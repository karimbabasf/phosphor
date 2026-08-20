// What it costs to put collateral on this venue, as a shape rather than as a price.
//
// The trading surface has to make the funding capability legible without becoming a place a
// human starts a deposit from. That means it prints what the rail WOULD cost, and it prints
// the shape of the cost rather than one flattering number: the routing fee is close to flat,
// so the same deposit is 5 percent at the floor and a tenth of a percent at a thousand
// dollars, and a screen that says "about 0.7 percent" without saying against what has told
// the reader the wrong thing twice.
//
// MEASURED, NOT QUOTED. The two coefficients below came from live 1Click dry quotes taken on
// 2026-08-20 against arb, eth and base. They are display material for a screen with no input
// on it: nothing here prices a real deposit. Every number a human actually approves comes from
// the rail's own simulate(), which quotes the live router and refuses the draft when the
// quote disagrees with it.
//
// The floor and the ceiling are NOT measured, they are policy, and they live in
// src/rails/hypercore-deposit.ts. They are restated here because this module must not drag the
// rail's whole dependency graph (viem, the NEAR client, the 1Click client) into a pure payload
// builder. tests/unit/trade-collateral.test.ts imports both and fails if the two ever disagree,
// which is what keeps a restatement from becoming a fork.

import type { ChainId, Network } from '../types.ts';

// One origin the rail has actually routed from, with what the router said it takes. Solana is
// absent because the signer is, which is the same honest gap the swap rail carries, and near
// is absent from this list because it has not been measured rather than because it is refused.
export type FundingOrigin = { chain: ChainId; etaSec: number };

export type FundingShape = {
  // Below this the rail refuses: the flat part of the fee stops being a fee and starts being
  // most of the deposit.
  minUsd: number;
  // What a deposit is allowed to cost before the rail stops calling it a deposit.
  maxFeePct: number;
  // The measured cost model. cost = flatUsd + amount * rateBp / 10000.
  flatUsd: number;
  rateBp: number;
  origins: FundingOrigin[];
  measuredOn: string;
};

export const FUNDING_SHAPE: FundingShape = {
  minUsd: 5,
  maxFeePct: 5,
  flatUsd: 0.315,
  rateBp: 10,
  origins: [
    { chain: 'arb', etaSec: 35 },
    { chain: 'base', etaSec: 45 },
    { chain: 'eth', etaSec: 55 },
  ],
  measuredOn: '2026-08-20',
};

// What the model says a deposit of this size costs, as a percentage. Null rather than Infinity
// for a size that cannot be charged against, because null is how the rest of this surface says
// it does not know and a screen printing Infinity has said something false.
export function feePctAt(amountUsd: number, shape: FundingShape = FUNDING_SHAPE): number | null {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) return null;
  const cost = shape.flatUsd + (amountUsd * shape.rateBp) / 10_000;
  return (cost / amountUsd) * 100;
}

// The two sizes the surface quotes the cost at. Two, and these two, because the whole point is
// that ONE number would be a lie: the fee is close to flat, so the percentage is a fact about
// the amount and not about the rail. A small size and a size twenty times larger is the
// shortest way to show a reader that depositing more at once costs the same in dollars.
const SAMPLE_SIZES = [50, 1000];

// Below this a balance is dust and not collateral.
//
// The number is the display threshold, and that is the whole argument: every dollar figure on
// this surface rounds at half a cent, so a balance the screen prints as $0.00 must not also
// drive a flag that says the account has something in it. The live mainnet account holds
// 0.000002 USDC, which is a rounding artefact of a venue that has never been funded. Counting
// it as collateral hides the one line an empty account needs, which is the line that says what
// to do next.
export const DUST_USD = 0.005;

// Where testnet collateral comes from instead, printed as text because this surface is a
// terminal and not a set of links. Held as a constant so the screen and the rail's refusal
// cannot come to name two different places; tests/unit/trade-collateral.test.ts asks the rail
// for its own refusal and fails if this string is not inside it.
export const FUNDING_FAUCET = 'app.hyperliquid-testnet.xyz/drip';

// The funding facts as the browser renders them. Assembled here rather than on the client so
// that the arithmetic behind a cost on screen lives with the model it comes from, and so the
// page does no maths about money at all.
export type FundingBlock = {
  // Whether the rail can fund the network this app is TRADING. It is mainnet only, and the
  // reason is the worst failure this rail could have: 1Click has no testnet and the asset it
  // delivers is mainnet HyperCore USDC, while one EVM address names an account on both
  // networks. A testnet deposit would take real money, land it correctly on the mainnet
  // account, report success, and leave the account being traded empty. The rail refuses it,
  // and a screen advertising a capability its rail refuses would be sending a person to ask
  // for something they cannot have.
  available: boolean;
  minUsd: number;
  maxFeePct: number;
  // The fastest measured origin's time, in seconds.
  etaSec: number | null;
  // Measured origins, fastest first. Naming them is what makes the claim checkable.
  origins: string[];
  costAt: { usd: number; pct: number }[];
  // Only when the rail cannot serve this network: where the collateral comes from instead.
  faucet: string | null;
};

export function fundingBlock(network: Network, shape: FundingShape = FUNDING_SHAPE): FundingBlock {
  const available = network === 'mainnet';
  const ordered = [...shape.origins].sort((a, b) => a.etaSec - b.etaSec);
  const costAt: { usd: number; pct: number }[] = [];
  for (const usd of SAMPLE_SIZES) {
    const pct = feePctAt(usd, shape);
    if (pct !== null) costAt.push({ usd, pct });
  }
  return {
    available,
    minUsd: shape.minUsd,
    maxFeePct: shape.maxFeePct,
    etaSec: ordered.length > 0 ? ordered[0].etaSec : null,
    origins: ordered.map((o) => o.chain),
    costAt,
    faucet: available ? null : FUNDING_FAUCET,
  };
}
