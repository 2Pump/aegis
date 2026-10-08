import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PublicClient } from 'viem';
import {
  HISTORY,
  INDEX_PATH,
  aggPath,
  aggPoint,
  appendAgg,
  appendWalletRows,
  compactAgg,
  dataGaps,
  monthsBetween,
  shardOf,
  stateAt,
  walletChanges,
  walletPath,
  walletTimeline,
  type AggPoint,
  type CensusShip,
  type HistoryIndex,
  type WalletFile,
} from '../src/index.js';
import { fileStore, recordHistory, runCensus, type CensusStore } from '../src/node/index.js';
import { fakeChain } from './fakeChain.js';

const ship = (address: string, over: Partial<CensusShip> = {}): CensusShip => ({
  address,
  primary: 'CARRY',
  tags: ['CARRY'],
  hullTemp: 'NOMINAL',
  band: '1–10k',
  watch: false,
  venues: { tydro: true, nado: true },
  readBlock: 100,
  woundedSince: null,
  wound: { tydro: false, nado: false },
  correlatedLoop: false,
  correlatedNado: false,
  extraSubs: [],
  ...over,
});
const A = '0x0a00000000000000000000000000000000000001';
const B = '0xf100000000000000000000000000000000000002';
const FIX = '0x0000000000000000000000000000000000ae6001';
const V = { rules: 'v1.2.0', engine: 'pressure-1.0.0', reader: 'ink-io-x', prices: 'p-1' };
const pt = (block: number, at: string, crit = 0, extra: Partial<AggPoint> = {}): AggPoint => ({
  ...aggPoint({ ships: [ship(A, { hullTemp: crit ? 'CRITICAL' : 'NOMINAL' })], known: 1, at, block, hash: `0x${block}`, sweep: 'incremental', complete: true, versions: V, stress: null }),
  ...extra,
});

