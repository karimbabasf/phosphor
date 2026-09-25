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

The build is not notarized by Apple, so the first open stops with a warning. Click Done, then
double-click Open Anyway in the disk image window, which opens System Settings at the Open Anyway
button, or go to Privacy & Security and scroll down to Security yourself. No button there means
the refused open was more than about an hour ago: open the app once more and look again. Check
the disk image's SHA-256 first, see [Getting started](getting-started.md#check-the-file).

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

The wallet was locked when the agent proposed, or when you clicked. The move was drafted,
priced and checked against your rules, and is waiting for the key. Press Unlock on the card, or
unlock the window, with Touch ID or your password. Every waiting move is then decided again
against the policy as it stands, and lands as something to click, small ones included: an unlock
is not an approval. If the policy now refuses the move, it is refused whether or not there is a
key to sign it with. See [Getting started](getting-started.md#the-15-minute-lock).

## A send was refused for a typo

`propose_send` decodes the address for the place it is going before any quote is asked. An EVM
address must be forty hex characters and, when it carries capitals, pass its own EIP-55 checksum.
A Solana address must decode to exactly 32 bytes. A NEAR id must be a valid account id. An
intents account is an EVM address in lower case or a NEAR id. A dropped or changed character
fails one of those checks, and the refusal says which.

Do not let the agent fix the address. Paste it again from the place you got it, read it back to
the agent character for character, and confirm. A contract address cannot be paid the chain's own
coin at all, because a contract without a receive path burns it. The card and the Touch ID
sentence both name the receiver, so you can check it once more before the click. See
[Money](money.md#send).

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
