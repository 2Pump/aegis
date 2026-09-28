# MATH — every formula, with a worked example

All code: `packages/pose/src/classify.ts`, `packages/ink-io/src/{tydro,nado}.ts`.

## 1. Unit conversions

**Nado x18:** `value = BigInt(raw) / 1e18` (converted to float64 at the edge; ~15 significant digits).
Example (docs payload): KBTC spot `amount = -600152323366021154` → −0.600152 KBTC;
`oracle_price_x18 = 115596528090565357611177` → $115,596.53. USD = −0.600152 × 115,596.53 = **−$69,375.52** (a borrow).

**Tydro:** token amount = `balanceOf / 10^decimals`; price = `getAssetsPrices[i] / BASE_CURRENCY_UNIT` (Aave v3: 1e8).
Example: aWETH balance 0.75e18, price 4000e8 → 0.75 × 4000 = **$3,000**.
HF = `healthFactor / 1e18`. LT = `currentLiquidationThreshold / 10,000`.

## 2. Nado equity and buffer

`E = Σ spot.usd + Σ perp.(v_quote + size × price)`
EX1: KBTC 0.1 × 100,000 = 10,000; BTC-PERP size −0.1, v_quote +10,000 → unsettled 10,000 − 10,000 = 0. **E = $10,000.**
Cross-check: `healths[2].health` must equal E within max($1, 1%). Docs payload: 387,544.48 vs 456,895.62 − 69,375.52 = 387,520.10 → Δ $24 → OK.

`nadoBuffer = maint.health / maint.assets` (healths[1]). EX1 fixture: 9,400 / 9,700 = **96.9%**. < 0 → liquidatable.
Across several subaccounts the **worst** buffer is used.

## 3. Tydro liquidation distance

`liq = 1 − 1/hf` — how far collateral value can fall, debt fixed, before HF hits 1.
hf 2.1 → 52.4%. hf 1.12 → 10.7%. hf 1.087 → 8.0% (WOUNDED line).

## 4. Families

For each asset family F (BTC, ETH, SPY, …; stables excluded):
`S_F = Σ Nado spot usd + Σ Tydro supply usd − Σ Tydro debt usd`
`L_F = Σ long perp notional`, `P_F = Σ |short perp notional|`.

## 5. CARRY

`gap_F = |S_F⁺ − P_F| / max(S_F⁺, P_F, 1)` with `S_F⁺ = max(S_F, 0)`.
CARRY if `gap ≤ 0.15` and `min(S_F⁺, P_F) ≥ $200`.
EX1: S = 10,000, P = 10,000 → gap 0% → CARRY. Short $12,000 instead → gap 2,000/12,000 = 16.7% → not CARRY (then NAKED, since L=0, P=12,000 → imbalance 100%).

## 6. NAKED

`imb_F = |L_F − P_F| / max(L_F + P_F, 1)`. NAKED if `L_F + P_F ≥ $200`, not CARRY_F, and `imb > 0.5`.
EX2: BTC long 10,000, P 0 → imb 100% → NAKED.

## 7. Shares

`eqShare = eq / max(nadoCollateral, eq, 1)` — EX3: 8,000 / 8,000 = 100% → EQUITY-MARGIN.
`kbShare = kb / max(totalMargin, 1)` — EX1: 10,000 / (10,000 Nado + 3,000 Tydro) = 76.9% → KBTC-CORE.
`stShare = st / max(totalMargin, 1)` — EX2: 3,000 / 3,000 = 100% → STABLE-BALLAST.

## 8. LEVERED

`lev = grossPerp / max(E, 1)` — EX2: 10,000 / 3,000 = 3.33× ≥ 3 → LEVERED.

## 9. Residual delta (VECTOR)

`residual = Σ_F (S_F + L_F − P_F)`; `frac = residual / Σ_F (|S_F| + L_F + P_F)`.
EX1: BTC 10,000 + 0 − 10,000 = 0; ETH (Tydro WETH) 3,000 → residual **$3,000**, exposure 23,000 → **13.0%**.
Stables are excluded (they are the numeraire).
