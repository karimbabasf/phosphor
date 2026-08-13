# Phosphor v0.3: basic and pro view modes

Date: 2026-08-12
Status: approved in conversation, not yet built
Branch: `feat/basic-view`, worktree `~/Developer/phosphor-basic`

## What this adds

Phosphor gets two view modes. `pro` is the screen that exists today: chart, wallet table,
donut, policy sentences, log. `basic` is a new screen written for someone who does not know
what a swap is, whose whole job is to get one safe yes or no out of them.

Only the connected agent can change the mode. There is no keyboard shortcut, no button and no
URL that lets the human switch. That is Karim's explicit call, made after the alternative was
offered and declined.

## Why a second view model and not a CSS toggle

Three options were weighed.

1. **Server builds a `basic` view model, browser renders it.** Chosen. The plain-English
   sentences are produced in TypeScript from the same state the pro view uses, so they are
   testable and they sit next to the policy renderer that already machine-renders sentences.
2. **CSS and DOM toggle in `app.js`.** Rejected. Basic needs different numbers (rolled-up
   totals, "4 places"), not a subset of the pro numbers, so the sentences would be built in
   untested browser JavaScript. The repo already holds a rule that policy sentences are always
   machine-rendered and agent prose is quarantined. Money sentences in `app.js` break it.
3. **A separate `/basic` page.** Rejected. It doubles the SSE, session and candle wiring, a
   mode switch becomes a page navigation that drops stream state, and the approval gate would
   have two implementations to keep honest. Two implementations of the gate is the exact shape
   of the v0.2 failure recorded in `Lessons/2026-08-12-a-flag-that-only-changes-the-ui.md`.

## The rule basic is built on

**Basic may render fewer words. It may never render fewer facts about where the money goes.**

Always rendered: the action, the amount in USD, both token symbols, the chains, the balance
afterwards, and **every destination the funds actually land on**, each labelled with who chose it.
Removable: slippage floors, gas estimates, pool ids, fee tiers, tick ranges, venue names,
proposal ids, verdict reason strings.

### Why the amount alone is not the control

The first draft of this spec asserted only `basic.ask.amountUsd === draft.amountUsd`. That test
would not have caught F2, this repo's own worst approval bug: the amount was correct and the
destination was a solver-chosen deposit address while the screen said "your wallet". The engine
checked `leg.to` while `depositAddressFor()` was what got signed. Amount is the field least
likely to be wrong. Destination is the one with a track record here.

So the agreement test compares every field a human's yes actually rests on:

| Field | Source of truth |
|---|---|
| action kind | `proposal.kind` |
| amount in USD | `draft.amountUsd`, the number `evaluateRail` governed on |
| token symbols | `draft.fromSymbol` / `draft.toSymbol`, or the leg's symbol |
| chains | `draft.chain` / `draft.toChain` |
| counterparty | `draft.counterparty` |
| **deposit addresses** | `simulation.depositAddresses`, when present |

A senior cannot verify a `0x` string, so the address is not the fact that helps them. The
**label** is: "this is going to an address the swap service chose, not to your own wallet" is
something anyone can act on. Basic renders the label in plain words at full size and the address
itself in full underneath, never truncated. Hiding either one makes basic strictly less safe than
pro for the exact bug class this repo has already shipped once.

## Types

New in `src/types.ts`:

```ts
export type ViewMode = 'basic' | 'pro';

// Drives the one big sentence and the colour treatment. Never sent as a class name;
// the browser maps it, so a new tone cannot silently render as unstyled text.
export type BasicTone = 'calm' | 'asking' | 'working' | 'stopped' | 'frozen' | 'broken';

// Where the funds actually land. 'quoter' means the venue minted the address rather
// than the app choosing it, which is inherent to intent bridging and is exactly what
// F2 hid behind the words "your wallet".
export type BasicDestination = {
  label: string;                  // "your own wallet" | "an address the swap service chose"
  address: string;                // rendered in full, never truncated
  chosenBy: 'app' | 'quoter';
};

export type BasicAsk = {
  proposalId: string;
  kind: WriteDraft['kind'];
  headline: string;   // "It wants to change $105.00 of your dollars into Ether."
  afterLine: string;  // "You would have $2,236.08 in dollars afterwards."
  amountUsd: number;  // MUST equal proposal.draft.amountUsd
  symbols: string[];  // every token symbol the draft names
  chains: string[];   // every chain the draft names
  destinations: BasicDestination[]; // MUST cover draft.counterparty and every simulation.depositAddresses entry
  facts: string[];    // short plain lines that may not be dropped
};

export type BasicView = {
  tone: BasicTone;
  totalUsd: number | null;  // null when unknown; never 0 as a stand-in for unknown
  totalLine: string;        // "$2,341.08" or "still checking"
  placesLine: string;       // "spread across 4 places. all normal."
  headline: string;         // the big state sentence
  ask: BasicAsk | null;
  warning: string | null;   // gate off, policy unreadable, kill switch, in plain words
  agentLine: string;        // "An assistant is connected."
  footer: string;           // "Nothing moves unless you press YES."
};
```

