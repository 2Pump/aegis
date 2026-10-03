# The well — HULL SPHERE (default) and WELL GLASS (2D)

The well has three views, chosen with the SPHERE / 2D / LIST switch or `?view=sphere|2d|list`:
- **HULL SPHERE** (default, since 2026-09-29): a 3D glass world, described in the next section.
- **WELL GLASS** (2D): the polar plot described after it. It's also what `?well=legacy` shows for one release, and what browsers without WebGL get.
- **LIST:** the accessible wallet list, opened.

Filters, Find, share links and the hull pages work the same in all three.


## Words on screen

Since 2026-09-29 everything a visitor reads uses plain names from `packages/glyphs/src/labels.ts`: position types (Hedged, Unhedged bet, …, see RULES.md section 6), risk (Safe / Watch / Near liquidation / Couldn't read) and size ($1k–10k …). The engine names below (pose, hull temp, HAZE/MANTLE/TISSUE/NODE, CORE/HULL pivot) are code names; on screen they read as position type, risk, VIEW FAR/OVERVIEW/CLOSE-UP/WALLET and CENTRED ON SPHERE/WALLET/POINT. The sphere HUD says DEPTH instead of R.

## HULL SPHERE

A skin and a renderer only: pose, ink-io, the census job and census.json are unchanged. It draws only fields already on a wallet row, with no balances, HF or liquidation prices.

| Axis | Comes from |
|---|---|
| **Longitude (lune)** | Main pose, using the same frozen sector table and address hash as the 2D plot, so a wallet's bearing is **identical** in both views. |
| **Depth (radius)** | Hull temp, using the same rings as 2D: LIQ 0.12–0.30 · WARN 0.34–0.52 · NOMINAL 0.56–0.82 · dark sensors 0.86–0.96. |
| **Latitude** | A third hash of the address, spread evenly over the surface. The top and bottom ~26° stay empty so the lunes don't crush together at the poles. |

**What's on the glass:**
- **Shells:** nested glass shells at 0.84 / 0.54 / 0.32, labelled SAFE / WATCH / NEAR LIQUIDATION at their visual top. The NEAR LIQUIDATION shell is dark ruby, and the core is a dim recessed nucleus.
- **Lunes:** meridian lines at the lune edges, pose-coloured brackets on the equator, and lune names on the equator that fade on the far side (and near the edges on phones).
- **Threads:** decoration only (`buildThreads` in `packages/glyphs/src/sphere.ts`).
  - Same main pose only, and only among wallets currently drawn.
  - Up to 3 per wallet, within a short distance.
  - Built in address-hash order, never risk order.
  - Caps: 3,500 at full orbit (2,000 on phones), 4,000 in the zoomed region.

**Level of detail**, set by zoom (default distance ÷ current distance):

| LOD | When | Drawn |
|---|---|---|
| HAZE | zoom < 0.85 | haze + the orbit glyph set |
| MANTLE | the default | haze + glyphs for ≥$10k, wounded/critical ≥$1k, elevated ≥$1k and a 1-in-16 sample (phones: ≥$10k and wounded ≥$1k only), faint threads, hairline wounded rings |
| TISSUE | zoom ≥ 1.8 | every wallet fades in (1.5×–2.1×); wallets near the camera fade so you see through the mantle; short threads around where you're looking, rebuilt when the camera settles |
| NODE | a wallet is framed by Find, double-click or F | the neighbourhood dims; a cyan hairline bracket and a plate (short address, pose chips, risk, band, **Open wallet**) |

**Framing stays until you end it:**
- It survives orbiting, panning and live updates; the hull is kept by address, not by list position.
- It ends when you zoom back out (camera more than ~3× its framing distance), press 0 or Esc, or hit Clear.
- F re-frames the found hull.

**The pivot:**
- While a wallet is framed, the camera orbits **around that hull** (`PIVOT HULL` in the HUD), with gentler rotate, zoom and pan for fine control.
- When the framing ends, the pivot slides back to the core (`PIVOT CORE`), and the camera moves with it so the sphere re-centres without the view swinging. Scrolling or dragging cannot stop it halfway (the first version could). Orbit and zoom then turn about exactly the same axis as before the search.
- Right-drag panning moves the pivot off-centre (`PIVOT POINT`); 0 resets it.

**Hover and tap:** they pick the wallet whose drawn glyph is under the pointer, nearest the camera first, so never a wallet hidden behind it. The framed wallet always wins where it's drawn.

Glyphs shrink as you close in, so they stay beads.

**Camera:**
- **Default view:** 18° tilt, sphere at ~70% of the view (86% on phones).
- **Mouse:** drag orbits (damped; it can't tip over the poles), the wheel zooms, right-drag pans. Double-click frames a hull.
- **Keys:** ← → orbit, + − zoom, 0 or Esc resets, F frames.
- **Phone:** one finger orbits; pinch only zooms (no pan since 2026-10-01). A pinch always drifts a little, and with pan on that drift slid the pivot off the centre, so the sphere turned around some other point. The pivot is always the centre, or the framed wallet.
- **Site updated while a tab was open:** the first lazy load (the sphere) fails because the old build's files are gone. The page reloads once by itself (guarded, never a loop) and gets the new build; otherwise it shows a plain error panel with Reload, never the router's developer page.
- **Find** eases to the hull with no overshoot, and changing a filter sends the camera home.
- **Scrolling:** while the pointer is over the well, the wheel only zooms the well; the page never scrolls (even fully zoomed out). Scroll the page from outside the well.
- **Nothing moves on its own:** no auto-spin.

**Motion:**
- Near-liquidation rings stay still. Since 2026-10-03, no single wallet pulses on its own.
- **The nucleus breathes.** The recessed nucleus and the inner NEAR LIQUIDATION shell breathe together on a 4 s eased cycle. Their opacity runs from 0.82× to 1.12× and their scale moves ±1.2%, with no flash.
- **One falling ring at a time.** Every second breath, a thin dim ring (opacity at most 0.2) is born at the inner shell. It falls to the nucleus over 3.2 s and fades as it goes. It always faces the camera and is centred on the core, never aimed at a wallet. The shell label stays NEAR LIQUIDATION. There are no new words and no crosshair.
- Frame rate: about 30 fps on desktop and 20 fps on phones.
- Phones always breathe, but the falling ring only runs while frames keep up. It switches off when the frame rate drops under about 42 fps and back on above about 52 fps.
- One 200 ms ember when a wallet changes live.
- Camera eases.
- A 160 ms fade on filter change.
- With reduced motion switched on in the OS: no breath, no falling ring, no ember, no easing.

**Performance:**
- **Draw calls:** about 24 whatever the fleet size (measured with 18,555 wallets). One Points haze, instanced nodes (icosahedra; octahedra on phones), coronas as Points, threads as LineSegments.
- **Pixel density cap:** 1.5 on desktop, 2 on phones.
- **Rendering on demand:** only when the camera moves or the capped nucleus breath ticks, and paused when the tab is hidden (the nucleus then holds still).
- **Phones (since 2026-10-01):**
  - Pixel density is 1.5× at rest and drops to 1× while the camera moves. It sharpens again about a quarter-second after the camera stops.
  - The glass shells use fewer segments.
  - The HUD text updates about 6 times a second while moving instead of every frame; its final value always lands at rest.
- **Points never balloon:** haze dots are capped at 5 px on phones and 9 px on desktop, and the near-liquidation rings at 34 px and 56 px. Before the cap, zooming into the crowded core made thousands of big overlapping see-through points, which is a phone GPU's worst case. On phones the haze switches off once every wallet is drawn as a glyph.
- **The page doesn't re-walk every wallet once a second:**
  - The clocks live inside the two strips that show times.
  - The wallet list only changes when the live layer changes what you see (the engine's `shipsVersion`), not on every re-read.
  - The "read N ago" line is worked out when a tooltip or row draws.
  - Measured on a phone-speed CPU, idle script time went from 1.2 s to 0.2 s per 10 s.
- **Live data never lands mid-gesture.** A live update (25 or fewer wallets changed) waits until the camera rests, because each one rebuilds the GPU buffers. On phones it also waits at least 8 s after the previous one. A filter change lands at once. Hover, plate, Find and the ember all index the world that is actually drawn.
- **Loading:** three.js and the engine load only when the sphere opens, as a ~136 KB (compressed) chunk; the main bundle is unchanged.
- **Checking it:** `?fps=1` shows frames drawn per second and draw calls on the page. Targets are 60 fps with a floor of 40 on a mid laptop at default orbit, and 30+ on a phone. If a device misses them, drop threads first, then pixel density, then the glyph sample; never the sphere.

**Code:** seats, LOD and threads in `packages/glyphs/src/sphere.ts` (tested); the engine in `apps/web/src/components/sphere/engine.ts`; the view in `HullSphere.tsx`.

---

# WELL GLASS — the 2D polar plot

A visual refit only. Nothing in pose, ink-io, the census job, prove, or the published snapshot changed. The well draws only fields already on a wallet row.

## Reading it

| On the glass | Means |
|---|---|
| **Bearing** (angle) | The wallet's **main pose**. Each pose owns a fixed sector. |
| **Radius** | **Risk**, the same hull-temp rings as before. |
| **Dot size** | **Size band** only: 5 radii, capped so $100k+ doesn't cover the glass. |
| **Red ring** | **WOUNDED**, on the wallet in its own pose's slice. Never a fill, never a sector. |

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

**The last sector** holds DARK, EMPTY, "no rule fired", and WOUNDED-as-main-pose. Those wallets are drawn neutral grey with the red ring, because red stays reserved for the ring.

## Seats

A wallet's position inside its sector comes from its address:
- **Bearing** = sector start + span × (0.04 + 0.92 × hash(address)).
- **Radius** = a position inside its hull-temp ring, from a second hash.

The same address gets the same seat on every load, until the rules version or the sector table changes.

## Level of detail

**Full view** (zoom below 2.2×): pose-coloured haze, plus glyphs for:
- ≥$10k
- WOUNDED or CRITICAL ≥$1k, and ELEVATED ≥$1k
- a stable 1-in-16 sample, for texture
- the wallet you found

**Phones** draw only ≥$10k glyphs over the haze.

**From 1.6× to 2.2×** the haze fades out and every wallet fades in.

## Controls

- **Zoom:** wheel or pinch. While the pointer is over the well the page never scrolls; over the bezel the wheel does nothing.
- **Pan:** drag, once zoomed.
- **Close in:** double-click.
- **Keys:** + / − / 0, and the arrow keys.
- **Find** frames the hull at 3.2×.
- **Filters:** changing a filter sends the camera home.
- **Tapping on a phone:** the first tap shows the wallet's plate, the second opens it.

The HUD reads `AZ 214°  R 0.62  ZOOM 3.4×`, where AZ is the bearing and R the radius fraction under the pointer.

## Motion

- A 160 ms fade when the filter changes.
- One pulse (1.2 s) on a wallet that changed live.
- A short highlight on new tape rows.

Nothing else moves. There's no idle pulsing, no rotation, and no lock-on.

## Performance

Profiled with 20,245 wallets in the production build:

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

`?well=legacy` now shows WELL GLASS (this 2D plot) for one release, so the sphere can be compared with it. The flag survives filter changes. The older donut well was retired on 2026-09-29.

---

# WALLET PLATE — the hero of a wallet page (2026-10-02)

The top of `/hull/:address` is a state plate, read like a lab spectral plate (`apps/web/src/components/WalletPlate.tsx`). It replaced the sigil + chip row only; 01 Wallet → 07 Share, the data log, Re-read and Set as my wallet are unchanged, and the address, lamps, Re-read and My wallet sit in the plate's top row.

- **Left:** the wallet's own sigil, coloured by its main type (never red, even when near liquidation).
- **Centre: energy levels.** One line per type that fired on this wallet. The main type is the occupied line (bright, labelled, a breathing dot on it); extra types are faint lines with no dot; types that did not fire are not drawn. Each type always sits at the same height (its rule priority, near liquidation last), so two plates compare at a glance.
- **Right: the risk rail.** NEAR LIQUIDATION at the top, WATCH in the middle, SAFE at the bottom, COULDN'T READ as a hollow mark off the rail. The dot's height is this wallet's risk. Red appears only when the wallet is near liquidation: that rail label and the dot.
- **Empty wallet:** the plate says EMPTY, no levels, the dot at SAFE. **Couldn't read:** the plate says COULDN'T READ, no made-up levels, the hollow mark lit (a near-liquidation reading from the venue that did read still puts the dot at the top).
- It reads the pose the page already has (no reclassification), adds nothing to census.json, and shows no balances, health factor or liquidation price. Those stay in 02, 04 and 05.
- Desktop: full width, ~288 px tall. Phone: sigil on top, levels under it, the rail to their right. Reduced motion: the dot doesn't breathe.
- Browser test: "wallet plate: one line per type that fired…".
