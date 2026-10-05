/**
 * YIELD AND CARRY (pure; no IO) — `carry-1.0.0`. Release 4. Analysis only: Phrourax never executes anything.
 *
 * Inputs are protocol state read at the latest block and at daily checkpoints (UTC midnight) for up to 30 days
 * (ink-io carry.ts). What was actually paid between two readings is OBSERVED, not modelled:
 *   - Tydro interest   = change in the reserve's liquidity / borrow index
 *   - Nado interest    = change in the spot product's deposit / borrow multiplier
 *   - Nado funding     = change in the perp's cumulative funding (quote per 1 base), ÷ the oracle price
 *   - LST / yield-bearing stable appreciation = change in Tydro's own price ratio to the base asset
 * Tydro also publishes its CURRENT rates (rays) and those are shown as such; Nado doesn't, so its "current" figure
 * is the last 24 h observed, labelled so.
 *
 * Every structure is sized per $1 of capital with stated assumptions; every rate is annual and NOT compounded
 * (APR); one-off costs are shown separately. A structure is an observation of what the chain paid — never a promise.
 */
import type { CarryPoint, GasRead, NadoPerpMarket, NadoSpotMarket, TydroMarket } from '@aegis/ink-io';
import type { ChangeRecord } from './changes.js';
import type { OracleStatus, OracleWatch } from './oracle.js';
import { queryPressure, stressLevel, type PressureSnapshot } from './pressure.js';

export const CARRY = {
  VERSION: 'carry-1.0.0',
  /** daily checkpoints kept / looked back */
  DAYS: 30,
  /** a checkpoint pair counts as one day only if 20–28 h apart (a missed day is a gap, not stretched) */
  DAY_MIN_H: 20,
  DAY_MAX_H: 28,
  /** sizing assumptions (fractions of $1 capital) */
  TYDRO_HEDGE_MARGIN: 0.5, // Nado margin for a short hedging a Tydro position, as a share of the hedge
  BORROW_SHARE_OF_LTV: 0.5, // borrow half of what Tydro's LTV allows
  /** gas: units per transaction (assumed) and transactions per structure (open + close) */
  GAS_UNITS: 250_000,
  /** capital used for one-off cost examples */
  EXAMPLE_CAPITAL: 10_000,
  EXAMPLE_HOLD_DAYS: 30,
  /** risk thresholds */
  LIQ_HIGH_PCT: 20,
  LIQ_MED_PCT: 50,
  REVERSAL_MED_DAYS: 4,
  REVERSAL_HIGH_DAYS: 10,
  CAPACITY_HIGH_USD: 100_000,
  CAPACITY_MED_USD: 1_000_000,
  STALE_H: 3,
} as const;

export const CARRY_LATEST = 'history/carry/latest.json' as const;
export const CARRY_DAYS = 'history/carry/days.json' as const;

const YEAR = 365 * 86_400_000;

/* ───────────────────────── mapping (explicit, never by ticker guess) ───────────────────────── */

/** Tydro asset → the Nado perp that hedges it, and what the hedge does NOT cover. */
export const HEDGE: Record<string, { perp: string; relation: string; base?: string }> = {
  WETH: { perp: 'ETH-PERP', relation: 'WETH is wrapped ETH, 1:1' },
  kBTC: { perp: 'BTC-PERP', relation: 'kBTC is wrapped BTC — the hedge does not cover the wrapper losing its peg' },
  SolvBTC: { perp: 'BTC-PERP', relation: 'SolvBTC is wrapped BTC — the hedge does not cover the wrapper losing its peg' },
  weETH: { perp: 'ETH-PERP', relation: 'weETH is a liquid-staking token priced off ETH — the hedge does not cover its ETH ratio falling', base: 'WETH' },
  wrsETH: { perp: 'ETH-PERP', relation: 'wrsETH is a liquid-restaking token priced off ETH — the hedge does not cover its ETH ratio falling', base: 'WETH' },
  ezETH: { perp: 'ETH-PERP', relation: 'ezETH is a liquid-restaking token priced off ETH — the hedge does not cover its ETH ratio falling', base: 'WETH' },
};
/** Stablecoins lent as such; yield-bearing ones also appreciate against their base. */
export const STABLES: Record<string, { base?: string; label: string }> = {
  USDT: { label: 'USDT0' },
  USDC: { label: 'USDC' },
  USDG: { label: 'USDG' },
  GHO: { label: 'GHO' },
  USDe: { label: 'USDe' },
  sUSDe: { label: 'sUSDe', base: 'USDT' },
  syrupUSDT: { label: 'syrupUSDT', base: 'USDT' },
};
const ORACLE_SYMBOL = (tydroSymbol: string) => (tydroSymbol === 'USDT' ? 'USDT0' : tydroSymbol);
const NADO_QUOTE = 0;

/* ───────────────────────── observed rates between two readings ───────────────────────── */

type Pt = CarryPoint;
const tyd = (p: Pt, sym: string): TydroMarket | undefined => p.tydro.find((t) => t.symbol === sym);
const spot = (p: Pt, id: number): NadoSpotMarket | undefined => p.nado?.spot.find((s) => s.productId === id);
const perp = (p: Pt, id: number): NadoPerpMarket | undefined => p.nado?.perp.find((s) => s.productId === id);
const ann = (ratio: number, dt: number) => ((ratio - 1) * YEAR) / dt;

export type RateFn = (a: Pt, b: Pt) => number | null;
export const RATE = {
  tydroSupply: (sym: string): RateFn => (a, b) => {
    const x = tyd(a, sym)?.liquidityIndex;
    const y = tyd(b, sym)?.liquidityIndex;
    return x && y ? ann(y / x, b.at - a.at) : null;
  },
  tydroBorrow: (sym: string): RateFn => (a, b) => {
    const x = tyd(a, sym)?.borrowIndex;
    const y = tyd(b, sym)?.borrowIndex;
    return x && y ? ann(y / x, b.at - a.at) : null;
  },
  nadoDeposit: (id: number): RateFn => (a, b) => {
    const x = spot(a, id)?.depositMultiplier;
    const y = spot(b, id)?.depositMultiplier;
    return x && y ? ann(y / x, b.at - a.at) : null;
  },
  nadoBorrow: (id: number): RateFn => (a, b) => {
    const x = spot(a, id)?.borrowMultiplier;
    const y = spot(b, id)?.borrowMultiplier;
    return x && y ? ann(y / x, b.at - a.at) : null;
  },
  /** what a SHORT receives (positive) or pays (negative), per $1 of notional */
  fundingShort: (id: number): RateFn => (a, b) => {
    const x = perp(a, id);
    const y = perp(b, id);
    if (!x || !y || !(x.priceUsd > 0) || !(y.priceUsd > 0)) return null;
    return (((y.cumFundingShort - x.cumFundingShort) / ((x.priceUsd + y.priceUsd) / 2)) * YEAR) / (b.at - a.at);
  },
  /** what a LONG pays (positive = pays) per $1 of notional */
  fundingLongPays: (id: number): RateFn => (a, b) => {
    const x = perp(a, id);
    const y = perp(b, id);
    if (!x || !y || !(x.priceUsd > 0) || !(y.priceUsd > 0)) return null;
    return (((y.cumFundingLong - x.cumFundingLong) / ((x.priceUsd + y.priceUsd) / 2)) * YEAR) / (b.at - a.at);
  },
  /** growth of an asset's Tydro price relative to its base (LST staking, yield-bearing stables) */
  appreciation: (sym: string, base: string): RateFn => (a, b) => {
    const r = (p: Pt) => {
      const s = tyd(p, sym)?.priceUsd;
      const q = tyd(p, base)?.priceUsd;
      return s && q ? s / q : null;
    };
    const x = r(a);
    const y = r(b);
    return x && y ? ann(y / x, b.at - a.at) : null;
  },
};

