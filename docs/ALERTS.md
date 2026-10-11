# Alerts (Telegram) — `alerts-1.0.0`, linked to accounts

**Status: built and tested; switched on by the owner in the steps below.** Alerts are a paid feature: **Pro watches
10 wallets, Desk 100** (complimentary accounts count as Desk). Until `ALERTS_LIVE=1` is set in Vercel, only the
complimentary (owner) accounts see the Alerts page working — everyone else sees COMING SOON. That is the end-to-end
test window.

Phrourax stays read-only: alerts read the chain (view calls) and send a Telegram message to someone who asked. No keys, no
wallet connection, no approvals, no orders.

## How it fits together

```
phrourax.com (Vercel function)                         GitHub Actions, every 10 min (scripts/alerts.ts)
──────────────────────────────                         ────────────────────────────────────────────────
/watch page: Connect Telegram, wallets and lines       1. keeps the bot's webhook pointed at phrourax.com
POST /telegram/hook — the bot's messages, answered     2. GET  /api/v1/alerts/feed   → linked paid accounts
   at once (/start <code>, /watch, /hf, …)             3. reads every watched wallet once → evaluate → send
accounts store (Upstash): wallets + sealed chat id     4. POST /api/v1/alerts/report → last-known levels
```

- **Linking:** the Alerts page asks for a one-time code (10 min, used once) and opens `t.me/<bot>?start=<code>`.
  Telegram sends `/start <code>` to the webhook, which links that chat to the account and answers "Linked" at once.
  One chat ↔ one account: linking a chat to a new account unlinks it from the old one.
- **Who owns what:** the site owns *who* is watched (account, plan, wallets, lines, chat). The runner owns *how each
  watch is doing* (alert state, cooldowns, rate limits, outbox) in its own encrypted store. Neither writes the other's.
- **Plan ends:** the feed marks the account inactive; the runner sends one "alerts paused — renew" message and stops.
  Wallets are kept. A downgrade from Desk to Pro keeps the first 10 checked; the rest show NOT CHECKED.
- **Blocked bot / deleted chat:** the runner reports it; the site unlinks the account.
- **Runner ↔ site auth:** `Authorization: Bearer sha256("phx-alerts-feed:" + bot token)`. Telegram → site:
  `X-Telegram-Bot-Api-Secret-Token = sha256("phx-alerts-hook:" + bot token)`, set by the runner with `setWebhook`.
  Both sides already hold the bot token, so there is no extra secret to copy.

## What fires (transitions only, never every run)

| Alert | When | Noise control |
|---|---|---|
| Risk level up | SAFE → WATCH → NEAR → LIQUIDATABLE | immediate; NEAR/LIQ are urgent (skip cooldown and hourly cap) |
| Recovery | a lower level | must be seen on 2 runs in a row (hysteresis); the least-recovered level seen is announced |
| Your HF line | Tydro HF crosses below your number | re-arms only above number + 0.05 |
| Your buffer line | worst Nado subaccount buffer crosses below your % | re-arms only above % + 2 points |
| Your scenario | "if ETH fell 20%" would liquidate it (scenario engine `pressure-1.0.0`) | fires on change, clears on change |
| Classification | primary type changed | cooldown |
| Unreadable | a venue unreadable 2 runs in a row; and when readable again | once each |
| Stale | chain data older than 30 min | said once; never shown as current |
| Partial | Nado isolated subaccounts may be missing | said once |

Every alert goes through the same readers (`readBook`, every known Nado subaccount), classification and scenario
engine as the site. First reading of a new watch is a baseline — no news unless it is already NEAR/LIQ.

**Dedup/cooldown:** same chat + wallet + kind + level not repeated within 60 min. **Rate limit:** 6 messages per chat
per rolling hour; beyond that alerts are *held*, counted, audited and mentioned in the next message (urgent ones always
go). Several alerts for one wallet in one run become one message.

**Messages** carry: wallet (short + link to its page), what changed, risk level, Tydro HF / worst Nado buffer, data
age and block, APPROXIMATE / PARTIAL labels, rules / engine / alerts versions, and the footer. **Never balances or
position sizes.**

## Commands
In the bot (answered at once): `/status [addr]` `/list` `/watch <addr> [tydro|nado]` `/unwatch <addr>` `/hf <addr> <1.0–5|off>`
`/buffer <addr> <1–90|off>` `/scenario <addr> <DIR> <±pct|off>` `/protocol on|off` `/pause` `/resume` `/help`
`/delete` (unlinks the chat; wallets stay on the account). The same settings are on the /watch page.

`/protocol on` also sends the Ink-wide event feed (`events-1.0.0`, `packages/census/src/events.ts` — the same feed webhooks and `/api/v1/events` use):
- oracle problems (divergence, depeg, stale, jump, invalid, resolved);
- Tydro and Nado parameter changes;
- Ink Stress Level changes;
- liquidation cascades;
- failed automatic checks.

They're sent from the moment it's turned on, once each, inside the same rate limit. Off by default.

