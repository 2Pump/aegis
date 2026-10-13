import { describe, expect, it } from 'vitest';
import { DEPTH, appendRun, runLine, summarizeBook, updateStatus, type DepthRun } from '../src/depth.js';

const E18 = 10n ** 18n;
const lvl = (price: number, size: number) => ({ price, size, raw: BigInt(Math.round(size * 1000)) * (E18 / 1000n) });
const INC = E18 / 1000n; // 0.001 base

describe('market depth summary', () => {
  const bids = [lvl(99.95, 2), lvl(99.6, 5), lvl(99, 10), lvl(97, 50)];
  const asks = [lvl(100.05, 1), lvl(100.4, 4), lvl(101.5, 10), lvl(103, 50)];
  const m = summarizeBook({ productId: 2, symbol: 'BTC-PERP', oracle: 99.9, sizeIncrement: INC, bids, asks });

  it('spread, mid and mark vs oracle', () => {
    expect(m.mid).toBe(100);
    expect(m.spreadBps).toBe(10);
    expect(m.markOracleBps).toBe(10.01);
  });

  it('USD within 10 / 50 / 100 / 200 bps of the mid, per side', () => {
    // bids: 99.95 is inside 10 bps (≥ 99.9); 99.6 inside 50; 99 inside 100; 97 is past 200 bps (98)
    expect(m.bidUsd).toEqual([200, 698, 1688, 1688]);
    // asks: 100.05 inside 10 bps (≤ 100.1); 100.4 inside 50; 101.5 inside 200 only; 103 past 200
    expect(m.askUsd).toEqual([100, 502, 502, 1517]);
    expect(m.bidUsd).toHaveLength(DEPTH.BANDS_BPS.length);
  });

  it('checks its own units against the on-chain size increment', () => {
    expect(m.unitsOk).toBe(true);
    const odd = summarizeBook({ productId: 2, symbol: 'X', oracle: 100, sizeIncrement: INC, bids: [{ price: 99, size: 1, raw: 1234n }], asks: asks });
    expect(odd.unitsOk).toBe(false);
  });

  it('an empty or crossed book has no mid and no depth — never a made-up number', () => {
    const e = summarizeBook({ productId: 9, symbol: 'Y', oracle: 5, sizeIncrement: INC, bids: [], asks: [] });
    expect([e.mid, e.spreadBps, e.markOracleBps]).toEqual([null, null, null]);
    expect(e.bidUsd).toEqual([0, 0, 0, 0]);
  });

  it('flags a band that may be undercounted because the reply hit the level limit', () => {
    const c = summarizeBook({ productId: 2, symbol: 'Z', oracle: 100, sizeIncrement: INC, bids: [lvl(99.9, 1), lvl(99.8, 1)], asks: [lvl(100.1, 1), lvl(100.2, 1)], levelsAsked: 2 });
    expect(c.clipped).toBe(true);
    expect(m.clipped).toBe(false);
  });
});

describe('depth history files', () => {
  const run = (at: string, answered: number, refused = 0): DepthRun => ({ at, block: 1, asked: answered + refused, answered, refused, failed: 0, reason: refused ? 'BTC-PERP: HTTP 403 (Cloudflare page)' : null, markets: [] });

  it('a day file only grows; a new day starts a new file', () => {
    const a = appendRun(null, run('2026-10-13T00:10:00Z', 30));
    const b = appendRun(a, run('2026-10-13T00:20:00Z', 30));
    expect(b.runs).toHaveLength(2);
    expect(appendRun(b, run('2026-10-14T00:00:00Z', 30)).runs).toHaveLength(1);
  });

  it('status keeps per-day reachability and the last run', () => {
    let s = updateStatus(null, run('2026-10-13T00:10:00Z', 30));
    s = updateStatus(s, run('2026-10-13T00:20:00Z', 0, 30));
    expect(s.days['2026-10-13']).toEqual({ runs: 2, asked: 60, answered: 30, refused: 30, failed: 0 });
    expect(s.last?.reason).toContain('Cloudflare');
    expect(runLine(run('2026-10-13T00:20:00Z', 0, 30))).toBe('depth: 0/30 books answered (0%) · 30 refused by Nado · first reason: BTC-PERP: HTTP 403 (Cloudflare page)');
  });

  it('holds market data only — no wallet, account or position fields', () => {
    const m = summarizeBook({ productId: 2, symbol: 'BTC-PERP', oracle: 100, sizeIncrement: INC, bids: [lvl(99, 1)], asks: [lvl(101, 1)] });
    expect(Object.keys(m).sort()).toEqual(['ask', 'askUsd', 'bid', 'bidUsd', 'clipped', 'markOracleBps', 'mid', 'n', 'oracle', 'p', 's', 'spreadBps', 'unitsOk']);
  });
});
