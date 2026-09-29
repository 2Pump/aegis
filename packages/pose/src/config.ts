/**
 * THE ONLY PLACE CLASSIFICATION CONSTANTS LIVE.
 * docs/RULES.md and the in-app /rules page are checked against this file by
 * packages/pose/test/rules-doc.test.ts. Change a number here → update RULES.md or the test fails.
 */
export const RULES = {
  RULES_VERSION: 'v1.2.0',

  /** EMPTY: gross |USD| across every leg below this */
  DUST_USD: 10,

  /** WOUNDED: Tydro health factor below this */
  WOUNDED_HF: 1.25,
  /** WOUNDED: Nado maintenance buffer (maintHealth / maintAssets) below this */
  NADO_BUFFER_CRIT: 0.1,
  /** WOUNDED: Tydro liquidation distance (1 − 1/hf) below this */
  LIQ_DISTANCE_CRIT: 0.08,
  /** WOUNDED for a same-family Tydro loop (only a depeg liquidates it): HF below this. Replaces the two lines above for such loops. */
  WOUNDED_HF_CORRELATED: 1.03,
  /** WOUNDED for a same-family Nado loop (stables only, no perps): maintenance buffer below this. Replaces NADO_BUFFER_CRIT for such books. */
  NADO_BUFFER_CRIT_CORRELATED: 0.03,

  /** ELEVATED hull: Tydro HF below this */
  ELEVATED_HF: 1.5,
  /** ELEVATED hull for a same-family Tydro loop: HF below this */
  ELEVATED_HF_CORRELATED: 1.08,
  /** ELEVATED hull for a same-family Nado loop: maintenance buffer below this */
  NADO_BUFFER_WARN_CORRELATED: 0.08,
  /** ELEVATED hull: Nado maintenance buffer below this */
  NADO_BUFFER_WARN: 0.25,

  /** LOCKED: Tydro supplies above this */
  LOCKED_MIN_SUPPLY_USD: 50,

  /** CARRY: |S_F − P_F| / max(S_F, P_F, 1) ≤ band */
  CARRY_BAND: 0.15,
  /** CARRY: min(S_F, P_F) ≥ this */
  CARRY_MIN_LEG_USD: 200,

  /** NAKED: (L_F + P_F) ≥ this */
  NAKED_MIN_GROSS_USD: 200,
  /** NAKED: |L_F − P_F| / max(L_F + P_F, 1) > this */
  NAKED_IMBALANCE: 0.5,

  /** EQUITY-MARGIN: eq ≥ this */
  EQUITY_MIN_USD: 200,
  /** EQUITY-MARGIN: eq / max(nadoCollateral, eq, 1) ≥ this */
  EQUITY_SHARE: 0.25,

  /** KBTC-CORE: kb ≥ this */
  KBTC_MIN_USD: 200,
  /** KBTC-CORE: kb / max(totalMargin, 1) ≥ this */
  KBTC_SHARE: 0.35,

  /** STABLE-BALLAST: st / max(totalMargin, 1) ≥ this */
  STABLE_SHARE: 0.5,

  /** LEVERED: grossPerp / max(E, 1) ≥ this */
  LEVERED_RATIO: 3,

  /** HOLD: non-stable assets held outright ≥ this (and no perps, no debt ≥ DUST_USD) */
  HOLD_MIN_USD: 10,
} as const;

export type RulesConfig = typeof RULES;

/** Primary priority after DARK / EMPTY. WOUNDED is an overlay and only primary as last resort. */
export const PRIMARY_PRIORITY = [
  'CARRY',
  'EQUITY-MARGIN',
  'NAKED',
  'KBTC-CORE',
  'LOCKED',
  'STABLE-BALLAST',
  'LEVERED',
  'HOLD',
] as const;

/** Tag colors — the well and the plates use these. */
export const TAG_COLORS: Record<string, string> = {
  CARRY: '#4CE0D2',
  NAKED: '#F5C14A',
  'EQUITY-MARGIN': '#A78BFA',
  'KBTC-CORE': '#C4CED8',
  LOCKED: '#64748B',
  WOUNDED: '#FF4D4D',
  DARK: '#4B5563',
  EMPTY: '#374151',
  'STABLE-BALLAST': '#7DD3FC',
  LEVERED: '#FB923C',
  HOLD: '#86EFAC',
};
