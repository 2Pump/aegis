import { Err, Ok, errMessage, type InkErrorCode, type Result } from './result.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpOpts {
  fetch?: FetchLike;
  timeoutMs?: number;
  /** error code to use when the network fails / times out */
  deadCode?: InkErrorCode;
}

/** JSON GET/POST with timeout and 429 → RATE_LIMIT. Never throws. Errors carry a plain-words reason for the on-page log. */
export async function getJson(url: string, init: RequestInit | undefined, opts: HttpOpts = {}): Promise<Result<unknown>> {
  const f = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 8000);
  try {
    const res = await f(url, { ...init, signal: ctrl.signal });
    if (res.status === 429) {
      const ra = Number(res.headers.get('retry-after'));
      return Err('RATE_LIMIT', `429 from ${host(url)}`, Number.isFinite(ra) && ra > 0 ? ra : undefined);
    }
    if (!res.ok) {
      const snippet = await bodySnippet(res);
      const server = res.headers.get('server');
      const hint = diagnose(res, snippet, server);
      return Err(
        opts.deadCode ?? 'VENUE_TIMEOUT',
        `HTTP ${res.status} from ${host(url)}${server ? ` [server: ${server}]` : ''}${hint ? ` — ${hint}` : ''}${snippet ? ` — body: "${snippet}"` : ''}`,
      );
    }
    try {
      return Ok(await res.json());
    } catch (e) {
      return Err('PARSE_FAIL', `Non-JSON body from ${host(url)}: ${errMessage(e)}`);
    }
  } catch (e) {
    const aborted = e instanceof DOMException && e.name === 'AbortError';
    if (aborted) return Err(opts.deadCode ?? 'VENUE_TIMEOUT', `${host(url)} did not answer in ${(opts.timeoutMs ?? 8000) / 1000}s`);
    // In a browser, a TypeError with no response means the browser refused to hand us the reply:
    // almost always CORS (the venue does not allow other sites to read it), or the network is down.
    const corsLike = e instanceof TypeError && 'document' in globalThis;
    return Err(
      opts.deadCode ?? 'VENUE_TIMEOUT',
      corsLike
        ? `${host(url)}: browser blocked the reply (CORS — venue does not allow other sites to read it) or network down. Raw: ${errMessage(e)}`
        : `${host(url)}: ${errMessage(e)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/** First ~160 chars of the body, HTML tags stripped, whitespace collapsed. */
async function bodySnippet(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160);
  } catch {
    return '';
  }
}

/** Plain-words guess at why a venue refused us. Shown in the sensor log; never used for logic. */
function diagnose(res: Response, body: string, server: string | null): string {
  const b = body.toLowerCase();
  if (res.headers.get('cf-mitigated') === 'challenge') return 'Cloudflare challenge: venue only answers real browsers, not servers/proxies';
  if (res.status === 403 && /(restrict|region|countr|jurisdiction|geo|not available in your)/.test(b)) return 'looks like a location block';
  if (res.status === 403 && (server?.toLowerCase().includes('cloudflare') || /cloudflare|attention required|just a moment/.test(b)))
    return 'blocked by Cloudflare (venue only answers real browsers)';
  if (res.status === 403) return 'venue refused the request';
  if (res.status === 502 || res.status === 504) return 'proxy could not reach the venue';
  return '';
}

function host(url: string): string {
  try {
    return new URL(url, 'http://local').host === 'local' ? url.split('?')[0]! : new URL(url).host;
  } catch {
    return url;
  }
}
