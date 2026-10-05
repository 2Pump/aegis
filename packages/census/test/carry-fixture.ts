/** Synthetic Tydro + Nado market readings for carry tests and the web fixtures (no real data). */
import { TYDRO_RESERVES, type CarryPoint } from '@aegis/ink-io';
import type { OracleWatch } from '../src/index.js';

export const D = 86_400_000;
export const T0 = Date.UTC(2026, 9, 1); // 2026-10-01 00:00 UTC
export const PRICE: Record<string, number> = { WETH: 2000, kBTC: 60000, SolvBTC: 60000, USDT: 1, USDG: 1, GHO: 1, USDC: 1, weETH: 2100, wrsETH: 2080, ezETH: 2090, sUSDe: 1.2, USDe: 1, syrupUSDT: 1.1, kHYPE: 40 };

export interface Rates {
  supply?: Record<string, number>;
  borrow?: Record<string, number>;
  /** daily funding received by shorts (annual rate) per perp id, as a function of the day */
  funding?: Record<number, (day: number) => number>;
  nadoDeposit?: Record<number, number>;
}
export const DEFAULT: Required<Rates> = {
  supply: { WETH: 0.02, kBTC: 0.001, USDT: 0.05, USDC: 0.045, USDG: 0.03, GHO: 0.04, USDe: 0.03, sUSDe: 0.01, syrupUSDT: 0.01, weETH: 0.005, wrsETH: 0.004, ezETH: 0.004, SolvBTC: 0.001, kHYPE: 0.01 },
  borrow: { WETH: 0.03, kBTC: 0.01, USDT: 0.07, USDC: 0.065, USDG: 0.05, GHO: 0.06, USDe: 0.05, sUSDe: 0.03, syrupUSDT: 0.03, weETH: 0.02, wrsETH: 0.02, ezETH: 0.02, SolvBTC: 0.01, kHYPE: 0.03 },
  funding: { 4: () => 0.1, 2: () => 0.08 },
  nadoDeposit: { 0: 0.04, 1: 0.0, 3: 0.01, 5: 0.03 },
};

/** A reading `day` days after T0 (fractional days allowed), with rates integrated linearly from day 0. */
export function point(day: number, r: Rates = {}, over: Partial<CarryPoint> = {}): CarryPoint {
  const R = { ...DEFAULT, ...r, supply: { ...DEFAULT.supply, ...r.supply }, borrow: { ...DEFAULT.borrow, ...r.borrow }, funding: { ...DEFAULT.funding, ...r.funding }, nadoDeposit: { ...DEFAULT.nadoDeposit, ...r.nadoDeposit } };
  const years = day / 365;
  const cumFunding = (id: number, px: number) => {
    // ∫ daily rate × price / 365 over whole days (piecewise constant per day)
    let c = 0;
    for (let k = 0; k < Math.floor(day); k++) c += (R.funding[id]!(k) * px) / 365;
    c += (R.funding[id]!(Math.floor(day)) * px * (day - Math.floor(day))) / 365;
    return c;
  };
  return {
    block: 1_000_000 + Math.round(day * 86_400),
    at: T0 + day * D,
    tydro: TYDRO_RESERVES.map((t) => ({
      symbol: t.symbol,
      asset: t.underlying.toLowerCase(),
      decimals: t.decimals,
      priceUsd: PRICE[t.symbol]!,
      supplyApr: R.supply[t.symbol]!,
      borrowApr: R.borrow[t.symbol]!,
      liquidityIndex: 1 + R.supply[t.symbol]! * years,
      borrowIndex: 1 + R.borrow[t.symbol]! * years,
      supplied: 1_000_000 / PRICE[t.symbol]!,
      borrowed: 600_000 / PRICE[t.symbol]!,
      available: 400_000 / PRICE[t.symbol]!,
      supplyCap: 2_000_000 / PRICE[t.symbol]!,
      borrowCap: 0,
      ltv: 8000,
      liquidationThreshold: 8300,
      borrowingEnabled: true,
      isActive: true,
      isFrozen: false,
    })),
    nado: {
      spot: [
        { productId: 0, symbol: 'USDT0', token: TYDRO_RESERVES.find((t) => t.symbol === 'USDT')!.underlying.toLowerCase(), priceUsd: 1, depositMultiplier: 1 + R.nadoDeposit[0]! * years, borrowMultiplier: 1 + 0.08 * years, deposits: 40e6, borrows: 10e6, withdrawFee: 1, longWeightMaintenance: 1, shortWeightMaintenance: 1 },
        { productId: 3, symbol: 'WETH', token: TYDRO_RESERVES.find((t) => t.symbol === 'WETH')!.underlying.toLowerCase(), priceUsd: 2000, depositMultiplier: 1 + R.nadoDeposit[3]! * years, borrowMultiplier: 1 + 0.03 * years, deposits: 1000, borrows: 100, withdrawFee: 0.0005, longWeightMaintenance: 0.95, shortWeightMaintenance: 1.05 },
        { productId: 1, symbol: 'KBTC', token: TYDRO_RESERVES.find((t) => t.symbol === 'kBTC')!.underlying.toLowerCase(), priceUsd: 60000, depositMultiplier: 1 + R.nadoDeposit[1]! * years, borrowMultiplier: 1 + 0.01 * years, deposits: 10, borrows: 1, withdrawFee: 0.00002, longWeightMaintenance: 0.95, shortWeightMaintenance: 1.05 },
      ],
      perp: [
        { productId: 4, symbol: 'ETH-PERP', priceUsd: 2000, cumFundingLong: cumFunding(4, 2000), cumFundingShort: cumFunding(4, 2000), openInterest: 5000, longWeightMaintenance: 0.95, shortWeightMaintenance: 1.05 },
        { productId: 2, symbol: 'BTC-PERP', priceUsd: 60000, cumFundingLong: cumFunding(2, 60000), cumFundingShort: cumFunding(2, 60000), openInterest: 100, longWeightMaintenance: 0.95, shortWeightMaintenance: 1.05 },
      ],
    },
    errors: [],
    ...over,
  };
}
export const history = (n: number, r: Rates = {}) => Array.from({ length: n }, (_, i) => point(i, r));
export const watch = (status: Record<string, string>): OracleWatch =>
  ({ kind: 'aegis-oracle-watch', rows: Object.entries(status).map(([symbol, s]) => ({ symbol, status: s })) }) as unknown as OracleWatch;
export const okWatch = watch({ WETH: 'OK', kBTC: 'OK', USDT0: 'OK', USDC: 'OK', USDG: 'OK', GHO: 'OK', USDe: 'OK', sUSDe: 'OK', syrupUSDT: 'OK', weETH: 'OK', wrsETH: 'OK', ezETH: 'OK', SolvBTC: 'OK' });
