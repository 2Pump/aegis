/**
 * NADO ORDER BOOKS — read-only. Nado's order book lives off-chain, in its sequencer; the only official way to see it
 * is the gateway's `market_liquidity` query (Nado SDK EngineQueryClient.getMarketLiquidity). A plain GET, no keys.
 *
 * Nado's API sits behind Cloudflare. When it refuses, the read is UNAVAILABLE — recorded as such, never guessed and
 * never worked around (no browser emulation, no proxies, no alternate hosts).
 *
 * Units, as the SDK maps them: a tick is [priceX18, liquidity]; price ÷ 1e18 is quote per base. Liquidity is base
 * amount in the same 1e18 units as the on-chain book's sizeIncrement, which is how each read checks its own units:
 * every level must be a whole multiple of the product's sizeIncrement (read from FQuerier at the same time).
 */
import type { PublicClient } from 'viem';
import { nadoSubaccount } from './address.js';
import type { FetchLike } from './http.js';
import { NADO_CONTRACTS, NADO_PRODUCTS, QUERIER_GET_SUBACCOUNT_INFO_ABI } from './nado-registry.js';
import { NADO_DIRECT } from './nado.js';
import { Err, Ok, errMessage, type Result } from './result.js';

export interface NadoPerpRef {
  productId: number;
  symbol: string;
  /** on-chain oracle price (quote per base) */
  oracle: number;
  /** on-chain book size increment, raw 1e18 units */
  sizeIncrement: bigint;
}

/** Every perp product with its on-chain oracle price and size increment — one FQuerier call. */
export async function readNadoPerpRefs(client: PublicClient, blockNumber?: bigint): Promise<Result<{ block: number; perps: NadoPerpRef[] }>> {
  try {
    const block = blockNumber ?? (await client.getBlockNumber());
    const info = (await client.readContract({
      address: NADO_CONTRACTS.querier as `0x${string}`,
      abi: QUERIER_GET_SUBACCOUNT_INFO_ABI,
      functionName: 'getSubaccountInfo',
      args: [nadoSubaccount('0x0000000000000000000000000000000000000000') as `0x${string}`],
      blockNumber: block,
    })) as unknown as { perpProducts: readonly { productId: number; oraclePriceX18: bigint; bookInfo: { sizeIncrement: bigint } }[] };
    const perps = info.perpProducts
      .map((p) => ({ productId: Number(p.productId), symbol: NADO_PRODUCTS.get(Number(p.productId))?.symbol ?? `PERP#${p.productId}`, oracle: Number(p.oraclePriceX18) / 1e18, sizeIncrement: BigInt(p.bookInfo.sizeIncrement) }))
      .filter((p) => p.oracle > 0);
    return Ok({ block: Number(block), perps });
  } catch (e) {
    return Err('RPC_DEAD', `Nado markets: ${errMessage(e).slice(0, 200)}`);
  }
}

export interface BookLevel {
  /** quote per base */
  price: number;
  /** base units */
  size: number;
  /** raw 1e18 base units, as sent */
  raw: bigint;
}
export interface NadoBookRead {
  bids: BookLevel[];
  asks: BookLevel[];
}

/** Parse a `market_liquidity` reply. Bids come best (highest) first, asks best (lowest) first; we sort to be sure. */
export function parseMarketLiquidity(json: unknown): Result<NadoBookRead> {
  const d = (json as { status?: string; data?: { bids?: unknown; asks?: unknown } } | null) ?? null;
  if (!d || d.status !== 'success' || !d.data || !Array.isArray(d.data.bids) || !Array.isArray(d.data.asks)) return Err('PARSE_FAIL', 'market_liquidity: unexpected reply');
  const side = (rows: unknown[]): BookLevel[] | null => {
    const out: BookLevel[] = [];
    for (const r of rows) {
      if (!Array.isArray(r) || r.length < 2) return null;
      try {
        const p = BigInt(String(r[0]));
        const s = BigInt(String(r[1]));
        if (p <= 0n || s <= 0n) continue;
        out.push({ price: Number(p) / 1e18, size: Number(s) / 1e18, raw: s });
      } catch {
        return null;
      }
    }
    return out;
  };
  const bids = side(d.data.bids);
  const asks = side(d.data.asks);
  if (!bids || !asks) return Err('PARSE_FAIL', 'market_liquidity: a level did not parse');
  bids.sort((a, b) => b.price - a.price);
  asks.sort((a, b) => a.price - b.price);
  return Ok({ bids, asks });
}

export type BookFetch = { ok: true; book: NadoBookRead } | { ok: false; refused: boolean; reason: string };

/** One plain GET to Nado's official gateway. `refused` = Nado's side said no (HTTP error / Cloudflare page). */
export async function fetchNadoBook(doFetch: FetchLike, productId: number, depth: number, base: string = NADO_DIRECT.gateway): Promise<BookFetch> {
  const url = `${base}/query?type=market_liquidity&product_id=${productId}&depth=${depth}`;
  try {
    const res = await doFetch(url);
    const type = res.headers.get('content-type') ?? '';
    if (!res.ok || !type.includes('json')) return { ok: false, refused: true, reason: `HTTP ${res.status}${type.includes('html') ? ' (Cloudflare page)' : ''}` };
    const parsed = parseMarketLiquidity(await res.json());
    return parsed.ok ? { ok: true, book: parsed.value } : { ok: false, refused: false, reason: parsed.error.message };
  } catch (e) {
    return { ok: false, refused: false, reason: `unreachable: ${errMessage(e).slice(0, 160)}` };
  }
}
