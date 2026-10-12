import { describe, expect, it } from 'vitest';
import { classify, type Book } from '@aegis/pose';
import { buildGrid, hitTest, hullSigilSvg, placeShips, shipLiteFromPose, shipXY, sizeBand, summaryText, wellView, type ShipLite } from '../src/index.js';
import { tagColor } from '../src/index.js';
import carry from '../../../fixtures/carry.json';
import wounded from '../../../fixtures/wounded.json';

const pc = classify(carry as unknown as Book);
const pw = classify(wounded as unknown as Book);

describe('glyphs', () => {
  it('positions are deterministic per address', () => {
    const a = placeShips([shipLiteFromPose(carry.address, pc)])[0]!;
    const b = placeShips([shipLiteFromPose(carry.address, pc)])[0]!;
    expect(a.angle).toBe(b.angle);
    expect(a.r).toBe(b.r);
  });
  it('WOUNDED falls inward and pulses', () => {
    const [n, w] = placeShips([shipLiteFromPose(carry.address, pc), shipLiteFromPose(wounded.address, pw)]);
    expect(w!.r).toBeLessThan(n!.r);
    expect(w!.pulse).toBe(true);
  });
  it('a wounded ship keeps its pose color and gets a red ring instead', () => {
    const [, w] = placeShips([shipLiteFromPose(carry.address, pc), shipLiteFromPose(wounded.address, pw)]);
    expect(pw.primary).toBe('CARRY'); // fixture: CARRY + WOUNDED
    expect(w!.color).toBe(tagColor('CARRY'));
    expect(w!.wounded).toBe(true);
  });
  it('two addresses → two different sigils', () => {
    expect(hullSigilSvg(carry.address, pc)).not.toBe(hullSigilSvg(wounded.address, pc));
  });
  it('size bands', () => {
    expect(sizeBand(5)).toBe('dust');
    expect(sizeBand(999)).toBe('<1k');
    expect(sizeBand(10_000)).toBe('10–100k');
    expect(sizeBand(250_000)).toBe('100k+');
  });
  it('share text carries no dollar figures', () => {
    const s = summaryText(carry.address, pc, { tydro: true, nado: true }, 'https://x/hull/0x');
    expect(s).toContain('Hedged');
    expect(s).toContain('Risk: Safe');
    expect(s).not.toMatch(/\$/);
  });
  it('grid hit-test finds the right ship among 20,000, fast', () => {
    const ships: ShipLite[] = Array.from({ length: 20_000 }, (_, i) => ({
      address: `0x${i.toString(16).padStart(40, '0')}`,
      primary: 'LOCKED',
      tags: ['LOCKED'],
      hullTemp: 'NOMINAL',
      band: '<1k',
    }));
    const placed = placeShips(ships);
    const v = wellView(800, 800);
    const t0 = performance.now();
    const grid = buildGrid(placed, v);
    const target = placed[12_345]!;
    const [x, y] = shipXY(target, v);
    const hit = hitTest(grid, x, y);
    expect(performance.now() - t0).toBeLessThan(200);
    expect(hit).not.toBeNull();
    const [hx, hy] = shipXY(hit!, v);
    expect(Math.hypot(hx - x, hy - y)).toBeLessThan(1);
  });
});

describe('legacy brand text (display only)', () => {
  it('translates human-readable values, never keys or lowercase identifiers', async () => {
    const { brandJson, brandText, hasLegacyBrand } = await import('../src/brand');
    expect(brandText("on-chain; AEGIS reads FQuerier · Aegis bot · AEGIS's list")).toBe("on-chain; PHROURAX reads FQuerier · Phrourax bot · PHROURAX's list");
    const raw = { kind: 'aegis-verify-log', aegis: { why: 'before AEGIS began recording' }, AEGIS_KEY: 1, rows: [['0xabc', 'AEGIS couldn\'t read Nado', 3]], schema: 'aegis-api-1' };
    const out = brandJson(raw);
    expect(out).toEqual({ kind: 'aegis-verify-log', aegis: { why: 'before PHROURAX began recording' }, AEGIS_KEY: 1, rows: [['0xabc', "PHROURAX couldn't read Nado", 3]], schema: 'aegis-api-1' });
    expect(raw.aegis.why).toBe('before AEGIS began recording'); // the source object is not mutated
    expect(hasLegacyBrand(JSON.stringify({ kind: 'aegis-changes', aegis: 1 }))).toBe(false);
    expect(hasLegacyBrand('"source": "AEGIS reads FQuerier"')).toBe(true);
  });
});

