import type { Book, NadoBook, Sensor, TydroBook } from '@aegis/pose';
import type { Address, PublicClient } from 'viem';
import { readNado, type NadoConfig } from './nado.js';
import { readNadoChain } from './nado-chain.js';
import type { InkError } from './result.js';
import { readTydro } from './tydro.js';

export interface SensorsConfig {
  client: PublicClient;
  nado: NadoConfig;
}

export interface BookRead {
  book: Book;
  /** worst error across sensors, for backoff decisions */
  rateLimited: boolean;
  retryAfterS: number | null;
}

const dark = <T>(e: InkError, at: number): Sensor<T> => ({ status: 'DARK', code: e.code, message: e.message, asOfTime: at });

/** Reads both venues in parallel. Never throws. A failed sensor becomes DARK — it is never filled in. */
export async function readBook(address: `0x${string}`, cfg: SensorsConfig): Promise<BookRead> {
  const nadoRead =
    (cfg.nado.mode ?? 'chain') === 'chain'
      ? readNadoChain(cfg.client, address).then((r) => (r.ok ? { ok: true as const, value: r.value.book } : r))
      : readNado(address, cfg.nado);
  const [t, n] = await Promise.all([readTydro(cfg.client, address as Address), nadoRead]);
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
