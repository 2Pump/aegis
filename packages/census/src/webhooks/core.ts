/**
 * WEBHOOKS (pure core) — `webhooks-1.0.0`. Release 5. Built and tested; OFF until the owner switches it on.
 *
 * Events come from the same places as Telegram alerts: wallet events from the alerts transition engine
 * (alerts/engine.ts → toWalletEvents), Ink-wide events from events.ts. Each delivery is:
 *   - signed:     AEGIS-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, `${t}.${body}`)>  (one v1 per live
 *                 secret during a rotation, so a receiver can switch secrets without missing anything)
 *   - replay-safe: receivers reject t older than 5 minutes (verifySignature does) and dedupe on AEGIS-Delivery
 *   - idempotent:  Idempotency-Key = the event id — retries of one event carry the same key
 *   - retried:     1 min, 5 min, 30 min, 2 h, 6 h (exponential), then dead-lettered (kept, visible, never silently lost)
 * Endpoints must pass verification (echo a challenge) before any event is sent. Payloads are balance-free by schema.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AlertEvent, Observation } from '../alerts/model.js';
import { EVENTS_VERSION, INK_EVENT_TYPES, WALLET_EVENT_TYPES, type EventType, type InkEvent } from '../events.js';
import { BRAND } from '@aegis/glyphs';

export const WEBHOOKS = {
  VERSION: 'webhooks-1.0.0',
  SCHEMA: 'aegis-webhook-1',
  SIG_TOLERANCE_S: 300,
  RETRY_S: [60, 300, 1_800, 7_200, 21_600],
  /** first attempt + retries */
  MAX_ATTEMPTS: 6,
  DEAD_LETTER_KEPT: 200,
  LOG_KEPT: 200,
  SEEN_KEPT: 2_000,
  /** deliveries per subscription per minute; the rest wait */
  MAX_PER_MIN: 30,
  MAX_WALLETS: 10,
  MAX_SUBSCRIPTIONS: 500,
  ROTATION_GRACE_H: 24,
  TIMEOUT_MS: 5_000,
  MAX_RESPONSE_BYTES: 4_096,
  /** dead-lettered deliveries in a row before the subscription is paused (the endpoint is clearly gone) */
  AUTO_PAUSE_AFTER: 20,
} as const;

export const SUPPORTED_EVENTS: readonly EventType[] = [...INK_EVENT_TYPES, ...WALLET_EVENT_TYPES];
export const SYSTEM_EVENTS = ['webhook.verification', 'webhook.test'] as const;
export type SystemEvent = (typeof SYSTEM_EVENTS)[number];

export interface Secret {
  id: string;
  secret: string;
  createdAt: number;
  /** null = current; a time = still signed with until then (rotation grace) */
  expiresAt: number | null;
}
export interface Delivery {
  deliveryId: string;
  eventId: string;
  type: EventType | SystemEvent;
  /** the exact JSON body sent (signed as-is on every attempt) */
  body: string;
  attempts: number;
  firstAt: number;
  nextAt: number;
  lastError: string | null;
  lastStatus: number | null;
}
export interface LogEntry {
  at: number;
  deliveryId: string;
  eventId: string;
  type: string;
  attempt: number;
  ok: boolean;
  status: number | null;
  ms: number | null;
  error: string | null;
}
export interface Subscription {
  v: 1;
  id: string;
  url: string;
  events: Array<EventType>;
  /** wallets whose events this endpoint wants (lower-case); empty = Ink-wide events only */
  wallets: string[];
  status: 'pending-verification' | 'active' | 'paused';
  pausedReason: string | null;
  secrets: Secret[];
  /** sha256 of the management token (the token itself is shown once, never stored) */
  tokenHash: string;
  createdAt: number;
  verifiedAt: number | null;
  challenge: string | null;
  /** Ink events at or after this time are due (set at verification: no backlog) */
  since: number | null;
  testRequested: boolean;
  seen: string[];
  outbox: Delivery[];
  deadLetter: Delivery[];
  deadInARow: number;
  log: LogEntry[];
  sentAt: number[];
  /** per watched wallet: the alerts engine's transition state */
  walletState: Record<string, unknown>;
}

