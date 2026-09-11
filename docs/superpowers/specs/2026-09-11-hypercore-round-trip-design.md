# HyperCore round trip: NEAR Intents balance in, NEAR Intents balance out

Date: 2026-09-11. Status: approved by Karim in chat, four calls locked (below).

## Why

Phosphor supports two venues: NEAR Intents and Hyperliquid. Until today the money graph had one
missing edge and one wrong one. `hl_deposit` funded HyperCore from an on-chain wallet (arb, eth,
base, near), so money already sitting inside the intents balance had to leave the verifier first
and be deposited again: two fees, two approvals, an on-chain hop. And there was no way out of
Hyperliquid at all: `withdraw3` had no caller since the terminal script went on 2026-09-01, while
three surfaces still promised it.

1Click changed under us. Checked live 2026-09-11: a quote FROM the intents balance TO HyperCore
works (`depositType INTENTS`, 10 USDC in, 9.6594 out, 20 s), and the new asset
`1cs_v1:hypercore:hip1:0x6d1e7cde53ba9467b783cb7c530ce054` (HyperCore spot USDC, 8 decimals) is
accepted as an ORIGIN, so HyperCore TO the intents balance works too (8 USDC in, 7.78 out, 35 s).
The asset the app pinned, `1cs_v1:hypercore:erc20:0xb883...`, is destination only.

## Karim's four calls

1. An agent-proposed withdraw lands in the app's own intents balance only. No recipient field.
2. A withdraw is always a human click, at any size, and is refused while any position is open
   or any margin is in use.
3. `propose_hl_deposit` takes money from the intents balance only. The wallet origins are deleted.
4. Live proof on mainnet, up to 10 USDC each way.

## The money graph after this change

    wallet (eth, base, arb, sol)  <-- intents_withdraw --  intents balance  -- hl_deposit -->  HyperCore
                                  -- intents_deposit -->                   <-- hl_withdraw --

Every edge is one signature. Nothing touches Arbitrum or the Hyperliquid bridge.

## Rail 1: `hl_deposit`, rebuilt (kind kept)

The kind stays because the policy engine, the ledger, the receipts and the approval screen all
already know what it means: money entering the trading account.

Draft:

    kind: 'hl_deposit'
    symbol: string          // the asset SPENT from the intents balance, USDC by default
    originAsset: string     // its 1Click id, picked by the proposal service from the ledger's holdings
    amount: number          // in `symbol`
    amountUsd: number
    minCredited: number     // the least USDC that may land on the account
    from: string            // our intents account id: the EVM address, lowercased
    hlAccount: string       // the Hyperliquid account credited: our EVM address, never a caller's
    counterparty: string    // INTENTS_VERIFIER, because the funds are spent inside the verifier

Sequence, one signature, nothing sent on any chain by us:

1. `POST /v0/quote` with `depositType INTENTS`, `originAsset` = the held flavor, `destinationAsset`
   = `HYPERCORE_USDC_ASSET_ID` (now the `hip1` id, decimals 8), `recipient` = `hlAccount`,
   `recipientType DESTINATION_CHAIN`, `refundTo` = `from`, `refundType INTENTS`.
2. Quote echo check (`quoteEchoProblems`): every field above must come back verbatim.
3. `POST /v0/generate-intent`, `checkIntentPayload`: an erc191 `transfer` of exactly `amountBase`
   of `originAsset` to the quote's deposit handle, deadline no later than the quote's.
