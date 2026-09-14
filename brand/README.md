# Phosphor brand

The official Phosphor mark, its three colourways, the banners, the app icon, the wordmark, and
the script that draws the wordmark.

## The mark

An isometric P built from four slabs, drawn once as a vector and shipped in three colourways.
The colours are the whole identity. The app carries two of them (`ui/design/tokens.css`): green
on black and black on white. Black on green is for banners and social only, never the window
(cut from it on 2026-09-14).

| Colourway | Ground | Ink | File |
|---|---|---|---|
| Green on black | `#0E0F13` | `#3FFF6C` | `phosphor-logo-green-on-black.png` (2000 x 2000) |
| Black on green | `#3FFF6C` | `#0E0F13` | `phosphor-logo-black-on-green.png` (2000 x 2000) |
| Black on white | `#FFFFFF` | `#111111` | `phosphor-logo-black-on-white.png` (2000 x 2000) |

- `phosphor-mark.svg`, the vector, one path in `currentColor` in a box the size of its own ink
  (58.05 x 64.75 units). Traced from the black on white PNG with potrace; 0.6 percent of edge
  pixels differ from the source at 2000 px. This is the copy the app draws: `ui/index.html`
  holds it as a `<symbol>`, the splash (`src-tauri/frontend/index.html`) holds it inline.
- `phosphor-app-icon.png` (1024 x 1024), the macOS app icon source: the green on black logo on
  an 824 px rounded square (radius 185) centred on a transparent canvas. `npx tauri icon
  brand/phosphor-app-icon.png -o src-tauri/icons` regenerates the icon set from it; delete the
  `android` and `ios` folders it also writes.
- `phosphor-banner-twitter.png` (3000 x 1000) and `phosphor-banner-linkedin.png` (3168 x 792),
  the mark and the name on black. The `-wordmark` pair is the name alone.

The app switches between its two colourways from the menu under the mark in its top left,
and an agent can do the same with `set_theme { profile }`. Each colourway is a whole palette
(text, warning amber and the gate's red change with the ground), and every one is checked
against the contrast floors in `tests/unit/theme-slots.test.ts`.

## The wordmark

- `phosphor-wordmark.png` (3949 x 1088), the logo.
- `phosphor-headquarters.png` (3508 x 2480), the same mark with a "headquarters" line under it,
  laid out on A4 landscape at 300 dpi. Prints at 297 x 210 mm with a 24 mm side margin.
- `phosphor-wordmark-white-outline.png` (3949 x 1088), white `#fff` letters with a black `#000`
  outline and no background, for laying the mark over a photo or a colour.

The first two are black `#000` on white `#fff`. The app runs green on near-black; these are the
inverted mark, for light and print contexts.

## What the mark is

Set in Expose (Fontshare, ITF Free Font License, variable weight 400 to 900) at weight 600, all
caps, 0.055em tracking. Three things are drawn on top of the glyphs:

- A slash through the zero and through the O. Expose has no slashed-zero glyph, so both are drawn.
  Both run at the ZERO's angle, not each letter's own diagonal: the O is wider, so its own diagonal
  would sit at a different angle and the two would read as an accident instead of a system.
- Seven gaps at the joins: the bowl of each P and of the R, and the crossbar of each H on both
  sides. Each gap sits flush against the stem, so the stem stays whole and the bar it carries
  starts a little way off it.
- The "headquarters" line is Menlo, lowercase, 0.42em tracking, set at 0.38 of the wordmark's cap
  height. On the sheet the mark's ink spans 84 percent of the width, and the two of them are
  placed as one block, slightly above centre so it does not look like it is sinking.

Nothing is hand-placed. The script renders the word once, reads the pixels to find each letter's
ink box, its stems and its bars, then puts the slashes and the gaps on what it finds. Change the
size or the weight and the geometry follows.

## Run it

Needs a local Brave and `playwright-core`. Both come from the machine, not from this repo:
`BROWSER` and `PW` below default to the paths this was built with.

    node build.mjs mark.html ../phosphor-wordmark.png
    node build.mjs hq.html ../phosphor-headquarters.png
    node build.mjs mark-outline.html ../phosphor-wordmark-white-outline.png

`build.mjs` writes the PNG and prints the geometry it measured.

## Test it

There is no test suite. Check it by eye against these numbers, which `build.mjs` prints:

    wordmark      W 3949  H 1088  stroke 91  gap 31  cuts 7  slashAngle 56
    headquarters  page 3508x2480  markSize 614  cap 437  subPx 166  marginSide 281
    outline       same as wordmark, plus outlineW 12

A changed `stroke` or `slashAngle` means the font failed to load and a fallback face was used.

## The outline

`outline` is a width in stroke widths, and `draw.js` grows the finished shape by that much, so the
line follows the slashes and the cut joins rather than the plain glyph. It has a ceiling of half a
gap minus a pixel: any wider and the outline meets itself across a join and closes the gap that the
join is there to make. At the sizes above that ceiling is 14 px, and `outline: 0.13` asks for 12.
`build.mjs` prints the `outlineW` it actually used, so a silent clamp shows up in the numbers.
