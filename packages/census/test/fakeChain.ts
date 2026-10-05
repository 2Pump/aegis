import type { Log, PublicClient } from 'viem';
import { NADO_CONTRACTS, TOPIC, TYDRO, TYDRO_RESERVES, TYDRO_TOKENS, nadoSubaccount } from '@aegis/ink-io';

/**
 * A tiny in-memory Ink: serves eth_getLogs and the read calls Phrourax makes, and deliberately rejects
 * oversized requests (like real RPC nodes do) so the self-sizing code paths are exercised.
 */
export const U = {
  borrower: '0x1000000000000000000000000000000000000001', // Tydro: 1 kBTC supplied, 60k USDC borrowed, HF 1.45
  saver: '0x2000000000000000000000000000000000000002', // Tydro: 1,000 USDG supplied, no debt
  gone: '0x3000000000000000000000000000000000000003', // Tydro: supplied then withdrew → empty
  carry: '0x4000000000000000000000000000000000000004', // Nado: 0.1 KBTC spot + 0.1 BTC-PERP short
  quitter: '0x5000000000000000000000000000000000000005', // Nado: deposited then withdrew → empty
} as const;

const pad = (a: string) => `0x${a.slice(2).padStart(64, '0')}` as `0x${string}`;
const idxOf = (sym: string) => TYDRO_RESERVES.findIndex((r) => r.symbol === sym);
const e18 = 10n ** 18n;

export interface FakeOpts {
  head: number;
  maxLogRange?: number;
  maxMulticall?: number;
  /** block of the one sample Nado trade (default head − 100) */
  tradeAt?: number;
  /** borrower health factor × 100 (default 145 → 1.45) */
  borrowerHf100?: bigint;
  /** every Nth getLogs request fails like a throttled public RPC (HTTP 429) */
  rateLimitEvery?: number;
  /** getLogs always fails after this many successful requests (RPC gone) */
  dieAfter?: number;
  /** per-request gas budget: only this many calls in one multicall succeed; the rest fail individually (like out-of-gas) */
  gasCalls?: number;
  /** the saver also holds 1 WETH supplied long ago — no event for it in the scanned window */
  saverOldWeth?: boolean;
  /**
   * the CARRY owner also opened an isolated-margin BTC-PERP long at this block. Isolated subaccounts are created by
   * Nado's engine and funded from the main account — no ModifyCollateral, only trades (BalanceUpdate) name them.
   */
  isolatedTradeAt?: number;
  /** Endpoint.getNlpPools() lists one NLP pool, holding a 0.05 BTC-PERP long (otherwise the list is empty) */
  nlpPool?: boolean;
  /**
   * a subaccount discovery never saw: it only appears in a Nado-only SpotBalance event (which discovery doesn't scan),
   * near head, and holds a 0.05 BTC-PERP long
   */
  missedSub?: boolean;
}

export const MISSED_SUB = `0x6000000000000000000000000000000000000006${'64656661756c740000000000'}`.toLowerCase() as `0x${string}`;

/** The NLP pool's subaccount in the fake chain: owner + name "nlp" (made-up test values, never published). */
export const NLP_OWNER = '0x00000000000000000000000000000000000a11ce';
export const NLP_SUB = `${NLP_OWNER}6e6c700000000000000000000000`.toLowerCase() as `0x${string}`;

/** Isolated subaccount of the CARRY owner: name bytes 00 00 02 00 "iso" (layout from the Nado SDK bytes32 tests). */
export const ISO_SUB = `${U.carry}0000020069736f0000000000`.toLowerCase() as `0x${string}`;

