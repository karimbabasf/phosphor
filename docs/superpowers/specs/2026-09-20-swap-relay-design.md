# Swap rail v2: the solver relay, one atomic token_diff

Date: 2026-09-20. Status: draft for Karim. Nothing built.

## Why

The swap rail (`src/rails/intents-native.ts`) spends the intents balance through 1Click. It
quotes, asks 1Click to generate the intent, checks the payload, signs it and submits it. The
payload 1Click returns for an INTENTS quote is a `transfer`, not a `token_diff`: it hands the
input to the solver's handle, and the output arrives later as a separate settlement. Between
those two moments the money is the solver's and the only guarantee is the quote. The rail's own
comment (`intents-native.ts:584`) names this as the weak point and accepts it because 1Click
offers nothing else.

The verifier has the atomic primitive. A `token_diff` says "minus X of this, plus Y of that" on
one account; the solver signs the mirror; `intents.near` executes both in one call or neither.
The way to reach it is the Message Bus (the solver relay) at
`https://solver-relay-v2.chaindefuser.com/rpc`: three JSON-RPC methods, `quote`, `publish_intent`,
`get_status`. It is the layer 1Click wraps, and the path near-intents.org's own app and the
official SDK use.

Checked live 2026-09-20, no API key:

- `quote` 10 USDC (`nep141:17208628...36133a1`) to USDT (`nep141:usdt.tether-token.near`):
  `amount_out 10000578`, one quote, `expiration_time` 60 s out. The same dry quote through
  1Click unkeyed: `9975578`. The 25 bp app fee is the whole difference.
- `publish_intent` with a bogus erc191 signature reached contract simulation and failed on the
  signature, not on auth. The docs say the relay wants a JWT; it does not enforce one today.
- `get_status` answers for any hash.

What this buys: atomic settlement, the app fee gone (1 pip protocol fee stays), a payload we
build ourselves instead of one we parse from a server, and a deadline of two minutes instead of
four days. What it costs: a new rail, and a swap above the click threshold re-quotes after the
click because a relay quote lives a minute.

Hyperliquid is untouched. HyperCore USDC is a 1Click-only asset, not a verifier token, so
`hl_deposit` and `hl_withdraw` stay on 1Click whatever happens here.

## Calls to lock

1. Kind `swap` is kept. The draft grows `venue: 'intents-relay'`; `'intents-native'` stays a
   valid value until the old rail is deleted, and stays a string in history rows forever, the
   way `'oneclick'` does today.
2. The diff we sign IS the price. `minAmountOut` becomes the gate on which quote we accept,
   not a floor the venue may fill down to. A quote under the floor is never signed.
3. Counterparty stays `intents.near`. The allowlist entry does not change.
4. One signature per move, ever. The rule at the top of `src/rails/intents-spend.ts` applies
   unchanged: identical bytes may be re-posted once on no reply; nothing is ever signed twice.
5. The flip is a config switch, not a rebuild, and the old rail stays in the tree until the
   new one has settled real money and the receipt matched the signed diff to the unit.

## The sequence

One signature, nothing sent on any chain by us.

1. `quote`: `defuse_asset_identifier_in`, `defuse_asset_identifier_out`, `exact_amount_in`,
   `min_deadline_ms 60000`. Every solver answers within 3 s. Pick the quote with the largest
   `amount_out` whose `amount_in` equals ours and whose `expiration_time` is at least 15 s
   ahead. No quote, or none at or above the floor: refuse (simulate) or hold (execute).
2. Balance: `mt_batch_balance_of` on `intents.near` for the input asset. Below `amountIn`:
   refuse, nothing signed.
3. Build the payload (below), `JSON.stringify` it exactly once, sign that string with the EVM
   key as ERC-191 personal_sign, encode the signature the way `erc191SignatureField` already
   does (`secp256k1:` plus base58 of 65 bytes, v normalised to 0 or 1).
4. `onEvidence` with the nonce, the deadline and the quote hash, BEFORE publish. A process that
   dies after this line can be reconciled from the nonce alone (below).
5. `publish_intent` with `quote_hashes: [<the one we chose>]` and `signed_data
   {standard: 'erc191', payload, signature}`. Response `{status: 'OK', intent_hash}` or
   `{status: 'FAILED', reason}`.
6. `onEvidence` with the intent hash. Then `get_status` until `SETTLED` or
   `NOT_FOUND_OR_NOT_VALID`, 3 s apart, 3 minutes at most. `PENDING` and `TX_BROADCASTED` are
   the two words in between and go on the row as `providerStage`.
7. Read the output balance. Settled and the balance rose by the signed diff: executed. Settled
   and the balance did not show it yet: `settling`, the executor's existing
   `needs_reconciliation` path. Anything else: unconfirmed, hash and nonce on the row, and no
   second signature.

## The payload we build

