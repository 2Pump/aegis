import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PublicClient } from 'viem';
import { NADO_CONTRACTS, PYTH, TYDRO, TYDRO_RESERVES, readOracleSnapshot, type OracleSnapshot } from '@aegis/ink-io';
import { classify, familyOf, type Book } from '@aegis/pose';
import {
  type LedgerRecord,
  ORACLE,
  PARAMS_LATEST,
  PressureAcc,
  buildOracleWatch,
  changesPath,
  diffParams,
  emptyIndex,
  aggPath,
  aggPoint,
  appendAgg,
  INDEX_PATH,
  scoreForecasts,
  worstMove,
  type ChangesFile,
  type ForecastRecord,
  type OracleWatch,
  type ParamsLatest,
  type PricePoint,
} from '../src/index.js';
import { fileStore, recordChanges, recordOracles } from '../src/node/index.js';
import { TestTransport, emptyDb, runAlerts } from '../src/alerts/index.js';

const T0 = Date.UTC(2026, 9, 4, 12);
const H = 3_600_000;
const WETH = TYDRO_RESERVES.find((r) => r.symbol === 'WETH')!;
const USDC = TYDRO_RESERVES.find((r) => r.symbol === 'USDC')!;
const KBTC = TYDRO_RESERVES.find((r) => r.symbol === 'kBTC')!;
const USDE = TYDRO_RESERVES.find((r) => r.symbol === 'USDe')!;

/** A snapshot with sane defaults; override per test. */
function snap(o: { tydro?: Partial<Record<string, Partial<OracleSnapshot['tydro'][number]>>>; nado?: OracleSnapshot['nado']; pyth?: OracleSnapshot['pyth']; at?: number; block?: number } = {}): OracleSnapshot {
  const at = o.at ?? T0;
  const base: Record<string, number> = { WETH: 2000, kBTC: 60000, SolvBTC: 60000, USDT: 1, USDG: 1, GHO: 1, USDC: 1, weETH: 2100, wrsETH: 2080, ezETH: 2090, sUSDe: 1.15, USDe: 1, syrupUSDT: 1.1, kHYPE: 40 };
  return {
    block: o.block ?? 1000,
    at,
    tydroBaseUnit: 1e8,
    tydroFallback: null,
    tydro: TYDRO_RESERVES.map((r) => ({
      symbol: r.symbol,
      asset: r.underlying.toLowerCase(),
      decimals: r.decimals,
      priceUsd: base[r.symbol] ?? 1,
      source: { address: `0x${'5'.repeat(38)}${String(TYDRO_RESERVES.indexOf(r)).padStart(2, '0')}`, answer: base[r.symbol] ?? 1, decimals: 8, description: `${r.symbol} / USD`, updatedAt: at - H, error: null },
      ...(o.tydro?.[r.symbol] ?? {}),
    })),
    nado: o.nado ?? [
      { productId: 3, symbol: 'WETH', type: 'spot', token: WETH.underlying.toLowerCase(), priceUsd: 2000 },
      { productId: 1, symbol: 'KBTC', type: 'spot', token: KBTC.underlying.toLowerCase(), priceUsd: 60000 },
      { productId: 5, symbol: 'USDC', type: 'spot', token: USDC.underlying.toLowerCase(), priceUsd: 1 },
      { productId: 4, symbol: 'ETH-PERP', type: 'perp', token: null, priceUsd: 2003 },
    ],
    pyth: o.pyth ?? [
      { key: 'ETH', id: PYTH.feeds.ETH!, price: 2000, conf: 1, publishTime: at - 60_000, error: null },
      { key: 'BTC', id: PYTH.feeds.BTC!, price: 60000, conf: 20, publishTime: at - 60_000, error: null },
      { key: 'USDC', id: PYTH.feeds.USDC!, price: 1, conf: 0.0005, publishTime: at - 60_000, error: null },
    ],
    errors: [],
  };
}
const row = (w: OracleWatch, sym: string) => w.rows.find((r) => r.symbol === sym)!;
const kinds = (w: OracleWatch, sym: string) => Object.fromEntries(row(w, sym).checks.map((c) => [c.kind, c.status]));

