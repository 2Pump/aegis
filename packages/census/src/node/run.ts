import {
  NADO_START_BLOCK,
  TYDRO_START_BLOCK,
  TYDRO_TOKENS,
  VERTEX_PROTOCOL_SUBS,
  decodeNadoProtocolSubaccounts,
  decodeNadoSubaccounts,
  decodeTydroTransfers,
  readNadoSubsMany,
  readNlpPools,
  scanNadoTouched,
  isProtocolSub,
  nadoSubaccount,
  readBooksMany,
  readProtocolTotals,
  readTydroPrices,
  scanNadoAccounts,
  scanNadoActivity,
  scanTydro,
  seedTydroHolders,
  subaccountOwner,
  type FetchLike,
} from '@aegis/ink-io';
import { RULES, classify } from '@aegis/pose';
import { shipSizeUsd, sizeBand } from '@aegis/glyphs';
import type { PublicClient } from 'viem';
import {
  CENSUS_VERSION,
  CoverageAcc,
  PressureAcc,
  buildCoverage,
  coveragePct,
  coverageSummary,
  publicCoverage,
  type CoveragePublic,
  decodeSnapshot,
  encodeShip,
  shipFromRead,
  summarize,
  type CensusShip,
  type CensusSnapshot,
  stressLevel,
  queryPressure,
  type PressureSnapshot,
  type AggPoint,
} from '../index.js';
import type { CensusStore } from './store.js';
import { recordHistory } from './history-write.js';
import { recordLiquidations, rescoreAccountability } from './ledger-write.js';
import { recordChanges, recordOracles, rescoreForecasts } from './intel-write.js';
import { recordCarry } from './carry-write.js';
import { appendForecast, forecastPath, type ForecastRecord } from '../ledger.js';

/** Job state (known.json). Addresses only — public chain facts, no balances. */
/**
 * History that still has to be scanned BEFORE the forward cursor. Exists because a `--since-blocks` run (or a
 * state made by one) only covers recent blocks: the forward cursor alone can't tell "all history" from "recent only".
 *  - done: every block since the venue launched has been covered
 *  - chain: [next, end] still to scan on-chain
 *  - seed (Tydro only): explorer holder lists still to read (token indexes); `stalls` = runs in a row with no progress
 */
export type History = { done: true } | { done: false; next: number; end: number; seedTokens?: number[]; stalls?: number };

export interface CensusState {
  v: 1;
  tydro: { scannedTo: number; users: Record<string, number[]>; seededFromExplorerAt?: number; history?: History };
  nado: {
    accountsScannedTo: number;
    activityScannedTo: number;
    subs: Record<string, string[]>;
    active: string[];
    history?: History;
    /**
     * Every trade (BalanceUpdate) since launch, scanned once. Isolated-margin subaccounts are created by Nado's engine
     * and funded from the owner's main account, so they never emit a deposit (ModifyCollateral) — trades are the only
     * public event that names them.
     */
    tradeHistory?: History;
    /** protocol-owned (zero-owner) subaccounts seen in logs — read for coverage only, never drawn */
    protocolSubs?: string[];
  };
  lastFullBlock: number;
  lastFullAt: string | null;
  /** start a full sweep at the next run (e.g. a history backfill just finished) */
  fullDue?: boolean;
  /**
   * A full sweep in progress. Wallets are swept in address order; `cursor` is the last address read. A sweep that
   * runs out of time continues from here next run instead of starting over.
   */
  fullSweep?: { cursor: string; startBlock: number; startedAt: string; runs: number };
  /** wallets read as EMPTY → block of that read. Kept here (addresses only) instead of in census.json, which only carries ships worth drawing */
  empty?: Record<string, number>;
  /** last full sweep's coverage vs protocol totals — shares only, no dollar figures (this file is public too) */
  coverage?: CoveragePublic;
}

export interface RunOpts {
  client: PublicClient;
  store: CensusStore;
  /** re-read every known wallet, including quiet Nado accounts */
  full?: boolean;
  /** force a full sweep when the last one is older than this (ms) */
  fullIfOlderThanMs?: number;
  /** stop discovery/reads at this many ms and save progress; the next run resumes */
  budgetMs?: number;
  /** for quick local tests: only discover wallets active in the last N blocks */
  sinceBlocks?: number;
  /** blocks behind head to treat as final */
  confirmations?: number;
  /** first retry wait for getLogs (tests use 1 ms). Default 1000 ms. */
  scanBackoffMs?: number;
  /** pause between getLogs requests (be gentle with free RPCs). Default 60 ms; tests use 0. */
  scanPaceMs?: number;
  /** share of the budget that history backfill (explorer seed + old-block scans) may use; reads get the rest. Default 0.6 */
  backfillShare?: number;
  /** one-time Tydro seed from the explorer's holder lists (false = always scan the chain) */
  explorer?: false | { fetch?: FetchLike; base?: string; pageDelayMs?: number; backoffBaseMs?: number };
  log?: (msg: string) => void;
  /** Flight Recorder (history.ts): record this run. Default true. */
  history?: boolean;
  /** addresses never recorded (Phrourax's synthetic test wallets) */
  exclude?: ReadonlySet<string>;
  /** Liquidation Ledger (ledger.ts): scan liquidations and score the track record. Default true (needs history). */
  ledger?: boolean;
  /** time the ledger backfill may use per run. Default 8 minutes. */
  ledgerBudgetMs?: number;
  /** Oracle Watch, Protocol Change Monitor, forecast scoring (Release 3), Yield and Carry (Release 4). Default true. */
  intel?: boolean;
  /** Yield and Carry (Release 4). Default true; false skips only this step. */
  carry?: boolean;
}

/** Logs a progress line only when the percentage crosses a new 10% step. */
function progress(log: (m: string) => void, label: string, from: number, to: number) {
  let last = -1;
  return (p: { to: number }) => {
    const pct = Math.floor(((p.to - from) / Math.max(1, to - from + 1)) * 10) * 10;
    if (pct > last) {
      last = pct;
      log(`${label} → block ${p.to} (${pct}%)`);
    }
  };
}

