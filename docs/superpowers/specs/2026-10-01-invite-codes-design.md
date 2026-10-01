# Invite codes: $5 for the people Karim invites

Date: 2026-10-01. Status: draft for Karim, revised after an adversarial review (26 findings,
all folded in). Nothing built. Research behind it: a full read of this repo at 0.10.12
(`167d18c9`), the `near/intents` contract source at the deployed commit, the official Intents
SDK, and read-only live calls against `intents.near`.

## What it does

Karim hands someone a link. They download Phosphor. On the first screen after the welcome they
paste the code. The app checks it and says $5 is waiting. They make the wallet with Touch ID, and
the moment the wallet exists the app moves the $5 into it. Their balance reads $5.00 USDC before
they have deposited anything.

Rules the design holds to:
- No code, no money. A code pays once, ever.
- On the main route nobody can redirect a claim, and no Phosphor server decides who gets paid.
- The person's own key never signs anything for the claim.
- The agent never sees a code and has no tool that touches one.
- The worst case is capped at the money Karim chose to put in.

## The decision: a code is a funded Intents account

Two designs were weighed.

| | A: code is an Intents account (chosen) | B: Solidity claim contract on Base |
|---|---|---|
| Where the $5 lands | Native USDC in the person's Intents balance, where every Phosphor balance already lives | Base USDC, credited in Intents as a different token (`nep141:base-0x8335...omft.near`) after a bridge deposit |
| Code to write and audit | None on-chain | A new contract, deployed and verified |
| Gas | Paid by the solver relay, which executes as `intents.near` | A relayer wallet with ETH on Base, about $0.0015 a claim |
| Signing | The ERC-191 path Phosphor already uses (`src/intents-sign.ts:28-64`) | EIP-712, new to this repo |

A wins: the money lands as the right token in the right place, there is nothing to deploy, and the
signing code exists. B stays the fallback only if NEAR Intents itself becomes unusable.

How A works in one paragraph. Each code is a random secret. The secret turns into a private key,
the key into an EVM address, and that address is an account inside `intents.near` (the contract
creates an account on its first credit, no registration). Karim's treasury puts $5 USDC into that
account. To claim, the app signs a `transfer` intent with the code's key: "move my USDC to
`<the new wallet>`". The contract checks the signature against the code's address, moves the
money, and the account is empty. A second claim fails with `insufficient balance or overflow`.

Facts this rests on, all checked on 2026-10-01:
- A never-used EVM address can receive a transfer and then sign one out with no key registration
  (contract `state.rs` `get_or_create` and `has_public_key`; live `simulate_intents` passed with a
  fresh key).
- `transfer` charges no protocol fee in code (only `token_diff` does), so the person gets exactly
  5.000000 USDC.
- `simulate_intents` is a free view call that needs no account. It returns the verifier's exact
  error for a bad claim.
- The official SDK sends every non-swap intent to the solver relay as
  `publish_intents { quote_hashes: [], signed_datas: [...] }` (`sdk.ts` line 327). The relay
  executes as `intents.near`, so nobody in the claim pays gas. Not yet tested by us: see Proof,
  step 0.

## The code

**Entropy.** 128 bits from the OS CSPRNG (`crypto.randomBytes(16)`), nothing less. The code's
address is public the moment it is funded, so anyone can guess codes offline with no rate limit.
At 128 bits, 1,000 RTX 4090s for a year (about 2^65 guesses at the profanity2 benchmark of
1.36e9 per second) against 50 live codes expect to find about 1 in 10^17. At 64 bits every code
would fall. The hard floor is 96 bits; this spec uses 128.

**Key.** `k = keccak256(utf8("phosphor-invite-v1") || secret)`, read as a big-endian integer. The
generator redraws the secret until `0 < k < n` (secp256k1 order), so every issued code is valid.
The tag separates this key from every other use of the same bytes.