describe('Oracle Watch · checks', () => {
  it('all sources agree and fresh → OK; joins Tydro and Nado by token address; perp basis kept separate', () => {
    const w = buildOracleWatch({ snap: snap() });
    expect(row(w, 'WETH').status).toBe('OK');
    expect(row(w, 'WETH').nado?.productId).toBe(3);
    expect(row(w, 'WETH').perp?.symbol).toBe('ETH-PERP');
    expect(row(w, 'WETH').usedBy).toEqual(['tydro', 'nado']);
    expect(kinds(w, 'WETH')).toMatchObject({ 'source-age': 'OK', 'cross-venue': 'OK', external: 'OK' });
  });

  it('a symbol collision is never joined: a Nado spot called WETH with a different token address is not compared', () => {
    const w = buildOracleWatch({ snap: snap({ nado: [{ productId: 99, symbol: 'WETH', type: 'spot', token: '0x000000000000000000000000000000000000dead', priceUsd: 1500 }] }) });
    expect(row(w, 'WETH').nado).toBeNull();
    expect(kinds(w, 'WETH')['cross-venue']).toBeUndefined();
  });

  it('stale source, missing source, non-Chainlink source', () => {
    const w = buildOracleWatch({
      snap: snap({
        tydro: {
          WETH: { source: { address: '0xa', answer: 2000, decimals: 8, description: 'ETH / USD', updatedAt: T0 - 30 * H, error: null } },
          kBTC: { source: null },
          USDG: { source: { address: '0xb', answer: null, decimals: null, description: null, updatedAt: null, error: 'no Chainlink-style answer' } },
        },
      }),
    });
    expect(kinds(w, 'WETH')['source-age']).toBe('STALE');
    expect(kinds(w, 'kBTC')['source-age']).toBe('UNAVAILABLE');
    expect(row(w, 'USDG').checks.find((c) => c.kind === 'source-age')!.text).toMatch(/no price AEGIS can read|no update time/);
  });

  it('decimals other than 8 are flagged; a protocol price that differs from its own source is shown', () => {
    const w = buildOracleWatch({ snap: snap({ tydro: { kHYPE: { source: { address: '0xc', answer: 40, decimals: 18, description: 'HYPE / USD', updatedAt: T0 - H, error: null } }, weETH: { priceUsd: 2050 } } }) });
    expect(kinds(w, 'kHYPE')['source-decimals']).toBe('WARN');
    expect(row(w, 'weETH').checks.find((c) => c.kind === 'protocol-vs-source')!.pct).toBeCloseTo(-2.38, 1);
  });

  it('cross-venue divergence and stablecoin depeg (Nado quote excluded as unit of account)', () => {
    const w = buildOracleWatch({ snap: snap({ tydro: { USDe: { priceUsd: 0.97, source: { address: '0xd', answer: 0.97, decimals: 8, description: 'USDe / USD', updatedAt: T0 - H, error: null } } }, nado: [{ productId: 3, symbol: 'WETH', type: 'spot', token: WETH.underlying.toLowerCase(), priceUsd: 1960 }] }) });
    expect(kinds(w, 'WETH')['cross-venue']).toBe('DIVERGENT');
    expect(row(w, 'USDe').status).toBe('DEPEG');
    const peg = row(w, 'USDe').checks.find((c) => c.kind === 'peg')!;
    expect(peg.pct).toBeCloseTo(-3, 5);
  });

  it('external reference: compared only when fresh; inside its confidence band is OK; wrapped assets say so', () => {
    const stale = buildOracleWatch({ snap: snap({ pyth: [{ key: 'ETH', id: 'x', price: 1500, conf: 1, publishTime: T0 - 5 * H, error: null }] }) });
    expect(kinds(stale, 'WETH').external).toBe('UNAVAILABLE');
    expect(row(stale, 'WETH').external?.note).toMatch(/pull oracle/);
    const band = buildOracleWatch({ snap: snap({ pyth: [{ key: 'ETH', id: 'x', price: 1975, conf: 30, publishTime: T0 - 60_000, error: null }] }) });
    expect(kinds(band, 'WETH').external).toBe('OK'); // 1.27% off, but within Pyth's ±30
    expect(row(band, 'kBTC').external?.relation).toMatch(/wrapped/);
    const missing = buildOracleWatch({ snap: snap({ pyth: [{ key: 'BTC', id: 'x', price: null, conf: null, publishTime: null, error: 'PriceFeedNotFound' }] }) });
    expect(kinds(missing, 'kBTC').external).toBe('UNAVAILABLE');
  });

  it('a dormant reference (not pushed for over a day) is shown but is not a check; a fixed $1 source says what it can\'t see', () => {
    const w = buildOracleWatch({
      snap: snap({
        pyth: [{ key: 'ETH', id: 'x', price: 1500, conf: 1, publishTime: T0 - 160 * 24 * H, error: null }],
        tydro: { GHO: { source: { address: '0x20fd5f3f00000000000000000000000000000000', answer: 1, decimals: 8, description: null, updatedAt: null, error: null, kind: 'answer-only' } } },
      }),
    });
    expect(kinds(w, 'WETH').external).toBeUndefined();
    expect(row(w, 'WETH').external?.note).toMatch(/dormant — last pushed 160 days ago/);
    expect(row(w, 'WETH').status).toBe('OK');
    expect(row(w, 'GHO').status).toBe('OK');
    expect(row(w, 'GHO').checks.find((c) => c.kind === 'source-age')!.text).toMatch(/fixed-price source.*market depeg would not show/);
  });

  it('a sudden jump against the previous run', () => {
    const prev = buildOracleWatch({ snap: snap() });
    const w = buildOracleWatch({ snap: snap({ tydro: { WETH: { priceUsd: 1800 } }, at: T0 + H, block: 2000 }), prev });
    expect(kinds(w, 'WETH').jump).toBe('JUMP');
  });

  it('invalid or missing protocol price is never shown as a number', () => {
    const w = buildOracleWatch({ snap: snap({ tydro: { GHO: { priceUsd: null } } }) });
    expect(row(w, 'GHO').status).toBe('INVALID');
  });
});

