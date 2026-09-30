import { TAG_COLORS, type HullTemp, type Tag } from '@aegis/pose';
import { HULL_RING, hash32, hexA, unit, type ShipLite, type SizeBand } from './core.js';

/*
 * WELL GLASS — the well as a polar plot a radar officer could read.
 *   radius  = risk (HULL_RING, unchanged: CRITICAL inside, NOMINAL outside, UNKNOWN at the rim)
 *   bearing = primary-pose SECTOR (fixed order, frozen widths), seat inside the sector = hash of the address
 *   size    = size band only
 *   red ring = WOUNDED (never a sector, never a fill)
 * No balances, no HF, no liquidation prices are drawn. Same address → same seat on every load.
 */

/* ───────────────────────── sector table (owner-approved order; change only with approval) ───────────────────────── */

export const SECTOR_ORDER = ['CARRY', 'EQUITY-MARGIN', 'NAKED', 'KBTC-CORE', 'LEVERED', 'HOLD', 'LOCKED', 'STABLE-BALLAST', 'OTHER'] as const;
export type SectorKey = (typeof SECTOR_ORDER)[number];

/**
 * Live pose mix the widths were tuned on (census 2026-09-29, rules v1.2.0). FROZEN: the widths do not follow
 * the live mix on each refresh (that would reshuffle every seat). Retune only with owner approval — that is a
 * one-time, documented reseat.
 */
export const SECTOR_MIX_FROZEN: Readonly<Record<SectorKey, number>> = {
  CARRY: 26,
  'EQUITY-MARGIN': 73,
  NAKED: 821,
  'KBTC-CORE': 214,
  LEVERED: 23,
  HOLD: 2691,
  LOCKED: 4235,
  'STABLE-BALLAST': 4431,
  OTHER: 547,
};
/** Rare poses stay an arc, never a hairline. */
export const SECTOR_MIN_ARC_DEG = 16;
export const SECTOR_GAP_DEG = 2;

export const SECTOR_COLORS: Readonly<Record<SectorKey, string>> = {
  CARRY: TAG_COLORS.CARRY!,
  'EQUITY-MARGIN': TAG_COLORS['EQUITY-MARGIN']!,
  NAKED: TAG_COLORS.NAKED!,
  'KBTC-CORE': TAG_COLORS['KBTC-CORE']!,
  LEVERED: TAG_COLORS.LEVERED!,
  HOLD: TAG_COLORS.HOLD!,
  LOCKED: TAG_COLORS.LOCKED!,
  'STABLE-BALLAST': TAG_COLORS['STABLE-BALLAST']!,
  OTHER: '#6B7280',
};
/** Plain position-type names on the rim (same words as TAG_LABEL in labels.ts, upper-cased for the instrument). */
export const SECTOR_LABEL: Readonly<Record<SectorKey, string>> = {
  CARRY: 'HEDGED',
  'EQUITY-MARGIN': 'STOCKS AS COLLATERAL',
  NAKED: 'UNHEDGED BET',
  'KBTC-CORE': 'BITCOIN-BACKED',
  LEVERED: 'HIGH LEVERAGE',
  HOLD: 'JUST HOLDING',
  LOCKED: 'LENDING ONLY',
  'STABLE-BALLAST': 'MOSTLY STABLECOINS',
  OTHER: 'OTHER · UNCLASSIFIED',
};
/** Rim labels for narrow sectors at full zoom-out. */
export const SECTOR_ABBR: Readonly<Record<SectorKey, string>> = {
  CARRY: 'HEDGED',
  'EQUITY-MARGIN': 'STOCKS',
  NAKED: 'UNHEDGED',
  'KBTC-CORE': 'BTC',
  LEVERED: 'LEVERAGE',
  HOLD: 'HOLDING',
  LOCKED: 'LENDING',
  'STABLE-BALLAST': 'STABLES',
  OTHER: 'OTHER',
};

/** Bearings in degrees, 0 = 12 o'clock, clockwise. Width = min arc + a √count share of the rest. */
export function computeSectors(
  mix: Readonly<Record<SectorKey, number>> = SECTOR_MIX_FROZEN,
  minArc = SECTOR_MIN_ARC_DEG,
  gap = SECTOR_GAP_DEG,
): Record<SectorKey, readonly [number, number]> {
  const sq = SECTOR_ORDER.map((k) => Math.sqrt(Math.max(0, mix[k])));
  const sqT = sq.reduce((a, b) => a + b, 0) || 1;
  const free = 360 - SECTOR_ORDER.length * (minArc + gap);
  const out = {} as Record<SectorKey, readonly [number, number]>;
  let acc = 0;
  SECTOR_ORDER.forEach((k, i) => {
    const w = minArc + (free * sq[i]!) / sqT;
    out[k] = [acc + gap / 2, acc + gap / 2 + w] as const;
    acc += w + gap;
  });
  return out;
}
export const SECTORS = computeSectors();

