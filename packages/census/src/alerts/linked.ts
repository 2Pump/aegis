/**
 * ALERTS — linked to accounts (pure; no IO). Release 2 of alerts: only paying accounts get alerts.
 *
 *   phrourax.com (Vercel)                       GitHub Actions, every 10 min (scripts/alerts.ts)
 *   ─────────────────────                       ────────────────────────────────────────────────
 *   Alerts page: Connect Telegram, wallets      GET  /api/v1/alerts/feed    who to watch, for whom, on which plan
 *   Telegram webhook: /start <code>, commands   read every watched wallet once → evaluate → send
 *   (instant replies)                           POST /api/v1/alerts/report  last-known level per watch, last run
 *
 * The site owns WHO is watched (accounts, plans, watches — in the accounts store). The runner owns HOW each watch is
 * doing (alert state, rate limits, outbox — in its own encrypted store). Neither writes the other's data.
 */
import { directionById, DIRECTIONS } from '@aegis/pose';
import { runAlerts, type RunDeps, type RunReport } from './run.js';
import { ALERTS, checkWatchAddress, type AlertLevel, type AlertsDb, type Chat, type Watch, type WatchVenue } from './model.js';

export const ALERTS_FEED_SCHEMA = 'phrourax-alerts-feed-1';

/** wallets each plan may watch */
export const ALERT_LIMITS = { free: 0, pro: 10, desk: 100 } as const;
export type AlertAccess = keyof typeof ALERT_LIMITS;
export const alertLimit = (a: AlertAccess): number => ALERT_LIMITS[a] ?? 0;

/** What the site stores per account (key alerts:u:<userId>). The chat id is sealed (never in the clear in the store). */
export interface AlertsAccount {
  v: 1;
  /** sealed Telegram chat id, or null when no chat is linked */
  chat: string | null;
  linkedAt: number | null;
  paused: boolean;
  protocol: boolean;
  protocolSince: number | null;
  watches: Watch[];
}
export const emptyAlertsAccount = (): AlertsAccount => ({ v: 1, chat: null, linkedAt: null, paused: false, protocol: false, protocolSince: null, watches: [] });

export function parseAlertsAccount(raw: string | null): AlertsAccount {
  if (!raw) return emptyAlertsAccount();
  try {
    const a = JSON.parse(raw) as AlertsAccount;
    if (a && a.v === 1 && Array.isArray(a.watches)) return { ...emptyAlertsAccount(), ...a };
  } catch {
    /* below */
  }
  return emptyAlertsAccount();
}

/** One linked account, as the runner sees it. `active` false = the plan ended (alerts stop; told once). */
export interface FeedEntry {
  /** the account id (opaque) — the report is keyed by it */
  account: string;
  chatId: string;
  active: boolean;
  limit: number;
  paused: boolean;
  protocol: boolean;
  protocolSince: number | null;
  /** at most `limit` (a downgrade keeps the oldest ones) */
  watches: Watch[];
}
export interface AlertsFeed {
  schema: typeof ALERTS_FEED_SCHEMA;
  at: number;
  site: string;
  accounts: FeedEntry[];
}

/** What the runner sends back after a run (stored as one key; shown on the Alerts page and by /status). */
export interface AlertsReport {
  at: number;
  ok: boolean;
  note: string;
  /** account → wallet → last-known level and when it was read */
  accounts: Record<string, Record<string, { level: AlertLevel | null; checkedAt: number | null }>>;
  /** accounts whose chat blocked the bot (or was deleted): the site unlinks them */
  blocked: string[];
}

/* ───────────────────────── editing watches (site + bot share these rules) ───────────────────────── */

export interface WatchInput {
  address?: unknown;
  venue?: unknown;
  /** number (1.0–5], or null to switch off */
  hfBelow?: unknown;
  /** percent 1–90, or null to switch off */
  bufferPct?: unknown;
  /** {direction, pct} or null */
  scenario?: unknown;
}

export type EditResult = { ok: true; account: AlertsAccount; message: string } | { ok: false; message: string };

const num = (x: unknown): number | null => (typeof x === 'number' ? x : typeof x === 'string' && x.trim() !== '' ? Number(x.replace('%', '')) : NaN);

/**
 * Add a wallet, or change one already watched. Only the fields given are changed. Limits come from the plan.
 */
