/**
 * /api/v1/auth/* — email sign-in links and the session cookie (pure: the store, mailer and clock are passed in).
 *
 *   GET  /auth/me        who is signed in and what they can use. {configured:false} when accounts are off.
 *   POST /auth/start     {email, next?} → emails a one-time sign-in link (15 min). Same answer whether or not the
 *                        account exists, so it can't be used to test addresses.
 *   POST /auth/verify    {token} → signs in (creates the account on first sign-in) and sets the session cookie.
 *                        The link opens a page with a button that makes this call, so mail scanners that open
 *                        links can't use up the token.
 *   POST /auth/signout   clears the cookie. {everywhere:true} also signs out every other device.
 *
 * POSTs must be JSON and, when the browser sends an Origin, come from the site itself (no cross-site sign-ins).
 */
import { BRAND } from '@aegis/glyphs';
import {
  ACCOUNTS,
  clearedCookie,
  isLinkToken,
  linkKey,
  newLinkToken,
  newUser,
  normalizeEmail,
  readCookie,
  safeNext,
  sessionCookie,
  signSession,
  userId,
  verifySession,
  type User,
} from './core.js';
import type { Kv } from './kv.js';
import { effectiveAccess } from './paywall.js';
import { signInMail, type Mailer } from './mail.js';

export interface AccountsDeps {
  kv: Kv;
  mail: Mailer;
  secret: Buffer;
  now: () => number;
  site?: string;
  log?: (m: string) => void;
  /** complimentary accounts (count as Desk) */
  comp?: ReadonlySet<string>;
  /** PAYWALL=1: the site shows locks to accounts without a plan */
  paywall?: boolean;
  /** payments are set up (NOWPayments keys present): the pricing page can sell */
  billing?: boolean;
  /** Telegram alerts: off, owner-only (testing before going live), or live for every paying account */
  alerts?: 'off' | 'owner' | 'live';
  /** webhooks are switched on (Desk) */
  webhooks?: boolean;
}

export interface AuthRequest {
  method: string;
  /** path after /api/v1, e.g. /auth/me */
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body?: string;
  ip: string;
}

export interface AuthResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export type AuthHandler = (req: AuthRequest) => Promise<AuthResponse>;

const NO_STORE = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' };
const json = (status: number, body: unknown, extra: Record<string, string> = {}): AuthResponse => ({ status, headers: { ...NO_STORE, ...extra }, body });
const err = (status: number, code: string, message: string) => json(status, { error: { code, message } });
const h1 = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export const userKey = (id: string) => `user:${id}`;
/** how long /auth/me may answer from memory (a payment, plan change or sign-out elsewhere shows within this) */
export const ME_TTL_MS = 15_000;

export async function loadUser(kv: Kv, id: string): Promise<User | null> {
  const raw = await kv.get(userKey(id));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as User;
  } catch {
    return null;
  }
}
export const saveUser = (kv: Kv, u: User) => kv.set(userKey(u.id), JSON.stringify(u));

/** The signed-in user for a request, or null (bad, expired or revoked cookie). */
export async function sessionUser(d: Pick<AccountsDeps, 'kv' | 'secret' | 'now'>, cookieHeader: string | undefined): Promise<User | null> {
  const claims = verifySession(d.secret, readCookie(cookieHeader, ACCOUNTS.COOKIE), d.now());
  if (!claims) return null;
  const u = await loadUser(d.kv, claims.u);
  return u && u.sv === claims.v ? u : null;
}

export const meBody = (u: User | null, nowMs: number, o: { comp?: ReadonlySet<string>; paywall?: boolean; billing?: boolean; alerts?: 'off' | 'owner' | 'live'; webhooks?: boolean } = {}) =>
  u
    ? {
        configured: true,
        paywall: o.paywall === true,
        billing: o.billing === true,
        alerts: o.alerts === 'live' || (o.alerts === 'owner' && o.comp?.has(u.email) === true),
        webhooks: o.webhooks === true,
        signedIn: true,
        email: u.email,
        access: effectiveAccess(u, nowMs, o.comp),
        comp: o.comp?.has(u.email) === true,
        plan: u.plan,
        paidUntil: u.paidUntil,
        since: u.createdAt,
        payments: (u.payments ?? []).slice(0, 6).map((p) => ({ at: p.at, plan: p.plan, usd: p.usd, paidUntil: p.paidUntil })),
      }
    : { configured: true, paywall: o.paywall === true, billing: o.billing === true, alerts: o.alerts === 'live', webhooks: o.webhooks === true, signedIn: false, access: 'free' as const };

/** For when accounts aren't set up (no secret / store / mail key): the site works exactly as before. */
export const accountsOff: AuthHandler = async (req) =>
  req.method === 'GET' && req.path === '/auth/me'
    ? json(200, { configured: false, paywall: false, billing: false, signedIn: false, access: 'free' })
    : err(503, 'NOT_ENABLED', 'Accounts are not switched on yet.');

