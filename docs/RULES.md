# AEGIS — Classification Rules (v1.2.0)

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
| same-family loop | A Tydro book with debt where every supply and every debt (≥ dust) is in **one** asset family, e.g. sUSDe → USDT (USD) or weETH → WETH (ETH). **On Nado:** borrowing, no perps, and every spot leg (≥ dust) in one family, e.g. USDC deposited → USDT0 borrowed. Price moves hit both sides alike, so only a depeg (or accrued interest) can liquidate it. An unknown Nado product counts as its own family. |

**Asset families** hedge each other: `BTC` = kBTC, SolvBTC, BTC-PERP · `ETH` = WETH, weETH, wrsETH, ezETH, ETH-PERP ·
`SPY` = wSPYx, SPY-PERP · `QQQ` = wQQQx, QQQ-PERP · (same for AAPL, NVDA, TSLA, GOOGL, META, MSFT, AMZN) ·
`XAU` = XAUT0, XAUT-PERP · `HYPE` = kHYPE, HYPE-PERP · `USD` = all stables (never CARRY/NAKED).
Unknown symbols become their own family, so an unknown token can never silently hedge a known perp.

## 2. Predicates

| Tag | Kind | Fires when |
|---|---|---|
| DARK | state | Tydro or Nado sensor failed (RPC dead, timeout, parse fail, rate limit). Positional rules are **not** evaluated — we never guess S or P from half a book. WOUNDED may still attach from the readable sensor. |
| EMPTY | state | Σ \|USD\| of every leg < `DUST_USD` |
| WOUNDED | overlay | Tydro: `hf < WOUNDED_HF` OR `(1 − 1/hf) < LIQ_DISTANCE_CRIT` — for a **same-family loop** these two are replaced by `hf < WOUNDED_HF_CORRELATED`. Nado: `nadoBuffer < NADO_BUFFER_CRIT` — for a **same-family Nado loop**, `nadoBuffer < NADO_BUFFER_CRIT_CORRELATED` instead. |
| CARRY | primary | ∃ F: `\|S_F − P_F\| / max(S_F, P_F, 1) ≤ CARRY_BAND` AND `min(S_F, P_F) ≥ CARRY_MIN_LEG_USD` |
| EQUITY-MARGIN | primary / overlay | `eq ≥ EQUITY_MIN_USD` AND `eq / max(nadoCollateral, eq, 1) ≥ EQUITY_SHARE` |
| NAKED | primary | ∃ F: `(L_F + P_F) ≥ NAKED_MIN_GROSS_USD` AND NOT CARRY_F AND `\|L_F − P_F\| / max(L_F + P_F, 1) > NAKED_IMBALANCE` |
| KBTC-CORE | primary / overlay | `kb ≥ KBTC_MIN_USD` AND `kb / max(totalMargin, 1) ≥ KBTC_SHARE` |
| LOCKED | primary | Tydro supplies `> LOCKED_MIN_SUPPLY_USD` AND no Nado perps AND no Nado risk spots (non-stable or borrowed, ≥ dust) |
| STABLE-BALLAST | primary | `st / max(totalMargin, 1) ≥ STABLE_SHARE` |
| LEVERED | primary | `grossPerp / max(E, 1) ≥ LEVERED_RATIO` |
| HOLD | primary | non-stable (positive Nado spot + Tydro supply) `≥ HOLD_MIN_USD` AND no perp ≥ `DUST_USD` AND no debt ≥ `DUST_USD` on either venue |

**Primary priority:** DARK → EMPTY short-circuit. Otherwise first match of
`CARRY > EQUITY-MARGIN > NAKED > KBTC-CORE > LOCKED > STABLE-BALLAST > LEVERED > HOLD`.
WOUNDED is an overlay; it is primary only if nothing else fires. If nothing fires at all,
`primary = null` and the plate shows **NO RULE FIRED** (this is not a tag).

**Tag order on a plate:** primary, then WOUNDED, then the rest in priority order.

## 3. Hull temperature (shown on the site as Risk)

| Temp | Condition | Copy |
|---|---|---|
| CRITICAL | WOUNDED | “In liquidation range on at least one venue.” (Near liquidation) |
| ELEVATED | `hf < ELEVATED_HF` (same-family loop: `hf < ELEVATED_HF_CORRELATED`) OR `nadoBuffer < NADO_BUFFER_WARN` (same-family Nado loop: `< NADO_BUFFER_WARN_CORRELATED`) | “Inside a warning band.” (Watch) |
| UNKNOWN | any sensor DARK (and no readable wound) | “A data source couldn't be read.” (Couldn't read) |
| NOMINAL | otherwise | “Below every warning line.” (Safe) |