describe('Flight Recorder · aggregate points', () => {
  it('counts risk per size floor (same floors as the Pressure Map), never balances', () => {
    const p = aggPoint({
      ships: [ship(A, { hullTemp: 'CRITICAL', band: '100k+' }), ship(B, { hullTemp: 'ELEVATED', band: '<1k' }), ship('0x03', { primary: 'EMPTY', band: 'dust' })],
      known: 3,
      at: '2026-10-04T12:00:00Z',
      block: 10,
      hash: '0xabc',
      sweep: 'full',
      complete: true,
      versions: V,
      stress: { level: 'CALM', confidence: 'NORMAL', version: 'stress-1.0.0', population: 2 },
    });
    expect(p.risk['0']).toEqual([0, 1, 1, 0]);
    expect(p.risk['1k']).toEqual([0, 0, 1, 0]);
    expect(p.risk['100k']).toEqual([0, 0, 1, 0]);
    expect(p.drawn).toBe(2);
    expect(p.v).toMatchObject({ rules: 'v1.2.0', engine: 'pressure-1.0.0', reader: 'ink-io-x', prices: 'p-1', history: HISTORY.VERSION });
    expect(JSON.stringify(p)).not.toMatch(/usd|balance|hf/i);
  });

  it('idempotent: the same block twice is one point; points stay in block order', () => {
    let f = appendAgg(null, pt(20, '2026-10-04T12:00:00Z'));
    f = appendAgg(f, pt(10, '2026-10-04T11:00:00Z'));
    f = appendAgg(f, pt(20, '2026-10-04T12:00:00Z'));
    expect(f.points.map((p) => p.block)).toEqual([10, 20]);
    expect(f.month).toBe('2026-10');
  });

  it('compaction thins old points to one per 6 h but keeps every risk change and every reorg mark', () => {
    const pts: AggPoint[] = [];
    for (let h = 0; h < 24; h++) pts.push(pt(h, new Date(Date.UTC(2026, 5, 1, h)).toISOString(), h === 13 ? 1 : 0));
    pts[3] = { ...pts[3]!, reorg: true };
    const out = compactAgg(pts, Date.UTC(2026, 8, 1));
    expect(out.length).toBeLessThan(pts.length);
    expect(out.some((p) => p.block === 13)).toBe(true); // risk went up
    expect(out.some((p) => p.block === 14)).toBe(true); // and back down
    expect(out.some((p) => p.block === 3)).toBe(true); // reorg kept
    expect(compactAgg(pts, Date.UTC(2026, 0, 1))).toHaveLength(24); // inside the hourly window nothing is dropped
  });

  it('gaps longer than 2 h are shown as gaps, never interpolated', () => {
    const t = (h: number) => new Date(Date.UTC(2026, 9, 4, h)).toISOString();
    const g = dataGaps([{ at: t(0) }, { at: t(1) }, { at: t(5) }], Date.UTC(2026, 9, 4, 0), Date.UTC(2026, 9, 4, 6));
    expect(g).toEqual([{ from: Date.UTC(2026, 9, 4, 1), to: Date.UTC(2026, 9, 4, 5), next: { sweep: 'incremental', complete: true, at: Date.UTC(2026, 9, 4, 5), startedAt: null } }]);
  });

  it('a long full re-read is a scan in progress, not a gap: gaps are measured to when a scan STARTED reading', () => {
    const t = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 4, h, m)).toISOString();
    const span = [Date.UTC(2026, 9, 4, 0), Date.UTC(2026, 9, 4, 4)] as const;
    // hourly point at 0:05; a full re-read starts 1:00 and finishes 2:20 (over 2 h after the last point)
    const long = [{ at: t(0, 5) }, { at: t(2, 20), startedAt: t(1, 0), sweep: 'full' as const }, { at: t(3, 5) }];
    expect(dataGaps(long, ...span)).toEqual([]);
    // the same point recorded before start times existed: still a gap, and it says a full re-read ended it
    const legacy = [{ at: t(0, 5) }, { at: t(2, 20), sweep: 'full' as const }, { at: t(3, 5) }];
    const g = dataGaps(legacy, ...span);
    expect(g).toHaveLength(1);
    expect(g[0]!.next).toMatchObject({ sweep: 'full', startedAt: null });
    // a real outage: nothing started for 3 h — a gap up to the moment the next scan started
    const out = dataGaps([{ at: t(0, 5) }, { at: t(3, 10), startedAt: t(3, 0) }], ...span);
    expect(out).toEqual([{ from: Date.parse(t(0, 5)), to: Date.parse(t(3, 0)), next: { sweep: 'incremental', complete: true, at: Date.parse(t(3, 10)), startedAt: Date.parse(t(3, 0)) } }]);
    // nothing since: open-ended gap with no next scan
    expect(dataGaps([{ at: t(0, 5) }], span[0], Date.UTC(2026, 9, 4, 3))[0]!.next).toBeNull();
  });

  it('months between two dates, bounded', () => {
    expect(monthsBetween(Date.UTC(2026, 8, 20), Date.UTC(2026, 9, 4))).toEqual(['2026-09', '2026-10']);
    expect(monthsBetween(Date.UTC(2020, 0, 1), Date.UTC(2026, 9, 4))).toHaveLength(HISTORY.MAX_MONTHS_PER_VIEW);
  });
});

describe('Flight Recorder · wallet rows', () => {
  it('a change is a change of type, risk, size range, venues or trip — not the at-risk watch flag', () => {
    const prev = new Map([[A, ship(A)], [B, ship(B)]]);
    expect(walletChanges(prev, [ship(A, { watch: true }), ship(B)])).toHaveLength(0);
    expect(walletChanges(prev, [ship(A, { hullTemp: 'ELEVATED' }), ship(B)]).map((s) => s.address)).toEqual([A]);
    expect(walletChanges(prev, [ship(A), ship(B, { band: '10–100k' })]).map((s) => s.address)).toEqual([B]);
    expect(walletChanges(prev, [ship(A), ship(B, { primary: 'EMPTY', tags: ['EMPTY'] })])).toHaveLength(1); // emptied is recorded
    expect(walletChanges(new Map(), [ship(A)])).toHaveLength(1); // first appearance
    expect(walletChanges(new Map(), [ship(FIX)], new Set([FIX]))).toHaveLength(0); // fixtures never
  });

  it('rows land in the right shard, are idempotent, and keep the rules version they were classified under', () => {
    const shard = shardOf(A);
    let f = appendWalletRows(null, { month: '2026-10', shard, rows: [{ ship: ship(A), kind: 'B' }, { ship: ship(B), kind: 'B' }], block: 100, atSec: 1, rules: 'v1.1.0' });
    expect(f.rows.map((r) => r[4])).toEqual([A]); // B belongs to another shard
    f = appendWalletRows(f, { month: '2026-10', shard, rows: [{ ship: ship(A), kind: 'B' }], block: 100, atSec: 1, rules: 'v1.1.0' });
    expect(f.rows).toHaveLength(1);
    f = appendWalletRows(f, { month: '2026-10', shard, rows: [{ ship: ship(A, { hullTemp: 'CRITICAL', tags: ['CARRY', 'WOUNDED'] }), kind: 'T' }], block: 200, atSec: 2, rules: 'v1.2.0' });
    const tl = walletTimeline([f], A);
    expect(tl.map((s) => [s.kind, s.hullTemp, s.rulesVersion])).toEqual([
      ['B', 'NOMINAL', 'v1.1.0'],
      ['T', 'CRITICAL', 'v1.2.0'],
    ]);
    expect(stateAt(tl, 150)?.hullTemp).toBe('NOMINAL');
    expect(stateAt(tl, 99)).toBeNull(); // before recording began: nothing, not a guess
  });

  it("a month's baseline that repeats the known state is a bookmark, not a change", () => {
    const shard = shardOf(A);
    const sep = appendWalletRows(null, { month: '2026-09', shard, rows: [{ ship: ship(A), kind: 'B' }], block: 10, atSec: 1, rules: 'v1.2.0' });
    const oct = appendWalletRows(null, { month: '2026-10', shard, rows: [{ ship: ship(A), kind: 'B' }], block: 50, atSec: 5, rules: 'v1.2.0' });
    expect(walletTimeline([sep, oct], A)).toHaveLength(1);
  });

  it('fixture wallets are refused even if handed in', () => {
    const f = appendWalletRows(null, { month: '2026-10', shard: shardOf(FIX), rows: [{ ship: ship(FIX), kind: 'B' }], block: 1, atSec: 1, rules: 'v', exclude: new Set([FIX]) });
    expect(f.rows).toHaveLength(0);
  });
});

