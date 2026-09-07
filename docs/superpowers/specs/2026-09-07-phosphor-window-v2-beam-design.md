# Phosphor window v2: the beam

Date: 2026-09-07. Status: decided, building. Owner's brief, compressed: the base is strong and stays.
The window looks generic and is not productive. Reimagine it around the customer: the assistant
(summoning it and talking to it) comes first, feedback on what the assistant is doing comes second,
and a person waiting on an answer must never sit in front of a blank screen. Modern, with a palette
that is a decision. Local performance matters. Everything that exists must be bulletproof: the agent
channel, tool execution, the rails across NEAR, tokens and chains. Nothing new in the backend.

Companion documents: `2026-09-07-phosphor-ui-contract.md` (the exact backend contract the window is
built on, facts only) and the three audit reports plus the performance audit in the session
scratchpad, whose accepted findings become tracks of the plan.

## 1. What the window is for, in priority order

1. **The conversation is the product.** It is on screen in every mode, in the same place, never
   below the fold, never a panel among panels. Starting the assistant is the first thing a new
   window offers.
2. **What the assistant is doing is visible as it happens, and it is visible in space.** Every tool
   call lands on the thing it touched. Waiting is watching, not idling.
3. **Money moves need a person.** The decision is unmissable and sits where the person is already
   looking: in the conversation, above the composer, in its own colour.
4. **The money itself is calm.** Plain words, big quiet numbers, nothing decorated.

## 2. The idea: the assistant is the beam, the window is the phosphor

A phosphor screen glows where the beam lands and fades after it leaves. That is the name of the
product, and it is exactly the feedback the brief asks for, so it is the whole visual system:

- A tool call is a **beam**: a point of light leaves the step line in the conversation and lands on
  the surface the tool touched (the holdings list, the chart, the earning panel, the rules, the
  tabs). The surface **glows**, holds a **scan** while the call is in flight, and **decays** over
  about two and a half seconds once the result is back. Rose on an error, amber when the landing
  is a proposal waiting for a click.
- The transcript keeps the **trace**: under each assistant turn, the steps it took, with a phrase,
  the elapsed time, and the outcome. The live turn is open; older turns fold to one line.
- The ground behind the conversation is the **afterglow field** (the canvas from `pattern.js`,
  kept), and its energy is the assistant's state: dim when off, drifting when ready, lifted while
  working, held still while waiting for a click.

Everything in the system is driven by real events (`driver` frames, `state` frames), never by a
timer pretending to be progress. That is what makes the wait honest as well as alive.

## 3. Layout: one stage, two columns, three modes

```
+-------------------------------------------------------------------------------------------+
| [glyph] Phosphor           ( Basic | Pro | Trade )          1 waiting  Locks in 14m  Freeze |
+----------------------------------+--------------------------------------------------------+
|  CONVERSATION                    |  WORLD                                                 |
|  Your assistant   Working  Stop  |                                                        |
|                                  |   what the assistant touches, per mode                 |
|  you  Put $500 to work.          |                                                        |
|                                  |   +- Your money ------------------------- [surface] -+ |
|  reading your balances    0.3 s  |   |  $52,013.21                                      | |
|  reading the lending rate 0.6 s  |   |  ...                                             | |
|  asking to put money to work     |   +--------------------------------------------------+ |
|                                  |                                                        |
|  assistant  Aave on Arbitrum     |   +- Earning ---------------------------- [surface] -+ |
|  pays 4.2% ...                   |   |  Nothing is earning                              | |
|                                  |   +--------------------------------------------------+ |
|  +- Waiting for you ---- amber -+|                                                        |
|  | Put 500 USDC into Aave       ||                                                        |
|  | fee $0.04      [No] [Yes]    ||                                                        |
|  +------------------------------+|                                                        |
|  [ Tell your assistant what to do              ] Send                                     |
+----------------------------------+--------------------------------------------------------+
```

