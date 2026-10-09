import { describe, expect, it } from 'vitest';
import { BILLING, extendPlan, ipnSignature, makeAccountsHandler, makeBillingHandler, memoryKv, sortKeysDeep, verifyIpn, type Mail } from '../src/accounts/index.js';

const SITE = 'https://phrourax.com';
const secret = Buffer.alloc(32, 9);
const IPN = 'ipn-secret-for-tests';
const DAY = 86_400_000;

function setup() {
  let t = Date.UTC(2026, 9, 10, 12);
  const now = () => t;
  const kv = memoryKv(now);
  const mails: Mail[] = [];
  const mail = async (m: Mail) => void mails.push(m);
  const invoices: Array<Record<string, unknown>> = [];
  let invoiceOk = true;
  const fetch = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    invoices.push({ url, key: init.headers['x-api-key'], ...(JSON.parse(init.body ?? '{}') as object) });
    return { ok: invoiceOk, status: invoiceOk ? 200 : 500, json: async () => (invoiceOk ? { id: 555, invoice_url: 'https://nowpayments.io/payment/?iid=555' } : {}), text: async () => '' };
  };
  const auth = makeAccountsHandler({ kv, mail, secret, now, site: SITE });
  const bill = makeBillingHandler({ kv, mail, secret, now, apiKey: 'np-key', ipnSecret: IPN, cronSecret: 'cron', site: SITE, fetch });
  const post = (h: typeof auth, path: string, body: unknown, headers: Record<string, string> = {}) =>
    h({ method: 'POST', path, ip: '1.1.1.1', headers: { 'content-type': 'application/json', origin: SITE, ...headers }, body: JSON.stringify(body) });
  const signIn = async (email: string) => {
    await post(auth, '/auth/start', { email });
    const token = mails.at(-1)!.text.match(/#t=([\w-]{43})/)![1];
    return (await post(auth, '/auth/verify', { token })).headers['Set-Cookie']!.split(';')[0]!;
  };
  const me = async (cookie: string) => (await auth({ method: 'GET', path: '/auth/me', ip: 'x', headers: { cookie } })).body as Record<string, unknown>;
  const ipn = (body: Record<string, unknown>, sig = ipnSignature(IPN, body)) =>
    bill({ method: 'POST', path: '/billing/ipn', ip: 'np', headers: { 'content-type': 'application/json', 'x-nowpayments-sig': sig }, body: JSON.stringify(body) });
  const remind = (auth = 'Bearer cron') => bill({ method: 'GET', path: '/billing/remind', ip: 'cron', headers: { authorization: auth } });
  return { kv, mails, invoices, bill, post, signIn, me, ipn, remind, advance: (ms: number) => (t += ms), now, failInvoices: () => (invoiceOk = false) };
}

