import type { AssetClass, Family } from './types.js';

/**
 * Symbol → asset family.
 * Sources (see docs/LOOKUPS.md): Tydro reserves from aave-address-book AaveV3InkWhitelabel,
 * Nado symbols from gateway `symbols` query (fetched 2026-09-28).
 *
 * A symbol not in this table falls back to the perp base (e.g. "SOL-PERP" → SOL, CRYPTO).
 * Unknown spot symbols fall back to their own name as family. That keeps CARRY honest:
 * an unknown token can never silently hedge a known perp.
 */
interface FamilyInfo {
  family: Family;
  assetClass: AssetClass;
}

const TABLE: Record<string, FamilyInfo> = {
  // ── BTC family ─────────────────────────────────────────
  KBTC: { family: 'BTC', assetClass: 'CRYPTO' }, // Nado spot product 1
  SOLVBTC: { family: 'BTC', assetClass: 'CRYPTO' },
  'BTC-PERP': { family: 'BTC', assetClass: 'CRYPTO' },

  // ── ETH family ─────────────────────────────────────────
  WETH: { family: 'ETH', assetClass: 'CRYPTO' },
  ETH: { family: 'ETH', assetClass: 'CRYPTO' },
  WEETH: { family: 'ETH', assetClass: 'CRYPTO' },
  WRSETH: { family: 'ETH', assetClass: 'CRYPTO' },
  EZETH: { family: 'ETH', assetClass: 'CRYPTO' },
  'ETH-PERP': { family: 'ETH', assetClass: 'CRYPTO' },

  // ── HYPE family ────────────────────────────────────────
  KHYPE: { family: 'HYPE', assetClass: 'CRYPTO' },
  'HYPE-PERP': { family: 'HYPE', assetClass: 'CRYPTO' },

  // ── Gold ───────────────────────────────────────────────
  XAUT0: { family: 'XAU', assetClass: 'GOLD' },
  'XAUT-PERP': { family: 'XAU', assetClass: 'GOLD' },

  // ── Stables (all one family: USD) ──────────────────────
  USDT0: { family: 'USD', assetClass: 'STABLE' },
  USDT: { family: 'USD', assetClass: 'STABLE' }, // Tydro lists USDT0 under key "USDT"
  USDC: { family: 'USD', assetClass: 'STABLE' },
  USDG: { family: 'USD', assetClass: 'STABLE' },
  GHO: { family: 'USD', assetClass: 'STABLE' },
  USDE: { family: 'USD', assetClass: 'STABLE' },
  SUSDE: { family: 'USD', assetClass: 'STABLE' },
  SYRUPUSDT: { family: 'USD', assetClass: 'STABLE' },

  // ── xStocks (Nado wrapped spot) ↔ equity perps ─────────
  WSPYX: { family: 'SPY', assetClass: 'XSTOCK' },
  SPYX: { family: 'SPY', assetClass: 'XSTOCK' },
  'SPY-PERP': { family: 'SPY', assetClass: 'XSTOCK' },
  WQQQX: { family: 'QQQ', assetClass: 'XSTOCK' },
  QQQX: { family: 'QQQ', assetClass: 'XSTOCK' },
  'QQQ-PERP': { family: 'QQQ', assetClass: 'XSTOCK' },
  WAAPLX: { family: 'AAPL', assetClass: 'XSTOCK' },
  AAPLX: { family: 'AAPL', assetClass: 'XSTOCK' },
  'AAPL-PERP': { family: 'AAPL', assetClass: 'XSTOCK' },
  WNVDAX: { family: 'NVDA', assetClass: 'XSTOCK' },
  NVDAX: { family: 'NVDA', assetClass: 'XSTOCK' },
  'NVDA-PERP': { family: 'NVDA', assetClass: 'XSTOCK' },
  WTSLAX: { family: 'TSLA', assetClass: 'XSTOCK' },
  TSLAX: { family: 'TSLA', assetClass: 'XSTOCK' },
  'TSLA-PERP': { family: 'TSLA', assetClass: 'XSTOCK' },
  WGOOGLX: { family: 'GOOGL', assetClass: 'XSTOCK' },
  'GOOGL-PERP': { family: 'GOOGL', assetClass: 'XSTOCK' },
  WMETAX: { family: 'META', assetClass: 'XSTOCK' },
  'META-PERP': { family: 'META', assetClass: 'XSTOCK' },
  WMSFTX: { family: 'MSFT', assetClass: 'XSTOCK' },
  'MSFT-PERP': { family: 'MSFT', assetClass: 'XSTOCK' },
  WAMZNX: { family: 'AMZN', assetClass: 'XSTOCK' },
  'AMZN-PERP': { family: 'AMZN', assetClass: 'XSTOCK' },

  // ── FX perps (isolated-only on Nado) ───────────────────
  'EURUSD-PERP': { family: 'EURUSD', assetClass: 'FX' },
  'GBPUSD-PERP': { family: 'GBPUSD', assetClass: 'FX' },
  'USDJPY-PERP': { family: 'USDJPY', assetClass: 'FX' },

  // ── Commodities ────────────────────────────────────────
  'WTI-PERP': { family: 'WTI', assetClass: 'COMMODITY' },
  'XAG-PERP': { family: 'XAG', assetClass: 'COMMODITY' },
};

/** Equity perps with no xStock spot on Nado still count as XSTOCK asset class. */
const EQUITY_PERPS = new Set([
  'LLY', 'MU', 'AMD', 'DELL', 'MSTR', 'SNDK', 'HIMS', 'CRCL', 'ORCL', 'AVGO', 'MRVL', 'INTC', 'NBIS', 'SPCX',
]);

export function familyOf(symbol: string): FamilyInfo {
  const key = symbol.toUpperCase();
  const hit = TABLE[key];
  if (hit) return hit;
  if (key.endsWith('-PERP')) {
    const base = key.slice(0, -'-PERP'.length);
    return { family: base, assetClass: EQUITY_PERPS.has(base) ? 'XSTOCK' : 'CRYPTO' };
  }
  return { family: key, assetClass: 'CRYPTO' };
}

/** kBTC family for KBTC-CORE is strictly kBTC (not SolvBTC). */
export function isKbtc(symbol: string): boolean {
  const k = symbol.toUpperCase();
  return k === 'KBTC';
}
