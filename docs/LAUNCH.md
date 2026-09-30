# LAUNCH — must be done before AEGIS goes public

Deferred on 2026-09-29, to come back to before launch. Nothing here changes what the site shows; it changes how the data reaches many viewers at once.

## Why

The census job costs the same however many people visit, because it runs once an hour. What grows with users is each visitor's browser:

| Piece | Per visitor today | What breaks |
|---|---|---|
| `census.json` on Vercel Blob | ~250 KB on page load, then again every 5 min while the tab stays open. The URL carries a per-minute cache-bust, so there are many cache misses. | **Hobby plan:** 10 GB Blob transfer and 10,000 simple operations a month are included. Past either, Blob is **blocked for 30 days** and the well goes dark. That's roughly 40k page loads a month. |
| Live layer (`LiveEngine`) | each open tab polls the public Ink RPC every ~4 s and re-reads at-risk ships every ~15 s | hundreds of tabs → the public RPC operators throttle or block the site's traffic |
| Hull pages | one on-chain read of that wallet, plus Nado's gateway direct from the browser | fine for Nado (the load spreads across visitors); Ink reads share the public RPC |

## The plan

1. **One watcher, many viewers.** A small always-on server process runs the live chain watch once. Every few seconds it publishes a tiny "what changed" file (or a server-sent event stream), and every browser reads that same file from the CDN. RPC load then stays flat whatever the user count.
2. **Cache-friendly census publishing.** Publish each snapshot under a block-numbered name (`census-<block>.json`), cached permanently, plus a tiny `latest.json` pointer with a short cache. Drop the per-minute cache-bust in `apps/web/src/lib/census.ts`.
3. **RPC for hull pages.** A paid Ink RPC whose key only works from the site's domain, or a small cached relay on Vercel. `VITE_INK_RPC` is public, so the key must be domain-restricted.
4. **Vercel Pro ($20/month) and spend alerts.** Hobby is for personal, non-commercial use and blocks rather than bills. Pro bills overage, and spend management can warn or pause.

**Expected cost after 1–4:** roughly $30–60/month fixed (Vercel Pro, a small server, an RPC plan), plus cheap CDN transfer, plus GitHub Actions (~$7–12/month on Pro, independent of users).

## Also before launch

- Verification: both venues proven in `verification/status.json`, so the PREVIEW banner goes (see VERIFICATION.md).
- Coverage: Nado open interest coverage explained or closed (see CENSUS.md, "Why Nado was at ~46%").
- Renew-by dates: the cron-job.org GitHub token expiry, and the `X-GitHub-Api-Version: 2022-11-28` header (sunset 10 March 2028).