/* ───────────────────────── signing ───────────────────────── */

export const hmacHex = (secret: string, t: number, body: string) => createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');

/** Header value for one delivery attempt: one v1 per secret still in force. */
export function signatureHeader(secrets: readonly Secret[], body: string, nowMs: number): string {
  const t = Math.floor(nowMs / 1000);
  const live = secrets.filter((s) => s.expiresAt === null || s.expiresAt > nowMs);
  return [`t=${t}`, ...live.map((s) => `v1=${hmacHex(s.secret, t, body)}`)].join(',');
}

/** What a receiver runs (also published in docs/WEBHOOKS.md). Rejects bad signatures and anything outside the window. */
export function verifySignature(secret: string, header: string | undefined, body: string, nowMs: number, toleranceS: number = WEBHOOKS.SIG_TOLERANCE_S): { ok: boolean; reason: string | null } {
  if (!header) return { ok: false, reason: 'missing signature header' };
  const parts = header.split(',').map((p) => p.trim().split('='));
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v ?? '');
  if (!Number.isInteger(t)) return { ok: false, reason: 'no timestamp' };
  if (Math.abs(nowMs / 1000 - t) > toleranceS) return { ok: false, reason: 'timestamp outside the replay window' };
  const want = Buffer.from(hmacHex(secret, t, body), 'hex');
  const ok = sigs.some((s) => {
    const got = Buffer.from(s, 'hex');
    return got.length === want.length && timingSafeEqual(got, want);
  });
  return ok ? { ok: true, reason: null } : { ok: false, reason: 'signature does not match' };
}

export const newSecret = () => `whsec_${randomBytes(32).toString('base64url')}`;
export const newToken = () => `whtok_${randomBytes(32).toString('base64url')}`;
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
export function tokenMatches(sub: Subscription, token: string | undefined): boolean {
  if (!token) return false;
  const a = Buffer.from(tokenHash(token), 'hex');
  const b = Buffer.from(sub.tokenHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Rotate: a new current secret; the old one keeps signing for the grace period, then drops out. */
export function rotate(sub: Subscription, nowMs: number, secret: string = newSecret()): { sub: Subscription; secret: string } {
  const grace = nowMs + WEBHOOKS.ROTATION_GRACE_H * 3_600_000;
  const secrets = [...sub.secrets.filter((s) => s.expiresAt === null || s.expiresAt > nowMs).map((s) => (s.expiresAt === null ? { ...s, expiresAt: grace } : s)), { id: randomBytes(6).toString('hex'), secret, createdAt: nowMs, expiresAt: null }];
  return { sub: { ...sub, secrets }, secret };
}

/* ───────────────────────── URL rules (SSRF) — the network layer re-checks every resolved address ───────────────────────── */

const V4_PRIVATE: Array<[number, number]> = [
  [0x00000000, 8], // 0.0.0.0/8
  [0x0a000000, 8], // 10/8
  [0x64400000, 10], // 100.64/10 CGNAT
  [0x7f000000, 8], // loopback
  [0xa9fe0000, 16], // 169.254/16 link-local (cloud metadata)
  [0xac100000, 12], // 172.16/12
  [0xc0000000, 24], // 192.0.0/24
  [0xc0000200, 24], // TEST-NET-1
  [0xc0a80000, 16], // 192.168/16
  [0xc6120000, 15], // 198.18/15
  [0xc6336400, 24], // TEST-NET-2
  [0xcb007100, 24], // TEST-NET-3
  [0xe0000000, 4], // multicast
  [0xf0000000, 4], // reserved + broadcast
];

export function isPrivateIp(ip: string): boolean {
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const n = v4.slice(1).reduce((a, x) => (a << 8) + Number(x), 0) >>> 0;
    return V4_PRIVATE.some(([base, bits]) => (n >>> (32 - bits)) === (base >>> (32 - bits)));
  }
  const v6 = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (!v6.includes(':')) return true; // not an IP we understand → refuse
  if (v6 === '::' || v6 === '::1') return true;
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIp(mapped[1]!);
  return /^(fc|fd)/.test(v6) || /^fe[89ab]/.test(v6) || /^ff/.test(v6) || v6.startsWith('64:ff9b:') || v6.startsWith('2001:db8');
}

/** A delivery URL must be public https on 443. Returns the reason it's refused, or null. */
export function urlProblem(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length > 500) return 'URL missing or over 500 characters';
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'not a URL';
  }
  if (u.protocol !== 'https:') return 'only https URLs are accepted';
  if (u.username || u.password) return 'credentials in the URL are not accepted';
  if (u.port && u.port !== '443') return 'only the default https port (443) is accepted';
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!h || h === 'localhost' || /\.(local|localhost|internal|lan|home|corp|intranet)$/.test(h) || !h.includes('.') && !h.includes(':')) return 'that host is not a public internet name';
  if (/^[\d.]+$/.test(h) || h.includes(':')) return isPrivateIp(h) ? 'private, loopback or reserved addresses are not accepted' : 'use a host name, not an IP address';
  if (/(^|\.)vercel-storage\.com$|(^|\.)aegis-web/.test(h)) return 'that host is not accepted';
  return null;
}