## 4. Constants (tested)

| Constant | Value | Used by |
|---|---|---|
| `RULES_VERSION` | v1.2.0 | plate footer |
| `DUST_USD` | 10 | EMPTY, LOCKED |
| `WOUNDED_HF` | 1.25 | WOUNDED |
| `NADO_BUFFER_CRIT` | 0.1 | WOUNDED |
| `LIQ_DISTANCE_CRIT` | 0.08 | WOUNDED |
| `WOUNDED_HF_CORRELATED` | 1.03 | WOUNDED (same-family loop) |
| `NADO_BUFFER_CRIT_CORRELATED` | 0.03 | WOUNDED (same-family Nado loop) |
| `ELEVATED_HF` | 1.5 | hull temp |
| `ELEVATED_HF_CORRELATED` | 1.08 | hull temp (same-family loop) |
| `NADO_BUFFER_WARN_CORRELATED` | 0.08 | hull temp (same-family Nado loop) |
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
| `HOLD_MIN_USD` | 10 | HOLD |

## 5. Known limits of V1 rules

- NAKED looks at perps only. A $10k spot + $5k short is NAKED (short side), not “half-hedged”. Intentional: the rule is simple and public.
- CARRY uses the Nado oracle for perp notional and the Tydro oracle for Tydro legs. Two venues, two prices — both labeled on the plate.
- Isolated Nado subaccounts are read when the indexer lookup works; otherwise only `default` is read and the plate says so.
- Funding rates are not wired in V1. The plate shows funding **side** only.
- A same-family loop is judged by family, not by Tydro's e-mode setting. A USDe → USDT loop counts as a loop even outside e-mode (its HF is simply higher). sUSDe and USDT are both `USD` family, so a sUSDe depeg is exactly the risk the 1.03 line measures.
- Anything that still fires no rule is below every rule's minimum size (e.g. perps under $200 gross) or mixes stables and non-stables with some debt below the LOCKED/STABLE lines.

## 6. Display names

Approved by the project owner on 2026-09-29. **Display only — not a rule change.** The rule tags above stay the names in the classifier, `census.json`, share links (`?pose=CARRY`) and tests, so nothing underneath moves and `RULES_VERSION` is unchanged. The site shows the plain name; `/rules` shows both. The single source is `packages/glyphs/src/labels.ts`.

| Rule tag | Shown as | Meaning |
|---|---|---|
| CARRY | Hedged | Holds a coin and is short the same coin on perps, roughly equal, so price moves mostly cancel out. |
| NAKED | Unhedged bet | Perp positions pointing one way, with nothing on the other side. |
| LEVERED | High leverage | Positions many times bigger than the money in the account. |
| EQUITY-MARGIN | Stocks as collateral | Tokenized stocks posted as margin on Nado. |
| KBTC-CORE | Bitcoin-backed | Mostly kBTC underneath everything. |
| STABLE-BALLAST | Mostly stablecoins | Mostly dollar-pegged coins. |
| LOCKED | Lending only | Money parked in Tydro lending, no trading on Nado. |
| HOLD | Just holding | Owns coins outright; no perps, no borrowing. |
| WOUNDED | Near liquidation | Close to being force-closed on at least one venue. |
| DARK | Couldn't read | A data source failed; the last good reading is kept. |
| EMPTY | Empty | Nothing worth drawing. |
| (no rule fired) | Unclassified | Doesn't match any pattern. |

Risk level (hull temperature, section 3): NOMINAL → **Safe**, ELEVATED → **Watch**, CRITICAL → **Near liquidation**, UNKNOWN → **Couldn't read**.

## 7. Changelog

- **v1.2.0 (2026-09-29)** — The same depeg logic now applies to Nado. A Nado book that only holds and borrows one family (e.g. USDC deposited, USDT0 borrowed; no perps) is WOUNDED below a 3% maintenance buffer (warn 8%) instead of 10%. This was found by checking two real wounded wallets (1.7% and 2.0% buffers, which stay wounded) and approved by the project owner.
- **v1.1.0 (2026-09-28)** — Same-family Tydro loops get their own WOUNDED line (HF 1.03, warn 1.08) instead of 1.25 / 8% distance. New last-priority pose **HOLD** for wallets that simply own non-stable assets (no perps, no debt). Both approved by the project owner.
