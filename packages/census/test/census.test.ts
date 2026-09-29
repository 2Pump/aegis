import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetLearnedMaxSpan } from '@aegis/ink-io';
beforeEach(() => resetLearnedMaxSpan());
import { multicallAdaptive, scanTydro } from '@aegis/ink-io';
import { decodeShip, decodeSnapshot, encodeShip, type CensusShip } from '../src/index.js';
import { fileStore, runCensus } from '../src/node/index.js';
import { U, fakeChain } from './fakeChain.js';

const HEAD = 57_200_000;

describe('snapshot codec', () => {
  it('round-trips a ship and keeps primary first', () => {
    const s: CensusShip = {
      address: U.carry,
      primary: 'CARRY',
      tags: ['CARRY', 'WOUNDED', 'KBTC-CORE'],
      hullTemp: 'CRITICAL',
      band: '10–100k',
      watch: true,
      venues: { tydro: false, nado: true },
      readBlock: 123,
      woundedSince: 120,
      wound: { tydro: false, nado: true },
      correlatedLoop: true,
      correlatedNado: false,
      extraSubs: [],
    };
    const back = decodeShip(encodeShip(s));
    expect(back.primary).toBe('CARRY');
    expect(back.tags[0]).toBe('CARRY');
    expect(new Set(back.tags)).toEqual(new Set(s.tags));
    expect(back).toMatchObject({ hullTemp: 'CRITICAL', band: '10–100k', watch: true, readBlock: 123, woundedSince: 120, venues: { nado: true, tydro: false }, wound: { tydro: false, nado: true }, correlatedLoop: true });
  });

  it('reads rows written before wound bits existed as "source unknown", not as a wrong venue', () => {
    const old = decodeShip([U.carry, 0, 1, 0, 0, 1 | 4, 5, 3]);
    expect(old.wound).toEqual({ tydro: false, nado: false });
    expect(old.woundedSince).toBe(3);
  });
});

describe('self-sizing IO', () => {
  it('getLogs shrinks its window when the RPC rejects big ranges, and still finds every log', async () => {
    const { client, stats } = fakeChain({ head: HEAD, maxLogRange: 100_000 });
    const r = await scanTydro(client, 19_954_047, 27_000_000, { initialSpan: 5_000_000, paceMs: 0 });
    expect(r.complete).toBe(true);
    expect(stats.getLogsRejected).toBeGreaterThan(0);
    expect(r.logs).toHaveLength(5);
  });

  it('multicall halves chunks that are too big and returns every result in order', async () => {
    const { client, stats } = fakeChain({ head: HEAD, maxMulticall: 7 });
    const calls = Array.from({ length: 50 }, () => ({ address: '0x2816cf15F6d2A220E789aA011D5EE4eB6c47FEbA' as const, abi: [], functionName: 'getUserAccountData', args: [U.borrower] }));
    const res = await multicallAdaptive(client, calls, { chunk: 40 });
    expect(stats.multicallRejected).toBeGreaterThan(0);
    expect(res.every((r) => r.ok)).toBe(true);
    expect(res).toHaveLength(50);
  });
});

