import { describe, expect, it } from 'vitest';
import type { CensusShip, CensusSnapshot } from '@aegis/census';
import { fullCensusInProgress, liveBadge, snapshotGap, wellPhase, SCAN_STALE_H } from './wellState';
import type { CensusState } from './census';

const NOW = Date.parse('2026-10-04T12:00:00Z');
const snap = (drawn: number, at = '2026-10-04T11:30:00Z') => ({ generatedAt: at, counts: { drawn } }) as unknown as CensusSnapshot;
const ship = (primary: string) => ({ primary }) as unknown as CensusShip;
const ok = (drawn: number, extra: Partial<Extract<CensusState, { status: 'ok' }>> = {}, at?: string): CensusState => ({ status: 'ok', snap: snap(drawn, at), ships: drawn ? [ship('CARRY')] : [], loadedAt: NOW, ...extra });

describe('well loading states — never a false zero', () => {
  it('loading → LOADING, not empty, not zero', () => expect(wellPhase({ status: 'loading' }, NOW)).toEqual({ kind: 'loading' }));
  it('failed with nothing loaded → UNAVAILABLE with the reason (not zero wallets)', () => {
    expect(wellPhase({ status: 'error', message: 'HTTP 500' }, NOW)).toEqual({ kind: 'unavailable', message: 'HTTP 500' });
    expect(wellPhase({ status: 'missing', message: 'no census yet' }, NOW).kind).toBe('unavailable');
  });
  it('a scan that really holds no wallets is the only EMPTY', () => expect(wellPhase(ok(0), NOW).kind).toBe('empty'));
  it('fresh scan → OK, not stale', () => expect(wellPhase(ok(5), NOW)).toMatchObject({ kind: 'ok', stale: false, lastGood: false }));
  it(`scan older than ${SCAN_STALE_H} h → STALE`, () => expect(wellPhase(ok(5, {}, '2026-10-04T07:00:00Z'), NOW)).toMatchObject({ kind: 'ok', stale: true }));
  it('a refresh that failed keeps the last good scan, labelled', () =>
    expect(wellPhase(ok(5, { refreshError: 'HTTP 503' }), NOW)).toMatchObject({ kind: 'ok', lastGood: true, refreshError: 'HTTP 503' }));
});

describe('live badge — PAUSED only when actually paused', () => {
  const b = (o: Partial<Parameters<typeof liveBadge>[0]>) => liveBadge({ running: false, wantLive: true, visible: true, phase: 'ok', ...o }).text;
  it('loading → WAITING FOR SCAN', () => expect(b({ phase: 'loading' })).toBe('WAITING FOR SCAN'));
  it('user paused → PAUSED', () => expect(b({ wantLive: false })).toBe('PAUSED'));
  it('hidden tab → PAUSED · TAB HIDDEN', () => expect(b({ visible: false })).toBe('PAUSED · TAB HIDDEN'));
  it('running → LIVE', () => expect(b({ running: true })).toBe('LIVE'));
  it('no scan → NO SCAN', () => expect(b({ phase: 'unavailable' })).toBe('NO SCAN'));
});

describe('census status — only from authoritative snapshot metadata', () => {
  const sweep = (kind: 'full' | 'incremental', complete?: boolean) => ({ sweep: { kind, complete, reread: 1, carried: 1, ms: 1 } });
  it('FULL CENSUS IN PROGRESS only when the snapshot itself says a full sweep is part-way', () => {
    expect(fullCensusInProgress(sweep('full', false))).toBe(true);
    expect(fullCensusInProgress(sweep('full', true))).toBe(false);
    expect(fullCensusInProgress(sweep('incremental', true))).toBe(false);
    expect(fullCensusInProgress(null)).toBe(false);
  });
  it('a big snapshot gap alone never means a census is running', () => {
    expect(fullCensusInProgress(sweep('incremental', true))).toBe(false);
    expect(snapshotGap(57_728_710, 57_740_274)).toEqual({ blocks: 11_564, text: '11,564 BLOCKS (~3.2 H)' });
    expect(snapshotGap(100, 130)!.text).toBe('30 BLOCKS');
    expect(snapshotGap(100, null)).toBeNull();
  });
});
