/**
 * Phrourax alerts — one run (see packages/census/src/alerts/). Scheduled by .github/workflows/alerts.yml, which does
 * nothing until the repo variable ALERTS_ENABLED is 'true'.
 *
 *   pnpm alerts --check-env          # validate the environment only (prints problems, never secret values)
 *   pnpm alerts --store blob         # live: Telegram + encrypted db on Vercel Blob
 *   pnpm alerts --store file         # live Telegram, encrypted db in .alerts/alerts.sealed.json (local testing)
 *
 * Needs: TELEGRAM_BOT_TOKEN, ALERTS_STORE_KEY (+ BLOB_READ_WRITE_TOKEN for blob). Optional: INK_RPC, ALERTS_SITE_URL.
 * Read-only on the chain. Sends Telegram messages to people who asked for them; nothing else.
 *
 * Who is watched comes from the site (GET /api/v1/alerts/feed — linked Pro/Desk accounts only); bot messages go to the
 * site's webhook, which this run keeps registered with Telegram. After the run, last-known levels go back to the site
 * (POST /api/v1/alerts/report). Both calls carry a token derived from the bot token, which both sides hold.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INK_PUBLIC_RPCS, makeInkClient, splitRpcList } from '@aegis/ink-io';
import { COMMANDS, emptyDb, isAlertsFeed, runLinkedAlerts, type AlertsFeed } from '@aegis/census/alerts';
import { alertsFeedToken, alertsFeedUrl, alertsHookSecret, alertsHookUrl, alertsReportUrl } from '@aegis/census/accounts';
import { paramLabel } from '@aegis/census';
import { blobAlertsStore, blobStore, chatHasher, checkAlertsEnv, ensureTelegramSetup, fileAlertsStore, fileStore, fixtureAddresses, loadFeed, makeAlertsReader, parseStoreKey, telegramTransport } from '@aegis/census/node';

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
  const token = process.env.TELEGRAM_BOT_TOKEN!.trim();
  const site = (process.env.ALERTS_SITE_URL?.trim() || 'https://phrourax.com').replace(/\/+$/, '');
  const scrub = (s: string) => s.split(token).join('<token>');

  // 1 ── keep the bot pointed at the site (bot commands are answered there, instantly)
  try {
    const note = await ensureTelegramSetup({ token, hookUrl: alertsHookUrl(site), hookSecret: alertsHookSecret(token), commands: BOT_MENU });
    console.log(`alerts: telegram — ${note}`);
  } catch (e) {
    console.error(`alerts: couldn't set up the Telegram webhook: ${scrub(String(e))}`);
    process.exitCode = 1;
  }

  // 2 ── who to watch, from the site
  const feed = await getFeed(site, token);
  if (!feed) {
    process.exitCode = 1;
    return;
  }

  // 3 ── the run (state in the runner's own encrypted store)
  const key = parseStoreKey(process.env.ALERTS_STORE_KEY);
  const store = storeKind === 'blob' ? await blobAlertsStore(key) : fileAlertsStore(join(root, '.alerts/alerts.sealed.json'), key);
  // a db that exists but can't be read stops the run — never silently replaced by an empty one
  const db = (await store.load()) ?? emptyDb(Date.now());
  const census = await (storeKind === 'blob' ? await blobStore() : fileStore(join(root, 'apps/web/public/census'))).get('census.json').catch(() => null);
  const given = splitRpcList(process.env.INK_RPC || process.env.VITE_INK_RPC);
  const client = makeInkClient(given.length ? given : [...INK_PUBLIC_RPCS]);
  const t0 = Date.now();
  const { db: next, report, siteReport, endedTold } = await runLinkedAlerts(db, feed, {
    transport: telegramTransport({ token }),
    ...(await feedFor(storeKind)),
    read: makeAlertsReader(client, census),
    now: () => Date.now(),
    fixtures: fixtureAddresses(root),
    siteUrl: site,
    hashChat: chatHasher(key),
    log: (m) => console.log(`[alerts +${Math.round((Date.now() - t0) / 1000)}s] ${m}`),
  });
  await store.save(next);

  // 4 ── last-known levels back to the site (the Alerts page and /status show them)
  const posted = await fetch(alertsReportUrl(site), { method: 'POST', headers: { authorization: `Bearer ${alertsFeedToken(token)}`, 'content-type': 'application/json' }, body: JSON.stringify(siteReport) }).catch((e: unknown) => ({ ok: false, status: 0, e }));
  if (!posted.ok) console.error(`alerts: couldn't post the report to the site (HTTP ${posted.status}) — levels on the Alerts page will lag one run`);

  // counts only — never chat ids, never addresses
  console.log(`alerts: linked accounts ${feed.accounts.length} (${feed.accounts.filter((a) => !a.active).length} plan ended, ${endedTold} told) · chats ${Object.keys(next.chats).length} · reads ${report.reads} (${report.unreadable} unreadable) · sent ${report.sent} · held ${report.held} · cooled ${report.cooled} · failed ${report.failed} · retried ${report.retried} · blocked ${siteReport.blocked.length}`);
  for (const n of report.notes) console.log(`  note: ${n}`);
  if (report.failed) process.exitCode = 1;
}

/** The bot's command menu in Telegram (the "/" button). */
const BOT_MENU = [
  { command: 'status', description: 'last known state of your wallets' },
  { command: 'list', description: 'what you watch' },
  { command: 'watch', description: '<address> [tydro|nado] — watch a wallet' },
  { command: 'unwatch', description: '<address> — stop watching it' },
  { command: 'hf', description: '<address> <1.0–5|off> — Tydro HF line' },
  { command: 'buffer', description: '<address> <1–90|off> — Nado buffer line (%)' },
  { command: 'scenario', description: '<address> <DIR> <±pct|off> — scenario line' },
  { command: 'protocol', description: '<on|off> — Ink-wide events' },
  { command: 'pause', description: 'hold your alerts' },
  { command: 'resume', description: 'restart your alerts' },
  { command: 'help', description: 'all commands' },
  { command: 'delete', description: 'unlink this chat' },
].filter((c) => (COMMANDS as readonly string[]).includes(c.command));

