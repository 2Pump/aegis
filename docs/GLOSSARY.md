# Glossary — what the site says, and what the code calls it

The site uses plain words. The code, `census.json`, share links and the rules keep their original names so nothing underneath changed. One source for every on-screen name: `packages/glyphs/src/labels.ts`. Approved by the project owner on 2026-09-29.

## Things

| On screen | In code / docs | What it is |
|---|---|---|
| Wallet | ship, hull, address | One Ink address that has used Tydro or Nado. |
| Position type | pose, primary pose, tag | What the wallet is doing, decided by the public rules. |
| Risk | hull temp (`hullTemp`) | How close the wallet is to liquidation. |
| Wallet size | band | Rough size, never the exact balance. |
| The well | well | The picture of every wallet (sphere, 2D, list). |
| Scan | census | The hourly job that finds and reads every wallet. |
| Hourly update / full re-read | incremental / full sweep | The two kinds of scan. |
| Live updates | live layer (`LiveEngine`) | Your browser watching new blocks between scans. |
| Near liquidation (list) | wounded tape | Wallets near liquidation, newest first. Not a hit list. |
| Pressure Map | pressure map (`pressure.json`, `scenario.ts`) | Counts of wallets that would move toward liquidation if prices moved. A simulation, not a prediction. |
| Ink stress level | `stressLevel()` (`stress-1.0.0`) | CALM / ELEVATED / HIGH / CRITICAL from three published shares of wallets ≥ $1,000 with debt or perps. |
| Stress test | `StressTest` | A wallet page's own scenarios: the moves that take it to Watch, Near liquidation, Liquidatable. |
| Checks | calibration | Whether readings were matched against the official apps. |
| Test wallet | fixture | A made-up example account. |
| Intel | intel | History (Flight Recorder) now; Liquidations, Oracles, Changes and Carry are later releases, labelled NOT BUILT. |
| Flight Recorder | — | What the hourly scan recorded over time: risk, type and size range per wallet, counts for all of Ink. Balance-free. docs/HISTORY.md |
| Liquidation ledger | intel?tab=liquidations | Every actual Tydro and Nado liquidation on Ink, from on-chain events, with what AEGIS had recorded before it. docs/LEDGER.md |
| Cascade | — | 3+ liquidations each within 30 min of the one before (cascade-1.0.0). Grouped by timing, not by cause. |
| Track record | calibration | AEGIS's NEAR warnings scored against real liquidations, always as n of N. |
| Alerts | watch | Telegram alerts: built and tested, not live yet (docs/ALERTS.md). |
| Data log | sensor log | On-page diagnostics. |
| Couldn't read | DARK | A data source failed; the last good reading is kept. |

## Position types

| On screen | Rule tag |
|---|---|
| Hedged | CARRY |
| Unhedged bet | NAKED |
| High leverage | LEVERED |
| Stocks as collateral | EQUITY-MARGIN |
| Bitcoin-backed | KBTC-CORE |
| Mostly stablecoins | STABLE-BALLAST |
| Lending only | LOCKED |
| Just holding | HOLD |
| Near liquidation | WOUNDED |
| Couldn't read | DARK |
| Empty | EMPTY |
| Unclassified | (no rule fired) |

Meanings: RULES.md section 6.

## Risk

| On screen | Code |
|---|---|
| Safe | NOMINAL |
| Watch | ELEVATED |
| Near liquidation | CRITICAL |
| Couldn't read | UNKNOWN |

## Sizes

under $10 (dust) · under $1k (<1k) · $1k–10k · $10k–100k · $100k+

## Sphere HUD

| On screen | Code |
|---|---|
| VIEW FAR / OVERVIEW / CLOSE-UP / WALLET | LOD HAZE / MANTLE / TISSUE / NODE |
| CENTRED ON SPHERE / WALLET / POINT | pivot CORE / HULL / POINT |
| DEPTH | r (distance from centre) |

## Hull page panels

Wallet (was Registry) · Risk (Hull temp) · Position type — why (Pose — why) · Tydro lending (Locker · Tydro) · Nado account (Book · Nado) · Exposure (Vector) · Share · Data log (Sensor log). Each reason line shows the plain name, then the rule tag, then the rule's own audit text unchanged.
