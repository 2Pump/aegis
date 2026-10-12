import { describe, expect, it } from 'vitest';
import { ACCOUNTS, KEYS, bearerKey, isApiKey, keyHash, makeKeyResolver, makeKeysHandler, memoryKv, newUser, saveUser, signSession, type User } from '../src/accounts/index.js';
import { RateLimiter, handle, type ApiDeps } from '../src/api/index.js';
import { makeWebhookApi, type WebhookOwners } from '../src/webhooks/index.js';
import { memoryWebhookStore } from '../src/node/index.js';

const SITE = 'https://phrourax.com';
const secret = Buffer.alloc(32, 3);
const DAY = 86_400_000;

function setup() {
  let t = Date.UTC(2026, 9, 12, 12);
  const now = () => t;
  const kv = memoryKv(now);
  const keys = makeKeysHandler({ kv, secret, now, site: SITE, comp: new Set(['owner@phrourax.co']) });
  const resolve = makeKeyResolver({ kv, now, comp: new Set(['owner@phrourax.co']) });
  const user = async (email: string, plan: 'pro' | 'desk' | null, days = 30): Promise<{ u: User; cookie: string }> => {
    const u = newUser(email, t);
    if (plan) {
      u.plan = plan;
      u.paidUntil = new Date(t + days * DAY).toISOString();
    }
    await saveUser(kv, u);
    return { u, cookie: `${ACCOUNTS.COOKIE}=${signSession(secret, u, t)}` };
  };
  const post = (path: string, body: unknown, cookie: string) => keys({ method: 'POST', path, ip: 'x', headers: { 'content-type': 'application/json', origin: SITE, cookie }, body: JSON.stringify(body) });
  const list = async (cookie: string) => (await keys({ method: 'GET', path: '/keys', ip: 'x', headers: { cookie } })).body as { desk: boolean; keys: Array<{ id: string; name: string; hint: string; lastUsedAt: string | null }> };
  return { kv, keys, resolve, user, post, list, advance: (ms: number) => (t += ms), now };
}

describe('Desk API keys', () => {
  it('only Desk (or complimentary) accounts make keys; a key is shown once and only its fingerprint is stored', async () => {
    const s = setup();
    const pro = await s.user('pro@x.co', 'pro');
    expect((await s.post('/keys', { name: 'bot' }, pro.cookie)).status).toBe(402);
    expect((await s.post('/keys', { name: 'bot' }, 'nope')).status).toBe(401);
    const owner = await s.user('owner@phrourax.co', null);
    const r = await s.post('/keys', { name: 'bot' }, owner.cookie);
    expect(r.status).toBe(201);
    const key = (r.body as { key: string }).key;
    expect(isApiKey(key)).toBe(true);
    for (const [, v] of s.kv.dump()) expect(v.v).not.toContain(key);
    expect(s.kv.dump().has(`ak:${keyHash(key)}`)).toBe(true);
    const l = await s.list(owner.cookie);
    expect(l.keys).toEqual([expect.objectContaining({ name: 'bot', hint: key.slice(-4), lastUsedAt: null })]);
    expect(JSON.stringify(l)).not.toContain(key);
  });

  it(`at most ${KEYS.MAX_PER_ACCOUNT} keys; revoking one stops it (after the ${KEYS.CACHE_MS / 1000} s per-instance memory)`, async () => {
    const s = setup();
    const d = await s.user('desk@x.co', 'desk');
    const made: string[] = [];
    for (let i = 0; i < KEYS.MAX_PER_ACCOUNT; i++) made.push(((await s.post('/keys', { name: `k${i}` }, d.cookie)).body as { key: string }).key);
    expect((await s.post('/keys', {}, d.cookie)).status).toBe(400);
    expect(await s.resolve(made[0]!)).toMatchObject({ uid: d.u.id, access: 'desk' });
    const id = (await s.list(d.cookie)).keys[0]!.id;
    expect((await s.post('/keys/revoke', { id }, d.cookie)).status).toBe(200);
    expect(await s.resolve(made[0]!)).not.toBeNull(); // still remembered on this instance
    s.advance(KEYS.CACHE_MS + 1);
    expect(await s.resolve(made[0]!)).toBeNull();
    expect(await s.resolve(made[1]!)).toMatchObject({ access: 'desk' });
    expect((await s.list(d.cookie)).keys[0]!.lastUsedAt).not.toBeNull();
    expect(await s.resolve('phx_not-a-real-key')).toBeNull();
  });

  it('a key follows its account\'s plan: when Desk ends it reads as free (the API then answers 402)', async () => {
    const s = setup();
    const d = await s.user('desk@x.co', 'desk', 1);
    const key = ((await s.post('/keys', {}, d.cookie)).body as { key: string }).key;
    expect((await s.resolve(key))!.access).toBe('desk');
    s.advance(2 * DAY);
    expect((await s.resolve(key))!.access).toBe('free');
  });

  it('bearer parsing: only "Bearer phx_…" is an API key', () => {
    expect(bearerKey('Bearer phx_abc')).toBe('phx_abc');
    expect(bearerKey('bearer   phx_abc ')).toBe('phx_abc');
    expect(bearerKey('Bearer whtok_abc')).toBeNull();
    expect(bearerKey(undefined)).toBeNull();
  });
});

