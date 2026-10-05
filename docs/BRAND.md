# BRAND — PHROURAX

Renamed from AEGIS on 2026-10-05 by the project owner. The product, rules, data and behaviour are unchanged; only the name, the domain and the wording moved.

| | |
|---|---|
| Name (wordmark, titles, all-caps labels) | **PHROURAX** |
| In sentences | Phrourax |
| Domain | https://phrourax.com |
| Category | On-chain risk intelligence |
| Tagline | See risk before it moves. |
| Positioning | Built for the Ink ecosystem, initially covering Tydro and Nado. |
| What it is | A read-only view of positions, liquidation pressure, oracle conditions, protocol changes, and on-chain risk across Tydro and Nado. |
| Safety | Phrourax never connects to a wallet, requests private keys, signs transactions, or moves funds. |
| Disclaimer (footer, alerts, API, webhooks) | Phrourax is read-only. It never connects to your wallet and cannot move funds. Classifications may be incomplete or incorrect. Not financial advice. |
| Origin (only where it fits) | A modern name inspired by the Ancient Greek "phroura", relating to watching, guarding, or vigilant observation. |

**One source of truth:** `packages/glyphs/src/brand.ts` (`BRAND`). The site header, error page, footer, share text, Pressure Map share text, Telegram alerts, the API's `meta.disclaimer`, the OpenAPI title and the webhook disclaimer all read from it. Change the wording there, not in each place.

**Tone:** direct and factual. No claims that it prevents losses, no guaranteed predictions; simulations stay labelled as simulations.

## The mark

An aperture: an outer ring, a hexagonal opening and six blade edges. It watches and never touches. It is abstract (no letter), so it carried over from AEGIS unchanged. It deliberately isn't a target or crosshair; the site lists wallets near liquidation and is "not a hit list".

- **One colour:** the mark always uses the current text colour, so it follows the palette (see COLOURS.md).
- **Under the wordmark:** `TYDRO · NADO · INK 57073`. "The Well" stays as the name of the main view (sphere / 2D / list).
- **Tab title:** `PHROURAX · Tydro · Nado · Ink`.

## Where it lives

| Use | File |
|---|---|
| Site header, error page | `apps/web/src/components/Mark.tsx` (`<Mark size={28} />`) |
| Browser tab | `apps/web/public/favicon.svg` (modern browsers) and `favicon.ico` (16/32/48, for older ones) |
| Phone home screen | `apple-touch-icon.png` (180), `icon-192.png`, `icon-512.png`, `site.webmanifest` |
| Link previews (X, Telegram, Discord…) | `og.png` (1200×630, PHROURAX wordmark + tagline); `og:image` / `twitter:image` in `apps/web/index.html` point at `https://phrourax.com/og.png` |
| Search engines | `robots.txt` (keeps `/hull/` out, declares the sitemap), `sitemap.xml` (the public pages only — no wallet pages, no queries). `index.html` carries `https://phrourax.com/` as canonical; the shell sets each page's own canonical and `og:url` (path only) as you navigate. |

## Small-size rule

At 16 px the full mark turns to mush. So the tab icon is a dark disc with thicker strokes (3 instead of 2) and a slightly smaller opening. The bigger icons (180 / 512) use the full mark on a rounded dark tile.

## Regenerating

`docs/brand/gen-icons.py` writes the SVGs, and `docs/brand/og.html` is the share card (it needs the IBM Plex Mono 400/500/600 woff2 files in `docs/brand/fonts/`). The PNGs are rendered with headless Chromium at 1200×630, and the .ico was built with ImageMagick (`convert favicon-16.png favicon-32.png favicon-48.png favicon.ico`). Regenerate them if the colours change: the tile is `#05080C`, the ink `#CFD9E3`.

## Legacy identifiers (intentionally still `aegis`)

These are data contracts and infrastructure names, not branding. None of them is shown to people using the site. Renaming any of them would break stored data, saved preferences, the published API or the build — so they stay, and new code keeps using them.

| Identifier | Where | Why it stays |
|---|---|---|
| `@aegis/pose`, `@aegis/ink-io`, `@aegis/glyphs`, `@aegis/census`, `@aegis/web`; root package `aegis` | package names, imports, `pnpm --filter` commands, `vercel.json` build command | Workspace wiring; renaming touches every import and the Vercel build command for no visible gain. |
| Data `kind`s: `aegis-history-agg`, `aegis-history-index`, `aegis-history-wallets`, `aegis-oracle-watch`, `aegis-changes`, `aegis-params`, `aegis-prices`, `aegis-forecasts`, `aegis-forecast-score`, `aegis-liquidations`, `aegis-warnings`, `aegis-accountability`, `aegis-carry`, `aegis-carry-days`, … | files the hourly census writes to Vercel Blob, and the readers that check them | Every file already published carries these values, and the readers reject a file whose `kind` doesn't match. |
| API schema `aegis-api-1` | every `/api/v1` response | Public API contract. Changing it needs a new version (`/api/v2`), per API.md. |
| Webhook payload schema `aegis-webhook-1`, headers `AEGIS-Signature`, `AEGIS-Delivery`, `AEGIS-Event`, user agent `AEGIS-Webhooks/<version>` | `webhooks-1.0.0` | Part of the signed webhook contract receivers verify. Change only with a new webhooks version. |
| Ledger field `record.aegis` (`before`, `nearSince`, `watchSince`, `evaluable`, `why`) and verification field `aegis` | ledger and verification records, API `/liquidations`, `/verification` | Field names in historical records and the API. |
| Text inside historical records (e.g. a parameter change's `txNote`, a ledger record's `unavailable` / `why`, a check's `source` or `failureReason`) | records written before 2026-10-05 | Historical records are never rewritten. Every published JSON file the site reads (history, intel, ledger, checks, Pressure Map) goes through `readJson()` (`apps/web/src/lib/brandJson.ts`), which shows legacy wording as PHROURAX / Phrourax: only string values, only the whole words `AEGIS` and `Aegis` — never keys, never lowercase identifiers. The API returns records as recorded. |
| Browser storage: `aegis-my-wallet` (localStorage), `aegis.recent.v1` (localStorage), `aegis-stale-reload-at` (sessionStorage) | `apps/web/src/lib/myWallet.ts`, `recent.ts`, `staleBuild.ts` | Keeps visitors' saved "My wallet" and recent addresses. Never shown. |
| Blob paths and cache/temp prefixes (`census/…`, `aegis-census-…`, `aegis-*` temp dirs), alerts store kind | census, alerts, webhooks stores | Existing stored objects and running jobs depend on them. |
| Vercel Firewall rule names `AEGIS API - live wallet scenario`, `AEGIS API - webhook management`, `AEGIS API - read endpoints` | Vercel → aegis-web → Firewall; `scripts/firewall.mjs` | The script finds its rules by these names to update them instead of adding duplicates. Visible only in the Vercel dashboard. |
| Repository `2Pump/aegis`, Vercel project `aegis-web`, `aegis-web-lake.vercel.app` | infrastructure | Not renamed unless the owner asks. The old Vercel address keeps serving the same deployment. |
| Comment `// aegis-api-inputs:` | first line of `apps/web/api/v1.js` | The stale-bundle guard reads it. |
