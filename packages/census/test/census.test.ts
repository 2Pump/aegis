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
      extraSubs: [],
    };
    const back = decodeShip(encodeShip(s));
    expect(back.primary).toBe('CARRY');
    expect(back.tags[0]).toBe('CARRY');
    expect(new Set(back.tags)).toEqual(new Set(s.tags));
    expect(back).toMatchObject({ hullTemp: 'CRITICAL', band: '10–100k', watch: true, readBlock: 123, woundedSince: 120, venues: { nado: true, tydro: false } });
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
    expect(ships.get(U.gone)!.primary).toBe('EMPTY');
    expect(snap.mix).toEqual({ 'KBTC-CORE': 1, LOCKED: 1, CARRY: 1 });

    // the health filter kept the heavy Querier call to the one non-empty Nado subaccount
    expect(stats.subaccountInfoCalls).toBe(1);

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
    expect(snap.sweep.carried).toBe(1); // the CARRY wallet
    expect(second.stats.subaccountInfoCalls).toBe(0);
    const ships = new Map(decodeSnapshot(snap).ships.map((s) => [s.address, s]));
    expect(ships.get(U.borrower)!.readBlock).toBe(HEAD + 50_000 - 2); // watch → fresh
    expect(ships.get(U.carry)!.readBlock).toBe(HEAD - 2); // carried → keeps its older read block
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
    expect(logs.some((l) => l.startsWith('tydro seed complete: 1 wallets'))).toBe(true); // zero-balance holder skipped
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
