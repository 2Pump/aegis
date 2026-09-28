import { familyOf, type Leg, type TydroBook } from '@aegis/pose';
import type { Address, PublicClient } from 'viem';
import { INK_CHAIN_ID } from './chain.js';
import { Err, Ok, errMessage, type Result } from './result.js';
import { TYDRO, TYDRO_RESERVES } from './tydro-registry.js';

/* Read-only ABI fragments. There is deliberately no write function in this file. */
const poolAbi = [
  {
    type: 'function',
    name: 'getUserAccountData',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [
      { name: 'totalCollateralBase', type: 'uint256' },
      { name: 'totalDebtBase', type: 'uint256' },
      { name: 'availableBorrowsBase', type: 'uint256' },
      { name: 'currentLiquidationThreshold', type: 'uint256' },
      { name: 'ltv', type: 'uint256' },
      { name: 'healthFactor', type: 'uint256' },
    ],
  },
  { type: 'function', name: 'getReservesList', stateMutability: 'view', inputs: [], outputs: [{ type: 'address[]' }] },
] as const;

const oracleAbi = [
  { type: 'function', name: 'BASE_CURRENCY_UNIT', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  {
    type: 'function',
    name: 'getAssetsPrices',
    stateMutability: 'view',
    inputs: [{ name: 'assets', type: 'address[]' }],
    outputs: [{ type: 'uint256[]' }],
  },
] as const;

const erc20BalanceAbi = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

export interface TydroRead {
  book: TydroBook;
  block: number;
}

const toNum = (x: bigint, decimals: number) => Number(x) / 10 ** decimals;

/**
 * Reads one address's Tydro position.
 *  - HF, totals, LT: Pool.getUserAccountData (authoritative; this is what liquidators see)
 *  - per-reserve legs: aToken / variableDebtToken balanceOf, priced by AaveOracle.getAssetsPrices
 *  - Pool.getReservesList detects reserves missing from our registry → note on the plate
 */
export async function readTydro(client: PublicClient, user: Address): Promise<Result<TydroRead>> {
  try {
    const chainId = await client.getChainId();
    if (chainId !== INK_CHAIN_ID) return Err('WRONG_CHAIN', `RPC is chain ${chainId}, expected ${INK_CHAIN_ID}`);
    const blockNumber = await client.getBlockNumber();

    const reserves = TYDRO_RESERVES;
    const settle = <T>(p: Promise<T>): Promise<{ ok: true; v: T } | { ok: false; e: unknown }> =>
      p.then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));

    // Header reads (batched into one multicall by the client's batch.multicall setting).
    const [acct, list, unit, prices] = await Promise.all([
      settle(client.readContract({ address: TYDRO.POOL, abi: poolAbi, functionName: 'getUserAccountData', args: [user], blockNumber })),
      settle(client.readContract({ address: TYDRO.POOL, abi: poolAbi, functionName: 'getReservesList', blockNumber })),
      settle(client.readContract({ address: TYDRO.ORACLE, abi: oracleAbi, functionName: 'BASE_CURRENCY_UNIT', blockNumber })),
      settle(client.readContract({ address: TYDRO.ORACLE, abi: oracleAbi, functionName: 'getAssetsPrices', args: [reserves.map((r) => r.underlying)], blockNumber })),
    ]);
    if (!acct.ok) return Err('PARSE_FAIL', `getUserAccountData failed: ${errMessage(acct.e)}`);
    if (!unit.ok) return Err('PARSE_FAIL', `Oracle BASE_CURRENCY_UNIT failed: ${errMessage(unit.e)}`);
    if (!prices.ok) return Err('PARSE_FAIL', `Oracle getAssetsPrices failed: ${errMessage(prices.e)}`);

    // Per-reserve balances: aToken (supply) and variableDebtToken (debt) for every registry reserve.
    const bals = await client.multicall({
      contracts: reserves.flatMap((r) => [
        { address: r.aToken, abi: erc20BalanceAbi, functionName: 'balanceOf' as const, args: [user] as const },
        { address: r.vToken, abi: erc20BalanceAbi, functionName: 'balanceOf' as const, args: [user] as const },
      ]),
      allowFailure: true,
      blockNumber,
    });

    const [totalCollateralBase, totalDebtBase, , ltBps, , healthFactor] = acct.v;
    const baseUnit = Number(unit.v);
    const priceArr = prices.v;

    const notes: string[] = [];
    const supplies: Leg[] = [];
    const debts: Leg[] = [];

    reserves.forEach((r, i) => {
      const a = bals[i * 2];
      const v = bals[i * 2 + 1];
      const price = Number(priceArr[i] ?? 0n) / baseUnit;
      const { family, assetClass } = familyOf(r.symbol);
      const symbol = r.symbol === 'USDT' ? 'USDT0' : r.symbol;
      if (!a || a.status !== 'success' || !v || v.status !== 'success') {
        notes.push(`${symbol}: balance read failed — leg omitted`);
        return;
      }
      const supplied = toNum(a.result, r.decimals);
      const borrowed = toNum(v.result, r.decimals);
      if (supplied > 0) supplies.push({ symbol, family, assetClass, amount: supplied, usd: supplied * price, priceUsd: price, priceSource: 'TYDRO_ORACLE' });
      if (borrowed > 0) debts.push({ symbol, family, assetClass, amount: borrowed, usd: borrowed * price, priceUsd: price, priceSource: 'TYDRO_ORACLE' });
    });

    if (list.ok) {
      const known = new Set(reserves.map((r) => r.underlying.toLowerCase()));
      const unknown = list.v.filter((x) => !known.has(x.toLowerCase()));
      if (unknown.length) notes.push(`${unknown.length} live Tydro reserve(s) not in registry — run scripts/sync-tydro-registry.mjs`);
    }

    const totalCollateralUsd = Number(totalCollateralBase) / baseUnit;
    const totalDebtUsd = Number(totalDebtBase) / baseUnit;
    const legDebt = debts.reduce((s, d) => s + d.usd, 0);
    if (totalDebtUsd > 1 && Math.abs(legDebt - totalDebtUsd) / totalDebtUsd > 0.01) {
      notes.push(`Σ debt legs ${legDebt.toFixed(2)} ≠ pool total ${totalDebtUsd.toFixed(2)} (>1%) — registry may be stale`);
    }
    const supplyUsd = supplies.reduce((s, x) => s + x.usd, 0);

    const book: TydroBook = {
      hf: totalDebtBase === 0n ? null : Number(healthFactor) / 1e18,
      supplies,
      debts,
      totalCollateralUsd,
      totalDebtUsd,
      usdNet: supplyUsd - legDebt,
      liquidationThreshold: ltBps > 0n ? Number(ltBps) / 10_000 : null,
      notes,
    };
    return Ok({ book, block: Number(blockNumber) });
  } catch (e) {
    return Err('RPC_DEAD', `Ink RPC: ${errMessage(e)}`);
  }
}
