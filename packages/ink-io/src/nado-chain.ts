import type { NadoBook } from '@aegis/pose';
import type { PublicClient } from 'viem';
import { nadoSubaccount } from './address.js';
import { INK_CHAIN_ID, isZeroData, stableHead } from './chain.js';
import { aggregate, parseSubaccountInfo } from './nado.js';
import { NADO_CONTRACTS, NADO_PRODUCTS, QUERIER_GET_SUBACCOUNT_INFO_ABI } from './nado-registry.js';
import { Err, Ok, errMessage, type Result } from './result.js';

/**
 * Nado read straight from the Ink chain via Nado's own FQuerier contract (read-only `view` call).
 * Why: Nado's HTTP API sits behind a Cloudflare challenge that only its own frontend passes
 * (verified 2026-09-28; SDK comment: "CORS set to the relevant frontend endpoint … will NOT work from other domains").
 * The chain has no such gate. Caveat: this is SETTLED state — it can trail app.nado.xyz by seconds while the
 * sequencer batches. Prices are the oracle prices last written on-chain.
 */
export interface NadoChainRead {
  book: NadoBook;
  block: number;
}

const s = (x: bigint | number | boolean | string) => String(x);

interface ChainHealth { assets: bigint; liabilities: bigint; health: bigint }
interface ChainInfo {
  subaccount: `0x${string}`;
  exists: boolean;
  healths: readonly ChainHealth[];
  spotBalances: readonly { productId: number; balance: { amount: bigint } }[];
  perpBalances: readonly { productId: number; balance: { amount: bigint; vQuoteBalance: bigint } }[];
  spotProducts: readonly { productId: number; oraclePriceX18: bigint }[];
  perpProducts: readonly { productId: number; oraclePriceX18: bigint }[];
}

/** viem struct → the same JSON shape the gateway returns, so one tested parser serves both. */
export function chainInfoToGatewayShape(info: ChainInfo): unknown {
  return {
    status: 'success',
    data: {
      subaccount: info.subaccount.toLowerCase(),
      exists: info.exists,
      healths: info.healths.map((h) => ({ assets: s(h.assets), liabilities: s(h.liabilities), health: s(h.health) })),
      spot_balances: info.spotBalances.map((b) => ({ product_id: b.productId, balance: { amount: s(b.balance.amount) } })),
      perp_balances: info.perpBalances.map((b) => ({
        product_id: b.productId,
        balance: { amount: s(b.balance.amount), v_quote_balance: s(b.balance.vQuoteBalance) },
      })),
      spot_products: info.spotProducts.map((p) => ({ product_id: p.productId, oracle_price_x18: s(p.oraclePriceX18) })),
      perp_products: info.perpProducts.map((p) => ({ product_id: p.productId, oracle_price_x18: s(p.oraclePriceX18) })),
    },
  };
}

export async function readNadoChain(client: PublicClient, address: string, blockNumber?: bigint): Promise<Result<NadoChainRead>> {
  const first = await readNadoChainAt(client, address, blockNumber);
  if (!first.ok && blockNumber === undefined && isZeroData(first.error.message)) {
    return readNadoChainAt(client, address, await stableHead(client, 20n));
  }
  return first;
}

async function readNadoChainAt(client: PublicClient, address: string, blockNumber?: bigint): Promise<Result<NadoChainRead>> {
  try {
    const chainId = await client.getChainId();
    if (chainId !== INK_CHAIN_ID) return Err('WRONG_CHAIN', `RPC is chain ${chainId}, expected ${INK_CHAIN_ID}`);
    const block = blockNumber ?? (await stableHead(client));
    const sub = nadoSubaccount(address, 'default');
    const info = (await client.readContract({
      address: NADO_CONTRACTS.querier,
      abi: QUERIER_GET_SUBACCOUNT_INFO_ABI,
      functionName: 'getSubaccountInfo',
      args: [sub],
      blockNumber: block,
    })) as unknown as ChainInfo;

    const parsed = parseSubaccountInfo(chainInfoToGatewayShape(info), NADO_PRODUCTS, 'NADO_ONCHAIN');
    if (!parsed.ok) return parsed;

    const notes: string[] = [
      'Read from Ink chain via Nado FQuerier (settled state; may trail app.nado.xyz by seconds)',
      "Only the 'default' subaccount is read — isolated positions are not shown yet",
    ];
    if (!parsed.value.exists) notes.push('No Nado account for this address');
    const unknown = [...parsed.value.spots, ...parsed.value.perps].filter((x) => /#\d+$/.test(x.symbol)).map((x) => x.symbol);
    if (unknown.length) notes.push(`Unknown Nado product(s) ${unknown.join(', ')} — product list is from ${'2026-09-28'}; they cannot count as hedges`);
    return Ok({ book: aggregate([parsed.value], notes), block: Number(block) });
  } catch (e) {
    return Err('RPC_DEAD', `Nado on-chain read (Ink RPC): ${errMessage(e)}`);
  }
}