**Format.** `PHOS` plus 27 Crockford base32 characters (no I, L, O, U; case-insensitive): 26 carry
the 128-bit secret (130 bits, the top 2 must be zero) and the last is Crockford's mod-37 check
symbol. The generator redraws until the check symbol is one of the 32 letters and digits, never
`* ~ $ = U`, which costs 0.2 bits.

    PHOS-2X9QK-M7RTB-0HVFD-K3WPZ-A8GN4CJ

Parser order matters. First find and strip the prefix (accept `PHOS`, `PH0S`, any case, or a whole
pasted invite link), then on the 27 data characters only: drop spaces and hyphens, uppercase, map
O to 0 and I or L to 1, require the 2 spare bits to be zero, check the symbol. Mod 37 catches every
single wrong character and every swap of two neighbours before any network call ("That code has a
typo"). A worse mistake that slips through derives an empty address, so the empty message says
"used or mistyped". The prefix also lets the log tail redact codes by shape (see The app).

Not 12 words: a code that looks like a recovery phrase trains people to paste phrases into apps,
which is the exact habit phishing needs.

**Link.** `https://phosphor.money/invite#PHOS-...`. The code sits after `#`, and a browser never
sends that part to a server (RFC 3986 section 3.5), so it stays out of Vercel's logs and out of
link-preview fetches. Peanut and Linkdrop do the same. That only holds if no script on the page
reads it: see The invite page.

## The money path

Three kinds of account, and the most any one of them can lose:

| Account | Holds | Key lives | Max loss if its key leaks |
|---|---|---|---|
| Karim's wallet | His real money | Secure Enclave, as today | Never touched by anything in this spec |
| Treasury `T` | Only the batch about to be issued | Encrypted invite file on Karim's Mac | What is in `T` (about 0 between batches) |
| One code | $5 until claimed | The link, and the encrypted invite file | $5 |

All operator commands run in Karim's own Terminal, not through an agent session. The script
refuses a non-TTY stdin (so a passphrase cannot be piped in), and prints secrets to `/dev/tty`
only, once. An agent session would put every live code into transcripts on disk and at the model
provider.

**Fund.** `npm run invite -- treasury` makes `T`, writes its key to the invite file, and only then
prints its address. Karim moves one batch into it with the app's normal Send (an in-Intents send,
his click on the approval card, so he reads the receiver before he signs). That send costs about
0.25 percent (`src/rails/intents-send.ts:31-33`), so fund `count x amount / 0.9975` plus a cent.

**Issue.** `npm run invite -- issue --count 10 --amount 5 --label "SF builders"`, in this order:
1. Take the file lock. Generate the codes and write them, marked `pending`, to the invite file with
   an atomic write. Only then sign. A crash after this point loses nothing: the secrets are on disk
   before any money moves.
2. Sign one payload from `T` with one `transfer` per code (at most 10), `simulate_intents`, publish.
3. Read each code's balance back. Mark each funded code `open`. Print the links once.

The one-signature rule from the app holds here too: an unconfirmed publish is resent as the same
bytes, never signed again, and a second `issue` cannot start while a batch is `pending`.

**Claim.** Done by the app, below.

**Reclaim.** `npm run invite -- reclaim` signs each `open` code's balance back to `T` and marks it
`reclaimed` in the file (a claimed code and a reclaimed code both read 0 on-chain, so only the file
can tell them apart). After a reclaim, an old code shows "This code was already used, or it has a
typo."

**Withdraw.** `npm run invite -- withdraw --to <address>` sends `T` to Karim's wallet. The script
does not read the address from the keystore header: that header is plaintext and any process
running as Karim can edit it (`src/keystore/store.ts:352-361`). Karim copies the address from the
app's Receive screen, which serves only a decrypted, untampered address, and types the last six
characters back as a check.

**Status.** `npm run invite -- status` shows labels, code addresses, amount, and pending, open,
claimed or reclaimed, plus `T`'s balance. Never a code.