- **Topbar** (48 px): wordmark with the glyph (a phosphor square that carries the assistant's
  state: dim off, lit ready, breathing while working), the mode switch as a segmented control with a
  sliding indicator, then the status cluster: a `waiting` chip (amber, only when a proposal is
  pending), the lock countdown chip, the feed chip (trade only), and Freeze everything (rose, ghost).
- **Conversation column**: 440 px at 1280 and above, 400 px below that, 360 px in Trade. Draggable
  through `split.js` between 360 and 640 px; the world never goes under 560 px. Below 960 px the
  columns stack: the world scrolls, the conversation docks to the bottom 46vh with its composer
  fixed. Panel internals respond to their own width with container queries, never to the viewport,
  which is the fix for the draggable-column gotcha of 2026-08-20.
- **World**: everything the assistant can touch, per mode. The old three-page shell becomes one
  stage whose right half changes. The server still owns `view`; `switch` still moves it; a chart tool
  in Basic or Pro still switches to Trade and says so.

### Basic (the default for a fresh install)
A single 640 px column centred in the world:
1. **Your money**: the total, weight 500 at 44 px, tabular; under it one plain sentence that is
   state: "Nothing is connected to it right now." / "Your assistant is reading it." / "Waiting for
   you." / "Locked. Nothing moves."
2. **Your rules**, one strip: "Asks you above $100. Refuses above $10,000 at once and $25,000 a
   day." Teaches the safety model in one line, and is the surface `policy_show` lands on.
3. **What you hold**: rows by what it is, not by chain (as today), value first, amount in mono.
4. **Earning**: the panel as today, restyled.
5. **Money in**: the row that opens the receive screen.
6. **Activity**: newest first, five rows, "See all".

### Pro
A 12-column grid, max 1440 px, gutter 24: Money table (7) beside Earning (5); Limits (5) beside
Activity and receipts (7). Same components as Basic at higher density: rows 36 px instead of 48,
13 px labels instead of 14.

### Trade
The chart fills the world with a 320 px rail on its right: Position, Account, Rules, What happened.
`ui/chart/chart.js` and `ui/chart/trade-overlay.js` are not rewritten; their chrome takes the new
tokens and classes. The conversation narrows to 360 px and stays.

## 4. The conversation column

Namespace stays `window.PhosphorAgent` (tests read it), file stays `ui/screens/agent.js`, rewritten.

- **Head**: "Your assistant", the state chip (Off, Starting, Ready, Working, Stopped, Could not
  start), Start (accent) when off, Stop the answer (ghost) while working, Stop (ghost) when ready.
  Connected external clients list under the head as small rows: name, "can ask" or "read only",
  call count.
- **Empty state** (off, no transcript): on the afterglow field, "Nobody is at the wheel." and one
  line: "Start your assistant, or connect one you already use." Two actions: **Start your
  assistant** (accent) and **Connect your own** (ghost), which reveals the `claude mcp add` line with
  Copy. Nothing else in the column.
- **Transcript**: left-aligned throughout, measure capped at 68 characters, 15 px on 1.5.
  - *you* rows sit on a raised ground (`--bg-2`, radius 12), the assistant's rows are plain text on
    the field: the assistant's words are the surface, not a bubble.
  - **Steps** live between the person's message and the assistant's reply. Each step is one row:
    a phosphor dot (lit while in flight, settled when done, rose when the tool errored), the phrase
    from `TOOL_PHRASES`, and the elapsed time in mono, ticking live and then fixed. A step whose
    tool leaves the machine (`research`) carries the words "leaves this computer". The live turn
    shows every step; a finished turn folds to "4 steps, 2.1 s" and opens on click.
  - **Thinking**: 300 ms after a message is sent with nothing back yet, one row "thinking" with
    three dots breathing on opacity. Never a spinner, never a skeleton.
  - The transcript is text only, never markup, and never draws a control. Unchanged property.
- **Composer**: a textarea growing from one to five lines, Enter sends, Shift+Enter breaks the
  line, Send (accent). Placeholder "Tell your assistant what to do." Disabled with a reason when
  the assistant is off ("Start your assistant to talk to it"). Sending is instant: no animation on a
  keyboard action.
