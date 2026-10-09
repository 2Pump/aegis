# BILLING — crypto payments through NOWPayments (stage 3)

Status: built and **off** until the NOWPayments keys are set in Vercel. While off, the Plans page says "Payments open soon".

## How it works

1. **Checkout:** a signed-in visitor clicks **Subscribe — pay in crypto** on `/pricing`.
   - The function creates a **NOWPayments invoice** for one 30-day period: $19 Pro or $99 Desk, priced in USD.
   - It sends the visitor to NOWPayments' own page.
2. **Payment:** they pay there from their own wallet, in whatever coin NOWPayments offers. Phrourax never connects to a wallet. NOWPayments converts and pays out to your payout wallet, following your NOWPayments settings.
3. **Notification:** NOWPayments calls `POST /api/v1/billing/ipn`, an IPN signed with HMAC-SHA512 using your IPN secret.
   - On `confirmed` or `finished`, the plan is extended **once per payment** (retries and confirmed→finished count once).
   - A receipt is emailed.
   - Short payments (`partially_paid`), waiting, failed and expired payments change nothing.
   - Forged notifications, meaning a bad signature, are refused.
4. **Back on the site:** NOWPayments returns the visitor to `/account?paid=1`. That page checks every 15 s until the payment lands, then shows the plan and the payment.
5. **Reminders:** a daily job (Vercel cron, 15:07 UTC, `GET /api/v1/billing/remind` with `CRON_SECRET`) emails a renewal link **3 days before** a plan ends and **on the day it ends**, once each.
   - **Nothing ever renews or charges by itself.**

**Plan rules:**
- Paying for the plan you already have adds 30 days to the end of your current period.
- Paying for a different plan starts a fresh 30 days of that plan now. The Plans page says so before you pay.

**What's stored per payment:** date, plan, USD amount, NOWPayments payment id, paid-to date. That's in the account record, at most 24 kept. Order ids sent to NOWPayments are random and carry no email.

**Terms and refunds:** `/terms` is a plain-language draft for the owner to review. It is **not legal advice**. Refunds:
- none once a period starts;
- duplicate payments and overpayments are refunded, less network fees;
- an outage of more than 72 hours adds the lost days.

The contact address on the page is `phrourax@gmail.com`; change `CONTACT` in `apps/web/src/pages/Terms.tsx` if needed.

## Turning it on

1. **NOWPayments account** (nowpayments.io):
   1. Sign up and verify your email.
   2. Add a **payout wallet**, where your money goes, for example USDC on a chain you use. Turn on 2FA.
   3. **Settings → Payments → API keys:** generate an **API key**.
   4. **Settings → Payments → Instant payment notifications (IPN):** generate the **IPN secret key**. Phrourax sends the callback URL with every invoice, so no URL is needed there.
   5. Optionally pick which coins customers may pay with (Settings → Payments → Coins).
2. **Vercel → aegis-web → Settings → Environment Variables.** Add these as Secret, all environments:
   - `NOWPAYMENTS_API_KEY`
   - `NOWPAYMENTS_IPN_SECRET`
   - `CRON_SECRET`: make one in PowerShell and don't share it:

     ```powershell
     $b = New-Object byte[] 32; (New-Object Security.Cryptography.RNGCryptoServiceProvider).GetBytes($b); ($b | % { $_.ToString('x2') }) -join ''
     ```
3. **Redeploy.** `/pricing` should show working **Subscribe** buttons. Your comp account sees "complimentary" and no button, so test with a second email.
4. **Test end to end:**
   - **Option 1, sandbox (no real money):** create a sandbox account at account-sandbox.nowpayments.io. Set `NOWPAYMENTS_SANDBOX=1` and its API key and IPN secret in **Preview** only, and test on a preview deployment.
   - **Option 2, one real $19 payment** from a second account.
   - **What to check:** the account shows Pro, the receipt email arrives, and the payment is listed on `/account`.
5. **Switch the paywall on:** `PAYWALL=1` (docs/PAYWALL.md), then redeploy.

**To switch payments off:** remove `NOWPAYMENTS_API_KEY` and redeploy. Paid plans keep running to their paid-to dates.

## Code

- `packages/census/src/accounts/billing.ts`:
  - checkout;
  - IPN verification (`verifyIpn`: sorted-key HMAC-SHA512);
  - `extendPlan`;
  - reminders.
  
  Tests: `packages/census/test/billing.test.ts`.
- `packages/census/src/accounts/mail.ts`: receipt and renewal emails.
- `apps/web/api-src/accounts.ts`: env → billing on or off. `v1.ts` routes `/billing/*`.
- `apps/web/vercel.json`: `crons`, for the daily reminder.
- `apps/web/src/pages/Pricing.tsx`, `Account.tsx` (`?paid=1`, payments table), `Terms.tsx`.
