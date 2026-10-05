import { useEffect, useState } from 'react';
import type { CensusShip, CensusSnapshot } from '@aegis/census';
import { loadCensusOnce } from './censusLoad';
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
  /** refreshError: a later reload failed — this is the LAST GOOD scan, and the page says so */
  | { status: 'ok'; snap: CensusSnapshot; ships: CensusShip[]; loadedAt: number; refreshError?: string };

const REFRESH_MS = 5 * 60_000;

export function useCensus(): CensusState {
  const [s, set] = useState<CensusState>({ status: 'loading' });
  useEffect(() => {
    let alive = true;
    const load = () =>
      loadCensusOnce({
        fetchFn: (u, init) => fetch(u, init),
        url: CENSUS_URL,
        nowMs: Date.now(),
        alive: () => alive,
        update: set,
        log,
      });
    void load();
    const id = setInterval(() => void load(), REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  return s;
}
