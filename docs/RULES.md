# AEGIS — Classification Rules (v1.0.0)

> AEGIS is a camera. It cannot move your funds. Classifications can be wrong.

The classifier lives in `packages/pose/src/classify.ts`. Every constant lives in
`packages/pose/src/config.ts`. The table below is **tested against that file**
(`packages/pose/test/rules-doc.test.ts`). If a number here and a number in code disagree, CI goes red.

The in-app `/rules` page renders from the same constants (`packages/pose/src/rules.ts`).

---

## 1. Symbols

| Symbol | Meaning |
|---|---|
| `S_F` | USD of spot-like inventory in asset family F: Nado spot net balance + Tydro supply − Tydro debt. Floored at 0 for CARRY. |
| `P_F` | USD notional of short perps in family F (absolute value) |
| `L_F` | USD notional of long perps in family F |
| `E` | Nado equity: Σ spot USD + Σ perp (v_quote + size × oracle price) |
| `hf` | Tydro health factor (`Pool.getUserAccountData`, on-chain) |
| `nadoBuffer` | Nado maintenance health ÷ maintenance-weighted assets. < 0 = liquidatable. |
| `eq` | USD of xStock collateral (positive Nado spot in wSPYx, wQQQx, wAAPLx, …) |
| `kb` | USD of kBTC (Nado `KBTC` spot + Tydro kBTC supply). SolvBTC is BTC family, not kBTC. |
| `st` | USD of stables held (USDT0, USDC, USDG, GHO, USDe, sUSDe, syrupUSDT) |
| `totalMargin` | Positive Nado spot USD + Tydro supply USD |

**Asset families** hedge each other: `BTC` = kBTC, SolvBTC, BTC-PERP · `ETH` = WETH, weETH, wrsETH, ezETH, ETH-PERP ·
`SPY` = wSPYx, SPY-PERP · `QQQ` = wQQQx, QQQ-PERP · (same for AAPL, NVDA, TSLA, GOOGL, META, MSFT, AMZN) ·
`XAU` = XAUT0, XAUT-PERP · `HYPE` = kHYPE, HYPE-PERP · `USD` = all stables (never CARRY/NAKED).
Unknown symbols become their own family, so an unknown token can never silently hedge a known perp.

## 2. Predicates

| Tag | Kind | Fires when |
|---|---|---|
| DARK | state | Tydro or Nado sensor failed (RPC dead, timeout, parse fail, rate limit). Positional rules are **not** evaluated — we never guess S or P from half a book. WOUNDED may still attach from the readable sensor. |
| EMPTY | state | Σ \|USD\| of every leg < `DUST_USD` |
| WOUNDED | overlay | `hf < WOUNDED_HF` OR `nadoBuffer < NADO_BUFFER_CRIT` OR `(1 − 1/hf) < LIQ_DISTANCE_CRIT` |
| CARRY | primary | ∃ F: `\|S_F − P_F\| / max(S_F, P_F, 1) ≤ CARRY_BAND` AND `min(S_F, P_F) ≥ CARRY_MIN_LEG_USD` |
| EQUITY-MARGIN | primary / overlay | `eq ≥ EQUITY_MIN_USD` AND `eq / max(nadoCollateral, eq, 1) ≥ EQUITY_SHARE` |
| NAKED | primary | ∃ F: `(L_F + P_F) ≥ NAKED_MIN_GROSS_USD` AND NOT CARRY_F AND `\|L_F − P_F\| / max(L_F + P_F, 1) > NAKED_IMBALANCE` |
| KBTC-CORE | primary / overlay | `kb ≥ KBTC_MIN_USD` AND `kb / max(totalMargin, 1) ≥ KBTC_SHARE` |
| LOCKED | primary | Tydro supplies `> LOCKED_MIN_SUPPLY_USD` AND no Nado perps AND no Nado risk spots (non-stable or borrowed, ≥ dust) |
| STABLE-BALLAST | primary | `st / max(totalMargin, 1) ≥ STABLE_SHARE` |
| LEVERED | primary | `grossPerp / max(E, 1) ≥ LEVERED_RATIO` |

**Primary priority:** DARK → EMPTY short-circuit. Otherwise first match of
`CARRY > EQUITY-MARGIN > NAKED > KBTC-CORE > LOCKED > STABLE-BALLAST > LEVERED`.
WOUNDED is an overlay; it is primary only if nothing else fires. If nothing fires at all,
`primary = null` and the plate shows **NO RULE FIRED** (this is not a tag).

**Tag order on a plate:** primary, then WOUNDED, then the rest in priority order.

## 3. Hull temperature

| Temp | Condition | Copy |
|---|---|---|
| CRITICAL | WOUNDED | “Liquidation range on at least one venue.” |
| ELEVATED | `hf < ELEVATED_HF` OR `nadoBuffer < NADO_BUFFER_WARN` | “Inside the warn band.” |
| UNKNOWN | any sensor DARK (and no readable wound) | “A sensor is dark.” |
| NOMINAL | otherwise | “Sensors below warn lines.” |

## 4. Constants (tested)

| Constant | Value | Used by |
|---|---|---|
| `RULES_VERSION` | v1.0.0 | plate footer |
| `DUST_USD` | 10 | EMPTY, LOCKED |
| `WOUNDED_HF` | 1.25 | WOUNDED |
| `NADO_BUFFER_CRIT` | 0.1 | WOUNDED |
| `LIQ_DISTANCE_CRIT` | 0.08 | WOUNDED |
| `ELEVATED_HF` | 1.5 | hull temp |
| `NADO_BUFFER_WARN` | 0.25 | hull temp |
| `LOCKED_MIN_SUPPLY_USD` | 50 | LOCKED |
| `CARRY_BAND` | 0.15 | CARRY |
| `CARRY_MIN_LEG_USD` | 200 | CARRY |
| `NAKED_MIN_GROSS_USD` | 200 | NAKED |
| `NAKED_IMBALANCE` | 0.5 | NAKED |
| `EQUITY_MIN_USD` | 200 | EQUITY-MARGIN |
| `EQUITY_SHARE` | 0.25 | EQUITY-MARGIN |
| `KBTC_MIN_USD` | 200 | KBTC-CORE |
| `KBTC_SHARE` | 0.35 | KBTC-CORE |
| `STABLE_SHARE` | 0.5 | STABLE-BALLAST |
| `LEVERED_RATIO` | 3 | LEVERED |

## 5. Known limits of V1 rules

- NAKED looks at perps only. A $10k spot + $5k short is NAKED (short side), not “half-hedged”. Intentional: the rule is simple and public.
- CARRY uses the Nado oracle for perp notional and the Tydro oracle for Tydro legs. Two venues, two prices — both labeled on the plate.
- Isolated Nado subaccounts are read when the indexer lookup works; otherwise only `default` is read and the plate says so.
- Funding rates are not wired in V1. The plate shows funding **side** only.