**The invite file.** `~/.phosphor-invites/invites.enc.json`, mode 0600, AES-256-GCM under a key
from scrypt (N = 2^17, r = 8, p = 1) of a passphrase of at least 20 characters typed at a no-echo
prompt on each run. It holds `T`'s key and every code with its label and state. Nothing goes on the
command line (a `security add-generic-password -w` call would put the secret in `ps` output for a
moment), nothing goes in the vault or git. It is the only copy of `T`'s key: lose the file and the
reclaim and whatever sits in `T` are gone, while holders can still claim their codes. Keeping `T`
near 0 between batches is what makes that loss small. A Time Machine copy of the file is safe only
as long as the passphrase is strong, which is why the minimum exists.

## The claim, step by step

Backend module `src/invite/`, network injected like every rail (`fetchImpl`). The claim needs an
open wallet: the receiver must come from `addressReport()` with `verified: true` and
`tampered: false` (`src/keystore/store.ts:362-390`), never from the plaintext header. At
onboarding the wallet was just created, so it is open. From Add money on a locked wallet, the
normal Touch ID unlock comes first.

1. Parse the code (order above), derive the key and the code address (lowercase).
2. Views on `intents.near`: `mt_balance_of(code, USDC)` must be above 0, and
   `is_account_locked(code)` must be `false`. The amount is whatever the code holds, so a $10
   code works with no change.
3. Read `current_salt` and the final block's time (`finalBlock`, `src/relay/verifier.ts:127-141`),
   not the Mac's clock, so a Mac running slow cannot fail every claim with `deadline has expired`.
   Build a V1 nonce with the existing `buildNonce` (`src/relay/payload.ts:36`): magic `5628f6c6`,
   version 0, salt, nonce deadline, 15 random bytes. The intent deadline is chain time + 120 s.
   The nonce lives 7 days past it (`NONCE_LIFE_AFTER_DEADLINE_MS`,
   `src/rails/intents-relay.ts:97-103`), so a later reconcile can still ask whether it was spent.
   Never the legacy random nonce: it still passes today, and the contract README says it will be
   banned.
4. Build the payload with fixed key order, the way `buildTokenDiffPayload` does
   (`src/relay/payload.ts:100-118`). `receiver_id` is the verified address lowercased, never a
   typed value, and must differ from the code address.
5. Sign with viem `privateKeyToAccount(k).signMessage` and encode with the existing
   `erc191SignatureField` (`src/intents-sign.ts:28-41`): 65 bytes, v as 0 or 1,
   `secp256k1:<base58>`.
6. `simulate_intents` (view). Any error stops here and maps to a plain sentence.
7. Save a pending record before publishing: code address, nonce, intent hash, amount. Never the
   code. Then publish to `https://solver-relay-v2.chaindefuser.com/rpc` with `quote_hashes: []`.
   The relay client today has only `publish_intent` with one `signed_data`
   (`src/relay/client.ts:178-199`); the claim uses it with an empty `quote_hashes`, which is new
   code. The partner key goes as `X-API-Key` when one is set (`src/relay/client.ts:126`). On no
   reply, resend the identical bytes once, never a second signature (the relay rail's rule,
   `src/rails/intents-relay.ts:583-598`). Poll `get_status`, and keep watching until the intent
   deadline plus 30 s before calling it failed: the intent stays valid that long.
8. Proof is the nonce plus the code's balance, not the status word and not the wallet's balance.
   `is_nonce_used(code, our nonce)` must read `true`, and the code's USDC must have fallen by the
   signed amount. The wallet's rise is shown, never used as proof: a deposit landing at the same
   moment, or dust sent to the public code address, would fool it. Then write the audit line, mark
   the pending record done, call `refreshLedger` (`src/http/context.ts:210-215`) so the ring
   updates at once instead of on the 15 s poll, and drop the key.

At boot, any pending record is reconciled with the same nonce check, so a quit after publish still
ends in an `invite_claimed` line and an Activity row.

The payload the code signs:

```json
{
  "signer_id": "0x<code address, lowercase>",
  "verifying_contract": "intents.near",
  "deadline": "<ISO time, chain time + 120 s, no later than the nonce deadline>",
  "nonce": "<base64 V1 nonce>",
  "intents": [
    {
      "intent": "transfer",
      "receiver_id": "0x<new wallet, lowercase>",
      "tokens": { "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1": "5000000" }
    }
  ]
}
```

