import { describe, expect, it } from 'vitest';
import {
  CAMERA_HOME,
  HULL_RING,
  SECTORS,
  SECTOR_GAP_DEG,
  SECTOR_MIN_ARC_DEG,
  SECTOR_ORDER,
  buildGlassGrid,
  clampCamera,
  frameShip,
  glassGeom,
  hitGlass,
  hudText,
  polarOf,
  snapshotPlacement,
  seatShip,
  seatShips,
  sectorOf,
  toScreen,
  toUnit,
  zoomAt,
  type ShipLite,
} from '../src/index.js';

const addr = (i: number) => `0x${i.toString(16).padStart(40, '0')}`;
const ship = (i: number, extra: Partial<ShipLite> = {}): ShipLite => ({
  address: addr(i),
  primary: 'LOCKED',
  tags: ['LOCKED'],
  hullTemp: 'NOMINAL',
  band: '<1k',
  ...extra,
});

describe('well glass — sectors', () => {
  it('fixed order, every sector at least the minimum arc, full circle', () => {
    expect(SECTOR_ORDER).toEqual(['CARRY', 'EQUITY-MARGIN', 'NAKED', 'KBTC-CORE', 'LEVERED', 'HOLD', 'LOCKED', 'STABLE-BALLAST', 'OTHER']);
    let prevEnd = 0;
    for (const k of SECTOR_ORDER) {
      const [a0, a1] = SECTORS[k];
      expect(a1 - a0).toBeGreaterThanOrEqual(SECTOR_MIN_ARC_DEG - 1e-9);
      expect(a0).toBeGreaterThanOrEqual(prevEnd);
      prevEnd = a1;
    }
    expect(prevEnd + SECTOR_GAP_DEG / 2).toBeCloseTo(360, 6);
    // the big poses get the big arcs; CARRY stays an arc, not a hairline
    const span = (k: (typeof SECTOR_ORDER)[number]) => SECTORS[k][1] - SECTORS[k][0];
    expect(span('STABLE-BALLAST')).toBeGreaterThan(span('NAKED'));
    expect(span('CARRY')).toBeGreaterThanOrEqual(16);
  });

  it('WOUNDED is never a sector: wounded-as-main, DARK, EMPTY and no-rule share the last one', () => {
    expect(sectorOf('WOUNDED')).toBe('OTHER');
    expect(sectorOf('DARK')).toBe('OTHER');
    expect(sectorOf('EMPTY')).toBe('OTHER');
    expect(sectorOf(null)).toBe('OTHER');
    expect(sectorOf('CARRY')).toBe('CARRY');
    const w = seatShip(ship(1, { primary: 'NAKED', tags: ['NAKED', 'WOUNDED'], hullTemp: 'CRITICAL' }));
    expect(w.sector).toBe('NAKED');
    expect(w.wounded).toBe(true);
    expect(w.color).not.toBe('#FF4D4D'); // red is the ring, not the fill
  });
});

describe('well glass — seats', () => {
  it('same address → same seat, every load', () => {
    const a = seatShip(ship(42, { primary: 'CARRY', tags: ['CARRY'] }));
    const b = seatShip(ship(42, { primary: 'CARRY', tags: ['CARRY'] }));
    expect([a.deg, a.r, a.ux, a.uy]).toEqual([b.deg, b.r, b.ux, b.uy]);
  });

  it('bearing stays inside the pose sector; radius keeps the hull-temp ring', () => {
    for (let i = 0; i < 2000; i++) {
      const temp = (['NOMINAL', 'ELEVATED', 'CRITICAL', 'UNKNOWN'] as const)[i % 4]!;
      const s = seatShip(ship(i, { primary: 'HOLD', tags: ['HOLD'], hullTemp: temp }));
      const [a0, a1] = SECTORS.HOLD;
      expect(s.deg).toBeGreaterThan(a0);
      expect(s.deg).toBeLessThan(a1);
      const [lo, hi] = HULL_RING[temp];
      expect(s.r).toBeGreaterThanOrEqual(lo);
      expect(s.r).toBeLessThanOrEqual(hi);
      const p = polarOf(s.ux, s.uy);
      expect(p.deg).toBeCloseTo(s.deg, 6);
      expect(p.r).toBeCloseTo(s.r, 9);
    }
  });

  it('level of detail: ≥$10k everywhere, wounded ≥$1k on desktop; the rest haze + a stable sample', () => {
    expect(seatShip(ship(3, { band: '10–100k' })).lod).toBe(2);
    expect(seatShip(ship(3, { band: '1–10k', tags: ['LOCKED', 'WOUNDED'], hullTemp: 'CRITICAL' })).lod).toBe(1);
    // small wounded books ride the texture sample, so the full-view core stays a basin, not a fused blob
    const smallW = seatShips(Array.from({ length: 1600 }, (_, i) => ship(i, { band: '<1k', tags: ['LOCKED', 'WOUNDED'], hullTemp: 'CRITICAL' })));
    expect(smallW.filter((s) => s.lod > 0).length).toBeLessThan(160);
    expect(seatShip(ship(3, { band: '1–10k', hullTemp: 'ELEVATED' })).lod).toBe(1);
    const many = seatShips(Array.from({ length: 4000 }, (_, i) => ship(i, { band: 'dust' })));
    const sampled = many.filter((s) => s.lod > 0).length;
    expect(sampled).toBeGreaterThan(150); // ~1 in 16 for texture
    expect(sampled).toBeLessThan(400);
  });

  it('seatShips draws small → large', () => {
    const s = seatShips([ship(1, { band: '100k+' }), ship(2, { band: 'dust' }), ship(3, { band: '1–10k' })]);
    expect(s.map((x) => x.band)).toEqual(['dust', '1–10k', '100k+']);
  });
});

