import { useEffect, useState } from 'react';
import { PRESSURE_VERSION, type PressureSnapshot } from '@aegis/census';
import { CENSUS_URL } from './census';
import { log } from './log';

const read = (k: string): string | undefined => {
  const v = (import.meta.env as Record<string, string | undefined>)[k];
  return v && v.trim() ? v.trim() : undefined;
};

/** Written next to census.json by every one-block full sweep (every 3 hours). */
export const PRESSURE_URL = read('VITE_PRESSURE_URL') ?? CENSUS_URL.replace(/census\.json(\?.*)?$/, 'pressure.json');

export type PressureState =
  | { status: 'loading' }
  | { status: 'missing' }
  | { status: 'error'; message: string }
  | { status: 'ok'; snap: PressureSnapshot };

/** Only the shape we publish: anything else is refused, not guessed at. */
function valid(x: unknown): x is PressureSnapshot {
  const s = x as PressureSnapshot;
  return (
    !!s &&
    s.v === PRESSURE_VERSION &&
    typeof s.block === 'number' &&
    typeof s.at === 'string' &&
    typeof s.maxPct === 'number' &&
    !!s.population &&
    typeof s.now === 'object' &&
    typeof s.hist === 'object' &&
    Object.values(s.hist).every((rows) => Array.isArray(rows) && rows.every((r) => Array.isArray(r) && r.length === 2 && r.every((n) => Number.isFinite(n))))
  );
}

export function usePressure(): PressureState {
  const [s, set] = useState<PressureState>({ status: 'loading' });
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(`${PRESSURE_URL}${PRESSURE_URL.includes('?') ? '&' : '?'}t=${Math.floor(Date.now() / 600_000)}`, { cache: 'no-cache' });
        const type = res.headers.get('content-type') ?? '';
        if (res.status === 404 || (res.ok && !type.includes('json'))) {
          if (alive) set({ status: 'missing' });
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j: unknown = await res.json();
        if (!valid(j)) throw new Error('unexpected shape (refused)');
        if (alive) set({ status: 'ok', snap: j });
        log('ok', 'live', `pressure map loaded · block ${j.block} · ${j.population.exposed} wallets simulated`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (alive) set((prev) => (prev.status === 'ok' ? prev : { status: 'error', message: msg }));
        log('err', 'live', `pressure map load failed: ${msg}`);
      }
    };
    void load();
    const id = setInterval(() => void load(), 15 * 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  return s;
}
