# Yield and Carry (Release 4, `carry-1.0.0`)

**INTEL → CARRY** shows estimated rates, costs and risks of carry structures that can be built from Tydro and Nado. It's **analysis only**:
- There's no button to trade, borrow, deposit or connect a wallet, and no link into the protocols' apps.
- Nothing is a promised return.
- Everything is before slippage, and rates change every block.

## Where the numbers come from (all read from the protocols' own contracts)

| Input | Contract and function | What it gives |
|---|---|---|
| Tydro supply and borrow rates | `AaveProtocolDataProvider.getReserveData` → `liquidityRate`, `variableBorrowRate` (rays) | the **current** rates Tydro publishes |
| Tydro interest actually paid | the same call → `liquidityIndex`, `variableBorrowIndex` | observed rates between two readings |
| Tydro utilization and caps | `getReserveData` (supplied, borrowed), `getReserveCaps`, `getReserveConfigurationData` (LTV, liquidation threshold, frozen, borrowing on/off) | utilization, cap room, liquidation thresholds |
| Tydro available liquidity | `balanceOf(aToken)` on the underlying token | what can actually be borrowed or withdrawn now |
| Tydro prices | `AaveOracle.getAssetsPrices` | USD values; LST and yield-bearing-stable appreciation (price ratio over time) |
| Nado deposit and borrow interest | `FQuerier.getSubaccountInfo` → spot `cumulativeDeposits/BorrowsMultiplierX18`, totals | observed rates (**Nado publishes no current rate**) |
| Nado funding | the same call → perp `cumulativeFundingShortX18` / `cumulativeFundingLongX18`, `openInterest`, oracle price | funding a short received or a long paid |
| Nado fees | spot `config.withdrawFeeX18` | a flat fee per withdrawal |
| Nado trading fee | **not exposed on-chain** | listed as missing, never assumed zero |
| Gas | `eth_gasPrice` and the OP-stack GasPriceOracle predeploy `0x4200…000F` → `getL1FeeUpperBound(300)` | L2 execution gas plus an upper bound for Ink's L1 data fee |

- **Observed, not modelled.** The change in an index, multiplier or cumulative funding between two readings is what the protocol actually paid.
  - Rates: `(new / old − 1) × year / elapsed`.
  - Funding: `Δ cumulative funding ÷ average oracle price × year / elapsed`. A positive value means shorts received it.
- **History comes from the chain, so there's no backfill of our own.**
  - The census keeps one reading per UTC day, at the first block of the day, for the last 31 days in `history/carry/days.json`.
  - A past block never changes, so each day is read once and kept. Missing days are filled from the chain, newest first, at most 31 per run, stopping after 3 failures in a row.
  - If the RPC can't serve old state, the recent days are kept and the failure is logged. Nothing is filled with zeros.
- **Windows:** "last checkpoint" (12–36 h, with the span shown), 7 days and 30 days.
  - A pair of checkpoints counts as one day only if they're 20–28 h apart. A missed day is a gap, never stretched over two days.

## Structures (each sized per $1 of capital)

| Kind | Structure | Sizing (assumed, versioned) |
|---|---|---|
| Lending baseline | Lend each stablecoin on Tydro (USDT0, USDC, USDG, GHO, USDe, sUSDe, syrupUSDT); deposit USDT0 / USDC on Nado | $1 lent; sUSDe and syrupUSDT also appreciate against USDT0 |
| Spot + short perp, one Nado account | WETH + short ETH-PERP; kBTC + short BTC-PERP | $1 spot deposited, $1 perp short; the spot is the margin |
| Spot on Tydro + short perp on Nado | WETH, kBTC, SolvBTC, weETH, wrsETH, ezETH | ⅔ supplied on Tydro, the same amount shorted on Nado, ⅓ USDT0 as margin (margin = 50% of the hedge) |
| Borrowed asset + hedge | Supply WETH / kBTC on Tydro, borrow USDT0 against it, deposit it on Nado as margin, short the perp | borrow half of what Tydro's LTV allows; two-sided liquidation risk |

