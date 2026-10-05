# Oracle Watch and Protocol Change Monitor (Release 3)

Both run inside the hourly census, after the ledger. Both are read-only on the chain. The site shows them under **INTEL → ORACLES** and **INTEL → CHANGES**. Pressure forecast scoring, which needs the recorded prices, is on **CHECKS**.

Every feed is an observation, not the truth. When two feeds disagree, one of them is wrong; AEGIS doesn't say which.

## Oracle Watch (`oracle-1.0.0`)

### Sources (each one verified or discovered on-chain, never guessed)

| Source | What is read | Where the address comes from |
|---|---|---|
| Tydro protocol price | `AaveOracle.getAssetsPrices` at `0x4758213271BFdC72224A7a8742dC865fC97756e1` | Tydro deployment |
| Tydro's source per asset | `AaveOracle.getSourceOfAsset(asset)`, then `latestRoundData` / `latestAnswer` / `decimals` / `description` / `isCapped` on that contract. If it's an Aave-style adapter (price cap or peg-to-base), it's followed through `BASE_TO_USD_AGGREGATOR`, `ASSET_TO_USD_AGGREGATOR`, `ASSET_TO_PEG` or `PEG_TO_BASE` to the feeds underneath (at most two levels). The adapter's age is the age of its **oldest** underlying feed. An adapter that also answers `latestRoundData` itself keeps its own update time, but its feeds are still followed and named. | discovered on-chain each run |
| Nado oracle prices | `FQuerier.getSubaccountInfo` for the zero subaccount, which returns every product with its oracle price, spot token and risk weights | Nado contracts |
| Pyth (external reference) | `getPriceUnsafe(id)` at `0x2880aB155794e7179c9eE2e38200202908C17B43`: ETH/USD, BTC/USD, USDC/USD | Pyth's published Ink address and feed IDs. USDT is left out because its feed ID wasn't verified. |