- **Decision dock**: section 5. It sits between the transcript and the composer so a person can ask
  the assistant about a proposal before deciding it.

## 5. The decision dock

`window.PhosphorDecision` keeps its name and `boot()`; the full-screen overlay is retired in favour
of the dock. The dock renders only from the server's pending list in `/api/state`. Nothing the
assistant writes can put anything in it, and it is the one region in the column drawn in amber, so
a transcript row cannot impersonate it.

- Card: "Waiting for you" as the title, then the sentence the server already renders, the legs,
  the fee, the simulation result, and the policy diff for a rule change (the existing diff renderer,
  restyled). Buttons: **No** (ghost) and **Yes** (accent). Same words as today, so the e2e and the
  approvals tests keep their meaning.
- While a card is up: the dock's top edge is amber, the topbar shows "1 waiting", the world surface
  the rail would touch glows amber and holds, and the field stands still. Under `pending_unlock` the
  card reads "Unlock to decide" with an Unlock button that opens the lock screen.
- After Yes: the card becomes the receipt for six seconds (what moved, the tx links), then folds
  into a "done" step in the transcript and into Activity. After No: "Refused" for two seconds, then
  gone. `needs_reconciliation` keeps the card up with "Checking what happened" and the Reconcile
  action.
- Several pending: stacked, newest on top, the count in the head. In Trade, where the column is
  narrow, the card scrolls inside the dock rather than growing the column.

## 6. The world's surfaces

Every panel the assistant can touch is a **surface**: a bordered box with a stable
`data-surface` id. The border is information (this is something the assistant can act on), which is
why static text such as the Basic hero and the rules strip is unboxed and hairline-separated instead.

| `data-surface` | Basic | Pro | Trade | Tools that land here |
|---|---|---|---|---|
| `holdings` | What you hold | Money table | | `balances`, `wallet`, `composition`, `gas_report` |
| `earning` | Earning | Earning | | `yield_read`, `yield_auto`, `propose_yield_*` (amber) |
| `rules` | Your rules strip | Limits | Rules | `policy_show`, `propose_policy_change` (amber), `mandate_catalog`, `propose_mandate` (amber) |
| `activity` | Activity | Activity | What happened | `proposal_status`, `log_tail` |
| `moneyin` | Money in | | | `propose_intents_deposit`, `propose_hl_deposit` (amber) |
| `chart` | | | Chart | `candles`, `market_search`, `chart_*`, `trade_*`, `watch`, `indicator_catalog` |
| `position` | | | Position | `trade_read` |
| `account` | | | Account | `propose_hl_deposit` (amber) |
| `tabs` | topbar | topbar | topbar | `switch`, and any tool whose surface is in another mode |
| `window` | the stage edge | | | `set_theme` |
| `assistant` | the head | | | `start`, `skill`, `agent_*` |

A tool whose surface is not on screen lands on the tab of the mode that holds it, so a chart tool
called in Basic lights the Trade tab a beat before the server switches the view. `propose_swap` and
`propose_consolidate` land on `holdings` in amber; `propose_intents_withdraw` lands on `holdings`.

## 7. The beam system

Two new files, no dependencies.

`ui/beam/beam.js`, `window.PhosphorBeam`:
- `fire({ from, to, tone })`: `from` is an element or a point, `to` a `data-surface` id, `tone`
  one of `glow`, `wait`, `down`. Draws one flight of 320 ms on a fixed full-window canvas with
  pointer events off, DPR capped at 2, a 3 px head and a tail of twelve samples along a quadratic
  curve, `--ease-in-out`. Rects are read once at fire time. The rAF loop runs only while a flight is
  in the air and cancels itself.
- `hold(id)` starts the scan on the surface: a 1 px gradient bar in a child element translating
  from top to bottom over 900 ms, linear, looping. `release(id, ok)` stops it and starts the decay.
