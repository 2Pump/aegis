/**
 * Desk API keys — /api/v1/keys (docs/API.md).
 *
 *   GET  /keys            the signed-in Desk account's keys: name, last 4 characters, created, last used (never the key)
 *   POST /keys            {name} → {key}: shown ONCE. At most KEYS.MAX_PER_ACCOUNT live keys.
 *   POST /keys/revoke     {id} → the key stops working (within KEYS.CACHE_MS on instances that just used it)
 *
 * A key is `phx_` + 32 random base64url characters. Only its SHA-256 is stored. A request carrying
 * `Authorization: Bearer phx_…` is treated as the key's account: Desk unlocks the paid API; anything else is 402,
 * exactly as for a signed-in session. Rate limits apply per key instead of per IP.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { AuthRequest, AuthResponse } from './api.js';
import { loadUser, sessionUser } from './api.js';
import type { User } from './core.js';
import type { Kv } from './kv.js';
import { apiUnlocked, effectiveAccess } from './paywall.js';
import type { Access } from './core.js';

export const KEYS = {
  VERSION: 'keys-1.0.0',
  PREFIX: 'phx_',
  MAX_PER_ACCOUNT: 5,
  /** a key → account lookup is remembered this long per instance (so a revoke takes effect within it) */
  CACHE_MS: 30_000,
  /** "last used" is written at most this often per key per instance */
  TOUCH_MS: 3_600_000,
  MAX_NAME: 40,
} as const;

export interface KeyRecord {
  id: string;
  name: string;
  /** last 4 characters, to tell keys apart */
  hint: string;
  createdAt: string;
  lastUsedAt: string | null;
  /** sha256 of the key (hex) */
  hash: string;
}

export const isApiKey = (s: string): boolean => /^phx_[A-Za-z0-9_-]{32}$/.test(s);
export const keyHash = (key: string) => createHash('sha256').update(key).digest('hex');
const byHash = (h: string) => `ak:${h}`;
const listKey = (uid: string) => `ak:u:${uid}`;

/** "Bearer phx_…" → the key, or null when the header isn't an API key at all */
export function bearerKey(header: string | string[] | undefined): string | null {
  const v = (Array.isArray(header) ? header[0] : header) ?? '';
  const m = /^Bearer\s+(phx_\S+)$/i.exec(v.trim());
  return m ? m[1]! : null;
}

export async function loadKeys(kv: Kv, uid: string): Promise<KeyRecord[]> {
  const raw = await kv.get(listKey(uid));
  if (!raw) return [];
  try {
    const l = JSON.parse(raw) as KeyRecord[];
    return Array.isArray(l) ? l : [];
  } catch {
    return [];
  }
}
const saveKeys = (kv: Kv, uid: string, l: KeyRecord[]) => kv.set(listKey(uid), JSON.stringify(l));
const view = (k: KeyRecord) => ({ id: k.id, name: k.name, hint: k.hint, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt });

const NO_STORE = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' };
const json = (status: number, body: unknown): AuthResponse => ({ status, headers: { ...NO_STORE }, body });
const err = (status: number, code: string, message: string) => json(status, { error: { code, message } });
const h1 = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export interface KeysDeps {
  kv: Kv;
  secret: Buffer;
  now: () => number;
  comp?: ReadonlySet<string>;
  site: string;
  log?: (m: string) => void;
}

