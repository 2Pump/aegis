/**
 * Where the alerts db lives between runs — ENCRYPTED at rest (AES-256-GCM). Chat ids are personal data; the census
 * blobs are public, so the alerts db is never written in the clear. The key (ALERTS_STORE_KEY, 32 random bytes,
 * base64) lives only in the server's secrets. Losing the key = the db can't be read (a fresh one is NOT silently
 * started: the run stops and says so, so nobody's watches vanish without notice).
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isAlertsDb, type AlertsDb } from '../alerts/model.js';

export interface AlertsStore {
  describe: string;
  /** null = nothing stored yet. Throws if something is stored but can't be decrypted/understood. */
  load(): Promise<AlertsDb | null>;
  save(db: AlertsDb): Promise<void>;
}

export function parseStoreKey(b64: string | undefined): Buffer {
  if (!b64) throw new Error('ALERTS_STORE_KEY is not set (32 random bytes, base64 — e.g. `node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"`)');
  const k = Buffer.from(b64.trim(), 'base64');
  if (k.length !== 32) throw new Error(`ALERTS_STORE_KEY must decode to 32 bytes (got ${k.length})`);
  return k;
}

interface Sealed {
  v: 1;
  alg: 'AES-256-GCM';
  iv: string;
  tag: string;
  data: string;
}

export function seal(key: Buffer, body: unknown): Sealed {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(JSON.stringify(body), 'utf8'), c.final()]);
  return { v: 1, alg: 'AES-256-GCM', iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
}

export function unseal(key: Buffer, s: unknown): unknown {
  const x = s as Sealed;
  if (!x || x.v !== 1 || x.alg !== 'AES-256-GCM') throw new Error('alerts store: not an AEGIS sealed object');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(x.iv, 'base64'));
  d.setAuthTag(Buffer.from(x.tag, 'base64'));
  try {
    return JSON.parse(Buffer.concat([d.update(Buffer.from(x.data, 'base64')), d.final()]).toString('utf8'));
  } catch {
    throw new Error('alerts store: could not decrypt (wrong ALERTS_STORE_KEY, or the object was tampered with)');
  }
}

/** Salted hash of a chat id for the audit log — stable per key, meaningless without it. */
export const chatHasher = (key: Buffer) => (chatId: string) => createHmac('sha256', key).update(`chat:${chatId}`).digest('hex').slice(0, 12);

/** The object's name is derived from the key, so it can't be guessed from the repo. */
const objectName = (key: Buffer) => `alerts/${createHmac('sha256', key).update('aegis-alerts-store').digest('hex').slice(0, 24)}.sealed.json`;

const decode = (key: Buffer, raw: unknown): AlertsDb => {
  const db = unseal(key, raw);
  if (!isAlertsDb(db)) throw new Error('alerts store: decrypted, but it is not an alerts db — refusing to overwrite it');
  return { ...db, outbox: db.outbox ?? [], checked: db.checked ?? {} };
};

export function memoryAlertsStore(key: Buffer = randomBytes(32)): AlertsStore & { raw(): unknown } {
  let raw: unknown = null;
  return {
    describe: 'memory',
    raw: () => raw,
    async load() {
      return raw === null ? null : decode(key, raw);
    },
    async save(db) {
      raw = seal(key, db);
    },
  };
}

export function fileAlertsStore(path: string, key: Buffer): AlertsStore {
  return {
    describe: `file:${path} (encrypted)`,
    async load() {
      let txt: string;
      try {
        txt = await readFile(path, 'utf8');
      } catch {
        return null;
      }
      return decode(key, JSON.parse(txt));
    },
    async save(db) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(seal(key, db)));
    },
  };
}

/** Vercel Blob (BLOB_READ_WRITE_TOKEN). The object is public like every blob in the store — and useless without the key. */
export async function blobAlertsStore(key: Buffer): Promise<AlertsStore> {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) throw new Error('BLOB_READ_WRITE_TOKEN is not set');
  const { put, list } = await import('@vercel/blob');
  const name = objectName(key);
  return {
    describe: 'vercel-blob (encrypted)',
    async load() {
      const { blobs } = await list({ prefix: name, token, limit: 2 });
      const hit = blobs.find((b) => b.pathname === name);
      if (!hit) return null;
      const res = await fetch(`${hit.url}?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`alerts store: HTTP ${res.status}`);
      return decode(key, await res.json());
    },
    async save(db) {
      await put(name, JSON.stringify(seal(key, db)), { access: 'public', token, contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 0 });
    },
  };
}
