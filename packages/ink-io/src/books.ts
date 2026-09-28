import type { Book, NadoBook, Sensor, TydroBook } from '@aegis/pose';
import type { PublicClient } from 'viem';
import { nadoSubaccount } from './address.js';
import { nadoBooksByOwner, nadoHealthMany, readNadoSubsMany } from './nado-batch.js';
import { aggregate } from './nado.js';
import type { Result } from './result.js';
import { readTydroMany, type TydroPrices } from './tydro-batch.js';

export interface ReadManyInput {
  addresses: readonly string[];
  /** Tydro token indexes each address has touched (from discovery). Missing → read all tokens. */
  tydroTokens?: ReadonlyMap<string, ReadonlySet<number>>;
  /** Known Nado subaccounts per owner. `default` is always included. */
  nadoSubs?: ReadonlyMap<string, readonly `0x${string}`[]>;
  blockNumber?: bigint;
  tydroPrices?: TydroPrices;
  onStage?: (stage: string, done: number, total: number) => void;
}

export interface ReadManyResult {
  block: number;
  books: Map<string, Book>;
  /** subaccounts that were checked and found empty (lets the census skip them next time) */
  emptySubs: Set<string>;
  activeSubs: Set<string>;
}

/**
 * Read many wallets at ONE block. Every sensor is a real chain read; a failed read darkens only that wallet's
 * sensor (never filled in). Used by the census job and by the browser's live layer.
 */
export async function readBooksMany(client: PublicClient, input: ReadManyInput): Promise<ReadManyResult> {
  const block = input.blockNumber ?? (await client.getBlockNumber());
  const at = Date.now();
  const addrs = [...new Set(input.addresses.map((a) => a.toLowerCase()))];

  // Tydro
  input.onStage?.('tydro', 0, addrs.length);
  const t = await readTydroMany(client, addrs, block, {
    tokens: input.tydroTokens,
    prices: input.tydroPrices,
    onChunk: (d, tot) => input.onStage?.('tydro', d, tot),
  });

  // Nado: health filter, then exact reads for non-empty subaccounts
  const subsOf = new Map<string, `0x${string}`[]>();
  for (const a of addrs) {
    const set = new Set<`0x${string}`>([nadoSubaccount(a), ...((input.nadoSubs?.get(a) ?? []).map((s) => s.toLowerCase() as `0x${string}`))]);
    subsOf.set(a, [...set]);
  }
  const allSubs = [...subsOf.values()].flat();
  input.onStage?.('nado-health', 0, allSubs.length);
  const health = await nadoHealthMany(client, allSubs, block);
  const emptySubs = new Set<string>();
  const activeSubs = new Set<string>();
  const healthErr = new Map<string, string>();
  for (const [s, r] of health) {
    if (!r.ok) healthErr.set(s.slice(0, 42), r.error.message);
    else if (r.value.empty) emptySubs.add(s);
    else activeSubs.add(s);
  }
  input.onStage?.('nado-books', 0, activeSubs.size);
  const parsed = await readNadoSubsMany(client, [...activeSubs] as `0x${string}`[], block, {
    onChunk: (d, tot) => input.onStage?.('nado-books', d, tot),
  });
  const nadoBooks = nadoBooksByOwner(parsed, emptySubs);

  const books = new Map<string, Book>();
  for (const a of addrs) {
    const tr: Result<TydroBook> | undefined = t.ok ? t.value.get(a) : { ok: false, error: t.error };
    const tydro: Sensor<TydroBook> =
      tr && tr.ok
        ? { status: 'OK', data: tr.value, asOfTime: at, asOfBlock: Number(block) }
        : { status: 'DARK', code: tr?.ok === false ? tr.error.code : 'DARK', message: tr?.ok === false ? tr.error.message : 'no Tydro read', asOfTime: at };

    let nado: Sensor<NadoBook>;
    const herr = healthErr.get(a);
    const nb = nadoBooks.get(a);
    if (herr) nado = { status: 'DARK', code: 'RPC_DEAD', message: `Nado health: ${herr}`, asOfTime: at };
    else if (nb && !nb.ok) nado = { status: 'DARK', code: nb.error.code, message: nb.error.message, asOfTime: at };
    else if (nb && nb.ok) nado = { status: 'OK', data: nb.value, asOfTime: at, asOfBlock: Number(block) };
    else nado = { status: 'OK', data: aggregate([], ['No Nado balances (every known subaccount is empty)']), asOfTime: at, asOfBlock: Number(block) };

    books.set(a, { address: a, source: 'LIVE', tydro, nado, asOfBlock: Number(block), asOfTime: at });
  }
  return { block: Number(block), books, emptySubs, activeSubs };
}