export function makeAccountsHandler(d: AccountsDeps): AuthHandler {
  const site = (d.site ?? BRAND.siteUrl).replace(/\/+$/, '');
  const log = d.log ?? (() => {});

  const postGuard = (req: AuthRequest): AuthResponse | null => {
    if (req.method !== 'POST') return err(405, 'METHOD_NOT_ALLOWED', 'Use POST.');
    const ct = String(h1(req.headers['content-type']) ?? '');
    if (!ct.toLowerCase().startsWith('application/json')) return err(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send JSON.');
    const origin = h1(req.headers.origin);
    if (origin && origin !== site) return err(403, 'FORBIDDEN', 'Cross-site request refused.');
    if ((req.body?.length ?? 0) > 2048) return err(413, 'PAYLOAD_TOO_LARGE', 'Request too large.');
    return null;
  };
  const parse = (req: AuthRequest): Record<string, unknown> | null => {
    try {
      const v = JSON.parse(req.body ?? '') as unknown;
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };

  // short per-instance memory of who a cookie belongs to; sign-in and sign-out on this instance clear it at once
  const meCache = new Map<string, { at: number; u: User | null }>();
  return async function handleAuth(req) {
    const cookie = h1(req.headers.cookie);
    if (req.path === '/auth/verify' || req.path === '/auth/signout') meCache.clear();
    try {
      if (req.path === '/auth/me') {
        if (req.method !== 'GET') return err(405, 'METHOD_NOT_ALLOWED', 'Use GET.');
        // every page asks this once: one store read per session per ME_TTL_MS per instance, not one per page view
        const key = cookie ?? '';
        const hit = key ? meCache.get(key) : undefined;
        const now = d.now();
        const u = hit && now - hit.at < ME_TTL_MS ? hit.u : await sessionUser(d, cookie);
        if (key && !(hit && now - hit.at < ME_TTL_MS)) {
          if (meCache.size > 5000) meCache.clear();
          meCache.set(key, { at: now, u });
        }
        return json(200, meBody(u, now, d));
      }

      if (req.path === '/auth/start') {
        const bad = postGuard(req);
        if (bad) return bad;
        const b = parse(req);
        const email = normalizeEmail(b?.email);
        if (!email) return err(400, 'BAD_EMAIL', 'Enter a valid email address.');
        const W = ACCOUNTS.LIMITS.windowS;
        if ((await d.kv.incrWindow(`rl:ip:${req.ip}`, W)) > ACCOUNTS.LIMITS.perIp) return err(429, 'RATE_LIMITED', 'Too many sign-in requests — try again in 15 minutes.');
        if ((await d.kv.incrWindow(`rl:em:${userId(email)}`, W)) > ACCOUNTS.LIMITS.perEmail) return err(429, 'RATE_LIMITED', 'Several links were already sent to this address — use the newest one, or try again in 15 minutes.');
        const token = newLinkToken();
        await d.kv.set(linkKey(token), JSON.stringify({ email, next: safeNext(b?.next) }), ACCOUNTS.LINK_TTL_S);
        // the token travels in the fragment: never sent to a server, never in access logs
        await d.mail(signInMail(email, `${site}/auth/verify#t=${token}`, ACCOUNTS.LINK_TTL_S / 60));
        return json(200, { sent: true });
      }

      if (req.path === '/auth/verify') {
        const bad = postGuard(req);
        if (bad) return bad;
        const b = parse(req);
        const token = b?.token;
        if (!isLinkToken(token)) return err(400, 'BAD_LINK', 'This sign-in link is not valid.');
        const raw = await d.kv.getdel(linkKey(token));
        if (!raw) return err(410, 'LINK_USED_OR_EXPIRED', 'This sign-in link was already used or has expired. Ask for a new one.');
        const { email, next } = JSON.parse(raw) as { email: string; next: string };
        const now = d.now();
        const u = (await loadUser(d.kv, userId(email))) ?? newUser(email, now);
        u.lastSignInAt = new Date(now).toISOString();
        await saveUser(d.kv, u);
        return json(200, { ...meBody(u, now, d), next: safeNext(next) }, { 'Set-Cookie': sessionCookie(signSession(d.secret, u, now)) });
      }

      if (req.path === '/auth/signout') {
        const bad = postGuard(req);
        if (bad) return bad;
        if (parse(req)?.everywhere === true) {
          const u = await sessionUser(d, cookie);
          if (u) {
            u.sv += 1;
            await saveUser(d.kv, u);
          }
        }
        return json(200, { signedIn: false }, { 'Set-Cookie': clearedCookie() });
      }

      return err(404, 'NOT_FOUND', 'No such endpoint.');
    } catch (e) {
      log(`accounts: ${String(e).slice(0, 300)}`);
      return err(503, 'UNAVAILABLE', 'Accounts are temporarily unavailable — try again shortly.');
    }
  };
}
