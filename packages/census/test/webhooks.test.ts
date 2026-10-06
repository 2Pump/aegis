import { describe, expect, it } from 'vitest';
import { API, RateLimiter, handle, type ApiDeps } from '../src/api/index.js';
import { WEBHOOKS, isPrivateIp, makeWebhookApi, newSubscription, plan, rotate, settle, signatureHeader, urlProblem, verifySignature, type SendResult, type Subscription } from '../src/webhooks/index.js';
import { memoryWebhookStore, runWebhooks, safeLookup, type Sender } from '../src/node/index.js';
import type { Observation } from '../src/alerts/model.js';
import type { InkEvent, OracleWatch } from '../src/index.js';

const T = Date.UTC(2026, 9, 5, 12);
const W = '0x' + 'ab'.repeat(20);
const FIX = '0x' + 'f0'.repeat(20);

/** A fake receiver that verifies like a real one would. */
function receiver(o: { status?: (n: number) => number; echo?: boolean } = {}) {
  const got: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
  let n = 0;
  const send: Sender = async (url, body, headers) => {
    got.push({ url, body, headers });
    const status = o.status ? o.status(n++) : 200;
    const parsed = JSON.parse(body) as { event: { data: { challenge?: string } } };
    if (status >= 200 && status < 300) return { ok: true, status, ms: 5, body: o.echo === false ? 'ok' : JSON.stringify({ challenge: parsed.event.data.challenge ?? null }) };
    return { ok: false, status, ms: 5, error: `HTTP ${status}`, retryable: status >= 500 || status === 429 };
  };
  return { send, got };
}
const census = (files: Record<string, unknown> = {}) => ({ get: async (n: string) => (n in files ? files[n] : null) });
const oracleFile = (events: Array<{ id: string; at: number; status: string }>) =>
  ({ kind: 'aegis-oracle-watch', rows: [], events: events.map((e) => ({ ...e, block: 1, asset: '0xa', symbol: 'USDe', kind: 'peg', text: `USDe ${e.status}` })) }) as unknown as OracleWatch;

async function setup(events: string[] = ['oracle.depeg', 'wallet.risk_changed'], wallets: string[] = [W]) {
  const store = memoryWebhookStore();
  let now = T;
  const api = makeWebhookApi({ store, now: () => now, fixtures: new Set([FIX]) });
  const deps: ApiDeps = { get: async () => null, now: () => now, limiter: new RateLimiter(), webhooks: api };
  const r = await handle({ method: 'POST', path: '/webhooks', query: {}, ip: '1.1.1.1', headers: {}, body: JSON.stringify({ url: 'https://hooks.example.com/aegis', events, wallets }) }, deps);
  const created = (r.body as { data: { id: string; secret: string; token: string } }).data;
  return { store, api, deps, created, status: r.status, at: (t: number) => (now = t) };
}

describe('Webhooks · signing and replay protection', () => {
  it('signature: HMAC over timestamp.body; a receiver accepts it; tampering, wrong secret and old timestamps are refused', () => {
    const { sub, secret } = newSubscription({ id: 'wh_x', url: 'https://a.example.com', events: ['oracle.depeg'], wallets: [], nowMs: T });
    const body = '{"x":1}';
    const h = signatureHeader(sub.secrets, body, T);
    expect(h).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(verifySignature(secret, h, body, T).ok).toBe(true);
    expect(verifySignature(secret, h, '{"x":2}', T).reason).toBe('signature does not match');
    expect(verifySignature('whsec_wrong', h, body, T).ok).toBe(false);
    expect(verifySignature(secret, h, body, T + (WEBHOOKS.SIG_TOLERANCE_S + 1) * 1000).reason).toMatch(/replay window/);
    expect(verifySignature(secret, undefined, body, T).ok).toBe(false);
  });

  it('secret rotation: during the grace period both secrets sign; after it only the new one', () => {
    const { sub, secret: old } = newSubscription({ id: 'wh_x', url: 'https://a.example.com', events: ['oracle.depeg'], wallets: [], nowMs: T });
    const r = rotate(sub, T + 1000);
    const body = 'b';
    const during = signatureHeader(r.sub.secrets, body, T + 3_600_000);
    expect(during.split('v1=').length - 1).toBe(2);
    expect(verifySignature(old, during, body, T + 3_600_000).ok).toBe(true);
    expect(verifySignature(r.secret, during, body, T + 3_600_000).ok).toBe(true);
    const after = signatureHeader(r.sub.secrets, body, T + 25 * 3_600_000);
    expect(verifySignature(old, after, body, T + 25 * 3_600_000).ok).toBe(false);
    expect(verifySignature(r.secret, after, body, T + 25 * 3_600_000).ok).toBe(true);
  });
});

