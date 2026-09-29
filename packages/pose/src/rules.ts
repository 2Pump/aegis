import { PRIMARY_PRIORITY, RULES } from './config.js';
import type { Tag } from './types.js';

export interface RuleText {
  tag: Tag;
  kind: 'STATE' | 'PRIMARY' | 'OVERLAY';
  human: string;
  predicate: string;
}

const R = RULES;
const p = (f: number) => `${Math.round(f * 100)}%`;

/** Rendered by /rules and the RULES drawer. Built from the same constants the classifier uses. */
export const RULE_TEXT: RuleText[] = [
  {
    tag: 'DARK',
    kind: 'STATE',
    human: 'A sensor could not be read. We refuse to guess the missing half of the book.',
    predicate: 'tydro.status = DARK OR nado.status = DARK (RPC dead, venue timeout, parse fail, rate limit)',
  },
  {
    tag: 'EMPTY',
    kind: 'STATE',
    human: 'Nothing on Tydro or Nado worth drawing.',
    predicate: `Σ |USD| of every leg < $${R.DUST_USD}`,
  },
  {
    tag: 'WOUNDED',
    kind: 'OVERLAY',
    human: 'Close to liquidation on at least one venue. Stacks with any other tag. A same-family Tydro loop (stables on stables, ETH on ETH) can only be liquidated by a depeg, so it has its own, tighter line.',
    predicate: `hf < ${R.WOUNDED_HF} OR (1 − 1/hf) < ${p(R.LIQ_DISTANCE_CRIT)} — or, for a same-family Tydro loop, hf < ${R.WOUNDED_HF_CORRELATED} instead — OR nadoBuffer < ${p(R.NADO_BUFFER_CRIT)} — or, for a same-family Nado loop, nadoBuffer < ${p(R.NADO_BUFFER_CRIT_CORRELATED)} instead`,
  },
  {
    tag: 'CARRY',
    kind: 'PRIMARY',
    human: 'Owns an asset and is short the same asset on perps, sized roughly equal. Basis-ish hedge.',
    predicate: `∃ family F: |S_F − P_F| / max(S_F, P_F, 1) ≤ ${p(R.CARRY_BAND)} AND min(S_F, P_F) ≥ $${R.CARRY_MIN_LEG_USD}`,
  },
  {
    tag: 'EQUITY-MARGIN',
    kind: 'PRIMARY',
    human: 'Tokenized stocks (xStocks) are posted as margin on Nado.',
    predicate: `eq ≥ $${R.EQUITY_MIN_USD} AND eq / max(nadoCollateral, eq, 1) ≥ ${p(R.EQUITY_SHARE)}`,
  },
  {
    tag: 'NAKED',
    kind: 'PRIMARY',
    human: 'Perps pointed one way on a family, with no matching spot hedge.',
    predicate: `∃ family F: (L_F + P_F) ≥ $${R.NAKED_MIN_GROSS_USD} AND NOT CARRY_F AND |L_F − P_F| / max(L_F + P_F, 1) > ${p(R.NAKED_IMBALANCE)}`,
  },
  {
    tag: 'KBTC-CORE',
    kind: 'PRIMARY',
    human: 'kBTC is the backbone of the margin stack.',
    predicate: `kb ≥ $${R.KBTC_MIN_USD} AND kb / max(totalMargin, 1) ≥ ${p(R.KBTC_SHARE)}`,
  },
  {
    tag: 'LOCKED',
    kind: 'PRIMARY',
    human: 'Parked in the Tydro locker. Not fighting on Nado.',
    predicate: `tydroSupplies > $${R.LOCKED_MIN_SUPPLY_USD} AND no Nado perps AND no Nado risk spots (non-stable or borrowed, ≥ $${R.DUST_USD})`,
  },
  {
    tag: 'STABLE-BALLAST',
    kind: 'PRIMARY',
    human: 'Mostly stables in the hold.',
    predicate: `st / max(totalMargin, 1) ≥ ${p(R.STABLE_SHARE)}`,
  },
  {
    tag: 'LEVERED',
    kind: 'PRIMARY',
    human: 'Perp notional is a large multiple of account equity.',
    predicate: `grossPerp / max(E, 1) ≥ ${R.LEVERED_RATIO}×`,
  },
  {
    tag: 'HOLD',
    kind: 'PRIMARY',
    human: 'Owns non-stable assets outright — no perps, no borrowing. Only when no other pose fits.',
    predicate: `non-stable spot + Tydro supply ≥ $${R.HOLD_MIN_USD} AND no perp ≥ $${R.DUST_USD} AND no debt ≥ $${R.DUST_USD} (Tydro or Nado)`,
  },
];

export const PRIORITY_TEXT = `Primary = first match of ${PRIMARY_PRIORITY.join(' > ')}. WOUNDED is an overlay; it is primary only if nothing else fires. DARK and EMPTY short-circuit.`;

export const DEFINITIONS: Array<[string, string]> = [
  ['S_F', 'USD of spot-like inventory in family F: Nado spot net balance + Tydro supply − Tydro debt (floored at 0 for CARRY)'],
  ['P_F', 'USD notional of short perps in family F (absolute)'],
  ['L_F', 'USD notional of long perps in family F'],
  ['E', 'Nado account equity: Σ spot USD + Σ perp (v_quote + size × oracle price)'],
  ['hf', 'Tydro health factor from Pool.getUserAccountData (on-chain, Tydro oracle)'],
  ['same-family loop', 'Tydro book with debt where every supply and every debt (≥ dust) is in ONE asset family — e.g. USDe/sUSDe/USDT/USDC (USD), or weETH/ezETH/WETH (ETH). On Nado: borrowing, no perps, every spot leg in one family (e.g. USDC deposited, USDT0 borrowed)'],
  ['nadoBuffer', 'Nado maintenance health ÷ maintenance-weighted assets (healths[1]); < 0 means liquidatable'],
  ['eq', 'USD of xStock balances held as collateral (positive Nado spot, wSPYx / wQQQx / wAAPLx / …)'],
  ['kb', 'USD of kBTC (Nado KBTC spot + Tydro kBTC supply). SolvBTC is BTC family but not kBTC.'],
  ['st', 'USD of stables (USDT0, USDC, USDG, GHO, USDe, sUSDe, syrupUSDT)'],
  ['totalMargin', 'Positive Nado spot USD + Tydro supply USD'],
];
