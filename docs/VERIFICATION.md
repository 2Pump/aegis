# VERIFICATION — prove one real address before drawing the well

**Rule:** the well is not drawn until one real Ink address has been read by the exact AEGIS sensors and matched, field by field, against the official Tydro and Nado UIs.
The gate is `verification/status.json`. Only `pnpm prove` can flip it, and only when every check passes.
Until then, `/` shows a red **WELL LOCKED — SENSORS UNVERIFIED** banner. Every live hull plate says **SENSORS UNVERIFIED**, and fixtures appear only on `/calibration`.

## Known issue (2026-09-28)

Nado's HTTP API refuses everything except its own website (Cloudflare challenge + CORS). **Resolved:** AEGIS and `pnpm prove` now read Nado from the Ink chain via Nado's `FQuerier` contract, so both work in Node and in the browser. Tydro works live: block 57,115,786 on the test vector, HF 1.389 = $2,994,782 × 0.87 ÷ $1,875,960.
When comparing with app.nado.xyz, allow a few seconds of lag: on-chain is *settled* state.

## Protocol

```powershell
pnpm install
pnpm prove 0xYOUR_ADDRESS
```

1. **Same sensors.** `prove` calls `readBook()` from `@aegis/ink-io`, the same function the web app uses. It talks to Nado directly, since there is no browser and no CORS.
2. **Tydro independent path, same block.**
   - Every reserve is re-read via `AaveProtocolDataProvider.getUserReserveData`, a different contract from AEGIS's aToken/debtToken `balanceOf`. The amounts must match exactly.
   - HF is recomputed as Σ(collateral × liquidation threshold) / debt from `getReserveConfigurationData`. It must be within 0.5% of `Pool.getUserAccountData`.
3. **Blockscout.** The chain indexer's token balances are a third source. The indexer lags, so this check can only warn, not fail.
4. **Nado self-consistency.** `healths[2]` must equal the equity AEGIS computes. It also reports whether the archive found your subaccounts, or whether AEGIS fell back to `default` only.
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

| Token | Raw | Human | AEGIS leg expected |
|---|---|---|---|
| aInkWlKBTC | 3582283279 | 35.82283279 kBTC | SUPPLY kBTC ≈ 35.8228 (grows with interest) |
| variableDebtInkWlUSDC | 1800680231150 | 1,800,680.23 USDC | DEBT USDC ≈ 1,800,680 (grows) |
| variableDebtInkWlUSDT | 75245455707 | 75,245.46 USDT0 | DEBT USDT0 ≈ 75,245 (grows) |
| GHO (wallet, not Tydro) | 788e18 | 788 GHO | **not** a Tydro leg; must not appear |

Expected pose if Nado is empty: primary **KBTC-CORE** (kBTC is 100% of margin). LOCKED is also listed. HF is whatever the Pool says. `pnpm prove 0x0B3f…` must show the three legs above within indexer lag, with the Blockscout rows PASS or WARN.
This vector cannot pass the human step unless you control that wallet. It proves the Tydro decoding only. **The gate needs your own address.**
