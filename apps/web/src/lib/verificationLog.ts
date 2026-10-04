import { useEffect, useState } from 'react';
import type { VerificationRecord } from '@aegis/census';
import { CENSUS_URL } from './census';

/** Written by the `verify` workflow (every 4 h) next to census.json. Only records of the published shape are kept. */
export const VERIFY_LOG_URL = CENSUS_URL.replace(/census\.json(\?.*)?$/, 'verification-log.json');

export type VerifyLogState = { status: 'loading' } | { status: 'missing' } | { status: 'error'; message: string } | { status: 'ok'; records: VerificationRecord[] };

const isRecord = (x: unknown): x is VerificationRecord => {
  const r = x as VerificationRecord;
  return !!r && r.v === 1 && typeof r.at === 'string' && (r.venue === 'tydro' || r.venue === 'nado') && Array.isArray(r.fields) && ['PASS', 'FAIL', 'SOURCE_UNAVAILABLE'].includes(r.status);
};

export function useVerificationLog(): VerifyLogState {
  const [s, set] = useState<VerifyLogState>({ status: 'loading' });
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`${VERIFY_LOG_URL}${VERIFY_LOG_URL.includes('?') ? '&' : '?'}t=${Math.floor(Date.now() / 600_000)}`, { cache: 'no-cache' });
        if (res.status === 404 || (res.ok && !(res.headers.get('content-type') ?? '').includes('json'))) return alive && set({ status: 'missing' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j: unknown = await res.json();
        if (!Array.isArray(j)) throw new Error('unexpected shape (refused)');
        if (alive) set({ status: 'ok', records: j.filter(isRecord) });
      } catch (e) {
        if (alive) set({ status: 'error', message: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  return s;
}
