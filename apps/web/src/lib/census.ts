import { useEffect, useState } from 'react';
import { decodeSnapshot, type CensusShip, type CensusSnapshot } from '@aegis/census';
import { log } from './log';
import { VERIFIED } from './verification';

const read = (k: string): string | undefined => {
  const v = (import.meta.env as Record<string, string | undefined>)[k];
  return v && v.trim() ? v.trim() : undefined;
};

/** Where the hourly census lives. Local runs of `pnpm census` write apps/web/public/census/census.json. */
export const CENSUS_URL = read('VITE_CENSUS_URL') ?? '/census/census.json';

/**
 * The well stays locked until real numbers are matched against the official UIs (verification/status.json).
 * Local dev always previews it; production previews only if VITE_WELL_PREVIEW=1 is set on purpose.
 */
export const WELL_ON = VERIFIED || read('VITE_WELL_PREVIEW') === '1' || import.meta.env.DEV;
export const WELL_PREVIEW = WELL_ON && !VERIFIED;

export type CensusState =
  | { status: 'loading' }
  | { status: 'missing'; message: string }
  | { status: 'error'; message: string }
  | { status: 'ok'; snap: CensusSnapshot; ships: CensusShip[]; loadedAt: number };

const REFRESH_MS = 5 * 60_000;

export function useCensus(): CensusState {
  const [s, set] = useState<CensusState>({ status: 'loading' });
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(`${CENSUS_URL}${CENSUS_URL.includes('?') ? '&' : '?'}t=${Math.floor(Date.now() / 60_000)}`, { cache: 'no-cache' });
        if (res.status === 404) {
          if (alive) set({ status: 'missing', message: `No census at ${CENSUS_URL} yet — run \`pnpm census\` locally or set up the hourly job (docs/CENSUS.md).` });
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status} from ${CENSUS_URL}`);
        const type = res.headers.get('content-type') ?? '';
        if (!type.includes('json')) {
          // SPA fallback returns index.html for missing files in dev/prod
          if (alive) set({ status: 'missing', message: `No census at ${CENSUS_URL} yet — run \`pnpm census\` locally or set up the hourly job (docs/CENSUS.md).` });
          return;
        }
        const { snap, ships } = decodeSnapshot(await res.json());
        if (!alive) return;
        set({ status: 'ok', snap, ships, loadedAt: Date.now() });
        log('ok', 'live', `census loaded · ${snap.counts.drawn} ships · block ${snap.block} · ${snap.sweep.kind} sweep`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (alive) set((prev) => (prev.status === 'ok' ? prev : { status: 'error', message: msg }));
        log('err', 'live', `census load failed: ${msg}`);
      }
    };
    void load();
    const id = setInterval(() => void load(), REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  return s;
}
