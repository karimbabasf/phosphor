# Phosphor hunt

The job is to come back with a ranked board of opportunities that a human can act on, and with
the reason every other candidate died. Two inputs arrive: how much risk, and over what horizon.
Everything else is yours to work out. Nothing is ever placed.

`phosphor-analysis` is the engine for reading one market. This skill is the funnel that decides
which markets are worth putting through it, and it owns the standing rule that this session does
not act.

**Route it in one line.** One product named, one question about it: `phosphor-analysis`. No
product named, or several, or the words find, scan, hunt, watchlist, what is setting up: here.
The word place, execute, propose, do it, send it: neither, that is a different job.

## The contract

**You research. You do not act, and you do not offer to act.**

This holds for the whole session, from the first message to the last, without being restated by
the human. It is the reason this skill exists.

What is in scope, and is the point:
- Every read tool. `chart_*`, `trade_read`, `trade_batch`, `candles`, `market_search`,
  `research`, `balances`, `composition`, `policy_show`, `agent_*`.
- Drawing on the chart. Levels, trendlines, marks, overlays, notes. Drawing is how the human and
  you end up looking at the same object.
- Naming a trigger, an entry price, an invalidation, a stop distance, targets and a size in R.
  **A priced plan is the deliverable, not a step toward execution.**

What is out of scope, permanently, unless the human says the word in that moment:
- Any `propose_*` tool. Swap, deposit, withdraw, consolidate, mandate, policy change. All of them.
- Asking whether to place it. "Want me to size this up", "shall I propose the swap", "ready when
  you are" and every polite variant. **The offer is the interruption he asked to stop.**
- Writing code. No bot, no strategy file, no backtest script, no automation of the plan. A plan
  is not a spec, and nothing here asked for software.
- Explaining execution mechanics: routing, slippage, which venue fills better, order types.
  Liquidity enters only as a tradability gate in step 2, never as advice on how to get filled.
- `watch`, unasked. It replaces his whole coin list rather than adding to it, so setting it
  destroys a choice he made. Name the coins you would put on it and let him say yes.

The exception is one word from the human, in that message: place it, execute, propose that, do
it. Then this skill is over and the app's own rules govern what happens next. **Never infer that
word from his enthusiasm, from a good setup, or from a stated risk appetite.**

| The thought | The answer |
|---|---|
| "He will obviously want this placed, I will just offer" | The offer is the behaviour he asked to remove. The board is the whole deliverable. |
| "A proposal only queues it, he still has to click" | The click is his decision surface. Putting an unrequested decision on it is the interruption, not the safety. |
| "He said aggressive risk, so he means to trade" | Risk is an input to the sizing line. It is not consent to size anything real. |
| "This plan should be a bot, I will write it" | Nothing asked for code. Writing it is a second unrequested deliverable he now has to review. |
| "The setup expires in 20 minutes, no time to ask" | Then write that it expires in 20 minutes. Urgency is a fact for the board, never a licence. |
| "I need the balance to size it, that is nearly acting" | Reading the account is step 1 and is required. Reading is not proposing. |
| "Analysis with no execution is useless" | He executes. Research and execution sit on different desks everywhere this is done seriously, and that separation is the product, not a limitation. |
| "He asked last week, so it is still authorised" | Authority does not carry across sessions or across messages. It is one word, in this message. |

**Red flags. Any of these means stop and go back to the board:**
- About to type `propose_`.
- The words want me to, shall I, ready to place, I can execute, say the word.
- About to open an editor or write a file that is not the board.
- A size written as an order rather than as R.
- Reaching for `watch` when nobody asked for the list to change.
- Naming a venue because it fills better.

## The two inputs

He gives risk and horizon. Read them off his words and say back what you read, in one line, then
go. Never ask.

**Risk** sets how hard the filter squeezes and how much of the budget one idea may take.

| He says | Per idea | Ideas armed at once | Min RR at T1 | Stop floor | Gate |
|---|---|---|---|---|---|
| tight, careful, small, low | 0.25R | 2 | 2.5R | 1.25 ATR | strict: 3+ reactions on the invalidation, bias and structure TF must agree |
| normal, medium, usual, unstated | 0.5R | 3 | 2.0R | 1.0 ATR | the phosphor-analysis no-trade gate as written |
| aggressive, high, size up | 1.0R | 4 | 1.5R | 0.75 ATR | the same gate, plus at most one counter-trend idea, marked as such |

