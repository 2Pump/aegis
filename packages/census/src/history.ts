/**
 * FLIGHT RECORDER — the historical record of observable Ink risk (pure; no IO). Written by the hourly census
 * (./node/history-write.ts), read by the wallet page's HISTORY panel and INTEL → HISTORY.
 *
 * Two kinds of file, both balance-free like census.json (types, risk levels, size RANGES, counts — never balances,
 * health factors or liquidation prices):
 *
 *   history/agg/<YYYY-MM>.json           one point per census run: block + block hash, versions, risk counts per
 *                                        size floor, position-type mix, venues, unreadable count, Ink Stress Level
 *                                        when a full scan built the Pressure Map that run
 *   history/w/<YYYY-MM>/<shard>.json     per-wallet states: a BASELINE row per wallet at its first write of the
 *                                        month, then a row only when the wallet's type, risk, size range, venues
 *                                        or venue-trip changes. 64 shards by address, so a wallet page fetches
 *                                        ~1/64 of a month.
 *   history/index.json                   which months exist, when recording began
 *
 * Every row is a reading the hourly census made AT THE TIME ("recorded live"), stamped with the rules version it
 * was classified under. Rows are never rewritten when rules change. Nothing here is reconstructed afterwards —
 * a past-block reconstruction on the wallet page is computed in the browser and labelled as such.
 */
import { TAGS, type HullTemp, type Tag } from '@aegis/pose';
import type { SizeBand } from '@aegis/glyphs';
import { encodeShip, type CensusShip } from './index.js';
import { MATERIAL, meetsMaterial, type Material, type StressLevel } from './pressure.js';

export const HISTORY = {
  VERSION: 'hist-1.0.0',
  SHARDS: 64,
  /** hourly aggregate points are kept for this long; older months keep one point per COMPACT_EVERY_H plus every risk change */
  HOURLY_KEEP_DAYS: 90,
  COMPACT_EVERY_H: 6,
  /** no census point for longer than this = a data gap, shown as such */
  GAP_H: 2,
  /** the wallet page never loads more than this many months at once */
  MAX_MONTHS_PER_VIEW: 13,
} as const;

const HULLS: readonly HullTemp[] = ['NOMINAL', 'ELEVATED', 'CRITICAL', 'UNKNOWN'];
const BANDS: readonly SizeBand[] = ['dust', '<1k', '1–10k', '10–100k', '100k+'];
/** census flag bits that matter for history: venues (2,4), venue trips (8,16), same-family loops (32,64). Not `watch` (1). */
const FLAG_MASK = 0b1111110;

export const monthOf = (ms: number) => new Date(ms).toISOString().slice(0, 7);
/** 64 shards from the first two hex digits of the address */
export const shardOf = (address: string) => String(parseInt(address.slice(2, 4), 16) >> 2).padStart(2, '0');
export const aggPath = (month: string) => `history/agg/${month}.json` as const;
export const walletPath = (month: string, shard: string) => `history/w/${month}/${shard}.json` as const;
export const INDEX_PATH = 'history/index.json' as const;

/* ───────────────────────── aggregate points ───────────────────────── */

export type RiskCounts = [nominal: number, elevated: number, critical: number, unknown: number];

export interface AggPoint {
  at: string;
  block: number;
  /** block hash at `block`; null = couldn't be read (the point is still kept, marked) */
  hash: string | null;
  sweep: 'full' | 'incremental';
  complete: boolean;
  v: { rules: string; engine: string; reader: string; prices: string; history: string };
  /** risk counts per size floor (same floors as the Pressure Map and the near-liquidation list) */
  risk: Record<Material, RiskCounts>;
  /** position-type mix of wallets with a position (primary type → count; 'NONE' = no rule fired) */
  mix: Record<string, number>;
  venues: { tydro: number; nado: number; both: number };
  known: number;
  drawn: number;
  /** wallets with a venue unreadable this run (kept at their last good reading, never zeroed) */
  dark: number;
  /** only on runs where a full scan rebuilt the Pressure Map */
  stress: { level: StressLevel; confidence: 'NORMAL' | 'REDUCED'; version: string; population: number } | null;
  /** set by a later run: this block's hash no longer matched the chain (reorg) — kept, never silently deleted */
  reorg?: true;
}

