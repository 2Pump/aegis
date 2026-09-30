import { describe, expect, it } from 'vitest';
import type { PublicClient } from 'viem';
import { classify } from '@aegis/pose';
import {
  aggregate,
  nadoSubaccount,
  parseAddress,
  parseSubaccountInfo,
  parseSymbols,
  readNado,
  readTydro,
  TYDRO_RESERVES,
  type SymbolMap,
} from '../src/index.js';
import docsSample from './data/subaccount-info.docs.json';

const symbols: SymbolMap = new Map([
  [0, { symbol: 'USDT0', type: 'spot' }],
  [1, { symbol: 'KBTC', type: 'spot' }],
  [2, { symbol: 'BTC-PERP', type: 'perp' }],
]);

describe('address', () => {
  it('nado subaccount bytes32 matches the docs example', () => {
    expect(nadoSubaccount('0x8d7d64d6cf1d4f018dd101482ac71ad49e30c560')).toBe(docsSample.data.subaccount);
  });
  it('rejects junk, accepts lowercase, returns checksum', () => {
    expect(parseAddress('0x123').ok).toBe(false);
    const r = parseAddress('0x8d7d64d6cf1d4f018dd101482ac71ad49e30c560');
    expect(r.ok && r.value.lower).toBe('0x8d7d64d6cf1d4f018dd101482ac71ad49e30c560');
    expect(r.ok && r.value.checksum).not.toBe(r.ok && r.value.lower);
  });
  it('rejects a mixed-case address with a bad checksum', () => {
    expect(parseAddress('0x8D7d64d6cf1d4f018dd101482ac71ad49e30c560').ok).toBe(false);
  });
});

describe('nado parse — documented subaccount_info payload', () => {
  const r = parseSubaccountInfo(docsSample, symbols);
  it('parses', () => expect(r.ok).toBe(true));
  if (!r.ok) return;
  const sub = r.value;

  it('spot USDT0 and a KBTC borrow, x18 decoded and priced by Nado oracle', () => {
    expect(sub.spots).toHaveLength(2);
    const usdt = sub.spots.find((s) => s.symbol === 'USDT0')!;
    expect(usdt.usd).toBeCloseTo(456_895.62, 1);
    const kbtc = sub.spots.find((s) => s.symbol === 'KBTC')!;
    expect(kbtc.amount).toBeCloseTo(-0.600152, 5);
    expect(kbtc.usd).toBeCloseTo(-69_375.52, 1);
    expect(kbtc.priceSource).toBe('NADO_ORACLE');
  });

  it('zero perp is dropped', () => expect(sub.perps).toHaveLength(0));

  it('healths index mapping: [2] unweighted ≈ computed equity; [0]/[1] liabilities = 1.10× / 1.05× of borrow', () => {
    const book = aggregate([sub], []);
    expect(book.unweighted!.healthUsd).toBeCloseTo(book.equityUsd, -2); // within ~$50
    expect(book.notes.some((n) => n.includes('cross-check OK'))).toBe(true);
    const borrow = 69_375.52;
    expect(sub.initial!.liabilitiesUsd / borrow).toBeCloseTo(1.1, 2);
    expect(sub.maintenance!.liabilitiesUsd / borrow).toBeCloseTo(1.05, 2);
  });

  it('pose on docs sample is STABLE-BALLAST (it is a big USDT0 account)', () => {
    const book = aggregate([sub], []);
    const p = classify({
      address: '0x8d7d64d6cf1d4f018dd101482ac71ad49e30c560',
      source: 'LIVE',
      tydro: { status: 'OK', data: { hf: null, supplies: [], debts: [], totalCollateralUsd: 0, totalDebtUsd: 0, usdNet: 0, liquidationThreshold: null, notes: [] }, asOfTime: 0, asOfBlock: null },
      nado: { status: 'OK', data: book, asOfTime: 0, asOfBlock: null },
      asOfBlock: null,
      asOfTime: 0,
    });
    expect(p.primary).toBe('STABLE-BALLAST');
    expect(p.hullTemp).toBe('NOMINAL');
  });

  it('missing price → PARSE_FAIL, never a guessed number', () => {
    const broken = structuredClone(docsSample);
    broken.data.spot_products = [];
    const x = parseSubaccountInfo(broken, symbols);
    expect(x.ok).toBe(false);
    expect(!x.ok && x.error.code).toBe('PARSE_FAIL');
  });
});

