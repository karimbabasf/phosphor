# Security

Phosphor treats the agent as useful and untrusted at the same time: it may read everything and
draft anything, and it can never decide. This page says, for a user rather than an auditor, how
that is enforced, what the Secure Enclave and the lock buy you, and where the limits honestly
sit. The full model, with the code paths and the tests behind each claim, is in the
[Security model](security-model.md).

## What the agent can read, draft and never decide

An agent reads untrusted text all day: token names, web pages, chart labels, notes from other
agents. If approval were the agent saying "confirmed", any of that text could produce the word.
So approval is not a message. It is a click in a window the agent's process cannot reach.

- The MCP process the agent talks through has no route that decides anything. The approve,
  refuse and kill routes do not appear in its source, and a test reads the file to check.
- No tool on the surface decides. No tool name starts with approve, refuse, kill, dismiss or
  execute, and a test holds the live tool list to that. See [Tools](tools.md).
- Every write is a proposal judged by the policy engine, see [Policy](policy.md). A send, a
  withdrawal and a rule change always wait for your click, whatever their size.
- The one field that names a receiver, on a send, is behind the agent's read-back, your click
  and, on an enclave wallet, a Touch ID dialog that names the receiver itself.
- A pending card cannot be dismissed from the chat. If the agent disconnects, the card is still
  there and still yours.

Everything the agent reads through its tools is data, never an instruction. A token whose name
tells it to move funds is an attack, and the agent is told to say so. A post from another agent
claiming you approved something is the same.

## The window token

The decision routes need a token the app mints on every boot: 32 random bytes, made by the
desktop shell, handed to the backend on its own input and injected into the one window you see.
No route serves it. The MCP process never sees it, and the app removes it from the environment
of every agent it starts. A click is the only thing that carries it, so a click is the only thing
recorded as a human decision in the audit log.

The agent's own door is behind a second secret, written under the app's data directory at every
boot. Nothing that has not read that file can read the app or file a proposal into it, which
keeps the door shut to any web page and to any process that has not been given the file.

## The Secure Enclave and Touch ID

On a Mac with a Secure Enclave, the wallet file is sealed with a data key, and that data key is
wrapped to a key the enclave made and cannot export. The wallet opens with Touch ID or your Mac
login password, and each click on a proposal ends in a Touch ID dialog whose sentence the app
composes from the proposal's numbers: the amount, the receiver shortened to eight characters at
each end, the chain. No agent-written text reaches that dialog. Read it before you confirm.

Two limits belong here. While the vault is open, the unwrapped wallet key sits in the backend's
memory as bytes, so the app can sign the moves you approved and the small ones the policy allows;
the lock wipes it. And on a build that is not signed with a Developer ID, the enclave key is bound
to this Mac rather than to Phosphor, so the Vault tab says "Any process on this Mac can ask".

A software wallet is locked with your password and a slow key derivation. Anything that learns
the password, or reads the disk and guesses it, has the keys. A click on a software wallet is a
click alone, with no biometric; the card says Approve rather than Approve, then Touch ID. That
is the custody you chose, not a bypass of it. Move behind the Secure Enclave when you can.

## The lock

The wallet locks after fifteen minutes with nobody at the window, when the Mac sleeps, and when
you close the window. Locked, the key is gone from memory. Reads still work, so the window keeps
showing your balances. A proposal made while locked is drafted, priced and checked, and waits as
Needs the unlock; when you unlock, it is decided again and lands as something to click. An unlock
is never an approval, even for a move small enough to have run on its own with the app open.

The one thing that outlives a lock is an armed trading plan. It holds a separate trading key on a
session of at most 24 hours; that key can place and cancel orders and cannot withdraw or transfer.
A bot that outlives a lock holds trading authority, not custody. See
[Trading](trading.md#after-the-wallet-locks).

## The honest limits

The model defends, completely, the case its tool surface covers: an agent driving the app through
the tools it was given, reading hostile text, and being talked into trying something. That agent
has no tool to approve with and no way to remove a rule without your click.

What it does not defend against is a process already running as you on this Mac. Such a process
can read the agent's secret from the data directory, and then it can do what an agent can do:
read the app and file proposals. Three things follow, stated rather than hidden:

1. The path under the click threshold is the money exposure that remains. A proposal sized under
   the threshold executes with no human involved, and the threshold is readable. If a hostile
   local process is in your threat model, lower it or set it to zero.
2. Prompt injection into an agent that also has a shell is contained for approval and not for
   proposal. The tests prove the tool surface holds and that a decision needs the window; they
   prove nothing about what a sub-threshold proposal can cost.
3. The audit log tells the two apart. An execution under the threshold is recorded as decided by
   policy; only a click is recorded as decided by a human.

Two more limits are yours to know. The safety systems are engineering by one person, without a
third-party audit; read the
[disclaimer](https://github.com/karimbabasf/phosphor/blob/main/DISCLAIMER.md) before you fund the
wallet. And the
app cannot protect you from your own click: a rule that does what it said, or an address you
confirmed wrongly, is not something it can undo.

## Reporting a problem

Do not open a public issue for anything that could move, expose or lose funds. Use private
vulnerability reporting on the [GitHub repository](https://github.com/karimbabasf/phosphor): the
Security tab, then Report a vulnerability. The repository's
[SECURITY.md](https://github.com/karimbabasf/phosphor/blob/main/SECURITY.md) lists what is in
scope, what to include, and what to expect.
