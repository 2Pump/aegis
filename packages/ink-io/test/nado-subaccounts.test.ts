import { describe, expect, it } from 'vitest';
import { decodeFunctionResult, encodeFunctionResult, type PublicClient } from 'viem';
import { classify, shockBook, stressState, directionScenario, directionById, type Book } from '@aegis/pose';
import { NADO_CONTRACTS, QUERIER_GET_SUBACCOUNT_INFO_ABI } from '../src/nado-registry.js';
import { readNadoChain } from '../src/nado-chain.js';
import { TOPIC } from '../src/logs.js';
import { nadoSubaccount, subaccountKind } from '../src/index.js';

/*
 * Wallet-page reads of every Nado subaccount AEGIS knows of. Made-up wallets; the FQuerier struct round-trips through
 * the real ABI like a node's reply would.
 */
const OWNER = '0x1111111111111111111111111111111111111111';
const DEF = nadoSubaccount(OWNER);
const ISO1 = `${OWNER}0000020069736f0000000000` as const;
const ISO2 = `${OWNER}0000050069736f0000000000` as const;
const FOREIGN = `0x2222222222222222222222222222222222222222${'0000020069736f0000000000'}`;
const e18 = 10n ** 18n;
const r = { longWeightInitialX18: 0n, shortWeightInitialX18: 0n, longWeightMaintenanceX18: (95n * e18) / 100n, shortWeightMaintenanceX18: (105n * e18) / 100n, priceX18: 0n };
const book = { sizeIncrement: 0n, priceIncrementX18: 0n, minSize: 0n, collectedFees: 0n };

interface SubSpec {
  usdt0: bigint; // whole USDT0
  btc?: bigint; // BTC-PERP size, in 1/100 BTC (signed)
  vq?: bigint; // whole USD
  health: bigint; // maintenance health, whole USD
  assets: bigint;
}

function info(sub: string, s: SubSpec) {
  const spotBalances = s.usdt0 ? [{ productId: 0, balance: { amount: s.usdt0 * e18 } }] : [];
  const perpBalances = s.btc ? [{ productId: 2, balance: { amount: (s.btc * e18) / 100n, vQuoteBalance: (s.vq ?? 0n) * e18, lastCumulativeFundingX18: 0n } }] : [];
  const h = { assets: s.assets * e18, liabilities: (s.assets - s.health) * e18, health: s.health * e18 };
  return {
    subaccount: sub,
    exists: true,
    healths: [h, h, h],
    healthContributions: [],
    spotCount: spotBalances.length,
    perpCount: perpBalances.length,
    spotBalances,
    perpBalances,
    spotProducts: [{ productId: 0, oraclePriceX18: e18, risk: { ...r, longWeightMaintenanceX18: e18, shortWeightMaintenanceX18: e18 }, config: { token: NADO_CONTRACTS.quote, interestInflectionUtilX18: 0n, interestFloorX18: 0n, interestSmallCapX18: 0n, interestLargeCapX18: 0n, withdrawFeeX18: 0n, minDepositRateX18: 0n }, state: { cumulativeDepositsMultiplierX18: 0n, cumulativeBorrowsMultiplierX18: 0n, totalDepositsNormalized: 0n, totalBorrowsNormalized: 0n }, bookInfo: book }],
    perpProducts: [{ productId: 2, oraclePriceX18: 100_000n * e18, risk: r, state: { cumulativeFundingLongX18: 0n, cumulativeFundingShortX18: 0n, availableSettle: 0n, openInterest: 0n }, bookInfo: book }],
  };
}

const EMPTY: SubSpec = { usdt0: 0n, health: 0n, assets: 0n };

function client(subs: Record<string, SubSpec | 'FAIL'>, logs: Array<{ sub: string; block: number }> = [], seen: string[] = []): PublicClient {
  return {
    getChainId: async () => 57073,
    getBlockNumber: async () => 1_003n, // stableHead → 1000
    readContract: async (args: { args: readonly unknown[] }) => {
      const sub = String(args.args[0]).toLowerCase();
      seen.push(sub);
      const spec = subs[sub] ?? EMPTY;
      if (spec === 'FAIL') throw new Error('execution reverted (fake)');
      const data = encodeFunctionResult({ abi: QUERIER_GET_SUBACCOUNT_INFO_ABI, functionName: 'getSubaccountInfo', result: info(sub, spec) as never });
      return decodeFunctionResult({ abi: QUERIER_GET_SUBACCOUNT_INFO_ABI, functionName: 'getSubaccountInfo', data });
    },
    request: async ({ params }: { params: Array<{ fromBlock: string; toBlock: string }> }) => {
      const from = parseInt(params[0]!.fromBlock, 16), to = parseInt(params[0]!.toBlock, 16);
      return logs
        .filter((l) => l.block >= from && l.block <= to)
        .map((l) => ({ address: NADO_CONTRACTS.perpEngine, topics: [TOPIC.balanceUpdate], data: `0x${(2).toString(16).padStart(64, '0')}${l.sub.slice(2)}`, blockNumber: BigInt(l.block) }));
    },
  } as unknown as PublicClient;
}

const asBook = (n: Awaited<ReturnType<typeof readNadoChain>>): Book => {
  if (!n.ok) throw new Error(n.error.message);
  return {
    address: OWNER,
    source: 'LIVE',
    tydro: { status: 'OK', asOfTime: 0, asOfBlock: 1, data: { hf: null, supplies: [], debts: [], totalCollateralUsd: 0, totalDebtUsd: 0, usdNet: 0, liquidationThreshold: null, notes: [] } },
    nado: { status: 'OK', asOfTime: 0, asOfBlock: 1, data: n.value.book },
    asOfBlock: 1,
    asOfTime: 0,
  };
};

