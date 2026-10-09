/**
 * Billing (stage 3, docs/BILLING.md): crypto payments through NOWPayments' hosted invoices. Pure — fetch, the store,
 * the mailer and the clock are passed in.
 *
 *   POST /billing/checkout   {plan} → a NOWPayments invoice for one 30-day period; answers {url} to send the
 *                            subscriber to. They pay on NOWPayments' page from their own wallet — Phrourax never
 *                            connects to it.
 *   POST /billing/ipn        NOWPayments' payment notification (signed, HMAC-SHA512 with the IPN secret). On a
 *                            finished payment the account's plan is extended by 30 days — once per payment.
 *   GET  /billing/remind     daily (Vercel cron, Authorization: Bearer CRON_SECRET): renewal emails 3 days before a
 *                            plan ends and on the day it ends. Nothing ever renews or charges by itself.
 *
 * Plan rules: buying the plan you already have adds 30 days to the end of the current period; buying a different plan
 * starts a fresh 30 days of that plan now (the pricing page says so before you pay).
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { BRAND, PLANS } from '@aegis/glyphs';
import { type Plan, type User } from './core.js';
import type { Kv } from './kv.js';
import { receiptMail, renewalMail, type Mailer } from './mail.js';
import { loadUser, saveUser, sessionUser, type AuthRequest, type AuthResponse } from './api.js';

export const BILLING = {
  VERSION: 'billing-1.0.0',
  PERIOD_DAYS: PLANS.PERIOD_DAYS,
  /** an unpaid checkout is forgotten after this long (NOWPayments invoices expire well before) */
  ORDER_TTL_S: 14 * 24 * 3600,
  KEEP_PAYMENTS: 24,
  /** reminders: days before the end */
  REMIND_DAYS: [3, 0],
  /** IPN statuses that mean the money arrived in full */
  PAID: ['finished', 'confirmed'],
  LIMIT_CHECKOUTS: { perUser: 10, windowS: 3600 },
} as const;

export interface BillingDeps {
  kv: Kv;
  mail: Mailer;
  secret: Buffer;
  now: () => number;
  apiKey: string;
  ipnSecret: string;
  /** Vercel cron secret for /billing/remind */
  cronSecret?: string;
  sandbox?: boolean;
  site?: string;
  fetch?: (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;
  log?: (m: string) => void;
}

const NO_STORE = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' };
const json = (status: number, body: unknown): AuthResponse => ({ status, headers: { ...NO_STORE }, body });
const err = (status: number, code: string, message: string) => json(status, { error: { code, message } });
const h1 = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

const isPlan = (p: unknown): p is Plan => p === 'pro' || p === 'desk';
const SUBS_KEY = 'subs:index';
const orderKey = (id: string) => `ord:${id}`;
const payKey = (id: string) => `pay:${id}`;

/** NOWPayments' IPN signature: HMAC-SHA512 (hex) of the body's JSON with object keys sorted, at every level. */
export function sortKeysDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortKeysDeep((v as Record<string, unknown>)[k])]));
  return v;
}
export const ipnSignature = (secret: string, body: unknown): string => createHmac('sha512', secret).update(JSON.stringify(sortKeysDeep(body))).digest('hex');
export function verifyIpn(secret: string, rawBody: string, sig: string | undefined): Record<string, unknown> | null {
  if (!sig || !/^[0-9a-f]{128}$/i.test(sig)) return null;
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const want = Buffer.from(ipnSignature(secret, body), 'hex');
  const got = Buffer.from(sig.toLowerCase(), 'hex');
  return want.length === got.length && timingSafeEqual(want, got) ? (body as Record<string, unknown>) : null;
}

/** The new paid-to date for a payment of `plan` at `nowMs`. Same plan: added to the end. Other plan: 30 days from now. */
export function extendPlan(u: Pick<User, 'plan' | 'paidUntil'>, plan: Plan, nowMs: number): string {
  const days = BILLING.PERIOD_DAYS * 86_400_000;
  const end = u.paidUntil ? Date.parse(u.paidUntil) : 0;
  const base = u.plan === plan && end > nowMs ? end : nowMs;
  return new Date(base + days).toISOString();
}