export interface AggFile {
  v: 1;
  kind: 'aegis-history-agg';
  chainId: 57073;
  month: string;
  points: AggPoint[];
}

export function riskCounts(ships: readonly CensusShip[]): Record<Material, RiskCounts> {
  const out = Object.fromEntries(MATERIAL.map((m) => [m, [0, 0, 0, 0]])) as Record<Material, RiskCounts>;
  for (const s of ships) {
    if (s.primary === 'EMPTY') continue;
    const i = Math.max(0, HULLS.indexOf(s.hullTemp));
    for (const m of MATERIAL) if (meetsMaterial(s.band, m)) out[m][i]! += 1;
  }
  return out;
}

export function aggPoint(o: {
  ships: readonly CensusShip[];
  known: number;
  at: string;
  block: number;
  hash: string | null;
  sweep: 'full' | 'incremental';
  complete: boolean;
  versions: Omit<AggPoint['v'], 'history'>;
  stress: AggPoint['stress'];
}): AggPoint {
  const drawn = o.ships.filter((s) => s.primary !== 'EMPTY');
  const mix: Record<string, number> = {};
  for (const s of drawn) mix[s.primary ?? 'NONE'] = (mix[s.primary ?? 'NONE'] ?? 0) + 1;
  return {
    at: o.at,
    block: o.block,
    hash: o.hash,
    sweep: o.sweep,
    complete: o.complete,
    v: { ...o.versions, history: HISTORY.VERSION },
    risk: riskCounts(drawn),
    mix,
    venues: {
      tydro: drawn.filter((s) => s.venues.tydro).length,
      nado: drawn.filter((s) => s.venues.nado).length,
      both: drawn.filter((s) => s.venues.tydro && s.venues.nado).length,
    },
    known: o.known,
    drawn: drawn.length,
    dark: drawn.filter((s) => s.primary === 'DARK').length,
    stress: o.stress,
  };
}

export function isAggFile(x: unknown): x is AggFile {
  const f = x as AggFile;
  return !!f && f.v === 1 && f.kind === 'aegis-history-agg' && Array.isArray(f.points);
}

/** Idempotent: a point for a block already recorded is not added twice (a re-run of the same block changes nothing). */
export function appendAgg(file: unknown, p: AggPoint): AggFile {
  const month = monthOf(Date.parse(p.at));
  const base: AggFile = isAggFile(file) && file.month === month ? file : { v: 1, kind: 'aegis-history-agg', chainId: 57073, month, points: [] };
  if (base.points.some((x) => x.block === p.block)) return base;
  return { ...base, points: [...base.points, p].sort((a, b) => a.block - b.block) };
}

/**
 * Bounded growth: points older than `keepFromMs` keep one per COMPACT_EVERY_H bucket, plus every point where the
 * all-sizes risk counts or the stress level changed from the previous kept point (risk transitions survive).
 * Reorg-marked points are always kept (an audit trail is not compacted away).
 */
export function compactAgg(points: readonly AggPoint[], keepFromMs: number, everyH: number = HISTORY.COMPACT_EVERY_H): AggPoint[] {
  const out: AggPoint[] = [];
  let lastBucket = -1;
  let last: AggPoint | null = null;
  for (const p of [...points].sort((a, b) => a.block - b.block)) {
    const t = Date.parse(p.at);
    if (t >= keepFromMs || p.reorg) {
      out.push(p);
      last = p;
      continue;
    }
    const bucket = Math.floor(t / (everyH * 3_600_000));
    const changed = !last || last.risk['0'].join() !== p.risk['0'].join() || (last.stress?.level ?? null) !== (p.stress?.level ?? null);
    if (bucket !== lastBucket || changed) {
      out.push(p);
      last = p;
      lastBucket = bucket;
    }
  }
  return out;
}

/** Spans with no census point for longer than `maxGapH` hours — shown as gaps, never interpolated. */
export function dataGaps(points: readonly { at: string }[], fromMs: number, toMs: number, maxGapH: number = HISTORY.GAP_H): Array<{ from: number; to: number }> {
  const ts = points.map((p) => Date.parse(p.at)).filter((t) => t >= fromMs - maxGapH * 3_600_000 && t <= toMs).sort((a, b) => a - b);
  const gaps: Array<{ from: number; to: number }> = [];
  let prev = fromMs;
  const lim = maxGapH * 3_600_000;
  for (const t of ts) {
    if (t - prev > lim) gaps.push({ from: prev, to: t });
    prev = Math.max(prev, t);
  }
  if (toMs - prev > lim) gaps.push({ from: prev, to: toMs });
  return gaps;
}

