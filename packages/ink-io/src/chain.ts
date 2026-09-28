import { createPublicClient, http, type PublicClient } from 'viem';
import { Err, Ok, errMessage, type Result } from './result.js';
import { ink } from 'viem/chains';

export const INK_CHAIN_ID = 57073 as const;
export const INK_DEFAULT_RPC = 'https://rpc-gel.inkonchain.com';
export const INK_EXPLORER = 'https://explorer.inkonchain.com';

export { ink };

export function makeInkClient(rpcUrl?: string): PublicClient {
  return createPublicClient({
    chain: ink,
    transport: http(rpcUrl || INK_DEFAULT_RPC, { timeout: 10_000, retryCount: 1 }),
    batch: { multicall: true },
  }) as PublicClient;
}

export interface ChainHead {
  chainId: number;
  block: number;
  /** block timestamp, ms */
  blockTime: number;
  /** when we read it, ms */
  readAt: number;
}

/** Footer telemetry: chain id + latest block. */
export async function readHead(client: PublicClient): Promise<Result<ChainHead>> {
  try {
    const [chainId, blk] = await Promise.all([client.getChainId(), client.getBlock({ blockTag: 'latest' })]);
    if (chainId !== INK_CHAIN_ID) return Err('WRONG_CHAIN', `RPC is chain ${chainId}, expected ${INK_CHAIN_ID}`);
    return Ok({ chainId, block: Number(blk.number), blockTime: Number(blk.timestamp) * 1000, readAt: Date.now() });
  } catch (e) {
    return Err('RPC_DEAD', `Ink RPC: ${errMessage(e)}`);
  }
}
