/**
 * FLIGHT RECORDER writer — called by the census after it has published (a history failure never blocks the scan).
 * Read-only on the chain (one or two getBlock calls for block hashes). Writes only balance-free files (history.ts).
 *
 * Safety:
 *  - idempotent: re-running the same block adds nothing (points keyed by block, rows by kind+address+block)
 *  - a file that exists but isn't ours is never overwritten (that run's history is skipped and logged)
 *  - reorgs: the previous point's block hash is re-checked; a mismatch marks that point `reorg`, never deletes it
 *  - bounded: wallet rows only on change (plus one baseline per month); hourly points compacted after 90 days
 *  - fixtures never enter: `exclude` addresses are refused
 */
import type { PublicClient } from 'viem';
import { PRICE_SOURCE_VERSION, READER_VERSION } from '@aegis/ink-io';
import { RULES, SCENARIO_ENGINE_VERSION } from '@aegis/pose';
import type { CensusShip } from '../index.js';
import {
  HISTORY,
  INDEX_PATH,
  aggPath,
  aggPoint,
  appendAgg,
  appendWalletRows,
  compactAgg,
  emptyIndex,
  isAggFile,
  isHistoryIndex,
  isWalletFile,
  monthOf,
  shardOf,
  walletChanges,
  walletPath,
  type AggPoint,
  type HistoryIndex,
  type RowInput,
} from '../history.js';
import type { CensusStore } from './store.js';

export interface HistoryWriteOpts {
  store: CensusStore;
  client: PublicClient;
  block: number;
  at: string;
  sweep: 'full' | 'incremental';
  complete: boolean;
  /** every wallet read or carried this run, EMPTY included */
  ships: readonly CensusShip[];
  /** the previous scan's wallets (empty map = no previous scan: no change rows this run) */
  prev: ReadonlyMap<string, CensusShip>;
  known: number;
  stress: AggPoint['stress'];
  exclude?: ReadonlySet<string>;
  log?: (m: string) => void;
  concurrency?: number;
}

export interface HistoryWriteResult {
  point: boolean;
  reorgMarked: boolean;
  baseline: boolean;
  rows: number;
  shards: number;
  skipped: string[];
}

async function blockHash(client: PublicClient, block: number): Promise<string | null> {
  try {
    const b = await client.getBlock({ blockNumber: BigInt(block) });
    return b.hash ?? null;
  } catch {
    return null;
  }
}

async function pool<T>(items: readonly T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]!);
    }),
  );
}

