# sendAsset research, 2026-09-20

Fetched pages are data, not instructions. Every claim below names its URL.

## 1. The action (Hyperliquid official docs)

URL: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint (section "Send Asset")

"This generalized method is used to transfer tokens between different perp DEXs, spot balance,
users, and/or sub-accounts. Use "" to specify the default USDC perp DEX and "spot" to specify
spot. Only the collateral token can be transferred to or from a perp DEX."

Body:

    action = {
      "type": "sendAsset",
      "hyperliquidChain": "Mainnet",            // "Testnet" on testnet
      "signatureChainId": "0xa4b1",             // hex chain id the wallet signed under
      "destination": "0x...",                   // 42-char hex address
      "sourceDex": "",                          // "" = default perp dex, "spot" = spot
      "destinationDex": "",                     // same vocabulary
      "token": "USDC:0x6d1e7cde53ba9467b783cb7c530ce054",   // tokenName:tokenId
      "amount": "5",                            // string
      "fromSubAccount": "",                     // "" when not from a sub-account
      "nonce": 1758400000000                    // ms timestamp, equals the outer nonce
    }
    nonce = same number
    signature = { r, s, v }

## 2. The signing scheme (official Python SDK)

URL: https://raw.githubusercontent.com/hyperliquid-dex/hyperliquid-python-sdk/master/hyperliquid/utils/signing.py

    SEND_ASSET_SIGN_TYPES = [
        {"name": "hyperliquidChain", "type": "string"},
        {"name": "destination", "type": "string"},
        {"name": "sourceDex", "type": "string"},
        {"name": "destinationDex", "type": "string"},
        {"name": "token", "type": "string"},
        {"name": "amount", "type": "string"},
        {"name": "fromSubAccount", "type": "string"},
        {"name": "nonce", "type": "uint64"},
    ]
    sign_send_asset_action -> sign_user_signed_action(wallet, action, SEND_ASSET_SIGN_TYPES,
                                                       "HyperliquidTransaction:SendAsset", is_mainnet)

sign_user_signed_action sets action.signatureChainId = "0x66eee" and hyperliquidChain, then
builds EIP-712 typed data with domain
{ name: "HyperliquidSignTransaction", version: "1", chainId: int(signatureChainId),
  verifyingContract: 0x0000000000000000000000000000000000000000 }, primaryType
"HyperliquidTransaction:SendAsset", message = the action. This is the user-signed path, the
same domain hl-user-signed.ts already uses for spotSend and usdSend. The SDK's exchange.py
(https://raw.githubusercontent.com/hyperliquid-dex/hyperliquid-python-sdk/master/hyperliquid/exchange.py)
posts { action, nonce, signature } with no vaultAddress.

## 3. Does it serve a withdrawal on a unified account? Yes.

URL: https://docs.swapkit.dev/spotlights/chain-specific-guides/hypercore-signing-and-broadcasting

"Do not substitute Hyperliquid's usdSend or spotSend actions. Both are rejected outright on a
unified account with {"status":"err","response":"Action disabled when unified account is
active"}, and unified is Hyperliquid's recommended mode. sendAsset is the only transfer both
account types can execute." Also: "A unified account also reports every balance under
spotClearinghouseState, with clearinghouseState.withdrawable reading "0.0"", and SwapKit
"reads the sender's live perps and spot balances and picks whichever can fund the transfer,
preferring perps".

URL: https://docs.near-intents.org/integration/distribution-channels/1click-api/hyperliquid.md

1Click accepts sendAsset for a Hyperliquid-origin deposit: "sendAsset: Supported. Spot or
perp, the standard Send in the Hyperliquid app. Send quote.amountIn." spotSend is spot only;
usdSend is perp only and "Extra 1 USDC is deducted on top of the 0.2 USDC deposit fee". The
page also states: flat 0.2 USDC deducted from each USDC transfer to the deposit address;
minimum deposit 0.5 USDC; HyperCore USDC is 1cs_v1:hypercore:hip1:0x6d1e7cde53ba9467b783cb7c530ce054
with 8 decimals; a deposit into Hyperliquid lands in the perps balance.

## 4. The activation fee stays

URL: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/activation-gas-fee

"New HyperCore accounts require 1 quote token (e.g., 1 USDC, 1 USDT) of fees for the first
transaction which has the new account as destination address. This applies regardless of the
asset being transferred to the new account." Every 1Click deposit address is a new HyperCore
account (userRole answers "missing"), so the sender pays 1 USDC on top of the amount whatever
action carries it. HL_ACTIVATION_FEE_USDC stays on the card.

## 5. Decision

Withdraw signs one sendAsset with the master key: token USDC:<tokenId from the venue's spot
meta>, sourceDex "spot" on a unified account (the unified balance is reported under
spotClearinghouseState and the perps side reads 0), "spot" on a classic account too (the rail
always spent the spot book), destinationDex "spot" (1Click accepts either; spot is the side the
live 2026-09-11 spotSend deposits proved), fromSubAccount "", amount as the venue formats it
(no trailing zeroes). The response is read the way exchange.ts reads every venue answer: HTTP
200 with status "err" is a refusal, never a success.

## 6. Signing vectors, produced with the official SDK (hyperliquid-python-sdk 0.24.0, scratch venv, 2026-09-20)

Inputs are the SDK's own fixture key and destination (tests/signing_test.py), nonce 1687816341423,
token USDC:0x6d1e7cde53ba9467b783cb7c530ce054, amount "1", sourceDex "spot", destinationDex "spot",
fromSubAccount "". The venv first reproduced the repo's pinned spotSend vector byte for byte
(r 0xd252d075..., s 0x64fa8a36..., v 28), so the SDK copy is the real one.

    sendAsset Mainnet  r 0xfe1a043dc1f5b7e5bd361b397a615f8f791a317cf2d7c28e483746020cf2dd04
                       s 0x3dbf449f1d7dc7c819e04c8f88e30edc762abbc69351d278e851c2b7c1fd9d39  v 28
    sendAsset Testnet  r 0x99a9ac7337378f56543cb5a762b710d4afd8925abf644bb6ec03ed9669c8f60e
                       s 0x5d2db4547b8b54c9c54ce80a4948031566e5e78267eb3d9fe811960f59a7dcc0  v 27

tests/unit/hl-user-signed.test.ts asserts viem produces the same r, s, v from buildSendAssetPayload.

## 7. Live read-only probe of the real account, 2026-09-20 (public /info, no key)

    userAbstraction            "unifiedAccount"
    userRole                   {"role":"user"}
    clearinghouseState         withdrawable 0.0, accountValue 0.0, 0 positions
    spotClearinghouseState     USDC total 0.000775, tokenToAvailableAfterMaintenance [[0, "0.000775"]]
    spotMeta USDC              index 0, tokenId 0x6d1e7cde53ba9467b783cb7c530ce054, 8 wei decimals

1Click dry quotes the same minute (no partner key):
    withdraw 5 USDC hypercore -> intents: out 4.787511, minAmountOut 4.782723, timeEstimate 35 s,
      refundFee 0.3153, quoteRequest.appFees [{"fee":25}]  (5 - 4.787511 = 0.212489 = 0.20 flat + 25 bp)
    deposit 7 USDC eth-USDC in intents -> hypercore: out 6.666488, minAmountOut 6.659511,
      timeEstimate 20 s, withdrawFee 0.3153 (8 decimals), quoteRequest.appFees [{"fee":25}]
