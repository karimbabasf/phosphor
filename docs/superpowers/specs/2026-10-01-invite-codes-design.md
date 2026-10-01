# Invite codes: $5 for the people Karim invites

Date: 2026-10-01. Status: draft for Karim. Nothing built. Research behind it: a full read of this
repo at 0.10.12 (`167d18c9`), the `near/intents` contract source at the deployed commit, the
official Intents SDK, and read-only live calls against `intents.near`.

## What it does

Karim hands someone a link. They download Phosphor. On the first screen after the welcome they
paste the code. The app checks it and says $5 is waiting. They make the wallet with Touch ID, and
the moment the wallet exists the app moves the $5 into it. Their balance reads $5.00 USDC before
they have deposited anything.

Rules the design holds to:
- No code, no money. A code pays once, ever.
- Nobody can redirect a claim, and no Phosphor server decides who gets paid.
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

**Format.** Crockford base32 (no I, L, O, U; case-insensitive), 26 characters for the 128 bits plus
1 check character (the first 5 bits of `sha256(secret)`), behind a `PHOS` prefix:

    PHOS-2X9QK-M7RTB-0HVFD-K3WPZ-A8GN4CJ

The parser strips spaces and hyphens, uppercases, maps O to 0 and I or L to 1, and requires the
prefix. A wrong check character says "typo" before any network call. The prefix also lets the log
tail redact codes by shape (see The app).

Not 12 words: a code that looks like a recovery phrase trains people to paste phrases into apps,
which is the exact habit phishing needs.

**Link.** `https://phosphor.money/invite#PHOS-...`. The code sits after `#`, and a browser never
sends that part to a server (RFC 3986 section 3.5), so it stays out of Vercel's logs and out of
link-preview fetches. Peanut and Linkdrop do the same.

## The money path

Three kinds of account, and the most any one of them can lose:

| Account | Holds | Key lives | Max loss if its key leaks |
|---|---|---|---|
| Karim's wallet | His real money | Secure Enclave, as today | Never touched by anything in this spec |
| Treasury `T` | The budget not yet issued | Encrypted invite file on Karim's Mac | What is in `T` |
| One code | $5 until claimed | The link, and the encrypted invite file | $5 |

**Fund.** `npm run invite -- treasury` makes `T` once and prints its address. Karim moves the
budget into it with the app's normal Send (an in-Intents send, his click on the approval card, so
he reads the receiver before he signs). Keep `T` thin: only what he plans to issue soon.

**Issue.** `npm run invite -- issue --count 10 --amount 5 --label "SF builders"` generates the
codes, signs one payload from `T` with one `transfer` per code, checks it with `simulate_intents`,
publishes it to the relay, reads every code's balance back, then saves the codes and prints the
links. Batches of at most 10 per payload. A code is funded only when it is issued, so codes Karim
has not handed out yet hold no money.

**Claim.** Done by the app, below.

**Reclaim.** `npm run invite -- reclaim` signs each unclaimed code's balance back to `T`.
`npm run invite -- withdraw` sends `T` back to Karim's wallet address, read from the wallet
header, never typed. After a reclaim, an old code shows "This code was already used."

**Status.** `npm run invite -- status` lists every issued code: label, amount, claimed or open, and
`T`'s balance. All reads are view calls.

**The invite file.** `~/.phosphor-invites/invites.enc.json`, mode 0600, AES-256-GCM under a key
from scrypt of a passphrase Karim types at a no-echo prompt on each run. It holds `T`'s key and
every code with its label. Nothing goes on the command line (a `security add-generic-password -w`
call would put the secret in `ps` output for a moment), nothing goes in the vault or git. If the
file is lost, holders can still claim their codes; only the reclaim is gone.

## The claim, step by step

Backend module `src/invite/`, network injected like every rail (`fetchImpl`).

1. Parse the code, check the check character, derive the key and the code address (lowercase).
2. Views on `intents.near`: `mt_balance_of(code, USDC)` must be above 0, and
   `is_account_locked(code)` must be `false`. The amount is whatever the code holds, so a $10
   code works with no change.
3. Read `current_salt` and build a V1 nonce with the existing `buildNonce`
   (`src/relay/payload.ts:36`): magic `5628f6c6`, version 0, salt, nonce deadline now + 120 s
   (ns, i64 little-endian), 15 random bytes. Do not use the legacy random nonce: it still passes
   today, and the contract README says it will be banned.
4. Build the payload with fixed key order, the same way `buildTokenDiffPayload` does
   (`src/relay/payload.ts:100-118`). `receiver_id` is `evmAddress()` lowercased
   (`src/ledger/index.ts:171-177`), never a typed value, and must differ from the code address.
5. Sign with viem `privateKeyToAccount(k).signMessage` and encode with the existing
   `erc191SignatureField` (`src/intents-sign.ts:28-41`): 65 bytes, v as 0 or 1,
   `secp256k1:<base58>`.
