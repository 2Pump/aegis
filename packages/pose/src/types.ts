/**
 * @aegis/pose — normalized input (Book) and output (Pose) types.
 * Pure data. No React, no IO, no RPC.
 */

/** Stable tag names. Changing these later breaks the culture. */
export const TAGS = [
  'DARK',
  'EMPTY',
  'LOCKED',
  'NAKED',
  'CARRY',
  'EQUITY-MARGIN',
  'KBTC-CORE',
  'STABLE-BALLAST',
  'WOUNDED',
  'LEVERED',
  // v1.1 — appended (never reorder: the census stores tags as bit positions in this list)
  'HOLD',
] as const;
export type Tag = (typeof TAGS)[number];

export type HullTemp = 'NOMINAL' | 'ELEVATED' | 'CRITICAL' | 'UNKNOWN';

export type InkErrorCode =
  | 'WRONG_CHAIN'
  | 'RPC_DEAD'
  | 'VENUE_TIMEOUT'
  | 'PARSE_FAIL'
  | 'EMPTY'
  | 'DARK'
  | 'RATE_LIMIT';

/** Every USD number carries where its price came from. */
export type PriceSource =
  | 'TYDRO_ORACLE' // AaveOracle on Ink — what Tydro HF uses
  | 'NADO_ORACLE' // oracle_price_x18 returned by Nado gateway — what Nado risk uses
  | 'NADO_ONCHAIN' // oracle price last settled on Ink by Nado (FQuerier) — may trail the gateway by seconds
  | 'FIXTURE' // hand-written test data
  | 'OFFCHAIN_DISPLAY_ONLY'; // never used for risk; banner required

/** Coarse asset class, used by EQUITY-MARGIN / STABLE-BALLAST / KBTC-CORE. */
export type AssetClass = 'STABLE' | 'CRYPTO' | 'XSTOCK' | 'GOLD' | 'FX' | 'COMMODITY';

/**
 * Asset family = the thing a perp and a spot/collateral can hedge each other on.
 * e.g. BTC (kBTC, SolvBTC, BTC-PERP), ETH (WETH, weETH, ETH-PERP), SPY (wSPYx, SPY-PERP).
 */
export type Family = string;

export interface Leg {
  symbol: string;
  family: Family;
  assetClass: AssetClass;
  /** token units (human, not raw). Signed for Nado spot (negative = borrow). */
  amount: number;
  /** USD value, signed like amount. */
  usd: number;
  priceUsd: number;
  priceSource: PriceSource;
}

export interface TydroBook {
  /** null = no debt (health factor is infinite). */
  hf: number | null;
  supplies: Leg[];
  debts: Leg[];
  totalCollateralUsd: number;
  totalDebtUsd: number;
  /** supplies − debts */
  usdNet: number;
  /** weighted average liquidation threshold, 0..1, if known */
  liquidationThreshold: number | null;
  /** registry mismatches, unknown reserves, etc. Shown on the plate. */
  notes: string[];
}

export interface NadoSpot extends Leg {
  productId: number;
  subaccount: string;
}

export interface NadoPerp {
  productId: number;
  subaccount: string;
  symbol: string;
  family: Family;
  assetClass: AssetClass;
  /** signed base size (positive = long) */
  sizeBase: number;
  /** signed USD notional = sizeBase × price */
  notionalUsd: number;
  priceUsd: number;
  priceSource: PriceSource;
  /** v_quote_balance in USD */
  vQuoteUsd: number;
  /** vQuote + sizeBase × price (unsettled PnL, before funding settle) */
  unsettledUsd: number;
}

export interface HealthTriple {
  assetsUsd: number;
  liabilitiesUsd: number;
  healthUsd: number;
}

export interface FundingSide {
  symbol: string;
  /** which side of the book this position is on — the rate itself is not wired in V1 */
  side: 'LONG' | 'SHORT';
  rateHourly: number | null;
}

export interface NadoBook {
  subaccounts: string[];
  /** Σ spot usd + Σ perp unsettled usd — computed, not trusted from venue */
  equityUsd: number;
  spots: NadoSpot[];
  perps: NadoPerp[];
  /** healths[1] per Vertex/Nado convention (INITIAL=0, MAINTENANCE=1, PNL=2) */
  maintenance: HealthTriple | null;
  initial: HealthTriple | null;
  /** healths[2] unweighted — used only to cross-check equityUsd */
  unweighted: HealthTriple | null;
  funding: FundingSide[];
  notes: string[];
}

export type Sensor<T> =
  | { status: 'OK'; data: T; asOfTime: number; asOfBlock: number | null }
  | { status: 'DARK'; code: InkErrorCode; message: string; asOfTime: number };

export interface Book {
  /** lowercase 0x address */
  address: string;
  source: 'LIVE' | 'FIXTURE';
  label?: string;
  tydro: Sensor<TydroBook>;
  nado: Sensor<NadoBook>;
  asOfBlock: number | null;
  asOfTime: number;
}

export interface FamilyRow {
  family: Family;
  assetClass: AssetClass;
  /** spot-like net inventory: Nado spot net + Tydro supply − Tydro debt */
  S: number;
  /** long perp notional */
  L: number;
  /** short perp notional (absolute) */
  P: number;
  /** |S − P| / max(S, P, 1) — only meaningful when both legs exist */
  carryGap: number | null;
  carry: boolean;
  naked: boolean;
  residualUsd: number;
}

export interface PoseMetrics {
  S: number;
  P: number;
  L: number;
  E: number | null;
  hf: number | null;
  nadoBuffer: number | null;
  eq: number;
  kb: number;
  st: number;
  totalMarginUsd: number;
  nadoCollateralUsd: number;
  grossPerpUsd: number;
  grossUsd: number;
  families: FamilyRow[];
  /** Tydro loop where every supply and every debt is one asset family (e.g. USD, ETH) — only a depeg can liquidate it. null = not such a loop. */
  correlatedFamily: string | null;
  /** Nado book with borrowing and no perps where every spot leg (≥ dust) is one family — only a depeg can liquidate it. null = not such a loop. */
  correlatedNadoFamily: string | null;
  /** which venue tripped WOUNDED (both false when not wounded) */
  wound: { tydro: boolean; nado: boolean };
}

export interface Pose {
  tags: Tag[];
  /** null = no rule fired (shown as "NO RULE FIRED"). Not a tag. */
  primary: Tag | null;
  residualDeltaUsd: number | null;
  residualDeltaFrac: number | null;
  /** Tydro-derived: 1 − 1/hf, in bps. Nado uses nadoBuffer (see MATH.md). */
  liqDistanceBps: number | null;
  hullTemp: HullTemp;
  reasons: string[];
  darkReasons: string[];
  metrics: PoseMetrics;
  rulesVersion: string;
}