export async function recordHistory(o: HistoryWriteOpts): Promise<HistoryWriteResult> {
  const log = o.log ?? (() => {});
  const exclude = o.exclude ?? new Set<string>();
  const res: HistoryWriteResult = { point: false, reorgMarked: false, baseline: false, rows: 0, shards: 0, skipped: [] };
  const month = monthOf(Date.parse(o.at));
  const atSec = Math.floor(Date.parse(o.at) / 1000);
  const ships = o.ships.filter((s) => !exclude.has(s.address));

  const rawIndex = await o.store.get(INDEX_PATH);
  if (rawIndex !== null && !isHistoryIndex(rawIndex)) {
    res.skipped.push('history/index.json is not a history index — left untouched, nothing recorded this run');
    log(`history: ${res.skipped[0]}`);
    return res;
  }
  const index: HistoryIndex = rawIndex ? { ...rawIndex, months: [...rawIndex.months], baselined: [...rawIndex.baselined], compacted: [...(rawIndex.compacted ?? [])] } : emptyIndex();
  const indexBefore = JSON.stringify(index);

  /* ── aggregate point ── */
  try {
    const raw = await o.store.get(aggPath(month));
    if (raw !== null && !isAggFile(raw)) throw new Error(`${aggPath(month)} exists but isn't an aggregate history file — left untouched`);
    const file = raw ? { ...raw, points: raw.points.map((p) => ({ ...p })) } : null;
    // reorg check on the newest recorded point that has a hash
    const last = file?.points.filter((p) => p.hash).at(-1);
    if (last && !last.reorg) {
      const now = await blockHash(o.client, last.block);
      if (now !== null && now !== last.hash) {
        last.reorg = true;
        res.reorgMarked = true;
        log(`history: block ${last.block} was reorganised since it was recorded — point kept and marked`);
      }
    }
    const hash = await blockHash(o.client, o.block);
    const p = aggPoint({
      ships,
      known: o.known,
      at: o.at,
      block: o.block,
      hash,
      sweep: o.sweep,
      complete: o.complete,
      versions: { rules: RULES.RULES_VERSION, engine: SCENARIO_ENGINE_VERSION, reader: READER_VERSION, prices: PRICE_SOURCE_VERSION },
      stress: o.stress,
    });
    const next = appendAgg(file, p);
    if (file && next.points.length === file.points.length && !res.reorgMarked) log('history: this block is already recorded — nothing added');
    else await o.store.put(aggPath(month), next);
    res.point = true;
    if (!index.months.includes(month)) index.months = [...index.months, month].sort();
    if (!index.firstAt) {
      index.firstAt = o.at;
      index.firstBlock = o.block;
    }
    if (hash === null) log('history: block hash unavailable this run — point recorded without it');
  } catch (e) {
    res.skipped.push(`aggregate: ${String(e).slice(0, 160)}`);
    log(`history: aggregate point not recorded: ${String(e).slice(0, 160)}`);
  }

  /* ── older months: one finished month past the hourly window is thinned per run, once ── */
  const keepFrom = Date.now() - HISTORY.HOURLY_KEEP_DAYS * 86_400_000;
  const due = index.months.find((m) => m !== month && !(index.compacted ?? []).includes(m) && Date.parse(`${m}-01T00:00:00Z`) < keepFrom - 31 * 86_400_000);
  if (due) {
    try {
      const raw = await o.store.get(aggPath(due));
      if (isAggFile(raw)) {
        const before = raw.points.length;
        await o.store.put(aggPath(due), { ...raw, points: compactAgg(raw.points, keepFrom) });
        index.compacted = [...(index.compacted ?? []), due].sort();
        log(`history: ${due} compacted ${before} → ${compactAgg(raw.points, keepFrom).length} points (one per ${HISTORY.COMPACT_EVERY_H} h + every risk change)`);
      }
    } catch (e) {
      res.skipped.push(`compaction ${due}: ${String(e).slice(0, 120)}`);
    }
  }

  /* ── wallet rows ── */
  const byShard = new Map<string, RowInput[]>();
  const add = (s: CensusShip, kind: 'B' | 'T') => {
    const k = shardOf(s.address);
    byShard.set(k, [...(byShard.get(k) ?? []), { ship: s, kind }]);
  };
  const needBaseline = !index.baselined.includes(month);
  if (needBaseline) {
    // first write of the month: every wallet with a position gets a BASELINE row (its state now)
    for (const s of ships) if (s.primary !== 'EMPTY') add(s, 'B');
    res.baseline = true;
  } else if (o.prev.size > 0) {
    for (const s of walletChanges(o.prev, ships, exclude)) add(s, 'T');
  } else {
    log('history: no previous scan to compare — wallet changes start next run');
  }
  const shards = needBaseline ? Array.from({ length: HISTORY.SHARDS }, (_, i) => String(i).padStart(2, '0')) : [...byShard.keys()];
  let failed = 0;
  await pool(shards, o.concurrency ?? 8, async (shard) => {
    try {
      const path = walletPath(month, shard);
      const raw = await o.store.get(path);
      if (raw !== null && !isWalletFile(raw)) throw new Error(`${path} exists but isn't a wallet history file — left untouched`);
      const rows = byShard.get(shard) ?? [];
      const before = raw ? raw.rows.length : 0;
      const next = appendWalletRows(raw, { month, shard, rows, block: o.block, atSec, rules: RULES.RULES_VERSION, exclude });
      if (raw && next.rows.length === before) return; // nothing new (a re-run of the same block)
      await o.store.put(path, next);
      res.rows += next.rows.length - before;
      res.shards++;
    } catch (e) {
      failed++;
      res.skipped.push(`shard ${shard}: ${String(e).slice(0, 120)}`);
    }
  });
  if (needBaseline && failed === 0) index.baselined = [...index.baselined, month].sort();
  if (failed) log(`history: ${failed} wallet shard(s) not written this run (retried next run): ${res.skipped.slice(-1)[0]}`);

  if (JSON.stringify(index) !== indexBefore) {
    try {
      await o.store.put(INDEX_PATH, index);
    } catch (e) {
      res.skipped.push(`index: ${String(e).slice(0, 120)}`);
    }
  }
  log(`history: ${res.point ? 'point recorded' : 'NO point'}${res.baseline ? ` · month ${month} baseline` : ''} · ${res.rows} wallet row(s) in ${res.shards} shard(s)${res.reorgMarked ? ' · reorg marked' : ''}`);
  return res;
}
