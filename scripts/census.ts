/**
 * Phrourax census — find every wallet that has used Tydro or Nado, read them from the Ink chain, classify, publish.
 *
 *   pnpm census                              # local: writes apps/web/public/census/{census,known}.json
 *   pnpm census --since-blocks 200000        # quick local test: only wallets active in the last ~2.3 days
 *   pnpm census --full                       # re-read everyone (every 3 hours happens automatically)
 *   pnpm census --store blob                 # GitHub Action: publish to Vercel Blob (needs BLOB_READ_WRITE_TOKEN)
 *   pnpm census --rpc https://…              # custom Ink RPC (or env INK_RPC); several = comma-separated, rotated
 *                                            # default: all of Ink's public RPCs, rotated (a throttled one is rested)
 *   pnpm census --budget-min 40              # save progress and stop after N minutes (resumes next run)
 *
 * Read-only. No keys that can move funds. Every row in the output came from a real chain read.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  INK_DEFAULT_RPC,
  INK_PUBLIC_RPCS,
  NADO_CONTRACTS,
  checkInkEndpoints,
  makeInkClient,
  maskRpc,
  splitRpcList,
  type RotateStats,
  nadoSubaccount,
  parseAddress,
  readBooksMany,
  readNadoChain,
  readTydro,
} from '@aegis/ink-io';
import { classify } from '@aegis/pose';
import { blobStore, fileStore, fixtureAddresses, runCensus } from '@aegis/census/node';

const args = process.argv.slice(2);
const flag = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (k: string) => args.includes(k);
const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');

/** --probe 0xADDR: read one wallet through the census's bulk path AND the single-call path, print everything. */
async function probe(rpc: string, raw: string) {
  const pa = parseAddress(raw);
  if (!pa.ok) throw new Error(pa.error.message);
  const a = pa.value.lower;
  const client = makeInkClient(rpc);
  const block = await client.getBlockNumber();
  console.log(`PROBE ${pa.value.checksum} at block ${block}\n`);

  console.log('1) bulk path (what the census uses):');
  const res = await readBooksMany(client, { addresses: [a], blockNumber: block });
  const book = res.books.get(a)!;
  console.log(`   TYDRO ${book.tydro.status}${book.tydro.status === 'DARK' ? ` — ${book.tydro.code}: ${book.tydro.message}` : ` · hf ${book.tydro.data.hf ?? '∞'} · ${book.tydro.data.supplies.length} supply / ${book.tydro.data.debts.length} debt legs`}`);
  console.log(`   NADO  ${book.nado.status}${book.nado.status === 'DARK' ? ` — ${book.nado.code}: ${book.nado.message}` : ` · ${book.nado.data.spots.length} spot / ${book.nado.data.perps.length} perp legs`}`);
  console.log(`   subaccounts active ${res.activeSubs.size} · empty ${res.emptySubs.size}`);
  const pose = classify(book);
  console.log(`   pose ${pose.tags.join(' + ') || 'NO RULE'} · hull ${pose.hullTemp}\n`);

  console.log('2) single-call path (what the hull page uses):');
  const t = await readTydro(client, a);
  console.log(`   TYDRO ${t.ok ? `OK · hf ${t.value.book.hf ?? '∞'}` : `DARK — ${t.error.code}: ${t.error.message}`}`);
  const n = await readNadoChain(client, a, block);
  console.log(`   NADO  ${n.ok ? `OK · ${n.value.book.spots.length} spot / ${n.value.book.perps.length} perp legs` : `DARK — ${n.error.code}: ${n.error.message}`}`);
  const sub = nadoSubaccount(a);
  const ghAbi = [{ type: 'function', name: 'getHealth', stateMutability: 'view', inputs: [{ name: 's', type: 'bytes32' }, { name: 't', type: 'uint8' }], outputs: [{ type: 'int128' }] }] as const;
  for (const ht of [1, 2] as const) {
    try {
      const v = await client.readContract({ address: NADO_CONTRACTS.clearinghouse, abi: ghAbi, functionName: 'getHealth', args: [sub, ht], blockNumber: block });
      console.log(`   Clearinghouse.getHealth(default, ${ht === 1 ? 'MAINTENANCE' : 'PNL'}) = ${Number(v) / 1e18}`);
    } catch (e) {
      console.log(`   Clearinghouse.getHealth(default, ${ht}) FAILED — ${(e as Error).message.split('\n').slice(0, 3).join(' | ')}`);
    }
  }
}

