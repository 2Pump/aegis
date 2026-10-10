import { describe, expect, it } from 'vitest';
import type { PublicClient } from 'viem';
import { readBook, type ReadStage } from '../src/index.js';

// a client whose every call fails: both venues end DARK, and the stages say so
const dead = new Proxy({}, { get: () => async () => { throw new Error('HTTP request failed: dead rpc'); } }) as unknown as PublicClient;

describe('readBook progress', () => {
  it('reports each venue starting and ending, in order; the read itself is unchanged by the callback', async () => {
    const seen: ReadStage[] = [];
    const lookup = async () => ({ subs: [], throughBlock: 1 });
    const a = '0x' + '1'.repeat(40) as `0x${string}`;
    const r = await readBook(a, { client: dead, nado: { mode: 'chain', gatewayBase: '', archiveBase: '' }, nadoDiscovery: lookup, onStage: (s) => seen.push(s) });
    expect(r.book.tydro.status).toBe('DARK');
    expect(r.book.nado.status).toBe('DARK');
    const of = (v: string) => seen.filter((s) => s.venue === v).map((s) => s.phase);
    expect(of('tydro')).toEqual(['reading', 'failed']);
    expect(of('nado')).toEqual(['lookup', 'reading', 'failed']);
    // a callback that throws never breaks the read
    const r2 = await readBook(a, { client: dead, nado: { mode: 'chain', gatewayBase: '', archiveBase: '' }, onStage: () => { throw new Error('ui bug'); } });
    expect(r2.book.tydro.status).toBe('DARK');
  });
});
