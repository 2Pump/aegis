import type { PublicClient } from 'viem';
import { multicallAdaptive, type Call } from './batch.js';
import { NADO_CONTRACTS, NADO_PRODUCTS, QUERIER_GET_SUBACCOUNT_INFO_ABI } from './nado-registry.js';
import { Err, Ok, errMessage, type Result } from './result.js';
import type { TydroPrices } from './tydro-batch.js';
import { TYDRO_RESERVES } from './tydro-registry.js';

/**
 * Protocol-wide totals, read on-chain at one block — the yardstick for census coverage.
 *  - Tydro: aToken.totalSupply() (all supplied) and variableDebtToken.totalSupply() (all borrowed), per reserve.
 *  - Nado:  FQuerier.getSubaccountInfo(any subaccount) returns every product with its on-chain state:
 *           spot  → totalDepositsNormalized × cumulativeDepositsMultiplierX18 (and the same for borrows)
 *           perp  → openInterest
 *           All Nado amounts are 18-decimal fixed point, whatever the token's own decimals.
 * Read-only `view` calls, same contracts the hull page already uses.
 */
export interface ProtocolTotals {
  block: number;
  tydro: Array<{ symbol: string; priceUsd: number; supplied: number; borrowed: number }>;
  nadoSpot: Array<{ productId: number; label: string; priceUsd: number; deposits: number; borrows: number }>;
  nadoPerp: Array<{ productId: number; label: string; priceUsd: number; openInterest: number }>;
}

const supplyAbi = [{ type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }] as const;

interface RawSpotProduct {
  productId: number;
  oraclePriceX18: bigint;
  state: { cumulativeDepositsMultiplierX18: bigint; cumulativeBorrowsMultiplierX18: bigint; totalDepositsNormalized: bigint; totalBorrowsNormalized: bigint };
}
interface RawPerpProduct {
  productId: number;
  oraclePriceX18: bigint;
  state: { openInterest: bigint };
}

const X18 = 10n ** 18n;
const f18 = (x: bigint) => Number(x) / 1e18;

export async function readProtocolTotals(
  client: PublicClient,
  blockNumber: bigint,
  opts: { tydroPrices: TydroPrices; nadoSub: `0x${string}` },
): Promise<Result<ProtocolTotals>> {
  try {
    // Tydro: 2 × totalSupply per reserve
    const calls: Call[] = TYDRO_RESERVES.flatMap((r) => [
      { address: r.aToken, abi: supplyAbi, functionName: 'totalSupply' },
      { address: r.vToken, abi: supplyAbi, functionName: 'totalSupply' },
    ]);
    const res = await multicallAdaptive(client, calls, { blockNumber, chunk: 60 });
    const tydro: ProtocolTotals['tydro'] = [];
    TYDRO_RESERVES.forEach((r, i) => {
      const a = res[i * 2]!, v = res[i * 2 + 1]!;
      if (!a.ok || !v.ok) throw new Error(`Tydro totalSupply ${r.symbol}: ${!a.ok ? a.error : !v.ok ? v.error : ''}`);
      const d = 10 ** r.decimals;
      tydro.push({
        symbol: r.symbol === 'USDT' ? 'USDT0' : r.symbol, // same display rename as the wallet legs
        priceUsd: opts.tydroPrices.usd[i] ?? 0,
        supplied: Number(a.value as bigint) / d,
        borrowed: Number(v.value as bigint) / d,
      });
    });

    // Nado: one Querier call carries every product's state
    const info = (await client.readContract({
      address: NADO_CONTRACTS.querier,
      abi: QUERIER_GET_SUBACCOUNT_INFO_ABI as never,
      functionName: 'getSubaccountInfo' as never,
      args: [opts.nadoSub] as never,
      blockNumber,
    })) as unknown as { spotProducts: readonly RawSpotProduct[]; perpProducts: readonly RawPerpProduct[] };

    const label = (id: number, kind: 'spot' | 'perp') => `${kind} ${id}${NADO_PRODUCTS.get(id)?.symbol ? ` ${NADO_PRODUCTS.get(id)!.symbol}` : ''}`;
    const nadoSpot = info.spotProducts.map((p) => ({
      productId: p.productId,
      label: label(p.productId, 'spot'),
      priceUsd: f18(p.oraclePriceX18),
      deposits: f18((p.state.totalDepositsNormalized * p.state.cumulativeDepositsMultiplierX18) / X18),
      borrows: f18((p.state.totalBorrowsNormalized * p.state.cumulativeBorrowsMultiplierX18) / X18),
    }));
    const nadoPerp = info.perpProducts.map((p) => ({
      productId: p.productId,
      label: label(p.productId, 'perp'),
      priceUsd: f18(p.oraclePriceX18),
      openInterest: f18(p.state.openInterest),
    }));
    return Ok({ block: Number(blockNumber), tydro, nadoSpot, nadoPerp });
  } catch (e) {
    return Err('RPC_DEAD', `protocol totals: ${errMessage(e)}`);
  }
}
