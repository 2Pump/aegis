import { TAG_COLORS, type HullTemp, type Tag } from '@aegis/pose';

/* Shared by the legacy well (index.ts) and WELL GLASS (glass.ts). */

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
export const unit = (h: number) => h / 0xffffffff;

export type SizeBand = 'dust' | '<1k' | '1–10k' | '10–100k' | '100k+';

export function tagColor(tag: Tag | null): string {
  if (!tag) return '#6B7280';
  return TAG_COLORS[tag] ?? '#9CA3AF';
}

/** What the well needs to draw a ship. Built from a live Pose or from a census row — never from balances. */
export interface ShipLite {
  address: string;
  primary: Tag | null;
  tags: readonly Tag[];
  hullTemp: HullTemp;
  band: SizeBand;
  label?: string;
  fixture?: boolean;
  /** opened by this viewer — ringed */
  focused?: boolean;
  /** ms timestamp of the last live change — drawn as one short pulse */
  flashAt?: number;
}

/**
 * Risk → radius (fraction of the well). The meaning of the well: CRITICAL innermost, DARK sensors at the rim.
 * WELL GLASS reuses this exact table — only the paint and labels changed.
 */
export const HULL_RING: Record<HullTemp, readonly [number, number]> = {
  CRITICAL: [0.12, 0.3],
  ELEVATED: [0.34, 0.52],
  NOMINAL: [0.56, 0.82],
  UNKNOWN: [0.86, 0.96],
};

export function hexA(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a.toFixed(3)})`;
}