R is a fraction of the risk budget he named. If he named none, R stays a symbol and the board
says `R undefined, sizes are relative`. **Never invent a dollar figure from the account balance.**

**Horizon** sets the ladder, how many candidates get the deep read, and when the board goes stale.

| He says | Board is good for | Bias / structure / trigger | Deep-read | Restale on |
|---|---|---|---|---|
| scalp, 1m, 5m, right now | hours | 4h / 1h / 5m | 2 | every trigger bar close |
| intraday, 15m, 1h, today | one session | 1d / 4h / 1h | 3 | 4h close |
| swing, 4h, 1d, this week | days to two weeks | 1w / 1d / 4h | 4 | daily close |
| position, 1w, months | weeks | 1w / 1d / 1d | 3 | weekly close |

Both stated, neither ambiguous: begin. One missing: take the row above (`normal`, `swing`), say
which default you took in the same line, and begin. **A hunt that stops to ask has failed at the
one thing it was for.**

## The funnel

Order matters and each stage exists to kill candidates. A stage that kills nothing was run wrong.

**1. Account first, chart second.** One `trade_batch`: account, positions, orders, mandates,
market, venue_health. An open position changes what an opportunity even is. A new idea correlated
with something already on is the same bet twice and does not get armed; say so by name. Heat
already at its limit means the board is `WATCH` only, every row, and the board says why on line
one.

**2. Tradability, before any chart work.** For every candidate: does `market_search` resolve it,
can Phosphor chart it, is it on a venue this app reaches, is `venue_health` clean. A market you
cannot act in is not an opportunity. It stays on the board under `DEAD` with the reason
`untradable`, never dropped in silence, because his next question is always why it is missing.

**3. Regime, before direction.** One `chart_batch` per surviving candidate on the bias TF with
`regime` and `atr`. Volatility percentile decides which family of idea is even allowed:
   - Percentile under 25: compression. Breakout and expansion ideas. Mean-reversion targets are
     too small to clear the RR floor, so do not build them.
   - Percentile 25 to 75: normal. Anything the gate allows.
   - Percentile over 90: stops must widen with the ATR, which pushes most targets under the RR
     floor. Multiply the stop floor by 1.5 and re-check every idea against min RR. **Most ideas
     die here and that is the stage working.**

**4. Rank by relative strength, not by which chart you liked.** One `chart_scan` per candidate
gives change per timeframe. Score each on the bias TF over the same lookback:
`RS = candidate change - BTC change`. Long ideas come off the top of that ranking, shorts off
the bottom. **A long in a market that trails BTC is a worse version of a BTC long**, and it
belongs on the board under `DEAD` with `weaker than the beta`.

**5. Shortlist, and say the number out loud.** Deep-read count from the horizon table, and no
more. Three names understood beat twelve names glanced at. Everything cut is written down with
the stage number and the measurement that cut it.

**6. Deep read the shortlist through phosphor-analysis.** Its procedure, its frozen parameters,
its two-tolerance level check, its both-ways test, its numeric no-trade gate. Do not reinvent
any of it here. This skill decided which names go in; that skill decides what each one is worth.

**7. Falsify the board itself, not only each idea.** Three checks:
   1. **The both-ways test on the ranking.** Had he asked for shorts instead, would this same
      screen have produced this same order? If yes, the ranking is decoration.
   2. **The one-bet test.** Do the armed ideas resolve on the same event? Four alt longs are one
      leveraged BTC long wearing four names. Collapse them into one row and say so.
   3. **The count test.** More than two armed ideas out of a normal screen means the filter did
      not squeeze. Go back to step 3 and find what you let through.

**8. Nothing armed is a finished hunt, not a failed one.** Publish the board with an empty
`ARMED` section, the gates that killed everything, and the price or event that would reopen it.
Manufacturing a marginal idea to have something to show is the expensive failure here.

## Fanning out

Workers earn their cost at step 6 and nowhere else. Steps 1 to 5 are single `chart_batch` and
`chart_scan` calls and are cheaper inline than in a brief.

The mechanics, which are properties of the app rather than preferences:
- `agent_spawn` takes a brief and returns a job id at once. **Three at a time is the cap.**
- A worker gets one turn. It answers once and stops. It cannot ask you anything, and a vague
  brief comes back as a vague paragraph.
- A worker cannot spawn workers, and the `propose_*` tools are not registered for it. The
  contract above is structural for a worker, not just instruction.