No `memo` and no `msg`: a `msg` makes the contract call `mt_on_transfer` on the receiver, and a
plain account has nothing to answer it.

A failed claim never loses money: the $5 stays on the code until a claim succeeds. One claim runs at
a time per app.

## Plan B: the 1Click route

Used at run time, not chosen at build time: when the relay refuses a claim for auth or for a
missing quote, the app falls back to this route on its own, so installed apps keep working if the
relay starts enforcing its JWT (the docs require one; the endpoint "does not enforce one today",
`src/relay/client.ts:4-5`). It reuses `spendFromIntents` (`src/rails/intents-spend.ts:164-263`)
with a code-key `IntentsSignerPort`, the exact shape of today's in-Intents send
(`src/rails/intents-send.ts`). It is weaker, and the app treats it that way:
- **The receiver is not in the signature.** The code signs a transfer to 1Click's deposit handle;
  the receiver lives only in the quote echo (`src/rails/intents-send.ts:25-29`). The quote echo and
  1Click's quote signature are checked as today, but on this route a claim's safety rests on 1Click
  delivering. The threat table marks it.
- **Deadline.** 1Click writes 72 hours; the claim cuts it to 3 minutes before signing, the swap
  rail's `SIGNED_DEADLINE_MS` (`src/rails/intents-native.ts:142`).
- **Refunds** go back to `refundTo`, the code account, where any holder of the code can claim them
  again. No money is lost; the code is live again.
- **Amount.** About 0.25 percent less: a $5 code delivers about $4.99, and the check step shows the
  net figure.
- **Operator commands** have no Plan B. If the relay refuses them, `issue`, `reclaim` and
  `withdraw` stop and say so; nothing is signed twice.
- **Age.** This route is 1Click, so the under-18 clause below covers every claim that takes it.

## The app

**Onboarding.** A new `invite` step after welcome and terms, before `create`, `choose` or
`foreign`, in all four flows (`ui/screens/firstrun.js:34-39`), and in `UNCOUNTED` beside welcome
and terms (`firstrun.js:49`) so the progress counter does not call it step 1. It is skippable and
Skip is the quiet default. The claim fires on entering `addresses`, right after the wallet exists,
the one step every first-run flow shares. Wallets restored from the lock card or the Vault tab
(`/api/vault/restore`) never reach `addresses`; they claim through Add money. The code is held in
the page draft beside the phrase and password, and wiped in `close()` (`firstrun.js:72, 136-149`),
the same pattern as the recovery phrase (`screenImport`, 894-923).

Copy:
- Step: "Got an invite code?" / "Paste it and $5 lands in your wallet once it's made." /
  "Use code", "Skip".
- Valid: "Nice. $5 is waiting for you."
- Typo: "That code has a typo. Check it and try again."
- Empty: "This code was already used, or it has a typo."
- Offline: "Couldn't check the code right now. You can add it later from Add money."
- At `addresses`, landed: "$5 USDC is in your wallet."
- Still running when the person moves on: the outcome arrives as an SSE frame and shows as a toast
  on Basic: landed, or "Your $5 didn't come through. Add the code again from Add money." A claim can
  take up to two minutes, and `close()` must not make its result silent. Onboarding never stops on
  a claim.

**Add money.** A "Have an invite code?" line in the Add money card (`ui/screens/deposit.js`), with
the same field. It catches a quit between create and claim (nothing records onboarding progress,
so the first run never reopens after create: `ui/screens/lock.js:72-95`), restored wallets, and
people who already have a wallet.

**The chat composer.** The composer is on screen in every mode ("Ask, or tell it what to do",
`ui/screens/agent.js:1-3, 527-534`), and a code pasted there would go to the agent, its model
provider and the transcripts. The composer checks for the `PHOS` shape in the page before sending,
refuses to send it, and opens the invite field with the code in it.