/* ───────────────────────── wallet rows ───────────────────────── */

/** [kind, block, unix seconds, rules-version index, address, primary idx, tag mask, risk idx, size-band idx, flags] */
export type WalletRow = ['B' | 'T', number, number, number, string, number, number, number, number, number];

export interface WalletFile {
  v: 1;
  kind: 'aegis-history-wallets';
  chainId: 57073;
  month: string;
  shard: string;
  /** rules versions the rows were classified under (rows point into this list) */
  rules: string[];
  rows: WalletRow[];
}

export function isWalletFile(x: unknown): x is WalletFile {
  const f = x as WalletFile;
  return !!f && f.v === 1 && f.kind === 'aegis-history-wallets' && Array.isArray(f.rows) && Array.isArray(f.rules);
}

const sig = (r: ReturnType<typeof encodeShip>) => `${r[1]}|${r[2]}|${r[3]}|${r[4]}|${r[5] & FLAG_MASK}`;

/** The recorded part of a wallet's state (everything that may change history). */
export const stateSig = (s: CensusShip) => sig(encodeShip(s));

export interface RowInput {
  ship: CensusShip;
  kind: 'B' | 'T';
}

/**
 * What changed between the previous scan and this one. A wallet not in the previous scan is recorded when it
 * first appears. Fixture addresses are refused outright (they are never real accounts).
 */
export function walletChanges(prev: ReadonlyMap<string, CensusShip>, next: readonly CensusShip[], exclude: ReadonlySet<string> = new Set()): CensusShip[] {
  const out: CensusShip[] = [];
  for (const s of next) {
    if (exclude.has(s.address)) continue;
    const p = prev.get(s.address);
    if (!p) {
      if (s.primary !== 'EMPTY') out.push(s);
      continue;
    }
    if (stateSig(p) !== stateSig(s)) out.push(s);
  }
  return out;
}

/** Idempotent append: (kind, address, block) is unique; rows stay ordered by block. */
export function appendWalletRows(file: unknown, o: { month: string; shard: string; rows: readonly RowInput[]; block: number; atSec: number; rules: string; exclude?: ReadonlySet<string> }): WalletFile {
  const base: WalletFile =
    isWalletFile(file) && file.month === o.month && file.shard === o.shard ? { ...file, rules: [...file.rules], rows: [...file.rows] } : { v: 1, kind: 'aegis-history-wallets', chainId: 57073, month: o.month, shard: o.shard, rules: [], rows: [] };
  let vi = base.rules.indexOf(o.rules);
  if (vi < 0) {
    base.rules.push(o.rules);
    vi = base.rules.length - 1;
  }
  const seen = new Set(base.rows.map((r) => `${r[0]}|${r[4]}|${r[1]}`));
  for (const { ship, kind } of o.rows) {
    if (o.exclude?.has(ship.address) || shardOf(ship.address) !== o.shard) continue;
    const e = encodeShip(ship);
    const key = `${kind}|${e[0]}|${o.block}`;
    if (seen.has(key)) continue;
    seen.add(key);
    base.rows.push([kind, o.block, o.atSec, vi, e[0], e[1], e[2], e[3], e[4], e[5] & FLAG_MASK]);
  }
  base.rows.sort((a, b) => a[1] - b[1] || (a[0] === b[0] ? 0 : a[0] === 'B' ? -1 : 1));
  return base;
}

export interface WalletState {
  kind: 'B' | 'T';
  block: number;
  at: number;
  rulesVersion: string;
  primary: Tag | null;
  tags: Tag[];
  hullTemp: HullTemp;
  band: SizeBand;
  venues: { tydro: boolean; nado: boolean };
  wound: { tydro: boolean; nado: boolean };
}

