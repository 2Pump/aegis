# Public Risk API (`/api/v1`, `api-1.0.0`)

A read-only JSON API over the same readings as the site. It's one Vercel function (`apps/web/api/v1.js`) that only adapts HTTP to the handler in `packages/census/src/api/`. Routing, validation, privacy and the response envelope all live in that handler, and the tests call it directly.

The machine-readable description is at **`/api/v1/openapi.json`** (OpenAPI 3.1). There's also a page for people at **`/developers`**.

## Endpoints (GET only)

| Path | What |
|---|---|
| `/status` | census block, time, sweep kind, counts, discovery progress |
| `/coverage` | known wallets vs each protocol's on-chain totals (last full sweep) |
| `/stress` | current Ink Stress Level and its inputs (shares) |
| `/stress/history?from&to` | the level over time (full scans) |
| `/pressure?dir&sign&pct&material&dim` | aggregate scenario counts (1–4 suppressed) |
| `/wallets/{address}` | one wallet's classification and risk, as of the last census run |
| `/wallets/{address}/history?from&to` | its recorded changes (Flight Recorder) |
| `/wallets/{address}/scenario?dir&sign&pct` | **live:** the level it would reach under a move. No balances, and never the move that liquidates it. |
| `/oracles`, `/oracles/events` | Oracle Watch |
| `/changes?from&to` | protocol parameter changes |
| `/liquidations?from&to` | the Liquidation Ledger, newest first |
| `/cascades?from&to` | `cascade-1.0.0` groups |
| `/performance` | warnings vs real liquidations; Pressure forecasts vs recorded prices |
| `/carry` | Yield and Carry (analysis only) |
| `/verification` | automatic checks against the official sources |
| `/events?from&to&type` | the Ink-wide event feed (at most 30 days per request) |