**Routes.** `POST /api/invite/check { token, code }` and `POST /api/invite/claim { token, code }`,
both behind `guarded()` (`src/http/wallet.ts:56-85`), so only the window can call them. Neither is
an MCP op, neither is in `READ_TOOLS` (`src/http/context.ts:71-121`), and the pinned tool surface
(`tests/tool-surface.ts`) does not change.

**The code never leaves that path.** It is not written to an audit line, `/api/state`, an SSE
frame, a proposal, the pending record or disk. No error and no `reason` ever quotes the input, in
any form. Second wall: the log tail gets a shape rule for `PHOS` codes in every form the parser
accepts (lowercase, spaces, no hyphens, `PH0S`), because it does not redact by shape today and a
bare 64-hex key would pass straight through (`src/http/log-tail.ts:22-26`).

**One stated exception.** The code signer is a second signer beside the wallet's, outside the
proposals executor. The rule at `src/keystore/index.ts:9-12` (a signer takes key material and
fails while locked) protects the wallet key, and this key is not the wallet's. The claim still
runs only while the wallet is open, because the receiver must be a decrypted address. The exception
gets its own paragraph in `docs/security-model.md` under "What signs, and with what".

**What the person and the agent see.** New audit events in the `LogEvent` union
(`src/types.ts`, from line 718): `invite_claimed { codeAddress, receiver, asset, amount,
intentHash }` and `invite_failed { codeAddress, reason }`. Not `executed`, because the injection
test requires every `executed` line to follow an approval (`tests/injection.test.ts:804-830`).
Receipts get a kind `invite`, so Activity shows "Invite: +5 USDC". The agent's `intents_activity`
reads NearBlocks for any account (`src/http/read/chain.ts:56-66`), so that reader labels a
counterparty "Phosphor invite" when it matches a code address from this app's own audit log;
otherwise it would show a bare `0x`.

**Deposit watch.** The watch checks every 3 s and calls a deposit credited as soon as the asset
rises (`src/vault/watch.ts`). While a claim runs, it holds "credited" on NEAR USDC; once the claim
is proven, it adds the proven amount to its baseline. It never reads the baseline again, which
would also swallow a real deposit landing in the same window.

## The invite page

`phosphor.money/invite` in `phosphor-site`, static like the rest of the site. Every page there
loads Vercel Web Analytics from the same origin (`/_vercel/insights/script.js`: `index.html:768`,
`404.html:184`, and the docs template `scripts/build-docs.mjs:140`), and `script-src 'self'`
allows it, so a CSP alone does not keep it off the hash. Instead:
- `/invite` and `404.html` are built with no analytics tag. A build check fails if either has one.
  `404.html` matters because a mistyped invite path lands there with the hash intact.
- The page's first script, a same-origin file, reads `location.hash`, keeps the code in a variable
  and clears the address bar with `history.replaceState` before anything else runs.
- The site-wide CSP on `/(.*)` (`default-src 'none'`, a short `connect-src` list,
  `frame-ancestors 'none'`) stays as it is. No second CSP header for `/invite`.
- The page shows the code with a Copy button and the Download button, and sends the code nowhere.
  It says: paste it into the invite field on Phosphor's first screen, or in Add money, never into
  the chat, and Phosphor never asks for your recovery phrase to claim.

## Threat model

Assets: the issued budget (in `T` and in unclaimed codes), each person's new wallet, Karim's wallet,
the privacy of who got an invite, and trust in the product.

