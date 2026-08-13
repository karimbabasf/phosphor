# Trading surface: flow before screens

Scope: the new `/trade` page. Hyperliquid perpetuals only. The existing pro page at `/` keeps
swaps, liquidity positions and custody, and nothing here changes it.

A note on one word. "Leverage" appears throughout as a noun, because it is the venue's own
field name and the number a trader says out loud. The house style bans it as a verb, which is
the corporate usage, not this one.

## WHO

When my agent says it sees a setup on the 4h, I want to check its reasoning against the same
chart it is reading, so I can agree or disagree in seconds instead of rebuilding the analysis
myself.

When I have approved a bot to trade, I want to see how much of what I approved it has already
spent and how near it is to both walls, so I can leave the desk without wondering.

When something goes wrong while a bot holds a position, I want the control that stops it to be
in the same place it always is, so I am never hunting for the brake while money moves.

**Not for:** anyone who wants to click buy and sell by hand at speed. This is not a scalping
ladder and it has no order ticket. Every manual control on this page STOPS something. Starting
is what a mandate is for, and a mandate needs a program and a click.

## VALUE

The moment of value is the `/trade` page in its **armed** state: the mandate console showing a
live envelope with its four bounds filling up, while the chart behind it carries the two walls,
the venue's liquidation and the human's stop-out, with the human's nearer.

Budgets, declared before building:

- **Max steps from cold start to that moment: 3.** Open the page, read the proposed mandate,
  click ARM.
- **Max input fields to that moment: 0.** The human types nothing. The agent authors the
  program; the human's whole contribution is reading it and clicking once.
- **Max tab stops to the primary action: 2.** The primary action on a trading surface is the
  brake, not the accelerator. KILL SWITCH is the first or second thing the keyboard reaches,
  from page load, in every state.

## FLOW

Primary flow: the agent proposes a bot, the human arms it, the bot trades inside its bounds.

1. **Open the surface.**
   entry: the app is running and the browser is at `/trade`.
   action: the human opens the page.
   response: chart for the focused symbol, account health, positions, and the mandate console
   reading NOTHING ARMED.
   exit: the human can see mark price, free collateral and whether anything is running.
   fails: the venue is unreachable, so no price and no account exist. The page renders its
   frame with every number as `--` and a banner naming the venue and the last error. It never
   renders a stale price as a live one.

2. **Agent analyses and marks up the chart.**
   entry: the human asks the agent a question in their own client.
   action: the agent calls the chart and analysis tools, draws lines, and pins a note.
   response: the drawings and the note appear on this page within one refresh, tagged as agent
   objects and dotted so attribution is visible without reading a label.
   exit: the human is looking at the same objects the agent is reasoning about.
   fails: the agent draws twenty things and buries the price. Agent objects are counted in the
   status bar and `trade_clear` removes them in one call; drawings are capped by the store.

3. **Agent proposes a mandate.**
   entry: the human and the agent have agreed on a plan in conversation.
   action: the agent calls `propose_mandate` with a program and an envelope.
   response: the mandate console shows the program in plain English, the four bounds, the worst
   case in dollars, and the price at which the approved loss is reached.
   exit: a pending mandate is on screen with an ARM button.
   fails: the program does not validate, or its worst case is larger than its own notional cap.
   The proposal is refused at propose time with the sentence that says which bound is wrong.
   Nothing reaches the screen half-formed.

4. **Human arms it.**
   entry: a pending mandate is on screen.
   action: the human reads it and clicks ARM, then confirms.
   response: the runner child process starts, the mandate moves to ARMED, the envelope bars
   appear at zero, and the mandate wall is drawn on the chart.
   exit: a bot is running inside bounds the human read.
   fails: the kill switch is on, no API wallet is approved, or the venue refuses. The arm fails
   with the venue's own sentence and the mandate stays pending rather than silently vanishing.

5. **Bot trades; human watches the bounds fill.**
   entry: a mandate is armed.
   action: none. The human watches, or leaves.
   response: each fill moves the position line, the liquidation line, and the notional and loss
   bars. The rule that fired is named with a timestamp.
   exit: the human can answer "how much of what I approved has it used" without doing arithmetic.
   fails: the feed stalls and the numbers stop being true. Every price carries its age, and a
   feed that has failed puts the whole surface into a degraded banner rather than showing the
   last good number as current.

