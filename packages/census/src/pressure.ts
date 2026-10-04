/**
 * PRESSURE MAP — aggregates (pure; no IO).
 *
 * The census job runs the scenario engine (@aegis/pose scenario.ts) on every wallet it reads in a one-block full
 * sweep and publishes ONLY counts: how many wallets reach Watch / Near liquidation / liquidatable at each whole-%
 * move, per direction. No addresses, balances, health factors or per-wallet thresholds are published.
 *
 * Privacy: a cell is one (direction, up/down, current state, level, size floor, breakdown) combination. When fewer
 * than PRIVACY_MIN_CELL wallets fall in a cell, its moves are rounded UP to the next 10% so a lone large wallet's
 * liquidation point can't be read off the chart. Totals stay exact.
 *
 * The page queries the snapshot with the functions at the bottom (also used by tests).
 */
import {
  DIRECTIONS,
  SCENARIO_ENGINE_VERSION,
  canBeLiquidated,
  confidenceOf,
  directionMatch,
  directionScenario,
  exposedTo,
  liquidatable,
  thresholds,
  type Book,
  type Direction,
  type HullTemp,
  type Pose,
} from '@aegis/pose';
import type { SizeBand } from '@aegis/glyphs';

export const PRESSURE_VERSION = 1 as const;
export const MAX_PCT = 50;
export const PRIVACY_MIN_CELL = 5;

/** current state: Safe, Watch, Near liquidation (not yet liquidatable), Liquidatable now */
export type Cur = 'S' | 'W' | 'N' | 'L';
export type Lv = 'W' | 'N' | 'L';
export type Sign = 'down' | 'up';
/** "material" floors on wallet size (the same size bands the well uses) */
export const MATERIAL = ['0', '1k', '10k', '100k'] as const;
export type Material = (typeof MATERIAL)[number];
export const MATERIAL_LABEL: Record<Material, string> = { '0': 'All wallets', '1k': 'At least $1,000', '10k': 'At least $10,000', '100k': 'At least $100,000' };
const BAND_FLOOR: Record<SizeBand, number> = { dust: 0, '<1k': 0, '1–10k': 1, '10–100k': 2, '100k+': 3 };

/** Does a wallet of this size band meet the floor? The ONE definition of "material" (well, Scan, Pressure). */
export function meetsMaterial(band: SizeBand, m: Material): boolean {
  return BAND_FLOOR[band] >= MATERIAL.indexOf(m);
}

/** How many of these wallets meet each floor — e.g. for the near-liquidation list's summary. */
export function materialCounts(bands: readonly SizeBand[]): Record<Material, number> {
  const out = { '0': 0, '1k': 0, '10k': 0, '100k': 0 } as Record<Material, number>;
  for (const b of bands) for (const m of MATERIAL) if (meetsMaterial(b, m)) out[m]++;
  return out;
}

export type Venue = 'tydro' | 'nado' | 'both';

export interface PressureSnapshot {
  v: typeof PRESSURE_VERSION;
  engine: string;
  rulesVersion: string;
  block: number;
  /** when the sweep read the chain (prices are the venues' oracle prices at that block) */
  at: string;
  /** when the prices were read: the venues' oracle prices at `block`, read at this time (same sweep) */
  pricesAt?: string;
  maxPct: number;
  privacyMinCell: number;
  /** wallets in the sweep, by what could be simulated */
  population: {
    drawn: number;
    /** debt or perps somewhere: price alone can change their risk */
    exposed: number;
    approximate: number;
    unsupported: number;
  };
  /** current state counts: key `${cur}|${material}|${dim}` (dim: '*', 'v:tydro', 'v:nado', 'v:both', 't:<TYPE>') — exposed wallets only */
  now: Record<string, number>;
  /** key `${dir}|${sign}|${cur}|${level}|${material}|${dim}` → [move %, wallets that first reach `level` at that move] */
  hist: Record<string, Array<[number, number]>>;
  /** cells whose moves were rounded up to 10% for privacy */
  coarse: string[];
}

