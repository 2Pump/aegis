# CENSUS — every Tydro and Nado account, drawn live

## What it is

**Step A: the census job**, hourly (`pnpm census`, `.github/workflows/census.yml`)
1. **Discover.** It finds every wallet that has ever used Tydro or Nado, from public on-chain events only:
   - **Tydro:** `Transfer` on every aToken and variableDebtToken since the Pool launched (block 19,954,047).
   - **Nado:** `Clearinghouse.ModifyCollateral` and `Liquidation` since launch (block 29,851,015), plus `BalanceUpdate` (every trade) for recent windows.
2. **Read.** It reads every wallet at one block, with the same sensors as the hull page:
   - **Tydro:** `Pool.getUserAccountData` plus aToken/vToken `balanceOf`, priced by the AaveOracle.
   - **Nado:** `Clearinghouse.getHealth` filters out empty accounts cheaply. Active ones get the exact `FQuerier.getSubaccountInfo`.
3. **Classify** each wallet with `@aegis/pose`, the same rules as everywhere else.
4. **Publish** `census.json` (the ships) and `known.json` (the job's address book and cursors).

**Step B: the live layer**, which runs in the viewer's browser while the well is open (`LiveEngine`)
- **Starts from** the snapshot.
- **Every ~4 s:** it scans new blocks for Tydro and Nado events and re-reads any wallet that acted. Changes show within seconds.
- **Every ~15 s:** it re-reads the next few at-risk ships, because price alone can hurt them.
- **Pauses** when the tab is hidden, or when you click "Pause live".

**Every update is a real chain read.** Nothing is estimated between reads. A failed read keeps the last good reading, and its age shows.

## What the hourly job re-reads

| Wallet | Re-read |
|---|---|
| Tydro-only and empty Nado accounts | every hour (cheap) |
| Anything that transacted since the last run | every hour |
| At-risk (HF < 2, Nado buffer < 50%, ELEVATED/CRITICAL) | every hour, and every ~15 s live |
| Quiet, healthy, active Nado accounts | weekly full sweep (they're expensive: the Querier returns ~100 products per call) |

**First run.**
- **Tydro** is seeded from the Ink explorer's holder lists for its 28 tokens, about 400 small requests. The explorer supplies addresses only; every balance and HF is still read on-chain. If the explorer fails, the job falls back to a chain scan.
- **Nado** history is scanned on-chain. The public Ink RPC allows only 1,000 blocks per history request, so its ~27M blocks take a few hours, spread over several hourly runs (it saves progress after every phase and resumes). A private RPC with a bigger range cap makes this much faster.
- Until the scan is done, the site says "history backfill in progress", and Tydro wallets appear right away.

**RPC limits.** The job reads the RPC's stated block-range cap from its error message (e.g. "block range greater than 1000 max") once, and never asks for more than that again. On rate limits ("Your IP has exceeded its request rate limit") it waits and retries without shrinking.

## Setup

1. **Create the Blob store.** Vercel → your `aegis-web` project → **Storage** → **Create** → **Blob** → name it `aegis-census` → **Connect** to the project.
2. **Copy the token.** In the Blob store, open the `.env.local` tab and copy `BLOB_READ_WRITE_TOKEN`.
3. **Add the GitHub secret.** github.com/2Pump/aegis → **Settings → Secrets and variables → Actions → New repository secret**: name `BLOB_READ_WRITE_TOKEN`, then paste the value.
4. **Optional: private RPC.** Add a second secret, `INK_RPC`, with a private Ink RPC URL, or several separated by commas. Without it, the job rotates over Ink's four public RPCs (Gelato, QuickNode, Tenderly, dRPC). Before using any of them it checks that each one is chain 57073 and not lagging, and it rests an endpoint for 20 s when that endpoint throttles. The end of the log shows how many requests each endpoint answered.
5. **First run.** In GitHub **Actions** → **census** → **Run workflow**. The log shows discovery progress, then "published N ships … → https://….public.blob.vercel-storage.com/census/census.json". **Copy that URL.**
6. **Point the site at it.** Vercel → project → **Settings → Environment Variables**: `VITE_CENSUS_URL` = that URL. Then redeploy.
   Use the **Config** type, not Secret. `VITE_` values are built into the public site anyway.

### Bootstrap from a local census (what we actually did, 2026-09-28)

The first Action run from zero is slow. The explorer holder-list seed took about 20 minutes, and then the public RPC throttled GitHub's shared IPs. It's faster to build the census on your own computer (`pnpm census`) and upload that state:

```powershell
# cancel any census run that's in progress first, or its result overwrites yours
$env:BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_..."   # Vercel → Storage → aegis-census → .env.local tab
node packages/census/scripts/push-local.mjs          # uploads census/known.json + census/census.json
```

After that, each hourly run only covers the last hour of blocks, taking about a minute.

### Local run (no Blob needed)

```powershell
pnpm census --since-blocks 200000   # quick: wallets active in the last ~2.3 days
pnpm census                         # everything since launch (long on the public RPC)
pnpm dev                            # the dev build shows the well as a PREVIEW
```

A local run writes to `apps/web/public/census/`, which is git-ignored, so the dev server serves it at `/census/census.json`.

## The lock

The production well stays locked until `verification/status.json` is proven (see VERIFICATION.md).
- **Local dev:** always shows it, with a PREVIEW banner.
- **Production:** set `VITE_WELL_PREVIEW=1` on Vercel to show it with the same banner. That's your call.

## Costs and limits

- **GitHub Actions:** hourly on a private repo uses roughly 1,500–2,200 minutes a month. The free plan includes about 2,000, so check **Settings → Billing**. If it runs over, change the cron to every 2 hours (`'17 */2 * * *'`). The live layer keeps the well fresh in between anyway.
- **Vercel Blob:** each well visit downloads the snapshot, about 210 KB compressed per 15,000 ships. Check Vercel → Usage.
- **RPC:** each open well tab makes a few small calls every 4 s and one heavier Nado read every ~15 s. Fine for testing on the public RPC. Use a private RPC key before announcing publicly.

## Privacy

- **A snapshot row holds only:** address, tags, hull temp, size band, a watch flag, read block, "wounded since" block, and any isolated Nado subaccount ids.
- **It never holds:** balances, HF, or liquidation prices. A test enforces this.
- **Wounded tape:** ordered by when a book was first seen wounded, never by closeness to liquidation.
