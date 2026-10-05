# Known limits

What this build does not cover, stated plainly so you can size what you put in it. Each item
says what the limit is, what it means for your money, and what closes it. The Vault tab, the
cards and the audit log say several of them in their own words; this page has them all.

## Alpha software that moves real money

Every address the app makes is a real address, and every move it makes is a real move on a real
venue. There is no practice mode. The safety systems are the engineering of one person and have
not had a third-party audit. Read the [disclaimer](https://github.com/karimbabasf/phosphor/blob/main/DISCLAIMER.md)
before you fund the wallet, and start with an amount you can afford to lose.

What closes it: an audit by a third party, which is planned and not done. Nothing internal
gets called an audit until a third party signs it.

## The key is in memory while the vault is open

Your wallet file is sealed on disk: a Touch ID wallet to this Mac's Secure Enclave, which opens
it with Touch ID or your Mac login password, and a password wallet with your password. But while
the vault is open the unsealed key sits in the app's memory, because that is what signs the moves
you approved and the small ones your rules allow. The lock overwrites it, along with a key or
recovery phrase you asked to see and had not read yet. The lock comes after five minutes with
nobody at the window (or the time you set in the Vault tab), when the Mac wakes from a sleep of more than a minute, when the screen locks or the Mac
switches to another user, when you close the window, and when you press Lock now. The key stays
in memory while the Mac sleeps. When the screen locks, the Mac switches user or the window closes,
a move that has not been signed yet gets its signature first, two minutes at most, while nothing
new starts. Copies of the key, and of your recovery phrase, that an unlock, a signature, a new
wallet or words or a key shown to you left as text are not overwritten: JavaScript cannot wipe them, so
they stay in memory until it is reused, after the lock too. The check behind Prove it, made when a
wallet is created or its words are shown, also outlives a lock: it goes when the words are proven
or shown again, after five wrong tries, after half an hour with the Mac awake, or when the app
quits. It keeps only the three positions it asks for and one slow hash of those three words, the
same hash that guards the wallet file's password, so a program that reads memory has 8.6 billion
guesses to make before it learns them, and three words of twelve do not open the wallet. A wallet
with no phrase backs up its private key instead, and I saved it somewhere safe, clicked just after
the key was shown, is the proof, so nothing of the key is kept for it: only the wallet it opens,
for half an hour.

What it means: a program that can read the app's memory while the vault is open has the key, and
after a lock it may still find a copy. On macOS that takes a process running as you with the right
to attach to another process, which the hardened runtime is there to refuse. Keep the vault open
only while you are using it.

What closes it for the vault: the move to the chip in the Vault tab. After it the vault answers
only to this Mac's Touch ID key and your paper key, and the open session holds the allowance key,
the gas key and the trading key, never the owner key. What it does not close: those three keys are
in memory while the wallet is open, so the allowance, the gas account and trading stay as exposed as
described here.

## Two seconds after the backend stops

If a program running as you stops the app's backend and takes its port, the app needs up to two
seconds to notice. In that time what the window sends goes to that program: a click, or a
password typed into Unlock. The window token those carry no longer opens anything.

What it means: the program would have to time this to the second, and a password wallet's
password is what it would be after. If the window suddenly shows the splash, or Phosphor says
its backend stopped, do not type your password until it is back.

## A local program that reads the seat secret can propose

The agent's door into the app is guarded by a secret the app writes into its own data folder at
every start. A web page cannot read that file. A program already running as you on this Mac can,
and once it has, it can do what your agent can do: read your balances and propose moves.

What it means: such a program takes a seat as an agent started outside Phosphor, so the window
asks you whether to allow it, and until you do, every move it proposes waits for your click.
Answer Ask each time to anything you did not start. What stays open: the agents Phosphor starts
carry a second secret in their environment, and a program running as you can read a running agent's
environment and pose as it; then a move under your click threshold runs without a click. Your
rules set its size. If a hostile program running as you is something you worry about, lower the
threshold in the Vault tab, or ask your assistant to set it to zero: at zero every move waits for
you. Nothing on this Mac can approve a move: the click needs the window token, which no route
serves and no program can fetch.

What closes it: the agent's door moving onto a socket the operating system can identify the
caller of. Until then the seat secret is the credential in its place.

## An older wallet's key answers any app on this Mac

A Touch ID wallet made before Phosphor-only existed, and any Touch ID wallet that a copy of
Phosphor you build yourself makes, keeps its key where any program running as you on this Mac can
ask to use it. Only a signed release can keep a key that Phosphor alone reaches: that takes a
permission Apple signs for Phosphor's developer, and a copy you build yourself cannot carry it.

What it means: another app running as you could ask to use the key, and macOS would show that
app's own Touch ID prompt, not Phosphor's. Approve a Touch ID prompt only for something you started
in Phosphor, and read the sentence in it.

What closes it: on a signed release, the Vault tab's Keys row shows Phosphor-only access, and once
the wallet's backup is proven, Make it Phosphor-only moves its key to where only Phosphor reaches
it, with one Touch ID. The same wallet, the same addresses. Every Touch ID wallet a signed release
makes is Phosphor-only from the start. Before it asks for Touch ID, Phosphor checks that a
Phosphor-only wallet's file is the one it saved, so a file someone else made for the same key, or
an edited one, is refused. A signed update verifies either way: the updater checks the bundle's own
update signature, and then its Developer ID code signature against Phosphor's Team ID, before it
replaces anything. Four limits stay, below.

## Phosphor-only is one rule for the whole Mac

The first time a signed release makes a Touch ID wallet Phosphor-only, or makes or restores one,
every older Touch ID wallet on this Mac that is not Phosphor-only stops opening in Phosphor. That
holds for every copy of Phosphor and every data folder on the Mac, not only the one that made the
change, and for copies of the older wallet's file too.

What it means: a second wallet made in another folder, even one for a test, shuts your first
wallet out of Phosphor while that one is still older. Its money is not touched: its lock card says
why and offers Restore, and its backup brings it back here as a Phosphor-only wallet. So before you
make or restore a second wallet on this Mac, make the one you have Phosphor-only, or at least prove
its backup. A demo run never does this: it makes a password wallet and leaves Phosphor's keys
alone.

What closes it: making every wallet on the Mac Phosphor-only. The rule itself stays, because it is
what keeps a file swapped in for your wallet from opening the older way.

## A Phosphor-only wallet's key is in one place on this Mac

A Phosphor-only wallet's key is kept in one place on this Mac that only Phosphor reaches, not in
the wallet file, so no copy of the file opens the wallet without it, and it never leaves this Mac.

What it means: if this Mac is erased, lost or replaced, or the passwords and keys macOS keeps for
you are reset, the wallet file cannot open again, here or on any other Mac, and your backup (the
recovery phrase, or the private key of a wallet that has no phrase) is the only way back. That is
why Make it Phosphor-only asks for a proven backup first. A private key backup holds the EVM key
alone: an older wallet whose file also holds a NEAR key, a Solana key or a trading key keeps those
only in the Phosphor-only file, and the backup cannot bring them back. The app never shows or
spends from those NEAR and Solana addresses, and a trading key is approved again.

What closes it: nothing in this build. Keep your backup somewhere that is not this Mac.

## Old copies of a wallet file still open on this Mac until the keys change

Making a wallet Phosphor-only writes a new wallet file for it, and from then on Phosphor on this Mac
refuses the older file, before any Touch ID. What the step cannot reach is a copy of the old
`keys.enc.json` saved before that day: a Time Machine backup or local snapshot, a sync folder, a
copy you made, the file on another disk. Such a copy still opens the old way on this Mac: any
program running as you can ask for your Touch ID with it, in its own dialog, and a Phosphor from
before Phosphor-only opens it too. The keys inside are your wallet's keys, so such a copy can spend
the same money.

What Phosphor deletes: only the copies it wrote itself, the temp file a write cut short leaves
beside the key file, and only after the Phosphor-only file has opened once. It never touches a Time
Machine snapshot, a sync folder or a file you made. A backup you exported with a password is a
password file: this step does not change it, and anyone with the file and the password opens it
anywhere.

What it means: once a wallet is Phosphor-only, delete the old copies you know of, and approve a
Touch ID dialog only for something you started in Phosphor. What closes it for the vault: the move
to the chip, after which the old key is no key of the vault. An old copy still holds the allowance,
the gas account and Hyperliquid.

## A readable key file is trusted only on a Mac known to have no Phosphor-only wallet

A wallet from before encryption lives in a readable `keys.json`, and nothing pins that file to a
wallet. On a Mac where any wallet is Phosphor-only, Phosphor does not open one: a program running as
you could have put its own wallet where the Phosphor-only file was. The lock card says the key file
stayed closed and offers Restore from your backup, and Phosphor will not encrypt the file. A copy of
Phosphor that cannot read its keychain (the development shell, `npm run tauri dev`, or a copy built
without the Developer ID) cannot tell whether the Mac keeps one, so it does not open the file
either: Encrypt now says so, and the card points to the Phosphor app you downloaded and offers
Restore from your backup. On a Mac with no
Phosphor-only wallet, the Phosphor app still reads the file as your wallet and offers to encrypt it,
as it always has. The one exception is the bare backend (`npm run app`), which has no vault service
to ask: it reads the file as your wallet on any Mac.

What it means: "Your keys are not encrypted" is only for a wallet made before Phosphor encrypted
keys. If you never had one, do not set a password there.

## The venues are not ours

Money inside NEAR Intents is held by the verifier and moved by solvers; money on Hyperliquid is
held by the venue. The app reads them and signs for them, and it cannot make either of them do
anything. A bridge that holds a failed deposit refunds it on its own timetable, through its own
support, and the app can only keep asking and show you the state honestly. A venue outage means
the app shows unknown, never zero, and signs nothing against a number it could not read. The NEAR
Intents verifier can be upgraded by its owners, and an invite claim that goes through 1Click rests
on 1Click delivering it.

What it means: a move whose card says Taking longer, or that reads Not confirmed, is money in
the venue's hands, not lost and not the app's to recover by itself. Do not send it again.
[Troubleshooting](troubleshooting.md#a-move-is-late-or-not-confirmed) says what to do.

## The paper is the only key that opens the vault away from this Mac

After the move to the chip, the vault answers to this Mac's Touch ID key and to the 24 words you
wrote by hand, and to nothing else. The key backup alone no longer reaches the vault. A restore on a
new Mac needs both: the key backup brings back the vault's address, the allowance, the gas account
and Hyperliquid, and the paper brings back the vault. Phosphor has you type three of the words back
before anything moves, so a slip in another word is caught only when you restore, and the paper
signs a proof on chain in the same call that adds it, but nothing can check the paper itself. Check
each word as you write it.

What it means: if this Mac is lost and the paper is lost or wrong, the money in the vault is lost.
Keep the paper like cash, apart from the key backup. The paper is an ordinary EVM key, so it also
signs for the vault in any EVM wallet if Phosphor is gone. What closes it: nothing in this build.

## The key backup also controls the allowance and the gas account

The allowance key and the gas account's key are derived from the owner key, never stored, so the
backup you already have brings both back. The cost: whoever holds that backup also holds the
allowance (its size plus 10 percent, $110 at the default, more while a move is under way), the gas
account (about 0.5 NEAR) and Hyperliquid, even after the vault has moved.

What it means: keep the key backup like cash too. What closes it: nothing planned; deriving the two
keys is what keeps one backup instead of three.

## After the move, your wallet's words still open the allowance, the gas account and Hyperliquid

The move takes your wallet's key off the vault, not out of use. The Vault tab still shows your
recovery phrase, or your private key, after the move, behind the same Touch ID, and says beside
them what follows. Those words no longer open the vault, but the allowance key and the gas key are
derived from them, and they still own your Hyperliquid account.

What it means: whoever reads those words can spend the allowance, the gas account's NEAR and your
Hyperliquid collateral, though never the vault. Show them only to write your backup. What closes
it: nothing planned.

## NEAR Intents' admins can switch predecessor auth back on

The move turns auth by predecessor id off for your vault: the NEAR door in the Vault tab, a way for
your wallet's key to act for the vault through its NEAR account. The verifier's admins can turn it
back on for any account, which would let that key reach a moved vault again.

What it means: the Vault tab reads the flag from the chain and says when the door is open. If it
does, keep your key backup like cash; if anyone else may have it, send your money to a wallet only
you control. What closes it: nothing Phosphor controls; the switch is the verifier's.

## A backend compromised after the move writes every dialog but the chip's

The owner key's unwrap and the presence ask carry sentences the backend writes. A backend someone
broke into after the move can word those dialogs as it likes, and can ask for your paper on a
screen of its own.

What it means: only a chip dialog moves money out of the vault, and the vault service writes that
sentence from the payload it read, never the backend. Phosphor asks for words of your paper only in
a move or a restore you started: type them nowhere else. What closes it: nothing in this build.

## This Mac's login password answers the chip's dialog

The vault's Touch ID key asks for you on every use, by Touch ID or this Mac's login password.

What it means: a stolen Mac and its login password move the vault. Keep the password strong and the
Mac locked when you leave it. What closes it: nothing in this build.

## Every chain read trusts one NEAR RPC

The app reads NEAR through one provider, FastNEAR. Phosphor checks what it can: a move is called
done only when the whole move reads right at one block, and a top-up the RPC turned down after it
saw the signed bundle waits on NEAR rather than reading as nothing moved. Three gaps stay. A lying
RPC can make a top-up whose call landed look dead, because the check that calls a bundle dead
trusts a final block whose time is not tied to its hash and asks no second RPC; it can make a
stopped move look done, by lying about the whole move at one block; and it can hide a forced
switch of the NEAR door from the Vault tab.

What it means: in the first case your next approval of the same top-up moves the money a second
time, still inside your own accounts, and the sweep sends what is over the size back to the vault.
What closes it: a second RPC asked before such a verdict, and a final height recorded at the send.

## The chip's sentence must fit the dialog

The vault service refuses any payload whose sentence would run past 120 characters, but no real
Touch ID dialog has been read in a test yet.

What it means: if a dialog ever looks cut short, cancel it. What closes it: a session on a real Mac
that reads each sentence in the system dialog.

## An unlock can keep your owner key out for the session

At an unlock the app asks NEAR whether your vault moved when this Mac holds a chip marker for it
from a move that stopped, or when it could not read the markers at its start. If NEAR answers
after the unlock, a wallet that never moved opens without its owner key.

What it means: moves from the vault are refused, saying the vault moved, until you lock and unlock
again; nothing is signed and nothing moves. What closes it: asking NEAR before the unlock is
answered.

## The trading key's counter can be rolled back

vault.json counts the trading keys the Vault tab has approved on Hyperliquid. A program running as
you that rolls the counter back makes the next Allow trading approve an address the venue approved
before.

What it means: that key's signed actions inside the venue's nonce window, about two days, could
replay. It cannot trade with or approve a key someone else holds: every trading key comes from your
owner key. What closes it: deriving each trading key under its approval's own nonce.

## A signed test session leaves a signing window open

A maintainer's signed run of the release harness unlocks a throwaway keychain for that run, and its
key trusts codesign, so a program running as the maintainer could sign with the Developer ID in that
window.

What it means: nothing for a copy you install; it is about the maintainer's Mac, where such a
program could already read the signing key's file. What closes it: moving the signing keys off the
maintainer's Mac first, and that session waits for it.

## A program running as you during the move

The owner key and the paper sign the call that changes the vault's keys inside the app, not in the
chip. A program running as you while the move runs could read the paper's words as you type them,
pin a wrong allowance, or add a key of its own in that call. Afterwards it cannot: the chip refuses
to add a key, and the paper's key is gone from memory once it signs.

What it means: move the vault on a Mac you trust, with nothing else running that you did not start.
The done screen shows the vault, the allowance and the paper key the move pinned, and the Vault tab
reads the vault's keys from the chain. What closes it: an audit by a third party, which is planned
and not done, and a signer that builds that call itself.

## A Touch ID sentence names a coin by its ticker

The vault's Touch ID says "move 5.00 USDC from your vault to your allowance", not which USDC: USDC
on NEAR and USDC bridged from Ethereum share the ticker, and a payload names each ticker once.

What it means: the value is the same either way, inside NEAR Intents. What closes it: nothing
planned.

## Hyperliquid, and what a withdrawal needs

Collateral leaves Hyperliquid only back into your intents balance, only with your click, and
only while no position is open. Each withdrawal pays the bridge's fee and a 1 USDC activation
fee the venue charges. Below 5 USDC a withdrawal is refused. On a unified Hyperliquid account
the venue refuses the transfer the older exit used; the app either uses the transfer both
account modes accept, or refuses before any quote and names the most it can send.

## A fee can hide inside the loss floors

Quotes come from 1Click and, for swaps by default, from the solver relay. 1Click does not sign
the field that names its fee, and the relay signs nothing it quotes. The app checks what it can:
a 1Click quote must come back as it was sent, a fee line may pay only 1Click, and the quote must
carry 1Click's signature; a relay price is checked against a quote 1Click signed for the same
swap; and what a move gives up is held to a floor. Inside that floor a fee hidden from the app is
not caught.

What it means: someone who can change a quote between your Mac and the venue, which takes
breaking HTTPS, can take up to 3 percent of a swap on either route, 1 percent of a send, 3 percent
of a payout, 5 percent of a Hyperliquid deposit, 0.25 USDC plus 0.4 percent of a Hyperliquid
withdrawal, or 1 percent of an invite claim that goes through 1Click. The relay itself can price a
swap on its route up to 3 percent worse. The 3 percent is measured by dollar figures 1Click signs,
on either route, so it trusts 1Click's prices: a 1Click that signs false figures is not held to it.
A swap of a coin 1Click puts no dollar figure on has no cap at all, so it waits for your click on
either route. The same strict check cuts the other way:
if 1Click starts sending back a field the app does not know, every quote is refused until
Phosphor is updated, and nothing moves.

What closes it: the venues signing what they quote, the fee included.

## A relay swap with no signed price

A relay price is checked against a quote 1Click signed for the same swap. When that quote does not
come back, because 1Click did not answer in time or someone who breaks HTTPS dropped its answer,
the swap waits for your click whatever its size, and its card says Phosphor could not check the
price.

What it means: once you click such a swap, it runs at the relay's price, held only to what its card
says you get at least. Nothing measures it against 1Click's prices, so read that number before you
click.

What closes it: the relay signing what it quotes.

## A relay that answers nothing or an error moves a swap to 1Click

The solver relay is asked first for every swap. When it offers no price for a pair, answers with an
error, or does not answer in time, the same swap goes through 1Click, under 1Click's own checks.
Once the card is drawn the route is fixed: an error at your click stays on the route the card showed.
On the relay a swap is one step: both sides move together or neither does. On 1Click your coins go
to 1Click's solver first, and what you bought arrives a few seconds later; if the swap fails, your
coins come back as a refund.

What it means: whoever runs the relay can send a swap to 1Click by answering nothing, or an error.
The relay and 1Click have one operator, who is already trusted for the price on both routes, so no
new party is trusted; what changes is that this operator holds your coins for those few seconds.

What closes it: a click on every swap that leaves the relay. This build does not ask for one,
because the operator who could send a swap there already sets its price on either route.

## Names a venue lists do not mark the agent

A page, the news, a chain read or a venue's error text marks the agent that reads it, and its
next small move waits for your click. Some names a venue lists do not: 1Click's coin names, the
bridge's asset names and its deposit memo, and the account names in a swap's record.

What it means: a venue that lies, or someone who breaks HTTPS to it, can put words in those names,
and the agent that reads them keeps its no-click moves. Those moves stay inside your rules and
your daily limit.

## A release signs what its build made

Releases are built in a job that holds no secret, and signed in another job that installs and
builds nothing. Before signing, the release checks that the payload's own files match the tagged
source, that every program inside carries only the committed entitlements, and that the vault
service carries the five chip ops and the grammar's newest rule. Nothing checks
what else the build put on the disk image beside the app. It cannot vouch for the compiled
programs (the shell, the bundled Node, the Secure Enclave service) or for the installed packages,
and the release build does not repeat CI's check of each package's registry signature.

What it means: a build job someone tampered with could hand the signing job a changed program, or
an extra file beside the app on the disk image, and it would be signed.
[Check a release yourself](security.md#check-a-release-yourself) covers the payload's files, not
those programs.

What closes it: a build anyone can reproduce byte for byte.

## A release rests on one GitHub account

The signing keys (the Developer ID and the update key) are read only in the release workflow's
`release` environment, which lets only `v*` tags in and waits for the maintainer's approval. The
job that puts the disk image on phosphor.money reads the Blob token alone, in a `release-site`
environment that starts only after that approved job, so a release asks for one approval. Both
are settings on the repository, not code in it. The GitHub API shows them: the approval each
environment asks, then which tags each lets in.

```
gh api repos/karimbabasf/phosphor/environments
gh api repos/karimbabasf/phosphor/environments/release/deployment-branch-policies
gh api repos/karimbabasf/phosphor/environments/release-site/deployment-branch-policies
```

What it means: the maintainer's GitHub account, the only one that can push, approves every
release and can change those settings. Someone who takes that account can ship a signed release.

What closes it: a second person who must approve, or signing that needs a device outside GitHub.

## An armed plan keeps trading after a lock

A trading plan you armed keeps its own trading key when the wallet locks. The key's session lasts
as long as the plan's expiry, a day at most, and a plan whose entry rests on the venue renews it
eight hours at a time until the plan expires, at most seven days after it was made. That key can
place and cancel orders, and can never withdraw or transfer.

What it means: a plan can open or close a position while you are away, inside the limits you armed
it with. Freeze stops every plan from placing anything new. See
[Trading](trading.md#after-the-wallet-locks).

## The audit log is evidence, not a lock

The audit log is append-only and hash-chained, so a hand edit to one entry shows as a broken
chain. The hash needs no key, so a program running as you can rewrite the whole file from the edit
onward, and nothing on chain records that a click or a Touch ID happened.

What it means: read the log as a record of what the app did, not as proof against a program on your
Mac.

## What web reading still lets through

A page is read only at an address a web search returned or you typed, and never at one that
carries your wallet's address or balances. Which pages the agent chooses can still tell those sites
a few bits each: at most 12 pages a session, and 3 a site. With Grok in the chat there is no web
search at all; give it a link and it reads that page.

## An invite code changed by hand

The chat's guard, the backend's wall and the log tail hold back an invite code as it was issued,
and as an editor or a chat app changes it. A code someone retyped with a slip (a character missing,
zeros and ones typed as O, I or L, no PHOS in front and odd spacing, or a code split over two
messages) can reach your agent and its transcript. Paste codes only into the invite field.
[Money](money.md#invite-codes) says how a claim works.

## A claim can look failed for a while

A claim on the relay route is rehearsed first, signed so it expires a millisecond after a recent
NEAR block. A NEAR RPC that stamps that block up to two minutes ahead of the true time can run the
rehearsal. It can pay only your wallet.

What it means: the money lands, but the window says the claim failed until Phosphor's next start
finds it and marks the code claimed. Restart Phosphor before you ask for a new code.

## An agent can stop a worker it did not start

An agent can stop any worker by its id through `agent_jobs`, including a worker another agent
started.

What it means: a worker can lose its job before it reports. It moves no money.

## The invite tools

`npm run invite`, for whoever hands out invite codes, guards the treasury, each code's key and the
encrypted invite file. Its passphrase is what keeps that file shut. Its refusal of piped input
only stops a script or an agent from running it by accident: a program that pretends to be a
terminal gets past it and can read what the terminal shows, live links included.

What it means: type the passphrase only in your own Terminal, never through an agent. A convert
closes on 1Click's word, which is unsigned, so a lying 1Click can mark a convert done before its
money reaches the treasury (a refund counts only once it shows there). A Mac clock running fast
and a lying NEAR RPC together can run a batch's rehearsal as well as its real payload: each code
then holds twice its amount, a claim takes all of it, and `reclaim` takes back what nobody
claimed. A convert may give up 1 percent of its value to a fee hidden in the quote.
`scripts/invite-proof.ts` keeps its throwaway keys in the clear and `release-code` prints a live
code, so put in only what you are ready to lose.
[Money](money.md#issuing-invite-codes) has every command, and the
[security model](security-model.md#the-invite-tools) what each one trusts.

## What the app cannot protect you from

Your own click. A rule that does what it said, an address you confirmed wrongly, or an amount
you approved without reading the card is not something the app can undo. The card and the Touch
ID sentence both name the receiver and the amount so you can read them once more before the
click; nothing reads them for you.

## Where to report a limit you hit

For anything that could move, expose or lose funds, use private reporting on the
[GitHub repository](https://github.com/karimbabasf/phosphor), see
[Security](security.md#reporting-a-problem). For anything else, Help, then Report a Problem in
the menu bar opens an issue form with the version and your macOS filled in.