- **Assets are joined across venues by token contract address** (Nado spot `config.token` = Tydro underlying), never by ticker.
- Nado doesn't expose an update time on-chain, so its age is shown as "not exposed".
- Pyth is a pull oracle: it updates only when someone pushes a price on Ink. It's compared only when it was published in the last hour. Otherwise the check says "not compared" and why.
- A Pyth feed not pushed for over **24 h is dormant**: it's shown with its last push time, but it isn't a check and doesn't make the asset UNAVAILABLE. On 2026-10-04 all three Pyth feeds on Ink were dormant (last pushed 160–400 days earlier), so the cross-venue Tydro-vs-Nado comparison is the live second source for WETH, kBTC and USDC.
- A stablecoin source that answers exactly $1 with no update time is a **fixed-price source**, as Aave's GHO oracle is by design. It's OK (there's nothing to go stale), and the check says plainly that a market depeg would not show in Tydro's price.
- External references are explicit: WETH→ETH, kBTC and SolvBTC→BTC (labelled *wrapped*, because the wrapper itself can lose its peg), and USDC→USDC.

### Checks and thresholds

| Check | Status |
|---|---|
| Source age | STALE if over 26 h; UNAVAILABLE if the source doesn't answer the Chainlink interface |
| Source decimals | WARN if not 8 (an adapter may rescale) |
| Price cap | WARN if the adapter reports its cap as active (`isCapped()`): Tydro values the asset at the cap, below its feed |
| Protocol vs its own source | WARN if more than 0.01% apart, DIVERGENT at 1% or more |
| Tydro vs Nado (same token) | WARN at 0.3%, DIVERGENT at 1% |
| External (Pyth) | WARN at 0.3%, DIVERGENT at 1%. OK when inside Pyth's own confidence band |
| Peg (USDT, USDC, USDG, GHO, USDe, per venue) | WARN at 0.5% from $1, DEPEG at 2% |
| Jump | JUMP if the price moved 5% or more since the previous run |
| Validity | INVALID if the protocol price is missing or not a positive number |

- Nado product 0 (USDT0) is Nado's unit of account, $1 by definition, so it isn't peg-checked.
- Yield-bearing stables (sUSDe, syrupUSDT) aren't $1 by design and aren't peg-checked.
- Severity, highest first: INVALID > DIVERGENT = DEPEG > STALE = JUMP > WARN > UNAVAILABLE > OK. An asset's status is its worst check.

### Events

- An event fires when a check **enters** a problem, not on every run.
- The same problem on the same asset and check isn't repeated within **6 h**.
- "Resolved" needs **2 clean runs in a row**, so a flapping price doesn't produce noise.
- The last 300 events are kept in `history/oracle/latest.json`.
- `/protocol on` in the Telegram bot (not live yet) sends them.

### Impact

A divergence is modelled with the Pressure engine as the protocol price converging on the other source, treated as a whole-family move: ETH, BTC, USDC, USDe or the other stables.

- The move is relative to the protocol price: (other − protocol) / protocol.
- It is rounded up to a whole percent and clamped between 1% and 50%.
- It shows wallets newly near liquidation and newly liquidatable, for all sizes and for ≥ $1k.
- It's labelled *approximate, not a prediction*.
- Like the Pressure Map, it's locked with the well until the readings are verified.

### Files

- `history/oracle/latest.json`: the current watch, rewritten every run. A failed read keeps the last good watch, and its age shows; the page labels it STALE after 3 h.
- `history/prices/<YYYY-MM>.json`: one price point per run. Keys are `tydro:SYMBOL`, `nado:<productId>` and `pyth:KEY`. These are public oracle prices only, with no wallet data. Recording begins with this release, and nothing earlier is reconstructed.

## Protocol Change Monitor (`changes-1.0.0`)

### Monitored parameters

- **Tydro, per reserve:** LTV, liquidation threshold, liquidation bonus, reserve factor, collateral/borrowing enabled, active, frozen, paused, borrow and supply caps, debt ceiling, liquidation protocol fee, interest-rate strategy contract, and oracle source.
- **Tydro, PoolAddressesProvider:** pool, configurator, price oracle, ACL manager and ACL admin.
- **Implementation contracts** (EIP-1967 slot, i.e. upgrades): Tydro Pool and PoolConfigurator; Nado Clearinghouse, Endpoint, SpotEngine, PerpEngine and Querier.
- **Nado, per product** (`SYMBOL#id`): listed, the four risk weights, spot token and interest configuration.
- Anything that couldn't be read is listed as **not monitored** on the page, never claimed as watched.

### How changes are recorded

- The first run is a baseline: it records the values and makes no change records.
- After that, any difference produces a record with: old → new, the two blocks it happened between, the contract and function it was read from, and the reader version.
- A value that fails to read on one run keeps its last reading. A failed read is not a change.
- "Removed" applies only to a Nado product that is no longer listed, and only when the product list itself was read.
- **Tydro:** the PoolConfigurator's transactions in that block range are listed as candidates (one of them made the change).
- **Nado:** the transaction isn't identified, because Nado doesn't emit a configuration event AEGIS reads.
- **Impact:** AEGIS's own counts just before and just after the change, from the Flight Recorder. These are observed, not isolated, because price moves in the same hour are in them too. With no recorded point on one side, no impact is shown.

### Files

- `history/params/latest.json`: current values.
- `history/changes/<YYYY-MM>.json`: change records. The months are listed in `history/index.json` as `changeMonths`.

## Pressure forecast scoring (`forecast-score-1.0.0`)

- Each full scan's forecast is checked against the recorded Tydro prices over the next **24 h**.
- Proxies for each scenario: CRYPTO is the average of WETH and kBTC; USD is the worst stablecoin.
- A scenario is **reached** if its move actually happened within the window.
- **Unreached scenarios are neither hits nor misses.**
- For reached scenarios, the page shows predicted near-liquidation counts next to the most the hourly scan recorded, plus the liquidations seen.
- Forecasts made before prices were recorded are counted as *can't be judged*.
- A forecast is recorded only when the Pressure Map is rebuilt, which needs a full sweep that reads every wallet in **one** run. A sweep that spans several runs builds no map and no forecast. Every run that doesn't build one says why in the log.
- The result is written to `history/forecast-score.json`.

## What to look for in the census log

```
  oracle kBTC UNAVAILABLE — external: Pyth last published 9.0 h ago …   ← one line per asset that isn't OK, with the reason
oracles: Tydro sources — chainlink 3 · adapter 11
oracles: 14 assets · OK 11 · UNAVAILABLE 2 · …
changes: monitoring N parameters from now on (…)   ← first run only
pressure map + forecast: not rebuilt — <why> · last built N h ago · last full sweep …   ← on every run without one
forecasts: N recorded · … judged · … reached · … before prices were recorded · … pending · files: 2026-09 none, 2026-10 12
```

## Privacy

- Only public oracle prices and protocol parameters are stored.
- Impact numbers are counts of wallets, never addresses, balances or health factors.

## Rollback

- To stop both, pass `intel: false` to `runCensus({...})` in `scripts/census.ts`, or revert the commit. The census runs exactly as before.
- To remove what was recorded, delete `census/history/oracle/`, `census/history/prices/`, `census/history/params/`, `census/history/changes/` and `census/history/forecast-score.json` from the Blob store. The pages then say NOT RECORDING YET or NOT MONITORING YET.
