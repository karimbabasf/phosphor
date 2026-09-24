---
name: Phosphor
description: A desktop wallet you run by talking to your agent, with the money always in view.
colors:
  phosphor-green: "#52e893"
  on-green: "#161210"
  gain: "#52e893"
  loss-red: "#ff6b5b"
  caution-amber: "#F5B942"
  agent-violet: "#B79CFF"
  charcoal-ground: "#161210"
  charcoal-slab: "#1e1917"
  charcoal-raised: "#292320"
  charcoal-key: "#342e2b"
  hairline: "#302a26"
  hairline-strong: "#3e3633"
  ember-light: "rgb(255, 232, 220)"
  ground-warmth: "#845d47"
  text-primary: "#f8f0e8"
  text-secondary: "#bcaea1"
  text-tertiary: "#9a8c7f"
typography:
  display:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "44px"
    fontWeight: 550
    lineHeight: 1.05
    letterSpacing: "-0.035em"
    fontFeature: "tnum, lnum"
  headline:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "28px"
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: "-0.025em"
  title:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: "-0.02em"
  title-sm:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 500
    letterSpacing: "-0.012em"
  prose:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.5
  body:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    letterSpacing: "0"
  meta:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.45
  address:
    fontFamily: "Geist Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "-0.01em"
    fontFeature: "tnum"
rounded:
  xs: "6px"
  sm: "10px"
  base: "14px"
  btn: "14px"
  tile: "18px"
  lg: "20px"
  card: "22px"
  xl: "24px"
  slab: "30px"
  pill: "999px"
spacing:
  s-1: "4px"
  s-2: "8px"
  s-3: "12px"
  s-4: "16px"
  s-5: "24px"
  s-6: "32px"
  s-7: "48px"
  s-8: "64px"
components:
  button:
    backgroundColor: "{colors.charcoal-key}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.btn}"
    padding: "0 16px"
    height: "36px"
  button-primary:
    backgroundColor: "{colors.phosphor-green}"
    textColor: "{colors.on-green}"
    rounded: "{rounded.btn}"
    padding: "0 16px"
    height: "36px"
  button-primary-hover:
    backgroundColor: "color-mix(in srgb, #52e893 88%, #FFFFFF)"
  button-ghost:
    backgroundColor: "{colors.charcoal-raised}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.btn}"
    padding: "0 16px"
    height: "36px"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.btn}"
    padding: "0 12px"
    height: "36px"
  button-danger:
    backgroundColor: "{colors.charcoal-key}"
    textColor: "{colors.loss-red}"
    rounded: "{rounded.btn}"
    padding: "0 16px"
    height: "36px"
  button-lg:
    padding: "0 24px"
    height: "44px"
    typography: "{typography.title-sm}"
  move-card:
    backgroundColor: "{colors.charcoal-raised}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.card}"
    padding: "12px 18px 18px 16px"
  move-card-approve:
    backgroundColor: "{colors.phosphor-green}"
    textColor: "{colors.on-green}"
    rounded: "{rounded.btn}"
    padding: "0 24px"
    height: "40px"
  coin-tile:
    backgroundColor: "{colors.charcoal-raised}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.tile}"
    padding: "12px 16px 12px 12px"
    height: "64px"
  balances-slab:
    backgroundColor: "{colors.charcoal-slab}"
    rounded: "{rounded.slab}"
    padding: "22px"
    width: "clamp(400px, 30vw, 480px)"
  composer:
    backgroundColor: "{colors.charcoal-raised}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.xl}"
    padding: "9px 9px 9px 20px"
    height: "58px"
  user-bubble:
    backgroundColor: "color-mix(in srgb, #292320, #342e2b 55%)"
    textColor: "{colors.text-primary}"
    rounded: "22px 22px 8px 22px"
    padding: "11px 18px 12px"
    typography: "{typography.prose}"
  mode-switch:
    backgroundColor: "color-mix(in srgb, #161210, #000 25%)"
    textColor: "{colors.text-secondary}"
    rounded: "16px"
    padding: "4px"
  mode-switch-active:
    backgroundColor: "{colors.charcoal-key}"
    textColor: "{colors.text-primary}"
    rounded: "12px"
  popover:
    backgroundColor: "{colors.charcoal-raised}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.xl}"
    padding: "18px"
  inset-well:
    backgroundColor: "{colors.charcoal-raised}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.base}"
    padding: "10px 12px"
