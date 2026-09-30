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
| Checks | calibration | Whether readings were matched against the official apps. |
| Test wallet | fixture | A made-up example account. |
| Alerts | watch | Planned alerts; not built. |
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
