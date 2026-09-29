import { TAG_COLORS, type HullTemp, type Pose, type Tag } from '@aegis/pose';
import { HULL_RING, hash32, hexA, tagColor, unit, type ShipLite, type SizeBand } from './core.js';

export { HULL_RING, hash32, hexA, tagColor, unit, type ShipLite, type SizeBand } from './core.js';
export * from './glass.js';

/* ───────────────────────── size bands (privacy default) ───────────────────────── */

export function sizeBand(usd: number): SizeBand {
  const a = Math.abs(usd);
  if (a < 10) return 'dust';
  if (a < 1_000) return '<1k';
  if (a < 10_000) return '1–10k';
  if (a < 100_000) return '10–100k';
  return '100k+';
}

/** Book size for the well: Nado equity if known, else total margin. */
export function shipSizeUsd(p: Pose): number {
  const m = p.metrics;
  return Math.max(m.E ?? 0, m.totalMarginUsd, 0);
}

/** Color by primary, but a WOUNDED ship always burns red. */
export function shipColor(p: Pose): string {
  if (p.tags.includes('WOUNDED')) return TAG_COLORS.WOUNDED!;
  return tagColor(p.primary);
}

/* ───────────────────────── legacy well layout (?well=legacy, one release) ───────────────────────── */

export function shipLiteFromPose(address: string, pose: Pose, extra: Partial<ShipLite> = {}): ShipLite {
  return { address, primary: pose.primary, tags: pose.tags, hullTemp: pose.hullTemp, band: sizeBand(shipSizeUsd(pose)), ...extra };
}

export interface PlacedShip extends ShipLite {
  /** 0..1 of well radius */
  r: number;
  angle: number;
  sizePx: number;
  color: string;
  hollow: boolean;
  pulse: boolean;
  /** near liquidation: drawn with a red ring around its pose color */
  wounded: boolean;
}

/** Risk → radius. WOUNDED falls inward. DARK drifts at the rim. */
const RING = HULL_RING;

/** Size band → dot size. Bands, not dollars: the public well never encodes exact balances. */
const BAND_PX: Record<SizeBand, number> = { dust: 1.6, '<1k': 2.4, '1–10k': 3.4, '10–100k': 5, '100k+': 7.5 };

export function placeShip(s: ShipLite): PlacedShip {
  const h1 = hash32(s.address);
  const h2 = hash32(s.address, 0x9e3779b9);
  const [lo, hi] = RING[s.hullTemp];
  const wounded = s.tags.includes('WOUNDED');
  return {
    ...s,
    r: lo + (hi - lo) * unit(h2),
    angle: unit(h1) * Math.PI * 2,
    sizePx: BAND_PX[s.band],
    // the dot keeps its POSE color; being wounded is shown as a red ring (static) + pulse (animated),
    // so a wounded CARRY and a wounded LOCKED look different at a glance
    color: tagColor(s.primary),
    hollow: s.primary === 'DARK' || s.primary === 'EMPTY',
    pulse: wounded,
    wounded,
  };
}

export function placeShips(ships: readonly ShipLite[]): PlacedShip[] {
  return ships.map(placeShip);
}

export interface WellView {
  cx: number;
  cy: number;
  R: number;
}

export function wellView(w: number, h: number): WellView {
  return { cx: w / 2, cy: h / 2, R: Math.min(w, h) / 2 - 12 };
}

/** Dots shrink on small wells (phones) so a crowded census stays readable. */
export function dotScale(v: WellView): number {
  return Math.max(0.45, Math.min(1, v.R / 330));
}

export function shipXY(s: PlacedShip, v: WellView): [number, number] {
  return [v.cx + Math.cos(s.angle) * s.r * v.R, v.cy + Math.sin(s.angle) * s.r * v.R];
}

/** Uniform grid over the canvas so hover stays O(1) with tens of thousands of ships. */
export interface ShipGrid {
  cell: number;
  cols: number;
  buckets: Map<number, PlacedShip[]>;
  view: WellView;
}

export function buildGrid(ships: readonly PlacedShip[], v: WellView, cell = 16): ShipGrid {
  const cols = Math.ceil((v.cx * 2) / cell) + 1;
  const buckets = new Map<number, PlacedShip[]>();
  for (const s of ships) {
    const [x, y] = shipXY(s, v);
    const k = Math.floor(y / cell) * cols + Math.floor(x / cell);
    let b = buckets.get(k);
    if (!b) buckets.set(k, (b = []));
    b.push(s);
  }
  return { cell, cols, buckets, view: v };
}

