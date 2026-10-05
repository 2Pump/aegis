/**
 * LIQUIDATION LEDGER writer — runs inside the hourly census, after the Flight Recorder.
 *
 *  forward   every run: liquidations from the last scanned block to the head (new ones, seconds of work)
 *  backfill  every run, inside a time budget: from the protocols' launch blocks towards where forward scanning
 *            began. Checkpointed in history/index.json → resumes after any interruption; finishes in ~a day of
 *            hourly runs; never an unbounded scan in one go.
 *
 * Each liquidation is enriched from the chain (block time; Tydro: oracle prices AT THAT BLOCK for the size range
 * and implied bonus — unavailable, never guessed, when the RPC can't serve that block) and joined with what the
 * Flight Recorder had recorded for that wallet before the liquidation block. Cursors only move after the records
 * are written, and writes are idempotent (tx + log index), so a failed run just repeats the work next time.
 */
import type { PublicClient } from 'viem';
import { READER_VERSION, TYDRO_START_BLOCK, decodeLiquidations, readTydroPrices, scanLiquidations, subaccountKind, TYDRO_RESERVES, type RawLiquidation } from '@aegis/ink-io';
import { RULES, TAGS } from '@aegis/pose';
import { sizeBand } from '@aegis/glyphs';
import { INDEX_PATH, isHistoryIndex, isWalletFile, monthOf, shardOf, walletPath, walletTimeline, type HistoryIndex, type LedgerCursor, type WalletFile } from '../history.js';
import {
  ACCOUNT_PATH,
  LEDGER,
  appendLedger,
  isLedgerFile,
  isWarnFile,
  ledgerPath,
  priorState,
  readWarnings,
  scoreAccountability,
  warnPath,
  type LedgerRecord,
} from '../ledger.js';
import type { CensusStore } from './store.js';

export interface LedgerOpts {
  store: CensusStore;
  client: PublicClient;
  head: number;
  /** wall-clock budget for this run's ledger work (forward always gets at least 2 minutes) */
  budgetMs: number;
  exclude?: ReadonlySet<string>;
  log?: (m: string) => void;
  scan?: { paceMs?: number; backoffBaseMs?: number; onLimit?: (n: number) => void };
}

export interface LedgerResult {
  forward: number;
  backfill: number;
  written: number;
  skipped: number;
  cursor: LedgerCursor | null;
  notes: string[];
}

const reserveDec = new Map(TYDRO_RESERVES.map((r, i) => [r.underlying.toLowerCase(), { i, decimals: r.decimals }]));
const toUnits = (amount: string, decimals: number) => Number(BigInt(amount)) / 10 ** decimals;

async function pool<T>(items: readonly T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]!);
    }),
  );
}