```json
{
  "signer_id": "0x<our evm address, lowercased>",
  "verifying_contract": "intents.near",
  "deadline": "<ISO, min(quote.expiration_time, now + 120 s)>",
  "nonce": "<base64 of 32 random bytes from crypto.randomBytes>",
  "intents": [
    {
      "intent": "token_diff",
      "diff": {
        "<asset in>": "-<amount_in, base units, exactly the quote's>",
        "<asset out>": "<amount_out, base units, exactly the quote's>"
      }
    }
  ]
}
```

Every field comes from one of three places and nowhere else: the approved draft, the chosen
quote, or the app's own key and clock. Nothing from the relay's response is copied into the
payload except the two amounts and the two asset ids, and each is checked against the draft
first.

The same `checkIntentPayload` discipline as today, run on the string we are about to sign, as
a second reader with no access to how it was built:

| Check | Refusal |
|---|---|
| `verifying_contract` is `intents.near` | any other value |
| `signer_id` is our address, lowercased | any other value, any other case |
| `nonce` is 32 bytes when decoded | missing, short, reused inside this process |
| `deadline` is in the future and at most 120 s out | past, absent, longer |
| exactly one intent, `token_diff`, exactly two keys | any other count, kind or key |
| negative side is the draft's asset and equals `amountIn` in base units | any other asset, any other amount |
| positive side is the draft's asset and is at or above `minAmountOut` in base units | any other asset, less |
| the two asset ids differ | same asset both sides |
| the JSON is parsed once, as data | a key spelled twice, an amount that is not a decimal string |

Amounts are compared as `bigint` from decimal strings, never through a double.

## What the relay can and cannot do to us

| Threat | Why it fails |
|---|---|
| Relay pairs our intent with a worse solver | The contract executes the diff we signed. A solver can give exactly Y or the call reverts. Less than Y is impossible. |
| Relay or solver takes the input and delays the output | No two moments. `token_diff` moves both sides in one `execute_intents` call or neither. |
| Relay replays our signed intent | The verifier spends the nonce on first execution and rejects it after. Same bytes, same hash, once. |
| A quote with a bad `amount_in` | Refused before signing: `amount_in` must equal ours to the unit. |
| A quote from the future or the past | `expiration_time` must be at least 15 s ahead; our deadline is capped at 120 s. |
| A hostile token list | Asset ids come from the same registry the old rail uses (`resolveAsset`), pinned in the draft at propose time, compared again before signing. |
| A hostile relay response shape | Every field is typed and bounded before use; an unknown status is never terminal (the existing `rail-provider-stage` rule). |
| The relay starts enforcing the JWT | The partner key from partners.near-intents.org is read from `PHOSPHOR_1CLICK_API_KEY` and sent as `X-API-Key` when present, exactly as the 1Click client does. |
| Relay down | Nothing signed on a quote failure; unconfirmed with hash and nonce on a status failure. |

What the relay CAN do: refuse to serve us. That is denial, not loss, and the old rail stays
reachable by config for as long as that risk is real.

## After the signature

Nothing throws once the key has been used. The two-phase contract from `intents-spend.ts`
holds: before the signature every problem throws; after it every outcome returns.

`RailEvidence` carries: `handle` = the intent hash, `nonce`, `deadline`, `providerStage` = the
relay's own status word, `explorerUrl` = the NEAR tx on nearblocks once `data.hash` is known,
and a new optional `relayQuote {quoteHash, amountIn, amountOut, expiration}`. The 1Click-shaped
`quote` field stays for the other rails.

Reconciliation has a chain-level source the old rail never had. The verifier exposes whether a
nonce is spent for an account (`is_nonce_used`; confirm the exact view name against the
contract before wiring it). A row with a nonce and no settled status is answered by that view:
spent means the swap executed and the balance read settles the row; unspent past the deadline
means it never can execute and the row is failed with nothing lost. `reconcileOnBoot` gets that
branch for `venue: 'intents-relay'` rows.

The settle check expects the output balance to rise by the signed diff. The 1 pip protocol fee
may come out of our side; the proof run below pins which. The check tolerates at most 1 pip
under the diff and nothing more, and a shortfall beyond that is `settling`, never success.

## The click

Under the threshold the rail runs quote, sign, publish inside one minute; no change.