- The glow is `[data-surface]::after`, an inset box-shadow in the tone colour whose **opacity**
  transitions (never the shadow itself): 0 to 1 in 120 ms, then 1 to 0 over 2400 ms `--ease-out`
  on release. Amber holds at 1 until the proposal is decided.
- `reduce`: under `prefers-reduced-motion` there is no flight and no scan; the glow fades in and
  out on opacity in 200 ms. Everything else is identical.
- Budget: under 1 ms per frame in flight, zero work when idle, no layout reads inside the loop.

`ui/beam/trace.js`, `window.PhosphorTrace`: listens to `driver` frames. On `tool` it opens a step
row in the live turn, maps the tool to a surface with the table above, fires the beam from the row's
dot and holds the surface; on `tool_result` it releases with the outcome and fixes the elapsed time;
on `text` it closes the step block; on `turn_end` it folds the turn. It also lights `activity` on
`transactions` frames and `holdings` on a balance change, in the decay-only form, so what changed
after an execution glows for a moment on its own.

## 8. Palette, type, motion

The five `set_theme` slots keep their names and meanings (`--ink`, `--bg-0`, `--up`, `--down`,
`--agent`) so `ui/theme.js` and the tool contract are untouched. The window is one colour on
graphite, and the colour is light, not paint: green is emitted by the assistant's activity and
decays; it is never a flat wash on a panel. Primary actions carry it as ink because the accent slot
is one decision, not two.

| Token | Value | Use |
|---|---|---|
| `--bg-0` | `#0B0D10` | window ground, a cool graphite rather than a tinted black |
| `--bg-1` | `#111418` | surfaces |
| `--bg-2` | `#181C22` | raised: inputs, the person's rows, hover rows |
| `--line` | `#232830` | hairlines |
| `--line-strong` | `#313843` | focused borders, the dragged divider |
| `--text` | `#ECEEF1` | primary |
| `--text-2` | `#9BA1AB` | secondary |
| `--text-3` | `#5E656F` | tertiary, disabled |
| `--ink` | `#33FF66` | accent slot: primary buttons, links, the live dot; `--on-ink` `#0B0D10` |
| `--beam` | `var(--ink)` | the beam, the glow, the step dots and the glyph: the assistant's light follows the accent |
| `--agent` | `#B79CFF` | unchanged slot: what the assistant drew on the chart, told from the person's drawings by colour |
| `--glow-ash` | `#0F3A1E` | the last stop of the decay, what a surface settles to before the ground |
| `--up` | `#33FF66` | price up, positive delta |
| `--down` | `#FF5A6E` | price down, danger, an errored step, Freeze |
| `--wait` | `#F5B942` | waiting for a person: the dock, the waiting chip, the amber glow |
| `--lift` | one shadow | only the dragged divider and toasts float |

Panels have no shadow: depth comes from ground steps and hairlines, light comes from the glow. Radius
14 on surfaces, 10 on inputs and buttons, pill on chips.

Type: Geist for everything, Geist Mono for numbers, addresses, hashes, times, axes, with `tnum`.
Scale 12, 13, 14, 15 (transcript), 16, 20, 28, 44 (the total). Display sizes take -0.02em tracking.
Titles are short noun phrases. No all-caps labels, no eyebrows, no dot-joined meta strings, no
arrows in button text.

Motion, unchanged tokens: press `scale(0.97)` 160 ms; enters opacity plus 6 px rise 220 ms, stagger
40 ms; view swap crossfade 180 ms with 2 px blur; numbers crossfade 300 ms, no digit scrolling; the
segmented control's indicator slides 180 ms `--ease-in-out`. Nothing animates on a keyboard action.
One page-load moment: a single beam sweeps the topbar's bottom hairline and lights the glyph, 600 ms,
once. Reduced motion keeps opacity only.

## 9. Screens outside the stage

Lock, first run, migration, receive (money in) and receipts keep their flows and API calls exactly
and take the new tokens, radii and copy voice. The lock and first-run cards keep the afterglow
field behind them. The unknown-outcome and reconciliation states keep their words.

## 10. Copy