describe('sharing a wallet (text, card, share page)', () => {
  const A = '0x7BFEe91193d9Df2Ac0bFe90191D40F23c773C060';
  const f = { address: A, tags: ['EQUITY-MARGIN', 'NAKED'] as const, hullTemp: 'NOMINAL' as const, venues: { tydro: true, nado: true }, block: 57812440, at: Date.parse('2026-10-07T14:05:00Z') };
  it('post text: short lines, the link last, no dollar figures', async () => {
    const { shareText } = await import('../src/share');
    expect(shareText({ ...f, tags: [...f.tags] }, 'https://phrourax.com/s/' + A)).toBe(
      ['Phrourax · Ink wallet 0x7BFE…C060', 'Position: Stocks as collateral + Unhedged bet', 'Risk: Safe · Tydro and Nado read OK', 'https://phrourax.com/s/' + A].join('\n'),
    );
  });
  it('near liquidation is the risk line — as a type it only shows when it is the only one', async () => {
    const { shareTypeText } = await import('../src/share');
    expect(shareTypeText(['NAKED', 'WOUNDED'])).toBe('Unhedged bet');
    expect(shareTypeText(['WOUNDED'])).toBe('Near liquidation');
    expect(shareTypeText([])).toBe('Unclassified');
  });
  it('venue wording never claims a read that failed', async () => {
    const { shareVenueText } = await import('../src/share');
    expect(shareVenueText({ tydro: true, nado: false })).toBe("Tydro read OK · Nado couldn't be read");
    expect(shareVenueText({ tydro: false, nado: false })).toBe("Tydro and Nado couldn't be read");
  });
  it('card: 1200×630 SVG with the type, risk, venues and block — no amounts', async () => {
    const { shareCardSvg } = await import('../src/share');
    const svg = shareCardSvg({ ...f, tags: [...f.tags] });
    expect(svg).toMatch(/^<svg[^>]+width="1200" height="630"/);
    for (const t of ['0x7BFE…C060', 'STOCKS AS COLLATERAL', 'UNHEDGED BET', 'SAFE', 'TYDRO', 'NADO', '57,812,440', '2026-10-07 14:05 UTC', 'Read-only · not financial advice']) expect(svg).toContain(t);
    expect(svg).not.toMatch(/\$|health factor|HF /i);
    const unknown = shareCardSvg({ ...f, tags: ['LOCKED'], hullTemp: 'UNKNOWN', venues: { tydro: true, nado: false } });
    expect(unknown).toContain("NADO — couldn't read");
    expect(unknown).toContain('stroke-dasharray');
    expect(shareCardSvg({ ...f, tags: ['LEVERED'], hullTemp: 'CRITICAL' })).toContain('#FF4D4D');
  });
  it('share page: preview tags for crawlers, noindex, and straight on to the wallet page', async () => {
    const { sharePageHtml } = await import('../src/share');
    const h = sharePageHtml({ address: A, facts: { ...f, tags: [...f.tags] }, imageBucket: 7 });
    expect(h).toContain('<meta name="twitter:card" content="summary_large_image" />');
    expect(h).toContain('<meta name="twitter:site" content="@Phrourax" />');
    expect(h).toContain(`<meta property="og:image" content="https://phrourax.com/og/${A}.png?h=7" />`);
    expect(h).toContain('<meta name="robots" content="noindex" />');
    expect(h).toContain(`url=https://phrourax.com/hull/${A}`);
    expect(h).toContain('Risk: Safe');
    // unreadable right now → the site's own card, still forwards
    const g = sharePageHtml({ address: A, facts: null });
    expect(g).toContain('<meta property="og:image" content="https://phrourax.com/og.png" />');
    expect(g).toContain(`/hull/${A}`);
  });
});
