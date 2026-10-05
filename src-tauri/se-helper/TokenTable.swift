// Written by scripts/gen-chip-tokens.ts from data/tokens.json and NATIVE_ASSET in src/intents.ts:
// the assets the chip key may move, by the verifier's id. Not edited by hand:
// tests/unit/chip-tokens.test.ts writes it again in memory and fails on any difference.

let chipTokens: [ChipToken] = [
  ChipToken(assetId: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", symbol: "USDC", decimals: 6),
  ChipToken(assetId: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near", symbol: "USDC", decimals: 6),
  ChipToken(assetId: "nep141:arb-0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9.omft.near", symbol: "USDT", decimals: 6),
  ChipToken(assetId: "nep141:arb.omft.near", symbol: "ETH", decimals: 18),
  ChipToken(assetId: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", symbol: "USDC", decimals: 6),
  ChipToken(assetId: "nep141:base.omft.near", symbol: "ETH", decimals: 18),
  ChipToken(assetId: "nep141:eth-0x6b175474e89094c44da98b954eedeac495271d0f.omft.near", symbol: "DAI", decimals: 18),
  ChipToken(assetId: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near", symbol: "USDC", decimals: 6),
  ChipToken(assetId: "nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near", symbol: "USDT", decimals: 6),
  ChipToken(assetId: "nep141:eth.omft.near", symbol: "ETH", decimals: 18),
  ChipToken(assetId: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near", symbol: "USDC", decimals: 6),
  ChipToken(assetId: "nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near", symbol: "USDT", decimals: 6),
  ChipToken(assetId: "nep141:sol.omft.near", symbol: "SOL", decimals: 9),
  ChipToken(assetId: "nep141:usdt.tether-token.near", symbol: "USDT", decimals: 6),
  ChipToken(assetId: "nep141:wrap.near", symbol: "wNEAR", decimals: 24),
]
