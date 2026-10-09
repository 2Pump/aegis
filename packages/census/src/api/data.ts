/**
 * /api/v1/data/* — the census files the site draws, served through the function so a paywall can apply
 * (docs/PAYWALL.md). Pure: the file reader and the visitor's plan are passed in.
 *
 *   GET /data/<file>.json          a census file (census.json, pressure.json, history/…). Free files always; the rest
 *                                  only to a plan that unlocks the site while PAYWALL=1.
 *   GET /data/subs/<address>       the Nado subaccounts the census found for one wallet (free: the wallet page needs
 *                                  them to read isolated positions, and they're public chain facts anyway)
 *
 * Caching: a paid file is never cached by the CDN (one subscriber's response must not reach anyone else) — only by
 * the subscriber's own browser, briefly. Free files may be cached by the CDN.
 */
import { decodeSnapshot } from '../index.js';
import { isDataFileName, isFreeFile, siteUnlocked, PAYMENT_REQUIRED, type Access } from '../accounts/index.js';

export interface DataDeps {
  read: (name: string) => Promise<unknown | null>;
  /** the visitor's plan (cookie → account), only asked when needed */
  access: () => Promise<{ signedIn: boolean; access: Access }>;
  paywall: boolean;
}

export interface DataResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

const JSON_H = { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' };
const CDN = 'public, max-age=30, s-maxage=60';
const PRIVATE = 'private, max-age=30';
const NO_STORE = 'no-store';
const out = (status: number, body: unknown, cache: string, extra: Record<string, string> = {}): DataResponse => ({ status, headers: { ...JSON_H, 'Cache-Control': cache, ...extra }, body });
const fail = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) => out(status, { error: { code, message, ...extra } }, NO_STORE);

export function makeDataHandler(d: DataDeps) {
  return async function handleData(req: { method: string; path: string }): Promise<DataResponse> {
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(405, 'METHOD_NOT_ALLOWED', 'GET only.');
    const rest = req.path.replace(/^\/data\//, '');
    try {
      const subs = rest.match(/^subs\/(0x[0-9a-fA-F]{40})$/);
      if (subs) {
        const raw = await d.read('census.json');
        if (!raw) return fail(404, 'NOT_FOUND', 'No census yet.');
        const { snap, ships } = decodeSnapshot(raw as Parameters<typeof decodeSnapshot>[0]);
        const a = subs[1]!.toLowerCase();
        const ship = ships.find((s) => s.address.toLowerCase() === a);
        return out(200, { block: snap.block, complete: snap.discovery.backfillComplete, subs: ship?.extraSubs ?? [] }, CDN);
      }
      if (!isDataFileName(rest)) return fail(404, 'NOT_FOUND', 'No such file.');
      const free = isFreeFile(rest);
      if (d.paywall && !free) {
        const who = await d.access();
        if (!siteUnlocked(who.access)) return fail(402, 'PAYMENT_REQUIRED', PAYMENT_REQUIRED.site, { signedIn: who.signedIn });
      }
      const body = await d.read(rest);
      if (body === null) return fail(404, 'NOT_FOUND', 'No such file yet.');
      return out(200, body, free || !d.paywall ? CDN : PRIVATE, free || !d.paywall ? {} : { Vary: 'Cookie' });
    } catch {
      return fail(503, 'UPSTREAM_UNAVAILABLE', 'The census could not be read just now.');
    }
  };
}