6. **It ends.**
   entry: the program closes, a bound is hit, the mandate expires, or the human stops it.
   action: the human clicks DISARM, or nothing.
   response: the bot stands down, the mandate leaves ARMED with the reason it left, and the
   wall comes off the chart. A position it opened is still a position; disarming stops the bot,
   it does not close the trade.
   exit: nothing is running and the reason is in the log.
   fails: the child process is wedged and does not answer. Disarm asks first and kills after
   three seconds regardless, because a brake that needs the engine to be healthy is not a brake.

### Non-happy path A: the venue degrades while a bot is armed

1. entry: armed, position open. action: none, Hyperliquid slows to sixteen seconds per call.
   response: requests are bounded, deduped, and after three failures the client backs off; the
   status bar turns the feed indicator to DEGRADED with the latency and the last error.
   exit: the human knows the screen is behind the market. fails: the human does not notice, so
   the indicator is in the status bar next to the price, not in the log.
2. entry: degraded. action: the human clicks KILL. response: the runner is asked to flatten and
   is killed three seconds later either way. exit: nothing armed. fails: covered above.

### Non-happy path B: the human returns to a page whose session token is stale

1. entry: the browser has been open overnight and the app restarted underneath it.
   action: the human clicks DISARM. response: the write is refused with `invalid approval
   token`. exit: nothing happened, and the human knows nothing happened.
   fails: a silent no-op would be the dangerous outcome. The page reloads its token and says
   RELOADED, TRY AGAIN rather than swallowing the refusal.

### Non-happy path C: the agent tries to do the human's job

1. entry: an agent connected over MCP. action: it calls a tool hoping to close a position.
   response: no such tool exists. The closest is a mandate proposal, which needs a click.
   exit: the agent asks the human instead. fails: it cannot fail open, because the capability is
   absent rather than guarded.

## STATES

Surfaces down the side. `N/A:` carries its reason.

| surface | first-run | empty | zero-results | loading-cold | loading-refetch | partial | error-recoverable | error-fatal | offline | unauthorized | success |
|---|---|---|---|---|---|---|---|---|---|---|---|
| page shell | Frame, panel titles, every number `--`, one line: "Waiting for the venue." | N/A: the shell always has content, its panels carry the empty states | N/A: the shell is not a result set | Frame drawn immediately, values `--`, no spinner | Frame and last values held, age shown beside the price | Panels that have data render; those that do not keep `--` | Banner naming the venue and the error, with RETRY | Banner: app unreachable, with the command to restart it | Banner: "No route to the venue." Cached values marked with their age | N/A: the surface binds to localhost only and has no accounts | Full surface, feed indicator LIVE |
| chart | Empty grid with the axis and "no candle data" | Same as first-run, with the product name | N/A: candles are a stream, not a query | Axis only, no candles | Existing candles held, new bar appended when it lands | Candles drawn, overlays skipped until the account answers | "no candle data: <reason>" in the plot | Same as recoverable; a chart has no fatal state that is not the app's | Last candles held, staleness in the chart bar | N/A | Candles, indicators and overlays |
| risk | All `--`, one line: "No account data yet." | "Nothing at risk. No open position." with the free collateral still shown | N/A: not a query | Labels with `--` | Values held, age shown | Collateral shown, liquidation distance omitted when no position exists | Row-level `--` plus the error line, RETRY | Banner from the shell | Values held with their age, marked STALE | N/A | Equity, margin, free, and the distance bar |
| mandate console | "Nothing armed. Ask your agent for a proposal." | Same, plus a one-line description of what a mandate is | N/A | "--" with the panel title | Armed rows held, bars redrawn | Armed rows shown, envelope bars omitted until the runner reports | The runner's own error with DISARM still enabled | Runner dead: every mandate shown as NOT RUNNING with DISARM enabled | Armed rows held and marked STALE; DISARM still enabled | N/A | Program in English, four bars filling, the rule that last fired |
| book (positions and their orders) | "Flat. No position on any market." | Same line | "No orders working." under a position that has none | Header row only | Rows held, changed cells re-rendered | Positions shown, orders omitted with "orders unavailable" | Inline error row, RETRY | Shell banner | Rows held, marked STALE | N/A | Position rows with their working orders nested under them |
| fills | "No fills yet." | Same line | "No fills on <symbol>." with a control to show every market | Header only | Existing rows held, new fills prepended | Rows shown, closed PnL omitted where the venue did not report it | Inline error row with RETRY | Shell banner | Rows held, marked STALE | N/A | Newest first, liquidations ringed |
| log | "Nothing yet." | Same line | N/A: the log is not filtered | Empty pane | Appended, scroll position kept | N/A: a line is whole or absent | "log unavailable" with RETRY | Shell banner | Last lines held | N/A | Newest at the bottom, refusals in red |

