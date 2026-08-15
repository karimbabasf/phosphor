# Phosphor brand

The official Phosphor wordmark, and the script that draws it.

- `phosphor-wordmark.png` (3949 x 1088), the logo, black `#000` on white `#fff`.
- `phosphor-wordmark-dark.png` (3949 x 1088), the same geometry in the app's own colours,
  phosphor green `#33ff66` on near-black `#0b0d0b`. The README serves this one to readers on a
  dark theme.
- `phosphor-headquarters.png` (3508 x 2480), the black mark with a "headquarters" line under it,
  laid out on A4 landscape at 300 dpi. Prints at 297 x 210 mm with a 24 mm side margin.

The black-on-white pair is the inverted mark, for light and print contexts. Colour is the only
thing that separates the two wordmarks: both come off the same page, so the geometry cannot drift
between them.

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
    node build.mjs mark.html ../phosphor-wordmark-dark.png --fg '#33ff66' --bg '#0b0d0b'
    node build.mjs hq.html ../phosphor-headquarters.png

`build.mjs` writes the PNG and prints the geometry it measured. `--fg` and `--bg` reach the page
on the query string and default to black on white.

## Test it

There is no test suite. Check it by eye against these numbers, which `build.mjs` prints:

    wordmark      W 3949  H 1088  stroke 91  gap 31  cuts 7  slashAngle 56
    dark          W 3949  H 1088  stroke 91  gap 31  cuts 7  slashAngle 56
    headquarters  page 3508x2480  markSize 614  cap 437  subPx 166  marginSide 281

A changed `stroke` or `slashAngle` means the font failed to load and a fallback face was used.
