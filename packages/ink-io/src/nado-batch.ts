import type { NadoBook } from '@aegis/pose';
import type { PublicClient } from 'viem';
import { multicallAdaptive, type Call } from './batch.js';
import { chainInfoToGatewayShape } from './nado-chain.js';
import { ENDPOINT_GET_NLP_POOLS_ABI, NADO_CONTRACTS, NADO_PRODUCTS, QUERIER_GET_SUBACCOUNT_INFO_ABI } from './nado-registry.js';
import { aggregate, parseSubaccountInfo, type ParsedSub } from './nado.js';
import type { Result } from './result.js';

/**
 * Nado for many subaccounts at one block, straight from the chain.
 *  1) Clearinghouse.getHealth(sub, MAINTENANCE=1) and (sub, PNL=2): one int each, cheap → filters empty accounts.
 *  2) FQuerier.getSubaccountInfo(sub): exact book (same struct the hull page uses). Heavy — the Querier returns
 *     every product (~100) on every call — so only run it for non-empty subaccounts, in small adaptive chunks.
 */
const getHealthAbi = [
  {
    type: 'function',
    name: 'getHealth',
    stateMutability: 'view',
    inputs: [
      { name: 'subaccount', type: 'bytes32' },
      { name: 'healthType', type: 'uint8' },
    ],
    outputs: [{ type: 'int128' }],
  },
] as const;

export interface NadoHealthLite {
  maintUsd: number;
  pnlUsd: number;
  /** both zero → nothing in this subaccount */
  empty: boolean;
}

export async function nadoHealthMany(
  client: PublicClient,
  subs: readonly `0x${string}`[],
  blockNumber: bigint,
): Promise<Map<string, Result<NadoHealthLite>>> {
  const calls: Call[] = subs.flatMap((s) => [
    { address: NADO_CONTRACTS.clearinghouse, abi: getHealthAbi, functionName: 'getHealth', args: [s, 1] },
    { address: NADO_CONTRACTS.clearinghouse, abi: getHealthAbi, functionName: 'getHealth', args: [s, 2] },
  ]);
  // getHealth loops over every product (~100) per call — keep batches modest so one eth_call doesn't run out of gas
  const res = await multicallAdaptive(client, calls, { blockNumber, chunk: 60 });
  const out = new Map<string, Result<NadoHealthLite>>();
  subs.forEach((s, i) => {
    const m = res[i * 2]!;
    const p = res[i * 2 + 1]!;
    if (!m.ok || !p.ok) {
      out.set(s, { ok: false, error: { code: 'PARSE_FAIL', message: `getHealth: ${!m.ok ? m.error : !p.ok ? p.error : ''}` } });
      return;
    }
    const maint = m.value as bigint;
    const pnl = p.value as bigint;
    out.set(s, { ok: true, value: { maintUsd: Number(maint) / 1e18, pnlUsd: Number(pnl) / 1e18, empty: maint === 0n && pnl === 0n } });
  });
  return out;
}

export async function readNadoSubsMany(
  client: PublicClient,
  subs: readonly `0x${string}`[],
  blockNumber: bigint,
  opts: { chunk?: number; onChunk?: (d: number, t: number) => void } = {},
): Promise<Map<string, Result<ParsedSub>>> {
  const calls: Call[] = subs.map((s) => ({
    address: NADO_CONTRACTS.querier,
    abi: QUERIER_GET_SUBACCOUNT_INFO_ABI as unknown as readonly unknown[],
    functionName: 'getSubaccountInfo',
    args: [s],
  }));
  const res = await multicallAdaptive(client, calls, { blockNumber, chunk: opts.chunk ?? 4, concurrency: 2, onChunk: (d, t) => opts.onChunk?.(d, t) });
  const out = new Map<string, Result<ParsedSub>>();
  subs.forEach((s, i) => {
    const r = res[i]!;
    if (!r.ok) return void out.set(s, { ok: false, error: { code: 'RPC_DEAD', message: `getSubaccountInfo: ${r.error}` } });
    out.set(s, parseSubaccountInfo(chainInfoToGatewayShape(r.value as never), NADO_PRODUCTS, 'NADO_ONCHAIN'));
  });
  return out;
}

/** Group parsed subaccounts by owner address into NadoBooks. Any failed subaccount darkens that owner's Nado sensor. */
export function nadoBooksByOwner(
  parsed: ReadonlyMap<string, Result<ParsedSub>>,
  emptySubs: ReadonlySet<string>,
): Map<string, Result<NadoBook>> {
  const byOwner = new Map<string, { subs: ParsedSub[]; err: string | null; empties: number }>();
  const slot = (o: string) => {
    let v = byOwner.get(o);
    if (!v) byOwner.set(o, (v = { subs: [], err: null, empties: 0 }));
    return v;
  };
  for (const [sub, r] of parsed) {
    const v = slot(sub.slice(0, 42));
    if (r.ok) v.subs.push(r.value);
    else v.err = r.error.message;
  }
  for (const sub of emptySubs) slot(sub.slice(0, 42)).empties++;
  const out = new Map<string, Result<NadoBook>>();
  for (const [owner, v] of byOwner) {
    if (v.err) {
      out.set(owner, { ok: false, error: { code: 'RPC_DEAD', message: v.err } });
      continue;
    }
    const notes = ['Read from Ink chain via Nado FQuerier (settled state)'];
    if (v.subs.length + v.empties > 1) notes.push(`${v.subs.length + v.empties} subaccounts known (${v.empties} empty)`);
    out.set(owner, { ok: true, value: aggregate(v.subs, notes) });
  }
  return out;
}

export interface NlpPool {
  poolId: number;
  subaccount: `0x${string}`;
  owner: `0x${string}`;
  /** share of NLP capital routed to this pool (0..1) */
  weight: number;
}

/** The NLP vault's pool subaccounts, straight from Endpoint.getNlpPools() at one block. Read only. */
export async function readNlpPools(client: PublicClient, blockNumber: bigint): Promise<Result<NlpPool[]>> {
  try {
    const raw = (await client.readContract({
      address: NADO_CONTRACTS.endpoint,
      abi: ENDPOINT_GET_NLP_POOLS_ABI,
      functionName: 'getNlpPools',
      blockNumber,
    })) as readonly { poolId: bigint; subaccount: `0x${string}`; owner: `0x${string}`; balanceWeightX18: bigint }[];
    return {
      ok: true,
      value: raw.map((p) => ({
        poolId: Number(p.poolId),
        subaccount: p.subaccount.toLowerCase() as `0x${string}`,
        owner: p.owner.toLowerCase() as `0x${string}`,
        weight: Number(p.balanceWeightX18) / 1e18,
      })),
    };
  } catch (e) {
    return { ok: false, error: { code: 'RPC_DEAD', message: `getNlpPools: ${String(e).slice(0, 160)}` } };
  }
}