async function main() {
  if (flag('--probe')) {
    const rpc0 = flag('--rpc') || process.env.INK_RPC || process.env.VITE_INK_RPC || INK_DEFAULT_RPC;
    await probe(rpc0, flag('--probe')!);
    return;
  }
  const given = splitRpcList(flag('--rpc') || process.env.INK_RPC || process.env.VITE_INK_RPC);
  const candidates = given.length ? given : [...INK_PUBLIC_RPCS];
  const storeKind = flag('--store') ?? 'file';
  const store = storeKind === 'blob' ? await blobStore() : fileStore(flag('--dir') ?? join(root, 'apps/web/public/census'));
  const started = Date.now();
  const log = (m: string) => console.log(`[census +${Math.round((Date.now() - started) / 1000)}s] ${m}`);

  // keep only endpoints that answer AND report chain 57073 — never mix chains
  let rpcs = candidates;
  if (candidates.length > 1) {
    const checks = await checkInkEndpoints(candidates);
    // a node far behind the others could silently return too few history logs — leave it out
    const top = Math.max(0, ...checks.map((c) => c.head ?? 0));
    for (const c of checks) if (c.ok && c.head !== null && top - c.head > 30) Object.assign(c, { ok: false, why: `${top - c.head} blocks behind the others` });
    for (const c of checks) log(`rpc ${maskRpc(c.url)} · ${c.ok ? 'ok' : 'SKIPPED'} (${c.why})`);
    rpcs = checks.filter((c) => c.ok).map((c) => c.url);
    if (!rpcs.length) throw new Error('none of the Ink RPC endpoints answered as chain 57073');
  }
  const stats: RotateStats = { ok: [], skipped: [] };
  log(`rpc ${rpcs.length > 1 ? `${rpcs.length} endpoints, rotating` : maskRpc(rpcs[0]!)} · store ${store.describe}`);
  const snap = await runCensus({
    client: makeInkClient(rpcs, { stats }),
    store,
    full: has('--full'),
    // every 3 hours (since 2026-10-04; was weekly, then 8 h): healthy Nado traders are carried between sweeps, and price alone can move them
    fullIfOlderThanMs: 3 * 3600_000,
    budgetMs: Number(flag('--budget-min') ?? 40) * 60_000,
    sinceBlocks: flag('--since-blocks') ? Number(flag('--since-blocks')) : undefined,
    // several nodes can be a few blocks apart: stay a little further behind the tip so every node has every block we scan
    confirmations: rpcs.length > 1 ? 12 : 2,
    // the Flight Recorder never records Phrourax's synthetic test wallets
    exclude: fixtureAddresses(root),
    log,
  });
  log(`mix ${Object.entries(snap.mix).map(([k, v]) => `${k}:${v}`).join(' ')}`);
  if (rpcs.length > 1) log(`rpc use: ${rpcs.map((u, i) => `${new URL(u).hostname} ${stats.ok[i] ?? 0} ok / ${stats.skipped[i] ?? 0} throttled`).join(' · ')}`);
  if (!snap.discovery.backfillComplete) log('NOTE: discovery backfill not complete yet — run again to continue');
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? (e as Error & { shortMessage?: string }).shortMessage ?? e.message.split('\n')[0] : String(e);
  const status = (e as { status?: number })?.status;
  console.error(`[census] FAILED: ${msg}${status ? ` (HTTP ${status})` : ''}`);
  if (/HTTP request failed|fetch failed|ECONN|403|429/i.test(`${msg} ${status ?? ''}`)) {
    console.error('[census] The Ink RPC could not be reached. Check your internet, or pass --rpc <url> / set INK_RPC to another Ink endpoint.');
  }
  if (process.env.CENSUS_DEBUG) console.error(e);
  process.exit(1);
});
