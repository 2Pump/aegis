/**
 * @aegis/census — the snapshot format shared by the hourly job and the browser's live layer.
 * Pure: no fs, no network. (The job itself lives in ./node.)
 *
 * Privacy: a snapshot row carries tags, hull temp and a SIZE BAND — never balances, never HF numbers,
 * never liquidation prices. Exact figures exist only on a hull page someone chose to open.
 */
import { shipSizeUsd, sizeBand, type SizeBand } from '@aegis/glyphs';
import { TAGS, type Book, type HullTemp, type Pose, type Tag } from '@aegis/pose';
import type { CoveragePublic } from './coverage.js';

export const CENSUS_VERSION = 1 as const;

/** Tunables for who counts as "at risk" (re-read every 15 s live, and every hourly run). Not classification rules. */
export const WATCH = {
  HF: 2.0,
  /** same-family Tydro loops live near HF 1.05 by design; watch them only when close to their own (depeg) line */
  HF_CORRELATED: 1.1,
  /** same-family Nado loops run on thin buffers by design; watch them only when close to their own line */
  NADO_BUFFER_CORRELATED: 0.1,
  NADO_BUFFER: 0.5,
} as const;

const HULLS: readonly HullTemp[] = ['NOMINAL', 'ELEVATED', 'CRITICAL', 'UNKNOWN'];
const BANDS: readonly SizeBand[] = ['dust', '<1k', '1–10k', '10–100k', '100k+'];

export interface CensusShip {
  address: string;
  primary: Tag | null;
  tags: Tag[];
  hullTemp: HullTemp;
  band: SizeBand;
  watch: boolean;
  venues: { tydro: boolean; nado: boolean };
  /** block this ship was last read at */
  readBlock: number;
  /** block at which it was first seen WOUNDED in the current wounded streak (null if not wounded) */
  woundedSince: number | null;
  /** which venue tripped the WOUNDED rule (a rule name, never a number). Both false when not wounded. */
  wound: { tydro: boolean; nado: boolean };
  /** Tydro book is a same-family loop (judged by the depeg line) */
  correlatedLoop: boolean;
  /** Nado book is a same-family loop (judged by the depeg line) */
  correlatedNado: boolean;
  /** non-default Nado subaccounts (bytes32) — lets the live layer read isolated positions too */
  extraSubs: string[];
}

/** Compact row: [addr, primaryIdx, tagMask, hullIdx, bandIdx, flags, readBlock, woundedSince, extraSubs?] */
export type ShipRow = [string, number, number, number, number, number, number, number, string[]?];

export interface CensusSnapshot {
  v: typeof CENSUS_VERSION;
  chainId: 57073;
  generatedAt: string;
  block: number;
  rulesVersion: string;
  discovery: { tydroScannedTo: number; nadoScannedTo: number; head: number; backfillComplete: boolean };
  /** complete=false: a full sweep that ran out of time this run and continues next run */
  sweep: { kind: 'full' | 'incremental'; complete?: boolean; reread: number; carried: number; ms: number };
  counts: { known: number; drawn: number; empty: number; dark: number; tydro: number; nado: number; wounded: number };
  mix: Record<string, number>;
  /** from the last FULL sweep: what share of each protocol's on-chain totals the known wallets add up to */
  coverage?: CoveragePublic;
  ships: ShipRow[];
}

export function encodeShip(s: CensusShip): ShipRow {
  const mask = s.tags.reduce((m, t) => m | (1 << TAGS.indexOf(t)), 0);
  const flags = (s.watch ? 1 : 0) | (s.venues.tydro ? 2 : 0) | (s.venues.nado ? 4 : 0) | (s.wound.tydro ? 8 : 0) | (s.wound.nado ? 16 : 0) | (s.correlatedLoop ? 32 : 0) | (s.correlatedNado ? 64 : 0);
  const row: ShipRow = [
    s.address.toLowerCase(),
    s.primary ? TAGS.indexOf(s.primary) : -1,
    mask,
    HULLS.indexOf(s.hullTemp),
    BANDS.indexOf(s.band),
    flags,
    s.readBlock,
    s.woundedSince ?? 0,
  ];
  if (s.extraSubs.length) row.push(s.extraSubs);
  return row;
}