6. `simulate_intents` (view). Any error stops here and maps to a plain sentence.
7. `publish_intents` to `https://solver-relay-v2.chaindefuser.com/rpc` with `quote_hashes: []`,
   sending the partner key as `X-API-Key` when one is set, like `src/relay/client.ts:23`. Poll
   `get_status` until `SETTLED` or `NOT_FOUND_OR_NOT_VALID`, at most 60 s. On no reply, resend
   the identical bytes once, never a second signature (the rule at
   `src/rails/intents-submit.ts:28-58`).
8. Proof is the balances, not the status word: the code reads 0 and the wallet's USDC rose by the
   amount. Then write the audit line, call `refreshLedger` (`src/http/context.ts:210-215`) so the
   ring updates at once instead of on the 15 s poll, and drop the key.

The payload the code signs:

```json
{
  "signer_id": "0x<code address, lowercase>",
  "verifying_contract": "intents.near",
  "deadline": "<ISO time, no later than the nonce deadline>",
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

**Plan B if the relay refuses quote-less intents** (decided by Proof, step 0): sign the same move
through `spendFromIntents` (`src/rails/intents-spend.ts:164-263`) with a code-key
`IntentsSignerPort`, the exact shape of today's in-Intents send (`src/rails/intents-send.ts`).
It works today with no new endpoint. The cost is about 0.25 percent, so a $5 code delivers about
$4.99, and the app shows the net amount at the check step. Nothing else in this spec changes.

## The app

**Onboarding.** A new `invite` step after welcome and terms, before `create`, `choose` or
`foreign`, in all four flows (`ui/screens/firstrun.js:34-39`). It is skippable and Skip is the
quiet default. The claim fires on entering `addresses`, the one step every flow shares, so the four
ways a wallet comes into existence (`/api/vault/create`, `/api/vault/restore`,
`/api/wallet/create`, `/api/wallet/import`) all get it with no hook in any of them. The code is
held in the page draft beside the phrase and password, and wiped in `close()`
(`firstrun.js:72, 136-149`), the same pattern as the recovery phrase (`screenImport`, 894-923).

Copy:
- Step: "Got an invite code?" / "Paste it and $5 lands in your wallet once it's made." /
  "Use code", "Skip".
- Valid: "Nice. $5 is waiting for you."
- Typo: "That code has a typo. Check it and try again."
- Empty: "This code was already used."
- Offline: "Couldn't check the code right now. You can add it later from Add money."
- At `addresses`, landed: "$5 USDC is in your wallet."
- At `addresses`, failed: "Your $5 didn't come through yet. Add the code again from Add money."
  Onboarding never stops on a claim.

**Add money.** A "Have an invite code?" line in the Add money card (`ui/screens/deposit.js`), with
the same field. It catches a quit between create and claim (nothing records onboarding progress,
so the first run never reopens after create: `ui/screens/lock.js:72-95`), and it serves people who
already have a wallet.

**Routes.** `POST /api/invite/check { token, code }` and `POST /api/invite/claim { token, code }`,
both behind `guarded()` (`src/http/wallet.ts:56-85`), so only the window can call them. Neither is
an MCP op, neither is in `READ_TOOLS` (`src/http/context.ts:71-121`), and the pinned tool surface
(`tests/tool-surface.ts`) does not change.

**The code never leaves that path.** It is not written to an audit line, `/api/state`, an SSE
frame, a proposal or disk. Second wall: the log tail gets a shape rule for `PHOS` codes, because it
does not redact by shape today and a bare 64-hex key would pass straight through
(`src/http/log-tail.ts:22-26`).

**One stated exception.** The code signer is the first signer that works while the wallet is
locked, against the rule at `src/keystore/index.ts:9-12`. That rule protects the wallet key, and
this key is not the wallet's. The exception gets its own paragraph in `docs/security-model.md`
under "What signs, and with what".

**What the person and the agent see.** New audit events in the `LogEvent` union
(`src/types.ts:718-748`): `invite_claimed { codeAddress, receiver, asset, amount, intentHash }` and
`invite_failed { codeAddress, reason }`. Not `executed`, because the injection test requires every
`executed` line to follow an approval (`tests/injection.test.ts:804-830`). Receipts get a kind
`invite`, so Activity shows "Invite: +5 USDC" and the agent reads it like any other receipt instead
of a bare `0x` counterparty in `intents_activity`. After a claim, an open deposit watch on NEAR
USDC re-takes its baseline, or the $5 would read as that deposit landing (`src/vault/watch.ts`).

## The invite page

`phosphor.money/invite` in `phosphor-site`, static like the rest of the site. It reads the code
from `location.hash`, clears it from the address bar with `history.replaceState`, and shows the
code with a Copy button and the Download button. No third-party script on that page, because any
script there can read the hash: `vercel.json` sets `Content-Security-Policy: script-src 'self'` and
`Referrer-Policy: no-referrer` for `/invite`. The page never sends the code anywhere. It says: only
paste this into the Phosphor app, and Phosphor never asks for your recovery phrase to claim.

## Threat model

Assets: the issued budget (in `T` and in unclaimed codes), each person's new wallet, Karim's wallet,
the privacy of who got an invite, and trust in the product.

| Threat | What stops it | Worst case |
|---|---|---|
| Guess a code offline against the public code addresses | 128 bits | About 1 in 10^17 per year at 1,000 GPUs |
| Copy a claim in flight and redirect it | `receiver_id` is inside the signature; the relay can only submit the bytes as signed | None |
| Replay a claim | The nonce bitmap spends the nonce; the account is empty after the first claim anyway | None |
| Claim twice with two signatures | The account holds $5; the second transfer fails | None |
| A leaked code (screenshot, chat, posted publicly) | Codes go one to one, never posted | $5 to whoever types it first |
| One person collects several codes | Karim gives one per person | $5 per extra code |
| Skip the app and claim with a script | Allowed: the holder owns the code | The same $5 |
| Invite file and passphrase stolen | Encrypted file, thin treasury, fund-on-issue, reclaim command | What is in `T` plus unclaimed codes |
| Relay censors or stalls claims | The money stays on the code; retry, or Plan B | Delay, never loss |
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
  and the relay and the NEAR RPC see the claim the way they see every Phosphor read.
- Bump `TERMS_VERSION` (`src/terms.ts:17`), so the terms card shows once more, as 0.10.11 did.
- US position (not legal advice): no chance and no purchase, so not a sweepstakes (Cal. Penal Code
  §319). Giving away Phosphor's own funds accepts nothing from anyone, so very likely not money
  transmission (FinCEN FIN-2019-G001). That changes the day users can buy or fund codes for each
  other. 1099 reporting starts at $2,000 a year per person for tax years after 2025.
- **Age.** The 1ClickSwap API Terms (updated 2026-08-28, §9.3) say an individual developer under
  18 "must not use the API". That already covers every Phosphor swap, not only this feature. The
  main claim path uses the relay, not 1Click, but whether the relay falls under the same terms is
  not confirmed. The same fix as the Apple account works: a parent or an entity as developer of
  record.

## Tests

Unit (`node --test`, network injected, keys are repeated bytes so `npm run sweep` stays clean):
- Code: generate, format, parse round-trip; check character catches a one-character typo; O, I, L
  map; prefix required; known secret to key to address vectors; `0 < k < n` enforced.
- Payload: exact bytes for a fixed input; lowercase ids; V1 nonce decodes with `decodeNonce`;
  payload deadline no later than the nonce deadline; receiver equal to the code address refused.
- Claim: simulate error strings map to the right sentences; publish with an empty `quote_hashes`;
  one identical resend on no reply, never a second signature; balances, not status, decide success;
  `invite_claimed` written, `executed` never written.
- Routes: no token is refused; `/api/state` and `/api/log` never contain the code (same grep as
  `tests/unit/wallet-routes.test.ts:226-237`); the log tail redacts the `PHOS` shape; the tool
  surface is unchanged.
- UI (`node:vm`, like `tests/unit/firstrun-ui.test.ts`): the `invite` step sits in all four flows;
  Skip works; the claim fires once at `addresses`; a failed claim does not block; `close()` wipes
  the code; the Add money field works.
- Operator script: dry run (`--simulate-only`) builds and simulates the funding payload with no
  publish.

## Proof

**Step 0, before any app code.** With 20 cents in `T` (Karim's click), issue one $0.10 code and
claim it to a throwaway address through the relay with `quote_hashes: []`. Record the intent hash,
both balances before and after, and the `get_status` answer. Pass means Route 1 is the build. A
refusal (auth or quote) means Plan B, and the step is repeated through `spendFromIntents`.

**Release proof.** A fresh data dir, a real $5 code, the enclave flow end to end: paste, Touch ID,
the ring reads $5.00, Activity shows the invite row, the code reads 0, a second claim says "already
used". Then `reclaim` and `withdraw` on a spare code. Then the security-audit skill over the diff
(keys, signatures, randomness) and `/security-review`.

## Rollout

Ships in the next release after 0.10.12 through the usual PR and signed tag (never `0.11.0`).
Docs touched: `docs/money.md` (new "Invite codes" section), `docs/getting-started.md` (first open),
`docs/reference.md` (first run), `docs/security-model.md` (the signer exception),
`docs/changelog.md`. The site ships `/invite`, the terms clause and the privacy line in the same
hour. Build estimate: about a day, most of it tests and proof.

## Open items for Karim

1. Budget and count. Recommendation: 10 codes at $5 to people he knows, look at who claims, then
   more.
2. Fund `T`. His money and his click, needed first for the 20-cent proof and then for the budget.
3. Developer of record for NEAR Intents and 1Click while he is under 18.
4. The lawyer read already open for the terms: add the promo clause to it.

## Not in scope

Rewards for the person who invites. Codes anyone can buy or fund (that makes it money
transmission). Claiming on the web. Any token but USDC. Hyperliquid. A per-person limit (the
contract cannot tell people apart; Karim's hand is the limit). Analytics on who claimed beyond the
`status` command.