export async function recordLiquidations(o: LedgerOpts): Promise<LedgerResult> {
  const log = o.log ?? (() => {});
  const t0 = Date.now();
  const res: LedgerResult = { forward: 0, backfill: 0, written: 0, skipped: 0, cursor: null, notes: [] };
  const rawIndex = await o.store.get(INDEX_PATH);
  if (!isHistoryIndex(rawIndex)) {
    res.notes.push('no Flight Recorder index yet — ledger starts once history is recording');
    log(`ledger: ${res.notes[0]}`);
    return res;
  }
  const index: HistoryIndex = rawIndex;
  const cur: LedgerCursor = index.ledger ?? {
    startedAt: new Date().toISOString(),
    forwardFrom: o.head,
    forwardTo: o.head,
    backfillFrom: TYDRO_START_BLOCK,
    backfillNext: TYDRO_START_BLOCK,
    done: false,
    events: 0,
    skipped: 0,
  };
  const scanOpts = { maxRetries: 4, paceMs: o.scan?.paceMs, backoffBaseMs: o.scan?.backoffBaseMs, onLimit: o.scan?.onLimit };

  /* ── scan ── */
  const forwardDeadline = t0 + Math.max(o.budgetMs, 2 * 60_000);
  const fwd = o.head > cur.forwardTo ? await scanLiquidations(o.client, cur.forwardTo + 1, o.head, { ...scanOpts, deadline: forwardDeadline }) : null;
  const backDeadline = t0 + o.budgetMs;
  const back = !cur.done && Date.now() < backDeadline ? await scanLiquidations(o.client, cur.backfillNext, cur.forwardFrom, { ...scanOpts, deadline: backDeadline }) : null;
  const decoded = decodeLiquidations([...(fwd?.logs ?? []), ...(back?.logs ?? [])]);
  const exclude = o.exclude ?? new Set<string>();
  const raws = decoded.liquidations.filter((l) => !exclude.has(l.user));
  res.forward = fwd ? fwd.logs.length : 0;
  res.backfill = back ? back.logs.length : 0;
  res.skipped = decoded.skipped;

  /* ── enrich: block times (required), Tydro prices at the block (optional → unavailable) ── */
  const blocks = [...new Set(raws.map((r) => r.block))];
  const times = new Map<number, number>();
  const prices = new Map<number, number[] | null>();
  await pool(blocks, 6, async (b) => {
    try {
      const blk = await o.client.getBlock({ blockNumber: BigInt(b) });
      times.set(b, Number(blk.timestamp) * 1000);
    } catch {
      /* missing → this batch isn't written; cursors don't move; next run retries */
    }
  });
  if (times.size < blocks.length) {
    res.notes.push(`${blocks.length - times.size} block time(s) unreadable — nothing written, retried next run`);
    log(`ledger: ${res.notes.at(-1)}`);
    return res;
  }
  const tydroBlocks = [...new Set(raws.filter((r) => r.venue === 'tydro').map((r) => r.block))];
  await pool(tydroBlocks, 4, async (b) => {
    const p = await readTydroPrices(o.client, BigInt(b));
    prices.set(b, p.ok ? p.value.usd : null);
  });

  /* ── what Phrourax had recorded before each liquidation ── */
  const recordingStart = index.firstBlock !== null ? { block: index.firstBlock } : null;
  const shardCache = new Map<string, Promise<WalletFile | null>>();
  const getShard = (month: string, shard: string) => {
    const k = walletPath(month, shard);
    if (!shardCache.has(k)) shardCache.set(k, o.store.get(k).then((f) => (isWalletFile(f) ? f : null)).catch(() => null));
    return shardCache.get(k)!;
  };
  const prevMonth = (m: string) => {
    const d = new Date(`${m}-01T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - 1);
    return d.toISOString().slice(0, 7);
  };

  const records: LedgerRecord[] = [];
  for (const r of raws) {
    const at = times.get(r.block)!;
    const unavailable: string[] = [];
    let aegis = priorState([], r.block, recordingStart);
    if (aegis.evaluable) {
      const m = monthOf(at);
      const files = (await Promise.all([prevMonth(m), m].filter((x) => index.months.includes(x)).map((x) => getShard(x, shardOf(r.user))))).filter((f): f is WalletFile => !!f);
      aegis = priorState(walletTimeline(files, r.user), r.block, recordingStart);
    }
    records.push(toRecord(r, at, prices.get(r.block) ?? null, aegis, unavailable));
  }

  /* ── write, month by month (idempotent) ── */
  const byMonth = new Map<string, LedgerRecord[]>();
  for (const rec of records) byMonth.set(monthOf(rec.at), [...(byMonth.get(monthOf(rec.at)) ?? []), rec]);
  for (const [m, recs] of byMonth) {
    const raw = await o.store.get(ledgerPath(m));
    if (raw !== null && !isLedgerFile(raw)) {
      res.notes.push(`${ledgerPath(m)} exists but isn't a ledger file — left untouched; nothing written`);
      log(`ledger: ${res.notes.at(-1)}`);
      return res;
    }
    const before = raw ? raw.records.length : 0;
    const next = appendLedger(raw, m, recs);
    if (next.records.length !== before) await o.store.put(ledgerPath(m), next);
    res.written += next.records.length - before;
    if (!(index.ledgerMonths ?? []).includes(m)) index.ledgerMonths = [...(index.ledgerMonths ?? []), m].sort();
  }

  /* ── move the cursors only now ── */
  if (fwd) cur.forwardTo = fwd.scannedTo;
  if (back) {
    cur.backfillNext = back.scannedTo + 1;
    cur.done = back.scannedTo >= cur.forwardFrom;
  }
  cur.events += raws.length;
  cur.skipped += decoded.skipped;
  index.ledger = cur;
  await o.store.put(INDEX_PATH, index);
  res.cursor = cur;
  const pct = cur.done ? 100 : Math.floor(((cur.backfillNext - cur.backfillFrom) / Math.max(1, cur.forwardFrom - cur.backfillFrom)) * 100);
  log(
    `ledger: ${raws.length} liquidation(s) found (${res.written} new) · forward to ${cur.forwardTo}${fwd && !fwd.complete ? ` (paused: ${fwd.stoppedBecause})` : ''} · history ${cur.done ? 'COMPLETE' : `${pct}% (block ${cur.backfillNext.toLocaleString('en-US')} of ${cur.forwardFrom.toLocaleString('en-US')})`}${decoded.skipped ? ` · ${decoded.skipped} malformed log(s) skipped` : ''} · ${Math.round((Date.now() - t0) / 1000)}s`,
  );
  return res;
}

