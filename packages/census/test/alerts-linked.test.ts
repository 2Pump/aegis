import { describe, expect, it } from 'vitest';
import {
  ACCOUNTS,
  alertsFeedToken,
  alertsHookSecret,
  chatSealer,
  makeAccountsHandler,
  makeAlertsHandler,
  memoryKv,
  newUser,
  saveUser,
  signSession,
  type AuthRequest,
  type User,
} from '../src/accounts/index.js';
import { ALERT_LIMITS, emptyDb, mergeFeed, runLinkedAlerts, TestTransport, upsertWatch, emptyAlertsAccount, type AlertsFeed, type Observation } from '../src/alerts/index.js';

const SITE = 'https://phrourax.com';
const secret = Buffer.alloc(32, 7);
const TOKEN = '123456789:AAH_test_token_for_phrourax_alerts_xyz';
const FIX = new Set(['0x0000000000000000000000000000000000ae6004']);
const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const A = addr(0xa1);
const DAY = 86_400_000;

function setup(o: { live?: boolean } = {}) {
  let t = Date.UTC(2026, 9, 11, 12);
  const now = () => t;
  const kv = memoryKv(now);
  const told: Array<{ chat_id: string; text: string }> = [];
  const fetch = async (url: string, init: { body: string }) => {
    if (url.endsWith('/getMe')) return { ok: true, status: 200, json: async () => ({ ok: true, result: { username: 'PhrouraxBot' } }) };
    if (url.endsWith('/sendMessage')) told.push(JSON.parse(init.body) as { chat_id: string; text: string });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const comp = new Set(['owner@phrourax.co']);
  const reads: string[] = [];
  const h = makeAlertsHandler({
    kv,
    secret,
    now,
    botToken: TOKEN,
    live: o.live ?? true,
    comp,
    fixtures: FIX,
    site: SITE,
    fetch,
    read: async (a) => {
      reads.push(a);
      return null;
    },
  });
  const user = async (email: string, plan: 'pro' | 'desk' | null, days = 30): Promise<{ u: User; cookie: string }> => {
    const u = newUser(email, t);
    if (plan) {
      u.plan = plan;
      u.paidUntil = new Date(t + days * DAY).toISOString();
    }
    await saveUser(kv, u);
    return { u, cookie: `${ACCOUNTS.COOKIE}=${signSession(secret, u, t)}` };
  };
  const get = (path: string, headers: Record<string, string> = {}) => h({ method: 'GET', path, ip: 'x', headers });
  const post = (path: string, body: unknown, cookie: string) =>
    h({ method: 'POST', path, ip: 'x', headers: { 'content-type': 'application/json', origin: SITE, cookie }, body: JSON.stringify(body) });
  const tg = (chatId: string, text: string, o2: { type?: string; secret?: string } = {}) =>
    h({
      method: 'POST',
      path: '/telegram/hook',
      ip: 'tg',
      headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': o2.secret ?? alertsHookSecret(TOKEN) },
      body: JSON.stringify({ update_id: 1, message: { chat: { id: Number(chatId), type: o2.type ?? 'private' }, text } }),
    } as AuthRequest);
  const replyText = async (chatId: string, text: string) => ((await tg(chatId, text)).body as { text?: string }).text ?? null;
  const bearer = { authorization: `Bearer ${alertsFeedToken(TOKEN)}` };
  const feed = async () => (await get('/alerts/feed', bearer)).body as AlertsFeed;
  const link = async (cookie: string, chatId: string) => {
    const r = await post('/alerts/link', {}, cookie);
    const code = (r.body as { url: string }).url.split('start=')[1]!;
    return replyText(chatId, `/start ${code}`);
  };
  return { kv, h, now, told, reads, user, get, post, tg, replyText, feed, bearer, link, advance: (ms: number) => (t += ms) };
}

describe('alerts for accounts — the site side', () => {
  it('signed out, free, or not live: no way in; the owner can test before going live', async () => {
    const s = setup({ live: false });
    expect((await s.get('/alerts/me')).body).toMatchObject({ enabled: true, live: false, signedIn: false });
    const paid = await s.user('paid@x.co', 'pro');
    expect((await s.get('/alerts/me', { cookie: paid.cookie })).body).toEqual({ enabled: false, signedIn: true });
    expect((await s.post('/alerts/link', {}, paid.cookie)).status).toBe(503);
    const owner = await s.user('owner@phrourax.co', null);
    const me = (await s.get('/alerts/me', { cookie: owner.cookie })).body as Record<string, unknown>;
    expect(me).toMatchObject({ enabled: true, bot: 'PhrouraxBot', limit: ALERT_LIMITS.desk, linked: false });

    const live = setup({ live: true });
    const free = await live.user('free@x.co', null);
    expect((await live.post('/alerts/link', {}, free.cookie)).status).toBe(402);
    expect((await live.post('/alerts/watch', { address: A }, free.cookie)).status).toBe(402);
    expect((await live.post('/alerts/link', {}, 'nope')).status).toBe(401);
  });

  it('/auth/me says whether this account sees alerts (off / owner-only / live)', async () => {
    const s = setup();
    const owner = await s.user('owner@phrourax.co', null);
    const paid = await s.user('paid@x.co', 'pro');
    const me = async (mode: 'off' | 'owner' | 'live', cookie: string) =>
      ((await makeAccountsHandler({ kv: s.kv, secret, now: s.now, site: SITE, mail: async () => {}, comp: new Set(['owner@phrourax.co']), alerts: mode })({ method: 'GET', path: '/auth/me', ip: 'x', headers: { cookie } })).body as { alerts: boolean }).alerts;
    expect(await me('off', owner.cookie)).toBe(false);
    expect(await me('owner', owner.cookie)).toBe(true);
    expect(await me('owner', paid.cookie)).toBe(false);
    expect(await me('live', paid.cookie)).toBe(true);
  });

  it('Connect Telegram: a one-time link; /start <code> links the chat at once; the chat id is never stored in the clear', async () => {
    const s = setup();
    const p = await s.user('pro@x.co', 'pro');
    const r = await s.post('/alerts/link', {}, p.cookie);
    const url = (r.body as { url: string }).url;
    expect(url).toMatch(/^https:\/\/t\.me\/PhrouraxBot\?start=[A-Za-z0-9_-]{24}$/);
    const code = url.split('start=')[1]!;
    const reply = await s.replyText('5550001', `/start ${code}`);
    expect(reply).toContain('Linked to pr…@x.co');
    expect(reply).toContain('up to 10 wallets');
    // used once
    expect(await s.replyText('5550002', `/start ${code}`)).toContain('expired or was already used');
    // stored: sealed chat id + keyed hash only
    for (const [, v] of s.kv.dump()) expect(v.v).not.toContain('5550001');
    expect((await s.get('/alerts/me', { cookie: p.cookie })).body).toMatchObject({ linked: true });
    // an expired code
    const r2 = await s.post('/alerts/link', {}, p.cookie);
    s.advance(11 * 60_000);
    expect(await s.replyText('5550001', `/start ${(r2.body as { url: string }).url.split('start=')[1]}`)).toContain('expired');
  });

  it('only Telegram may call the hook; groups are ignored; unlinked chats are pointed at the site and nothing is stored', async () => {
    const s = setup();
    expect((await s.tg('1', '/help', { secret: 'wrong' })).status).toBe(401);
    expect((await s.tg('-100', '/help', { type: 'group' })).body).toEqual({});
    const before = s.kv.dump().size;
    expect(await s.replyText('42', '/watch ' + A)).toContain('Connect Telegram');
    expect(s.kv.dump().size - before).toBeLessThanOrEqual(1); // only the per-chat rate counter
  });

  it('plan limits: Pro 10 wallets, Desk 100; addresses checked; test wallets refused', async () => {
    const s = setup();
    const p = await s.user('pro@x.co', 'pro');
    for (let i = 1; i <= 10; i++) expect((await s.post('/alerts/watch', { address: addr(0x100 + i) }, p.cookie)).status).toBe(200);
    const over = await s.post('/alerts/watch', { address: addr(0x200) }, p.cookie);
    expect(over.status).toBe(400);
    expect((over.body as { error: { message: string } }).error.message).toContain('up to 10');
    expect((await s.post('/alerts/watch', { address: 'nope' }, p.cookie)).status).toBe(400);
    expect((await s.post('/alerts/watch', { address: [...FIX][0] }, p.cookie)).status).toBe(400);
    // editing an existing one is fine at the limit
    const ed = await s.post('/alerts/watch', { address: addr(0x101), hfBelow: 1.3, bufferPct: 12, scenario: { direction: 'ETH', pct: -20 } }, p.cookie);
    expect(ed.status).toBe(200);
    const w = (ed.body as { watches: Array<Record<string, unknown>> }).watches[0]!;
    expect(w).toMatchObject({ hfBelow: 1.3, bufferPct: 12, scenario: { direction: 'ETH', pct: -20 } });
    expect((await s.post('/alerts/watch', { address: addr(0x101), hfBelow: 0.9 }, p.cookie)).status).toBe(400);

    let acct = emptyAlertsAccount();
    for (let i = 0; i < 100; i++) {
      const r = upsertWatch(acct, { address: addr(0x1000 + i) }, { limit: ALERT_LIMITS.desk, fixtures: FIX, now: 0 });
      expect(r.ok).toBe(true);
      if (r.ok) acct = r.account;
    }
    expect(upsertWatch(acct, { address: addr(0x9999) }, { limit: ALERT_LIMITS.desk, fixtures: FIX, now: 0 }).ok).toBe(false);
  });

  it('bot commands edit the same account the website shows', async () => {
    const s = setup();
    const p = await s.user('desk@x.co', 'desk');
    await s.link(p.cookie, '777');
    expect(await s.replyText('777', `/watch ${A} tydro`)).toContain('Watching');
    expect(s.reads).toEqual([A]);
    expect(await s.replyText('777', `/hf ${A} 1.25`)).toContain('below 1.25');
    expect(await s.replyText('777', '/pause')).toContain('Paused');
    expect(await s.replyText('777', '/list')).toContain('of 100');
    expect(await s.replyText('777', 'hello')).toBeNull();
    const me = (await s.get('/alerts/me', { cookie: p.cookie })).body as { paused: boolean; watches: Array<Record<string, unknown>> };
    expect(me.paused).toBe(true);
    expect(me.watches[0]).toMatchObject({ address: A, venue: 'tydro', hfBelow: 1.25 });
    expect(await s.replyText('777', '/status')).toContain('not read yet');
    expect(await s.replyText('777', '/help')).toContain('/delete — unlink this chat');
  });

  it('feed (runner only): linked accounts with plain chat ids for the runner; an ended plan is inactive; report shows levels; blocked chats are unlinked', async () => {
    const s = setup();
    expect((await s.get('/alerts/feed')).status).toBe(401);
    const p = await s.user('pro@x.co', 'pro', 1);
    await s.link(p.cookie, '9001');
    await s.post('/alerts/watch', { address: A }, p.cookie);
    let f = await s.feed();
    expect(f.accounts).toEqual([expect.objectContaining({ account: p.u.id, chatId: '9001', active: true, limit: 10 })]);
    expect(f.accounts[0]!.watches.map((w) => w.address)).toEqual([A]);

    const rep = { at: s.now(), ok: true, note: '', accounts: { [p.u.id]: { [A]: { level: 'WATCH', checkedAt: s.now() } } }, blocked: [] };
    expect((await s.h({ method: 'POST', path: '/alerts/report', ip: 'r', headers: { 'content-type': 'application/json' }, body: JSON.stringify(rep) })).status).toBe(401);
    expect((await s.h({ method: 'POST', path: '/alerts/report', ip: 'r', headers: { ...s.bearer, 'content-type': 'application/json' }, body: JSON.stringify(rep) })).status).toBe(200);
    const me = (await s.get('/alerts/me', { cookie: p.cookie })).body as { watches: Array<{ level: string }>; lastRun: { ok: boolean } };
    expect(me.watches[0]!.level).toBe('WATCH');
    expect(me.lastRun.ok).toBe(true);
    expect(await s.replyText('9001', '/status')).toContain('WATCH');

    s.advance(2 * DAY);
    f = await s.feed();
    expect(f.accounts[0]).toMatchObject({ active: false, limit: 0, watches: [] });
    expect(await s.replyText('9001', `/watch ${addr(0x77)}`)).toContain('plan has ended');

    await s.h({ method: 'POST', path: '/alerts/report', ip: 'r', headers: { ...s.bearer, 'content-type': 'application/json' }, body: JSON.stringify({ ...rep, blocked: [p.u.id] }) });
    expect((await s.feed()).accounts).toEqual([]);
    expect((await s.get('/alerts/me', { cookie: p.cookie })).body).toMatchObject({ linked: false });
  });

  it('unlink from the website tells the chat; /delete from the bot unlinks; one chat ↔ one account', async () => {
    const s = setup();
    const a = await s.user('a@x.co', 'pro');
    const b = await s.user('b@x.co', 'desk');
    await s.link(a.cookie, '100');
    await s.post('/alerts/unlink', {}, a.cookie);
    expect(s.told.at(-1)).toMatchObject({ chat_id: '100' });
    expect(s.told.at(-1)!.text).toContain('unlinked');
    expect(await s.replyText('100', '/list')).toContain('Connect Telegram');

    await s.link(a.cookie, '100');
    await s.link(b.cookie, '100'); // the same chat now belongs to b
    expect((await s.get('/alerts/me', { cookie: a.cookie })).body).toMatchObject({ linked: false });
    expect((await s.feed()).accounts.map((x) => x.account)).toEqual([b.u.id]);
    expect(await s.replyText('100', '/delete')).toContain('Unlinked');
    expect((await s.feed()).accounts).toEqual([]);
    expect(chatSealer(secret).unseal('v1.garbage')).toBeNull();
  });
});

describe('alerts for accounts — the runner side', () => {
  const T = Date.UTC(2026, 9, 11, 12);
  const obs = (level: Observation['level']): Observation => ({
    address: A,
    readAt: T,
    dataAt: T - 30_000,
    block: 1,
    tydro: { readable: true, active: true, hf: level === 'NEAR' ? 1.03 : 1.8 },
    nado: { readable: true, active: false, worstBuffer: null, partial: false },
    level,
    hullTemp: 'NOMINAL',
    primary: null,
    approximate: false,
    rulesVersion: 'r',
    engineVersion: 'e',
    scenarios: {},
  });
  const entry = (chatId: string, o: Partial<AlertsFeed['accounts'][number]> = {}) => ({
    account: `acct${chatId}`.padEnd(32, '0'),
    chatId,
    active: true,
    limit: 10,
    paused: false,
    protocol: false,
    protocolSince: null,
    watches: [{ address: A, venue: 'any' as const, hfBelow: null, bufferBelow: null, scenario: null, createdAt: T }],
    ...o,
  });
  const feedOf = (...accounts: ReturnType<typeof entry>[]): AlertsFeed => ({ schema: 'phrourax-alerts-feed-1', at: T, site: SITE, accounts });

  it('the feed decides who exists; alerts go out; an ended plan is told once; a blocked chat is reported back', async () => {
    let level: Observation['level'] = 'SAFE';
    const tr = new TestTransport();
    const deps = { transport: tr, read: async () => obs(level), now: () => T, fixtures: FIX, siteUrl: SITE, hashChat: (c: string) => `h${c}` };
    let r = await runLinkedAlerts(emptyDb(T), feedOf(entry('1'), entry('2')), deps);
    expect(tr.sent).toEqual([]); // first reading is a baseline
    expect(r.siteReport.accounts[entry('1').account]![A]!.level).toBe('SAFE');

    level = 'NEAR';
    tr.fail.set('2', { ok: false, retryable: false, blocked: true, error: 'blocked' });
    r = await runLinkedAlerts(r.db, feedOf(entry('1'), entry('2')), deps);
    expect(tr.to('1').join('\n')).toContain('NEAR LIQUIDATION');
    expect(r.siteReport.blocked).toEqual([entry('2').account]);

    // plan ended: told once, never alerted
    tr.sent = [];
    r = await runLinkedAlerts(r.db, feedOf(entry('1', { active: false, limit: 0, watches: [] })), deps);
    expect(tr.to('1')).toEqual([expect.stringContaining('plan has ended')]);
    r = await runLinkedAlerts(r.db, feedOf(entry('1', { active: false, limit: 0, watches: [] })), deps);
    expect(tr.to('1')).toHaveLength(1);
    expect(r.db.chats['1']).toBeUndefined();
  });

  it('merge keeps a chat\'s alert history across runs and drops chats that left the feed', () => {
    const db = emptyDb(T);
    db.chats['5'] = { id: '5', createdAt: 1, paused: false, watches: [], sentAt: [T - 1000], held: 2 };
    db.chats['6'] = { id: '6', createdAt: 1, paused: false, watches: [], sentAt: [], held: 0 };
    db.state['6|' + A] = { level: 'SAFE' } as never;
    const m = mergeFeed(db, feedOf(entry('5', { paused: true })), T);
    expect(m.db.chats['5']).toMatchObject({ paused: true, sentAt: [T - 1000], held: 2 });
    expect(m.db.chats['6']).toBeUndefined();
    expect(m.db.state['6|' + A]).toBeUndefined();
  });
});
