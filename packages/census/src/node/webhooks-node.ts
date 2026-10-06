/**
 * Webhooks — the server side: encrypted store, SSRF-safe delivery, and the delivery run. OFF until switched on.
 *
 * Store: one AES-256-GCM sealed object per subscription (key WEBHOOKS_STORE_KEY, 32 bytes base64), named from an HMAC
 * of its id, so the bucket listing reveals neither ids nor URLs. Secrets are kept sealed (they're needed to sign);
 * management tokens are kept only as a hash.
 *
 * Delivery: https only, port 443, no redirects followed, 5 s timeout, response read up to 4 KB, and every address the
 * host name resolves to is checked AT CONNECT TIME (a custom DNS lookup), so a name that later resolves to a private,
 * loopback or metadata address (DNS rebinding) is refused, not fetched.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request } from 'node:https';
import type { PublicClient } from 'viem';
import { evaluate } from '../alerts/engine.js';
import { freshState, type Observation, type Watch, type WatchState } from '../alerts/model.js';
import { changesPath, type ChangesFile } from '../changes.js';
import { inkEvents, liquidationEvents, type InkEvent } from '../events.js';
import { INDEX_PATH, aggPath, isAggFile, isHistoryIndex } from '../history.js';
import { isLedgerFile, ledgerPath, type LedgerRecord } from '../ledger.js';
import { ORACLE_LATEST, type OracleWatch } from '../oracle.js';
import type { VerificationRecord } from '../verify.js';
import { WEBHOOKS, due, isPrivateIp, plan, retryableStatus, settle, signatureHeader, toWalletEvents, urlProblem, type Delivery, type SendResult, type Subscription } from '../webhooks/core.js';
import type { WebhookStore } from '../webhooks/api.js';
import { seal, unseal } from './alerts-store.js';
import type { CensusStore } from './store.js';

/* ───────────────────────── store ───────────────────────── */

export interface WebhookStoreAll extends WebhookStore {
  all(): Promise<Subscription[]>;
  describe: string;
}

const isSub = (x: unknown): x is Subscription => !!x && (x as Subscription).v === 1 && typeof (x as Subscription).id === 'string' && Array.isArray((x as Subscription).secrets);
const objName = (key: Buffer, id: string) => `webhooks/${createHmac('sha256', key).update(`webhook:${id}`).digest('hex').slice(0, 32)}.sealed.json`;

export function memoryWebhookStore(key: Buffer = randomBytes(32)): WebhookStoreAll & { raw: Map<string, unknown> } {
  const raw = new Map<string, unknown>();
  return {
    describe: 'memory (encrypted)',
    raw,
    async get(id) {
      const r = raw.get(objName(key, id));
      if (!r) return null;
      const s = unseal(key, r);
      return isSub(s) ? s : null;
    },
    async put(sub) {
      raw.set(objName(key, sub.id), seal(key, sub));
    },
    async del(id) {
      raw.delete(objName(key, id));
    },
    async count() {
      return raw.size;
    },
    async all() {
      return [...raw.values()].map((r) => unseal(key, r)).filter(isSub);
    },
  };
}

/** Vercel Blob (BLOB_READ_WRITE_TOKEN). Objects are public like every blob there — and unreadable without the key. */
export async function blobWebhookStore(key: Buffer): Promise<WebhookStoreAll> {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) throw new Error('BLOB_READ_WRITE_TOKEN is not set');
  const { put, list, del } = await import('@vercel/blob');
  const fetchSealed = async (url: string) => {
    const r = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`webhooks store: HTTP ${r.status}`);
    const s = unseal(key, await r.json());
    return isSub(s) ? s : null;
  };
  const listAll = async () => {
    const out: Array<{ pathname: string; url: string }> = [];
    let cursor: string | undefined;
    do {
      const r = await list({ prefix: 'webhooks/', token, limit: 1000, cursor });
      out.push(...r.blobs);
      cursor = r.hasMore ? r.cursor : undefined;
    } while (cursor);
    return out;
  };
  return {
    describe: 'vercel-blob (encrypted)',
    async get(id) {
      const name = objName(key, id);
      const { blobs } = await list({ prefix: name, token, limit: 2 });
      const hit = blobs.find((b) => b.pathname === name);
      return hit ? fetchSealed(hit.url) : null;
    },
    async put(sub) {
      await put(objName(key, sub.id), JSON.stringify(seal(key, sub)), { access: 'public', token, contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 0 });
    },
    async del(id) {
      const name = objName(key, id);
      const { blobs } = await list({ prefix: name, token, limit: 2 });
      const hit = blobs.find((b) => b.pathname === name);
      if (hit) await del(hit.url, { token });
    },
    async count() {
      return (await listAll()).length;
    },
    async all() {
      const xs = await Promise.all((await listAll()).map((b) => fetchSealed(b.url).catch(() => null)));
      return xs.filter((x): x is Subscription => !!x);
    },
  };
}

