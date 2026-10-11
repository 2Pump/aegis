/**
 * The signed-in account's Telegram alerts — GET /api/v1/alerts/me and the POSTs that change them (docs/ALERTS.md).
 * Nothing is kept in the browser.
 */
import { authPost } from './account';

export type AlertLevel = 'SAFE' | 'WATCH' | 'NEAR' | 'LIQ' | 'UNKNOWN';
export interface AlertWatch {
  address: string;
  venue: 'any' | 'tydro' | 'nado';
  hfBelow: number | null;
  bufferPct: number | null;
  scenario: { direction: string; pct: number } | null;
  overLimit: boolean;
  level: AlertLevel | null;
  checkedAt: number | null;
}
export interface AlertsMe {
  enabled: boolean;
  signedIn?: boolean;
  live?: boolean;
  bot?: string | null;
  limit?: number;
  linked?: boolean;
  linkedAt?: number | null;
  paused?: boolean;
  protocol?: boolean;
  watches?: AlertWatch[];
  lastRun?: { at: number; ok: boolean } | null;
}

export async function fetchAlerts(): Promise<AlertsMe> {
  try {
    const r = await fetch('/api/v1/alerts/me', { credentials: 'same-origin', cache: 'no-store' });
    const ct = r.headers.get('content-type') ?? '';
    if (!r.ok || !ct.includes('json')) return { enabled: false };
    return (await r.json()) as AlertsMe;
  } catch {
    return { enabled: false };
  }
}

export const alertsPost = <T = AlertsMe>(path: 'link' | 'watch' | 'unwatch' | 'settings' | 'unlink', body: unknown) => authPost<T>(path, body, 'alerts');

export const LEVEL_LABEL: Record<AlertLevel, string> = { SAFE: 'SAFE', WATCH: 'WATCH', NEAR: 'NEAR LIQUIDATION', LIQ: 'LIQUIDATABLE', UNKNOWN: 'UNKNOWN' };
/** red only for near liquidation and worse */
export const LEVEL_COLOR: Record<AlertLevel, string> = { SAFE: 'var(--cyan)', WATCH: 'var(--amber)', NEAR: 'var(--red)', LIQ: 'var(--red)', UNKNOWN: 'var(--slate)' };
