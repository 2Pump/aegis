import type { NadoBook } from '@aegis/pose';
import type { PublicClient } from 'viem';
import { nadoSubaccount, subaccountKind } from './address.js';
import { scanNadoTouched } from './logs.js';
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
  spotProducts: readonly { productId: number; oraclePriceX18: bigint; risk?: ChainRisk }[];
  perpProducts: readonly { productId: number; oraclePriceX18: bigint; risk?: ChainRisk }[];
}
interface ChainRisk { longWeightMaintenanceX18: bigint; shortWeightMaintenanceX18: bigint }
const risk = (r: ChainRisk | undefined) =>
  r ? { long_weight_maintenance_x18: s(r.longWeightMaintenanceX18), short_weight_maintenance_x18: s(r.shortWeightMaintenanceX18) } : undefined;

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
      spot_products: info.spotProducts.map((p) => ({ product_id: p.productId, oracle_price_x18: s(p.oraclePriceX18), risk: risk(p.risk) })),
      perp_products: info.perpProducts.map((p) => ({ product_id: p.productId, oracle_price_x18: s(p.oraclePriceX18), risk: risk(p.risk) })),
    },
  };
}

/**
 * What AEGIS already knows about this owner's subaccounts (from the census: every trade and deposit since launch,
 * scanned from the chain). `throughBlock` = the block the census had scanned to. null discovery = the census isn't
 * available, so only the default subaccount can be read and the result is PARTIAL.
 */
export interface NadoDiscovery {
  subs: readonly string[];
  throughBlock: number | null;
}

/** Trades since the census are scanned for new subaccounts of this owner — up to this many blocks (~6 h on Ink). */
export const RECENT_SUB_SCAN_MAX_BLOCKS = 21_600;

export async function readNadoChain(client: PublicClient, address: string, blockNumber?: bigint, discovery?: NadoDiscovery | null): Promise<Result<NadoChainRead>> {
  const first = await readNadoChainAt(client, address, blockNumber, discovery ?? null);
  if (!first.ok && blockNumber === undefined && isZeroData(first.error.message)) {
    return readNadoChainAt(client, address, await stableHead(client, 20n), discovery ?? null);
  }
  return first;
}

async function readNadoChainAt(client: PublicClient, address: string, blockNumber: bigint | undefined, discovery: NadoDiscovery | null): Promise<Result<NadoChainRead>> {
  try {
    const chainId = await client.getChainId();
    if (chainId !== INK_CHAIN_ID) return Err('WRONG_CHAIN', `RPC is chain ${chainId}, expected ${INK_CHAIN_ID}`);
    const block = blockNumber ?? (await stableHead(client));
    const owner = address.toLowerCase();
    const def = nadoSubaccount(owner, 'default');
    // every subaccount we know of for THIS owner (a foreign one in the list is ignored, never read)
    const subs = new Set<string>([def, ...(discovery?.subs ?? []).map((x) => x.toLowerCase()).filter((x) => /^0x[0-9a-f]{64}$/.test(x) && x.slice(0, 42) === owner)]);
    const why: string[] = [];
    let complete = discovery !== null && discovery.throughBlock !== null;
    if (!discovery || discovery.throughBlock === null) {
      why.push("AEGIS's subaccount list wasn't available, so only the default subaccount was read — isolated positions may be missing");
    } else if (Number(block) > discovery.throughBlock) {
      const gap = Number(block) - discovery.throughBlock;
      if (gap > RECENT_SUB_SCAN_MAX_BLOCKS) {
        complete = false;
        why.push(`AEGIS's subaccount list is ${gap.toLocaleString('en-US')} blocks old — an isolated position opened since then may be missing`);
      } else {
        const r = await scanNadoTouched(client, discovery.throughBlock + 1, Number(block), { maxRetries: 3 });
        for (const x of r.subs) if (x.slice(0, 42) === owner) subs.add(x);
        if (!r.complete) {
          complete = false;
          why.push(`the scan of trades since block ${discovery.throughBlock.toLocaleString('en-US')} stopped early — an isolated position opened since then may be missing`);
        }
      }
    }
    const list = [...subs];
    const infos = await Promise.all(
      list.map((sub) =>
        client
          .readContract({ address: NADO_CONTRACTS.querier, abi: QUERIER_GET_SUBACCOUNT_INFO_ABI, functionName: 'getSubaccountInfo', args: [sub as `0x${string}`], blockNumber: block })
          .then((v) => ({ sub, ok: true as const, v: v as unknown as ChainInfo }))
          .catch((e: unknown) => ({ sub, ok: false as const, e: errMessage(e) })),
      ),
    );
    const failed = infos.filter((x) => !x.ok);
    // a subaccount that couldn't be read never silently disappears: the whole Nado reading is unreadable, and says which
    if (failed.length) {
      const f = failed[0] as { sub: string; e: string };
      return Err('RPC_DEAD', `Nado ${subaccountKind(f.sub)} subaccount ${f.sub.slice(42)} couldn't be read${failed.length > 1 ? ` (and ${failed.length - 1} more)` : ''}: ${f.e}`);
    }
    const parsedAll = [];
    for (const x of infos) {
      const p = parseSubaccountInfo(chainInfoToGatewayShape((x as { v: ChainInfo }).v), NADO_PRODUCTS, 'NADO_ONCHAIN');
      if (!p.ok) return p;
      parsedAll.push(p.value);
    }
    const readAt = Date.now();
    const iso = list.filter((x) => subaccountKind(x) === 'isolated').length;
    const notes: string[] = [
      'Read from Ink chain via Nado FQuerier (settled state; may trail app.nado.xyz by seconds)',
      `Subaccounts read: default${iso ? ` + ${iso} isolated` : ''}${list.length - 1 - iso > 0 ? ` + ${list.length - 1 - iso} other` : ''}`,
    ];
    if (complete) {
      why.push(
        `every subaccount AEGIS has found for this wallet (discovery through block ${discovery!.throughBlock!.toLocaleString('en-US')}${Number(block) > discovery!.throughBlock! ? ', plus trades since' : ''})`,
      );
    }
    const def0 = parsedAll[0]!;
    if (!def0.exists && parsedAll.every((p) => !p.spots.length && !p.perps.length)) notes.push('No Nado account for this address');
    const unknown = parsedAll.flatMap((p) => [...p.spots, ...p.perps]).filter((x) => /#\d+$/.test(x.symbol)).map((x) => x.symbol);
    if (unknown.length) notes.push(`Unknown Nado product(s) ${[...new Set(unknown)].join(', ')} — product list is from ${'2026-09-28'}; they cannot count as hedges`);
    const book = aggregate(parsedAll, notes);
    book.coverage = {
      status: complete ? 'COMPLETE' : 'PARTIAL',
      why,
      throughBlock: discovery?.throughBlock ?? null,
      subs: list.map((s) => ({ subaccount: s, kind: subaccountKind(s), readAt })),
    };
    return Ok({ book, block: Number(block) });
  } catch (e) {
    return Err('RPC_DEAD', `Nado on-chain read (Ink RPC): ${errMessage(e)}`);
  }
}
