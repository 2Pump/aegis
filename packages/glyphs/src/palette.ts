/**
 * The colours, in one place — "Ivory & Bank Green" (chosen 2026-10-12, docs/COLOURS.md).
 * A light, warm page; near-black ink; one deep green accent. Red is reserved for near liquidation.
 *
 * Every renderer (site CSS tokens, the 2D well, the sphere, chips and charts) reads from here, so the pose package
 * (rules) never changes for a colour decision. The share card and the emails keep their own dark look on purpose:
 * they're seen on X and in mail clients, away from the site.
 */
import type { HullTemp, Tag } from '@aegis/pose';

export const PALETTE = {
  name: 'ivory-bank-green-1',
  page: '#F5F3EE',
  panel: '#FBFAF7',
  /** inputs, code, charts' plot area */
  field: '#FFFFFF',
  well: '#EEEBE3',
  wellDeep: '#E4E0D5',
  hair: '#C6C0B2',
  hair2: '#D8D2C5',
  ink: '#1A1E22',
  inkDim: '#434A50',
  inkFaint: '#5B6268',
  accent: '#1F5C4A',
  accentInk: '#FFFFFF',
  /** risk levels */
  /** SAFE is the accent green: calm, and never confused with "couldn't read" grey */
  safe: '#1F5C4A',
  watch: '#A57F1F',
  /** watch as small text on the page (darker, for contrast) */
  watchText: '#7E5F17',
  near: '#B42F35',
  /** liquidatable — darker than near, still the same red family */
  liq: '#8E1F25',
  /** the high step on stress scales, between watch and near */
  high: '#B8612A',
  equity: '#45508F',
} as const;

/** Position-type colours, checked for colour-blind readers against each other and against near-liquidation red. */
export const TYPE_COLOR: Readonly<Record<string, string>> = {
  CARRY: '#2F7A6A', // hedged
  'EQUITY-MARGIN': '#45508F', // stocks as collateral
  NAKED: '#8A4A78', // unhedged bet
  'KBTC-CORE': '#6B5208', // bitcoin-backed
  LEVERED: '#C0612B', // high leverage
  HOLD: '#5A7A1E', // just holding
  LOCKED: '#4E7798', // lending only
  'STABLE-BALLAST': '#8A8572', // mostly stablecoins
  WOUNDED: PALETTE.near,
  DARK: '#7E868B', // couldn't read
  EMPTY: '#A3A8AB',
};
export const OTHER_COLOR = '#7E868B';

export const RISK_COLOR: Readonly<Record<HullTemp, string>> = {
  NOMINAL: PALETTE.safe,
  ELEVATED: PALETTE.watch,
  CRITICAL: PALETTE.near,
  UNKNOWN: OTHER_COLOR,
};

export const typeColor = (tag: Tag | string | null | undefined): string => (tag ? (TYPE_COLOR[tag] ?? OTHER_COLOR) : OTHER_COLOR);
