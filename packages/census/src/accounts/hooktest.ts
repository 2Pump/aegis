/**
 * Webhook test receiver — /api/v1/hooktest (Desk). A place to point a webhook before you've built your own endpoint.
 *
 *   GET  /hooktest            signed-in Desk: your receiver URL and the last 20 deliveries it got
 *   POST /hooktest/<token>    the receiver: answers the verification challenge, keeps a short record of each delivery
 *
 * It records only what a delivery says about itself (event type, id, time, text, whether it carried a signature),
 * never anything else, and only the last 20. It is a test tool: a real integration verifies signatures itself.
 */
import { randomBytes } from 'node:crypto';
import type { AuthRequest, AuthResponse } from './api.js';
import { sessionUser } from './api.js';
import type { Kv } from './kv.js';
import { apiUnlocked, effectiveAccess } from './paywall.js';

export const HOOKTEST = { KEEP: 20, PER_MIN: 60, MAX_BODY: 64_000 } as const;

export interface HookTestEntry {
  at: string;
  event: string | null;
  deliveryId: string | null;
  text: string | null;
  signed: boolean;
  bytes: number;
}

const NO_STORE = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' };
const json = (status: number, body: unknown): AuthResponse => ({ status, headers: { ...NO_STORE }, body });
const err = (status: number, code: string, message: string) => json(status, { error: { code, message } });
const h1 = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export function makeHookTestHandler(d: { kv: Kv; secret: Buffer; now: () => number; comp?: ReadonlySet<string>; site: string }) {
  const comp = d.comp ?? new Set<string>();
  const site = d.site.replace(/\/+$/, '');
  return async function hookTest(req: AuthRequest): Promise<AuthResponse> {
    if (req.path === '/hooktest') {
      if (req.method !== 'GET') return err(405, 'METHOD_NOT_ALLOWED', 'Use GET.');
      const u = await sessionUser(d, h1(req.headers.cookie));
      if (!u) return err(401, 'SIGN_IN', 'Sign in first.');
      if (!apiUnlocked(effectiveAccess(u, d.now(), comp))) return err(402, 'PAYMENT_REQUIRED', 'The webhook test receiver comes with the Desk plan.');
      let token = await d.kv.get(`ht:u:${u.id}`);
      if (!token) {
        token = randomBytes(18).toString('base64url');
        await d.kv.set(`ht:u:${u.id}`, token);
        await d.kv.set(`ht:t:${token}`, u.id);
      }
      const raw = await d.kv.get(`ht:d:${token}`);
      return json(200, {
        url: `${site}/api/v1/hooktest/${token}`,
        note: 'Use this URL as a webhook endpoint to try deliveries. It answers the verification challenge and keeps the last 20 deliveries here. Refresh this page to see new ones.',
        deliveries: raw ? (JSON.parse(raw) as HookTestEntry[]) : [],
      });
    }
    const token = req.path.slice('/hooktest/'.length);
    if (!/^[A-Za-z0-9_-]{24}$/.test(token)) return err(404, 'NOT_FOUND', 'No such receiver.');
    if (req.method !== 'POST') return err(405, 'METHOD_NOT_ALLOWED', 'Use POST.');
    if (!(await d.kv.get(`ht:t:${token}`))) return err(404, 'NOT_FOUND', 'No such receiver.');
    if ((await d.kv.incrWindow(`rl:ht:${token}`, 60)) > HOOKTEST.PER_MIN) return err(429, 'RATE_LIMITED', 'Too many deliveries this minute.');
    const body = req.body ?? '';
    let p: { deliveryId?: unknown; event?: { type?: unknown; text?: unknown; data?: { challenge?: unknown } } } = {};
    try {
      p = JSON.parse(body) as typeof p;
    } catch {
      /* recorded as unreadable */
    }
    const entry: HookTestEntry = {
      at: new Date(d.now()).toISOString(),
      event: typeof p.event?.type === 'string' ? p.event.type.slice(0, 60) : null,
      deliveryId: typeof p.deliveryId === 'string' ? p.deliveryId.slice(0, 80) : null,
      text: typeof p.event?.text === 'string' ? p.event.text.slice(0, 300) : null,
      signed: /^t=\d+,v1=[0-9a-f]{64}/.test(String(h1(req.headers['phrourax-signature']) ?? '')),
      bytes: body.length,
    };
    const raw = await d.kv.get(`ht:d:${token}`);
    const list = raw ? (JSON.parse(raw) as HookTestEntry[]) : [];
    await d.kv.set(`ht:d:${token}`, JSON.stringify([entry, ...list].slice(0, HOOKTEST.KEEP)), 30 * 86_400);
    const challenge = typeof p.event?.data?.challenge === 'string' ? p.event.data.challenge : undefined;
    return json(200, { ok: true, received: entry.event, ...(challenge ? { challenge } : {}) });
  };
}
