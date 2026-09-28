import {
  NADO_START_BLOCK,
  TYDRO_START_BLOCK,
  decodeNadoSubaccounts,
  decodeTydroTransfers,
  nadoSubaccount,
  readBooksMany,
  readTydroPrices,
  scanNadoAccounts,
  scanNadoActivity,
  scanTydro,
  seedTydroHolders,
  subaccountOwner,
  type FetchLike,
} from '@aegis/ink-io';
import { RULES, classify } from '@aegis/pose';
import type { PublicClient } from 'viem';
import {
  CENSUS_VERSION,
  decodeSnapshot,
  encodeShip,
  shipFromRead,
  summarize,
  type CensusShip,
  type CensusSnapshot,
} from '../index.js';
import type { CensusStore } from './store.js';

/** Job state (known.json). Addresses only — public chain facts, no balances. */
export interface CensusState {
  v: 1;
  tydro: { scannedTo: number; users: Record<string, number[]>; seededFromExplorerAt?: number };
  nado: { accountsScannedTo: number; activityScannedTo: number; subs: Record<string, string[]>; active: string[] };
  lastFullBlock: number;
  lastFullAt: string | null;
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
  /** one-time Tydro seed from the explorer's holder lists (false = always scan the chain) */
  explorer?: false | { fetch?: FetchLike; base?: string; pageDelayMs?: number };
  log?: (msg: string) => void;
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
  let prevShips = new Map<string, CensusShip>();
  const prevRaw = await o.store.get('census.json');
  if (prevRaw) {
    try {
      prevShips = new Map(decodeSnapshot(prevRaw).ships.map((s) => [s.address, s]));
    } catch (e) {
      log(`previous census unreadable, starting clean: ${String(e)}`);
    }
  }

  const head = Number(await client.getBlockNumber()) - (o.confirmations ?? 2);
  const floor = o.sinceBlocks ? Math.max(0, head - o.sinceBlocks) : 0;
  log(`head ${head} · store ${o.store.describe} · known tydro ${Object.keys(state.tydro.users).length} · known nado owners ${Object.keys(state.nado.subs).length}`);

  /* ── 1. discovery ─────────────────────────────────────────── */
  const touched = new Set<string>();

  // Tydro, first run: seed from the explorer's holder lists (addresses only; every read below is on-chain)
  if (state.tydro.scannedTo === 0 && !o.sinceBlocks && o.explorer !== false) {
    log('tydro: one-time seed from the Ink explorer holder lists (addresses only — every balance is still read on-chain)…');
    const ex = o.explorer || {};
    const seed = await seedTydroHolders({
      fetch: ex.fetch,
      base: ex.base,
      pageDelayMs: ex.pageDelayMs,
      deadline,
      onRetry: (m) => log(`tydro seed: ${m}`),
      onToken: (ti, holders, pages) => holders && log(`tydro seed: token ${ti + 1}/28 · ${holders} holders · ${pages} pages`),
    });
    if (seed.failedTokens.length === 0) {
      for (const [addr, idxs] of seed.users) state.tydro.users[addr] = [...idxs].sort((a, b) => a - b);
      // the explorer indexes a little behind the chain: re-scan the last ~10 minutes of blocks on-chain
      state.tydro.scannedTo = head - 600;
      state.tydro.seededFromExplorerAt = head;
      log(`tydro seed complete: ${seed.users.size} wallets from ${seed.pages} pages`);
    } else {
      log(`tydro seed incomplete (${seed.failedTokens.length} token lists failed) — falling back to a full chain scan`);
    }
    await o.store.put('known.json', state);
  }

