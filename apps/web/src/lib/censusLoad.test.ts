import { describe, expect, it } from 'vitest';
import type { CensusState } from './census';
import { loadCensusOnce } from './censusLoad';
import { wellPhase } from './wellState';

const NOW = Date.parse('2026-10-05T12:00:00Z');
const snapJson = (block: number) => ({
  v: 1,
  chainId: 57073,
  generatedAt: '2026-10-05T11:30:00Z',
  block,
  rulesVersion: 'v1.2.0',
  discovery: { tydroScannedTo: block, nadoScannedTo: block, head: block, backfillComplete: true },
  sweep: { kind: 'incremental', complete: true, reread: 1, carried: 0, ms: 1 },
  counts: { known: 2, drawn: 2, empty: 0, dark: 0, tydro: 2, nado: 0, wounded: 1 },
  mix: {},
  // [addr, primaryIdx, tagMask, hullIdx, bandIdx, flags, readBlock, woundedSince]
  ships: [
    ['0x1111111111111111111111111111111111111111', 0, 1, 0, 2, 2, block, 0],
    ['0x2222222222222222222222222222222222222222', 0, 1, 0, 2, 2, block, 0],
  ],
});
const json = (body: unknown, status = 200, type = 'application/json') => ({
  status,
  ok: status >= 200 && status < 300,
  headers: new Headers({ 'content-type': type }),
  json: async () => body,
});

/** A tiny harness: holds the state the page would render, and lets a test hold the network open. */
function harness(initial: CensusState = { status: 'loading' }) {
  let state = initial;
  return {
    get: () => state,
    update: (f: (p: CensusState) => CensusState) => {
      state = f(state);
    },
  };
}

describe('census load — never a false zero (slow / failing / missing network)', () => {
  it('stays LOADING (no counts, no "no wallets") for as long as the scan is still on its way', async () => {
    const h = harness();
    let release!: (v: ReturnType<typeof json>) => void;
    const slow = new Promise<ReturnType<typeof json>>((r) => (release = r));
    const done = loadCensusOnce({ fetchFn: () => slow, url: '/census/census.json', nowMs: NOW, alive: () => true, update: h.update });
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 10)); // the network is slow
    expect(h.get().status).toBe('loading');
    expect(wellPhase(h.get(), NOW).kind).toBe('loading'); // the page shows "Loading the latest scan…", never 0 or SAFE
    release(json(snapJson(100)));
    await done;
    const s = h.get();
    expect(s.status).toBe('ok');
    expect(wellPhase(s, NOW)).toMatchObject({ kind: 'ok', lastGood: false });
    if (s.status === 'ok') expect(s.ships).toHaveLength(2);
  });

  it('a first load that finds no file is MISSING, and a failed one is ERROR — never an empty scan', async () => {
    const a = harness();
    await loadCensusOnce({ fetchFn: async () => json('<html>', 200, 'text/html'), url: '/c.json', nowMs: NOW, alive: () => true, update: a.update });
    expect(a.get().status).toBe('missing');
    expect(wellPhase(a.get(), NOW).kind).toBe('unavailable');
    const b = harness();
    await loadCensusOnce({ fetchFn: async () => { throw new Error('offline'); }, url: '/c.json', nowMs: NOW, alive: () => true, update: b.update });
    expect(b.get()).toEqual({ status: 'error', message: 'offline' });
  });

  it('a background refresh never clears the scan on screen: 404, HTML fallback, HTTP error and network failure all keep it (LAST GOOD)', async () => {
    for (const bad of [async () => json(null, 404), async () => json('<html>', 200, 'text/html'), async () => json(null, 503), async () => { throw new Error('offline'); }]) {
      const h = harness();
      await loadCensusOnce({ fetchFn: async () => json(snapJson(100)), url: '/c.json', nowMs: NOW, alive: () => true, update: h.update });
      await loadCensusOnce({ fetchFn: bad as never, url: '/c.json', nowMs: NOW, alive: () => true, update: h.update });
      const s = h.get();
      expect(s.status).toBe('ok');
      if (s.status === 'ok') {
        expect(s.snap.block).toBe(100);
        expect(s.ships).toHaveLength(2);
        expect(s.refreshError).toBeTruthy();
      }
      expect(wellPhase(s, NOW)).toMatchObject({ kind: 'ok', lastGood: true });
    }
  });

  it('a newer scan replaces the old one only once it has fully decoded; a malformed file is refused', async () => {
    const h = harness();
    await loadCensusOnce({ fetchFn: async () => json(snapJson(100)), url: '/c.json', nowMs: NOW, alive: () => true, update: h.update });
    await loadCensusOnce({ fetchFn: async () => json({ v: 1, ships: 'nope' }), url: '/c.json', nowMs: NOW, alive: () => true, update: h.update });
    expect(h.get()).toMatchObject({ status: 'ok', snap: { block: 100 } });
    await loadCensusOnce({ fetchFn: async () => json(snapJson(200)), url: '/c.json', nowMs: NOW, alive: () => true, update: h.update });
    expect(h.get()).toMatchObject({ status: 'ok', snap: { block: 200 } });
    expect((h.get() as { refreshError?: string }).refreshError).toBeUndefined();
  });

  it('a page that was closed while loading is never updated', async () => {
    const h = harness();
    await loadCensusOnce({ fetchFn: async () => json(snapJson(100)), url: '/c.json', nowMs: NOW, alive: () => false, update: h.update });
    expect(h.get().status).toBe('loading');
  });
});