describe('Oracle Watch · events (dedup, cooldown, hysteresis)', () => {
  it('fires on entering a problem, not every run; resolves only after 2 clean runs', () => {
    const bad = (t: number, b: number) => snap({ tydro: { USDe: { priceUsd: 0.97, source: { address: '0xd', answer: 0.97, decimals: 8, description: 'USDe / USD', updatedAt: t - H, error: null } } }, at: t, block: b });
    const good = (t: number, b: number) => snap({ at: t, block: b });
    let w = buildOracleWatch({ snap: bad(T0, 1) });
    expect(w.events.filter((e) => e.symbol === 'USDe' && e.status === 'DEPEG')).toHaveLength(1);
    w = buildOracleWatch({ snap: bad(T0 + H, 2), prev: w });
    expect(w.events.filter((e) => e.symbol === 'USDe' && e.status === 'DEPEG')).toHaveLength(1); // no repeat
    w = buildOracleWatch({ snap: good(T0 + 2 * H, 3), prev: w });
    expect(w.events.some((e) => e.status === 'RESOLVED')).toBe(false); // one clean run is not enough
    w = buildOracleWatch({ snap: good(T0 + 3 * H, 4), prev: w });
    expect(w.events.filter((e) => e.symbol === 'USDe' && e.status === 'RESOLVED')).toHaveLength(1);
    w = buildOracleWatch({ snap: bad(T0 + 4 * H, 5), prev: w }); // within the cooldown
    expect(w.events.filter((e) => e.symbol === 'USDe' && e.status === 'DEPEG')).toHaveLength(1);
    w = buildOracleWatch({ snap: good(T0 + 5 * H, 6), prev: w });
    w = buildOracleWatch({ snap: good(T0 + 6 * H, 7), prev: w });
    w = buildOracleWatch({ snap: bad(T0 + 12 * H, 8), prev: w }); // after the cooldown
    expect(w.events.filter((e) => e.symbol === 'USDe' && e.status === 'DEPEG')).toHaveLength(2);
  });
});

describe('Oracle Watch · impact (Pressure engine, labelled approximate)', () => {
  const borrower = (supply: number, debt: number, i: number): Book => {
    const leg = (symbol: string, usd: number) => ({ symbol, ...familyOf(symbol), amount: usd / (symbol === 'WETH' ? 2000 : 1), usd, priceUsd: symbol === 'WETH' ? 2000 : 1, priceSource: 'FIXTURE' as const });
    return {
      address: `0x${(i + 1).toString(16).padStart(40, '0')}`,
      source: 'LIVE',
      tydro: { status: 'OK', asOfTime: 0, asOfBlock: 1, data: { hf: (0.8 * supply) / debt, supplies: [leg('WETH', supply)], debts: [leg('USDC', debt)], totalCollateralUsd: supply, totalDebtUsd: debt, usdNet: supply - debt, liquidationThreshold: 0.8, notes: [] } },
      nado: { status: 'OK', asOfTime: 0, asOfBlock: 1, data: { subaccounts: [], equityUsd: 0, spots: [], perps: [], maintenance: null, initial: null, unweighted: null, funding: [], notes: [] } },
      asOfBlock: 1,
      asOfTime: 0,
    };
  };
  it('a WETH divergence models the protocol price converging on Nado as an ETH move, with counts per size floor', () => {
    const acc = new PressureAcc();
    for (let i = 0; i < 12; i++) {
      const b = borrower(10_000, 6_600, i); // hf ≈ 1.21 → ≈ 0.97 after −20%
      acc.add(b, classify(b), '1–10k');
    }
    const ps = acc.toSnapshot({ block: 900, at: new Date(T0).toISOString(), rulesVersion: 'v1.2.0' });
    const w = buildOracleWatch({ snap: snap({ nado: [{ productId: 3, symbol: 'WETH', type: 'spot', token: WETH.underlying.toLowerCase(), priceUsd: 1600 }] }), pressure: ps });
    const imp = row(w, 'WETH').impact!;
    expect(imp).toMatchObject({ direction: 'ETH', sign: 'down', exact: false, pressureBlock: 900 });
    expect(imp.pct).toBe(20);
    expect(imp.byFloor['0'].newlyLiquidatable).toBeGreaterThan(0);
    expect(imp.note).toMatch(/Approximate — not a prediction/);
    expect(row(w, 'kHYPE').impact).toBeNull(); // no divergence, no impact
  });
});

/* ───────────────────────── Protocol Change Monitor ───────────────────────── */

const latest = (block: number, params: Record<string, string>, unsupported: string[] = []): ParamsLatest => ({
  v: 1,
  kind: 'aegis-params',
  block,
  at: T0 + block * 1000,
  since: 'x',
  params: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, { v, protocol: k.split(':')[0] as 'tydro', subject: k.split(':')[1]!, name: k.split(':').slice(2).join(':'), source: 'src' }])),
  unsupported,
  reader: 'r',
});

