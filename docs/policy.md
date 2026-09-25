# Policy

Your rules decide what the agent may do on its own, what waits for your click, and what is
refused outright. They live in the app as plain sentences, a pure engine enforces them with no
model in the path, and no proposal reaches execution without either your click or an allow inside
limits you wrote. This page explains the rules, the click threshold, the click that follows a web
page, how a rule changes, and why the gate has no off switch.

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
as long as the vault is open. Above it, nothing happens until you click. The Vault tab's Policies
row says it as Asks you above $100: "Anything above this waits for your click."

This convenience applies only to money that stays in your own custody: a swap inside NEAR
Intents, funding the Hyperliquid account, arming a trade. Three moves wait for a click at any
size, and the policy engine never executes them on its own:

- A send, because the money leaves for somebody else. See [Money](money.md#send).
- A withdrawal from Hyperliquid. See [Money](money.md#withdraw-from-hyperliquid).
- A policy change, because a rule the human did not click is how every other guarantee gets
  removed.

Two more cases wait for a click whatever their size: a swap the app cannot measure, because it
spends a coin the app cannot price or one whose listed price nothing in the quote can check (see
[Money](money.md#swap)), and every move the chat's agent proposes after it read a web page (see
below).

A move that waits is one card in the chat that says Needs your OK. It shows what leaves and what
arrives at least, its Details say why it asks, and it has two buttons: Cancel and Approve. On an
enclave wallet Approve then asks for Touch ID, and the card says Confirm on your Mac until you
answer.

If a hostile process running as you is in your threat model, lower the threshold in the Vault
tab, or ask your assistant to set it to zero: at zero every move waits for a person.
[Security](security.md#the-honest-limits) says why that is the one exposure that remains.

### After a web page

Once the agent in the chat has searched the web or read a page, every money move it proposes in
that chat waits for your click, whatever its size, until the chat starts a new session (the agent
restarts, or you start a new chat). Why it asks, in the card's Details, says: "It read a web
page earlier in this chat, so this one waits for your OK." A chart label the agent writes after
a web read carries the same mark, and an agent that later reads that label is marked too. A move
that would have been refused is still refused; the mark only turns a move that would have run on
its own into one that asks. [Security](security.md#a-web-page-is-not-an-instruction) says why.

### After a move that did not go through

When a move your agent proposed does not go through, the app wakes the agent to tell you in one
line, without waiting for your next message. Nobody typed that turn, so every money move the agent
proposes in it waits for your click, whatever its size. Why it asks says: "Your agent asked for
this on its own after a move did not go through, so it waits for your OK." The mark ends with that
turn, and a move that would have been refused is still refused.

## Policy as sentences

The policy is stored as a file but read as English. The sentences are rendered from the file by
a pure function, so what you read is what the engine enforces, and there is no second version
anywhere. You see them in three places. Policies on the Pro tab draws three of them as dials
(Asks you above, Never more in one move, and what ran on its own today), with the daily cap under
them. The Policies row in the Vault tab lists every rule that is set: Asks you above, Largest move,
In any 24 hours, Without asking, and where money may go. Policies on the Basic tab takes you
there. And the `policy_show` tool gives your assistant the sentences themselves.

Limits that mean something at their default always render. Opt-in restrictions render only once
set, because "no issuer may exceed 100%" says nothing. The kill switch line always renders last.

## Changing a rule

Besides Freeze, the click threshold is the one rule you can change in the window. In the Vault
tab, press Change beside Asks you above, type an amount or pick $25, $100, $500 or $1,000, and
press Save. That is your own click, and the audit log records it as a human change. The amount
must be above $0 and under the per-transaction cap, or it is refused with the reason.

Every other rule, and a threshold of zero, changes through your assistant. It proposes the change
with `propose_policy_change`, carrying the patch and a sentence that says what it means, and the
card is headed Change your limits. It always lands as something to click, however small the
change.

The engine holds a patch to these rules before it ever reaches you:

- The kill switch, the file version and the rendered sentences cannot be patched at all.
- A patch is checked against the schema, and an unknown field refuses it. A patch that names no
  rule is refused as nothing to change.
- No click can set a limit above $1,000,000 per transaction or $10,000,000 per day or session.
  Going higher is an edit to `policy.json` by a person, not a patch.
- The click threshold must sit strictly under the transaction cap, or nothing would ever wait
  for you. A patch that moves one past the other is refused and told to carry both.
- A patch may add a destination, a forbidden issuer or an issuer cap, and may move a cap that
  stays. Removing one is refused: that is a decision for the policy file, not a click.
- The sentence must say what the patch does, on one line, with every figure it moves. A patch
  whose sentence names a different number, or leaves one out, is refused. An accepted change
  carries before and after for every limit it touches, and the card shows both.

One click moves a limit to what the sentence says. There is no longer a ten-times-per-step
rule: the walls above are what hold a patch, and the click is what accepts it.

## The three verdicts

The engine returns exactly one of three verdicts, and there is no fourth:

- Refuse: nothing happens. The refusal names the rule and the reasons, and both are logged.
- Needs approval: the proposal is saved as pending and drawn as a card in the chat with its
  simulation. It executes only after your click.
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
