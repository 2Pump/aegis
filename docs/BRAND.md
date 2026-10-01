# BRAND — the AEGIS mark

Chosen by the project owner on 2026-09-30.

## The mark

A camera aperture: an outer ring, a hexagonal opening and six blade edges. It stands for "AEGIS is a camera": read-only, it watches and never touches. It deliberately isn't a target or crosshair; the site lists wallets near liquidation and is "not a hit list".

- **One colour:** the mark always uses the current text colour, so it follows whatever palette the site ends up with (see COLOURS.md).
- **Under the wordmark:** `TYDRO · NADO · INK 57073` replaced "THE WELL MAP". "The Well" stays as the name of the main view (sphere / 2D / list).
- **Tab title:** `AEGIS · Tydro · Nado · Ink`.

## Where it lives

| Use | File |
|---|---|
| Site header, error page | `apps/web/src/components/Mark.tsx` (`<Mark size={28} />`) |
| Browser tab | `apps/web/public/favicon.svg` (modern browsers) and `favicon.ico` (16/32/48, for older ones) |
| Phone home screen | `apple-touch-icon.png` (180), `icon-192.png`, `icon-512.png`, `site.webmanifest` |
| Link previews (X, Telegram, Discord…) | `og.png` (1200×630); its address is in the `og:image` / `twitter:image` tags in `apps/web/index.html` |

## Small-size rule

At 16 px the full mark turns to mush. So the tab icon is a dark disc with thicker strokes (3 instead of 2) and a slightly smaller opening. The bigger icons (180 / 512) use the full mark on a rounded dark tile.

## Regenerating

`docs/brand/gen-icons.py` writes the SVGs, and `docs/brand/og.html` is the share card. The PNGs were rendered with headless Chromium, and the .ico was built with ImageMagick (`convert favicon-16.png favicon-32.png favicon-48.png favicon.ico`). Regenerate them all if the colours change: the tile is `#05080C`, the ink `#CFD9E3`.

**If the site moves to its own domain,** update the two absolute `og.png` addresses in `index.html`. Link previews need a full URL.