const venueOf = (book: Book): Venue | null => {
  const t = book.tydro.status === 'OK' && (book.tydro.data.supplies.length > 0 || book.tydro.data.debts.length > 0);
  const n = book.nado.status === 'OK' && (book.nado.data.spots.length > 0 || book.nado.data.perps.length > 0);
  return t && n ? 'both' : t ? 'tydro' : n ? 'nado' : null;
};

const curOf = (temp: HullTemp, liq: boolean): Cur => (liq ? 'L' : temp === 'CRITICAL' ? 'N' : temp === 'ELEVATED' ? 'W' : 'S');

export class PressureAcc {
  private now = new Map<string, number>();
  private cells = new Map<string, Map<number, number>>();
  private pop = { drawn: 0, exposed: 0, approximate: 0, unsupported: 0 };

  constructor(private dirs: readonly Direction[] = DIRECTIONS) {}

  add(book: Book, pose: Pose, band: SizeBand): void {
    if (book.source !== 'LIVE') return; // test wallets never enter real aggregates
    if (pose.primary === 'EMPTY') return;
    this.pop.drawn++;
    const conf = confidenceOf(book);
    if (conf.confidence === 'UNSUPPORTED') {
      this.pop.unsupported++;
      return;
    }
    if (!canBeLiquidated(book)) return;
    this.pop.exposed++;
    if (conf.confidence === 'APPROXIMATE') this.pop.approximate++;
    const venue = venueOf(book);
    const dims = ['*', ...(venue ? [`v:${venue}`] : []), `t:${pose.primary ?? 'NONE'}`];
    const floors = MATERIAL.filter((m) => meetsMaterial(band, m));
    const cur = curOf(pose.hullTemp, liquidatable(book));
    for (const m of floors) for (const d of dims) this.bump(this.now, `${cur}|${m}|${d}`);
    for (const dir of this.dirs) {
      if (!exposedTo(book, directionMatch(dir))) continue;
      for (const sign of dir.downOnly ? (['down'] as const) : (['down', 'up'] as const)) {
        const t = thresholds(book, (p) => directionScenario(dir, sign === 'down' ? -p : p), MAX_PCT);
        for (const [lv, key] of [['W', 'WATCH'], ['N', 'NEAR'], ['L', 'LIQ']] as const) {
          const at = t[key];
          if (at === null || at === 0) continue;
          for (const m of floors) for (const d of dims) {
            const k = `${dir.id}|${sign}|${cur}|${lv}|${m}|${d}`;
            const cell = this.cells.get(k) ?? new Map<number, number>();
            cell.set(at, (cell.get(at) ?? 0) + 1);
            this.cells.set(k, cell);
          }
        }
      }
    }
  }

  private bump(m: Map<string, number>, k: string) {
    m.set(k, (m.get(k) ?? 0) + 1);
  }