/* ───────────────────────── events → payloads ───────────────────────── */

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** The alerts engine's wallet transitions, as webhook events — balance-free (levels, types and flags only). */
export function toWalletEvents(evs: readonly AlertEvent[], obs: Observation, nowMs: number): InkEvent[] {
  const out: InkEvent[] = [];
  for (const e of evs) {
    const base = { at: obs.dataAt ?? nowMs, block: obs.block, subject: short(e.address), urgent: e.urgent, version: EVENTS_VERSION };
    const id = (t: string) => `wallet|${e.address}|${t}|${e.detail}|${obs.block ?? nowMs}`;
    if (e.kind === 'LEVEL_UP' || e.kind === 'RECOVERED')
      out.push({ ...base, id: id('risk'), type: 'wallet.risk_changed', text: `${short(e.address)}: ${e.from ?? 'first reading'} → ${e.to ?? obs.level}`, data: { wallet: e.address, from: e.from ?? null, to: e.to ?? obs.level, hullTemp: obs.hullTemp, approximate: obs.approximate, rulesVersion: obs.rulesVersion } });
    else if (e.kind === 'CLASS_CHANGE')
      out.push({ ...base, id: id('class'), type: 'wallet.classification_changed', text: `${short(e.address)}: ${e.fromTag ?? 'none'} → ${e.toTag ?? 'none'}`, data: { wallet: e.address, from: e.fromTag ?? null, to: e.toTag ?? null, rulesVersion: obs.rulesVersion } });
    else if (e.kind === 'STALE') out.push({ ...base, id: id('stale'), type: 'wallet.data_stale', text: `${short(e.address)}: the reading is stale`, data: { wallet: e.address } });
    else if (e.kind === 'PARTIAL') out.push({ ...base, id: id('partial'), type: 'wallet.report_partial', text: `${short(e.address)}: only part of the Nado account could be read`, data: { wallet: e.address, venue: e.venue ?? null } });
    else if (e.kind === 'UNREADABLE') out.push({ ...base, id: id('unreadable'), type: 'wallet.unreadable', text: `${short(e.address)}: ${e.venue ?? 'a venue'} couldn't be read`, data: { wallet: e.address, venue: e.venue ?? null } });
  }
  return out;
}

export const DISCLAIMER = BRAND.disclaimer;

export function payload(deliveryId: string, ev: Pick<InkEvent, 'id' | 'type' | 'at' | 'block' | 'subject' | 'text' | 'data'> | { id: string; type: SystemEvent; at: number; block: null; subject: string; text: string; data: Record<string, string | number | boolean | null> }, nowMs: number): string {
  return JSON.stringify({ schema: WEBHOOKS.SCHEMA, version: WEBHOOKS.VERSION, deliveryId, sentAt: new Date(nowMs).toISOString(), event: { id: ev.id, type: ev.type, at: new Date(ev.at).toISOString(), block: ev.block, subject: ev.subject, text: ev.text, data: ev.data }, disclaimer: DISCLAIMER });
}

