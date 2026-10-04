/**
 * PRESSURE MAP — scenario engine (pure; no IO).
 *
 * Applies a hypothetical price move to a wallet's normalized Book and re-runs the SAME classifier (classify()) on the
 * shocked copy (its risk lines, via riskTemp — the same function classify uses), so a scenario can never disagree with
 * the live rules. The canonical Book is never mutated.
 *
 * Repricing, per leg, with x = the move for that leg's asset (−0.10 = −10%):
 *   Tydro   supply and debt USD × (1 + x). The health factor is rescaled from the on-chain one:
 *           hf' = hf × (Σ supply'/Σ supply) ÷ (Σ debt'/Σ debt)
 *           (APPROXIMATE: assumes one liquidation threshold across the wallet's collateral; Tydro's per-asset
 *           thresholds differ by a few points, so mixed-collateral results are approximate. Exact for one collateral.)
 *   Nado    each position's maintenance contribution c = w × value (+ v_quote for perps), with w = Nado's own
 *           maintenance weight for that side (from FQuerier). health' = health + Σ (c' − c); assets and liabilities
 *           move with the positive / negative contributions. Done per subaccount (isolated margin is liquidated on
 *           its own); the worst subaccount drives the buffer, exactly like the live reading.
 *           Nado's quote asset (USDT0, product 0) is the unit of account on Nado and never moves there.
 *   Liquidatable  Tydro hf' < 1, or any Nado subaccount's maintenance health' < 0.
 * Not modelled (stated, not hidden): funding and interest accrual over time, Nado spread pairs, Tydro per-asset
 * thresholds and e-mode, oracle lag, and market impact. Results are "approximately", never predictions.
 */
import { riskTemp } from './classify.js';
import type { AssetClass, Book, HealthTriple, HullTemp, NadoBook, NadoPerp, NadoSpot, TydroBook } from './types.js';

export const SCENARIO_ENGINE_VERSION = 'pressure-1.0.0';

/** Nado's quote product: the unit of account on Nado, so it cannot move against itself there. */
export const NADO_QUOTE_PRODUCT = 0;

/**
 * A scenario: moves by asset family and/or by asset class. A family move overrides a class move for that family.
 * Moves are fractions (−0.1 = −10%), clamped to [−0.95, +5].
 */
export interface Scenario {
  /** by token symbol (upper-case), e.g. USDE — for one coin losing its peg against the others */
  symbols?: Record<string, number>;
  families?: Record<string, number>;
  classes?: Partial<Record<AssetClass, number>>;
}

export type Level = 'WATCH' | 'NEAR' | 'LIQ';
export type Confidence = 'MODELLED' | 'APPROXIMATE' | 'UNSUPPORTED';

export interface StressState {
  /** the classifier's risk for this (possibly shocked) book */
  hullTemp: HullTemp;
  /** venue says liquidatable: Tydro hf < 1 or a Nado subaccount's maintenance health < 0 */
  liquidatable: boolean;
}

const clampMove = (x: number) => (Number.isFinite(x) ? Math.min(5, Math.max(-0.95, x)) : 0);

export function moveFor(s: Scenario, family: string, assetClass: AssetClass, symbol?: string): number {
  const y = symbol !== undefined ? s.symbols?.[symbol.toUpperCase()] : undefined;
  if (y !== undefined) return clampMove(y);
  const f = s.families?.[family];
  if (f !== undefined) return clampMove(f);
  const c = s.classes?.[assetClass];
  return c !== undefined ? clampMove(c) : 0;
}

/* ───────────────────────── Tydro ───────────────────────── */

function shockTydro(t: TydroBook, s: Scenario): TydroBook {
  const supplies = t.supplies.map((l) => {
    const k = 1 + moveFor(s, l.family, l.assetClass, l.symbol);
    return { ...l, usd: l.usd * k, priceUsd: l.priceUsd * k };
  });
  const debts = t.debts.map((l) => {
    const k = 1 + moveFor(s, l.family, l.assetClass, l.symbol);
    return { ...l, usd: l.usd * k, priceUsd: l.priceUsd * k };
  });
  const sum = (ls: readonly { usd: number }[]) => ls.reduce((a, l) => a + l.usd, 0);
  const s0 = sum(t.supplies), s1 = sum(supplies), d0 = sum(t.debts), d1 = sum(debts);
  let hf = t.hf;
  if (hf !== null && Number.isFinite(hf) && d0 > 0 && s0 > 0) {
    hf = d1 > 0 ? hf * (s1 / s0) / (d1 / d0) : null;
  }
  return { ...t, supplies, debts, hf, totalCollateralUsd: s1, totalDebtUsd: d1, usdNet: s1 - d1 };
}