| Threat | What stops it | Worst case |
|---|---|---|
| Guess a code offline against the public code addresses | 128 bits | About 1 in 10^17 per year at 1,000 GPUs |
| Copy a claim in flight and redirect it (relay route) | `receiver_id` is inside the signature; the relay can only submit the bytes as signed | None |
| The same, on Plan B | 1Click's quote echo and quote signature are checked, but the receiver is not in the code's signature | $5, and only if 1Click misbehaves |
| Replay a claim | The nonce bitmap spends the nonce; the account is empty after the first claim anyway | None |
| Claim twice with two signatures | The account holds $5; the second transfer fails | None |
| A leaked code (screenshot, chat, posted publicly) | Codes go one to one, never posted | $5 to whoever types it first |
| Clipboard, browser history, history sync | `replaceState` clears the address bar; the claim fires right after create | $5 per code: any process running as the user can read the clipboard (the boundary in `docs/security-model.md:412-416`) |
| A code pasted into the chat | The composer refuses the `PHOS` shape and opens the invite field | None |
| A script on the invite page reads the hash | No analytics on `/invite` or `404.html`, a build check, the site-wide CSP | None |
| One person collects several codes | Karim gives one per person | $5 per extra code |
| Skip the app and claim with a script | Allowed: the holder owns the code | The same $5 |
| An edited keystore header redirects a claim or a withdraw | Claims use only a decrypted, untampered address; `withdraw` takes a typed address checked against the Receive screen | None |
| A balance read fooled by a deposit or by dust | Proof is the nonce plus the code's own balance, never the wallet's | None |
| Crash mid-issue | Codes are on disk before signing; the batch stays `pending` and is resent as the same bytes | None |
| Invite file and passphrase stolen | Encrypted file, scrypt 2^17, 20-character minimum, `T` near 0 between batches, reclaim command | What is in `T` plus unclaimed codes |
| Relay censors, stalls or starts enforcing its JWT | The money stays on the code; Plan B at run time | Delay, never loss |
| A NEAR Intents admin freezes a code account | `is_account_locked` at the check step | That code cannot pay out; reclaim fails too |
| Weak randomness | OS CSPRNG only; a test asserts the generator never takes `Math.random` | None |
| Malicious agent | No tool, no route, no log line carries a code | None |
| Fake invite page or fake app | The page only sends people to the real download; docs say a claim never needs the recovery phrase | $5 per code typed into a fake |
| The person's own wallet | The claim never uses the person's key | None |

**Not changed by this, and still open:** the unwrapped wallet key sits in the backend's memory
while the vault is open, and the four risks accepted at 0.10.0 (web data leak, unmarked
stranger-text reads, idea notes, held-first coin pick). This feature adds none of them and fixes
none of them.

## Terms, privacy, legal

- Promo clause on `/terms`: one claim per code; no purchase needed; Phosphor can end the promo and
  take back unclaimed codes at any time; codes are not for sale; recipients handle their own taxes.
- `/privacy`: a claim links the new wallet to Phosphor's invite treasury in public on-chain data,
  and the relay and the NEAR RPC see the claim the way they see every Phosphor read. If `T` is
  funded from Karim's own wallet, his wallet is publicly linked to `T` and so to every invitee.
- Bump `TERMS_VERSION` (`src/terms.ts:17`), so the terms card shows once more, as 0.10.11 did.
- US position (not legal advice): no chance and no purchase, so not a sweepstakes (Cal. Penal Code
  §319). Giving away Phosphor's own funds accepts nothing from anyone, so very likely not money
  transmission (FinCEN FIN-2019-G001). That changes the day users can buy or fund codes for each
  other. 1099 reporting starts at $2,000 a year per person for tax years after 2025.
- **Age.** The 1ClickSwap API Terms (updated 2026-08-28, §9.3) say an individual developer under
  18 "must not use the API". That already covers every Phosphor swap, not only this feature, and
  every claim that falls back to Plan B. The main claim path uses the relay, not 1Click; whether the
  relay falls under the same terms is not confirmed. The same fix as the Apple account works: a
  parent or an entity as developer of record.

## Tests

Unit (`node --test`, network injected). Throwaway secrets are repeated bytes, and a derived key is
a 64-hex run that the secret sweep flags whatever the secret was (`scripts/sweep.ts:60`), so each
pinned vector goes on the sweep's exact allowlist (`scripts/sweep.ts:119`) or the test pins only
the address.
- Code: generate, format, parse round-trip; every single substitution and every neighbour swap is
  caught; the prefix is stripped before mapping (`PHOS` survives, `PH0S` and a whole link are
  accepted); spare bits must be zero; known vectors; `0 < k < n` enforced; the generator never
  emits a symbol check character.
