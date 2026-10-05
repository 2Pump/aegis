/**
 * Phrourax webhooks — one delivery run (see packages/census/src/webhooks/). Scheduled by .github/workflows/webhooks.yml,
 * which does nothing until the repo variable WEBHOOKS_ENABLED is 'true'.
 *
 *   pnpm webhooks --check-env     # validate the environment only (prints problems, never secret values)
 *   pnpm webhooks                 # one run: queue new events, deliver what's due, retry, dead-letter
 *
 * Needs: WEBHOOKS_STORE_KEY (32 random bytes, base64 — the SAME value as in Vercel), BLOB_READ_WRITE_TOKEN.
 * Optional: INK_RPC. Read-only on the chain; sends signed HTTPS POSTs only to endpoints that passed verification.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INK_PUBLIC_RPCS, makeInkClient, splitRpcList } from '@aegis/ink-io';
import { blobStore, blobWebhookStore, fixtureAddresses, httpsSender, makeAlertsReader, parseStoreKey, runWebhooks } from '@aegis/census/node';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');

async function main() {
  const problems: string[] = [];
  let key: Buffer | null = null;
  try {
    key = parseStoreKey(process.env.WEBHOOKS_STORE_KEY);
  } catch (e) {
    problems.push(String(e instanceof Error ? e.message : e).replace('ALERTS_STORE_KEY', 'WEBHOOKS_STORE_KEY'));
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN) problems.push('BLOB_READ_WRITE_TOKEN is not set');
  if (problems.length) {
    console.error(`webhooks: not configured — nothing was run:\n  - ${problems.join('\n  - ')}`);
    process.exit(2);
  }
  if (process.argv.includes('--check-env')) return console.log('webhooks: environment OK');
  const census = await blobStore();
  const snap = await census.get('census.json').catch(() => null);
  const given = splitRpcList(process.env.INK_RPC);
  const client = makeInkClient(given.length ? given : [...INK_PUBLIC_RPCS]);
  const reader = makeAlertsReader(client, snap);
  const t0 = Date.now();
  await runWebhooks({
    store: await blobWebhookStore(key!),
    census,
    send: httpsSender,
    now: () => Date.now(),
    read: (a) => reader(a, []),
    fixtures: fixtureAddresses(root),
    // counts only — never URLs, secrets or addresses
    log: (m) => console.log(`[webhooks +${Math.round((Date.now() - t0) / 1000)}s] ${m}`),
  });
}

main().catch((e) => {
  console.error(`webhooks: run failed: ${String(e instanceof Error ? e.message : e).slice(0, 300)}`);
  process.exit(1);
});
