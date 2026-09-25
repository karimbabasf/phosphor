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
gh attestation verify ~/Downloads/Phosphor-macOS-arm64.dmg --repo karimbabasf/phosphor
```

It passes only for a file that this repository's release workflow built on GitHub's machines,
and it prints the commit it came from, so you can read the exact code you are about to run. The
record is signed through Sigstore and kept in a public log that this project cannot edit, so
someone who took over the release page or the site could swap the file and its checksum, but
not this. What it does not prove: that the code is free of bugs. For that, read
[Security](security.md) and [Known limits](known-limits.md). It covers releases from 0.10.1 on.

## The Gatekeeper warning

The build is not notarized by Apple yet, so the first open stops with a warning. Click Done, not
Move to Trash, then double-click Open Anyway in the disk image window: it opens System Settings,
Privacy & Security, at the Open Anyway button next to Phosphor. Click it. The button appears only
after a refused open, for about an hour. Without the disk image, open System Settings, then
Privacy & Security, and scroll to Security. See
[Troubleshooting](troubleshooting.md#macos-will-not-open-the-app) if the app still refuses.
Notarization needs an Apple Developer account this project does not hold yet; until it does,
the checksum above is what proves the file is the one on the release page. It is listed as a
known gap in [Known limits](known-limits.md).

## First open

The window opens on the welcome: "Your money stays on this Mac, under a key only you hold. Your
assistant does the work. You decide what needs your click." Click Get started.

Then the terms, under Before you start: four plain facts (it is alpha and moves real money, your
keys are yours alone, the venues are not ours, you are 18 or older) and links to the full
[terms of use](https://phosphor.money/terms/) and the
[privacy page](https://phosphor.money/privacy/), which open in your browser. Nothing
else opens until you click Accept and continue. The app records the click (the date and the
version of the terms) in its own state folder and in the audit log, and asks again only when the
terms change. Nothing is uploaded and there is no account to make.

Every address the app makes is a real address that can hold real money. There is no practice
mode. Size your first deposit as a test.

## Create or restore a wallet

What the first run shows depends on your Mac.

### With a Secure Enclave

The Secure Enclave is a separate chip inside your Mac that holds keys and never lets them out. On
a Mac that has one, the first run is short: Create your wallet is one click and one Touch ID.
There is nothing to write down yet. The app then shows your addresses and asks which agent you
use, see [Connect an agent](connect-an-agent.md).

### With a password

Without an enclave, the app asks you to make a new wallet or bring one in with its recovery
words. Set a password of at least eight characters. Nobody can reset it, not the app and not your
assistant. The app then shows twelve recovery words once, and asks you to type three of them back
by their number before it goes on.

Near the end, When should it ask you? sets the click threshold for this wallet: type an amount,
or pick $25, $100, $500 or $1,000. The shipped default is $100. You can change it any time in the
Vault tab, see [Policy](policy.md#changing-a-rule).

### A wallet from another Mac

A wallet file made on a different Mac cannot be opened here, because its key lives in that Mac's
enclave. The window says Made on another Mac and asks for your recovery phrase, twelve or
twenty-four words, to bring the wallet here.

## The backup words

The recovery phrase is the only way back to the wallet. Anyone who has it has your money, and
nobody from this app will ever ask you for it.

On an enclave wallet the phrase is not shown at first run. Open the Vault tab: under Safety, the
Recovery phrase row has Back it up. Touch ID shows the words in that row only. Write them down
somewhere that is not this Mac, click I wrote them down, then Prove it and type three of the
words back by their number. Only that turns the row's line from Not backed up yet to Backed up.

Until then a line at the foot of the window says Recovery phrase not backed up, with Back it up
beside it, and the first deposit that lands reminds you once more. The Vault tab refuses to
forget a wallet whose phrase has not been proven backed up: its Forget row says Back up first.

A password wallet shows its words at creation. In the Vault tab, Show my words (in the Recovery
phrase row) and Save an encrypted copy (in the Restore row) both ask for the password.

## Touch ID and the Secure Enclave

The Keys row in the Vault tab, under Your wallet, says which kind of wallet you have. On an
enclave wallet it reads Touch ID: the key is behind the Secure Enclave on this Mac, and Touch ID
or your Mac login password opens it. The key file, `keys.enc.json`, sits under `~/.phosphor`,
outside the app and outside any code checkout. Its contents are sealed with a data key, and that
data key is wrapped to a key the enclave made and cannot export. Nothing on disk opens the file
without the enclave.

On an enclave wallet, every click you make on a proposal ends in a Touch ID dialog. The dialog
is drawn by macOS, and its sentence is composed by the app from the proposal's own numbers: the
amount, the receiver shortened to eight characters at each end, and the chain. Read it before you
confirm. [Security](security.md) says what this does and does not protect against.

A password wallet says Password in the Keys row: "Locked with your password on this Mac." On a
Mac that has an enclave, the row also shows Protect with Touch ID, which moves the same wallet
behind the enclave. Nothing moves and the addresses stay the same.

## The 15 minute lock

The wallet locks after fifteen minutes with nobody at the window, when the Mac sleeps, and when
you close the window. Locks after, under Safety in the Vault tab, sets the time to 5 minutes,
15 minutes or 1 hour, and Lock now locks at once. The window frosts and says Phosphor is locked.
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
proposal is refused until you unfreeze, whatever its size. The app also cancels resting orders,
ends every plan, and closes every open position on your Hyperliquid account when it can reach the
venue, including one you opened somewhere else. Money does not leave the app. Check the Trade tab
afterwards, see [Trading](trading.md).

## The Help menu

Help in the menu bar opens the documentation, a problem report on GitHub with your version and
macOS version already filled in, the security page, the terms of use and the privacy page, each
in your browser. Copy Log for a Report, under Report a Problem, puts the newest audit lines on
the clipboard for the report, with this app's own secrets already removed. The Phosphor menu
beside it has Check for Updates and Copy MCP Config.

## Next

- [Connect an agent](connect-an-agent.md): pick the agent you already use.
- [Money](money.md): deposit, swap, send, and fund the trading account.
- [Policy](policy.md): the rules that decide what needs your click.