4. Sign with the EVM key, `POST /v0/submit-intent`, poll `/v0/status` to a terminal state.
5. Read the Hyperliquid account before and after. A unified account (Karim's) needs nothing;
   a standard account that shows the credit on the spot side gets `usdClassTransfer(toPerp)`.
6. Result carries: intent hash, 1Click status and destination tx hashes, HL ledger entry if
   visible (`spotTransfer` or `send` to `hlAccount`), free collateral before and after.

The shared part of steps 1 to 4 is exactly what `intents-withdraw.ts` does with a different
destination. It moves into `src/rails/intents-spend.ts` (`spendFromIntents`) and both rails call
it. The intents withdraw rail keeps its own quote request, echo expectations, floor and sentences.

Fee model stays the 2026-08-20 one (flat about 0.32 USDC plus about 10 bp, plus 25 bp app fee
when no partner key is set). Refused below `MIN_DEPOSIT_USDC` (5) and when the effective fee is
above `MAX_FEE_PCT` (5 percent). The approval summary states the effective rate.

Deleted from the rail: the EVM and NEAR origin ports, the ERC-20 and `ft_transfer` legs, storage
registration, the origin-chain balance checks, the `chain` and `tokenId` draft fields, and the
`chain` argument of `propose_hl_deposit`.

## Rail 2: `hl_withdraw`, new

Draft:

    kind: 'hl_withdraw'
    symbol: 'USDC'
    amount: number          // USDC leaving the Hyperliquid account
    amountUsd: number
    minReceived: number     // the least USDC that may land in the intents balance
    from: string            // the Hyperliquid account: our EVM address
    to: string              // our intents account id: the EVM address, lowercased
    counterparty: string    // ONECLICK_COUNTERPARTY: the deposit address is per quote, the venue is 1Click

Sequence:

1. Simulate: dry quote with `depositType ORIGIN_CHAIN`, `originAsset` = the `hip1` id, amount in
   8 decimals, `destinationAsset` = `INTENTS_USDC_ASSET_ID` (`nep141:17208628...`, USDC on NEAR,
   the canonical intents USDC), `recipient` = `to`, `recipientType INTENTS`, `refundTo` = `from`,
   `refundType ORIGIN_CHAIN`, `swapType EXACT_INPUT`. Echo check. Read the HL account: refuse if
   `openPositions > 0`, if `marginUsedUsd > 0`, or if sendable USDC is below `amount + 1`.
   Sendable is `spotClearinghouseState.tokenToAvailableAfterMaintenance[0]` on a unified account
   and the spot USDC total on a standard one. Refuse if `amountOut < minReceived`.
2. Execute: live quote (mints a fresh HyperCore address, no memo), echo check again, then
   `userRole` on the deposit address. It answers `missing` for every fresh address, which is the
   Hyperliquid activation fee: the SENDER pays 1 USDC on top of the amount, the destination is
   credited in full. The sentence says so.
3. Sign `spotSend` with the master key: primaryType `HyperliquidTransaction:SpotSend`, fields
   `hyperliquidChain "Mainnet"`, `destination` (lowercased), `token "USDC:0x6d1e7cde53ba9467b783cb7c530ce054"`,
   `amount` (decimal string, trailing zeroes stripped), `time` (ms, equals the nonce). Same
   domain as `withdraw3`. POST to `/exchange`, refuse on `status: "err"`, ambiguous timeout rule
   as in the existing poster.
4. Poll `/v0/status` by deposit address to a terminal state.
5. Prove it: `userNonFundingLedgerUpdates` entry with `delta.nonce === time` and
   `delta.destination === depositAddress`; intents balance of `to` for the destination asset
   before and after (`mt_batch_balance_of`). Result carries the action time, the deposit address,
   the ledger hash, the 1Click status and the two balance deltas.

Floor: `minReceived = amount - (HL_ACTIVATION_USDC 1.0 + HL_WITHDRAW_FLAT_USDC 0.20 + 25 bp + 10 bp
slippage)`, and the rail refuses below `MIN_HL_WITHDRAW_USDC` (5). The summary states the
effective rate, because at 8 USDC it is about 15 percent and at 100 USDC about 1.5 percent.

Policy: `destinationOf` returns `draft.to`, which must be one of our addresses. Counterparty
`oneclick:1click.chaindefuser.com` is on the allowlist already. `allow` is downgraded to
`needs_approval` in `src/proposals/execute.ts`, beside the mandate rule, with the reason
"Collateral leaving the venue always needs a human click, whatever the size."

## Signing module

`src/rails/hyperliquid-withdraw.ts` keeps the domain, the sign port, the poster, the nonce rule
and `usdClassTransfer`, gains `SPOT_SEND_TYPES`, `buildSpotSendPayload`, `spotSend` and the token
string constant, and loses `withdraw3`, `buildWithdrawPayload`, `WITHDRAW_TYPES`,
`WITHDRAW_FEE_USDC`, `MIN_WITHDRAW_USDC` and `accountSummary` (zero callers). The module is
renamed `src/hl/user-signed.ts`, because it no longer withdraws and the name misled twice.
Tests assert the seven vectors from the signing spec (both SDK fixtures, spotSend Mainnet and
Testnet, usdClassTransfer).

## What the agent can verify

- `proposal_status` already returns status, verdict and the simulation summary; the rail results
  above put the evidence in `detail` and the hashes in `txids`.
- `wallet` gains one Hyperliquid row: free USDC, open positions, margin used, staleness. One read
  shows both pockets.
- The role text tells the agent: after any rail, read `proposal_status` and quote the evidence.

## Persona

`src/persona.ts` exports one identity block used by the MCP handshake (`INSTRUCTIONS` in
`src/mcp.ts`) and the in-app role (`buildRole` in `src/role.ts`): who the agent is, the voice,
the eight rules, the money graph, the withdraw rules, the verification habit. The seven stale
statements that reach the running agent are fixed: the `wallet` LP wording, the `withdraw3`
promise (two places), `CANNOT_APPROVE` on the two always-click tools, `switch` "different page",
"holds no Solana key", the `role.ts` delivery comment, the skill's dangling `context.md`.

## Sweep

Deleted: `ux/flow.md`, `docs/superpowers/plans/*` (7 done plans), the three 2026-08-20 yield and
perps specs, `config.local.json.before-2026-09-07`, `state/policy.json.stale-bak`,
`.claude/settings.local.json`, local branch `rebuild/two-venues`. Docs corrected: README,
`docs/reference.md`, `docs/architecture.md`, `docs/security-model.md`, `DISCLAIMER.md`.
Left for Karim: `.design/`, eight historical specs, branch `snapshot/lp-yield-gas`, two audit
backups, the remote copy of `rebuild/two-venues`.

## Proof

Unit (TDD) for every module above; typecheck; the full suite; `tests/injection.test.ts` and
`tests/lockdown.test.ts`; then live on mainnet: 10 USDC intents to HyperCore, 8 USDC back, two
clicks in the window; then a security audit of the signing and custody changes.

## Not in scope

A 1Click partner API key (removes the 25 bp app fee; Karim's to request). Solana signing.
Anything on the trade execution path, which a parallel session owns.