---

# Design System: Phosphor

## Overview

**Creative North Star: "Soft Depth"**

Phosphor is a warm charcoal room where the conversation is the product and the money sits beside it, in view and touchable. Every surface is a soft layer resting on the ground: a gradient a shade lighter at its top, a thin line of warm light along its top edge, and a long soft shadow falling below it. Depth comes from lift and shadow, never from hairlines. Corners are large and forgiving. The window is dark only and paints its own palette; nothing is inherited from the OS.

Colour means state and nothing else. Phosphor green is the mark, the live move, success and Approve. Red is a real loss and the freeze confirm. Violet is what the agent drew. Coins carry their own brand colour as a wash on their tile and as their slice of the allocation ring, drawn with their real full colour logos. Everything else is warm neutral.

Motion is springy and physical: things open with a little give, buttons squish when pressed, the done check pops, ring slices spring to a new split, and a changed balance glows once and cools. Nothing ever covers the thread: no overlay sits on the conversation.

**Key Characteristics:**
- Warm charcoal ground with two soft pools of warmer light behind it, never blue-black.
- Raised surfaces built from gradient, top highlight and soft drop shadow; wells pressed into the ground.
- Large radii: 14 on buttons and inputs, 18 on coin tiles, 22 on cards, 24 on the composer and popovers, 30 on the balances slab.
- Geist for every word and every figure, with tabular lining numerals; Geist Mono only for addresses, hashes and ids.
- One green for the live move and Approve; one spring grammar for everything that opens, lands or is pressed.

## Colors

A warm, low-saturation charcoal family carrying a few saturated state colours that appear only when they mean something.

### Primary
- **Phosphor Green** (phosphor-green): the mark, the live move, the success check, the lit total and changed rows, and the Approve button. It never marks focus, decoration or a passive heading. Text on it is the ground colour (on-green).

### Secondary
- **Agent Violet** (agent-violet): what the assistant drew or did: chart levels and lines, the "Jump to latest" wash, the agent's own edges (at 28% as agent-edge).

### Tertiary
- **Loss Red** (loss-red): a real loss, a failed move, and the freeze confirm. Buttons carry it as text on a neutral key (button-danger), never as a red fill.
- **Caution Amber** (caution-amber): a warning that needs reading, never an error.
- **Gain** (gain): shares Phosphor Green's value for a figure that went up.

### Neutral
- **Charcoal Ground** (charcoal-ground): the window background, lit by two radial pools mixed from Ground Warmth (20% and 11%).
- **Charcoal Slab** (charcoal-slab): the balances panel and other large slabs.
- **Charcoal Raised** (charcoal-raised): cards, bubbles, the composer, popovers; also the ghost button.
- **Charcoal Key** (charcoal-key): a quiet button or control sitting on a raised surface; the active mode tab.
- **Ember Light** (ember-light): the warm light surfaces lift toward, used only at low strength (4 to 10%) for top highlights and hover washes.
- **Hairline / Hairline Strong** (hairline, hairline-strong): dividers inside dense tables and the edge of a disabled button. Not the way a surface is separated from the ground.
- **Text Primary / Secondary / Tertiary** (text-primary, text-secondary, text-tertiary): words, quiet words and 12px meta. Tertiary still reads at 4.7:1 on Charcoal Raised. Text Secondary is also the one focus ring colour.

### Named Rules
**The Colour Is State Rule.** A colour appears because something is live, done, lost, or drawn by the agent. If a use cannot name its state, it is neutral.

**The One Green Rule.** Green is the mark, the live move, success and Approve. A focus ring, a link, a tab or a heading is never green.

**The Brand Wash Rule.** A coin's own brand colour washes into its tile from the left (22% at the edge, gone by 62% of the width) and colours its ring slice. The figures always stand on the tile's own neutral ground.

## Typography

**Display Font:** Geist (vendored variable woff2, with ui-sans-serif, system-ui fallback)
**Body Font:** Geist
**Label/Mono Font:** Geist Mono, for addresses, hashes, ids, code and commands only

**Character:** One sans for words and numbers alike, so a figure sits on its sentence's own baseline at its x-height. Tracking tightens as size grows; weights stay moderate.

