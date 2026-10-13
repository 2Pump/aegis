/**
 * MARKET DEPTH RECORDER (pure; no IO) — `depth-1.0.0`.
 *
 * Every run reads each Nado perp's order book through Nado's official API and keeps a small summary: best bid / ask,
 * spread, how much sits within 10 / 50 / 100 / 200 bps of the mid on each side (in USD), and the book's mid against
 * the on-chain oracle price. Market-level only: no wallet, position or account ever appears here.
 *
 * Two jobs:
 *   1. find out whether Nado's API answers reliably from a server (every run records how many books answered and
 *      why the rest didn't) — the question that decides whether exit-risk features can rest on it;
 *   2. start a depth / spread / mark-vs-oracle history that is Phrourax's own, from the day it starts. Nothing is
 *      backfilled or invented: before the first run there is simply no history.
 */

export const DEPTH = {
  VERSION: 'depth-1.0.0',
  /** levels asked per side (the gateway's query takes a depth) */
  LEVELS: 100,
  /** bands around the mid, in basis points */
  BANDS_BPS: [10, 50, 100, 200] as const,
  /** daily files kept in status (the files themselves are never deleted) */
  STATUS_DAYS: 30,
  /** pause between book requests, ms — polite to Nado's API */
  GAP_MS: 150,
} as const;

export interface Level {
  price: number;
  size: number;
  raw: bigint;
}

export interface MarketDepth {
  /** product id */
  p: number;
  /** symbol */
  s: string;
  oracle: number;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  spreadBps: number | null;
  /** (mid − oracle) ÷ oracle, bps */
  markOracleBps: number | null;
  /** USD resting within each band of the mid: [10, 50, 100, 200] bps */
  bidUsd: number[];
  askUsd: number[];
  /** levels returned [bids, asks] */
  n: [number, number];
  /** every level a whole multiple of the on-chain size increment (the units check) */
  unitsOk: boolean;
  /** the reply hit the level limit while still inside the widest band — that band may be undercounted */
  clipped: boolean;
}

export interface DepthRun {
  at: string;
  block: number | null;
  asked: number;
  answered: number;
  /** Nado's side said no (HTTP error / Cloudflare page) */
  refused: number;
  /** anything else: timeouts, replies that didn't parse */
  failed: number;
  /** the first reason a book wasn't read, if any */
  reason: string | null;
  markets: MarketDepth[];
}

export interface DepthDay {
  v: 1;
  version: string;
  day: string;
  runs: DepthRun[];
}

export interface DepthStatus {
  v: 1;
  version: string;
  updated: string;
  last: { at: string; asked: number; answered: number; refused: number; failed: number; reason: string | null } | null;
  days: Record<string, { runs: number; asked: number; answered: number; refused: number; failed: number }>;
}

const r = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;
const sig = (x: number) => (x === 0 ? 0 : Number(x.toPrecision(6)));

/** Summarise one book. Bids best-first (highest), asks best-first (lowest). */
export function summarizeBook(o: { productId: number; symbol: string; oracle: number; sizeIncrement: bigint; bids: Level[]; asks: Level[]; levelsAsked?: number }): MarketDepth {
  const bid = o.bids[0]?.price ?? null;
  const ask = o.asks[0]?.price ?? null;
  const mid = bid !== null && ask !== null && ask >= bid ? (bid + ask) / 2 : null;
  const within = (side: Level[], dir: 1 | -1) =>
    DEPTH.BANDS_BPS.map((b) => {
      if (mid === null) return 0;
      const edge = mid * (1 + (dir * b) / 10_000);
      let usd = 0;
      for (const l of side) {
        if (dir === -1 ? l.price < edge : l.price > edge) break;
        usd += l.price * l.size;
      }
      return r(usd, 0);
    });
  const inc = o.sizeIncrement;
  const unitsOk = inc > 0n && [...o.bids, ...o.asks].every((l) => l.raw % inc === 0n);
  const max = o.levelsAsked ?? DEPTH.LEVELS;
  const widest = DEPTH.BANDS_BPS[DEPTH.BANDS_BPS.length - 1]!;
  const lastInside = (side: Level[], dir: 1 | -1) => {
    const l = side[side.length - 1];
    return mid !== null && !!l && side.length >= max && (dir === -1 ? l.price >= mid * (1 - widest / 10_000) : l.price <= mid * (1 + widest / 10_000));
  };
  return {
    p: o.productId,
    s: o.symbol,
    oracle: sig(o.oracle),
    bid: bid === null ? null : sig(bid),
    ask: ask === null ? null : sig(ask),
    mid: mid === null ? null : sig(mid),
    spreadBps: mid === null ? null : r(((ask! - bid!) / mid) * 10_000, 2),
    markOracleBps: mid === null || !(o.oracle > 0) ? null : r(((mid - o.oracle) / o.oracle) * 10_000, 2),
    bidUsd: within(o.bids, -1),
    askUsd: within(o.asks, 1),
    n: [o.bids.length, o.asks.length],
    unitsOk,
    clipped: lastInside(o.bids, -1) || lastInside(o.asks, 1),
  };
}

export const dayOf = (iso: string) => iso.slice(0, 10);
export const depthDayPath = (day: string) => `depth/${day}.json` as const;
export const DEPTH_STATUS_PATH = 'depth/status.json' as const;

/** Add a run to its day's file (creating it); never drops an earlier run. */
export function appendRun(prev: unknown, run: DepthRun): DepthDay {
  const day = dayOf(run.at);
  const p = prev as DepthDay | null;
  const runs = p && p.v === 1 && p.day === day && Array.isArray(p.runs) ? p.runs : [];
  return { v: 1, version: DEPTH.VERSION, day, runs: [...runs, run] };
}

/** Rolling reachability: per day, how many books were asked for and how many answered. */
export function updateStatus(prev: unknown, run: DepthRun): DepthStatus {
  const p = prev as DepthStatus | null;
  const days = { ...(p && p.v === 1 && p.days ? p.days : {}) };
  const d = dayOf(run.at);
  const cur = days[d] ?? { runs: 0, asked: 0, answered: 0, refused: 0, failed: 0 };
  days[d] = { runs: cur.runs + 1, asked: cur.asked + run.asked, answered: cur.answered + run.answered, refused: cur.refused + run.refused, failed: cur.failed + run.failed };
  const keep = Object.keys(days).sort().slice(-DEPTH.STATUS_DAYS);
  return {
    v: 1,
    version: DEPTH.VERSION,
    updated: run.at,
    last: { at: run.at, asked: run.asked, answered: run.answered, refused: run.refused, failed: run.failed, reason: run.reason },
    days: Object.fromEntries(keep.map((k) => [k, days[k]!])),
  };
}

/** One line for the job log. */
export function runLine(run: DepthRun): string {
  const pct = run.asked ? Math.round((run.answered / run.asked) * 100) : 0;
  const units = run.markets.filter((m) => !m.unitsOk).length;
  return `depth: ${run.answered}/${run.asked} books answered (${pct}%)` + (run.refused ? ` · ${run.refused} refused by Nado` : '') + (run.failed ? ` · ${run.failed} failed` : '') + (run.reason ? ` · first reason: ${run.reason}` : '') + (units ? ` · ${units} books failed the units check` : '');
}
