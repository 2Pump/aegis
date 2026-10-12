import { describe, expect, it } from 'vitest';
import { priceStep, priceStepText } from './replay';

const H = 3_600_000;
const T = Date.UTC(2026, 9, 10, 12);
const pt = (at: number, p: Record<string, number>) => ({ block: at / 1000, at, p });
const names = new Map([[12, 'XPL']]);
const when = (ms: number) => new Date(ms).toISOString().slice(11, 16);

describe('cascade replay — oracle price step', () => {
  it('before any recorded price: says so, never "not recorded yet" for later cascades', () => {
    expect(priceStep([pt(T, { 'tydro:WETH': 2500 })], T - 48 * H, T - 47 * H, names).kind).toBe('before-recording');
    expect(priceStepText({ kind: 'before-recording' }, when)).toContain('before Phrourax started recording');
  });
  it('names the largest moves between the readings just before and just after, by symbol', () => {
    const s = priceStep([pt(T - H, { 'tydro:WETH': 2500, 'nado:12': 0.5, 'tydro:USDC': 1, 'pyth:ETH': 1 }), pt(T + H, { 'tydro:WETH': 2450, 'nado:12': 0.44, 'tydro:USDC': 1, 'pyth:ETH': 9 })], T - 10 * 60_000, T + 20 * 60_000, names);
    expect(s.kind).toBe('moves');
    const text = priceStepText(s, when);
    expect(text).toContain('XPL −12.0% · WETH −2.0%');
    expect(text).not.toContain('USDC');
    expect(text).not.toContain('ETH +'); // the external reference isn't a protocol price
  });
  it('a cascade centred on one family shows that family\'s prices first (even small moves), then the largest elsewhere', () => {
    const s = priceStep(
      [pt(T - H, { 'tydro:WETH': 2500, 'nado:4': 2501, 'nado:30': 10 }), pt(T + H, { 'tydro:WETH': 2470, 'nado:4': 2468, 'nado:30': 10.5 })],
      T, T, new Map([[4, 'ETH-PERP'], [30, 'ZEC-PERP']]), { family: 'ETH', share: 0.75 },
    );
    const text = priceStepText(s, when);
    expect(text).toMatch(/^ETH family \(75% of these liquidations\), .*: ETH-PERP −1\.3% · WETH −1\.2%\. Largest moves elsewhere: ZEC-PERP \+5\.0%$/);
  });
  it('no reading near enough: says so instead of guessing; flat: says nothing moved', () => {
    expect(priceStep([pt(T - 5 * H, { 'tydro:WETH': 1 }), pt(T + 5 * H, { 'tydro:WETH': 2 })], T, T, names).kind).toBe('no-readings');
    expect(priceStep([pt(T - H, { 'tydro:WETH': 2500 }), pt(T + H, { 'tydro:WETH': 2500.5 })], T, T, names).kind).toBe('flat');
  });
});