describe('census run (fake Ink)', () => {
  it('discovers every wallet from events, reads them, classifies, and publishes a snapshot without balances', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aegis-census-'));
    const { client, stats } = fakeChain({ head: HEAD, maxLogRange: 3_000_000, maxMulticall: 60 });
    const snap = await runCensus({ scanPaceMs: 0, explorer: false, client, store: fileStore(dir), budgetMs: 60_000 });

    expect(snap.counts.known).toBe(5);
    expect(snap.counts.drawn).toBe(3); // gone + quitter are EMPTY → not drawn
    expect(snap.counts.empty).toBe(2);
    expect(snap.discovery.backfillComplete).toBe(true);
    expect(snap.sweep.kind).toBe('full');

    const ships = new Map(decodeSnapshot(snap).ships.map((s) => [s.address, s]));
    expect(ships.get(U.borrower)).toMatchObject({ primary: 'KBTC-CORE', hullTemp: 'ELEVATED', watch: true, venues: { tydro: true, nado: false } });
    expect(ships.get(U.saver)).toMatchObject({ primary: 'LOCKED', hullTemp: 'NOMINAL', watch: false });
    expect(ships.get(U.saver)!.tags).toContain('STABLE-BALLAST');
    expect(ships.get(U.carry)).toMatchObject({ primary: 'CARRY', hullTemp: 'NOMINAL', venues: { tydro: false, nado: true } });
    expect(ships.has(U.gone)).toBe(false); // empty wallets are not in census.json…
    const known = JSON.parse(readFileSync(join(dir, 'known.json'), 'utf8'));
    expect(Object.keys(known.empty).sort()).toEqual([U.gone, U.quitter].sort()); // …they are remembered in known.json
    expect(snap.mix).toEqual({ 'KBTC-CORE': 1, LOCKED: 1, CARRY: 1 });

    // the health filter kept the heavy Querier call to the one non-empty Nado subaccount
    expect(stats.subaccountInfoCalls).toBe(2); // 1 book read + 1 for the protocol totals (coverage, full sweep only)

    // privacy: the public file carries no dollar figures or HF numbers
    const raw = readFileSync(join(dir, 'census.json'), 'utf8');
    expect(raw).not.toMatch(/usd|"hf"|health|liq|\$|balance/i);
    for (const row of snap.ships) expect(row.length).toBeLessThanOrEqual(9);
  });

  it('second run is incremental: quiet healthy Nado wallets are carried, watch wallets are re-read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aegis-census-'));
    const store = fileStore(dir);
    await runCensus({ scanPaceMs: 0, explorer: false, client: fakeChain({ head: HEAD }).client, store });
    const second = fakeChain({ head: HEAD + 50_000, tradeAt: HEAD - 100 }); // same history, nothing new since run 1
    const snap = await runCensus({ scanPaceMs: 0, explorer: false, client: second.client, store });
    expect(snap.sweep.kind).toBe('incremental');
    expect(snap.sweep.carried).toBe(3); // the quiet CARRY wallet + the 2 empty wallets (nothing touched them)
    expect(second.stats.subaccountInfoCalls).toBe(0);
    const ships = new Map(decodeSnapshot(snap).ships.map((s) => [s.address, s]));
    expect(ships.get(U.borrower)!.readBlock).toBe(HEAD + 50_000 - 2); // watch → fresh
    expect(ships.get(U.carry)!.readBlock).toBe(HEAD - 2); // carried → keeps its older read block
  });

  it('a wallet touched by an event is re-read; untouched empty wallets stay carried', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aegis-census-'));
    const store = fileStore(dir);
    await runCensus({ scanPaceMs: 0, explorer: false, client: fakeChain({ head: HEAD }).client, store });
    // the "quitter" trades again near the new head → its subaccount shows up in the activity scan
    const { client } = fakeChain({ head: HEAD + 1_000, tradeAt: HEAD + 900 });
    const snap = await runCensus({ scanPaceMs: 0, explorer: false, client, store });
    expect(snap.sweep.carried).toBe(2); // the 2 empty wallets; CARRY was touched by the trade → re-read
  });
});

describe('throttled public RPC (the failure seen on the first real run)', () => {
  it('rate limits → waits and keeps the window size instead of shrinking to tiny windows; finishes', async () => {
    const { client, stats } = fakeChain({ head: HEAD, rateLimitEvery: 4 });
    const spans: number[] = [];
    const r = await scanTydro(client, 19_954_047, HEAD, {
      initialSpan: 1_000_000,
      maxSpan: 1_000_000,
      paceMs: 0,
      backoffBaseMs: 1,
      onProgress: (p) => spans.push(p.span),
    });
    expect(r.complete).toBe(true);
    expect(stats.getLogsRejected).toBeGreaterThan(3);
    expect(Math.min(...spans)).toBe(1_000_000); // never shrank
    expect(r.logs).toHaveLength(5);
  });

  it('an RPC that dies mid-scan returns progress (does not throw), and the census publishes what it found', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aegis-census-'));
    const { client } = fakeChain({ head: HEAD, dieAfter: 3 });
    const logs: string[] = [];
    // backoff is real here but capped by maxRetries; keep it fast by patching env-free options through a tiny budget
    const snap = await runCensus({ scanPaceMs: 0, explorer: false, client, store: fileStore(dir), log: (m) => logs.push(m), budgetMs: 60_000, scanBackoffMs: 1 });
    expect(logs.some((l) => l.includes('PAUSED'))).toBe(true);
    expect(snap.discovery.backfillComplete).toBe(false);
    const known = JSON.parse(readFileSync(join(dir, 'known.json'), 'utf8'));
    expect(known.tydro.scannedTo).toBeGreaterThan(19_954_047); // progress kept
  });
});

