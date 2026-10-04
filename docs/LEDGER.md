# Liquidation Ledger, Cascades, Track record (Release 2)

Versions: ledger `ledger-1.0.0` · cascades `cascade-1.0.0` · scoring `acct-1.0.0`.

## Sources (on-chain, read-only `eth_getLogs`)

| Venue | Contract | Event | Owner | Notes |
|---|---|---|---|---|
| Tydro | Pool `0x2816cf15F6d2A220E789aA011D5EE4eB6c47FEbA` (aave-address-book, AaveV3InkWhitelabel) | `LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken)` | Tydro (Aave v3 white-label) | Aave v3's event, unchanged |
| Nado | Clearinghouse `0xD218103918C19D0A10cf35300E4CfAfbD444c5fE` | `Liquidation(bytes32 indexed liquidatorSubaccount, bytes32 indexed liquidateeSubaccount, uint32 productId, bool isEncodedSpread, int128 amount, int128 amountQuote)` | Nado | Already used for discovery since 2026-09-28 |

- **Rate limits:** the public Ink RPCs cap each history request at 1,000 blocks. The scan learns that limit and stays inside it.
- **If a source fails:** the scan pauses where it got to, and the next run resumes there.
- **Never decoded:** a log from another contract, or one with the wrong shape. Those are skipped and counted.

## How it is kept

The census does this after the Flight Recorder (`packages/census/src/node/ledger-write.ts`):

- **Forward:** every run scans from the last block checked to the head, so new liquidations appear within the hour.
- **History backfill:** each run spends up to 8 minutes scanning from Tydro's launch (block 19,954,047), which also covers Nado's, towards the block where forward scanning began. Progress is checkpointed in `history/index.json` (`ledger`). That's about 37 million blocks in 1,000-block requests, so roughly 10–15 hourly runs, after which only the forward scan remains. The INTEL page shows how far it has got.
- **Idempotent:** a liquidation is keyed by transaction + log index, so re-runs and overlapping scans never duplicate one.
- **Cursors move last:** cursors advance only after the records are written. If a block time can't be read, nothing is written and the same range is retried next run.

**Stored:** `history/liq/<YYYY-MM>.json`, by the month the liquidation happened. Each record holds:
- venue, transaction, block and time
- wallet (shown shortened) and subaccount kind
- assets or product, and asset family
- **size range** and its basis
- Tydro's implied bonus
- what AEGIS had recorded before
- completeness, and the list of unavailable fields
- source and versions

**Not stored:** raw amounts, balances or health factors. The exact figures are one click away on the explorer, inside the public transaction.

### What is derived, and what is unavailable rather than guessed

- **Tydro size range** comes from the debt repaid at **Tydro's own oracle prices at that block**. If the RPC can't serve that block, the size and bonus are *unavailable*. Today's price is never used. The implied bonus is collateral seized ÷ debt repaid − 1 at those prices, including any protocol fee.
- **Nado size range** comes from the event's quote amount (USDT0). **Direction** is always unavailable, because the event doesn't state which side the liquidated position was on, so every Nado record is PARTIAL.
- **Health factor immediately before and after** is not stored, because public files carry no per-wallet numbers. On a wallet page, "Read at a past block" shows it for any block (needs an RPC that keeps old state).
- A record is **COMPLETE** only when no field is unavailable.

## What AEGIS knew before (the join)

For each liquidation, the Flight Recorder's rows for that wallet strictly before the liquidation block give:

- **NEAR before:** the last recorded state was NEAR LIQUIDATION. The **lead time** runs from the start of the uninterrupted NEAR streak. "≥" means the streak reaches back to the first recorded row, so it may have started earlier.
- **WATCH only:** the last state was WATCH, with no NEAR.
- **No warning:** recorded without a warning.
- **Not seen:** no recorded position for that wallet.
- **Before recording:** the liquidation happened before AEGIS began recording. It's kept in the ledger but **excluded from every rate**.

Rows are hourly, so lead times are accurate to about an hour, and a wallet that goes from safe to liquidated within the hour can only be a miss.

## Cascades (`cascade-1.0.0`)

Liquidations are sorted by time, and each one joins the current group if it came **≤ 30 minutes** after the previous one. A group of **≥ 3** is a cascade.

The same input always gives the same groups. Each cascade lists why it was grouped:
- the timing rule;
- whether ≥ 70% of its liquidations are in one asset family (otherwise "timing only");
- whether it spans both venues.

Cascades without a dominant family, or spanning both venues, are labelled **uncertain**. Every cascade says that grouping shows the liquidations happened together, not why.

**Replay** steps through seven parts, from what was actually recorded:
1. The price or oracle move: not recorded until Oracle Watch, Release 3.
2. The first wallet AEGIS had in danger.
3. AEGIS's near-liquidation count and Ink Stress Level around the cascade (6 hours either side).
4. The first liquidation.
5. The ones after it.
6. The peak 10 minutes.
7. When the near-liquidation count came back down, if it did.

Where something wasn't recorded, the step says so.

## Track record (`acct-1.0.0`, on the Checks page)

- **Warnings:** recorded by the hourly census in `history/warn/<YYYY-MM>.json` each time a wallet enters NEAR LIQUIDATION. The first run that records warnings marks wallets already NEAR as starting warnings.
- **Scored:** each run, from every warning and liquidation since recording began (at most 13 months), into `history/accountability.json`:
  - Liquidations AEGIS could judge: warned NEAR before, WATCH only, missed, and never seen.
  - For windows of 1 h, 6 h, 24 h and 7 days: warnings followed by that wallet's liquidation within the window (warnings younger than the window count as *pending*, not misses), and liquidations warned at least that long before.
  - Breakdowns by venue, size range, position type at the time, asset family and **rules version, never pooled**.
- **Every rate** is shown as *n of N*. Under 30 cases it's marked "too few to judge".
- **No false-alarm %:** a warning that wasn't followed by a liquidation may simply have been acted on (the owner added collateral), so the page shows counts instead.
- **Forecasts:** every full scan records the Pressure Map's scenario results (`history/forecast/<YYYY-MM>.json`: crypto, ETH, BTC and stablecoins at −10% and −20%, for all sizes and for ≥ $1k). They are **not scored yet**, because scoring needs recorded prices (Oracle Watch, Release 3).

## Privacy

- The ledger is historical: ordered by time, never ranked by closeness to liquidation, with no export or download.
- Rows link to the already-public transaction on the explorer, not to a live wallet page.
- Size is a range. There are no balances or health factors in any public file.
- Fixture wallets are refused.

## Rollback

- To stop it, set `ledger: false` in `scripts/census.ts` → `runCensus`, or revert. The scan and Flight Recorder are unaffected.
- To remove the data, delete `census/history/liq/`, `history/warn/`, `history/forecast/` and `history/accountability.json` in Blob, and remove the `ledger` entry from `history/index.json` (or delete the index, which also resets the Flight Recorder). The pages then say NOT RECORDING YET or NOT SCORED YET.
