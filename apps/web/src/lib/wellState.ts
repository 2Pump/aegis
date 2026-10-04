/**
 * What the well may honestly say about its data right now (pure, unit-tested).
 * Never: zeroes or "no wallets" while the scan is still loading or failed; "PAUSED" when nothing was paused.
 */
import type { CensusState } from './census';

/** An hourly scan older than this is labelled STALE (two missed runs plus slack). */
export const SCAN_STALE_H = 3;

export type WellPhase =
  | { kind: 'loading' }
  /** no scan could be loaded at all — never shown as zero wallets */
  | { kind: 'unavailable'; message: string }
  /** a scan loaded but holds no wallets (the only time "no wallets" may be said) */
  | { kind: 'empty' }
  /** lastGood: a newer load failed and this is the last good scan, labelled as such */
  | { kind: 'ok'; ageH: number | null; stale: boolean; lastGood: boolean; refreshError: string | null };

export function wellPhase(c: CensusState, nowMs: number): WellPhase {
  if (c.status === 'loading') return { kind: 'loading' };
  if (c.status === 'missing' || c.status === 'error') return { kind: 'unavailable', message: c.message };
  if (c.snap.counts.drawn === 0 && c.ships.every((s) => s.primary === 'EMPTY')) return { kind: 'empty' };
  const t = Date.parse(c.snap.generatedAt);
  const ageH = Number.isFinite(t) ? Math.max(0, (nowMs - t) / 3_600_000) : null;
  return { kind: 'ok', ageH, stale: ageH === null || ageH > SCAN_STALE_H, lastGood: !!c.refreshError, refreshError: c.refreshError ?? null };
}

/** The live-layer badge: PAUSED only when someone (or a hidden tab) actually paused it. */
export function liveBadge(o: { running: boolean; wantLive: boolean; visible: boolean; phase: WellPhase['kind'] }): { text: string; on: boolean } {
  if (o.running) return { text: 'LIVE', on: true };
  if (!o.wantLive) return { text: 'PAUSED', on: false };
  if (!o.visible) return { text: 'PAUSED · TAB HIDDEN', on: false };
  if (o.phase === 'loading') return { text: 'WAITING FOR SCAN', on: false };
  if (o.phase === 'unavailable') return { text: 'NO SCAN', on: false };
  return { text: 'STARTING', on: false };
}
