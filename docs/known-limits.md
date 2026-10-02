# Known limits

What this build does not cover, stated plainly so you can size what you put in it. Each item
says what the limit is, what it means for your money, and what closes it. None of them is hidden
in the app: the Vault tab, the cards and the audit log say the same things in their own words.

## Alpha software that moves real money

Every address the app makes is a real address, and every move it makes is a real move on a real
venue. There is no practice mode. The safety systems are the engineering of one person and have
not had a third-party audit. Read the [disclaimer](https://github.com/karimbabasf/phosphor/blob/main/DISCLAIMER.md)
before you fund the wallet, and start with an amount you can afford to lose.

What closes it: an audit by a third party, which is planned and not done. Nothing internal
gets called an audit until a third party signs it.

## The key is in memory while the vault is open

Your wallet file is sealed on disk, and on a Mac with a Secure Enclave the seal opens only with
Touch ID. But while the vault is open the unsealed key sits in the app's memory, because that is
what signs the moves you approved and the small ones your rules allow. The lock overwrites it, and
the lock comes after five minutes with nobody at the window (or the time you set in the Vault
tab), when the Mac wakes from a sleep of more than a minute, when the screen locks or the Mac
switches to another user, when you close the window, and when you press Lock now. The key stays
in memory while the Mac sleeps. When the screen locks, the Mac switches user or the window closes,
a move that has not been signed yet gets its signature first, two minutes at most, while nothing
new starts. Copies of the key, and of your recovery phrase, that an unlock or a signature left as
text are not overwritten: JavaScript cannot wipe them, so they stay in memory until it is reused,
after the lock too.

What it means: a program that can read the app's memory while the vault is open has the key, and
after a lock it may still find a copy. On macOS that takes a process running as you with the right
to attach to another process, which the hardened runtime is there to refuse. Keep the vault open
only while you are using it.

What closes it: the chip vault, where the Secure Enclave signs NEAR Intents moves itself so that
key never exists as bytes, or a hardware signer. Neither ships here.

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

## The Secure Enclave key is bound to this Mac, not to Phosphor

Every build so far, the signed releases included, keeps the Secure Enclave key bound to this Mac
rather than to Phosphor. The keychain home that would tie it to the app needs the
keychain-access-groups entitlement, and no build carries it yet, so the key is a CryptoKit key any
program running as you can load. On a signed release the vault service answers only the signed
Phosphor app, and on a copy you build yourself it checks the app's identifier alone; the key
itself does not care who asks.

What it means: another app running as you could ask to use the key, and macOS would show that
app's own Touch ID prompt, not Phosphor's. Approve a Touch ID prompt only for something you started
in Phosphor, and read the sentence in it. The Keys row in the Vault tab says the same in one line.

What closes it: a Developer ID provisioning profile that grants the keychain entitlement, so the
key lives in the keychain where only Phosphor can ask for it. A signed update still verifies either
way: the updater checks the bundle's own update signature, and then its Developer ID code
signature against Phosphor's Team ID, before it replaces anything.

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

Every quote comes from 1Click, and 1Click does not sign the field that names its fee. The app
checks what it can: the request must come back as it was sent, a fee line may pay only 1Click, the
quote must carry 1Click's signature, and what a move gives up is held to a floor. Inside that floor
a fee hidden from the app is not caught.

What it means: someone who can change a quote between your Mac and 1Click, which takes breaking
HTTPS or being 1Click, can take up to 3 percent of a swap, 1 percent of a send, 3 percent of a
payout or 5 percent of a Hyperliquid deposit. A swap of a coin 1Click puts no dollar figure on has
no cap at all. The same strict check cuts the other way: if 1Click starts sending back a field the
app does not know, every quote is refused until Phosphor is updated, and nothing moves.

What closes it: 1Click signing its fee field.

## A release signs what its build made

Releases are built in a job that holds no secret, and signed in another job that installs and
builds nothing. Before signing, the release checks that the payload's own files match the tagged
source and that every program inside carries only the committed entitlements. It cannot vouch for
the compiled programs (the shell, the bundled Node, the Secure Enclave service) or for the
installed packages, and the release build does not repeat CI's check of each package's registry
signature.

What it means: a build job someone tampered with could hand the signing job a changed program, and
it would be signed. [Check a release yourself](security.md#check-a-release-yourself) covers the
payload's files, not those programs.

What closes it: a build anyone can reproduce byte for byte.

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