**Actual liquidations** of a watched wallet, from the Liquidation Ledger, are always sent, marked urgent, once each, and only for liquidations after the watch was set. The message gives the size as a range and never a balance.

Nothing about a chat is stored before it is linked from a paid account. Private chats only (groups are ignored).
Rejected: malformed addresses, the zero address, Phrourax's fixture wallets. Limits: Pro 10 / Desk 100 wallets, 300
wallet reads per run (oldest-checked first; the rest wait for the next run), 20 bot messages per chat per minute.

## Architecture
```
packages/census/src/alerts/          pure domain: model · observe · engine (transitions, dedup, rate) · format · commands · run
                                     linked.ts — plan limits, watch editing rules, feed/report types, mergeFeed, runLinkedAlerts
packages/census/src/accounts/alerts.ts  the site: /alerts/* (page, feed, report) and /telegram/hook (bot); sealed chat ids
packages/census/src/node/            telegram.ts (send + ensureTelegramSetup) · alerts-store.ts (AES-256-GCM runner store)
apps/web/src/pages/Alerts.tsx        the /watch page (also /alerts)
scripts/alerts.ts                    one run: webhook → feed → read wallets → send → save → report
.github/workflows/alerts.yml         every 10 min, SKIPPED unless repo variable ALERTS_ENABLED == 'true'
```
**Storage.** Site (Upstash): `alerts:u:<account>` = wallets, lines, pause, protocol, and the chat id sealed with
AES-256-GCM (key derived from AUTH_SECRET); `alerts:chat:<keyed hash>` → account; `alerts:linked` (set);
`alerts:code:<sha256>` (10 min); `alerts:report` (last-known levels). Runner: one encrypted object on Vercel Blob
(`alerts/<hash-of-key>.sealed.json`). A runner store that exists but can't be decrypted stops the run — it is never
silently replaced. Store use: ~3 commands per run for the feed + 1 for the report (≈600/day), plus a few per bot
message or page edit.

**Latency:** bot replies are instant; alerts are a scheduled batch (~10 min, more if GitHub's scheduler lags). The page
and `/help` say so.

## Environment variables (server only — never `VITE_`, never in the repo)
| Name | Where | What |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | **Vercel** env AND **GitHub** secret — same value | from @BotFather; never logged, scrubbed from errors |
| `ALERTS_STORE_KEY` | GitHub secret | 32 random bytes, base64 — encrypts the runner's store; losing it resets alert history |
| `BLOB_READ_WRITE_TOKEN` | GitHub secret (exists) | the runner's store |
| `INK_RPC` | GitHub secret (optional, exists) | |
| `ALERTS_SITE_URL` | optional | default https://phrourax.com |
| `ALERTS_ENABLED` | GitHub **variable** | `true` switches the runner on |
| `ALERTS_LIVE` | Vercel env | `1` opens alerts to every paying account (before: owner only). Redeploy after changing |

`VITE_ALERTS_BOT` is no longer used (the site asks Telegram for the bot's name).

## Turning it on
1. @BotFather → `/newbot` → name "Phrourax Alerts", username **PhrouraxBot** → keep the token in that chat.
2. Vercel → aegis-web → Settings → Environment Variables → `TELEGRAM_BOT_TOKEN` (all environments) → redeploy.
3. GitHub → Settings → Secrets and variables → Actions → Secrets: `TELEGRAM_BOT_TOKEN` (same value), `ALERTS_STORE_KEY`.
4. GitHub → Variables: `ALERTS_ENABLED = true`. Actions → alerts → Run workflow → the log says "webhook set (first time)".
5. Signed in as the owner: /watch → Connect Telegram → Open Telegram → START → "Linked". Add a wallet; run the workflow
   again; `/status` shows its level.
6. When happy: Vercel → `ALERTS_LIVE = 1` → redeploy. The nav loses SOON, Pricing says INCLUDED.

Off switch: `ALERTS_ENABLED` to anything else (no alerts sent), and/or remove `ALERTS_LIVE` (page back to COMING SOON
for everyone but the owner). Nothing else changes.

## Tests
`packages/census/test/alerts-linked.test.ts` (10): visibility (off / owner / live), one-time links, sealed chat ids, hook secret,
groups ignored, plan limits (Pro 10, Desk 100), bot and site edit the same account, feed/report auth, plan end, blocked
chats unlinked, one chat ↔ one account, runner merge and end-to-end runs. e2e: Connect → linked → wallets → lines → pause;
no-plan page.

`packages/census/test/alerts.test.ts` (35): addresses/fixtures, every transition and hysteresis, venue filter,
dedup/cooldown/rate limit, message content (no balances, footer verbatim), observe() on fixtures, every command,
end-to-end runs with the test adapter (baseline → alert → recovery, one read per wallet, blocked chat erased,
retry/give-up, unreadable, paused, held), encryption/tamper/wrong key, env validation, Telegram adapter on fake HTTP
(private chats only, 429 retry, 403 blocked, token never in errors).
