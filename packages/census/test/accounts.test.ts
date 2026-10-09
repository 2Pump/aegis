import { describe, expect, it } from 'vitest';
import {
  ACCOUNTS,
  access,
  accountsOff,
  makeAccountsHandler,
  memoryKv,
  normalizeEmail,
  parseAuthSecret,
  safeNext,
  signSession,
  upstashKv,
  verifySession,
  type Mail,
} from '../src/accounts/index.js';

const SITE = 'https://phrourax.com';
const secret = Buffer.alloc(32, 7);

function setup() {
  let t = Date.UTC(2026, 9, 9, 12);
  const now = () => t;
  const kv = memoryKv(now);
  const sent: Mail[] = [];
  const h = makeAccountsHandler({ kv, secret, now, site: SITE, mail: async (m) => void sent.push(m) });
  const post = (path: string, body: unknown, extra: Record<string, string> = {}) =>
    h({ method: 'POST', path, ip: '1.1.1.1', headers: { 'content-type': 'application/json', origin: SITE, ...extra }, body: JSON.stringify(body) });
  const me = (cookie?: string) => h({ method: 'GET', path: '/auth/me', ip: '1.1.1.1', headers: cookie ? { cookie } : {} });
  const tokenOf = (m: Mail) => m.text.match(/#t=([A-Za-z0-9_-]{43})/)![1]!;
  const cookieOf = (setCookie: string) => setCookie.split(';')[0]!;
  return { h, kv, sent, post, me, tokenOf, cookieOf, advance: (ms: number) => (t += ms), now };
}

describe('accounts', () => {
  it('emails: normalised, strict', () => {
    expect(normalizeEmail('  Me@Example.COM ')).toBe('me@example.com');
    for (const bad of ['', 'me', 'me@', '@x.com', 'me@x', 'me@@x.com', 'a..b@x.com', 42, null, `${'a'.repeat(250)}@x.com`]) expect(normalizeEmail(bad)).toBeNull();
  });

  it('a plan counts only while its paid period runs', () => {
    const now = Date.UTC(2026, 9, 9);
    expect(access(null, now)).toBe('free');
    expect(access({ plan: null, paidUntil: null }, now)).toBe('free');
    expect(access({ plan: 'pro', paidUntil: '2026-10-10T00:00:00Z' }, now)).toBe('pro');
    expect(access({ plan: 'desk', paidUntil: '2026-10-08T00:00:00Z' }, now)).toBe('free');
  });

  it('sessions: signed, expire, and a tampered cookie is refused', () => {
    const now = Date.UTC(2026, 9, 9);
    const tok = signSession(secret, { id: 'abc', sv: 1 }, now);
    expect(verifySession(secret, tok, now)?.u).toBe('abc');
    expect(verifySession(Buffer.alloc(32, 8), tok, now)).toBeNull();
    const [v, body, sig] = tok.split('.');
    const forged = Buffer.from(JSON.stringify({ u: 'someone-else', v: 1, iat: 0, exp: 9e9 })).toString('base64url');
    expect(verifySession(secret, `${v}.${forged}.${sig}`, now)).toBeNull();
    expect(verifySession(secret, `${v}.${body}.${sig}`, now + (ACCOUNTS.SESSION_TTL_S + 1) * 1000)).toBeNull();
  });

  it('secret must be ≥ 32 bytes; next must be a site path', () => {
    expect(parseAuthSecret('ab'.repeat(32))?.length).toBe(32);
    expect(parseAuthSecret('short')).toBeNull();
    expect(parseAuthSecret(undefined)).toBeNull();
    expect(safeNext('/intel')).toBe('/intel');
    for (const bad of ['//evil.com', 'https://evil.com', '/\\evil', 7]) expect(safeNext(bad)).toBe('/account');
  });

  it('full sign-in: link emailed (token in the fragment), used once, account created, cookie set, me works', async () => {
    const s = setup();
    expect(await s.me()).toMatchObject({ status: 200, body: { configured: true, signedIn: false, access: 'free' } });
    expect(await s.post('/auth/start', { email: 'Trader@Example.com', next: '/intel' })).toMatchObject({ status: 200, body: { sent: true } });
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]!.to).toBe('trader@example.com');
    expect(s.sent[0]!.text).toContain(`${SITE}/auth/verify#t=`);
    expect(s.sent[0]!.html).not.toMatch(/wallet connect|seed phrase:/i);
    // only the token's hash is stored
    const token = s.tokenOf(s.sent[0]!);
    expect([...s.kv.dump().keys()].some((k) => k.includes(token))).toBe(false);
    const v = await s.post('/auth/verify', { token });
    expect(v.status).toBe(200);
    expect(v.body).toMatchObject({ signedIn: true, email: 'trader@example.com', access: 'free', plan: null, next: '/intel' });
    expect(v.headers['Set-Cookie']).toMatch(/^__Host-phx_session=v1\..+; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000$/);
    const cookie = s.cookieOf(v.headers['Set-Cookie']!);
    expect((await s.me(cookie)).body).toMatchObject({ signedIn: true, email: 'trader@example.com' });
    // the same link again: refused
    expect(await s.post('/auth/verify', { token })).toMatchObject({ status: 410 });
  });

  it('links expire after 15 minutes', async () => {
    const s = setup();
    await s.post('/auth/start', { email: 'a@b.co' });
    s.advance(ACCOUNTS.LINK_TTL_S * 1000 + 1);
    expect(await s.post('/auth/verify', { token: s.tokenOf(s.sent[0]!) })).toMatchObject({ status: 410 });
  });

  it('signing in again keeps the account; sign out everywhere revokes old cookies', async () => {
    const s = setup();
    const signIn = async () => {
      await s.post('/auth/start', { email: 'a@b.co' });
      const v = await s.post('/auth/verify', { token: s.tokenOf(s.sent.at(-1)!) });
      return s.cookieOf(v.headers['Set-Cookie']!);
    };
    const c1 = await signIn();
    const c2 = await signIn();
    expect((await s.me(c1)).body).toMatchObject({ signedIn: true });
    const out = await s.post('/auth/signout', { everywhere: true }, { cookie: c2 });
    expect(out.headers['Set-Cookie']).toContain('Max-Age=0');
    expect((await s.me(c1)).body).toMatchObject({ signedIn: false });
    expect((await s.me(c2)).body).toMatchObject({ signedIn: false });
  });

  it('refuses cross-site posts, non-JSON, bad emails; limits per address and per IP', async () => {
    const s = setup();
    expect(await s.post('/auth/start', { email: 'a@b.co' }, { origin: 'https://evil.example' })).toMatchObject({ status: 403 });
    expect(await s.h({ method: 'POST', path: '/auth/start', ip: '1.1.1.1', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=a@b.co' })).toMatchObject({ status: 415 });
    expect(await s.post('/auth/start', { email: 'nope' })).toMatchObject({ status: 400 });
    for (let i = 0; i < ACCOUNTS.LIMITS.perEmail; i++) expect((await s.post('/auth/start', { email: 'a@b.co' })).status).toBe(200);
    expect(await s.post('/auth/start', { email: 'a@b.co' })).toMatchObject({ status: 429 });
    // another IP is limited on its own
    const other = (email: string) => s.h({ method: 'POST', path: '/auth/start', ip: '2.2.2.2', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
    for (let i = 0; i < ACCOUNTS.LIMITS.perIp; i++) expect((await other(`u${i}@b.co`)).status).toBe(200);
    expect((await other('z@b.co')).status).toBe(429);
  });

  it('a mail or store failure answers 503, never a crash; accounts off answers configured:false', async () => {
    const h = makeAccountsHandler({ kv: memoryKv(), secret, now: Date.now, site: SITE, mail: async () => { throw new Error('resend down'); } });
    expect(await h({ method: 'POST', path: '/auth/start', ip: 'x', headers: { 'content-type': 'application/json' }, body: '{"email":"a@b.co"}' })).toMatchObject({ status: 503 });
    expect(await accountsOff({ method: 'GET', path: '/auth/me', ip: 'x', headers: {} })).toMatchObject({ status: 200, body: { configured: false } });
    expect(await accountsOff({ method: 'POST', path: '/auth/start', ip: 'x', headers: {} })).toMatchObject({ status: 503 });
  });

  it('upstash store speaks the REST protocol', async () => {
    const calls: string[][] = [];
    const store: Record<string, string> = {};
    const kv = upstashKv({
      url: 'https://u.example/',
      token: 't',
      fetch: async (_u, init) => {
        const a = JSON.parse(init.body) as string[];
        calls.push(a);
        let result: unknown = 'OK';
        if (a[0] === 'GET') result = store[a[1]!] ?? null;
        if (a[0] === 'SET') store[a[1]!] = a[2]!;
        if (a[0] === 'GETDEL') { result = store[a[1]!] ?? null; delete store[a[1]!]; }
        if (a[0] === 'INCR') result = (store[a[1]!] = String(Number(store[a[1]!] ?? 0) + 1));
        return { ok: true, status: 200, json: async () => ({ result }) };
      },
    });
    await kv.set('k', 'v', 60);
    expect(await kv.getdel('k')).toBe('v');
    expect(await kv.get('k')).toBeNull();
    expect(await kv.incrWindow('r', 900)).toBe(1);
    expect(await kv.incrWindow('r', 900)).toBe(2);
    expect(calls).toContainEqual(['SET', 'k', 'v', 'EX', '60']);
    expect(calls.filter((c) => c[0] === 'EXPIRE')).toEqual([['EXPIRE', 'r', '900']]);
  });
});
