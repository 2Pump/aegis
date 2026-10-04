# Alerts (Telegram) — `alerts-1.0.0`

**Status: built and tested, NOT LIVE.** The owner approved Telegram alerts on 2026-10-04 (it was a Phase 3 item held
until Phases 1–2 shipped). The `/watch` page says "NOT LIVE YET" and offers no bot link and no sign-up until the steps
below are done and a real message has been received end to end.

AEGIS stays a camera: alerts read the chain (view calls) and send a Telegram message to someone who asked. No keys, no
wallet connection, no approvals, no orders.

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
`/start` `/watch <addr> [tydro|nado]` `/unwatch <addr>` `/list` `/pause` `/resume` `/status [addr]`
`/hf <addr> <1.0–5|off>` `/buffer <addr> <1–90|off>` `/scenario <addr> <DIR> <±pct|off>` `/help` `/delete`

Nothing is stored before `/start`. Private chats only (groups are ignored). Rejected: malformed addresses, the zero
address, AEGIS's fixture wallets. Limits: 10 wallets per chat, 500 chats, 300 wallet reads per run (oldest-checked first).

## Architecture
```
packages/census/src/alerts/   pure domain: model · observe · engine (transitions, dedup, rate) · format · commands · transport (interface + TestTransport) · run
packages/census/src/node/     telegram.ts (Bot API adapter) · alerts-store.ts (AES-256-GCM sealed store: memory/file/blob) · alerts-env.ts · alerts-read.ts
scripts/alerts.ts             one run: validate env → load db → poll commands → read wallets → send → save
.github/workflows/alerts.yml  every 10 min, SKIPPED unless repo variable ALERTS_ENABLED == 'true'
```
**Persistence:** one encrypted object on Vercel Blob (`alerts/<hash-of-key>.sealed.json`). Chat ids never sit in the
clear; the audit log names chats by a keyed hash. A store that exists but can't be decrypted stops the run — it is never
silently replaced by an empty one. A chat that blocks the bot is erased. `/delete` erases immediately. One run at a
time (workflow concurrency group).

**Latency:** a scheduled batch, not a live stream — command replies and alerts can take ~10 min (more if GitHub's
scheduler lags; cron-job.org can dispatch the workflow like the census). The page and `/help` say so.

## Environment variables (server only — never `VITE_`, never in the repo)
| Name | Where | What |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | GitHub secret | from @BotFather; validated, scrubbed from every error |
| `ALERTS_STORE_KEY` | GitHub secret | 32 random bytes, base64 — losing it loses the db |
| `BLOB_READ_WRITE_TOKEN` | GitHub secret (exists) | same store as the census |
| `INK_RPC` | GitHub secret (optional, exists) | |
| `ALERTS_SITE_URL` | optional | link base, default https://aegis-web-lake.vercel.app |
| `ALERTS_ENABLED` | GitHub **variable** | `true` switches the workflow on |
| `VITE_ALERTS_BOT` | Vercel env | bot username; set ONLY after the end-to-end test — it flips the page to live |

## Turning it on
1. @BotFather → `/newbot` → copy the token. (`/setprivacy` doesn't matter: only private chats are served.)
2. Key: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` — store it in a password manager too.
3. GitHub → Settings → Secrets → Actions: `TELEGRAM_BOT_TOKEN`, `ALERTS_STORE_KEY`.
4. Locally (optional): `pnpm alerts --check-env` with those set → "environment OK".
5. GitHub → Variables: `ALERTS_ENABLED = true`. Actions → alerts → Run workflow.
6. Message the bot `/start`, `/watch <your address>`, run the workflow again, check the replies.
7. Only then: Vercel → Environment Variables → `VITE_ALERTS_BOT = <botname>` → redeploy. The page goes live.

Off switch: set `ALERTS_ENABLED` to anything else. Nothing else changes.

## Tests
`packages/census/test/alerts.test.ts` (35): addresses/fixtures, every transition and hysteresis, venue filter,
dedup/cooldown/rate limit, message content (no balances, footer verbatim), observe() on fixtures, every command,
end-to-end runs with the test adapter (baseline → alert → recovery, one read per wallet, blocked chat erased,
retry/give-up, unreadable, paused, held), encryption/tamper/wrong key, env validation, Telegram adapter on fake HTTP
(private chats only, 429 retry, 403 blocked, token never in errors).
