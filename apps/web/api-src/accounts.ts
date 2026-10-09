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
 */
import { BRAND } from '@aegis/glyphs';
import {
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
  on: boolean;
  paywall: boolean;
  /** the visitor's plan from their cookie ('free' when signed out, or when accounts are off) */
  who: (cookieHeader: string | undefined) => Promise<{ signedIn: boolean; access: Access }>;
}

export function makeAccounts(env: NodeJS.ProcessEnv = process.env): AccountsRuntime {
  const secret = parseAuthSecret(env.AUTH_SECRET);
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  const resend = env.RESEND_API_KEY;
  if (!secret || !url || !token || !resend) {
    if (env.PAYWALL === '1') console.error('PAYWALL=1 ignored: accounts are not fully set up (docs/ACCOUNTS.md)');
    return { handler: accountsOff, on: false, paywall: false, who: async () => ({ signedIn: false, access: 'free' }) };
  }
  const kv = upstashKv({ url, token });
  const mail = resendMailer({ apiKey: resend, from: env.MAIL_FROM || `${BRAND.display} <signin@phrourax.com>` });
  const comp = parseComp(env.COMP_EMAILS);
  const paywall = env.PAYWALL === '1';
  const now = () => Date.now();
  return {
    handler: makeAccountsHandler({ kv, mail, secret, now, comp, paywall, log: (m) => console.error(m) }),
    on: true,
    paywall,
    who: async (cookie) => {
      if (!cookie) return { signedIn: false, access: 'free' };
      const u = await sessionUser({ kv, secret, now }, cookie);
      return { signedIn: u !== null, access: effectiveAccess(u, now(), comp) };
    },
  };
}