Above it, the card is drawn from a dry `quote` at propose time: receives, receives at least (the
draft floor), fee (the quote against the draft's USD), and "price good for about a minute,
re-quoted at your click". After the click, `execute` quotes again. At or above the floor: sign.
Below: the rail returns `held` with the sentence "best price is X, your floor is Y", and the
executor's existing hold loop retries every half minute for five minutes, then fails with
nothing signed. The floor the human approved is the contract; the number on the card is the
estimate. The card says so in one line.

## Fees and floors

- Relay: 1 pip protocol fee. No app fee, keyed or not.
- `MAX_SLIPPAGE_BPS` (`src/rails/slippage.ts`) still refuses a floor more than 20 percent under
  the app's own quote. Unchanged.
- No size floor of the 1Click kind: there is no flat routing fee to trap a small swap. The
  existing `$1` minimum stays as a sanity bound.

## Migration: replacing the old rail without a gap

Phase 0, plumbing (no behaviour change)
- `src/relay/client.ts`: `quote`, `publishIntent`, `status`, injected transport, 10 s timeouts,
  key sent when present. Pure, testable, no rail logic.
- `src/relay/payload.ts`: `buildTokenDiffPayload` and `checkTokenDiffPayload`, both pure.
- `SwapDraft.venue` widened to `'intents-native' | 'intents-relay'`.
- Config: `swap.rail: 'oneclick' | 'relay'`, default `'oneclick'`. The registry
  (`src/rails/index.ts`) constructs both rails and picks by `draft.venue`; `proposeSwap`
  (`src/proposals/rails.ts`) stamps the venue from config.

Phase 1, the rail
- `src/rails/intents-relay.ts` implementing `Rail<SwapDraft>`: `valueUsd`, `simulate`,
  `execute`, with the sequence above. It reuses `signErc191` and `erc191SignatureField` from
  `intents-native.ts` (move them to `src/intents-sign.ts` so neither rail imports the other),
  `fetchIntentsAssetBalance`, `resolveAsset`, `floorTooLow`, and the poll and hook shape of
  `intents-spend.ts`.
- `reconcileOnBoot` and `reconcileProposal` learn the `intents-relay` branch.
- Tests (below) green. `/security-review` on the diff. The security-audit skill on
  `src/relay/*`, `src/rails/intents-relay.ts` and `src/intents-sign.ts`: the signing path is
  the only thing that changed and it is the only thing that matters.

Phase 2, shadow
- With the default still `'oneclick'`, every swap `simulate` also runs a relay dry quote and
  writes both prices to the audit row. No signing, no card change. A week of rows, or ten
  swaps, whichever comes first, is the evidence the relay prices at or above 1Click.

Phase 3, the flip
- Proof (below) passes on the real wallet with 10 USDC.
- `swap.rail` default becomes `'relay'`. The old rail is one config line away for a month.
- `docs/money.md` "Swap" paragraph and `docs/architecture.md` "Where money lives" name the relay.

Phase 4, retire
- After a month relay-only with no reconciliation row: delete `intents-native.ts`, its tests,
  the `'intents-native'` venue from the registry. History rows keep the string. `intents-spend.ts`
  stays: the two Hyperliquid rails still use it.

Kill switch at every phase: `swap.rail: 'oneclick'` in config, restart. `Freeze everything`
covers a relay swap the same way: a signed intent past its two-minute deadline is dead by
itself, which is the other reason the deadline is short.

## Tests

`tests/unit/intents-relay.test.ts`, mirroring `intents-native.test.ts` where the property is
shared, plus what is new:

- picks the largest `amount_out` among quotes with the right `amount_in`, ignores one expiring
  inside 15 s, refuses when none is at or above the floor
- the payload's negative side is exactly `amountIn`, the positive side is exactly the chosen
  quote, and the two asset ids are the draft's
- `checkTokenDiffPayload`: each row of the table above, one test per refusal
- the string signed is the string sent, byte for byte
- nonce is 32 bytes, fresh per call, and never repeats inside a process
- deadline is at most 120 s out and never past the quote's expiration
- the executor hears nonce and deadline before publish, and the hash after it, before any poll
- publish with no reply is re-posted once with identical bytes; the signer is called exactly once
- publish answered `FAILED` is not re-posted; the signer is called exactly once
- an unknown status word is never terminal
- `SETTLED` with a balance rise equal to the diff is ok; short by more than 1 pip is `settling`
- a hold below the floor signs nothing and returns `held` with both numbers in the sentence
- the key is never read in `simulate`
- a draft with `venue: 'intents-native'` never reaches this rail, and the reverse

`tests/unit/rail-wiring.test.ts` gains: config selects the rail, and both are constructed.

## Proof

On the real wallet, `swap.rail: 'relay'`, USDC to USDT:

1. 10 USDC, under the threshold. Receipt shows the quote hash, the nonce, the intent hash, the
   NEAR tx, and USDT up by the signed diff to the unit (or by the diff minus 1 pip, which pins
   the fee side for the settle check). USDC down by exactly 10.
2. 10 USDT back with a floor set above the best quote. The card holds with both numbers, five
   minutes pass, the row fails, `is_nonce_used` is false, both balances unchanged.
3. The same 10 USDT with an honest floor. Executed, balances match.
4. `phosphor diagnose` on all three rows reads clean.

Then Phase 3.

## Not in scope

- Hyperliquid deposit and withdraw: 1Click only, no relay route exists.
- Confidential intents, limit orders, `publish_intents` batching.
- A partner key. Worth getting for the two Hyperliquid rails (25 bp to 1 bp on stables); it
  changes nothing here.
- The `intents_send` and `intents_pay` rails: they leave the verifier and need a bridge, which
  is 1Click's job or the intents-sdk's. A later spec.