/* ───────────────────────── structures ───────────────────────── */

export type Risk = 'LOW' | 'MEDIUM' | 'HIGH' | 'UNKNOWN';
export interface Component {
  label: string;
  kind: 'yield' | 'cost' | 'funding';
  /** share of $1 capital this leg applies to */
  weight: number;
  /** annual rate of the leg itself (for a cost: what is paid, positive) */
  current: number | null;
  basis: string;
  d1: number | null;
  d7: number | null;
  d30: number | null;
  source: string;
}
export interface Window {
  /** net annual rate per $1 of capital */
  net: number | null;
  /** hours the window actually spans */
  hours: number | null;
}
export interface Structure {
  id: string;
  kind: 'lend' | 'cash-and-carry' | 'borrowed-hedge';
  title: string;
  venues: Array<'tydro' | 'nado'>;
  assets: string[];
  sizing: string;
  components: Component[];
  /** current-basis figures, per $1 of capital, annual (APR) */
  gross: number | null;
  borrowCost: number | null;
  funding: number | null;
  net: number | null;
  windows: { d1: Window; d7: Window; d30: Window };
  /** daily net over the recorded days (oldest first) */
  daily: Array<{ at: number; net: number | null }>;
  range: { min: number | null; max: number | null; days: number };
  fees: { oneOffUsd: number | null; perCapital: number; items: string[]; missing: string[]; asRateIfHeld: number | null; holdDays: number };
  capacity: { usd: number | null; text: string };
  liquidity: string[];
  liquidation: { pctUp: number | null; pctDown: number | null; text: string };
  factors: Array<{ key: 'funding-reversal' | 'liquidation' | 'stablecoin' | 'oracle' | 'protocol-change' | 'capacity' | 'data'; risk: Risk; text: string }>;
  risk: Risk;
  completeness: 'COMPLETE' | 'PARTIAL' | 'UNAVAILABLE';
  missing: string[];
  sources: string[];
  assumptions: string[];
  notes: string[];
}

export interface CarryFile {
  v: 1;
  kind: 'aegis-carry';
  version: string;
  generatedAt: string;
  block: number;
  at: number;
  /** checkpoints used: time span and count */
  history: { days: number; from: number | null; gaps: number };
  structures: Structure[];
  markets: {
    tydro: Array<{
      symbol: string;
      priceUsd: number | null;
      supplyApr: number | null;
      borrowApr: number | null;
      utilization: number | null;
      availableUsd: number | null;
      supplyHeadroomUsd: number | null;
      borrowHeadroomUsd: number | null;
      supply7: number | null;
      supply30: number | null;
      borrow7: number | null;
      borrow30: number | null;
      flags: string[];
    }>;
    nadoSpot: Array<{ productId: number; symbol: string | null; depositsUsd: number; borrowsUsd: number; utilization: number | null; deposit1: number | null; deposit7: number | null; deposit30: number | null; borrow1: number | null; borrow7: number | null; withdrawFeeUsd: number }>;
    funding: Array<{ productId: number; symbol: string | null; priceUsd: number; openInterestUsd: number; short1: number | null; short7: number | null; short30: number | null; longPays1: number | null; negativeDays: number; days: number }>;
  };
  existing: { carryWallets: number | null; nearOrWorse: number | null; ifEthUp10: number | null; ifEthDown10: number | null; stress: string | null; pressureBlock: number | null; note: string };
  gas: { gasPriceGwei: number | null; l1FeeUpperBoundUsd: number | null; perTxUsd: number | null; note: string };
  equities: string;
  methodology: { version: string; rules: string[]; assumptions: string[]; definitions: Record<string, string> };
  errors: string[];
}

export interface CarryInput {
  head: CarryPoint;
  /** daily checkpoints, any order; those after head are ignored */
  days: readonly CarryPoint[];
  pressure?: PressureSnapshot | null;
  oracle?: OracleWatch | null;
  /** change records from the last 30 days */
  changes?: readonly ChangeRecord[];
  gas?: GasRead | null;
  /** Nado open-interest coverage (min of longs/shorts) for the Ink Stress Level's confidence; null = not measured */
  oiCoverage?: number | null;
  nowMs?: number;
}

const RISK_ORDER: Record<Risk, number> = { LOW: 0, UNKNOWN: 1, MEDIUM: 2, HIGH: 3 };
const worst = (rs: Risk[]): Risk => rs.reduce<Risk>((m, r) => (RISK_ORDER[r] > RISK_ORDER[m] ? r : m), 'LOW');
const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
const usd = (x: number) => `$${Math.round(x).toLocaleString('en-US')}`;
const sum = (xs: Array<number | null>) => (xs.some((x) => x === null) ? null : (xs as number[]).reduce((a, b) => a + b, 0));

interface Leg {
  label: string;
  kind: Component['kind'];
  weight: number;
  rate: RateFn;
  /** the protocol's own current rate, when it publishes one */
  current?: (p: Pt) => number | null;
  source: string;
}