/* ───────────────────────── SSRF-safe delivery ───────────────────────── */

/** DNS lookup that refuses private / loopback / link-local / metadata answers — checked when the socket connects. */
export function safeLookup(hostname: string, opts: unknown, cb: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void): void {
  dnsLookup(hostname, { all: true }, (err, addrs) => {
    if (err) return cb(err, '', 0);
    const list = addrs as LookupAddress[];
    const bad = list.find((a) => isPrivateIp(a.address));
    if (!list.length || bad) {
      const e = new Error(`refused: ${hostname} resolves to a non-public address`) as NodeJS.ErrnoException;
      e.code = 'EAI_REFUSED';
      return cb(e, '', 0);
    }
    const all = (opts as { all?: boolean } | undefined)?.all;
    if (all) return cb(null, list);
    cb(null, list[0]!.address, list[0]!.family);
  });
}

export type Sender = (url: string, body: string, headers: Record<string, string>) => Promise<SendResult>;

export const httpsSender: Sender = (url, body, headers) =>
  new Promise((resolve) => {
    const problem = urlProblem(url);
    if (problem) return resolve({ ok: false, status: null, ms: null, error: `refused: ${problem}`, retryable: false });
    const t0 = Date.now();
    let done = false;
    const finish = (r: SendResult) => {
      if (!done) {
        done = true;
        resolve(r);
      }
    };
    const req = request(url, { method: 'POST', headers: { ...headers, 'Content-Length': String(Buffer.byteLength(body)) }, lookup: safeLookup as never, timeout: WEBHOOKS.TIMEOUT_MS }, (res) => {
      const status = res.statusCode ?? 0;
      let got = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => {
        if (got.length < WEBHOOKS.MAX_RESPONSE_BYTES) got += c.slice(0, WEBHOOKS.MAX_RESPONSE_BYTES - got.length);
        else res.destroy();
      });
      res.on('close', () => {
        const ms = Date.now() - t0;
        // redirects are not followed: a 3xx is a failed delivery (and final — the URL should be the real one)
        if (status >= 200 && status < 300) finish({ ok: true, status, ms, body: got });
        else finish({ ok: false, status, ms, error: `HTTP ${status}${status >= 300 && status < 400 ? ' (redirects are not followed)' : ''}`, retryable: retryableStatus(status) });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`timed out after ${WEBHOOKS.TIMEOUT_MS} ms`)));
    req.on('error', (e) => finish({ ok: false, status: null, ms: Date.now() - t0, error: e.message.slice(0, 200), retryable: !/refused: /.test(e.message) }));
    req.end(body);
  });

/* ───────────────────────── one delivery run ───────────────────────── */

export interface WebhookRunDeps {
  store: WebhookStoreAll;
  /** the census store (read only here): oracle, changes, history, ledger, verification log */
  census: Pick<CensusStore, 'get'>;
  send: Sender;
  now: () => number;
  /** one live wallet read (the alerts reader); null = couldn't read */
  read?: (address: string) => Promise<Observation | null>;
  fixtures?: ReadonlySet<string>;
  log?: (m: string) => void;
  client?: PublicClient;
}

const WATCH = (address: string, now: number): Watch => ({ address, venue: 'any', hfBelow: null, bufferBelow: null, scenario: null, createdAt: now });

/** The canonical Ink-wide feed from the census store (shared by webhooks and Telegram alerts) + recent ledger records. */
export async function loadFeed(census: Pick<CensusStore, 'get'>, since: number): Promise<{ ink: InkEvent[]; liq: LedgerRecord[] }> {
  const d = { census };
  const idx = await d.census.get(INDEX_PATH).catch(() => null);
  const months = isHistoryIndex(idx) ? idx.months.slice(-2) : [];
  const ch = isHistoryIndex(idx) ? (idx.changeMonths ?? []).slice(-2) : [];
  const lm = isHistoryIndex(idx) ? (idx.ledgerMonths ?? []).slice(-2) : [];
  const [w, aggs, chs, liqs, vlog] = await Promise.all([
    d.census.get(ORACLE_LATEST).catch(() => null),
    Promise.all(months.map((m) => d.census.get(aggPath(m)).catch(() => null))),
    Promise.all(ch.map((m) => d.census.get(changesPath(m)).catch(() => null))),
    Promise.all(lm.map((m) => d.census.get(ledgerPath(m)).catch(() => null))),
    d.census.get('verification-log.json').catch(() => null),
  ]);
  const liq = liqs.filter(isLedgerFile).flatMap((f) => f.records);
  const ink = inkEvents({
    oracle: (w as OracleWatch | null)?.kind === 'aegis-oracle-watch' ? (w as OracleWatch) : null,
    changes: chs.flatMap((f) => ((f as ChangesFile)?.kind === 'aegis-changes' ? (f as ChangesFile).records : [])),
    agg: aggs.filter(isAggFile).flatMap((f) => f.points),
    liquidations: liq,
    verification: Array.isArray(vlog) ? (vlog as VerificationRecord[]) : [],
    since,
  });
  return { ink, liq };
}

