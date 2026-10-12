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
 *
 * Telegram alerts (docs/ALERTS.md) are OFF unless accounts are on and this exists:
 *   TELEGRAM_BOT_TOKEN                            from @BotFather (the same value as the GitHub secret)
 *   ALERTS_LIVE=1 (optional)                      every paying account sees alerts; without it only COMP_EMAILS do
 */
import { BRAND } from '@aegis/glyphs';
import {
  billingOff,
  makeBillingHandler,
  accountsOff,
  alertsOff,
  makeAlertsHandler,
  TELEGRAM_TOKEN_SHAPE,
  effectiveAccess,
  makeAccountsHandler,
  makeKeyResolver,
  makeHookTestHandler,
  makeKeysHandler,
  loadUser,
  parseAuthSecret,
  parseComp,
  resendMailer,
  sessionUser,
  upstashKv,
  type Access,
  type AlertsDeps,
  type AuthHandler,
  type Kv,
} from '@aegis/census/accounts';

export interface AccountsRuntime {
  handler: AuthHandler;
  /** /billing/* (checkout, NOWPayments IPN, daily reminders) */
  billing: AuthHandler;
  /** /alerts/* and /telegram/hook */
  alerts: AuthHandler;
  /** /keys — Desk API keys (create, list, revoke) */
  keys: AuthHandler;
  /** /hooktest — a webhook test receiver for Desk accounts */
  hooktest: AuthHandler;
  /** an API key's account and plan (null = not a live key) */
  byKey: (key: string) => Promise<{ uid: string; keyId: string; access: Access } | null>;
  /** the signed-in account behind a cookie (uncached; for rare actions like creating a webhook) */
  sessionOf: (cookieHeader: string | undefined) => Promise<{ uid: string; access: Access } | null>;
  /** an account's plan now */
  accessOf: (uid: string) => Promise<Access>;
  kv: Kv | null;
  on: boolean;
  paywall: boolean;
  /** the visitor's plan from their cookie ('free' when signed out, or when accounts are off) */
  who: (cookieHeader: string | undefined) => Promise<{ signedIn: boolean; access: Access }>;
}

const WHO_TTL_MS = 30_000;
const whoCache = new Map<string, { at: number; v: { signedIn: boolean; access: Access } }>();

export function makeAccounts(env: NodeJS.ProcessEnv = process.env, extra: Pick<AlertsDeps, 'fixtures' | 'read'> = { fixtures: new Set() }): AccountsRuntime {
  const secret = parseAuthSecret(env.AUTH_SECRET);
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  const resend = env.RESEND_API_KEY;
  if (!secret || !url || !token || !resend) {
    if (env.PAYWALL === '1') console.error('PAYWALL=1 ignored: accounts are not fully set up (docs/ACCOUNTS.md)');
    return { handler: accountsOff, billing: billingOff, alerts: alertsOff, keys: accountsOff, hooktest: accountsOff, byKey: async () => null, sessionOf: async () => null, accessOf: async () => 'free', kv: null, on: false, paywall: false, who: async () => ({ signedIn: false, access: 'free' }) };
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
  const botToken = env.TELEGRAM_BOT_TOKEN?.trim();
  const alertsOn = Boolean(botToken && TELEGRAM_TOKEN_SHAPE.test(botToken));
  if (botToken && !alertsOn) console.error('TELEGRAM_BOT_TOKEN ignored: it does not look like a bot token (docs/ALERTS.md)');
  const alertsLive = alertsOn && env.ALERTS_LIVE === '1';
  const site = BRAND.siteUrl.replace(/\/+$/, '');
  return {
    keys: makeKeysHandler({ kv, secret, now, comp, site, log }),
    hooktest: makeHookTestHandler({ kv, secret, now, comp, site }),
    byKey: makeKeyResolver({ kv, now, comp, log }),
    sessionOf: async (cookie) => {
      const u = await sessionUser({ kv, secret, now }, cookie);
      return u ? { uid: u.id, access: effectiveAccess(u, now(), comp) } : null;
    },
    accessOf: async (uid) => effectiveAccess(await loadUser(kv, uid), now(), comp),
    kv,
    handler: makeAccountsHandler({ kv, mail, secret, now, comp, paywall, billing: billingOn, alerts: alertsOn ? (alertsLive ? 'live' : 'owner') : 'off', webhooks: env.WEBHOOKS_ENABLED === '1' && !!env.WEBHOOKS_STORE_KEY && !!env.BLOB_READ_WRITE_TOKEN, log }),
    alerts: alertsOn ? makeAlertsHandler({ kv, secret, now, comp, botToken: botToken!, live: alertsLive, fixtures: extra.fixtures, read: extra.read, log }) : alertsOff,
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
