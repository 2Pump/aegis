# LOOKUPS — Phase 0 cartography

Everything AEGIS reads, where the address/endpoint came from, and how sure we are.
**PROVEN** = read from a primary source or verified by live response. **GUESSED** = inferred; must be verified live.
Fetched **2026-09-28** unless noted.

> Sandbox note: the build environment could not reach `rpc-gel.inkonchain.com` or `api.prod.nado.xyz`
> from its shell (egress allowlist). Nado GET endpoints were read via a web fetcher. **No live Tydro
> read has been made yet.** The Phase 1 exit check (“a real Ink address matches official UI numbers”)
> must be run from a normal machine: `pnpm prove 0xYOUR_ADDRESS` (docs/VERIFICATION.md). The well stays locked until it passes.
> Caveat: the web fetcher cached Nado `/query` by path, so only the `symbols` response was actually seen live.

---

## A. Network

| Item | Value | Status | Source |
|---|---|---|---|
| Chain | Ink, OP-Stack L2 | PROVEN | viem `chains/definitions/ink.ts` (viem 2.56.9) |
| Chain ID | 57073 | PROVEN | viem ink chain; aave-address-book `CHAIN_ID = 57073` |
| RPC (default) | https://rpc-gel.inkonchain.com | PROVEN (listed) | viem ink chain `rpcUrls.default` |
| RPC (census rotation) | https://rpc-qnd.inkonchain.com · https://rpc-ten.inkonchain.com · https://ink.drpc.org | LISTED (docs.inkonchain.com/tools/rpc, 2026-09-28) | each run checks eth_chainId = 57073 and head lag before use; a failing one is skipped |
| Explorer | https://explorer.inkonchain.com | PROVEN (listed) | aave-address-book links |
| Multicall3 | 0xcA11bde05977b3631167028862bE2a173976CA11 | PROVEN (listed) | viem ink chain `contracts.multicall3` |

## B. Tydro (Aave v3 white-label on Ink)

