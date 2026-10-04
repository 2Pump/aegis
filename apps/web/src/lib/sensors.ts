import { makeInkClient, readBook, readHead, type BookRead, type ChainHead, type NadoConfig, type NadoDiscovery, type Result } from '@aegis/ink-io';
import { decodeSnapshot } from '@aegis/census';
import { CENSUS_URL } from './census';
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

export async function nadoDiscovery(address: string): Promise<NadoDiscovery | null> {
  const c = await censusSubs();
  // history not fully scanned yet → the list may be short; null makes the page say PARTIAL
  if (!c || !c.complete) return null;
  return { subs: c.subs.get(address.toLowerCase()) ?? [], throughBlock: c.block };
}

export function loadBook(address: `0x${string}`): Promise<BookRead> {
  return readBook(address, { client: inkClient, nado: nadoConfig, nadoDiscovery });
}

export function loadHead(): Promise<Result<ChainHead>> {
  return readHead(inkClient);
}
