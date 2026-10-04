/**
 * Flight Recorder reads (browser). Files live next to census.json (history/…), written by the hourly census.
 * Only the months a view needs are fetched; a wallet page fetches its own shard (~1/64 of a month), never everyone.
 * A missing file is "not recorded" — never an empty history, never zero.
 */
import { useEffect, useState } from 'react';
import {
  HISTORY,
  INDEX_PATH,
  aggPath,
  dataGaps,
  isAggFile,
  isHistoryIndex,
  isWalletFile,
  monthsBetween,
  shardOf,
  walletPath,
  walletTimeline,
  type AggPoint,
  type HistoryIndex,
  type WalletFile,
  type WalletState,
} from '@aegis/census';
import { CENSUS_URL } from './census';

export const HISTORY_BASE = CENSUS_URL.replace(/census\.json(\?.*)?$/, '');

export type Range = '24h' | '7d' | '30d' | 'all';
export const RANGES: Array<[Range, string]> = [
  ['24h', '24 HOURS'],
  ['7d', '7 DAYS'],
  ['30d', '30 DAYS'],
  ['all', 'ALL'],
];
const RANGE_MS: Record<Exclude<Range, 'all'>, number> = { '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 };

/** Start of the view: the range, but never before recording began (nothing is drawn where nothing was recorded). */
export function rangeFrom(r: Range, nowMs: number, index: HistoryIndex | null): number {
  const first = index?.firstAt ? Date.parse(index.firstAt) : NaN;
  const want = r === 'all' ? (Number.isFinite(first) ? first : nowMs - 30 * 86_400_000) : nowMs - RANGE_MS[r];
  return Number.isFinite(first) ? Math.max(want, first) : want;
}

/* tiny cache: past months never change; the current month is re-fetched after 5 min */
const cache = new Map<string, { at: number; v: Promise<unknown | null> }>();
async function getJson(path: string, mutable: boolean): Promise<unknown | null> {
  const hit = cache.get(path);
  if (hit && (!mutable || Date.now() - hit.at < 5 * 60_000)) return hit.v;
  const v = (async () => {
    const res = await fetch(`${HISTORY_BASE}${path}${mutable ? `?t=${Math.floor(Date.now() / 300_000)}` : ''}`, { cache: mutable ? 'no-cache' : 'default' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
    if (!(res.headers.get('content-type') ?? '').includes('json')) return null; // SPA fallback = not there
    return res.json();
  })();
  cache.set(path, { at: Date.now(), v });
  v.catch(() => cache.delete(path));
  return v;
}

export type Loaded<T> = { status: 'loading' } | { status: 'none' } | { status: 'error'; message: string } | ({ status: 'ok' } & T);

export function useHistoryIndex(): Loaded<{ index: HistoryIndex }> {
  const [s, set] = useState<Loaded<{ index: HistoryIndex }>>({ status: 'loading' });
  useEffect(() => {
    let alive = true;
    getJson(INDEX_PATH, true)
      .then((j) => alive && set(isHistoryIndex(j) ? { status: 'ok', index: j } : { status: 'none' }))
      .catch((e: unknown) => alive && set({ status: 'error', message: String(e) }));
    return () => {
      alive = false;
    };
  }, []);
  return s;
}

const thisMonth = () => new Date().toISOString().slice(0, 7);

/** Aggregate points within [from, now], plus the data gaps in that span. */
export function useAggHistory(range: Range, index: HistoryIndex | null): Loaded<{ points: AggPoint[]; gaps: Array<{ from: number; to: number }>; from: number; to: number }> {
  type S = Loaded<{ points: AggPoint[]; gaps: Array<{ from: number; to: number }>; from: number; to: number }>;
  const [s, set] = useState<S>({ status: 'loading' });
  useEffect(() => {
    if (!index) return;
    let alive = true;
    const to = Date.now();
    const from = rangeFrom(range, to, index);
    const months = monthsBetween(from, to).filter((m) => index.months.includes(m));
    set({ status: 'loading' });
    Promise.all(months.map((m) => getJson(aggPath(m), m === thisMonth())))
      .then((files) => {
        if (!alive) return;
        const points = files.flatMap((f) => (isAggFile(f) ? f.points : [])).filter((p) => Date.parse(p.at) >= from && Date.parse(p.at) <= to);
        if (!points.length) return set({ status: 'none' });
        set({ status: 'ok', points, gaps: dataGaps(points, Math.max(from, Date.parse(index.firstAt ?? '') || from), to), from, to });
      })
      .catch((e: unknown) => alive && set({ status: 'error', message: String(e) }));
    return () => {
      alive = false;
    };
  }, [range, index]);
  return s;
}

/** One wallet's recorded states, newest months only as far as the range needs. */
export function useWalletHistory(
  address: string,
  range: Range,
  index: HistoryIndex | null,
): Loaded<{ timeline: WalletState[]; inRange: WalletState[]; gaps: Array<{ from: number; to: number }>; from: number; to: number }> {
  type S = Loaded<{ timeline: WalletState[]; inRange: WalletState[]; gaps: Array<{ from: number; to: number }>; from: number; to: number }>;
  const [s, set] = useState<S>({ status: 'loading' });
  useEffect(() => {
    if (!index) return;
    let alive = true;
    const to = Date.now();
    const from = rangeFrom(range, to, index);
    // one month before the range too, so the state AT the start of the range is known
    const months = monthsBetween(from - 31 * 86_400_000, to, HISTORY.MAX_MONTHS_PER_VIEW).filter((m) => index.months.includes(m));
    const shard = shardOf(address);
    set({ status: 'loading' });
    Promise.all([
      Promise.all(months.map((m) => getJson(walletPath(m, shard), m === thisMonth()))),
      Promise.all(months.filter((m) => m >= new Date(from).toISOString().slice(0, 7)).map((m) => getJson(aggPath(m), m === thisMonth()))),
    ])
      .then(([wf, af]) => {
        if (!alive) return;
        const timeline = walletTimeline(wf.filter(isWalletFile) as WalletFile[], address);
        const points = af.flatMap((f) => (isAggFile(f) ? f.points : []));
        const start = Math.max(from, Date.parse(index.firstAt ?? '') || from);
        set({ status: 'ok', timeline, inRange: timeline.filter((x) => x.at >= from), gaps: dataGaps(points, start, to), from, to });
      })
      .catch((e: unknown) => alive && set({ status: 'error', message: String(e) }));
    return () => {
      alive = false;
    };
  }, [address, range, index]);
  return s;
}

/** The state the hourly scan RECORDED for a wallet at a block (as classified then), or null if none was recorded. */
export async function recordedStateAt(address: string, atMs: number, block: number): Promise<WalletState | null> {
  const m = new Date(atMs).toISOString().slice(0, 7);
  const d = new Date(Date.UTC(new Date(atMs).getUTCFullYear(), new Date(atMs).getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  const shard = shardOf(address);
  const files = await Promise.all([d, m].map((x) => getJson(walletPath(x, shard), x === thisMonth()).catch(() => null)));
  const tl = walletTimeline(files.filter(isWalletFile) as WalletFile[], address);
  let hit: WalletState | null = null;
  for (const s of tl) if (s.block <= block) hit = s;
  return hit;
}