Source: [aave-dao/aave-address-book · AaveV3InkWhitelabel.ts](https://github.com/aave-dao/aave-address-book/blob/main/src/ts/AaveV3InkWhitelabel.ts).
`docs.tydro.com/resources/addresses` returned **404** on 2026-09-28; Tydro docs (`llms-full.txt`) only list the AaveOracle and kBTC/USDC, both of which **match** the address book.
Addresses are never hand-typed: `node scripts/sync-tydro-registry.mjs` regenerates `packages/ink-io/src/tydro-registry.ts`.

| Contract | Address | Status |
|---|---|---|
| PoolAddressesProvider | 0x4172E6aAEC070ACB31aaCE343A58c93E4C70f44D | PROVEN (address book) |
| Pool | 0x2816cf15F6d2A220E789aA011D5EE4eB6c47FEbA | PROVEN (address book + on-chain: verified proxy → L2PoolInstance 0x6a05…eb6) |
| AaveOracle | 0x4758213271BFdC72224A7a8742dC865fC97756e1 | PROVEN (address book + Tydro docs + on-chain verified `AaveOracle`) |
| AaveProtocolDataProvider | 0x96086C25d13943C80Ff9a19791a40Df6aFC08328 | PROVEN (address book) — not used yet |
| UiPoolDataProvider | 0x2E549104c516b8657A7D888494DfbAbD7C70b464 | PROVEN (address book) — not used (struct ABI varies by version) |
| WalletBalanceProvider | 0xB1532b76D054c9F9E61b25c4d91f69B4133E4671 | PROVEN (address book) — not used |

**How AEGIS reads Tydro (all `view`, pinned to one block):**
1. `Pool.getUserAccountData(user)` → totalCollateralBase, totalDebtBase, currentLiquidationThreshold (bps), healthFactor (1e18). **This is the HF liquidators see.** No debt → HF shown as ∞.
2. `AaveOracle.BASE_CURRENCY_UNIT()` and `getAssetsPrices(underlyings)` → USD prices (label: TYDRO ORACLE).
3. `aToken.balanceOf(user)` / `variableDebtToken.balanceOf(user)` per registry reserve → legs.
4. `Pool.getReservesList()` → if a live reserve is missing from the registry, the plate says so.
5. Cross-check: Σ debt legs vs `totalDebtBase`; >1% mismatch → note on the plate.

**Reserves (token registry, Tydro side)** — 14 listed in address book:
WETH, kBTC (8 dec, 0x73E0C0d45E048D25Fc26Fa3159b0aA04BfA4Db98), USDT (= USDT0, 0x0200C29006150606B650577BBE7B6248F58470c1), USDG, GHO, USDC (0x2D270e6886d130D724215A266106e6832161EAEd), weETH, wrsETH, ezETH, sUSDe, USDe, SolvBTC, syrupUSDT, kHYPE.
Full addresses in `packages/ink-io/src/tydro-registry.ts`.
On-chain spot check (Blockscout, 2026-09-28): kBTC aToken = `aInkWlKBTC`, USDC vToken = `variableDebtInkWlUSDC`, USDT vToken = `variableDebtInkWlUSDT`. Decimals match. See docs/VERIFICATION.md.

## C. Nado

### C.0 How AEGIS reads Nado now: ON-CHAIN (2026-09-28)

Nado's HTTP API sits behind a Cloudflare challenge that only its own frontend passes. This was proven from Brandon's machine: curl → 403 `Cf-Mitigated: challenge`, and the browser from localhost → CORS failure. The SDK source confirms it: *"CORS set to the relevant frontend endpoint … will NOT work from other domains"*.
So AEGIS reads Nado from the **Ink chain** with a `view` call to Nado's own `FQuerier.getSubaccountInfo(bytes32)`. It returns the same struct as the gateway's `subaccount_info`.

| Contract | Address | Status |
|---|---|---|
| FQuerier (proxy) | 0x68798229F88251b31D534733D6C4098318c9dff8 | PROVEN: SDK deployment.inkMainnet.json @7a326cb + Blockscout verified proxy → `FQuerier` impl 0xd0d3…d386 |
| Clearinghouse (proxy) | 0xD218103918C19D0A10cf35300E4CfAfbD444c5fE | PROVEN: SDK + Blockscout verified → `Clearinghouse` |
| Endpoint / SpotEngine / PerpEngine | 0x05ec…974E / 0xFcD9…07fE / 0xF859…6da1 | SDK (not used yet) |
| Quote token | 0x0200…70c1 (USDT0) | matches product 0 |
| Deployer | 0xC1cC56caB60e832665E6c3780BfEBe3C1C971603 | created both proxies |

ABI copied verbatim from SDK `packages/shared/src/abis/Querier.ts` @7a326cb; unit test round-trips it through viem's encoder/decoder.
Price label: **NADO ON-CHAIN**, the last oracle price settled on Ink. Caveats: settled state can trail app.nado.xyz by seconds; only the `default` subaccount is read (isolated discovery needs the blocked archive API); product ids → symbols from the 2026-09-28 snapshot in `nado-registry.ts`.

### C.0b Discovery events + start blocks (census)

| Venue | Event | Contract | From block | Source |
|---|---|---|---|---|
| Tydro | `Transfer(address,address,uint256)` | all 14 aTokens + 14 variableDebtTokens | 19,954,047 | Pool proxy creation tx 0x0320…3c40 (Blockscout; 2025-07-25) |
| Nado | `ModifyCollateral(int128,bytes32 indexed,uint32)`, `Liquidation(bytes32 indexed,bytes32 indexed,…)` | Clearinghouse | 29,851,015 | SDK `deployment.inkMainnet.json` startBlock |
| Nado | `BalanceUpdate(uint32,bytes32)` (not indexed; every trade) | SpotEngine, PerpEngine | recent windows only | SDK abis @7a326cb |
| Nado | `getHealth(bytes32,uint8)` → int128 | Clearinghouse | — | SDK abis; used to skip empty accounts cheaply |

**Finding:** `FQuerier.getSubaccountInfo` returns **every** product (~100) per call. This was confirmed from the verified source on Blockscout, and it's why the census filters empty accounts via `getHealth` first.

### C.1 HTTP API (kept for reference; not used by default)

Docs: https://docs.nado.xyz (index: `/llms.txt`). **Queries need no signature** — docs, *Core Concepts*: “Read operations (queries) don't require signing!” AEGIS never calls `/execute`.

| Item | Value | Status |
|---|---|---|
| Gateway (REST) | https://api.prod.nado.xyz/gateway/v1 | PROVEN (docs + live `symbols` response) |
| Archive / indexer | https://api.prod.nado.xyz/archive/v1 | PROVEN (docs) — not live-tested |
| WebSocket | wss://api.prod.nado.xyz/gateway/v1/ws | PROVEN (docs) — not used |
| Rate limit | 2400 weight/min or 400/10s per IP; `subaccount_info` weight 2, `symbols` 2 | PROVEN (docs) |
| Archive `subaccounts` limit | 1200 req/min per IP, weight 2 | PROVEN (docs) |
| Cloudflare bot protection | **PROVEN 2026-09-28**: every non-browser client (curl, curl with honest UA, Vite proxy, legacy `gateway.prod.nado.xyz`) gets `403` + `Cf-Mitigated: challenge`. A real browser (Chicago, US) gets `200` JSON. Not a location block. | → Nado is read **directly from the viewer's browser**. No server proxy. We do not disguise as a browser or solve challenges. |
| CORS for browser calls | **UNKNOWN — the app now reports it in the sensor log** ("browser blocked the reply (CORS…)") | if blocked: ask Nado to allow the AEGIS origin, or run read-only via their SDK where allowed |
| `Accept-Encoding: gzip/br/deflate` required | browsers send it; proxy passes it | PROVEN (docs) |

**Subaccount id** = 20-byte address ‖ 12-byte ASCII name, right-padded. Default name `default` → `…64656661756c740000000000`. PROVEN (docs example; unit-tested).

**Queries used:**
1. `GET /query?type=symbols` → `data.symbols` is an **object keyed by symbol** `{type, product_id, symbol, …}`. PROVEN (live response).
2. `POST archive {"subaccounts": {"address": "0x…"}}` → list of subaccounts incl. isolated. **Request shape GUESSED** from the docs description (“Query all subaccounts associated to an address”). On any failure AEGIS reads `default` only and **says so on the plate**.
3. `GET /query?type=subaccount_info&subaccount=0x…` → balances, healths, product oracle prices. PROVEN (docs example payload; parser unit-tested on it).

**Units:** every amount/price is x18 (“amounts come back normalized to 18 decimal places”). Spot `amount` < 0 = borrow. Perp `amount` = signed base size; `v_quote_balance` = quote leg in USD.

**`healths[]` order:** INITIAL = 0, MAINTENANCE = 1, PNL/unweighted = 2.
Status: **PROVEN by arithmetic on the docs example** — the example's liabilities are 1.10× / 1.05× / 1.00× of the single borrow (initial / maintenance / unweighted weights), and `healths[2].health` equals Σ spot USD within $25. Liquidation when maintenance health < 0 (DeepWiki summary of nado-contracts). The app re-checks `healths[2]` against computed equity on **every** read and flags a mismatch on the plate.

**Price source:** `oracle_price_x18` from the same `subaccount_info` response (label: NADO ORACLE). This is the venue's oracle, which is what Nado risk uses. It is **not** the order-book mid. No off-chain fallback is wired; if one is ever added it must carry the banner “DISPLAY ONLY — NOT VENUE MARK”.

**Funding rates:** not wired (archive `funding_rate` exists; request shape not yet verified). Plate shows funding **side** only.

## D. Token registry — Nado products (live `symbols`, 2026-09-28)

| Asset | Nado spot product | Perp product | Status |
|---|---|---|---|
| USDT0 (quote) | 0 | — | PROVEN (docs `/v2/assets` example); absent from `symbols` (quote asset) |
| KBTC | 1 | BTC-PERP 2 | LIVE |
| WETH | 3 | ETH-PERP 4 | LIVE |
| USDC | 5 | — | LIVE |
| wQQQx | 115 | QQQ-PERP 98 | LIVE |
| wSPYx | 117 | SPY-PERP 100 | LIVE |
| wAAPLx | 143 | AAPL-PERP 102 | LIVE |
| wAMZNx | 145 | AMZN-PERP 104 | spot **not_tradable** |
| wGOOGLx | 147 | GOOGL-PERP 106 | LIVE |
| wMETAx | 149 | META-PERP 108 | LIVE |
| wMSFTx | 151 | MSFT-PERP 110 | spot **not_tradable**, maint weight 0 |
| wNVDAx | 153 | NVDA-PERP 112 | LIVE |
| wTSLAx | 155 | TSLA-PERP 114 | LIVE |
| XAUT0 | 159 | XAUT-PERP 28 | LIVE |
| HOODx | — | — | **ABSENT** on Nado |
| GHO, USDG | — | — | **ABSENT** on Nado (Tydro only) |

Note the dossier's tickers (SPYx, QQQx…) are listed on Nado as **wrapped** `wSPYx`, `wQQQx`… Per docs *xStocks Spot Trading*: wrapped price = stock price × `exchange_rate` (ERC-4626 redemption rate). AEGIS values xStocks at Nado's oracle price for the wrapped token, so no conversion is needed for USD.

Carry family choice: **BTC** (KBTC spot + BTC-PERP both exist). ETH and every xStock family with a perp are also mapped, because the data supports it.

## E. Open lookups — run these from your machine

```powershell
# 1. Ink RPC alive + chain id (expect 0xdef1 = 57073)
curl -s -X POST https://rpc-gel.inkonchain.com -H "content-type: application/json" -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_chainId\",\"params\":[]}'

# 2. Nado CORS (look for access-control-allow-origin)
curl -s -D - -o NUL -H "Origin: https://example.com" "https://api.prod.nado.xyz/gateway/v1/query?type=status"

# 3. Archive subaccounts request shape (replace address)
curl -s -X POST https://api.prod.nado.xyz/archive/v1 -H "content-type: application/json" --compressed -d '{\"subaccounts\":{\"address\":\"0xYOURADDR\"}}'
```

Phase 1 exit: open `/hull/<an address you know has Tydro + Nado positions>` and compare HF, collateral, debt, Nado equity and positions against app.tydro.com and app.nado.xyz. Record the result here with date.
