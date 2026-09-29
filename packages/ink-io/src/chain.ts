import { createPublicClient, http, type PublicClient } from 'viem';
import { Err, Ok, errMessage, type Result } from './result.js';
import { rotatingHttp, splitRpcList, type RotateStats } from './rotate.js';
import { ink } from 'viem/chains';

export const INK_CHAIN_ID = 57073 as const;
export const INK_DEFAULT_RPC = 'https://rpc-gel.inkonchain.com';
export const INK_EXPLORER = 'https://explorer.inkonchain.com';

export { ink };

/**
 * One Ink RPC URL, or several separated by commas (then requests rotate between them and a throttled
 * endpoint is rested — see rotate.ts). Empty → Ink's Gelato endpoint.
 */
export function makeInkClient(rpcUrl?: string | readonly string[], opts: { stats?: RotateStats } = {}): PublicClient {
  const urls = typeof rpcUrl === 'string' || rpcUrl === undefined ? splitRpcList(rpcUrl) : [...rpcUrl];
  const transport =
    urls.length > 1 ? rotatingHttp(urls, { stats: opts.stats }) : http(urls[0] || INK_DEFAULT_RPC, { timeout: 10_000, retryCount: 1 });
  return createPublicClient({
    chain: ink,
    transport,
    batch: { multicall: true },
  }) as PublicClient;
}

/** Which of these endpoints answer, and are really Ink (chain 57073)? Used before a census run. */
export async function checkInkEndpoints(urls: readonly string[]): Promise<Array<{ url: string; ok: boolean; why: string; head: number | null }>> {
  return Promise.all(
    urls.map(async (url) => {
      try {
        const c = createPublicClient({ chain: ink, transport: http(url, { timeout: 8_000, retryCount: 1 }) });
        const [id, head] = await Promise.all([c.getChainId(), c.getBlockNumber()]);
        if (id !== INK_CHAIN_ID) return { url, ok: false, why: `chain ${id}, not Ink`, head: null };
        return { url, ok: true, why: `block ${head}`, head: Number(head) };
      } catch (e) {
        return { url, ok: false, why: errMessage(e).slice(0, 120), head: null };
      }
    }),
  );
}

/**
 * A block a few behind the tip. Public RPCs are load-balanced over several nodes; asking one node for "latest" and then
 * reading AT that number from another node that is 1–2 blocks behind returns empty data ("0x") instead of an error.
 * Reading 3 blocks (~3 s) back avoids that on Ink's 1-second blocks.
 */
export async function stableHead(client: PublicClient, back = 3n): Promise<bigint> {
  const tip = await client.getBlockNumber({ cacheTime: 0 });
  return tip > back ? tip - back : tip;
}

/** The node answered with empty data — almost always "that node doesn't have this block yet". Worth one retry further back. */
export const isZeroData = (msg: string) => /zero data \("0x"\)|returned no data \("0x"\)/i.test(msg);

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