describe('the 1,000-block cap seen on the first real run', () => {
  it('reads the cap from the RPC error text', async () => {
    const { parseRangeLimit } = await import('@aegis/ink-io');
    const real =
      'code -32602 · Invalid parameters were provided to the RPC method.\nDouble check you have provided the correct parameters. · block range greater than 1000 max · RPC Request failed.';
    expect(parseRangeLimit(real)).toBe(1000);
    expect(parseRangeLimit('query exceeds max block range 10000')).toBe(10000);
    expect(parseRangeLimit('You can make eth_getLogs requests with up to a 2K block range')).toBe(2000);
    expect(parseRangeLimit('Your IP has exceeded its request rate limit.')).toBeNull();
  });

  it('hits the cap once, then never asks for more than it (no half-failed requests)', async () => {
    const { client, stats } = fakeChain({ head: HEAD, maxLogRange: 1000 });
    const limits: number[] = [];
    const r = await scanTydro(client, HEAD - 50_000, HEAD, { paceMs: 0, onLimit: (n) => limits.push(n) });
    expect(r.complete).toBe(true);
    expect(limits).toEqual([1000]);
    expect(stats.getLogsRejected).toBe(1);
    expect(r.errors).toBe(0);
    // a second scan in the same process starts at the learned cap: zero rejections
    const again = fakeChain({ head: HEAD, maxLogRange: 1000 });
    await scanTydro(again.client, HEAD - 20_000, HEAD, { paceMs: 0 });
    expect(again.stats.getLogsRejected).toBe(0);
  });
});

describe('explorer seed (first run)', () => {
  it('seeds Tydro wallets from holder lists with paging, then only scans recent blocks on-chain', async () => {
    const { TYDRO_TOKENS } = await import('@aegis/ink-io');
    const aKbtc = TYDRO_TOKENS[2]!.toLowerCase(); // reserve 1 (kBTC) aToken
    const vUsdc = TYDRO_TOKENS[11]!.toLowerCase(); // reserve 5 (USDC) debt token
    const requested: string[] = [];
    const fakeFetch = async (url: string) => {
      requested.push(url);
      const token = url.split('/tokens/')[1]!.split('/')[0]!.toLowerCase();
      let body: unknown = { items: [], next_page_params: null };
      if (token === aKbtc && !url.includes('?')) body = { items: [{ address: { hash: U.borrower }, value: '100000000' }], next_page_params: { value: '5', address_hash: '0xabc', items_count: 50 } };
      else if (token === aKbtc) body = { items: [{ address: { hash: '0x9000000000000000000000000000000000000009' }, value: '0' }], next_page_params: null };
      else if (token === vUsdc) body = { items: [{ address: { hash: U.borrower }, value: '60000000000' }], next_page_params: null };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const dir = mkdtempSync(join(tmpdir(), 'aegis-census-'));
    const { client, stats } = fakeChain({ head: HEAD });
    const logs: string[] = [];
    const snap = await runCensus({ scanPaceMs: 0, client, store: fileStore(dir), explorer: { fetch: fakeFetch, pageDelayMs: 0 }, log: (m) => logs.push(m) });
    expect(requested.some((u) => u.includes('address_hash=0xabc'))).toBe(true); // followed next_page_params
    expect(logs.some((l) => l.startsWith('tydro seed complete: +1 wallets (1 known)'))).toBe(true); // zero-balance holder skipped
    const known = JSON.parse(readFileSync(join(dir, 'known.json'), 'utf8'));
    expect(known.tydro.users[U.borrower]).toEqual([2, 11]);
    expect(known.tydro.seededFromExplorerAt).toBe(HEAD - 2);
    // Tydro history before the seed was NOT scanned on-chain: only the last ~600 blocks, which hold no Tydro events
    expect(logs.find((l) => l.startsWith('tydro discovery →') && l.includes(' logs'))).toMatch(/· 0 logs/);
    expect(stats.getLogs).toBeGreaterThan(0); // (Nado history is still scanned on-chain)
    expect(decodeSnapshot(snap).ships.find((s) => s.address === U.borrower)?.primary).toBe('KBTC-CORE');
  });
});

describe('the all-DARK first real run', () => {
  it('calls that fail inside a big batch (out of gas) are retried smaller — nobody goes DARK', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aegis-census-'));
    const { client } = fakeChain({ head: HEAD, gasCalls: 3 });
    const logs: string[] = [];
    const snap = await runCensus({ scanPaceMs: 0, explorer: false, client, store: fileStore(dir), log: (m) => logs.push(m) });
    expect(snap.counts.dark).toBe(0);
    expect(logs.some((l) => l.includes('DARK reasons'))).toBe(false);
    expect(snap.mix).toEqual({ 'KBTC-CORE': 1, LOCKED: 1, CARRY: 1 });
  });

  it('when reads really fail, the log says why, grouped', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aegis-census-'));
    const { client } = fakeChain({ head: HEAD, gasCalls: 0 }); // every call fails, even alone
    const logs: string[] = [];
    await runCensus({ scanPaceMs: 0, explorer: false, client, store: fileStore(dir), log: (m) => logs.push(m) });
    const i = logs.findIndex((l) => l.includes('DARK reasons'));
    expect(i).toBeGreaterThan(-1);
    expect(logs[i + 1]).toMatch(/^\s+\d+× (TYDRO|NADO): /);
  });
});

