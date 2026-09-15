# First deposit is invisible until the app restarts

Found: 2026-09-15, on a clean install of 0.5.0, during the first-run walkthrough.
Status: open. Severity: high. Every new user hits it on their very first deposit.

## What happens

1. Download the DMG, open Phosphor. The backend boots with no wallet (`wallet no_wallet` in the audit).
2. Create a wallet in the window (Secure Enclave or password, both paths).
3. Open the deposit card, send a small amount from an exchange to the address it shows.
4. The bridge credits the intents account in about a minute. The app keeps showing $0. The deposit
   card never moves past "watching". Nothing in the audit log mentions the deposit.

Real run: wallet created 23 seconds after boot, 0.00114 ETH sent on Ethereum, landed on chain at
18:55:23Z, minted to `intents.near` for the new account at 18:56:29Z. `wallet` read at 18:57:11Z:
`rows: []`, `totalUsd: 0`, `emptyCount: 0`. `balances` read at 18:58:32Z: five chains `ok`, no
holdings, no intents pocket at all. The balance was there the whole time when read directly from
`intents.near` with `mt_batch_balance_of`. Quit and relaunch, and it shows.

## Expected

The intents balance shows on the next refresh after the bridge credits it, and the deposit card
goes to "landed".

## Root cause

`src/ledger/index.ts:188`, in `createLiveLedger`:

```ts
const intentsAccount = intentsAccountId(cfg);
```

`intentsAccountId` reads the EVM address out of the keys file and returns `null` when there is no
file. It runs once, when `main.ts:347` builds the ledger at boot. On a fresh install there is no
keys file at boot, so `intentsAccount` is `null` for the life of the process, and both
`refreshIntents` (`:204`) and `refreshHyperliquid` (`:220`) return `undefined` on every refresh.
The verifier and the trading account are never read until a restart.

The deposit card is caught by the same thing. `src/vault/watch.ts` decides "landed" by
`ledger.intents()` going up (`credited`, `:61`), so with the pocket never read the watch cannot
end. The "seen" phase comes from `poaRecentDeposits` and does not depend on the ledger, so the
card may say the bridge saw the transfer and then sit there.

Wallet creation fires an audit line (`src/http/vault.ts:178`, `src/http/wallet.ts:202`) and tells
the ledger nothing.

## Fix

Two ways. Take the first.

1. Resolve the account on every refresh. Replace the `const` with a function call inside `refresh`
   (`intentsAccountId(cfg)` is one file read, cheap next to the RPC calls), and pass the result
   into `refreshIntents` and `refreshHyperliquid`. No new plumbing, and a wallet made or replaced
   at any point is picked up on the next pass. The `null` case stays what it is: an install with no
   key reads nothing.
2. Add `ledger.rebind()` and call it from the two wallet-create routes. Correct, but it puts a
   second thing the routes must remember to do next to the audit line, and the next path that
   makes a key (restore from backup, import) has to remember it too.

Test to add, in the ledger tests: build the live ledger with no keys file, refresh once and expect
no intents read, write a keys file, refresh again and expect the verifier to be queried for that
address. Then a watch test: the deposit watch lands when the wallet was created after the ledger.

## Workaround until it ships

Quit Phosphor and open it again after creating the wallet.

The on-chain hashes and the test wallet address are in the vault note, not here.