export interface WebhookRunReport {
  subscriptions: number;
  active: number;
  queued: number;
  sent: number;
  failed: number;
  deadLettered: number;
  verified: number;
}

export async function runWebhooks(d: WebhookRunDeps): Promise<WebhookRunReport> {
  const log = d.log ?? (() => {});
  const now = d.now();
  const subs = await d.store.all();
  const rep: WebhookRunReport = { subscriptions: subs.length, active: subs.filter((s) => s.status === 'active').length, queued: 0, sent: 0, failed: 0, deadLettered: 0, verified: 0 };
  if (!subs.length) {
    log('webhooks: no subscriptions');
    return rep;
  }
  const since = Math.min(...subs.map((s) => s.since ?? now));
  const { ink, liq } = await loadFeed(d.census, since);
  // every watched wallet read once, however many endpoints watch it
  const watched = [...new Set(subs.filter((s) => s.status === 'active' && s.events.some((e) => e.startsWith('wallet.'))).flatMap((s) => s.wallets))].filter((a) => !d.fixtures?.has(a));
  const obs = new Map<string, Observation | null>();
  for (const a of watched) obs.set(a, d.read ? await d.read(a).catch(() => null) : null);
  const liqEvents = liquidationEvents(liq, new Set(watched));

  for (const s0 of subs) {
    // per endpoint: the alerts engine's own transitions for its wallets (state kept per endpoint)
    let s: Subscription = { ...s0, walletState: { ...s0.walletState } };
    const walletEvents: InkEvent[] = [];
    if (s.status === 'active')
      for (const a of s.wallets) {
        const o = obs.get(a);
        if (!o) continue;
        const prev = (s.walletState[a] as WatchState | undefined) ?? freshState();
        const { events, next } = evaluate(WATCH(a, now), prev, o, now);
        s.walletState[a] = next;
        walletEvents.push(...toWalletEvents(events, o, now));
      }
    const before = s.outbox.length;
    s = plan(s, [...ink, ...liqEvents, ...walletEvents], now, d.fixtures);
    rep.queued += s.outbox.length - before;
    for (const dl of due(s, now)) {
      const body = dl.body;
      const r = await d.send(s.url, body, {
        'Content-Type': 'application/json',
        'User-Agent': `Phrourax-Webhooks/${WEBHOOKS.VERSION}`,
        'Phrourax-Signature': signatureHeader(s.secrets, body, now),
        'Phrourax-Delivery': dl.deliveryId,
        'Phrourax-Event': dl.type,
        'Idempotency-Key': dl.eventId,
      });
      const wasPending = s.status === 'pending-verification';
      s = settle(s, dl as Delivery, r, now);
      if (r.ok) rep.sent++;
      else rep.failed++;
      if (s.deadLetter.length > (s0.deadLetter?.length ?? 0) && !r.ok && !s.outbox.some((x) => x.deliveryId === dl.deliveryId)) rep.deadLettered++;
      if (wasPending && s.status === 'active') rep.verified++;
    }
    // re-read just before writing: a pause or delete made through the API during this run wins
    const latest = await d.store.get(s.id);
    if (!latest) continue;
    if (latest.status === 'paused' && s.status !== 'paused') s = { ...s, status: 'paused', pausedReason: latest.pausedReason };
    const testSent = s0.testRequested && !s.testRequested;
    await d.store.put({ ...s, events: latest.events, wallets: latest.wallets, url: latest.url, secrets: latest.secrets, testRequested: testSent ? false : latest.testRequested });
  }
  log(`webhooks: ${rep.subscriptions} subscription(s) (${rep.active} active) · ${rep.queued} queued · ${rep.sent} delivered · ${rep.failed} failed · ${rep.deadLettered} dead-lettered · ${rep.verified} verified`);
  return rep;
}