export function decodeRow(f: WalletFile, r: WalletRow): WalletState {
  const tags: Tag[] = [];
  TAGS.forEach((t, i) => {
    if (r[6] & (1 << i)) tags.push(t);
  });
  const primary = r[5] >= 0 ? (TAGS[r[5]] ?? null) : null;
  return {
    kind: r[0],
    block: r[1],
    at: r[2] * 1000,
    rulesVersion: f.rules[r[3]] ?? '?',
    primary,
    tags: primary ? [primary, ...tags.filter((t) => t !== primary)] : tags,
    hullTemp: HULLS[r[7]] ?? 'UNKNOWN',
    band: BANDS[r[8]] ?? 'dust',
    venues: { tydro: (r[9] & 2) === 2, nado: (r[9] & 4) === 4 },
    wound: { tydro: (r[9] & 8) === 8, nado: (r[9] & 16) === 16 },
  };
}

/**
 * One wallet's recorded states across month files, oldest first. A month's BASELINE row that repeats the state
 * already known from the previous month is dropped (it is a bookmark, not a change).
 */
export function walletTimeline(files: readonly unknown[], address: string): WalletState[] {
  const a = address.toLowerCase();
  const all: WalletState[] = [];
  for (const f of files) {
    if (!isWalletFile(f)) continue;
    for (const r of f.rows) if (r[4] === a) all.push(decodeRow(f, r));
  }
  all.sort((x, y) => x.block - y.block || (x.kind === y.kind ? 0 : x.kind === 'B' ? -1 : 1));
  const out: WalletState[] = [];
  const key = (s: WalletState) => `${s.primary}|${s.tags.join()}|${s.hullTemp}|${s.band}|${s.venues.tydro}${s.venues.nado}|${s.wound.tydro}${s.wound.nado}|${s.rulesVersion}`;
  for (const s of all) {
    const prev = out[out.length - 1];
    if (prev && prev.block === s.block && prev.kind === s.kind) continue;
    if (prev && s.kind === 'B' && key(prev) === key(s)) continue;
    out.push(s);
  }
  return out;
}

/** The recorded state in force at a block (the newest row at or before it), or null if recording hadn't started. */
export function stateAt(timeline: readonly WalletState[], block: number): WalletState | null {
  let hit: WalletState | null = null;
  for (const s of timeline) if (s.block <= block) hit = s;
  return hit;
}

/* ───────────────────────── index ───────────────────────── */

export interface HistoryIndex {
  v: 1;
  kind: 'aegis-history-index';
  version: string;
  shards: number;
  /** months with an aggregate file */
  months: string[];
  /** months whose wallet baseline has been written (all shards) */
  baselined: string[];
  firstAt: string | null;
  firstBlock: number | null;
  /** finished months already thinned to one point per COMPACT_EVERY_H (plus every risk change) */
  compacted?: string[];
  /** Liquidation Ledger (ledger.ts): months with a ledger file, and how far the scans have got */
  ledgerMonths?: string[];
  ledger?: LedgerCursor;
  /** when AEGIS began recording its own NEAR LIQUIDATION warnings (the track record starts here) */
  warningsSince?: string;
}

/** Where the liquidation scans have got (kept in the index so any run can resume). */
export interface LedgerCursor {
  startedAt: string;
  /** forward scanning began after this block; the backfill runs up to it */
  forwardFrom: number;
  forwardTo: number;
  backfillFrom: number;
  backfillNext: number;
  done: boolean;
  events: number;
  skipped: number;
}

export function isHistoryIndex(x: unknown): x is HistoryIndex {
  const f = x as HistoryIndex;
  return !!f && f.v === 1 && f.kind === 'aegis-history-index' && Array.isArray(f.months) && Array.isArray(f.baselined);
}

export const emptyIndex = (): HistoryIndex => ({ v: 1, kind: 'aegis-history-index', version: HISTORY.VERSION, shards: HISTORY.SHARDS, months: [], baselined: [], compacted: [], firstAt: null, firstBlock: null });

/** Months (YYYY-MM) covering [fromMs, toMs], newest last, at most `max`. */
export function monthsBetween(fromMs: number, toMs: number, max: number = HISTORY.MAX_MONTHS_PER_VIEW): string[] {
  const out: string[] = [];
  const d = new Date(Date.UTC(new Date(fromMs).getUTCFullYear(), new Date(fromMs).getUTCMonth(), 1));
  while (d.getTime() <= toMs) {
    out.push(d.toISOString().slice(0, 7));
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return out.slice(-max);
}