describe('Protocol Change Monitor · diffs', () => {
  const before = {
    'tydro:WETH:liquidationThreshold': '8250',
    'tydro:WETH:supplyCap': '100000',
    'tydro:WETH:oracleSource': '0xaaa',
    'tydro:USDe:isFrozen': 'false',
    'nado:BTC-PERP#2:longWeightMaintenance': '0.95',
    'nado:BTC-PERP#2:listed': 'perp',
    'nado:OLD-PERP#77:listed': 'perp',
    'tydro:protocol:Pool.implementation': '0x111',
  };
  it('threshold, cap, oracle, frozen, weight, new product, removed product, contract upgrade', () => {
    const next = {
      ...before,
      'tydro:WETH:liquidationThreshold': '8000',
      'tydro:WETH:supplyCap': '120000',
      'tydro:WETH:oracleSource': '0xbbb',
      'tydro:USDe:isFrozen': 'true',
      'nado:BTC-PERP#2:longWeightMaintenance': '0.9',
      'nado:NEW-PERP#200:listed': 'perp',
      'tydro:protocol:Pool.implementation': '0x222',
    } as Record<string, string>;
    delete next['nado:OLD-PERP#77:listed'];
    const d = diffParams(latest(1, before), latest(2, next));
    const by = Object.fromEntries(d.map((x) => [x.key, x]));
    expect(by['tydro:WETH:liquidationThreshold']).toMatchObject({ kind: 'changed', old: '8250', new: '8000' });
    expect(by['tydro:WETH:supplyCap']).toMatchObject({ old: '100000', new: '120000' });
    expect(by['tydro:WETH:oracleSource']).toMatchObject({ new: '0xbbb' });
    expect(by['tydro:USDe:isFrozen']).toMatchObject({ new: 'true' });
    expect(by['nado:BTC-PERP#2:longWeightMaintenance']).toMatchObject({ old: '0.95', new: '0.9' });
    expect(by['nado:NEW-PERP#200:listed']).toMatchObject({ kind: 'added' });
    expect(by['nado:OLD-PERP#77:listed']).toMatchObject({ kind: 'removed' });
    expect(by['tydro:protocol:Pool.implementation']).toMatchObject({ old: '0x111', new: '0x222' });
    expect(d).toHaveLength(8);
  });
  it('a value that failed to read is not a change (and a failed product list is not a removal)', () => {
    const next = { ...before } as Record<string, string>;
    delete next['tydro:WETH:supplyCap'];
    delete next['nado:OLD-PERP#77:listed'];
    expect(diffParams(latest(1, before), latest(2, next, ['nado:products (timeout)']))).toHaveLength(0);
  });
});

/** Fake chain for the writers: answers multicall/readContract/getStorageAt/getBlock/getLogs from a mutable state. */
function paramChain(state: { lt: bigint; impl: string; frozen: boolean; logs?: Array<{ block: number; tx: string }> }) {
  return {
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ timestamp: BigInt(Math.floor(T0 / 1000) + Number(blockNumber)) }),
    getStorageAt: async () => `0x${'0'.repeat(24)}${state.impl.slice(2).padStart(40, '0')}`,
    multicall: async ({ contracts }: { contracts: Array<{ functionName: string; address: string }> }) =>
      contracts.map((c) => {
        switch (c.functionName) {
          case 'getReserveConfigurationData':
            return { status: 'success', result: [18n, 8000n, state.lt, 10500n, 1000n, true, true, false, true, state.frozen] };
          case 'getReserveCaps':
            return { status: 'success', result: [0n, 100000n] };
          case 'getPaused':
            return { status: 'success', result: false };
          case 'getPoolConfigurator':
            return { status: 'success', result: '0x00000000000000000000000000000000000c0f16' };
          case 'getSourceOfAsset':
          case 'getPool':
          case 'getPriceOracle':
            return { status: 'success', result: '0x0000000000000000000000000000000000000abc' };
          default:
            return { status: 'failure', error: new Error('execution reverted: function not found') };
        }
      }),
    readContract: async () => ({ spotProducts: [{ productId: 0, risk: { longWeightInitialX18: 10n ** 18n, shortWeightInitialX18: 10n ** 18n, longWeightMaintenanceX18: 10n ** 18n, shortWeightMaintenanceX18: 10n ** 18n }, config: { token: NADO_CONTRACTS.quote } }], perpProducts: [] }),
    request: async () => (state.logs ?? []).map((l) => ({ address: '0x00000000000000000000000000000000000c0f16', topics: ['0x01'], data: '0x', blockNumber: `0x${l.block.toString(16)}`, transactionHash: l.tx, logIndex: '0x0' })),
  } as unknown as PublicClient;
}

