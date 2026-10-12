/**
 * Webhook management (pure; the store is injected). Mounted at /api/v1/webhooks by the API handler — only when the
 * deployment has switched webhooks on. Server-to-server: no CORS. Every call but create needs the management token
 * (Authorization: Bearer whtok_…), shown once at creation; a wrong token and an unknown id answer the same 401.
 *
 *   POST   /webhooks                 {url, events[], wallets?[]} → 201 {id, secret, token, status: pending-verification}
 *   GET    /webhooks/{id}            status, secrets (ids only), queue, dead letters, recent deliveries
 *   PATCH  /webhooks/{id}            {status: 'paused' | 'active', events?, wallets?}
 *   DELETE /webhooks/{id}
 *   POST   /webhooks/{id}/rotate     → {secret} (the old one keeps signing for 24 h)
 *   POST   /webhooks/{id}/test       queue a webhook.test delivery
 */
import { randomBytes } from 'node:crypto';
import { parseAddress } from '@aegis/ink-io';
import { API, errorBody, type ApiRequest, type ApiResponse, type WebhookHandler } from '../api/index.js';
import type { EventType } from '../events.js';
import { SUPPORTED_EVENTS, WEBHOOKS, newSubscription, publicView, rotate, tokenMatches, urlProblem, type Subscription } from './core.js';

export interface WebhookStore {
  get(id: string): Promise<Subscription | null>;
  put(sub: Subscription): Promise<void>;
  del(id: string): Promise<void>;
  count(): Promise<number>;
}

const json = (status: number, body: unknown): ApiResponse => ({ status, headers: {}, body });
const fail = (status: number, code: Parameters<typeof errorBody>[0], msg: string, details?: Record<string, unknown>) => json(status, errorBody(code, msg, details));

