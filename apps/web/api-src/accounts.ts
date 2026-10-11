/**
 * Accounts and the paywall inside the API function (docs/ACCOUNTS.md, docs/PAYWALL.md).
 *
 * Accounts are OFF unless the Vercel project has all of:
 *   AUTH_SECRET                                   32+ random bytes (hex or base64) that sign session cookies
 *   KV_REST_API_URL + KV_REST_API_TOKEN           the Upstash Redis store (or UPSTASH_REDIS_REST_URL + _TOKEN)
 *   RESEND_API_KEY                                sends the sign-in emails
 *   MAIL_FROM (optional)                          default "Phrourax <signin@phrourax.com>"
 * Off = GET /auth/me says {configured:false} and the site shows no sign-in at all.
 *
 * The paywall is OFF unless PAYWALL=1 — and it can only be on while accounts are on (nobody could unlock it otherwise).
 *   COMP_EMAILS (optional)                        comma-separated emails with complimentary Desk access (the owner)
 *
 * Payments (docs/BILLING.md) are OFF unless accounts are on and these exist:
 *   NOWPAYMENTS_API_KEY, NOWPAYMENTS_IPN_SECRET   from the NOWPayments dashboard
 *   CRON_SECRET                                   any long random string; Vercel sends it to the daily reminder job
 *   NOWPAYMENTS_SANDBOX=1 (optional)              use NOWPayments' sandbox (test payments, no real money)
 */
import { BRAND } from '@aegis/glyphs';
import {
  billingOff,
  makeBillingHandler,
  accountsOff,
  effectiveAccess,
  makeAccountsHandler,
  parseAuthSecret,
  parseComp,
  resendMailer,
  sessionUser,
  upstashKv,
  type Access,
  type AuthHandler,
} from '@aegis/census/accounts';

export interface AccountsRuntime {
  handler: AuthHandler;
  /** /billing/* (checkout, NOWPayments IPN, daily reminders) */
  billing: AuthHandler;
  on: boolean;
  paywall: boolean;
  /** the visitor's plan from their cookie ('free' when signed out, or when accounts are off) */
  who: (cookieHeader: string | undefined) => Promise<{ signedIn: boolean; access: Access }>;
}

const WHO_TTL_MS = 30_000;
const whoCache = new Map<string, { at: number; v: { signedIn: boolean; access: Access } }>();

export function makeAccounts(env: NodeJS.ProcessEnv = process.env): AccountsRuntime {
  const secret = parseAuthSecret(env.AUTH_SECRET);
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  const resend = env.RESEND_API_KEY;
  if (!secret || !url || !token || !resend) {
    if (env.PAYWALL === '1') console.error('PAYWALL=1 ignored: accounts are not fully set up (docs/ACCOUNTS.md)');
    return { handler: accountsOff, billing: billingOff, on: false, paywall: false, who: async () => ({ signedIn: false, access: 'free' }) };
  }
  const kv = upstashKv({ url, token });
  const mail = resendMailer({ apiKey: resend, from: env.MAIL_FROM || `${BRAND.display} <signin@phrourax.com>` });
  const comp = parseComp(env.COMP_EMAILS);
  const paywall = env.PAYWALL === '1';
  const now = () => Date.now();
  const log = (m: string) => console.error(m);
  const npKey = env.NOWPAYMENTS_API_KEY;
  const npIpn = env.NOWPAYMENTS_IPN_SECRET;
  const billingOn = Boolean(npKey && npIpn);
  return {
    handler: makeAccountsHandler({ kv, mail, secret, now, comp, paywall, billing: billingOn, log }),
    billing: billingOn
      ? makeBillingHandler({ kv, mail, secret, now, apiKey: npKey!, ipnSecret: npIpn!, cronSecret: env.CRON_SECRET, sandbox: env.NOWPAYMENTS_SANDBOX === '1', log })
      : billingOff,
    on: true,
    paywall,
    // one store read per session per 30 s per instance — not one per file a page loads (a plan change shows within 30 s)
    who: async (cookie) => {
      if (!cookie) return { signedIn: false, access: 'free' };
      const hit = whoCache.get(cookie);
      if (hit && now() - hit.at < WHO_TTL_MS) return hit.v;
      const u = await sessionUser({ kv, secret, now }, cookie);
      const v = { signedIn: u !== null, access: effectiveAccess(u, now(), comp) };
      if (whoCache.size > 5000) whoCache.clear();
      whoCache.set(cookie, { at: now(), v });
      return v;
    },
  };
}
