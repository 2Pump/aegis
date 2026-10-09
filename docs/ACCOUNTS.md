# ACCOUNTS — sign in by emailed link (stage 1 of paid access)

Status: built and **off** until the four settings below exist in Vercel. While off, `GET /api/v1/auth/me` answers `{configured:false}`, the header shows no sign-in, and the site works exactly as before.

## What an account is

- **The record:** an email address and a plan. Nothing about the person's wallets is stored.
  - Phrourax never connects to a wallet.
  - Signing in uses only an emailed link. There are no passwords and no wallet signatures.
- **Plans** (`pro`, `desk`) count while their paid period runs (`paidUntil`). Payments come in stage 3 (NOWPayments). Until then every account is Free.

## Flow

1. **`/signin`:** the visitor enters an email.
   - `POST /api/v1/auth/start` emails a one-time link (Resend).
   - The answer is the same whether or not the account exists, so the form can't be used to test addresses.
2. **The link:** it is `https://phrourax.com/auth/verify#t=<token>`. The token is in the `#` part, so it is never sent to a server or written to logs.
   - The page removes it from the address bar at once.
   - A **Sign in** button sends it (`POST /auth/verify`). Mail scanners that open links therefore can't use it up.
3. **Verify:** the token works once, for 15 minutes. Only its SHA-256 hash is stored.
   - The first sign-in creates the account.
   - A signed session cookie is set: `__Host-phx_session`, HttpOnly, Secure, SameSite=Lax, 30 days.
4. **`/account`:** shows the email, plan and paid-to date.
   - **Sign out:** clears the cookie.
   - **Sign out on every device:** bumps the account's session version, so every older cookie stops working.

## Safety

- POSTs must be JSON and come from the site's own origin, so cross-site sign-in is refused.
- **Limits:** 3 links per address and 10 requests per IP per 15 minutes.
- Cookies are HMAC-SHA256 signed with `AUTH_SECRET`. A forged, expired or revoked cookie means "signed out".
- **Store or email outage:** the endpoint answers 503 and the error is logged. The site keeps working.

## Turning it on (Vercel → aegis-web)

1. **Store:**
   - Go to Storage → Create Database → **Upstash for Redis** (Marketplace). The free plan is enough to start.
   - Connect it to the `aegis-web` project, all environments.
   - Vercel adds `KV_REST_API_URL` and `KV_REST_API_TOKEN`. `UPSTASH_REDIS_REST_URL` / `_TOKEN` work too.
2. **Email:**
   - Create a [Resend](https://resend.com) account.
   - Under Domains, add `phrourax.com`.
   - Add the DNS records it shows (Vercel → Domains → phrourax.com → DNS records), then wait for **Verified**.
   - Under API Keys, create a key with **Sending access**.
   - In Vercel, set it as `RESEND_API_KEY`.
3. **Secret:** generate 32 random bytes on your own computer (PowerShell) and set the output as `AUTH_SECRET`. Don't paste it anywhere else.

   ```powershell
   $b = New-Object byte[] 32; (New-Object Security.Cryptography.RNGCryptoServiceProvider).GetBytes($b); ($b | % { $_.ToString('x2') }) -join ''
   ```
4. **Optional:** set `MAIL_FROM`. The default is `Phrourax <signin@phrourax.com>`.
5. **Redeploy:** Deployments → ⋯ → Redeploy. Then:
   - **SIGN IN** appears in the header.
   - Sign in with your own email.
   - `/account` shows "Free".

**To turn it off:** remove `AUTH_SECRET`. All four settings are required, so accounts go off and every existing session ends with them.

## Code

- `packages/census/src/accounts/`:
  - `core.ts`: emails, plans, tokens, cookie;
  - `kv.ts`: the store;
  - `mail.ts`: the sign-in email;
  - `api.ts`: the handler.
  
  Tests: `packages/census/test/accounts.test.ts`.
- `apps/web/api-src/accounts.ts`: env → handler (off when incomplete). `api-src/v1.ts` routes `/api/v1/auth/*` to it.
- `apps/web/src/pages/Account.tsx` (`/signin`, `/auth/verify`, `/account`, header button) and `src/lib/account.ts`.

## Next stages

2. **Paywall:**
   - Census and history files are served only to paid accounts, through the function.
   - The teaser stays free: a wallet's risk level and types, share links, rules, Checks.
3. **Billing:** NOWPayments invoices per 30-day period, an IPN webhook that extends `paidUntil`, and renewal emails.
4. **Plan features:** alerts per plan, Desk API keys, webhooks.
