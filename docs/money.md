# Money

Phosphor keeps money in two places, moves it between them, and pays it out to other people. This
page walks through every move: where the money lives, deposit, swap, send, funding the trading
account and bringing collateral back, what "settling" means, and the fees that make the app refuse
a move.

## Where money lives

Money lives in two pockets. The Basic tab adds them up: a ring with your total inside it and one
tile per coin. The Pro tab lists your NEAR Intents balance coin by coin, with the trading account
on its own line that opens the Trade tab, where everything about Hyperliquid lives.

- Your [NEAR Intents](https://near-intents.org) balance. NEAR Intents is a settlement layer where
  a signed message (an intent) tells a market maker (a solver) what you want, and the solver
  fills it. Your balance there is held under your wallet's own address. A deposit lands here, a
  swap happens here, and a send leaves from here.
- Your [Hyperliquid](https://hyperliquid.xyz) collateral. Collateral is the money posted in your
  trading account to back positions. It comes from the intents balance and goes back to it.

Nothing else holds money. The app signs no transaction on any chain: every move is an intent or
a venue action signed by the one key in your wallet, and the bridge does the chain work.

## Deposit

Money comes in through the deposit card, never through a tool. Press Add money on the Basic or
Pro tab and the steps run in place, beside the chat. The Addresses row in the Vault tab opens the
same card for the network you pick. Or ask your assistant where to send money: its `deposit` tool
draws the card in the chat for one coin on one network and starts watching for the money.

The card has three steps. Pick the network you are sending on: six quick tiles, then a search
over every network the bridge credits. Pick the token: the list shows what that network credits
and the minimum for each. Then read the address. The card draws it only once this Mac has opened
the wallet since the app started; on a Touch ID wallet that has not, Touch ID to show the address
reads the address and leaves the wallet locked. It checks the QR code by reading it back, and checks the clipboard
after Copy address. Where the network needs a memo, the card says Memo, required with the address.

Before the first address appears you confirm one line: only the tokens on the list can be sent
here, and anything else sent to this address is lost. The same holds for the network: USDC sent on
the wrong network is lost, and the bridge does not refund. Send a small test amount first.

Under the network tiles, Have an invite code? opens a field for a Phosphor invite code. A pasted
code is checked at once, and Use code checks a typed one. A good code says what is waiting
("Nice. $5 is waiting for you."), and Add $5 moves it into your wallet; that can take up to two
minutes, and the line says when it lands. What the app says about the code sits between the field
and the key, and scrolls into view when it changes. A code that holds nothing, or cannot pay, keeps
Use code off until you change the field; if the app could not check it, the key says Try again. A
claim that did not come through stays said on the closed line until you open it. The deposit card
has the same line on its first step.

### When NEAR Intents pauses a network

The bridge can still hand out an address for a network that NEAR Intents has stopped crediting.
So before it shows an address, the app asks two things: whether the swap service will take the
token you picked in on that network right now (a price check that moves nothing), and what the NEAR
Intents status page says. A network that is paused shows no address at all. Its tile and row say Paused, and the
card says why in one sentence, for example "NEAR Intents has paused TON deposits right now, so no
address is shown. Money sent now may not arrive.", with View status, which opens the status page
in your browser. Your assistant's `deposit` tool gives the same answer and opens no card. A
network with trouble reported but still working keeps its address, and the card prints a notice
above it: the money may take longer than usual. The check runs when an address is about to show
and again on the card's own watch while it is open, never on a timer of its own, so an address
already on screen comes down, with the same sentence, if NEAR Intents pauses the network while you
look. A paused network shows its address again within twenty seconds of NEAR Intents taking it back.

The card then watches: Waiting for your deposit, then Arriving when the bridge sees your
transfer, then Almost there, then "is in your balance" once your balance rises. It checks every
few seconds for ten minutes, then more slowly, and stops after two hours. Closing the card does
not stop it, and money sent after it stops still arrives. Your assistant is never given the full
address, only its first six and last four characters. Read the address in the window.

## Invite codes

An invite code is USDC waiting for a new wallet, usually $5. It looks like
`PHOS-2X9QK-M7RTB-0HVFD-K3WPZ-A8GN4CJ` and usually comes as a link,
`https://phosphor.money/invite#PHOS-...`. Paste the code or the whole link on the invite step
after the terms on first open, or under Have an invite code? on the Add money card. The code
still reads with PHOS left off, with its hyphens turned into dashes or spaces, or in full-width
letters. The app checks it first and says what is waiting, that it has a typo, or that it has
nothing left in it. One wrong character, or two neighbours swapped, is caught on this Mac before
the network is asked anything.

The money moves only while your wallet exists and is open: on first open, right after you make
it; later, when you press Add in Add money. It lands as USDC in your NEAR Intents balance and
Activity shows "Invite: +5 USDC".
A claim can take up to two minutes. You can move on, and the app tells you when it lands.

Each code is a key, and the key's address is an account inside NEAR Intents that holds the
money. Claiming signs one transfer with the code's key: everything the code holds, to your
wallet's address. On the solver relay route your address is inside the signed message, so nobody
between this Mac and NEAR Intents can send the money anywhere else. On the 1Click route below,
the code signs a transfer to a 1Click address instead, and the money reaches you only if 1Click
delivers it. Either way your own wallet key signs nothing. A transfer on the relay route pays no
fee, so a $5 code lands as exactly 5.00 USDC. The app calls a claim done only on NEAR
Intents' own record: the code's one-time number (its nonce) spent, which NEAR Intents writes in
the same step that moves the money. Your balance rising is shown, never taken as proof, because a
deposit landing at the same moment would look the same.

If the solver relay turns the claim away because it asks for authorization or a quote, the app
sends it through 1Click instead. That route costs about 0.25 percent, so a $5 code lands as about
$4.99. The first claim that takes this route was checked at the full $5; after that, until the
app restarts, the check says the smaller figure. If 1Click refunds it, the refund goes back to
the code, and the claim ends only once the refund shows there.

Before a claim on the solver relay is signed, the app rehearses it: the same transfer, signed to
expire one millisecond after a recent NEAR block and checked by NEAR Intents at that block. The
NEAR RPC that answers the check is someone else's computer, so it only ever sees that copy, which
no later block can run; the claim itself goes to the solver relay alone. A claim on the 1Click
route is not rehearsed: its signed transfer goes to 1Click. Every signature is written down
before it leaves this Mac. A claim that fails moves nothing: the money stays on the code, and you
can add it again from Add money. If you had moved on, the note on Basic stays until you close it.
If this Mac's clock is more than two minutes behind NEAR's, the app signs nothing and says so: set
date and time to automatic in System Settings, then add the code again. An RPC that lies about
the time could stretch the copy's life by up to two minutes, and even then the money can only
land in your wallet; the app finds it there the next time it opens. If the app quits in the
middle of a claim, it finishes the check the next time it opens.
A code pays once; a second claim says "This code has nothing left in it. Ask whoever sent it for
a new one."

Never paste a code into the chat. What you type there goes to your assistant and its model
provider, so the chat takes the code out of the box, leaves your other words, and opens the
invite field instead. The app's backend turns
such a message away too, before the assistant sees it, and writes none of it to the log or the
conversation. Both know a code with PHOS in front in almost every spelling the invite field reads,
and a code with PHOS left off when spaces or dashes split it into its groups. A code you changed
by hand can still get through, say one with a character missing, its zeros and ones typed as O, I
or L, or one with no PHOS in front and a wrong character or odd spacing, so paste codes into the
invite field only. Phosphor never asks for your recovery phrase to claim a code. A page or an
app that does is not Phosphor.

### Issuing invite codes

This part is for whoever hands out the invites. Run it in your own Terminal, never through an
agent: an agent session would keep every live code in its transcripts and send them to its
model provider. The script refuses piped input, asks for its passphrase with echo off, and shows
the links on the terminal only, never on stdout. Refusing piped input stops a run by accident; a
program that pretends to be a terminal gets past it and can read what the terminal shows. The
passphrase is what keeps the file shut, so type it only in your own Terminal.

The money sits in three places. Your wallet is never touched by any of this. The treasury, T,
holds only the batch you are about to issue. Each code holds its $5 until someone claims it or
you take it back.

    npm run invite -- treasury

makes T, writes its key to `~/.phosphor-invites/invites.enc.json`, and only then prints T's
address. The file is mode 0600 and encrypted (AES-256-GCM, its key made by scrypt from a
passphrase of at least 20 characters that you type on every run and that is stored nowhere).
Run `treasury` again to see the address and what T holds, NEAR USDC and any other USDC; it never
makes a second T. The file
is the only copy of T's key. Lose it and whatever sits in T is gone, while people can still
claim the codes they hold, so keep T near zero between batches. `--file <path>` or
`PHOSPHOR_INVITES_FILE` picks another file, never one inside the repo.

Fund T with the app's normal Send, so you read the receiver on the card before you click. That
send pays 1Click about 0.25 percent, so send count x amount / 0.9975 plus a cent: $50.14 for
ten $5 codes. Any USDC sent inside NEAR Intents works, because

    npm run invite -- convert

turns any other USDC in T into NEAR USDC, the one USDC a code holds. The app's Send pays out of
the USDC your wallet holds, so a send to T can land as USDC on Base or another chain inside NEAR
Intents. `convert` reads what T holds, lists each other USDC with the NEAR USDC it should bring,
and asks you to type yes. Each one is then a swap through 1Click with one signature from T:
everything T holds of that USDC in, the NEAR USDC credited to T, and a refund, if 1Click cannot
fill it, back to T. The quote is checked the way the app checks its own swaps: the request 1Click
priced must be the one sent, with a fee to 1Click's own account and nobody else, and a convert may
give up at most 1 percent of its value (honest quotes gave up about 0.02 percent on 2026-10-01).
It is rehearsed and written to the file before it is signed, like every move here, and the signed
bytes are written down before 1Click gets them. If a run stops, the next `convert` finishes it with
the same bytes, never a second signature, and converts nothing new while they can still run. A
convert ends on NEAR Intents' own record, its one-time number spent, and then on 1Click's word for
the NEAR USDC; a refund counts only once it shows on T. If NEAR Intents can no longer answer for
that number (days later), 1Click's word decides, and a convert 1Click never saw lapses five
minutes after its deadline instead of holding up the next one. A Mac clock more than a minute fast
is refused before the signature, because three minutes on it would be longer on NEAR.

    npm run invite -- issue --count 10 --amount 5 --label "SF builders"

checks that T holds enough and asks you to type yes. If T is short and holds another USDC, it
says exactly how much of which and to run `convert` first; it never converts anything itself.
Then it writes the codes to the file, marked pending, before anything is signed, so a crash from
that moment loses nothing. It builds
one payload from T with one transfer per code (ten at most) and rehearses it: the same transfers,
signed so the signature expires one millisecond after a recent NEAR block, and simulated at that
block. The NEAR RPC that answers the simulation is someone else's computer. No later block can
run a rehearsal as long as the block's time is true, and the script refuses a block stamped less
than a second behind this Mac's clock, so with this clock right the RPC never holds bytes that
could move money. A Mac clock running fast is the one thing that check cannot see, so every
account a rehearsal pays is one you meant to pay: T, the address you typed for a withdraw, or
codes whose keys are already in the file. Only then is the real payload signed, once, written to the
file, and sent to the solver relay. The script waits until NEAR
Intents shows the payload's one-time number (its nonce) spent, reads every code back, marks it
open, and prints the links once. Give one link to one person, and never post them.

If the relay does not answer, the same signed bytes go out once more; nothing is ever signed
twice. If the run stops before the end (a quit, no network), `issue --resume` finishes that
batch, and no new batch starts until it does. If the relay turns a batch away there is no
fallback: the script waits until the signed payload has expired on NEAR's own clock, about two
minutes, and then marks the codes void. T still holds the money.

`--simulate-only` is the rehearsal alone: it shows what NEAR Intents would say, and nothing is
sent. A dry run of `issue` writes its codes to the file as void before it signs, so a reclaim
could take back anything that ever reached them, and `status` lists it as a dry run; it takes the
file's lock like any write. If NEAR's final block looks less than a second behind this Mac's
clock (an honest one trails by about 2.6 s, so a clock running slow shows this), or the RPC does
not answer, a command stops before it signs anything that can run, and says so. A batch then waits for
`issue --resume`.

    npm run invite -- status

shows what T holds, any other USDC in it that `convert` would turn into NEAR USDC, and every
batch: each code's address, amount and state (pending, open, claimed, reclaimed, or void for a
batch that never ran or a dry run). It never shows a code.

    npm run invite -- reclaim [--label "SF builders"] [--address <code address>]

pays each open code's balance back to T, signed with that code's own key, and marks it
reclaimed. A code that already holds under a cent is marked claimed. After a reclaim the app
says of that code "This code has nothing left in it. Ask whoever sent it for a new one." With no
flag it takes every open code,
after you type yes.

    npm run invite -- withdraw --to <address>

sends everything T holds to the address you pass. Copy it from Receive in the app, which shows
only an address it decrypted and checked, and when asked, type back its first six and last six
characters as Receive shows them (a NEAR name, the whole name). A program that swapped your
clipboard for a look-alike would have to match both ends, not just the last six.
The script never reads the wallet's key file: its header is plain text that any program running
as you could edit. A withdraw waits while a batch is pending.

`reclaim` and `withdraw` take `--simulate-only` too. None of these commands has a Plan B: if the
relay refuses one, it stops and says so.

### Checking the claim routes with your own money

`scripts/invite-proof.ts` runs the whole money path on throwaway accounts, so anyone can check
both claim routes before trusting them:

    node scripts/invite-proof.ts init --file ~/invite-proof.json
    node scripts/invite-proof.ts convert --file ~/invite-proof.json
    node scripts/invite-proof.ts run --file ~/invite-proof.json
    node scripts/invite-proof.ts sweep --file ~/invite-proof.json --to <your address>

`init` makes a throwaway treasury and a throwaway receiver and prints both addresses. Send $1 to
the treasury. If it lands as USDC on another chain, `convert` turns it into NEAR USDC the way
`npm run invite -- convert` does, without asking, and writes each convert into the report. `run`
waits for the $1 (30 minutes; `--wait-minutes` changes that); if it arrives as another USDC, `run`
says so and converts it first, the same way. Then it issues two $0.10 codes in one payload, and claims both into the receiver with the app's own claim code: the first
through the solver relay with no quote, the second through 1Click. To reach 1Click it turns the
relay away itself, before anything is sent, the way the relay would if it began to enforce its
key, and the claim falls back on its own. It writes down what NEAR Intents says about each step:
the intent hashes, `is_nonce_used`, every balance before and after, and the relay's
`get_status` answer, then prints that report (`report` prints it again). It never prints a key
or a code. `sweep` sends every cent of NEAR USDC left on the throwaway accounts to your address
and names any other USDC still on the treasury, for `convert` first; it never calls the file done
while a convert is unfinished or a balance did not read. `release-code` issues one $5
code and prints it once, to try a real claim in the app; if its money arrived as another USDC, it
says so and stops, for `convert` first.

If a route turns $0.10 away as too small, start a new proof file and pass `run --amount 0.50`.
1Click gets the partner key in `PHOSPHOR_1CLICK_API_KEY` when one is set, as the app does;
without one it runs on 1Click's public fee tier.

The proof file holds its keys in the clear, because the script runs without a passphrase prompt.
It is mode 0600 and must sit outside the repo. Put in only what you are ready to lose, sweep it,
then delete it.

## Swap

A swap changes what your intents balance holds. Your assistant proposes it with `propose_swap`:
both legs stay inside NEAR Intents and nothing moves on any chain. Any coin the swap service lists
can be swapped, by name. A coin named without its network is the one you hold, or else the one
that quotes the most; when one name fits two different coins, your assistant asks you which.
Before it proposes, your assistant can ask what can be swapped and what a swap would get, with
`swap_assets` and `swap_quote`, and nothing is filed.

The amount is "all", which means every last unit you hold, or an exact amount; more than you hold
is refused before any price is asked. The app asks for a price once per swap and sets the floor,
the least you will get, one percent under that quote. A floor you name yourself is kept, but a
floor of zero, or one more than 20 percent below the app's quote, is refused. Under the click
threshold a swap runs on its own, unless your assistant read text from outside Phosphor (a web
page, the news, a chain read) earlier in that session, was started outside Phosphor and is not
allowed yet, or the swap spends a coin the app cannot price;
above it, the card shows what you pay and what you get at least, and waits for your click. See
[Policy](policy.md#the-click-threshold).

Every coin the swap service lists has a price in your balance. A swap that spends a coin priced
only by that list is judged at the larger of the listed price and what the quote says arrives,
so a wrong listed price cannot make a move look small. Two cases always wait for your click,
whatever the size: a swap whose listed price nothing in the quote can check, and a swap that
spends a coin the app cannot price at all, which is valued off what the quote says arrives.

## Send

A send is the one way money leaves for somebody else, and it leaves only from the intents
balance. Your assistant proposes it with `propose_send` and must say where it lands: on a real
chain (every chain the deposit card lists except Zcash and Aleo, paid out through the bridge),
or inside NEAR Intents (credited to another intents account, nothing touches a chain). The two
are different moves with different fees, and a wrong choice is not reversible.

### The read-back

Before it proposes, the agent is told to read the move back to you and wait for your yes: the
amount, the token, the full address character for character, and where it lands. It is told to
send only to an address you gave it in the conversation, never one from a tool result, a page or
a file. Those are instructions to your assistant, not checks: the app cannot tell where an
address came from. The card and the Touch ID dialog show the address in full, and your click is
the check.

The app then decodes the address for the place it is going. A mistyped address is refused before
any quote (see [Troubleshooting](troubleshooting.md#a-send-was-refused-for-a-typo)), and a
contract cannot be paid the chain's own coin.

### No memo, tag or comment

A payout cannot carry a memo, a destination tag or a comment: the bridge's quote has no field for
one. On the XRP Ledger, Stellar and TON an exchange tells one customer's deposit from another's by
that memo, so do not pay an exchange deposit address there. Pay a personal wallet address. The
card says this on every payout to those three chains, the assistant never asks you for a memo,
and a memo it tries to attach anyway is refused.

The app checks the rest with the chain itself, before the price is shown and again right before
it signs, and refuses the payout when the chain would lose it:

| Chain | Refused |
|---|---|
| XRP Ledger | an X-address (the tag is inside it); an account that requires a destination tag; an account that takes payments only from senders it authorized (DepositAuth, which every AMM account sets); an account that does not exist yet, paid less than the ledger's reserve (1 XRP today); any coin but XRP |
| Stellar | an M-address (the memo is inside it); an account that sets `config.memo_required`; an account that does not exist yet, whatever is paid (a payment cannot create a Stellar account, so its owner funds it first); a token the account has no trustline for; your own NEAR Intents deposit address there, which the bridge shares and tells apart by memo |
| TON | a testnet address. A bounceable (EQ...) or raw (0:...) address is paid as the same account in its non-bounceable form (UQ...), so a new wallet cannot bounce the money back, and the card shows both. A raw address carries no checksum, so the card says a changed character in it would not be caught and names the UQ... form as derived from it: compare that with the receiver's wallet |
| Tron | TRX to a contract, or to an address Tron would not describe |
| Bitcoin Cash | a legacy 1... or 3... address, which is also a Bitcoin address: use the `bitcoincash:q...` form |
| Dogecoin | an address starting with 9, which the payout service refuses |
| Starknet | a short address: write all 64 hex characters after `0x`, leading zeros included |

A chain that does not answer one of those questions is a refusal too, never a guess. Paying your
own deposit address on any other chain, an EVM chain, Solana or NEAR included, is allowed: the
money comes back into your balance, less the fees both ways, and the card says so. That payout is
a deposit, so it obeys what a deposit obeys: it is refused under the bridge's minimum deposit for
the token (2 XRP on the XRP Ledger), for a token the bridge does not take on that chain (any token
on Abstract, where it takes no deposits), while NEAR Intents has paused deposits on that chain,
and on the XRP Ledger while your deposit address does not exist on the ledger yet. If the bridge
does not say what your deposit address on the chain is, the payout is refused; try again in a
minute.

### The click

Every send waits for your click, whatever the size. The click threshold applies to swaps, funding
and trades, which keep money in your own custody; it never applies to money leaving it. The card
in the chat shows what you send, what they get at least, the fee, and the full address in groups
of four with Copy and an Explorer link, the network it lands on, and whether you have sent there
before. When you hold the coin from more than one chain inside NEAR Intents (USDC that came in on
Base and on Arbitrum, say), the send takes the largest, and the card names it after the amount:
1 USDC from Base. Its Details say why it asks and what the chain says about the address.

### The Touch ID sentence

On an enclave wallet the click puts up a Touch ID dialog whose sentence the app composes from the
proposal's own fields, for example "Approve: Pay 0.01 ETH to 0xb583f419...84BB5DB0 on Ethereum
($24.40)". The receiver is shortened to eight characters at each end, counted after the prefix
every address of its kind shares (`0x`, `bc1q`, `bitcoincash:q`, `addr1q`, `UQ`, `r`, `G`, `T`),
on every chain a payout lands on. A Cardano address shows sixteen characters at the front, from
the part of the address that says whose money it is. A NEAR name such as alice.near is shown
whole, however long, because anyone can register a name that starts and ends the same way. The card puts the same characters in the
text colour. Check them against the address you gave, then confirm. While the dialog is up the card says Confirm on your Mac. The
agent's words never reach this dialog.

### The recipients book

The app remembers every send you approved, by network and address. A first send shows "First
send to this address." on the card; a repeat says how many times you sent there before. The book
gates nothing: a known address still takes the click and the Touch ID every time, and the note an
agent attaches to a receiver is kept as data and never drawn as a name.

## Fund the trading account

`propose_hl_deposit` moves USDC from your intents balance into your Hyperliquid account so a plan
has collateral. One signed intent, nothing sent on any chain, and the account credited is your
own. The card is titled Fund trading. Under the click threshold it runs on its own, with the same
exceptions as a swap: an assistant that read outside text, or one started outside Phosphor and
not allowed yet, waits for your click.

The fee is almost flat, about $0.32 plus 0.25 percent, so it is about 3.4 percent on $10 and
about 0.3 percent on $1,000. The app refuses any deposit whose fee is above 5 percent, which is
why a deposit under 7 USDC is refused, and it refuses a quote that would land less than 5 USDC.
While fees on Arbitrum spike, a deposit waits instead of risking the money. The rail finishes by
reading the account, not by trusting the bridge's word.

## Withdraw from Hyperliquid

`propose_hl_withdraw` brings collateral back into your intents balance. It is the only way money
leaves Hyperliquid, it always waits for your click, and it is refused while any position is open
or any margin is in use: close positions first. Hyperliquid never pays an outside address, so
paying somebody from trading collateral is two moves and two clicks: the withdrawal, then a send.

The cost is the bridge fee (about $0.20 plus 0.25 percent) plus a 1 USDC activation fee the venue
charges, because each withdrawal address is new to it. So 8 USDC back costs about 15 percent and
100 USDC about 1.5 percent. Below 5 USDC the withdrawal is refused. The card is titled Collateral
back, and it says Done only once your intents balance shows the money.

## After the click

One card in the chat follows a move from the ask to the end, and it changes in place. Its face
says one of five things: the move is working (Swapping, Sending, Funding trading, Bringing it
back, Placing the trade), it needs your OK, it is Done, it Didn't go through, or a Refund is on
its way. A working move past its usual time says Taking longer, with how long so far. Details on
the card hold the rest: when you approved it or your rules allowed it, when it landed, and each
transaction with its explorer link.

Your assistant reads the finer stage by name. A swap goes Signing, Sending it, Finding a match,
Settling on NEAR, Settled, checking your balance, then Confirmed. Funding the trading account,
and bringing collateral back, go Sending it, Deposit seen, On its way, Waiting for the venue to
credit it, then Confirmed. Done and Confirmed are said only once your balance has risen: the
bridge reports success the moment its solver fills, and the money can trail that by a block, or
by the minutes a Hyperliquid deposit takes to cross. The app watches the balance for ninety
seconds inside NEAR Intents and two minutes on Hyperliquid before it says so.

A move that has not changed for eight times its usual length, and at least ten minutes, is late:
the card says Taking longer, and your assistant reads "Late, nothing has changed". Nothing is
over: the app keeps watching, and the card moves on the moment the venue credits it. A refund and
a failure are endings, and each names why.

A swap inside NEAR Intents moves nothing until a buyer takes it: the transfer and the fill settle
together. While it waits the card says "Sent. Waiting for a buyer to take it." Its signed transfer
can run for three minutes. Once NEAR's own clock and this Mac's are both half a minute past that
and the transfer never ran, it can never run, and the card says Didn't go through: nothing left
your balance. The app reads NEAR's clock and the transfer's nonce itself, so it knows this even
when the swap service does not answer.

If the venue said success and the app could not see the money land, the row is Not confirmed
and nothing more is signed. That is the honest state, not a failure: the money is on its way,
and the card keeps saying the move is working. The app judges the row again on every balance
refresh and asks the bridge again every ten minutes. An older move still in that state shows
Not confirmed under Recent moves on the Pro tab, and its receipt has Check it again, which asks
now. Never send the same move again while it is working, taking longer or not confirmed.
[Troubleshooting](troubleshooting.md#a-move-is-late-or-not-confirmed) walks through the case that
shaped this.

## Fees and refusals

A payout to a chain, a Hyperliquid deposit and a Hyperliquid withdrawal are refused when NEAR
Intents has paused that route, and the card says so in one sentence, for example "NEAR Intents is
not taking payouts to TON right now, so nothing was signed and nothing moved." The app asks when
the move is proposed and again just before it signs, because a card can wait for your click. A
route with trouble reported goes ahead, and the card says it may take longer.

The app refuses a move that loses too much of itself to fees, and names the fee when it does.

- A chain payout may lose at most 3 percent between your balance and the chain. The bridge's flat
  fee counts, so a small payout is refused with the fee named. The flat fee is higher on some
  chains: on 2026-09-26 USDT on Tron needed about $85 and Bitcoin about 0.00074 BTC to clear it.
- A send inside NEAR Intents may lose at most 1 percent.
- A Hyperliquid deposit is refused under 7 USDC and when the fee is above 5 percent.
- A Hyperliquid withdrawal is refused under 5 USDC.
- A swap floor more than 20 percent below the app's quote is refused as no floor at all.
- A swap may give up at most 3 percent of its value to fees and price, by the swap service's own
  dollar figures for both sides. When the swap service gives no dollar figure for a coin there is
  nothing to measure by, and no cap applies. A quote whose request carries a fee, a field or a
  value the app did not ask for is refused before anything is signed.
- A move runs with the coins its card was priced with. If the swap service's coin list names a
  different coin, or counts one in different decimals, when you click, nothing is signed and you
  ask again for a fresh quote.

Every amount the policy reads is priced by the app, never supplied by the agent. A token the app
cannot price is never assumed to be worth a dollar: a swap that spends one is valued off its quote
and waits for your click, and any other move with one is refused.
