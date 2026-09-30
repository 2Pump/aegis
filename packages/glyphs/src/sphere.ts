import { HULL_RING, hash32, unit, type ShipLite } from './core.js';
import { GLASS_BAND_R, SECTORS, SECTOR_COLORS, sectorOf, type SectorKey } from './glass.js';

/*
 * HULL SPHERE — the well as a glass world you can orbit.
 *   longitude = primary-pose LUNE   (the same frozen sector table as WELL GLASS: a wallet's bearing is identical in both)
 *   radius    = risk                (the same HULL_RING values: LIQ core → WARN shell → NOMINAL mantle → dark sensors at the rim)
 *   latitude  = a third hash of the address, spread evenly over the surface, poles kept clear
 * Pure math only (no three.js), so it is unit-tested and shared by the web engine.
 * No balances, no HF, no liquidation prices — only fields already on a ship row.
 */

/** sin(latitude) is kept inside ±0.9 (±64°) so the lunes don't converge into a crush at the poles. */
export const SPHERE_LAT_LIMIT = 0.9;
/** Glyph radius per size band, in sphere units (sphere radius = 1). Five sizes, capped. */
export const SPHERE_BAND_W: Readonly<Record<keyof typeof GLASS_BAND_R, number>> = { dust: 0.004, '<1k': 0.0055, '1–10k': 0.0075, '10–100k': 0.0105, '100k+': 0.014 };
/** Nested glass shells (contour labels): same fractions as the 2D contour rings. */
export const SPHERE_SHELLS = [
  { r: 0.84, label: 'NOMINAL', color: '#4ce0d2' },
  { r: 0.54, label: 'WARN', color: '#f5c14a' },
  { r: 0.32, label: 'LIQ ZONE', color: '#ff6b6b' },
] as const;

const BAND_IDX = { dust: 0, '<1k': 1, '1–10k': 2, '10–100k': 3, '100k+': 4 } as const;

export interface SphereSeat {
  address: string;
  sector: SectorKey;
  /** radians; 0 = +z, clockwise seen from above (bearing, like the 2D plot) */
  lon: number;
  lat: number;
  /** 0..1 of the sphere radius (= the 2D radius) */
  r: number;
  x: number;
  y: number;
  z: number;
  color: string;
  wounded: boolean;
  /** CRITICAL or WOUNDED */
  hot: boolean;
  bandIdx: number;
  /**
   * level of detail at full orbit: 2 = glyph everywhere (≥$10k, opened by you), 1 = glyph on desktop
   * (wounded/critical ≥$1k, elevated ≥$1k, a stable 1-in-16 texture sample), 0 = haze until you zoom in
   */
  lod: 0 | 1 | 2;
  /** stable per-address hash (orders thread building; never risk) */
  h: number;
}

export function seatSphere(s: ShipLite): SphereSeat {
  const sector = sectorOf(s.primary);
  const [a0, a1] = SECTORS[sector];
  const h1 = hash32(s.address);
  const h2 = hash32(s.address, 0x9e3779b9);
  const h3 = hash32(s.address, 0x5bd1e995);
  const bearing = a0 + (a1 - a0) * (0.04 + 0.92 * unit(h1)); // identical to seatShip() in glass.ts
  const lon = (bearing * Math.PI) / 180;
  const sinLat = (2 * unit(h3) - 1) * SPHERE_LAT_LIMIT; // equal-area latitude
  const cosLat = Math.sqrt(1 - sinLat * sinLat);
  const [lo, hi] = HULL_RING[s.hullTemp];
  const r = lo + (hi - lo) * unit(h2); // identical to the 2D radius
  const wounded = s.tags.includes('WOUNDED');
  const hot = wounded || s.hullTemp === 'CRITICAL';
  const bandIdx = BAND_IDX[s.band];
  const lod: 0 | 1 | 2 = bandIdx >= 3 || s.focused ? 2 : (hot && bandIdx >= 2) || (s.hullTemp === 'ELEVATED' && bandIdx >= 2) || h1 % 16 === 0 ? 1 : 0;
  const hollow = s.primary === 'DARK' || s.primary === 'EMPTY';
  return {
    address: s.address,
    sector,
    lon,
    lat: Math.asin(sinLat),
    r,
    x: r * cosLat * Math.sin(lon),
    y: r * sinLat,
    z: r * cosLat * Math.cos(lon),
    color: sector === 'OTHER' ? (hollow ? '#6B7280' : '#9CA3AF') : SECTOR_COLORS[sector],
    wounded,
    hot,
    bandIdx,
    lod,
    h: h1,
  };
}