export function hitTest(grid: ShipGrid, x: number, y: number): PlacedShip | null {
  const { cell, cols, buckets, view } = grid;
  const cx = Math.floor(x / cell);
  const cy = Math.floor(y / cell);
  let best: PlacedShip | null = null;
  let bestD = Infinity;
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const b = buckets.get((cy + dy) * cols + (cx + dx));
      if (!b) continue;
      for (const s of b) {
        const [sx, sy] = shipXY(s, view);
        const d = Math.hypot(sx - x, sy - y);
        if (d < Math.max(8, s.sizePx + 4) && d < bestD) {
          best = s;
          bestD = d;
        }
      }
    }
  return best;
}

/** Static layer: disc, contours and every ship. Redraw only when the data or size changes. */
export function drawWellStatic(ctx: CanvasRenderingContext2D, w: number, h: number, ships: readonly PlacedShip[]): void {
  const v = wellView(w, h);
  ctx.clearRect(0, 0, w, h);

  const g = ctx.createRadialGradient(v.cx, v.cy, v.R * 0.05, v.cx, v.cy, v.R);
  g.addColorStop(0, '#000000');
  g.addColorStop(0.7, '#05080C');
  g.addColorStop(1, '#0B1118');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(v.cx, v.cy, v.R, 0, Math.PI * 2);
  ctx.fill();

  ctx.lineWidth = 1;
  for (const [frac, col] of [
    [0.32, 'rgba(255,77,77,0.22)'],
    [0.54, 'rgba(245,193,74,0.16)'],
    [0.84, 'rgba(76,224,210,0.12)'],
    [1, 'rgba(148,163,184,0.25)'],
  ] as const) {
    ctx.strokeStyle = col;
    ctx.setLineDash(frac === 1 ? [] : [2, 6]);
    ctx.beginPath();
    ctx.arc(v.cx, v.cy, v.R * frac, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // Draw small → large so big hulls sit on top. Glow only for the largest bands, and only on roomy wells.
  const k = dotScale(v);
  const glowOn = k > 0.7 && ships.length < 40_000;
  const order = [...ships].sort((a, b) => a.sizePx - b.sizePx);
  for (const s of order) {
    const [x, y] = shipXY(s, v);
    const px = s.sizePx * k;
    if (glowOn && !s.hollow && s.sizePx >= 5) {
      const glow = ctx.createRadialGradient(x, y, 0, x, y, px * 2.4);
      glow.addColorStop(0, hexA(s.color, 0.3));
      glow.addColorStop(1, hexA(s.color, 0));
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(x, y, px * 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(x, y, px / 2 + 0.5, 0, Math.PI * 2);
    if (s.hollow) {
      ctx.strokeStyle = hexA(s.color === '#6B7280' ? '#9CA3AF' : s.color, 0.8);
      ctx.lineWidth = 1;
      ctx.stroke();
    } else {
      ctx.fillStyle = s.color;
      ctx.fill();
    }
    if (s.wounded) {
      ctx.strokeStyle = hexA(TAG_COLORS.WOUNDED!, 0.95);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, px / 2 + 2.5, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (s.focused) {
      ctx.strokeStyle = '#E5F9F7';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x, y, px / 2 + 5, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

/** Animated layer: WOUNDED pulses, live-change flashes, hover ring. Cheap — only a few ships. */
export function drawWellOverlay(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  animated: readonly PlacedShip[],
  t: number,
  now: number,
  hover: PlacedShip | null,
  /** "find my ship": crosshair + double ring, so one dot is findable among thousands */
  found: PlacedShip | null = null,
): void {
  const v = wellView(w, h);
  const k = dotScale(v);
  ctx.clearRect(0, 0, w, h);
  if (found) {
    const [x, y] = shipXY(found, v);
    ctx.strokeStyle = 'rgba(229,249,247,0.35)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 5]);
    ctx.beginPath();
    ctx.moveTo(v.cx - v.R, y);
    ctx.lineTo(v.cx + v.R, y);
    ctx.moveTo(x, v.cy - v.R);
    ctx.lineTo(x, v.cy + v.R);
    ctx.stroke();
    ctx.setLineDash([]);
    const p = 0.5 + 0.5 * Math.sin(t / 300);
    for (const [rad, a] of [[10 + p * 4, 0.95], [18 + p * 6, 0.5]] as const) {
      ctx.strokeStyle = `rgba(229,249,247,${a})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, rad, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  for (const s of animated) {
    const [x, y] = shipXY(s, v);
    if (s.pulse) {
      const p = 0.5 + 0.5 * Math.sin(t / 260 + s.angle * 3);
      ctx.strokeStyle = hexA(TAG_COLORS.WOUNDED!, 0.3 + p * 0.4);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x, y, (s.sizePx * k) / 2 + 2 + p * 4 * k, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (s.flashAt && now - s.flashAt < 6000) {
      const k = 1 - (now - s.flashAt) / 6000;
      ctx.strokeStyle = `rgba(229,249,247,${(0.8 * k).toFixed(3)})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, s.sizePx / 2 + 4 + (1 - k) * 16, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  if (hover) {
    const [x, y] = shipXY(hover, v);
    ctx.strokeStyle = '#E5F9F7';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(x, y, hover.sizePx / 2 + 6, 0, Math.PI * 2);
    ctx.stroke();
  }
}


/* ───────────────────────── hull sigil (SVG; reused by OG later) ───────────────────────── */

/**
 * Deterministic 8-point hull silhouette from the address, colored by pose.
 * No balances are encoded — safe for unfurls.
 */
export function hullSigilSvg(address: string, pose: Pick<Pose, 'primary' | 'tags' | 'hullTemp'>, size = 96): string {
  const color = pose.tags.includes('WOUNDED') ? TAG_COLORS.WOUNDED! : tagColor(pose.primary);
  const c = size / 2;
  const pts: string[] = [];
  for (let i = 0; i < 8; i++) {
    const h = hash32(address, 0x1000 + i);
    // mirror-symmetric hull: points i and 7-i share a radius
    const k = i < 4 ? i : 7 - i;
    const rr = 0.52 + 0.4 * unit(hash32(address, 0x2000 + k));
    const a = -Math.PI / 2 + (i / 8) * Math.PI * 2 + (unit(h) - 0.5) * 0.12;
    pts.push(`${(c + Math.cos(a) * rr * c * 0.9).toFixed(1)},${(c + Math.sin(a) * rr * c * 0.9).toFixed(1)}`);
  }
  const hollow = pose.primary === 'DARK' || pose.primary === 'EMPTY';
  const overlays = pose.tags.filter((t) => t !== pose.primary);
  const ticks = overlays
    .map((t, i) => {
      const a = (i / Math.max(overlays.length, 1)) * Math.PI * 2;
      return `<circle cx="${(c + Math.cos(a) * c * 0.94).toFixed(1)}" cy="${(c + Math.sin(a) * c * 0.94).toFixed(1)}" r="${(size / 40).toFixed(1)}" fill="${tagColor(t)}"/>`;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="hull sigil ${pose.primary ?? 'no rule'}">
<circle cx="${c}" cy="${c}" r="${c - 1}" fill="#05080C" stroke="#1F2937"/>
<polygon points="${pts.join(' ')}" fill="${hollow ? 'none' : hexA(color, 0.18)}" stroke="${color}" stroke-width="${hollow ? 1.5 : 2}" ${hollow ? 'stroke-dasharray="3 3"' : ''}/>
<circle cx="${c}" cy="${c}" r="${(size / 16).toFixed(1)}" fill="${color}"/>
${ticks}
</svg>`;
}

/* ───────────────────────── copy deck ───────────────────────── */

export const HULL_COPY: Record<HullTemp, string> = {
  NOMINAL: 'Sensors below warn lines.',
  ELEVATED: 'Inside the warn band.',
  CRITICAL: 'Liquidation range on at least one venue.',
  UNKNOWN: 'A sensor is dark.',
};

export const COPY = {
  footer: 'AEGIS is a camera. It cannot move your funds. Classifications can be wrong.',
  wellEmpty: 'No ships in sample. Paste an address to light the first hull.',
  census: 'Mix of the current readable sample. Not TVL. Not advice.',
  censusFull: 'Every Tydro and Nado account AEGIS has found on-chain. Mix by count, not TVL. Not advice.',
  share: 'Pose per AEGIS rules. Rules are public. Camera, not a broker.',
  woundedTape: 'Wounded in sample — not a hit list.',
  oneLiner: 'A camera on how Ink books are aimed.',
} as const;

/** Share text — no balances, ever. */
export function summaryText(address: string, pose: Pose, sensors: { tydro: boolean; nado: boolean }, url: string): string {
  const short = `${address.slice(0, 6)}…${address.slice(-4)}`;
  const tags = pose.tags.length ? pose.tags.join(' + ') : 'NO RULE FIRED';
  const ok = [sensors.tydro ? 'Tydro' : null, sensors.nado ? 'Nado' : null].filter(Boolean).join('+');
  const sensorTxt = ok === 'Tydro+Nado' ? 'sensors Tydro+Nado OK' : ok ? `sensors ${ok} OK, others DARK` : 'sensors DARK';
  return `AEGIS hull ${short}  ${tags}  HULL ${pose.hullTemp}  ${sensorTxt}\n${url}`;
}
