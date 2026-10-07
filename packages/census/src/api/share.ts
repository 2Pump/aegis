/**
 * The share endpoints (pure; the Vercel adapter in apps/web/api-src only does HTTP and the PNG renderer):
 *   /s/<address>        a tiny page with the wallet's preview tags for X / Telegram / Discord, forwarding people to
 *                       /hull/<address>. Crawlers may fetch it; it is noindex.
 *   /og/<address>.png   the 1200×630 card for that wallet, from a fresh read (cached about an hour).
 * One live read serves both (X fetches the page, then the image), cached per address for 10 minutes.
 * Same privacy as the share text: types, risk level, venues read, block and time — never amounts.
 */
import { getAddress } from 'viem';
import { classify, type Book } from '@aegis/pose';
import { BRAND, shareCardSvg, sharePageHtml, type ShareFacts } from '@aegis/glyphs';
import { RateLimiter } from './index.js';

export const SHARE_API = {
  /** per client IP per minute, per function instance (the edge cache absorbs repeats) */
  LIMITS: { share: 60, og: 30 } as Record<string, number>,
  /** one live read per address serves the page and the image */
  FACTS_TTL_MS: 10 * 60_000,
  /** a failed read is retried soon, not cached for long */
  FAIL_TTL_MS: 60_000,
} as const;

export interface ShareDeps {
  readWallet: (address: `0x${string}`) => Promise<Book | null>;
  /** SVG → PNG bytes (resvg in production). Throwing falls back to the site's own card. */
  render: (svg: string) => Promise<Uint8Array> | Uint8Array;
  now: () => number;
  fixtures: ReadonlySet<string>;
  site?: string;
  limiter?: RateLimiter;
}

export interface ShareResponse {
  status: number;
  headers: Record<string, string>;
  body: string | Uint8Array | null;
}

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const redirect = (to: string, maxAge: number): ShareResponse => ({ status: 302, headers: { Location: to, 'Cache-Control': `public, max-age=0, s-maxage=${maxAge}`, 'X-Robots-Tag': 'noindex' }, body: null });

export function factsFromBook(address: string, book: Book, nowMs: number): ShareFacts {
  const pose = classify(book);
  return {
    address,
    tags: pose.tags,
    hullTemp: pose.hullTemp,
    venues: { tydro: book.tydro.status === 'OK', nado: book.nado.status === 'OK' },
    block: book.asOfBlock,
    at: nowMs,
  };
}

export function makeShareHandler(d: ShareDeps) {
  const site = d.site ?? BRAND.siteUrl;
  const limiter = d.limiter ?? new RateLimiter(SHARE_API.LIMITS);
  const cache = new Map<string, { at: number; ok: boolean; v: Promise<ShareFacts | null> }>();

  const facts = (address: `0x${string}`): Promise<ShareFacts | null> => {
    const now = d.now();
    const hit = cache.get(address);
    if (hit && now - hit.at < (hit.ok ? SHARE_API.FACTS_TTL_MS : SHARE_API.FAIL_TTL_MS)) return hit.v;
    const entry = { at: now, ok: true, v: Promise.resolve<ShareFacts | null>(null) };
    entry.v = d
      .readWallet(address)
      .then((book) => (book ? factsFromBook(address, book, d.now()) : null))
      .catch(() => null)
      .then((f) => {
        entry.ok = f !== null;
        return f;
      });
    cache.set(address, entry);
    if (cache.size > 2000) for (const [k, x] of cache) if (now - x.at > SHARE_API.FACTS_TTL_MS) cache.delete(k);
    return entry.v;
  };

  /** kind 'page' for /s/<param>, 'image' for /og/<param> */
  return async function handleShare(req: { kind: 'page' | 'image'; param: string; ip: string }): Promise<ShareResponse> {
    const raw = req.param.replace(/\.png$/i, '');
    if (!ADDR.test(raw)) return redirect(req.kind === 'page' ? `${site}/` : `${site}/og.png`, 3600);
    const address = getAddress(raw) as `0x${string}`;
    if (d.fixtures.has(address.toLowerCase())) return redirect(req.kind === 'page' ? `${site}/` : `${site}/og.png`, 3600);
    const lim = limiter.take(req.ip, req.kind === 'page' ? 'share' : 'og', d.now());
    if (!lim.ok) return { status: 429, headers: { 'Retry-After': String(lim.resetS), 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, body: 'Too many requests — try again shortly.' };
    const f = await facts(address);
    if (req.kind === 'page') {
      const bucket = Math.floor(d.now() / 3_600_000);
      return {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': `public, max-age=0, s-maxage=${f ? 600 : 60}`,
          'X-Robots-Tag': 'noindex',
        },
        body: sharePageHtml({ address, facts: f, site, imageBucket: bucket }),
      };
    }
    if (!f) return redirect(`${site}/og.png`, 60);
    try {
      const png = await d.render(shareCardSvg(f));
      return {
        status: 200,
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400',
          'X-Robots-Tag': 'noindex',
        },
        body: png,
      };
    } catch {
      return redirect(`${site}/og.png`, 60);
    }
  };
}
