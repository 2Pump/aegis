/**
 * Webhook management inside the API function — OFF unless the Vercel project has WEBHOOKS_ENABLED=1, a 32-byte
 * WEBHOOKS_STORE_KEY and BLOB_READ_WRITE_TOKEN. Off = every /webhooks call answers 503 NOT_ENABLED.
 *
 * Desk only (docs/WEBHOOKS.md): creating a webhook needs a Desk API key (Authorization: Bearer phx_…) or a signed-in
 * Desk session; each account may have WEBHOOK_MAX. Managing one afterwards uses its own token (whtok_…), as before.
 * When the creating account's plan ends, the daily cron (/api/v1/cron/webhooks) pauses its webhooks; renewing and
 * PATCHing {status: "active"} restarts them.
 */
import type { ApiRequest, WebhookHandler } from '@aegis/census/api';
import { makeWebhookApi, type WebhookOwners } from '@aegis/census/webhooks';
import { bearerKey, apiUnlocked } from '@aegis/census/accounts';
import { blobWebhookStore, parseStoreKey } from '@aegis/census/node';
import type { AccountsRuntime } from './accounts';

declare const __FIXTURES__: string[];

export const WEBHOOK_MAX = 5;
const ownedKey = (uid: string) => `wh:u:${uid}`;
const OWNERS = 'wh:owners';

export interface WebhooksRuntime {
  handler: WebhookHandler | null;
  /** daily: pause webhooks whose account is no longer on Desk. Returns counts. */
  pauseEnded: () => Promise<{ owners: number; paused: number }>;
}

export function makeWebhooks(accounts: AccountsRuntime): WebhooksRuntime {
  const off: WebhooksRuntime = { handler: null, pauseEnded: async () => ({ owners: 0, paused: 0 }) };
  if (process.env.WEBHOOKS_ENABLED !== '1' || !process.env.WEBHOOKS_STORE_KEY || !process.env.BLOB_READ_WRITE_TOKEN) return off;
  if (accounts.paywall && !accounts.kv) return off; // Desk-only needs the accounts store
  let key: Buffer;
  try {
    key = parseStoreKey(process.env.WEBHOOKS_STORE_KEY);
  } catch {
    return off; // misconfigured key: stay off rather than half-on
  }
  const store = blobWebhookStore(key);
  const kv = accounts.kv;
  const owners: WebhookOwners | undefined = kv
    ? {
        max: WEBHOOK_MAX,
        async authorize(req: ApiRequest) {
          const k = bearerKey(req.headers.authorization ?? req.headers.Authorization);
          const who = k ? await accounts.byKey(k) : await accounts.sessionOf(typeof req.headers.cookie === 'string' ? req.headers.cookie : undefined);
          if (!who) return { ok: false, code: 'UNAUTHORIZED', message: k ? 'unknown or revoked API key' : 'creating a webhook needs a Desk API key (Authorization: Bearer phx_…)' };
          if (!apiUnlocked(who.access)) return { ok: false, code: 'PAYMENT_REQUIRED', message: 'webhooks come with the Desk plan' };
          return { ok: true, owner: who.uid };
        },
        active: async (uid) => apiUnlocked(await accounts.accessOf(uid)),
        count: async (uid) => (await kv.smembers(ownedKey(uid))).length,
        add: async (uid, id) => {
          await kv.sadd(ownedKey(uid), id);
          await kv.sadd(OWNERS, uid);
        },
        remove: async (uid, id) => kv.srem(ownedKey(uid), id),
      }
    : undefined;
  let api: WebhookHandler | null = null;
  return {
    handler: async (req, sub) => {
      api ??= makeWebhookApi({ store: await store, now: () => Date.now(), fixtures: new Set(__FIXTURES__), owners });
      return api(req, sub);
    },
    pauseEnded: async () => {
      if (!kv) return { owners: 0, paused: 0 };
      const s = await store;
      const uids = await kv.smembers(OWNERS);
      let paused = 0;
      for (const uid of uids) {
        const ids = await kv.smembers(ownedKey(uid));
        if (!ids.length) {
          await kv.srem(OWNERS, uid);
          continue;
        }
        if (apiUnlocked(await accounts.accessOf(uid))) continue;
        for (const id of ids) {
          const w = await s.get(id);
          if (!w) {
            await kv.srem(ownedKey(uid), id);
            continue;
          }
          if (w.status === 'paused') continue;
          await s.put({ ...w, status: 'paused', pausedReason: 'the Desk plan on the account that created it has ended — renew, then PATCH {"status":"active"}' });
          paused++;
        }
      }
      return { owners: uids.length, paused };
    },
  };
}
