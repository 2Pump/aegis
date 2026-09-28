import { describe, expect, it } from 'vitest';
import { classify, type Book } from '@aegis/pose';
import { hullSigilSvg, placeShips, sizeBand, summaryText } from '../src/index.js';
import carry from '../../../fixtures/carry.json';
import wounded from '../../../fixtures/wounded.json';

const pc = classify(carry as unknown as Book);
const pw = classify(wounded as unknown as Book);

describe('glyphs', () => {
  it('positions are deterministic per address', () => {
    const a = placeShips([{ address: carry.address, pose: pc }])[0]!;
    const b = placeShips([{ address: carry.address, pose: pc }])[0]!;
    expect(a.angle).toBe(b.angle);
    expect(a.r).toBe(b.r);
  });
  it('WOUNDED falls inward', () => {
    const [n, w] = placeShips([
      { address: carry.address, pose: pc },
      { address: wounded.address, pose: pw },
    ]);
    expect(w!.r).toBeLessThan(n!.r);
    expect(w!.pulse).toBe(true);
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
    expect(s).toContain('CARRY');
    expect(s).toContain('HULL NOMINAL');
    expect(s).not.toMatch(/\$/);
  });
});
