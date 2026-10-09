import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// two fake Blob stores keyed by token: 'pub' (public URLs) and 'priv' (private)
const stores: Record<string, Map<string, string>> = { pub: new Map(), priv: new Map() };
const puts: Array<{ token: string; path: string; access: string }> = [];
vi.mock('@vercel/blob', () => ({
  list: async ({ prefix, token }: { prefix: string; token: string }) => ({
    blobs: [...stores[token]!.entries()].filter(([p]) => p.startsWith(prefix)).map(([p, v]) => ({ pathname: p, url: `https://${token}.blob/${p}`, size: v.length })),
    hasMore: false,
  }),
  put: async (path: string, body: string, o: { token: string; access: string }) => {
    stores[o.token]!.set(path, body);
    puts.push({ token: o.token, path, access: o.access });
    return { url: `https://${o.token}.blob/${path}` };
  },
  del: async (urls: string[], o: { token: string }) => {
    for (const u of urls) stores[o.token]!.delete(u.replace(/^https:\/\/[a-z]+\.blob\//, ''));
  },
  get: async (path: string, o: { token: string; access: string }) => {
    const v = stores[o.token]!.get(path);
    if (v === undefined) return null;
    return { statusCode: 200, stream: new Response(v).body, headers: new Headers(), blob: {} };
  },
}));

const { blobStore, migrateToPrivateIfNeeded, privateCensusReader } = await import('../src/node/store.js');

beforeEach(() => {
  stores.pub = new Map([
    ['census/known.json', '{"k":1}'],
    ['census/census.json', '{"c":1}'],
    ['census/history/index.json', '{"i":1}'],
  ]);
  stores.priv = new Map();
  puts.length = 0;
  vi.stubGlobal('fetch', async (url: string) => {
    const path = String(url).replace(/^https:\/\/pub\.blob\//, '').replace(/\?.*$/, '');
    const v = stores.pub!.get(path);
    return new Response(v ?? 'nope', { status: v === undefined ? 404 : 200 });
  });
  process.env.BLOB_READ_WRITE_TOKEN = 'pub';
});
afterEach(() => {
  delete process.env.CENSUS_BLOB_TOKEN;
  vi.unstubAllGlobals();
});

describe('private census store', () => {
  it('without CENSUS_BLOB_TOKEN nothing moves and the public store is used', async () => {
    expect(await migrateToPrivateIfNeeded(() => {})).toBe(0);
    const s = await blobStore();
    expect(s.describe).not.toContain('private');
    expect(await s.get('census.json')).toEqual({ c: 1 });
  });

  it('first private run copies every file, known.json last; then it is a no-op; reads and writes go private', async () => {
    process.env.CENSUS_BLOB_TOKEN = 'priv';
    expect(await migrateToPrivateIfNeeded(() => {})).toBe(3);
    expect([...stores.priv!.keys()].sort()).toEqual(['census/census.json', 'census/history/index.json', 'census/known.json']);
    expect(puts.at(-1)!.path).toBe('census/known.json');
    expect(puts.every((p) => p.access === 'private')).toBe(true);
    expect(await migrateToPrivateIfNeeded(() => {})).toBe(0);
    const s = await blobStore();
    expect(s.describe).toContain('private');
    expect(await s.get('census.json')).toEqual({ c: 1 });
    await s.put('census.json', { c: 2 });
    expect(stores.priv!.get('census/census.json')).toBe('{"c":2}');
    expect(stores.pub!.get('census/census.json')).toBe('{"c":1}'); // the public copy is left alone
    expect(await privateCensusReader('priv')('census.json')).toEqual({ c: 2 });
    expect(await privateCensusReader('priv')('nothing.json')).toBeNull();
  });

  it('refuses to start from scratch: empty private store and no public source', async () => {
    process.env.CENSUS_BLOB_TOKEN = 'priv';
    stores.pub = new Map();
    await expect(migrateToPrivateIfNeeded(() => {})).rejects.toThrow(/never written/);
    delete process.env.BLOB_READ_WRITE_TOKEN;
    await expect(migrateToPrivateIfNeeded(() => {})).rejects.toThrow(/not set/);
  });
});

describe('deleting the public copies', () => {
  it('refuses before the move, refuses while files are missing, dry-runs without yes, deletes with yes', async () => {
    const { deletePublicCopies } = await import('../src/node/store.js');
    process.env.CENSUS_BLOB_TOKEN = 'priv';
    await expect(deletePublicCopies({ yes: true, log: () => {} })).rejects.toThrow(/no known.json/);
    await migrateToPrivateIfNeeded(() => {});
    stores.pub!.set('census/history/agg/2026-10.json', '{}'); // written to public after the move? → not in private
    await expect(deletePublicCopies({ yes: true, log: () => {} })).rejects.toThrow(/refusing/);
    stores.pub!.delete('census/history/agg/2026-10.json');
    expect(await deletePublicCopies({ yes: false, log: () => {} })).toBe(0);
    expect(stores.pub!.size).toBe(3);
    expect(await deletePublicCopies({ yes: true, log: () => {} })).toBe(3);
    expect(stores.pub!.size).toBe(0);
    expect(stores.priv!.size).toBe(3);
  });
});