function toRecord(r: RawLiquidation, at: number, usd: number[] | null, aegis: LedgerRecord['aegis'], unavailable: string[]): LedgerRecord {
  const base = { id: r.id, venue: r.venue, tx: r.tx, block: r.block, at, wallet: r.user, aegis, v: { ledger: LEDGER.VERSION, reader: READER_VERSION, rules: RULES.RULES_VERSION } };
  if (r.venue === 'tydro') {
    const c = reserveDec.get(r.collateral.asset);
    const d = reserveDec.get(r.debt.asset);
    let sizeBandV: LedgerRecord['sizeBand'] = null;
    let bonus: number | null = null;
    if (usd && c && d) {
      const debtUsd = toUnits(r.debt.amount, d.decimals) * (usd[d.i] ?? NaN);
      const collUsd = toUnits(r.collateral.amount, c.decimals) * (usd[c.i] ?? NaN);
      if (Number.isFinite(debtUsd) && debtUsd > 0) sizeBandV = sizeBand(debtUsd);
      if (Number.isFinite(debtUsd) && Number.isFinite(collUsd) && debtUsd > 0) bonus = Math.round((collUsd / debtUsd - 1) * 1000) / 10;
    }
    if (!usd) unavailable.push("size range and bonus (the RPC couldn't serve oracle prices at that block)");
    else if (!c || !d) unavailable.push('size range and bonus (asset not in the Tydro registry)');
    if (aegis.evaluable === false) unavailable.push('prior Phrourax state (before recording began)');
    return {
      ...base,
      subaccountKind: null,
      collateral: r.collateral.symbol ?? r.collateral.asset,
      debt: r.debt.symbol ?? r.debt.asset,
      product: null,
      family: r.collateral.family ?? null,
      isEncodedSpread: null,
      sizeBand: sizeBandV,
      sizeBasis: sizeBandV ? "debt repaid, at Tydro's oracle prices at that block" : null,
      impliedBonusPct: bonus,
      completeness: unavailable.length ? 'PARTIAL' : 'COMPLETE',
      unavailable,
      source: `Tydro Pool LiquidationCall · tx ${r.tx}`,
    };
  }
  const quote = Math.abs(Number(BigInt(r.amountQuoteX18)) / 1e18);
  const band = Number.isFinite(quote) && quote > 0 ? sizeBand(quote) : null;
  unavailable.push('direction (the event does not state which side the liquidated position was on)');
  if (!band) unavailable.push('size range (quote amount missing or zero)');
  if (!r.symbol) unavailable.push(`product name (product ${r.productId} is not in Phrourax's Nado list)`);
  if (aegis.evaluable === false) unavailable.push('prior Phrourax state (before recording began)');
  return {
    ...base,
    subaccountKind: subaccountKind(r.subaccount),
    collateral: null,
    debt: null,
    product: r.symbol ?? `product ${r.productId}`,
    family: r.family ?? null,
    isEncodedSpread: r.isEncodedSpread,
    sizeBand: band,
    sizeBasis: band ? 'quote amount of the liquidation as stated in the event (USDT0)' : null,
    impliedBonusPct: null,
    completeness: unavailable.length ? 'PARTIAL' : 'COMPLETE',
    unavailable,
    source: `Nado Clearinghouse Liquidation · tx ${r.tx}`,
  };
}

/** Recompute the track record from every warning and liquidation since recording began (bounded to 13 months). */
export async function rescoreAccountability(store: CensusStore, nowMs: number, log: (m: string) => void = () => {}): Promise<void> {
  const index = await store.get(INDEX_PATH);
  if (!isHistoryIndex(index)) return;
  const months = (index.months ?? []).slice(-13);
  const liqMonths = (index.ledgerMonths ?? []).filter((m) => !index.firstAt || m >= index.firstAt.slice(0, 7)).slice(-13);
  const [warnFiles, liqFiles] = await Promise.all([Promise.all(months.map((m) => store.get(warnPath(m)).catch(() => null))), Promise.all(liqMonths.map((m) => store.get(ledgerPath(m)).catch(() => null)))]);
  const warnings = readWarnings(warnFiles.filter(isWarnFile));
  const liquidations = liqFiles.filter(isLedgerFile).flatMap((f) => f.records);
  const a = scoreAccountability({ warnings, liquidations, nowMs, recordingStart: index.firstAt, tags: TAGS });
  await store.put(ACCOUNT_PATH, a);
  log(`accountability: ${a.liquidations.evaluable} evaluable liquidation(s), ${a.warnings.total} warning(s) · warned before ${a.recall.num}/${a.recall.den}`);
}
