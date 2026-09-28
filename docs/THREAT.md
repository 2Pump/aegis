# THREAT — how the map can lie, dox, or get rate-limited

## A. How the map can lie

| Risk | Mitigation in V1 |
|---|---|
| A sensor fails and a half-book gets classified | Any DARK sensor → primary DARK. CARRY/NAKED/etc. are **not evaluated**, residual Δ is null. Only a wound seen on the readable venue may attach. |
| Parser silently reads 0 on a schema change | Missing price / non-numeric amount → PARSE_FAIL → DARK. Never a zero. |
| `healths[]` index wrong | Every read re-checks `healths[2]` against computed equity; a mismatch is printed on the plate. |
| Stale Tydro registry (new reserve listed) | `Pool.getReservesList()` diff and Σ debt vs `totalDebtBase` check — both flagged on the plate. |
| Isolated Nado positions missed | Archive subaccount discovery; if it fails, plate says “read 'default' only; isolated positions not shown”. |
| Two venues, two prices | Every USD number carries a source chip (TYDRO ORACLE / NADO ORACLE / FIXTURE). No off-chain prices. |
| Unknown token hedging a known perp | Unknown symbols become their own family; they can never make a CARRY. |
| Rules drift from docs | `rules-doc.test.ts` fails if RULES.md constants ≠ `config.ts`. `/rules` renders from the same constants. |
| Fixtures mistaken for real accounts | Synthetic `0x…ae60NN` addresses, FIXTURE banner, FIXTURE chips, no explorer link, copy-link disabled. |
| Wrong chain RPC | `getChainId() ≠ 57073` → WRONG_CHAIN → DARK. |

## B. How the map can dox or be used to hunt

- The public well shows **size bands**, not balances. Exact figures only on a hull page a user opened.
- Share text and (future) OG images carry **no balances** — tested in `glyphs.test.ts`.
- The census shows **every** Tydro/Nado account, found from public on-chain events (not scraped, not bought).
  - **Why that isn't a hit list:** snapshot rows carry no balances, HF or liquidation prices (tested), and dots encode size *bands* only.
  - **Wounded tape:** 8 rows, ordered by *when first seen wounded*, never by closeness to liquidation.
  - **Honest context:** professional liquidators already index every borrower; AEGIS adds no edge, and the guardrails are about not *presenting* it as a target list.
- Seed list remains empty (it's no longer needed for coverage).
- Wounded tape (Phase 2) label is fixed: “Wounded in sample — not a hit list.” No “hunt”, no sort-by-closest-to-liquidation, no liquidation-price column.
- `robots.txt` disallows `/hull/` so search engines don't build an index of plates.
- Recent addresses live in `sessionStorage` of the viewer's own tab only.

## C. How we get rate-limited

- Nado: 2400 weight/min per IP. One hull read = symbols (2, cached 10 min) + archive subaccounts (2) + subaccount_info (2 × subaccounts, cap 8).
  At 15 s polling that is ≈ 16–72 weight/min per open tab — well under the cap for a user, and since Nado is read from each viewer's own browser, each viewer spends their own IP budget (no pooled proxy). Nado HTTP is no longer used: every read is an Ink RPC `eth_call` or `eth_getLogs`.
- 429 → RATE_LIMIT → exponential backoff (×2, honours `Retry-After`, max 5 min), shown in the sensor log.
- Hidden tabs skip reads.
- **Ink public RPC, per open hull page:** one multicall-batched read plus one multicall every 15 s, and the footer head every 15 s.
- **Per open well tab (live layer):** `getBlockNumber`, plus two `getLogs` every ~4 s (≤1,500 blocks each), plus re-reads of ≤12 wallets per tick. Nado `getSubaccountInfo` is heavy (~100 products per call), so it's kept to touched and at-risk wallets.
- Set `VITE_INK_RPC` and the `INK_RPC` Action secret to a private endpoint before any public launch.
- **Census job:** self-sizing `getLogs` windows (halve on error, never regrow past a failed size) and self-sizing multicall chunks. Budget-limited to 40 min per run, resumable.

## D. Write-path guarantees

- No `approve`, `transfer`, `writeContract`, `sendTransaction`, `signTypedData`, `signMessage`, Nado `/execute` or order code in `apps/` or `packages/`. `node scripts/audit-writes.mjs` fails the build if one appears.
- Wallet connect is injected-only and used solely to read the connected address.