/** a fake chain that only answers getBlock (block hashes) */
const hashes = new Map<number, string>();
const client = { getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ hash: hashes.get(Number(blockNumber)) ?? `0xh${blockNumber}` }) } as unknown as PublicClient;
const tmpStore = () => fileStore(mkdtempSync(join(tmpdir(), 'aegis-history-')));

describe('Flight Recorder · writer', () => {
  const base = (store: CensusStore, block: number, ships: CensusShip[], prev: Map<string, CensusShip>, at = '2026-10-04T12:00:00Z') =>
    recordHistory({ store, client, block, at, sweep: 'incremental', complete: true, ships, prev, known: ships.length, stress: null, exclude: new Set([FIX]) });

  it('first run of a month writes a baseline for every shard; the next run writes only changes; a re-run adds nothing', async () => {
    const store = tmpStore();
    const r1 = await base(store, 100, [ship(A), ship(B), ship(FIX)], new Map());
    expect(r1.baseline).toBe(true);
    expect(r1.shards).toBe(HISTORY.SHARDS);
    expect(r1.rows).toBe(2); // fixture refused
    const idx = (await store.get(INDEX_PATH)) as HistoryIndex;
    expect(idx.baselined).toEqual(['2026-10']);
    expect(idx.firstBlock).toBe(100);

    const prev = new Map([[A, ship(A)], [B, ship(B)]]);
    const r2 = await base(store, 200, [ship(A, { hullTemp: 'CRITICAL' }), ship(B)], prev, '2026-10-04T13:00:00Z');
    expect(r2.baseline).toBe(false);
    expect(r2.rows).toBe(1);
    expect(r2.shards).toBe(1);
    const r3 = await base(store, 200, [ship(A, { hullTemp: 'CRITICAL' }), ship(B)], prev, '2026-10-04T13:00:00Z');
    expect(r3.rows).toBe(0);
    const agg = (await store.get(aggPath('2026-10'))) as { points: AggPoint[] };
    expect(agg.points.map((p) => p.block)).toEqual([100, 200]);
    expect(agg.points[0]!.hash).toBe('0xh100');
    const w = (await store.get(walletPath('2026-10', shardOf(A)))) as WalletFile;
    expect(walletTimeline([w], A).map((s) => s.hullTemp)).toEqual(['NOMINAL', 'CRITICAL']);
    // nothing in any history file that looks like money
    expect(JSON.stringify(w) + JSON.stringify(agg)).not.toMatch(/usd|balance|health/i);
  });

  it('a reorganised block is marked on the next run, never deleted', async () => {
    const store = tmpStore();
    await base(store, 300, [ship(A)], new Map());
    hashes.set(300, '0xDIFFERENT');
    const r = await base(store, 301, [ship(A)], new Map([[A, ship(A)]]), '2026-10-04T13:00:00Z');
    hashes.delete(300);
    expect(r.reorgMarked).toBe(true);
    const agg = (await store.get(aggPath('2026-10'))) as { points: AggPoint[] };
    expect(agg.points.find((p) => p.block === 300)?.reorg).toBe(true);
    expect(agg.points).toHaveLength(2);
  });

  it("a file that isn't ours is left untouched and nothing is recorded over it", async () => {
    const store = tmpStore();
    await store.put(INDEX_PATH, { hello: 'not an index' });
    const r = await base(store, 400, [ship(A)], new Map());
    expect(r.point).toBe(false);
    expect(await store.get(INDEX_PATH)).toEqual({ hello: 'not an index' });
  });

  it('a shard that fails to write is reported and the month baseline is retried next run (resume)', async () => {
    const inner = tmpStore();
    let failOnce = true;
    const flaky: CensusStore = {
      describe: 'flaky',
      get: (n) => inner.get(n),
      put: async (n, b) => {
        if (failOnce && n.startsWith('history/w/') && n.endsWith(`/${shardOf(A)}.json`)) {
          failOnce = false;
          throw new Error('network blip');
        }
        return inner.put(n, b);
      },
    };
    const r1 = await base(flaky, 500, [ship(A), ship(B)], new Map());
    expect(r1.skipped.some((s) => s.includes('network blip'))).toBe(true);
    expect(((await inner.get(INDEX_PATH)) as HistoryIndex).baselined).toEqual([]);
    const r2 = await base(flaky, 501, [ship(A), ship(B)], new Map([[A, ship(A)], [B, ship(B)]]), '2026-10-04T13:00:00Z');
    expect(r2.baseline).toBe(true);
    expect(((await inner.get(INDEX_PATH)) as HistoryIndex).baselined).toEqual(['2026-10']);
    const w = (await inner.get(walletPath('2026-10', shardOf(A)))) as WalletFile;
    expect(walletTimeline([w], A)).toHaveLength(1);
  });

  it('the census records history after publishing, and a history failure never fails the scan', async () => {
    const store = tmpStore();
    const logs: string[] = [];
    await runCensus({ scanPaceMs: 0, explorer: false, client: fakeChain({ head: 57_200_000 }).client, store, log: (m) => logs.push(m) });
    expect(logs.some((l) => l.startsWith('history: '))).toBe(true);
    const idx = (await store.get(INDEX_PATH)) as HistoryIndex | null;
    expect(idx?.months.length).toBe(1);
    expect(await store.get('census.json')).not.toBeNull();
  });
});