export function makeKeysHandler(d: KeysDeps) {
  const comp = d.comp ?? new Set<string>();
  return async function handleKeys(req: AuthRequest): Promise<AuthResponse> {
    try {
      const u = await sessionUser(d, h1(req.headers.cookie));
      if (req.method === 'GET' && req.path === '/keys') {
        if (!u) return err(401, 'SIGN_IN', 'Sign in first.');
        return json(200, { desk: apiUnlocked(effectiveAccess(u, d.now(), comp)), max: KEYS.MAX_PER_ACCOUNT, keys: (await loadKeys(d.kv, u.id)).map(view) });
      }
      if (req.method !== 'POST') return err(405, 'METHOD_NOT_ALLOWED', 'Use POST.');
      if (!String(h1(req.headers['content-type']) ?? '').toLowerCase().startsWith('application/json')) return err(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send JSON.');
      const origin = h1(req.headers.origin);
      if (origin && origin !== d.site) return err(403, 'FORBIDDEN', 'Cross-site request refused.');
      if ((req.body?.length ?? 0) > 1024) return err(413, 'PAYLOAD_TOO_LARGE', 'Request too large.');
      if (!u) return err(401, 'SIGN_IN', 'Sign in first.');
      let body: Record<string, unknown> = {};
      try {
        body = (JSON.parse(req.body ?? '{}') as Record<string, unknown>) ?? {};
      } catch {
        /* empty */
      }
      const list = await loadKeys(d.kv, u.id);
      if (req.path === '/keys/revoke') {
        const k = list.find((x) => x.id === body.id);
        if (!k) return err(404, 'NOT_FOUND', 'No such key.');
        await d.kv.del(byHash(k.hash));
        await saveKeys(d.kv, u.id, list.filter((x) => x !== k));
        return json(200, { revoked: k.id, keys: list.filter((x) => x !== k).map(view) });
      }
      if (req.path !== '/keys') return err(404, 'NOT_FOUND', 'No such endpoint.');
      if (!apiUnlocked(effectiveAccess(u, d.now(), comp))) return err(402, 'PAYMENT_REQUIRED', 'API keys come with the Desk plan.');
      if ((await d.kv.incrWindow(`rl:ak:${u.id}`, 3600)) > 20) return err(429, 'RATE_LIMITED', 'Too many new keys — try again in an hour.');
      if (list.length >= KEYS.MAX_PER_ACCOUNT) return err(400, 'TOO_MANY_KEYS', `At most ${KEYS.MAX_PER_ACCOUNT} keys. Revoke one first.`);
      const name = String(body.name ?? '').trim().replace(/[\u0000-\u001f]/g, '').slice(0, KEYS.MAX_NAME) || `Key ${list.length + 1}`;
      const key = `${KEYS.PREFIX}${randomBytes(24).toString('base64url')}`;
      const rec: KeyRecord = { id: `key_${randomBytes(8).toString('base64url')}`, name, hint: key.slice(-4), createdAt: new Date(d.now()).toISOString(), lastUsedAt: null, hash: keyHash(key) };
      await d.kv.set(byHash(rec.hash), JSON.stringify({ uid: u.id, id: rec.id }));
      await saveKeys(d.kv, u.id, [...list, rec]);
      return json(201, { key, shownOnce: 'Copy it now — Phrourax stores only a fingerprint of it and cannot show it again.', keys: [...list, rec].map(view) });
    } catch (e) {
      d.log?.(`keys: ${String(e).slice(0, 200)}`);
      return err(503, 'UNAVAILABLE', 'API keys are temporarily unavailable — try again shortly.');
    }
  };
}

/**
 * Who an API key belongs to and what it can use, remembered for KEYS.CACHE_MS per instance. null = not a live key.
 * Also notes "last used" (at most hourly per key per instance).
 */
export function makeKeyResolver(d: Pick<KeysDeps, 'kv' | 'now' | 'comp' | 'log'>) {
  const comp = d.comp ?? new Set<string>();
  const cache = new Map<string, { at: number; v: { uid: string; keyId: string; access: Access; email: string } | null }>();
  const touched = new Map<string, number>();
  return async (key: string): Promise<{ uid: string; keyId: string; access: Access; email: string } | null> => {
    if (!isApiKey(key)) return null;
    const h = keyHash(key);
    const hit = cache.get(h);
    const now = d.now();
    if (hit && now - hit.at < KEYS.CACHE_MS) return hit.v;
    let v: { uid: string; keyId: string; access: Access; email: string } | null = null;
    const raw = await d.kv.get(byHash(h));
    if (raw) {
      const { uid, id } = JSON.parse(raw) as { uid: string; id: string };
      const u: User | null = await loadUser(d.kv, uid);
      if (u) v = { uid, keyId: id, access: effectiveAccess(u, now, comp), email: u.email };
      if (u && now - (touched.get(h) ?? 0) > KEYS.TOUCH_MS) {
        touched.set(h, now);
        const list = await loadKeys(d.kv, uid);
        const k = list.find((x) => x.id === id);
        if (k) {
          k.lastUsedAt = new Date(now).toISOString();
          await saveKeys(d.kv, uid, list).catch(() => {});
        }
      }
    }
    if (cache.size > 5000) cache.clear();
    cache.set(h, { at: now, v });
    return v;
  };
}
