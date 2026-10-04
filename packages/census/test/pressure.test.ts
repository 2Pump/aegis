import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classify, familyOf, type Book } from '@aegis/pose';
import { PressureAcc, STRESS, clampQuery, pressureCurve, queryPressure, shareText, stressLevel, type PressureSnapshot } from '../src/index.js';
import { fileStore, runCensus } from '../src/node/index.js';
import { fakeChain } from './fakeChain.js';

const HEAD = 57_200_000;

/** Tydro-only borrower: WETH collateral, USDC debt, liquidation threshold 0.8 → hf = 0.8 × supply / debt */
function borrower(supply: number, debt: number, source: Book['source'] = 'LIVE', i = 0): Book {
  const leg = (symbol: string, usd: number) => ({ symbol, ...familyOf(symbol), amount: usd, usd, priceUsd: 1, priceSource: 'FIXTURE' as const });
  return {
    address: `0x${(i + 1).toString(16).padStart(40, '0')}`,
    source,
    tydro: { status: 'OK', asOfTime: 0, asOfBlock: 1, data: { hf: (0.8 * supply) / debt, supplies: [leg('WETH', supply)], debts: [leg('USDC', debt)], totalCollateralUsd: supply, totalDebtUsd: debt, usdNet: supply - debt, liquidationThreshold: 0.8, notes: [] } },
    nado: { status: 'OK', asOfTime: 0, asOfBlock: 1, data: { subaccounts: [], equityUsd: 0, spots: [], perps: [], maintenance: null, initial: null, unweighted: null, funding: [], notes: [] } },
    asOfBlock: 1,
    asOfTime: 0,
  };
}

function snap(books: Array<[Book, '1–10k' | '<1k' | '100k+' | '10–100k']>, at = new Date().toISOString()): PressureSnapshot {
  const acc = new PressureAcc();
  for (const [b, band] of books) acc.add(b, classify(b), band);
  return acc.toSnapshot({ block: 123, at, rulesVersion: 'v1.2.0' });
}

describe('Pressure Map aggregates', () => {
  // ETH down: hf 1.6 → Watch 7%, Near 22%, Liq 38%. hf 1.3 → Watch 0, Near 4%, Liq 19%.
  const ten = Array.from({ length: 10 }, (_, i) => borrower(10_000, 5_000, 'LIVE', i));
  const close = Array.from({ length: 6 }, (_, i) => borrower(10_000, 6_154, 'LIVE', 100 + i));
  const s = snap([...ten.map((b) => [b, '1–10k'] as [Book, '1–10k']), ...close.map((b) => [b, '1–10k'] as [Book, '1–10k'])]);

  it('counts transitions at a move: nobody moves at −5% except the close ones into Near', () => {
    const r = queryPressure(s, { dir: 'ETH', sign: 'down', pct: 5, material: '0', dim: '*' });
    expect(r.population).toBe(16);
    expect(r.now).toEqual({ S: 10, W: 6, N: 0, L: 0 });
    expect(r.watchToNear).toBe(6);
    expect(r.safeToWatch).toBe(0);
    expect(r.nearUnder).toBe(6);
  });
  it('at −25%: the ten go Safe → Near; at −40% everyone is liquidatable', () => {
    expect(queryPressure(s, { dir: 'ETH', sign: 'down', pct: 25, material: '0', dim: '*' }).safeToNear).toBe(10);
    const r40 = queryPressure(s, { dir: 'ETH', sign: 'down', pct: 40, material: '0', dim: '*' });
    expect(r40.liquidatableUnder).toBe(16);
    expect(r40.newlyLiquidatable).toBe(16);
  });
  it('a move the wallets have no exposure to changes nothing', () => {
    const r = queryPressure(s, { dir: 'BTC', sign: 'down', pct: 50, material: '0', dim: '*' });
    expect(r.affected).toBe(0);
  });
  it('the pressure curve rises with the move and never falls', () => {
    const c = pressureCurve(s, { dir: 'ETH', sign: 'down', material: '0', dim: '*' });
    expect(c[0]!.near).toBe(0);
    for (let i = 1; i < c.length; i++) expect(c[i]!.near).toBeGreaterThanOrEqual(c[i - 1]!.near);
  });
  it('material floors: small wallets are counted under "All wallets" and dropped, visibly, under "At least $10,000"', () => {
    const t = snap([
      [borrower(10_000, 6_154, 'LIVE', 1), '<1k'],
      [borrower(10_000, 6_154, 'LIVE', 2), '<1k'],
      [borrower(10_000, 6_154, 'LIVE', 3), '100k+'],
    ]);
    expect(queryPressure(t, { dir: 'ETH', sign: 'down', pct: 10, material: '0', dim: '*' }).nearUnder).toBe(3);
    expect(queryPressure(t, { dir: 'ETH', sign: 'down', pct: 10, material: '10k', dim: '*' }).nearUnder).toBe(1);
    expect(queryPressure(t, { dir: 'ETH', sign: 'down', pct: 10, material: '100k', dim: '*' }).population).toBe(1);
  });
  it('privacy: a cell with fewer than 5 wallets has its moves rounded up to 10%', () => {
    const t = snap([[borrower(10_000, 6_154, 'LIVE', 1), '100k+']]);
    const k = 'ETH|down|W|N|100k|*';
    expect(t.coarse).toContain(k);
    expect(t.hist[k]).toEqual([[10, 1]]); // the real move is 4%; published as "by 10%"
  });
  it('test wallets never enter real aggregates', () => {
    const t = snap([[borrower(10_000, 5_000, 'FIXTURE', 1), '1–10k']]);
    expect(t.population.drawn).toBe(0);
    expect(Object.keys(t.hist)).toHaveLength(0);
  });
  it('publishes no addresses, balances or health factors', () => {
    const json = JSON.stringify(s);
    expect(json).not.toMatch(/0x[0-9a-f]{40}/i);
    expect(json).not.toMatch(/\$|usd|hf|health/i);
  });
  it('validates and clamps the URL query', () => {
    expect(clampQuery({ dir: 'NOPE', sign: 'sideways' as never, pct: 999, material: 'lots' as never, dim: '<script>' })).toEqual({ dir: 'CRYPTO', sign: 'down', pct: 50, material: '1k', dim: '*' });
    expect(clampQuery({ dir: 'USD', sign: 'up', pct: -4 })).toMatchObject({ dir: 'USD', sign: 'down', pct: 0 });
    expect(clampQuery({ dir: 'ETH', sign: 'up', pct: 12.6, material: '100k', dim: 't:LOCKED' })).toEqual({ dir: 'ETH', sign: 'up', pct: 13, material: '100k', dim: 't:LOCKED' });
  });
});

