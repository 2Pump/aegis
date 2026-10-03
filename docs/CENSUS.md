# CENSUS — every Tydro and Nado account, drawn live

On the site this is called **the scan** (nav: Scan). "Hourly update" = an incremental run; "full re-read" = a full sweep.

## What it is

**Step A: the census job**, hourly (`pnpm census`, `.github/workflows/census.yml`)
1. **Discover.** It finds every wallet that has ever used Tydro or Nado, from public on-chain events only:
   - **Tydro:** `Transfer` on every aToken and variableDebtToken since the Pool launched (block 19,954,047).
   - **Nado:** `Clearinghouse.ModifyCollateral` and `Liquidation` since launch (block 29,851,015), plus `BalanceUpdate` (every trade) since launch. Trades are the only public event that names **isolated-margin subaccounts** (see below).
2. **Read.** It reads every wallet at one block, with the same sensors as the hull page:
   - **Tydro:** `Pool.getUserAccountData` plus aToken/vToken `balanceOf`, priced by the AaveOracle.
   - **Nado:** `Clearinghouse.getHealth` filters out empty accounts cheaply. Active ones get the exact `FQuerier.getSubaccountInfo`.
3. **Classify** each wallet with `@aegis/pose`, the same rules as everywhere else.
4. **Publish** `census.json` (the wallets) and `known.json` (the job's address book and cursors).

**Step B: the live layer**, which runs in the viewer's browser while the well is open (`LiveEngine`)
- **Starts from** the snapshot.
- **Catches up** to ~4 hours of blocks (14,400) if the snapshot is old; anything older arrives with the next census.
- **Every ~4 s:** it scans new blocks for Tydro and Nado events and re-reads any wallet that acted. Changes show within seconds.
- **Every ~15 s:** it re-reads the next few at-risk wallets, because price alone can hurt them.
- **Pauses** when the tab is hidden, or when you click "Pause live".

**Every update is a real chain read.** Nothing is estimated between reads. A failed read keeps the last good reading, and its age shows.

## What the hourly job re-reads

| Wallet | Re-read |
|---|---|
| Anything that transacted since the last run | every hour |
| At-risk (HF < 2, Nado buffer < 50%, ELEVATED/CRITICAL) | every hour, and every ~15 s live |
| Tydro borrowers (ever touched a debt token) | every hour (price alone can move their HF) |
| Quiet, healthy, active Nado accounts | weekly full sweep (they're expensive: the Querier returns ~100 products per call) |
| Healthy wallets that never borrowed on Tydro | weekly full sweep (no debt → price can't wound them; any deposit, withdrawal or trade re-reads them at once) |
| Empty wallets | weekly full sweep (they can only fill up through an event, which re-reads them at once) |

The first hourly run on this rule (2026-09-29, run #13) read 4,609 wallets in about 4 minutes and carried 60,265.

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
5. **First run.** In GitHub **Actions** → **census** → **Run workflow**. The log shows discovery progress, then "published N wallets … → https://….public.blob.vercel-storage.com/census/census.json". **Copy that URL.**
6. **Point the site at it.** Vercel → project → **Settings → Environment Variables**: `VITE_CENSUS_URL` = that URL. Then redeploy.
   Use the **Config** type, not Secret. `VITE_` values are built into the public site anyway.
7. **Hourly start.** Set up the outside timer (see "Hourly start" at the end).

### Bootstrap from a local census (what we actually did, 2026-09-28)

The first Action run from zero is slow. The explorer holder-list seed took about 20 minutes, and then the public RPC throttled GitHub's shared IPs. It's faster to build the census on your own computer (`pnpm census`) and upload that state:

```powershell
# cancel any census run that's in progress first, or its result overwrites yours
$env:BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_..."   # Vercel → Storage → aegis-census → .env.local tab
node packages/census/scripts/push-local.mjs          # uploads census/known.json + census/census.json
```

After that, each hourly run only covers the last hour of blocks.

### Local run (no Blob needed)

```powershell
pnpm census --since-blocks 200000   # quick: wallets active in the last ~2.3 days
pnpm census                         # everything since launch (long on the public RPC)
pnpm dev                            # the dev build shows the well as a PREVIEW
```

A local run writes to `apps/web/public/census/`, which is git-ignored, so the dev server serves it at `/census/census.json`.

## History backfill (why the first coverage check said ~10%)

The first full sweep (2026-09-28) measured **~10%** of Tydro and Nado totals. The cause was the bootstrap:
- The census we uploaded from the local machine had been built with `--since-blocks`, a quick test mode that only scans recent blocks.
- The job's forward cursor then sat at the chain head, so nothing ever went back for older history.
- The site said "history complete", and that was wrong.

Fix (census v1.1):
- `known.json` now records, per venue, whether **all history since launch** has been covered, and what's left.
- A state that can't prove it covered history (like the uploaded one) is re-checked once.
  - **Tydro:** the explorer's holder lists (resumable across runs). After 3 runs without progress, it falls back to an on-chain scan.
  - **Nado:** an on-chain scan of the Clearinghouse events since launch, resumable across runs.
- Backfill uses at most 60% of each run's budget, so the hourly reads still happen. While it runs, the site shows **"history backfill in progress"**.
- When the backfill finishes, that run automatically re-reads every wallet and measures coverage again.

## Empty wallets

Most wallets the explorer lists hold nothing, or only dust. On the first backfill run, 22,991 of 32,499 were empty. So:
- `census.json` carries only wallets worth drawing. It stays small enough for phones.
- The empty ones are remembered in `known.json` as address → the block they were read at.
- Hourly runs don't re-read them. A wallet can only fill up through a deposit or transfer event, and the event scan marks it for re-reading at once. The weekly full sweep re-reads them anyway.

## Reads once history is complete

A full sweep read about 15 wallets a second, too slow for 55,070 wallets in 40 minutes (2026-09-29: 40,500 read, then the budget ran out). Most of that time went on proving a negative: Nado health calls for ~45k Tydro-only wallets, and all-28-token Tydro reads for Nado-only wallets.

Once a venue's history is fully scanned, a wallet never seen there provably has nothing there:
- A Nado account only exists after a deposit.
- A Tydro position only exists after a token mint.

So the census no longer reads that venue for such a wallet. Its sensor is OK and empty, with a note saying why. Hull pages still read both venues in full.

### Full sweeps resume (census v1.2, 2026-09-29)

A full sweep reads wallets in address order and saves a cursor (`fullSweep` in `known.json`). If it runs out of time, the next run **continues from the cursor**; it never starts over. Before this, an unfinished sweep restarted from zero every run, and each of those runs used the whole 40 minutes.
- A wallet whose read fails keeps its last good reading, and **does not** make the sweep start over (the old code treated one failed read as "sweep unfinished").
- The snapshot says `sweep.complete: false` while a sweep is still going; the site shows **FULL · PARTIAL**.
- **Coverage** needs every wallet read at one block, so it is measured only by a sweep that starts and finishes in the same run (the sweep of ~65k wallets took 36 minutes on 2026-09-29). A sweep that spans runs logs "coverage not measured" and the last measurement is kept.

## The Scan page (`/census`)

Since 2026-10-03 the page opens on a living colony (`apps/web/src/components/Colony.tsx`). It replaced the rings instrument, which had replaced the mix bar and coverage stack.

**What it is.** A Physarum (slime-mould) simulation in a dish. It is decoration over real numbers: **the agents are not wallets**, and nothing in the dish is invented data.
- The agents sense ahead, turn toward the stronger scent and lay a trail that spreads and fades.
- **Food morsels** are the position types. Each morsel's size is that type's share of drawn wallets, and its colour is the type colour. The morsels drift slowly around the dish. They bounce off its wall (kept clear of the NOT SEEN sector and the rim) and off each other as boxes, dot plus label, so no two labels ever overlap. The colony follows their scent as they move. Only their positions change; size, colour and numbers never do. The name sits above the percent under each dot.
- An agent takes the colour of the last morsel it touched. Each morsel keeps sending out agents in proportion to its share, so no type goes unfed.
- **Click a morsel, or a type in the list:** the colony leans toward it (its food is ×4), and the line under the dish reads "name · n wallets · x% of drawn". Click again or press Clear to undo. This changes only the dish. It never filters the well.
- **A live type change** (a wallet newly typed, or one that changed type, seen by the live layer while the page is open) drops a bright speck on that type's morsel.
- **Freezes** when the tab is hidden or the dish is off-screen. With reduced motion it settles out of sight and shows one still frame. Capped at 30 fps. Phones run 2,600 agents; desktops run 6,500.

**The rim is the coverage, always labelled.** Lit arcs start at 12 o'clock and run clockwise.
- Outer rim: Tydro supplied and borrowed. When both are 100%, it is one closed rim marked "outer rim · closed".
- Middle rim: Nado deposits.
- Inner rim: Nado open interest, as two thin arcs (longs, shorts).
- The unlit remainder of each arc is dark and dashed. A hatched sector under it is labelled **NOT SEEN · deposits** or **NOT SEEN · open interest**.
- **Agents cannot enter the NOT SEEN sector.** From the smallest Nado share round to 12 o'clock they bounce off a shorter wall. The verification script samples the canvas there and expects zero lit pixels.
- Without a coverage measurement, the rim stays dark and is labelled "NADO COVERAGE NOT MEASURED YET · RIM DARK".

**Readout, always visible, no clicking needed.** It sits beside the dish, or under it on screens narrower than 860 px.
- Coverage: the five percentages, with "% not seen" on the Nado lines, plus the block and age of that full scan.
- Wallets: found, with a position, empty, on Tydro, on Nado, near liquidation, couldn't read.
- Position types: count and percent for each.
- Last scan: block, age, hourly or full, re-read, kept from earlier, seconds taken, history, rules version.
- Under the dish: the three Limits lines and "Counts wallets, not money. Not advice."

**Phones** (dish narrower than 520 px): rim labels break onto short lines in bigger type, and morsels show only their percent. The names sit in the type list right below. Shares and wallet counts only: no dollars, no health factors.

## Coverage check (is anyone missing?)

On every **full** sweep (weekly, or Actions → census → Run workflow with **full** ticked), the job compares what the known wallets add up to against each protocol's own on-chain totals at the same block:

- **Tydro:** Σ wallet aToken / debt-token balances vs `aToken.totalSupply()` / `variableDebtToken.totalSupply()`, per reserve.
- **Nado:** Σ wallet spot deposits vs each spot product's `totalDepositsNormalized × cumulativeDepositsMultiplierX18`, and Σ wallet longs and shorts vs each perp product's `openInterest`. Both come from the same FQuerier call the hull page uses.

What is published where:
- The **public snapshot** carries **shares only**, for example "Tydro supplied 99.6%". The census page shows them under Coverage.
- The **job log** (private repo) carries the dollar totals and the 8 largest per-asset gaps. That's where to look if a share is low.

A gap would mean accounts the discovery doesn't see yet.

**First measurement (2026-09-29, block 57,211,516):** Tydro supplied 100.0%, Tydro borrowed 100.0%, Nado deposits 82.1%, Nado open interest 46.2% (longs) / 46.4% (shorts). The largest gaps were BTC-, ETH- and HYPE-PERP open interest on both sides (about 45–50% seen), USDT0 deposits (70%), and spot product 11 borrows (0% of about $7.7M).

### Why Nado was at ~46%: what we checked, in order

**How Nado counts open interest.** Nado is a Vertex fork. In Vertex's `PerpEngineState._updateBalance`, `openInterest` goes up only when a balance is positive, so it's the sum of **longs** (plus base in any AMM LP pool). Every long has a short on the other side, so comparing longs seen with it, and shorts seen with it, is right. The 46% was a real gap, not a formula mistake.

**1. Isolated subaccounts: discovery was not the problem.** Nado's engine creates a separate subaccount for each isolated-margin position and funds it from the owner's main account. Its name ends in `…69736f` ("iso"). Census v1.2 scans every trade since launch once to find them (`nado.tradeHistory` in `known.json`, resumable, within the 60% backfill share of each run), and the forward trade scan no longer caps itself at 6 hours.

The first run of that scan (2026-09-29, run #13) covered blocks 29.85M → 36.92M, about 26% of history. It saw 24,170 subaccounts, **2,391 of them isolated, and all of them already known** (+0 new). So the census already found and read these subaccounts.

**2. Reading: a subaccount holding positions was dropped if the chain said `exists = false`.** When an owner's subaccounts were combined, any that Nado's on-chain reader (FQuerier) reported as `exists = false` were skipped, even if they held balances. Engine-created subaccounts are the likely case, since they're never registered by a deposit. From v1.2 a subaccount that holds balances always counts. The hull page gets the same fix, and the log counts how many wallets were affected.

**3. Protocol accounts are now measured.** Nado's own accounts have a zero owner (Vertex: FEES_ACCOUNT = 0, X_ACCOUNT = 1, V_ACCOUNT = 2), and the census deliberately never draws them. On every coverage sweep they are now read, for the log only, so it's clear how much of the open interest sits with the protocol itself rather than with wallets we missed.

**4. The NLP vault (found 2026-10-03).** Nado's own liquidity vault (Nado Liquidity Provider) is the most likely holder of the missing open interest.
- **What it is.** It is a set of pool subaccounts that make markets and take over liquidated positions, so they sit on the other side of a lot of trades.
- **Where it shows up.** Its share token is spot product **11**, the "SPOT#11" seen on wallet pages. The Nado SDK says `NLP_PRODUCT_ID = 11` (nado-typescript-sdk @ aa288c6).
- **The $7.7M borrow gap.** The coverage log showed product 11 borrows at 0% of about $7.7M. That fits NLP shares issued by the pools: a pool holds them as a negative balance, and we never read the pools.
- **What the census does now.** The pools are listed on-chain by `Endpoint.getNlpPools()`, so every coverage sweep reads them directly, and two lines are logged:
  - an "NLP pools" line (how many there are, which are already known wallets, their share of deposits and open interest)
  - a "wallets + protocol accounts + NLP pools" line
- **Where the numbers go.** These lines go to the job log only. NLP pools are not drawn and not added to the public shares; whether to show them is an owner decision.
- **On wallet pages.** Product 11 now reads **NLP** instead of SPOT#11. Classification is unchanged: like any unlisted spot, it is its own family and never hedges a perp.

**What the next coverage line should look like:**
- If 2 was the cause, open interest coverage jumps and the log reports wallets with `exists=false` balances.
- If 3 holds the rest, the "wallets + protocol accounts" line closes the gap.
- If the NLP pools hold it, the "wallets + protocol accounts + NLP pools" line closes the gap. Then the census misses no one: the rest of the open interest is the vault, not wallets.
- If none of these do, the gap is accounts we still don't see, and the per-product gap lines show where to look next.

The trade-history scan still completes once, so the old 6-hour gaps are covered too. When it finishes, the next run does a full sweep and measures coverage again.

The job log shows the coverage line only on full sweeps; the other runs republish the last full sweep's shares.

**Measuring coverage now needs a full run started by hand (since 2026-10-03).**
- **Why:** coverage is only measured when one run reads every wallet at one block. At about 19 wallets a second, 65,000 wallets take about an hour, which no longer fits the hourly runs' 40-minute budget. The weekly automatic sweep therefore spans several runs and doesn't measure coverage.
- **What changed:** a full run started by hand (Actions → census → Run workflow, **full** ticked) now gets a 115-minute budget and a 130-minute job limit. It also restarts any sweep that paused part-way, so it reads everyone in one go.
- **What it costs:** about an hour of GitHub Actions minutes per measurement. Hourly runs are unchanged.

## The lock

The production well stays locked until `verification/status.json` is proven (see VERIFICATION.md).
- **Local dev:** always shows it, with a PREVIEW banner.
- **Production:** set `VITE_WELL_PREVIEW=1` on Vercel to show it with the same banner. That's your call.

## Costs and limits

- **GitHub Actions:** the account is on **GitHub Pro** (since 2026-09-29), which includes **3,000 minutes** a month; minutes past that cost **$0.006** each on the standard Linux runner (GitHub Docs, 2026 prices). GitHub bills each run rounded up to a whole minute, and setup (checkout + install) takes about a minute.
  - On 2026-09-29 an hourly run read 4,609 wallets in about 4 minutes, so a run costs about 5–6 minutes, or roughly **3,500–4,300 minutes a month**. That's about 500–1,300 minutes over, about **$3–8 a month** on top of Pro's $4.
  - Skipped duplicate runs cost 1 minute each.
  - Paying for extra minutes needs a payment method on file. Without one, runs are blocked once the included minutes are used.
  - An **Actions budget** (github.com/settings/billing → Budgets) caps it. It's a ceiling with email alerts, not a prepayment: GitHub charges only what was used, once a month. We use **$15**. With "stop usage when budget limit is reached" ticked, the census pauses at the cap instead of overspending, and the live site keeps working.
- **Vercel Blob:** each well visit downloads the snapshot, about 210 KB compressed per 15,000 wallets. Check Vercel → Usage.
- **RPC:** each open well tab makes a few small calls every 4 s and one heavier Nado read every ~15 s. Fine for testing on the public RPC. Use a private RPC key before announcing publicly.

## Privacy

- **A snapshot row holds only:** address, tags, hull temp, size band, a watch flag, read block, "wounded since" block, and any isolated Nado subaccount ids.
- **It never holds:** balances, HF, or liquidation prices. A test enforces this.
- **Wounded tape:** ordered by when a book was first seen wounded, never by closeness to liquidation.

## Hourly start (outside timer)

GitHub's own schedule is best-effort. On 2026-09-28/29 it started the hourly workflow only every 5–7 hours (runs at 9:01 PM, 2:53 AM, 10:03 AM and 3:25 PM). So the hour is kept by a free outside timer, **cron-job.org**, which calls GitHub's "run workflow" API. GitHub's schedule stays on as a backup every 6 hours.

**Freshness check.** It runs first in every job and costs almost nothing:
- **Timer runs** skip if the census was published under 15 minutes ago. That's a duplicate that queued behind a long run.
- **The backup schedule** skips if the census is under 50 minutes old, meaning the timer is working.
- **Runs you start by hand** never skip.

It reads the snapshot's age from the repo **variable** `CENSUS_URL`, the public census.json URL. Without it, every run goes ahead.

It went live on 2026-09-29. Run #12 failed on a bug in this check (`node -e` doesn't allow a top-level `return`), fixed the same day. Run #14 then skipped itself correctly, 5 minutes after run #13 published.

**Setup:**
1. **Repo variable.** github.com/2Pump/aegis → Settings → Secrets and variables → Actions → **Variables** tab → New repository variable: `CENSUS_URL` = `https://…public.blob.vercel-storage.com/census/census.json`.
2. **Token for the timer.** github.com/settings/personal-access-tokens/new (fine-grained):
   - **Name:** `aegis census timer`
   - **Expiration:** the longest offered. Put the date in your calendar; the timer stops when the token expires.
   - **Repository access:** Only select repositories → `aegis`.
   - **Permissions:** Add permissions → **Actions: Read and write**. Nothing else. GitHub may add **Metadata: Read-only** by itself; that's fine.
   - Generate the token and copy it.
3. **cron-job.org.** Sign up (free), then create a cronjob:
   - **URL:** `https://api.github.com/repos/2Pump/aegis/actions/workflows/census.yml/dispatches`
   - **Schedule:** every hour, at minute 5. With the Custom option, leave no hour selected, so the crontab reads `5 * * * *`.
   - **Advanced → Request method:** `POST`
   - **Advanced → Headers:**
     - `Accept: application/vnd.github+json`
     - `Authorization: Bearer <the token>`
     - `X-GitHub-Api-Version: 2022-11-28`
     - `Content-Type: application/json`
   - **Advanced → Request body:** `{"ref":"main","inputs":{"source":"timer"}}`
   - Save, then **Test run**. GitHub answers **204** (success, empty reply). A new run appears in Actions named **census · timer**.
4. **If it fails.** cron-job.org can email you when a call fails.
   - **401:** the token expired or was pasted wrong.
   - **404:** the URL or the token's repository access is wrong.
   - **422:** the body or the branch name is wrong.
5. **API version.** GitHub marks the `2022-11-28` API version as deprecated from 10 March 2026, with a sunset on 10 March 2028. When you renew the token, check GitHub's API versions page for the current version and update the header.