describe('well glass — camera', () => {
  const g = glassGeom(900, 760);

  it('screen ↔ unit round-trips at any zoom', () => {
    const c = clampCamera({ zoom: 3.4, fx: 0.2, fy: -0.1 });
    const [x, y] = toScreen(g, c, 0.31, -0.22);
    const [ux, uy] = toUnit(g, c, x, y);
    expect(ux).toBeCloseTo(0.31, 9);
    expect(uy).toBeCloseTo(-0.22, 9);
  });

  it('zoom keeps the point under the cursor fixed; clamp keeps the glass on screen', () => {
    const before = toUnit(g, CAMERA_HOME, 600, 300);
    const c = zoomAt(g, CAMERA_HOME, 600, 300, 2);
    const after = toUnit(g, c, 600, 300);
    expect(after[0]).toBeCloseTo(before[0], 9);
    expect(after[1]).toBeCloseTo(before[1], 9);
    expect(clampCamera({ zoom: 1, fx: 0.5, fy: 0.5 })).toEqual({ zoom: 1, fx: 0, fy: 0 });
    expect(clampCamera({ zoom: 99, fx: 0, fy: 0 }).zoom).toBe(10);
  });

  it('a gesture-frame snapshot lines up with the camera it is shown under', () => {
    const from = clampCamera({ zoom: 2, fx: 0.1, fy: -0.2 });
    const to = clampCamera({ zoom: 3.1, fx: 0.25, fy: -0.05 });
    const { k, dx, dy } = snapshotPlacement(g, from, to);
    for (const [ux, uy] of [[0.3, -0.1], [0.12, 0.05], [-0.2, -0.3]] as const) {
      const [sx1, sy1] = toScreen(g, from, ux, uy);
      const [sx2, sy2] = toScreen(g, to, ux, uy);
      expect(dx + sx1 * k).toBeCloseTo(sx2, 6);
      expect(dy + sy1 * k).toBeCloseTo(sy2, 6);
    }
  });

  it('HUD is an instrument line with no dollar figure', () => {
    expect(hudText({ deg: 214.2, r: 0.6234 }, 3.4)).toBe('AZ 214°  R 0.62  ZOOM 3.4×');
    expect(hudText(null, 1)).toBe('AZ ---°  R -.--  ZOOM 1.0×');
  });

  it('hit-test among 20,000 seats finds the right hull, fast, zoomed in', () => {
    const seats = seatShips(Array.from({ length: 20_000 }, (_, i) => ship(i, { primary: i % 3 ? 'LOCKED' : 'HOLD', tags: [i % 3 ? 'LOCKED' : 'HOLD'] })));
    const t0 = performance.now();
    const grid = buildGlassGrid(seats);
    const target = seats[12_345]!;
    const cam = frameShip(target, 6);
    const [x, y] = toScreen(g, cam, target.ux, target.uy);
    const hit = hitGlass(grid, g, cam, x, y);
    expect(performance.now() - t0).toBeLessThan(300);
    expect(hit?.address).toBe(target.address);
  });

  it('at full view, hover only hits ships that are drawn as glyphs', () => {
    const hidden = seatShips([ship(7, { band: 'dust' })]).find((s) => s.lod === 0);
    if (!hidden) return; // this address happens to be in the texture sample
    const grid = buildGlassGrid([hidden]);
    const [x, y] = toScreen(g, CAMERA_HOME, hidden.ux, hidden.uy);
    expect(hitGlass(grid, g, CAMERA_HOME, x, y)).toBeNull();
    const cam = frameShip(hidden, 4);
    const [x2, y2] = toScreen(g, cam, hidden.ux, hidden.uy);
    expect(hitGlass(grid, g, cam, x2, y2)?.address).toBe(hidden.address);
  });
});