  // Tydro: every aToken/vToken Transfer since launch (or since the seed), resumable
  const tFrom = Math.max(state.tydro.scannedTo + 1, TYDRO_START_BLOCK, floor);
  if (tFrom <= head) {
    const r = await scanTydro(client, tFrom, head, {
      deadline,
      onProgress: progress(log, 'tydro discovery', tFrom, head),
      onRetry: retryLog(log, 'tydro discovery'),
      onLimit: (n) => log(`RPC allows ${n} blocks per history request — using exactly that from now on`),
      backoffBaseMs: o.scanBackoffMs,
      paceMs: o.scanPaceMs,
    });
    for (const [addr, idxs] of decodeTydroTransfers(r.logs)) {
      const cur = new Set(state.tydro.users[addr] ?? []);
      idxs.forEach((i) => cur.add(i));
      state.tydro.users[addr] = [...cur].sort((a, b) => a - b);
      if (state.tydro.scannedTo > 0) touched.add(addr);
    }
    state.tydro.scannedTo = r.scannedTo;
    await o.store.put('known.json', state);
    log(`tydro discovery → ${r.scannedTo}${r.complete ? '' : ` — PAUSED (${r.stoppedBecause}); progress saved, resumes next run`} · ${r.logs.length} logs · ${r.errors} retries`);
  }

  const addSub = (sub: string) => {
    const owner = subaccountOwner(sub);
    const list = state.nado.subs[owner] ?? [];
    if (!list.includes(sub)) list.push(sub);
    state.nado.subs[owner] = list;
    return owner;
  };

  // Nado accounts: deposits/withdrawals + liquidations since launch (low volume, resumable)
  const nFrom = Math.max(state.nado.accountsScannedTo + 1, NADO_START_BLOCK, floor);
  if (nFrom <= head && Date.now() < deadline) {
    const r = await scanNadoAccounts(client, nFrom, head, {
      deadline,
      onProgress: progress(log, 'nado account discovery', nFrom, head),
      onRetry: retryLog(log, 'nado account discovery'),
      onLimit: (n) => log(`RPC allows ${n} blocks per history request — using exactly that from now on`),
      backoffBaseMs: o.scanBackoffMs,
      paceMs: o.scanPaceMs,
    });
    for (const sub of decodeNadoSubaccounts(r.logs)) {
      const owner = addSub(sub);
      if (state.nado.accountsScannedTo > 0) touched.add(owner);
    }
    state.nado.accountsScannedTo = r.scannedTo;
    await o.store.put('known.json', state);
    log(`nado account discovery → ${r.scannedTo}${r.complete ? '' : ` — PAUSED (${r.stoppedBecause}); progress saved, resumes next run`} · ${r.logs.length} logs`);
  }

  // Nado activity (every trade) — only the window since the last run, max ~6 h of blocks
  const aFrom = Math.max(state.nado.activityScannedTo + 1, head - 21_600, NADO_START_BLOCK, floor);
  if (aFrom <= head && Date.now() < deadline) {
    const r = await scanNadoActivity(client, aFrom, head, { deadline, initialSpan: 2_000, onRetry: retryLog(log, 'nado activity'), backoffBaseMs: o.scanBackoffMs, paceMs: o.scanPaceMs });
    if (!r.complete) log(`nado activity paused at ${r.scannedTo}: ${r.stoppedBecause}`);
    const subs = decodeNadoSubaccounts(r.logs);
    for (const sub of subs) touched.add(addSub(sub));
    state.nado.activityScannedTo = r.scannedTo;
    log(`nado activity ${aFrom}→${r.scannedTo} · ${r.logs.length} logs · ${subs.size} subaccounts touched`);
  }

  // save discovery progress now, so a crash or Ctrl+C during reads doesn't lose the scan
  await o.store.put('known.json', state);

