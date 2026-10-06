# Webhooks (`webhooks-1.0.0`): built and tested, OFF

Webhooks are signed HTTPS POSTs of Phrourax events to an endpoint you control. They use the **same transition engine as Telegram alerts** for wallet events (`alerts/engine.ts`) and the **same Ink-wide event feed** (`events.ts`).

**They are not switched on.** Until the owner does it (see the last section), every `/api/v1/webhooks` call answers `503 NOT_ENABLED` and the delivery workflow skips itself.

## Events

| Type | From |
|---|---|
| `wallet.risk_changed`, `wallet.classification_changed`, `wallet.data_stale`, `wallet.report_partial`, `wallet.unreadable` | the alerts transition engine (hysteresis, dedup) for the wallets the endpoint watches (max 10) |
| `wallet.liquidated` | the Liquidation Ledger, for watched wallets |
| `oracle.divergence`, `oracle.depeg`, `oracle.stale`, `oracle.jump`, `oracle.invalid`, `oracle.resolved` | Oracle Watch (cooldowns and hysteresis at the source) |
| `protocol.parameter_changed` | Protocol Change Monitor |
| `stress.level_changed` | Ink Stress Level between two full scans |
| `cascade.detected` | `cascade-1.0.0` grouping of the ledger |
| `verification.failed` | an automatic check that FAILED |
| `webhook.verification`, `webhook.test` | system events |

The Pressure state is covered by `stress.level_changed`. Test wallets (fixtures) are refused at subscription and never delivered.

## Payload (`phrourax-webhook-1`): balance-free by schema

```json
{
  "schema": "phrourax-webhook-1", "version": "webhooks-1.0.0",
  "deliveryId": "dlv_…", "sentAt": "2026-10-05T18:05:11.000Z",
  "event": { "id": "oracle|…", "type": "oracle.depeg", "at": "…", "block": 57725110, "subject": "USDe",
             "text": "USDe: Tydro: $0.9750 (−2.50% from $1)", "data": { "symbol": "USDe", "status": "DEPEG", "…": "…" } },
  "disclaimer": "Phrourax is read-only. It never connects to your wallet and cannot move funds. Classifications may be incomplete or incorrect. Not financial advice."
}
```

- `data` holds only flat strings, numbers, booleans and nulls: levels, types, size ranges, parameter values.
- It never holds a balance, a health factor or a price at which anyone is liquidated. A test checks this.

## Headers

| Header | |
|---|---|
| `Phrourax-Signature` | `t=<unix seconds>,v1=<hex>` — HMAC-SHA256 with your secret over `` `${t}.${rawBody}` ``. During a secret rotation there's one `v1` per live secret. |
| `Phrourax-Delivery` | unique per delivery attempt chain: dedupe on it |
| `Phrourax-Event` | the event type |

The header names and schema were renamed from `AEGIS-…` / `aegis-webhook-1` on 2026-10-06, before webhooks were ever switched on, so no receiver used the old names.
| `Idempotency-Key` | the event id; every retry of one event carries the same key |

### Verifying (receiver)

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';
function verify(secret: string, header: string, rawBody: string, nowMs = Date.now()): boolean {
  const parts = header.split(',').map((p) => p.trim().split('='));
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  if (!Number.isInteger(t) || Math.abs(nowMs / 1000 - t) > 300) return false; // replay window: 5 minutes
  const want = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  return parts.filter(([k]) => k === 'v1').some(([, v]) => { const got = Buffer.from(v ?? '', 'hex'); return got.length === want.length && timingSafeEqual(got, want); });
}
```

Replay protection takes two steps on the receiver: reject timestamps outside 5 minutes, and remember `Phrourax-Delivery` ids for at least that long.

## Delivery

- **Verification first:**
  - A new endpoint gets one `webhook.verification` event. It must answer 2xx with `data.challenge` somewhere in the response body.
  - Nothing else is sent until it does.
  - Events from before verification are never sent (no backlog).
- **Retries** happen on network errors, timeouts, 408, 425, 429 and 5xx. The waits are 1 min, 5 min, 30 min, 2 h, then 6 h (6 attempts in all), and the body and idempotency key stay the same each time.
- **Final failures:** any other 4xx, and a 3xx because redirects aren't followed, is final.
- **Dead letters:**
  - A delivery that never succeeds goes to the dead-letter list. It's kept (last 200) and visible through the management API.
  - After 20 dead letters in a row, the endpoint is **paused automatically**, with the reason given.
- **Rate limit:** at most 30 deliveries per endpoint per minute. The rest wait in the queue.
- **Delivery log:** the last 200 attempts per endpoint, with time, status, latency and error.

## SSRF protection

- **Accepted URLs:** `https` only, port 443, no user:password, a public host name (no IP literal, no `localhost`, `.local` or `.internal`), and at most 500 characters.
- **Address check at connect time:** every address the name resolves to is checked when the connection opens (a custom DNS lookup). A private, loopback, link-local, CGNAT, ULA, multicast or metadata (`169.254.169.254`) answer is refused, which also stops **DNS rebinding**.
- **Limits:** no redirects followed, a 5 s timeout, and responses read up to 4 KB.

## Management (`/api/v1/webhooks`, server-to-server, no CORS)

```
POST   /api/v1/webhooks              {"url": "https://…", "events": ["oracle.depeg", "wallet.risk_changed"], "wallets": ["0x…"]}
       → 201 {id, secret (whsec_…), token (whtok_…)} — both shown ONCE
GET    /api/v1/webhooks/{id}         Authorization: Bearer whtok_…  → status, secret ids, queue, dead letters, recent deliveries
PATCH  /api/v1/webhooks/{id}         {"status": "paused" | "active", "events": […], "wallets": […]}
DELETE /api/v1/webhooks/{id}
POST   /api/v1/webhooks/{id}/rotate  → {secret}; the old secret keeps signing for 24 h
POST   /api/v1/webhooks/{id}/test    → a webhook.test delivery on the next run
```

- A wrong token and an unknown id get the same 401, so ids can't be probed.
- The token is stored only as a SHA-256 hash.

## Storage and secrets

- **Store:** one AES-256-GCM sealed object per subscription in Vercel Blob, named from an HMAC of its id, so the bucket listing reveals neither ids nor URLs.
- **Key:** `WEBHOOKS_STORE_KEY`, 32 bytes base64. It lives only in Vercel's and GitHub's secret settings.
- **Signing secrets** are stored sealed, because they're needed to sign.
- **Logs** carry counts only: never URLs, secrets or addresses.

## Turning it on (owner's decision)

1. Generate a key:
   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```
2. **Vercel** → Settings → Environment Variables:
   - `WEBHOOKS_STORE_KEY` = that key
   - `WEBHOOKS_ENABLED` = `1`
   - `BLOB_READ_WRITE_TOKEN` (the census token)
3. **GitHub** → Settings → Secrets → Actions: `WEBHOOKS_STORE_KEY` = **the same key**.
4. **GitHub** → Variables: `WEBHOOKS_ENABLED` = `true`.
5. Redeploy. Then create a webhook against an endpoint you own, watch it verify, and send a test.

To turn it off again, remove `WEBHOOKS_ENABLED` from both places.

Deleting the `webhooks/` folder in Blob erases every subscription. A lost key makes them unreadable, and nothing is silently recreated.

## Known limitations

- Delivery runs every 10 minutes, so it isn't instant.
- Limits are per run and per function instance.
- A pause made during a delivery run is honoured at the end of that run.