const newDelivery = (sub: Subscription, eventId: string, type: Delivery['type'], body: (id: string) => string, nowMs: number): Delivery => {
  const deliveryId = `dlv_${randomBytes(9).toString('base64url')}`;
  void sub;
  return { deliveryId, eventId, type, body: body(deliveryId), attempts: 0, firstAt: nowMs, nextAt: nowMs, lastError: null, lastStatus: null };
};

/**
 * Queue what's due: verification first (nothing else until verified), a requested test, then every new event this
 * endpoint subscribed to — once per event id, never anything from before verification, never a test wallet.
 */
export function plan(sub0: Subscription, events: readonly InkEvent[], nowMs: number, fixtures: ReadonlySet<string> = new Set()): Subscription {
  const sub: Subscription = { ...sub0, outbox: [...sub0.outbox], seen: [...sub0.seen] };
  if (sub.status === 'paused') return sub;
  if (sub.status === 'pending-verification') {
    if (sub.challenge && !sub.outbox.some((d) => d.type === 'webhook.verification')) {
      const ch = sub.challenge;
      sub.outbox.push(newDelivery(sub, `verify|${sub.id}|${ch.slice(0, 8)}`, 'webhook.verification', (id) => payload(id, { id: `verify|${sub.id}`, type: 'webhook.verification', at: nowMs, block: null, subject: sub.id, text: 'Respond 2xx with this challenge in the body to activate this endpoint.', data: { challenge: ch } }, nowMs), nowMs));
    }
    return sub;
  }
  if (sub.testRequested) {
    sub.outbox.push(newDelivery(sub, `test|${sub.id}|${nowMs}`, 'webhook.test', (id) => payload(id, { id: `test|${nowMs}`, type: 'webhook.test', at: nowMs, block: null, subject: sub.id, text: 'A test event. Nothing happened on Ink.', data: { test: true } }, nowMs), nowMs));
    sub.testRequested = false;
  }
  const seen = new Set(sub.seen);
  const wallets = new Set(sub.wallets);
  for (const e of [...events].sort((a, b) => a.at - b.at)) {
    if (seen.has(e.id) || !sub.events.includes(e.type as EventType)) continue;
    if (sub.since !== null && e.at < sub.since) continue;
    const w = typeof e.data.wallet === 'string' ? e.data.wallet.toLowerCase() : null;
    if (e.type.startsWith('wallet.') && (!w || !wallets.has(w) || fixtures.has(w))) continue;
    seen.add(e.id);
    sub.seen.push(e.id);
    sub.outbox.push(newDelivery(sub, e.id, e.type, (id) => payload(id, e, nowMs), nowMs));
  }
  sub.seen = sub.seen.slice(-WEBHOOKS.SEEN_KEPT);
  return sub;
}

export type SendResult = { ok: true; status: number; ms: number; body: string } | { ok: false; status: number | null; ms: number | null; error: string; retryable: boolean };

/** Deliveries due now, within the per-minute limit (the rest stay queued). */
export function due(sub: Subscription, nowMs: number): Delivery[] {
  const recent = sub.sentAt.filter((t) => nowMs - t < 60_000).length;
  return sub.outbox
    .filter((d) => d.nextAt <= nowMs)
    .sort((a, b) => a.nextAt - b.nextAt)
    .slice(0, Math.max(0, WEBHOOKS.MAX_PER_MIN - recent));
}

