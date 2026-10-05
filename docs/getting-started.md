# Getting started

Phosphor is a Mac app that holds your keys, your venue connections and your rules. An agent reads
your money and proposes moves; you approve each one with a click in the window. This page takes
you from the download to a wallet that is made, backed up and locked, and shows you the brake.

## Download

Download the disk image from [phosphor.money/download/mac](https://phosphor.money/download/mac). It needs
an Apple silicon Mac on macOS 13.5 or later. Open the disk image and drag Phosphor into
Applications. The source is at [github.com/karimbabasf/phosphor](https://github.com/karimbabasf/phosphor).

## Check the file

The app holds keys, so check the file before you open it. The release page lists the SHA-256 of
the disk image. This line must print the same one:

```sh
shasum -a 256 ~/Downloads/Phosphor-macOS-arm64.dmg
```

If the two differ, delete the file and download it again.

The checksum proves your file is the one on the release page. This proves the release page's
file was built from the public code. It needs the GitHub CLI (`brew install gh`):

```sh
gh attestation verify ~/Downloads/Phosphor-macOS-arm64.dmg --repo karimbabasf/phosphor \
  --signer-workflow karimbabasf/phosphor/.github/workflows/release.yml \
  --source-ref refs/tags/v0.10.16
```

Put the version you downloaded in the last line. It passes only for a file that this
repository's release workflow built on GitHub's machines from that version's tag, and it prints
the commit it came from, so you can read the exact code you are about to run. Leave out the last
two lines and it also passes for a file any other workflow in this repository vouched for. The
record is signed through Sigstore and kept in a public log that this project cannot edit, so
someone who took over the release page or the site could swap the file and its checksum, but
not this. What it does not prove: that the code is free of bugs. For that, read
[Security](security.md) and [Known limits](known-limits.md). It covers releases from 0.10.1 on.

## First open

The window opens on the welcome: "Your money stays on this Mac, under a key only you hold. Your
assistant does the work. You decide what needs your click." Click Get started.

Then the terms, under Before you start: five plain facts (it is alpha and moves real money, your
keys are yours alone, the venues are not ours, you are 18 or older, an invite code is free, pays
out once and is not for sale) and links to the full
[terms of use](https://phosphor.money/terms/) and the
[privacy page](https://phosphor.money/privacy/), which open in your browser. Nothing
else opens until you click Accept and continue. The app records the click (the date and the
version of the terms) in its own state folder and in the audit log, and asks again only when the
terms change. Nothing is uploaded and there is no account to make.

Then Have an invite code? If someone sent you a Phosphor invite, paste the code, or the whole
invite link, there. The app checks it on the spot and says what is waiting: "Nice. $5 is waiting
for you." Nothing moves yet. The money comes into your wallet right after the wallet is made, on
the addresses step, and that can take up to two minutes; if you have moved on by then, a note on
Basic says when it lands. No code? Press Skip. A code that comes later goes in Add money, under
Have an invite code?. A code never goes in the chat: pasted there, it is taken out of the box
before anything is sent and put in Add money instead, so your assistant never sees it. See
[Invite codes](money.md#invite-codes).

Every address the app makes is a real address that can hold real money. There is no practice
mode. Size your first deposit as a test.

## Create or restore a wallet

What the first run shows depends on your Mac.

### With a Secure Enclave

The Secure Enclave is a separate chip inside your Mac that holds keys and never lets them out. On
a Mac that has one, the first run is short: Create your wallet is one click and one Touch ID.
There is nothing to write down yet. The app then shows your addresses and asks which agent you
use, see [Connect an agent](connect-an-agent.md).

If you already have a wallet (a Mac lost or replaced, the case the backup is for), press I already
have a wallet beside Create a new wallet. Type your recovery phrase, or your private key if your
wallet has no phrase, and one Touch ID restores it here. The key can be typed the way the backup
shows it: with or without 0x, the spaces or line breaks between the groups, even the numbers in
front of each group. A character a key never uses (an o for a 0) is named by its group before
anything is sent. With no wallet on this Mac yet, nothing is replaced, so no backup is asked for; a
cancelled Touch ID leaves the Mac as it was.

Before any address, the next screen, Your wallet is back, names the wallet that came back with its
full address. Check it against the address on your copy: a key with one slipped character restores
a wallet too, an empty one. If it is not yours, press That is not my wallet and type the copy again.

### With a password

Without a Secure Enclave, the app asks you to create a new wallet or restore one from its recovery
phrase, or from its private key if it has no phrase. Set a password of at least eight characters. Nobody can reset it, not the app and not your
assistant. The app then shows twelve recovery words once, and asks you to type three of them back
by their number before it goes on. Take as long as writing them down takes. If Phosphor locks
meanwhile, after five quiet minutes or when your screen locks, the lock card covers the words;
unlock and you are back on the same step. Prove it checks your three words however long ago the
words were shown: past half an hour, or after five wrong tries, it reads them again from the
wallet with the password you just set.

Near the end, When should it ask you? sets the click threshold for this wallet: type an amount,
or pick $25, $100, $500 or $1,000. The shipped default is $100. You can change it any time in the
Vault tab, see [Policy](policy.md#changing-a-rule).

### A wallet from another Mac

A wallet file made on a different Mac cannot be opened here, because its key lives in that Mac's
Secure Enclave. This is what moving to a new Mac with Migration Assistant looks like, so the window skips
the welcome and says Made on another Mac: your wallet file came with you and your money has not
moved. Type your recovery phrase, twelve or twenty-four words, or the private key of a wallet that
has no phrase (see [A wallet with no phrase](#a-wallet-with-no-phrase)), to open it here. The next
screen sets the wallet that came back beside the one the old file names. With no copy at hand,
open Phosphor on the Mac that made the wallet, then Vault, Back it up, and come back with the copy.

## The backup words

The recovery phrase is the only way back to the wallet. Anyone who has it has your money, and
nobody from this app will ever ask you for it.

On a Touch ID wallet the phrase is not shown at first run. Open the Vault tab: under Safety, the
Recovery phrase row has Back it up. Touch ID shows the words in that row only. Write them down
somewhere that is not this Mac, click I wrote them down, then Prove it and type three of the
words back by their number. Only that turns the row's line from Not backed up yet to Backed up.
Showing the words does not open the wallet. Type them back within half an hour; after that, Back
it up shows them again first.

Until then a line at the foot of the window says Recovery phrase not backed up, with Back it up
beside it, and the first deposit that lands reminds you once more. The Vault tab refuses to
forget a wallet whose phrase has not been proven backed up: its Forget row says Back up first.

A password wallet shows its words at creation. In the Vault tab, Show my words (in the Recovery
phrase row) and Save an encrypted copy (in the Restore row) both ask for the password.

### A wallet with no phrase

A wallet brought in as a key has no recovery phrase, so its backup is the private key itself, and
anyone who has it has your money. Under Safety its row is Private key: Back it up and a Touch ID
(or your password, on a password wallet) show the key in that row only, in sixteen numbered groups
of four characters, with the wallet it opens under them. Write the groups down or Print them, then
click I wrote it down and type the whole key back from your copy, once. Only a copy that opens this
very wallet turns the row to Backed up; the line at the foot of the window says Private key not
backed up until then, and Forget waits for it the same way.

The whole copy, and not three groups of it, because a key has no checksum: a copy with one slip is
simply another wallet, and you would find out the day you restore it. A phrase does carry a
checksum, which is why three of its words are enough. If a group is off, the row names it while the
key you were just shown is still on screen; two misses show the key again. Later, Check my copy
checks a copy against this wallet the same way, with no Touch ID and nothing changed. Never check a
copy by restoring it over the wallet you have: after its Touch ID, a restore replaces the wallet on
this Mac with whatever wallet the copy makes. A cancelled Touch ID leaves the wallet you have as it
was.

To bring the wallet back, on this Mac or another one, use Restore from a key in the Restore row
(or the Made on another Mac screen). Type the key as you wrote it: with or without 0x, with or
without the spaces between the groups. The note that says Restored names the wallet it brought,
so check it against the one your copy opens. While the wallet on this Mac is not backed up, the
Restore row says Back up first instead, before anything is typed: a restore of another wallet would
replace the only copy of this one.

## Touch ID and the Secure Enclave

The Keys row in the Vault tab, under Your wallet, says which kind of wallet you have. A Touch
ID wallet's row reads Touch ID: the key is behind the Secure Enclave on this Mac, and Touch ID
or your Mac login password opens it. The key file, `keys.enc.json`, sits under `~/.phosphor`,
outside the app and outside any code checkout. Its contents are sealed with a data key, and that
data key is wrapped to a key the Secure Enclave made and cannot export. Nothing on disk opens the
file without the Secure Enclave.

On a Touch ID wallet, every click you make on a proposal ends in a Touch ID dialog. The dialog
is drawn by macOS, and its sentence is composed by the app from the proposal's own numbers: the
amount, the receiver shortened to eight characters at each end (a NEAR name whole), and the chain. Read it before you
confirm. [Security](security.md) says what this does and does not protect against.

A password wallet says Password in the Keys row: "Locked with your password on this Mac." On a
Mac that has a Secure Enclave, the row also shows Protect with Touch ID, which moves the same
wallet behind the Secure Enclave. Nothing moves and the addresses stay the same.

A wallet made before the signed app could keep its key where only Phosphor reaches it: any app on
this Mac can ask to open it, with its own Touch ID prompt. On a signed release the Keys row then
shows Phosphor-only access: once your backup is proven (Back it up first takes you there), Make it
Phosphor-only does what it says, with one Touch ID that checks Phosphor opens your wallet the new
way before anything changes; a cancel changes nothing. The same wallet, the same addresses. The row
then says Phosphor-only since that day. From then on the wallet's key is in one place on this Mac
that only Phosphor reaches, so your backup is the way back if anything happens to this Mac; that is
why the step asks for it first. Copies of your wallet file saved before then (a Time Machine backup,
a sync folder) still open the old way, so approve a Touch ID prompt only when you started it. A
private key backup is the EVM key alone: an older wallet whose file also holds a NEAR key, a Solana
key or a trading key keeps those only in the Phosphor-only file, and the backup cannot bring them
back if that one key is lost (the app never shows or spends from those NEAR and Solana addresses,
and a trading key is approved again). [Known limits](known-limits.md) says more.

Phosphor-only is one rule for the whole Mac, not for one wallet. The first time a signed release
makes a Touch ID wallet Phosphor-only, or makes or restores one, from any copy of Phosphor and in
any folder, every older Touch ID wallet on this Mac that is not Phosphor-only stops opening in
Phosphor, even one in another folder. Its lock card then offers Restore, and its backup brings it back. So before
you make or restore a second wallet on this Mac, make the one you have Phosphor-only, or at least
prove its backup. A demo run never does this: it makes a password wallet and leaves Phosphor's keys
alone.

## Move your vault to Touch ID

Your vault is the account every deposit lands in. On a Touch ID wallet, the Vault tab can move it to
this Mac's Touch ID key and a paper key you write by hand. After the move nothing else opens it:
every move out of the vault asks for a Touch ID that names it, and your assistant spends from a
small allowance.

Your paper key is the only key that opens your vault away from this Mac. Your recovery phrase also
controls your allowance (at most its size plus 10 percent) and the gas account (about 0.5 NEAR), so
keep both like cash. On a wallet with no recovery phrase, that second backup is your private key.

Under Your vault, the Vault key row takes you through four steps, in order:

1. **Back up your recovery phrase** (or private key). It still opens the allowance, the gas account
   and Hyperliquid after the move.
2. **Add NEAR to the gas account.** It pays NEAR's small fee for every move of your vault. Add 0.1 to
   1 NEAR from the Gas account row: a payout you approve on its card in the conversation, with one
   Touch ID that names the gas account.
3. **Write your paper key.** Show my paper key puts 24 words on screen once, with your vault's
   address to write under them. Write both by hand: there is no Print and no Copy, because a
   printer, a screenshot or a clipboard keeps one more key to your vault. Then type all 24 words
   back from the paper, one to a field, with pasting off. A slip is named by its number, never by
   the word.
4. **Move your vault.** Two Touch IDs: the first reads "Move your vault to this Mac's Touch ID key and
   your paper key", the second "confirm this Mac's Touch ID key for your vault". Cancel any other
   sentence. The row shows each step as it runs, and your assistant's moves wait until it is done.

Afterwards the row lists who opens your vault, as NEAR reads it: this Mac's Touch ID key, your paper
key, and not your recovery phrase. It also shows the NEAR door: a way for your recovery phrase to
act for your vault through NEAR, which the move shut. NEAR Intents' admins can open it again for any
account, and the row would then say so.

The Allowance row reads like "$63 of $100": what your assistant spends with no Touch ID. Anything
over the size plus 10 percent goes back to your vault on its own, USDC first. Top up asks for USDC
from your vault on a card in the conversation, then one Touch ID that names the amount; under a
quarter of its size the row says it is running low. A move bigger than the allowance asks two Touch
IDs on Approve: the first approves the move, the second moves the difference from your vault to your
allowance. See [Money](money.md#top-ups-and-the-sweep).

Once the vault has moved, Allow trading on Hyperliquid, in the Trading key row, approves a new
trading key with one Touch ID: "Let 0x... trade on your Hyperliquid account for 90 days". The row says
when it ends. Allow a new one before then: without a trading key, Freeze cannot close your positions.

On a new Mac, restore the wallet first, with I already have a wallet and your recovery phrase or
private key. The Vault tab then says your vault waits for your paper key. Restore your vault, beside
the wallet's own restore, has you write a new paper key, then type the old paper's 24 words, and one
Touch ID brings the vault here. The restore retires the old paper. See
[Troubleshooting](troubleshooting.md#moving-the-vault-to-touch-id).

## The five minute lock

The wallet locks after five minutes with nobody at the window, when the Mac wakes from a sleep of
more than a minute, when the screen locks or the Mac switches to another user, and when you close
the window. A move waiting
for your click stays on its card through a lock. Locks after, under Safety in the Vault tab, sets the time to 5 minutes,
15 minutes or 1 hour, and Lock now locks at once. The window frosts and says Phosphor is locked,
with a line under it that says why: the screen locked, the Mac switched users or slept, or the
minutes you picked went by. When moves wait for your OK, it says how many. Lock now and the app's
start add no reason.
Unlock with Touch ID, or with your password on a software wallet.

Locked, every read still works. A move the agent asks for while the wallet is locked is drafted,
priced and checked against your rules, then its card in the chat says Unlock to decide. When you
unlock, each waiting move is decided again and lands as something to click. An unlock is never
an approval.

## Freeze everything

Freeze everything is the snowflake at the right end of the top bar, on every tab, and the Freeze
row under Safety in the Vault tab. It is the brake. It asks first: "This closes your open trading
positions at the market price and stops every plan. Nothing can move your money until you
unfreeze."

Frozen, the button reads Frozen and the policy reads "KILL SWITCH ON: all writes refused." Every
proposal is refused until you unfreeze, whatever its size, and a move already on its way stops
at its last step, before it is signed, whether you clicked it or your rules allowed it; one signed
before you pressed Freeze still lands. A trading plan stops before it fires, arms or changes its
orders. The app
also cancels the orders its own plans have resting, closes every open position on your
Hyperliquid account when it can reach the venue, including one you opened somewhere else, and
ends every plan whose position closed. An
order you placed on Hyperliquid yourself stays on the book: cancel it there. Closing a position
takes the trading key; when the app has none in reach, the positions stay open and the window
says so. Money does not leave the app. Check the Trade tab afterwards, see [Trading](trading.md).

If the policy file cannot be read, Freeze still stops every plan, and every move is refused anyway
while the file is unreadable; the window says the switch itself was not saved. Unfreeze is refused
until the file is fixed.

## The Help menu

Help in the menu bar opens the documentation, a problem report on GitHub with your version and
macOS version already filled in, the security page, the terms of use and the privacy page, each
in your browser. Copy Log for a Report, under Report a Problem, puts the newest audit lines on
the clipboard for the report, with this app's own secrets already removed. The Phosphor menu
beside it has Check for Updates and Copy MCP Config. Updates need Phosphor in Applications: a copy
running from the disk image or an external disk, or from a folder whose name holds a quote mark
or a backslash, is not offered one, and Check for Updates says to move it into Applications.

## Next

- [Connect an agent](connect-an-agent.md): pick the agent you already use.
- [Money](money.md): deposit, swap, send, and fund the trading account.
- [Policy](policy.md): the rules that decide what needs your click.