const POSE_SECTORS = new Set<string>(SECTOR_ORDER.filter((k) => k !== 'OTHER'));
/** Primary pose → sector. WOUNDED-as-main, DARK, EMPTY and "no rule fired" share the last sector. */
export function sectorOf(primary: Tag | null): SectorKey {
  return primary && POSE_SECTORS.has(primary) ? (primary as SectorKey) : 'OTHER';
}

/* ───────────────────────── seats ───────────────────────── */

const BAND_IDX: Record<SizeBand, number> = { dust: 0, '<1k': 1, '1–10k': 2, '10–100k': 3, '100k+': 4 };
/** Dot radius per size band at a ~400px well. 5 radii, capped so $100k+ never eats the glass. */
export const GLASS_BAND_R: Readonly<Record<SizeBand, number>> = { dust: 1.1, '<1k': 1.6, '1–10k': 2.3, '10–100k': 3.3, '100k+': 4.4 };
export const GLASS_BANDS: readonly SizeBand[] = ['dust', '<1k', '1–10k', '10–100k', '100k+'];

/** Fill for a ship with no pose sector color: WOUNDED-as-main stays neutral (red is the ring only). */
const NEUTRAL = '#9CA3AF';

export interface GlassShip extends ShipLite {
  sector: SectorKey;
  /** bearing, degrees clockwise from 12 o'clock */
  deg: number;
  /** 0..1 of the well radius */
  r: number;
  /** unit-disc coordinates (x right, y down) */
  ux: number;
  uy: number;
  color: string;
  hollow: boolean;
  wounded: boolean;
  bandIdx: number;
  /**
   * Level of detail at full view: 2 = drawn as a glyph on every screen, 1 = drawn on desktop,
   * 0 = only haze until you zoom in. Rule: ≥$10k → 2 (phones draw only these, wounded or not);
   * WOUNDED/CRITICAL ≥$1k, ELEVATED ≥$1k and a stable 1-in-16 texture sample → 1 (desktop). Small wounded books join the sample like everyone else, so the
   * full-view core is a basin with rings on it, not one fused red blob — zoom separates the rest.
   */
  lod: 0 | 1 | 2;
}

export function seatShip(s: ShipLite): GlassShip {
  const sector = sectorOf(s.primary);
  const [a0, a1] = SECTORS[sector];
  const h1 = hash32(s.address);
  const h2 = hash32(s.address, 0x9e3779b9);
  const deg = a0 + (a1 - a0) * (0.04 + 0.92 * unit(h1));
  const [lo, hi] = HULL_RING[s.hullTemp];
  const r = lo + (hi - lo) * unit(h2);
  const rad = (deg * Math.PI) / 180;
  const wounded = s.tags.includes('WOUNDED');
  const bandIdx = BAND_IDX[s.band];
  const hot = wounded || s.hullTemp === 'CRITICAL';
  const lod: 0 | 1 | 2 =
    bandIdx >= 3 || s.focused
      ? 2
      : (hot && bandIdx >= 2) || (s.hullTemp === 'ELEVATED' && bandIdx >= 2) || h1 % 16 === 0
        ? 1
        : 0;
  const hollow = s.primary === 'DARK' || s.primary === 'EMPTY';
  return {
    ...s,
    sector,
    deg,
    r,
    ux: Math.sin(rad) * r,
    uy: -Math.cos(rad) * r,
    color: sector === 'OTHER' ? (hollow ? '#9CA3AF' : NEUTRAL) : SECTOR_COLORS[sector],
    hollow,
    wounded,
    bandIdx,
    lod,
  };
}

/** Seats, sorted small → large so big hulls draw on top. */
export function seatShips(ships: readonly ShipLite[]): GlassShip[] {
  return ships.map(seatShip).sort((a, b) => a.bandIdx - b.bandIdx);
}

/* ───────────────────────── geometry & camera ───────────────────────── */

export interface GlassGeom {
  w: number;
  h: number;
  cx: number;
  cy: number;
  /** radius of the glass */
  R: number;
  phone: boolean;
  /** glyph scale for this glass size */
  k: number;
}

export const PHONE_MAX_W = 560;

/** Canvas height for a given container width (the rack decides width). */
export function glassHeight(w: number): number {
  return w < PHONE_MAX_W ? Math.round(w * 1.0) : Math.round(Math.min(w * 0.84, 900));
}