describe('Webhooks · SSRF prevention', () => {
  it('only public https on 443; no credentials, IP literals, private names', () => {
    expect(urlProblem('https://hooks.example.com/x')).toBeNull();
    for (const bad of ['http://hooks.example.com', 'https://localhost/x', 'https://127.0.0.1/x', 'https://10.0.0.5/x', 'https://169.254.169.254/latest/meta-data', 'https://[::1]/x', 'https://user:pw@hooks.example.com', 'https://hooks.example.com:8443/x', 'https://printer.local/x', 'https://metadata.google.internal/x', 'https://intranet/x', 'ftp://x.example.com', 'not a url']) {
      expect(urlProblem(bad), bad).not.toBeNull();
    }
  });
  it('private, loopback, link-local, CGNAT, ULA and mapped addresses are recognised', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '224.0.0.1']) expect(isPrivateIp(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111']) expect(isPrivateIp(ip), ip).toBe(false);
  });
  it('the connect-time DNS check refuses a name that resolves to loopback (DNS rebinding)', async () => {
    const err = await new Promise<NodeJS.ErrnoException | null>((res) => safeLookup('localhost', {}, (e) => res(e)));
    expect(err?.message).toMatch(/non-public address/);
  });
});

describe('Webhooks · management API (only when enabled)', () => {
  it('create returns the secret and token once; a wrong token or unknown id is the same 401; fixtures and bad URLs refused', async () => {
    const s = await setup();
    expect(s.status).toBe(201);
    expect(s.created.secret).toMatch(/^whsec_/);
    expect(s.created.token).toMatch(/^whtok_/);
    const stored = (await s.store.get(s.created.id))!;
    expect(JSON.stringify(stored)).not.toContain(s.created.token); // only the hash is kept
    const call = (method: string, path: string, token?: string, body?: unknown) => handle({ method, path, query: {}, ip: '1.1.1.1', headers: token ? { authorization: `Bearer ${token}` } : {}, body: body === undefined ? undefined : JSON.stringify(body) }, s.deps);
    expect((await call('GET', `/webhooks/${s.created.id}`, 'whtok_nope')).status).toBe(401);
    expect((await call('GET', '/webhooks/wh_AAAAAAAAAAAAAAAA', s.created.token)).status).toBe(401);
    const view = (await call('GET', `/webhooks/${s.created.id}`, s.created.token)).body as { data: Record<string, unknown> };
    expect(view.data.status).toBe('pending-verification');
    expect(JSON.stringify(view)).not.toMatch(/whsec_|tokenHash/);
    const fx = await call('POST', '/webhooks', undefined, { url: 'https://hooks.example.com/a', events: ['wallet.risk_changed'], wallets: [FIX] });
    expect((fx.body as { error: { code: string } }).error.code).toBe('FIXTURE_REJECTED');
    const ssrf = await call('POST', '/webhooks', undefined, { url: 'https://169.254.169.254/', events: ['oracle.depeg'] });
    expect(ssrf.status).toBe(400);
    const badEv = await call('POST', '/webhooks', undefined, { url: 'https://hooks.example.com/a', events: ['wallet.balance'] });
    expect(badEv.status).toBe(400);
  });

  it('pause, resume, rotate, test and delete', async () => {
    const s = await setup(['oracle.depeg']);
    const call = (method: string, path: string, body?: unknown) => handle({ method, path, query: {}, ip: '1.1.1.1', headers: { authorization: `Bearer ${s.created.token}` }, body: body === undefined ? undefined : JSON.stringify(body) }, s.deps);
    expect(((await call('PATCH', `/webhooks/${s.created.id}`, { status: 'paused' })).body as { data: { status: string } }).data.status).toBe('paused');
    expect(((await call('PATCH', `/webhooks/${s.created.id}`, { status: 'active' })).body as { data: { status: string } }).data.status).toBe('pending-verification'); // never verified yet
    expect((await call('POST', `/webhooks/${s.created.id}/test`)).status).toBe(400); // not verified
    const rot = (await call('POST', `/webhooks/${s.created.id}/rotate`)).body as { data: { secret: string } };
    expect(rot.data.secret).toMatch(/^whsec_/);
    expect((await s.store.get(s.created.id))!.secrets).toHaveLength(2);
    expect((await call('DELETE', `/webhooks/${s.created.id}`)).status).toBe(200);
    expect(await s.store.get(s.created.id)).toBeNull();
    expect((await call('GET', `/webhooks/${s.created.id}`)).status).toBe(401);
  });
});

