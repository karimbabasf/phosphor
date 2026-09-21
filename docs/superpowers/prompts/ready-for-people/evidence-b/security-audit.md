# Security review and audit of the sendAsset diff (7e0357f..HEAD, src/rails and scripts)

Date 2026-09-20. Two passes, as the brief asks: /security-review over the diff, then the
security-audit skill (threat model, tools, exploit-path verification) over the changed files
under src/rails, because a signing path changed.

## Scope and assets
Assets: the master EVM key (enclave-wrapped, unwrapped in memory while the vault is open, a
known open item this diff does not touch), the Hyperliquid account balance, the intents balance.
In scope: src/rails/hl-user-signed.ts, hypercore-withdraw.ts, hypercore-deposit.ts,
intents-spend.ts, demo.ts, scripts/hypercore-probe.ts.

## Attack surface on the diff
- sendAsset(deps, params): reachable only from the withdraw rail's execute, itself behind the
  policy engine and the human click (land() forces needs_approval for hl_withdraw, unchanged).
  Signed fields: hyperliquidChain (Mainnet, a constant from hlVenue()), destination (1Click's
  depositAddress: isAddress, and bound by the Ed25519 quote signature check and the quote echo
  before it is read), sourceDex and destinationDex (constants "spot"), token (a pinned constant),
  amount (toAmountString(draft.amount), the human-approved figure), fromSubAccount (""), nonce
  (ms clock, or the previous attempt's nonce on a retry). The message and the posted action come
  from one object.
- Untrusted inputs: the 1Click quote and its quoteRequest echo (appFees), Hyperliquid /info
  answers (balances, userRole, the ledger), status polls. Traced: appFees reaches sentences and
  the card's fee fact only, bounded by the measured fee; balances feed refusals (fail closed:
  a malformed number reads 0); userRole feeds the activation fee (a missing read refuses);
  the ledger feeds the receipt's hash and the decision to retry the SAME nonce, never a new one.
- Demo code: demoRails throws outside cfg.mode 'demo'; every knob reads off outside demo;
  hlWalk signs nothing and reads no key.

## Tools (raw output kept out of the repo, in the session scratchpad)
- semgrep --config auto --config p/secrets over the six files: 0 findings, 0 errors.
- gitleaks over the branch's commits (7e0357f..HEAD): 0 leaks.

## Findings
No Critical, High or Medium. Three Low from the /security-review pass, all closed in 4752918:
1. hypercore-withdraw.ts proveBothSides: with no verifier before-read, any answered after-read
   confirmed the row. Now: never confirms; the row lands settling without a pocket and a
   sentence that does not carry "has not shown", so the sweep settles it on the router's
   terminal word instead of routing it to the deposit's venue read (which answers false for a
   withdrawal and would have held the row open for ever). Test: "a verifier that would not
   answer before the send leaves no pocket and never confirms".
2. hypercore-withdraw.ts ledgerHash: a `send` delta with no nonce field is matched on
   destination, exact amount and time. Loose only in the direction that skips a same-nonce
   retry, which the venue refuses as a duplicate anyway; the destination is a fresh per-quote
   address nobody else sends to. Test: "the venue ledger names the send by its nonce, and a send
   delta without a nonce field still matches".
3. hl-user-signed.ts sendAsset refusal: toAmountString(amount + fee) threw on a float sum
   (8.209399 + 1) and the refusal read as "rail threw". Now spelled as money. Test: "a short
   balance refusal spells the sum as money".

## Replay and signing checks (crypto-primitives reference)
- EIP-712 domain: HyperliquidSignTransaction, version 1, chainId 421614, zero verifying contract,
  exactly the official SDK's; primaryType HyperliquidTransaction:SendAsset with the SDK's field
  order; r, s, v pinned to vectors produced by hyperliquid-python-sdk 0.24.0 for the fixture
  inputs (Mainnet and Testnet differ, so hyperliquidChain is inside the digest).
- Nonce: one per move from the clock; a retry reuses the first attempt's nonce and identical
  fields, so the venue refuses a duplicate; the executor never re-runs a rail for a row found on
  disk (tests/unit/hl-crash-recovery.test.ts, 12 stages).
- Key material: read inside signTypedData only, never on a result, an evidence field, a
  sentence or a log line; the probe with --account builds a config whose keys path does not exist
  and calls simulate only.

## Follow-ups (not security, not fixed here)
- plan() reads accountSummary(draft.from) before requireOwner(): a draft for a stranger's
  address costs one public read before the refusal. Pre-existing, no money moves.
- judgeSettling can attribute an unrelated USDC credit to a settling row (pre-existing, both
  rails, the design's documented trade-off).
