/**
 * The alerts runner's eyes: the SAME readers the wallet page uses (readBook: Tydro + every known Nado subaccount),
 * with the census as the subaccount list, then reduced to an Observation. Read-only view calls.
 */
import type { PublicClient } from 'viem';
import { NADO_DIRECT, readBook, type NadoDiscovery } from '@aegis/ink-io';
import { decodeSnapshot } from '../index.js';
import { observe } from '../alerts/observe.js';
import type { Observation, Watch } from '../alerts/model.js';

export function makeAlertsReader(client: PublicClient, census: unknown | null) {
  let discovery: (a: string) => Promise<NadoDiscovery | null> = async () => null;
  if (census) {
    try {
      const { snap, ships } = decodeSnapshot(census);
      const subs = new Map(ships.map((s) => [s.address, s.extraSubs]));
      if (snap.discovery.backfillComplete) discovery = async (a) => ({ subs: subs.get(a.toLowerCase()) ?? [], throughBlock: snap.block });
    } catch {
      /* no usable census → default subaccount only, and readings say PARTIAL */
    }
  }
  const blockTime = new Map<number, number>();
  return async (address: string, scenarios: ReadonlyArray<Watch['scenario']>): Promise<Observation | null> => {
    const readAt = Date.now();
    const { book } = await readBook(address as `0x${string}`, { client, nado: { mode: 'chain', gatewayBase: NADO_DIRECT.gateway, archiveBase: NADO_DIRECT.archive }, nadoDiscovery: discovery });
    let dataAt: number | null = null;
    if (book.asOfBlock !== null) {
      dataAt = blockTime.get(book.asOfBlock) ?? null;
      if (dataAt === null) {
        dataAt = await client
          .getBlock({ blockNumber: BigInt(book.asOfBlock) })
          .then((b) => Number(b.timestamp) * 1000)
          .catch(() => null);
        if (dataAt !== null) blockTime.set(book.asOfBlock, dataAt);
      }
    }
    return observe(book, { readAt, dataAt, scenarios });
  };
}
