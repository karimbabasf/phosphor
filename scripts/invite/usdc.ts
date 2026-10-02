// The USDC that is not NEAR's, as the operator script sees it: which ones there are, how T's
// balance of each reads, and how an amount is said. scripts/invite/convert.ts turns them into NEAR
// USDC; issue, status and treasury (scripts/invite/money.ts, scripts/invite.ts) and the proof script
// read them to say what arrived.

import { baseUnitsToDecimal } from '../../src/intents.ts';
import { INVITE_ASSET_DECIMALS } from '../../src/invite/payload.ts';
import type { VerifierPort } from '../../src/relay/verifier.ts';

export type UsdcVariant = { assetId: string; chain: string; decimals: number };

/* Every USDC inside NEAR Intents but NEAR's own: 1Click's list on 2026-10-01 (GET /v0/tokens,
   symbol exactly USDC and a NEAR Intents token id), the four the app's Send can hold matching
   data/tokens.json. Pinned here, ids and decimals both: the list is unsigned (src/rails/asset-pin.ts
   says why that matters), and the decimals scale the floor every convert is held to. */
export const USDC_VARIANTS: readonly UsdcVariant[] = [
  { assetId: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near', chain: 'Base', decimals: 6 },
  { assetId: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near', chain: 'Ethereum', decimals: 6 },
  { assetId: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near', chain: 'Arbitrum', decimals: 6 },
  { assetId: 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near', chain: 'Solana', decimals: 6 },
  { assetId: 'nep141:gnosis-0x2a22f9c3b484c3629090feed35f17ff8f88f76f0.omft.near', chain: 'Gnosis', decimals: 6 },
  { assetId: 'nep141:aptos-34ee497f210c5a511e8d5b53bc56d75b63612bb5.omft.near', chain: 'Aptos', decimals: 6 },
  { assetId: 'nep141:sui-c1b81ecaf27933252d31a963bc5e9458f13c18ce.omft.near', chain: 'Sui', decimals: 6 },
  { assetId: 'nep245:v2_1.omni.hot.tg:137_qiStmoQJDQPTebaPjgx5VBxZv6L', chain: 'Polygon', decimals: 6 },
  { assetId: 'nep245:v2_1.omni.hot.tg:10_A2ewyUyDp6qsue1jqZsGypkCxRJ', chain: 'Optimism', decimals: 6 },
  { assetId: 'nep245:v2_1.omni.hot.tg:43114_3atVJH3r5c4GqiSYmg9fECvjc47o', chain: 'Avalanche', decimals: 6 },
  { assetId: 'nep245:v2_1.omni.hot.tg:56_2w93GqMcEmQFDru84j3HZZWt557r', chain: 'BNB Chain', decimals: 18 },
  { assetId: 'nep245:v2_1.omni.hot.tg:1100_111bzQBB65GxAPAVoxqmMcgYo5oS3txhqs1Uh1cgahKQUeTUq1TJu', chain: 'Stellar', decimals: 7 },
  { assetId: 'nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx', chain: 'Monad', decimals: 6 },
  { assetId: 'nep245:v2_1.omni.hot.tg:196_2dK9kLNR7Ekq7su8FxNGiUW3djTw', chain: 'X Layer', decimals: 6 },
];

export type OtherUsdc = { variant: UsdcVariant; base: bigint };

export function variantOf(assetId: string | undefined): UsdcVariant | undefined {
  return USDC_VARIANTS.find((v) => v.assetId === assetId);
}

// A variant's base units as NEAR USDC's six places, rounded down.
export function asInviteBase(base: bigint, decimals: number): bigint {
  const shift = decimals - INVITE_ASSET_DECIMALS;
  return shift >= 0 ? base / 10n ** BigInt(shift) : base * 10n ** BigInt(-shift);
}

// One cent of a variant: anything less is left where it is.
function centOf(variant: UsdcVariant): bigint {
  return variant.decimals > 2 ? 10n ** BigInt(variant.decimals - 2) : 1n;
}

/* NEAR USDC base units as dollars, exact past the cent when there is more: 1.00, 0.9998, 2.50.
   formatUsdc rounds down to the cent, which would show a convert that gave up two hundredths of a
   percent as one that gave up one. */
export function exactDollars(base: bigint): string {
  const [whole, fraction = ''] = baseUnitsToDecimal(base, INVITE_ASSET_DECIMALS).split('.');
  return `${whole}.${fraction.padEnd(2, '0')}`;
}

// "$1.00 USDC on Base".
export function heldWords(held: OtherUsdc): string {
  return `$${exactDollars(asInviteBase(held.base, held.variant.decimals))} USDC on ${held.variant.chain}`;
}

export function heldList(held: OtherUsdc[]): string {
  const words = held.map(heldWords);
  return words.length <= 1 ? (words[0] ?? 'nothing') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

/* What `account` holds of each USDC but NEAR's, read live: the ones at a cent or more, and the
   ones whose read did not answer. */
export async function otherUsdc(net: { verifier: VerifierPort }, account: string): Promise<{ held: OtherUsdc[]; unread: UsdcVariant[] }> {
  const reads = await Promise.all(USDC_VARIANTS.map((v) => net.verifier.balance(account, v.assetId).catch(() => null)));
  const held: OtherUsdc[] = [];
  const unread: UsdcVariant[] = [];
  USDC_VARIANTS.forEach((variant, i) => {
    const base = reads[i] ?? null;
    if (base === null) unread.push(variant);
    else if (base >= centOf(variant)) held.push({ variant, base });
  });
  return { held, unread };
}