/** Apply one attempt's result: done, retry later (backoff), or dead-letter. Verification success activates. */
export function settle(sub0: Subscription, d: Delivery, r: SendResult, nowMs: number): Subscription {
  const sub: Subscription = { ...sub0, outbox: sub0.outbox.filter((x) => x.deliveryId !== d.deliveryId), log: [...sub0.log], deadLetter: [...sub0.deadLetter], sentAt: [...sub0.sentAt.filter((t) => nowMs - t < 60_000), nowMs] };
  const attempt = d.attempts + 1;
  sub.log.push({ at: nowMs, deliveryId: d.deliveryId, eventId: d.eventId, type: d.type, attempt, ok: r.ok, status: r.status, ms: r.ms, error: r.ok ? null : r.error });
  sub.log = sub.log.slice(-WEBHOOKS.LOG_KEPT);
  if (r.ok) {
    if (d.type === 'webhook.verification') {
      if (sub.challenge && r.body.includes(sub.challenge)) {
        sub.status = 'active';
        sub.verifiedAt = nowMs;
        sub.since = nowMs;
        sub.challenge = null;
      } else {
        sub.log[sub.log.length - 1] = { ...sub.log[sub.log.length - 1]!, ok: false, error: 'responded 2xx but did not echo the challenge' };
        return { ...sub, outbox: [...sub.outbox, { ...d, attempts: attempt, nextAt: nowMs + WEBHOOKS.RETRY_S[Math.min(attempt - 1, WEBHOOKS.RETRY_S.length - 1)]! * 1000, lastError: 'challenge not echoed', lastStatus: r.status }] };
      }
    }
    return { ...sub, deadInARow: 0 };
  }
  const next = { ...d, attempts: attempt, lastError: r.error, lastStatus: r.status };
  if (r.retryable && attempt < WEBHOOKS.MAX_ATTEMPTS) {
    sub.outbox.push({ ...next, nextAt: nowMs + WEBHOOKS.RETRY_S[attempt - 1]! * 1000 });
    return sub;
  }
  sub.deadLetter = [...sub.deadLetter, next].slice(-WEBHOOKS.DEAD_LETTER_KEPT);
  sub.deadInARow = sub0.deadInARow + 1;
  if (sub.deadInARow >= WEBHOOKS.AUTO_PAUSE_AFTER) {
    sub.status = 'paused';
    sub.pausedReason = `paused automatically: ${sub.deadInARow} deliveries in a row failed every retry`;
  }
  return sub;
}

/** Retryable = the endpoint may recover: network errors, timeouts, 408, 425, 429, 5xx. Other 4xx are final. */
export const retryableStatus = (status: number | null) => status === null || status === 408 || status === 425 || status === 429 || status >= 500;

export function newSubscription(o: { id: string; url: string; events: EventType[]; wallets: string[]; nowMs: number }): { sub: Subscription; secret: string; token: string } {
  const secret = newSecret();
  const token = newToken();
  return {
    secret,
    token,
    sub: {
      v: 1,
      id: o.id,
      url: o.url,
      events: o.events,
      wallets: o.wallets,
      status: 'pending-verification',
      pausedReason: null,
      secrets: [{ id: randomBytes(6).toString('hex'), secret, createdAt: o.nowMs, expiresAt: null }],
      tokenHash: tokenHash(token),
      createdAt: o.nowMs,
      verifiedAt: null,
      challenge: randomBytes(18).toString('base64url'),
      since: null,
      testRequested: false,
      seen: [],
      outbox: [],
      deadLetter: [],
      deadInARow: 0,
      log: [],
      sentAt: [],
      walletState: {},
    },
  };
}

/** What a management GET returns — never a secret or the token hash. */
export function publicView(sub: Subscription) {
  return {
    id: sub.id,
    url: sub.url,
    events: sub.events,
    wallets: sub.wallets,
    status: sub.status,
    pausedReason: sub.pausedReason,
    createdAt: new Date(sub.createdAt).toISOString(),
    verifiedAt: sub.verifiedAt ? new Date(sub.verifiedAt).toISOString() : null,
    secrets: sub.secrets.map((s) => ({ id: s.id, createdAt: new Date(s.createdAt).toISOString(), expiresAt: s.expiresAt ? new Date(s.expiresAt).toISOString() : null })),
    queued: sub.outbox.length,
    deadLetter: sub.deadLetter.map((d) => ({ deliveryId: d.deliveryId, eventId: d.eventId, type: d.type, attempts: d.attempts, lastStatus: d.lastStatus, lastError: d.lastError })),
    recentDeliveries: sub.log.slice(-50).reverse().map((l) => ({ ...l, at: new Date(l.at).toISOString() })),
  };
}
