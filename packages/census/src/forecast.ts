/**
 * PRESSURE FORECAST SCORING (pure) — `forecast-score-1.0.0`. Release 3.
 *
 * Each full scan records what the Pressure Map predicted for fixed scenarios (ledger.ts ForecastRecord). Once
 * prices are recorded (oracle.ts PricePoint), a forecast can be checked: did the scenario's move actually happen
 * within the horizon, and if it did, how did the predicted counts compare with what was observed?
 *
 * Most scenarios (−10%, −20%) simply don't happen in a given day; that is reported as "not reached", never as a
 * hit or a miss. Forecasts made before prices were recorded can't be judged and are counted separately.
 */
import type { AggPoint } from './history.js';
import type { ForecastRecord, LedgerRecord } from './ledger.js';
import type { PricePoint } from './oracle.js';

export const FORECAST_SCORE = { VERSION: 'forecast-score-1.0.0', HORIZON_H: 24 } as const;
export const FORECAST_SCORE_PATH = 'history/forecast-score.json' as const;

/** The price that stands for each scenario direction (USD-quoted, Tydro's protocol price). */
const REPRESENT: Record<string, string[]> = {
  ETH: ['tydro:WETH'],
  BTC: ['tydro:kBTC'],
  CRYPTO: ['tydro:WETH', 'tydro:kBTC'],
  USD: ['tydro:USDC', 'tydro:USDT', 'tydro:USDG', 'tydro:GHO', 'tydro:USDe'],
};

export interface ScenarioScore {
  key: string;
  dir: string;
  pct: number;
  material: string;
  /** forecasts old enough and with prices covering the whole horizon */
  judged: number;
  /** of those, the move actually happened within the horizon */
  reached: number;
  /** for reached ones: predicted near-or-worse vs the most observed (recorded) in the horizon */
  comparisons: Array<{ at: string; predictedNear: number; observedNear: number | null; predictedLiquidatable: number; liquidationsSeen: number }>;
}

export interface ForecastScore {
  v: 1;
  kind: 'aegis-forecast-score';
  version: string;
  generatedAt: string;
  horizonH: number;
  forecasts: number;
  /** forecasts made before prices were recorded, or whose horizon has no price data */
  unjudgeable: number;
  pending: number;
  scenarios: ScenarioScore[];
  notes: string[];
}

/** The worst (most negative) move of a direction within (from, to], relative to the price at `from`. null = no data. */
export function worstMove(points: readonly PricePoint[], dir: string, from: number, to: number): number | null {
  const keys = REPRESENT[dir];
  if (!keys) return null;
  const start = [...points].filter((p) => p.at <= from).at(-1);
  const inWin = points.filter((p) => p.at > from && p.at <= to);
  if (!start || !inWin.length) return null;
  const moveAt = (p: PricePoint) => {
    const ms = keys.map((k) => (start.p[k] && p.p[k] ? p.p[k]! / start.p[k]! - 1 : null)).filter((x): x is number => x !== null);
    if (!ms.length) return null;
    // CRYPTO: the average of its members; USD: the worst stablecoin; single: itself
    return dir === 'USD' ? Math.min(...ms) : ms.reduce((a, b) => a + b, 0) / ms.length;
  };
  const moves = inWin.map(moveAt).filter((x): x is number => x !== null);
  return moves.length ? Math.min(...moves) : null;
}

export function scoreForecasts(o: { forecasts: readonly ForecastRecord[]; prices: readonly PricePoint[]; agg: readonly AggPoint[]; liquidations: readonly LedgerRecord[]; nowMs: number }): ForecastScore {
  const H = FORECAST_SCORE.HORIZON_H * 3_600_000;
  const firstPrice = o.prices.length ? Math.min(...o.prices.map((p) => p.at)) : Infinity;
  const lastPrice = o.prices.length ? Math.max(...o.prices.map((p) => p.at)) : -Infinity;
  const map = new Map<string, ScenarioScore>();
  let unjudgeable = 0;
  let pending = 0;
  for (const f of o.forecasts) {
    const t = Date.parse(f.at);
    if (o.nowMs - t < H) {
      pending++;
      continue;
    }
    if (t < firstPrice || t + H > lastPrice) {
      unjudgeable++;
      continue;
    }
    for (const s of f.scenarios) {
      const key = `${s.dir} ${s.sign === 'down' ? '−' : '+'}${s.pct}% · ${s.material === '0' ? 'all sizes' : '≥ $1k'}`;
      const sc = map.get(key) ?? { key, dir: s.dir, pct: s.pct, material: s.material, judged: 0, reached: 0, comparisons: [] };
      const mv = worstMove(o.prices, s.dir, t, t + H);
      if (mv === null) continue;
      sc.judged++;
      if (mv <= -s.pct / 100) {
        sc.reached++;
        const pts = o.agg.filter((p) => Date.parse(p.at) > t && Date.parse(p.at) <= t + H);
        const fl = s.material === '0' ? '0' : '1k';
        sc.comparisons.push({
          at: f.at,
          predictedNear: s.near,
          observedNear: pts.length ? Math.max(...pts.map((p) => p.risk[fl as '0' | '1k'][2])) : null,
          predictedLiquidatable: s.liquidatable,
          liquidationsSeen: o.liquidations.filter((r) => r.at > t && r.at <= t + H).length,
        });
      }
      map.set(key, sc);
    }
  }
  return {
    v: 1,
    kind: 'aegis-forecast-score',
    version: FORECAST_SCORE.VERSION,
    generatedAt: new Date(o.nowMs).toISOString(),
    horizonH: FORECAST_SCORE.HORIZON_H,
    forecasts: o.forecasts.length,
    unjudgeable,
    pending,
    scenarios: [...map.values()].sort((a, b) => a.key.localeCompare(b.key)),
    notes: [
      'A scenario is "reached" when its move actually happened within 24 hours of the forecast (Tydro protocol prices; CRYPTO = average of ETH and BTC; USD = the worst stablecoin).',
      'Unreached scenarios are neither hits nor misses — the forecast was conditional on a move that did not happen.',
      'When reached, the forecast counted wallets near-or-worse at the full move; the observed figure is the most wallets the hourly scan recorded near liquidation in that day. Prices rarely move by exactly the scenario, so this is a rough check, not a score.',
      'Forecasts made before prices were recorded (before Release 3) cannot be judged.',
    ],
  };
}
