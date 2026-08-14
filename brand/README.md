# Phosphor brand

The official Phosphor wordmark, and the script that draws it.

- `phosphor-wordmark.png` (3949 x 1088), the logo.
- `phosphor-headquarters.png` (3949 x 1347), the same mark with a "headquarters" line under it, for print.

Both are black `#000` on white `#fff`. The app runs green on near-black; these are the inverted
mark, for light and print contexts.

## What the mark is

Set in Expose (Fontshare, ITF Free Font License, variable weight 400 to 900) at weight 600, all
caps, 0.055em tracking. Three things are drawn on top of the glyphs:

- A slash through the zero and through the O. Expose has no slashed-zero glyph, so both are drawn.
  Both run at the ZERO's angle, not each letter's own diagonal: the O is wider, so its own diagonal
  would sit at a different angle and the two would read as an accident instead of a system.
- Seven gaps at the joins: the bowl of each P and of the R, and the crossbar of each H on both
  sides. Each gap sits flush against the stem, so the stem stays whole and the bar it carries
  starts a little way off it.
- The "headquarters" line is Menlo, lowercase, 0.45em tracking.

Nothing is hand-placed. The script renders the word once, reads the pixels to find each letter's
ink box, its stems and its bars, then puts the slashes and the gaps on what it finds. Change the
size or the weight and the geometry follows.

## Run it

Needs a local Brave and `playwright-core`. Both come from the machine, not from this repo:
`BROWSER` and `PW` below default to the paths this was built with.

    node build.mjs mark.html ../phosphor-wordmark.png
    node build.mjs hq.html ../phosphor-headquarters.png

`build.mjs` writes the PNG and prints the geometry it measured.

## Test it

There is no test suite. Check it by eye against these numbers, which `build.mjs` prints:

    wordmark    W 3949  H 1088  stroke 91  gap 31  cuts 7  slashAngle 56
    headquarters  W 3949  H 1347  cap 499  px 67

A changed `stroke` or `slashAngle` means the font failed to load and a fallback face was used.
