# Getting started

Phosphor is a Mac app that holds your keys, your venue connections and your rules. An agent reads
your money and proposes moves; you approve each one with a click in the window. This page takes
you from the download to a wallet that is made, backed up and locked, and shows you the brake.

## Download

Download the disk image from [phosphor.karimbabasf.com](https://phosphor.karimbabasf.com). It needs
an Apple silicon Mac on macOS 13.5 or later. Open the disk image and drag Phosphor into
Applications. The source is at [github.com/karimbabasf/phosphor](https://github.com/karimbabasf/phosphor).

## Check the file

The app holds keys, so check the file before you open it. The release page lists the SHA-256 of
the disk image. This line must print the same one:

```sh
shasum -a 256 ~/Downloads/Phosphor-macOS-arm64.dmg
```

If the two differ, delete the file and download it again.

## The Gatekeeper warning

The build is not notarized by Apple yet, so the first open stops with a warning. Open System
Settings, then Privacy & Security, scroll to Security and click Open Anyway. See
[Troubleshooting](troubleshooting.md#macos-will-not-open-the-app) if the app still refuses.

## First open

The window opens on a welcome screen: "Your money stays on this Mac, under a key only you hold.
Your assistant does the work, and every move waits for your click." Nothing is uploaded and there
is no account to make. Click Get started.

Every address the app makes is a real address that can hold real money. There is no practice
mode. Size your first deposit as a test.

## Create or restore a wallet

What the first run shows depends on your Mac.

### With a Secure Enclave

The Secure Enclave is a separate chip inside your Mac that holds keys and never lets them out. On
a Mac that has one, the first run is short: Create your wallet is one click and one Touch ID.
There is nothing to write down yet. The app then shows your addresses and asks you to connect an
assistant, see [Connect an agent](connect-an-agent.md).

### With a password

Without an enclave, the app asks you to make a new wallet or bring one in with its recovery
words. Set a password of at least eight characters. Nobody can reset it, not the app and not your
assistant. The app then shows twelve recovery words once, and asks you to type three of them back
by their number before it goes on.

The last screen, Set the ask threshold, shows the click threshold. The shipped default is $100. A
change to it goes through your assistant and waits for your click, see [Policy](policy.md).

### A wallet from another Mac

A wallet file made on a different Mac cannot be opened here, because its key lives in that Mac's
enclave. The window says Made on another Mac and asks for your recovery phrase, twelve or
twenty-four words, to bring the wallet here.

## The backup words

The recovery phrase is the only way back to the wallet. Anyone who has it has your money, and
nobody from this app will ever ask you for it.

On an enclave wallet the phrase is not shown at first run. Open the Vault tab, then Recovery,
and click Reveal recovery phrase. Touch ID shows the words on that screen only. Write them down
somewhere that is not this Mac, then click Prove it and type three of the words back by their
number. Only that turns the chip from Not backed up to Backed up.

Until then the top bar shows Not backed up, and the first deposit that lands raises a card that
says "You have money in. Back up now." The Vault tab refuses to forget a wallet whose phrase has
not been proven backed up.

A password wallet shows its words at creation. The Vault tab also offers Show my recovery words
and Save an encrypted backup, both behind the password.

## Touch ID and the Secure Enclave

The Vault tab's Custody card says which kind of wallet you have. Secure Enclave on this Mac opens
with Touch ID, or your Mac login password. The key file, `keys.enc.json`, sits under `~/.phosphor`,
outside the app and outside any code checkout. Its contents are sealed with a data key, and that
data key is wrapped to a key the enclave made and cannot export. Nothing on disk opens the file
without the enclave.

On an enclave wallet, every click you make on a proposal ends in a Touch ID dialog. The dialog
is drawn by macOS, and its sentence is composed by the app from the proposal's own numbers: the
amount, the receiver shortened to eight characters at each end, and the chain. Read it before you
confirm. [Security](security.md) says what this does and does not protect against.

A password wallet on a Mac that has an enclave shows a Move behind the Secure Enclave button. The
Custody card says Software, on this disk until you press it.

## The 15 minute lock

The wallet locks after fifteen minutes with nobody at the window, when the Mac sleeps, and when
you close the window. The window frosts and says Phosphor is locked. Unlock with Touch ID, or with
your password on a software wallet.

Locked, every read still works and the window still shows your balances. A move the agent asks
for while the wallet is locked is drafted, priced and checked against your rules, then waits as
Needs the unlock. When you unlock, each waiting move is decided again and lands as something to
click. An unlock is never an approval.

## Freeze everything

Freeze everything is the last button in the top bar, on every tab. It is the brake. The dialog
says it cancels every working order and disarms every rule, and it asks you to confirm.

Frozen, the policy reads "KILL SWITCH ON: all writes refused." Every proposal is refused until you
press the button again, whatever its size. The app also cancels every order it placed, ends every
armed plan, and closes the positions those plans opened when it can reach the venue. Money does
not leave the app. Check the Trade tab afterwards, see [Trading](trading.md).

## Next

- [Connect an agent](connect-an-agent.md): start the built-in assistant or connect your own.
- [Money](money.md): deposit, swap, send, and fund the trading account.
- [Policy](policy.md): the rules that decide what needs your click.