Hedges are mapped explicitly, never by ticker:
- WETH, weETH, wrsETH and ezETH → ETH-PERP.
- kBTC and SolvBTC → BTC-PERP.

Each structure says what its hedge does **not** cover: a wrapper losing its peg, or an LST's ETH ratio falling.

For tokenized equities, Nado lists equities only as perps, and no tokenized-equity collateral exists on Tydro or as Nado spot. The page says so, and the equity perps' funding is in the funding table.

## Shown for every structure

- **Rates:** gross, borrowing cost, funding contribution and estimated net (current basis), plus the 7-day and 30-day observed net and the daily range with a daily bar chart.
- **One-off costs:** gas plus Nado withdrawal fees, on $10,000 of capital, and as a rate if held 30 days. Missing fees are listed.
- **Size limits:**
  - Capacity: the room left before a supply cap, a borrow cap or available liquidity binds.
  - Liquidity: Tydro available liquidity and Nado open interest. Open interest is market size, not a limit.
- **Liquidation:** the price move that liquidates each leg, from the protocols' own weights and thresholds.
  - Same Nado account: rises by `1/(w_short − w_long) − 1`.
  - Nado short with margin m: rises by `(1+m)/w_short − 1`.
  - Tydro loan at borrow share b: falls by `1 − b/LT`.
- **Risk factors**, each LOW, MEDIUM, HIGH or UNKNOWN, with the reason. The structure's **risk state is the worst one**:
  - **Funding reversal:** HIGH if funding went against the position since the last checkpoint, or on 10 or more of the last 30 days; MEDIUM on 4–9 days.
  - **Liquidation:** HIGH if a move under 20% liquidates; MEDIUM under 50%. No borrowing means LOW.
  - **Stablecoin:** Oracle Watch peg status of each stablecoin held. DEPEG or INVALID is HIGH; WARN or DIVERGENT is MEDIUM.
  - **Oracle:** the worst Oracle Watch status among the prices that decide the margin.
  - **Protocol change:** HIGH if a market is frozen, inactive or has borrowing off; MEDIUM if a recorded change in the last 30 days touches it.
  - **Capacity:** HIGH under $100k of room, MEDIUM under $1M. No readable cap is LOW, and the page says so.
  - **Data:** HIGH if the reading is over 3 h old or the rate can't be computed; MEDIUM if a window or input is missing.
- **Completeness:** COMPLETE, PARTIAL (with what's missing) or UNAVAILABLE.
- **Sources** (contract and function), assumptions and notes.

The risk rules are deterministic and versioned, and the page publishes the full methodology. No model or AI decides them.

## Carry already on Ink

The panel shows counts from the last full Pressure Map:
- wallets the rules classify as CARRY, and how many are near liquidation now;
- how many more would be near liquidation if ETH rose or fell 10%;
- the Ink Stress Level.

It never names a wallet, and it's locked with the well until verified.

## Language

The page uses "estimated", "observed", "could change", "before slippage", APR and "per $1 of capital". It never says "guaranteed", "risk-free" or "APY". A unit test checks the published file, and a browser test checks the page.

## Files

- `history/carry/days.json`: daily checkpoints (public market state only).
- `history/carry/latest.json`: the analysis at the latest block.

## Census log

```
carry: 18 structures (18 with a rate) · 95 perps · daily history 30 day(s) from 31 checkpoint(s) · 31 day(s) read this run · 74s
carry: risk states — LOW 4 · MEDIUM 12 · HIGH 2 · UNKNOWN 0 · gas per transaction ≈ $0.0012
```

## Rollback

- Pass `carry: false` to `runCensus({...})` in `scripts/census.ts` (this stops only this step), or revert the commit.
- Delete `census/history/carry/` from the Blob store. The page then says NOT RECORDING YET.