/** Plain-words retry logging: first wait, then every third, so the Action log stays readable. */
function retryLog(log: (m: string) => void, label: string) {
  return (i: { attempt: number; kind?: string; waitMs: number; error: string; span?: number }) => {
    if (i.kind === 'size' && i.attempt < 3) return; // size is handled silently unless it keeps failing
    if (i.attempt === 1 || i.attempt % 3 === 0) {
      const what = i.kind === 'size' ? `RPC said the request was too big — trying ${i.span}-block windows` : `RPC is throttling/slow — waiting ${Math.round(i.waitMs / 1000)}s`;
      log(`${label}: ${what} (try ${i.attempt}; ${i.error})`);
    }
  };
}

/** Sum of two coverage accumulators (wallets + protocol accounts). */
function mergeAcc(a: CoverageAcc, b: CoverageAcc): CoverageAcc {
  const out = new CoverageAcc();
  for (const k of ['tydroSupply', 'tydroDebt', 'nadoDeposits', 'nadoBorrows', 'nadoLongs', 'nadoShorts'] as const) {
    for (const src of [a, b]) for (const [key, v] of src[k] as Map<string | number, number>) (out[k] as Map<string | number, number>).set(key, ((out[k] as Map<string | number, number>).get(key) ?? 0) + v);
  }
  return out;
}

/** Isolated-margin subaccounts carry "iso" in their 12-byte name (Nado SDK bytes32 tests). Used for logging only. */
export const isIsolatedSub = (sub: string) => sub.slice(42).toLowerCase().includes('69736f');

const freshState = (): CensusState => ({
  v: 1,
  tydro: { scannedTo: 0, users: {} },
  nado: { accountsScannedTo: 0, activityScannedTo: 0, subs: {}, active: [] },
  lastFullBlock: 0,
  lastFullAt: null,
});

