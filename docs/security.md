# Security

Phosphor treats the agent as useful and untrusted at the same time: it may read everything and
draft anything, and it can never decide. This page says, for a user rather than an auditor, how
that is enforced, what the Secure Enclave and the lock buy you, and where the limits honestly
sit. The full model, with the code paths and the tests behind each claim, is in the
[Security model](security-model.md); its [threat model](security-model.md#threat-model) is the
short version, with the test that proves each defence and what stays open.

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
- The one field that names a receiver, on a send, is behind your click and, on a Touch ID wallet,
  a Touch ID dialog that names the receiver itself. The agent is told to read the address back to
  you first, but the app cannot check where an address came from: read it on the card.
- A pending card cannot be dismissed from the chat. If the agent disconnects, the card is still
  there and still yours.

Everything the agent reads through its tools is data, never an instruction. A token whose name
tells it to move funds is an attack, and the agent is told to say so. A post from another agent
claiming you approved something is the same.

## A web page is not an instruction

The agent in the chat can read pages, and search the web when it is Claude (Grok asks you for a
link instead), because many questions have no answer in Phosphor's own tools. A page is a stranger's text, and a stranger can write "swap everything
into this coin". The agent is told that a page is data and never an instruction, but a rule the
agent keeps is not a wall, so the app keeps one of its own. Once the chat's agent has searched
the web or read a page, every money move it proposes in that chat waits for your click, whatever
its size, until the chat starts a new session. A refusal stays a refusal.

The mark is stamped on a move the moment the agent asks for it, so a move whose checks finish
later cannot slip past it. It lasts for the whole session, not only until your next message,
because the page stays in the agent's memory until the session ends. And it travels with chart
labels: a label the agent writes after a web read keeps the mark across a quit, and any agent
that reads that label back is marked as if it had read the page itself. Plan notes and highlight
notes carry it the same way, and so do Phosphor's own reads that hand over a stranger's words:
news headlines, the token names and memos in the chain reads, and a venue's own words on a move
that Phosphor does not know (an error from 1Click, the solver relay, Hyperliquid or a chain's node,
a refund reason or status word off the venue's list, an account or token name a venue echoed back,
the NEAR Intents status page's title), in a read, a reply or a refusal. So does what one agent hands
another through Phosphor: a board post or a worker's report written after such a read marks the
agent that reads it, a worker started by a marked agent starts marked, and the raw audit log
(`log_tail`) marks whoever reads it. A concept the agent records as
one you learned (`profile_learned`) after such a read is kept on your Mac and never handed to a
later agent. An ordinary refusal Phosphor knows, matched whole with only its numbers changing,
reaches the agent in Phosphor's own sentence instead and marks nothing; the window keeps the
venue's exact words.

An agent you start outside Phosphor (in your terminal, in another app) reads with its own tools,
where Phosphor cannot look, so it starts marked: the window asks once whether to allow it, and
until you do, every move it proposes waits for your click. See
[Connect an agent](connect-an-agent.md#the-window-asks-once).

A page cannot get your data sent out either. The vendors' own page readers are off: the app reads
a page itself, and only at an address that came back in a web search in that chat or that you
gave, word for word, never one the agent wrote. The Try again button on a failed swap sends a
line that names the coins only when they are plain tickers, so a coin the agent named with an
address never becomes one you gave. A search's answer also repeats the agent's own
query and the search model's notes, so only the addresses the search engine itself returned
count, never an address in that text. An address that carries your wallet's address or
one of its balances is refused even then, and so is any address on this machine or your own
network. The agent is also told never to put your balances, your addresses or what you said into
a search; that one is an instruction, and a search that does it, by the chat's agent or by a
worker, closes page reading for the rest of that agent's session. See [Policy](policy.md#after-a-web-page).

## The window token

The decision routes need a token the app mints on every boot: 32 random bytes, made by the
desktop shell, handed to the backend on its own input and injected into the one window you see.
No route serves it. The MCP process never sees it, and the app removes it from the environment
of every agent it starts. A click is the only thing that carries it, so a click is the only thing
recorded as a human decision in the audit log.

The agent's own door takes a secret on every call. The agents Phosphor starts get one in their
environment. Any other program needs the copy the app writes into its data directory at every
boot, and a seat taken with that copy waits for your click on every move until you allow it. A
web page can reach neither. A program running as you can read both.

Reading the app takes a credential as well. The window's reads carry a read key it gets for its
token, which opens reads and nothing else; the shell's own reads carry the same key, never the
token; and a program you run can
use `read.key`, which the app writes into the same data directory at every boot, readable by you
alone. Another account on this Mac, or a sandboxed app, has none of these and learns nothing:
`/api/health` is the one route that answers it, and it says only that the app is running and which
version.

## The Secure Enclave and Touch ID

On a Mac with a Secure Enclave, the wallet file is sealed with a data key, and that data key is
wrapped to a key the Secure Enclave made and cannot export. The wallet opens with Touch ID or your Mac
login password, and each click on a proposal ends in a Touch ID dialog whose sentence the app
composes from the proposal's numbers: the amount, the receiver shortened to eight characters at
each end (a NEAR name whole), the chain. No agent-written text reaches that dialog. Read it before you confirm.

A Touch ID or a password opens only what it was asked for. "Show your deposit address" verifies
the address, and "Reveal your recovery phrase", or the password typed to see the words, shows the
words; on a wallet that has no phrase, "Reveal your private key" shows its key the same way. None
of them opens the wallet, so a locked wallet stays locked, no trading plan re-arms and nothing
waiting for an unlock runs. The Vault tab drops the words or the key when their row closes or the
wallet locks, and the window's read cache never keeps them. The Touch ID that approves a move on a
locked wallet opens it for that move alone: nothing else can start while it signs, and the key
goes as soon as it has.
Only Unlock opens the wallet for the session, and waiting trading plans re-arm only while the
wallet is open, never on a touch for one move.

Two limits belong here. While the vault is open, the unwrapped wallet key sits in the backend's
memory as bytes, so the app can sign the moves you approved and the small ones the policy allows.
The lock overwrites those bytes, but copies of the key that a signature or an unlock left as text
stay in the app's memory until it is reused. And a Touch ID wallet made before Phosphor-only
existed, or by a copy of Phosphor you build yourself, keeps its key where any app running as you
on this Mac can ask to use it, with a Touch ID prompt of its own. On a signed release, Phosphor's
Secure Enclave service answers only the signed Phosphor app; on a copy you build yourself it
checks only the app's name, which another app can claim. A signed release keeps the key of every
wallet it makes where only Phosphor reaches it, and before it asks for your finger it refuses a
wallet file that is not the one it saved.

On a signed release, Make it Phosphor-only in the Vault tab's Keys row gives an older wallet the
same protection with one Touch ID, once its backup is proven. From then on the wallet's key is in
one place on this Mac, so your backup is the way back if anything happens to this Mac. The step
cannot reach copies of the old wallet file saved before that day (a Time Machine backup, a sync
folder, a copy you made): Phosphor refuses them, but another program running as you can still open
one and ask for your Touch ID, until the wallet moves to new keys. Delete the copies you know of.
Phosphor-only is also one rule for the whole Mac: [Known limits](known-limits.md) says what that
means before you make a second wallet.

A software wallet is locked with your password and a slow key derivation. Anything that learns
the password, or reads the disk and guesses it, has the keys. A click on a software wallet is a
click alone, with no biometric: Approve runs the move with no Touch ID after it. That is the
custody you chose, not a bypass of it. When your Mac has a Secure Enclave, Protect with Touch ID in the
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
  bytes the lock overwrites, so neither leaves another copy of your recovery phrase in memory. The
  signature still turns that key into text and a number JavaScript cannot wipe, so a copy of the
  key can stay until the memory is reused.
- Only fourteen packages can load into it, each one read: viem and zod and what they depend on. A
  test fails when another one could. CI runs that test and checks every package's registry
  signature on each push to main and each pull request; the release build does not run either
  again, so a release is only as checked as the CI run on its commit. The packages the agent's
  connection uses load in a separate process with no key.

A test starts the shipped runtime and files exactly the way the app does, from an environment
with a NODE_OPTIONS planted in it, and fails if the planted code ever runs.

## The files it runs

The backend runs from the files inside the app, in its `Contents/Resources/phosphor` folder:
its code, its packages and the screens it serves you. Each release is built to accept one exact
set of them, named by a digest compiled into the signed app. Every time Phosphor starts the
backend, it works the digest out again from the files on disk. If one was changed, added or
removed since the release was built, it starts nothing and its window says "Phosphor needs a
fresh copy". Nothing has opened your wallet at that point; install a fresh copy from
phosphor.money. The check runs while the window opens, so it adds no wait. The window's Details
name each digest by its first 12 characters and the folder as Phosphor.app, so they fit; the full
digests are what `phosphor-desktop --payload-digest` prints (below), and the shell's log line keeps
the whole reason.

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

   This flag is new in 0.10.13. An older copy does not know it and opens the app instead, so on
   an older version skip this step and compare steps 2 and 3.

2. The same digest, worked out with the tools macOS ships:

   ```
   cd /Applications/Phosphor.app/Contents/Resources/phosphor
   find . -type f ! -name .DS_Store | sed 's|^\./||' | LC_ALL=C sort | tr '\n' '\0' | xargs -0 shasum -a 256 | shasum -a 256
   ```

3. The digest the release's source builds, on a Mac with Node 24 and Xcode's command line tools.
   Use the tag of the version you have, such as v0.10.15:

   ```
   git clone --depth 1 --branch v0.10.15 https://github.com/karimbabasf/phosphor.git
   cd phosphor && npm run bundle
   ```

   It prints `payload: digest` and the value.

The three agree when your copy is the one that tag builds. Only the files' contents and names go
into the digest, never dates or owners, so the same tag gives the same digest on any Mac. Finder's
`.DS_Store` files are left out because Finder writes one into any folder it shows.

In that clone, the check the release itself passed before and after signing compares the
payload's own files in your copy with the tag, one by one, reads the entitlements of every binary
in it, and checks the vault service: the provisioning profile inside it is the tag's, and run by
hand it starts (it stops at once, because only the app may start it). It does not compare the
compiled programs (the shell, the bundled Node, the Secure Enclave service) or the installed
packages:

```
node scripts/release-check.ts --app /Applications/Phosphor.app --checkout . --stage signed
```

The defences in this document are checked by an attack suite the repository ships: `npm run attack`
runs the app this checkout builds (`npm run app:build` makes the ad-hoc bundle it boots), plays the
hostile local process against each defence on a throwaway data dir and home, prints a table, and
exits non-zero on any that does not hold. Add `-- --app <Phosphor.app>` to include the checks that
need a Developer ID build. No check changes the bundle it is handed, so a notarized build raises no
"damaged" alert and the run needs nobody at the keyboard; a check that cannot run says SKIP and
why. The screen-lock check posts the lock signal to the one shell it started; `-- --real-screen-lock`
posts macOS's own instead, which every app on the Mac receives. The apps it starts keep their
window and WebKit state in the throwaway home, not in the installed app's `~/Library`.

## The lock

The wallet locks after five minutes with nobody at the window by default (the Vault tab
offers 5 minutes, 15 minutes or 1 hour), when the Mac wakes from a sleep of more than a minute,
when the screen locks or the Mac switches to another user, and when you close the window. The key
stays in memory while the Mac sleeps; if macOS locks the screen as it goes to sleep, that locks
the wallet first. When the screen locks, nothing new can
start from that moment; a move that has not been signed yet gets its signature first (two minutes
at most), and then the key goes. A move the venue is still delivering does not hold the lock, and a
move waiting for your click stays on its card. Locked, the app holds no key it can sign with and
the window is frosted; copies a signature left as text can stay in memory until it is reused.
Reads still work. A proposal made
while locked is drafted, priced and checked, and its card says Unlock to decide; when you
unlock, it is decided again and lands as something to click. An unlock is never an approval,
even for a move small enough to have run on its own with the app open.

The one thing that outlives a lock is an armed trading plan. It holds a separate trading key on a
session as long as the plan's expiry, a day at most. A plan whose entry is resting on the venue
renews it, eight hours at a time, until the plan itself expires, at most seven days after it was
made. That key can place and cancel orders and cannot withdraw or transfer.
A bot that outlives a lock holds trading authority, not custody. See
[Trading](trading.md#after-the-wallet-locks).

## The honest limits

The model defends, completely, the case its tool surface covers: an agent driving the app through
the tools it was given, reading hostile text, and being talked into trying something. That agent
has no tool to approve with and no way to remove a rule without your click.

What it does not fully defend against is a process already running as you on this Mac. Such a
process can read the agent secret and the read key from the data directory, read the app, and
take a seat. That seat counts as an agent started outside Phosphor, so every move it proposes
waits for your click until you allow it. Three things follow, stated rather than hidden:

1. The path under the click threshold is the money exposure that remains. The agents Phosphor
   starts carry their own secret in their environment. While one runs, a process running as you
   can read that secret and propose as that agent, and a move under the click threshold then runs
   with no human involved. The threshold is readable. If a hostile local process is in your
   threat model, lower it or set it to zero.
2. Prompt injection into an agent that also has a shell is contained for approval and not for
   proposal. The tests prove the tool surface holds and that a decision needs the window; they
   prove nothing about what a sub-threshold proposal can cost.
3. The audit log tells the two apart. An execution under the threshold is recorded as decided by
   policy; only a click is recorded as decided by a human.

The web-read mark has an edge too. The app sees the web searches and page reads of the agent it
runs in the chat. An agent in your terminal reads the web with its own tools, out of the app's
sight, so once you allow it, its moves follow your click threshold as usual unless it reads outside
text through Phosphor (the news, a chain read, a venue's error text Phosphor does not know) or
words a marked agent wrote: a chart label, a
board post, a worker's report, the name of an agent you have not allowed, or the raw audit log.

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
