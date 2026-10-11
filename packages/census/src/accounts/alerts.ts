/**
 * /api/v1/alerts/* and /api/v1/telegram/hook — Telegram alerts for paying accounts (docs/ALERTS.md).
 *
 *   GET  /alerts/me          the signed-in account's alerts: linked?, wallets and lines, plan limit, last-known levels
 *   POST /alerts/link        → {url}: a one-time t.me link (10 min) that links the Telegram chat that opens it
 *   POST /alerts/watch       {address, venue?, hfBelow?, bufferPct?, scenario?} add or change a wallet
 *   POST /alerts/unwatch     {address}
 *   POST /alerts/settings    {paused?, protocol?}
 *   POST /alerts/unlink      the chat stops getting alerts (wallets are kept on the account)
 *   GET  /alerts/feed        the runner only (bearer): every linked account, its plan and its watches
 *   POST /alerts/report      the runner only (bearer): last-known levels after a run; chats that blocked the bot
 *   POST /telegram/hook      Telegram only (secret header): bot commands, answered at once
 *
 * Stored (accounts store): per account its wallets and lines and a SEALED chat id (AES-256-GCM, key derived from
 * AUTH_SECRET); a keyed hash of the chat id → account, for the bot. Never a balance. Read-only: nothing here can
 * touch a wallet.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { BRAND } from '@aegis/glyphs';
import { handleCommand, HELP_TEXT, parseCommand } from '../alerts/commands.js';
import { short } from '../alerts/format.js';
import { ALERTS, emptyDb, type Observation, type Watch } from '../alerts/model.js';
import {
  ALERTS_FEED_SCHEMA,
  alertLimit,
  parseAlertsAccount,
  removeWatch,
  upsertWatch,
  type AlertsAccount,
  type AlertsFeed,
  type AlertsReport,
  type FeedEntry,
} from '../alerts/linked.js';
import type { AuthRequest, AuthResponse } from './api.js';
import { loadUser, sessionUser } from './api.js';
import type { Kv } from './kv.js';
import { effectiveAccess } from './paywall.js';
import type { User } from './core.js';

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface AlertsDeps {
  kv: Kv;
  /** AUTH_SECRET — signs sessions; here it also derives the key that seals chat ids */
  secret: Buffer;
  now: () => number;
  botToken: string;
  /** ALERTS_LIVE=1: every paying account sees alerts. Off: only complimentary (owner) accounts do — for the end-to-end test */
  live: boolean;
  comp?: ReadonlySet<string>;
  fixtures: ReadonlySet<string>;
  site?: string;
  /** read a wallet now, for the bot's /watch and /status replies (null = couldn't) */
  read?: (address: string, scenarios: ReadonlyArray<Watch['scenario']>) => Promise<Observation | null>;
  fetch?: FetchLike;
  log?: (m: string) => void;
}

/** a bot token's shape ("<digits>:<secret>" from @BotFather) — the same check as the runner's */
export const TELEGRAM_TOKEN_SHAPE = /^\d{5,12}:[A-Za-z0-9_-]{30,}$/;

export const ALERTS_SITE = {
  CODE_TTL_S: 10 * 60,
  /** link codes per account per hour */
  CODES_PER_HOUR: 10,
  /** bot messages per chat per minute */
  BOT_PER_MIN: 20,
  /** edits from the site per account per minute */
  EDITS_PER_MIN: 60,
  MAX_REPORT_BYTES: 2_000_000,
} as const;

/* ───────────────────────── derived secrets (both sides hold the bot token) ───────────────────────── */

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
/** what the runner sends as `Authorization: Bearer …` to /alerts/feed and /alerts/report */
export const alertsFeedToken = (botToken: string) => sha(`phx-alerts-feed:${botToken.trim()}`);
/** what Telegram sends in X-Telegram-Bot-Api-Secret-Token (set by the runner with setWebhook) */
export const alertsHookSecret = (botToken: string) => sha(`phx-alerts-hook:${botToken.trim()}`);
export const alertsHookUrl = (site: string) => `${site.replace(/\/+$/, '')}/api/v1/telegram/hook`;
export const alertsFeedUrl = (site: string) => `${site.replace(/\/+$/, '')}/api/v1/alerts/feed`;
export const alertsReportUrl = (site: string) => `${site.replace(/\/+$/, '')}/api/v1/alerts/report`;

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/* ───────────────────────── sealed chat ids ───────────────────────── */