  toSnapshot(meta: { block: number; at: string; rulesVersion: string }): PressureSnapshot {
    const hist: Record<string, Array<[number, number]>> = {};
    const coarse: string[] = [];
    for (const [k, cell] of [...this.cells.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      let total = 0;
      for (const c of cell.values()) total += c;
      let rows = [...cell.entries()];
      if (total < PRIVACY_MIN_CELL) {
        const up = new Map<number, number>();
        for (const [p, c] of rows) {
          const q = Math.min(MAX_PCT, Math.ceil(p / 10) * 10);
          up.set(q, (up.get(q) ?? 0) + c);
        }
        rows = [...up.entries()];
        coarse.push(k);
      }
      hist[k] = rows.sort((a, b) => a[0] - b[0]);
    }
    return {
      v: PRESSURE_VERSION,
      engine: SCENARIO_ENGINE_VERSION,
      rulesVersion: meta.rulesVersion,
      block: meta.block,
      at: meta.at,
      pricesAt: meta.at,
      maxPct: MAX_PCT,
      privacyMinCell: PRIVACY_MIN_CELL,
      population: { ...this.pop },
      now: Object.fromEntries([...this.now.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
      hist,
      coarse,
    };
  }
}

/* ───────────────────────── queries (the page and the tests) ───────────────────────── */

export interface PressureQuery {
  dir: string;
  sign: Sign;
  /** whole %, 0..maxPct */
  pct: number;
  material: Material;
  /** '*' | 'v:tydro' | 'v:nado' | 'v:both' | 't:<TYPE>' */
  dim: string;
}

export interface PressureResult {
  /** exposed wallets in this selection (debt or perps) */
  population: number;
  now: Record<Cur, number>;
  /** under the scenario */
  safeToWatch: number;
  safeToNear: number;
  watchToNear: number;
  newlyLiquidatable: number;
  nearUnder: number;
  liquidatableUnder: number;
  /** wallets whose state gets worse */
  affected: number;
}

const CURS: readonly Cur[] = ['S', 'W', 'N', 'L'];

/** wallets in a cell that reach the level at or before `pct` */
export function reachedBy(s: PressureSnapshot, key: string, pct: number): number {
  const rows = s.hist[key];
  if (!rows) return 0;
  let n = 0;
  for (const [p, c] of rows) if (p <= pct) n += c;
  return n;
}

export function clampQuery(q: Partial<PressureQuery>, s?: PressureSnapshot): PressureQuery {
  const dir = DIRECTIONS.find((d) => d.id === q.dir) ?? DIRECTIONS.find((d) => d.id === 'CRYPTO')!;
  const sign: Sign = dir.downOnly ? 'down' : q.sign === 'up' ? 'up' : 'down';
  const max = s?.maxPct ?? MAX_PCT;
  const raw = Number(q.pct);
  const pct = Number.isFinite(raw) ? Math.max(0, Math.min(max, Math.round(raw))) : 10;
  const material = (MATERIAL as readonly string[]).includes(q.material ?? '') ? (q.material as Material) : '1k';
  const dim = typeof q.dim === 'string' && /^(\*|v:(tydro|nado|both)|t:[A-Z-]{3,16})$/.test(q.dim) ? q.dim : '*';
  return { dir: dir.id, sign, pct, material, dim };
}

export function queryPressure(s: PressureSnapshot, q0: PressureQuery): PressureResult {
  const q = clampQuery(q0, s);
  const now = Object.fromEntries(CURS.map((c) => [c, s.now[`${c}|${q.material}|${q.dim}`] ?? 0])) as Record<Cur, number>;
  const k = (cur: Cur, lv: Lv) => `${q.dir}|${q.sign}|${cur}|${lv}|${q.material}|${q.dim}`;
  const r = (cur: Cur, lv: Lv) => reachedBy(s, k(cur, lv), q.pct);
  const safeToNear = r('S', 'N');
  const safeToWatch = r('S', 'W') - safeToNear;
  const watchToNear = r('W', 'N');
  const newlyLiquidatable = r('S', 'L') + r('W', 'L') + r('N', 'L');
  return {
    population: CURS.reduce((a, c) => a + now[c], 0),
    now,
    safeToWatch,
    safeToNear,
    watchToNear,
    newlyLiquidatable,
    nearUnder: now.N + now.L + safeToNear + watchToNear,
    liquidatableUnder: now.L + newlyLiquidatable,
    affected: r('S', 'W') + watchToNear + r('N', 'L'),
  };
}

/** wallets near liquidation (or worse) at each move 0..maxPct — the pressure curve */
export function pressureCurve(s: PressureSnapshot, q: Omit<PressureQuery, 'pct'>): Array<{ pct: number; near: number; liquidatable: number }> {
  const out = [];
  for (let p = 0; p <= s.maxPct; p++) {
    const r = queryPressure(s, { ...q, pct: p });
    out.push({ pct: p, near: r.nearUnder, liquidatable: r.liquidatableUnder });
  }
  return out;
}

/* ───────────────────────── INK STRESS LEVEL ───────────────────────── */

/**
 * Deterministic, versioned. Measured on wallets of at least $1,000 that price alone can push (debt or perps), so
 * dust accounts can't make Ink look stressed. Three inputs, each a share of that population:
 *   near     — near liquidation or liquidatable right now
 *   near10   — newly near liquidation if all crypto falls 10%
 *   liq10    — newly liquidatable if all crypto falls 10%
 * The level is the highest one any input reaches. Not a prediction.
 */
export const STRESS = {
  VERSION: 'stress-1.0.0',
  MATERIAL: '1k' as Material,
  DIR: 'CRYPTO',
  MOVE_PCT: 10,
  LEVELS: [
    { level: 'CRITICAL', near: 0.15, near10: 0.3, liq10: 0.1 },
    { level: 'HIGH', near: 0.08, near10: 0.15, liq10: 0.04 },
    { level: 'ELEVATED', near: 0.03, near10: 0.06, liq10: 0.01 },
  ],
  /** confidence drops when the reading is older than this, Nado open-interest coverage is under this, or more than this share couldn't be simulated */
  STALE_HOURS: 12,
  MIN_COVERAGE: 0.9,
  MAX_UNSUPPORTED: 0.05,
} as const;

export type StressLevel = 'CALM' | 'ELEVATED' | 'HIGH' | 'CRITICAL';

export interface StressReading {
  level: StressLevel;
  inputs: { population: number; near: number; near10: number; liq10: number };
  /** why this level (the inputs that reached it), or why CALM */
  why: string[];
  confidence: 'NORMAL' | 'REDUCED';
  confidenceWhy: string[];
  version: string;
}

const pc = (x: number) => `${(x * 100).toFixed(1)}%`;

export function stressLevel(s: PressureSnapshot, ctx: { nowMs: number; oiCoverage?: number | null }): StressReading {
  const r = queryPressure(s, { dir: STRESS.DIR, sign: 'down', pct: STRESS.MOVE_PCT, material: STRESS.MATERIAL, dim: '*' });
  const pop = r.population;
  const share = (n: number) => (pop > 0 ? n / pop : 0);
  const inputs = { population: pop, near: share(r.now.N + r.now.L), near10: share(r.safeToNear + r.watchToNear), liq10: share(r.newlyLiquidatable) };
  let level: StressLevel = 'CALM';
  const why: string[] = [];
  for (const L of STRESS.LEVELS) {
    const hits = [
      inputs.near >= L.near ? `${pc(inputs.near)} are near liquidation now (≥ ${pc(L.near)})` : null,
      inputs.near10 >= L.near10 ? `${pc(inputs.near10)} more would be near liquidation if all crypto fell ${STRESS.MOVE_PCT}% (≥ ${pc(L.near10)})` : null,
      inputs.liq10 >= L.liq10 ? `${pc(inputs.liq10)} would become liquidatable if all crypto fell ${STRESS.MOVE_PCT}% (≥ ${pc(L.liq10)})` : null,
    ].filter((x): x is string => x !== null);
    if (hits.length) {
      level = L.level as StressLevel;
      why.push(...hits);
      break;
    }
  }
  if (level === 'CALM') why.push(`under every line: ${pc(inputs.near)} near liquidation now, ${pc(inputs.near10)} more at −${STRESS.MOVE_PCT}% crypto, ${pc(inputs.liq10)} newly liquidatable`);
  const confidenceWhy: string[] = [];
  const ageH = (ctx.nowMs - Date.parse(s.at)) / 3_600_000;
  if (!(ageH <= STRESS.STALE_HOURS)) confidenceWhy.push(`the reading is ${Number.isFinite(ageH) ? Math.round(ageH) : '?'} h old (over ${STRESS.STALE_HOURS} h)`);
  if (ctx.oiCoverage == null || ctx.oiCoverage < STRESS.MIN_COVERAGE) confidenceWhy.push(ctx.oiCoverage == null ? 'Nado coverage not measured' : `Nado open-interest coverage ${pc(ctx.oiCoverage)} (under ${pc(STRESS.MIN_COVERAGE)})`);
  const unsupported = s.population.drawn > 0 ? s.population.unsupported / s.population.drawn : 0;
  if (unsupported > STRESS.MAX_UNSUPPORTED) confidenceWhy.push(`${pc(unsupported)} of wallets couldn't be simulated`);
  if (pop === 0) confidenceWhy.push('no wallets of at least $1,000 with debt or perps');
  return { level, inputs, why, confidence: confidenceWhy.length ? 'REDUCED' : 'NORMAL', confidenceWhy, version: STRESS.VERSION };
}

/** The share text: counts and labels only — never balances, never addresses. */
export function shareText(s: PressureSnapshot, q: PressureQuery, stress: StressReading, url: string, nowMs: number = Date.now()): string {
  const d = DIRECTIONS.find((x) => x.id === q.dir)!;
  const r = queryPressure(s, q);
  const all = queryPressure(s, { ...q, material: '0' });
  const f = pressureFreshness(s, nowMs);
  return [
    `AEGIS Pressure Map — ${d.label} ${q.sign === 'down' ? '−' : '+'}${q.pct}% (a simulation, not a prediction)`,
    ...(f.status === 'CURRENT' ? [] : [`${f.status}: this map is ${f.why}`]),
    `Ink Stress Level: ${stress.level}${f.status === 'STALE' ? ' (as of then, not now)' : ''}${stress.confidence === 'REDUCED' ? ' (reduced confidence)' : ''}`,
    `Wallets pushed toward liquidation: ${all.affected} of ${all.population} visible to AEGIS · ${r.affected} of ${r.population} ${MATERIAL_LABEL[q.material].toLowerCase()}`,
    `Block ${s.block.toLocaleString('en-US')} · ${s.at}`,
    'Based on wallets currently visible to AEGIS. AEGIS is a camera. It cannot move your funds. Classifications can be wrong.',
    url,
  ].join('\n');
}

/* ───────────────────────── freshness ───────────────────────── */

/**
 * The Pressure Map is rebuilt by each one-block full sweep (every 3 hours, ~45 min to run); the well is refreshed by
 * every hourly run. So Pressure is normally older than the well. Versioned thresholds:
 *   CURRENT  ≤ CURRENT_H   (one full-sweep interval plus its run time)
 *   DELAYED  ≤ STALE_H     (a sweep or two missed)
 *   STALE    > STALE_H, or no readable time
 */
export const FRESHNESS = { VERSION: 'fresh-1.0.0', CURRENT_H: 4, STALE_H: 12 } as const;

export type Freshness = 'CURRENT' | 'DELAYED' | 'STALE';

export function pressureFreshness(s: Pick<PressureSnapshot, 'at' | 'pricesAt'>, nowMs: number): { status: Freshness; ageH: number | null; why: string } {
  const t = Date.parse(s.pricesAt ?? s.at);
  if (!Number.isFinite(t)) return { status: 'STALE', ageH: null, why: 'its reading time is missing, so its age is unknown' };
  const ageH = Math.max(0, (nowMs - t) / 3_600_000);
  if (ageH <= FRESHNESS.CURRENT_H) return { status: 'CURRENT', ageH, why: `built by the last full scan, ${ageH.toFixed(1)} h ago` };
  if (ageH <= FRESHNESS.STALE_H) return { status: 'DELAYED', ageH, why: `${ageH.toFixed(1)} h old — at least one full scan was missed` };
  return { status: 'STALE', ageH, why: `${ageH.toFixed(0)} h old — prices and positions have moved since` };
}
