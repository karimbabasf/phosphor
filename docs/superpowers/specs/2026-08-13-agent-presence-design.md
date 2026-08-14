# Agent presence: the window shows what the agent is doing while it does it

Date: 2026-08-13
Surfaces: `/trade` and `/` (pro). Basic view is out of scope and must not change.

> **STATUS: BUILT, THEN REMOVED THE SAME DAY (`f572972`).** Karim saw it and wanted none of it:
> the MECHANISM panel, the `{type:'agent'}` SSE channel, the panel arming and the brightness hold
> are all gone, removed outright rather than hidden behind a flag, because a panel nobody wants is
> not a setting. This document is kept as the record of why the work was done, not as a
> description of the app.
>
> Three things in here survived and are still live, because they were asked for in their own
> right: the **position-latency fix** (the feed drives `broadcastTrade` as well as
> `broadcastState`, so a fill repaints the position panel instead of waiting for the agent's next
> tool call), the **chart tween and symbol-switch auto-fit**, and **SUMMON**, whole. Read sections
> on those as current. Read everything about the mechanism panel as history.

## The problem

Phosphor is an interface you drive through an agent, but the window only ever shows results.
An action arrives, something changes, and nothing in between says a machine is working. Two
concrete defects sit under that:

1. A fill never repaints the position panel on its own. The feed's push wire calls
   `broadcastState()` where the trading surface listens for `trade`
   (`src/main.ts:290` vs `ui/trade.js:1508`). Positions correct on the agent's *next* tool
   call, which is why the lag reads as "a couple of seconds" and is really unbounded.
2. Switching BTC to SOL carries the old symbol's price scale and pan across, so candles draw
   off-axis or collapse to a degenerate domain (`src/chart.ts:250-251` reset the fields, then
   `:298` and `:308` re-apply them from the same patch).

## The rule this design turns on

**Never predict a duration.** The agent's think time is invisible to this app: the MCP server
is a stdio proxy and the first thing Phosphor learns is the tool call landing, already whole.
So no animation may be timed to an expected length. Every one is three phases:

- **WIND** — starts the instant intent is known, loops for as long as the work is open.
- **RELEASE** — fires on the real event, never on a timer.
- **SETTLE** — the result, held briefly, then decayed.

A 200ms read and an 8s swap use the same choreography and neither looks wrong. This is the
whole answer to the latency question, and it is why the archer holds the draw.

## The second rule: motion lives where the instrument already moves

`ui/style.css:5` states the surface's law: *no radius, no shadow, no gradient, no transition;
two animations, the cursor and the block wave.* The existing motion grammar is `steps(1)`
two-state opacity, 0.72-1.6s, 90ms stagger, no easing anywhere on the pro side. A cubic-bezier
fade or a transform slide on a panel would be the first soft thing on this surface and would
read as a second design language. That failure mode is already documented in the brief.

So the split is:

- **DOM keeps the law.** Panels, rows and numbers animate only as `steps(1)` opacity and
  brightness-tier flicks, reusing `waiting` and the 90ms stagger. No transitions, no transforms.
- **Canvas carries continuous motion.** The chart already tweens continuously under a human
  drag and nobody reads that as a second language. A new MECHANISM canvas gets the same
  licence. Phosphor persistence (a lit cell decaying rather than cutting) is the honest CRT
  primitive and is native to a raster surface, not to CSS.

Corollary, from `layoutFrames()` at `ui/trade.js:252`: panel frames are ASCII box-drawing
measured in JS. **Nothing may animate a panel's width.** Height and opacity are safe.

## Components

### 1. `src/agent-action.ts` — what the agent is doing now

The audit log answers "what happened" and cannot answer "something is happening": a line is
appended once and never changes. This store holds in-flight actions and emits on transition.
Guarantees: `start` is emitted before dispatch, and every `start` gets exactly one `settle`
including on throw (a `finally`, not a happy path). Open actions older than 120s are swept
with a real `settle` so the window releases through its normal path.

