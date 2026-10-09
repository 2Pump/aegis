/**
 * Accounts inside the API function (/api/v1/auth/*) — OFF unless the Vercel project has all of:
 *   AUTH_SECRET                                   32+ random bytes (hex or base64) that sign session cookies
 *   KV_REST_API_URL + KV_REST_API_TOKEN           the Upstash Redis store (Vercel sets these when you add it;
 *     (or UPSTASH_REDIS_REST_URL + _TOKEN)        the Upstash names work too)
 *   RESEND_API_KEY                                sends the sign-in emails
 *   MAIL_FROM (optional)                          default "Phrourax <signin@phrourax.com>"
 * Off = GET /auth/me says {configured:false} and the site shows no sign-in at all (docs/ACCOUNTS.md).
 */
import { BRAND } from '@aegis/glyphs';
import { accountsOff, makeAccountsHandler, parseAuthSecret, resendMailer, upstashKv, type AuthHandler, type Kv } from '@aegis/census/accounts';

export interface AccountsRuntime {
  handler: AuthHandler;
  /** the store, when accounts are on (stage 2 reads plans from it) */
  kv: Kv | null;
  secret: Buffer | null;
}

export function makeAccounts(env: NodeJS.ProcessEnv = process.env): AccountsRuntime {
  const secret = parseAuthSecret(env.AUTH_SECRET);
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  const resend = env.RESEND_API_KEY;
  if (!secret || !url || !token || !resend) return { handler: accountsOff, kv: null, secret: null };
  const kv = upstashKv({ url, token });
  const mail = resendMailer({ apiKey: resend, from: env.MAIL_FROM || `${BRAND.display} <signin@phrourax.com>` });
  return { handler: makeAccountsHandler({ kv, mail, secret, now: () => Date.now(), log: (m) => console.error(m) }), kv, secret };
}
