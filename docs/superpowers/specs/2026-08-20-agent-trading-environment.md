# The agent-driven trading environment

> **Implementation status, 2026-08-20.** This document is a design decision, and most of it is
> not built yet. What IS built and verified against the live venue, so a reader does not have to
> guess which half they are looking at:
>
> | From this spec | State |
> |---|---|
> | The frequency boundary (section 1.2) and its consequence that the agent never decides on a price | Built into what exists: no order tool was added, `propose_mandate` is still the only door |
> | Venue-side primitives the spec calls tier 3 | **BUILT**: `bracket`, `modify`, `batchModify`, `scheduleCancel` in `src/hl/exchange.ts`, all four round-tripped against live testnet |
> | `scheduleCancel` as a usable dead-man switch | **BLOCKED BY THE VENUE**: gated behind $1,000,000 of traded volume. Measured, not read. See `isScheduleCancelLocked` |
> | Funding the account from any chain (section 8.4) | **BUILT**: `src/rails/hypercore-deposit.ts`, `propose_hl_deposit`, live dry quotes on arb, eth and base |
> | Portfolio ceiling (sections 5.10, 5.11) | **BUILT**, in `src/runner/host.ts` rather than the policy engine: $250 across 3 mandates on mainnet, $2500 on testnet |
> | Mainnet (section 8.3) | **BUILT**: `cfg.tradingNetwork`, and the runner's blanket refusal was replaced by the ceiling above rather than deleted |
> | Grammar extensions (section 3): relative `Ref`, `clock` condition, maintained limit, TWAP entry | **NOT BUILT** |
> | `mandate_check`, `mandate_replay`, `mandate_tighten` (section 4) | **NOT BUILT** |
> | Websocket-driven runner tick (section 1.4) | **NOT BUILT**. The runner still reasons every 250 ms about a book up to 2000 ms old, which is the single largest gap between what this app claims and what it does |
> | Fusing a rule's `open` and `set_stop` into one `bracket` call | **NOT BUILT**. The builder exists and the runner still places them as two actions, so a position is briefly naked between the fill and the stop. This is the next change, and it is deliberately not a late-session edit to the tick loop's in-flight accounting |
> | `stand_down` catalog text (section 8.1) | **NOT FIXED** |