describe('Webhooks · delivery run', () => {
  it('endpoint verification first: nothing else is sent until the challenge is echoed; then no backlog', async () => {
    const s = await setup(['oracle.depeg']);
    const files = { 'history/oracle/latest.json': oracleFile([{ id: 'old', at: T - 60_000, status: 'DEPEG' }]) };
    const r1 = receiver({ echo: false });
    await runWebhooks({ store: s.store, census: census(files), send: r1.send, now: () => T });
    expect(r1.got.map((g) => g.headers['Phrourax-Event'])).toEqual(['webhook.verification']);
    expect((await s.store.get(s.created.id))!.status).toBe('pending-verification'); // 2xx without the challenge isn't enough
    const r2 = receiver();
    await runWebhooks({ store: s.store, census: census(files), send: r2.send, now: () => T + 61_000 });
    const sub = (await s.store.get(s.created.id))!;
    expect(sub.status).toBe('active');
    expect(r2.got).toHaveLength(1); // the old DEPEG (before verification) is never sent
    const r3 = receiver();
    await runWebhooks({ store: s.store, census: census({ 'history/oracle/latest.json': oracleFile([{ id: 'new', at: T + 120_000, status: 'DEPEG' }, { id: 'old', at: T - 60_000, status: 'DEPEG' }]) }), send: r3.send, now: () => T + 180_000 });
    expect(r3.got).toHaveLength(1);
    const body = JSON.parse(r3.got[0]!.body) as { schema: string; event: { type: string; id: string } };
    expect(body).toMatchObject({ schema: 'phrourax-webhook-1', event: { type: 'oracle.depeg' } });
    expect(verifySignature(s.created.secret, r3.got[0]!.headers['Phrourax-Signature'], r3.got[0]!.body, T + 180_000).ok).toBe(true);
    expect(r3.got[0]!.headers['Idempotency-Key']).toBe(body.event.id);
  });

  it('retry with exponential backoff, same idempotency key and body each time; then dead-letter; auto-pause after many', () => {
    const { sub: s0 } = newSubscription({ id: 'wh_x', url: 'https://a.example.com', events: ['oracle.depeg'], wallets: [], nowMs: T });
    let sub: Subscription = { ...s0, status: 'active', verifiedAt: T, since: T, challenge: null };
    const ev: InkEvent = { id: 'e1', type: 'oracle.depeg', at: T + 1, block: 1, subject: 'USDe', text: 't', data: {}, urgent: true, version: 'events-1.0.0' };
    sub = plan(sub, [ev], T + 2);
    const d = sub.outbox[0]!;
    const fail: SendResult = { ok: false, status: 503, ms: 5, error: 'HTTP 503', retryable: true };
    let now = T + 2;
    const waits: number[] = [];
    for (let i = 0; i < WEBHOOKS.MAX_ATTEMPTS; i++) {
      const cur = sub.outbox.find((x) => x.eventId === 'e1');
      if (!cur) break;
      expect(cur.body).toBe(d.body);
      sub = settle(sub, cur, fail, now);
      const nxt = sub.outbox.find((x) => x.eventId === 'e1');
      if (nxt) {
        waits.push((nxt.nextAt - now) / 1000);
        now = nxt.nextAt;
      }
    }
    expect(waits).toEqual([...WEBHOOKS.RETRY_S]);
    expect(sub.outbox).toHaveLength(0);
    expect(sub.deadLetter).toHaveLength(1);
    expect(sub.deadLetter[0]!.attempts).toBe(WEBHOOKS.MAX_ATTEMPTS);
    // a final 4xx is not retried
    let s2 = plan({ ...sub, deadLetter: [] }, [{ ...ev, id: 'e2' }], now);
    s2 = settle(s2, s2.outbox[0]!, { ok: false, status: 404, ms: 5, error: 'HTTP 404', retryable: false }, now);
    expect(s2.outbox).toHaveLength(0);
    expect(s2.deadLetter).toHaveLength(1);
    // auto-pause once an endpoint fails everything for long enough
    let s3: Subscription = { ...s2, deadInARow: WEBHOOKS.AUTO_PAUSE_AFTER - 1 };
    s3 = plan(s3, [{ ...ev, id: 'e3' }], now);
    s3 = settle(s3, s3.outbox[0]!, { ok: false, status: 410, ms: 5, error: 'HTTP 410', retryable: false }, now);
    expect(s3.status).toBe('paused');
    expect(s3.pausedReason).toMatch(/automatically/);
  });

  it('idempotency: an event is queued once however many runs see it; paused endpoints get nothing; deleted ones are not resurrected', async () => {
    const s = await setup(['oracle.depeg']);
    const sub = (await s.store.get(s.created.id))!;
    await s.store.put({ ...sub, status: 'active', verifiedAt: T, since: T, challenge: null });
    const files = { 'history/oracle/latest.json': oracleFile([{ id: 'x', at: T + 10, status: 'DEPEG' }]) };
    const r = receiver();
    await runWebhooks({ store: s.store, census: census(files), send: r.send, now: () => T + 100 });
    await runWebhooks({ store: s.store, census: census(files), send: r.send, now: () => T + 200 });
    expect(r.got).toHaveLength(1);
    await s.store.put({ ...(await s.store.get(s.created.id))!, status: 'paused' });
    const r2 = receiver();
    await runWebhooks({ store: s.store, census: census({ 'history/oracle/latest.json': oracleFile([{ id: 'y', at: T + 300, status: 'DEPEG' }]) }), send: r2.send, now: () => T + 400 });
    expect(r2.got).toHaveLength(0);
    await s.store.del(s.created.id);
    await runWebhooks({ store: s.store, census: census(files), send: r2.send, now: () => T + 500 });
    expect(await s.store.get(s.created.id)).toBeNull();
  });

  it('wallet events come from the alerts engine; balance-free payloads; fixture wallets never delivered', async () => {
    const s = await setup(['wallet.risk_changed', 'wallet.classification_changed'], [W]);
    await s.store.put({ ...(await s.store.get(s.created.id))!, status: 'active', verifiedAt: T, since: T, challenge: null });
    const o = (level: string, hf: number): Observation =>
      ({ address: W, readAt: T, dataAt: T, block: 10, tydro: { readable: true, active: true, hf }, nado: { readable: true, active: false, worstBuffer: null, partial: false }, level, hullTemp: level === 'NEAR' ? 'CRITICAL' : 'NOMINAL', primary: 'LEVERED', approximate: false, rulesVersion: 'v1.2.0', engineVersion: 'e', scenarios: {} }) as unknown as Observation;
    let cur = o('SAFE', 2.3);
    const r = receiver();
    const run = (t: number) => runWebhooks({ store: s.store, census: census(), send: r.send, now: () => t, read: async () => cur, fixtures: new Set([FIX]) });
    await run(T + 1000);
    cur = o('NEAR', 1.04);
    await run(T + 2000);
    const bodies = r.got.map((g) => g.body);
    expect(bodies.some((b) => /wallet\.risk_changed/.test(b) && /"to":"NEAR"/.test(b))).toBe(true);
    for (const b of bodies) expect(b).not.toMatch(/1\.04|2\.3|"hf"|"usd"|balance/i);
  });

  it('a delivery whose body was refused by the URL rules fails without a request', async () => {
    const { httpsSender } = await import('../src/node/index.js');
    const r = await httpsSender('https://127.0.0.1/x', '{}', {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/refused/);
      expect(r.retryable).toBe(false);
    }
  });
});

describe('Webhooks are OFF by default', () => {
  it('without a handler the API answers NOT_ENABLED', async () => {
    const r = await handle({ method: 'POST', path: '/webhooks', query: {}, ip: '1', headers: {}, body: '{}' }, { get: async () => null, now: () => T, limiter: new RateLimiter() });
    expect((r.body as { error: { code: string } }).error.code).toBe('NOT_ENABLED');
    expect(API.VERSION).toBe('api-1.0.0');
  });
});
