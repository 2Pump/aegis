# Pressure Map

What happens to the wallets AEGIS can see if prices move. It's a simulation from today's readings, not a prediction and not advice.

**Where it shows up**
- **`/pressure`:** ecosystem-wide counts, plus the **Ink stress level**.
- **Wallet pages, section 07 "Stress test":** the same engine run on that one wallet.

## How it works

**1. One engine** (`packages/pose/src/scenario.ts`, pure, versioned `pressure-1.0.0`).
- **Shocked copy.** A scenario moves prices by asset family, asset class or token. The engine reprices a copy of the wallet's book and runs it through the same risk lines the classifier uses (`riskTemp()`, which `classify()` itself calls). A scenario can't disagree with the live rules, and a test pins that `riskTemp(book) === classify(book).hullTemp` across every fixture and many moves. The canonical book is never mutated.
- **Tydro.** Supply and debt USD both move with their asset. The on-chain health factor is rescaled: `hf' = hf × (Σsupply'/Σsupply) ÷ (Σdebt'/Σdebt)`. That's exact for one collateral. When collateral is mixed it's approximate, because it assumes one liquidation threshold, and the wallet is marked "approximate".
- **Nado.** Each position's maintenance contribution is `w × value (+ v_quote for perps)`, using Nado's own maintenance weight for that side, read from FQuerier. Health, assets and liabilities move with the change in contributions, per subaccount, because isolated margin is liquidated on its own. The worst subaccount drives the buffer, exactly as in the live reading. Nado's unit of account (USDT0, product 0) never moves on Nado.
- **What the levels mean.**
  - **Watch:** the existing ELEVATED lines.
  - **Near liquidation:** the existing WOUNDED lines, including the tighter lines for same-family loops.
  - **Liquidatable:** Tydro hf < 1, or a Nado subaccount's maintenance health < 0.
- **Search.** Thresholds are found by stepping 1%, 2%, … 50% in each direction.

**2. Directions.** These are shared by the census, the page and the wallet page:
- BTC, ETH, HYPE and SOL.
- All crypto.
- Stocks: xStocks and stock perps together.
- Everything but stablecoins.
- All stablecoins depeg, USDe depeg and USDC depeg. These only go down.
- Same-family positions move together. For example, kBTC, SolvBTC and BTC-PERP move as one, as do weETH and WETH. So a same-family loop doesn't get closer to liquidation when its family moves; only a depeg of one coin against another does.

**3. Aggregates** (`packages/census/src/pressure.ts`).
- **When they're built.** Every full sweep that reads every wallet at one block (every 3 hours) runs the engine on each wallet with debt or perps. It writes `pressure.json` next to `census.json`.
- **Cost.** About 7 s for 18,500 wallets, giving a file of about 260 KB.
- **What's in the file:**
  - **counts only:** wallets that first reach Watch, Near liquidation or Liquidatable at each whole-% move, per direction × up/down × current state × size floor × one breakdown (venue or position type)
  - **counts of current states**
  - **population:** read, simulated, approximate, and couldn't simulate
- **Never in it:** addresses, balances, health factors, per-wallet thresholds or rankings. Tests enforce this.
- **Privacy.** A group of fewer than 5 wallets has its moves rounded up to the next 10%, so a lone large wallet's liquidation point can't be read off the chart.
- **Test wallets** (`source: FIXTURE`) never enter the aggregates. A test enforces this.

**4. The page** (`apps/web/src/pages/Pressure.tsx`).
- **Controls:** presets, what moves, falls or rises, a 0–50% slider, size floor, and narrow-to (venue or position type).
- **State in the URL:** `?d=CRYPTO&s=down&p=10&m=1k&by=*`. Every parameter is validated and clamped (`clampQuery`); anything unknown falls back to the default.
- **Results:** the transitions (Safe → Watch, Safe → Near, Watch → Near, newly liquidatable), the pressure curve with a table equivalent, and which asset hurts most. Also breakdowns by wallet size (small accounts or material ones?), by venue and by position type.
- **Stamps:** what's included and what isn't, the block, the age, the rules, engine and stress versions, and a share text.

## Material-risk filter

The near-liquidation count includes many tiny accounts.
- **Floors:** "All wallets", "At least $1,000", "At least $10,000" and "At least $100,000".
- **Definition of size:** the same size bands the well uses (`shipSizeUsd` → `sizeBand`).
- **Nothing silently dropped.** The active floor is always shown, and the "all sizes" totals stay visible beside it.

## Ink stress level (`stress-1.0.0`)

The level is deterministic and versioned (`STRESS` in `packages/census/src/pressure.ts`). Every threshold is unit-tested.

**Population:** wallets of at least $1,000 with debt or perps.

**Inputs, each a share of that population:**
- **near:** near liquidation or liquidatable now.
- **near10:** newly near liquidation if all crypto fell 10%.
- **liq10:** newly liquidatable if all crypto fell 10%.

| Level | near ≥ | near10 ≥ | liq10 ≥ |
|---|---|---|---|
| CRITICAL | 15% | 30% | 10% |
| HIGH | 8% | 15% | 4% |
| ELEVATED | 3% | 6% | 1% |
| CALM | below all | | |

- **The highest level any input reaches wins.** The page lists the inputs that set it.
- **Reduced confidence** shows when:
  - the map is over 12 h old
  - Nado open-interest coverage is under 90% (or not measured)
  - over 5% of wallets couldn't be simulated
  - there's no population

## Not modelled (said on the page, not hidden)

- Funding and interest accrual over time.
- Nado spread pairs.
- Tydro per-asset liquidation thresholds and e-mode: one threshold per wallet is assumed when collateral is mixed.
- Oracle lag and market impact.
- Moves beyond 50%.
- Coverage: the map counts only wallets AEGIS can see. The Scan page has the coverage numbers.

## Alerts

Not built, and not wired to the Pressure Map. AEGIS has no Telegram (a standing rule), so the Alerts page keeps its "not built" state. Scenario-based alerts would need that rule changed first.

## Checks

The Checks page now:
- shows the current rules version
- shows each stored check under the rules version it ran under, flagged when that version is older (never relabelled)
- marks a check STALE after 30 days

`pnpm prove 0xADDRESS` is the repeatable re-check. It records the time, block, rules version, source and fields, and a source it can't reach is never recorded as a pass.