Date: 2026-08-20
Extends, does not replace: `2026-08-12-phosphor-trading-design.md` (the three clocks, the
grammar, the mandate), `2026-08-12-trading-surface-design.md` (the `/trade` page, the two walls,
the agent's read/view split), `2026-08-13-agent-presence-design.md` (never predict a duration),
`plans/2026-08-12-mandate-and-runner.md` (the locked interfaces).

Everything those four settled stays settled. This document answers the one question they left
open: what "high frequency" means when the driver is a language model, where exactly the line
between deciding and executing sits, and what has to be built on top of the existing grammar,
mandate and runner to serve a once-a-week swing trade and a continuously quoted loop from one
surface.

Read-only work. Nothing here is implemented yet.

---

## 0. The claim this document rests on

The metaphor is the design law: **the app is the car, the agent is the person with the key.** A
driver does not spin the crankshaft. The driver chooses the destination, sets the speed, and
turns the wheel; the engine does every revolution without asking.

Phosphor already has that split. It is called the three clocks and it is built. What it does not
yet have is an engine fast enough to be worth driving, a way for the driver to rehearse a route
before committing, or a brake the driver can reach without waking the owner. Those three gaps
are the whole of this document.

---

## 1. Decision: the frequency boundary

### 1.1 The measured numbers

Every number below is either read off this repository or taken from the prior specs. Nothing is
estimated.

| Stage | Latency | Where it comes from |
|---|---|---|
| Model think plus one MCP round trip | 1,000 to 5,000 ms | `2026-08-12-phosphor-trading-design.md`: "An LLM turn is seconds" |
| MCP stdio proxy to the app | under 5 ms | `src/mcp.ts` POSTs to `http://127.0.0.1:<port>` |
| Runner tick interval | 250 ms | `src/runner/main.ts`, `setInterval(..., 250)`, serialised by the `ticking` flag |
| **Runner market data age** | **up to 2,000 ms** | `src/runner/host.ts`, `pump = setInterval(..., deps.pollMs ?? 2000)`, two REST calls per symbol |
| Evaluate plus envelope plus sign | under 5 ms target | latency budget in the trading design spec |
| Trading window market data age | one network hop | `src/trade/feed-ws.ts`, websocket, already built |
| Venue matching a resting order | zero of ours | the order is already on the book |

The fourth row is the finding. The runner's 250 ms tick is a claim its inputs cannot support: it
reasons every quarter second about a book that is up to two seconds old. `src/runner/feed.ts`
says so in its own header, unprompted: "Polling rather than websocket, stated plainly as a
limitation. It bounds reaction time to the interval, which is fine for a strategy working on
minute bars and NOT fine for anything genuinely high frequency."

### 1.2 The decision

**Three tiers, split by data freshness, not by importance.**

| Tier | Who decides | Data age it may depend on | What it decides |
|---|---|---|---|
| 1. Cognition | the agent, per tool call | seconds to minutes | which market, the thesis, the program's shape, every envelope number, when to arm, when to tighten |
| 2. Reaction | the runner child, per tick | 250 ms and under, once 1.4 lands | does a rule fire, does the envelope allow it, place, re-peg, cancel, supervise, flatten |
| 3. Standing | the venue's matching engine | zero | resting limit entries, TP and SL triggers, reduce-only exits, TWAP slices, `scheduleCancel` |

**The rule that makes the boundary checkable, and it is a physics rule rather than a policy one:
a decision may be made at a tier only if the price it depends on is fresher than that tier's data
age.** The agent's freshest price is whatever its last tool call returned, which is seconds to
minutes old by the time the model has finished reading it. Therefore **the agent may never make a
decision that depends on the current price**, and that single sentence justifies every absence on
its tool surface. It is not that the agent is untrusted with an order verb. It is that an order
verb driven from stale data is a defect regardless of who holds it.

**Because Y:** true high-frequency trading through an agent's tool calls is physically impossible
at a 1 to 5 second round trip, so Phosphor does not sell it. What Phosphor sells instead is that
**the agent authors reaction rather than reacting.** Frequency is a property of the program the
agent writes and of where that program's decisions rest, not a property of how often the agent is
called.

### 1.3 What "high frequency" therefore means here

It means the answer already exists at tier 3 and Phosphor barely uses it. A resting limit order at
the venue fills at match speed with zero of our latency in the path. A trigger order fires on mark
with zero of our latency in the path. The fastest thing Phosphor can do is not to tick faster; it
is **to have already put the decision on the venue.**

So the frequency ladder, from slowest to fastest:

1. Agent arms a new mandate. Minutes. One human click.
2. Agent tightens a live mandate. Seconds. No click (section 4.4).
3. A program rule fires on a tick. 250 ms, and after 1.4, one network hop.
4. A maintained quote re-pegs itself. Same tick, but the order it moves was already resting.
5. A resting entry, stop, target or TWAP slice fills. Zero.

Anything a user calls "high frequency" lives at 4 and 5. Anything a user calls "swing trading"
lives at 1 and 3. **The same machinery serves both**, which is why this is one product and not
two.

### 1.4 The one change that makes tier 2 honest

Replace the runner's REST poll with the websocket the trading surface already runs.

- `src/trade/feed-ws.ts` exists, is subscribed at construction, handles snapshots, heartbeats and
  reconnects, and is the app's single view of the market.
- `src/runner/host.ts` currently reads `src/runner/feed.ts` on a 2,000 ms timer and pushes
  `{cmd:'book'}` to the child. Change `pumpOnce` to be driven by `feed.onUpdate` from the
  websocket rather than by a timer, keeping the same IPC message so the child is untouched.
- Keep `src/runner/feed.ts` as the declared REST fallback when the socket is down, which is what
  the trading surface spec already requires of every read path.
- Keep the serialised tick. `runner/main.ts` documents why (eight concurrent ticks each truthfully
  answering the same envelope question), and a faster feed makes that reasoning more important,
  not less.

Target after the change: mark change to intended action under 50 ms, intended action to signed
order under 5 ms, both inside the existing budget.

**Do not lower the 250 ms interval as part of this.** A faster loop on stale data is the defect; a
fresh feed on a 250 ms loop is already an order of magnitude better than today. Event-driving the
tick off the feed rather than the timer is the follow-up, and it should be measured before it is
built.

---

## 2. Decision: the primitive set

Six objects. Every one already exists in the codebase, which is the point: the existing grammar
and the existing mandate cover both frequencies once three fields are added to them.

| # | Primitive | Where it lives now | What it is |
|---|---|---|---|
| 1 | **Instrument** | `src/market/catalog.ts`, `src/analysis/*`, the chart | one perp market plus every measurement taken on it. The agent's eyes. |
| 2 | **Mark** | `src/drawings.ts`, `Ref` in `src/strategy/grammar.ts` | a trend line, level, zone or indicator handle. **The executable reference**: one object the human sees, the agent names and the bot triggers off, by id. |
| 3 | **Program** | `src/strategy/grammar.ts` | the strategy as a closed-grammar document. Rules of conditions and actions. No code, no address, no verb that moves value off the venue. |
| 4 | **Mandate** | `src/rails/mandate.ts`, `src/strategy/envelope.ts` | the bounded standing authority a human clicked: program hash, symbol, caps, expiry, permitted verbs. Also the running instance, deliberately the same object. |
| 5 | **Position** | `src/trade/feed-ws.ts`, `src/trade/state.ts` | venue truth. Read-only on the agent's surface, and it stays that way. |
| 6 | **Order** | same | venue truth, including resting limits, triggers and TWAPs. Read-only on the agent's surface. Placed only by a mandate rule or by a human button. |

### 2.1 Killed, with the reason each failed to earn its place

- **Bracket.** Already expressible. A rule whose `then` is `[open, set_stop, set_target]` is a
  bracket, and `worstCaseUsd` in `src/strategy/render.ts` already pairs stops to opens **per
  rule** precisely so a bracket is the unit it prices. A `Bracket` object would be a second name
  for a shape the grammar has.
- **Schedule.** Not an object; a missing condition. The original trading design listed
  `time: after, before, or inside a UTC session window` and it was never built. It becomes
  `{ op: 'clock' }` in the existing grammar (section 3.2). Anything a Schedule object would hold,
  a rule holds better, because the human reads it in the same English as everything else.
- **Alert.** Already expressible, and the catalog's fourth worked example is literally it: a
  mandate with `maxNotionalUsd: 0` and `allowedActions: ['notify']`. A watch-only mandate is a
  first-class alert with an expiry, an audit trail and a human click behind it.
- **Basket.** Refused, not deferred. `checkEnvelope` halts on a symbol mismatch, one mandate is
  one symbol, and cross-symbol strategy is explicitly out of scope in the trading design spec. A
  basket would need a second envelope shape and a second halt semantic. What a basket actually
  wants is a **portfolio ceiling**, and that is a policy number rather than an object: see
  `maxArmedMandates` and `maxAggregateNotionalUsd` in section 5.
- **Session.** Exists already and is not a trading object. `src/agents.ts` holds the seat,
  `src/mcp.ts` heartbeats it. An agent session has no relationship to a mandate's lifetime, and
  section 5.10 turns that into a guarantee rather than a gap.

---

## 3. Decision: the grammar extension

Four additions and one new envelope field. Every one is justified against "why can the existing
grammar not express this", and every one keeps the two habits stated at the top of
`src/strategy/grammar.ts`: identifiers no address fits in, free text with no control characters
and no semicolons.

### 3.1 A relative Ref

```ts
| { kind: 'offset'; from: 'mark' | 'entry'; bps: number }
```

`bps` is signed, finite, `|bps| <= 5000`.

**Why the grammar cannot express this today:** every `Ref` resolves to a price that is either
fixed (`price`), or moves with time (`drawing`), or moves with a computed series (`indicator`).
**None of them moves with the market.** So "rest a bid five basis points under mark" and "stop one
percent under my entry" are both unwritable, and those two sentences are most of what a trader
means by a working order. This is the highest-value addition in the document: it is what makes
quoting, re-pegging and mark-relative stops all expressible with no new verb.

Resolution belongs in `src/runner/main.ts` `resolveRef`, which already holds `book.markPx`, and in
the pure `MarketState.resolveRef` injected in `src/strategy/evaluate.ts`. `from: 'entry'` resolves
to null while flat, which the evaluator already treats as a false condition rather than a throw.

Rendering, in `src/strategy/render.ts`: `mark -5 bps`, never a resolved number. Same rule the
drawing ids already follow, and for the same reason: a number on the approval screen is stale by
the time it is read, and it hides which thing the strategy is actually watching.

Not included: `from: 'best_bid' | 'best_ask'`. Those need a `bbo` subscription the runner does not
have, and `postOnly` already covers the "do not take" intent. Named, not built.

### 3.2 Two conditions

```ts
| { op: 'clock'; fromUtc: string; toUtc: string }        // "HH:MM", inclusive of from, exclusive of to
| { op: 'resting'; side: 'buy' | 'sell' | 'any'; cmp: 'gt' | 'lt' | 'eq'; count: number }
```

**`clock`** is the condition the original spec listed and the build dropped. `elapsed` measures
from arm or from entry and cannot express "only the London open" or "flat before the funding
print". `fromUtc` and `toUtc` are `/^([01]\d|2[0-3]):[0-5]\d$/`, a window that wraps midnight when
`to <= from`, and UTC only, because a timezone name is a free-text field on a surface that refuses
free-text fields.

**`resting`** is what any maintain-a-quote loop needs and it also closes a defect that has already
cost money. `src/strategy/envelope.ts` records the incident in its own comment: a rule reading
"when position is long: set stop at 1860" fired on every tick and placed ten identical trigger
orders in ten seconds. The workaround today is `once: true` or a cooldown, neither of which asks
the real question. `when resting sell eq 0: set_stop ...` asks it.

`count` is `z.number().int().min(0).max(64)`. Resolution needs the child to hold the working order
list, which today lives only in the app (`src/trade/service.ts` reads it off the feed). Push it
over the existing IPC as `{cmd:'orders'}` beside `{cmd:'book'}`, from the same feed, so there is
still exactly one view of the venue in the process tree.

### 3.3 A maintained limit entry, and a TWAP entry

```ts
// Entry, limit variant, one new optional field:
{ type: 'limit'; ref: Ref; postOnly?: boolean; maintain?: { refreshBps: number } }

// Entry, new variant:
| { type: 'twap'; minutes: number; maxSlippageBps: number; randomize?: boolean }
```

**`maintain` rather than a `quote` verb.** A `{ do: 'quote' }` action was considered and refused:
it would duplicate `open`'s side, size and borrowed multiple, add a verb to `allowedActions`, add
a branch to `checkEnvelope`'s `placesOrder` and `addedNotionalUsd`, and add a line to
`src/strategy/catalog.ts` ACTIONS, all to express something `open` already expresses. One optional
field on the limit entry is the smaller change and it composes: `open`, `add` and `reduce` all
become maintainable for free.

Semantics: when `maintain` is present the runner keeps the order alive at `ref` instead of placing
it once. When `|mark - restingPx| / mark` exceeds `refreshBps`, the runner re-pegs with
Hyperliquid's `batchModify` rather than cancel-then-order, so one re-peg is one action rather than
two. `refreshBps` is `z.number().int().min(5).max(1000)`; the floor of 5 exists because a re-peg
tighter than that is thrash rather than a strategy. A maintained order is withdrawn by
`cancel { which: 'entries' }`, by the mandate expiring, or by the supervisor.

**Every re-peg counts against `maxOrdersPerMin`.** `placesOrder` in `src/strategy/envelope.ts`
already counts `set_stop` and `set_target` for exactly this reason: a trigger is an order, the
venue counts it, so we count it. A re-peg is an order by the same argument. The catalog must tell
the agent to size `maxOrdersPerMin` for the re-peg rate rather than for the rule rate, because
that is the one number a quoting program gets wrong.

**TWAP** is tier 3 in one field. It is the only way to fill size larger than the visible book
without the runner slicing the order itself, which would put slicing logic in the hot path and
spend the whole order-rate budget on one entry. `minutes` bounds are NEEDS-VERIFICATION
(section 9).

### 3.4 One new envelope field

```ts
// src/strategy/envelope.ts, type Mandate
maxOpenOrders: number;
```

**Why:** `maxOrdersPerMin` bounds the rate and the venue bounds the absolute count at a thousand.
Neither bounds what a maintained quote plus a stop-stacking bug leaves resting over an eight-hour
mandate. A count cap is the missing bound and it is cheap: `RunState` gains `openOrders: number`,
fed by the same `{cmd:'orders'}` push that `resting` needs, and `checkEnvelope` refuses (halting,
like every other envelope breach) when a `placesOrder` action would take the count past it.

Default suggested to the agent by `mandate_catalog`: 8. Hard ceiling in the grammar: 64.

### 3.5 Named, not built

- `{ op: 'funding'; cmp; hourlyBps }`. `MarketCtx.fundingRateHourly` is already on the payload,
  and a carry strategy is a legitimate low-frequency shape. It is third in line behind `clock` and
  `resting` and adds no capability those two do not.
- `Ref` from `best_bid` / `best_ask`, which needs a `bbo` subscription.
- Cost-to-fill from `l2Book`, which the trading surface spec already named as the next thing to
  build and which is the right input for choosing `maxSlippageBps`.

---

## 4. Decision: the MCP tool surface

### 4.1 The conventions this follows

Read off `src/mcp.ts` and matched exactly.

- Registration goes through one of `registerRead` (`op: 'read'`), `registerView` (`op: 'view'`),
  or `registerPropose` (`op: 'propose'`, with a `ProposeKind`). One new registrar is added, for
  one tool, in section 4.4.
- Names are snake_case and carry their surface as a prefix. The mandate family becomes
  `mandate_*`, matching the existing `mandate_catalog`, even where the object is a Program: the
  catalog already set that precedent and one prefix beats two.
- Every read description ends `Read-only, changes nothing.`
- Every view description ends with `TRADE_ANSWER`.
- Every propose description ends with `CANNOT_APPROVE`.
- Arguments are enumerated zod fields, never a free-form record. `tests/injection.test.ts` walks
  schema property names looking for somewhere an address could be smuggled, and it cannot see
  inside an open bag. Batch tools name every key for the same reason.
- No argument anywhere accepts an address, a URL or a destination.

Today: 39 registered tools (18 read, 12 view, 6 propose, plus `skill`, `switch`, `watch`). This
adds three. 42.

### 4.2 The complete new and changed surface

| Tool | Op | Purpose | Policy path |
|---|---|---|---|
| `mandate_catalog` | read (exists) | the grammar and worked examples | none |
| `mandate_check` | read (**new**) | validate a program, render it to English, price its worst case, without proposing anything | none |
| `mandate_replay` | read (**new**) | run the pure evaluator over loaded history and report which rules would have fired when | none |
| `propose_mandate` | propose (exists) | arm a bot | `evaluateRail`, then the `land()` carve-out: always a human click |
| `mandate_tighten` | **tighten (new op)** | shrink a live mandate's own bounds, never widen them | none by construction; monotonic check in code |
| `trade_read` | read (exists, **extended**) | the whole situation, now with events since a cursor | none |
| `trade_batch` | read (exists, **extended**) | many reads in one round trip, now with `events` and `budget` | none |
| `trade_overlay` | view (exists, **extended**) | one new overlay name, `quotes` | none |

Nothing else changes. In particular **no propose tool is added.** `propose_mandate` remains the
only door through which an order can ever reach the venue, and that is a decision: an app with
`propose_order` beside `propose_mandate` has two trust paths and the cheaper one wins every time.

### 4.3 The two new reads

Both are reads in the strict sense: no keys, no venue, no money, no policy verdict, no proposal,
no click. They exist because **iterating on a program currently costs a human click per attempt**,
which is the worst thing about the agent's experience of this app today.

```ts
registerRead(
  'mandate_check',
  [
    'Checks a program BEFORE you propose it. Returns the same English and the same worst case the',
    'human will read on the approval screen, plus the allowedActions the app would derive, plus the',
    'program hash. Costs nothing, waits on nobody, and can be called as many times as you like.',
    '',
    'Call this until it comes back clean, THEN call propose_mandate. A refused proposal spends a',
    'human click; this does not. Read-only, changes nothing.',
  ].join(' '),
  {
    program: z
      .object({ symbol: z.string(), rules: z.array(z.unknown()) })
      .passthrough()
      .describe('{ symbol, rules: [...] }. Call mandate_catalog for the grammar.'),
    maxNotionalUsd: z.number().optional(),
    maxLeverage: z.number().optional(),
    maxOrdersPerMin: z.number().int().optional(),
    maxOpenOrders: z.number().int().optional(),
    maxLossUsd: z.number().optional(),
    expiresAt: z.string().optional(),
    allowedActions: z.array(z.string()).optional(),
  },
);
```

Returns:

```ts
{
  ok: boolean,
  errors: string[],                    // exactly what validateProgram returns
  english: string[],                   // exactly what renderProgram returns
  programHash: string,
  worstCaseUsd: number | null,         // null when no envelope numbers were supplied
  derivedAllowedActions: string[],     // actionVerbs(program), before intersection
  warnings: string[]                   // see below
}
```

`warnings` is the part that earns the tool. Every one is a thing the app knows and the agent
cannot see from a schema:

- `"no set_stop anywhere: this program opens a position nothing at the venue will close"`, which
  after section 5.16 is an error rather than a warning
- `"allowedActions you asked for do not include close: this bot cannot get flat"`, the trap
  `src/strategy/catalog.ts` already names as the one that costs a position rather than a refusal
- `"rule 'x' is a state condition with no once and no cooldown: it fires on every tick"`
- `"maxOrdersPerMin 4 with a maintained quote at refreshBps 10: expect the rate limit to bite"`
- `"maxLossUsd exceeds maxNotionalUsd"`, `"expiresAt is in the past"`, `"expiresAt is more than
  24h out"`, mirroring the refusals in `proposeMandate` so the agent learns them for free

Implementation: pure composition of `validateProgram`, `renderProgram`, `worstCaseUsd`,
`actionVerbs` and the checks already written in `src/proposals.ts` `proposeMandate`. New file
`src/strategy/check.ts`, so `proposals.ts` and this tool call the same function and cannot drift.

```ts
registerRead(
  'mandate_replay',
  [
    'Runs a program against candles already loaded, and reports which rules would have fired, when,',
    'and at what price. The evaluator is pure, so this is the same code that will run live.',
    '',
    'This is NOT a backtest and does not answer whether a strategy makes money. There is no fee',
    'model, no slippage model, no order book, and no fill uncertainty: an order is assumed filled at',
    'the reference price. It answers one question only, and it is the question that actually goes',
    'wrong: do my conditions fire where I think they fire. Read-only, changes nothing.',
  ].join(' '),
  {
    program: z.object({ symbol: z.string(), rules: z.array(z.unknown()) }).passthrough(),
    product: z.string().optional().describe('omit to use whatever the chart is showing'),
    granularitySec: z.number().int().optional(),
    bars: z.number().int().optional().describe('how far back, default 500, maximum 5000'),
  },
);
```

Returns:

```ts
{
  bars: number,
  from: string, to: string,            // ISO
  fired: { t: number; ruleId: string; actions: string[]; markPx: number }[],
  counts: Record<string, number>,      // per rule id, so a rule that fired 900 times is obvious
  ended: 'flat' | 'long' | 'short',
  invalidatedAt: number | null,
  notes: string[]                      // "no fees, no slippage, refs to drawings resolved at each bar"
}
```

**Why this is worth building and is not scope creep:** the trading design spec already states the
property that makes it nearly free. "The evaluator produces intended actions. Pure and
deterministic: same inputs, same output, which is what makes it replayable against history." The
replay is three loops over `evaluate()` with a `MarketState` built from candles the chart has
already loaded. It is the only honest way to check a program before it holds money, and the spec
says so in those words.

The `notes` array is not decoration. This surface's law is that it returns measurements and never
conclusions, and a replay that did not say what it was not modelling would be the first conclusion
this app ever shipped.

### 4.4 `mandate_tighten`, the one new write

**Decision: the agent gets exactly one write into a live mandate, and it can only shrink it.**

```ts
// A fourth registrar beside registerRead / registerView / registerPropose.
function registerTighten(name: string, description: string, shape: Record<string, z.ZodTypeAny>): void {
  server.registerTool(name, { description, inputSchema: shape }, async (args) =>
    proxy({ op: 'tighten', args }),
  );
}

registerTighten(
  'mandate_tighten',
  [
    'Shrinks the bounds of a mandate that is already armed. It can ONLY make a mandate smaller,',
    'shorter or more restricted, never larger, longer or freer, and a call that would loosen any',
    'field is refused whole rather than partly applied.',
    '',
    'This is your brake, and it is the only one you have. You cannot arm, close, cancel, flatten or',
    'disarm: those are the human\'s controls. What you can do is take back authority a human granted',
    'you. Setting expiresAt to a moment a minute from now is how you stop a bot whose thesis has',
    'died: the supervisor closes the position and disarms at expiry.',
    '',
    'The reason is required, is shown to the human tagged [agent], and is written to the audit log.',
    'Every change is reported on the trading window as it happens.',
  ].join(' '),
  {
    id: z.string().describe('the mandate id from trade_read'),
    reason: z.string().describe('one line the human reads, 200 characters at most'),
    maxNotionalUsd: z.number().optional(),
    maxLeverage: z.number().optional(),
    maxOrdersPerMin: z.number().int().optional(),
    maxOpenOrders: z.number().int().optional(),
    maxLossUsd: z.number().optional(),
    expiresAt: z.string().optional(),
    dropActions: z.array(z.string()).optional().describe('verbs to REMOVE from allowedActions'),
  },
);
```

Returns the mandate row as it now stands, so no follow-up read is needed.

**Monotonicity, enforced in one new pure function** `src/strategy/tighten.ts`:

```ts
export function tighten(m: Mandate, patch: TightenPatch):
  | { ok: true; mandate: Mandate }
  | { ok: false; refusals: string[] };
```

Every numeric field must be strictly less than the current value. `expiresAt` must parse and must
be strictly earlier than the current one. `dropActions` may only remove verbs already present, and
may never remove a safety verb (`close`, `reduce`, `cancel`, `stand_down`, `notify`), because a
tighten that strips the exits is the one shape of this call that could trap a position rather than
release it. `programHash` and `symbol` are not patchable at all: changing either would make the
running thing a different thing from the one that was read, which is what the hash check in
`checkEnvelope` exists to catch.

Halt, never clamp. A patch with one loosening field is refused whole and lists every refusal. Same
property as `checkEnvelope` and for the same reason: silently applying a different, smaller change
is still applying something nobody asked for.

**Policy path: none, and that is the argument.** Every gate in this app exists to stop authority
being taken that a human did not grant. This call can only give authority back. `disarm` already
works this way (`src/runner/host.ts`: "Disarm never fails and never waits on approval"), the
envelope already lets safety verbs through after a breach, and the kill switch is already
described as a trap if it could block a human closing a position. Tightening is the same class of
act, so it is gated the same way, which is to say not at all.

**The tension, stated rather than hidden.** `2026-08-12-trading-surface-design.md` says the agent
"deliberately cannot close a position, cancel an order, flatten, or disarm" and that "an
architecture rots at its exceptions". `mandate_tighten` is not any of those four verbs and does
not add a fifth hand on the wheel: the agent still cannot cause an order. What changes is that an
agent watching a thesis die at 3am can shrink the envelope instead of doing nothing until a human
wakes up. That trade is worth taking, and the reason it is safe is structural rather than
promissory: a monotonic shrink has no reachable state a human did not already approve.

**Wire path:** `src/mcp.ts` new registrar, one tool. `src/server.ts` gains `if (op === 'tighten')`
beside the five existing ops, behind the same seat check, the same origin check and the same
`audit.append('tool_call', ...)` line every other op passes. `src/trade/service.ts` gains a
`tighten` method beside `action`. `src/runner/host.ts` gains `retighten(id, mandate)` which
updates its `armed` map and sends `{cmd:'retighten', id, mandate}`. `src/runner/main.ts` replaces
`a.mandate` on receipt. A new `LogEvent` type, `mandate_tightened`.

### 4.5 The extensions to existing tools

**`trade_read` gains `sinceMs`.** Today an agent returning after ten minutes has to reconstruct
what happened from positions and fills. The runner already keeps a 200-entry event ring
(`src/runner/host.ts`, `recent`) and `src/trade/service.ts` already walks it for `lastRule` and
`haltedReason`. Expose it:

```ts
{ symbol: z.string().optional(), sinceMs: z.number().optional() }
```

adding `events: { atMs, type, mandateId, ruleId?, message }[]` to the payload, newest first,
capped at 100. One call answers "what did I miss", which is the read a low-frequency agent makes
every single session.

**`trade_batch` gains two ops.** The enumerated arg object already carries `sinceMs` and `limit`,
so no schema change is needed, only the op list:

- `events`, returning the same array `trade_read` now returns
- `budget`, returning `{ ordersLastMin, ordersPerMinCap, tokensLeft, exitReserve, addressWeightUsed, addressWeightBudget }`

`budget` is what lets an agent size `maxOrdersPerMin` against reality instead of against a guess,
and it is the read that pairs with the rate limiter in section 5.18.

**`trade_overlay` gains `quotes`** to the enum, so a maintained order draws differently from a
one-shot resting order. Same overlay list, one new name.

### 4.6 What is deliberately absent from the agent's door

Absent rather than guarded, which `src/mcp.ts` already argues is the stronger property because a
check can be wrong and a capability that was never registered cannot be called.

- No `propose_order`, `propose_close`, `propose_bracket`. One door.
- No close, cancel, flatten or disarm. Human controls on `/api/trade/action`, token-gated,
  unreachable from `/api/mcp`.
- No pause. See section 6.3.
- **No wait, watch, subscribe or poll tool.** A tool call that blocks for thirty seconds burns the
  agent's turn, holds the seat, and is the exact shape of the thing that cannot work at this
  latency. The agent's answer to "tell me when X" is a watch-only mandate with a `notify` rule,
  which runs at tier 2 and costs the agent nothing while it waits.
- No `mandate_loosen`, and no argument on `mandate_tighten` that could act as one.

---

## 5. Decision: safety

Every limit below lives in code. None lives in a prompt. Existing limits are listed with their
current values read off the repository; new ones carry a proposed number and a file.

### Already enforced (verified in this tree)

1. `maxPerTransactionUsd` $10,000, `maxPerSessionUsd` $25,000, `humanClickAboveUsd` $100.
   `src/policy/file.ts` `defaultPolicy()`. A mandate is priced at `maxNotionalUsd` through
   `MandateDraft.amountUsd`, so all three already bind it.
2. Grammar ceilings: borrowed multiple 1 to 40, slippage 0 to 1000 bps, 32 rules, 8 actions per
   rule, 8 branches per and/or, condition depth 6, symbol 12 chars, identifiers 32 chars, display
   text 200 chars with no control characters and no semicolons. `src/strategy/grammar.ts`.
3. Per-mandate envelope: `maxNotionalUsd`, `maxLeverage`, `maxOrdersPerMin`, `maxLossUsd`,
   `expiresAt`, `allowedActions`, and a program-hash identity check, all in the same function that
   signs. `src/strategy/envelope.ts`.
4. `maxLossUsd <= maxNotionalUsd`. `src/proposals.ts:1013`.
5. Arming always needs a human click, on every network, gate on or off. `src/proposals.ts`
   `land()`, two separate carve-outs: the `needs_approval` one and the downgrade of `allow` that
   was added after the first live arm executed with nobody clicking.
6. Supervisor flattens at 1% from liquidation, on mark, every tick. `src/runner/main.ts`.
7. In-flight notional counted before the network call, released by observed position growth, TTL
   30,000 ms. `src/runner/main.ts`. This is the fix for the incident where a $60 cap held $238.
8. Kill switch checked every tick in the child, pushed over IPC, and enforced by `host.stopAll()`
   which SIGKILLs after 3 s regardless of the child's health.
9. The API wallet cannot withdraw, transfer or approve another agent. Enforced by the venue's
   signing split, not by our code. `src/runner/keys.ts`, `src/runner/host.ts`.

### New, with numbers and files

10. **Max concurrent armed mandates: 3.** `policy.trading.maxArmedMandates`.
    File: schema and default in `src/policy/file.ts`; enforced in `src/policy/engine.ts` in the
    `mandate_arm` branch of `evaluateRail`, which needs `EngineCtx` to gain
    `armed: { count: number; aggregateNotionalUsd: number }`.
    **Why:** today nothing caps the aggregate. Three separate $200 mandates are $600 of standing
    authority no single number on any screen ever states, and `maxPerSessionUsd` is a rolling
    window rather than a live position cap. Enforcement must be at the engine, because `approve()`
    re-runs the engine at click time and that is the only moment the live count is knowable.

11. **Max aggregate armed notional: $2,500 on testnet, $250 on mainnet first run.**
    `policy.trading.maxAggregateNotionalUsd`. Same file, same branch.
    **Why:** the number a human should be able to read as "the most every bot I have armed can be
    holding at once". It is the portfolio ceiling that replaces the Basket object killed in 2.1.

12. **Hard ceiling on the borrowed multiple: 10x.** `policy.trading.maxLeverage`.
    File: `src/policy/file.ts`, checked in `evaluateRail` against `MandateDraft.maxLeverage`, and
    again at arm time in `src/rails/mandate.ts` `execute()`.
    **Why:** the grammar's 40 exists only to refuse what no venue would accept, which is a
    different job. 40x on a small account is a liquidation on a 2.5% move, and the mainnet move
    makes that a real number rather than a testnet one.

13. **Max open positions: 3.** `policy.trading.maxOpenPositions`.
    File: the number in `src/policy/file.ts`, but the enforcement in `src/strategy/envelope.ts`,
    with `RunState` gaining `openPositionCount: number`. `checkEnvelope` refuses (halting) an
    `open` when the account already holds that many positions and this symbol is not one of them.
    **Why the envelope and not the engine:** the engine rules at propose time on a world that has
    since moved. The envelope is the only check that runs in the same function as the signature,
    which is the property the whole design leans on.

14. **Daily account loss limit: $250.** `policy.trading.maxDailyLossUsd`, measured from 00:00 UTC
    across every mandate and every manual fill.
    File: number in `src/policy/file.ts`; counter persisted beside the audit log in
    `src/trade/state.ts`; enforced in `src/runner/main.ts` `supervise()`, which already runs every
    tick regardless of program logic. On breach: flatten everything, disarm everything, and refuse
    every new arm until a human clears it in the window.
    **Why:** each mandate has its own `maxLossUsd` and nothing sums them. Three mandates at $50
    each is $150 with no single number that says stop, and the supervisor is the only place that
    sees all three.

15. **Mandate duration ceiling: 24 h, 8 h on mainnet.** `MAX_MANDATE_MS` in `src/proposals.ts`,
    checked in `proposeMandate` beside the existing `expiresAt` checks.
    **Why:** `src/strategy/catalog.ts` already advises "keep it hours, not weeks" and advice is not
    a limit. Standing authority that outlives the human's memory of granting it is the shape of the
    problem.

16. **A program that opens with no stop anywhere is refused.**
    File: `export function unstopped(p: Program): boolean` in `src/strategy/grammar.ts`, called
    from `src/proposals.ts` `proposeMandate` and from `src/strategy/check.ts`.
    Rule: a program containing `open` or `add` and containing no `set_stop` in any rule is refused.
    Checked against the four existing catalog examples: examples 1, 2 and 3 all carry a `set_stop`,
    and example 4 opens nothing, so the rule breaks none of them.
    **Why:** the trading design spec says "a mandate that permits `open` without a stop is a
    mandate the approval screen must argue with", and today the argument is that `worstCaseUsd`
    returns the whole `maxNotionalUsd`, which is a big number a human can click past. More
    importantly, a `set_stop` is the only thing this app puts on the venue that survives the app
    dying. Without one, "the runner crashed" and "the position is unmanaged" are the same event.

17. **Dead-man switch: `scheduleCancel` at T+60 s, re-armed every 20 s.**
    File: `buildScheduleCancelAction` in `src/hl/exchange.ts`; the heartbeat in
    `src/runner/main.ts`, started on the first arm and stopped when nothing is armed.
    **What it does:** if the runner stops heartbeating for any reason (crash, SIGKILL, machine
    sleep, network partition), Hyperliquid cancels every resting order on the account within 60 s.
    That closes the hole where a maintained quote or a resting entry outlives the process managing
    it and fills into a position nothing is watching.
    **What it does not do, said plainly:** it cancels orders, not positions. A position open when
    the runner dies stays open, protected only by whatever trigger orders are resting, which is
    exactly why limit 16 exists.
    Lead time and any volume gating on `scheduleCancel` are NEEDS-VERIFICATION (section 9).

18. **Local rate budget with a reserved exit allowance.**
    File: new `src/runner/budget.ts`, spent in `src/runner/main.ts` `place()`.
    Numbers: token bucket, capacity 60, refill 60 per minute, process-wide across every armed
    mandate. An order costs 1, a `batchModify` re-peg costs 1, a cancel costs 0.5. **Entries may
    spend down to 12 tokens (a 20% reserve); exits and cancels may spend to 0.**
    **Why:** the trading design spec states the requirement and it was never built: "Cancels get a
    larger allowance than orders on purpose, so a rate-limited account can still get flat. The
    runner budgets against this and reserves headroom for exits." Today `maxOrdersPerMin` is
    per-mandate only, so three mandates at 6/min can spend 18/min with nothing summing them.
    A refused entry does not halt the mandate; being briefly too fast is a pace problem, which is
    the same reasoning `checkEnvelope` already applies to its own rate refusal.
    The venue's address-level budget (one request per USDC of cumulative volume, 10,000 buffer) is
    **reported** through `trade_batch op:'budget'` and not enforced, because at these sizes it will
    not bind and a limiter that never fires is a limiter nobody debugs.

19. **Maintained-order thrash floor: `refreshBps >= 5`.** `src/strategy/grammar.ts`.
    **Why:** a re-peg tighter than 5 bps on a liquid perp is a loop, and it will consume limit 18
    before it consumes anything else.

20. **`maxOpenOrders` per mandate, default advised 8, grammar ceiling 64.** Section 3.4.

### 5.10 What happens when the agent disconnects mid-strategy

**Decision: nothing happens to the trade, and that is the design rather than a gap.**

The chain, in order:

1. The MCP proxy's `bye` fires on any ordinary exit, or its 5,000 ms heartbeat lapses and
   `src/agents.ts` sweeps the seat. Worst case is about twelve seconds.
2. The window's presence light goes out. Nothing else on the screen changes.
3. **The armed mandate keeps running, untouched.** The agent was never in the execution path, so
   its absence is not an event the runner can even observe. This is the three-clock split paying
   for itself, and it is the property that makes the whole architecture worth having: an agent
   that can be killed mid-trade without the trade noticing.
4. The mandate ends at whichever of its own bounds arrives first: a program rule, `expiresAt` (now
   capped at 24 h), `maxLossUsd`, the 1% liquidation distance, the daily loss limit, or the kill
   switch.
5. If the **runner** dies rather than the agent: `src/runner/host.ts` already records every armed
   mandate as disarmed on child exit, because "leaving a mandate listed as live after its executor
   is gone would misreport the safety state". The venue then cancels every resting order within
   60 s through `scheduleCancel`. Positions survive on their resting triggers.
6. If the **whole app** dies: identical to 5 without the bookkeeping. The venue-side timer is the
   only thing still running, which is precisely why it is a venue-side timer.

The one honest gap: a position with a resting stop survives correctly; a position whose stop was
about to be placed on the next tick does not. Limit 16 narrows that window to the tick between the
fill and the stop, and nothing can close it entirely short of Hyperliquid accepting an entry and
its stop as one atomic action.

---

## 6. Decision: what a bot IS

### 6.1 The definition

**A bot in Phosphor is an armed Mandate: one Program in the closed grammar, bound by SHA-256 hash
to one Envelope that a human clicked, hosted as one state machine inside the single runner child
process.**

It is not a saved sequence of MCP calls, because a saved sequence would run at the agent's clock
and would put the model back in the execution path. It is not code, because the trading design
spec already refused code on three grounds and the strongest was that you cannot bound its worst
case before running it. It is a document, and the document is the same artifact three parties
read: the agent writes it, the human approves it in English, the runner executes it.

The hash is what makes that a fact rather than a claim. `src/runner/main.ts` derives `programHash`
from the program the child is holding, on every tick, and `checkEnvelope` refuses everything on a
mismatch. "The thing running is the thing that was read" is an assertion the code makes about
itself.

### 6.2 The lifecycle

| Phase | Who | What happens | Cost |
|---|---|---|---|
| **Draft** | agent | writes a Program, checks it with `mandate_check`, rehearses it with `mandate_replay` | nothing, unlimited, no click |
| **Arm** | human | `propose_mandate` to `evaluateRail` to the `land()` carve-out to pending to a physical click to `mandateRail.execute()` to `host.arm()` to `{cmd:'arm'}` | one click, always |
| **Run** | app | supervisor first, then evaluate, then `checkEnvelope` per action, then sign. 250 ms, and one network hop after 1.4 | none |
| **Tighten** | agent | `mandate_tighten`, monotonic shrink only | none |
| **Halt** | app | envelope breach with `halt: true`, expiry, `maxLossUsd`, 1% from liquidation, daily loss limit, kill switch. All flatten and disarm. | none |
| **Kill** | human | DISARM per row, FLATTEN for everything, KILL switch | none |

### 6.3 There is no pause, and that is a decision

**Because Y:** a paused bot holds standing authority a human granted while producing no observable
behaviour, which is the worst possible state to have on a screen whose whole job is showing what
has authority right now. A human glancing at the window would see an armed mandate and could not
tell whether it is working or asleep.

Everything a pause is wanted for is already expressible:

- "stop during the news print" is `{ op: 'clock' }` guarding the entry rules
- "stop but keep the position" is `stand_down`, which the runner treats as flatten-and-disarm (see
  the defect in section 8.1)
- "stop taking new risk" is `mandate_tighten { maxNotionalUsd: <current position size> }`, which
  refuses every `open` and `add` while leaving every exit path open
- "stop entirely" is DISARM, a human click that never fails and never waits

That fourth line is the pause. It is called disarm and it is one button.

### 6.4 How a human sees it running, and stops it

All of this exists on `/trade` and needs the two changes in section 7.

- **MANDATE panel:** the program in English (the same lines the approval screen showed), the four
  bounds filling up, the last rule that fired with its timestamp, and the halt reason if it halted.
  `[ DISARM ]` on every row.
- **Chart overlays:** entry line, liquidation line, the mandate stop-out wall drawn as a real
  price, working stops, targets, resting orders, fills as marks.
- **BOOK panel:** positions with working orders nested underneath them, because a stop is a
  property of a position rather than an independent object.
- **Status bar:** mark, funding, equity, free collateral, feed health, `[KILL]`.
- **LOG panel:** audit lines, refusals in red.

Three stop controls, all on `/api/trade/action`, all token-gated, none reachable from `/api/mcp`:
**DISARM** one bot, **FLATTEN** every bot and every position, **KILL** which refuses every write
app-wide and is checked in the child on every tick.

---

## 7. Decision: one screen for both frequencies

The question is how a surface built for one swing trade survives a program that fires forty times
an hour, without becoming two apps.

**The answer is that the panels do not change at all. Three rendering rules change.**

### 7.1 The four bounds are already the tempo gauge

The MANDATE panel draws four bars: notional, loss, orders-per-minute, time-to-expiry. Nobody has
to be told which frequency a bot is running at, because **which bar is moving says it**:

- a swing bot sits at 0 orders/min and its time bar is the only thing that moves
- a quoting bot pins its orders/min bar and its time bar barely moves

Same four bars, same panel, and a reader learns a bot's tempo from a glance without a mode switch,
a setting or a second page. This already exists and needs nothing built. It is the reason the
answer to this question is "one screen" at all.

### 7.2 A re-pegged order keeps its row

**Rule: order rows key on the rule that owns them, not on the venue's `oid`.**

A maintained quote at `refreshBps: 10` on a market moving 1% an hour cancels and replaces its
order several times a minute. Keyed on `oid`, every re-peg destroys a row and creates a new one,
and the BOOK panel becomes a slot machine. Keyed on the owning rule, the row persists and its
price ticks in place.

Implementation: `newCloid()` in `src/hl/exchange.ts` currently returns a random 128-bit hex. Change
it to pack a mandate ordinal and a rule ordinal into the high bytes and keep the rest random. Then
`Order.mandateId` and a new `Order.ruleId` come off the cloid with no lookup table, which also
makes fills attributable to the rule that caused them, which is the "why did this happen" question
the MANDATE panel's `lastRule` field is already trying to answer.

This is the surface spec's "numbers must not jitter" rule applied one level up, to rows.

### 7.3 The on-screen log coalesces; the audit log never does

**Rule: repeated rule fires collapse to one line with a count that updates. The append-only audit
log at `src/audit.ts` records every one of them, unchanged.**

A quoting bot writes forty `rule` events an hour. Rendered one per line, the LOG panel scrolls the
refusals and the policy lines (the ones a human actually needs) off the screen within minutes,
which turns a safety surface into noise. `quote-bid fired 12x, last 14:03:21` is one line that
means the same thing.

The audit log must not do this and the split matters: `src/audit.ts` is append-only and never
rewritten, and it is what the transcript is judged on. The screen is a view; the log is the
record. Collapsing the view is a rendering choice, and collapsing the record would be a lie.

### 7.4 Nothing else changes

No mode toggle, no second page, no HFT view. The two decisions the surface spec made about layout
hold at both frequencies and hold for the same reason: there is no order ticket because a human
clicking buy is the thing this app is not for, and working orders nest under their position
because a stop is a property of a position. Neither becomes less true at forty orders an hour.

---

## 8. Defects found while reading, worth fixing alongside

### 8.1 `stand_down` closes the position; the catalog says it does not

`src/strategy/catalog.ts` ACTIONS says `stand_down` means "stop acting and say why. **The thesis is
dead but the position is handled elsewhere.**"

`src/runner/main.ts` `tick()` does
`if (action.do === 'stand_down') { await flatten(id, action.reason); break; }`, and `flatten()`
places a market close if the position is not flat, then disarms.

So an agent that reads the catalog, writes `close` in one rule and `stand_down` in another
believing the position is handled by the first, gets the position closed twice: once by its own
rule and once by the flatten. On a live account that is a reversal, not a no-op.

**Decision: the runner's behaviour is right and the catalog text is wrong.** Closing is the safe
direction, `flatten` is what every other halt path does, and a `stand_down` that left a position
behind with no program watching it would be the worst state this app can produce. Fix the
sentence, not the code. Same fix in `src/strategy/render.ts`, whose `stand down: "reason"` line
should read as the halt it is.

### 8.2 The runner's advertised tick is faster than its data

Covered in 1.4. Worth restating as a defect because a comment saying "250 ms" beside a feed saying
"2,000 ms" will be read as a 250 ms system by the next person who touches it.

### 8.3 Mainnet

`src/runner/main.ts` carries `MAINNET_REFUSED` and refuses to build an exchange client when
`PHOSPHOR_HL_MAINNET === '1'`. The move to mainnet has to remove that guard, and removing it
should not be a one-line delete. `gateRequired()` already forces a click on mainnet and ignores the
config flag, which is the right shape. What should replace the refusal is the mainnet profile of
section 5: `maxAggregateNotionalUsd` $250, `maxLeverage` 10, mandate duration 8 h. A guard removed
and replaced with nothing is how a testnet convenience becomes a mainnet hole.

### 8.4 NEAR Intents one-way deposits are a safety property, not just a feature

1Click can now deposit into HyperCore from 35+ chains and cannot pull funds back out.
`propose_intents_deposit` already exists with an EVM-only chain enum and already refuses on a
testnet config. Nothing needs building. What is worth writing into the tool description is that
**the direction is the point**: an agent can help fund the trading account and structurally cannot
drain it, which is the same argument as the API wallet's signing split, arriving from the other
side.

---

## 9. NEEDS-VERIFICATION

Marked because they were not verifiable from this repository and no fetching was done.

1. **`scheduleCancel` constraints.** The minimum lead time the venue accepts, whether it is gated
   on account volume, and whether re-arming resets the timer or requires a cancel first. The design
   assumes T+60 s re-armed every 20 s; the numbers may need to change.
2. **TWAP bounds.** Minimum and maximum `minutes`, the slice interval the venue uses, whether
   `randomize` is a real field, and whether a TWAP counts as one order or n against the
   address-level rate budget. That last one decides whether TWAP is cheap or expensive in the
   bucket in limit 18.
3. **`batchModify` semantics for a re-peg.** Whether modifying a resting order preserves queue
   position, and whether a modify counts as one action or as a cancel plus an order against the
   rate limit. If it counts as two, `refreshBps` needs a higher floor.
4. **Per-position maintenance margin on a unified account.** The surface spec derives it as
   `positionValue / (2 * maxLeverage)` and notes there is no per-position field. Limit 13 does not
   depend on it; limit 14 does, through equity.
5. **Whether `maxOpenOrders` should count trigger orders.** The venue's thousand-order allowance is
   documented as including triggers; whether a TWAP's unsent slices count is not known here.

---

## 10. Build order

Each phase is independently shippable and leaves the tree green.

1. **Honest tier 2.** Websocket-drive the runner's book (1.4). Nothing else changes. Measure before
   and after; the number to beat is 2,000 ms.
2. **Rehearsal.** `src/strategy/check.ts`, `mandate_check`, `mandate_replay`. No new capability, no
   new risk, and it is the change that most improves what it is like to drive this app.
3. **The safety floor.** Limits 10 to 20, in order: policy schema, engine checks, envelope fields,
   supervisor daily loss, `unstopped`, `scheduleCancel`, `src/runner/budget.ts`. Ship this before
   the grammar extension, so the new expressiveness lands inside new bounds rather than beside
   them.
4. **The grammar extension.** `offset` Ref, `clock` and `resting` conditions, `maintain` on the
   limit entry, `twap` entry, `maxOpenOrders`. Catalog, render and injection tests move with it.
5. **The brake.** `src/strategy/tighten.ts`, the `tighten` op, `mandate_tighten`.
6. **The screen.** Cloid packing, row keying, log coalescing, the `quotes` overlay.
7. **Mainnet.** Remove `MAINNET_REFUSED`, land the mainnet policy profile, run the security-audit
   skill over the signer, the envelope, the tighten path and the new rate budget, since this is a
   wallet and a signer and that is the documented trigger.

Phases 1 through 3 are worth doing even if 4 through 7 are never built: they make what already
exists true.