Every list takes `limit` (1–100, default 50) and `cursor` (the previous response's `page.nextCursor`). A range spans at most 90 days.

## Response envelope

The schema is `phrourax-api-1`. Before public launch (2026-10-06) it was briefly `aegis-api-1`; it was renamed with the product while no one was using the API, so there's no compatibility period.

```json
{
  "schema": "phrourax-api-1",
  "data": {},
  "page": { "total": 120, "limit": 50, "returned": 50, "nextCursor": "eyJvIjo1MH0" },
  "meta": {
    "apiVersion": "api-1.0.0", "rulesVersion": "v1.2.0", "engineVersion": "…", "dataVersion": "oracle-1.0.0",
    "source": "history/oracle/latest.json (Oracle Watch)", "sourceBlock": 57725110, "sourceBlockHash": "0x…",
    "generatedAt": "…", "servedAt": "…", "ageSeconds": 1840,
    "freshness": "FRESH", "freshnessRule": "STALE when the source is more than 3 h old",
    "completeness": "COMPLETE", "completenessNotes": [], "approximate": false,
    "coverage": { "…": 0.99 }, "privacy": ["…"], "disclaimer": "Phrourax is read-only. …"
  }
}
```

- **Freshness:** each source has its own STALE threshold: census 2 h, oracles 3 h, carry 3 h, Pressure Map 6 h, checks 8 h. `UNKNOWN` means the source has no time.
- **`sourceBlockHash`:** given where the Flight Recorder recorded that block; `null` otherwise.
- **Coverage:** the shares of each protocol's own on-chain totals that Phrourax's known wallets add up to, from the last full sweep that read every wallet at one block.

## Errors

```json
{ "schema": "phrourax-api-1", "error": { "code": "INVALID_RANGE", "status": 400, "message": "a range can span at most 90 days", "details": { "maxDays": 90 } }, "disclaimer": "…" }
```

| Status | Codes |
|---|---|
| 400 | `BAD_REQUEST`, `INVALID_ADDRESS`, `INVALID_RANGE`, `INVALID_PARAMETER`, `FIXTURE_REJECTED` |
| 401 | `UNAUTHORIZED` |
| 404 | `NOT_FOUND`, `WALLET_NOT_IN_CENSUS` |
| 405 | `METHOD_NOT_ALLOWED` |
| 413 | `PAYLOAD_TOO_LARGE` |
| 429 | `RATE_LIMITED` |
| 503 | `UPSTREAM_UNAVAILABLE`, `NOT_ENABLED`, `NOT_RECORDED_YET` |

## Rate limits and caching

| Class | Limit (per client IP, per minute) |
|---|---|
| Aggregates | 120 |
| Single wallet | 30 |
| Live wallet scenario | 6 |
| Webhook management | 20 |

- **Headers:** every response carries `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Policy`. A 429 carries `Retry-After`.
- **Edge cache:** aggregate and wallet responses are cached for 60 s (`s-maxage=60`), so most requests never reach the function. The live scenario is `no-store`.
- **Limits are per function instance**, so on their own they're best effort. A global backstop runs at Vercel's edge, before the function: three Vercel Firewall rate-limit rules, per client IP per minute, answering 429 when exceeded.

  | Rule | Limit |
  |---|---|
  | live wallet scenario | 15 |
  | webhook management | 30 |
  | everything else under `/api/v1` | 300 |

  `scripts/firewall.mjs` creates or updates them through Vercel's REST API (safe to re-run). It edits the firewall draft, publishes it, then checks the rules are live. `--dry-run` shows the change and discards it. If the project already has unpublished firewall edits, it stops without changing anything. Run it with a short-lived token:

  ```
  $env:VERCEL_TOKEN="…"; pnpm firewall
  ```

  The rules only cover `/api/v1`; the site isn't affected. On Pro, rate-limit checks are billed by usage, which is negligible at current traffic. To remove them, delete the three "AEGIS API - …" rules under Vercel → Firewall.

## Privacy and abuse prevention

- There's **no endpoint that lists wallets** (no `/wallets`, `/near` or dump of `census.json`), and **no ranking by closeness to liquidation**. The ledger is time-ordered.
- **No exact figures:** no balances, health factors or liquidation prices in any response. The wallet endpoint gives the risk level, types, size range and venues. The live scenario gives a level, not a threshold.
- **Small-group privacy:** aggregate counts of 1–4 are returned as `null`.
- **Bounded input:** addresses, ranges, percentages, directions and size floors are validated; ranges and pages are bounded.
- **CORS:** `Access-Control-Allow-Origin: *` for GET and OPTIONS without credentials, since the API is public and read-only. Webhook management has no CORS (server-to-server only).
- **Wallet data comes from the published census**, cached for 60 s. The single live endpoint reads one validated address through ink-io, so no caller-supplied RPC call or URL ever reaches the chain or the network.

## Versioning and deprecation

- The path carries the major version.
- Within v1, fields are only added.
- Removing or renaming anything means `/api/v2`. v1 then keeps working for at least 90 days after a deprecation notice in `meta` and on `/developers`.
- Usage tiers can be introduced later without changing the envelope.

## Terms

Free and best effort, with no uptime promise. It's not advice, and the data can be late, incomplete or wrong. Phrourax cannot trade or move funds.

## Deployment

- **The function is a single file:** `apps/web/api/v1.js`, bundled by `apps/web/scripts/build-api.mjs` from `apps/web/api-src/`, with no workspace TypeScript left for Vercel to compile.
- **Stale-bundle guard:** `pnpm check` fails if the bundle wasn't built from the current sources. It compares a fingerprint of the inputs (Phrourax sources with line endings normalised, the lockfile, the esbuild version, the test-wallet list), stored in the bundle's first line, so it gives the same answer on Windows and Linux. To rebuild:

  ```
  pnpm --filter @aegis/web build:api
  ```
- **Routing:** `vercel.json` rewrites `/api/v1/*`, `/s/*` and `/og/*` to the function, before the site's own catch-all.
- **Environment (Vercel, all optional):**
  - `CENSUS_URL`: falls back to the site's existing `VITE_CENSUS_URL`.
  - `INK_RPC`: for the live endpoint; defaults to Ink's public RPCs.
- **Rollback:**
  - Delete `apps/web/api/` and the first rewrite in `vercel.json`, then push.
  - Or revert the commit. The site is unaffected either way.

## Share link and card (`/s/<address>`, `/og/<address>.png`)

Served by the same function, but not part of the versioned API: no envelope, no schema.

- **What they are:**
  - `/s/<address>` is a tiny page with Open Graph and Twitter tags. It forwards people to `/hull/<address>` straight away.
  - `/og/<address>.png` is a 1200×630 card for that wallet.
  - The wallet page's Share panel links to `/s/…`, never to `/hull/…`. robots.txt disallows `/hull/`, and X's crawler obeys robots.txt, so a `/hull/` link would post with no card.
- **What the card shows:** the shortened address, position types, the risk level with its sentence, which venues were read, and the block and time. It never shows balances, health factor or liquidation prices. The post text follows the same rule.
- **Bottom-left corner:** kept clear, because X draws the domain over it.
- **One read serves both:** a single live read per address feeds the page and the image. It is held in memory for 10 minutes; a failed read is retried after 60 s.
- **Caching:**

  | Response | Cache |
  |---|---|
  | Card | `s-maxage=3600, stale-while-revalidate=86400` |
  | Page | `s-maxage=600`, or 60 when the read failed |

  The page's `og:image` URL carries `?h=<hour>`, so feeds pick up a fresh card at most hourly.
- **Fallbacks:** an invalid address or a test wallet redirects to `/` (page) or `/og.png` (card). A read or render failure redirects the card to the site's own `/og.png`, so a share never shows a broken image.
- **Limits:** per IP per function instance: 60 pages and 30 cards a minute, then 429.
- **Crawling:** both paths send `X-Robots-Tag: noindex`. robots.txt leaves them crawlable on purpose, since link-preview bots must fetch them.
- **Rendering:**
  - SVG → PNG with `@resvg/resvg-js`, a native module kept outside the esbuild bundle and loaded only for cards.
  - IBM Plex fonts (OFL) ship from `apps/web/api-assets/fonts` via `includeFiles` in `vercel.json`.
  - A card takes about 50 ms.
- **After a deploy, check:**
  - `https://phrourax.com/og/<address>.png` shows the wallet's card. If it shows the generic site card, the native module or fonts didn't ship, and the function logs say which.
  - Pasting `https://phrourax.com/s/<address>` into X's compose box shows the card.
- **Deferred:** an X handle (`twitter:site`, "via @…") is added once the account exists.