function parseBody(req: ApiRequest): Record<string, unknown> | null {
  try {
    const b = JSON.parse(req.body ?? '');
    return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function validEvents(x: unknown): EventType[] | string {
  if (!Array.isArray(x) || !x.length) return `events must be a non-empty list of: ${SUPPORTED_EVENTS.join(', ')}`;
  const bad = x.filter((e) => !(SUPPORTED_EVENTS as readonly unknown[]).includes(e));
  return bad.length ? `unknown event type(s): ${bad.join(', ')}` : ([...new Set(x)] as EventType[]);
}

function validWallets(x: unknown, fixtures: ReadonlySet<string>): string[] | { code: 'INVALID_ADDRESS' | 'FIXTURE_REJECTED' | 'INVALID_PARAMETER'; msg: string } {
  if (x === undefined) return [];
  if (!Array.isArray(x) || x.length > WEBHOOKS.MAX_WALLETS) return { code: 'INVALID_PARAMETER', msg: `wallets must be a list of at most ${WEBHOOKS.MAX_WALLETS} addresses` };
  const out: string[] = [];
  for (const a of x) {
    const p = parseAddress(typeof a === 'string' ? a : '');
    if (!p.ok) return { code: 'INVALID_ADDRESS', msg: `not a valid address: ${String(a).slice(0, 60)}` };
    if (fixtures.has(p.value.lower)) return { code: 'FIXTURE_REJECTED', msg: `${p.value.lower} is a Phrourax test wallet, not a real account` };
    out.push(p.value.lower);
  }
  return [...new Set(out)];
}

/** Who may create webhooks, and how many each account has (Desk, docs/WEBHOOKS.md). Absent = anyone (tests, local). */
export interface WebhookOwners {
  /** the creating request's account: ok when it is on Desk (API key or signed-in session) */
  authorize(req: ApiRequest): Promise<{ ok: true; owner: string } | { ok: false; code: 'UNAUTHORIZED' | 'PAYMENT_REQUIRED'; message: string }>;
  /** may this owner's webhook be (re)activated — is the plan still Desk? */
  active(owner: string): Promise<boolean>;
  count(owner: string): Promise<number>;
  add(owner: string, id: string): Promise<void>;
  remove(owner: string, id: string): Promise<void>;
  max: number;
}

export function makeWebhookApi(o: { store: WebhookStore; now: () => number; fixtures?: ReadonlySet<string>; owners?: WebhookOwners }): WebhookHandler {
  const fixtures = o.fixtures ?? new Set<string>();
  return async (req, sub) => {
    const [id, action] = sub;
    const now = o.now();
    if (!id) {
      if (req.method !== 'POST') return fail(405, 'METHOD_NOT_ALLOWED', 'POST to create; manage a webhook at /webhooks/{id}');
      const b = parseBody(req);
      if (!b) return fail(400, 'BAD_REQUEST', 'body must be a JSON object');
      const problem = urlProblem(String(b.url ?? ''));
      if (problem) return fail(400, 'INVALID_PARAMETER', `url: ${problem}`);
      const events = validEvents(b.events);
      if (typeof events === 'string') return fail(400, 'INVALID_PARAMETER', events);
      const wallets = validWallets(b.wallets, fixtures);
      if (!Array.isArray(wallets)) return fail(400, wallets.code, wallets.msg);
      if (events.some((e) => e.startsWith('wallet.')) && !wallets.length) return fail(400, 'INVALID_PARAMETER', 'wallet.* events need at least one wallet');
      let owner: string | null = null;
      if (o.owners) {
        const a = await o.owners.authorize(req);
        if (!a.ok) return fail(a.code === 'UNAUTHORIZED' ? 401 : 402, a.code, a.message);
        owner = a.owner;
        if ((await o.owners.count(owner)) >= o.owners.max) return fail(400, 'INVALID_PARAMETER', `at most ${o.owners.max} webhooks per account — delete one first`);
      }
      if ((await o.store.count()) >= WEBHOOKS.MAX_SUBSCRIPTIONS) return fail(503, 'NOT_ENABLED', 'no new webhooks can be created right now (capacity)');
      const created = newSubscription({ id: `wh_${randomBytes(12).toString('base64url')}`, url: String(b.url), events, wallets, nowMs: now, owner });
      await o.store.put(created.sub);
      if (o.owners && owner) await o.owners.add(owner, created.sub.id);
      return json(201, {
        schema: API.SCHEMA,
        data: {
          id: created.sub.id,
          status: created.sub.status,
          secret: created.secret,
          token: created.token,
          shownOnce: 'Store the secret (verifies signatures) and the token (manages this webhook) now — Phrourax keeps neither in readable form and cannot show them again.',
          next: 'Your endpoint will receive a webhook.verification event within the next delivery run. Respond 2xx with data.challenge in the body to activate it. No other event is sent until then.',
        },
      });
    }
    const token = String(req.headers.authorization ?? req.headers.Authorization ?? '').replace(/^Bearer\s+/i, '');
    const s = /^wh_[A-Za-z0-9_-]{16}$/.test(id) ? await o.store.get(id) : null;
    if (!s || !tokenMatches(s, token)) return fail(401, 'UNAUTHORIZED', 'unknown webhook or wrong token');
    if (!action) {
      if (req.method === 'GET') return json(200, { schema: API.SCHEMA, data: publicView(s) });
      if (req.method === 'DELETE') {
        await o.store.del(id);
        if (o.owners && s.owner) await o.owners.remove(s.owner, id);
        return json(200, { schema: API.SCHEMA, data: { id, deleted: true } });
      }
      if (req.method === 'PATCH') {
        const b = parseBody(req);
        if (!b) return fail(400, 'BAD_REQUEST', 'body must be a JSON object');
        const next: Subscription = { ...s };
        if (b.status !== undefined) {
          if (b.status === 'paused') next.status = 'paused';
          else if (b.status === 'active') {
            if (o.owners && s.owner && !(await o.owners.active(s.owner))) return fail(402, 'PAYMENT_REQUIRED', 'webhooks need an active Desk plan on the account that created this one');
            next.status = s.verifiedAt ? 'active' : 'pending-verification';
          }
          else return fail(400, 'INVALID_PARAMETER', "status must be 'paused' or 'active'");
          next.pausedReason = next.status === 'paused' ? 'paused by its owner' : null;
          if (next.status !== 'paused') next.deadInARow = 0;
        }
        if (b.events !== undefined) {
          const ev = validEvents(b.events);
          if (typeof ev === 'string') return fail(400, 'INVALID_PARAMETER', ev);
          next.events = ev;
        }
        if (b.wallets !== undefined) {
          const w = validWallets(b.wallets, fixtures);
          if (!Array.isArray(w)) return fail(400, w.code, w.msg);
          next.wallets = w;
        }
        await o.store.put(next);
        return json(200, { schema: API.SCHEMA, data: publicView(next) });
      }
      return fail(405, 'METHOD_NOT_ALLOWED', 'GET, PATCH or DELETE');
    }
    if (req.method !== 'POST') return fail(405, 'METHOD_NOT_ALLOWED', 'POST');
    if (action === 'rotate') {
      const r = rotate(s, now);
      await o.store.put(r.sub);
      return json(200, { schema: API.SCHEMA, data: { id, secret: r.secret, note: `The previous secret keeps signing for ${WEBHOOKS.ROTATION_GRACE_H} h — every delivery in that time carries a v1 signature for each.` } });
    }
    if (action === 'test') {
      if (s.status !== 'active') return fail(400, 'INVALID_PARAMETER', 'only an active (verified) webhook can receive a test event');
      await o.store.put({ ...s, testRequested: true });
      return json(202, { schema: API.SCHEMA, data: { id, queued: 'webhook.test', note: 'sent on the next delivery run' } });
    }
    return fail(404, 'NOT_FOUND', 'unknown action (rotate, test)');
  };
}