| Where | Text |
|---|---|
| Composer placeholder | Tell your assistant what to do. |
| Composer, assistant off | Start your assistant to talk to it. |
| Empty column | Nobody is at the wheel. / Start your assistant, or connect one you already use. |
| Start button | Start your assistant |
| Connect reveal | Connect your own |
| State chip | Off, Starting, Ready, Working, Stopped, Could not start |
| Thinking row | thinking |
| Folded steps | 4 steps, 2.1 s |
| Research step | reading the web, leaves this computer |
| Dock title | Waiting for you |
| Dock, locked | Unlock to decide |
| Dock buttons | No, Yes |
| After Yes | Done. (then the receipt line) |
| After No | Refused. |
| Reconciling | Checking what happened. |
| Topbar chip | 1 waiting |
| Hero, idle | Nothing is connected to it right now. |
| Hero, working | Your assistant is reading it. |
| Hero, pending | Waiting for you. |
| Hero, locked | Locked. Nothing moves. |
| Rules strip | Asks you above $100. Refuses above $10,000 at once and $25,000 a day. |

Tool phrases: the `TOOL_PHRASES` table in `agent.js` stays and gains a phrase for every tool that
lacks one (`gas_report` checking gas, `yield_read` reading what you earn, `yield_auto` setting up
auto earning, `propose_yield_deposit` asking to put money to work, `propose_yield_withdraw` asking to
take money out, `propose_hl_deposit` asking to fund trading, `propose_policy_change` asking to change
a rule, `set_theme` recolouring the window, `chart_preset` applying a chart preset, `chart_clear`
and `trade_clear` clearing the chart, `chart_remove_indicator` removing an indicator, `log_tail`
reading the log, `agent_spawn` starting a helper, `agent_roster` checking the helpers, `agent_post`,
`agent_board`, `agent_jobs` talking to the helpers, `mandate_arm` arming a rule).

## 11. Performance rules for the window

Fixed by this spec; the performance audit adds to the list and its accepted items become tasks.

- One `state` frame must not rebuild the DOM: every screen reconciles by key (`dom.reconcile`) and
  writes only text nodes and attributes that changed.
- Only `transform` and `opacity` animate. No `transition: all`. No animated `box-shadow`, `filter`
  above 2 px, or `backdrop-filter` anywhere on a hot path.
- The field: DPR capped at 2, 24 fps only while visible and not static, cancelled on
  `visibilitychange`, one pre-rendered frame under reduced motion, under 2 ms a frame, and the
  canvas is the conversation column's size, not the window's.
- The beam: section 7's budget.
- The chart keeps its own loop and budget; nothing in the new layout forces it to resize on a
  heartbeat.
- Fonts preloaded, `font-display: swap`; scripts deferred in the existing order plus the two beam
  files after `screens/agent.js`.

## 12. What does not change

- Every backend route, frame and shape in the contract document. No new endpoint.
- `ui/core/*`, `ui/chart/chart.js`, `ui/chart/trade-overlay.js`, `ui/theme.js`, `ui/activity.js`
  (tokens and class names only where the chrome is styled).
- The security properties the window carries: the transcript is text only; the decision is drawn
  from server state only; no inline script under the served CSP; the token is handled exactly as
  `ui/core/net.js` handles it today; nothing new is written to the DOM as markup from any frame.
- The behaviours the tests in section 11 of the contract document assert, or the tests change in the
  same commit with the reason in the message.
- The tool surface and its names.

## 13. Verification

- `npm test`, `npm run typecheck`, `npm run e2e` green.
- Captures at 1440x900 and 1920x1200 of Basic, Pro, Trade, the empty column, a live turn with
  steps, a pending dock, a receipt, the lock screen and the first run, produced against a fixture
  data directory the way `.design/v1` was, and checked by eye at the end of the build.
- `npm run bundle` then `npm run tauri dev` opens the real window; a screenshot of it is the last
  check before the branch merges.
- No em dashes, no all-caps labels, no green literal outside `tokens.css`.