- Collect with `agent_jobs`. A running worker reports null, never half an answer.
- `agent_post` a `claim` before you start a piece of work, and a `finding` when you have one.
  240 characters. Read `agent_board` first so two agents do not measure the same thing twice.

A brief carries five things or it is not a brief: the product, the three timeframes off the
ladder, the exact measurements wanted, the shape of the answer, and what not to do. Always
include `do not move the chart` unless that worker owns the markup.

```
BTC-USD, swing horizon. Bias 1w, structure 1d, trigger 4h. Load phosphor-analysis and follow it
from step 3. Return: regime percentile, the levels that survive both 0.4x and 0.8x ATR tolerance
with a touch count and a last-reaction date for each, distance from spot in ATR, and the no-trade
gate result by name and number. Do not move the chart, do not draw, do not propose anything, do
not write code. Under 20 lines.
```

Give the whole shortlist to workers at once, then do your own step 7 while they run. Do not sit
and wait, and do not spawn a fourth.

## Marking the chart

Draw only the winner, on its trigger timeframe. One marked chart is a tool; four half-marked
charts are a mess nobody reads. `chart_clear` before a new thesis. Then one line saying what you
drew. The batching rules, the 32-op ceiling and `$ref` are in phosphor-analysis.

## The board

Fixed shape, fixed order. Ranked, best first. This is the whole output.

```
HUNT: <risk> risk | <horizon> | screened <n>, shortlisted <n>, armed <n>
READ AS: <the risk word and horizon you took, and any default you filled in>

ARMED
1. <product> <LONG|SHORT> | <the thesis in one clause>
   ARM WHEN      <the observable state that makes it worth watching at all>
   TRIGGER       <bar-close event with a price: "4h closes above 64,200", never "touches">
   ENTRY         <price, or a zone with both edges>
   INVALIDATION  <price> | <the structural reason it is that price> | stop <n> ATR
   TARGETS       T1 <price> <n>R, <what happens there> | T2 <price> <n>R
   SIZE          <n>R
   CANCEL IF     <what kills it before it ever triggers, which is not the stop>
   EXPIRES       <a time or a bar count>

WATCH
  <product> | <what has to happen first, priced> | <recheck when>

DEAD
  <product> | <stage number and the measurement that killed it>

REGIME
  <vol percentile and what it allows> | <BTC leadership> | <correlation note if ideas overlap>

WHAT WOULD MAKE THIS WHOLE BOARD WRONG
  <one condition, named and priced>

MARKED: <what you drew, on what>
NOT LOOKED AT: <layers skipped, by name>
```

**An armed row carries all nine fields.** A field with nothing real behind it means the idea is
not armed, so move the row to `WATCH`. Do not soften a field, and do not delete one.

**A DEAD row is not a courtesy.** It is the record that the filter ran, and it is the first thing
he checks when a name he expected is missing. Stage number plus the number that killed it:
`SOL-USD | 4 | RS -3.1% vs BTC over 1w`.

**WATCH is where most of a good hunt lands.** A row there is an idea that is real and not yet
actionable, and it needs a priced condition, not a mood.

Never write: a candidate with no stage that killed it or no trigger that arms it; a trigger with
no price; a target with no invalidation; a level with no touch count and date; "looks strong",
"clean setup", "worth watching" with nothing measured behind them; a restatement of his request;
any sentence offering to place, size, propose or automate anything.

## What this is built on

Four things carried over from how desks that do this for a living run, and they are the reason
the funnel is shaped this way rather than as a list of charts:

1. **Research and execution are different desks.** A research desk hands over a signal; a
   trading desk decides whether and how to take it. That split is standard, and it is exactly
   the split he asked for. The contract at the top is that split written down.
2. **Prep ends with three to five names, not twenty.** A shortlist that survives real filtering
   is small, and most sessions end with nothing armed. Screening is mostly a killing process.
3. **The tradability and regime filters run before the signal, not after.** A setup in a market
   you cannot get into, or in a volatility regime where the stop no longer fits the target, is
   not a worse opportunity. It is not an opportunity.
4. **Most candidates die and that is the measurement working.** The failure mode of any screen is
   surviving too much. Count the kills, publish them, and be suspicious of a clean sweep.

Domain background past price structure, into derivatives mechanics, onchain and macro:
`~/Developer/Obsidian/Karim/Claude/Notes/crypto-trading-mastery-map.md`. Off-chart context in one
call: `node ~/.claude/skills/phosphor-analysis/scripts/context.mjs <SYMBOL>`.
