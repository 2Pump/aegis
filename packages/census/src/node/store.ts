import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Where the census lives between runs.
 *  - file: a folder (default apps/web/public/census) — for local runs; `pnpm dev` then serves it at /census/census.json
 *  - blob: Vercel Blob — for the hourly GitHub Action (public store, or the private one when CENSUS_BLOB_TOKEN is set)
 * Three objects: census.json (what the site draws), known.json (discovery cursors + address book for the job) and
 * pressure.json (Pressure Map aggregates, written by full sweeps only).
 */
/** history/… = the Flight Recorder (history.ts); everything else is one fixed file */
export type StoreName = 'census.json' | 'known.json' | 'pressure.json' | 'verification-log.json' | `history/${string}.json` | `depth/${string}.json`;

export interface CensusStore {
  describe: string;
  get(name: StoreName): Promise<unknown | null>;
  put(name: StoreName, body: unknown): Promise<string>;
}

export function fileStore(dir: string): CensusStore {
  return {
    describe: `file:${dir}`,
    async get(name) {
      try {
        return JSON.parse(await readFile(join(dir, name), 'utf8'));
      } catch {
        return null;
      }
    },
    async put(name, body) {
      const p = join(dir, name);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, JSON.stringify(body));
      return p;
    },
  };
}

/**
 * Vercel Blob.
 *  - CENSUS_BLOB_TOKEN set → the PRIVATE census store (paid access, docs/PAYWALL.md): nothing is readable without the
 *    token; the site reads files through its own function, which checks the visitor's plan.
 *  - otherwise BLOB_READ_WRITE_TOKEN → the original PUBLIC store (anyone with a file's URL can read it).
 */
export async function blobStore(prefix = 'census'): Promise<CensusStore> {
  const privateToken = process.env.CENSUS_BLOB_TOKEN;
  const token = privateToken || process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) throw new Error('BLOB_READ_WRITE_TOKEN is not set (Vercel → Storage → Blob → your store → .env.local tab)');
  const access = privateToken ? ('private' as const) : ('public' as const);
  const blob = await import('@vercel/blob');
  const urlOf = async (name: string): Promise<string | null> => {
    const { blobs } = await blob.list({ prefix: `${prefix}/${name}`, token, limit: 5 });
    const hit = blobs.find((b) => b.pathname === `${prefix}/${name}`);
    return hit ? hit.url : null;
  };
  // read-your-writes within one run: Blob reads can go through a CDN (cacheControlMaxAge 60), so a read soon after a
  // write can return the previous copy — and a step that read-modify-writes (e.g. the history index) would then
  // silently drop what an earlier step just wrote. What this process wrote is returned as written.
  const written = new Map<string, string>();
  return {
    describe: `vercel-blob${access === 'private' ? ' (private)' : ''}:${prefix}/`,
    async get(name) {
      const mine = written.get(name);
      if (mine !== undefined) return JSON.parse(mine);
      if (access === 'private') {
        const r = await blob.get(`${prefix}/${name}`, { access: 'private', token, useCache: false }).catch((e: unknown) => {
          if (/not.?found|404/i.test(String(e))) return null;
          throw e;
        });
        if (!r || r.statusCode !== 200) return null;
        return new Response(r.stream).json();
      }
      const url = await urlOf(name);
      if (!url) return null;
      const res = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`blob get ${name}: HTTP ${res.status}`);
      return res.json();
    },
    async put(name, body) {
      const text = JSON.stringify(body);
      const r = await blob.put(`${prefix}/${name}`, text, {
        access,
        token,
        contentType: 'application/json',
        addRandomSuffix: false,
        allowOverwrite: true,
        cacheControlMaxAge: 60,
      });
      written.set(name, text);
      return r.url;
    },
  };
}

/**
 * Moving to the private store (docs/PAYWALL.md), done by the census job itself so no run can see a half-empty store:
 * when CENSUS_BLOB_TOKEN is set and the private store has no known.json yet, every census/… file is copied from the
 * public store (BLOB_READ_WRITE_TOKEN) first. Copies are byte-for-byte; the public files are left in place (a separate,
 * deliberate step deletes them). Returns how many files were copied (0 = nothing to do).
 */