export function glassGeom(w: number, h: number): GlassGeom {
  const phone = w < PHONE_MAX_W;
  const R = Math.max(40, Math.min(w, h) / 2 - (phone ? 26 : 62));
  return { w, h, cx: w / 2, cy: h / 2, R, phone, k: Math.max(0.72, Math.min(1.15, R / 400)) };
}

/** zoom ≥ 1; (fx, fy) = the unit-disc point at the center of the glass. */
export interface GlassCamera {
  zoom: number;
  fx: number;
  fy: number;
}
export const CAMERA_HOME: GlassCamera = { zoom: 1, fx: 0, fy: 0 };
export const MAX_ZOOM = 10;
/** Below this zoom the haze + glyph budget applies; above it every ship is drawn. */
export const LOD_FULL_ZOOM = 2.2;
const LOD_FADE_FROM = 1.6;

export function clampCamera(c: GlassCamera): GlassCamera {
  const zoom = Math.max(1, Math.min(MAX_ZOOM, c.zoom));
  const lim = Math.max(0, 1 - 1 / zoom);
  const d = Math.hypot(c.fx, c.fy);
  const s = d > lim ? (lim === 0 ? 0 : lim / d) : 1;
  return { zoom, fx: c.fx * s, fy: c.fy * s };
}

export function toScreen(g: GlassGeom, c: GlassCamera, ux: number, uy: number): [number, number] {
  return [g.cx + (ux - c.fx) * g.R * c.zoom, g.cy + (uy - c.fy) * g.R * c.zoom];
}

export function toUnit(g: GlassGeom, c: GlassCamera, sx: number, sy: number): [number, number] {
  return [c.fx + (sx - g.cx) / (g.R * c.zoom), c.fy + (sy - g.cy) / (g.R * c.zoom)];
}

/** Bearing (0 = 12 o'clock, clockwise) and radius fraction of a unit-disc point. */
export function polarOf(ux: number, uy: number): { deg: number; r: number } {
  const deg = ((Math.atan2(ux, -uy) * 180) / Math.PI + 360) % 360;
  return { deg, r: Math.hypot(ux, uy) };
}

/** Zoom by `factor` keeping the unit point under (sx, sy) fixed on screen. */
export function zoomAt(g: GlassGeom, c: GlassCamera, sx: number, sy: number, factor: number): GlassCamera {
  const [ux, uy] = toUnit(g, c, sx, sy);
  const zoom = Math.max(1, Math.min(MAX_ZOOM, c.zoom * factor));
  return clampCamera({ zoom, fx: ux - (sx - g.cx) / (g.R * zoom), fy: uy - (sy - g.cy) / (g.R * zoom) });
}

export function panBy(g: GlassGeom, c: GlassCamera, dx: number, dy: number): GlassCamera {
  return clampCamera({ zoom: c.zoom, fx: c.fx - dx / (g.R * c.zoom), fy: c.fy - dy / (g.R * c.zoom) });
}

/** Frame one hull (Find / double-click). */
export function frameShip(s: Pick<GlassShip, 'ux' | 'uy'>, zoom = 3.2): GlassCamera {
  return clampCamera({ zoom, fx: s.ux, fy: s.uy });
}

/** HUD readout — an instrument line, never a balance. */
export function hudText(p: { deg: number; r: number } | null, zoom: number): string {
  const az = p ? `${String(Math.round(p.deg) % 360).padStart(3, '0')}°` : '---°';
  const r = p ? p.r.toFixed(2) : '-.--';
  return `AZ ${az}  DEPTH ${r}  ZOOM ${zoom.toFixed(1)}×`;
}

/** 0 at full view → 1 once every ship is drawn. */
export function lodMix(zoom: number): number {
  if (zoom <= LOD_FADE_FROM) return 0;
  if (zoom >= LOD_FULL_ZOOM) return 1;
  return (zoom - LOD_FADE_FROM) / (LOD_FULL_ZOOM - LOD_FADE_FROM);
}

export function lodText(zoom: number, phone: boolean): string {
  const m = lodMix(zoom);
  if (m >= 1) return 'SHOWING: EVERY WALLET';
  return phone ? 'SHOWING: WALLETS ≥$10K' : 'SHOWING: ≥$10K · NEAR LIQUIDATION · WATCH';
}

/* ───────────────────────── hit testing (unit-disc grid; O(1) per pointer move) ───────────────────────── */

export interface GlassGrid {
  cell: number;
  n: number;
  buckets: Map<number, GlassShip[]>;
}

