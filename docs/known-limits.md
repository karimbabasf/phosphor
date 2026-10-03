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
with no phrase backs up its private key instead, and its whole copy typed back is the proof, so
nothing of the key is kept for it.

What it means: a program that can read the app's memory while the vault is open has the key, and
after a lock it may still find a copy. On macOS that takes a process running as you with the right
to attach to another process, which the hardened runtime is there to refuse. Keep the vault open
only while you are using it.

What closes it: the chip vault, where the Secure Enclave signs NEAR Intents moves itself so that
key never exists as bytes, or a hardware signer. Neither ships here.

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

## An older wallet's Secure Enclave key is bound to this Mac, not to Phosphor

A wallet made before the vault service carried its provisioning profile, and any wallet a copy
you build yourself makes, keeps its Secure Enclave key bound to this Mac rather than to Phosphor:
a CryptoKit key any program running as you can load. A signed release embeds a Developer ID
provisioning profile in the vault service (`src-tauri/signing/vault.provisionprofile`), which
grants it one keychain group, `35Z6P26CBD.com.karimbabasf.phosphor.vault`, and the key of a wallet
it makes lives there, where only that service can ask for it. A copy you build yourself is signed
ad hoc and can carry no profile: macOS kills an ad hoc program that claims a keychain group. On a
signed release the vault service answers only the signed Phosphor app, and on a copy you build
yourself it checks the app's identifier alone; a key bound to this Mac does not care who asks.

What it means: another app running as you could ask to use the key, and macOS would show that
app's own Touch ID prompt, not Phosphor's. Approve a Touch ID prompt only for something you started
in Phosphor, and read the sentence in it. The Vault tab's Keys row offers the step that changes it.

What closes it: Make it Phosphor-only (the Phosphor-only access card in the Vault tab's Keys row of
a signed release; in the code, the bind) moves an older wallet's key into the vault's keychain group
with one Touch ID, once its backup is proven. The service of such a release
makes new keys only in that group, never a device key, and a wallet bound there carries a pin only
the service can write, so a wallet file someone else wrapped to the same key, or an edited one, is
refused before any Touch ID. Once a wallet on the Mac is bound, device-bound key files stop opening
in Phosphor there, copies included. A signed update still verifies either way: the updater checks
the bundle's own update signature, and then its Developer ID code signature against Phosphor's Team
ID, before it replaces anything.

## Old copies of a wallet file still open on this Mac until the keys change

Making a wallet Phosphor-only moves its key into Phosphor's own keychain and writes a new wallet
file for it. From then on Phosphor on this Mac refuses every device-bound wallet file, old copies
included, before any Touch ID. What the step cannot do is reach those copies. A copy of the old `keys.enc.json` made
before the bind (a Time Machine backup or local snapshot, a sync folder, a copy you made, the file on
another disk) still holds the old key, wrapped to a key this Mac's Secure Enclave keeps. Any program
running as you can load that key from the copy and ask for your Touch ID with its own dialog, and a
Phosphor build from before Phosphor-only existed opens it too. The keys inside are the same keys, so such
a copy can spend the same money.

What Phosphor deletes: only the copies it wrote itself, the temp file a write cut short leaves
beside the key file, and only after the Phosphor-only file has opened once. It never touches a Time
Machine snapshot, a sync folder or a file you made. A backup you exported with a password is a
password file: this step does not change it, and anyone with the file and the password opens it
anywhere.

What it means: once a wallet is Phosphor-only, delete the old copies you know of, and approve a
Touch ID dialog only for something you started in Phosphor. What closes it: moving to new keys that never existed outside
the keychain, so the old key holds nothing. The chip vault plans that; it is not built.

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
source and that every program inside carries only the committed entitlements. Nothing checks
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