describe('nado IO', () => {
  const cfg = (fetchImpl: (u: string, i?: RequestInit) => Promise<Response>) => ({ gatewayBase: '/g', archiveBase: '/a', fetch: fetchImpl });
  const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { 'content-type': 'application/json' } });

  it('symbols parse accepts object map', () => {
    const r = parseSymbols({ status: 'success', data: { symbols: { KBTC: { product_id: 1, symbol: 'KBTC', type: 'spot' } } } });
    expect(r.ok && r.value.get(1)?.symbol).toBe('KBTC');
    expect(r.ok && r.value.get(0)?.symbol).toBe('USDT0');
  });

  it('429 → RATE_LIMIT (dark, not zero)', async () => {
    const r = await readNado('0x8d7d64d6cf1d4f018dd101482ac71ad49e30c560', cfg(async () => new Response('slow down', { status: 429, headers: { 'retry-after': '30' } })));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.code).toBe('RATE_LIMIT');
    expect(!r.ok && r.error.retryAfterS).toBe(30);
  });

  it('archive failure falls back to default subaccount and says so', async () => {
    const r = await readNado('0x8d7d64d6cf1d4f018dd101482ac71ad49e30c560', cfg(async (u) => {
      if (u.includes('type=symbols')) return json({ status: 'success', data: { symbols: { KBTC: { product_id: 1, symbol: 'KBTC', type: 'spot' }, 'BTC-PERP': { product_id: 2, symbol: 'BTC-PERP', type: 'perp' } } } });
      if (u === '/a') return json({ error: 'nope' }, 500);
      if (u.includes('subaccount_info')) {
        expect(u).toContain(docsSample.data.subaccount);
        return json(docsSample);
      }
      throw new Error('unexpected ' + u);
    }));
    expect(r.ok).toBe(true);
    expect(r.ok && r.value.notes[0]).toMatch(/default' only/);
  });
});

describe('tydro reader (mock RPC)', () => {
  it('wrong chain → WRONG_CHAIN', async () => {
    const client = { getChainId: async () => 1 } as unknown as PublicClient;
    const r = await readTydro(client, '0x8d7d64d6cf1d4f018dd101482ac71ad49e30c560');
    expect(!r.ok && r.error.code).toBe('WRONG_CHAIN');
  });

  it('decodes HF, legs, and prices from multicall', async () => {
    const n = TYDRO_RESERVES.length;
    const prices = TYDRO_RESERVES.map((r) => (r.symbol === 'WETH' ? 4000n * 10n ** 8n : r.symbol === 'USDC' ? 10n ** 8n : 0n));
    const bals = TYDRO_RESERVES.flatMap((r) => {
      if (r.symbol === 'WETH') return [{ status: 'success', result: 75n * 10n ** 16n }, { status: 'success', result: 0n }];
      if (r.symbol === 'USDC') return [{ status: 'success', result: 0n }, { status: 'success', result: 1000n * 10n ** 6n }];
      return [{ status: 'success', result: 0n }, { status: 'success', result: 0n }];
    });
    const client = {
      getChainId: async () => 57073,
      getBlockNumber: async () => 123n,
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === 'getUserAccountData') return [3000n * 10n ** 8n, 1000n * 10n ** 8n, 0n, 7000n, 6500n, 21n * 10n ** 17n];
        if (functionName === 'getReservesList') return TYDRO_RESERVES.map((r) => r.underlying);
        if (functionName === 'BASE_CURRENCY_UNIT') return 10n ** 8n;
        if (functionName === 'getAssetsPrices') return prices;
        throw new Error(functionName);
      },
      multicall: async () => bals,
    } as unknown as PublicClient;
    const r = await readTydro(client, '0x8d7d64d6cf1d4f018dd101482ac71ad49e30c560');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.block).toBe(120); // 3 blocks behind the tip (stableHead);
    expect(r.value.book.hf).toBeCloseTo(2.1);
    expect(r.value.book.supplies[0]).toMatchObject({ symbol: 'WETH', family: 'ETH', priceSource: 'TYDRO_ORACLE' });
    expect(r.value.book.supplies[0]!.usd).toBeCloseTo(3000);
    expect(r.value.book.debts[0]!.usd).toBeCloseTo(1000);
    expect(r.value.book.liquidationThreshold).toBeCloseTo(0.7);
    expect(r.value.book.notes).toEqual([]);
    expect(n).toBeGreaterThan(5);
  });
});

describe('subaccounts that report exists=false (census v1.2)', () => {
  const sub = (exists: boolean, withPerp: boolean) => ({
    subaccount: `0x${'ab'.repeat(20)}0000020069736f0000000000`,
    exists,
    spots: [],
    perps: withPerp
      ? [{ productId: 2, subaccount: 'x', symbol: 'BTC-PERP', family: 'BTC', assetClass: 'CRYPTO', sizeBase: 0.05, notionalUsd: 5000, priceUsd: 100000, priceSource: 'NADO_ONCHAIN', vQuoteUsd: -5000, unsettledUsd: 0 }]
      : [],
    initial: null,
    maintenance: null,
    unweighted: null,
  });
  it('a subaccount holding a position is counted even when the chain says exists=false', () => {
    const book = aggregate([sub(false, true) as never], []);
    expect(book.perps).toHaveLength(1);
    expect(book.notes.some((n) => n.includes('exists=false'))).toBe(true);
  });
  it('an empty subaccount that does not exist is still ignored', () => {
    const book = aggregate([sub(false, false) as never], []);
    expect(book.subaccounts).toHaveLength(0);
  });
});
