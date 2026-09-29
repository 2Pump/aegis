# WELL GLASS — how the well is drawn

A visual refit only. Nothing in pose, ink-io, the census job, prove, or the published snapshot changed. The well draws only fields already on a ship row.

## Reading it

| On the glass | Means |
|---|---|
| **Bearing** (angle) | The ship's **main pose**. Each pose owns a fixed sector. |
| **Radius** | **Risk**, the same hull-temp rings as before. |
| **Dot size** | **Size band** only: 5 radii, capped so $100k+ doesn't cover the glass. |
| **Red ring** | **WOUNDED**, on the ship in its own pose's slice. Never a fill, never a sector. |

The risk rings, from inside out:

| Ring label | Hull temp | Radius (fraction of the glass) |
|---|---|---|
| LIQ ZONE | CRITICAL | 0.12–0.30 |
| WARN | ELEVATED | 0.34–0.52 |
| NOMINAL | NOMINAL | 0.56–0.82 |
| (rim) | UNKNOWN | 0.86–0.96 |

The ring labels sit at 12 o'clock at full view. When you zoom, they ride their rings to stay on screen.

Nothing on the glass, its legend, or its tooltip carries a balance, a health factor or a liquidation price. The hull page keeps the exact numbers.

## Sectors

**Order:** CARRY → EQUITY-MARGIN → NAKED → KBTC-CORE → LEVERED → HOLD → LOCKED → STABLE-BALLAST → DARK · NO RULE.

**Widths:**
- Each sector gets 16° minimum, plus a √count share of the rest of the circle, with 2° gaps between sectors.
- The share comes from the live mix of 2026-09-29, **frozen** in `packages/glyphs/src/glass.ts` (`SECTOR_MIX_FROZEN`).
- The widths do not follow the live mix, which would reshuffle every seat. A retune needs owner approval and means a one-time, documented reseat.

**The last sector** holds DARK, EMPTY, "no rule fired", and WOUNDED-as-main-pose. Those ships are drawn neutral grey with the red ring, because red stays reserved for the ring.

## Seats

A ship's position inside its sector comes from its address:
- **Bearing** = sector start + span × (0.04 + 0.92 × hash(address)).
- **Radius** = a position inside its hull-temp ring, from a second hash.

The same address gets the same seat on every load, until the rules version or the sector table changes.

## Level of detail

**Full view** (zoom below 2.2×): pose-coloured haze, plus glyphs for:
- ≥$10k
- WOUNDED or CRITICAL ≥$1k, and ELEVATED ≥$1k
- a stable 1-in-16 sample, for texture
- the ship you found

**Phones** draw only ≥$10k glyphs over the haze.

**From 1.6× to 2.2×** the haze fades out and every ship fades in.

## Controls

- **Zoom:** wheel or pinch. At full view, scrolling down or scrolling over the bezel scrolls the page instead.
- **Pan:** drag, once zoomed.
- **Close in:** double-click.
- **Keys:** + / − / 0, and the arrow keys.
- **Find** frames the hull at 3.2×.
- **Filters:** changing a filter sends the camera home.
- **Tapping on a phone:** the first tap shows the ship's plate, the second opens it.

The HUD reads `AZ 214°  R 0.62  ZOOM 3.4×`, where AZ is the bearing and R the radius fraction under the pointer.

## Motion

- A 160 ms fade when the filter changes.
- One pulse (1.2 s) on a ship that changed live.
- A short highlight on new tape rows.

Nothing else moves. There's no idle pulsing, no rotation, and no lock-on.

## Performance

Profiled with 20,245 ships in the production build:

| Test | Result |
|---|---|
| Desktop gesture frames | 60 fps |
| Phone with 4× CPU throttle, gesture frames | p50 16.7 ms, p95 33 ms |
| Phone with 4× CPU throttle, sharp redraw once a gesture settles | ~120–190 ms |

How it holds that:
- **Glyph sprites:** glyphs are stamped from pre-rendered sprites, not stroked as paths.
- **Snapshot gestures:** during a gesture, the last sharp render moves with the camera; it redraws sharp ~140 ms after the gesture stops.
- **Cached seats:** seats are cached per address, so a new block only refreshes the "read N blocks ago" text, never the layout.

Plain 2D canvas holds this, so no WebGL is used.

## Legacy

`?well=legacy` shows the old well for one release so the two can be compared. The flag survives filter changes.