export function decodeShip(r: ShipRow): CensusShip {
  const tags: Tag[] = [];
  TAGS.forEach((t, i) => {
    if (r[2] & (1 << i)) tags.push(t);
  });
  const primary = r[1] >= 0 ? (TAGS[r[1]] ?? null) : null;
  // primary first, then the rest in stored order
  const ordered = primary ? [primary, ...tags.filter((t) => t !== primary)] : tags;
  return {
    address: r[0],
    primary,
    tags: ordered,
    hullTemp: HULLS[r[3]] ?? 'UNKNOWN',
    band: BANDS[r[4]] ?? 'dust',
    watch: (r[5] & 1) === 1,
    venues: { tydro: (r[5] & 2) === 2, nado: (r[5] & 4) === 4 },
    readBlock: r[6],
    woundedSince: r[7] > 0 ? r[7] : null,
    wound: { tydro: (r[5] & 8) === 8, nado: (r[5] & 16) === 16 },
    correlatedLoop: (r[5] & 32) === 32,
    correlatedNado: (r[5] & 64) === 64,
    extraSubs: r[8] ?? [],
  };
}

/** Is this wallet close enough to danger that price alone could hurt it? */
export function isWatch(book: Book, pose: Pose): boolean {
  if (pose.tags.includes('WOUNDED') || pose.hullTemp === 'CRITICAL' || pose.hullTemp === 'ELEVATED') return true;
  const hf = pose.metrics.hf;
  if (hf !== null && hf < (pose.metrics.correlatedFamily !== null ? WATCH.HF_CORRELATED : WATCH.HF)) return true;
  const b = pose.metrics.nadoBuffer;
  if (b !== null && b < (pose.metrics.correlatedNadoFamily != null ? WATCH.NADO_BUFFER_CORRELATED : WATCH.NADO_BUFFER)) return true;
  return false;
}

/** Which venue tripped the WOUNDED overlay — straight from the classifier, so it can never disagree with the rule. */
export function woundSource(pose: Pose): { tydro: boolean; nado: boolean } {
  return pose.metrics.wound ?? { tydro: false, nado: false };
}

export function shipFromRead(book: Book, pose: Pose, prev: CensusShip | undefined, extraSubs: string[]): CensusShip {
  const wounded = pose.tags.includes('WOUNDED');
  const hasTydro = book.tydro.status === 'OK' && (book.tydro.data.supplies.length > 0 || book.tydro.data.debts.length > 0);
  const hasNado = book.nado.status === 'OK' && (book.nado.data.spots.length > 0 || book.nado.data.perps.length > 0);
  return {
    address: book.address.toLowerCase(),
    primary: pose.primary,
    tags: pose.tags,
    hullTemp: pose.hullTemp,
    band: sizeBand(shipSizeUsd(pose)),
    watch: isWatch(book, pose),
    venues: { tydro: hasTydro, nado: hasNado },
    readBlock: book.asOfBlock ?? 0,
    woundedSince: wounded ? (prev?.woundedSince ?? book.asOfBlock ?? 0) : null,
    wound: woundSource(pose),
    correlatedLoop: pose.metrics.correlatedFamily != null,
    correlatedNado: pose.metrics.correlatedNadoFamily != null,
    extraSubs,
  };
}

/** A ship is drawn unless it is EMPTY. DARK ships are drawn (hollow) — hiding them would overstate coverage. */
export const isDrawn = (s: CensusShip) => s.primary !== 'EMPTY';

export function summarize(ships: readonly CensusShip[], knownOwners: number) {
  const drawn = ships.filter(isDrawn);
  const mix: Record<string, number> = {};
  for (const s of drawn) {
    const k = s.primary ?? 'NONE';
    mix[k] = (mix[k] ?? 0) + 1;
  }
  return {
    counts: {
      known: knownOwners,
      drawn: drawn.length,
      empty: ships.length - drawn.length,
      dark: drawn.filter((s) => s.primary === 'DARK').length,
      tydro: drawn.filter((s) => s.venues.tydro).length,
      nado: drawn.filter((s) => s.venues.nado).length,
      wounded: drawn.filter((s) => s.tags.includes('WOUNDED')).length,
    },
    mix,
  };
}

export function decodeSnapshot(json: unknown): { snap: CensusSnapshot; ships: CensusShip[] } {
  const snap = json as CensusSnapshot;
  if (!snap || snap.v !== CENSUS_VERSION || !Array.isArray(snap.ships)) throw new Error('census: unexpected snapshot format');
  return { snap, ships: snap.ships.map(decodeShip) };
}
export { CoverageAcc, buildCoverage, coveragePct, coverageSummary, publicCoverage, sharePct, type Coverage, type CoverageLine, type CoveragePublic, type ProtocolTotals } from './coverage.js';
export { LiveEngine, type LiveStats, type LiveChange, type LiveOpts } from './live.js';
