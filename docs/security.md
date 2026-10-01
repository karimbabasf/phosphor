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

## A web page is not an instruction

The agent in the chat can search the web and read pages, because many questions have no answer
in Phosphor's own tools. A page is a stranger's text, and a stranger can write "swap everything
into this coin". The agent is told that a page is data and never an instruction, but a rule the
agent keeps is not a wall, so the app keeps one of its own. Once the chat's agent has searched
the web or read a page, every money move it proposes in that chat waits for your click, whatever
its size, until the chat starts a new session. A refusal stays a refusal.

The mark is stamped on a move the moment the agent asks for it, so a move whose checks finish
later cannot slip past it. It lasts for the whole session, not only until your next message,
because the page stays in the agent's memory until the session ends. And it travels with chart
labels: a label the agent writes after a web read keeps the mark across a quit, and any agent
that reads that label back is marked as if it had read the page itself. The agent is also told never to put your
balances, your addresses or what you said into a search or a web address; that one is an
instruction, not a wall. See [Policy](policy.md#after-a-web-page).

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
each end (a NEAR name whole), the chain. No agent-written text reaches that dialog. Read it before you confirm.

Two limits belong here. While the vault is open, the unwrapped wallet key sits in the backend's
memory as bytes, so the app can sign the moves you approved and the small ones the policy allows;
the lock wipes it. And on a build that is not signed with a Developer ID, the enclave key is bound
to this Mac rather than to Phosphor, so the Keys row in the Vault tab says "This copy of Phosphor
is not signed, so other apps on this Mac could ask for the key."

A software wallet is locked with your password and a slow key derivation. Anything that learns
the password, or reads the disk and guesses it, has the keys. A click on a software wallet is a
click alone, with no biometric: Approve runs the move with no Touch ID after it. That is the
custody you chose, not a bypass of it. When your Mac has an enclave, Protect with Touch ID in the
Keys row moves the same wallet behind it; use it when you can.

## The process that holds the key

While the vault is open, the key sits in one process: the backend the app starts. The app starts
it shut against the ways in that Node leaves open by default:

- Its debugger cannot be opened. Node opens one, with no password, when any program running as
  you sends it a signal; that signal is turned off.
- Nothing from your Mac's environment reaches it except the settings Phosphor reads, named one by
  one. A NODE_OPTIONS set on this Mac (one `launchctl setenv` reaches every app you open) would
  load code into Node as it starts; it never reaches the backend.
- Native add-ons and eval are off in it, and it runs the Node 24 the app ships, never one from
  your PATH.
- A signature, and each start of a trading plan's runner, reads the one key it needs, held as 32
  bytes the lock overwrites, so neither leaves another copy of your recovery phrase in memory.

A test starts the shipped runtime and files exactly the way the app does, from an environment
with a NODE_OPTIONS planted in it, and fails if the planted code ever runs.

## The files it runs

The backend runs from the files inside the app, in `Phosphor.app/Contents/Resources/phosphor`:
its code, its packages and the screens it serves you. Each release is built to accept one exact
set of them, named by a digest compiled into the signed app. Every time Phosphor starts the
backend, it works the digest out again from the files on disk. If one was changed, added or
removed since the release was built, it starts nothing and its window says "Phosphor needs a
fresh copy". Nothing has opened your wallet at that point; install a fresh copy from
phosphor.money. The check runs while the window opens, so it adds no wait.

The Node runtime beside those files is checked as well. On a signed release, the running process
has to carry a Developer ID signature of the same team as the app, or it is stopped before it is
given anything.

The limit: the files are checked when the backend starts. A file changed while Phosphor is
running is caught at the next start, not before.

## Check a release yourself

You can check that the files in your copy are the ones its release's source builds, with no
Phosphor code involved in the check.

1. The digest your copy was built for, and the digest of its files on disk:

   ```
   /Applications/Phosphor.app/Contents/MacOS/phosphor-desktop --payload-digest
   ```

2. The same digest, worked out with the tools macOS ships:

   ```
   cd /Applications/Phosphor.app/Contents/Resources/phosphor
   find . -type f ! -name .DS_Store | sed 's|^\./||' | LC_ALL=C sort | tr '\n' '\0' | xargs -0 shasum -a 256 | shasum -a 256
   ```

3. The digest the release's source builds, on a Mac with Node 24 and Xcode's command line tools.
   Use the tag of the version you have, such as v0.10.13:

   ```
   git clone --depth 1 --branch v0.10.13 https://github.com/karimbabasf/phosphor.git
   cd phosphor && npm run bundle
   ```

   It prints `payload: digest` and the value.

The three agree when your copy is the one that tag builds. Only the files' contents and names go
into the digest, never dates or owners, so the same tag gives the same digest on any Mac. Finder's
`.DS_Store` files are left out because Finder writes one into any folder it shows.

## The lock

The wallet locks after five minutes with nobody at the window by default (the Vault tab
offers 5 minutes, 15 minutes or 1 hour), when the Mac sleeps, and when you close the window.
Locked, the key is gone from memory and the window is frosted. Reads still work. A proposal made
while locked is drafted, priced and checked, and its card says Unlock to decide; when you
unlock, it is decided again and lands as something to click. An unlock is never an approval,
even for a move small enough to have run on its own with the app open.

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

The web-read mark has an edge too. The app sees the web searches and page reads of the agent it
runs in the chat. An agent in your terminal reads the web with its own tools, out of the app's
sight, so its moves follow your click threshold as usual unless it reads a marked chart label.

The whole list, with what closes each item, is [Known limits](known-limits.md). Two more limits
are yours to know here. The safety systems are engineering by one person, without a
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