describe('billing', () => {
  it('IPN signatures: keys sorted at every level; tampered body or bad signature refused', () => {
    const body = { payment_status: 'finished', a: { z: 1, b: [ { y: 2, c: 3 } ] } };
    expect(JSON.stringify(sortKeysDeep(body))).toBe('{"a":{"b":[{"c":3,"y":2}],"z":1},"payment_status":"finished"}');
    const sig = ipnSignature(IPN, body);
    expect(verifyIpn(IPN, JSON.stringify(body), sig)).toEqual(body);
    expect(verifyIpn(IPN, JSON.stringify({ ...body, payment_status: 'failed' }), sig)).toBeNull();
    expect(verifyIpn('other', JSON.stringify(body), sig)).toBeNull();
    expect(verifyIpn(IPN, JSON.stringify(body), undefined)).toBeNull();
  });

  it('plan periods: same plan adds to the end; another plan starts fresh now; a lapsed plan starts now', () => {
    const now = Date.UTC(2026, 9, 10);
    const in10 = new Date(now + 10 * DAY).toISOString();
    expect(extendPlan({ plan: 'pro', paidUntil: in10 }, 'pro', now)).toBe(new Date(now + 40 * DAY).toISOString());
    expect(extendPlan({ plan: 'pro', paidUntil: in10 }, 'desk', now)).toBe(new Date(now + 30 * DAY).toISOString());
    expect(extendPlan({ plan: 'pro', paidUntil: new Date(now - DAY).toISOString() }, 'pro', now)).toBe(new Date(now + 30 * DAY).toISOString());
    expect(extendPlan({ plan: null, paidUntil: null }, 'desk', now)).toBe(new Date(now + 30 * DAY).toISOString());
  });

  it('checkout → NOWPayments invoice for the plan price; signed-out and junk plans refused', async () => {
    const s = setup();
    expect(await s.post(s.bill, '/billing/checkout', { plan: 'pro' })).toMatchObject({ status: 401 });
    const c = await s.signIn('buyer@x.co');
    expect(await s.post(s.bill, '/billing/checkout', { plan: 'gold' }, { cookie: c })).toMatchObject({ status: 400 });
    expect(await s.post(s.bill, '/billing/checkout', { plan: 'pro' }, { cookie: c, origin: 'https://evil.example' })).toMatchObject({ status: 403 });
    const r = await s.post(s.bill, '/billing/checkout', { plan: 'pro' }, { cookie: c });
    expect(r).toMatchObject({ status: 200, body: { url: 'https://nowpayments.io/payment/?iid=555' } });
    expect(s.invoices.at(-1)).toMatchObject({ url: 'https://api.nowpayments.io/v1/invoice', key: 'np-key', price_amount: 19, price_currency: 'usd', ipn_callback_url: `${SITE}/api/v1/billing/ipn`, success_url: `${SITE}/account?paid=1`, cancel_url: `${SITE}/pricing` });
    // the order id says nothing about the account
    expect(String(s.invoices.at(-1)!.order_id)).not.toMatch(/buyer|@/);
    s.failInvoices();
    expect(await s.post(s.bill, '/billing/checkout', { plan: 'desk' }, { cookie: c })).toMatchObject({ status: 502 });
  });

  it('a finished payment extends the plan once (retries and confirmed→finished count once), emails a receipt; waiting/partial do nothing', async () => {
    const s = setup();
    const c = await s.signIn('buyer@x.co');
    await s.post(s.bill, '/billing/checkout', { plan: 'pro' }, { cookie: c });
    const order_id = String(s.invoices.at(-1)!.order_id);
    const base = { payment_id: 9001, invoice_id: 555, order_id, price_amount: 19, price_currency: 'usd', pay_currency: 'usdcbase', actually_paid: 19.02 };
    expect((await s.ipn({ ...base, payment_status: 'waiting' })).body).toMatchObject({ applied: false });
    expect((await s.ipn({ ...base, payment_status: 'partially_paid' })).body).toMatchObject({ applied: false });
    expect((await s.me(c)).access).toBe('free');
    expect((await s.ipn({ ...base, payment_status: 'confirmed' })).body).toMatchObject({ applied: true });
    expect((await s.ipn({ ...base, payment_status: 'finished' })).body).toMatchObject({ applied: false, reason: 'already applied' });
    const m = await s.me(c);
    expect(m).toMatchObject({ access: 'pro', plan: 'pro', paidUntil: new Date(s.now() + 30 * DAY).toISOString() });
    expect((m.payments as unknown[]).length).toBe(1);
    expect(s.mails.at(-1)!.subject).toContain('payment received');
    // a forged notification changes nothing
    expect((await s.ipn({ ...base, payment_id: 9002, payment_status: 'finished' }, 'ab'.repeat(64))).status).toBe(401);
    // renewing the same plan adds 30 days to the end
    await s.post(s.bill, '/billing/checkout', { plan: 'pro' }, { cookie: c });
    await s.ipn({ ...base, payment_id: 9003, order_id: String(s.invoices.at(-1)!.order_id), payment_status: 'finished' });
    expect((await s.me(c)).paidUntil).toBe(new Date(s.now() + 60 * DAY).toISOString());
  });

  it('underpriced or unknown orders are not applied', async () => {
    const s = setup();
    const c = await s.signIn('buyer@x.co');
    await s.post(s.bill, '/billing/checkout', { plan: 'desk' }, { cookie: c });
    const order_id = String(s.invoices.at(-1)!.order_id);
    expect((await s.ipn({ payment_id: 1, order_id, price_amount: 19, payment_status: 'finished' })).body).toMatchObject({ applied: false, reason: 'amount' });
    expect((await s.ipn({ payment_id: 2, order_id: 'nope', price_amount: 99, payment_status: 'finished' })).body).toMatchObject({ applied: false, reason: 'unknown order' });
    expect((await s.me(c)).access).toBe('free');
  });

  it('renewal emails: 3 days before, then on the day it ends — once each; cron secret required', async () => {
    const s = setup();
    const c = await s.signIn('buyer@x.co');
    await s.post(s.bill, '/billing/checkout', { plan: 'pro' }, { cookie: c });
    await s.ipn({ payment_id: 7, order_id: String(s.invoices.at(-1)!.order_id), price_amount: 19, payment_status: 'finished' });
    expect((await s.remind('Bearer wrong')).status).toBe(401);
    const before = s.mails.length;
    expect((await s.remind()).body).toMatchObject({ sent: 0 }); // 30 days left
    s.advance(27.5 * DAY);
    expect((await s.remind()).body).toMatchObject({ sent: 1 });
    expect(s.mails.at(-1)!.subject).toMatch(/ends/);
    expect((await s.remind()).body).toMatchObject({ sent: 0 }); // not twice
    s.advance(3 * DAY);
    expect((await s.remind()).body).toMatchObject({ sent: 1 });
    expect(s.mails.at(-1)!.subject).toMatch(/has ended/);
    expect((await s.me(c)).access).toBe('free');
    expect(s.mails.length - before).toBe(2);
    expect(BILLING.REMIND_DAYS).toEqual([3, 0]);
  });
});
