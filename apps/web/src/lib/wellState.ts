/**
 * What the well may honestly say about its data right now (pure, unit-tested).
 * Never: zeroes or "no wallets" while the scan is still loading or failed; "PAUSED" when nothing was paused.
 */
import type { CensusSnapshot } from '@aegis/census';
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

/**
 * What the published census itself says about a full re-read. Authoritative only: the snapshot's own `sweep` field
 * (a full sweep that ran out of time and continues on the next hourly run). Never inferred from age or block gap,
 * and it carries no progress count or finish time — so none is shown.
 */
export function fullCensusInProgress(snap: Pick<CensusSnapshot, 'sweep'> | null | undefined): boolean {
  return !!snap && snap.sweep.kind === 'full' && snap.sweep.complete === false;
}

/** Blocks between the completed census snapshot and the live monitor's latest block (two different systems). */
export function snapshotGap(snapBlock: number, liveBlock: number | null): { blocks: number; text: string } | null {
  if (liveBlock === null || !Number.isFinite(liveBlock)) return null;
  const blocks = Math.max(0, liveBlock - snapBlock);
  const h = blocks / 3600;
  return { blocks, text: `${blocks.toLocaleString('en-US')} BLOCKS${blocks >= 90 ? ` (~${h >= 1.5 ? `${h.toFixed(1)} H` : `${Math.round(blocks / 60)} MIN`})` : ''}` };
}

/**
 * What the page may show: a scan that has loaded but isn't in the live layer yet is still LOADING — the counts,
 * filters and near-liquidation list read the live layer, so showing them before it holds the scan would show zeroes.
 */
export function displayPhase(phase: WellPhase, seeded: boolean): WellPhase {
  return (phase.kind === 'ok' || phase.kind === 'empty') && !seeded ? { kind: 'loading' } : phase;
}
