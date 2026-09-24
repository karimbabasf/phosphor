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
what signs the moves you approved and the small ones your rules allow. The lock wipes it, and the
lock comes after fifteen minutes with nobody at the window (or the time you set in the Vault
tab), when the Mac sleeps, when you close the window, and when you press Lock now.

What it means: a program that can read the app's memory while the vault is open has the key.
On macOS that takes a process running as you with the right to attach to another process, which
the hardened runtime is there to refuse. Keep the vault open only while you are using it.

What closes it: a separate signing process or a hardware signer, neither of which ships here.

## A local program that reads the seat secret can propose

The agent's door into the app is guarded by a secret the app writes into its own data folder at
every start. A web page cannot read that file. A program already running as you on this Mac can,
and once it has, it can do what your agent can do: read your balances and propose moves.

What it means: a move under your click threshold runs without a click. That is the one money
exposure such a program has, and your rules set its size. If a hostile program running as you is
something you worry about, lower the threshold in the Vault tab, or ask your assistant to set it
to zero: at zero every move waits for you. Nothing on this Mac can approve a move: the click
needs the window token, which no route serves and no program can fetch.

What closes it: the agent's door moving onto a socket the operating system can identify the
caller of. Until then the seat secret is the credential in its place.

## The app is not notarized by Apple

The download is signed by the build itself, not with an Apple Developer ID, and Apple has not
notarized it. So the first open stops at a Gatekeeper warning, and you go through System
Settings, Privacy & Security, Open Anyway. Notarization needs an Apple Developer account this
project does not hold yet.

What it means: the checksum on the release page is what proves the file is the one we built.
Check it before you open the disk image, every time, see
[Getting started](getting-started.md#check-the-file). Two more things follow from the missing
Developer ID. The Secure Enclave key is bound to this Mac rather than to Phosphor, so the Keys row
in the Vault tab says that other apps on this Mac could ask for the key; a Developer ID build
binds it to the app. And a
signed update still verifies: the updater checks the bundle's own signature, which does not
depend on Apple.

What closes it: an Apple Developer account and a Developer ID certificate in the release
workflow, which is already written to use them when they are set.

## The venues are not ours

Money inside NEAR Intents is held by the verifier and moved by solvers; money on Hyperliquid is
held by the venue. The app reads them and signs for them, and it cannot make either of them do
anything. A bridge that holds a failed deposit refunds it on its own timetable, through its own
support, and the app can only keep asking and show you the state honestly. A venue outage means
the app shows unknown, never zero, and signs nothing against a number it could not read.

What it means: a move whose card says Taking longer, or that reads Not confirmed, is money in
the venue's hands, not lost and not the app's to recover by itself. Do not send it again.
[Troubleshooting](troubleshooting.md#a-move-is-late-or-not-confirmed) says what to do.

## Hyperliquid, and what a withdrawal needs

Collateral leaves Hyperliquid only back into your intents balance, only with your click, and
only while no position is open. Each withdrawal pays the bridge's fee and a 1 USDC activation
fee the venue charges. Below 5 USDC a withdrawal is refused. On a unified Hyperliquid account
the venue refuses the transfer the older exit used; the app either uses the transfer both
account modes accept, or refuses before any quote and names the most it can send.

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
