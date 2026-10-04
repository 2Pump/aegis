import { describe, expect, it } from 'vitest';
import { decodeFunctionResult, encodeFunctionResult, type PublicClient } from 'viem';
import { NADO_CONTRACTS, QUERIER_GET_SUBACCOUNT_INFO_ABI } from '../src/nado-registry.js';
import { readNadoChain } from '../src/nado-chain.js';
import { nadoSubaccount } from '../src/index.js';

const ADDR = '0x8d7d64d6cf1d4f018dd101482ac71ad49e30c560';
const SUB = nadoSubaccount(ADDR);
const r = { longWeightInitialX18: 0n, shortWeightInitialX18: 0n, longWeightMaintenanceX18: 0n, shortWeightMaintenanceX18: 0n, priceX18: 0n };
const book = { sizeIncrement: 0n, priceIncrementX18: 0n, minSize: 0n, collectedFees: 0n };

/** Same numbers as Nado's documented subaccount_info example, but as the on-chain FQuerier struct. */
function info(exists = true) {
  return {
    subaccount: SUB,
    exists,
    healths: [
      { assets: 456895621098158389211471n, liabilities: 76286259844766495292488n, health: 380609361253391893918983n },
      { assets: 456895621098158389211471n, liabilities: 72818702579095290924243n, health: 384076918519063098287228n },
      { assets: 456895621098158389211471n, liabilities: 69351145313424086671554n, health: 387544475784734302539917n },
    ],
    healthContributions: [],
    spotCount: 2,
    perpCount: 1,
    spotBalances: [
      { productId: 0, balance: { amount: 456895621098158389211471n } },
      { productId: 1, balance: { amount: -600152323366021154n } },
    ],
    perpBalances: [{ productId: 2, balance: { amount: -100000000000000000n, vQuoteBalance: 11559652809056535761117n, lastCumulativeFundingX18: 0n } }],
    spotProducts: [0, 1].map((productId) => ({
      productId,
      oraclePriceX18: productId === 0 ? 10n ** 18n : 115596528090565357611177n,
      risk: r,
      config: { token: NADO_CONTRACTS.quote, interestInflectionUtilX18: 0n, interestFloorX18: 0n, interestSmallCapX18: 0n, interestLargeCapX18: 0n, withdrawFeeX18: 0n, minDepositRateX18: 0n },
      state: { cumulativeDepositsMultiplierX18: 0n, cumulativeBorrowsMultiplierX18: 0n, totalDepositsNormalized: 0n, totalBorrowsNormalized: 0n },
      bookInfo: book,
    })),
    perpProducts: [
      {
        productId: 2,
        oraclePriceX18: 115596528090565357611177n,
        risk: r,
        state: { cumulativeFundingLongX18: 0n, cumulativeFundingShortX18: 0n, availableSettle: 0n, openInterest: 0n },
        bookInfo: book,
      },
    ],
  };
}

/** A fake RPC that round-trips through the real ABI encoder/decoder, like a node would. */
function client(exists = true, chainId = 57073): PublicClient {
  return {
    getChainId: async () => chainId,
    getBlockNumber: async () => 999n,
    readContract: async (args: { address: string; functionName: string; args: readonly unknown[] }) => {
      expect(args.address).toBe(NADO_CONTRACTS.querier);
      expect(args.functionName).toBe('getSubaccountInfo');
      expect(args.args[0]).toBe(SUB);
      const data = encodeFunctionResult({ abi: QUERIER_GET_SUBACCOUNT_INFO_ABI, functionName: 'getSubaccountInfo', result: info(exists) as never });
      return decodeFunctionResult({ abi: QUERIER_GET_SUBACCOUNT_INFO_ABI, functionName: 'getSubaccountInfo', data });
    },
  } as unknown as PublicClient;
}

describe('Nado on-chain sensor (FQuerier)', () => {
  it('decodes the real ABI round-trip into the same book the gateway parser produces', async () => {
    const res = await readNadoChain(client(), ADDR);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const b = res.value.book;
    expect(res.value.block).toBe(996); // 3 blocks behind the tip (stableHead);
    const kbtc = b.spots.find((s) => s.symbol === 'KBTC')!;
    expect(kbtc.usd).toBeCloseTo(-69_375.52, 1);
    expect(kbtc.priceSource).toBe('NADO_ONCHAIN');
    const perp = b.perps[0]!;
    expect(perp.symbol).toBe('BTC-PERP');
    expect(perp.sizeBase).toBeCloseTo(-0.1, 9);
    expect(perp.notionalUsd).toBeCloseTo(-11_559.65, 1);
    expect(b.maintenance!.liabilitiesUsd).toBeCloseTo(72_818.7, 0);
    expect(b.notes.some((n) => n.includes('FQuerier'))).toBe(true);
  });

  it('exists=false but holding balances → OK, counted, and NOT called "no account" (not DARK, not invented)', async () => {
    const res = await readNadoChain(client(false), ADDR);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.book.notes).not.toContain('No Nado account for this address');
    expect(res.value.book.notes.join(' ')).toMatch(/exists=false on-chain but hold balances — counted/);
  });

  it('wrong chain → WRONG_CHAIN', async () => {
    const res = await readNadoChain(client(true, 1), ADDR);
    expect(!res.ok && res.error.code).toBe('WRONG_CHAIN');
  });
});