`targetFor(op, tool, kind)` maps to one of `chart | order | policy | account | view | read`,
totally: an unknown op animates as a read, the least dramatic thing on the surface.

### 2. Lifecycle events on `/api/events`

New frame `{type:'agent', phase, action}`. A dedicated frame, not a reuse of `log`: `log` is
consumed by `appendLog` on both pages, and piggybacking would couple the mechanism to the
audit renderer.

Emitted at `src/server.ts:1607`, the single chokepoint every MCP op passes through, after the
seat check and before all four dispatch branches. There is no matching chokepoint for the
finish, so the dispatch block is wrapped in one `try/finally`.

One more emit that has no home today: a proposal reaching `executing` (`src/proposals.ts:426`)
is the only transition with no audit line, and it is the state an animation most wants — real
chain work, seconds to minutes. It gets an event.

### 3. MECHANISM panel

A `<canvas>` panel, full width under the status bar on `/trade`, and a panel on `/`. Draws a
gear train in phosphor line art: idles at rest, drives under load, and the drive rate follows
how long the current action has been open rather than a predicted duration. Beside it, the
action in words: `agent · chart_batch ▸ interval 1h → 15m`.

Per target the train is dressed differently (a lathe for chart work, a draw-and-loose for an
order, a valve for policy) but it is one renderer with one geometry, not a cast of characters.
Everything is stroked vector at 1px on the character grid. No sprites, no bitmaps, no 3D.

Reconnecting windows read open actions from `/api/state` so a refresh mid-action still winds.

### 4. Instrument motion

Driven by the same events, inside the law:
- A number that changed flicks to `--green-hi` for one `steps(1)` beat, then back.
- New rows arrive on the existing 90ms stagger wave.
- The panel the action targets brightens its frame title for the duration of WIND.

### 5. Chart: tween and auto-fit

- A shadow view is interpolated client-side over ~320ms and exactly one `pushChart` fires at
  the end (`queueChartPush` debounces at 150ms and would otherwise fire mid-tween).
- `CHART_AXIS_W` settles a frame late, so it is measured against the tween's *target* domain
  up front and held, or the axis visibly shifts during a BTC to SOL change.
- Gated on the existing `reducedMotion()` at `ui/chart.js:528`.
- Auto-fit: when a patch changes `product`, `panOffset` and `priceScale` from that same patch
  are ignored. A symbol switch always lands at pan 0 and `{mode:'auto'}`. The existing test
  passes only because it sends `product` alone, a patch shape the real client never sends; the
  new test uses the client's actual full-view push.

### 6. Latency

- Export `broadcastTrade` and drive it from the feed (`src/main.ts:290`), alongside state.
- Flip both coalescers to leading-edge — fire now, suppress for the window — at
  `src/trade/feed-ws.ts:288` and `src/server.ts:259`. Removes 220ms from every first event
  while keeping the burst cap.
- Keep the cap. Hyperliquid pushes `clearinghouseState` on every mark move, several per second
  on a liquid coin; uncapped that is one full `renderAll` plus `chartRedraw` per message per
  browser, which is the exact regression `src/server.ts:296-303` documents from the retired
  trades socket.
- Separate a mark tick from a fill so equity does not repaint the book.

### 7. Summon

A button that opens a new Terminal.app window running `claude` wired to this app, and drops the
seat held by any prior agent. `agents.check()` already manages seats; summoning bumps a
generation so the previous proxy is refused and exits. Local only, `127.0.0.1`, never exposed.

## Testing

Code only. No visual or animation assertions — a screenshot cannot judge a tween. What is
tested: the action store's start/settle/sweep invariants, the event payloads, `targetFor`
totality, the symbol-switch patch contract with a real client-shaped push, the feed pushing
`trade`, and leading-edge coalescing. Animation correctness is judged by opening the page.

## Out of scope

Basic view. Any change to the colour tokens. Any new dependency — the surface is hand-rolled
and stays that way.
