# Troubleshooting

The situations people actually hit, what the window says in each, and what to do. The rule
under all of them: when the app says a move is unconfirmed, do not send it again. Read first.

## A move is late, or Not confirmed

Between your click and Done the card in the chat says the move is working (Swapping, Funding
trading), and your assistant reads what the app is waiting on by name: Sending it, Deposit seen,
On its way, Waiting for the venue to credit it. The bridge reports success the moment its solver
fills, and your balance can trail that by a block, or by minutes for a Hyperliquid deposit that
crosses a bridge first. The app waits for the balance to rise, up to ninety seconds inside NEAR
Intents and two minutes on Hyperliquid, and the card says Done only when it has. See
[Money](money.md#after-the-click) for every stage by name.

Taking longer on the card (your assistant reads "Late, nothing has changed") means the move has
sat on one stage for eight times its usual length, and at least ten minutes. It is not over: the
app keeps asking, and the card moves the moment the venue credits it. Wait, and do not send it
again.

A swap inside NEAR Intents that finds no buyer does not stay late for long: about half a minute
after its three minute transfer window, the card says Didn't go through and nothing left your
balance, and your agent tells you in one line. You can try again then.

Not confirmed means the venue said success and the app could not see the money land: the balance
had not risen inside the window, or the account could not be read. Nothing more is signed, and
the card keeps saying the move is working, then Taking longer. The app judges the row again on
every balance refresh and asks the bridge every ten minutes. An older move still in that state
reads Not confirmed under Recent moves on the Pro tab, and its receipt has Check it again, which
asks now.

This state exists because of 2026-09-15. A Hyperliquid funding move was accepted by the bridge,
the bridge's relayer ran out of gas on Arbitrum twice, and the app could not read the credit in
the Hyperliquid account. The row stayed unconfirmed until the balance showed. Meanwhile a timeout
told the agent the app was down, it proposed the deposit again, and "deposit $10" moved $20.

Three things changed. A slow answer is now reported as "a proposal may be executing", never as
"not running". Before any intent is signed the app runs five checks (gas on Arbitrum, fee cover,
venue, balance, deadline) and holds a move it cannot afford, retrying for fifteen minutes; the
card says Waiting to start, "Nothing is signed until they do", and the checks fold open in its
Details. And an unconfirmed row keeps its hash and handle, counts against the day's cap, and
refuses a same-session repeat with its id.

What to do: wait, ask your assistant to check the move (it reads it again with `swap_check` for a
swap, or `diagnose`), and read the account or the balance before you approve anything that looks
like the same move. See [Money](money.md#after-the-click).

## Hyperliquid is not answering one of our reads

A line on the Trade tab says "Hyperliquid is not answering one of our reads. Trying again." or
"Not connected to Hyperliquid. Trying again." The app retries on its own. While it does, a value
it could not read is left out or reported as unknown, never as zero. A plan whose prices stopped
coming in says Waiting for prices, and nothing fires until they are back. Nothing is signed
against a number the app could not read.

If the line stays, the venue is the cause, not the wallet. Your positions are held by
[Hyperliquid](https://hyperliquid.xyz) with their stops and targets on the venue's own book, so a
venue the app cannot reach is still holding your exits.

## macOS will not open the app

Every release is notarized by Apple, so macOS opens it with no warning. A warning that macOS
cannot verify the app means the file is not one this project released: move it to the Trash and
download it again from the release page or https://phosphor.money, then check the disk image's
SHA-256, see [Getting started](getting-started.md#check-the-file).

Opening a second copy of the app while one is running, such as the copy in the disk image and the
copy in Applications, brings the running one forward and closes the new one, with no message. A
control app left running from an earlier session with no window on it, after a force quit for
example, is stopped and replaced the next time Phosphor opens. When Phosphor cannot start, it
says so in its own window, Phosphor did not open, with one sentence, the reason behind Details,
and Try again. "Another copy of Phosphor, started outside this app, is already running" is
usually one started from a source checkout with `npm run app`: stop it, then press Try again.
"Another program is using the address Phosphor runs on" means something else holds
127.0.0.1:4177: quit that program, or set a different port in `config.local.json`, then press Try
again.

## The agent does not connect

The MCP server your agent starts is a thin proxy: every call becomes one request to the app on
`127.0.0.1:4177`. Check these in order.

1. Phosphor is running. If not, the agent is told "The control app is not running."
2. The registration is the one the app wrote or gave you: the agent picker registers Claude
   Code, Codex, Hermes and Grok itself, shows the one line to paste for any other agent, and
   Phosphor, then Copy MCP Config in the menu bar puts that line on the clipboard. It carries the
   app's data directory, which is where the proxy reads the secret the agent's door needs.
   Without it the app refuses the call and names the file it expected.
3. One app, one wallet, one port. A source checkout's backend cannot start while the installed
   app holds 4177, and the other way round; the loser reports the address is already in use.
4. There is room. At most six agents can drive at once; a seventh is told there is no room right
   now. Turn off a session you no longer need.
5. The agent you picked is on this Mac and signed in. The picker checks it on this Mac, never
   over the network, and says so in one sentence: "Codex is not on this Mac yet. Install it,
   then come back to this screen." or "Codex is installed but not signed in. Sign in in your
   terminal, then press Check again." How to install or How to sign in on its tile opens the
   line to run. Claude Desktop and the chat apps cannot drive Phosphor yet: install Claude Code
   or Codex and pick it. Your assistant, in the Vault tab, shows the same check, with Check
   again; an agent that was uninstalled later reads "X is no longer on this Mac".
6. For the chat's own agent: the chat runs the one you picked, and only Claude Code and Grok run
   there. A pick that runs in your terminal makes the chat say so, for example "Codex runs in
   your terminal, not in this chat." Grok needs `grok login` in a terminal first, and it will
   not start while your Grok setup loads hooks, rules, plugins or other tool servers Phosphor did
   not put there. A start that never reports back is called out after twenty seconds, with Retry.

A proxy started by hand re-reads the app's secret on every call, so restarting Phosphor does not
need the agent restarted. See [Connect an agent](connect-an-agent.md).

## A move card says Unlock to decide

The wallet was locked when the agent proposed or, on a password wallet, when you clicked. (On a
Touch ID wallet a click on a locked wallet asks for Touch ID instead, and opens the wallet for
that one move.) The move was drafted,
priced and checked against your rules, and is waiting for the key. Press Unlock on the card, or
unlock the window, with Touch ID or your password. Every waiting move is then decided again
against the policy as it stands, and lands as something to click, small ones included: an unlock
is not an approval. If the policy now refuses the move, it is refused whether or not there is a
key to sign it with. See [Getting started](getting-started.md#the-five-minute-lock).

## The lock card says the wallet file stayed closed

Phosphor did not open the wallet file on this Mac, because the file is not the one Phosphor saved
here, is an older wallet file on a Mac where a wallet is Phosphor-only (any wallet on this Mac
counts, see [Getting started](getting-started.md#touch-id-and-the-secure-enclave)), or cannot be
read. Nothing moved, and asking Touch ID again opens nothing. The line ends with the way back,
and the button under it, Restore from your private key (or Restore from your recovery phrase),
opens the restore in the card: type your backup, press Restore twice, and one Touch ID opens your
wallet here again. No proven backup is asked for first, since the file this Mac holds cannot be
opened anyway. A cancelled Touch ID changes nothing, and the next press asks again before it
replaces anything.

## A send was refused for a typo

`propose_send` decodes the address for the place it is going before any quote is asked. An EVM
address must be forty hex characters and, when it carries capitals, pass its own EIP-55 checksum.
A Solana address must decode to exactly 32 bytes. A NEAR id must be a valid account id. A
Bitcoin, Litecoin, Dogecoin, Bitcoin Cash, Dash, XRP, Stellar, TON, Tron or Cardano address must
pass its own checksum, and a Sui, Aptos, Movement or Starknet address must be written out to 64
hex characters. An intents account is an EVM address in lower case or a NEAR id. A dropped or
changed character fails one of those checks, and the refusal says which. An XRP X-address or a
Stellar M-address is refused even when it is typed right, because the memo inside it cannot go
with a payout: ask for the plain r... or G... address (see
[Money](money.md#no-memo-tag-or-comment)).

Do not let the agent fix the address. Paste it again from the place you got it, read it back to
the agent character for character, and confirm. A contract address cannot be paid the chain's own
coin at all, because a contract without a receive path burns it. The card and the Touch ID
sentence both name the receiver, so you can check it once more before the click. See
[Money](money.md#send).

## Moving the vault to Touch ID

The move adds this Mac's Touch ID key and your paper key to the vault and takes the owner key off,
in one call that lands whole or not at all. It asks two Touch IDs: the first reads "Move your vault
to this Mac's Touch ID key and your paper key", the second "confirm this Mac's Touch ID key for your
vault". Anything else in the dialog is not the move: cancel it. What the window may say instead:

- **Type your paper key back first.** The 24 words are typed back whole before anything moves. A
  lock wipes words already typed, so after a lock type them again.
- **Those words do not match.** One word differs from your paper or from the screen. While the
  words are still in the window, it names the first slip by its number, never the word; after a
  lock or a restart it cannot, so check each word.
- **The gas account has no NEAR yet, or needs more.** The move is paid from the gas account, a NEAR
  account derived from your key. Add 0.1 to 1 NEAR from the Vault tab: it is a payout you click
  and confirm with Touch ID, and the dialog names the gas account. Nothing is made or signed until
  it can pay. Once your vault is on Touch ID, the NEAR comes from your allowance; when the allowance
  holds too little, Phosphor first moves the difference from your vault, behind one more Touch ID.
- **Touch ID took longer than the move can wait.** Each signature lives about two minutes. Start the
  move again and answer both dialogs when they come.
- **Your last vault move can still land on NEAR.** A call that left this Mac can run until its own
  deadline, so Phosphor signs nothing new for a few minutes. Try again then; you may need to type
  the paper again.
- **Phosphor sent this move and NEAR has not confirmed it yet.** It keeps checking on its own, and
  finishes the move the moment the chain shows it, also after a restart. Do not start it again.
- **Your vault already answers to other keys.** The vault moved, from this Mac or another one. On a
  new Mac, restore it from the Vault tab: restore the wallet from its key backup first, write a new
  paper key, then type the old paper's 24 words.
- **Your vault opens with another Mac's Touch ID key now.** NEAR shows your wallet's own key off
  the vault, and this Mac holds no Touch ID key for it, so this Mac signs no swap, send, payout or
  Hyperliquid deposit from the vault: each one says so before anything is signed. Restore the vault
  on this Mac to spend from it here. The gas account still takes NEAR: Add NEAR shows its account
  whole, to send 0.1 to 1 NEAR to it from any NEAR wallet.
- **A paper shown earlier opens nothing.** It was never added to the vault. Show a new one and write
  that down; destroy the old one.
- **Your vault moved, and it also holds a key Phosphor did not add.** Someone with your owner key
  added a key while the move was being signed, and that key can still move the vault's money. The
  Vault tab names it. Treat the owner key and its backup as seen by someone else: send the money in
  the vault, and in the allowance, to a wallet whose key was made fresh, then stop using this one.
- **Your assistant says your vault is moving.** While the move or a restore runs, your assistant's
  moves wait: it can ask for nothing new, a move it asked for earlier cannot be approved until the
  move is done, and one already on its way stops with nothing sent. Ask again once the move is over.
- **Checking which keys open your vault.** Phosphor's own note of the move on this Mac went missing
  (in vault.json). The Vault tab asks NEAR which keys open the vault, and writes the note back as
  soon as NEAR shows this Mac's Touch ID key on it.

If the Mac is gone, the paper and the key backup together bring the vault back on a new one. If the
paper is gone and this Mac still opens the vault, move the money out with Touch ID while you can:
the Touch ID key cannot add a new paper key on its own. See
[Known limits](known-limits.md#the-paper-is-the-only-key-that-opens-the-vault-away-from-this-mac).

## Something else

Recent moves on the Pro tab lists your latest moves, and an ended one opens its receipt. An agent
in your terminal can read the raw audit lines with `log_tail`. Every refusal names its rule. For
a problem that could move, expose or lose funds, use private reporting on the
[GitHub repository](https://github.com/karimbabasf/phosphor), see
[Security](security.md#reporting-a-problem). For anything else, Help, then Report a Problem opens
the issue form with your version and macOS version filled in; Help, then Copy Log for a Report
puts the newest audit lines on the clipboard to paste into it, with this boot's secrets removed.
[Known limits](known-limits.md) lists what the build does not cover, so you can tell a limit
from a bug.
