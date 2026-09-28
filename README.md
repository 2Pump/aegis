# AEGIS — THE WELL MAP

A camera on how Ink books are aimed. Paste an Ink address and AEGIS reads Tydro (Aave v3 on Ink) and Nado.
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
packages/glyphs   Well layout + canvas draw, hull sigil SVG (reused for OG in Phase 2), copy deck.
docs              LOOKUPS · RULES · MATH · THREAT · VERIFICATION
verification      status.json (the well gate) + proof records written by `pnpm prove`
fixtures          Six synthetic books (the dossier examples) + empty seeds.json
scripts           prove · make-fixtures · sync-tydro-registry · audit-writes
```

## Routes
- `/`: the well. **Locked** (red banner, no canvas) until `verification/status.json` is proven; then it draws only ships you opened. Fixtures never appear in it.
- `/hull/:address`: the ship plate. It re-reads every 15 s, backs off on 429, and pauses while the tab is hidden. It has sections REGISTRY, HULL TEMP, POSE, LOCKER, BOOK, VECTOR and SHARE, plus an on-page **sensor log**, so a screenshot shows exactly what each sensor returned.
- `/calibration`: proof status + the six fixture books. `/fixture/carry|naked|equity-margin|wounded|dark|empty`: calibration plates.
- `/rules`: rules page. There is also a rules drawer in the header.
- `/census` and `/watch`: placeholders for Phase 2 and Phase 3.
