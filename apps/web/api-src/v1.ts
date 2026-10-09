/**
 * Vercel function for /api/v1/* (vercel.json rewrites every /api/v1/… path here). It only adapts HTTP to the pure
 * handler in @aegis/census/api — routing, validation, privacy and the envelope all live (and are tested) there.
 *
 * Bundled by scripts/build-api.mjs into api/v1.js (one self-contained file; `pnpm check` fails if it is out of date).
 * Environment (Vercel → Settings → Environment Variables), all optional:
 *   CENSUS_URL or VITE_CENSUS_URL  the public census.json URL (the site already has VITE_CENSUS_URL)
 *   INK_RPC                        RPC URL(s) for the one live endpoint; default: Ink's public RPCs
 * Also serves the share link and its card (vercel.json rewrites /s/<address> and /og/<address>.png here):
 * the page and the PNG come from @aegis/census/api's share handler; this file only renders SVG → PNG with resvg.
 * Webhook management stays NOT_ENABLED until WEBHOOKS_ENABLED=1 and its secrets exist (docs/WEBHOOKS.md).
 * Accounts (/api/v1/auth/*) stay off until their four settings exist (./accounts.ts, docs/ACCOUNTS.md).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { API, RateLimiter, handle, makeShareHandler, type ApiDeps } from '@aegis/census/api';
import { decodeShip, type CensusSnapshot } from '@aegis/census';
import { INK_PUBLIC_RPCS, makeInkClient, readBook, splitRpcList } from '@aegis/ink-io';
import { makeWebhookHandler } from './webhooks';
import { makeAccounts } from './accounts';

declare const __FIXTURES__: string[];

const CENSUS = (process.env.CENSUS_URL || process.env.VITE_CENSUS_URL || '').trim();
const BASE = CENSUS.replace(/census\.json(\?.*)?$/, '');
const TTL_MS = 60_000;
const cache = new Map<string, { at: number; v: Promise<unknown | null> }>();

async function get(name: string): Promise<unknown | null> {
  if (!BASE) throw new Error('CENSUS_URL not configured');
  if (!/^[a-z0-9/_.-]+\.json$/i.test(name) || name.includes('..')) return null; // only census file names, never a URL
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.v;
  const v = (async () => {
    const r = await fetch(`${BASE}${name}?t=${Math.floor(Date.now() / TTL_MS)}`, { cache: 'no-store' });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`source HTTP ${r.status}`);
    return r.json();
  })();
  cache.set(name, { at: Date.now(), v });
  v.catch(() => cache.delete(name));
  if (cache.size > 200) for (const [k, x] of cache) if (Date.now() - x.at > TTL_MS) cache.delete(k);
  return v;
}

const rpcs = splitRpcList(process.env.INK_RPC);
const client = makeInkClient(rpcs.length ? rpcs : [...INK_PUBLIC_RPCS]);
const limiter = new RateLimiter();
const fixtures = new Set(__FIXTURES__);

const deps: ApiDeps = {
  get,
  now: () => Date.now(),
  limiter,
  fixtures,
  readWallet: async (address) => {
    const c = (await get('census.json').catch(() => null)) as CensusSnapshot | null;
    const row = c?.ships.find((r) => r[0] === address);
    const subs = row ? decodeShip(row).extraSubs : [];
    const r = await readBook(address, {
      client,
      nado: { mode: 'chain', maxSubaccounts: 8, gatewayBase: '', archiveBase: '' },
      nadoDiscovery: async () => (c && c.discovery.backfillComplete ? { subs, throughBlock: c.block } : null),
    });
    return r.book ?? null;
  },
  webhooks: makeWebhookHandler(),
};

/* ── share card renderer: resvg + the bundled IBM Plex TTFs (apps/web/api-assets/fonts, OFL) ── */
const FONT_FILES = ['IBMPlexMono-Regular.ttf', 'IBMPlexMono-Medium.ttf', 'IBMPlexMono-SemiBold.ttf', 'IBMPlexSans-Regular.ttf'];
let resvg: Promise<typeof import('@resvg/resvg-js')> | null = null;
async function renderPng(svg: string): Promise<Uint8Array> {
  resvg ??= import('@resvg/resvg-js');
  const { Resvg } = await resvg;
  const fontFiles = FONT_FILES.map((f) => fileURLToPath(new URL(`../api-assets/fonts/${f}`, import.meta.url)));
  return new Resvg(svg, { font: { fontFiles, loadSystemFonts: false, defaultFontFamily: 'IBM Plex Mono' } }).render().asPng();
}
const accounts = makeAccounts();
const share = makeShareHandler({ readWallet: (a) => deps.readWallet!(a), render: renderPng, now: () => Date.now(), fixtures });

function clientIp(req: IncomingMessage): string {
  const xf = String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim();
  return xf || String(req.headers['x-real-ip'] ?? '') || req.socket.remoteAddress || 'unknown';
}

async function readBody(req: IncomingMessage): Promise<string | undefined> {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return undefined;
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > API.MAX_BODY_BYTES + 1) break; // stop reading: the handler answers 413
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://x');
  // /s/<address> and /og/<address>.png (vercel.json) — the share page and card, not part of the JSON API
  const shareParam = url.searchParams.get('__share');
  const ogParam = url.searchParams.get('__og');
  if (shareParam !== null || ogParam !== null) {
    const out = await share({ kind: shareParam !== null ? 'page' : 'image', param: shareParam ?? ogParam ?? '', ip: clientIp(req) });
    res.statusCode = out.status;
    for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v);
    res.end(req.method === 'HEAD' || out.body === null ? undefined : typeof out.body === 'string' ? out.body : Buffer.from(out.body));
    return;
  }
  const forced = url.searchParams.get('__path');
  url.searchParams.delete('__path');
  const path = forced !== null ? `/${forced}` : url.pathname.replace(/^\/api\/v1/, '') || '/';
  // accounts: sign-in links and the session cookie (not part of the data API's envelope)
  if (path.startsWith('/auth/')) {
    const out = await accounts.handler({ method: req.method ?? 'GET', path, headers: req.headers, ip: clientIp(req), body: await readBody(req) });
    res.statusCode = out.status;
    for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v);
    res.end(JSON.stringify(out.body));
    return;
  }
  const query: Record<string, string> = {};
  for (const [k, v] of url.searchParams) if (!(k in query)) query[k] = v;
  const out = await handle(
    { method: req.method === 'HEAD' ? 'GET' : (req.method ?? 'GET'), path, query, ip: clientIp(req), headers: req.headers as Record<string, string>, body: await readBody(req) },
    deps,
  );
  res.statusCode = out.status;
  for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v);
  res.end(out.status === 204 || req.method === 'HEAD' ? undefined : JSON.stringify(out.body));
}