describe('Ink Stress Level', () => {
  const fresh = new Date().toISOString();
  const pop = (safe: number, nearNow: number, closeNear: number) => {
    const books: Array<[Book, '1–10k']> = [];
    let i = 0;
    for (let k = 0; k < safe; k++) books.push([borrower(10_000, 2_000, 'LIVE', i++), '1–10k']); // hf 4: far from anything
    for (let k = 0; k < nearNow; k++) books.push([borrower(10_000, 7_300, 'LIVE', i++), '1–10k']); // hf 1.10: near now
    for (let k = 0; k < closeNear; k++) books.push([borrower(10_000, 6_154, 'LIVE', i++), '1–10k']); // near at −4% ETH
    return snap(books, fresh);
  };
  // the stress move is ALL crypto −10%; ETH is crypto, so the "close" wallets count in near10
  const ctx = { nowMs: Date.now(), oiCoverage: 0.94 };
  it('CALM below every line', () => expect(stressLevel(pop(100, 0, 2), ctx).level).toBe('CALM'));
  it('two wallets that are near now AND liquidatable at −10% crypto already make it ELEVATED (liq10 ≥ 1%)', () => expect(stressLevel(pop(100, 2, 0), ctx).level).toBe('ELEVATED'));
  it(`ELEVATED at ${STRESS.LEVELS[2].near * 100}% near now`, () => expect(stressLevel(pop(97, 3, 0), ctx).level).toBe('ELEVATED'));
  it(`HIGH at ${STRESS.LEVELS[1].near * 100}% near now`, () => expect(stressLevel(pop(92, 8, 0), ctx).level).toBe('HIGH'));
  it(`CRITICAL at ${STRESS.LEVELS[0].near * 100}% near now`, () => expect(stressLevel(pop(85, 15, 0), ctx).level).toBe('CRITICAL'));
  it(`ELEVATED / HIGH / CRITICAL from the −10% move alone (${STRESS.LEVELS.map((l) => l.near10 * 100).join(' / ')}%)`, () => {
    expect(stressLevel(pop(94, 0, 6), ctx).level).toBe('ELEVATED');
    expect(stressLevel(pop(85, 0, 15), ctx).level).toBe('HIGH');
    expect(stressLevel(pop(70, 0, 30), ctx).level).toBe('CRITICAL');
  });
  it('says why, and lowers confidence for stale data, low coverage, or no population', () => {
    const r = stressLevel(pop(92, 8, 0), ctx);
    expect(r.why.join(' ')).toMatch(/8\.0% are near liquidation now/);
    expect(r.confidence).toBe('NORMAL');
    expect(stressLevel(pop(92, 8, 0), { nowMs: Date.now() + 13 * 3_600_000, oiCoverage: 0.94 }).confidence).toBe('REDUCED');
    expect(stressLevel(pop(92, 8, 0), { nowMs: Date.now(), oiCoverage: 0.46 }).confidenceWhy.join(' ')).toMatch(/coverage 46\.0%/);
    expect(stressLevel(snap([], fresh), ctx).confidence).toBe('REDUCED');
  });
  it('the share text carries counts and labels, never a balance or an address', () => {
    const s = pop(92, 8, 0);
    const q = { dir: 'CRYPTO', sign: 'down' as const, pct: 10, material: '1k' as const, dim: '*' };
    const t = shareText(s, q, stressLevel(s, ctx), 'https://aegis-web-lake.vercel.app/pressure?d=CRYPTO&s=down&p=10');
    expect(t).toMatch(/simulation, not a prediction/);
    // the only dollar figure allowed is the size floor's own label ("at least $1,000"), never a balance
    expect(t.replace(/at least \$[\d,]+/gi, '')).not.toMatch(/\$\s?\d/);
    expect(t).not.toMatch(/0x[0-9a-f]{40}/i);
  });
});

describe('census full sweep writes pressure.json', () => {
  it('only on a one-block full sweep, with aggregates only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aegis-pressure-'));
    const store = fileStore(dir);
    const logs: string[] = [];
    await runCensus({ scanPaceMs: 0, explorer: false, client: fakeChain({ head: HEAD }).client, store, log: (m) => logs.push(m) });
    const p = (await store.get('pressure.json')) as PressureSnapshot | null;
    expect(p).not.toBeNull();
    expect(p!.engine).toMatch(/^pressure-/);
    expect(p!.population.drawn).toBeGreaterThan(0);
    expect(JSON.stringify(p)).not.toMatch(/0x[0-9a-f]{40}/i);
    expect(logs.some((l) => l.startsWith('pressure map: '))).toBe(true);
  });
});