describe('Protocol Change Monitor · writer (fake chain)', () => {
  it('first run is a baseline; then a threshold change, a freeze and an upgrade are recorded with tx candidates and BEFORE/AFTER; unsupported reads are listed, never claimed', async () => {
    const store = fileStore(mkdtempSync(join(tmpdir(), 'aegis-changes-')));
    await store.put(INDEX_PATH, { ...emptyIndex(), months: ['2026-10'], firstAt: new Date(T0).toISOString(), firstBlock: 1 });
    const state = { lt: 8250n, impl: '0x1111111111111111111111111111111111111111', frozen: false, logs: [{ block: 150, tx: '0xfeed' }] };
    const client = paramChain(state);
    expect(await recordChanges({ store, client, head: 100 })).toHaveLength(0);
    const base = (await store.get(PARAMS_LATEST)) as ParamsLatest;
    expect(base.params['tydro:WETH:liquidationThreshold']?.v).toBe('8250');
    expect(base.unsupported.some((u) => u.includes('debtCeiling'))).toBe(true); // couldn't read → listed, not monitored
    // recorded points on both sides
    const pt = (block: number, crit: number) => aggPoint({ ships: [], known: 0, at: new Date(T0 + block * 1000).toISOString(), block, hash: null, sweep: 'incremental', complete: true, versions: { rules: 'v', engine: 'e', reader: 'r', prices: 'p' }, stress: null });
    let agg = appendAgg(null, { ...pt(100, 0), risk: { ...pt(100, 0).risk, '0': [10, 5, 3, 0] } });
    agg = appendAgg(agg, { ...pt(200, 0), risk: { ...pt(200, 0).risk, '0': [8, 6, 4, 0] } });
    await store.put(aggPath('2026-10'), agg);
    state.lt = 8000n;
    state.frozen = true;
    state.impl = '0x2222222222222222222222222222222222222222';
    const recs = await recordChanges({ store, client, head: 200 });
    const by = Object.fromEntries(recs.map((r) => [r.key, r]));
    expect(by['tydro:WETH:liquidationThreshold']).toMatchObject({ old: '8250', new: '8000', between: { fromBlock: 100, toBlock: 200 } });
    expect(by['tydro:WETH:isFrozen']).toMatchObject({ old: 'false', new: 'true' });
    expect(by['tydro:protocol:Pool.implementation']?.new).toBe('0x2222222222222222222222222222222222222222');
    expect(by['tydro:WETH:liquidationThreshold']!.txCandidates).toEqual(['0xfeed']);
    expect(by['tydro:WETH:liquidationThreshold']!.impact).toMatchObject({ before: { block: 100, near: 3 }, after: { block: 200, near: 4 } });
    expect(by['tydro:WETH:liquidationThreshold']!.impact.note).toMatch(/not isolated/);
    const f = (await store.get(changesPath(new Date(T0 + 200_000).toISOString().slice(0, 7)))) as ChangesFile;
    expect(f.records.length).toBe(recs.length);
    // a re-run of the same block adds nothing new
    expect(await recordChanges({ store, client, head: 200 })).toHaveLength(0);
  });

  it('no recorded point on one side → no impact shown (never reconstructed)', async () => {
    const store = fileStore(mkdtempSync(join(tmpdir(), 'aegis-changes-')));
    const state = { lt: 8250n, impl: '0x1111111111111111111111111111111111111111', frozen: false };
    await recordChanges({ store, client: paramChain(state), head: 100 });
    state.lt = 7000n;
    const r = (await recordChanges({ store, client: paramChain(state), head: 300 })).find((x) => x.name === 'liquidationThreshold')!;
    expect(r.impact.before).toBeNull();
    expect(r.impact.note).toMatch(/no impact shown/);
  });
});

/* ───────────────────────── oracle reads (fake chain) ───────────────────────── */

