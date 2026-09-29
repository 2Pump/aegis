import type { SizeBand } from '@aegis/glyphs';
import type { Tag } from '@aegis/pose';

/**
 * Well filters — pure, so they are unit-tested and shareable through the URL
 * (?pose=CARRY,NAKED&venue=nado&min=1k&wounded=1&find=0x…).
 * Filtering never MOVES a ship: positions come from the address hash, so a filtered well is the same map with fewer dots.
 */
export type VenueFilter = 'all' | 'tydro' | 'nado' | 'both';
export type MinBand = 'all' | '1k' | '10k' | '100k';
/** 'NONE' = no rule fired */
export type PoseKey = Tag | 'NONE';

export interface WellFilter {
  /** empty = every pose */
  poses: PoseKey[];
  venue: VenueFilter;
  min: MinBand;
  woundedOnly: boolean;
  /** lowercase 0x address to find, or '' */
  find: string;
}

export const EMPTY_FILTER: WellFilter = { poses: [], venue: 'all', min: 'all', woundedOnly: false, find: '' };

export interface FilterableShip {
  address: string;
  primary: Tag | null;
  tags: readonly Tag[];
  band: SizeBand;
  venues?: { tydro: boolean; nado: boolean };
}

const BAND_RANK: Record<SizeBand, number> = { dust: 0, '<1k': 1, '1–10k': 2, '10–100k': 3, '100k+': 4 };
const MIN_RANK: Record<MinBand, number> = { all: 0, '1k': 2, '10k': 3, '100k': 4 };

export function matches(s: FilterableShip, f: WellFilter): boolean {
  if (f.poses.length && !f.poses.includes(s.primary ?? 'NONE')) return false;
  if (f.woundedOnly && !s.tags.includes('WOUNDED')) return false;
  if (BAND_RANK[s.band] < MIN_RANK[f.min]) return false;
  if (f.venue !== 'all') {
    const v = s.venues;
    if (!v) return false; // venue unknown (e.g. a hull opened this session) — only shown under "all"
    if (f.venue === 'tydro' && !v.tydro) return false;
    if (f.venue === 'nado' && !v.nado) return false;
    if (f.venue === 'both' && !(v.tydro && v.nado)) return false;
  }
  return true;
}

export function applyFilter<T extends FilterableShip>(ships: readonly T[], f: WellFilter): T[] {
  const active = f.poses.length > 0 || f.venue !== 'all' || f.min !== 'all' || f.woundedOnly;
  return active ? ships.filter((s) => matches(s, f)) : [...ships];
}

export const isFilterActive = (f: WellFilter) => f.poses.length > 0 || f.venue !== 'all' || f.min !== 'all' || f.woundedOnly || f.find !== '';

const POSE_KEYS: readonly PoseKey[] = ['CARRY', 'EQUITY-MARGIN', 'NAKED', 'KBTC-CORE', 'LOCKED', 'STABLE-BALLAST', 'LEVERED', 'HOLD', 'WOUNDED', 'DARK', 'NONE'];
export const POSE_CHIPS = POSE_KEYS;

/** URL ⇄ filter. Unknown values are ignored, never trusted. */
export function filterFromParams(p: URLSearchParams): WellFilter {
  const poses = (p.get('pose') ?? '')
    .split(',')
    .map((x) => x.trim().toUpperCase())
    .filter((x): x is PoseKey => (POSE_KEYS as readonly string[]).includes(x));
  const venue = (['all', 'tydro', 'nado', 'both'] as const).find((v) => v === p.get('venue')) ?? 'all';
  const min = (['all', '1k', '10k', '100k'] as const).find((v) => v === p.get('min')) ?? 'all';
  const find = /^0x[0-9a-fA-F]{40}$/.test(p.get('find') ?? '') ? p.get('find')!.toLowerCase() : '';
  return { poses, venue, min, woundedOnly: p.get('wounded') === '1', find };
}

export function filterToParams(f: WellFilter): Record<string, string> {
  const out: Record<string, string> = {};
  if (f.poses.length) out.pose = f.poses.join(',');
  if (f.venue !== 'all') out.venue = f.venue;
  if (f.min !== 'all') out.min = f.min;
  if (f.woundedOnly) out.wounded = '1';
  if (f.find) out.find = f.find;
  return out;
}
