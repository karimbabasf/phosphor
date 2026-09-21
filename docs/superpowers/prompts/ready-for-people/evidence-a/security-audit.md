# Security audit: the relay swap rail's signing path

Date: 2026-09-20. Scope: src/relay/client.ts, src/relay/payload.ts, src/relay/verifier.ts,
src/rails/intents-relay.ts, src/intents-sign.ts on branch rfp/a-relay, plus the relay branch
of src/proposals/reconcile.ts because its verdicts decide whether a second swap gets asked for.
Method: the security-audit skill (threat model, tools, exploit-path verification), the
crypto-primitives reference, and one fresh-context reviewer over the diff (/security-review).

## Assets and boundary

Protected: the intents balance (real money) and the one EVM key. The key is touched in one
place, src/intents-sign.ts liveIntentsSigner.signErc191, through the keystore door, at the
moment of use, over one string. Untrusted inputs: every field the relay returns (quotes, the
publish reply, get_status), every NEAR RPC reply (balance, salt, is_nonce_used), the 1Click
token list (asset ids, decimals, prices), and the draft's numbers (agent-authored, app-resolved
addresses). Sensitive sinks: signErc191, publish_intent, the persisted row, the executed and
failed verdicts, the explorer link.

## Tools

semgrep (p/default, p/typescript, 210 rules on the 5 files): 0 findings. trufflehog: 0 secrets.
gitleaks: 1 hit, `RELAY_API_KEY_ENV = 'PHOSPHOR_1CLICK_API_KEY'`, an environment variable
name (the 1Click rail carries the same constant), not a key. osv-scanner: no package sources
in scope. Raw output: scratchpad, not kept.

## What was traced and cleared

1. Signature binding (the recurring "value checked was not the value used" shape). The string
   signed at intents-relay.ts execute is the `payload` const built by buildTokenDiffPayload
   from the draft (amountIn, the two asset ids resolved at plan time), the chosen quote
   (amountOut) and the app's own address, clock and randomness; checkTokenDiffPayload runs on
   that same const before signErc191, and publishOnce sends that same const. amountIn is
   pinned to the unit, amountOut must be at or above the draft floor and exactly the chosen
   quote's, signer_id is our lowercased account, verifying_contract is the constant, one
   token_diff with exactly two distinct keys, the deadline is at most 120 s from the clock the
   rail signed on, the nonce is fresh, 32 bytes, V1, salt-matched to the read used to build it.
   A token_diff names no receiver, so nothing in the signed bytes can steer the credit anywhere
   but our own account. The relay's only lever inside the signed bytes is amountOut, and a
   larger one is a better price for us.
2. Replay. Nonce = magic || version || salt || deadline || 15 bytes from crypto.getRandomValues
   (a CSPRNG); the verifier commits it on execution; the intent deadline is at most 120 s; the
   payload names the verifying contract and our account. ECDSA k is RFC 6979 deterministic in
   viem. The nonce set signedNonces refuses a repeat before the key is touched.
3. One signature per move. Nothing throws after signErc191: publishOnce catches, the watch
   loop catches, the two verifier reads after the signature are wrapped (fix 2 below). A publish
   with no reply is re-posted once with identical bytes; any answer is never resent. A hold and
   every pre-sign refusal return or throw before the key is read; simulate reads no key, no
   balance and no salt (test).
4. Key material. The signature leaves the process only in the publish body; nothing key-shaped
   reaches detail strings, evidence, audit lines or the probe's output. The partner key is a
   header and nowhere else; an HTTP error message is the relay's body text, never the header.
5. Sinks. explorerUrl is a fixed nearblocks prefix plus a hash held to base58 (fix 1); the UI
   allowlists https hosts before any href (ui/core/links.js). providerStage and detail render as
   text. No eval, exec, shell or innerHTML on this path. JSON is parsed once, as data.
6. Verdicts. A row is executed only on a measured balance rise or on the verifier showing the
   nonce spent (review fix, commit 225c38d); the relay's SETTLED alone never settles a row. An
   unspent nonce is called dead only past the deadline plus five minutes of skew and inside the
   nonce's own life. The spec's worry that the protocol fee might come off our credit is
   answered by the contract source (near/intents contracts/defuse/core/src/intents/token_diff.rs):
   the signer's account gets exactly its signed deltas, the fee is taken on the negative side at
   the supply level, so the one-pip tolerance is a guard that should never fire.

## Findings

None Critical, High or Medium. Three Low from the fresh-context reviewer, all wrong-verdict
shapes in recovery with no attacker-driven loss, fixed in 225c38d with regression tests
(reconcile-relay, intents-relay):

- Low, reconcile.ts: SETTLED at the relay settled a row that never read its balance on the
  relay's word alone. Now asks is_nonce_used and stays unconfirmed until it shows spent.
- Low, intents-relay.ts: a blind settle (no balance read either side) returned ok on the
  relay's word. Now the same nonce check; anything less is settling, never a success.
- Low, reconcile.ts: an unspent nonce one minute past a deadline minted from this clock was
  called dead, and a nonce past its own life (which the contract may prune) could read as
  unspent. Five minutes of grace now, and no verdict once the nonce's own life has passed.

Two hardening changes from this audit, commit 2e8c194 with tests (relay-client,
intents-relay): a hash off the relay is base58 of a hash's length or no hash; the verifier
reads that run after the signature cannot throw.

## Left as follow-ups (not this rail's code)

- src/proposals/execute.ts judgeSettling writes a terminal `failed` ("short fill") on
  0 < rise < floor for any settling row. On the relay a short fill cannot exist (the diff is
  atomic), so that verdict is wrong whenever an unrelated smaller credit lands in the window
  before the swap's own shows at finality. Shared executor logic, same exposure as the 1Click
  rail; a relay row should stay or be routed to the nonce check instead.
- resolveAsset takes the asset id from the 1Click token list matched by contract address, so a
  hostile list could rename the bought asset under the approved symbol. Inherited from the
  1Click rail; the fix is a pinned asset table, out of scope here.