describe('incomplete token list (the STABLE-BALLAST → LOCKED flips on the live tape)', () => {
  it('Pool totals expose a missed token; the wallet is re-read with all tokens before publishing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aegis-census-'));
    const { client } = fakeChain({ head: HEAD, saverOldWeth: true });
    // like `--since-blocks`: the saver's old WETH deposit is outside the scanned window
    const snap = await runCensus({ scanPaceMs: 0, explorer: false, client, store: fileStore(dir), sinceBlocks: HEAD - 24_000_000 });
    const saver = decodeSnapshot(snap).ships.find((s) => s.address === U.saver)!;
    expect(saver.primary).toBe('LOCKED');
    expect(saver.tags).not.toContain('STABLE-BALLAST'); // $1k stables of $5k margin = 20% < 50%
    expect(saver.band).toBe('1–10k'); // $5k, not $1k
  });
});

describe('coverage vs protocol totals', () => {
  it('a full sweep compares known wallets with on-chain totals; the public file gets shares only, the log gets the gaps', async () => {
    const { client } = fakeChain({ head: HEAD });
    const lines: string[] = [];
    const dir = mkdtempSync(join(tmpdir(), 'aegis-cov-'));
    const snap = await runCensus({ scanPaceMs: 0, explorer: false, client, store: fileStore(dir), log: (m) => lines.push(m) });
    const c = snap.coverage!;
    expect(c.block).toBe(snap.block);
    // Tydro: $100k of $125k kBTC + all $1k USDG supplied → 101/126; all $60k USDC debt
    expect(c.share.tydroSupply).toBeCloseTo(101 / 126, 3);
    expect(c.share.tydroDebt).toBe(1);
    // Nado: 0.1 of 0.2 KBTC deposits; OI 0.1 BTC — we see the 0.1 short, no longs
    expect(c.share.nadoDeposits).toBe(0.5);
    expect(c.share.nadoOpenInterestShorts).toBe(1);
    expect(c.share.nadoOpenInterestLongs).toBe(0);
    // the gaps (in dollars) are in the job log only
    expect(lines.find((l) => l.startsWith('coverage: '))).toMatch(/Tydro supply 80\.2%.*Nado deposits 50\.0%/);
    expect(lines.some((l) => /gap tydro kBTC supply: ours \$100,000 of \$125,000/.test(l))).toBe(true);
    const raw = readFileSync(join(dir, 'census.json'), 'utf8') + readFileSync(join(dir, 'known.json'), 'utf8');
    expect(raw).not.toMatch(/usd|\$|gap/i);
  });

  it('an incremental run republishes the last full sweep\'s coverage instead of a partial one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aegis-cov2-'));
    const first = await runCensus({ scanPaceMs: 0, explorer: false, client: fakeChain({ head: HEAD }).client, store: fileStore(dir) });
    const second = await runCensus({ scanPaceMs: 0, explorer: false, client: fakeChain({ head: HEAD + 50 }).client, store: fileStore(dir) });
    expect(second.sweep.kind).toBe('incremental');
    expect(second.coverage).toEqual(first.coverage);
  });
});

