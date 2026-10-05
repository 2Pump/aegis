# AEGIS — Tydro · Nado · Ink

A camera on what every Ink wallet is doing. Paste an Ink address and AEGIS reads Tydro (Aave v3 on Ink) and Nado.
It classifies the pose (CARRY, NAKED, EQUITY-MARGIN, …) with public rules and draws it as a ship in a gravity well.

> **AEGIS is a camera. It cannot move your funds. Classifications can be wrong.**

It takes no custody, requests no approvals, and places no orders. There is no token. `pnpm build` runs `scripts/audit-writes.mjs`, which fails if a write path appears.

## Status: Phase 1 scaffold, stopped for demo (dossier step G)

| Acceptance (Phase 1) | State |
|---|---|
| Paste an address, no connect required | ✅ |
| Tydro and/or Nado data shown or explicitly DARK | ✅ both live on-chain from Brandon's machine 2026-09-28 (block 57,117,283); UI match still pending |
| Primary tag + reasons visible | ✅ |
| /rules matches the code constants | ✅ enforced by `rules-doc.test.ts` |
| Six fixture tests green | ✅ (plus edge tests) |
| Footer says camera / cannot move funds | ✅ |
| Zero approve() / zero order paths | ✅ `pnpm audit:writes` |
| **Exit: real address matches official UI within rounding** | ⏳ `pnpm prove 0xYOUR_ADDRESS` — the well is LOCKED until this passes (docs/VERIFICATION.md) |

## Run (Windows / PowerShell)

```powershell
# Node 20+ and pnpm 10
corepack enable
pnpm install
copy apps\web\.env.example apps\web\.env.local   # optional; defaults work
pnpm dev                                          # http://localhost:5173
```

```powershell
pnpm census --since-blocks 200000   # local census (see docs/CENSUS.md); pnpm dev then shows the well as PREVIEW
pnpm prove 0xYOUR_ADDRESS   # read a real address, cross-check, compare to official UIs
pnpm check     # write-path audit + typecheck + all unit tests
pnpm build     # audit + typecheck + production build
pnpm --filter @aegis/web exec playwright install chromium   # first time only
pnpm --filter @aegis/web build; pnpm e2e                    # browser smoke tests
```

### Deploy (Vercel)
Set the project **Root Directory** to `apps/web`. `apps/web/vercel.json` installs and builds from the workspace root and adds the SPA fallback. No proxy or server is needed: both Tydro and Nado are read from the Ink chain in the viewer's browser.

## Layout

```
apps/web          Vite + React 19 + TS strict. Routes: / /hull/:address /calibration /fixture/:name /rules /census /watch
packages/pose     Classifier — pure functions, no React, no IO. Constants in src/config.ts only.
packages/ink-io   Every network read. Result<T, InkError>. Tydro and Nado both via Ink RPC (Nado through its FQuerier contract).
packages/glyphs   Well layout + layered canvas (20k+ ships), hull sigil SVG, copy deck.
packages/census   Census snapshot format + LiveEngine (browser-safe) and the hourly job (./node: discovery, batch reads, Blob/file store).
docs              LOOKUPS · RULES · MATH · THREAT · VERIFICATION · CENSUS
.github/workflows census.yml — hourly census job
verification      status.json (the well gate) + proof records written by `pnpm prove`
fixtures          Six synthetic books (the dossier examples) + empty seeds.json
scripts           census · prove · verify-auto · alerts · make-fixtures · sync-tydro-registry · audit-writes
```

## Routes
- `/`: the well. It shows every Tydro and Nado account from the hourly census, kept live in the browser (events every ~4 s, at-risk re-reads every ~15 s), plus the wounded tape, the live-changes tape and the live diagnostics. It stays **locked** in production until verification passes; dev builds and `VITE_WELL_PREVIEW=1` show it with a PREVIEW banner. Fixtures never appear in it.
- `/hull/:address`: the ship plate. It re-reads every 15 s, backs off on 429, and pauses while the tab is hidden. It has sections REGISTRY, HULL TEMP, POSE, LOCKER, BOOK, VECTOR and SHARE, plus an on-page **sensor log**, so a screenshot shows exactly what each sensor returned.
- `/calibration`: proof status + the six fixture books. `/fixture/carry|naked|equity-margin|wounded|dark|empty`: calibration plates.
- Rules: one drawer, opened from the header button, the footer, a wallet page, or any link with `?rules=1` (old `/rules` links redirect to it).
- `/intel`: INTEL. HISTORY (ecosystem risk over time), LIQUIDATIONS (ledger, cascades, replay), ORACLES (Oracle Watch), CHANGES (Protocol Change Monitor) and CARRY (Yield and Carry, analysis only) are built (docs/HISTORY.md, docs/LEDGER.md, docs/ORACLES.md, docs/CARRY.md). The Checks page carries the track record and Pressure forecast scoring.
- `/developers` and `/api/v1`: the read-only Public Risk API (docs/API.md); webhooks are built but OFF (docs/WEBHOOKS.md).
- `/census`: pose mix of every account found, coverage, and snapshot and backfill status.
- `/watch`: Telegram alerts — built and tested, labelled NOT LIVE until switched on (docs/ALERTS.md).