export function chatSealer(secret: Buffer) {
  const key = createHmac('sha256', secret).update('phx-alerts-chat-seal-v1').digest();
  const idKey = createHmac('sha256', secret).update('phx-alerts-chat-id-v1').digest();
  return {
    seal(chatId: string): string {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([c.update(chatId, 'utf8'), c.final()]);
      return `v1.${Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url')}`;
    },
    unseal(s: string | null): string | null {
      if (!s?.startsWith('v1.')) return null;
      try {
        const b = Buffer.from(s.slice(3), 'base64url');
        const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
        d.setAuthTag(b.subarray(12, 28));
        return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
      } catch {
        return null;
      }
    },
    /** store key for chat → account (a keyed hash: the id isn't recoverable from it) */
    chatKey: (chatId: string) => `alerts:chat:${createHmac('sha256', idKey).update(chatId).digest('hex').slice(0, 40)}`,
  };
}

const acctKey = (uid: string) => `alerts:u:${uid}`;
const LINKED = 'alerts:linked';
const REPORT = 'alerts:report';
const codeKey = (code: string) => `alerts:code:${sha(code)}`;

const NO_STORE = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' };
const json = (status: number, body: unknown): AuthResponse => ({ status, headers: { ...NO_STORE }, body });
const err = (status: number, code: string, message: string) => json(status, { error: { code, message } });
const h1 = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const maskEmail = (e: string) => {
  const [n, d] = e.split('@');
  return `${n!.slice(0, 2)}…@${d}`;
};

export const alertsOff = async (req: AuthRequest): Promise<AuthResponse> =>
  req.method === 'GET' && req.path === '/alerts/me' ? json(200, { enabled: false }) : err(503, 'NOT_ENABLED', 'Alerts are not switched on yet.');

