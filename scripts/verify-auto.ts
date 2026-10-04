/**
 * Automatic verification — see packages/census/src/node/verify-run.ts.
 *
 *   pnpm verify:auto                 # local: reads apps/web/public/census/census.json, writes verification-log.json next to it
 *   pnpm verify:auto --store blob    # GitHub Action (every 4 h): Vercel Blob (needs BLOB_READ_WRITE_TOKEN)
 *   pnpm verify:auto --rpc https://… # custom Ink RPC (or env INK_RPC); several = comma-separated, rotated
 *   pnpm verify:auto --store blob --if-due   # only if the last automatic check is ≥ ~4 h old (the hourly census calls this)
 *
 * Read-only: view calls and one GET to Nado's public API. Exits 1 when a check FAILED (the record is still written),
 * so the scheduled run shows red. SOURCE UNAVAILABLE does not fail the run — it is recorded and shown as such.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INK_PUBLIC_RPCS, makeInkClient, splitRpcList } from '@aegis/ink-io';
import { blobStore, fileStore, runVerification } from '@aegis/census/node';
import { VERIFY, verifyDue } from '@aegis/census';

const args = process.argv.slice(2);
const flag = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');

async function main() {
  const given = splitRpcList(flag('--rpc') || process.env.INK_RPC || process.env.VITE_INK_RPC);
  const rpcs = given.length ? given : [...INK_PUBLIC_RPCS];
  const store = flag('--store') === 'blob' ? await blobStore() : fileStore(flag('--dir') ?? join(root, 'apps/web/public/census'));
  if (args.includes('--if-due')) {
    // a quarter hour of slack, so an hourly caller lands on ~every 4 h instead of drifting to 5
    const d = verifyDue(await store.get('verification-log.json'), Date.now(), VERIFY.EVERY_HOURS - 0.25);
    console.log(`verify: ${d.why}${d.due ? ' — running' : ''}`);
    if (!d.due) return;
  }
  const t0 = Date.now();
  const recs = await runVerification({
    client: makeInkClient(rpcs),
    store,
    log: (m) => console.log(`[verify +${Math.round((Date.now() - t0) / 1000)}s] ${m}`),
  });
  for (const r of recs) {
    console.log(`${r.status.padEnd(18)} ${r.venue.padEnd(5)} ${r.case} · ${r.wallet} · ${r.sourceType} · block ${r.block ?? '—'}${r.failureReason ? ` · ${r.failureReason}` : ''}`);
    for (const f of r.fields) console.log(`   ${f.pass === null ? 'n/a ' : f.pass ? 'ok  ' : 'FAIL'} ${f.label}: AEGIS ${f.aegis} · source ${f.expected} (±${f.tolerance}${f.unit === 'rel' ? ' rel' : ''})`);
  }
  if (recs.some((r) => r.status === 'FAIL')) process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
