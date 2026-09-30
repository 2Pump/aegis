import { describe, expect, it } from 'vitest';
import { HULL_RING, SECTORS, buildThreads, seatShip, seatSphere, sphereFineMix, sphereGlyphScale, sphereHud, sphereLod, orbitGlyph, type ShipLite } from '../src/index.js';

const addr = (i: number) => `0x${i.toString(16).padStart(40, '0')}`;
const ship = (i: number, extra: Partial<ShipLite> = {}): ShipLite => ({ address: addr(i), primary: 'LOCKED', tags: ['LOCKED'], hullTemp: 'NOMINAL', band: '<1k', ...extra });

describe('hull sphere — seats', () => {
  it('same address → same seat; bearing and radius identical to the 2D well', () => {
    for (let i = 0; i < 500; i++) {
      const s = ship(i, { primary: i % 2 ? 'CARRY' : 'HOLD', tags: [i % 2 ? 'CARRY' : 'HOLD'], hullTemp: (['NOMINAL', 'ELEVATED', 'CRITICAL', 'UNKNOWN'] as const)[i % 4] });
      const a = seatSphere(s), b = seatSphere(s), g = seatShip(s);
      expect([a.x, a.y, a.z]).toEqual([b.x, b.y, b.z]);
      expect((a.lon * 180) / Math.PI).toBeCloseTo(g.deg, 9);
      expect(a.r).toBeCloseTo(g.r, 12);
      expect(Math.hypot(a.x, a.y, a.z)).toBeCloseTo(a.r, 9);
    }
  });
  it('longitude stays inside the pose lune; radius inside the hull-temp shell; poles kept clear', () => {
    for (let i = 0; i < 2000; i++) {
      const temp = (['NOMINAL', 'ELEVATED', 'CRITICAL'] as const)[i % 3]!;
      const s = seatSphere(ship(i, { primary: 'NAKED', tags: ['NAKED'], hullTemp: temp }));
      const deg = (s.lon * 180) / Math.PI;
      expect(deg).toBeGreaterThan(SECTORS.NAKED[0]);
      expect(deg).toBeLessThan(SECTORS.NAKED[1]);
      expect(s.r).toBeGreaterThanOrEqual(HULL_RING[temp][0]);
      expect(s.r).toBeLessThanOrEqual(HULL_RING[temp][1]);
      expect(Math.abs(Math.sin(s.lat))).toBeLessThanOrEqual(0.9 + 1e-12);
    }
  });
  it('WOUNDED is a ring, never a lune; a wounded-as-main ship sits in the last lune, not coloured red', () => {
    const w = seatSphere(ship(1, { primary: 'WOUNDED', tags: ['WOUNDED'], hullTemp: 'CRITICAL' }));
    expect(w.sector).toBe('OTHER');
    expect(w.wounded).toBe(true);
    expect(w.color.toUpperCase()).not.toBe('#FF4D4D');
  });
  it('orbit glyph budget: phones draw only ≥$10k and wounded ≥$1k', () => {
    const big = seatSphere(ship(2, { band: '10–100k' }));
    const hot = seatSphere(ship(3, { band: '1–10k', tags: ['LOCKED', 'WOUNDED'], hullTemp: 'CRITICAL' }));
    const warn = seatSphere(ship(4, { band: '1–10k', hullTemp: 'ELEVATED' }));
    expect([orbitGlyph(big, true), orbitGlyph(hot, true), orbitGlyph(warn, true)]).toEqual([true, true, false]);
    expect(orbitGlyph(warn, false)).toBe(true);
  });
});

describe('hull sphere — threads', () => {
  const seats = Array.from({ length: 3000 }, (_, i) => seatSphere(ship(i, { primary: i % 3 === 0 ? 'HOLD' : 'LOCKED', tags: [i % 3 === 0 ? 'HOLD' : 'LOCKED'] })));
  it('only between the same pose, within the length limit, capped, deterministic', () => {
    const a = buildThreads(seats, { k: 3, maxLen: 0.12, cap: 1500 });
    const b = buildThreads(seats, { k: 3, maxLen: 0.12, cap: 1500 });
    expect(a).toEqual(b);
    expect(a.length).toBeLessThanOrEqual(1500);
    expect(a.length).toBeGreaterThan(100);
    for (const [i, j] of a) {
      expect(seats[i]!.sector).toBe(seats[j]!.sector);
      expect(Math.hypot(seats[i]!.x - seats[j]!.x, seats[i]!.y - seats[j]!.y, seats[i]!.z - seats[j]!.z)).toBeLessThan(0.12);
    }
  });
  it('the order never depends on risk: re-labelling ships as wounded does not change the threads', () => {
    const calm = buildThreads(seats, { k: 2, maxLen: 0.1, cap: 800 });
    const hurt = buildThreads(seats.map((s, i) => (i % 5 ? s : { ...s, wounded: true, hot: true })), { k: 2, maxLen: 0.1, cap: 800 });
    expect(hurt).toEqual(calm);
  });
});

describe('hull sphere — camera', () => {
  it('LOD bands and the HUD line', () => {
    expect(sphereLod(0.7, false)).toBe('HAZE');
    expect(sphereLod(1, false)).toBe('MANTLE');
    expect(sphereLod(3, false)).toBe('TISSUE');
    expect(sphereLod(1, true)).toBe('NODE');
    expect(sphereFineMix(1)).toBe(0);
    expect(sphereFineMix(3)).toBe(1);
    expect(sphereGlyphScale(1)).toBe(1);
    expect(sphereGlyphScale(20)).toBeLessThan(0.3);
    expect(sphereHud({ az: 214.2, el: 18.4, r: 0.6234, zoom: 3.4, lod: 'TISSUE' })).toBe('AZ 214°  EL 18°  DEPTH 0.62  ZOOM 3.4×');
    expect(sphereHud({ az: -10, el: -5, r: null, zoom: 1, lod: 'MANTLE' })).toBe('AZ 350°  EL -05°  DEPTH -.--  ZOOM 1.0×');
  });
});