describe('Oracle reads (fake chain)', () => {
  it('an adapter over another adapter (sUSDe → capped USDT/USD → USDT/USD) names the feed at the bottom, and its age is that feed\'s', async () => {
    const TOP = '0x00000000000000000000000000000000000000b1';
    const MID = '0x00000000000000000000000000000000000000b2';
    const LEAF = '0x00000000000000000000000000000000000000b3';
    const client = {
      getBlock: async () => ({ timestamp: BigInt(T0 / 1000) }),
      multicall: async ({ contracts }: { contracts: Array<{ functionName: string; address: string }> }) =>
        contracts.map((c) => {
          const a = c.address.toLowerCase();
          const f = c.functionName;
          if (f === 'BASE_CURRENCY_UNIT') return { status: 'success', result: 100_000_000n };
          if (f === 'getAssetsPrices') return { status: 'success', result: TYDRO_RESERVES.map(() => 125_000_000n) };
          if (f === 'getSourceOfAsset') return { status: 'success', result: TOP };
          if (a === TOP && f === 'latestAnswer') return { status: 'success', result: 125_000_000n };
          if (a === TOP && f === 'BASE_TO_USD_AGGREGATOR') return { status: 'success', result: MID };
          if (a === MID && f === 'latestAnswer') return { status: 'success', result: 100_000_000n };
          if (a === MID && f === 'description') return { status: 'success', result: 'Capped USDT/USD' };
          if (a === MID && f === 'ASSET_TO_USD_AGGREGATOR') return { status: 'success', result: LEAF };
          if (a === LEAF && f === 'latestRoundData') return { status: 'success', result: [1n, 100_000_000n, 0n, BigInt(T0 / 1000 - 39_600), 1n] };
          if (a === LEAF && f === 'description') return { status: 'success', result: 'USDT / USD' };
          if (f === 'decimals') return { status: 'success', result: 8 };
          return { status: 'failure', error: new Error('execution reverted') };
        }),
      readContract: async () => ({ spotProducts: [], perpProducts: [] }),
    } as unknown as PublicClient;
    const r = await readOracleSnapshot(client, 1000n);
    if (!r.ok) throw new Error('read failed');
    const src = r.value.tydro[0]!.source!;
    expect(src.kind).toBe('adapter');
    expect(src.updatedAt).toBe(T0 - 39_600_000);
    expect(src.via![0]).toMatchObject({ description: 'Capped USDT/USD', updatedAt: T0 - 39_600_000, under: [{ role: 'ASSET_TO_USD_AGGREGATOR', address: LEAF, description: 'USDT / USD', updatedAt: T0 - 39_600_000 }] });
    expect(buildOracleWatch({ snap: r.value }).rows[0]!.tydro?.via?.[0]?.under?.[0]?.description).toBe('USDT / USD');
  });

  it('an adapter that ALSO answers latestRoundData is still followed to the feed underneath (its own time kept)', async () => {
    const TOP = '0x00000000000000000000000000000000000000c1';
    const LEAF = '0x00000000000000000000000000000000000000c3';
    const client = {
      getBlock: async () => ({ timestamp: BigInt(T0 / 1000) }),
      multicall: async ({ contracts }: { contracts: Array<{ functionName: string; address: string }> }) =>
        contracts.map((c) => {
          const a = c.address.toLowerCase();
          const f = c.functionName;
          if (f === 'BASE_CURRENCY_UNIT') return { status: 'success', result: 100_000_000n };
          if (f === 'getAssetsPrices') return { status: 'success', result: TYDRO_RESERVES.map(() => 100_000_000n) };
          if (f === 'getSourceOfAsset') return { status: 'success', result: TOP };
          if (a === TOP && f === 'latestRoundData') return { status: 'success', result: [1n, 100_000_000n, 0n, BigInt(T0 / 1000 - 3600), 1n] };
          if (a === TOP && f === 'description') return { status: 'success', result: 'Capped USDT/USD' };
          if (a === TOP && f === 'ASSET_TO_USD_AGGREGATOR') return { status: 'success', result: LEAF };
          if (a === LEAF && f === 'latestRoundData') return { status: 'success', result: [1n, 100_000_000n, 0n, BigInt(T0 / 1000 - 7200), 1n] };
          if (a === LEAF && f === 'description') return { status: 'success', result: 'USDT / USD' };
          if (f === 'decimals') return { status: 'success', result: 8 };
          return { status: 'failure', error: new Error('execution reverted') };
        }),
      readContract: async () => ({ spotProducts: [], perpProducts: [] }),
    } as unknown as PublicClient;
    const r = await readOracleSnapshot(client, 1000n);
    if (!r.ok) throw new Error('read failed');
    const src = r.value.tydro[0]!.source!;
    expect(src.kind).toBe('adapter');
    expect(src.updatedAt).toBe(T0 - 3_600_000);
    expect(src.via).toMatchObject([{ role: 'ASSET_TO_USD_AGGREGATOR', description: 'USDT / USD', updatedAt: T0 - 7_200_000 }]);
  });

  it('an Aave-style adapter (latestAnswer only) is followed to the feed underneath for its age; an active price cap is flagged', async () => {
    const FEED = '0x00000000000000000000000000000000000000f4';
    const ADAPTER = '0x00000000000000000000000000000000000000a3';
    const client = {
      getBlock: async () => ({ timestamp: BigInt(T0 / 1000) }),
      multicall: async ({ contracts }: { contracts: Array<{ functionName: string; address: string; args?: unknown[] }> }) =>
        contracts.map((c) => {
          const a = c.address.toLowerCase();
          if (c.functionName === 'BASE_CURRENCY_UNIT') return { status: 'success', result: 100_000_000n };
          if (c.functionName === 'getAssetsPrices') return { status: 'success', result: TYDRO_RESERVES.map(() => 105_000_000n) };
          if (c.functionName === 'getSourceOfAsset') return { status: 'success', result: ADAPTER };
          if (a === ADAPTER) {
            if (c.functionName === 'latestAnswer') return { status: 'success', result: 105_000_000n };
            if (c.functionName === 'decimals') return { status: 'success', result: 8 };
            if (c.functionName === 'description') return { status: 'success', result: 'Capped weETH / ETH / USD' };
            if (c.functionName === 'isCapped') return { status: 'success', result: true };
            if (c.functionName === 'BASE_TO_USD_AGGREGATOR') return { status: 'success', result: FEED };
          }
          if (a === FEED) {
            if (c.functionName === 'latestRoundData') return { status: 'success', result: [1n, 200_000_000_000n, 0n, BigInt(T0 / 1000 - 7200), 1n] };
            if (c.functionName === 'decimals') return { status: 'success', result: 8 };
            if (c.functionName === 'description') return { status: 'success', result: 'ETH / USD' };
            if (c.functionName === 'aggregator') return { status: 'success', result: '0x00000000000000000000000000000000000000f5' }; // a proxy is a feed, not an adapter
          }
          return { status: 'failure', error: new Error('execution reverted') };
        }),
      readContract: async () => ({ spotProducts: [], perpProducts: [] }),
    } as unknown as PublicClient;
    const r = await readOracleSnapshot(client, 1000n);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const src = r.value.tydro[0]!.source!;
    expect(src.kind).toBe('adapter');
    expect(src.answer).toBe(1.05);
    expect(src.updatedAt).toBe(T0 - 7_200_000);
    expect(src.via).toEqual([{ role: 'BASE_TO_USD_AGGREGATOR', address: FEED, description: 'ETH / USD', answer: 2000, updatedAt: T0 - 7_200_000 }]);
    expect(src.capped).toBe(true);
    const w = buildOracleWatch({ snap: r.value });
    const row0 = w.rows[0]!;
    expect(row0.checks.find((c) => c.kind === 'source-age')).toMatchObject({ status: 'OK', text: expect.stringMatching(/adapter over ETH \/ USD.*2\.0 h/) });
    expect(row0.checks.find((c) => c.kind === 'source-cap')?.status).toBe('WARN');
    expect(row0.tydro?.sourceKind).toBe('adapter');
  });

  it('decimals normalised from each source; a source without the Chainlink interface is reported, not guessed', async () => {
    const client = {
      getBlock: async () => ({ timestamp: BigInt(T0 / 1000) }),
      multicall: async ({ contracts }: { contracts: Array<{ functionName: string; address: string; args?: unknown[] }> }) =>
        contracts.map((c) => {
          if (c.functionName === 'BASE_CURRENCY_UNIT') return { status: 'success', result: 100_000_000n };
          if (c.functionName === 'getAssetsPrices') return { status: 'success', result: TYDRO_RESERVES.map((r) => (r.symbol === 'WETH' ? 2000n * 100_000_000n : 100_000_000n)) };
          if (c.functionName === 'getFallbackOracle') return { status: 'success', result: '0x0000000000000000000000000000000000000000' };
          if (c.functionName === 'getSourceOfAsset') return { status: 'success', result: (c.args![0] as string).toLowerCase() === WETH.underlying.toLowerCase() ? '0x00000000000000000000000000000000000000e1' : '0x00000000000000000000000000000000000000e2' };
          if (c.functionName === 'latestRoundData') return c.address.endsWith('e1') ? { status: 'success', result: [1n, 200_000_000_000_000_000_000n, 0n, BigInt(T0 / 1000 - 600), 1n] } : { status: 'failure', error: new Error('revert') };
          if (c.functionName === 'decimals') return c.address.endsWith('e1') ? { status: 'success', result: 18 } : { status: 'failure', error: new Error('revert') };
          if (c.functionName === 'description') return { status: 'success', result: 'ETH / USD' };
          if (c.functionName === 'getPriceUnsafe') return { status: 'success', result: { price: 200_123_000_000n, conf: 100_000_000n, expo: -8, publishTime: BigInt(T0 / 1000 - 30) } };
          return { status: 'failure', error: new Error('unknown') };
        }),
      readContract: async () => ({ spotProducts: [{ productId: 3, oraclePriceX18: 2000n * 10n ** 18n, config: { token: WETH.underlying } }], perpProducts: [] }),
    } as unknown as PublicClient;
    const r = await readOracleSnapshot(client, 1000n);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const w = r.value.tydro.find((t) => t.symbol === 'WETH')!;
    expect(w.priceUsd).toBe(2000);
    expect(w.source?.answer).toBe(200); // 2e20 at 18 decimals
    expect(w.source?.decimals).toBe(18);
    expect(r.value.tydro.find((t) => t.symbol === 'USDC')!.source?.updatedAt).toBeNull();
    expect(r.value.pyth[0]!.price).toBeCloseTo(2001.23, 2);
    expect(r.value.pyth[0]!.conf).toBeCloseTo(1, 5);
    expect(r.value.nado[0]).toMatchObject({ productId: 3, token: WETH.underlying.toLowerCase(), priceUsd: 2000 });
  });

  it('the writer keeps the last good watch when a read fails (never an empty one)', async () => {
    const store = fileStore(mkdtempSync(join(tmpdir(), 'aegis-oracle-')));
    await store.put('history/oracle/latest.json', buildOracleWatch({ snap: snap() }));
    const dead = { getBlock: async () => { throw new Error('rpc down'); } } as unknown as PublicClient;
    expect(await recordOracles({ store, client: dead, head: 5 })).toBeNull();
    expect(((await store.get('history/oracle/latest.json')) as OracleWatch).rows.length).toBe(TYDRO_RESERVES.length);
  });
});