/* ───────────────────────── Nado ───────────────────────── */

const weightOf = (w: number | undefined) => (w !== undefined && Number.isFinite(w) && w > 0 ? w : 1);

function contribution(p: { maintWeight?: number }, value: number, vQuote = 0): number {
  return weightOf(p.maintWeight) * value + vQuote;
}

function shockNado(n: NadoBook, s: Scenario): NadoBook {
  const spots: NadoSpot[] = n.spots.map((l) => {
    const x = l.productId === NADO_QUOTE_PRODUCT ? 0 : moveFor(s, l.family, l.assetClass, l.symbol);
    return { ...l, usd: l.usd * (1 + x), priceUsd: l.priceUsd * (1 + x) };
  });
  const perps: NadoPerp[] = n.perps.map((p) => {
    const x = moveFor(s, p.family, p.assetClass, p.symbol);
    const notionalUsd = p.notionalUsd * (1 + x);
    return { ...p, notionalUsd, priceUsd: p.priceUsd * (1 + x), unsettledUsd: p.vQuoteUsd + notionalUsd };
  });
  // per-subaccount maintenance, moved by the change in each position's weighted contribution
  const subs = n.subHealth && n.subHealth.length ? n.subHealth : [{ subaccount: '*', maintenance: n.maintenance }];
  const inSub = (sub: string, x: { subaccount: string }) => sub === '*' || x.subaccount === sub;
  const subHealth = subs.map(({ subaccount, maintenance }) => {
    if (!maintenance) return { subaccount, maintenance };
    let dH = 0, dA = 0, dL = 0;
    n.spots.forEach((l, i) => {
      if (!inSub(subaccount, l)) return;
      const c0 = contribution(l, l.usd), c1 = contribution(l, spots[i]!.usd);
      dH += c1 - c0;
      dA += Math.max(c1, 0) - Math.max(c0, 0);
      dL += Math.max(-c1, 0) - Math.max(-c0, 0);
    });
    n.perps.forEach((p, i) => {
      if (!inSub(subaccount, p)) return;
      const c0 = contribution(p, p.notionalUsd, p.vQuoteUsd), c1 = contribution(p, perps[i]!.notionalUsd, p.vQuoteUsd);
      dH += c1 - c0;
      dA += Math.max(c1, 0) - Math.max(c0, 0);
      dL += Math.max(-c1, 0) - Math.max(-c0, 0);
    });
    const m: HealthTriple = { assetsUsd: Math.max(0, maintenance.assetsUsd + dA), liabilitiesUsd: Math.max(0, maintenance.liabilitiesUsd + dL), healthUsd: maintenance.healthUsd + dH };
    return { subaccount, maintenance: m };
  });
  // the worst subaccount drives the buffer — same choice the live reader makes (ink-io aggregate())
  let maintenance: HealthTriple | null = null;
  let worst = Infinity;
  for (const { maintenance: m } of subHealth) {
    if (!m || (m.assetsUsd === 0 && m.healthUsd === 0)) continue;
    const b = m.assetsUsd > 0 ? m.healthUsd / m.assetsUsd : m.healthUsd < 0 ? -1 : Infinity;
    if (b < worst) {
      worst = b;
      maintenance = m;
    }
  }
  const equityUsd = spots.reduce((a, l) => a + l.usd, 0) + perps.reduce((a, p) => a + p.unsettledUsd, 0);
  return { ...n, spots, perps, equityUsd, maintenance, subHealth: n.subHealth ? subHealth : undefined };
}

/* ───────────────────────── book-level ───────────────────────── */

/** A shocked COPY of the book. The original is never touched. */
export function shockBook(book: Book, s: Scenario): Book {
  return {
    ...book,
    tydro: book.tydro.status === 'OK' ? { ...book.tydro, data: shockTydro(book.tydro.data, s) } : book.tydro,
    nado: book.nado.status === 'OK' ? { ...book.nado, data: shockNado(book.nado.data, s) } : book.nado,
  };
}

