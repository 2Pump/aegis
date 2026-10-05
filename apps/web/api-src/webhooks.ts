/**
 * Webhook management inside the API function — OFF unless the Vercel project has WEBHOOKS_ENABLED=1, a 32-byte
 * WEBHOOKS_STORE_KEY and BLOB_READ_WRITE_TOKEN. Off = every /webhooks call answers 503 NOT_ENABLED.
 */
import type { WebhookHandler } from '@aegis/census/api';
import { makeWebhookApi } from '@aegis/census/webhooks';
import { blobWebhookStore, parseStoreKey } from '@aegis/census/node';

declare const __FIXTURES__: string[];

export function makeWebhookHandler(): WebhookHandler | null {
  if (process.env.WEBHOOKS_ENABLED !== '1' || !process.env.WEBHOOKS_STORE_KEY || !process.env.BLOB_READ_WRITE_TOKEN) return null;
  let key: Buffer;
  try {
    key = parseStoreKey(process.env.WEBHOOKS_STORE_KEY);
  } catch {
    return null; // misconfigured key: stay off rather than half-on
  }
  const store = blobWebhookStore(key);
  let api: WebhookHandler | null = null;
  return async (req, sub) => {
    api ??= makeWebhookApi({ store: await store, now: () => Date.now(), fixtures: new Set(__FIXTURES__) });
    return api(req, sub);
  };
}
