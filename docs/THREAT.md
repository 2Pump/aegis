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
- Seed list is empty. Adding a wallet requires owner consent or a public protocol label (`fixtures/seeds.json` `_howto`).
- Wounded tape (Phase 2) label is fixed: “Wounded in sample — not a hit list.” No “hunt”, no sort-by-closest-to-liquidation, no liquidation-price column.
- `robots.txt` disallows `/hull/` so search engines don't build an index of plates.
- Recent addresses live in `sessionStorage` of the viewer's own tab only.

## C. How we get rate-limited

- Nado: 2400 weight/min per IP. One hull read = symbols (2, cached 10 min) + archive subaccounts (2) + subaccount_info (2 × subaccounts, cap 8).
  At 15 s polling that is ≈ 16–72 weight/min per open tab — well under the cap for a user, and since Nado is read from each viewer's own browser, each viewer spends their own IP budget (no pooled proxy). Watch this before Phase 2's 250-ship sample; a Worker cache will be required there.
- 429 → RATE_LIMIT → exponential backoff (×2, honours `Retry-After`, max 5 min), shown in the sensor log.
- Hidden tabs skip reads.
- Ink public RPC: 1 multicall-batched read + 1 multicall per hull per 15 s, plus footer head every 15 s. Set `VITE_INK_RPC` to a private endpoint for production traffic.

## D. Write-path guarantees

- No `approve`, `transfer`, `writeContract`, `sendTransaction`, `signTypedData`, `signMessage`, Nado `/execute` or order code in `apps/` or `packages/`. `node scripts/audit-writes.mjs` fails the build if one appears.
- Wallet connect is injected-only and used solely to read the connected address.