export function upsertWatch(acct: AlertsAccount, input: WatchInput, o: { limit: number; fixtures: ReadonlySet<string>; now: number }): EditResult {
  const chk = checkWatchAddress(String(input.address ?? ''), o.fixtures);
  if (!chk.ok) return { ok: false, message: chk.why };
  const a = chk.address;
  const existing = acct.watches.find((w) => w.address === a);
  if (!existing && acct.watches.length >= o.limit)
    return { ok: false, message: o.limit === 0 ? 'Alerts need a Pro or Desk plan.' : `Your plan watches up to ${o.limit} wallets. Remove one first.` };
  const w: Watch = existing ? { ...existing } : { address: a, venue: 'any', hfBelow: null, bufferBelow: null, scenario: null, createdAt: o.now };

  if (input.venue !== undefined) {
    const v = String(input.venue).toLowerCase();
    if (!['any', 'tydro', 'nado'].includes(v)) return { ok: false, message: 'Venue must be tydro, nado or any.' };
    w.venue = v as WatchVenue;
  }
  if (input.hfBelow !== undefined) {
    if (input.hfBelow === null || input.hfBelow === 'off' || input.hfBelow === '') w.hfBelow = null;
    else {
      const v = num(input.hfBelow);
      if (v === null || !Number.isFinite(v) || v <= ALERTS.HF_MIN || v > ALERTS.HF_MAX) return { ok: false, message: `HF line must be above ${ALERTS.HF_MIN} and at most ${ALERTS.HF_MAX} (e.g. 1.2).` };
      w.hfBelow = Math.round(v * 100) / 100;
    }
  }
  if (input.bufferPct !== undefined) {
    if (input.bufferPct === null || input.bufferPct === 'off' || input.bufferPct === '') w.bufferBelow = null;
    else {
      const v = num(input.bufferPct);
      if (v === null || !Number.isFinite(v) || v < ALERTS.BUFFER_MIN_PCT || v > ALERTS.BUFFER_MAX_PCT) return { ok: false, message: `Buffer line must be ${ALERTS.BUFFER_MIN_PCT}–${ALERTS.BUFFER_MAX_PCT} (percent).` };
      w.bufferBelow = Math.round(v * 10) / 1000;
    }
  }
  if (input.scenario !== undefined) {
    if (input.scenario === null || input.scenario === 'off') w.scenario = null;
    else {
      const s = input.scenario as { direction?: unknown; pct?: unknown };
      const d = directionById(String(s?.direction ?? '').toUpperCase());
      if (!d) return { ok: false, message: `Scenario direction must be one of ${DIRECTIONS.map((x) => x.id).join(', ')}.` };
      const pct = num(s.pct);
      if (pct === null || !Number.isInteger(pct) || pct === 0 || Math.abs(pct) > ALERTS.SCENARIO_MAX_PCT) return { ok: false, message: `Scenario move must be a whole percent between -${ALERTS.SCENARIO_MAX_PCT} and +${ALERTS.SCENARIO_MAX_PCT}, not 0.` };
      if (d.downOnly && pct > 0) return { ok: false, message: `${d.label} only goes down — use a negative move.` };
      w.scenario = { direction: d.id, pct };
    }
  }
  const watches = existing ? acct.watches.map((x) => (x.address === a ? w : x)) : [...acct.watches, w];
  return { ok: true, account: { ...acct, watches }, message: existing ? 'Updated.' : 'Watching.' };
}

export function removeWatch(acct: AlertsAccount, address: unknown): EditResult {
  const a = String(address ?? '').trim().toLowerCase();
  if (!acct.watches.some((w) => w.address === a)) return { ok: false, message: 'Not watching that wallet.' };
  return { ok: true, account: { ...acct, watches: acct.watches.filter((w) => w.address !== a) }, message: 'Stopped watching.' };
}

/* ───────────────────────── the runner side ───────────────────────── */

export function isAlertsFeed(x: unknown): x is AlertsFeed {
  const f = x as AlertsFeed;
  return !!f && f.schema === ALERTS_FEED_SCHEMA && Array.isArray(f.accounts) && f.accounts.every((e) => typeof e?.chatId === 'string' && /^-?\d{1,20}$/.test(e.chatId) && Array.isArray(e.watches));
}

export interface MergeResult {
  db: AlertsDb;
  /** chats whose plan ended since the last run — tell each once */
  ended: Array<{ chatId: string; account: string }>;
  /** chat id → account id, for the report */
  accountOf: Map<string, string>;
}

/**
 * Make the runner's db match the feed: the feed decides which chats exist and what they watch; the db keeps each
 * chat's alert state, rate-limit history and outbox. A chat that is no longer linked (or whose plan ended) is erased
 * from the runner's db, state and all.
 */