export async function migrateToPrivateIfNeeded(log: (m: string) => void = console.log, prefix = 'census'): Promise<number> {
  const priv = process.env.CENSUS_BLOB_TOKEN;
  const pub = process.env.BLOB_READ_WRITE_TOKEN;
  if (!priv) return 0;
  const blob = await import('@vercel/blob');
  const has = await blob.list({ prefix: `${prefix}/known.json`, token: priv, limit: 5 });
  if (has.blobs.some((b) => b.pathname === `${prefix}/known.json`)) return 0;
  if (!pub) throw new Error('private census store is empty and BLOB_READ_WRITE_TOKEN (the public store) is not set — nothing to copy from; refusing to start a census from scratch');
  const all: Array<{ pathname: string; url: string; size: number }> = [];
  let cursor: string | undefined;
  do {
    const page = await blob.list({ prefix: `${prefix}/`, token: pub, limit: 1000, cursor });
    all.push(...page.blobs.map((b) => ({ pathname: b.pathname, url: b.url, size: b.size })));
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  if (!all.some((b) => b.pathname === `${prefix}/known.json`)) throw new Error('the public store has no known.json either — refusing to migrate a store that was never written');
  log(`private store is empty: copying ${all.length} files (${(all.reduce((n, b) => n + b.size, 0) / 1e6).toFixed(1)} MB) from the public store…`);
  let done = 0;
  const queue = [...all];
  // known.json last: its presence is the "migration finished" marker
  queue.sort((a, b) => Number(a.pathname === `${prefix}/known.json`) - Number(b.pathname === `${prefix}/known.json`));
  const worker = async () => {
    for (let b = queue.shift(); b && b.pathname !== `${prefix}/known.json`; b = queue.shift()) await copyOne(b);
  };
  const copyOne = async (b: { pathname: string; url: string }) => {
    const res = await fetch(`${b.url}?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`copy ${b.pathname}: HTTP ${res.status}`);
    await blob.put(b.pathname, await res.text(), { access: 'private', token: priv, contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 60 });
    if (++done % 100 === 0) log(`  copied ${done}/${all.length}`);
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  const known = all.find((b) => b.pathname === `${prefix}/known.json`)!;
  await copyOne(known);
  log(`copied ${done} files to the private store — the census continues there from now on`);
  return done;
}

/** Read-only access to the private census store (the site's function uses this; it never writes). */
export function privateCensusReader(token: string, prefix = 'census'): (name: string) => Promise<unknown | null> {
  let sdk: Promise<typeof import('@vercel/blob')> | null = null;
  return async (name) => {
    sdk ??= import('@vercel/blob');
    const { get } = await sdk;
    const r = await get(`${prefix}/${name}`, { access: 'private', token }).catch((e: unknown) => {
      if (/not.?found|404/i.test(String(e))) return null;
      throw e;
    });
    if (!r || r.statusCode !== 200) return null;
    return new Response(r.stream).json();
  };
}

/**
 * After the move (docs/PAYWALL.md): delete the census files from the PUBLIC store so the old public URLs stop working.
 * Refuses unless the private store already holds every file the public one does. Without `yes` it only reports.
 */
export async function deletePublicCopies(o: { yes: boolean; log?: (m: string) => void; prefix?: string }): Promise<number> {
  const log = o.log ?? console.log;
  const prefix = `${o.prefix ?? 'census'}/`;
  const pub = process.env.BLOB_READ_WRITE_TOKEN;
  const priv = process.env.CENSUS_BLOB_TOKEN;
  if (!pub || !priv) throw new Error('needs both BLOB_READ_WRITE_TOKEN (public store) and CENSUS_BLOB_TOKEN (private store)');
  const blob = await import('@vercel/blob');
  const all = async (token: string) => {
    const out: Array<{ pathname: string; url: string }> = [];
    let cursor: string | undefined;
    do {
      const page = await blob.list({ prefix, token, limit: 1000, cursor });
      out.push(...page.blobs.map((b) => ({ pathname: b.pathname, url: b.url })));
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return out;
  };
  const [p, q] = await Promise.all([all(pub), all(priv)]);
  const inPrivate = new Set(q.map((b) => b.pathname));
  log(`public store: ${p.length} census files · private store: ${q.length}`);
  if (!inPrivate.has(`${prefix}known.json`)) throw new Error('the private store has no known.json — the move has not happened yet; nothing deleted');
  const missing = p.filter((b) => !inPrivate.has(b.pathname));
  if (missing.length) {
    log(`${missing.length} public files are not in the private store, e.g. ${missing.slice(0, 5).map((b) => b.pathname).join(', ')}`);
    throw new Error('refusing to delete: let the census run once against the private store first; nothing deleted');
  }
  if (!o.yes) {
    log(`would delete ${p.length} public files (confirm to delete)`);
    return 0;
  }
  for (let i = 0; i < p.length; i += 100) await blob.del(p.slice(i, i + 100).map((b) => b.url), { token: pub });
  log(`deleted ${p.length} census files from the public store — the old public URLs no longer work`);
  return p.length;
}
