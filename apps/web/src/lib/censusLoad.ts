import { decodeSnapshot } from '@aegis/census';
import type { CensusState } from './census';

/**
 * One load of the published census, as a state transition (pure apart from the injected fetch; unit-tested with a
 * deliberately slow, failing and missing network). The rules that keep a risk page from ever showing a false zero:
 *  - the state stays `loading` until a scan has actually been decoded — an empty or pending response is never a scan;
 *  - a failed, missing or non-JSON refresh never replaces a scan already on screen: it stays, marked LAST GOOD
 *    (`refreshError`), so a background refresh can't blank the page;
 *  - before any scan has loaded, those outcomes become `missing` / `error` — shown as such, never as zero wallets.
 */
export async function loadCensusOnce(o: {
  fetchFn: (url: string, init: RequestInit) => Promise<Pick<Response, 'status' | 'ok' | 'headers' | 'json'>>;
  url: string;
  nowMs: number;
  alive: () => boolean;
  update: (f: (prev: CensusState) => CensusState) => void;
  log?: (level: 'ok' | 'err', area: 'live', msg: string) => void;
}): Promise<void> {
  const missing = `No census at ${o.url} yet — run \`pnpm census\` locally or set up the hourly job (docs/CENSUS.md).`;
  const keepOr = (why: string, otherwise: CensusState) => {
    if (o.alive()) o.update((prev) => (prev.status === 'ok' ? { ...prev, refreshError: why } : otherwise));
  };
  try {
    const res = await o.fetchFn(o.url.startsWith('/api/v1/data/') ? o.url : `${o.url}${o.url.includes('?') ? '&' : '?'}t=${Math.floor(o.nowMs / 60_000)}`, { cache: 'no-cache' });
    if (res.status === 404) return keepOr('the scan file is missing right now', { status: 'missing', message: missing });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${o.url}`);
    // the SPA fallback answers index.html for a file that isn't there
    if (!(res.headers.get('content-type') ?? '').includes('json')) return keepOr('the scan file is missing right now', { status: 'missing', message: missing });
    const { snap, ships } = decodeSnapshot(await res.json());
    if (!o.alive()) return;
    o.update(() => ({ status: 'ok', snap, ships, loadedAt: o.nowMs }));
    o.log?.('ok', 'live', `scan loaded · ${snap.counts.drawn} wallets · block ${snap.block} · ${snap.sweep.kind === 'full' ? 'full re-read' : 'hourly update'}${snap.sweep.complete === false ? ' (partial — continues next run)' : ''}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    keepOr(msg, { status: 'error', message: msg });
    o.log?.('err', 'live', `scan load failed: ${msg}`);
  }
}