/* ───────────────────────── forecast scoring ───────────────────────── */

describe('Forecast scoring', () => {
  const pts = (moves: number[]): PricePoint[] => moves.map((m, i) => ({ block: i, at: T0 + i * H, p: { 'tydro:WETH': 2000 * (1 + m), 'tydro:kBTC': 60000 * (1 + m / 2), 'tydro:USDC': 1 } }));
  const f = (at: number): ForecastRecord => ({ at: new Date(at).toISOString(), block: 0, v: { rules: 'v', engine: 'e', stress: 's' }, coverage: 1, population: 10, confidence: 'NORMAL', scenarios: [{ dir: 'ETH', sign: 'down', pct: 10, material: '0', population: 10, near: 4, liquidatable: 2, affected: 5 }, { dir: 'CRYPTO', sign: 'down', pct: 10, material: '0', population: 10, near: 3, liquidatable: 1, affected: 4 }] });
  it('worst move per direction; CRYPTO averages ETH and BTC', () => {
    const p = pts([0, -0.05, -0.12, -0.02]);
    expect(worstMove(p, 'ETH', T0, T0 + 24 * H)).toBeCloseTo(-0.12, 5);
    expect(worstMove(p, 'CRYPTO', T0, T0 + 24 * H)).toBeCloseTo(-0.09, 5);
  });
  it('reached vs not reached vs before prices vs pending — never a hit or miss for an unreached scenario', () => {
    const p = pts([0, -0.05, -0.12, ...Array(30).fill(-0.02)]);
    const s = scoreForecasts({ forecasts: [f(T0), f(T0 - 48 * H), f(T0 + 31 * H)], prices: p, agg: [], liquidations: [], nowMs: T0 + 32 * H });
    expect(s.pending).toBe(1);
    expect(s.unjudgeable).toBe(1);
    const eth = s.scenarios.find((x) => x.dir === 'ETH')!;
    expect(eth).toMatchObject({ judged: 1, reached: 1 });
    const cr = s.scenarios.find((x) => x.dir === 'CRYPTO')!;
    expect(cr).toMatchObject({ judged: 1, reached: 0, comparisons: [] });
  });
});