export function liquidatable(book: Book): boolean {
  const t = book.tydro.status === 'OK' ? book.tydro.data : null;
  if (t && t.hf !== null && Number.isFinite(t.hf) && t.hf < 1) return true;
  const n = book.nado.status === 'OK' ? book.nado.data : null;
  if (n) {
    const subs = n.subHealth && n.subHealth.length ? n.subHealth.map((x) => x.maintenance) : [n.maintenance];
    if (subs.some((m) => m !== null && m.healthUsd < 0)) return true;
  }
  return false;
}

export function stressState(book: Book): StressState {
  return { hullTemp: riskTemp(book), liquidatable: liquidatable(book) };
}

const RANK: Record<HullTemp, number> = { UNKNOWN: -1, NOMINAL: 0, ELEVATED: 1, CRITICAL: 2 };
/** has this state reached the level? (LIQ is beyond NEAR) */
export function reached(st: StressState, level: Level): boolean {
  if (level === 'LIQ') return st.liquidatable;
  if (level === 'NEAR') return st.liquidatable || RANK[st.hullTemp] >= 2;
  return st.liquidatable || RANK[st.hullTemp] >= 1;
}

/** Can this wallet be simulated at all, and how well? */
export function confidenceOf(book: Book): { confidence: Confidence; why: string[] } {
  const why: string[] = [];
  if (book.tydro.status !== 'OK' || book.nado.status !== 'OK') {
    why.push(`${book.tydro.status !== 'OK' ? 'Tydro' : 'Nado'} couldn't be read, so half the wallet is missing`);
    return { confidence: 'UNSUPPORTED', why };
  }
  const legs = [...book.tydro.data.supplies, ...book.tydro.data.debts, ...book.nado.data.spots, ...book.nado.data.perps];
  if (legs.some((l) => !Number.isFinite(l.priceUsd) || l.priceUsd <= 0)) {
    why.push('a price is missing');
    return { confidence: 'UNSUPPORTED', why };
  }
  const n = book.nado.data;
  if ((n.spots.length || n.perps.length) && [...n.spots, ...n.perps].some((x) => x.maintWeight === undefined)) why.push("Nado's maintenance weights weren't in this reading (weight 1 assumed)");
  const t = book.tydro.data;
  if (t.debts.length && new Set(t.supplies.map((l) => l.family)).size > 1) why.push('Tydro collateral spans several assets (one liquidation threshold assumed)');
  return { confidence: why.length ? 'APPROXIMATE' : 'MODELLED', why };
}

/** Which scenario directions can move this book at all? (a wallet with nothing in BTC can't be hurt by a BTC move) */
export function exposedTo(book: Book, match: (family: string, assetClass: AssetClass, nadoQuote: boolean, symbol: string) => boolean): boolean {
  const t = book.tydro.status === 'OK' ? book.tydro.data : null;
  const n = book.nado.status === 'OK' ? book.nado.data : null;
  const legs: Array<{ family: string; assetClass: AssetClass; q: boolean; symbol: string }> = [
    ...(t ? [...t.supplies, ...t.debts].map((l) => ({ family: l.family, assetClass: l.assetClass, q: false, symbol: l.symbol })) : []),
    ...(n ? n.spots.map((l) => ({ family: l.family, assetClass: l.assetClass, q: l.productId === NADO_QUOTE_PRODUCT, symbol: l.symbol })) : []),
    ...(n ? n.perps.map((p) => ({ family: p.family, assetClass: p.assetClass, q: false, symbol: p.symbol })) : []),
  ];
  return legs.some((l) => match(l.family, l.assetClass, l.q, l.symbol));
}

/** Can price alone ever liquidate this wallet? Only with debt on Tydro, or borrowing / perps on Nado. */
export function canBeLiquidated(book: Book): boolean {
  const t = book.tydro.status === 'OK' ? book.tydro.data : null;
  const n = book.nado.status === 'OK' ? book.nado.data : null;
  return !!(t && t.debts.some((d) => d.usd > 0)) || !!(n && (n.perps.some((p) => p.sizeBase !== 0) || n.spots.some((l) => l.amount < 0)));
}