`LogEvent['type']` gains `'view_changed'` and `'view_refused'`.

## Where the mode lives

`data/view.json`, written atomically the same way `store.ts` writes proposals. Read on boot,
default `pro` when the file is absent or unparseable.

It persists deliberately. Basic exists for a person who owns the money and is not technical, so
an app restart that dumped them back into pro would be a back-door escape hatch Karim declined.
A crash mid-session must not change what they see.

New module `src/view/mode.ts`, holding `readViewMode(dataDir)` and `writeViewMode(dataDir, mode)`.

## The new tool

`set_view_mode({ mode })`, registered in `src/mcp.ts` as a new op. Thirteen tools becomes fourteen.

It is not a read (it mutates) and not a propose (it moves no money and gets no policy verdict),
so `handleMcp` gains a third branch: `op: 'set_view_mode'`.

Server behaviour:

- Unknown mode: `400`, nothing changes.
- **Any proposal in `pending`: `409`, nothing changes**, audit `view_refused`. Without this an
  agent can move the YES button under a person's cursor while they are reading, which is worst
  for exactly the user basic exists for.

### Exactly what the 409 buys, and what it does not

Be precise about this, because the overstated version is the one people quote later.

The 409 guarantees: **the surface cannot change under a decision the human is in the middle of
making.** That is real and it is worth having.

The 409 does NOT guarantee that the agent cannot choose which surface a decision happens on.
Nothing stops `set_view_mode` being called first, while no proposal is pending, and the proposal being
made after. It also never fires on the sub-threshold path at all: a proposal under
`humanClickAboveUsd` goes straight to `executed` with `decidedBy: 'policy'` and is never `pending`
(verified 2026-08-12, a $60.64 `lp_add`).

The agent choosing the surface is inherent to what Karim asked for and is not a hole to close. It
is the reason the field-equality rule above is the actual control: whichever surface the agent
picked, the human must see the same facts. Ordering cannot be prevented, so the facts have to
survive either ordering.
- Otherwise: write, audit `view_changed`, `broadcastState()`, return `{ ok: true, view }`.

Every switch is in the log because a view change is a thing an agent did, and the transcript
should say so. `set_view_mode` gets no approve path, and `tests/injection.test.ts` keeps asserting
the sorted tool-name set (never the count, per the v0.2 lesson).

### The description is part of the security surface

`propose_lp_add` currently tells the agent "Execution only ever happens after a human approves
in the app window; this tool cannot approve." That is false below the click threshold: a $60.64
add executed immediately with `decidedBy: 'policy'`. The behaviour is right, the sentence is
wrong, and the description is the only thing an agent reads before deciding how to act.

So `set_view_mode`'s description states what it actually does and does not soften it:

> Switches the app window between the detailed operator view and a simplified view written for
> someone non-technical. This changes what the human sees before they approve anything, so it is
> refused while any proposal is waiting for a decision, and every switch is written to the audit
> log. It cannot approve, refuse or execute anything.

This is not one tool. `CANNOT_APPROVE` is a single shared constant in `src/mcp.ts` interpolated
into all six propose descriptions, so every write tool on the surface carries the same false
sentence. One edit fixes all six.

**Scope call:** this spec fixes it. Adding an honest `set_view_mode` description directly above six
dishonest siblings, in the same file, in the same commit, is not a defensible place to stop. The
constant becomes:

> "Returns a proposal id and simulation result. This tool cannot approve, refuse or execute
> anything. Whether a human is asked depends on the policy: proposals above the click threshold
> wait for a human click in the app window, and proposals below it are decided by the policy
> engine and may execute immediately."

Two lines of change. Flagged in the final report so Karim can revert it if he wants the fix on
its own branch.

## State payload

`buildState()` gains two fields:

```ts
view: currentView,          // 'basic' | 'pro'
basic: buildBasic({ ... }), // always computed, both modes
```

`basic` is computed even in pro mode. A view model that only exists in the mode that renders it
is a view model nothing tests when the app is in its default state.

## What basic shows

Kept: the balance, the ask, YES and NO, a STOP EVERYTHING button, one line saying whether an
assistant is connected.

Dropped: chart, donut, wallet table, policy sentences, composition, the raw log.

STOP EVERYTHING sits at the bottom, visually separated from YES and NO, and takes two presses
(press, then "Are you sure?"). It posts to the existing `/api/kill`. A senior needs a panic
button more than an expert does, and needs it harder to hit by accident.

## The eleven states

Every one produces non-empty copy. A test asserts that; a blank screen is the worst possible
outcome for this user.

