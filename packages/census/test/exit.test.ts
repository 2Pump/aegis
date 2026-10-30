import { describe, expect, it } from 'vitest';
import { EXIT, exitEstimate, reachBps } from '../src/exit.js';
import type { DepthLatest, MarketDepth } from '../src/depth.js';

const NOW = Date.parse('2026-10-30T00:30:00Z');
const now = (o: Partial<MarketDepth> = {}): MarketDepth => ({
  p: 2, s: 'BTC-PERP', oracle: 100, bid: 99.99, ask: 100.01, mid: 100, spreadBps: 2, markOracleBps: 0,
  // USD within 10 / 50 / 100 / 200 bps
  bidUsd: [100_000, 1_000_000, 2_000_000, 4_000_000], askUsd: [50_000, 400_000, 800_000, 1_600_000],
  n: [100, 100], unitsOk: true, clipped: false, ...o,
});
const market = (o: Partial<DepthLatest['markets'][number]> = {}): DepthLatest['markets'][number] => ({
  p: 2, s: 'BTC-PERP', at: '2026-10-30T00:25:00Z', now: now(), hist: [[1, 2, 1_000_000, 400_000, 0], [2, 2, 600_000, 300_000, 0]], ...o,
});

describe('exit risk (estimate)', () => {
  it('a long sells into the bids, a short buys from the asks', () => {
    const l = exitEstimate({ notionalUsd: 10_000, long: true, market: market(), nowMs: NOW });
    const s = exitEstimate({ notionalUsd: -10_000, long: false, market: market(), nowMs: NOW });
    expect(l.ok && l.side).toBe('bids');
    expect(s.ok && s.side).toBe('asks');
  });

  it('LOW when small against the book now and at its 24 h thinnest', () => {
    const e = exitEstimate({ notionalUsd: 200_000, long: true, market: market(), nowMs: NOW });
    expect(e.ok && e.level).toBe('LOW'); // 20% of $1M now, under the $600k low
    expect(e.ok && e.low24Usd).toBe(600_000);
  });

  it('MEDIUM when it fits within 2% but is large against the book', () => {
    const e = exitEstimate({ notionalUsd: 700_000, long: true, market: market(), nowMs: NOW });
    expect(e.ok && e.level).toBe('MEDIUM'); // 70% of the 0.5% book
  });

  it('HIGH when the whole book within 2% is smaller than the position', () => {
    const e = exitEstimate({ notionalUsd: 2_000_000, long: false, market: market(), nowMs: NOW });
    expect(e.ok && e.level).toBe('HIGH'); // asks within 2%: $1.6M
    expect(e.ok && e.reachBps).toBeNull();
  });

  it('reach is interpolated between the recorded bands', () => {
    expect(reachBps([100, 1000, 2000, 4000], 550)).toBe(30); // halfway between 10 bps ($100) and 50 bps ($1000)
    expect(reachBps([100, 1000, 2000, 4000], 4001)).toBeNull();
  });

  it('never guesses: missing, empty, stale or unit-failed books are unavailable', () => {
    const cases = [
      exitEstimate({ notionalUsd: 1, long: true, market: undefined, nowMs: NOW }),
      exitEstimate({ notionalUsd: 1, long: true, market: market({ now: now({ mid: null }) }), nowMs: NOW }),
      exitEstimate({ notionalUsd: 1, long: true, market: market({ now: now({ unitsOk: false }) }), nowMs: NOW }),
      exitEstimate({ notionalUsd: 1, long: true, market: market({ at: '2026-10-29T23:00:00Z' }), nowMs: NOW }),
      exitEstimate({ notionalUsd: 0, long: true, market: market(), nowMs: NOW }),
    ];
    for (const c of cases) expect(c.ok).toBe(false);
    expect(EXIT.MAX_AGE_MIN).toBe(30);
  });
});
