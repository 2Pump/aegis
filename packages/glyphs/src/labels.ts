import type { HullTemp, Tag } from '@aegis/pose';

/*
 * Plain-language wording — the ONE place user-facing names come from (approved 2026-09-29).
 * Display only: the stored tag names, the rules, census.json and share-link parameters (?pose=CARRY) are unchanged,
 * so old links keep working and the classifier is untouched. The rules page shows both the plain name and the rule tag.
 */

/** Position type (a rule tag) → the name people read. */
export const TAG_LABEL: Readonly<Record<Tag, string>> = {
  CARRY: 'Hedged',
  NAKED: 'Unhedged bet',
  LEVERED: 'High leverage',
  'EQUITY-MARGIN': 'Stocks as collateral',
  'KBTC-CORE': 'Bitcoin-backed',
  'STABLE-BALLAST': 'Mostly stablecoins',
  LOCKED: 'Lending only',
  HOLD: 'Just holding',
  WOUNDED: 'Near liquidation',
  DARK: "Couldn't read",
  EMPTY: 'Empty',
};
/** One line each: what the wallet is doing. */
export const TAG_MEANING: Readonly<Record<Tag, string>> = {
  CARRY: 'Holds a coin and is short the same coin on perps, roughly equal, so price moves mostly cancel out.',
  NAKED: 'Perp positions pointing one way, with nothing on the other side.',
  LEVERED: 'Positions many times bigger than the money in the account.',
  'EQUITY-MARGIN': 'Tokenized stocks posted as margin on Nado.',
  'KBTC-CORE': 'Mostly kBTC underneath everything.',
  'STABLE-BALLAST': 'Mostly dollar-pegged coins.',
  LOCKED: 'Money parked in Tydro lending, no trading on Nado.',
  HOLD: 'Owns coins outright; no perps, no borrowing.',
  WOUNDED: 'Close to being force-closed on at least one venue.',
  DARK: 'A data source failed; the last good reading is kept.',
  EMPTY: 'Nothing worth drawing.',
};
export const NO_TYPE_LABEL = 'Unclassified';

/*
 * Two different near-liquidation totals, named so they can't be read as contradicting each other:
 *  - the RISK STATE: every wallet whose current risk is near liquidation (census counts.wounded, any position type)
 *  - the SOLE CLASSIFICATION: wallets for which "near liquidation" is the only type that applies (main type WOUNDED)
 */
export const NEAR_STATE_LABEL = 'Current risk state — near liquidation';
export const NEAR_STATE_LONG = 'Wallets currently in the near-liquidation risk state';
export const NEAR_SOLE_LABEL = 'Near liquidation — sole classification';
export const NEAR_EXPLAIN =
  'A wallet can be near liquidation while still being classified as Hedged, Unhedged, Bitcoin-backed, or another position type. The smaller figure counts wallets for which Near Liquidation is the only applicable classification.';

/** A wallet's MAIN position type as a label (mix bars, type filters, charts): WOUNDED there means the sole classification. */
export function primaryTypeLabel(t: Tag | 'NONE' | null): string {
  if (t === null || t === 'NONE') return NO_TYPE_LABEL;
  return t === 'WOUNDED' ? NEAR_SOLE_LABEL : TAG_LABEL[t];
}
export const NO_TYPE_MEANING = "Doesn't match any pattern.";

export function tagLabel(tag: Tag | null): string {
  return tag ? TAG_LABEL[tag] : NO_TYPE_LABEL;
}

/** Risk level (hull temp) → plain word. */
export const RISK_LABEL: Readonly<Record<HullTemp, string>> = {
  NOMINAL: 'Safe',
  ELEVATED: 'Watch',
  CRITICAL: 'Near liquidation',
  UNKNOWN: "Couldn't read",
};
export const riskLabel = (t: HullTemp) => RISK_LABEL[t];

/** Size bands, written as money. */
export const SIZE_LABEL: Readonly<Record<'dust' | '<1k' | '1–10k' | '10–100k' | '100k+', string>> = {
  dust: 'under $10',
  '<1k': 'under $1k',
  '1–10k': '$1k–10k',
  '10–100k': '$10k–100k',
  '100k+': '$100k+',
};

/** HUD: how close the camera is (sphere LOD bands). */
export const VIEW_LABEL = { HAZE: 'FAR', MANTLE: 'OVERVIEW', TISSUE: 'CLOSE-UP', NODE: 'WALLET' } as const;
/** HUD: what the sphere turns around. */
export const CENTRE_LABEL = { CORE: 'SPHERE', HULL: 'WALLET', POINT: 'POINT' } as const;

/** Venue sensor state → plain word. */
export const SOURCE_LABEL = { OK: 'OK', DARK: "couldn't read" } as const;

/**
 * Split a classifier reason ("CARRY · ETH: spot-like …") into its plain name and the rule tag, for display.
 * The reason text itself is the rule's audit trail and is shown unchanged after the name.
 */
export function reasonParts(r: string): { label: string | null; tag: string | null; rest: string } {
  const m = /^([A-Z][A-Z-]*(?: [A-Z]+)*) · ([\s\S]*)$/.exec(r);
  if (!m) {
    if (r.startsWith('NO RULE FIRED · ')) return { label: NO_TYPE_LABEL, tag: 'NO RULE FIRED', rest: r.slice(16) };
    return { label: null, tag: null, rest: r };
  }
  const tag = m[1]!;
  const label = tag in TAG_LABEL ? TAG_LABEL[tag as Tag] : tag === 'NOTE' ? 'Note' : tag === 'NO RULE FIRED' ? NO_TYPE_LABEL : null;
  const rest = m[2]!.replace(/\bTYDRO_SENSOR\b/g, 'Tydro').replace(/\bNADO_SENSOR\b/g, 'Nado').replace('both sensors unreadable', 'both venues unreadable');
  return { label, tag, rest };
}

/** Sensor-failure reason ("TYDRO_SENSOR: code — msg") → plain lead-in. */
export function darkReasonText(r: string): string {
  return r.replace(/^TYDRO_SENSOR: /, "Tydro couldn't be read: ").replace(/^NADO_SENSOR: /, "Nado couldn't be read: ");
}