### Hierarchy
- **Display** (550, 44px, 1.05, tracking -0.035em): the one balance figure, the largest thing on screen. Inside the ring the total is 31px at the same weight and scales down to fit the disc.
- **Headline** (500, 28px, 1.2): rare screen headings.
- **Title** (500, 20px, 1.3) and **Title Small** (500, 16px): panel, card and popover titles, as short noun phrases.
- **Prose** (400, 15px, 1.5, max 68ch): the transcript and the move line on a card.
- **Body** (400, 14px, 1.55): card lines, button labels (at 550).
- **Label** (500, 12px, sentence case, no tracking): field labels such as "You pay".
- **Meta** (400, 12px, 1.45, Text Secondary): timestamps, footnotes, the foot line under the tiles.
- **Address** (Geist Mono 400, 13px, -0.01em): addresses and hashes, allowed to break anywhere.

Sizes step up about 12% and spacing about 10% at windows of 2000px and wider, through the same tokens.

### Named Rules
**The Same Line Rule.** Every figure (a sum, a price, an amount, a time) is Geist with tabular lining numerals. Geist Mono is only for text read one character at a time.

**The Never 700 Rule.** Weights are 400 for body, 500 for labels and rows, 550 to 600 for titles, buttons and the balance. Never 700.

**The Sentence Case Rule.** Labels, tabs and buttons are sentence case. No uppercase, no tracked-out small caps.

## Layout

A 64px top bar holds the mark and "Phosphor" on the left, the Basic, Pro, Trade, Vault switch centred, and one quiet freeze control on the right. On Basic the conversation takes the window and the balances slab holds a reading width on the right (clamp 400 to 480px). The text column caps at 760px with the composer pinned at its foot. Pro, Trade and Vault give the conversation 30vw between 360px and 760px and the world the rest, never under 560px, up to 1680px wide.

Spacing is a four-based rhythm (4, 8, 12, 16, 24, 32, 48, 64). Coin tiles stack with 8px between them and 12px between groups; the slab pads 22px. Nothing is a fixed pixel width that cannot flex with the window. Views change by cross-fading, and the track between Basic and the other modes slides rather than snaps.

## Elevation & Depth

A layered system. Surfaces rise from the ground by a lighter top in their gradient, an inset line of Ember Light along the top edge, and a soft shadow that falls well below. Wells (the mode switch, an address line, a code block, a quote) are pressed in instead: a darker fill and a shade at their top. Things that float over the rest (popovers, the freeze panel, menus, toasts) take a longer lift shadow.

### Shadow Vocabulary
- **Top highlight** (`inset 0 1px 0 rgba(255,232,220,0.07)`): every tile and bubble; the minimum a surface carries.
- **Raise small** (`inset 0 1px 0 rgba(255,232,220,0.07), 0 1px 2px rgba(0,0,0,0.3), 0 6px 14px -8px rgba(0,0,0,0.55)`): small raised controls such as the freeze button and panels.
- **Raise** (`inset 0 1px 0 rgba(255,232,220,0.06), 0 1px 2px rgba(0,0,0,0.35), 0 14px 34px -14px rgba(0,0,0,0.65)`): move cards and the composer.
- **Slab** (`inset 0 1px 0 rgba(255,232,220,0.05), 0 30px 60px -30px rgba(0,0,0,0.7)`): the balances slab.
- **Well** (`inset 0 1px 3px rgba(0,0,0,0.55), 0 1px 0 rgba(255,232,220,0.04)`): the mode switch track.
- **Lift** (`inset 0 1px 0 rgba(255,232,220,0.08), 0 28px 64px -20px rgba(0,0,0,0.85), 0 0 0 1px rgba(0,0,0,0.25)`): popovers, confirms, screen cards.
- **Change glow** (`0 0 0 1.5px green at 55%, 0 14px 30px -14px green at 50%`): a coin tile whose balance just changed, in over 120ms and out over 2400ms. Only as a response to a real change.

### Named Rules
**The Lift Not Line Rule.** A surface separates from the ground by gradient, highlight and shadow. A 1px border is never the thing that makes a card a card.

**The Nothing Covers The Thread Rule.** Only small floating things (popovers, menus, confirms, toasts) take Lift, and none of them sits over the conversation.

## Shapes

