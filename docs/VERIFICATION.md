# VERIFICATION — prove one real address before drawing the well

**Rule:** the well is not drawn until one real Ink address has been read by the exact Phrourax sensors and matched, field by field, against the official Tydro and Nado UIs.
The gate is `verification/status.json`. Only `pnpm prove` can flip it, and only when every check passes.
Until then, `/` shows a red **WELL LOCKED — SENSORS UNVERIFIED** banner. Every live hull plate says **SENSORS UNVERIFIED**, and fixtures appear only on `/calibration`.

## Known issue (2026-09-28)

Nado's HTTP API refuses everything except its own website (Cloudflare challenge + CORS). **Resolved:** Phrourax and `pnpm prove` now read Nado from the Ink chain via Nado's `FQuerier` contract, so both work in Node and in the browser. Tydro works live: block 57,115,786 on the test vector, HF 1.389 = $2,994,782 × 0.87 ÷ $1,875,960.
When comparing with app.nado.xyz, allow a few seconds of lag: on-chain is *settled* state.

## Per-venue proofs with a watch-only address (2026-09-28)

Neither official app has a "view any address" box. A read-only wallet can still connect *as* any public address:
- **Rabby:** Add address → **Import Watch-Only Address**.

The app then shows that address's dashboard. A watch-only address has no keys, so nothing can be signed.

Because the address you can watch on Tydro rarely also trades on Nado, each venue is proven **on its own**:
- `pnpm prove 0xADDR` asks only for the venues where the address has positions.
- A venue is PROVEN when all of these hold:
  - its machine checks have 0 FAIL;
  - every one of its UI fields was typed in and matched, with none skipped;
  - the address really has positions there.
- `verification/status.json` records `venues.tydro` / `venues.nado`. `verified` is true only when **both** are proven.
- Until then, the site states exactly which venue is verified, against which address and at which block, and keeps the PREVIEW label.

Tydro Dashboard labels map to: **Health Factor**, **Assets** (Σ supplied USD), **Liabilities** (Σ borrowed USD), and each asset's **Amount**. Tolerances: HF ±0.01, USD ±1%, amounts ±0.1%.

### Nado when app.nado.xyz is blocked in your region

app.nado.xyz answers some regions with `{"reason":"ip_query_only","blocked":true}`. That means the app is off, but **queries** still work. Don't bypass it with a VPN; that breaks Nado's terms.

Nado's official API, the one the app is built on, still answers `subaccount_info` in your browser. It is an independent path from Phrourax's own read, which goes through the Ink chain via FQuerier:

```powershell
pnpm prove 0xNADO_ADDRESS                  # prints the API link for that address
# open the link, Ctrl+A, Ctrl+C, then:
Get-Clipboard | Set-Content nado.json -Encoding utf8
pnpm prove 0xNADO_ADDRESS --nado-json nado.json
```

`prove` checks that the reply is for **this** address's `default` subaccount. It then compares:
- equity: ±1%
- maintenance health: ±2%
- every spot balance: ±0.1%
- every perp size: ±0.01%

The API is the sequencer's live state and the chain is settled state, so fetch the JSON and run prove within a minute of each other. A proof made this way is recorded as `sources.nado = "api"`, and the site says **"Nado verified against Nado's official API"**, not "app.nado.xyz".

## Protocol

```powershell
pnpm install
pnpm prove 0xYOUR_ADDRESS
```

1. **Same sensors.** `prove` calls `readBook()` from `@aegis/ink-io`, the same function the web app uses. It talks to Nado directly, since there is no browser and no CORS.
2. **Tydro independent path, same block.**
   - Every reserve is re-read via `AaveProtocolDataProvider.getUserReserveData`, a different contract from Phrourax's aToken/debtToken `balanceOf`. The amounts must match exactly.
   - HF is recomputed as Σ(collateral × liquidation threshold) / debt from `getReserveConfigurationData`. It must be within 0.5% of `Pool.getUserAccountData`.
3. **Blockscout.** The chain indexer's token balances are a third source. The indexer lags, so this check can only warn, not fail.
4. **Nado self-consistency.** `healths[2]` must equal the equity Phrourax computes. It also reports whether the archive found your subaccounts, or whether Phrourax fell back to `default` only.
5. **Human.** Open app.tydro.com and app.nado.xyz connected as that address, and type in what they show:
   - Tydro HF: must be within ±0.01.
   - Tydro supplied and borrowed: within ±1%.
   - Nado account value: within ±1%.
   - Each perp size and spot balance: within ±0.01% / ±0.1%.
6. **Verdict.** A record is written to `verification/<address>-<utc>.json`, so commit it. The address is PROVEN only if:
   - there are 0 FAIL checks,
   - both venues were readable,
   - the address actually has positions,
   - and every UI field matched.

   Only then is `status.json` flipped.

**Best address to use: your own**, with at least one Tydro borrow and one Nado perp. The official UIs show the numbers when you connect, and it proves the full CARRY/NAKED path.

## What was verified from the build sandbox (2026-09-28)