describe('Webhooks are Desk-only', () => {
  function hooks(o: { owner?: string | null; desk?: boolean; max?: number } = {}) {
    const store = memoryWebhookStore();
    const owned = new Map<string, Set<string>>();
    let desk = o.desk ?? true;
    const owners: WebhookOwners = {
      max: o.max ?? 2,
      authorize: async () => (o.owner === null ? { ok: false, code: 'UNAUTHORIZED', message: 'needs a key' } : desk ? { ok: true, owner: o.owner ?? 'u1' } : { ok: false, code: 'PAYMENT_REQUIRED', message: 'Desk' }),
      active: async () => desk,
      count: async (u) => owned.get(u)?.size ?? 0,
      add: async (u, id) => void owned.set(u, new Set([...(owned.get(u) ?? []), id])),
      remove: async (u, id) => void owned.get(u)?.delete(id),
    };
    const api = makeWebhookApi({ store, now: () => Date.UTC(2026, 9, 12), owners });
    const deps: ApiDeps = { get: async () => null, now: () => Date.UTC(2026, 9, 12), limiter: new RateLimiter(), webhooks: api };
    const create = () => handle({ method: 'POST', path: '/webhooks', query: {}, ip: '1', headers: {}, body: JSON.stringify({ url: 'https://hooks.example.com/x', events: ['oracle.depeg'] }) }, deps);
    const call = (method: string, id: string, token: string, body?: unknown) => handle({ method, path: `/webhooks/${id}`, query: {}, ip: '1', headers: { authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) }, deps);
    return { store, owned, create, call, endDesk: () => (desk = false) };
  }

  it('creating needs a Desk account; each account has a limit; the owner is recorded', async () => {
    expect((await hooks({ owner: null }).create()).status).toBe(401);
    expect((await hooks({ desk: false }).create()).status).toBe(402);
    const h = hooks({ max: 2 });
    const a = await h.create();
    expect(a.status).toBe(201);
    const id = (a.body as { data: { id: string } }).data.id;
    expect((await h.store.get(id))!.owner).toBe('u1');
    expect((await h.create()).status).toBe(201);
    expect((await h.create()).status).toBe(400);
  });

  it('when Desk ends, a paused webhook cannot be switched back on; deleting frees a slot', async () => {
    const h = hooks({ max: 1 });
    const d = (await h.create()).body as { data: { id: string; token: string } };
    expect((await h.call('PATCH', d.data.id, d.data.token, { status: 'paused' })).status).toBe(200);
    h.endDesk();
    expect((await h.call('PATCH', d.data.id, d.data.token, { status: 'active' })).status).toBe(402);
    expect((await h.call('DELETE', d.data.id, d.data.token)).status).toBe(200);
    expect(h.owned.get('u1')!.size).toBe(0);
  });
});

describe('Webhook test receiver (Desk)', () => {
  it('a Desk account gets a receiver URL; it echoes the verification challenge and keeps the last 20 deliveries', async () => {
    const { makeHookTestHandler } = await import('../src/accounts/index.js');
    const s = setup();
    const h = makeHookTestHandler({ kv: s.kv, secret, now: s.now, site: SITE });
    const pro = await s.user('pro@x.co', 'pro');
    expect((await h({ method: 'GET', path: '/hooktest', ip: 'x', headers: { cookie: pro.cookie } })).status).toBe(402);
    const d = await s.user('desk@x.co', 'desk');
    const me = (await h({ method: 'GET', path: '/hooktest', ip: 'x', headers: { cookie: d.cookie } })).body as { url: string; deliveries: unknown[] };
    expect(me.url).toMatch(/^https:\/\/phrourax\.com\/api\/v1\/hooktest\/[A-Za-z0-9_-]{24}$/);
    const path = new URL(me.url).pathname.replace('/api/v1', '');
    const deliver = (body: unknown, sig = 't=1,v1=' + 'a'.repeat(64)) => h({ method: 'POST', path, ip: 'w', headers: { 'phrourax-signature': sig }, body: JSON.stringify(body) });
    const v = await deliver({ deliveryId: 'dlv_1', event: { type: 'webhook.verification', text: 'verify', data: { challenge: 'CH-123' } } });
    expect(JSON.stringify(v.body)).toContain('CH-123');
    for (let i = 0; i < 25; i++) await deliver({ deliveryId: `dlv_${i + 2}`, event: { type: 'webhook.test', text: 't' } });
    const after = (await h({ method: 'GET', path: '/hooktest', ip: 'x', headers: { cookie: d.cookie } })).body as { deliveries: Array<{ event: string; signed: boolean }> };
    expect(after.deliveries).toHaveLength(20);
    expect(after.deliveries[0]).toMatchObject({ event: 'webhook.test', signed: true });
    expect((await h({ method: 'POST', path: '/hooktest/' + 'x'.repeat(24), ip: 'w', headers: {}, body: '{}' })).status).toBe(404);
  });
});
