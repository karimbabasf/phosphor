# Policy

Your rules decide what the agent may do on its own, what waits for your click, and what is
refused outright. They live in the app as plain sentences, a pure engine enforces them with no
model in the path, and no proposal reaches execution without either your click or an allow inside
limits you wrote. This page explains the rules, the click threshold, how a rule changes, and why
the gate has no off switch.

## The rules

A fresh install ships with four rules:

```
Refuse any single transaction above $10,000.
Refuse more than $25,000 in any 24 hours.
Ask me before anything above $100.
Ask me once auto-approved moves pass $500 in 24 hours.
```

The first two are hard caps: nothing above them runs, click or no click. The third is the click
threshold. The fourth is a daily ceiling on what runs without you: once the moves the policy
approved on its own pass $500 in a day, the next one waits for a click however small it is.

Three more kinds of rule exist and appear only once you set them: a cap on how much of your
holdings one stablecoin issuer may hold ("Tether may not exceed 30% of holdings"), a cap on how
much may be freezable by an issuer ("No more than 20% of holdings may be freezable"), and a list
of issuers the app may never move funds into. These judge the state a move would leave behind,
so a portfolio already past a cap cannot make further moves until you change the rule or the
breach clears.

The last line, when it shows, is the brake: "KILL SWITCH ON: all writes refused." That is Freeze
everything in the top bar, see [Getting started](getting-started.md#freeze-everything).

## The click threshold

The click threshold splits every write into two kinds. At or below it, the policy engine decides
alone and the move may execute at once, with no click and, on an enclave wallet, no Touch ID,
as long as the vault is open. Above it, nothing happens until you click. The Vault tab says the
same in one line: "Moves under $100 run without a click while the vault is open. Above that,
nothing happens until you click."

This convenience applies only to money that stays in your own custody: a swap inside NEAR
Intents, funding the Hyperliquid account, arming a trade. Three moves wait for a click at any
size, and the policy engine never executes them on its own:

- A send, because the money leaves for somebody else. See [Money](money.md#send).
- A withdrawal from Hyperliquid. See [Money](money.md#withdraw-from-hyperliquid).
- A policy change, because a rule the human did not click is how every other guarantee gets
  removed.

The card for a move above the threshold shows the simulation, the totals, and Why you are being
asked, then two buttons: Yes and No. On a send the button reads Approve, then Touch ID.

If a hostile process running as you is in your threat model, lower the threshold or set it to
zero: at zero every move waits for a person. [Security](security.md#the-honest-limits) says why
that is the one exposure that remains.

## Policy as sentences

The policy is stored as a file but read as English. The sentences are rendered from the file by
a pure function, so what you read is what the engine enforces, and there is no second version
anywhere. You see them in three places: the rules strip on the Basic tab ("Asks you above $100",
"Refuses above $10,000"), the Policy card on the Pro tab, and the `policy_show` tool your
assistant reads.

Limits that mean something at their default always render. Opt-in restrictions render only once
set, because "no issuer may exceed 100%" says nothing. The kill switch line always renders last.

## Changing a rule

The Pro tab's Policy card says it in one line: "Ask your assistant to change a rule. Every change
waits for your click." There is no editor in the window. The agent proposes the change with
`propose_policy_change`, carrying the patch and a sentence that says what it means, and the card
is headed Change your limits. It always lands as something to click, however small the change.

The engine holds a patch to these rules before it ever reaches you:

- The kill switch, the file version and the rendered sentences cannot be patched at all.
- A patch is checked against the schema, and an unknown field refuses it.
- One change may loosen a cap by at most ten times. Past that, make it in steps you read each
  time.
- A cap at zero cannot be raised by a patch. Zero is a different policy, not a small number.
- A click threshold above the transaction cap is refused, because nothing would ever wait for
  you.
- The destination allowlist is replaced whole, never merged, so a patch carries the whole list.

## The three verdicts

The engine returns exactly one of three verdicts, and there is no fourth:

- Refuse: nothing happens. The refusal names the rule and the reasons, and both are logged.
- Needs approval: the proposal is saved as pending and drawn in the window with its simulation.
  It executes only after your click.
- Allow: inside every cap and at or below the threshold, so the app executes it and logs the
  verdict that let it.

The chain runs in a fixed order and stops at the first refusal: the policy file is unreadable,
the kill switch is on, the move is not a rail this app runs, the amount the app priced is not a
positive number, the venue or the account the money lands in is not allowed (a send is the
exception: its receiver is yours to check, and the click stands in for a list), the
per-transaction cap, the rolling 24 hour cap, then the composition rules. What is left is judged
against the click threshold and the daily ceiling, and only then allowed. Every rail then
simulates before anything is signed, and a simulation that fails is a refusal, never a pending
card you could click.

There is no override argument, no force flag and no "the user said it was fine" field anywhere
in the tool surface. An agent that dislikes a refusal has one recourse: propose a rule change,
which waits for your click.

## Why the gate has no off switch

There used to be one. A setting turned the gate off so a rail could be exercised without a click
on every proposal, and it was the one deliberate hole in the model. It is gone. There is no flag,
no environment variable, no proposal kind and no configuration that reaches execution without
either your click or a policy allow inside limits you wrote.

The audit log records who decided every executed move: human for a click, policy for an allow.
Only a click is recorded as human, and a click needs the window token the agent never holds, see
[Security](security.md#the-window-token). A pending card cannot be dismissed from the chat: if the
agent disconnects, the card is still there and still yours to decide.