export function makeBillingHandler(d: BillingDeps) {
  const site = (d.site ?? BRAND.siteUrl).replace(/\/+$/, '');
  const api = d.sandbox ? 'https://api-sandbox.nowpayments.io/v1' : 'https://api.nowpayments.io/v1';
  const f = d.fetch ?? (globalThis.fetch as unknown as NonNullable<BillingDeps['fetch']>);
  const log = d.log ?? (() => {});

  const addToIndex = async (id: string) => {
    const raw = await d.kv.get(SUBS_KEY);
    const ids = new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
    if (!ids.has(id)) {
      ids.add(id);
      await d.kv.set(SUBS_KEY, JSON.stringify([...ids]));
    }
  };

  async function checkout(req: AuthRequest): Promise<AuthResponse> {
    if (req.method !== 'POST') return err(405, 'METHOD_NOT_ALLOWED', 'Use POST.');
    if (!String(h1(req.headers['content-type']) ?? '').toLowerCase().startsWith('application/json')) return err(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send JSON.');
    const origin = h1(req.headers.origin);
    if (origin && origin !== site) return err(403, 'FORBIDDEN', 'Cross-site request refused.');
    const u = await sessionUser(d, h1(req.headers.cookie));
    if (!u) return err(401, 'SIGN_IN', 'Sign in first.');
    let plan: unknown;
    try {
      plan = (JSON.parse(req.body ?? '') as { plan?: unknown }).plan;
    } catch {
      /* below */
    }
    if (!isPlan(plan)) return err(400, 'BAD_PLAN', 'Choose Pro or Desk.');
    if ((await d.kv.incrWindow(`rl:co:${u.id}`, BILLING.LIMIT_CHECKOUTS.windowS)) > BILLING.LIMIT_CHECKOUTS.perUser) return err(429, 'RATE_LIMITED', 'Too many checkouts — try again in an hour.');
    const orderId = randomBytes(12).toString('base64url');
    const usd = PLANS[plan].usd;
    await d.kv.set(orderKey(orderId), JSON.stringify({ userId: u.id, plan, usd, at: new Date(d.now()).toISOString() }), BILLING.ORDER_TTL_S);
    const r = await f(`${api}/invoice`, {
      method: 'POST',
      headers: { 'x-api-key': d.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        price_amount: usd,
        price_currency: 'usd',
        order_id: orderId,
        order_description: `${BRAND.display} ${PLANS[plan].name} — ${BILLING.PERIOD_DAYS} days`,
        ipn_callback_url: `${site}/api/v1/billing/ipn`,
        success_url: `${site}/account?paid=1`,
        cancel_url: `${site}/pricing`,
      }),
    });
    const j = (await r.json().catch(() => null)) as { invoice_url?: string; id?: string | number } | null;
    if (!r.ok || !j?.invoice_url || !/^https:\/\/([a-z0-9-]+\.)*nowpayments\.io\//i.test(j.invoice_url)) {
      log(`billing: invoice not created (HTTP ${r.status})`);
      return err(502, 'PAYMENT_PROVIDER', "The payment page couldn't be opened just now — try again in a minute.");
    }
    return json(200, { url: j.invoice_url });
  }

  async function ipn(req: AuthRequest): Promise<AuthResponse> {
    if (req.method !== 'POST') return err(405, 'METHOD_NOT_ALLOWED', 'Use POST.');
    const body = verifyIpn(d.ipnSecret, req.body ?? '', h1(req.headers['x-nowpayments-sig']));
    if (!body) {
      log('billing: IPN with a bad or missing signature — ignored');
      return err(401, 'BAD_SIGNATURE', 'Signature check failed.');
    }
    const status = String(body.payment_status ?? '');
    const paymentId = String(body.payment_id ?? '');
    const orderId = String(body.order_id ?? '');
    if (!(BILLING.PAID as readonly string[]).includes(status)) return json(200, { ok: true, applied: false, status });
    if (!paymentId || !orderId) return json(200, { ok: true, applied: false, reason: 'no payment or order id' });
    const rawOrder = await d.kv.get(orderKey(orderId));
    if (!rawOrder) {
      log(`billing: paid IPN for an unknown order (payment ${paymentId}) — needs a manual look`);
      return json(200, { ok: true, applied: false, reason: 'unknown order' });
    }
    const order = JSON.parse(rawOrder) as { userId: string; plan: Plan; usd: number };
    // the amount must be the plan's price (NOWPayments marks short payments partially_paid, never finished)
    const priced = Number(body.price_amount);
    if (Number.isFinite(priced) && priced + 1e-9 < order.usd) {
      log(`billing: payment ${paymentId} priced ${priced} below ${order.usd} — not applied`);
      return json(200, { ok: true, applied: false, reason: 'amount' });
    }
    // once per payment, whatever NOWPayments retries ('confirmed' then 'finished' is one payment)
    if (!(await d.kv.setIfAbsent(payKey(paymentId), orderId, 400 * 86_400))) return json(200, { ok: true, applied: false, reason: 'already applied' });
    const u = await loadUser(d.kv, order.userId);
    if (!u) {
      log(`billing: payment ${paymentId} for a missing account — needs a manual look`);
      return json(200, { ok: true, applied: false, reason: 'no account' });
    }
    const now = d.now();
    const paidUntil = extendPlan(u, order.plan, now);
    u.plan = order.plan;
    u.paidUntil = paidUntil;
    u.payments = [{ at: new Date(now).toISOString(), plan: order.plan, usd: order.usd, paymentId, paidUntil }, ...(u.payments ?? [])].slice(0, BILLING.KEEP_PAYMENTS);
    await saveUser(d.kv, u);
    await addToIndex(u.id);
    await d.mail(receiptMail(u.email, { planName: PLANS[order.plan].name, usd: order.usd, paidUntil, site })).catch((e: unknown) => log(`billing: receipt not sent: ${String(e).slice(0, 200)}`));
    return json(200, { ok: true, applied: true });
  }

  async function remind(req: AuthRequest): Promise<AuthResponse> {
    if (!d.cronSecret || h1(req.headers.authorization) !== `Bearer ${d.cronSecret}`) return err(401, 'UNAUTHORIZED', 'Cron only.');
    const raw = await d.kv.get(SUBS_KEY);
    const ids: string[] = raw ? (JSON.parse(raw) as string[]) : [];
    const now = d.now();
    let sent = 0;
    for (const id of ids) {
      const u = await loadUser(d.kv, id);
      if (!u?.plan || !u.paidUntil) continue;
      const end = Date.parse(u.paidUntil);
      const daysLeft = (end - now) / 86_400_000;
      // the latest reminder now due, if not yet sent for this paid-to date
      const due = BILLING.REMIND_DAYS.filter((n) => daysLeft <= n && daysLeft > n - 7).map((n) => `${n}d`);
      const done = new Set(u.reminded?.[u.paidUntil] ?? []);
      // only the most recent reminder that applies (an ended plan never gets a late "ends in 3 days")
      const next = due.at(-1);
      if (!next || done.has(next)) continue;
      try {
        await d.mail(renewalMail(u.email, { planName: PLANS[u.plan].name, paidUntil: u.paidUntil, site, ended: next === '0d' }));
        u.reminded = { [u.paidUntil]: [...done, next] };
        await saveUser(d.kv, u);
        sent++;
      } catch (e) {
        log(`billing: reminder not sent: ${String(e).slice(0, 200)}`);
      }
    }
    return json(200, { ok: true, accounts: ids.length, sent });
  }

  return async function handleBilling(req: AuthRequest): Promise<AuthResponse> {
    try {
      if (req.path === '/billing/checkout') return await checkout(req);
      if (req.path === '/billing/ipn') return await ipn(req);
      if (req.path === '/billing/remind') return await remind(req);
      return err(404, 'NOT_FOUND', 'No such endpoint.');
    } catch (e) {
      log(`billing: ${String(e).slice(0, 300)}`);
      return err(503, 'UNAVAILABLE', 'Billing is temporarily unavailable — try again shortly.');
    }
  };
}

export const billingOff = async (): Promise<AuthResponse> => err(503, 'NOT_ENABLED', 'Payments are not switched on yet.');