function buildStructure(
  base: Omit<Structure, 'components' | 'gross' | 'borrowCost' | 'funding' | 'net' | 'windows' | 'daily' | 'range' | 'factors' | 'risk' | 'completeness' | 'missing' | 'fees' | 'capacity' | 'liquidity' | 'liquidation'>,
  legs: Leg[],
  ctx: Ctx,
  extra: {
    fees: Structure['fees'];
    capacity: Structure['capacity'];
    liquidity: string[];
    liquidation: Structure['liquidation'];
    stables: string[];
    oracleAssets: string[];
    subjects: string[];
    blockers: string[];
    missing: string[];
  },
): Structure {
  const signed = (l: Leg, r: number | null) => (r === null ? null : (l.kind === 'cost' ? -r : r) * l.weight);
  const at = (a: Pt | null, b: Pt) => (a ? legs.map((l) => l.rate(a, b)) : legs.map(() => null));
  const comps: Component[] = legs.map((l) => {
    const d1 = ctx.w1 ? l.rate(ctx.w1, ctx.head) : null;
    const cur = l.current ? l.current(ctx.head) : d1;
    return {
      label: l.label,
      kind: l.kind,
      weight: l.weight,
      current: cur,
      basis: l.current ? 'current rate published by the contract' : `observed since the last daily checkpoint${ctx.w1 ? ` (${((ctx.head.at - ctx.w1.at) / 3_600_000).toFixed(0)} h)` : ''} — no current rate is published`,
      d1,
      d7: ctx.w7 ? l.rate(ctx.w7, ctx.head) : null,
      d30: ctx.w30 ? l.rate(ctx.w30, ctx.head) : null,
      source: l.source,
    };
  });
  const part = (k: Component['kind']) => {
    const xs = comps.filter((c) => c.kind === k);
    return xs.length ? sum(xs.map((c) => (c.current === null ? null : c.current * c.weight))) : 0;
  };
  const gross = part('yield');
  const borrowCost = part('cost');
  const funding = part('funding');
  const net = gross === null || borrowCost === null || funding === null ? null : gross - borrowCost + funding;
  const win = (a: Pt | null): Window => ({ net: a ? sum(at(a, ctx.head).map((r, i) => signed(legs[i]!, r))) : null, hours: a ? (ctx.head.at - a.at) / 3_600_000 : null });
  const daily = ctx.pairs.map(([a, b]) => ({ at: b.at, net: sum(legs.map((l) => signed(l, l.rate(a, b)))) }));
  const dn = daily.map((d) => d.net).filter((x): x is number => x !== null);
  const range = { min: dn.length ? Math.min(...dn) : null, max: dn.length ? Math.max(...dn) : null, days: dn.length };

  // risk factors (deterministic; methodology lists the same rules)
  const factors: Structure['factors'] = [];
  const fundLegs = legs.filter((l) => l.kind === 'funding');
  if (fundLegs.length) {
    const negDays = ctx.pairs.filter(([a, b]) => fundLegs.some((l) => (l.rate(a, b) ?? 0) < 0)).length;
    const d1neg = comps.filter((c) => c.kind === 'funding').some((c) => (c.d1 ?? 0) < 0);
    const r: Risk = !ctx.pairs.length ? 'UNKNOWN' : d1neg || negDays >= CARRY.REVERSAL_HIGH_DAYS ? 'HIGH' : negDays >= CARRY.REVERSAL_MED_DAYS ? 'MEDIUM' : 'LOW';
    factors.push({ key: 'funding-reversal', risk: r, text: ctx.pairs.length ? `funding went against this position on ${negDays} of the last ${ctx.pairs.length} recorded days${d1neg ? ', including the last 24 h' : ''}` : 'no daily funding history yet' });
  }
  const lq = extra.liquidation;
  const adverse = [lq.pctUp, lq.pctDown].filter((x): x is number => x !== null);
  factors.push({
    key: 'liquidation',
    risk: !adverse.length ? 'LOW' : Math.min(...adverse) < CARRY.LIQ_HIGH_PCT ? 'HIGH' : Math.min(...adverse) < CARRY.LIQ_MED_PCT ? 'MEDIUM' : 'LOW',
    text: lq.text,
  });
  if (extra.stables.length) {
    const st = extra.stables.map((s) => ({ s, status: ctx.oracleStatus(s) }));
    const r = worst(st.map(({ status }) => (status === null ? 'UNKNOWN' : status === 'DEPEG' || status === 'INVALID' ? 'HIGH' : status === 'WARN' || status === 'DIVERGENT' ? 'MEDIUM' : 'LOW')));
    factors.push({ key: 'stablecoin', risk: r, text: `holds ${extra.stables.join(', ')} — Oracle Watch: ${st.map(({ s, status }) => `${s} ${status ?? 'not read'}`).join(', ')}` });
  }
  {
    const st = extra.oracleAssets.map((s) => ({ s, status: ctx.oracleStatus(s) }));
    const r = !ctx.oracle ? 'UNKNOWN' : worst(st.map(({ status }) => (status === null ? 'UNKNOWN' : status === 'OK' ? 'LOW' : status === 'WARN' || status === 'UNAVAILABLE' ? 'MEDIUM' : 'HIGH')));
    factors.push({ key: 'oracle', risk: r, text: ctx.oracle ? `prices that decide this structure's margin: ${st.map(({ s, status }) => `${s} ${status ?? 'not read'}`).join(', ')}` : 'Oracle Watch not available this run' });
  }
  {
    const hits = (ctx.changes ?? []).filter((c) => extra.subjects.some((s) => c.subject === s || c.subject.startsWith(`${s}#`)) || c.subject === 'protocol');
    const r: Risk = extra.blockers.length ? 'HIGH' : hits.length ? 'MEDIUM' : 'LOW';
    factors.push({
      key: 'protocol-change',
      risk: r,
      text: extra.blockers.length ? extra.blockers.join('; ') : hits.length ? `${hits.length} recorded parameter change(s) in the last 30 days touch this structure (see CHANGES)` : 'no recorded parameter change in the last 30 days touches it (monitoring began with Release 3)',
    });
  }
  {
    const c = extra.capacity.usd;
    factors.push({ key: 'capacity', risk: c === null ? 'LOW' : c < CARRY.CAPACITY_HIGH_USD ? 'HIGH' : c < CARRY.CAPACITY_MED_USD ? 'MEDIUM' : 'LOW', text: extra.capacity.text });
  }
  const ageH = (ctx.nowMs - ctx.head.at) / 3_600_000;
  const missing = [...extra.missing, ...(ctx.w1 ? [] : ['no 24 h window yet']), ...(ctx.w30 ? [] : ['under 30 days of history yet'])];
  factors.push({ key: 'data', risk: ageH > CARRY.STALE_H ? 'HIGH' : net === null ? 'HIGH' : missing.length ? 'MEDIUM' : 'LOW', text: `read ${ageH.toFixed(1)} h ago at block ${ctx.head.block.toLocaleString('en-US')}${missing.length ? ` · missing: ${missing.join('; ')}` : ''}` });

  return {
    ...base,
    components: comps,
    gross,
    borrowCost,
    funding,
    net,
    windows: { d1: win(ctx.w1), d7: win(ctx.w7), d30: win(ctx.w30) },
    daily,
    range,
    fees: extra.fees,
    capacity: extra.capacity,
    liquidity: extra.liquidity,
    liquidation: extra.liquidation,
    factors,
    risk: worst(factors.map((f) => f.risk)),
    completeness: net === null ? 'UNAVAILABLE' : missing.length ? 'PARTIAL' : 'COMPLETE',
    missing,
  };
}

