import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Where the census lives between runs.
 *  - file: a folder (default apps/web/public/census) — for local runs; `pnpm dev` then serves it at /census/census.json
 *  - blob: Vercel Blob (public URLs) — for the hourly GitHub Action; the site fetches the public URL
 * Three objects: census.json (what the site draws), known.json (discovery cursors + address book for the job) and
 * pressure.json (Pressure Map aggregates, written by full sweeps only).
 */
export interface CensusStore {
  describe: string;
  get(name: 'census.json' | 'known.json' | 'pressure.json' | 'verification-log.json'): Promise<unknown | null>;
  put(name: 'census.json' | 'known.json' | 'pressure.json' | 'verification-log.json', body: unknown): Promise<string>;
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

/** Vercel Blob. Needs BLOB_READ_WRITE_TOKEN (create a Blob store in Vercel → Storage, connect it, copy the token). */
export async function blobStore(prefix = 'census'): Promise<CensusStore> {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) throw new Error('BLOB_READ_WRITE_TOKEN is not set (Vercel → Storage → Blob → your store → .env.local tab)');
  const { put, list } = await import('@vercel/blob');
  const urlOf = async (name: string): Promise<string | null> => {
    const { blobs } = await list({ prefix: `${prefix}/${name}`, token, limit: 5 });
    const hit = blobs.find((b) => b.pathname === `${prefix}/${name}`);
    return hit ? hit.url : null;
  };
  return {
    describe: `vercel-blob:${prefix}/`,
    async get(name) {
      const url = await urlOf(name);
      if (!url) return null;
      const res = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`blob get ${name}: HTTP ${res.status}`);
      return res.json();
    },
    async put(name, body) {
      const r = await put(`${prefix}/${name}`, JSON.stringify(body), {
        access: 'public',
        token,
        contentType: 'application/json',
        addRandomSuffix: false,
        allowOverwrite: true,
        cacheControlMaxAge: 60,
      });
      return r.url;
    },
  };
}
