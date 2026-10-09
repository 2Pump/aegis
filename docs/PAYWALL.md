# PAYWALL — paid access (stage 2)

Status: built and **off**. It turns on only when `PAYWALL=1` is set in Vercel *and* accounts are on (docs/ACCOUNTS.md). While off, the site and API behave exactly as before.

## What is free and what is paid

| | Free | Pro ($19 / 30 days) | Desk ($99 / 30 days) |
|---|---|---|---|
| Paste a wallet: risk level and position types | ✓ | ✓ | ✓ |
| Share links and cards, rules, Checks / track record | ✓ | ✓ | ✓ |
| Well, Pressure, Intel, Scan | — | ✓ | ✓ |
| Wallet detail: positions, exposure, stress test, history | — | ✓ | ✓ |
| API beyond `/status`, `/wallets/{address}`, `/performance`, `/verification` | — | — | ✓ |

- **Where it's set:**
  - Prices and plan text: `PLANS` in `packages/glyphs/src/brand.ts`.
  - The free lists: `packages/census/src/accounts/paywall.ts`.
- **Test wallets** (`/fixture/…`) are always fully open.
- **Complimentary accounts:** `COMP_EMAILS`, comma-separated, count as Desk. Put your own email there.

## How it is enforced

- **Data goes through the function.** A deployed site no longer reads census files from the Blob URL. It reads them through `/api/v1/data/<file>`.
  - The function checks the visitor's plan from their session cookie.
  - It answers **402** without a plan, except for the free files.
  - A per-wallet lookup (`/api/v1/data/subs/<address>`) is free. The wallet page needs it to find Nado isolated accounts.
- **No shared caching of paid answers.**
  - A paid file or paid API answer is `Cache-Control: private` with `Vary: Cookie`, so Vercel's CDN never hands one subscriber's response to someone else.
  - Free files may be cached by the CDN.
  - **When the paywall is first switched on**, copies the CDN cached while it was off expire within about a minute.
- **Large files are gzipped by the function** (a function response is capped at 4.5 MB).
- **Locked pages don't load anything.**
  - The paid component isn't mounted, so no census or chain-watching starts.
  - On a wallet page, the risk level and types still come from the live chain read in the browser.
  - That read is public chain data. What a plan pays for is Phrourax's hourly scan, its history, the analysis and the API.

## Private storage (do this before switching the paywall on)

With the original public Blob store, anyone who knows a file's URL can read it, and the URL was in the site's code. The census can move to a **private** Blob store, which needs a token for every read.

1. **Vercel → Storage → Create Storage → Blob.**
   - Name it `phrourax-census-private`.
   - Set Access to **Private**.
   - Create it.
   - Open it and copy its **read-write token**, from the `.env.local` / Quickstart tab: the value of `BLOB_READ_WRITE_TOKEN` *for this store*.
   - Don't connect it to the project with the default name, because that would replace the existing `BLOB_READ_WRITE_TOKEN`. If Vercel insists on connecting it, set a custom prefix such as `CENSUS_PRIVATE`.
2. **Vercel → aegis-web → Settings → Environment Variables:** add `CENSUS_BLOB_TOKEN` (Secret, all environments) with that token.
3. **GitHub → 2Pump/aegis → Settings → Secrets and variables → Actions:**
   - Secrets: add `CENSUS_BLOB_TOKEN`, the same token.
   - Variables: add `CENSUS_STORE` = `private`.
4. **First private run:** the next census run (or Actions → census → Run workflow) sees an empty private store and **copies every file over from the public one first**, with `known.json` last. Then it carries on there. Its log says `copying N files …`.
5. **Redeploy Vercel.** The function reads the private store from then on.
6. **After a day of good runs:** Actions → **census storage** → Run workflow.
   - Type `DELETE PUBLIC` to delete the public copies, so the old URLs stop working.
   - It refuses unless the private store has every file. Leave the box empty for a dry run.

The census, Checks, alerts and webhooks jobs all switch together through `CENSUS_STORE=private`. The freshness check now reads the site's free `/api/v1/status`.

## Switching the paywall on

1. Accounts are on (docs/ACCOUNTS.md), and private storage is done (above).
2. Vercel env:
   - `COMP_EMAILS` = your own email.
   - `PAYWALL` = `1`.
3. Redeploy.
4. Check signed out: the Well, Pressure, Intel and Scan show **Subscribers only**, and the header shows **Subscribe**.
5. Check signed in with your comp email: everything opens, and the header shows **Desk**.

**Turn the paywall on only once payments work** (docs/BILLING.md). Until then nobody can buy a plan, so the site would be closed to everyone but comp accounts.

**To switch it off:** remove `PAYWALL` and redeploy.

## Code

- `packages/census/src/accounts/paywall.ts`: what's free, and plan logic. Tests: `test/paywall.test.ts`.
- `packages/census/src/api/data.ts`: the `/data` route.
- `packages/census/src/node/store.ts`:
  - private store reads and writes;
  - `migrateToPrivateIfNeeded`;
  - `deletePublicCopies`.
  
  Tests: `test/store-private.test.ts`.
- `apps/web/api-src/accounts.ts`: env → accounts, paywall and comp. `v1.ts` routes `/data/*` and gates the API.
- `apps/web/src/components/Paywall.tsx`: locked panel, page wrapper, Subscribe button.
- `src/pages/Pricing.tsx`, `src/lib/account.ts` (`usePlanGate`).