export function fakeChain(o: FakeOpts) {
  const stats = { getLogs: 0, getLogsRejected: 0, multicalls: 0, multicallRejected: 0, subaccountInfoCalls: 0, isolatedReads: 0 };
  const logs: Log[] = [];
  const mkLog = (address: string, topics: `0x${string}`[], data: `0x${string}`, block: number) =>
    logs.push({ address: address as `0x${string}`, topics: topics as never, data, blockNumber: BigInt(block) } as unknown as Log);

  // Tydro history
  const kbtc = idxOf('kBTC'), usdc = idxOf('USDC'), usdg = idxOf('USDG'), weth = idxOf('WETH');
  const zero = pad('0x0000000000000000000000000000000000000000');
  mkLog(TYDRO_TOKENS[kbtc * 2]!, [TOPIC.transfer, zero, pad(U.borrower)], '0x', 20_000_100);
  mkLog(TYDRO_TOKENS[usdc * 2 + 1]!, [TOPIC.transfer, zero, pad(U.borrower)], '0x', 20_000_200);
  mkLog(TYDRO_TOKENS[usdg * 2]!, [TOPIC.transfer, zero, pad(U.saver)], '0x', 25_000_000);
  mkLog(TYDRO_TOKENS[weth * 2]!, [TOPIC.transfer, zero, pad(U.gone)], '0x', 26_000_000);
  mkLog(TYDRO_TOKENS[weth * 2]!, [TOPIC.transfer, pad(U.gone), zero], '0x', 26_000_500);

  // Nado history
  const sCarry = nadoSubaccount(U.carry);
  const sQuit = nadoSubaccount(U.quitter);
  mkLog(NADO_CONTRACTS.clearinghouse, [TOPIC.modifyCollateral, sCarry], '0x', 30_000_000);
  mkLog(NADO_CONTRACTS.clearinghouse, [TOPIC.modifyCollateral, sQuit], '0x', 31_000_000);
  // a trade near head (BalanceUpdate: data = abi.encode(uint32 productId, bytes32 subaccount))
  mkLog(NADO_CONTRACTS.perpEngine, [TOPIC.balanceUpdate], `0x${(2).toString(16).padStart(64, '0')}${sCarry.slice(2)}`, o.tradeAt ?? o.head - 100);

  if (o.missedSub) mkLog(NADO_CONTRACTS.spotEngine, [TOPIC.spotBalance, MISSED_SUB, pad('0x0')], `0x${'0'.repeat(128)}`, o.head - 50);
  if (o.isolatedTradeAt) mkLog(NADO_CONTRACTS.perpEngine, [TOPIC.balanceUpdate], `0x${(2).toString(16).padStart(64, '0')}${ISO_SUB.slice(2)}`, o.isolatedTradeAt);

  const prices = TYDRO_RESERVES.map((r) => (r.symbol === 'kBTC' ? 100_000n : r.symbol === 'WETH' ? 4_000n : 1n) * 10n ** 8n);
  const tydroBal = (token: string, user: string): bigint => {
    const t = token.toLowerCase(), u = user.toLowerCase();
    if (u === U.borrower && t === TYDRO_TOKENS[kbtc * 2]!.toLowerCase()) return 1n * 10n ** 8n;
    if (u === U.borrower && t === TYDRO_TOKENS[usdc * 2 + 1]!.toLowerCase()) return 60_000n * 10n ** 6n;
    if (u === U.saver && t === TYDRO_TOKENS[usdg * 2]!.toLowerCase()) return 1_000n * 10n ** 6n;
    if (o.saverOldWeth && u === U.saver && t === TYDRO_TOKENS[weth * 2]!.toLowerCase()) return 10n ** 18n;
    return 0n;
  };
  const acct = (user: string): bigint[] => {
    const u = user.toLowerCase();
    if (u === U.borrower) return [100_000n * 10n ** 8n, 60_000n * 10n ** 8n, 0n, 8700n, 8000n, (o.borrowerHf100 ?? 145n) * 10n ** 16n];
    if (u === U.saver) return [(o.saverOldWeth ? 5_000n : 1_000n) * 10n ** 8n, 0n, 0n, 7500n, 7000n, 2n ** 256n - 1n];
    return [0n, 0n, 0n, 0n, 0n, 2n ** 256n - 1n];
  };
  const health = (sub: string, type: number): bigint =>
    sub.toLowerCase() === sCarry ? (type === 1 ? 9_400n * e18 : 10_000n * e18) : o.missedSub && sub.toLowerCase() === MISSED_SUB ? (type === 1 ? 400n * e18 : 500n * e18) : o.isolatedTradeAt && sub.toLowerCase() === ISO_SUB ? (type === 1 ? 400n * e18 : 500n * e18) : 0n;
  const subInfo = (sub: string) => {
    if (o.missedSub && sub.toLowerCase() === MISSED_SUB) {
      return {
        subaccount: MISSED_SUB,
        exists: true,
        healths: [
          { assets: 500n * e18, liabilities: 0n, health: 450n * e18 },
          { assets: 500n * e18, liabilities: 0n, health: 400n * e18 },
          { assets: 500n * e18, liabilities: 0n, health: 500n * e18 },
        ],
        healthContributions: [],
        spotCount: 0,
        perpCount: 1,
        spotBalances: [],
        perpBalances: [{ productId: 2, balance: { amount: e18 / 20n, vQuoteBalance: -5_000n * e18, lastCumulativeFundingX18: 0n } }],
        spotProducts: [],
        perpProducts: [{ productId: 2, oraclePriceX18: 100_000n * e18, state: { openInterest: e18 / 5n } }],
      };
    }
    if (o.nlpPool && sub.toLowerCase() === NLP_SUB) {
      return {
        subaccount: NLP_SUB,
        exists: true,
        healths: [
          { assets: 500n * e18, liabilities: 0n, health: 450n * e18 },
          { assets: 500n * e18, liabilities: 0n, health: 400n * e18 },
          { assets: 500n * e18, liabilities: 0n, health: 500n * e18 },
        ],
        healthContributions: [],
        spotCount: 0,
        perpCount: 1,
        spotBalances: [],
        perpBalances: [{ productId: 2, balance: { amount: e18 / 20n, vQuoteBalance: -5_000n * e18, lastCumulativeFundingX18: 0n } }],
        spotProducts: [],
        perpProducts: [{ productId: 2, oraclePriceX18: 100_000n * e18, state: { openInterest: e18 / 5n } }],
      };
    }
    if (o.isolatedTradeAt && sub.toLowerCase() === ISO_SUB) {
      stats.subaccountInfoCalls++;
      stats.isolatedReads++;
      return {
        subaccount: ISO_SUB,
        // engine-created isolated subaccount: holds a position, yet reports exists=false (the v1.2 finding)
        exists: false,
        healths: [
          { assets: 500n * e18, liabilities: 0n, health: 450n * e18 },
          { assets: 500n * e18, liabilities: 0n, health: 400n * e18 },
          { assets: 500n * e18, liabilities: 0n, health: 500n * e18 },
        ],
        healthContributions: [],
        spotCount: 1,
        perpCount: 1,
        spotBalances: [{ productId: 0, balance: { amount: 500n * e18 } }],
        perpBalances: [{ productId: 2, balance: { amount: e18 / 20n, vQuoteBalance: -5_000n * e18, lastCumulativeFundingX18: 0n } }],
        spotProducts: [
          { productId: 0, oraclePriceX18: e18, state: { cumulativeDepositsMultiplierX18: e18, cumulativeBorrowsMultiplierX18: e18, totalDepositsNormalized: 500n * e18, totalBorrowsNormalized: 0n } },
        ],
        perpProducts: [{ productId: 2, oraclePriceX18: 100_000n * e18, state: { openInterest: e18 / 5n } }],
      };
    }
    if (sub.toLowerCase() !== sCarry) throw new Error('fake: getSubaccountInfo called for an empty subaccount (health filter should have skipped it)');
    stats.subaccountInfoCalls++;
    return {
      subaccount: sCarry,
      exists: true,
      healths: [
        { assets: 9_500n * e18, liabilities: 200n * e18, health: 9_300n * e18 },
        { assets: 9_700n * e18, liabilities: 300n * e18, health: 9_400n * e18 },
        { assets: 10_000n * e18, liabilities: 0n, health: 10_000n * e18 },
      ],
      healthContributions: [],
      spotCount: 1,
      perpCount: 1,
      spotBalances: [{ productId: 1, balance: { amount: e18 / 10n } }],
      perpBalances: [{ productId: 2, balance: { amount: -(e18 / 10n), vQuoteBalance: 10_000n * e18, lastCumulativeFundingX18: 0n } }],
      // protocol-wide state: 0.2 KBTC deposited in total (we know 0.1), perp OI 0.2 BTC (Nado counts both sides: 0.1 long + 0.1 short)
      spotProducts: [
        {
          productId: 1,
          oraclePriceX18: 100_000n * e18,
          state: { cumulativeDepositsMultiplierX18: e18, cumulativeBorrowsMultiplierX18: e18, totalDepositsNormalized: e18 / 5n, totalBorrowsNormalized: 0n },
        },
      ],
      perpProducts: [{ productId: 2, oraclePriceX18: 100_000n * e18, state: { openInterest: e18 / 5n } }],
    };
  };

  const call = (c: { address: string; functionName: string; args?: readonly unknown[] }): unknown => {
    switch (c.functionName) {
      case 'getUserAccountData':
        return acct(c.args![0] as string);
      case 'balanceOf':
        return tydroBal(c.address, c.args![0] as string);
      case 'getHealth':
        return health(c.args![0] as string, Number(c.args![1]));
      case 'getSubaccountInfo':
        return subInfo(c.args![0] as string);
      case 'totalSupply': {
        // all of Tydro: 1.25 kBTC supplied (we know 1), 1,000 USDG (all known), 60k USDC borrowed (all known)
        const t = c.address.toLowerCase();
        if (t === TYDRO_TOKENS[kbtc * 2]!.toLowerCase()) return 125n * 10n ** 6n;
        if (t === TYDRO_TOKENS[usdg * 2]!.toLowerCase()) return 1_000n * 10n ** 6n;
        if (t === TYDRO_TOKENS[usdc * 2 + 1]!.toLowerCase()) return 60_000n * 10n ** 6n;
        return 0n;
      }
      case 'BASE_CURRENCY_UNIT':
        return 10n ** 8n;
      case 'getAssetsPrices':
        return prices;
      case 'getNlpPools':
        return o.nlpPool ? [{ poolId: 0n, subaccount: NLP_SUB, owner: NLP_OWNER, balanceWeightX18: e18 }] : [];
      default:
        throw new Error(`fake: unknown call ${c.functionName}`);
    }
  };

  const client = {
    getChainId: async () => 57073,
    getBlockNumber: async () => BigInt(o.head),
    readContract: async (c: never) => call(c),
    multicall: async ({ contracts }: { contracts: Array<{ address: string; functionName: string; args?: unknown[] }> }) => {
      stats.multicalls++;
      if (o.maxMulticall && contracts.length > o.maxMulticall) {
        stats.multicallRejected++;
        throw new Error('fake: execution reverted: out of gas (multicall too big)');
      }
      return contracts.map((c, idx) => {
        if (o.gasCalls !== undefined && idx >= o.gasCalls) return { status: 'failure', error: new Error('The contract function reverted.') };
        try {
          return { status: 'success', result: call(c) };
        } catch (e) {
          return { status: 'failure', error: e };
        }
      });
    },
    request: async ({ method, params }: { method: string; params: Array<{ address: string | string[]; topics: unknown[]; fromBlock: string; toBlock: string }> }) => {
      if (method !== 'eth_getLogs') throw new Error(`fake: ${method}`);
      stats.getLogs++;
      if (o.rateLimitEvery && stats.getLogs % o.rateLimitEvery === 0) {
        stats.getLogsRejected++;
        throw Object.assign(new Error('HTTP request failed.'), { shortMessage: 'HTTP request failed.', status: 429, details: 'Too Many Requests' });
      }
      if (o.dieAfter !== undefined && stats.getLogs > o.dieAfter) {
        throw Object.assign(new Error('HTTP request failed.'), { shortMessage: 'HTTP request failed.', status: 503 });
      }
      const p = params[0]!;
      const from = parseInt(p.fromBlock, 16), to = parseInt(p.toBlock, 16);
      if (o.maxLogRange && to - from + 1 > o.maxLogRange) {
        stats.getLogsRejected++;
        // exact wording the public Gelato RPC returned on Brandon's machine (2026-09-28)
        throw Object.assign(new Error('RPC Request failed.'), {
          shortMessage: 'RPC Request failed.',
          code: -32602,
          details: `block range greater than ${o.maxLogRange} max`,
        });
      }
      const addrs = (Array.isArray(p.address) ? p.address : [p.address]).map((a) => a.toLowerCase());
      const t0 = p.topics[0];
      const t0s = Array.isArray(t0) ? t0 : [t0];
      return logs.filter((l) => {
        const b = Number(l.blockNumber);
        return b >= from && b <= to && addrs.includes(l.address.toLowerCase()) && t0s.includes(l.topics[0]);
      });
    },
  } as unknown as PublicClient;

  return { client, stats, subs: { sCarry, sQuit } };
}

export const TYDRO_POOL = TYDRO.POOL;
