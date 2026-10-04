import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classify, familyOf, type Book, type HealthTriple, type NadoPerp, type NadoSpot } from '@aegis/pose';
import { shipSizeUsd, sizeBand } from '@aegis/glyphs';
import { PressureAcc, queryPressure, stressLevel } from '../src/index.js';

/** A realistically sized, made-up population (seeded, so the numbers are stable). Never real accounts. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const leg = (symbol: string, usd: number) => ({ symbol, ...familyOf(symbol), amount: usd, usd, priceUsd: 1, priceSource: 'FIXTURE' as const });
const okNado = (spots: NadoSpot[], perps: NadoPerp[]): Book['nado'] => {
  const cs = [...spots.map((x) => x.maintWeight! * x.usd), ...perps.map((p) => p.maintWeight! * p.notionalUsd + p.vQuoteUsd)];
  const m: HealthTriple = { assetsUsd: cs.reduce((a, c) => a + Math.max(c, 0), 0), liabilitiesUsd: cs.reduce((a, c) => a + Math.max(-c, 0), 0), healthUsd: cs.reduce((a, c) => a + c, 0) };
  return { status: 'OK', asOfTime: 0, asOfBlock: 1, data: { subaccounts: ['main'], equityUsd: spots.reduce((a, s) => a + s.usd, 0) + perps.reduce((a, p) => a + p.unsettledUsd, 0), spots, perps, maintenance: spots.length || perps.length ? m : null, initial: null, unweighted: null, funding: [], notes: [], subHealth: [{ subaccount: 'main', maintenance: spots.length || perps.length ? m : null }] } };
};
const noTydro: Book['tydro'] = { status: 'OK', asOfTime: 0, asOfBlock: 1, data: { hf: null, supplies: [], debts: [], totalCollateralUsd: 0, totalDebtUsd: 0, usdNet: 0, liquidationThreshold: null, notes: [] } };

export function population(n: number, seed = 7): Book[] {
  const r = rng(seed);
  const size = () => Math.round(10 ** (1.5 + r() * 4.5)); // $30 … $1M, log-spread
  const out: Book[] = [];
  for (let i = 0; i < n; i++) {
    const kind = r();
    const address = `0x${(i + 1).toString(16).padStart(40, '0')}`;
    if (kind < 0.35) {
      // Tydro borrower
      const col = ['WETH', 'kBTC', 'kHYPE', 'USDe', 'weETH'][Math.floor(r() * 5)]!;
      const debt = ['USDC', 'USDT', 'GHO'][Math.floor(r() * 3)]!;
      const S = size();
      const hf = 1.02 + r() * 2.2;
      const D = (S * 0.8) / hf;
      out.push({ address, source: 'LIVE', tydro: { status: 'OK', asOfTime: 0, asOfBlock: 1, data: { hf, supplies: [leg(col, S)], debts: [leg(debt, D)], totalCollateralUsd: S, totalDebtUsd: D, usdNet: S - D, liquidationThreshold: 0.8, notes: [] } }, nado: okNado([], []), asOfBlock: 1, asOfTime: 0 });
    } else if (kind < 0.65) {
      // Nado perp trader
      const sym = ['BTC-PERP', 'ETH-PERP', 'HYPE-PERP', 'SOL-PERP', 'SPY-PERP'][Math.floor(r() * 5)]!;
      const margin = size();
      const lev = 0.5 + r() * 9;
      const notional = margin * lev * (r() < 0.6 ? 1 : -1);
      const { family, assetClass } = familyOf(sym);
      const w = notional > 0 ? 0.95 : 1.05;
      const spots: NadoSpot[] = [{ ...leg('USDT0', margin), productId: 0, subaccount: 'main', maintWeight: 1 }];
      const perps: NadoPerp[] = [{ productId: 2, subaccount: 'main', symbol: sym, family, assetClass, sizeBase: notional / 100, notionalUsd: notional, priceUsd: 100, priceSource: 'FIXTURE', vQuoteUsd: -notional, unsettledUsd: 0, maintWeight: w }];
      out.push({ address, source: 'LIVE', tydro: noTydro, nado: okNado(spots, perps), asOfBlock: 1, asOfTime: 0 });
    } else {
      // lender / holder: price can't liquidate
      out.push({ address, source: 'LIVE', tydro: { status: 'OK', asOfTime: 0, asOfBlock: 1, data: { hf: null, supplies: [leg('USDC', size())], debts: [], totalCollateralUsd: 0, totalDebtUsd: 0, usdNet: 0, liquidationThreshold: null, notes: [] } }, nado: okNado([], []), asOfBlock: 1, asOfTime: 0 });
    }
  }
  return out;
}

describe('Pressure Map at real size', () => {
  it('18,500 wallets (about 12,000 with debt or perps) in well under a minute, and a file the site can load', () => {
    const books = population(18_500);
    const t0 = Date.now();
    const acc = new PressureAcc();
    for (const b of books) {
      const pose = classify(b);
      acc.add(b, pose, sizeBand(shipSizeUsd(pose)));
    }
    const s = acc.toSnapshot({ block: 57_600_000, at: new Date().toISOString(), rulesVersion: 'v1.2.0' });
    const ms = Date.now() - t0;
    const json = JSON.stringify(s);
    // eslint-disable-next-line no-console
    console.log(`pressure: ${books.length} wallets, ${s.population.exposed} simulated in ${ms} ms · ${(json.length / 1024).toFixed(0)} KB · ${Object.keys(s.hist).length} cells`);
    expect(ms).toBeLessThan(60_000);
    expect(json.length).toBeLessThan(2_500_000);
    const t1 = Date.now();
    for (let p = 0; p <= 50; p++) queryPressure(s, { dir: 'CRYPTO', sign: 'down', pct: p, material: '1k', dim: '*' });
    expect(Date.now() - t1).toBeLessThan(200); // a slider sweep is instant
    expect(['CALM', 'ELEVATED', 'HIGH', 'CRITICAL']).toContain(stressLevel(s, { nowMs: Date.now(), oiCoverage: 0.94 }).level);
    if (process.env.PRESSURE_SAMPLE_OUT) writeFileSync(process.env.PRESSURE_SAMPLE_OUT, json);
  }, 120_000);
});
