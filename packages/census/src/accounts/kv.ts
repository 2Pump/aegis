/**
 * The accounts store: a tiny key-value interface. Production uses Upstash Redis over its REST API (added to the
 * Vercel project from Storage → Marketplace → Upstash; Vercel then sets KV_REST_API_URL / KV_REST_API_TOKEN).
 * Tests use the in-memory one.
 */
export interface Kv {
  get(key: string): Promise<string | null>;
  /** set, optionally expiring after ttlS seconds */
  set(key: string, value: string, ttlS?: number): Promise<void>;
  /** read and delete in one step (a sign-in link works once) */
  getdel(key: string): Promise<string | null>;
  /** add 1; the first add starts a window of ttlS seconds. Returns the new count. */
  incrWindow(key: string, ttlS: number): Promise<number>;
  del(key: string): Promise<void>;
  /** set only if the key doesn't exist yet; true when this call set it (a payment is applied once) */
  setIfAbsent(key: string, value: string, ttlS?: number): Promise<boolean>;
}

export function memoryKv(now: () => number = Date.now): Kv & { dump(): Map<string, { v: string; exp: number | null }> } {
  const m = new Map<string, { v: string; exp: number | null }>();
  const live = (k: string) => {
    const x = m.get(k);
    if (x && x.exp !== null && x.exp <= now()) {
      m.delete(k);
      return undefined;
    }
    return x;
  };
  return {
    async get(k) {
      return live(k)?.v ?? null;
    },
    async set(k, v, ttlS) {
      m.set(k, { v, exp: ttlS ? now() + ttlS * 1000 : null });
    },
    async getdel(k) {
      const x = live(k);
      m.delete(k);
      return x?.v ?? null;
    },
    async incrWindow(k, ttlS) {
      const x = live(k);
      const n = (x ? Number(x.v) : 0) + 1;
      m.set(k, { v: String(n), exp: x ? x.exp : now() + ttlS * 1000 });
      return n;
    },
    async del(k) {
      m.delete(k);
    },
    async setIfAbsent(k, v, ttlS) {
      if (live(k)) return false;
      m.set(k, { v, exp: ttlS ? now() + ttlS * 1000 : null });
      return true;
    },
    dump: () => m,
  };
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export function upstashKv(o: { url: string; token: string; fetch?: FetchLike }): Kv {
  const f = o.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const base = o.url.replace(/\/+$/, '');
  const cmd = async (...args: (string | number)[]): Promise<unknown> => {
    const r = await f(base, { method: 'POST', headers: { Authorization: `Bearer ${o.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args.map(String)) });
    const j = (await r.json().catch(() => null)) as { result?: unknown; error?: string } | null;
    if (!r.ok || !j || j.error) throw new Error(`accounts store: ${j?.error ?? `HTTP ${r.status}`}`);
    return j.result;
  };
  return {
    async get(k) {
      return ((await cmd('GET', k)) as string | null) ?? null;
    },
    async set(k, v, ttlS) {
      await (ttlS ? cmd('SET', k, v, 'EX', ttlS) : cmd('SET', k, v));
    },
    async getdel(k) {
      return ((await cmd('GETDEL', k)) as string | null) ?? null;
    },
    async incrWindow(k, ttlS) {
      const n = Number(await cmd('INCR', k));
      if (n === 1) await cmd('EXPIRE', k, ttlS);
      return n;
    },
    async del(k) {
      await cmd('DEL', k);
    },
    async setIfAbsent(k, v, ttlS) {
      return (await (ttlS ? cmd('SET', k, v, 'NX', 'EX', ttlS) : cmd('SET', k, v, 'NX'))) === 'OK';
    },
  };
}
