import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, type Log, type PublicClient } from 'viem';
import { LIQ_TOPIC, NADO_CONTRACTS, TYDRO, TYDRO_RESERVES, decodeLiquidations } from '@aegis/ink-io';
import { TAGS } from '@aegis/pose';
import {
  INDEX_PATH,
  LEDGER,
  appendLedger,
  appendWalletRows,
  appendWarnings,
  cascades,
  emptyIndex,
  ledgerPath,
  ledgerSummary,
  priorState,
  readWarnings,
  scoreAccountability,
  shardOf,
  warningKind,
  walletPath,
  type CensusShip,
  type HistoryIndex,
  type LedgerFile,
  type LedgerRecord,
  type WalletState,
  type Warning,
} from '../src/index.js';
import { fileStore, recordLiquidations } from '../src/node/index.js';

const pad = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, '0')}` as `0x${string}`;
const WETH = TYDRO_RESERVES.find((r) => r.symbol === 'WETH')!;
const USDC = TYDRO_RESERVES.find((r) => r.symbol === 'USDC')!;
const U1 = '0x1111111111111111111111111111111111111111';
const U2 = '0x2222222222222222222222222222222222222222';
const FIX = '0x0000000000000000000000000000000000ae6001';

function tydroLog(user: string, block: number, logIndex = 0, debt = 1_000_000_000n /* 1,000 USDC */, coll = 520_000_000_000_000_000n /* 0.52 WETH */): Log {
  return {
    address: TYDRO.POOL,
    topics: [LIQ_TOPIC.tydro, pad(WETH.underlying), pad(USDC.underlying), pad(user)],
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'address' }, { type: 'bool' }], [debt, coll, '0x9999999999999999999999999999999999999999', false]),
    blockNumber: `0x${block.toString(16)}` as never,
    logIndex: `0x${logIndex.toString(16)}` as never,
    transactionHash: `0x${'ab'.repeat(31)}${block.toString(16).padStart(2, '0').slice(-2)}` as never,
  } as unknown as Log;
}
function nadoLog(owner: string, block: number, logIndex = 1, product = 2, amount = -5n * 10n ** 16n, quote = 5_000n * 10n ** 18n): Log {
  const sub = `${owner}${'64656661756c740000000000'}`;
  return {
    address: NADO_CONTRACTS.clearinghouse,
    topics: [LIQ_TOPIC.nado, pad('0x00'), sub as `0x${string}`],
    data: encodeAbiParameters([{ type: 'uint32' }, { type: 'bool' }, { type: 'int128' }, { type: 'int128' }], [product, false, amount, quote]),
    blockNumber: `0x${block.toString(16)}` as never,
    logIndex: `0x${logIndex.toString(16)}` as never,
    transactionHash: `0x${'cd'.repeat(31)}${block.toString(16).padStart(2, '0').slice(-2)}` as never,
  } as unknown as Log;
}

describe('liquidation events · decoding', () => {
  it('Tydro LiquidationCall: user, assets, raw amounts; Nado Liquidation: owner, product, signed amounts', () => {
    const { liquidations, skipped } = decodeLiquidations([tydroLog(U1, 100), nadoLog(U2, 101)]);
    expect(skipped).toBe(0);
    const t = liquidations.find((x) => x.venue === 'tydro')!;
    expect(t).toMatchObject({ user: U1, collateral: { symbol: 'WETH', family: 'ETH' }, debt: { symbol: 'USDC', amount: '1000000000' } });
    const n = liquidations.find((x) => x.venue === 'nado')!;
    expect(n).toMatchObject({ user: U2, productId: 2, symbol: 'BTC-PERP', amountX18: (-5n * 10n ** 16n).toString() });
  });
  it('a log from another contract, or with the wrong shape, is never half-read', () => {
    const wrong = { ...tydroLog(U1, 100), address: '0x0000000000000000000000000000000000000001' } as Log;
    const short = { ...tydroLog(U1, 100), data: '0x1234' } as Log;
    const r = decodeLiquidations([wrong, short]);
    expect(r.liquidations).toHaveLength(0);
    expect(r.skipped).toBe(1);
  });
});

const st = (block: number, at: number, hullTemp: WalletState['hullTemp'], primary: WalletState['primary'] = 'CARRY', rulesVersion = 'v1.2.0'): WalletState => ({
  kind: 'T',
  block,
  at,
  rulesVersion,
  primary,
  tags: primary ? [primary] : [],
  hullTemp,
  band: '1–10k',
  venues: { tydro: true, nado: false },
  wound: { tydro: false, nado: false },
});
const H = 3_600_000;

describe('what Phrourax knew before a liquidation', () => {
  it('before recording began → not evaluable (excluded from every rate)', () => {
    expect(priorState([], 50, { block: 100 }).evaluable).toBe(false);
  });
  it('no recorded position → evaluable, "not seen", no warning', () => {
    const p = priorState([], 500, { block: 100 });
    expect(p).toMatchObject({ evaluable: true, before: null, nearSince: null });
  });
  it('NEAR streak → lead time from the start of the streak; only rows before the liquidation block count', () => {
    const tl = [st(100, 0, 'NOMINAL'), st(200, 1 * H, 'ELEVATED'), st(300, 2 * H, 'CRITICAL'), st(400, 5 * H, 'CRITICAL'), st(600, 9 * H, 'NOMINAL')];
    const p = priorState(tl, 500, { block: 50 });
    expect(p.before?.hullTemp).toBe('CRITICAL');
    expect(p.nearSince).toBe(2 * H);
    expect(p.watchSince).toBe(1 * H);
    expect(p.leadIsMinimum).toBe(false);
  });
  it('WATCH only, and a streak reaching the first row is a minimum lead', () => {
    const p = priorState([st(100, 0, 'ELEVATED'), st(200, H, 'ELEVATED')], 300, { block: 50 });
    expect(p.nearSince).toBeNull();
    expect(p.watchSince).toBe(0);
    expect(p.leadIsMinimum).toBe(true);
  });
});

const rec = (id: string, at: number, over: Partial<LedgerRecord> = {}): LedgerRecord => ({
  id,
  venue: 'tydro',
  tx: `0x${id}`,
  block: 1000 + at / 1000,
  at,
  wallet: U1,
  subaccountKind: null,
  collateral: 'WETH',
  debt: 'USDC',
  product: null,
  family: 'ETH',
  isEncodedSpread: null,
  sizeBand: '1–10k',
  sizeBasis: 'x',
  impliedBonusPct: 5,
  aegis: { evaluable: true, why: '', before: { hullTemp: 'CRITICAL', primary: 'CARRY', rulesVersion: 'v1.2.0', block: 1, at: at - 3 * H }, nearSince: at - 3 * H, watchSince: at - 5 * H, leadIsMinimum: false },
  completeness: 'COMPLETE',
  unavailable: [],
  source: 's',
  v: { ledger: LEDGER.VERSION, reader: 'r', rules: 'v1.2.0' },
  ...over,
});

describe('ledger file', () => {
  it('a liquidation is recorded once (tx + log index), whatever order backfill and live runs arrive in', () => {
    let f = appendLedger(null, '2026-10', [rec('b', 2000), rec('a', 1000)]);
    f = appendLedger(f, '2026-10', [rec('a', 1000)]);
    expect(f.records.map((r) => r.id)).toEqual(['a', 'b']);
  });
  it('summary counts by venue, family and size, and separates not-evaluable from missed', () => {
    const s = ledgerSummary([rec('a', 0), rec('b', H, { venue: 'nado', family: 'BTC', aegis: { ...rec('x', 0).aegis, evaluable: false } }), rec('c', 2 * H, { aegis: { ...rec('x', 0).aegis, nearSince: null, watchSince: null } })]);
    expect(s.byVenue).toEqual({ tydro: 2, nado: 1 });
    expect(s.beforeRecording).toBe(1);
    expect(s.warnedNear).toBe(1);
    expect(s.notWarned).toBe(1);
    expect(s.leadHoursMedian).toBe(3);
  });
});

describe('cascades (cascade-1.0.0)', () => {
  const M = 60_000;
  it('deterministic: liquidations ≤30 min apart chain into one cascade; a later one is separate; < 3 is not a cascade', () => {
    const rs = [rec('a', 0), rec('b', 20 * M), rec('c', 45 * M), rec('d', 200 * M), rec('e', 210 * M)];
    const c1 = cascades(rs);
    const c2 = cascades([...rs].reverse());
    expect(c1).toEqual(c2);
    expect(c1).toHaveLength(1);
    expect(c1[0]!.ids).toEqual(['a', 'b', 'c']);
  });
  it('a dominant family is described; mixed families or both venues are labelled uncertain; never a causal claim', () => {
    const one = cascades([rec('a', 0), rec('b', M), rec('c', 2 * M)])[0]!;
    expect(one.centredOn).toEqual({ family: 'ETH', share: 1 });
    expect(one.uncertain).toBe(false);
    const mixed = cascades([rec('a', 0), rec('b', M, { family: 'BTC' }), rec('c', 2 * M, { family: 'SOL', venue: 'nado' })])[0]!;
    expect(mixed.centredOn).toBeNull();
    expect(mixed.uncertain).toBe(true);
    expect(mixed.reasons.join(' ')).toMatch(/timing only/);
    expect(mixed.reasons.join(' ')).toMatch(/does not establish a common cause/);
    expect(mixed.version).toBe('cascade-1.0.0');
  });
  it('the peak is the busiest 10-minute window', () => {
    const c = cascades([rec('a', 0), rec('b', 25 * M), rec('c', 27 * M), rec('d', 29 * M)])[0]!;
    expect(c.peak).toEqual({ at: 25 * M, count: 3 });
  });
});

describe('accountability (scoring method LEDGER.ACCOUNT_VERSION)', () => {
  const now = 30 * 24 * H;
  const w = (wallet: string, at: number, over: Partial<Warning> = {}): Warning => ({ wallet, block: at, at, kind: 'T', primary: TAGS.indexOf('CARRY'), band: 2, venues: { tydro: true, nado: false }, rulesVersion: 'v1.2.0', ...over });
  it('true positive, false positive, false negative — every rate with its denominator', () => {
    const a = scoreAccountability({
      warnings: [w(U1, 10 * H), w(U2, 10 * H)], // U1 liquidated 3 h later (TP), U2 never (FP)
      liquidations: [rec('a', 13 * H, { wallet: U1 }), rec('b', 20 * H, { wallet: '0x3333333333333333333333333333333333333333', aegis: { ...rec('x', 0).aegis, nearSince: null, watchSince: null } })], // FN
      nowMs: now,
      recordingStart: 'x',
      tags: TAGS,
    });
    const w6 = a.windows.find((x) => x.hours === 6)!;
    expect(w6.precision).toMatchObject({ num: 1, den: 2, rate: 0.5, lowSample: true });
    const w1 = a.windows.find((x) => x.hours === 1)!;
    expect(w1.precision.num).toBe(0); // liquidated 3 h after, not within 1 h
    expect(a.recall).toMatchObject({ num: 1, den: 2 });
    expect(a.missed).toMatchObject({ num: 1, den: 2 });
  });
  it('warnings younger than the window are pending, not counted as misses', () => {
    const a = scoreAccountability({ warnings: [w(U1, now - 2 * H)], liquidations: [], nowMs: now, recordingStart: 'x', tags: TAGS });
    const d = a.windows.find((x) => x.hours === 168)!;
    expect(d.pending).toBe(1);
    expect(d.precision.den).toBe(0);
    expect(d.precision.rate).toBeNull();
  });
  it('liquidations before recording are counted but excluded from every rate', () => {
    const a = scoreAccountability({ warnings: [], liquidations: [rec('a', H, { aegis: { ...rec('x', 0).aegis, evaluable: false } })], nowMs: now, recordingStart: 'x', tags: TAGS });
    expect(a.liquidations).toMatchObject({ total: 1, evaluable: 0, beforeRecording: 1 });
    expect(a.recall.den).toBe(0);
  });
  it('rules versions are reported separately, never pooled', () => {
    const a = scoreAccountability({
      warnings: [w(U1, H, { rulesVersion: 'v1.1.0' }), w(U2, H)],
      liquidations: [rec('a', 2 * H, { wallet: U1, aegis: { ...rec('x', 0).aegis, before: { ...rec('x', 0).aegis.before!, rulesVersion: 'v1.1.0' } } })],
      nowMs: now,
      recordingStart: 'x',
      tags: TAGS,
    });
    expect(a.byRules.map((b) => b.key)).toEqual(['v1.1.0', 'v1.2.0']);
    expect(a.byRules.find((b) => b.key === 'v1.1.0')!.recall).toMatchObject({ num: 1, den: 1 });
  });
  it('small samples are flagged, large ones are not', () => {
    const many = Array.from({ length: 40 }, (_, i) => w(`0x${String(i).padStart(40, '0')}`, H));
    const a = scoreAccountability({ warnings: many, liquidations: [], nowMs: now, recordingStart: 'x', tags: TAGS });
    expect(a.windows[0]!.precision).toMatchObject({ den: 40, lowSample: false });
  });
  it('baseline states imported at recording start are never warnings: out of every warning denominator', () => {
    const base = Array.from({ length: 500 }, (_, i) => w(`0x${String(i).padStart(40, '0')}`, H, { kind: 'B' }));
    const a = scoreAccountability({
      warnings: [...base, w(U1, 10 * H), w(U2, 10 * H)],
      liquidations: [rec('a', 13 * H, { wallet: U1 }), rec('z', 14 * H, { wallet: base[0]!.wallet })],
      nowMs: now,
      recordingStart: 'x',
      tags: TAGS,
    });
    expect(a.version).toBe(LEDGER.ACCOUNT_VERSION);
    expect(a.warnings).toEqual({ total: 502, atRecordingStart: 500, afterRecordingStart: 2 });
    for (const win of a.windows) expect(win.precision.den + win.pending).toBe(2); // the 500 baseline rows never count
    expect(a.windows.find((x) => x.hours === 6)!.precision).toMatchObject({ num: 1, den: 2 });
    expect(a.byVenue.reduce((n, b) => n + b.precision24.den, 0)).toBe(2);
  });
  it('one scoring-method version everywhere: the report carries the constant', () => {
    expect(LEDGER.ACCOUNT_VERSION).toBe('acct-1.2.0');
    expect(scoreAccountability({ warnings: [], liquidations: [], nowMs: now, recordingStart: null, tags: TAGS }).version).toBe(LEDGER.ACCOUNT_VERSION);
  });
  it('warnings file: idempotent, keeps the rules version', () => {
    let f = appendWarnings(null, '2026-10', [{ ...w(U1, H), at: H }]);
    f = appendWarnings(f, '2026-10', [{ ...w(U1, H), at: H }]);
    expect(readWarnings([f])).toHaveLength(1);
    expect(readWarnings([f])[0]!.rulesVersion).toBe('v1.2.0');
  });
});

/* ───────── end to end: the census-side writer on a fake chain ───────── */

function fakeClient(o: { logs: Log[]; times?: Record<number, number>; noTimes?: boolean; noPrices?: boolean }) {
  const calls = { getLogs: 0 };
  const client = {
    request: async ({ method, params }: { method: string; params: Array<{ fromBlock: string; toBlock: string }> }) => {
      if (method !== 'eth_getLogs') throw new Error('unexpected');
      calls.getLogs++;
      const from = parseInt(params[0]!.fromBlock, 16);
      const to = parseInt(params[0]!.toBlock, 16);
      return o.logs.filter((l) => Number(l.blockNumber) >= from && Number(l.blockNumber) <= to);
    },
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => {
      if (o.noTimes) throw new Error('rpc down');
      return { timestamp: BigInt(Math.floor((o.times?.[Number(blockNumber)] ?? Number(blockNumber) * 1000) / 1000)) };
    },
    readContract: async ({ functionName }: { functionName: string }) => {
      if (o.noPrices) throw new Error('missing trie node');
      if (functionName === 'BASE_CURRENCY_UNIT') return 100_000_000n;
      return TYDRO_RESERVES.map((r) => (r.symbol === 'WETH' ? 2_000n * 100_000_000n : 100_000_000n));
    },
  } as unknown as PublicClient;
  return { client, calls };
}

const ship = (address: string, hullTemp: CensusShip['hullTemp']): CensusShip => ({ address, primary: 'CARRY', tags: ['CARRY'], hullTemp, band: '1–10k', watch: false, venues: { tydro: true, nado: false }, readBlock: 1, woundedSince: null, wound: { tydro: false, nado: false }, correlatedLoop: false, correlatedNado: false, extraSubs: [] });

async function seededStore(firstBlock: number, month = '2026-10') {
  const store = fileStore(mkdtempSync(join(tmpdir(), 'aegis-ledger-')));
  await store.put(INDEX_PATH, { ...emptyIndex(), months: [month], baselined: [month], firstAt: `${month}-01T00:00:00.000Z`, firstBlock });
  // U1 recorded NEAR from block 25,000,000 on (before its liquidation)
  const at = Date.parse(`${month}-02T00:00:00Z`) / 1000;
  const f = appendWalletRows(null, { month, shard: shardOf(U1), rows: [{ ship: ship(U1, 'CRITICAL'), kind: 'T' }], block: 25_000_000, atSec: at, rules: 'v1.2.0' });
  await store.put(walletPath(month, shardOf(U1)), f);
  return store;
}

describe('ledger writer (fake chain; nothing real is touched)', () => {
  const T = (b: number) => Date.parse('2026-10-03T00:00:00Z') + (b - 25_500_000) * 1000;
  it('backfill + forward: records each liquidation once, joins what Phrourax knew, never stores raw amounts, excludes fixtures', async () => {
    const store = await seededStore(20_000_000);
    const logs = [tydroLog(U1, 25_500_000), nadoLog(U2, 25_600_000), tydroLog(FIX, 25_700_000, 2)];
    const times = Object.fromEntries([25_500_000, 25_600_000, 25_700_000].map((b) => [b, T(b)]));
    const { client } = fakeClient({ logs, times });
    const r = await recordLiquidations({ store, client, head: 30_000_000, budgetMs: 60_000, exclude: new Set([FIX]), scan: { paceMs: 0, backoffBaseMs: 1 } });
    expect(r.written).toBe(2);
    expect(r.cursor?.done).toBe(true);
    const f = (await store.get(ledgerPath('2026-10'))) as LedgerFile;
    const t = f.records.find((x) => x.venue === 'tydro')!;
    expect(t).toMatchObject({ wallet: U1, collateral: 'WETH', debt: 'USDC', sizeBand: '1–10k', completeness: 'COMPLETE' }); // $1,000 debt
    expect(t.impliedBonusPct).toBeCloseTo(4, 0); // 0.52 WETH × 2000 = 1040 vs 1000 debt
    expect(t.aegis).toMatchObject({ evaluable: true, before: { hullTemp: 'CRITICAL' } });
    const n = f.records.find((x) => x.venue === 'nado')!;
    expect(n).toMatchObject({ product: 'BTC-PERP', sizeBand: '1–10k', subaccountKind: 'default', completeness: 'PARTIAL' }); // direction is never stated by the event
    expect(n.unavailable.join(' ')).toMatch(/direction/);
    expect(JSON.stringify(f)).not.toMatch(/1000000000|amountX18|amountQuote/); // no raw amounts in the public file
    // a re-run of the same range adds nothing
    const again = await recordLiquidations({ store, client, head: 30_000_000, budgetMs: 60_000, exclude: new Set([FIX]), scan: { paceMs: 0, backoffBaseMs: 1 } });
    expect(again.written).toBe(0);
  });

  it("prices unreadable at that block → size and bonus UNAVAILABLE (never today's price)", async () => {
    const store = await seededStore(20_000_000);
    const { client } = fakeClient({ logs: [tydroLog(U1, 25_500_000)], times: { 25_500_000: T(25_500_000) }, noPrices: true });
    await recordLiquidations({ store, client, head: 30_000_000, budgetMs: 60_000, scan: { paceMs: 0, backoffBaseMs: 1 } });
    const t = ((await store.get(ledgerPath('2026-10'))) as LedgerFile).records[0]!;
    expect(t.sizeBand).toBeNull();
    expect(t.impliedBonusPct).toBeNull();
    expect(t.completeness).toBe('PARTIAL');
    expect(t.unavailable.join(' ')).toMatch(/oracle prices at that block/);
  });

  it('block times unreadable → nothing written and the cursor does not move (retried next run)', async () => {
    const store = await seededStore(20_000_000);
    const { client } = fakeClient({ logs: [tydroLog(U1, 25_500_000)], noTimes: true });
    const r = await recordLiquidations({ store, client, head: 30_000_000, budgetMs: 60_000, scan: { paceMs: 0, backoffBaseMs: 1 } });
    expect(r.written).toBe(0);
    expect(((await store.get(INDEX_PATH)) as HistoryIndex).ledger).toBeUndefined();
  });

  it('before recording began: recorded, but marked not evaluable', async () => {
    const store = await seededStore(29_000_000);
    const { client } = fakeClient({ logs: [tydroLog(U1, 25_500_000)], times: { 25_500_000: T(25_500_000) } });
    await recordLiquidations({ store, client, head: 30_000_000, budgetMs: 60_000, scan: { paceMs: 0, backoffBaseMs: 1 } });
    const t = ((await store.get(ledgerPath('2026-10'))) as LedgerFile).records[0]!;
    expect(t.aegis.evaluable).toBe(false);
    expect(t.unavailable.join(' ')).toMatch(/before recording began/);
  });

  it('no Flight Recorder yet → the ledger waits (nothing scanned)', async () => {
    const store = fileStore(mkdtempSync(join(tmpdir(), 'aegis-ledger-')));
    const { client, calls } = fakeClient({ logs: [] });
    const r = await recordLiquidations({ store, client, head: 30_000_000, budgetMs: 60_000 });
    expect(calls.getLogs).toBe(0);
    expect(r.notes.join(' ')).toMatch(/ledger starts once history is recording/);
  });
});

/* ───────── time windows: eligibility (acct-1.2.0) ───────── */

describe('track record windows — every window has its own eligible denominator', () => {
  const T0 = Date.parse('2026-10-04T00:00:00Z');
  const START = new Date(T0).toISOString();
  const near = (since: number | null) => ({ ...rec('x', 0).aegis, nearSince: since, watchSince: since });
  const score = (o: { liqs?: LedgerRecord[]; warns?: Warning[]; nowMs: number }) =>
    scoreAccountability({ warnings: o.warns ?? [], liquidations: o.liqs ?? [], nowMs: o.nowMs, recordingStart: START, tags: TAGS });
  const win = (a: ReturnType<typeof score>, h: number) => a.windows.find((w) => w.hours === h)!;

  it('7 days asked, under 7 days recorded: nothing is eligible — not enough history, never 0 of N', () => {
    const liqs = Array.from({ length: 32 }, (_, i) => rec(`l${i}`, T0 + (10 + i) * H, { aegis: near(null) }));
    const a = score({ liqs, nowMs: T0 + 2 * 24 * H });
    expect(win(a, 168).leadAtLeast).toMatchObject({ num: 0, den: 0, rate: null });
    expect(win(a, 168).insufficientHistory).toBe(32);
    expect(a.recall.den).toBe(32); // still evaluable for "anything recorded before"
  });
  it('24 h: only liquidations with a complete 24-hour lookback count', () => {
    const liqs = [
      rec('a', T0 + 10 * H, { aegis: near(T0 + 1 * H) }), // only 10 h after recording began → not eligible
      rec('b', T0 + 30 * H, { aegis: near(T0 + 2 * H) }), // eligible, NEAR 28 h before → counts
      rec('c', T0 + 40 * H, { aegis: near(T0 + 39 * H) }), // eligible, NEAR only 1 h before → not at least 24 h
    ];
    const a = score({ liqs, nowMs: T0 + 50 * H });
    expect(win(a, 24).leadAtLeast).toMatchObject({ num: 1, den: 2 });
    expect(win(a, 24).insufficientHistory).toBe(1);
    expect(win(a, 1).leadAtLeast).toMatchObject({ num: 3, den: 3 });
  });
  it('a genuine zero: full lookback existed and no NEAR was recorded', () => {
    const a = score({ liqs: [rec('a', T0 + 30 * H, { aegis: near(null) })], nowMs: T0 + 40 * H });
    expect(win(a, 24).leadAtLeast).toMatchObject({ num: 0, den: 1, rate: 0 });
    expect(win(a, 24).insufficientHistory).toBe(0);
  });
  const w = (wallet: string, at: number, kind: 'T' | 'B' = 'T'): Warning => ({ wallet, block: at / 1000, at, kind, primary: 0, band: 2, venues: { tydro: true, nado: false }, rulesVersion: 'v1.2.0' });
  it('forward: a warning whose follow-up window is still open is awaiting outcome, not a miss', () => {
    const a = score({ warns: [w(U1, T0 + 5 * H, 'B'), w(U2, T0 + 20 * H)], nowMs: T0 + 30 * H });
    expect(win(a, 24)).toMatchObject({ pending: 1, precision: { num: 0, den: 0, rate: null } });
    expect(win(a, 6)).toMatchObject({ pending: 0, precision: { den: 1 } });
  });
  it('forward: completed windows with and without a later liquidation', () => {
    const W3 = '0x3333333333333333333333333333333333333333';
    const a = score({
      warns: [w(U1, T0 + 5 * H, 'B'), w(U2, T0 + 10 * H), w(W3, T0 + 10 * H)],
      liqs: [rec('z', T0 + 15 * H, { wallet: U2, aegis: near(T0 + 10 * H) })],
      nowMs: T0 + 60 * H,
    });
    expect(win(a, 24).precision).toMatchObject({ num: 1, den: 2 }); // U2 followed, W3 not; the baseline row never counts
    expect(win(a, 1).precision).toMatchObject({ num: 0, den: 2 }); // liquidated 5 h later: not within 1 h
  });
});

/* ───────── what counts as a new warning ───────── */

describe('new warnings — the recording rule (warningKind)', () => {
  const st = (hullTemp: 'NOMINAL' | 'ELEVATED' | 'CRITICAL', primary: string | null = 'CARRY') => ({ hullTemp, primary });
  const later = { firstRun: false, havePrevScan: true };
  it('baseline NEAR states are baseline rows, never new warnings', () => {
    expect(warningKind(st('CRITICAL'), undefined, { firstRun: true, havePrevScan: false })).toBe('B');
    expect(warningKind(st('CRITICAL'), st('CRITICAL'), { firstRun: true, havePrevScan: true })).toBe('B');
  });
  it('SAFE or WATCH → NEAR is a new warning', () => {
    expect(warningKind(st('CRITICAL'), st('NOMINAL'), later)).toBe('T');
    expect(warningKind(st('CRITICAL'), st('ELEVATED'), later)).toBe('T');
    expect(warningKind(st('CRITICAL'), st('NOMINAL', 'EMPTY'), later)).toBe('T');
  });
  it('staying NEAR is not counted again; a wallet first seen already NEAR is not a transition', () => {
    expect(warningKind(st('CRITICAL'), st('CRITICAL'), later)).toBeNull();
    expect(warningKind(st('CRITICAL'), undefined, later)).toBeNull();
    expect(warningKind(st('CRITICAL'), st('NOMINAL'), { firstRun: false, havePrevScan: false })).toBeNull();
    expect(warningKind(st('ELEVATED'), st('NOMINAL'), later)).toBeNull();
    expect(warningKind(st('CRITICAL', 'EMPTY'), st('NOMINAL'), later)).toBeNull();
  });
  it('recovery and a later re-entry into NEAR: one new warning per entry', () => {
    const path = [st('NOMINAL'), st('CRITICAL'), st('CRITICAL'), st('ELEVATED'), st('CRITICAL'), st('CRITICAL')];
    const kinds = path.slice(1).map((cur, i) => warningKind(cur, path[i], later));
    expect(kinds).toEqual(['T', null, null, 'T', null]);
  });
});

/* ───────── the baseline figure, and repeated imports ───────── */

describe('baseline unit — unique wallets from the first import; repeated imports never counted as wallets or warnings', () => {
  const T0 = Date.parse('2026-10-04T00:00:00Z');
  const W = (n: number) => `0x${String(n).padStart(40, '0')}`;
  const row = (wallet: string, atH: number, kind: 'B' | 'T'): Warning => ({ wallet, block: 1000 + atH, at: T0 + atH * H, kind, primary: 0, band: 2, venues: { tydro: true, nado: false }, rulesVersion: 'v1.2.0' });
  // run 0 imported 2 wallets; runs 1 and 2 re-imported (marker lost): 3 + 3 repeated rows; then runs record transitions
  const warnings = [
    row(W(1), 0, 'B'), row(W(2), 0, 'B'),
    row(W(1), 1, 'B'), row(W(2), 1, 'B'), row(W(3), 1, 'B'),
    row(W(1), 2, 'B'), row(W(2), 2, 'B'), row(W(3), 2, 'B'),
    row(W(9), 1.5, 'T'), // a transition recorded in between: before transitions were reliable → excluded
    row(W(4), 4, 'T'), // after the last repeated import → a real new warning
  ];
  it('counts unique wallets in the first import, and the repeats separately', () => {
    const a = scoreAccountability({ warnings, liquidations: [], nowMs: T0 + 10 * H, recordingStart: new Date(T0).toISOString(), tags: TAGS });
    expect(a.baseline).toEqual({ uniqueWallets: 2, rows: 2, firstAt: new Date(T0).toISOString(), repeatedRows: 6, repeatedRuns: 2 });
    expect(a.transitions).toMatchObject({ reliableSince: new Date(T0 + 2 * H).toISOString(), counted: 1, excluded: 1, available: true });
    expect(a.warnings.afterRecordingStart).toBe(1);
    expect(a.windows.find((x) => x.hours === 1)!.precision.den).toBe(1); // only the reliable new warning is judged
  });
  it('right after a repeated import there is no complete run yet: no new-warning count (never a false zero)', () => {
    const a = scoreAccountability({ warnings: warnings.filter((x) => x.kind === 'B'), liquidations: [], nowMs: T0 + 2 * H + 10 * 60_000, recordingStart: new Date(T0).toISOString(), tags: TAGS });
    expect(a.transitions).toMatchObject({ available: false, counted: 0 });
    for (const win of a.windows) expect(win.precision.den + win.pending).toBe(0);
  });
  it('one clean import (no repeats): the whole baseline is unique wallets and transitions count from it', () => {
    const a = scoreAccountability({ warnings: [row(W(1), 0, 'B'), row(W(2), 0, 'B'), row(W(5), 3, 'T')], liquidations: [], nowMs: T0 + 5 * H, recordingStart: new Date(T0).toISOString(), tags: TAGS });
    expect(a.baseline).toMatchObject({ uniqueWallets: 2, repeatedRows: 0, repeatedRuns: 0 });
    expect(a.transitions).toMatchObject({ counted: 1, excluded: 0, available: true });
  });
});