async function getFeed(site: string, token: string): Promise<AlertsFeed | null> {
  let r: Response;
  try {
    r = await fetch(alertsFeedUrl(site), { headers: { authorization: `Bearer ${alertsFeedToken(token)}` } });
  } catch (e) {
    console.error(`alerts: couldn't reach ${site} for the watch list: ${String(e).slice(0, 160)}`);
    return null;
  }
  const j = (await r.json().catch(() => null)) as unknown;
  if (r.status === 503) {
    console.error(`alerts: the site says alerts are off — add TELEGRAM_BOT_TOKEN to Vercel (the same value as this GitHub secret) and redeploy`);
    return null;
  }
  if (r.status === 401) {
    console.error(`alerts: the site refused the runner — TELEGRAM_BOT_TOKEN in Vercel and in GitHub must be the same value`);
    return null;
  }
  if (!r.ok || !isAlertsFeed(j)) {
    console.error(`alerts: the watch list from the site was not usable (HTTP ${r.status})`);
    return null;
  }
  return j;
}

/** The canonical Ink-wide feed (events.ts) from the last day + recent ledger records — balance-free. */
const LABEL: Record<string, string> = {
  'oracle.divergence': 'Oracle divergence',
  'oracle.depeg': 'Stablecoin depeg',
  'oracle.stale': 'Oracle stale',
  'oracle.jump': 'Price jump',
  'oracle.invalid': 'Oracle invalid',
  'oracle.resolved': 'Oracle resolved',
  'protocol.parameter_changed': 'Parameter change',
  'stress.level_changed': 'Ink Stress Level',
  'cascade.detected': 'Liquidation cascade',
  'verification.failed': 'Check failed',
};
async function feedFor(kind: 'blob' | 'file') {
  const cs = kind === 'blob' ? await blobStore() : fileStore(join(root, 'apps/web/public/census'));
  const { ink, liq } = await loadFeed(cs, Date.now() - 86_400_000);
  return {
    protocolEvents: ink.map((e) => ({ id: e.id, at: e.at, text: `${LABEL[e.type] ?? e.type}: ${e.type === 'protocol.parameter_changed' ? `${e.data.protocol === 'tydro' ? 'Tydro' : 'Nado'} ${e.data.subject} · ${paramLabel(String(e.data.parameter))}: ${e.data.old ?? '—'} → ${e.data.new ?? '—'}` : e.text}`, urgent: e.urgent })),
    liquidations: liq.filter((r) => r.at >= Date.now() - 86_400_000),
  };
}

main().catch((e: unknown) => {
  console.error(String(e).replace(process.env.TELEGRAM_BOT_TOKEN ?? '\u0000', '<token>'));
  process.exit(1);
});