/** Which seats get a glyph at full orbit. Phones: ≥$10k and wounded ≥$1k only. */
export function orbitGlyph(s: SphereSeat, phone: boolean): boolean {
  return phone ? s.lod >= 2 || (s.hot && s.bandIdx >= 2) : s.lod >= 1;
}

/* ───────────────────────── camera / LOD ───────────────────────── */

export type SphereLod = 'HAZE' | 'MANTLE' | 'TISSUE' | 'NODE';

/** zoom = default distance / current distance. */
export function sphereLod(zoom: number, framed: boolean): SphereLod {
  if (framed) return 'NODE';
  if (zoom < 0.85) return 'HAZE';
  if (zoom < 1.8) return 'MANTLE';
  return 'TISSUE';
}
/** 0 → 1 as every ship fades in (1.5× → 2.1×). */
export function sphereFineMix(zoom: number): number {
  return Math.min(1, Math.max(0, (zoom - 1.5) / 0.6));
}
/** Glyphs shrink as you close in, so they stay beads instead of boulders. */
export function sphereGlyphScale(zoom: number): number {
  return Math.min(1, Math.max(0.22, Math.pow(1 / Math.max(zoom, 1), 0.55)));
}
/** Camera distance that fits a unit sphere to `fill` of the smaller viewport side. */
export function sphereFitDistance(fovDeg: number, aspect: number, fill: number): number {
  const halfH = Math.tan((fovDeg * Math.PI) / 360);
  return 1 / (Math.min(halfH, halfH * aspect) * fill);
}

export function sphereHud(p: { az: number; el: number; r: number | null; zoom: number; lod: SphereLod }): string {
  const az = String(Math.round(((p.az % 360) + 360) % 360)).padStart(3, '0');
  const el = `${p.el < 0 ? '-' : ''}${String(Math.round(Math.abs(p.el))).padStart(2, '0')}`;
  return `AZ ${az}°  EL ${el}°  R ${p.r === null ? '-.--' : p.r.toFixed(2)}  ZOOM ${p.zoom.toFixed(1)}×`;
}

/* ───────────────────────── filaments ───────────────────────── */

export interface ThreadOpts {
  /** neighbours per node (2–4) */
  k: number;
  /** longest thread, sphere units */
  maxLen: number;
  /** global cap */
  cap: number;
}

/**
 * Same-pose "cytoskeleton" threads between nearby seats. Decoration only: same primary pose, only among the seats given
 * (the ones currently drawn), k nearest within maxLen, hard cap. Built in address-hash order — never ordered by risk, so
 * a thread never says "these two are about to die" or "these people know each other".
 * Returns index pairs into `seats`.
 */
export function buildThreads(seats: readonly SphereSeat[], o: ThreadOpts): Array<[number, number]> {
  const cell = o.maxLen;
  const grid = new Map<string, number[]>();
  const key = (x: number, y: number, z: number) => `${x}|${y}|${z}`;
  seats.forEach((s, i) => {
    const k = key(Math.floor(s.x / cell), Math.floor(s.y / cell), Math.floor(s.z / cell));
    const b = grid.get(k);
    if (b) b.push(i);
    else grid.set(k, [i]);
  });
  const order = seats.map((_, i) => i).sort((a, b) => seats[a]!.h - seats[b]!.h || (seats[a]!.address < seats[b]!.address ? -1 : 1));
  const out: Array<[number, number]> = [];
  const seen = new Set<number>();
  const n = seats.length;
  for (const i of order) {
    if (out.length >= o.cap) break;
    const s = seats[i]!;
    const cx = Math.floor(s.x / cell), cy = Math.floor(s.y / cell), cz = Math.floor(s.z / cell);
    const cand: Array<[number, number]> = [];
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          const b = grid.get(key(cx + dx, cy + dy, cz + dz));
          if (!b) continue;
          for (const j of b) {
            if (j === i) continue;
            const t = seats[j]!;
            if (t.sector !== s.sector) continue; // never across poses
            const d = Math.hypot(s.x - t.x, s.y - t.y, s.z - t.z);
            if (d < o.maxLen) cand.push([d, j]);
          }
        }
    cand.sort((a, b) => a[0] - b[0]);
    for (const [, j] of cand.slice(0, o.k)) {
      const e = i < j ? i * n + j : j * n + i;
      if (seen.has(e)) continue;
      seen.add(e);
      out.push([i, j]);
      if (out.length >= o.cap) break;
    }
  }
  return out;
}