export function makeAlertsHandler(d: AlertsDeps) {
  const site = (d.site ?? BRAND.siteUrl).replace(/\/+$/, '');
  const log = d.log ?? (() => {});
  const f = d.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const seal = chatSealer(d.secret);
  const feedToken = alertsFeedToken(d.botToken);
  const hookSecret = alertsHookSecret(d.botToken);
  const tg = `https://api.telegram.org/bot${d.botToken.trim()}`;
  const scrub = (s: string) => s.split(d.botToken.trim()).join('<token>');
  const comp = d.comp ?? new Set<string>();

  let botName: { at: number; v: string | null } | null = null;
  const botUsername = async (): Promise<string | null> => {
    if (botName && (botName.v || d.now() - botName.at < 60_000)) return botName.v;
    try {
      const r = await f(`${tg}/getMe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const j = (await r.json()) as { ok?: boolean; result?: { username?: string } };
      botName = { at: d.now(), v: j.ok && j.result?.username ? j.result.username : null };
    } catch (e) {
      log(`alerts: getMe failed: ${scrub(String(e)).slice(0, 160)}`);
      botName = { at: d.now(), v: null };
    }
    return botName.v;
  };
  const tell = async (chatId: string, text: string) => {
    await f(`${tg}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }) }).catch((e: unknown) =>
      log(`alerts: message not sent: ${scrub(String(e)).slice(0, 160)}`),
    );
  };

  /** may this account see alerts at all (live, or the owner testing before going live) */
  const visible = (u: User) => d.live || comp.has(u.email);
  const limitOf = (u: User) => alertLimit(effectiveAccess(u, d.now(), comp));

  const loadAcct = async (uid: string) => parseAlertsAccount(await d.kv.get(acctKey(uid)));
  const saveAcct = (uid: string, a: AlertsAccount) => d.kv.set(acctKey(uid), JSON.stringify(a));

  async function unlink(uid: string, why: 'site' | 'bot' | 'blocked' | 'relinked'): Promise<string | null> {
    const a = await loadAcct(uid);
    const chatId = seal.unseal(a.chat);
    if (chatId) await d.kv.del(seal.chatKey(chatId));
    await saveAcct(uid, { ...a, chat: null, linkedAt: null });
    await d.kv.srem(LINKED, uid);
    if (chatId && why === 'site') await tell(chatId, `Phrourax · unlinked\nThis chat was unlinked from your Phrourax account on the website. No more alerts here. Connect again any time at ${site}/watch`);
    return chatId;
  }

  /* ── site endpoints (signed in) ── */

  const postGuard = (req: AuthRequest): AuthResponse | null => {
    if (req.method !== 'POST') return err(405, 'METHOD_NOT_ALLOWED', 'Use POST.');
    if (!String(h1(req.headers['content-type']) ?? '').toLowerCase().startsWith('application/json')) return err(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send JSON.');
    const origin = h1(req.headers.origin);
    if (origin && origin !== site) return err(403, 'FORBIDDEN', 'Cross-site request refused.');
    if ((req.body?.length ?? 0) > 4096) return err(413, 'PAYLOAD_TOO_LARGE', 'Request too large.');
    return null;
  };
  const bodyOf = (req: AuthRequest): Record<string, unknown> => {
    try {
      const v = JSON.parse(req.body ?? '') as unknown;
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };

  async function meView(u: User) {
    const a = await loadAcct(u.id);
    const limit = limitOf(u);
    const rep = a.chat ? await readReport() : null;
    const levels = rep?.accounts[u.id] ?? {};
    return {
      enabled: true,
      live: d.live,
      bot: await botUsername(),
      limit,
      linked: a.chat !== null,
      linkedAt: a.linkedAt,
      paused: a.paused,
      protocol: a.protocol,
      watches: a.watches.map((w, i) => ({
        address: w.address,
        venue: w.venue,
        hfBelow: w.hfBelow,
        bufferPct: w.bufferBelow === null ? null : Math.round(w.bufferBelow * 1000) / 10,
        scenario: w.scenario,
        /** beyond the plan's limit (after a downgrade): kept, not checked */
        overLimit: i >= limit,
        level: levels[w.address]?.level ?? null,
        checkedAt: levels[w.address]?.checkedAt ?? null,
      })),
      lastRun: rep ? { at: rep.at, ok: rep.ok } : null,
    };
  }

  async function readReport(): Promise<AlertsReport | null> {
    const raw = await d.kv.get(REPORT);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as AlertsReport;
    } catch {
      return null;
    }
  }

  async function siteCall(req: AuthRequest): Promise<AuthResponse> {
    const u = await sessionUser(d, h1(req.headers.cookie));
    if (req.path === '/alerts/me') {
      if (req.method !== 'GET') return err(405, 'METHOD_NOT_ALLOWED', 'Use GET.');
      if (!u) return json(200, { enabled: true, live: d.live, signedIn: false });
      if (!visible(u)) return json(200, { enabled: false, signedIn: true });
      return json(200, { signedIn: true, ...(await meView(u)) });
    }
    const bad = postGuard(req);
    if (bad) return bad;
    if (!u) return err(401, 'SIGN_IN', 'Sign in first.');
    if (!visible(u)) return err(503, 'NOT_ENABLED', 'Alerts are not switched on yet.');
    const limit = limitOf(u);
    if ((await d.kv.incrWindow(`rl:al:${u.id}`, 60)) > ALERTS_SITE.EDITS_PER_MIN) return err(429, 'RATE_LIMITED', 'Too many changes — wait a minute.');
    const body = bodyOf(req);

    if (req.path === '/alerts/unlink') {
      await unlink(u.id, 'site');
      return json(200, await meView(u));
    }
    if (limit === 0) return err(402, 'PAYMENT_REQUIRED', 'Alerts need a Pro or Desk plan.');

    if (req.path === '/alerts/link') {
      if ((await d.kv.incrWindow(`rl:alc:${u.id}`, 3600)) > ALERTS_SITE.CODES_PER_HOUR) return err(429, 'RATE_LIMITED', 'Too many links — try again in an hour.');
      const bot = await botUsername();
      if (!bot) return err(503, 'BOT_UNAVAILABLE', "Telegram isn't answering right now — try again in a minute.");
      const code = randomBytes(18).toString('base64url');
      await d.kv.set(codeKey(code), u.id, ALERTS_SITE.CODE_TTL_S);
      return json(200, { url: `https://t.me/${bot}?start=${code}`, expiresInS: ALERTS_SITE.CODE_TTL_S });
    }
    const a = await loadAcct(u.id);
    if (req.path === '/alerts/watch' || req.path === '/alerts/unwatch') {
      const r = req.path === '/alerts/watch' ? upsertWatch(a, body, { limit, fixtures: d.fixtures, now: d.now() }) : removeWatch(a, body.address);
      if (!r.ok) return err(400, 'BAD_REQUEST', r.message);
      await saveAcct(u.id, r.account);
      return json(200, await meView(u));
    }
    if (req.path === '/alerts/settings') {
      const next = { ...a };
      if (typeof body.paused === 'boolean') next.paused = body.paused;
      if (typeof body.protocol === 'boolean' && body.protocol !== a.protocol) {
        next.protocol = body.protocol;
        next.protocolSince = body.protocol ? d.now() : null;
      }
      await saveAcct(u.id, next);
      return json(200, await meView(u));
    }
    return err(404, 'NOT_FOUND', 'No such endpoint.');
  }

  /* ── the runner (bearer) ── */

  const runnerOk = (req: AuthRequest) => same(String(h1(req.headers.authorization) ?? ''), `Bearer ${feedToken}`);

  async function feed(): Promise<AlertsFeed> {
    const ids = await d.kv.smembers(LINKED);
    const accts = await d.kv.mget(ids.map(acctKey));
    const users = await d.kv.mget(ids.map((id) => `user:${id}`));
    const out: FeedEntry[] = [];
    for (let i = 0; i < ids.length; i++) {
      const a = parseAlertsAccount(accts[i] ?? null);
      const chatId = seal.unseal(a.chat);
      let u: User | null = null;
      try {
        u = users[i] ? (JSON.parse(users[i]!) as User) : null;
      } catch {
        u = null;
      }
      if (!chatId || !u) {
        await d.kv.srem(LINKED, ids[i]!);
        continue;
      }
      const limit = visible(u) ? limitOf(u) : 0;
      out.push({ account: ids[i]!, chatId, active: limit > 0, limit, paused: a.paused, protocol: a.protocol, protocolSince: a.protocolSince, watches: a.watches.slice(0, limit) });
    }
    return { schema: ALERTS_FEED_SCHEMA, at: d.now(), site, accounts: out };
  }

  async function report(req: AuthRequest): Promise<AuthResponse> {
    if (req.method !== 'POST') return err(405, 'METHOD_NOT_ALLOWED', 'Use POST.');
    let r: AlertsReport;
    try {
      r = JSON.parse(req.body ?? '') as AlertsReport;
    } catch {
      return err(400, 'BAD_REQUEST', 'Send the report as JSON.');
    }
    if (!r || typeof r.at !== 'number' || typeof r.accounts !== 'object' || !Array.isArray(r.blocked)) return err(400, 'BAD_REQUEST', 'Not a report.');
    for (const uid of r.blocked) if (typeof uid === 'string' && /^[0-9a-f]{32}$/.test(uid)) await unlink(uid, 'blocked');
    await d.kv.set(REPORT, JSON.stringify({ at: r.at, ok: r.ok === true, note: String(r.note ?? '').slice(0, 300), accounts: r.accounts, blocked: [] }));
    return json(200, { ok: true });
  }

  /* ── Telegram ── */

  const helpText = () =>
    [
      ...HELP_TEXT.split('\n').map((l) => (l.startsWith('/delete') ? '/delete — unlink this chat (your wallets stay on your account)' : l)),
      '',
      `Manage wallets and lines on the website too: ${site}/watch`,
    ].join('\n');
  const intro = () =>
    [
      `${BRAND.display} alerts are for Pro and Desk accounts.`,
      `Sign in at ${site}/watch and press "Connect Telegram" — it opens this chat already linked.`,
      'Nothing about this chat is stored until you do.',
    ].join('\n');

  async function botReply(chatId: string, text: string): Promise<string | null> {
    if ((await d.kv.incrWindow(`rl:tg:${seal.chatKey(chatId).slice(-16)}`, 60)) > ALERTS_SITE.BOT_PER_MIN) return null;
    const p = parseCommand(text);
    const linkedTo = await d.kv.get(seal.chatKey(chatId));

    if (p?.ok && p.cmd === 'start' && p.args[0]) {
      const code = p.args[0];
      if (!/^[A-Za-z0-9_-]{16,64}$/.test(code)) return intro();
      const uid = await d.kv.getdel(codeKey(code));
      if (!uid) return `That link has expired or was already used. Open ${site}/watch and press "Connect Telegram" again.`;
      const u = await loadUser(d.kv, uid);
      if (!u || !visible(u)) return intro();
      const limit = limitOf(u);
      if (limit === 0) return `Alerts need a Pro or Desk plan: ${site}/pricing`;
      if (linkedTo && linkedTo !== uid) await unlink(linkedTo, 'relinked');
      const a = await loadAcct(uid);
      const old = seal.unseal(a.chat);
      if (old && old !== chatId) await d.kv.del(seal.chatKey(old));
      await saveAcct(uid, { ...a, chat: seal.seal(chatId), linkedAt: d.now() });
      await d.kv.set(seal.chatKey(chatId), uid);
      await d.kv.sadd(LINKED, uid);
      return [
        `Linked to ${maskEmail(u.email)}. Alerts for your wallets will come to this chat.`,
        a.watches.length ? `Watching ${Math.min(a.watches.length, limit)} wallet(s).` : `Add a wallet: /watch <address> — or on ${site}/watch`,
        `Your plan watches up to ${limit} wallets. Checked every ~10 minutes; don't rely on it as your only warning.`,
        'Messages never include balances. /help for commands.',
      ].join('\n');
    }
    if (!linkedTo) return intro();

    const u = await loadUser(d.kv, linkedTo);
    if (!u) {
      await d.kv.del(seal.chatKey(chatId));
      return intro();
    }
    if (p === null) return null; // plain chat text: ignored
    if (!p.ok) return p.why;
    if (p.cmd === 'help') return helpText();
    if (p.cmd === 'delete') {
      await unlink(linkedTo, 'bot');
      return `Unlinked. This chat gets no more alerts and nothing about it is kept. Your wallets stay on your account: ${site}/watch`;
    }
    const limit = visible(u) ? limitOf(u) : 0;
    if (limit === 0) return `Your Phrourax plan has ended, so alerts are paused. Your wallets are kept. Renew: ${site}/pricing`;
    const a = await loadAcct(linkedTo);
    if (p.cmd === 'start') return `Already linked to ${maskEmail(u.email)}. Watching ${Math.min(a.watches.length, limit)} of ${limit}.${a.paused ? ' Alerts are PAUSED — /resume to restart.' : ''}`;
    if (p.cmd === 'status' && !p.args[0]) {
      const rep = await readReport();
      const lv = rep?.accounts[linkedTo] ?? {};
      if (!a.watches.length) return `Watching nothing yet. /watch <address> or ${site}/watch`;
      return [
        `${a.paused ? 'PAUSED · ' : ''}Last known state (send /status <address> to read one now):`,
        ...a.watches.slice(0, limit).map((w) => `• ${short(w.address)} — ${lv[w.address]?.level ?? 'not read yet'}${lv[w.address]?.checkedAt ? ` · checked ${Math.round((d.now() - lv[w.address]!.checkedAt!) / 60_000)} min ago` : ''}`),
        rep ? `Last alerts run: ${Math.round((d.now() - rep.at) / 60_000)} min ago${rep.ok ? '' : ' (had problems)'}` : 'The first alerts run is still to come.',
      ].join('\n');
    }
    // everything else: the same command code the bot always had, on a one-chat view of this account
    const db = emptyDb(d.now());
    db.chats[chatId] = { id: chatId, createdAt: a.linkedAt ?? d.now(), paused: a.paused, watches: a.watches.map((w) => ({ ...w })), sentAt: [], held: 0, protocol: a.protocol, protocolSince: a.protocolSince ?? undefined };
    const reply = await handleCommand(db, chatId, text, {
      now: d.now(),
      fixtures: d.fixtures,
      siteUrl: site,
      hashChat: () => '-',
      read: d.read ?? (async () => null),
      cfg: { ...ALERTS, MAX_WATCHES_PER_CHAT: limit },
    });
    const c = db.chats[chatId]!;
    const next: AlertsAccount = { ...a, paused: c.paused, protocol: c.protocol === true, protocolSince: c.protocol ? (c.protocolSince ?? a.protocolSince) : null, watches: c.watches };
    if (JSON.stringify(next) !== JSON.stringify(a)) await saveAcct(linkedTo, next);
    return reply;
  }

  async function hook(req: AuthRequest): Promise<AuthResponse> {
    if (req.method !== 'POST') return err(405, 'METHOD_NOT_ALLOWED', 'Use POST.');
    if (!same(String(h1(req.headers['x-telegram-bot-api-secret-token']) ?? ''), hookSecret)) return err(401, 'UNAUTHORIZED', 'Telegram only.');
    let up: { message?: { chat?: { id?: number | string; type?: string }; text?: string } };
    try {
      up = JSON.parse(req.body ?? '') as typeof up;
    } catch {
      return json(200, {});
    }
    const chat = up.message?.chat;
    const text = up.message?.text;
    // private chats only: in a group, other members would see someone's wallets
    if (!chat || chat.id === undefined || chat.type !== 'private' || typeof text !== 'string') return json(200, {});
    const chatId = String(chat.id);
    const reply = await botReply(chatId, text.slice(0, 500)).catch((e: unknown) => {
      log(`alerts: bot command failed: ${scrub(String(e)).slice(0, 200)}`);
      return 'Something went wrong handling that. Try again shortly.';
    });
    // the reply rides back on Telegram's own request (no second call needed)
    return json(200, reply ? { method: 'sendMessage', chat_id: chatId, text: reply.slice(0, 4000), disable_web_page_preview: true } : {});
  }

  return async function handleAlerts(req: AuthRequest): Promise<AuthResponse> {
    try {
      if (req.path === '/telegram/hook') return await hook(req);
      if (req.path === '/alerts/feed') {
        if (!runnerOk(req)) return err(401, 'UNAUTHORIZED', 'Runner only.');
        return json(200, await feed());
      }
      if (req.path === '/alerts/report') {
        if (!runnerOk(req)) return err(401, 'UNAUTHORIZED', 'Runner only.');
        return await report(req);
      }
      if (req.path.startsWith('/alerts/')) return await siteCall(req);
      return err(404, 'NOT_FOUND', 'No such endpoint.');
    } catch (e) {
      log(`alerts: ${scrub(String(e)).slice(0, 300)}`);
      return err(503, 'UNAVAILABLE', 'Alerts are temporarily unavailable — try again shortly.');
    }
  };
}