export function mergeFeed(dbIn: AlertsDb & { ended?: Record<string, number> }, feed: AlertsFeed, now: number): MergeResult & { db: AlertsDb & { ended: Record<string, number> } } {
  const db = { ...dbIn, chats: { ...dbIn.chats }, state: { ...dbIn.state }, ended: { ...(dbIn.ended ?? {}) } };
  const accountOf = new Map<string, string>();
  const ended: MergeResult['ended'] = [];
  const keep = new Set<string>();
  for (const e of feed.accounts) {
    if (!e.active) {
      if (!db.ended[e.chatId]) {
        ended.push({ chatId: e.chatId, account: e.account });
        db.ended[e.chatId] = now;
      }
      continue;
    }
    delete db.ended[e.chatId];
    keep.add(e.chatId);
    accountOf.set(e.chatId, e.account);
    const prev: Chat | undefined = db.chats[e.chatId];
    const protocolChanged = prev?.protocolSince !== (e.protocolSince ?? undefined);
    db.chats[e.chatId] = {
      id: e.chatId,
      createdAt: prev?.createdAt ?? now,
      paused: e.paused,
      watches: e.watches.slice(0, e.limit),
      sentAt: prev?.sentAt ?? [],
      held: prev?.held ?? 0,
      protocol: e.protocol,
      protocolSince: e.protocolSince ?? undefined,
      seenProtocol: protocolChanged ? [] : (prev?.seenProtocol ?? []),
      seenLiq: prev?.seenLiq ?? [],
    };
  }
  // ended entries no longer in the feed at all (unlinked) are forgotten
  const inFeed = new Set(feed.accounts.map((e) => e.chatId));
  for (const c of Object.keys(db.ended)) if (!inFeed.has(c)) delete db.ended[c];
  for (const id of Object.keys(db.chats)) {
    if (keep.has(id)) continue;
    delete db.chats[id];
    for (const k of Object.keys(db.state)) if (k.startsWith(`${id}|`)) delete db.state[k];
    db.outbox = (db.outbox ?? []).filter((o) => o.chatId !== id);
  }
  return { db, ended, accountOf };
}

/** The report the runner posts back after a run. */
export function buildReport(db: AlertsDb, accountOf: ReadonlyMap<string, string>, blockedChats: readonly string[]): AlertsReport {
  const accounts: AlertsReport['accounts'] = {};
  for (const c of Object.values(db.chats)) {
    const acct = accountOf.get(c.id);
    if (!acct) continue;
    const m: Record<string, { level: AlertLevel | null; checkedAt: number | null }> = {};
    for (const w of c.watches) {
      const st = db.state[`${c.id}|${w.address}`];
      m[w.address] = { level: st?.level ?? null, checkedAt: st?.lastCheckedAt ?? null };
    }
    accounts[acct] = m;
  }
  const blocked = blockedChats.map((c) => accountOf.get(c)).filter((x): x is string => !!x);
  return { at: db.lastRun?.at ?? Date.now(), ok: db.lastRun?.ok ?? false, note: db.lastRun?.note ?? '', accounts, blocked };
}

export const PLAN_ENDED_TEXT = (site: string) =>
  [
    'Phrourax · alerts paused',
    'Your Phrourax plan has ended, so alerts have stopped. Your wallets and lines are kept.',
    `Renew to restart them: ${site.replace(/\/$/, '')}/pricing`,
  ].join('\n');

/**
 * One run for linked accounts: match the feed, tell chats whose plan ended (once), then the usual run — with no
 * command polling (bot messages reach the site's webhook instead). Returns the db to save and the report to post.
 */
export async function runLinkedAlerts(
  dbIn: AlertsDb,
  feed: AlertsFeed,
  deps: RunDeps,
): Promise<{ db: AlertsDb; report: RunReport; siteReport: AlertsReport; endedTold: number }> {
  const now = deps.now();
  const { db, ended, accountOf } = mergeFeed(dbIn, feed, now);
  let endedTold = 0;
  for (const e of ended) {
    const r = await deps.transport.send(e.chatId, PLAN_ENDED_TEXT(feed.site)).catch(() => ({ ok: false as const }));
    if (r.ok) endedTold++;
  }
  const before = Object.keys(db.chats);
  const quiet = { name: `${deps.transport.name} (no polling)`, poll: async (offset: number) => ({ messages: [], next: offset }), send: (c: string, t: string) => deps.transport.send(c, t) };
  const { db: next, report } = await runAlerts(db, { ...deps, transport: quiet });
  const blocked = before.filter((c) => !next.chats[c]);
  return { db: next, report, siteReport: buildReport(next, accountOf, blocked), endedTold };
}
