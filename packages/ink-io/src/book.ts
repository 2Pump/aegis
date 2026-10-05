import type { Book, NadoBook, Sensor, TydroBook } from '@aegis/pose';
import type { Address, PublicClient } from 'viem';
import { readNado, type NadoConfig } from './nado.js';
import { readNadoChain, type NadoDiscovery } from './nado-chain.js';
import type { InkError } from './result.js';
import { readTydro } from './tydro.js';

export interface SensorsConfig {
  client: PublicClient;
  nado: NadoConfig;
  /** what Phrourax already knows about an owner's Nado subaccounts (the census); null/absent = default only, PARTIAL */
  nadoDiscovery?: (address: string) => Promise<NadoDiscovery | null>;
}

export interface BookRead {
  book: Book;
  /** worst error across sensors, for backoff decisions */
  rateLimited: boolean;
  retryAfterS: number | null;
}

const dark = <T>(e: InkError, at: number): Sensor<T> => ({ status: 'DARK', code: e.code, message: e.message, asOfTime: at });

/**
 * Reads both venues in parallel. Never throws. A failed sensor becomes DARK — it is never filled in.
 * `blockNumber`: read the wallet as it was at that past block (both venues at the same block). Needs an RPC that
 * still holds that block's state; when it doesn't, the venue is DARK with the node's reason — never guessed.
 */
export async function readBook(address: `0x${string}`, cfg: SensorsConfig, blockNumber?: bigint): Promise<BookRead> {
  const nadoRead =
    (cfg.nado.mode ?? 'chain') === 'chain'
      ? (cfg.nadoDiscovery ? cfg.nadoDiscovery(address).catch(() => null) : Promise.resolve(null)).then((d) =>
          readNadoChain(cfg.client, address, blockNumber, d).then((r) => (r.ok ? { ok: true as const, value: r.value.book } : r)),
        )
      : blockNumber !== undefined
        ? Promise.resolve({ ok: false as const, error: { code: 'DARK' as const, message: "Nado's API can't read past blocks" } })
        : readNado(address, cfg.nado);
  const [t, n] = await Promise.all([readTydro(cfg.client, address as Address, blockNumber), nadoRead]);
  const at = Date.now();
  const tydro: Sensor<TydroBook> = t.ok ? { status: 'OK', data: t.value.book, asOfTime: at, asOfBlock: t.value.block } : dark(t.error, at);
  const nado: Sensor<NadoBook> = n.ok ? { status: 'OK', data: n.value, asOfTime: at, asOfBlock: null } : dark(n.error, at);
  const errs = [t, n].filter((r) => !r.ok).map((r) => (r.ok ? null : r.error)).filter((e): e is InkError => e !== null);
  const rl = errs.filter((e) => e.code === 'RATE_LIMIT');
  return {
    book: {
      address: address.toLowerCase(),
      source: 'LIVE',
      tydro,
      nado,
      asOfBlock: t.ok ? t.value.block : null,
      asOfTime: at,
    },
    rateLimited: rl.length > 0,
    retryAfterS: rl.reduce<number | null>((m, e) => (e.retryAfterS && (m === null || e.retryAfterS > m) ? e.retryAfterS : m), null),
  };
}