export interface Thresholds {
  /** smallest move (whole %, 1..maxPct) at which the wallet reaches the level; null = not within maxPct */
  WATCH: number | null;
  NEAR: number | null;
  LIQ: number | null;
}

/**
 * Smallest move along one direction that takes the wallet to each level, scanning 1%, 2%, … maxPct.
 * `make(pct)` builds the scenario for a move of pct% in this direction (sign included by the caller).
 * Levels the wallet is ALREADY at report 0.
 */
export function thresholds(book: Book, make: (pct: number) => Scenario, maxPct = 50): Thresholds {
  const now = stressState(book);
  const out: Thresholds = { WATCH: reached(now, 'WATCH') ? 0 : null, NEAR: reached(now, 'NEAR') ? 0 : null, LIQ: reached(now, 'LIQ') ? 0 : null };
  for (let pct = 1; pct <= maxPct && (out.WATCH === null || out.NEAR === null || out.LIQ === null); pct++) {
    const st = stressState(shockBook(book, make(pct)));
    for (const lv of ['WATCH', 'NEAR', 'LIQ'] as const) if (out[lv] === null && reached(st, lv)) out[lv] = pct;
  }
  return out;
}

/* ───────────────────────── scenario directions (shared by the census, the Pressure page and the wallet page) ───────────────────────── */

export interface Direction {
  id: string;
  label: string;
  /** what moves */
  symbols?: readonly string[];
  families?: readonly string[];
  classes?: readonly AssetClass[];
  /** a stablecoin depeg only goes down */
  downOnly?: boolean;
  note?: string;
}

export const DIRECTIONS: readonly Direction[] = [
  { id: 'BTC', label: 'BTC', families: ['BTC'], note: 'kBTC, SolvBTC and BTC-PERP move together' },
  { id: 'ETH', label: 'ETH', families: ['ETH'], note: 'WETH, weETH, wrsETH, ezETH and ETH-PERP move together' },
  { id: 'HYPE', label: 'HYPE', families: ['HYPE'] },
  { id: 'SOL', label: 'SOL', families: ['SOL'] },
  { id: 'CRYPTO', label: 'All crypto', classes: ['CRYPTO'], note: 'every crypto asset at once' },
  { id: 'XSTOCK', label: 'Stocks', classes: ['XSTOCK'], note: 'xStocks and stock perps at once' },
  { id: 'RISK', label: 'Everything but stablecoins', classes: ['CRYPTO', 'XSTOCK', 'GOLD', 'COMMODITY'] },
  { id: 'USD', label: 'All stablecoins depeg', families: ['USD'], downOnly: true, note: "every stablecoin loses its peg by the same amount (a stablecoin-on-stablecoin loop doesn't move); Nado's own unit of account (USDT0 on Nado) can't move against itself" },
  { id: 'USDE', label: 'USDe depeg', symbols: ['USDE', 'SUSDE'], downOnly: true, note: 'USDe and sUSDe lose their peg; other stablecoins hold' },
  { id: 'USDC', label: 'USDC depeg', symbols: ['USDC'], downOnly: true, note: 'USDC loses its peg; other stablecoins hold' },
];

export const directionById = (id: string) => DIRECTIONS.find((d) => d.id === id);

/** The scenario for a signed move in one direction (pct = −10 → down 10%). */
export function directionScenario(d: Direction, signedPct: number): Scenario {
  const x = Math.max(-95, Math.min(500, Number.isFinite(signedPct) ? signedPct : 0)) / 100;
  const s: Scenario = {};
  if (d.symbols) s.symbols = Object.fromEntries(d.symbols.map((y) => [y, x]));
  if (d.families) s.families = Object.fromEntries(d.families.map((f) => [f, x]));
  if (d.classes) s.classes = Object.fromEntries(d.classes.map((c) => [c, x]));
  return s;
}

export function directionMatch(d: Direction) {
  return (family: string, assetClass: AssetClass, nadoQuote: boolean, symbol: string) =>
    !nadoQuote && ((d.symbols?.includes(symbol.toUpperCase()) ?? false) || (d.families?.includes(family) ?? false) || (d.classes?.includes(assetClass) ?? false));
}
