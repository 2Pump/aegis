# LOAD — keeping PHROURAX up under heavy use

How the site behaves when many people use it at once, what was measured, and the alerts to set.

## What a visit costs

| Piece | Who pays | Per visit |
|---|---|---|
| Pages, JS, CSS | Vercel CDN (static) | cached, no function |
| `/api/v1/data/*` (census, history, pressure, verification) | one Vercel function | answered from instance memory; blob store read at most once per 60 s per instance |
| Sign-in check (`who`, `/auth/me`) | Upstash KV | at most 1 read per cookie per 30 s (`who`) / 15 s (`/auth/me`) per instance |
| Live wallet read | the visitor's browser → Ink public RPCs | rotates over 4 endpoints, a failing one rests 20 s |

## Server caching (api-src/v1.ts)

- The parsed census/history file is kept 60 s per instance (one store read, shared by all requests).
- The encoded bytes are kept with it: raw, gzip (when over 32 KB, done once), and an `ETag`.
- A browser that already has the file sends `If-None-Match` → **304, 0 bytes**. The paywall check still runs first, so a 304 never leaks paid data.
- Paid answers stay `private` with `Vary: Cookie, Accept-Encoding` — the CDN never shares them between users.
- The browser no longer adds `?t=` cache-busters to `/api/v1/data/` URLs, so revalidation actually works.

## Limits

- Data routes: **300 requests per minute per IP per instance** → `429` with `Retry-After`. A normal visit uses well under 20.
- Sign-in: 3 links per email and 10 requests per IP per 15 minutes (unchanged).

## Measured (local, mock 1.3 MB census, 30 concurrent)

| | Before | After |
|---|---|---|
| Throughput | 59 req/s | ~15,000 req/s |
| p50 latency | 497 ms | < 1 ms |
| KV commands | 1 per request | 30 per 2,000 requests |
| Bytes sent for the census | 1,281 KB | 80 KB gzip; 0 on repeat (304) |

Real numbers on Vercel are lower (network, cold starts) but the shape holds: the store and KV are no longer touched per request.

## Alerts to set (once)

**Vercel — spend**
1. vercel.com → your team → **Settings** → **Billing**.
2. Find **Spend Management**. Turn it on.
3. Set an amount you're comfortable with (e.g. $50). Tick the email/notification option.
4. Leave "pause projects" **off** unless you'd rather the site go down than cost more.

**Vercel — usage**
1. Project **aegis-web** → **Usage** tab. Check Function Invocations and Fast Data Transfer once a week at first.
2. **Observability** tab shows errors and slow routes for `/api/v1/*`.

**Upstash — KV**
1. console.upstash.com → your database → **Usage** / **Details**.
2. Check the daily command count. If it nears the free limit, switch the database to **Pay as you go** (same page) so it doesn't stop answering.
3. Turn on email alerts in account settings if offered.

**Ink RPC (optional)**
If wallet reads get slow under load, set a paid Ink RPC in Vercel env `VITE_INK_RPC` (comma-separated list allowed) and redeploy. Never paste the key anywhere else.

## After each deploy — quick check

1. Open phrourax.com, sign in, open the Well. It loads.
2. Reload. In browser DevTools → Network, `census.json` shows **304**.
3. The footer reads **"4 public RPCs, rotating"**.
