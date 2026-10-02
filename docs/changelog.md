# Changelog

What changed in each version of Phosphor, newest first, written from the git history of the
[repository](https://github.com/karimbabasf/phosphor). The top entry is the version these pages
describe, and a test fails the suite when it is not the version in `package.json`. Versions
without a git tag say so.

## 0.10.13

Built 2026-10-01, the invite codes and safety pass. Not tagged at the time of writing.

- Invite codes. Someone can send you a code, or a link to phosphor.money/invite, that holds USDC
  for a new wallet, usually $5. Paste it on the new step after the terms, Have an invite code?, or
  later under the same question in Add money. The app checks it on your Mac first and says what is
  waiting, that it has a typo, or that it has nothing left in it. No code? Press Skip.
- The money lands right after your wallet is made, or when you press Add in Add money with your
  wallet open. A claim signs one transfer with the code's own key, and your wallet key signs
  nothing.
  The app calls it done only when NEAR Intents shows the code's one-time number spent, and
  Activity shows "Invite: +5 USDC". If you moved on before it lands, a note on Basic says so.
- A claim that did not come through cannot be missed: the note on Basic stays until you close it,
  and Add money keeps saying it until you open the field. A used or taken-back code says it has
  nothing left in it, a held code says it can't pay out, and both say to ask for a new one. After a
  code that cannot pay, Use code stays off until you change the field, and when the app could not
  check, the key says Try again.
- If the solver relay turns a claim away, the app sends it through 1Click instead, for about 0.25
  percent less, and a 1Click refund goes back to the code. A claim cut short by a quit is finished
  at the next start.
- Before a claim on the solver relay is signed, the app rehearses it with a copy that expires a
  millisecond after a recent block, so the outside server it checks with holds no claim it could
  run later, unless it lies about the time, and then only for up to two minutes and only into your
  wallet. A claim through 1Click is not rehearsed. Every
  signature is written down before it is made, the code's key is let go as soon as it can sign
  nothing more, and a claim stops, moving nothing, when your Mac's clock is more than two minutes
  behind NEAR's. Then the first run, the Add money line or the note on Basic says your Mac's clock
  is off: set date and time to automatic in System Settings, then add the code again.
- A pasted invite code never reaches your assistant. One pasted in the chat leaves the box on its
  own, your other words stay, and the code opens in Add money. The app turns away any chat message
  that still carries one before the assistant sees it, and the log tail and the agent's log read
  cut every code as it was issued. All of them catch a code an editor or a chat app changed:
  hyphens turned into dashes, invisible spaces, full-width letters, a first group cut short or
  PHOS left off. The invite field reads all of those. A code someone changed by hand can still get
  through, so paste codes into the invite field only.
- The invite page on phosphor.money shows the code with Copy and the download, takes it out of
  the address bar before anything else runs, sends it nowhere and loads no analytics.
- The terms card comes back once. The terms now carry the invite code rules (one claim per code,
  no purchase needed, not for sale, the author can end the promotion, taxes are yours), so their
  version is 2026-10-01 and the card has a fifth fact.
- An agent started outside Phosphor, such as Claude Code in a terminal, asks once in the window:
  "Allow this agent?". Until you allow it, every move it proposes waits for your click, however it
  names itself. Allow holds for that connection, and the app's own assistant never asks. The Allow
  card sits in the conversation under the agents it is about, so it never covers your balances or
  the Freeze key. It says how many more agents are waiting and that moves already asked for still
  wait for your OK. Not now is now Ask each time, and an agent you put off keeps a Change on its
  row.
- A page is read only at an address a web search returned or that you typed yourself. One that
  appeared only in the agent's own search words or the search model's notes is refused, and so is
  a page name that answers with an IPv4 address hidden inside IPv6.
- A worker's web search that carries your wallet's address or figures closes its page reading, as
  the chat's does.
- A move that waits after a chain read, the news or a page says "This chat read text from outside
  Phosphor, so this move waits for your OK." So does a move from an agent that read words another
  agent wrote after reading such text (a board post, a worker's report, the name an agent you have
  not allowed gave itself), or that read the raw log. A small move that waits for this, or because
  its agent was started outside Phosphor, says why on its card, and a cancelled card's Details say
  when you said no. A concept your agent records after reading outside text stays on your Mac and
  is not handed to later agents.
- An agent that reads a venue's own words that Phosphor does not know (an error from 1Click, the
  solver relay, Hyperliquid or a chain's node, a refund reason, the NEAR Intents status page) waits
  for your click on every move after that, the way it does after reading a web page. An ordinary
  refusal Phosphor knows (too little margin, an order under the minimum, a price too far out, an
  amount under a route's minimum) reaches the agent in Phosphor's own words instead and changes
  nothing; the card still shows the venue's words.
- A second agent that repeats a move is told which move it repeats, never where that move was paid.
  An agent that reads how a move is going sees the first six and last four characters of the
  address 1Click made for it; the card in the window shows it whole.
- Only the agent that holds a seat can end it, so another program on your Mac cannot drop an agent
  you allowed, and closing an agent frees its seat right away instead of about 12 seconds later.
- A send card says which coin leaves when you hold it from more than one chain inside NEAR
  Intents: 1 USDC from Base.
- Try again on a failed swap names the coins only when they are plain tickers, and a coin name
  with a space or a web address in it is refused.
- Grok asks you for a link instead of searching the web.
- The agent profiles name the built-in tools they allow in full (web search for the chat's
  assistant, Read for the operator), so a tool a later Claude Code adds never reaches them, and
  they deny Claude Code's task list, which newer accounts turn on: the list is a file any program
  on your Mac can write, and Claude Code reads it back to the agent.
- Only the app itself, on its own data folder, adds Phosphor to your agents' settings. A test,
  `npm run app` or a copy on a scratch folder shows the line to paste instead and leaves Claude
  Code, Codex, Grok and Hermes untouched.
- The wallet shuts at once when your screen locks or your Mac switches to another user: a move
  already being signed gets its signature, then the key goes. A move waiting for your click stays
  on its card. The lock screen says why Phosphor locked (your screen locked, your Mac switched
  users or slept, or the minutes you picked went by) and how many moves wait for your OK, without
  saying what they are, and the Vault's lock timer says the window also locks with your screen.
- The wallet locks after 5 idle minutes by default instead of 15. A time you picked in the Vault
  stays, and the app now waits the time you picked; before, it always waited 15 minutes. The one
  exception is 15 minutes picked before this version: the app cannot tell it from the old default,
  so it now reads as 5. Pick it again if you want it.
- Approving with Touch ID checks your limits and Freeze once more right before anything is signed,
  and opens the wallet for that one move only. Showing your deposit address or your recovery
  phrase no longer opens the wallet.
- Freeze over a damaged policy file still stops every plan and says the switch could not be saved,
  and Unfreeze waits until the file is fixed. Freeze tells you when it could not close your trading
  positions.
- Proving your backup asks for three different words. After two misses the window shows the words
  again; after five, the check stops until you show the words again with Back it up. Finishing an
  interrupted migration counts wrong passwords like every other password check.
- A quote changed on its way to 1Click (a fee paying someone else, a field the app never sent, a
  value it never chose) is refused before anything is signed, and a swap gives up at most 3
  percent of its value by 1Click's own figures, when 1Click gives a figure for both coins.
- A swap, send, payout or Hyperliquid deposit moves exactly the coins its card showed. If the coin
  list names another coin or other decimals by the time you click, the move is refused and nothing
  is signed.
- Reading your balances, policy and waiting moves takes a key that only Phosphor's window, the app
  itself and a program you run from its data folder hold. Another account on this Mac, or a
  sandboxed app, learns only that Phosphor is running and its version.
- The Keys row says plainly that the Touch ID key is bound to this Mac rather than to Phosphor, on
  every build so far.
- Phosphor checks its own files before it starts its backend. If any changed since the release
  was built, it starts nothing and asks you to install a fresh copy, with Details that fit the
  window. The security docs show how to check a release yourself.
- Phosphor's window knows its own backend by a question only that backend can answer. If the
  backend stops, its window closes within two seconds and its keys go with it, and a fresh window
  opens when the backend is back. A program that stopped the backend and took its place gets no
  token it can use, and Phosphor will not open onto it. Copy Log, Copy MCP Config and an update's
  check read with a read-only key, so a program that grabs Phosphor's port sees nothing that can
  approve or unlock.
- On a signed release, the Secure Enclave helper and the hand-over at launch accept only the
  Phosphor app signed by Phosphor's team, and the bundled runtime only a Node runtime signed by
  that team, not any other program from it. The backend loads code only from inside the installed
  app.
- The process that holds your key starts with no debugger signal, no NODE_OPTIONS from your Mac,
  no add-ons and no eval, runs only on a runtime signed by Phosphor's team, and loads only 14
  reviewed packages.
- Starting a trading plan no longer leaves a copy of your recovery phrase in memory.
- After an update, a backend the old version left running is found and stopped.
- An update installs only when its code signature is Phosphor's own: Apple's Developer ID,
  Phosphor's identifier and its team. One that fails is refused, the app stays as it was, and the
  update window says the update did not pass its check and where to get that version. While the
  signature is checked the window says Checking the update, and Installing only once the swap
  starts. A failed install no longer says "try again later" next to its Try again button.
- Releases are built in a job that holds no secret. The job that signs and notarizes installs and
  builds nothing, deletes its keychain as soon as notarizing ends, and signs the update with Node
  alone. Release secrets live in a protected environment that waits for an approval and lets in
  only version tags, and the Release workflow has a dry run that builds, signs and notarizes and
  publishes nothing. A release stops unless the payload's own files match the tagged source and
  every program inside carries only the committed entitlements, checked before signing and again
  on the disk image and the update. The compiled programs and the installed packages are not
  compared. The release notes give the disk image and the update archive each their own command
  and the exact line it prints.
- For whoever hands out invite codes: `npm run invite` makes a treasury, funds up to ten codes with
  one signature, shows their links once on the terminal, takes unused codes back, withdraws to an
  address you confirm by its first six and last six characters, and shows where every code stands
  without ever showing a code. It refuses piped input, so a script or an agent does not run it by
  accident (a program that fakes a terminal gets past that; the passphrase is what keeps the file
  shut), works from a file encrypted under a passphrase of at least 20 characters, and rehearses
  every move with a signature no block can run while this Mac's clock is right, before it signs
  the real one. A dry run keeps its codes in the file as void, and status lists it
  as one. The script says plainly that the passphrase is what keeps the file shut.
- `npm run invite -- convert` turns any other USDC that reached the treasury inside NEAR Intents
  (on Base, Ethereum, Arbitrum, Solana and ten more chains) into NEAR USDC through 1Click, with one
  signature from the treasury, after it shows what each will bring and you type yes. Issue, status
  and treasury say exactly what arrived and to run it.
- `scripts/invite-proof.ts` checks both claim routes with your own money on throwaway accounts,
  records what NEAR Intents says about each, and sweeps the rest back. Its `convert` does the same
  for the proof's treasury, `run` converts first and says so instead of waiting for NEAR USDC
  forever, and `sweep` never calls the file done while a convert is unfinished.
- The docs and phosphor.money say only what 0.10.13 does: small moves can run under your limit
  while sends, withdrawals and rule changes always wait, the agent's read-back of an address is an
  instruction and the card is the check, Freeze leaves orders you placed by hand, and the lock
  overwrites the key it holds while copies a signature left can stay in memory.
- phosphor.money/security shows Phosphor's threat model: what the agent can and cannot do, each
  defence with the test that proves it, what stays open, and how to check a release yourself.
- For people who build Phosphor: the update signer names its key the way minisign does, so a test
  that failed about one run in sixteen passes every time.
- For people who build Phosphor: the secret sweep passes again. All 51 values it stopped on were
  public (transactions and addresses the chain reader reads live, deposit addresses, test
  receivers, one curve constant), each now excused by its exact value. `npm run sweep` reads the
  history a push can publish (HEAD, the remote branches and the tags), takes `--history=all` or a
  revision, and fails a shallow clone. CI runs it on every push to main and every pull request, over the full
  history and every pull request head, and checks every installed package's registry signature.
- For people who build Phosphor: `npm run attack` plays a hostile program on your Mac against the
  app `npm run app:build` made and proves each defence holds, 26 cases including the three serious
  findings of this release's audit; `-- --app <Phosphor.app>` adds the checks that need a signed
  build. `scripts/xpc-attack.sh` compiles again, and ip-address is 10.7.2 (four advisories closed).
  It runs unattended on a Developer ID build: it never runs a changed copy of a notarized app,
  times out any caller that hangs, and says who refused each stranger (the service, launchd or
  macOS). Its screen-lock check locks only the shell it started, which also hears that signal
  addressed to its own process id; `--real-screen-lock` posts macOS's own notice, which every app
  receives. It leaves nothing outside its scratch: WebKit state stays in the throwaway home,
  launched copies leave no LaunchServices record, and passing cases leave no temp folders. The
  task-list check finds the claude CLI the way the app does, and skips with the reason when there
  is none.

## 0.10.12

Built 2026-09-30. Tagged v0.10.12 on 2026-09-30.

- Phosphor is now signed with an Apple Developer ID and notarized by Apple. A new download opens
  with a double click, with no Open Anyway step in System Settings. The installer window drops
  the old first-open tile.
- The part of the app that asks the Secure Enclave and Touch ID to unlock your keys now runs as
  its own service inside the app, and answers only a caller signed by Phosphor's team. Another
  program on your Mac that asks it gets refused.
- Your wallet, your keys and your settings stay as they were.

## 0.10.11

Built 2026-09-27. Tagged v0.10.11 on 2026-09-27.

- A chart of a coin Hyperliquid does not list, such as 1INCH on Coinbase, now names that coin
  in the Trade header, says "on Coinbase" under it, and shows its price. The header used to stay
  on the last Hyperliquid market, so a 1INCH chart sat under a Bitcoin title. The strip no longer
  says Hyperliquid is not answering while such a coin is up.
- Asking your assistant for another market right after the window opened or resized could land
  and then snap back to the old one. The window's own view write no longer undoes a newer switch.
- Every NEAR Intents swap now carries the referral "phosphor", so the NEAR Intents Explorer can
  count the swaps made through Phosphor. The label is public on the explorer, so a swap can be
  seen to come from Phosphor. The app still sends nothing about you anywhere.
- The privacy page says so, and the terms screen shows once more so you can read the change.

## 0.10.10

Built 2026-09-27. Tagged v0.10.10 on 2026-09-27.

- Pro's Activity lists your whole history, not the last four moves. It scrolls inside its card
  and reads the next 40 as you reach the end. A search field finds a move by coin, kind, chain
  or hash, and four filters show All, Swaps, Transfers or the moves that did not go through.
  New moves appear on their own while Pro is open.
- Turning your assistant off after it made trades now leaves the empty card, "Your agent is
  off.", instead of a column of old trade receipts.

## 0.10.9

Built 2026-09-27. Tagged v0.10.9 on 2026-09-27.

- Right after the app starts, a network NEAR Intents has paused no longer shows its address. The
  first check after a start can take longer than four seconds, and an unanswered check used to
  let the address through. The deposit card, Add money and your assistant now wait up to fifteen
  seconds for the real answer before they show an address.

## 0.10.8

Built 2026-09-27. Tagged v0.10.8 on 2026-09-27.

- Send out to 14 more chains: Tron, TON, XRP Ledger, Stellar, Sui, Aptos, Movement, Cardano,
  Starknet, Bitcoin, Litecoin, Dogecoin, Bitcoin Cash and Dash. Zcash and Aleo still take
  deposits only.
- A payout never carries a memo, tag or comment. On XRP, Stellar and TON the card says not to pay
  an exchange deposit address, and your assistant never asks you for a memo.
- The app asks the chain first and refuses a payout that would be lost: an XRP account that needs
  a destination tag or blocks payments, a Stellar account that needs a memo or does not exist
  yet, an X-address or M-address, a new XRP account paid less than its reserve, a Stellar token
  the receiver has no trustline for, TRX to a Tron contract. It checks again right before it signs.
- A TON address is always paid in its non-bounceable form (UQ...). A bounceable or raw address is
  converted to the same account, and the card shows both.
- Bitcoin addresses are checked by their checksum. Bitcoin Cash takes the bitcoincash: form only,
  and Dogecoin addresses starting with 9 are refused, because the payout service refuses them.
- Paying your own NEAR Intents deposit address sends the money back into your balance. It is
  refused on Stellar, while your XRP deposit address does not exist yet, below the bridge's
  minimum deposit, and while that network's deposits are paused.
- The card and the Touch ID dialog name the receiver by the characters that identify it, past
  fixed prefixes like addr1 and bitcoincash:, so a lookalike address cannot pass. A named NEAR
  account is always shown in full.
- When a payout is too small for the bridge's flat fee, the refusal names the minimum in the coin
  and in dollars.

## 0.10.7

Built 2026-09-26. Tagged v0.10.7 on 2026-09-26.

- Add money no longer shows an address on a network NEAR Intents has paused, checked for the
  exact token you pick, and an address already on screen comes down if the network pauses while
  the card is open. The network reads Paused, the card says why in one sentence, and View status
  opens the NEAR Intents status page. A network with trouble reported keeps its address, with a
  notice that money may take longer.
- A payout to a chain, a Hyperliquid deposit and a Hyperliquid withdrawal are refused before
  signing when NEAR Intents has paused that route, checked when proposed and again right before
  the key signs. Your assistant's deposit tool gives the same answer.
- Your assistant can read 35 chains instead of 6: an address's balance and activity, a
  transaction's result, and whether the chain is still making blocks. Zcash is the one it cannot
  read yet, because no public source answers without a key.
- Before a payout, the app reads the receiving address on every EVM chain it pays to, not only
  Ethereum, Base and Arbitrum, and tells you when that address has never been used.
- Payouts to Ethereum and Arbitrum run the gas check again. It had been skipped.
- Looking up a NEAR transaction shows its real result again instead of "unknown".

## 0.10.6

Built 2026-09-26. Tagged v0.10.6 on 2026-09-26.

- The deposit card your agent opens in the chat shows its list of tokens at full width again. It
  had folded to one letter per line, so what a network accepts could not be read.
- Toncoin is called Gram (GRAM) since its 2026-06-15 rename, with Gram's logo. The network is
  still TON, and asking for TON on TON still finds it.

## 0.10.5

Built 2026-09-25. Tagged v0.10.5 on 2026-09-25.

- A new wallet makes one key, the EVM key that signs everything, and nothing else. Wallets used to
  carry a Solana and a NEAR key too that the app never signed with, so money sent to either
  address was stuck. Importing a Solana or NEAR private key is now refused with a sentence.
- A wallet made before 0.10.5 opens exactly as it did, with every key it holds.

## 0.10.4

Built 2026-09-25. Tagged v0.10.4 on 2026-09-25.

- A swap that cannot go through says so about half a minute after its deadline: it didn't go
  through, and nothing left your balance. Phosphor reads NEAR's own clock and the signed transfer
  to prove it can never run, instead of waiting up to ten minutes to look again.
- While a swap inside NEAR Intents waits for a buyer, its card says so. It no longer says your
  money is on its way.
- When a move your agent proposed does not go through, the agent tells you in one line and offers
  the next step, without waiting for you to ask. Anything it files in that turn waits for your
  click, whatever your auto-approve limit. A move that went through stays quiet: the card says it.
- Your agent prices every step of a plan of swaps before it files the first. A coin you do not
  hold yet is priced as a preview, and a step with no price stops the plan before anything moves.
- Pro shows the last 24 hours for every coin NEAR Intents lists, not only the seven it knew.
  Prices are read for every listed coin at once, so no request says which coins you hold.
- Coins without a logo of their own show their real picture instead of a letter. Pictures are
  fetched for every listed coin, checked, and kept on your Mac.
- Quitting with Cmd+Q, the menu or the window's close button shows a Shutting down card with each
  step as it happens: moves noted, wallet locked, Phosphor stopped. The wallet never locks under a
  move that is still being sent.

## 0.10.3

Built 2026-09-25. Tagged v0.10.3 on 2026-09-25.

- A coin bought without a network named lands as its NEAR version, so your balance keeps one tile
  per coin. The agent no longer asks which network; USDT, USDC and wNEAR are picked by their exact
  NEAR ids, never by name, and a coin with no NEAR version goes to the one you hold most of. A
  network you name yourself still wins.
- Add money lists every token a network takes, with its minimum, and asks for your tick every time
  before it shows an address. The deposit card your agent opens in the chat asks the same way.
- Ask your agent what is new: it reads these notes from the copy of the app you run.

## 0.10.2

Built 2026-09-25. Tagged v0.10.2 on 2026-09-25. It was tagged v0.11.0 first; that tag never became a release.

- Quitting asks first. Cmd+Q, Quit Phosphor and the window's close button open a small sheet that
  says what a quit would interrupt: a move on its way (it finishes without the app), a plan entry
  resting at Hyperliquid with no stop yet, a plan that only fires while the app is open, or an agent
  mid-reply. Quit is never blocked: "Quit when it lands" waits for a move and then quits by itself,
  a second Cmd+Q quits at once, and a window that does not answer is quit anyway. The window fades
  out as it goes.
- Side charts draw like the main chart: their indicators, the live price line and the price tag
  with its number. Zones are see-through again instead of solid blocks.
- News reaches the web. The news tool matches every word of the question as a whole word, so a
  question about Gram no longer matches Telegram, and when its four feeds have nothing it says so
  and the agent searches the web. Every web search and page the agent reads is in the audit.
- Onboarding, the terms card and the lock screen sit on the same warm ground as the main window.

## 0.10.0

Built 2026-09-24, the production pass. Tagged v0.10.0 on 2026-09-24.

- Swaps work for every coin 1Click lists, by name, with the exact amount you hold. "All" of a coin
  now means every last unit: a rounding bug made every swap from NEAR ask for a hair more than the
  balance, so those swaps could never run. A coin named without its network is the one you hold,
  or the one that quotes the most.
- A swap asks for its price once, so a small move in the market no longer refuses it and the card
  appears sooner. A swap that fails says so plainly, says when nothing left your balance, and keeps
  watching a signed transfer until it can no longer run.
- Every coin 1Click lists has a price in your balance. A move is judged at the larger of the listed
  price and what the quote says arrives, so a wrong listed price can never make a move look small.
- A new window: warm, soft layers, the conversation on the left and your money on the right.
  Basic shows the chat and your balances in a ring with a tile per coin. Pro is a statement of your
  coins with each coin's day, your policies as three dials, and your recent moves. Trade holds
  everything for Hyperliquid. Vault holds your agents, your policies and your safety controls.
- A move lives in the chat as one card that changes in place, from working to done, with Approve
  on the card when your click is needed. Nothing covers the conversation any more.
- Replies stream in and the chat follows them to the end. Typing no longer shakes the thread, every
  panel opens and closes smoothly, and switching screens slides.
- Real logos for every coin and every agent, and figures that sit on the line of the text.
- The chat runs the agent you pick in the Vault, Claude Code or Grok, and it talks short and plain.
  It can look things up on the web; after it reads a page, every move in that chat waits for your
  click.
- Hyperliquid: a deposit waits while Arbitrum fees spike instead of risking the money, stop prices
  on coins under $1 are rounded correctly, a plan that ends cancels the rest of its entry, a close
  never takes more than its own plan, and Flatten never reports a position closed while it is open.
- Chart markings, studies and layouts are kept per market across a quit until you or the agent
  clear them. A stop or a liquidation level always has its own label on the price axis.
- When the app cannot start, it says so in its own window with Try again, instead of a system alert.

## 0.9.3

Built 2026-09-22, the first-week fixes. Tagged v0.9.3 on 2026-09-22.

- A swap proposed without a floor goes through again. The app sets the floor one percent under
  its own live quote and shows it on the card before you click. Since 0.9.1 every such swap was
  refused before a quote was asked for, so an agent asked you to name a floor yourself.
- The trading screen's header follows the chart. When an agent puts another market on the main
  chart, or a layout changes it, the header, the price and the position panel move with it. Only
  a market Hyperliquid lists moves the header.
- The token list on the deposit card and in onboarding shows each token's mark, its symbol and
  its minimum, and nothing to copy. The contract under each token, with its copy button, read like
  the address to send to, and a coin sent to its own token contract is lost. With the developer
  switch on, each row still shows its contract, labelled.
- Thirty-eight more tokens and networks show their own logo instead of a letter, from the same
  open icon sets as before.
- Opening a second copy of the app brings the first one forward instead of failing on port 4177.
  That happened on a first launch when the copy opened from the disk image was still running. A
  control app left running by a force-quit window is stopped and replaced on the next launch,
  once the app has proved it is its own.
- The update window keeps the release notes inside their box, above the buttons, and wraps them
  at the window's width. This shows from the next update on: the window that offers 0.9.3 belongs
  to the version you are updating from.

## 0.9.2

Built 2026-09-22, the new-address pass. Tagged v0.9.2 on 2026-09-22.

- The site moved to phosphor.money. The Help menu, the terms card, the docs and the release notes
  link there now. The old address forwards to the new one, so a link in an older copy still
  lands.
- The terms card comes back once. The terms now name the new address, so their version is
  2026-09-22 and the app asks for the click again. Nothing else in the terms changed.
- Three libraries under the agent connection (fast-uri, hono and qs) take their patched
  versions, which closes nine security alerts. None of the three was reachable in Phosphor: the
  connection runs over stdio and never loads the parts the alerts are about.
- The libraries the app is built with move forward: zod 4, TypeScript 7, viem 2.56.8, and patch
  releases of the shell's clipboard, dialog, compression and plist crates.
- With zod 4, two kinds of input that used to get through are refused where they arrive: a
  number too large to be real (it read as infinity and reached the app as an empty value), and a
  policy change that names `__proto__` in a share table. An approved policy change is saved only
  if the policy file still loads after it.
- The download no longer carries the TypeScript compiler, which only checks the code while it is
  written and never ran in the app.
- The release notes stop at their last sentence. The notes for 0.9.0 and 0.9.1 ended in the
  tag's signature block, and the update window that offered 0.9.1 showed its first line.

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
