/**
 * Nado market depth — one run (packages/census/src/depth.ts). Runs after the alerts job every ~10 minutes
 * (.github/workflows/alerts.yml, its own step: a depth failure never touches alerts).
 *
 *   pnpm depth --store blob     # GitHub Action: Vercel Blob (private store when CENSUS_BLOB_TOKEN is set)
 *   pnpm depth                  # local: apps/web/public/census/depth/…
 *   pnpm depth --rpc https://…  # custom Ink RPC (or env INK_RPC)
 *
 * Read-only: one view call (FQuerier) and one plain GET per perp to Nado's official API. When Nado refuses, the
 * refusal is recorded as such; nothing is retried through another route. Exits 0 even when every book is refused:
 * a refusal is a finding, not a broken job.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INK_PUBLIC_RPCS, fetchNadoBook, makeInkClient, readNadoPerpRefs, splitRpcList } from '@aegis/ink-io';
import { DEPTH, DEPTH_STATUS_PATH, appendRun, dayOf, depthDayPath, runLine, summarizeBook, updateStatus, type DepthRun } from '@aegis/census';
import { blobStore, fileStore } from '@aegis/census/node';

const args = process.argv.slice(2);
const flag = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const given = splitRpcList(flag('--rpc') || process.env.INK_RPC || process.env.VITE_INK_RPC);
  const client = makeInkClient(given.length ? given : [...INK_PUBLIC_RPCS]);
  const store = flag('--store') === 'blob' ? await blobStore() : fileStore(flag('--dir') ?? join(root, 'apps/web/public/census'));
  const at = new Date().toISOString();

  const refs = await readNadoPerpRefs(client);
  if (!refs.ok) {
    console.error(`depth: couldn't read Nado's markets on-chain — nothing recorded: ${refs.error.message}`);
    process.exitCode = 1;
    return;
  }
  const run: DepthRun = { at, block: refs.value.block, asked: refs.value.perps.length, answered: 0, refused: 0, failed: 0, reason: null, markets: [] };
  const fetchWithTimeout = (url: string) => fetch(url, { signal: AbortSignal.timeout(10_000) });
  for (const m of refs.value.perps) {
    const got = await fetchNadoBook(fetchWithTimeout, m.productId, DEPTH.LEVELS);
    if (got.ok) {
      run.answered++;
      run.markets.push(summarizeBook({ productId: m.productId, symbol: m.symbol, oracle: m.oracle, sizeIncrement: m.sizeIncrement, bids: got.book.bids, asks: got.book.asks }));
    } else {
      if (got.refused) run.refused++;
      else run.failed++;
      run.reason ??= `${m.symbol}: ${got.reason}`;
      // a Cloudflare refusal for one book is a refusal for all of them — stop asking rather than hammer it
      if (got.refused && run.answered === 0 && run.refused >= 3) {
        run.refused += refs.value.perps.length - (run.answered + run.refused + run.failed);
        break;
      }
    }
    await sleep(DEPTH.GAP_MS);
  }

  const dayPath = depthDayPath(dayOf(at));
  await store.put(dayPath, appendRun(await store.get(dayPath), run));
  await store.put(DEPTH_STATUS_PATH, updateStatus(await store.get(DEPTH_STATUS_PATH), run));
  console.log(runLine(run));
  const wide = [...run.markets].sort((a, b) => (b.spreadBps ?? 0) - (a.spreadBps ?? 0)).slice(0, 3);
  if (wide.length) console.log(`depth: widest spreads — ${wide.map((m) => `${m.s} ${m.spreadBps ?? '—'} bps`).join(' · ')}`);
  console.log(`depth: saved to ${store.describe} ${dayPath}`);
}

main().catch((e) => {
  console.error(`depth: ${String(e).slice(0, 300)}`);
  process.exitCode = 1;
});