export async function runCensus(o: RunOpts): Promise<CensusSnapshot> {
  const t0 = Date.now();
  const log = o.log ?? (() => {});
  const deadline = t0 + (o.budgetMs ?? 40 * 60_000);
  const client = o.client;

  const state = ((await o.store.get('known.json')) as CensusState | null) ?? freshState();
  // a full sweep requested by an earlier run starts now; one requested during this run starts next run (full budget)
  const fullDueAtStart = state.fullDue === true;
  let fullDueNext = false;
  let prevShips = new Map<string, CensusShip>();
  const prevRaw = await o.store.get('census.json');
  if (prevRaw) {
    try {
      prevShips = new Map(decodeSnapshot(prevRaw).ships.map((s) => [s.address, s]));
    } catch (e) {
      log(`previous census unreadable, starting clean: ${String(e)}`);
    }
  }

  // empty wallets live in known.json, not census.json — bring them back as EMPTY ships for the carry decision
  for (const [addr, block] of Object.entries(state.empty ?? {})) {
    if (!prevShips.has(addr)) {
      prevShips.set(addr, {
        address: addr, primary: 'EMPTY', tags: ['EMPTY'], hullTemp: 'NOMINAL', band: 'dust', watch: false,
        venues: { tydro: false, nado: false }, readBlock: block, woundedSince: null, wound: { tydro: false, nado: false }, correlatedLoop: false, correlatedNado: false, extraSubs: [],
      });
    }
  }

  const head = Number(await client.getBlockNumber()) - (o.confirmations ?? 2);
  /** the moment this run's reading block was taken — what the history point describes */
  const headAt = new Date().toISOString();
  const floor = o.sinceBlocks ? Math.max(0, head - o.sinceBlocks) : 0;
  log(`head ${head} · store ${o.store.describe} · known tydro ${Object.keys(state.tydro.users).length} · known nado owners ${Object.keys(state.nado.subs).length}`);

  /* ── 1. discovery ─────────────────────────────────────────── */
  const touched = new Set<string>();

  const backfillDeadline = t0 + Math.round((o.budgetMs ?? 40 * 60_000) * (o.backfillShare ?? 0.6));
  const ALL_TOKENS = Array.from({ length: 28 }, (_, i) => i);
  const scanOpts = { onLimit: (n: number) => log(`RPC allows ${n} blocks per history request — using exactly that from now on`), backoffBaseMs: o.scanBackoffMs, paceMs: o.scanPaceMs };

  /* ── history bookkeeping ──
     A fresh state that scans from launch needs no backfill. A `--since-blocks` run records what it skipped.
     A state from before this bookkeeping existed can't prove it saw all history, so it gets re-checked once. */
  const freshTydro = state.tydro.scannedTo === 0;
  const freshNado = state.nado.accountsScannedTo === 0;
  if (!state.tydro.history) {
    if (freshTydro) {
      state.tydro.history = floor > TYDRO_START_BLOCK
        ? { done: false, next: TYDRO_START_BLOCK, end: floor - 1, ...(o.explorer !== false ? { seedTokens: ALL_TOKENS } : {}) }
        : o.explorer !== false ? { done: false, next: 0, end: -1, seedTokens: ALL_TOKENS } : { done: true };
    } else if (state.tydro.seededFromExplorerAt) {
      state.tydro.history = { done: true };
    } else {
      log('tydro: this census state cannot prove it covered all history (made by a quick --since-blocks run?) — backfilling once');
      state.tydro.history = { done: false, next: TYDRO_START_BLOCK, end: state.tydro.scannedTo, ...(o.explorer !== false ? { seedTokens: ALL_TOKENS } : {}) };
    }
  }
  if (!state.nado.history) {
    if (freshNado) state.nado.history = floor > NADO_START_BLOCK ? { done: false, next: NADO_START_BLOCK, end: floor - 1 } : { done: true };
    else {
      log('nado: this census state cannot prove it covered all history — backfilling once');
      state.nado.history = { done: false, next: NADO_START_BLOCK, end: state.nado.accountsScannedTo };
    }
  }
  const historyWasDone = state.tydro.history.done && state.nado.history.done;

  const addTydro = (addr: string, idxs: Iterable<number>, markTouched: boolean) => {
    const cur = new Set(state.tydro.users[addr] ?? []);
    for (const i of idxs) cur.add(i);
    state.tydro.users[addr] = [...cur].sort((a, b) => a - b);
    if (markTouched) touched.add(addr);
  };
  const noteProtocol = (logs: Parameters<typeof decodeNadoProtocolSubaccounts>[0]) => {
    const cur = new Set(state.nado.protocolSubs ?? []);
    for (const s of decodeNadoProtocolSubaccounts(logs)) cur.add(s);
    state.nado.protocolSubs = [...cur].sort();
  };
  const addSub = (sub: string) => {
    const owner = subaccountOwner(sub);
    const list = state.nado.subs[owner] ?? [];
    if (!list.includes(sub)) list.push(sub);
    state.nado.subs[owner] = list;
    return owner;
  };

  // Tydro, first run with the explorer: seed from holder lists BEFORE the forward scan, so the forward scan
  // only has to cover the last few minutes (the explorer indexes slightly behind the chain)
  let seededThisRun = false;
  if (freshTydro && !o.sinceBlocks && state.tydro.history.done === false && state.tydro.history.seedTokens) {
    await seedTydro(true);
    seededThisRun = true;
  }

  // Tydro: every aToken/vToken Transfer since the forward cursor, resumable
  const tFrom = Math.max(state.tydro.scannedTo + 1, TYDRO_START_BLOCK, floor);
  if (tFrom <= head) {
    const r = await scanTydro(client, tFrom, head, { deadline, onProgress: progress(log, 'tydro discovery', tFrom, head), onRetry: retryLog(log, 'tydro discovery'), ...scanOpts });
    for (const [addr, idxs] of decodeTydroTransfers(r.logs)) addTydro(addr, idxs, state.tydro.scannedTo > 0);
    state.tydro.scannedTo = r.scannedTo;
    await o.store.put('known.json', state);
    log(`tydro discovery → ${r.scannedTo}${r.complete ? '' : ` — PAUSED (${r.stoppedBecause}); progress saved, resumes next run`} · ${r.logs.length} logs · ${r.errors} retries`);
  }

  // Nado accounts: deposits/withdrawals + liquidations since the forward cursor (low volume, resumable)
  const nFrom = Math.max(state.nado.accountsScannedTo + 1, NADO_START_BLOCK, floor);
  if (nFrom <= head && Date.now() < deadline) {
    const r = await scanNadoAccounts(client, nFrom, head, { deadline, onProgress: progress(log, 'nado account discovery', nFrom, head), onRetry: retryLog(log, 'nado account discovery'), ...scanOpts });
    for (const sub of decodeNadoSubaccounts(r.logs)) {
      const owner = addSub(sub);
      if (state.nado.accountsScannedTo > 0) touched.add(owner);
    }
    noteProtocol(r.logs);
    state.nado.accountsScannedTo = r.scannedTo;
    await o.store.put('known.json', state);
    log(`nado account discovery → ${r.scannedTo}${r.complete ? '' : ` — PAUSED (${r.stoppedBecause}); progress saved, resumes next run`} · ${r.logs.length} logs`);
  }

  // Nado activity (every trade) since the last run. The very first run starts ~6 h back; older trades are covered
  // once by the trade-history backfill below. No cap after that: a long gap between runs must not be skipped.
  if (!state.nado.tradeHistory) {
    const end = state.nado.activityScannedTo > 0 ? state.nado.activityScannedTo : Math.max(head - 21_600, NADO_START_BLOCK, floor) - 1;
    state.nado.tradeHistory = end >= NADO_START_BLOCK && !o.sinceBlocks ? { done: false, next: NADO_START_BLOCK, end } : { done: true };
    if (!state.nado.tradeHistory.done) log('nado: scanning every trade since launch once, to find isolated-margin subaccounts (they never make a deposit)');
  }
  const aFrom = state.nado.activityScannedTo > 0 ? Math.max(state.nado.activityScannedTo + 1, floor) : Math.max(head - 21_600, NADO_START_BLOCK, floor);
  if (aFrom <= head && Date.now() < deadline) {
    const r = await scanNadoActivity(client, aFrom, head, { deadline, initialSpan: 2_000, onRetry: retryLog(log, 'nado activity'), backoffBaseMs: o.scanBackoffMs, paceMs: o.scanPaceMs });
    if (!r.complete) log(`nado activity paused at ${r.scannedTo}: ${r.stoppedBecause}`);
    const subs = decodeNadoSubaccounts(r.logs);
    for (const sub of subs) touched.add(addSub(sub));
    noteProtocol(r.logs);
    state.nado.activityScannedTo = r.scannedTo;
    log(`nado activity ${aFrom}→${r.scannedTo} · ${r.logs.length} logs · ${subs.size} subaccounts touched`);
  }

  /* ── history backfill (never in a --since-blocks run; capped so the hourly reads still happen) ── */
  if (!o.sinceBlocks) {
    // Tydro: explorer holder lists first (minutes), the chain range only if the explorer keeps failing
    if (!seededThisRun && state.tydro.history.done === false && state.tydro.history.seedTokens && Date.now() < backfillDeadline) await seedTydro(false);
    const th = state.tydro.history;
    if (th.done === false && !th.seedTokens && Date.now() < backfillDeadline) {
      const r = await scanTydro(client, th.next, th.end, { deadline: backfillDeadline, onProgress: progress(log, 'tydro history', th.next, th.end), onRetry: retryLog(log, 'tydro history'), ...scanOpts });
      for (const [addr, idxs] of decodeTydroTransfers(r.logs)) addTydro(addr, idxs, false);
      state.tydro.history = r.scannedTo >= th.end ? { done: true } : { ...th, next: r.scannedTo + 1 };
      await o.store.put('known.json', state);
      log(`tydro history → ${r.scannedTo} of ${th.end}${state.tydro.history.done ? ' — COMPLETE' : ' — continues next run'} · ${r.logs.length} logs`);
    }
    const nh = state.nado.history;
    if (nh.done === false && Date.now() < backfillDeadline) {
      const r = await scanNadoAccounts(client, nh.next, nh.end, { deadline: backfillDeadline, onProgress: progress(log, 'nado history', nh.next, nh.end), onRetry: retryLog(log, 'nado history'), ...scanOpts });
      const before = Object.keys(state.nado.subs).length;
      for (const sub of decodeNadoSubaccounts(r.logs)) addSub(sub);
      state.nado.history = r.scannedTo >= nh.end ? { done: true } : { ...nh, next: r.scannedTo + 1 };
      await o.store.put('known.json', state);
      log(`nado history → ${r.scannedTo} of ${nh.end}${state.nado.history.done ? ' — COMPLETE' : ' — continues next run'} · ${r.logs.length} logs · +${Object.keys(state.nado.subs).length - before} owners`);
    }
  }
  const historyJustDone = !historyWasDone && state.tydro.history.done && state.nado.history.done;

  // Nado trade history (one time): finds isolated-margin subaccounts, which only ever appear in trades
  const trh = state.nado.tradeHistory;
  if (!o.sinceBlocks && trh && trh.done === false && Date.now() < backfillDeadline) {
    const r = await scanNadoActivity(client, trh.next, trh.end, { deadline: backfillDeadline, onProgress: progress(log, 'nado trade history', trh.next, trh.end), onRetry: retryLog(log, 'nado trade history'), ...scanOpts });
    const subCount = () => Object.values(state.nado.subs).reduce((n, l) => n + l.length, 0);
    const before = subCount();
    const seen = decodeNadoSubaccounts(r.logs);
    for (const sub of seen) addSub(sub);
    noteProtocol(r.logs);
    const iso = [...seen].filter(isIsolatedSub);
    const done = r.scannedTo >= trh.end;
    state.nado.tradeHistory = done ? { done: true } : { ...trh, next: r.scannedTo + 1 };
    if (done) fullDueNext = true; // the next run re-reads everyone, with its whole budget, and measures coverage
    await o.store.put('known.json', state);
    log(`nado trade history → ${r.scannedTo} of ${trh.end}${done ? ' — COMPLETE' : ' — continues next run'} · ${r.logs.length} logs · ${seen.size} subaccounts seen, +${subCount() - before} new · ${iso.length} isolated`);
    if (iso.length) log(`  isolated subaccount names (bytes after the owner), e.g. ${[...new Set(iso.map((x) => x.slice(42)))].slice(0, 3).join(', ')}`);
    if (done) log('trade history complete — the next run re-reads every wallet and measures coverage again');
  }
  if (historyJustDone) log('history backfill complete — this run re-reads everyone and measures coverage');

  async function seedTydro(first: boolean) {
    let h = state.tydro.history as Extract<History, { done: false }>;
    if (first) {
      // holder lists are "now": the forward scan only needs the last ~10 minutes (the explorer lags a little),
      // and if the explorer ever gives up, the on-chain fallback covers launch → here
      state.tydro.scannedTo = head - 600;
      h = state.tydro.history = { ...h, next: TYDRO_START_BLOCK, end: head - 600 };
    }
    const todo = h.seedTokens ?? ALL_TOKENS;
    log(`tydro: ${first ? 'one-time seed' : 'backfill'} from the Ink explorer holder lists — ${todo.length} of 28 token lists to read (addresses only; every balance is still read on-chain)…`);
    const ex = o.explorer || {};
    const seed = await seedTydroHolders({
      fetch: ex.fetch,
      base: ex.base,
      pageDelayMs: ex.pageDelayMs,
      backoffBaseMs: ex.backoffBaseMs,
      deadline: backfillDeadline,
      tokens: todo,
      onRetry: (m) => log(`tydro seed: ${m}`),
      onToken: (ti, holders, pages) => log(`tydro seed: token ${ti + 1}/28 · ${holders} holders · ${pages} pages`),
    });
    const before = Object.keys(state.tydro.users).length;
    for (const [addr, idxs] of seed.users) addTydro(addr, idxs, false);
    // explorer 404 = no holder list. Confirm on-chain: a token with totalSupply 0 has no holders, so it is done.
    const emptyOnChain: number[] = [];
    for (const ti of seed.notFound) {
      try {
        const supply = (await client.readContract({
          address: TYDRO_TOKENS[ti]!,
          abi: [{ type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }] as const,
          functionName: 'totalSupply',
          blockNumber: BigInt(head),
        })) as bigint;
        if (supply === 0n) {
          emptyOnChain.push(ti);
          log(`tydro seed: token ${ti + 1}/28 — explorer has no holder list, and on-chain totalSupply is 0: nobody holds it (done)`);
        } else log(`tydro seed: token ${ti + 1}/28 — explorer has no holder list but totalSupply is ${supply} — will retry`);
      } catch (e) {
        log(`tydro seed: token ${ti + 1}/28 — explorer 404 and totalSupply unreadable (${String(e).slice(0, 120)}) — will retry`);
      }
    }
    const left = todo.filter((t) => !seed.done.includes(t) && !emptyOnChain.includes(t));
    const stalls = seed.done.length + emptyOnChain.length === 0 ? (h.stalls ?? 0) + 1 : 0;
    if (left.length === 0) {
      state.tydro.history = { done: true };
      state.tydro.seededFromExplorerAt = head;
      log(`tydro seed complete: +${Object.keys(state.tydro.users).length - before} wallets (${Object.keys(state.tydro.users).length} known) from ${seed.pages} pages`);
    } else if (stalls >= 3) {
      // the explorer keeps failing: fall back to scanning the history on-chain (slow, but needs nothing but the RPC)
      state.tydro.history = { done: false, next: TYDRO_START_BLOCK, end: h.end };
      log('tydro seed: explorer failed 3 runs in a row — switching to an on-chain history scan');
    } else {
      state.tydro.history = { ...h, seedTokens: left, stalls };
      log(`tydro seed: ${seed.done.length} token lists done this run, ${left.length} left — continues next run (+${Object.keys(state.tydro.users).length - before} wallets so far)`);
    }
    await o.store.put('known.json', state);
  }

  // save discovery progress now, so a crash or Ctrl+C during reads doesn't lose the scan
  await o.store.put('known.json', state);

  /* ── 2. who to read ───────────────────────────────────────── */
  const owners = new Set<string>([...Object.keys(state.tydro.users), ...Object.keys(state.nado.subs)]);
  const activeSet = new Set(state.nado.active);
  const hasActiveNado = (a: string) => (state.nado.subs[a] ?? [nadoSubaccount(a)]).some((s) => activeSet.has(s)) || activeSet.has(nadoSubaccount(a));
  const stale = o.fullIfOlderThanMs !== undefined && (!state.lastFullAt || Date.now() - Date.parse(state.lastFullAt) > o.fullIfOlderThanMs);
  const startNow = o.full || prevShips.size === 0 || stale || historyJustDone || fullDueAtStart;
  // a full sweep asked for by hand always starts fresh, even over one paused mid-way: only a sweep that reads every
  // wallet in one run (one block) can measure coverage
  const createdNow = startNow && (!state.fullSweep || o.full === true);
  if (createdNow && state.fullSweep) log(`full sweep restarted by hand (the paused one had run ${state.fullSweep.runs} time(s))`);
  if (createdNow) {
    state.fullSweep = { cursor: '', startBlock: head, startedAt: new Date().toISOString(), runs: 0 };
    state.fullDue = false;
  }
  // requested during this run (trade history just finished) and no sweep starting now: a fresh sweep next run,
  // with its whole budget, so it can finish in one run and measure coverage
  if (fullDueNext && !createdNow) state.fullDue = true;
  const sweep = state.fullSweep;
  const full = sweep !== undefined;
  if (sweep) sweep.runs++;
  // a wallet that never touched a Tydro debt token has no debt, so price alone can't wound it
  const neverBorrowedTydro = (a: string) => !(state.tydro.users[a] ?? []).some((i) => i % 2 === 1);
  const mustRead: string[] = [];
  const sweepList: string[] = [];
  let carried = 0;
  for (const a of owners) {
    const prev = prevShips.get(a);
    // quiet = safe to carry between full sweeps; an event that touches it gets it re-read at once:
    //  - EMPTY wallets (they can only fill up through a deposit/transfer event)
    //  - healthy Nado-active wallets (the expensive reads)
    //  - healthy wallets that never borrowed on Tydro (no debt → no liquidation risk from price)
    const quiet =
      prev !== undefined && !touched.has(a) && !prev.watch && prev.primary !== 'DARK' && (prev.primary === 'EMPTY' || hasActiveNado(a) || neverBorrowedTydro(a));
    if (!quiet) mustRead.push(a);
    else if (sweep && a > sweep.cursor) sweepList.push(a);
    else carried++;
  }
  // at risk and touched first, so a budget stop still covers what matters; then the sweep in address order
  mustRead.sort((x, y) => Number(prevShips.get(y)?.watch ?? 0) - Number(prevShips.get(x)?.watch ?? 0) || Number(touched.has(y)) - Number(touched.has(x)));
  sweepList.sort();
  const toRead = [...mustRead, ...sweepList];
  log(
    sweep
      ? `FULL sweep${sweep.runs > 1 ? ` (continuing, run ${sweep.runs})` : ''}: read ${toRead.length} (${mustRead.length} due + ${sweepList.length} sweep), carry ${carried}, touched ${touched.size}`
      : `incremental sweep: read ${toRead.length}, carry ${carried}, touched ${touched.size}`,
  );


  /* ── 3. read at one block, in slices ──────────────────────── */
  const readBlock = BigInt(head);
  let prices = await readTydroPrices(client, readBlock);
  for (let k = 1; !prices.ok && k <= 5; k++) {
    log(`Tydro oracle read failed (${prices.error.message}) — retrying in ${k * 3}s`);
    await new Promise((r) => setTimeout(r, k * 3000));
    prices = await readTydroPrices(client, readBlock);
  }
  if (!prices.ok) {
    // save discovery progress even if we can't read this run
    await o.store.put('known.json', state);
    throw new Error(`Tydro oracle unreadable after retries: ${prices.error.message} (discovery progress saved)`);
  }
  const ships = new Map(prevShips);
  const nextActive = new Set(activeSet);
  let reread = 0;
  let darkNow = 0;
  /** wallets with a subaccount that reports exists=false on-chain but holds balances (counted since v1.2) */
  let unregistered = 0;
  /** why sensors went dark this run — grouped, so one log line explains a systemic failure */
  const darkWhy = new Map<string, number>();
  const noteDark = (sensor: string, msg: string) => {
    const k = `${sensor}: ${msg.replace(/0x[0-9a-f]{8,}/gi, '0x…').replace(/\d{5,}/g, 'N').slice(0, 220)}`;
    darkWhy.set(k, (darkWhy.get(k) ?? 0) + 1);
  };
  const tydroComplete = state.tydro.history.done && state.tydro.scannedTo >= head;
  const nadoComplete = state.nado.history.done && state.nado.accountsScannedTo >= head;
  // coverage is only meaningful when every known wallet is read at one block: a sweep that started this run
  const cov = sweep && sweep.runs === 1 ? new CoverageAcc() : null;
  // Pressure Map: scenario thresholds for every wallet read at this one block (aggregated; nothing per wallet is kept)
  const pacc = cov ? new PressureAcc() : null;
  let pressureMs = 0;
  let budgetStopped = false;
  const SLICE = 1500;
  for (let i = 0; i < toRead.length; i += SLICE) {
    if (Date.now() > deadline) {
      log(`budget hit after ${reread} reads — the rest keep their previous reading`);
      budgetStopped = true;
      break;
    }
    const slice = toRead.slice(i, i + SLICE);
    const tokens = new Map(slice.filter((a) => state.tydro.users[a]).map((a) => [a, new Set(state.tydro.users[a])] as const));
    const subs = new Map(slice.filter((a) => state.nado.subs[a]).map((a) => [a, state.nado.subs[a] as `0x${string}`[]] as const));
    const res = await readBooksMany(client, {
      addresses: slice,
      tydroTokens: tokens,
      nadoSubs: subs,
      blockNumber: readBlock,
      tydroPrices: prices.value,
      // once ALL history is scanned, a wallet never seen on a venue has nothing there: don't spend RPC calls proving it
      tydroOnlyKnown: tydroComplete,
      nadoOnlyKnown: nadoComplete,
    });
    for (const s of res.emptySubs) nextActive.delete(s);
    for (const s of res.activeSubs) nextActive.add(s);
    for (const [a, book] of res.books) {
      cov?.add(book);
      if (book.nado.status === 'OK' && book.nado.data.notes.some((n) => n.includes('exists=false'))) unregistered++;
      if (book.tydro.status === 'DARK') noteDark('TYDRO', book.tydro.message);
      if (book.nado.status === 'DARK') noteDark('NADO', book.nado.message);
      const pose = classify(book);
      if (pacc) {
        const tp = Date.now();
        pacc.add(book, pose, sizeBand(shipSizeUsd(pose)));
        pressureMs += Date.now() - tp;
      }
      const prev = prevShips.get(a);
      if (pose.primary === 'DARK' && prev && prev.primary !== 'DARK') {
        darkNow++; // transient sensor failure: keep the last good reading (its readBlock shows its age)
        continue;
      }
      const extra = (state.nado.subs[a] ?? []).filter((s) => s !== nadoSubaccount(a) && nextActive.has(s));
      ships.set(a, shipFromRead(book, pose, prev, extra));
      reread++;
    }
    const lastIdx = Math.min(i + SLICE, toRead.length) - 1;
    if (sweep && lastIdx >= mustRead.length) sweep.cursor = toRead[lastIdx]!;
    log(`read ${lastIdx + 1}/${toRead.length}`);
  }
  state.nado.active = [...nextActive];
  // a sweep is finished when every wallet in it was attempted; a failed read keeps its last good reading and
  // does NOT make the whole sweep start over
  const sweepDone = sweep !== undefined && !budgetStopped;
  if (sweep && sweepDone) {
    state.lastFullBlock = head;
    state.lastFullAt = new Date().toISOString();
    state.fullSweep = undefined;
    log(`full sweep complete${sweep.runs > 1 ? ` (took ${sweep.runs} runs)` : ''}`);
  } else if (sweep) {
    const left = toRead.length - Math.max(0, toRead.indexOf(sweep.cursor) + 1);
    log(`full sweep paused at ${sweep.cursor ? `${sweep.cursor.slice(0, 10)}…` : 'the start'} (${left} left) — the next run continues from there`);
  }
  const sweptAll = sweepDone && cov !== null;
  if (sweepDone && !cov) log(`coverage not measured: this full sweep spanned ${sweep!.runs} runs (coverage needs every wallet read at one block) — the next single-run sweep measures it`);

  /* ── 3b. coverage: known wallets vs the protocols' own on-chain totals ── */
  if (cov && sweptAll) {
    const nadoSub = (state.nado.active[0] ?? nadoSubaccount('0x0000000000000000000000000000000000000000')) as `0x${string}`;
    const totals = await readProtocolTotals(client, readBlock, { tydroPrices: prices.value, nadoSub });
    if (totals.ok) {
      const full = buildCoverage(cov, totals.value);
      state.coverage = publicCoverage(full);
      // dollar totals and per-asset gaps: job log only (private repo), never the public files
      log(`coverage: ${coverageSummary(full)}${cov.dark ? ` · ${cov.dark} wallets unreadable this sweep` : ''}`);
      for (const g of full.gaps.slice(0, 8)) {
        log(`  gap ${g.venue} ${g.key} ${g.side}: ours $${Math.round(g.oursUsd).toLocaleString('en-US')} of $${Math.round(g.totalUsd).toLocaleString('en-US')} (${coveragePct(g.oursUsd, g.totalUsd)})`);
      }
      // who holds the rest? Protocol accounts (fees / liquidity, zero owner) are not wallets and are never drawn,
      // but measuring them tells a discovery gap apart from positions that sit with the protocol itself
      const protoSubs = [...new Set([...VERTEX_PROTOCOL_SUBS, ...(state.nado.protocolSubs ?? [])])] as `0x${string}`[];
      try {
        const parsed = await readNadoSubsMany(client, protoSubs, readBlock);
        const pAcc = new CoverageAcc();
        let holding = 0;
        for (const r of parsed.values()) {
          if (!r.ok || (!r.value.spots.length && !r.value.perps.length)) continue;
          holding++;
          pAcc.addNado(r.value.spots, r.value.perps);
        }
        const pc = buildCoverage(pAcc, totals.value).totals;
        const both = buildCoverage(mergeAcc(cov, pAcc), totals.value).totals;
        log(
          `  protocol accounts (${protoSubs.length} known, ${holding} holding balances; not drawn): Nado deposits ${coveragePct(pc.nadoDeposits.oursUsd, pc.nadoDeposits.totalUsd)} · OI longs ${coveragePct(pc.nadoOpenInterest.oursLongUsd, pc.nadoOpenInterest.totalUsd)} / shorts ${coveragePct(pc.nadoOpenInterest.oursShortUsd, pc.nadoOpenInterest.totalUsd)}`,
        );
        log(
          `  wallets + protocol accounts: Nado deposits ${coveragePct(both.nadoDeposits.oursUsd, both.nadoDeposits.totalUsd)} · OI longs ${coveragePct(both.nadoOpenInterest.oursLongUsd, both.nadoOpenInterest.totalUsd)} / shorts ${coveragePct(both.nadoOpenInterest.oursShortUsd, both.nadoOpenInterest.totalUsd)}`,
        );
      } catch (e) {
        log(`  protocol accounts not measured: ${String(e).slice(0, 160)}`);
      }
      // the NLP vault (Nado Liquidity Provider): its pools are subaccounts that make markets and take over liquidated
      // positions, so they can hold a large share of open interest. They are listed on-chain (Endpoint.getNlpPools), so
      // measure them directly. Job log only; nothing here is drawn or published. Pools already among the known
      // wallets are counted once.
      const nlpSubs = new Set<string>();
      try {
        const pools = await readNlpPools(client, readBlock);
        if (!pools.ok) throw new Error(pools.error.message);
        for (const p of pools.value) nlpSubs.add(p.subaccount);
        const knownSubs = new Set(Object.values(state.nado.subs).flat().map((x) => x.toLowerCase()));
        // a pool that is also one of Nado's protocol accounts is counted with those, not twice
        const protoSet = new Set([...VERTEX_PROTOCOL_SUBS, ...(state.nado.protocolSubs ?? [])].map((x) => x.toLowerCase()));
        const fresh = pools.value.filter((p) => !knownSubs.has(p.subaccount) && !protoSet.has(p.subaccount.toLowerCase()));
        const parsed = fresh.length ? await readNadoSubsMany(client, fresh.map((p) => p.subaccount), readBlock) : new Map();
        const nAcc = new CoverageAcc();
        let holding = 0;
        let unread = 0;
        for (const r of parsed.values()) {
          if (!r.ok) {
            unread++;
            continue;
          }
          if (!r.value.spots.length && !r.value.perps.length) continue;
          holding++;
          nAcc.addNado(r.value.spots, r.value.perps);
        }
        const nc = buildCoverage(nAcc, totals.value).totals;
        const protoAcc = new CoverageAcc();
        const protoParsed = await readNadoSubsMany(client, [...protoSet] as `0x${string}`[], readBlock);
        for (const r of protoParsed.values()) if (r.ok && (r.value.spots.length || r.value.perps.length)) protoAcc.addNado(r.value.spots, r.value.perps);
        const all = buildCoverage(mergeAcc(mergeAcc(cov, protoAcc), nAcc), totals.value).totals;
        // public: the share of Nado deposits that sits with Nado's own vault and accounts (shares only, no dollars)
        const own = buildCoverage(mergeAcc(protoAcc, nAcc), totals.value).totals.nadoDeposits;
        if (state.coverage) state.coverage.share.nadoDepositsNadoOwn = own.totalUsd > 0 ? Math.round((own.oursUsd / own.totalUsd) * 1000) / 1000 : null;
        log(
          `  NLP pools (${pools.value.length} on-chain, ${pools.value.filter((p) => knownSubs.has(p.subaccount)).length} already among known wallets, ${pools.value.filter((p) => !knownSubs.has(p.subaccount) && protoSet.has(p.subaccount.toLowerCase())).length} already among protocol accounts, ${holding} more holding balances${unread ? `, ${unread} unreadable` : ''}; not drawn): Nado deposits ${coveragePct(nc.nadoDeposits.oursUsd, nc.nadoDeposits.totalUsd)} · OI longs ${coveragePct(nc.nadoOpenInterest.oursLongUsd, nc.nadoOpenInterest.totalUsd)} / shorts ${coveragePct(nc.nadoOpenInterest.oursShortUsd, nc.nadoOpenInterest.totalUsd)}`,
        );
        for (const p of pools.value) log(`    pool ${p.poolId}: owner ${p.owner.slice(0, 10)}… weight ${p.weight.toFixed(2)}${knownSubs.has(p.subaccount) ? ' (already a known wallet)' : protoSet.has(p.subaccount.toLowerCase()) ? ' (already a protocol account)' : ''}`);
        log(
          `  wallets + protocol accounts + NLP pools: Nado deposits ${coveragePct(all.nadoDeposits.oursUsd, all.nadoDeposits.totalUsd)} · OI longs ${coveragePct(all.nadoOpenInterest.oursLongUsd, all.nadoOpenInterest.totalUsd)} / shorts ${coveragePct(all.nadoOpenInterest.oursShortUsd, all.nadoOpenInterest.totalUsd)}`,
        );
      } catch (e) {
        log(`  NLP pools not measured: ${String(e).slice(0, 160)}`);
      }
      // discovery check: every subaccount whose Nado balance changed in the last ~6 hours, from both engines
      // (BalanceUpdate and the Nado-only SpotBalance event). Any the census doesn't know is one discovery missed:
      // read it at the coverage block, say how much of the remaining gap it holds, and add it to the known list
      // (it is a real subaccount, named by the chain), so the hourly runs pick it up from now on.
      try {
        const from = Math.max(NADO_START_BLOCK, head - 21_600);
        const t = await scanNadoTouched(client, from, head, { ...scanOpts, deadline: Date.now() + 4 * 60_000 });
        const known = new Set<string>([
          ...Object.values(state.nado.subs).flat().map((x) => x.toLowerCase()),
          ...[...VERTEX_PROTOCOL_SUBS, ...(state.nado.protocolSubs ?? [])].map((x) => x.toLowerCase()),
          ...nlpSubs,
        ]);
        const unknown = [...t.subs].filter((x) => !known.has(x));
        log(
          `  discovery check (blocks ${from}–${t.scannedTo}${t.complete ? '' : ', stopped early'}): ${t.subs.size} subaccounts changed balance (${t.spotBalanceEvents} SpotBalance events), ${unknown.length} not known before`,
        );
        if (unknown.length) {
          const read = await readNadoSubsMany(client, unknown.slice(0, 300) as `0x${string}`[], readBlock);
          const uAcc = new CoverageAcc();
          for (const r of read.values()) if (r.ok && (r.value.spots.length || r.value.perps.length)) uAcc.addNado(r.value.spots, r.value.perps);
          const uc = buildCoverage(uAcc, totals.value).totals;
          log(
            `  those ${Math.min(unknown.length, 300)} hold: Nado deposits ${coveragePct(uc.nadoDeposits.oursUsd, uc.nadoDeposits.totalUsd)} · OI longs ${coveragePct(uc.nadoOpenInterest.oursLongUsd, uc.nadoOpenInterest.totalUsd)} / shorts ${coveragePct(uc.nadoOpenInterest.oursShortUsd, uc.nadoOpenInterest.totalUsd)}`,
          );
          for (const x of unknown.slice(0, 8)) log(`    missed: ${x.slice(0, 10)}…${x.slice(42)}${isProtocolSub(x) ? ' (zero owner)' : ''}`);
          let added = 0;
          for (const x of unknown) if (!isProtocolSub(x)) (addSub(x), added++);
          if (added) log(`  added ${added} missed subaccounts to discovery — read from the next run on`);
        }
      } catch (e) {
        log(`  discovery check not run: ${String(e).slice(0, 160)}`);
      }
      if (unregistered) log(`  ${unregistered} wallets hold balances in subaccounts that report exists=false on-chain (counted since census v1.2)`);
    } else {
      log(`coverage not measured this sweep: ${totals.error.message}`);
    }
  }

  /* ── 4. publish ───────────────────────────────────────────── */
  const all = [...ships.values()].filter((s) => owners.has(s.address));
  const { counts, mix } = summarize(all, owners.size);
  // census.json carries ships worth drawing; the (many) empty wallets go to known.json as address → read block
  const drawnShips = all.filter((s) => s.primary !== 'EMPTY');
  state.empty = Object.fromEntries(all.filter((s) => s.primary === 'EMPTY').map((s) => [s.address, s.readBlock]));
  const snap: CensusSnapshot = {
    v: CENSUS_VERSION,
    chainId: 57073,
    generatedAt: new Date().toISOString(),
    block: head,
    rulesVersion: RULES.RULES_VERSION,
    discovery: {
      tydroScannedTo: state.tydro.scannedTo,
      nadoScannedTo: state.nado.accountsScannedTo,
      head,
      backfillComplete: state.tydro.scannedTo >= head && state.nado.accountsScannedTo >= head && state.tydro.history.done && state.nado.history.done && !o.sinceBlocks,
    },
    sweep: { kind: full ? 'full' : 'incremental', complete: full ? sweepDone : true, reread, carried, ms: Date.now() - t0 },
    counts,
    mix,
    ...(state.coverage ? { coverage: state.coverage } : {}),
    ships: drawnShips.map(encodeShip),
  };
  if (darkNow) log(`${darkNow} wallets had a sensor fail this run and kept their previous reading`);
  if (darkWhy.size) {
    log(`DARK reasons this run (grouped):`);
    for (const [k, n] of [...darkWhy.entries()].sort((x, y) => y[1] - x[1]).slice(0, 6)) log(`  ${n}× ${k}`);
  }
  await o.store.put('known.json', state);
  let pressureSnap: PressureSnapshot | null = null;
  if (pacc && sweptAll) {
    const ps = pacc.toSnapshot({ block: head, at: new Date().toISOString(), rulesVersion: RULES.RULES_VERSION });
    pressureSnap = ps;
    await o.store.put('pressure.json', ps);
    log(`pressure map: ${ps.population.exposed} wallets with debt or perps simulated (${ps.population.approximate} approximate, ${ps.population.unsupported} unreadable) · ${Object.keys(ps.hist).length} cells (${ps.coarse.length} rounded for privacy) · ${Math.round(pressureMs / 1000)}s`);
  }
  if (!pressureSnap) {
    // why no Pressure Map (and so no forecast) this run — stated every run, so a long gap can't go unnoticed
    const why = !sweep ? 'an hourly run (only a full sweep rebuilds it)' : !sweepDone ? 'the full sweep is paused and continues next run' : 'the full sweep spanned several runs, so it has no single-block reading to simulate';
    const prevPs = await o.store.get('pressure.json').catch(() => null);
    const prevAt = (prevPs as { at?: string } | null)?.at;
    log(`pressure map + forecast: not rebuilt — ${why} · last built ${prevAt ? `${Math.round((Date.now() - Date.parse(prevAt)) / 3_600_000)} h ago (${prevAt.slice(0, 16)}Z)` : 'never'} · last full sweep ${state.lastFullAt ?? 'never'}`);
  }
  const url = await o.store.put('census.json', snap);
  log(`published ${counts.drawn} ships (${counts.known} known, ${counts.empty} empty, ${counts.wounded} wounded) → ${url} in ${Math.round((Date.now() - t0) / 1000)}s`);

  /* ── 5. Flight Recorder (after publishing: a history failure never holds back the scan) ── */
  if (o.history !== false) {
    try {
      let stress: AggPoint['stress'] = null;
      if (pressureSnap) {
        const L = state.coverage?.share.nadoOpenInterestLongs ?? null;
        const S = state.coverage?.share.nadoOpenInterestShorts ?? null;
        const oi = L === null || S === null ? null : Math.min(L, S);
        const r = stressLevel(pressureSnap, { nowMs: Date.now(), oiCoverage: oi });
        stress = { level: r.level, confidence: r.confidence, version: r.version, population: r.inputs.population };
      }
      await recordHistory({
        store: o.store,
        client,
        block: head,
        at: snap.generatedAt,
        startedAt: headAt,
        sweep: snap.sweep.kind,
        complete: snap.sweep.complete !== false,
        ships: all,
        prev: prevShips,
        known: counts.known,
        stress,
        exclude: o.exclude,
        log,
      });
    } catch (e) {
      log(`history: not recorded this run: ${String(e).slice(0, 200)}`);
    }

    /* ── 6. Liquidation Ledger + track record + forecast records (Release 2) ── */
    if (o.ledger !== false) {
      try {
        const left = deadline - Date.now();
        await recordLiquidations({
          store: o.store,
          client,
          head,
          budgetMs: Math.max(0, Math.min(o.ledgerBudgetMs ?? 8 * 60_000, left)),
          exclude: o.exclude,
          log,
          scan: { paceMs: o.scanPaceMs, backoffBaseMs: o.scanBackoffMs },
        });
      } catch (e) {
        log(`ledger: not updated this run: ${String(e).slice(0, 200)}`);
      }
      try {
        await rescoreAccountability(o.store, Date.now(), log);
      } catch (e) {
        log(`accountability: not updated this run: ${String(e).slice(0, 200)}`);
      }
    }

    /* ── 7. Oracle Watch + Protocol Change Monitor + forecast scoring (Release 3) ── */
    if (o.intel !== false) {
      const io = { store: o.store, client, head, pressure: pressureSnap, log, scan: { paceMs: o.scanPaceMs, backoffBaseMs: o.scanBackoffMs } };
      for (const [name, step] of [
        ['oracles', () => recordOracles(io)],
        ['changes', () => recordChanges(io)],
        ['carry', () => (o.carry === false ? Promise.resolve(null) : recordCarry(io))],
      ] as const) {
        try {
          await step();
        } catch (e) {
          log(`${name}: not updated this run: ${String(e).slice(0, 200)}`);
        }
      }
    }
    if (pressureSnap) {
      try {
        const L = state.coverage?.share.nadoOpenInterestLongs ?? null;
        const S = state.coverage?.share.nadoOpenInterestShorts ?? null;
        const oi = L === null || S === null ? null : Math.min(L, S);
        const sr = stressLevel(pressureSnap, { nowMs: Date.now(), oiCoverage: oi });
        const scenarios: ForecastRecord['scenarios'] = [];
        for (const dir of ['CRYPTO', 'ETH', 'BTC', 'USD'])
          for (const pct of [10, 20])
            for (const material of ['0', '1k'] as const) {
              const q = queryPressure(pressureSnap, { dir, sign: 'down', pct, material, dim: '*' });
              scenarios.push({ dir, sign: 'down', pct, material, population: q.population, near: q.nearUnder, liquidatable: q.liquidatableUnder, affected: q.affected });
            }
        const rec: ForecastRecord = { at: snap.generatedAt, block: head, v: { rules: RULES.RULES_VERSION, engine: pressureSnap.engine, stress: sr.version }, coverage: oi, population: pressureSnap.population.exposed, confidence: sr.confidence, scenarios };
        const m = snap.generatedAt.slice(0, 7);
        await o.store.put(forecastPath(m), appendForecast(await o.store.get(forecastPath(m)), m, rec));
        log(`forecast: recorded ${scenarios.length} scenario results at block ${head}`);
      } catch (e) {
        log(`forecast: not recorded this run: ${String(e).slice(0, 200)}`);
      }
    }
    if (o.intel !== false) {
      try {
        await rescoreForecasts(o.store, Date.now(), log);
      } catch (e) {
        log(`forecasts: not scored this run: ${String(e).slice(0, 200)}`);
      }
    }
  }
  return snap;
}