| State | tone | headline | ask |
|---|---|---|---|
| Resting, nothing pending | calm | "Your money is safe. Nothing is happening." | none |
| Proposal needs approval | asking | "The assistant is asking." | YES / NO |
| Approved, executing | working | "Working on it. Please wait." | buttons disabled |
| Executed | calm | "Done. You now have $X." | none |
| Human refused | calm | "You said no. Nothing moved." | none |
| Policy refused | stopped | "The assistant tried to X. Phosphor stopped it. Your money did not move." | none |
| Kill switch on | frozen | "Everything is frozen. Nothing can move." | none |
| Gate disabled (testnet) | broken | "WARNING: this app is not asking you before it moves money." | none |
| Policy file unreadable | broken | "Something is wrong with the rules. Nothing can move." | none |
| No agent connected | calm | "No assistant is connected right now." | none |
| Chain read failed / still loading | calm | totalLine reads "still checking", never a number | none |

Two carry weight.

**Policy refused** is the product's best moment and it belongs in basic in plain words. It is
the whole demo: the agent tried, the app said no, the money did not move.

**Still checking** must never render as `$0.00`. The NEAR `UNKNOWN_ACCOUNT` bug proved a zero
and an unknown are indistinguishable on screen, and in basic nobody can tell them apart. When
`WalletView.stale` is non-empty, `totalUsd` is `null` and `totalLine` says so.

### Stale after a write, which `stale[]` does not catch

A peer session verified on 2026-08-12 that `wallet` serves pre-trade balances immediately after
a successful write and stamps them `stale: []`. An executed `lp_add` moved 36.540787 USDC and
0.011 WETH on chain (tx `0x2f5df5d0`, position #3643) while `wallet` still returned every
pre-trade figure and claimed nothing was stale. `stale[]` tracks chains that failed to READ, not
data that is out of date. Writeup: `Lessons/2026-08-12-a-cache-that-swears-it-is-fresh.md`.

Pro survives this because the operator can cross-check against the log, the tx ids and the
chart. Basic cannot: it is aimed at someone with nothing to cross-check against, so it is the
worst possible place to render a number that is one transaction and four minutes out of date.

Fixing the cache is out of scope, it belongs to the ledger and to whoever owns that bug. The
rule inside this scope is that **basic never states a balance it cannot back**:

> `totalUsd` is `null` and `totalLine` reads "checking your new balance" whenever the newest
> `chainStatus.fetchedAt` is older than the `decidedAt` of the most recent `executed` proposal.

Small, pure, and testable inside `buildBasic()`. It fails toward saying less rather than toward
stating a stale number as fact. A test drives it with a fetch timestamp behind an execution
timestamp and asserts `totalUsd === null`.

## Frontend

`ui/index.html` gains `data-view` on `<main id="page">` and a `<section id="basic">` sibling to
`.deck`. CSS hides whichever is not current. No second HTML file, no navigation.

`ui/app.js` gains `renderBasic(s)` and `applyViewMode(s)`. **Naming caution:** `applyView()` and
`setViewCount()` already exist in `app.js` and refer to the chart's candle window, not to view
mode. Do not overload them.

Basic typography: same phosphor green on near-black, same monospace, no box-drawing frames.
Base 20px, balance 64px, buttons at least 56px tall and full width to a 420px cap.

## Tests

Testing the switch is what failed last time. These test the consequence.

1. `tests/unit/basic-view.test.ts`: `buildBasic()` over fixtures for all eleven states, each
   producing non-empty `headline`, and `totalUsd === null` whenever a chain is stale.
2. **Both modes agree:** one pending proposal, assert `basic.ask.amountUsd === draft.amountUsd`
   and that the token symbols in `headline` match the ones pro renders.
3. `tests/unit/view-mode.test.ts`: persistence round trip, default `pro`, unparseable file
   falls back to `pro`.
4. **Refuse while pending:** create a pending proposal, call `set_view_mode`, assert `409`, assert
   the stored mode did not change, assert a `view_refused` line in the audit log.
5. **End to end, through a real MCP client:** call `set_view_mode` over stdio, then `GET /api/state`,
   and assert both that `view === 'basic'` and that `basic.ask.headline` contains the live
   proposal's real amount. Not `readViewMode() === 'basic'`.
6. `tests/injection.test.ts`: sorted tool-name set updated to fourteen names.
7. `ui-gate` PASS on basic at three viewports.

## Docs

README, `docs/architecture.md` and `docs/security-model.md` all change. The security model gets
the new agent capability written into it explicitly: the agent can now change what the human
sees, here is what stops that mattering (identical facts in both modes, refused while pending,
every switch audited). v0.2 shipped a security model describing a mechanism that did not exist.
A new agent capability left out of that file is the same mistake facing the other way.

## Version

`0.3.0` in `package.json`, `src/mcp.ts`, and the `ui/index.html` status bar.

## Out of scope

- Any change to the approval gate mechanism, the policy engine, or the rails.
- The open `GET /api/session` token hole. It is untouched and still open, and basic view neither
  worsens nor fixes it.
- Chart v2, which a peer session is building on `main` in parallel.