describe('Nado subaccounts on wallet pages', () => {
  it('kinds come from the 12-byte name: default, isolated ("iso"), other', () => {
    expect(subaccountKind(DEF)).toBe('default');
    expect(subaccountKind(ISO1)).toBe('isolated');
    expect(subaccountKind(nadoSubaccount(OWNER, 'savings'))).toBe('other');
  });

  it('no discovery → default only, PARTIAL, and says why', async () => {
    const seen: string[] = [];
    const r = await readNadoChain(client({ [DEF]: { usdt0: 1000n, health: 1000n, assets: 1000n } }, [], seen), OWNER, undefined, null);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(seen).toEqual([DEF]);
    expect(r.value.book.coverage?.status).toBe('PARTIAL');
    expect(r.value.book.coverage?.why.join(' ')).toMatch(/only the default subaccount/);
  });

  it('default only, with discovery current → COMPLETE', async () => {
    const r = await readNadoChain(client({ [DEF]: { usdt0: 1000n, health: 1000n, assets: 1000n } }), OWNER, undefined, { subs: [], throughBlock: 1000 });
    expect(r.ok && r.value.book.coverage?.status).toBe('COMPLETE');
  });

  it('multiple isolated subaccounts are all read, once each (no double counting), foreign ones never', async () => {
    const seen: string[] = [];
    const subs = {
      [DEF]: { usdt0: 10_000n, health: 10_000n, assets: 10_000n },
      [ISO1]: { usdt0: 600n, btc: 5n, vq: -5_000n, health: 350n, assets: 600n },
      [ISO2]: { usdt0: 900n, btc: -5n, vq: 5_000n, health: 650n, assets: 900n },
    };
    const r = await readNadoChain(client(subs, [], seen), OWNER, undefined, { subs: [ISO1, ISO2, ISO1, FOREIGN], throughBlock: 1000 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(seen.sort()).toEqual([DEF, ISO1, ISO2].sort());
    const b = r.value.book;
    expect(b.perps).toHaveLength(2);
    expect(b.coverage?.subs.map((x) => x.kind).sort()).toEqual(['default', 'isolated', 'isolated']);
    expect(b.coverage?.status).toBe('COMPLETE');
    expect(b.notes.join(' ')).toMatch(/default \+ 2 isolated/);
  });

  it('healthy default + endangered isolated: the worst subaccount drives the risk, not the healthy total', async () => {
    const subs = {
      [DEF]: { usdt0: 50_000n, health: 50_000n, assets: 50_000n },
      [ISO1]: { usdt0: 600n, btc: 5n, vq: -5_000n, health: 30n, assets: 600n }, // 5% buffer → near liquidation
    };
    const r = await readNadoChain(client(subs), OWNER, undefined, { subs: [ISO1], throughBlock: 1000 });
    const b = asBook(r);
    const pose = classify(b);
    expect(pose.hullTemp).toBe('CRITICAL');
    // aggregate equity looks huge, yet the isolated subaccount is the one at risk
    expect(b.nado.status === 'OK' && b.nado.data.subHealth?.length).toBe(2);
  });

  it('endangered default + healthy isolated: still CRITICAL', async () => {
    const subs = {
      [DEF]: { usdt0: 1_000n, btc: 2n, vq: -2_000n, health: 40n, assets: 1_000n },
      [ISO1]: { usdt0: 5_000n, btc: -1n, vq: 1_000n, health: 4_000n, assets: 5_000n },
    };
    expect(classify(asBook(await readNadoChain(client(subs), OWNER, undefined, { subs: [ISO1], throughBlock: 1000 }))).hullTemp).toBe('CRITICAL');
  });

  it('scenarios run per subaccount: a BTC drop liquidates the isolated long while the default stays fine', async () => {
    const subs = {
      [DEF]: { usdt0: 50_000n, health: 50_000n, assets: 50_000n },
      [ISO1]: { usdt0: 1_000n, btc: 5n, vq: -5_000n, health: 750n, assets: 1_000n },
    };
    const b = asBook(await readNadoChain(client(subs), OWNER, undefined, { subs: [ISO1], throughBlock: 1000 }));
    expect(stressState(b).liquidatable).toBe(false);
    expect(stressState(shockBook(b, directionScenario(directionById('BTC')!, -20))).liquidatable).toBe(true);
  });

  it('one unreadable subaccount never silently disappears: the Nado reading fails and names it', async () => {
    const r = await readNadoChain(client({ [DEF]: { usdt0: 1000n, health: 1000n, assets: 1000n }, [ISO1]: 'FAIL' }), OWNER, undefined, { subs: [ISO1], throughBlock: 1000 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/isolated subaccount 0000020069736f/);
  });

  it('a subaccount opened after the census is found by scanning trades since, and the report stays COMPLETE', async () => {
    const seen: string[] = [];
    const subs = { [DEF]: { usdt0: 1000n, health: 1000n, assets: 1000n }, [ISO2]: { usdt0: 500n, btc: 1n, vq: -1_000n, health: 400n, assets: 500n } };
    const r = await readNadoChain(client(subs, [{ sub: ISO2, block: 995 }, { sub: FOREIGN, block: 996 }], seen), OWNER, undefined, { subs: [], throughBlock: 990 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(seen).toContain(ISO2);
    expect(seen).not.toContain(FOREIGN);
    expect(r.value.book.coverage?.status).toBe('COMPLETE');
  });

  it('a discovery list too old to bridge → PARTIAL, not a claim of completeness', async () => {
    const r = await readNadoChain(client({ [DEF]: { usdt0: 1000n, health: 1000n, assets: 1000n } }), OWNER, 100_000n, { subs: [], throughBlock: 1 });
    expect(r.ok && r.value.book.coverage?.status).toBe('PARTIAL');
  });
});