describe('warnings recording — the "recording began" marker can be lost; the baseline is never re-imported', () => {
  const base = (store: CensusStore, block: number, ships: CensusShip[], prev: Map<string, CensusShip>, at: string) =>
    recordHistory({ store, client, block, at, sweep: 'incremental', complete: true, ships, prev, known: ships.length, stress: null, exclude: new Set([FIX]) });
  const near = (a: string) => ship(a, { hullTemp: 'CRITICAL' });
  const warnRows = async (store: CensusStore) => ((await store.get('history/warn/2026-10.json')) as { rows: Array<[string, number, number, 'B' | 'T']> }).rows;

  it('first run: baseline rows; later: only real transitions — even when the index lost its marker', async () => {
    const store = tmpStore();
    await base(store, 100, [near(A), ship(B)], new Map(), '2026-10-04T12:00:00Z');
    expect((await warnRows(store)).map((r) => [r[0], r[3]])).toEqual([[A, 'B']]);

    // simulate the lost marker (a stale read-modify-write of the index elsewhere)
    const idx = (await store.get(INDEX_PATH)) as HistoryIndex & { warningsSince?: string };
    delete idx.warningsSince;
    await store.put(INDEX_PATH, idx);

    // next run: A stays near (nothing), B enters near (one T) — no B rows re-imported
    await base(store, 200, [near(A), near(B)], new Map([[A, near(A)], [B, ship(B)]]), '2026-10-04T13:00:00Z');
    const rows = await warnRows(store);
    expect(rows.filter((r) => r[3] === 'B')).toHaveLength(1);
    expect(rows.filter((r) => r[3] === 'T').map((r) => r[0])).toEqual([B]);
    expect(((await store.get(INDEX_PATH)) as HistoryIndex & { warningsSince?: string }).warningsSince).toBe('2026-10-04T12:00:00.000Z');
  });
});