export function buildGlassGrid(ships: readonly GlassShip[], cell = 0.02): GlassGrid {
  const n = Math.ceil(2.2 / cell);
  const buckets = new Map<number, GlassShip[]>();
  for (const s of ships) {
    const k = Math.floor((s.uy + 1.1) / cell) * n + Math.floor((s.ux + 1.1) / cell);
    let b = buckets.get(k);
    if (!b) buckets.set(k, (b = []));
    b.push(s);
  }
  return { cell, n, buckets };
}

/** Is this ship drawn as a glyph at this zoom? (hover only hits what you can see) */
export function glyphVisible(s: GlassShip, zoom: number, phone: boolean): boolean {
  return lodMix(zoom) >= 0.5 || s.lod >= (phone ? 2 : 1);
}

export function hitGlass(grid: GlassGrid, g: GlassGeom, c: GlassCamera, sx: number, sy: number, extra: GlassShip | null = null): GlassShip | null {
  const [ux, uy] = toUnit(g, c, sx, sy);
  if (Math.hypot(ux, uy) > 1.02) return null;
  const pxPerUnit = g.R * c.zoom;
  const reachPx = g.phone ? 12 : 9;
  const reach = reachPx / pxPerUnit;
  const span = Math.ceil(reach / grid.cell);
  const col = Math.floor((ux + 1.1) / grid.cell);
  const row = Math.floor((uy + 1.1) / grid.cell);
  let best: GlassShip | null = null;
  let bestD = Infinity;
  const consider = (s: GlassShip) => {
    const d = Math.hypot(s.ux - ux, s.uy - uy) * pxPerUnit;
    if (d < reachPx && d < bestD) {
      best = s;
      bestD = d;
    }
  };
  for (let dy = -span; dy <= span; dy++)
    for (let dx = -span; dx <= span; dx++) {
      const b = grid.buckets.get((row + dy) * grid.n + (col + dx));
      if (!b) continue;
      for (const s of b) if (glyphVisible(s, c.zoom, g.phone)) consider(s);
    }
  if (extra) consider(extra);
  return best;
}

/* ───────────────────────── paint ───────────────────────── */

const MONO = '"IBM Plex Mono", ui-monospace, "DejaVu Sans Mono", Menlo, monospace';
const RED = TAG_COLORS.WOUNDED!;
const CONTOURS: ReadonlyArray<{ f: number; label: string; stroke: string; text: string; dash: number[]; temp: HullTemp }> = [
  { f: 0.84, label: 'S A F E', stroke: 'rgba(76,224,210,0.22)', text: 'rgba(76,224,210,0.85)', dash: [2, 6], temp: 'NOMINAL' },
  { f: 0.54, label: 'W A T C H', stroke: 'rgba(245,193,74,0.32)', text: 'rgba(245,193,74,0.9)', dash: [2, 5], temp: 'ELEVATED' },
  { f: 0.32, label: 'N E A R   L I Q U I D A T I O N', stroke: 'rgba(255,77,77,0.45)', text: 'rgba(255,77,77,0.95)', dash: [2, 4], temp: 'CRITICAL' },
];

type CanvasFactory = (w: number, h: number) => HTMLCanvasElement;

/** Density haze, built once per data/size in unit-disc space at low resolution; the camera just scales it. */
export interface GlassHaze {
  canvas: HTMLCanvasElement;
  /** unit-disc extent covered: [-ext, ext] */
  ext: number;
}

export function buildHaze(ships: readonly GlassShip[], g: GlassGeom, make: CanvasFactory): GlassHaze {
  const ext = 1.05;
  const q = g.phone ? 3 : 4; // CSS px per haze px
  const S = Math.max(16, Math.ceil((2 * ext * g.R) / q));
  const cv = make(S, S);
  const h = cv.getContext('2d');
  if (!h) return { canvas: cv, ext };
  // one soft sprite per color: the blur is baked into the stamp, so no canvas filter is needed (Safari-safe)
  const SP = 5;
  const sprites = new Map<string, HTMLCanvasElement>();
  const sprite = (col: string) => {
    let s = sprites.get(col);
    if (s) return s;
    s = make(SP * 2, SP * 2);
    const sc = s.getContext('2d')!;
    const gr = sc.createRadialGradient(SP, SP, 0, SP, SP, SP);
    gr.addColorStop(0, hexA(col, 1));
    gr.addColorStop(0.45, hexA(col, 0.45));
    gr.addColorStop(1, hexA(col, 0));
    sc.fillStyle = gr;
    sc.fillRect(0, 0, SP * 2, SP * 2);
    sprites.set(col, s);
    return s;
  };
  // source-over, not additive: dense cells converge on the pose color itself and never bloom to white.
  // Haze is pose-colored only — red stays reserved for the wounded ring and the LIQ ZONE basin.
  h.globalCompositeOperation = 'source-over';
  // the same count of ships lands on fewer pixels on a small glass: thin the stamp so a phone isn't saturated
  const dens = Math.max(0.3, Math.min(1, (g.R / 430) ** 2));
  const toPx = S / (2 * ext);
  h.globalAlpha = 0.09 * dens;
  for (const s of ships) {
    const x = (s.ux + ext) * toPx;
    const y = (s.uy + ext) * toPx;
    h.drawImage(sprite(s.hollow ? '#9CA3AF' : s.color), x - SP, y - SP);
  }
  return { canvas: cv, ext };
}

