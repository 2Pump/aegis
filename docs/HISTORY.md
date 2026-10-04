# Flight Recorder — history (`hist-1.0.0`)

Release 1 of the INTEL expansion. AEGIS now keeps what it saw, so the site can show how risk changed over time, for one wallet and for the whole of Ink.

## What is recorded

The hourly census writes the records itself, right after it publishes `census.json`. If writing history fails, the scan still publishes.

| File (Vercel Blob, next to census.json) | What | Written |
|---|---|---|
| `history/agg/<YYYY-MM>.json` | One **point per census run**: block, **block hash**, time, scan type, versions (rules, scenario engine, reader, price source, history). Also: risk counts per size floor (All / ≥$1k / ≥$10k / ≥$100k), position-type mix, venue counts, unreadable count, and the **Ink Stress Level** on runs where a full scan rebuilt the Pressure Map. | every run |
| `history/w/<YYYY-MM>/<shard>.json` | Per-wallet states, split into 64 shards by address: a **baseline** row for every wallet with a position at the first write of each month, then a row **only when** the wallet's position type, risk level, size range, venues or venue trip changes. Each row keeps the rules version it was classified under. | baseline once a month; then only shards with a change |
| `history/index.json` | Months recorded, months baselined, months compacted, when recording began | when any of those change |

**Balance-free, like census.json.** Files hold types, risk levels, size ranges and counts. They never hold balances, health factors, margin buffers or liquidation prices.

**Recorded live, never backfilled.** Every row is what the hourly scan read at the time. History starts when this version first runs. AEGIS doesn't reconstruct risk it didn't observe, and the pages say so.

**Never rewritten.** When the rules change, old rows keep their old rules version, and the wallet table marks the change ("rules changed").

## Reading at a past block (wallet page)

"Read at a past block or time" re-reads one wallet from the chain at a chosen block, in the visitor's browser: Tydro and every known Nado subaccount, both at the same block. A time is turned into a block by binary search on block timestamps. The result is shown in two separate boxes, never merged:

- **AS CLASSIFIED THEN:** the state the hourly scan recorded at or before that block, with its rules version.
- **USING CURRENT RULES:** the reconstruction, classified with today's rules, including the exact health factor and margin buffer. That's allowed here because it's the wallet page, like the live plate. It's labelled "reconstructed now … not observed live then".

If the RPC no longer holds that block's state (that needs an archive node), the box says UNAVAILABLE and shows the node's reason. Nothing is guessed.

## Integrity

- **Idempotent.** Points are keyed by block and rows by kind + address + block. Re-running a block adds nothing (tested).
- **Reorg aware.** Each run re-checks the previous point's block hash. A mismatch marks that point `reorg: true`. It's kept, never deleted, and the INTEL table shows it.
- **Resumable.** If a shard fails to write, the month's baseline isn't marked done, so the next run writes it again (tested). Rows are idempotent, so a retry can't duplicate anything.
- **Never overwrites foreign data.** If a history path holds anything that isn't a history file, it's left untouched and that run records nothing there (tested).
- **Fixtures excluded.** The census passes every address in `/fixtures` as `exclude`, and the writer refuses them. Fixture wallet pages have no HISTORY section (e2e).
- **Test vs production.** Tests and local runs write to temporary folders or `apps/web/public/census` (`fileStore`). Only the GitHub Action writes to Blob. Every file carries `chainId: 57073` and a `kind`.

## Retention and growth

- **Wallet rows:** only changes, plus one baseline per wallet per month (about 18,500 wallets with a position ÷ 64 shards ≈ 290 rows, about 20 KB per shard-month before changes). Kept.
- **Aggregate points:** about 570 bytes each, so about 425 KB per month uncompressed. JSON this repetitive compresses about 20×. Hourly points are kept for **90 days**. After that, one finished month per run is **compacted** to one point every 6 hours, plus every point where the all-sizes risk counts or the stress level changed (so risk transitions survive), plus every reorg mark.
- **Browser loads:** a wallet page loads the index, its own shard for the months in view (plus one month before, for the state at the start), and those months' aggregate files for data gaps. INTEL loads only the aggregate months in view, at most 13. The point-by-point table renders only when it's opened.

## Data gaps

If no census point exists for more than 2 hours, that's a gap. Charts hatch or shade it and the line breaks; nothing is interpolated. Gaps are listed in text and counted under the chart.

## Blob operations (Pro plan)

Per hourly run: about 4–6 extra operations (read the index, read and write the month's aggregate file, read and write each shard with a change). The first run of each month writes all 64 shards. At Pro rates that's a few cents a month. (On Hobby's 2,000 advanced operations a month, the census alone is already over the limit: see LAUNCH.md.)

## Versions stamped on every point

`v.rules` (classification rules), `v.engine` (scenario engine), `v.reader` (`READER_VERSION` in ink-io; bump it when what the readers return changes), `v.prices` (`PRICE_SOURCE_VERSION`), `v.history` (`HISTORY.VERSION`).

## Rollback

- To stop recording, set `history: false` in `scripts/census.ts` → `runCensus({...})`, or revert the commit. The census works exactly as before.
- To remove what was recorded, delete the `census/history/` folder in Vercel → Storage → aegis-census. The site then says "NOT RECORDING YET".
- The pages degrade on their own: no index means "NOT RECORDING YET", never an empty or zero history.

## Not in Release 1 (labelled on the pages)

- Health factor, margin buffer, leverage and exposure over time (never in public files; use "read at a past block").
- Deposits, borrows, repayments, perp entries and exits, and funding events. Liquidations are recorded since Release 2 (see [LEDGER.md](LEDGER.md)).
- Oracle prices and events are recorded since Release 3, and Pressure forecasts are scored against them (see [ORACLES.md](ORACLES.md)).
- Anything before recording began.
