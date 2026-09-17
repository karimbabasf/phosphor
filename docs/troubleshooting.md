# Troubleshooting

The situations people actually hit, what the window says in each, and what to do. The rule
under all of them: when the app says a move is unconfirmed, do not send it again. Read first.

## A deposit says Settling or Not confirmed

Settling is the normal state between your click and the venue's answer. The bridge reports
success the moment its solver fills, and your balance can trail that by a block, or by minutes
for a Hyperliquid deposit that crosses a bridge first. The app waits for the balance to rise, up
to ninety seconds inside NEAR Intents and two minutes on Hyperliquid, and the card turns to Done
when it does.

Not confirmed means the venue said success and the app could not see the money land: the balance
had not risen inside the window, or the account could not be read. The card stays up with the
row's own sentence and the quote handle, and says "Do not send it again." Nothing more is signed.
The app judges the row again on every balance refresh, asks the bridge every ten minutes, and
Reconcile asks now. Got it files the card without settling anything; the row stays unconfirmed
in Activity and comes back the moment the venue says something new.

This state exists because of 2026-09-15. A Hyperliquid funding move was accepted by the bridge,
the bridge's relayer ran out of gas on Arbitrum twice, and the app could not read the credit in
the Hyperliquid account. The row stayed unconfirmed until the balance showed. Meanwhile a timeout
told the agent the app was down, it proposed the deposit again, and "deposit $10" moved $20.

Three things changed. A slow answer is now reported as "a proposal may be executing", never as
"not running". Before any intent is signed the app runs five checks (gas on Arbitrum, fee cover,
venue, balance, deadline) and holds a move it cannot afford, retrying for fifteen minutes; the
card says Holding and the checks fold open on the receipt. And an unconfirmed row keeps its hash
and handle, counts against the day's cap, and refuses a same-session repeat with its id.

What to do: wait, press Reconcile once, and read the account or the balance before you approve
anything that looks like the same move. See [Money](money.md#settling).

## Hyperliquid is not answering one of our reads

The line under the trade strip says "Hyperliquid is not answering one of our reads. Trying
again." or "Not connected to Hyperliquid. Trying again." The app retries on its own. While it
does, values it could not read show as unknown, never as zero: the Pro tab says "The trading
venue did not answer, so these are unknown rather than zero." A plan whose price feed has gone
stale shows Feed stale and nothing fires until the feed is fresh. Nothing is signed against a
number the app could not read.

If the line stays, the venue is the cause, not the wallet. Your positions are held by
[Hyperliquid](https://hyperliquid.xyz) with their stops and targets on the venue's own book, so a
venue the app cannot reach is still holding your exits.

## macOS will not open the app

The build is not notarized by Apple, so the first open stops with a warning. Open System
Settings, then Privacy & Security, scroll down to Security and click Open Anyway. Check the disk
image's SHA-256 first, see [Getting started](getting-started.md#check-the-file).

A second copy of the app refuses to start while one is running: "Phosphor is already running as
process N and holding 127.0.0.1:4177. Use that window rather than opening a second one." If the
message names a control app from an earlier session with no window on it, quit that process as it
says and start Phosphor again. If it says the port is in use by something that is not Phosphor,
free the port or set a different one in `config.local.json`.

## The agent does not connect

The MCP server your agent starts is a thin proxy: every call becomes one request to the app on
`127.0.0.1:4177`. Check these in order.

1. Phosphor is running. If not, the agent is told "The control app is not running."
2. The registration line is the one the app gave you, from Connect your own or from Phosphor,
   then Copy MCP Config in the menu bar. It carries the app's data directory, which is where the
   proxy reads the secret the agent's door needs. Without it the app refuses the call and names
   the file it expected.
3. One app, one wallet, one port. A source checkout's backend cannot start while the installed
   app holds 4177, and the other way round; the loser reports the address is already in use.
4. There is room. At most six agents can drive at once; a seventh is told there is no room right
   now. Turn off a session you no longer need.
5. For Start your assistant, the `claude` command must be installed and logged in. The column
   says "Claude Code is not installed on this Mac." when it is missing, and reports the child's
   own reason when a start fails. A start that never reports back is called out after twenty
   seconds.

A proxy started by hand re-reads the app's secret on every call, so restarting Phosphor does not
need the agent restarted. See [Connect an agent](connect-an-agent.md).

## A proposal is waiting as Needs the unlock

The wallet was locked when the agent proposed, or when you clicked. The move was drafted,
priced and checked against your rules, and is waiting for the key. Unlock with Touch ID or your
password. Every waiting move is then decided again against the policy as it stands, and lands as
something to click, small ones included: an unlock is not an approval. If the policy now refuses
the move, it is refused whether or not there is a key to sign it with. See
[Getting started](getting-started.md#the-15-minute-lock).

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

The Activity list on the Basic and Pro tabs is the audit log in sentences, and your assistant can
read the raw lines with `log_tail`. Every refusal names its rule. For a problem that could move,
expose or lose funds, use private reporting on the
[GitHub repository](https://github.com/karimbabasf/phosphor), see
[Security](security.md#reporting-a-problem). For anything else, open an issue there.