/** Overall haze strength: phosphor, not neon. */
export const HAZE_ALPHA = 0.5;

export interface GlassDrawOpts {
  /** always drawn in full, whatever the LOD */
  pinned?: ReadonlySet<string>;
  /** canvas factory for glyph sprites (browser: document.createElement) — without it glyphs fall back to paths */
  make?: CanvasFactory;
  /** device pixel ratio the sprites are rendered at */
  dpr?: number;
}

/** The glass: volume, basin, haze, contours, spokes, glyphs, contour labels. Redrawn on camera or data change. */
export function drawGlass(ctx: CanvasRenderingContext2D, g: GlassGeom, c: GlassCamera, ships: readonly GlassShip[], haze: GlassHaze | null, opts: GlassDrawOpts = {}): number {
  const { w, h, R } = g;
  const Z = R * c.zoom;
  const [ccx, ccy] = toScreen(g, c, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.save();
  ctx.beginPath();
  ctx.arc(g.cx, g.cy, R, 0, Math.PI * 2);
  ctx.clip();

  // volume: darker at the bottom of the well; one lamp at ~2 o'clock; recessed edge
  const vol = ctx.createRadialGradient(ccx, ccy, 0, ccx, ccy, Z);
  vol.addColorStop(0, '#000000');
  vol.addColorStop(0.35, '#020406');
  vol.addColorStop(0.8, '#070b10');
  vol.addColorStop(1, '#0c1219');
  ctx.fillStyle = vol;
  ctx.fillRect(0, 0, w, h);
  const lamp = ctx.createRadialGradient(g.cx + R * 0.55, g.cy - R * 0.45, 0, g.cx + R * 0.55, g.cy - R * 0.45, R * 0.9);
  lamp.addColorStop(0, 'rgba(140,200,210,0.055)');
  lamp.addColorStop(1, 'rgba(140,200,210,0)');
  ctx.fillStyle = lamp;
  ctx.fillRect(0, 0, w, h);

  // LIQ ZONE basin
  const basin = ctx.createRadialGradient(ccx, ccy, 0, ccx, ccy, 0.32 * Z);
  basin.addColorStop(0, 'rgba(255,77,77,0)');
  basin.addColorStop(0.55, 'rgba(255,77,77,0.035)');
  basin.addColorStop(1, 'rgba(255,77,77,0.075)');
  ctx.fillStyle = basin;
  ctx.beginPath();
  ctx.arc(ccx, ccy, 0.32 * Z, 0, Math.PI * 2);
  ctx.fill();

  // haze fades out as the camera closes in
  const mix = lodMix(c.zoom);
  if (haze && mix < 1) {
    const [x0, y0] = toScreen(g, c, -haze.ext, -haze.ext);
    ctx.globalAlpha = HAZE_ALPHA * (1 - mix);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(haze.canvas, x0, y0, 2 * haze.ext * Z, 2 * haze.ext * Z);
    ctx.globalAlpha = 1;
  }

  // contour rings (etched)
  ctx.lineWidth = 1;
  for (const k of CONTOURS) {
    ctx.strokeStyle = k.stroke;
    ctx.setLineDash(k.dash);
    ctx.beginPath();
    ctx.arc(ccx, ccy, k.f * Z, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  // sector spokes
  ctx.strokeStyle = 'rgba(160,175,190,0.10)';
  ctx.beginPath();
  for (const k of SECTOR_ORDER) {
    const a = ((SECTORS[k][0] - SECTOR_GAP_DEG / 2) * Math.PI) / 180;
    const [x0, y0] = toScreen(g, c, Math.sin(a) * 0.1, -Math.cos(a) * 0.1);
    const [x1, y1] = toScreen(g, c, Math.sin(a), -Math.cos(a));
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
  }
  ctx.stroke();

  const drawn = drawGlyphs(ctx, g, c, ships, mix, opts.pinned, opts.make, opts.dpr ?? 1);

  ctx.restore();

  // contour labels: at 12 o'clock at full view; when zoomed, each label rides its ring to the point nearest the
  // top of the visible glass, so the ring you are looking at is always named
  ctx.save();
  ctx.beginPath();
  ctx.arc(g.cx, g.cy, R, 0, Math.PI * 2);
  ctx.clip();
  ctx.font = `600 ${g.phone ? 8 : 9.5}px ${MONO}`;
  ctx.textAlign = 'center';
  const tx = g.cx;
  const ty = g.cy - R * 0.86;
  const dirX = tx - ccx;
  const dirY = ty - ccy;
  const dl = Math.hypot(dirX, dirY) || 1;
  for (const k of CONTOURS) {
    const x = ccx + (dirX / dl) * k.f * Z;
    const y = ccy + (dirY / dl) * k.f * Z;
    if (Math.hypot(x - g.cx, y - g.cy) > R - 10) continue;
    const tw = ctx.measureText(k.label).width + 12;
    ctx.fillStyle = '#020305';
    ctx.fillRect(x - tw / 2, y - 7, tw, 13);
    ctx.fillStyle = k.text;
    ctx.fillText(k.label, x, y + 3.5);
  }
  ctx.restore();
  return drawn;
}

/**
 * Glyphs are stamped from pre-rendered sprites (one per color × radius × ring), not stroked as paths:
 * 20k drawImage calls rasterize far cheaper than 20k arcs, on GPU and on software canvases alike.
 */
const spriteCache = new Map<string, HTMLCanvasElement>();
function glyphSprite(make: CanvasFactory, dpr: number, color: string, rr: number, hollow: boolean, ringGap: number | null): HTMLCanvasElement {
  const key = `${color}|${rr}|${hollow ? 1 : 0}|${ringGap ?? '-'}|${dpr}`;
  let c = spriteCache.get(key);
  if (c) return c;
  if (spriteCache.size > 600) spriteCache.clear();
  const half = Math.ceil(rr + (ringGap ?? 0) + 2);
  c = make(half * 2 * dpr, half * 2 * dpr);
  const x = c.getContext('2d')!;
  x.scale(dpr, dpr);
  x.beginPath();
  x.arc(half, half, rr, 0, Math.PI * 2);
  if (hollow) {
    x.strokeStyle = color;
    x.lineWidth = 1;
    x.stroke();
  } else {
    x.fillStyle = color;
    x.fill();
  }
  if (ringGap !== null) {
    x.strokeStyle = hexA(RED, 0.9);
    x.lineWidth = 1;
    x.beginPath();
    x.arc(half, half, rr + ringGap, 0, Math.PI * 2);
    x.stroke();
  }
  spriteCache.set(key, c);
  return c;
}

function drawGlyphs(ctx: CanvasRenderingContext2D, g: GlassGeom, c: GlassCamera, ships: readonly GlassShip[], mix: number, pinned: ReadonlySet<string> | undefined, make: CanvasFactory | undefined, dpr: number): number {
  const need = g.phone ? 2 : 1;
  const kz = Math.min(g.phone ? 1.45 : 1.9, 1 + 0.45 * Math.log2(c.zoom));
  const scale = g.k * kz * (g.phone ? 0.85 : 1);
  const Z = g.R * c.zoom;
  const pad = 12;
  const ringGap = mix < 1 ? 1.8 : 2.6;
  // radius quantized to ¼ px so the sprite cache stays small while zooming
  const radii = GLASS_BANDS.map((b) => Math.max(0.75, Math.round(GLASS_BAND_R[b] * scale * 4) / 4));
  const focus: number[] = [];
  let drawn = 0;
  let curAlpha = -1;
  for (const s of ships) {
    const always = s.lod >= need || (pinned !== undefined && pinned.has(s.address));
    const alpha = always ? 0.95 : 0.95 * mix;
    if (alpha <= 0.02) continue;
    const x = g.cx + (s.ux - c.fx) * Z;
    const y = g.cy + (s.uy - c.fy) * Z;
    if (x < -pad || y < -pad || x > g.w + pad || y > g.h + pad) continue;
    const rr = radii[s.bandIdx]!;
    if (alpha !== curAlpha) {
      ctx.globalAlpha = alpha;
      curAlpha = alpha;
    }
    if (make) {
      const sp = glyphSprite(make, dpr, s.color, rr, s.hollow, s.wounded ? ringGap : null);
      const size = sp.width / dpr;
      ctx.drawImage(sp, x - size / 2, y - size / 2, size, size);
    } else {
      ctx.beginPath();
      ctx.arc(x, y, rr, 0, Math.PI * 2);
      ctx.fillStyle = s.color;
      ctx.fill();
    }
    if (s.focused) focus.push(x, y, rr);
    drawn++;
  }
  // hulls this viewer opened: a thin white ring
  if (focus.length) {
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = '#E5F9F7';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < focus.length; i += 3) {
      const rr = focus[i + 2]! + 5;
      ctx.moveTo(focus[i]! + rr, focus[i + 1]!);
      ctx.arc(focus[i]!, focus[i + 1]!, rr, 0, Math.PI * 2);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  return drawn;
}

/** Glyph radius on screen for one ship (overlay rings sit just outside it). */
export function glyphRadius(g: GlassGeom, c: GlassCamera, s: GlassShip): number {
  const kz = Math.min(g.phone ? 1.45 : 1.9, 1 + 0.45 * Math.log2(c.zoom));
  return GLASS_BAND_R[s.band] * g.k * kz * (g.phone ? 0.85 : 1);
}

/** Frame: panel vignette, bezel, 2°/10°/30° ticks, bearings, sector names + brackets, corner brackets. Redrawn only on resize. */
export function drawGlassFrame(ctx: CanvasRenderingContext2D, g: GlassGeom): void {
  const { w, h, cx, cy, R, phone } = g;
  ctx.clearRect(0, 0, w, h);
  const vg = ctx.createRadialGradient(cx, cy, R * 0.2, cx, cy, Math.max(w, h) * 0.75);
  vg.addColorStop(0, '#05080c');
  vg.addColorStop(1, '#010203');
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, w, h);

  // recessed lip
  const lip = ctx.createRadialGradient(cx, cy, R * 0.96, cx, cy, R + 6);
  lip.addColorStop(0, 'rgba(0,0,0,0)');
  lip.addColorStop(1, 'rgba(0,0,0,0.6)');
  ctx.fillStyle = lip;
  ctx.beginPath();
  ctx.arc(cx, cy, R + 6, 0, Math.PI * 2);
  ctx.fill();

  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(120,190,200,0.35)';
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(120,190,200,0.14)';
  ctx.beginPath();
  ctx.arc(cx, cy, R + (phone ? 14 : 26), 0, Math.PI * 2);
  ctx.stroke();

  ctx.font = `500 9px ${MONO}`;
  ctx.textAlign = 'center';
  for (let d = 0; d < 360; d += 2) {
    const a = ((d - 90) * Math.PI) / 180;
    const major = d % 10 === 0;
    const big = d % 30 === 0;
    const r0 = R + 2;
    const r1 = R + (big ? 9 : major ? 6 : 3);
    ctx.strokeStyle = big ? 'rgba(170,210,215,0.55)' : major ? 'rgba(150,170,180,0.32)' : 'rgba(150,170,180,0.18)';
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
    ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
    ctx.stroke();
    if (big && !phone) {
      ctx.fillStyle = 'rgba(125,139,155,0.8)';
      ctx.fillText(String(d).padStart(3, '0'), cx + Math.cos(a) * (R + 18), cy + Math.sin(a) * (R + 18) + 3);
    }
  }

  // sector names on the rim (arc text, flipped on the bottom half so they read upright) + a colored bracket
  const rimR = R + (phone ? 22 : 40);
  const cw = phone ? 6.2 : 7.4;
  ctx.font = `600 ${phone ? 8.5 : 10}px ${MONO}`;
  for (const k of SECTOR_ORDER) {
    const [a0, a1] = SECTORS[k];
    const mid = (a0 + a1) / 2;
    const arcPx = ((a1 - a0) * Math.PI * rimR) / 180;
    const full = SECTOR_LABEL[k];
    const label = full.length * cw + 10 <= arcPx ? full : SECTOR_ABBR[k];
    const col = SECTOR_COLORS[k] === '#6B7280' ? '#9CA3AF' : SECTOR_COLORS[k];
    ctx.save();
    ctx.fillStyle = col;
    ctx.globalAlpha = 0.9;
    const chars = [...label];
    const flip = mid > 90 && mid < 270;
    const dir = flip ? -1 : 1;
    const step = cw / rimR;
    let ang = ((mid - 90) * Math.PI) / 180 - (dir * (chars.length * cw)) / 2 / rimR;
    ctx.textAlign = 'center';
    for (const ch of chars) {
      const a = ang + (dir * step) / 2;
      ctx.save();
      ctx.translate(cx + Math.cos(a) * rimR, cy + Math.sin(a) * rimR);
      ctx.rotate(a + (flip ? -Math.PI / 2 : Math.PI / 2));
      ctx.fillText(ch, 0, 3);
      ctx.restore();
      ang += dir * step;
    }
    ctx.strokeStyle = col;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, R + (phone ? 6 : 12), ((a0 - 90) * Math.PI) / 180, ((a1 - 90) * Math.PI) / 180);
    ctx.stroke();
    ctx.restore();
  }

  // corner brackets: a frame for the instrument, never pointed at a ship
  ctx.strokeStyle = 'rgba(120,190,200,0.4)';
  ctx.lineWidth = 1;
  const m = phone ? 6 : 14;
  const L = phone ? 14 : 26;
  for (const [x, y, sx, sy] of [
    [m, m, 1, 1],
    [w - m, m, -1, 1],
    [m, h - m, 1, -1],
    [w - m, h - m, -1, -1],
  ] as const) {
    ctx.beginPath();
    ctx.moveTo(x, y + sy * L);
    ctx.lineTo(x, y);
    ctx.lineTo(x + sx * L, y);
    ctx.stroke();
  }
}

export interface GlassOverlayState {
  hover: GlassShip | null;
  found: GlassShip | null;
  /** ships that changed live: one pulse each, then still */
  flashes: readonly GlassShip[];
  now: number;
  reduceMotion: boolean;
}
export const FLASH_MS = 1200;

/** Overlay: hover ring, the found hull, live-change pulses. Returns true while a pulse is still running. */
export function drawGlassOverlay(ctx: CanvasRenderingContext2D, g: GlassGeom, c: GlassCamera, st: GlassOverlayState): boolean {
  ctx.clearRect(0, 0, g.w, g.h);
  ctx.save();
  ctx.beginPath();
  ctx.arc(g.cx, g.cy, g.R, 0, Math.PI * 2);
  ctx.clip();
  let running = false;
  for (const s of st.flashes) {
    if (!s.flashAt) continue;
    const age = st.now - s.flashAt;
    if (age < 0 || age > FLASH_MS) continue;
    running = true;
    const [x, y] = toScreen(g, c, s.ux, s.uy);
    const t = age / FLASH_MS;
    const rr = glyphRadius(g, c, s) + 3 + (st.reduceMotion ? 4 : t * 12);
    ctx.strokeStyle = `rgba(229,249,247,${(0.8 * (1 - t)).toFixed(3)})`;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(x, y, rr, 0, Math.PI * 2);
    ctx.stroke();
  }
  if (st.found) {
    const s = st.found;
    const [x, y] = toScreen(g, c, s.ux, s.uy);
    const rr = glyphRadius(g, c, s);
    ctx.fillStyle = s.color;
    ctx.beginPath();
    ctx.arc(x, y, Math.max(rr, 2.2), 0, Math.PI * 2);
    s.hollow ? ((ctx.strokeStyle = s.color), ctx.stroke()) : ctx.fill();
    if (s.wounded) {
      ctx.strokeStyle = RED;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x, y, rr + 2.6, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (const [pad, a] of [
      [7, 0.95],
      [13, 0.45],
    ] as const) {
      ctx.strokeStyle = `rgba(229,249,247,${a})`;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(x, y, rr + pad, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  if (st.hover) {
    const [x, y] = toScreen(g, c, st.hover.ux, st.hover.uy);
    ctx.strokeStyle = '#E5F9F7';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(x, y, glyphRadius(g, c, st.hover) + 5, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
  return running;
}

/* ───────────────────────── gesture frames ───────────────────────── */

/**
 * While a wheel / pinch / drag is in flight the glass is not redrawn: the last full render is moved with the
 * camera (one drawImage per frame), and the sharp redraw lands once the gesture settles. Returns the placement
 * of a snapshot taken at camera `from` so it lines up under camera `to`.
 */
export function snapshotPlacement(g: GlassGeom, from: GlassCamera, to: GlassCamera): { k: number; dx: number; dy: number } {
  const k = to.zoom / from.zoom;
  return {
    k,
    dx: g.cx - g.cx * k + (from.fx - to.fx) * g.R * to.zoom,
    dy: g.cy - g.cy * k + (from.fy - to.fy) * g.R * to.zoom,
  };
}

export function drawGlassSnapshot(ctx: CanvasRenderingContext2D, g: GlassGeom, snap: HTMLCanvasElement, from: GlassCamera, to: GlassCamera): void {
  const { k, dx, dy } = snapshotPlacement(g, from, to);
  ctx.clearRect(0, 0, g.w, g.h);
  ctx.save();
  ctx.beginPath();
  ctx.arc(g.cx, g.cy, g.R, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = '#05080c';
  ctx.fillRect(0, 0, g.w, g.h);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(snap, dx, dy, g.w * k, g.h * k);
  ctx.restore();
}
