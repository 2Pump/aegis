import { makeInkClient, readBook, readHead, type BookRead, type ReadStage, type ChainHead, type NadoConfig, type NadoDiscovery, type Result } from '@aegis/ink-io';
import { decodeSnapshot } from '@aegis/census';
import { CENSUS_URL, DATA_VIA_API } from './census';
import { ENV } from './env';

/** The only door from UI to chain/venue. All IO goes through @aegis/ink-io. */
export const inkClient = makeInkClient(ENV.inkRpc);

export const nadoConfig: NadoConfig = {
  gatewayBase: ENV.nadoGateway,
  archiveBase: ENV.nadoArchive,
  mode: 'chain',
  maxSubaccounts: 8,
};

/*
 * Which Nado subaccounts a wallet has: the census's chain discovery (every deposit and trade since launch), so a wallet
 * page reads isolated positions too. Loaded once per 5 minutes and shared by every wallet page. If the census can't be
 * loaded, the page reads the default subaccount only and says PARTIAL — it never claims completeness it doesn't have.
 */
let census: { at: number; p: Promise<{ block: number; complete: boolean; subs: Map<string, string[]> } | null> } | null = null;
function censusSubs() {
  if (census && Date.now() - census.at < 5 * 60_000) return census.p;
  const p = (async () => {
    try {
      const res = await fetch(`${CENSUS_URL}${CENSUS_URL.includes('?') ? '&' : '?'}t=${Math.floor(Date.now() / 60_000)}`, { cache: 'no-cache' });
      if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return null;
      const { snap, ships } = decodeSnapshot(await res.json());
      return { block: snap.block, complete: snap.discovery.backfillComplete, subs: new Map(ships.map((s) => [s.address, s.extraSubs])) };
    } catch {
      return null;
    }
  })();
  census = { at: Date.now(), p };
  return p;
}

/** Deployed: ask the function for this one wallet's subaccounts (free, small) instead of loading the whole census. */
const subsCache = new Map<string, { at: number; p: Promise<NadoDiscovery | null> }>();
function apiSubs(address: string): Promise<NadoDiscovery | null> {
  const a = address.toLowerCase();
  const hit = subsCache.get(a);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.p;
  const p = (async () => {
    try {
      const res = await fetch(`/api/v1/data/subs/${a}`, { cache: 'no-cache' });
      if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return null;
      const j = (await res.json()) as { block: number; complete: boolean; subs: string[] };
      return j.complete ? { subs: j.subs, throughBlock: j.block } : null;
    } catch {
      return null;
    }
  })();
  subsCache.set(a, { at: Date.now(), p });
  return p;
}

export async function nadoDiscovery(address: string): Promise<NadoDiscovery | null> {
  if (DATA_VIA_API) return apiSubs(address);
  const c = await censusSubs();
  // history not fully scanned yet → the list may be short; null makes the page say PARTIAL
  if (!c || !c.complete) return null;
  return { subs: c.subs.get(address.toLowerCase()) ?? [], throughBlock: c.block };
}

export function loadBook(address: `0x${string}`, onStage?: (s: ReadStage) => void): Promise<BookRead> {
  return readBook(address, { client: inkClient, nado: nadoConfig, nadoDiscovery, onStage });
}

/** The wallet as it was at a past block (both venues, same block). Needs an RPC that still holds that state. */
export function loadBookAt(address: `0x${string}`, block: number): Promise<BookRead> {
  return readBook(address, { client: inkClient, nado: nadoConfig, nadoDiscovery }, BigInt(block));
}

export function loadHead(): Promise<Result<ChainHead>> {
  return readHead(inkClient);
}

/** The first block at or after a time (Ink makes ~1 block/s): binary search on block timestamps, ~26 reads. */
export async function blockAtTime(ms: number): Promise<{ block: number; at: number }> {
  const head = await inkClient.getBlock();
  const headT = Number(head.timestamp) * 1000;
  if (ms >= headT) return { block: Number(head.number), at: headT };
  let lo = 1n;
  let hi = head.number;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    const b = await inkClient.getBlock({ blockNumber: mid });
    if (Number(b.timestamp) * 1000 < ms) lo = mid + 1n;
    else hi = mid;
  }
  const b = await inkClient.getBlock({ blockNumber: lo });
  return { block: Number(lo), at: Number(b.timestamp) * 1000 };
}

export async function blockTime(block: number): Promise<number> {
  const b = await inkClient.getBlock({ blockNumber: BigInt(block) });
  return Number(b.timestamp) * 1000;
}