The sandbox cannot reach the Ink RPC or the Nado API: its shell egress is blocked. The web fetcher also caches Nado `/query` by path, so every query returned `symbols`. What *was* checked live, via the Blockscout indexer:

| Check | Result |
|---|---|
| Pool `0x2816…FEbA` is a verified proxy → `L2PoolInstance` impl `0x6a05…eb6` (matches address book `POOL_IMPL`) | ✅ on-chain |
| Oracle `0x4758…56e1` is verified `AaveOracle` | ✅ on-chain |
| `0xC712…564e` = `aInkWlKBTC`, 8 dec (registry: kBTC aToken) | ✅ on-chain |
| `0x305c…0B29` = `variableDebtInkWlUSDC`, 6 dec (registry: USDC vToken) | ✅ on-chain |
| `0xA5d6…719a` = `variableDebtInkWlUSDT`, 6 dec (registry: USDT0 vToken) | ✅ on-chain |
| Nado `symbols` shape + product ids | ✅ live API |
| Nado `subaccount_info` against a real address | ❌ not reachable from sandbox |
| Pool `getUserAccountData` against a real address | ❌ not reachable from sandbox (Blockscout `eth_call` GET → 400) |

The Ink RPC and Nado are unreachable from the sandbox only. `pnpm prove` on your machine is the real test.

### Tydro test vector (public, from Blockscout indexer, 2026-09-28)

A large USDC borrower, taken from the top holders of the USDC variable-debt token. This is used **only** as a sensor test and is **not** a seed for the well.

`0x0B3fadeF84ea8877cA3C898133b4056950b75eC5`

| Token | Raw | Human | Phrourax leg expected |
|---|---|---|---|
| aInkWlKBTC | 3582283279 | 35.82283279 kBTC | SUPPLY kBTC ≈ 35.8228 (grows with interest) |
| variableDebtInkWlUSDC | 1800680231150 | 1,800,680.23 USDC | DEBT USDC ≈ 1,800,680 (grows) |
| variableDebtInkWlUSDT | 75245455707 | 75,245.46 USDT0 | DEBT USDT0 ≈ 75,245 (grows) |
| GHO (wallet, not Tydro) | 788e18 | 788 GHO | **not** a Tydro leg; must not appear |

Expected pose if Nado is empty: primary **KBTC-CORE** (kBTC is 100% of margin). LOCKED is also listed. HF is whatever the Pool says. `pnpm prove 0x0B3f…` must show the three legs above within indexer lag, with the Blockscout rows PASS or WARN.
This vector cannot pass the human step unless you control that wallet. It proves the Tydro decoding only. **The gate needs your own address.**

## Automatic checks (`verify-1.0.0`)

`pnpm verify:auto` — run about every 4 hours by the hourly census itself (census.yml → "Checks (when due)": it runs when the last automatic check is ≥ 3¾ h old, so cron-job.org's hourly timer keeps the checks on time with no timer of their own). By hand: Actions → verify → Run workflow, same secrets as the census.
- Picks real wallets from the latest census (a different set each run): a Tydro borrower, a Nado default-only wallet, a Nado wallet with an isolated subaccount.
- Reads each with the site's own readers and compares with sources Phrourax does not read from: Tydro AaveProtocolDataProvider balances (±1e-9) and a recomputed HF (±0.5%) at the same block; Nado Clearinghouse.getHealth for every subaccount (±1%).
- **E-Mode (since 2026-10-10):** the recomputed HF applies the wallet's E-Mode category.
  - It reads `Pool.getUserEMode`, then the category's liquidation threshold for the assets it covers. That's the v3.2 collateral bitmap, or the v3.0 per-reserve category.
  - Without this, an asset that is collateral only inside E-Mode (syrupUSDT: standard threshold 0) made the recomputation 0 while Tydro's own HF was 1.022. That was the FAILED record of 2026-10-10 20:10 UTC (`0x6431…ac26`, block 58,164,642).
  - That record stays in the history. The site's own HF always came from `Pool.getUserAccountData`, which is E-Mode-aware, so wallet pages were never affected.
  - If the E-Mode configuration can't be read, the row is SOURCE UNAVAILABLE, never a pass.
- Compares Nado's official API too, with a plain request (it answered from GitHub's runners on 2026-10-04). When Cloudflare refuses it, the row is SOURCE UNAVAILABLE — never a pass, never worked around.
- Tydro: wallets the census already flags as borrowing (a Tydro wound, a same-family loop, an at-risk watch) are tried first, up to 40.
- A case with no suitable wallet that run is recorded as NOT CHECKED. Every expected check always has a row on the page, so a missing one is never silently left out.
- Each record: venue, short wallet, case, source + type, time, block, rules and engine versions, fields (expected / Phrourax / tolerance / pass), status, failure reason.
- Appended to `verification-log.json` on Blob; history is never deleted.
- Checks page: per case the latest status — CURRENT, STALE (> 6 h: one missed run plus slack), FAILED, SOURCE UNAVAILABLE, NOT CHECKED — plus the last success, versions (older flagged) and the full history. A FAIL makes the workflow run red.

`pnpm prove` records now also carry the same structured form (`structured`), and a stated failure can never finalize as a pass.