interface Ctx {
  head: Pt;
  w1: Pt | null;
  w7: Pt | null;
  w30: Pt | null;
  pairs: Array<[Pt, Pt]>;
  nowMs: number;
  oracle: OracleWatch | null;
  oracleStatus: (sym: string) => OracleStatus | null;
  changes: readonly ChangeRecord[];
}

/* ───────────────────────── the whole file ───────────────────────── */

export function buildCarry(o: CarryInput): CarryFile {
  const head = o.head;
  const nowMs = o.nowMs ?? head.at;
  const days = [...o.days].filter((d) => d.at < head.at).sort((a, b) => a.at - b.at);
  // a window's start: the checkpoint nearest to head − w, within a quarter of w (at least 13 h: checkpoints are
  // daily, so "24 h" really spans 12–36 h — the span actually used is published with every window)
  const near = (w: number) => {
    const target = head.at - w;
    const tol = Math.max(w / 4, 13 * 3_600_000);
    let best: Pt | null = null;
    for (const d of days) if (Math.abs(d.at - target) <= tol && (!best || Math.abs(d.at - target) < Math.abs(best.at - target))) best = d;
    return best;
  };
  const D = 86_400_000;
  const pairs: Array<[Pt, Pt]> = [];
  for (let i = 1; i < days.length; i++) {
    const h = (days[i]!.at - days[i - 1]!.at) / 3_600_000;
    if (h >= CARRY.DAY_MIN_H && h <= CARRY.DAY_MAX_H) pairs.push([days[i - 1]!, days[i]!]);
  }
  const recent = pairs.slice(-CARRY.DAYS);
  const gaps = Math.max(0, days.length - 1 - pairs.length);
  const watch = o.oracle ?? null;
  const ctx: Ctx = {
    head,
    w1: near(D),
    w7: near(7 * D),
    w30: near(30 * D),
    pairs: recent,
    nowMs,
    oracle: watch,
    oracleStatus: (sym) => (watch ? (watch.rows.find((r) => r.symbol === ORACLE_SYMBOL(sym))?.status ?? null) : null),
    changes: o.changes ?? [],
  };
  const errors = [...head.errors];

  const ethUsd = tyd(head, 'WETH')?.priceUsd ?? null;
  const gas = o.gas ?? null;
  const perTxWei = gas?.gasPriceWei !== null && gas?.gasPriceWei !== undefined ? gas.gasPriceWei * CARRY.GAS_UNITS + (gas.l1FeeUpperBoundWei ?? 0) : null;
  const perTxUsd = perTxWei !== null && ethUsd ? (perTxWei / 1e18) * ethUsd : null;
  const gasNote =
    gas === null
      ? 'gas not read this run'
      : `${CARRY.GAS_UNITS.toLocaleString('en-US')} gas units per transaction (assumed) at ${gas.gasPriceWei !== null ? `${(gas.gasPriceWei / 1e9).toFixed(4)} gwei` : 'an unread gas price'}${gas.l1FeeUpperBoundWei !== null ? `, plus Ink's L1 data fee (upper bound for a ${gas.txBytes}-byte transaction, from the OP-stack GasPriceOracle)` : ' — the L1 data fee could not be read and is NOT included'}`;

  const perpBy = (sym: string) => head.nado?.perp.find((p) => p.symbol === sym) ?? null;
  const spotByToken = (token: string) => head.nado?.spot.find((s) => s.token === token) ?? null;
  const usdtQuote = head.nado?.spot.find((s) => s.productId === NADO_QUOTE) ?? null;

  const tydroCapacity = (sym: string, side: 'supply' | 'borrow'): { usd: number | null; text: string; blockers: string[] } => {
    const t = tyd(head, sym);
    if (!t || t.priceUsd === null) return { usd: null, text: `${sym}: Tydro market not read`, blockers: [] };
    const blockers: string[] = [];
    if (t.isActive === false) blockers.push(`Tydro ${sym} is not active`);
    if (t.isFrozen) blockers.push(`Tydro ${sym} is frozen (no new supply or borrowing)`);
    if (side === 'borrow' && t.borrowingEnabled === false) blockers.push(`borrowing ${sym} is disabled on Tydro`);
    if (blockers.length) return { usd: 0, text: blockers.join('; '), blockers };
    if (side === 'supply') {
      if (!t.supplyCap) return { usd: null, text: `Tydro ${sym}: no supply cap`, blockers };
      const room = Math.max(0, t.supplyCap - (t.supplied ?? 0)) * t.priceUsd;
      return { usd: room, text: `Tydro ${sym} supply cap room ≈ ${usd(room)}`, blockers };
    }
    const avail = t.available !== null ? t.available * t.priceUsd : null;
    const capRoom = t.borrowCap ? Math.max(0, t.borrowCap - (t.borrowed ?? 0)) * t.priceUsd : null;
    const room = [avail, capRoom].filter((x): x is number => x !== null);
    const v = room.length ? Math.min(...room) : null;
    return { usd: v, text: `Tydro ${sym} can lend ≈ ${v === null ? 'unknown' : usd(v)} now (${avail !== null ? `available liquidity ${usd(avail)}` : 'liquidity not read'}${capRoom !== null ? `, borrow cap room ${usd(capRoom)}` : ', no borrow cap'})`, blockers };
  };
  const minCap = (xs: Array<{ usd: number | null; text: string }>, scale: number[]) => {
    const vals = xs.map((x, i) => (x.usd === null ? null : x.usd / scale[i]!)).filter((x): x is number => x !== null);
    return { usd: vals.length ? Math.min(...vals) : null, text: `${xs.map((x) => x.text).join('; ')}${vals.length ? ` → about ${usd(Math.min(...vals))} of capital before a limit binds (before slippage)` : ' → no cap Phrourax can read'}` };
  };
  const nadoWithdrawUsd = (s: NadoSpotMarket | null) => (s ? s.withdrawFee * s.priceUsd : null);
  const fees = (txs: number, nadoWithdrawals: Array<NadoSpotMarket | null>, nadoTrades: boolean): Structure['fees'] => {
    const items: string[] = [];
    const missing: string[] = [];
    const g = perTxUsd !== null ? perTxUsd * txs : null;
    if (g !== null) items.push(`gas ≈ $${g.toFixed(2)} for ${txs} transactions (open and close)`);
    else missing.push('gas cost (not read)');
    let wd = 0;
    for (const s of nadoWithdrawals) {
      const f = nadoWithdrawUsd(s);
      if (f === null) missing.push('Nado withdrawal fee (not read)');
      else {
        wd += f;
        items.push(`Nado withdrawal fee ${s!.symbol ?? `#${s!.productId}`} ≈ $${f.toFixed(2)}`);
      }
    }
    if (nadoTrades) missing.push('Nado trading fee (not exposed on-chain; not included)');
    items.push('Tydro charges no entry or exit fee (its reserve factor is already inside the rates shown)');
    const total = g === null ? null : g + wd;
    return {
      oneOffUsd: total,
      perCapital: CARRY.EXAMPLE_CAPITAL,
      items,
      missing,
      asRateIfHeld: total === null ? null : (total / CARRY.EXAMPLE_CAPITAL) * (365 / CARRY.EXAMPLE_HOLD_DAYS),
      holdDays: CARRY.EXAMPLE_HOLD_DAYS,
    };
  };

  const structures: Structure[] = [];

  // 1 ── lend a stablecoin on Tydro (the baseline every carry is compared with)
  for (const [sym, st] of Object.entries(STABLES)) {
    const t = tyd(head, sym);
    if (!t) continue;
    const legs: Leg[] = [{ label: `${st.label} supply rate on Tydro`, kind: 'yield', weight: 1, rate: RATE.tydroSupply(sym), current: (p) => tyd(p, sym)?.supplyApr ?? null, source: 'Tydro AaveProtocolDataProvider.getReserveData (liquidityRate, liquidityIndex)' }];
    if (st.base) legs.push({ label: `${st.label} appreciation vs ${ORACLE_SYMBOL(st.base)} (Tydro's own prices)`, kind: 'yield', weight: 1, rate: RATE.appreciation(sym, st.base), source: 'Tydro AaveOracle.getAssetsPrices (price ratio over time)' });
    const cap = tydroCapacity(sym, 'supply');
    structures.push(
      buildStructure(
        {
          id: `lend-tydro-${sym}`,
          kind: 'lend',
          title: `Lend ${st.label} on Tydro`,
          venues: ['tydro'],
          assets: [st.label],
          sizing: `$1 of ${st.label} supplied`,
          sources: legs.map((l) => l.source),
          assumptions: ['no leverage', ...(st.base ? ['appreciation is read from Tydro’s price feed, which may be capped by its adapter'] : [])],
          notes: [],
        },
        legs,
        ctx,
        {
          fees: fees(3, [], false),
          capacity: minCap([cap], [1]),
          liquidity: [t.available !== null && t.priceUsd ? `Tydro ${st.label} available to withdraw ≈ ${usd(t.available * t.priceUsd)}` : `Tydro ${st.label} liquidity not read`],
          liquidation: { pctUp: null, pctDown: null, text: 'no borrowing: no liquidation path' },
          stables: [st.label],
          oracleAssets: [ORACLE_SYMBOL(sym)],
          subjects: [sym],
          blockers: cap.blockers,
          missing: [],
        },
      ),
    );
  }

  // 2 ── deposit a stablecoin on Nado
  for (const s of head.nado?.spot ?? []) {
    const label = s.symbol ?? `#${s.productId}`;
    if (!['USDT0', 'USDC'].includes(label)) continue;
    const legs: Leg[] = [{ label: `${label} deposit rate on Nado`, kind: 'yield', weight: 1, rate: RATE.nadoDeposit(s.productId), source: 'Nado FQuerier.getSubaccountInfo (cumulativeDepositsMultiplierX18)' }];
    structures.push(
      buildStructure(
        { id: `lend-nado-${s.productId}`, kind: 'lend', title: `Deposit ${label} on Nado`, venues: ['nado'], assets: [label], sizing: `$1 of ${label} deposited`, sources: legs.map((l) => l.source), assumptions: ['no leverage', 'Nado publishes no current rate: the figure is what deposits earned since the last daily checkpoint (12–36 h)'], notes: [] },
        legs,
        ctx,
        {
          fees: fees(3, [s], false),
          capacity: { usd: null, text: 'Nado: no deposit cap Phrourax can read' },
          liquidity: [`Nado ${label} deposits ${usd(s.deposits * s.priceUsd)} · borrowed ${usd(s.borrows * s.priceUsd)}`],
          liquidation: { pctUp: null, pctDown: null, text: 'no borrowing: no liquidation path' },
          stables: [label],
          oracleAssets: [label === 'USDT0' ? 'USDT0' : label],
          subjects: [label],
          blockers: [],
          missing: [],
        },
      ),
    );
  }

  // 3 ── spot + short perp, both on Nado (one account: the spot is the perp's margin)
  for (const s of head.nado?.spot ?? []) {
    const t = head.tydro.find((x) => x.asset === s.token);
    const h = t ? HEDGE[t.symbol] : undefined;
    const p = h ? perpBy(h.perp) : null;
    if (!t || !h || !p || h.base) continue;
    const label = t.symbol;
    const legs: Leg[] = [
      { label: `${label} deposit rate on Nado`, kind: 'yield', weight: 1, rate: RATE.nadoDeposit(s.productId), source: 'Nado FQuerier.getSubaccountInfo (cumulativeDepositsMultiplierX18)' },
      { label: `${h.perp} funding received by a short`, kind: 'funding', weight: 1, rate: RATE.fundingShort(p.productId), source: 'Nado FQuerier.getSubaccountInfo (cumulativeFundingShortX18 ÷ oracle price)' },
    ];
    const wDiff = p.shortWeightMaintenance - s.longWeightMaintenance;
    const up = wDiff > 0 ? (1 / wDiff - 1) * 100 : null;
    structures.push(
      buildStructure(
        {
          id: `cc-nado-${s.productId}-${p.productId}`,
          kind: 'cash-and-carry',
          title: `Hold ${label} on Nado + short ${h.perp}`,
          venues: ['nado'],
          assets: [label, h.perp],
          sizing: `$1 of ${label} deposited on Nado, $1 of ${h.perp} sold short in the same account`,
          sources: legs.map((l) => l.source),
          assumptions: ['the spot deposit is the only margin', 'price-neutral while the hedge holds; Nado’s spread margin may treat the pair better than this simple model'],
          notes: [h.relation],
        },
        legs,
        ctx,
        {
          fees: fees(3, [s], true),
          capacity: { usd: null, text: `Nado: no position cap Phrourax can read; ${h.perp} open interest ≈ ${usd(p.openInterest * p.priceUsd)} (market size, not a limit)` },
          liquidity: [`${h.perp} open interest ≈ ${usd(p.openInterest * p.priceUsd)}`, `Nado ${label} deposits ${usd(s.deposits * s.priceUsd)}`],
          liquidation: {
            pctUp: up,
            pctDown: null,
            text: up === null ? 'not computable from the weights read' : `liquidated only if ${label} rises about ${up.toFixed(0)}% (maintenance weights: spot ${s.longWeightMaintenance}, short ${p.shortWeightMaintenance}); a fall improves the account`,
          },
          stables: ['USDT0'],
          oracleAssets: [label],
          subjects: [label, h.perp],
          blockers: [],
          missing: [],
        },
      ),
    );
  }

  // 4 ── supply on Tydro + short perp on Nado (USDT0 margin)
  for (const [sym, h] of Object.entries(HEDGE)) {
    const t = tyd(head, sym);
    const p = perpBy(h.perp);
    if (!t || !p || !usdtQuote) continue;
    const m = CARRY.TYDRO_HEDGE_MARGIN;
    const wX = 1 / (1 + m);
    const wM = m / (1 + m);
    const legs: Leg[] = [
      { label: `${sym} supply rate on Tydro`, kind: 'yield', weight: wX, rate: RATE.tydroSupply(sym), current: (q) => tyd(q, sym)?.supplyApr ?? null, source: 'Tydro AaveProtocolDataProvider.getReserveData (liquidityRate, liquidityIndex)' },
      ...(h.base ? [{ label: `${sym} staking appreciation vs ETH (Tydro's own prices)`, kind: 'yield' as const, weight: wX, rate: RATE.appreciation(sym, h.base), source: 'Tydro AaveOracle.getAssetsPrices (price ratio over time)' }] : []),
      { label: `${h.perp} funding received by a short`, kind: 'funding', weight: wX, rate: RATE.fundingShort(p.productId), source: 'Nado FQuerier.getSubaccountInfo (cumulativeFundingShortX18 ÷ oracle price)' },
      { label: 'USDT0 margin deposit rate on Nado', kind: 'yield', weight: wM, rate: RATE.nadoDeposit(NADO_QUOTE), source: 'Nado FQuerier.getSubaccountInfo (USDT0 cumulativeDepositsMultiplierX18)' },
    ];
    const up = ((1 + m) / p.shortWeightMaintenance - 1) * 100;
    const cap = tydroCapacity(sym, 'supply');
    structures.push(
      buildStructure(
        {
          id: `cc-tydro-${sym}`,
          kind: 'cash-and-carry',
          title: `Supply ${sym} on Tydro + short ${h.perp} on Nado`,
          venues: ['tydro', 'nado'],
          assets: [sym, h.perp, 'USDT0'],
          sizing: `per $1: ${(wX * 100).toFixed(0)}¢ of ${sym} supplied on Tydro, the same amount of ${h.perp} short on Nado, ${(wM * 100).toFixed(0)}¢ of USDT0 as its margin`,
          sources: legs.map((l) => l.source),
          assumptions: [`Nado margin = ${(m * 100).toFixed(0)}% of the hedge (assumed)`, 'the two legs sit in different protocols: a loss on the short is NOT offset by the Tydro side inside Nado’s margin', ...(h.base ? ['staking appreciation is read from Tydro’s capped price feed'] : [])],
          notes: [h.relation],
        },
        legs,
        ctx,
        {
          fees: fees(6, [usdtQuote], true),
          capacity: minCap([cap], [wX]),
          liquidity: [`${h.perp} open interest ≈ ${usd(p.openInterest * p.priceUsd)}`, t.available !== null && t.priceUsd ? `Tydro ${sym} available ≈ ${usd(t.available * t.priceUsd)}` : `Tydro ${sym} liquidity not read`],
          liquidation: { pctUp: up, pctDown: null, text: `the Nado short is liquidated if ${h.perp.replace('-PERP', '')} rises about ${up.toFixed(0)}% before margin is added (margin ${(m * 100).toFixed(0)}%, short maintenance weight ${p.shortWeightMaintenance}); the Tydro side has no debt` },
          stables: ['USDT0'],
          oracleAssets: [sym, 'USDT0'],
          subjects: [sym, h.perp],
          blockers: cap.blockers,
          missing: [],
        },
      ),
    );
  }

  // 5 ── borrowed asset + hedge: supply X on Tydro, borrow a stablecoin against it, use it as Nado margin, short the
  //      perp. The stablecoin is whichever one Tydro lets you borrow NOW (read each run) that Nado also takes as
  //      margin (same token address) — USDT0 (Nado's quote) preferred, then USDC.
  const borrowStable = (() => {
    const cands = ['USDT', 'USDC']
      .map((sym) => ({ sym, t: tyd(head, sym), n: head.nado?.spot.find((s) => s.token === tyd(head, sym)?.asset) ?? null }))
      .filter((c): c is { sym: string; t: TydroMarket; n: NadoSpotMarket } => !!c.t && !!c.n);
    return cands.find((c) => c.t.borrowingEnabled !== false && c.t.isActive !== false && !c.t.isFrozen) ?? cands[0] ?? null;
  })();
  for (const sym of borrowStable ? ['WETH', 'kBTC'] : []) {
    const h = HEDGE[sym]!;
    const t = tyd(head, sym);
    const p = perpBy(h.perp);
    const { sym: bs, n: bn } = borrowStable!;
    const bl = ORACLE_SYMBOL(bs);
    if (!t || !p) continue;
    const b = t.ltv !== null ? (t.ltv / 10_000) * CARRY.BORROW_SHARE_OF_LTV : null;
    if (b === null || !t.liquidationThreshold) continue;
    const lt = t.liquidationThreshold / 10_000;
    const legs: Leg[] = [
      { label: `${sym} supply rate on Tydro`, kind: 'yield', weight: 1, rate: RATE.tydroSupply(sym), current: (q) => tyd(q, sym)?.supplyApr ?? null, source: 'Tydro AaveProtocolDataProvider.getReserveData (liquidityRate, liquidityIndex)' },
      { label: `${bl} borrow rate on Tydro`, kind: 'cost', weight: b, rate: RATE.tydroBorrow(bs), current: (q) => tyd(q, bs)?.borrowApr ?? null, source: 'Tydro AaveProtocolDataProvider.getReserveData (variableBorrowRate, variableBorrowIndex)' },
      { label: `${bl} margin deposit rate on Nado`, kind: 'yield', weight: b, rate: RATE.nadoDeposit(bn.productId), source: `Nado FQuerier.getSubaccountInfo (${bl} cumulativeDepositsMultiplierX18)` },
      { label: `${h.perp} funding received by a short`, kind: 'funding', weight: 1, rate: RATE.fundingShort(p.productId), source: 'Nado FQuerier.getSubaccountInfo (cumulativeFundingShortX18 ÷ oracle price)' },
    ];
    const marginW = bn.longWeightMaintenance > 0 ? bn.longWeightMaintenance : 1;
    const down = (1 - b / lt) * 100;
    const up = ((1 + b * marginW) / p.shortWeightMaintenance - 1) * 100;
    const supCap = tydroCapacity(sym, 'supply');
    const borCap = tydroCapacity(bs, 'borrow');
    structures.push(
      buildStructure(
        {
          id: `bh-${sym}`,
          kind: 'borrowed-hedge',
          title: `Supply ${sym} on Tydro, borrow ${bl} as Nado margin, short ${h.perp}`,
          venues: ['tydro', 'nado'],
          assets: [sym, bl, h.perp],
          sizing: `per $1 of ${sym} supplied: borrow ${(b * 100).toFixed(0)}¢ of ${bl} (half of Tydro's ${(t.ltv! / 100).toFixed(0)}% LTV), deposit it on Nado, short $1 of ${h.perp}`,
          sources: legs.map((l) => l.source),
          assumptions: [
            `borrow ${(CARRY.BORROW_SHARE_OF_LTV * 100).toFixed(0)}% of the LTV allowance (assumed)`,
            `${bl} is the stablecoin Tydro lets you borrow at this block that Nado also takes as margin (checked every run)`,
            'no rebalancing: both liquidation distances are from the opening price',
          ],
          notes: [h.relation, 'Two-sided: a fall threatens the Tydro loan, a rise threatens the Nado short — each side has to be watched on its own venue.'],
        },
        legs,
        ctx,
        {
          fees: fees(9, [bn], true),
          capacity: minCap([supCap, borCap], [1, b]),
          liquidity: [borCap.text, `${h.perp} open interest ≈ ${usd(p.openInterest * p.priceUsd)}`],
          liquidation: {
            pctUp: up,
            pctDown: down,
            text: `Tydro loan liquidated if ${sym} falls about ${down.toFixed(0)}% (liquidation threshold ${(lt * 100).toFixed(0)}%); Nado short liquidated if it rises about ${up.toFixed(0)}% (${bl} margin ${(b * 100).toFixed(0)}% at maintenance weight ${marginW}, short maintenance weight ${p.shortWeightMaintenance})`,
          },
          stables: [bl],
          oracleAssets: [sym, bl],
          subjects: [sym, bs, h.perp],
          blockers: [...supCap.blockers, ...borCap.blockers],
          missing: [],
        },
      ),
    );
  }

  /* ── market tables ── */
  const r = (f: RateFn, a: Pt | null) => (a ? f(a, head) : null);
  const tydroRows = head.tydro.map((t) => {
    const flags = [t.isFrozen ? 'frozen' : '', t.isActive === false ? 'inactive' : '', t.borrowingEnabled === false ? 'borrowing off' : ''].filter(Boolean);
    const px = t.priceUsd;
    return {
      symbol: ORACLE_SYMBOL(t.symbol),
      priceUsd: px,
      supplyApr: t.supplyApr,
      borrowApr: t.borrowApr,
      utilization: t.supplied && t.borrowed !== null ? t.borrowed / t.supplied : null,
      availableUsd: t.available !== null && px ? t.available * px : null,
      supplyHeadroomUsd: t.supplyCap && px ? Math.max(0, t.supplyCap - (t.supplied ?? 0)) * px : null,
      borrowHeadroomUsd: t.borrowCap && px ? Math.max(0, t.borrowCap - (t.borrowed ?? 0)) * px : null,
      supply7: r(RATE.tydroSupply(t.symbol), ctx.w7),
      supply30: r(RATE.tydroSupply(t.symbol), ctx.w30),
      borrow7: r(RATE.tydroBorrow(t.symbol), ctx.w7),
      borrow30: r(RATE.tydroBorrow(t.symbol), ctx.w30),
      flags,
    };
  });
  const nadoSpot = (head.nado?.spot ?? []).map((s) => ({
    productId: s.productId,
    symbol: s.symbol,
    depositsUsd: s.deposits * s.priceUsd,
    borrowsUsd: s.borrows * s.priceUsd,
    utilization: s.deposits > 0 ? s.borrows / s.deposits : null,
    deposit1: r(RATE.nadoDeposit(s.productId), ctx.w1),
    deposit7: r(RATE.nadoDeposit(s.productId), ctx.w7),
    deposit30: r(RATE.nadoDeposit(s.productId), ctx.w30),
    borrow1: r(RATE.nadoBorrow(s.productId), ctx.w1),
    borrow7: r(RATE.nadoBorrow(s.productId), ctx.w7),
    withdrawFeeUsd: s.withdrawFee * s.priceUsd,
  }));
  const funding = (head.nado?.perp ?? [])
    .map((p) => {
      const f = RATE.fundingShort(p.productId);
      return {
        productId: p.productId,
        symbol: p.symbol,
        priceUsd: p.priceUsd,
        openInterestUsd: p.openInterest * p.priceUsd,
        short1: r(f, ctx.w1),
        short7: r(f, ctx.w7),
        short30: r(f, ctx.w30),
        longPays1: r(RATE.fundingLongPays(p.productId), ctx.w1),
        negativeDays: recent.filter(([a, b]) => (f(a, b) ?? 0) < 0).length,
        days: recent.filter(([a, b]) => f(a, b) !== null).length,
      };
    })
    .sort((a, b) => b.openInterestUsd - a.openInterestUsd);

  /* ── existing carry behaviour (counts only) ── */
  const ps = o.pressure ?? null;
  let existing: CarryFile['existing'] = { carryWallets: null, nearOrWorse: null, ifEthUp10: null, ifEthDown10: null, stress: null, pressureBlock: null, note: 'Pressure Map not available this run' };
  if (ps) {
    const q = (sign: 'up' | 'down') => queryPressure(ps, { dir: 'ETH', sign, pct: 10, material: '0', dim: 't:CARRY' });
    const up = q('up');
    const down = q('down');
    existing = {
      carryWallets: up.population,
      nearOrWorse: up.now.N + up.now.L,
      ifEthUp10: up.safeToNear + up.watchToNear,
      ifEthDown10: down.safeToNear + down.watchToNear,
      stress: stressLevel(ps, { nowMs, oiCoverage: o.oiCoverage ?? null }).level,
      pressureBlock: ps.block,
      note: 'Wallets the rules classify as CARRY (a hedged position with debt or perps), from the last full Pressure Map — counts only, never who.',
    };
  }

  // tokenized equities: Nado lists them as spot (wAAPLx …) and as perps; none is Tydro collateral
  const equityBases = ['AAPL', 'TSLA', 'NVDA', 'SPY', 'QQQ', 'MSTR', 'COIN', 'AMZN', 'GOOGL', 'META', 'MSFT', 'HOOD', 'CRCL'];
  const isEquity = (s: string | null) => !!s && equityBases.some((b) => s.replace('-PERP', '').replace(/^w(.+)x$/, '$1') === b);
  const equityPerps = (head.nado?.perp ?? []).filter((p) => isEquity(p.symbol)).map((p) => p.symbol);
  const equitySpot = (head.nado?.spot ?? []).filter((s) => isEquity(s.symbol)).map((s) => s.symbol);
  const equities = `${equitySpot.length ? `Nado lists tokenized equities as spot (${equitySpot.join(', ')})` : 'Nado lists no tokenized-equity spot at this block'}${equityPerps.length ? ` and as perps (${equityPerps.join(', ')})` : ''}. None is Tydro collateral, so equity carry isn't modelled in ${CARRY.VERSION}; the equity spot rates and perp funding are in the tables below.`;

  return {
    v: 1,
    kind: 'aegis-carry',
    version: CARRY.VERSION,
    generatedAt: new Date(nowMs).toISOString(),
    block: head.block,
    at: head.at,
    history: { days: recent.length, from: recent[0]?.[0].at ?? null, gaps },
    structures,
    markets: { tydro: tydroRows, nadoSpot, funding },
    existing,
    gas: { gasPriceGwei: gas?.gasPriceWei != null ? gas.gasPriceWei / 1e9 : null, l1FeeUpperBoundUsd: gas?.l1FeeUpperBoundWei != null && ethUsd ? (gas.l1FeeUpperBoundWei / 1e18) * ethUsd : null, perTxUsd, note: gasNote },
    equities,
    methodology: {
      version: CARRY.VERSION,
      rules: [
        'Every rate is annual and not compounded (APR). Tydro publishes current rates; Nado does not, so Nado figures are observed over the stated window.',
        'Observed rates come from the change in the protocol’s own index, multiplier or cumulative funding between two readings — what was actually paid, not a model.',
        `Daily history uses checkpoints at 00:00 UTC; a pair counts as a day only if ${CARRY.DAY_MIN_H}–${CARRY.DAY_MAX_H} h apart (a missed day is a gap, never stretched).`,
        `Funding reversal: HIGH if funding went against the position in the last 24 h or on ${CARRY.REVERSAL_HIGH_DAYS}+ of the last ${CARRY.DAYS} days; MEDIUM on ${CARRY.REVERSAL_MED_DAYS}–${CARRY.REVERSAL_HIGH_DAYS - 1} days; else LOW.`,
        `Liquidation: the smallest adverse price move that liquidates a leg, from the protocols’ own weights and thresholds — HIGH under ${CARRY.LIQ_HIGH_PCT}%, MEDIUM under ${CARRY.LIQ_MED_PCT}%, else LOW; no borrowing = LOW.`,
        'Stablecoin: from Oracle Watch’s peg status of each stablecoin held — DEPEG/INVALID = HIGH, WARN/DIVERGENT = MEDIUM.',
        'Oracle: the worst Oracle Watch status among the prices that decide the structure’s margin — OK = LOW, WARN/UNAVAILABLE = MEDIUM, anything worse = HIGH.',
        'Protocol change: HIGH if a market is frozen, inactive or has borrowing off; MEDIUM if a recorded parameter change in the last 30 days touches it; else LOW.',
        `Capacity: the room before a cap or the available liquidity binds — HIGH under ${usd(CARRY.CAPACITY_HIGH_USD)}, MEDIUM under ${usd(CARRY.CAPACITY_MED_USD)}; no readable cap = LOW (and said so).`,
        `Data: HIGH if the reading is over ${CARRY.STALE_H} h old or the rate can't be computed; MEDIUM if a window or input is missing.`,
        'Risk state = the worst factor. Deterministic and versioned; no model or AI decides it.',
      ],
      assumptions: [
        `Nado margin for a short hedging a Tydro position: ${(CARRY.TYDRO_HEDGE_MARGIN * 100).toFixed(0)}% of the hedge.`,
        `Borrowing: ${(CARRY.BORROW_SHARE_OF_LTV * 100).toFixed(0)}% of what Tydro's LTV allows.`,
        `Gas: ${CARRY.GAS_UNITS.toLocaleString('en-US')} units per transaction, plus Ink's L1 data fee upper bound when readable.`,
        `One-off costs are shown for ${usd(CARRY.EXAMPLE_CAPITAL)} of capital and, for scale, as a rate if held ${CARRY.EXAMPLE_HOLD_DAYS} days.`,
        'Everything is before slippage, before Nado trading fees (not exposed on-chain) and at today’s rates, which change every block.',
      ],
      definitions: {
        Gross: 'yields earned by the structure’s legs (supply, deposit, appreciation), per $1 of capital',
        'Borrowing cost': 'interest paid on any borrowed leg, per $1 of capital',
        'Funding contribution': 'perp funding received (positive) or paid (negative), per $1 of capital',
        'Estimated net': 'gross − borrowing cost + funding; fees are separate one-off costs',
        'Historical range': 'the lowest and highest daily net rate over the recorded days',
      },
    },
    errors,
  };
}

/* ───────────────────────── checkpoints (the writer keeps these) ───────────────────────── */

export interface CarryDays {
  v: 1;
  kind: 'aegis-carry-days';
  /** UTC day (YYYY-MM-DD) → reading at the first block of that day */
  points: Record<string, CarryPoint>;
}

export function isCarryDays(x: unknown): x is CarryDays {
  const f = x as CarryDays;
  return !!f && f.v === 1 && f.kind === 'aegis-carry-days' && typeof f.points === 'object' && f.points !== null;
}

/** The UTC days (newest last) a checkpoint is wanted for, up to `head`. */
export function wantedDays(headMs: number, n: number = CARRY.DAYS + 1): string[] {
  const out: string[] = [];
  const d0 = Date.UTC(new Date(headMs).getUTCFullYear(), new Date(headMs).getUTCMonth(), new Date(headMs).getUTCDate());
  for (let i = n - 1; i >= 0; i--) out.push(new Date(d0 - i * 86_400_000).toISOString().slice(0, 10));
  return out;
}

/** Keep only wanted days (bounded file). */
export function pruneDays(f: CarryDays, keep: readonly string[]): CarryDays {
  const k = new Set(keep);
  return { ...f, points: Object.fromEntries(Object.entries(f.points).filter(([d]) => k.has(d))) };
}

export const FORBIDDEN_WORDS = /guarantee|guaranteed|risk[- ]free|\bapy\b|sure thing|can't lose|cannot lose/i;
