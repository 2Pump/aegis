/**
 * AEGIS alerts — one run (see packages/census/src/alerts/). Scheduled by .github/workflows/alerts.yml, which does
 * nothing until the repo variable ALERTS_ENABLED is 'true'.
 *
 *   pnpm alerts --check-env          # validate the environment only (prints problems, never secret values)
 *   pnpm alerts --store blob         # live: Telegram + encrypted db on Vercel Blob
 *   pnpm alerts --store file         # live Telegram, encrypted db in .alerts/alerts.sealed.json (local testing)
 *
 * Needs: TELEGRAM_BOT_TOKEN, ALERTS_STORE_KEY (+ BLOB_READ_WRITE_TOKEN for blob). Optional: INK_RPC, ALERTS_SITE_URL.
 * Read-only on the chain. Sends Telegram messages to people who asked for them; nothing else.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INK_PUBLIC_RPCS, makeInkClient, splitRpcList } from '@aegis/ink-io';
import { emptyDb, runAlerts } from '@aegis/census/alerts';
import { ORACLE_LATEST, changesPath, paramLabel, type ChangesFile, type OracleWatch } from '@aegis/census';
import { blobAlertsStore, blobStore, chatHasher, checkAlertsEnv, fileAlertsStore, fileStore, fixtureAddresses, makeAlertsReader, parseStoreKey, telegramTransport } from '@aegis/census/node';

const args = process.argv.slice(2);
const flag = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');

async function main() {
  const storeKind = flag('--store') === 'blob' ? 'blob' : 'file';
  const env = checkAlertsEnv(process.env, { store: storeKind });
  if (!env.ok) {
    console.error(`alerts: not configured — nothing was run:\n  - ${env.problems.join('\n  - ')}`);
    process.exit(2);
  }
  if (args.includes('--check-env')) {
    console.log('alerts: environment OK');
    return;
  }
  const key = parseStoreKey(process.env.ALERTS_STORE_KEY);
  const store = storeKind === 'blob' ? await blobAlertsStore(key) : fileAlertsStore(join(root, '.alerts/alerts.sealed.json'), key);
  // a db that exists but can't be read stops the run — never silently replaced by an empty one
  const db = (await store.load()) ?? emptyDb(Date.now());
  const census = await (storeKind === 'blob' ? await blobStore() : fileStore(join(root, 'apps/web/public/census'))).get('census.json').catch(() => null);
  const given = splitRpcList(process.env.INK_RPC || process.env.VITE_INK_RPC);
  const client = makeInkClient(given.length ? given : [...INK_PUBLIC_RPCS]);
  const t0 = Date.now();
  const { db: next, report } = await runAlerts(db, {
    transport: telegramTransport({ token: process.env.TELEGRAM_BOT_TOKEN!.trim() }),
    protocolEvents: await protocolEvents(storeKind),
    read: makeAlertsReader(client, census),
    now: () => Date.now(),
    fixtures: fixtureAddresses(root),
    siteUrl: process.env.ALERTS_SITE_URL?.trim() || 'https://aegis-web-lake.vercel.app',
    hashChat: chatHasher(key),
    log: (m) => console.log(`[alerts +${Math.round((Date.now() - t0) / 1000)}s] ${m}`),
  });
  await store.save(next);
  // counts only — never chat ids, never addresses
  console.log(`alerts: chats ${Object.keys(next.chats).length} · commands ${report.commands} · reads ${report.reads} (${report.unreadable} unreadable) · sent ${report.sent} · held ${report.held} · cooled ${report.cooled} · failed ${report.failed} · retried ${report.retried} · erased ${report.erasedChats}`);
  for (const n of report.notes) console.log(`  note: ${n}`);
  if (report.failed) process.exitCode = 1;
}

/** Ink-wide events from the last day: Oracle Watch events and protocol parameter changes (balance-free). */
async function protocolEvents(kind: 'blob' | 'file') {
  const cs = kind === 'blob' ? await blobStore() : fileStore(join(root, 'apps/web/public/census'));
  const since = Date.now() - 86_400_000;
  const out: Array<{ id: string; at: number; text: string; urgent?: boolean }> = [];
  const w = (await cs.get(ORACLE_LATEST).catch(() => null)) as OracleWatch | null;
  for (const e of w?.kind === 'aegis-oracle-watch' ? w.events : []) {
    if (e.at < since) continue;
    out.push({ id: `oracle:${e.id}`, at: e.at, text: `Oracle ${e.status === 'RESOLVED' ? 'resolved' : e.status}: ${e.text}`, urgent: e.status === 'DEPEG' || e.status === 'INVALID' });
  }
  const m = new Date().toISOString().slice(0, 7);
  const c = (await cs.get(changesPath(m)).catch(() => null)) as ChangesFile | null;
  for (const r of c?.kind === 'aegis-changes' ? c.records : []) {
    if (r.between.toAt < since) continue;
    out.push({ id: `change:${r.id}`, at: r.between.toAt, text: `${r.protocol === 'tydro' ? 'Tydro' : 'Nado'} parameter ${r.kind}: ${r.subject} · ${paramLabel(r.name)}: ${r.old ?? '—'} → ${r.new ?? '—'}` });
  }
  return out;
}

main().catch((e: unknown) => {
  console.error(String(e).replace(process.env.TELEGRAM_BOT_TOKEN ?? '\u0000', '<token>'));
  process.exit(1);
});