describe('history backfill (the 10% coverage found on 2026-09-28)', () => {
  it('a --since-blocks run records the history it skipped; the next normal run backfills it and then sweeps everyone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aegis-hist-'));
    // quick run: only the last ~100k blocks → finds only the recent Nado trade, none of the older wallets
    const quick = await runCensus({ scanPaceMs: 0, explorer: false, client: fakeChain({ head: HEAD }).client, store: fileStore(dir), sinceBlocks: 100_000 });
    expect(quick.discovery.backfillComplete).toBe(false);
    expect(decodeSnapshot(quick).ships.find((s) => s.address === U.borrower)).toBeUndefined();

    const logs: string[] = [];
    const snap = await runCensus({ scanPaceMs: 0, explorer: false, client: fakeChain({ head: HEAD + 100 }).client, store: fileStore(dir), log: (m) => logs.push(m) });
    expect(logs.some((l) => /^tydro history → .* — COMPLETE/.test(l))).toBe(true);
    expect(logs.some((l) => /^nado history → .* — COMPLETE/.test(l))).toBe(true);
    expect(snap.discovery.backfillComplete).toBe(true);
    expect(snap.sweep.kind).toBe('full'); // finishing history triggers a full sweep + coverage
    expect(snap.coverage).toBeDefined();
    const ships = decodeSnapshot(snap).ships;
    expect(ships.find((s) => s.address === U.borrower)?.primary).toBe('KBTC-CORE'); // 2025 wallet found
    expect(ships.find((s) => s.address === U.saver)?.primary).toBe('LOCKED');
  });

  it('a state from before this bookkeeping (no history fields) is re-checked once, not trusted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aegis-legacy-'));
    const store = fileStore(dir);
    // what the uploaded local census looked like: cursors at head, only recent wallets
    await store.put('known.json', {
      v: 1,
      tydro: { scannedTo: HEAD - 2, users: {} },
      nado: { accountsScannedTo: HEAD - 2, activityScannedTo: HEAD - 2, subs: {}, active: [] },
      lastFullBlock: 0,
      lastFullAt: null,
    });
    const logs: string[] = [];
    const snap = await runCensus({ scanPaceMs: 0, explorer: false, client: fakeChain({ head: HEAD }).client, store, log: (m) => logs.push(m) });
    expect(logs.some((l) => l.includes('cannot prove it covered all history'))).toBe(true);
    expect(snap.counts.known).toBe(5); // every fake wallet, found by the backfill
    expect(snap.discovery.backfillComplete).toBe(true);
  });

  it('the explorer seed resumes where it stopped, and falls back to the chain after 3 runs without progress', async () => {
    const { TYDRO_TOKENS } = await import('@aegis/ink-io');
    const broken = TYDRO_TOKENS[5]!.toLowerCase();
    const requested: string[] = [];
    const fakeFetch = async (url: string) => {
      requested.push(url);
      const token = url.split('/tokens/')[1]!.split('/')[0]!.toLowerCase();
      if (token === broken) return new Response('boom', { status: 500 });
      return new Response(JSON.stringify({ items: [], next_page_params: null }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const dir = mkdtempSync(join(tmpdir(), 'aegis-seed-'));
    const run = async (logs: string[]) =>
      runCensus({ scanPaceMs: 0, client: fakeChain({ head: HEAD }).client, store: fileStore(dir), explorer: { fetch: fakeFetch, pageDelayMs: 0, backoffBaseMs: 1 }, log: (m) => logs.push(m) });
    const l1: string[] = [];
    await run(l1);
    expect(l1.some((l) => l.includes('27 token lists done this run, 1 left'))).toBe(true);
    requested.length = 0;
    const l2: string[] = [];
    await run(l2);
    expect(new Set(requested.map((u) => u.split('/tokens/')[1]!.split('/')[0]!.toLowerCase()))).toEqual(new Set([broken])); // only the unfinished list
    const l3: string[] = [], l4: string[] = [], l5: string[] = [];
    await run(l3);
    await run(l4);
    expect(l4.some((l) => l.includes('switching to an on-chain history scan'))).toBe(true);
    const snap = await run(l5);
    expect(l4.some((l) => /^tydro history → .* — COMPLETE/.test(l))).toBe(true); // same run: the chain scan picks up at once
    expect(decodeSnapshot(snap).ships.find((s) => s.address === U.borrower)?.primary).toBe('KBTC-CORE');
  }, 60_000);
});

describe('explorer 404 (seen live: token 28/28 "Not found" on every page-1 request)', () => {
  it('a token the explorer 404s is confirmed on-chain: totalSupply 0 → done; totalSupply > 0 → retried next run', async () => {
    const { TYDRO_TOKENS } = await import('@aegis/ink-io');
    const empty = TYDRO_TOKENS[27]!.toLowerCase(); // fake chain: totalSupply 0
    const aKbtc = TYDRO_TOKENS[2]!.toLowerCase(); // fake chain: totalSupply > 0
    const make = (notFound: string[]) => async (url: string) => {
      const token = url.split('/tokens/')[1]!.split('/')[0]!.toLowerCase();
      if (notFound.includes(token)) return new Response('{"message":"Not found"}', { status: 404, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ items: [], next_page_params: null }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const run = async (dir: string, nf: string[]) => {
      const logs: string[] = [];
      await runCensus({ scanPaceMs: 0, client: fakeChain({ head: HEAD }).client, store: fileStore(dir), explorer: { fetch: make(nf), pageDelayMs: 0, backoffBaseMs: 1 }, log: (m) => logs.push(m) });
      return logs;
    };
    const a = await run(mkdtempSync(join(tmpdir(), 'aegis-404a-')), [empty]);
    expect(a.some((l) => l.includes('token 28/28 — explorer has no holder list, and on-chain totalSupply is 0'))).toBe(true);
    expect(a.some((l) => l.startsWith('tydro seed complete'))).toBe(true);
    expect(a.some((l) => /VENUE_TIMEOUT on token 28/.test(l))).toBe(false); // no pointless retries

    const b = await run(mkdtempSync(join(tmpdir(), 'aegis-404b-')), [aKbtc]);
    expect(b.some((l) => l.includes('token 3/28 — explorer has no holder list but totalSupply is'))).toBe(true);
    expect(b.some((l) => l.includes('27 token lists done this run, 1 left'))).toBe(true);
  });
});

describe('reads after history is complete (the 41-minute full sweep of 55,070 wallets)', () => {
  it('wallets never seen on a venue are not read there; their sensor says why', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aegis-skip-'));
    const store = fileStore(dir);
    await runCensus({ scanPaceMs: 0, explorer: false, client: fakeChain({ head: HEAD }).client, store });
    const second = fakeChain({ head: HEAD + 10 });
    const snap = await runCensus({ scanPaceMs: 0, explorer: false, client: second.client, store, full: true });
    expect(snap.discovery.backfillComplete).toBe(true);
    // the Tydro-only borrower is still read on Tydro and classified the same
    expect(decodeSnapshot(snap).ships.find((s) => s.address === U.borrower)?.primary).toBe('KBTC-CORE');
    // …but no Nado health calls were spent on the Tydro-only wallets (borrower, saver, gone) — only on Nado accounts
    const { readBooksMany } = await import('@aegis/ink-io');
    const probe = fakeChain({ head: HEAD + 10 });
    const r = await readBooksMany(probe.client, {
      addresses: [U.borrower],
      tydroTokens: new Map([[U.borrower, new Set([2, 11])]]),
      nadoSubs: new Map(),
      nadoOnlyKnown: true,
      tydroOnlyKnown: true,
    });
    const b = r.books.get(U.borrower)!;
    expect(b.nado.status).toBe('OK');
    expect(b.nado.status === 'OK' && b.nado.data.notes[0]).toMatch(/never deposited to Nado/);
    const q = await readBooksMany(probe.client, { addresses: [U.carry], nadoSubs: new Map([[U.carry, []]]), tydroTokens: new Map(), tydroOnlyKnown: true, nadoOnlyKnown: false });
    const c = q.books.get(U.carry)!;
    expect(c.tydro.status === 'OK' && c.tydro.data.notes[0]).toMatch(/never held a Tydro token/);
  });

  it('a full sweep that runs out of time is retried by the next run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aegis-fulldue-'));
    const store = fileStore(dir);
    await runCensus({ scanPaceMs: 0, explorer: false, client: fakeChain({ head: HEAD }).client, store });
    const logs: string[] = [];
    await runCensus({ scanPaceMs: 0, explorer: false, client: fakeChain({ head: HEAD + 5 }).client, store, full: true, budgetMs: 0, log: (m) => logs.push(m) });
    expect(logs.some((l) => l.includes('the next run tries the full sweep again'))).toBe(true);
    const next = await runCensus({ scanPaceMs: 0, explorer: false, client: fakeChain({ head: HEAD + 9 }).client, store });
    expect(next.sweep.kind).toBe('full');
    expect(next.coverage).toBeDefined();
  });
});