Large, soft corners scaled to the object: 6px for micro controls and inline code, 10px for small controls, 14px for buttons, inputs, wells and list rows, 18px for coin tiles, 20px for panels, 22px for cards, 24px for the composer and popovers, 30px for the balances slab, full pills for the fallback coin disc. The user's own message is a bubble rounded 22px on three corners and 8px at its lower right, where it points to its sender. Coin logos are their brands' real full colour marks in a 40px box, with nothing behind them; the move card's leading glyph sits on a round Charcoal Key disc.

## Components

### Buttons
Soft keys that squish when pressed.
- **Shape:** 14px radius, 36px tall (30px small, 44px large), 550 weight, sentence case.
- **Primary:** Phosphor Green fill, ground coloured label at 600, lit from inside by a bright top edge and a shade at its foot. Used for Approve and the single main action of a screen.
- **Hover:** the fill steps toward white (primary) or toward Ember Light (others), never toward the ground.
- **Press:** scales to 0.97 in 160ms and springs back over 480ms on the spring curve, with the fill one shade deeper.
- **Ghost, Quiet, Danger:** ghost is Charcoal Raised; quiet has no fill and Text Secondary, drawing its fill only on hover; danger is a neutral key with a red label.
- **Disabled:** no fill, a Hairline Strong inset edge, Text Tertiary label, never half opacity. A pending button keeps full weight and width and shows a spinner with its progress verb.
- **Live ask:** a primary that is waiting for the user breathes slowly (2600ms), its fill brightening and a soft green ring swelling around it.

### Move Card (signature)
The card the agent puts in the thread for every move. Raised surface, 22px radius, Raise shadow. Its head (56px) carries the coin logos, the move in prose weight 500 ("4 USDC to 0.00149 ETH"), and its state on the right in 13px (a clock and green "Needs your OK", or a green check and "Done · 6s"). When it needs a click, the body shows label over figure facts, a Details disclosure, and Cancel beside Approve (40px tall, Approve padded 24px). It changes in place from working to done: the check pops on the spring, the ring answers, and the touched coin tiles glow once.

### Balances Slab and Allocation Ring
The right panel on the Slab surface at a 30px radius. A 244px ring with 14px round capped slices, one per coin in its brand colour, around a raised disc holding the total and "in your balance". Slices spring to a new split over 1000ms. Below, the coin tiles, a foot line for tiny balances, and a full width large "Add money" button.

### Coin Tile
A 64px tile, 18px radius, Top highlight only, washed from the left in the coin's brand colour. Logo, symbol and amount stacked on the left; dollars right aligned. On a change it lifts 3px, its figures warm toward green, and the Change glow fades in and out.

### Composer
A raised field, 24px radius, 58px tall, Raise shadow, pinned at the foot of the conversation, with a round send key at its right.

### Mode Switch
A pressed well (16px radius, 4px inset) holding four 12px radius tabs at 550 weight; the active tab is a small raised key that slides between positions on the soft spring.

### Wells
Address lines, code blocks, quotes and connection blocks sit in a 14px well on the tile colour with an inner shade at their top.

## Do's and Don'ts

### Do:
- **Do** build every new surface from the layer tokens: raised gradient, top highlight, soft falling shadow.
- **Do** put Approve on the move card that needs it and nowhere else.
- **Do** set every figure in Geist with tabular lining numerals, and keep Geist Mono for addresses and ids.
- **Do** open popovers, panels and dialogs from 0.96 scale with a fade over 220ms and a spring over 600ms, and close them evenly over 200ms on the exit curve.
- **Do** give every pressable a press state that reads on a still frame: a 0.97 squish, a 12% text wash, or both.
- **Do** turn all motion off under prefers-reduced-motion; the change lands at once.
- **Do** draw coins and agents with their real brand logos in full colour.

### Don't:
- **Don't** use a blue-black or pure black ground; the charcoal is warm.
- **Don't** separate surfaces with hairline borders.
- **Don't** use green for focus, links, tabs or decoration, or red for anything but a loss or the freeze confirm.
- **Don't** use weight 700, uppercase labels or tracked-out captions.
- **Don't** set figures in running text in the mono face.
- **Don't** put an overlay or sheet over the conversation.
- **Don't** replace brand logos with tinted discs or initials, except as the fallback when a logo is missing.
