import { TAG_COLORS, type HullTemp, type Pose, type Tag } from '@aegis/pose';

/* ───────────────────────── deterministic hashing ───────────────────────── */

/** FNV-1a 32-bit over the lowercase address. Same address → same ship, every refresh. */
export function hash32(s: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  const str = s.toLowerCase();
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // murmur3 fmix32 avalanche — addresses that differ only in the last nibble must land far apart
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}
const unit = (h: number) => h / 0xffffffff;

/* ───────────────────────── size bands (privacy default) ───────────────────────── */

export type SizeBand = 'dust' | '<1k' | '1–10k' | '10–100k' | '100k+';
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

export function tagColor(tag: Tag | null): string {
  if (!tag) return '#6B7280';
  return TAG_COLORS[tag] ?? '#9CA3AF';
}

/** Color by primary, but a WOUNDED ship always burns red. */
export function shipColor(p: Pose): string {
  if (p.tags.includes('WOUNDED')) return TAG_COLORS.WOUNDED!;
  return tagColor(p.primary);
}

/* ───────────────────────── well layout ───────────────────────── */

export interface Ship {
  address: string;
  pose: Pose;
  label?: string;
  fixture?: boolean;
  focused?: boolean;
}

export interface PlacedShip extends Ship {
  /** 0..1 of well radius */
  r: number;
  angle: number;
  sizePx: number;
  color: string;
  hollow: boolean;
  pulse: boolean;
  band: SizeBand;
}

/** Risk → radius. WOUNDED falls inward. DARK drifts at the rim. */
const RING: Record<HullTemp, [number, number]> = {
  CRITICAL: [0.12, 0.3],
  ELEVATED: [0.34, 0.52],
  NOMINAL: [0.56, 0.82],
  UNKNOWN: [0.86, 0.96],
};

export function placeShips(ships: Ship[]): PlacedShip[] {
  return ships.map((s) => {
    const h1 = hash32(s.address);
    const h2 = hash32(s.address, 0x9e3779b9);
    const [lo, hi] = RING[s.pose.hullTemp];
    const usd = shipSizeUsd(s.pose);
    const sizePx = 3 + Math.min(14, Math.log10(Math.max(usd, 1) + 1) * 2.4);
    return {
      ...s,
      r: lo + (hi - lo) * unit(h2),
      angle: unit(h1) * Math.PI * 2,
      sizePx,
      color: shipColor(s.pose),
      hollow: s.pose.primary === 'DARK' || s.pose.primary === 'EMPTY',
      pulse: s.pose.tags.includes('WOUNDED'),
      band: sizeBand(usd),
    };
  });
}

export interface WellView {
  cx: number;
  cy: number;
  R: number;
}

export function wellView(w: number, h: number): WellView {
  return { cx: w / 2, cy: h / 2, R: Math.min(w, h) / 2 - 12 };
}

export function shipXY(s: PlacedShip, v: WellView): [number, number] {
  return [v.cx + Math.cos(s.angle) * s.r * v.R, v.cy + Math.sin(s.angle) * s.r * v.R];
}

export function hitTest(ships: PlacedShip[], v: WellView, x: number, y: number): PlacedShip | null {
  let best: PlacedShip | null = null;
  let bestD = Infinity;
  for (const s of ships) {
    const [sx, sy] = shipXY(s, v);
    const d = Math.hypot(sx - x, sy - y);
    if (d < Math.max(10, s.sizePx + 4) && d < bestD) {
      best = s;
      bestD = d;
    }
  }
  return best;
}

/** 2D canvas draw. Light enough for phones. `t` = ms for pulses. */
export function drawWell(ctx: CanvasRenderingContext2D, w: number, h: number, ships: PlacedShip[], t: number, hover: PlacedShip | null): void {
  const v = wellView(w, h);
  ctx.clearRect(0, 0, w, h);

  // disc + vignette
  const g = ctx.createRadialGradient(v.cx, v.cy, v.R * 0.05, v.cx, v.cy, v.R);
  g.addColorStop(0, '#000000');
  g.addColorStop(0.7, '#05080C');
  g.addColorStop(1, '#0B1118');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(v.cx, v.cy, v.R, 0, Math.PI * 2);
  ctx.fill();

  // gravity contours
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

  // ships
  for (const s of ships) {
    const [x, y] = shipXY(s, v);
    const pulse = s.pulse ? 0.5 + 0.5 * Math.sin(t / 260 + s.angle * 3) : 0;
    const size = s.sizePx * (1 + pulse * 0.35);
    // glow
    if (!s.hollow) {
      const glow = ctx.createRadialGradient(x, y, 0, x, y, size * 3);
      glow.addColorStop(0, hexA(s.color, 0.45 + pulse * 0.3));
      glow.addColorStop(1, hexA(s.color, 0));
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(x, y, size * 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(x, y, size / 2 + 1, 0, Math.PI * 2);
    if (s.hollow) {
      ctx.strokeStyle = hexA(s.color === '#6B7280' ? '#9CA3AF' : s.color, 0.9);
      ctx.lineWidth = 1.5;
      ctx.stroke();
    } else {
      ctx.fillStyle = s.color;
      ctx.fill();
    }
    if (s.focused || s === hover) {
      ctx.strokeStyle = '#E5F9F7';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x, y, size / 2 + 6, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

function hexA(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a.toFixed(3)})`;
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
