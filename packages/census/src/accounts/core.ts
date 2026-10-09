/**
 * Accounts (pure apart from node:crypto): who a subscriber is, what their plan allows, and the signed session cookie.
 *
 * Privacy: an account is an email address and a plan. Nothing about a person's wallets is stored here — Phrourax never
 * connects to a wallet, and signing in is by an emailed link only.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const ACCOUNTS = {
  VERSION: 'accounts-1.0.0',
  /** the emailed sign-in link works once, for this long */
  LINK_TTL_S: 15 * 60,
  /** a session lasts this long, then you sign in again */
  SESSION_TTL_S: 30 * 24 * 3600,
  COOKIE: '__Host-phx_session',
  /** sign-in emails per address, and requests per IP, per window */
  LIMITS: { perEmail: 3, perIp: 10, windowS: 15 * 60 },
  MAX_EMAIL_LEN: 254,
} as const;

export type Plan = 'pro' | 'desk';
/** what an account can use right now: 'free' until a plan is paid for (stage 3) */
export type Access = 'free' | Plan;

export interface User {
  id: string;
  email: string;
  createdAt: string;
  lastSignInAt: string | null;
  /** the plan last paid for, and the end of the paid period (ISO). Both null until a first payment. */
  plan: Plan | null;
  paidUntil: string | null;
  /** session version: bumping it signs out every device */
  sv: number;
}

/** Lower-cased, trimmed, and a plain address shape — or null. Deliberately strict: one @, a dot in the domain. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const e = raw.trim().toLowerCase();
  if (!e || e.length > ACCOUNTS.MAX_EMAIL_LEN) return null;
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(e)) return null;
  if (e.includes('..')) return null;
  return e;
}

/** Stable account id from the email (the store's key; the email itself lives only inside the record). */
export const userId = (email: string): string => createHash('sha256').update(`phx-user:${email}`).digest('hex').slice(0, 32);

export const newUser = (email: string, nowMs: number): User => ({
  id: userId(email),
  email,
  createdAt: new Date(nowMs).toISOString(),
  lastSignInAt: null,
  plan: null,
  paidUntil: null,
  sv: 1,
});

/** A plan counts while its paid period hasn't ended. */
export function access(u: Pick<User, 'plan' | 'paidUntil'> | null, nowMs: number): Access {
  if (!u?.plan || !u.paidUntil) return 'free';
  return Date.parse(u.paidUntil) > nowMs ? u.plan : 'free';
}

/* ───────────────────────── one-time sign-in tokens ───────────────────────── */

export const newLinkToken = (): string => randomBytes(32).toString('base64url');
/** only the hash is stored, so a store leak can't be replayed as sign-in links */
export const linkKey = (token: string): string => `ml:${createHash('sha256').update(token).digest('hex')}`;
export const isLinkToken = (t: unknown): t is string => typeof t === 'string' && /^[A-Za-z0-9_-]{43}$/.test(t);

/** where to go after signing in: a site path only, never another host */
export function safeNext(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\') || raw.length > 200) return '/account';
  return raw;
}

/* ───────────────────────── session cookie ───────────────────────── */

interface SessionClaims {
  /** user id */
  u: string;
  /** session version at sign-in */
  v: number;
  iat: number;
  exp: number;
}

const mac = (secret: Buffer, body: string) => createHmac('sha256', secret).update(`phx-session.v1.${body}`).digest('base64url');

export function signSession(secret: Buffer, u: Pick<User, 'id' | 'sv'>, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000);
  const body = Buffer.from(JSON.stringify({ u: u.id, v: u.sv, iat, exp: iat + ACCOUNTS.SESSION_TTL_S } satisfies SessionClaims)).toString('base64url');
  return `v1.${body}.${mac(secret, body)}`;
}

export function verifySession(secret: Buffer, token: string | undefined, nowMs: number): SessionClaims | null {
  if (!token || token.length > 600) return null;
  const [ver, body, sig] = token.split('.');
  if (ver !== 'v1' || !body || !sig) return null;
  const want = Buffer.from(mac(secret, body));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const c = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionClaims;
    if (typeof c.u !== 'string' || typeof c.v !== 'number' || typeof c.exp !== 'number') return null;
    return c.exp * 1000 > nowMs ? c : null;
  } catch {
    return null;
  }
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

export const sessionCookie = (value: string): string =>
  `${ACCOUNTS.COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${ACCOUNTS.SESSION_TTL_S}`;
export const clearedCookie = (): string => `${ACCOUNTS.COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

/** AUTH_SECRET: at least 32 bytes, given as hex or base64. Anything shorter keeps accounts off. */
export function parseAuthSecret(raw: string | undefined): Buffer | null {
  if (!raw) return null;
  const s = raw.trim();
  const b = /^[0-9a-f]+$/i.test(s) && s.length % 2 === 0 ? Buffer.from(s, 'hex') : Buffer.from(s, 'base64');
  return b.length >= 32 ? b : null;
}