  /* ── 2. who to read ───────────────────────────────────────── */
  const owners = new Set<string>([...Object.keys(state.tydro.users), ...Object.keys(state.nado.subs)]);
  const activeSet = new Set(state.nado.active);
  const hasActiveNado = (a: string) => (state.nado.subs[a] ?? [nadoSubaccount(a)]).some((s) => activeSet.has(s)) || activeSet.has(nadoSubaccount(a));
  const stale = o.fullIfOlderThanMs !== undefined && (!state.lastFullAt || Date.now() - Date.parse(state.lastFullAt) > o.fullIfOlderThanMs);
  const full = o.full || prevShips.size === 0 || stale;
  const toRead: string[] = [];
  let carried = 0;
  for (const a of owners) {
    const prev = prevShips.get(a);
    // quiet, healthy Nado-active wallets are the only expensive ones; carry them between full sweeps
    const skip = !full && prev && hasActiveNado(a) && !touched.has(a) && !prev.watch;
    if (skip) carried++;
    else toRead.push(a);
  }
  // most important first, so a budget stop still covers what matters
  toRead.sort((x, y) => Number(prevShips.get(y)?.watch ?? 0) - Number(prevShips.get(x)?.watch ?? 0) || Number(touched.has(y)) - Number(touched.has(x)));
  log(`${full ? 'FULL' : 'incremental'} sweep: read ${toRead.length}, carry ${carried}, touched ${touched.size}`);

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
  /** why sensors went dark this run — grouped, so one log line explains a systemic failure */
  const darkWhy = new Map<string, number>();
  const noteDark = (sensor: string, msg: string) => {
    const k = `${sensor}: ${msg.replace(/0x[0-9a-f]{8,}/gi, '0x…').replace(/\d{5,}/g, 'N').slice(0, 220)}`;
    darkWhy.set(k, (darkWhy.get(k) ?? 0) + 1);
  };
  const SLICE = 1500;
  for (let i = 0; i < toRead.length; i += SLICE) {
    if (Date.now() > deadline) {
      log(`budget hit after ${reread} reads — the rest keep their previous reading`);
      break;
    }
    const slice = toRead.slice(i, i + SLICE);
    const tokens = new Map(slice.map((a) => [a, new Set(state.tydro.users[a] ?? [])] as const));
    const subs = new Map(slice.map((a) => [a, (state.nado.subs[a] ?? []) as `0x${string}`[]] as const));
    const res = await readBooksMany(client, {
      addresses: slice,
      tydroTokens: tokens,
      nadoSubs: subs,
      blockNumber: readBlock,
      tydroPrices: prices.value,
    });
    for (const s of res.emptySubs) nextActive.delete(s);
    for (const s of res.activeSubs) nextActive.add(s);
    for (const [a, book] of res.books) {
      if (book.tydro.status === 'DARK') noteDark('TYDRO', book.tydro.message);
      if (book.nado.status === 'DARK') noteDark('NADO', book.nado.message);
      const pose = classify(book);
      const prev = prevShips.get(a);
      if (pose.primary === 'DARK' && prev && prev.primary !== 'DARK') {
        darkNow++; // transient sensor failure: keep the last good reading (its readBlock shows its age)
        continue;
      }
      const extra = (state.nado.subs[a] ?? []).filter((s) => s !== nadoSubaccount(a) && nextActive.has(s));
      ships.set(a, shipFromRead(book, pose, prev, extra));
      reread++;
    }
    log(`read ${Math.min(i + SLICE, toRead.length)}/${toRead.length}`);
  }
  state.nado.active = [...nextActive];
  if (full && reread === toRead.length) {
    state.lastFullBlock = head;
    state.lastFullAt = new Date().toISOString();
  }

  /* ── 4. publish ───────────────────────────────────────────── */
  const all = [...ships.values()].filter((s) => owners.has(s.address));
  const { counts, mix } = summarize(all, owners.size);
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
      backfillComplete: state.tydro.scannedTo >= head && state.nado.accountsScannedTo >= head && !o.sinceBlocks,
    },
    sweep: { kind: full ? 'full' : 'incremental', reread, carried, ms: Date.now() - t0 },
    counts,
    mix,
    ships: all.map(encodeShip),
  };
  if (darkNow) log(`${darkNow} wallets had a sensor fail this run and kept their previous reading`);
  if (darkWhy.size) {
    log(`DARK reasons this run (grouped):`);
    for (const [k, n] of [...darkWhy.entries()].sort((x, y) => y[1] - x[1]).slice(0, 6)) log(`  ${n}× ${k}`);
  }
  await o.store.put('known.json', state);
  const url = await o.store.put('census.json', snap);
  log(`published ${counts.drawn} ships (${counts.known} known, ${counts.empty} empty, ${counts.wounded} wounded) → ${url} in ${Math.round((Date.now() - t0) / 1000)}s`);
  return snap;
}