- Payload: exact bytes for a fixed input; lowercase ids; V1 nonce decodes with `decodeNonce`; chain
  time, not the Mac's clock; payload deadline no later than the nonce deadline; the nonce lives 7
  days past it; receiver equal to the code address refused.
- Claim: simulate errors map to the right sentences; publish with an empty `quote_hashes`; one
  identical resend on no reply, never a second signature; the watch runs to the deadline plus 30 s;
  proof needs the nonce spent and the code's balance down, and a wallet rise alone is not success;
  the pending record never holds the code; boot reconcile finishes a claim published before a quit;
  `invite_claimed` written, `executed` never written; an unverified or tampered address refuses the
  claim; a relay auth or quote refusal falls back to Plan B with the 3-minute deadline.
- Routes: no token is refused; `/api/state` and `/api/log` never contain the code (same grep as
  `tests/unit/wallet-routes.test.ts:226-237`); the log tail redacts every accepted form of the
  code; no error echoes the input; the tool surface is unchanged.
- UI (`node:vm`, like `tests/unit/firstrun-ui.test.ts`): the `invite` step sits in all four flows
  and in `UNCOUNTED`; Skip works; the claim fires once at `addresses`; a late result reaches Basic
  as a toast; `close()` wipes the code; the Add money field works; the composer refuses a `PHOS`
  paste and opens the field.
- Deposit watch: a claim on NEAR USDC is not reported as a deposit, and a real deposit in the same
  window still is.
- Site: the build fails if `/invite` or `404.html` carries the analytics tag.
- Operator script: refuses a non-TTY; writes codes before signing; a second `issue` is refused
  while one is `pending`; `--simulate-only` builds and simulates the funding payload with no
  publish; `status` never prints a code.

## Proof

**Step 0, before any app code.** With $1 in `T` (Karim's click, sized so 1Click's minimum and the
0.25 percent send fee are no question), issue one $0.10 code and claim it to a throwaway address
through the relay with `quote_hashes: []`. Record the intent hash, `is_nonce_used`, both balances
before and after, and the `get_status` answer. Then claim a second $0.10 code through Plan B and
record the same. Pass on the relay means it is the main route; Plan B is built either way, because
it is the run-time fallback.

**Release proof.** A fresh data dir, a real $5 code, the enclave flow end to end: paste, Touch ID,
the ring reads $5.00, Activity shows the invite row, the code reads 0, a second claim says "already
used". A quit right after publish, then a relaunch: the boot reconcile writes the row. Then
`reclaim` and `withdraw` on a spare code. Then the security-audit skill over the diff (keys,
signatures, randomness) and `/security-review`.

## Rollout

Ships in the next release after 0.10.12 through the usual PR and signed tag (never `0.11.0`).
Docs touched: `docs/money.md` (new "Invite codes" section), `docs/getting-started.md` (first open),
`docs/reference.md` (first run), `docs/security-model.md` (the signer exception),
`docs/changelog.md`. The site ships `/invite`, the analytics-free `404.html`, the terms clause and
the privacy line in the same hour. Build estimate: about a day and a half, most of it tests and
proof.

## Open items for Karim

1. Budget and count. Recommendation: 10 codes at $5 to people he knows, look at who claims, then
   more.
2. Fund `T`. His money and his click: $1 for the proof, then one batch at a time.
3. Where `T`'s money comes from. From his own wallet is simplest and links that wallet in public to
   every invitee; from a separate account keeps it apart.
4. Developer of record for NEAR Intents and 1Click while he is under 18.
5. The lawyer read already open for the terms: add the promo clause to it.

## Not in scope

Rewards for the person who invites. Codes anyone can buy or fund (that makes it money
transmission). Claiming on the web. Any token but USDC. Hyperliquid. A per-person limit (the
contract cannot tell people apart; Karim's hand is the limit). Analytics on who claimed beyond the
`status` command.