Two rules the table above obeys. `first-run` and `empty` differ everywhere they can: first-run
does not yet know, empty knows there is nothing. Every `empty` and every `error-*` cell names
the next action, because a state with no way out is a dead end.

## FORM

The page takes almost no input, which is the design working. There is no order ticket. Two
controls accept typing:

| label (as a question) | name | type | inputMode | autocomplete | required | validation | error string | hint |
|---|---|---|---|---|---|---|---|---|
| Which market? | symbol | select | N/A: a select has no text entry | `off`: the option list is the venue's asset universe, and a browser suggestion from another site would be wrong | yes | must be one of the listed products | "That market is not on this venue." | none needed, the list is the hint |
| What should the chart show? | trade-cmd | text | text | `off`: this is a command vocabulary, not a personal detail, and no saved value from any other field could ever be correct here | no | parsed against the closed command set | "Not a command. Try: focus eth, overlay fills on, clear agent." | `focus eth` |

Validation timing: first error on blur, cleared on the next keystroke, and the server's answer
is authoritative on submit. Never on every keystroke.

## COPY

Page title: `PHOSPHOR TRADE`

Panel titles: `CHART`, `RISK`, `MANDATE`, `BOOK`, `FILLS`, `LOG`

Status bar labels: `mark`, `funding`, `equity`, `free`, `feed`, `agent`

Buttons: `[ KILL SWITCH: OFF ]`, `[ KILL SWITCH: ON ]`, `[ ARM ]`, `[ REFUSE ]`, `[ DISARM ]`,
`[ CLOSE POSITION ]`, `[ CANCEL ]`, `[ CANCEL ALL ]`, `[ FLATTEN ALL ]`, `[ RETRY ]`

Confirmations:
- arm: `Arm this bot? It trades on its own inside these bounds until it expires or you stop it.`
- disarm: `Stop this bot? Any position it opened stays open.`
- close: `Close this position at market? This spends real collateral.`
- flatten: `Close every position and stop every bot?`
- kill on: `Turn the kill switch ON? Every write is refused and every bot stops.`
- kill off: `Turn the kill switch OFF? Writes are allowed again, subject to policy.`

Empty states, each with its next action:
- `Nothing armed. Ask your agent for a proposal.`
- `Flat. No position on any market.`
- `No orders working.`
- `No fills yet.`
- `Waiting for the venue.`

Errors, none of them containing please, sorry, valid, invalid, oops, or "something went wrong":
- `No route to the venue. Showing the last numbers with their age.`
- `The venue is slow: <n>s per call. This screen is behind the market.`
- `The venue refused: <its own words>`
- `Nothing armed: the kill switch is on.`
- `No API wallet approved. Run npm run hl-agent at a terminal.`
- `That market is not on this venue.`
- `Approval token is stale. The page reloaded it, try again.`

Risk phrasing, chosen so nothing reads as a promise:
- `LIQ at <price>, <n>% away, <n> ATR`
- `MANDATE STOP-OUT at <price>, the loss you approved`
- `Used <n> of <n> notional`
- `Lost <n> of <n> allowed`
- `<n> of <n> orders this minute`
- `Expires in <duration>`

Attribution, always visible and never inferred:
- `agent` on anything the agent drew or wrote
- `you` on anything the human did

## Verification

Run after the build, by `node ~/.claude/tools/ui-gate.mjs http://127.0.0.1:<port>/trade --src ui`,
which runs the slop lint, takes the screenshots, and holds the result against `.design/brief.md`.

Assertions specific to this surface, on top of what the gate already does:

1. KILL SWITCH is reachable within 2 tab stops from a cold load, in the armed state and in the
   flat state.
2. Every state in the STATES table that has real content renders without a blank pane, checked
   by driving the page with the venue forced to fail, forced to be slow, and returning nothing.
3. No string in `ui/trade.*` matches the banned list.
4. The page never scrolls horizontally at 390, 768 and 1440 CSS pixels.
5. With no account, no panel is blank: every one shows its own empty line from the COPY section.