/* ───────────────────────── protocol alerts (opt-in) ───────────────────────── */

describe('Alerts · /protocol (Ink-wide events, opt-in)', () => {
  it('only chats that opted in get them, once each, and only events from after opting in', async () => {
    const tx = new TestTransport();
    let now = T0;
    const events = [{ id: 'oracle:old', at: T0 - H, text: 'old' }];
    const deps = { transport: tx, read: async () => null, now: () => now, fixtures: new Set<string>(), siteUrl: 'https://x', hashChat: (c: string) => c, protocolEvents: events };
    let db = emptyDb(T0);
    tx.say('1', '/start');
    tx.say('1', '/protocol on');
    tx.say('2', '/start');
    ({ db } = await runAlerts(db, deps));
    expect(tx.to('1').some((t) => t.includes('Ink protocol watch'))).toBe(false); // the old event predates opting in
    now = T0 + H;
    events.push({ id: 'oracle:new', at: T0 + 30 * 60_000, text: 'USDe: DEPEG' });
    ({ db } = await runAlerts(db, deps));
    ({ db } = await runAlerts(db, deps));
    expect(tx.to('1').filter((t) => t.includes('USDe: DEPEG'))).toHaveLength(1);
    expect(tx.to('2').some((t) => t.includes('USDe'))).toBe(false);
    expect(tx.to('1').at(-1)).toMatch(/AEGIS is a camera/);
  });
});

describe('Alerts · actual liquidation of a watched wallet (always on)', () => {
  it('a chat watching the wallet is told once, urgently, with no balance; other chats and older liquidations are not', async () => {
    const tx = new TestTransport();
    let now = T0;
    const W = '0x' + 'cd'.repeat(20);
    const liqs: LedgerRecord[] = [];
    const deps = { transport: tx, read: async () => null, now: () => now, fixtures: new Set<string>(), siteUrl: 'https://x', hashChat: (c: string) => c, liquidations: liqs };
    let db = emptyDb(T0);
    tx.say('1', '/start');
    tx.say('1', `/watch ${W}`);
    tx.say('2', '/start');
    ({ db } = await runAlerts(db, deps));
    const rec = (id: string, at: number) => ({ id, venue: 'tydro', tx: '0xt', block: 77, at, wallet: W, sizeBand: '10–100k', family: 'ETH', aegis: { before: { hullTemp: 'CRITICAL' } } }) as unknown as LedgerRecord;
    liqs.push(rec('before-watch', T0 - H), rec('l1', T0 + 10 * 60_000));
    now = T0 + H;
    ({ db } = await runAlerts(db, deps));
    ({ db } = await runAlerts(db, deps));
    const got = tx.to('1').filter((t) => t.includes('LIQUIDATED'));
    expect(got).toHaveLength(1);
    expect(got[0]).toMatch(/size range 10–100k/);
    expect(got[0]).not.toMatch(/\$\d|health factor|HF \d/i);
    expect(tx.to('2').some((t) => t.includes('LIQUIDATED'))).toBe(false);
  });
});

void ORACLE;
void TYDRO;
void USDE;
