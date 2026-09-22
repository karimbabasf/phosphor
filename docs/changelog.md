# Changelog

What changed in each version of Phosphor, newest first, written from the git history of the
[repository](https://github.com/karimbabasf/phosphor). The top entry is the version these pages
describe, and a test fails the suite when it is not the version in `package.json`. Versions
without a git tag say so.

## 0.9.1

Built 2026-09-22, the first-open pass. Tagged v0.9.1 on 2026-09-22.

- The disk image window carries an Open Anyway shortcut. The build is not notarized, and since
  macOS 15 the warning on its first open has no Open button, only Done and Move to Trash. The
  way through is an Open Anyway button at the bottom of System Settings, Privacy & Security,
  which most people never find. Double-clicked after that warning, the shortcut opens Settings
  already scrolled to the button. The window says the two steps beside it.

## 0.9.0

Built 2026-09-22, the any token any chain pass. Tagged v0.9.0 on 2026-09-22.

- A swap reaches any coin the venue lists on any chain it lists, not only the majors. The app
  used to know five chains on the spend side while the deposit card already took money on
  thirty five. One chain table now serves both, and it carries the venue's own name for each
  chain, because the venue spells three of them differently and a guessed spelling prices a
  quote against the wrong chain.
- A payout reaches every chain whose address the app can decode by itself: every EVM chain,
  Solana, Fogo and NEAR. A chain it cannot decode is refused by name, and the refusal says what
  is missing rather than pretending the chain is unknown. An address the app cannot check is an
  address it will not hand money to.
- When one ticker means two different coins on one chain, the app asks instead of choosing. Two
  tiles, a plain line each, and no long identifier on the face of the card. There is one such
  pair on the venue's list today and its two halves are a hundredfold apart in decimals, so a
  silent pick would have been a silent hundredfold mistake.
- Every move card says what it is worth in dollars, and says "we cannot price this" when the
  venue quotes no price. The dollar figure is the check a person can actually make: a wrong coin
  or a wrong decimals reads as a number that is obviously wrong.
- A card you only have to read no longer looks like a warning. The amber ring belonged to a
  request waiting on you, and it was being painted over receipts, nudges and moves already under
  way. The ask now sits one step above the rail in the assistant's own colour, and everything
  else sits flat and quiet.
- A card sits in the middle of the conversation instead of down on the composer.
- A receiver you approved before is still known to the app, so a wallet you have paid twice does
  not come back as a stranger.
- Toncoin is Gram. The app calls the coin what the venue calls it.
- The agent says how a trade will fill before it arms one. A resting order and a bar close
  condition make different promises, and the same English asks for both.

## 0.8.0

Built 2026-09-20, the ready-for-people pass. Not tagged at the time of writing.

<!-- lead: the six lines below describe nodes A to F. Keep each one only when that node merged;
     the wording follows the builder prompt's mission and the definitions file. -->
- Swaps settle on the relay as one atomic exchange (`token_diff`): what you spend and what you
  receive are one signed message, and the money is never a solver's in between. The 1Click
  transfer path stays behind the `swap.rail` config switch for a month. The 25 bp 1Click app
  fee disappears with it; the 1 pip protocol fee stays.
- Hyperliquid deposits and withdrawals agree across the app, the venue and the card, and the
  exit works on a unified account: the app uses the transfer both account modes accept, or
  refuses before any quote and names the most it can send.
- The connect step is an agent picker: Claude Code, Codex, Hermes, Grok bot, another MCP agent,
  or "I use Claude Desktop or a chat app". The app checks the one you pick on this Mac, says in
  one sentence whether it can drive, registers it where it keeps a config of its own, and the
  Vault tab's Agent panel changes it later. The first run's ask threshold now reaches
  `policy.json`.
- One card per money move in the chat, redrawn in place at every stage, with the agent's reply
  held to three plain sentences; the receipt folds into the move card.
- The buttons and the screens went through a craft pass at 860 and 400 px; every button has its
  five states, and the pending face never shows beside the rest face.
- An anxiety score gates every screen and reply: a judge scores each situation as someone who
  has never bought crypto, and a naive-user run drives the flows.

- Stage words are the app's own. "The router is working" and the other vendor phases are gone
  from the cards: a move reads Sending it, Deposit seen, On its way, Waiting for the venue to
  credit it, Confirmed, and Finding a match, Settling on NEAR, Settled, checking your balance
  on a swap. One table (`src/proposals/view.ts`) is the only place a stage is ever printed.
- The log tail is redacted on the way out. `GET /api/log` and `log_tail` never hand out this
  boot's seat secret or window token, a value filed under a secret's name, or a PEM block, and
  every transaction hash still comes through. Help, then Copy Log for a Report puts the newest
  two hundred lines on the clipboard, one JSON line each.
- Help, then Report a Problem opens the bug form with the version and the macOS version already
  filled in; the form asks for the log and names the picker's agents.
- The secret sweep (`npm run sweep`) runs again. It had failed for days on Cargo.lock's crate
  checksums; a lockfile's checksum lines and the bridge token list are now named as
  machine-written public formats, a mnemonic must be made of seed words, and every fixture
  value in the tree and the history is excused by exact value with a note on what it is.
- The docs describe this build: the 46 tools, the stage words, the policy walls of one click,
  where a fresh install keeps its state and its key, the shell and its updater, and a new
  [Known limits](known-limits.md) page.

## 0.7.0

Built 2026-09-19, the live-truth pass; tagged v0.7.0 on 2026-09-19.

- One object for every move. `src/proposals/view.ts` builds the `ProposalView` that the card
  draws, the agent reads and `/api/state` carries: stage, what it is waiting on, elapsed time,
  time since the stage last changed, the typical duration, the settle time, every transaction leg
  and the error. `proposal_status` returns it. Two copies of that truth disagreeing (a card that
  said "Confirmed at 14:20" while the agent said "still settling") is the bug this ends.
- Stages use the router's own words. A move reads `KNOWN_DEPOSIT_TX`, `PENDING_DEPOSIT`,
  `INCOMPLETE_DEPOSIT`, `PROCESSING`, `SUCCESS` as 1Click reports them, then `crediting` while
  the venue credits it, then `confirmed` at the settle time. "Settling" is gone.
- A late move says so on its own. Eight typical durations after the click (ten minutes at least)
  a move that has not changed flips to `stalled`, "Late, nothing has changed", and keeps settling
  forward the moment the venue credits it. Nothing waits forever without a word.
- The card appears the moment the agent proposes. The propose reply answers on the decision with
  the view attached, where it used to hold for up to twenty seconds waiting for settlement.
- The backend no longer freezes as money lands. One deposit used to write hundreds of audit lines
  in a burst and the app answered nothing for up to twenty seconds at the exact moment the human
  asked "all good?". The settle writes its row before it logs, and a ledger refresh cannot
  re-enter itself.
- Three read-only tools that need no approval: `proposals` lists recent moves newest first,
  `diagnose` returns the view plus the move's own log lines and the router's and venue's status,
  `show` draws a proposal, a transaction, a position or the deposit card in the window. The
  orientation read `start` now names what is in flight and what is waiting, with amounts.
- The agent answers "all good?" with facts: the stage, what it is waiting on, elapsed against
  typical, the transaction hash. Never a bare "waiting".
- Policy in one click. The ten-times-per-step rule is gone: a limit moves to what the sentence
  says in one approval. The ask threshold must sit strictly under the hard cap or the change is
  refused (`never_asks`), a sentence that does not name every figure it moves is refused
  (`sentence_mismatch`), no click can set a limit above $1,000,000 per transaction or
  $10,000,000 per day or session (`above_ceiling`), and an accepted change carries before and
  after for every axis.
- The approval card is the move card: the amount that leaves, in mono, the two pockets, the fee,
  the sentence the app wrote, elapsed against typical, then No and Yes after the facts at every
  width. On a rule change the app writes the headline and the arithmetic and quotes the agent's
  words under them as the agent's. The dock holds the card it drew until it is answered; newer
  asks wait behind one line.
- The assistant's activity indicator is the verb and the clock: what it is doing and for how
  long. The beam, the seat light and every looping pulse are deleted. The one thing that breathes
  is the button waiting on a click.
- Every button reserves the width of its waiting word, so "Waiting for Touch ID" never runs out
  of its box. Twenty-six sites.
- A demo money rail walks every stage on a timer, so the live card can be seen without real
  money; nothing of it is reachable on mainnet.
- An eval suite for the agent: 28 scenarios graded on the tool-call trace, the reply and the
  window's events, in a scripted mode that runs in CI without a model and a live mode that
  drives the real agent.
- Every link the window draws goes through one allowlist, `ui/core/links.js`, which writes the
  anchor itself; a receipt no longer hides a waiting request, and receipts reach the dock again
  (they had not since 2026-09-15).
- A mode the app does not have refuses to boot: the mode override in the environment is checked
  like the config file, so a typo cannot run live rails with the live checks off. A demo boot
  never resolves the real key file, whatever the environment says.

## 0.6.0

Built 2026-09-17, the new-user pass; tagged v0.6.0 on 2026-09-18.

- The terms of use are accepted in the window before anything else opens, once per version of
  the terms; the click is recorded in `state/terms.json` and in the audit log as
  `terms_accepted`. `POST /api/terms/accept` carries the window token like the vault writes.
- A Help menu: Documentation, Report a Problem, Report a Security Issue, Terms of Use, Privacy.
- The chain era leaves: the product is two pockets, the NEAR Intents balance and the Hyperliquid
  collateral, and nothing signs a chain transaction any more.
- One send tool, `propose_send`, replaces `propose_intents_send`: where the money lands is
  required, the agent's read-back is required, every send waits for a click and a Touch ID that
  names the receiver, and a recipients book remembers who you have paid before.
- Payouts on the asset's own chain through the bridge, with the receiver bound in the quote and a
  mistyped address refused before any quote.
- Four read-only chain lookup tools: `chain_address`, `chain_transactions`, `chain_transaction`
  and `intents_activity`.
- Preflight: gas on Arbitrum, fee cover, venue, balance and deadline are checked before any intent
  is signed; a move that cannot clear holds and retries for fifteen minutes; the checks fold open
  on the receipt and the send card.
- The deposit watch reports seen, bridged and credited, and the bridge address is shape-checked,
  confirmed twice and pinned per account and network before it is drawn.
- Audit fixes: proposal rows are sealed in memory and a row rewritten on disk is refused at the
  click, the finger and the unlock; every string an agent sends has a ceiling; the Touch ID
  sentence shows eight characters of each end of the receiver.
- The chart backfills to the venue's own window, gains 1w and 1M and a calendar axis; the license
  becomes FSL-1.1-MIT with an MIT future license.

## 0.5.2

Released 2026-09-16, the Money in pass.

- Money in shows six network tiles in one row over a search of every network the bridge
  credits, then token rows with their minimums that copy their contract.
- Money in credits every network the bridge does, minimums are said straight, and the Hyperliquid
  funding rail refuses what the venue would lose.
- The backup card is raised at every start while the phrase is not proven backed up.
- Security review fixes: a memo network draws no bare QR, a price can never hide a real minimum,
  and Copy names what it copied.
- The README says what Phosphor is, how to install it, how to connect an agent and how to test it.

## 0.5.1

Released 2026-09-15, the hardening build.

- The agent's door takes this boot's seat secret on every call, and a hand-started proxy reads
  it off `agent.secret` in the data directory.
- Every rail verifies the bridge's signature over a live quote before it trusts a deposit
  address, and a deposit that could confirm after its deadline is refused.
- Three answers, not two: a move the venue confirmed but the balance has not shown is settling,
  then Not confirmed, never failed; the card carries Reconcile and Got it; a Hyperliquid deposit
  stays unconfirmed until the account's own ledger shows the credit.
- After an ambiguous outcome a rail never signs again, a same-session repeat is refused, and the
  proxy says a proposal may be executing instead of calling a slow answer "not running".
- Auto-approved moves have a daily ceiling of their own; past it, the next one waits for a click.
- A propose answers within twenty seconds with the row as it stands while the rail keeps running.
- The first run, the deposit steps, the assistant panel with its cards and receipts, and window
  scaling from 960 by 700 up are rebuilt; a wallet created after boot is read without a restart.

## 0.5.0

Released 2026-09-15.

- The vault: keys behind the Secure Enclave, a version 2 keystore with the data key wrapped to
  the enclave, Touch ID to unlock and one touch per click-tier move.
- The Vault tab, the first run and the lock screen on the enclave; restore from twelve or
  twenty-four words; a foreign enclave key is named apart from a damaged file.
- The deposit card draws a QR code it has decoded back, and the `deposit` tool hands the agent a
  fingerprint of the address only.
- The window foundation: the Sora face, tokens, drawn icons, real token logos, motion; dark only.
- Trades and bots become receipts; the receipt card and Activity rows as statement lines.
- The Pro and Basic cards are rebuilt, the trade strip and the deck (Open, Waiting, Done) land,
  panes can be hidden, and the control window opens maximized.

## 0.4.4

Released 2026-09-14, the UI pass.

- One money grammar shared by every surface: a price tag, a figure, a transaction row, a rule
  and a status line, with digits that roll.
- The top bar's right side is one quiet line of state and one control; Freeze everything is the
  last thing in the bar.
- The trade deck sits under the chart: three columns, a price tag, figures as stats and a tape.
- The Limits panel becomes a Policy card, one row per rule in the app's voice.
- The tab you click is written to the server, and every answer on the agent's door names the
  screen the window is on.
- A first move typed on a quiet column starts the assistant with the question waiting.

## 0.4.3

Released 2026-09-14.

- An update installs only the version it was announced as: the download must be the versioned
  GitHub asset, the signed bundle must carry that version, and it must be newer than what runs.
- An update waits for no proposal to be executing, and locks the wallet with a reason the audit
  log keeps before the backend stops.
- The site is out of the update loop: one endpoint, GitHub.

## 0.4.2

Released 2026-09-14.

- The update offer is Phosphor's own window, not a system alert, with a progress bar for the
  download.
- Release notes ship from the tag message.
- The brand mark is drawn from geometry rather than traced.

## 0.4.1

Released 2026-09-14.

- The release that proves 0.4.0 can update itself: a local 0.4.0 found 0.4.1, showed the offer,
  installed on the click and relaunched.
- The release gate runs the tests that decide what ships.
- The release guards run after the enclave sidecar is staged.

## 0.4.0

Released 2026-09-14, the first disk image. A month of work sits between 0.3.0 and this tag.

- Builds a DMG and carries the updater's public key; a test fails when the three version files
  disagree; the macOS floor is 13.5.
- The trading layer: Hyperliquid analysis, plans the venue holds, and the runner, the only
  process that places an order.
- Start your assistant: the app starts a headless Claude Code session locked to its own tools.
- The agent team: a roster, a board and workers; the operator profile.
- The keys move into an encrypted envelope with a scrypt wrap and a header that reads while
  locked; the wallet auto-locks; Freeze everything is called that everywhere.
- The window rebuilt around the conversation and the beam; the Basic screen; the chart engine.
- Funding the trading account from the intents balance, and a way back with a withdrawal.
- Hardening: slippage floors on every venue, a ceiling on policy patches, reserved roster seats.

## 0.3.0

Released 2026-08-12. No git tag.

- The security model says what the agent can now do: choose which surface an approval happens
  on, with every switch audited.
- Documentation for the tool surface and the approval flow.
- What is not claimed is stated too, because the overstated version is the one people quote.

## 0.2.0

Released 2026-08-11.

- The left column is a wallet: token, chain, quantity, price, value, share.
- Three rails behind the policy engine: swap, liquidity provide and withdraw, and a Hyperliquid
  bridge deposit, each run end to end on Arbitrum Sepolia.
- The tool surface grows from nine tools to thirteen, and signing lives in one module.

## 0.1.0

Released 2026-08-11. No git tag.

- The first build: a stablecoin viewer with one write path and a stubbed signer.
- The scaffold, the state layer, the read stack and the first rails.
- The project is named Phosphor.
