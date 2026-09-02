// What any yield venue has to be able to answer, and nothing else.
//
// This file imports no RPC client and no ABI on purpose, for the same reason
// src/rails/kinds.ts does not: the policy engine and the allocator both need to talk about
// venues, and neither should have to pull a chain client in to do it. The Aave adapter in
// ./aave.ts is the only thing that knows how a venue is actually reached.
//
// The interface is deliberately five methods. A venue that needs a sixth is a venue whose
// shape does not fit here, and the honest move then is a second interface rather than an
// optional field that half the callers forget to check.

import type { ChainId } from '../types.ts';

export type VenueId = 'aave-v3';

// The rate a venue is paying right now, as the venue itself reports it.
//
// Two numbers rather than one, because they are genuinely different and the difference is
// the kind of thing this app refuses to paper over. Aave publishes an ANNUALISED SIMPLE
// rate (currentLiquidityRate, in RAY) and then compounds it every second. So the simple
// rate is what the contract says and the compounded rate is what a depositor actually gets,
// and quoting either one as "the APY" without saying which is how a number becomes a lie by
// a tenth of a percent.
// aprRay is a STRING and not a bigint, and the reason is not style.
//
// This type is carried in the view that /api/state serialises, and JSON.stringify throws on
// a bigint rather than dropping it: "Do not know how to serialize a BigInt", which took out
// the WHOLE state payload and not just this field. Every panel in the window went blank
// because a lending rate was the wrong type. Keeping the raw value as a decimal string
// preserves all 27 digits of it, costs nothing, and makes that failure impossible to
// reintroduce. The two numbers below are what anything actually computes on.
export type VenueRate = {
  aprRay: string; // the raw annualised simple rate, RAY (1e27), exactly as the venue stores it
  apr: number; // aprRay as a fraction: 0.0427 for 4.27 percent
  apy: number; // the same rate compounded per second, which is what a depositor receives
};

// What we hold at a venue, read from the chain and never from a file.
export type VenuePosition = {
  // The venue's receipt token balance, in the UNDERLYING asset's base units. For a rebasing
  // receipt like an aToken this grows every block, which is the whole reason this venue type
  // was picked: current value needs no accounting layer, only a balanceOf.
  balanceBase: bigint;
  // The same holding in the venue's own internal units, which does NOT grow with interest.
  // Kept because it is the only way to tell "the balance went up because interest accrued"
  // from "the balance went up because someone deposited more", and those must not be
  // confused when the ledger is written.
  scaledBase: bigint;
  // The venue's index at the moment of the read, RAY. balanceBase = scaledBase * index / RAY.
  indexRay: bigint;
};

// Everything a rail needs to build one transaction, with no signing anywhere in sight.
// The rail hands these to src/chain/evm.ts, which is the only module that holds a key.
export type VenueCall = {
  to: string; // the contract to call
  data: string; // calldata, 0x-prefixed
  label: string; // what this call does, in words, for the approval gate and the log
};

export type VenueAsset = {
  symbol: string;
  address: string;
  decimals: number;
  receipt: string; // the aToken / share token address
  receiptSymbol: string;
};

export type YieldVenue = {
  id: VenueId;

  // Which chains this venue is wired for on this network. A chain absent here is a chain the
  // venue is not reachable on, and every caller treats that as a refusal rather than a retry.
  chains(): ChainId[];

  // The stablecoin this venue takes on this chain, or null when it takes none. Null is the
  // normal answer for most chain and network pairs and is not an error.
  asset(chain: ChainId, symbol: string): VenueAsset | null;

  // What it is paying, right now, read live.
  rate(chain: ChainId, symbol: string): Promise<VenueRate>;

  // What we hold there, right now, read live.
  position(chain: ChainId, symbol: string, owner: string): Promise<VenuePosition>;

  // The calls that put money in. More than one because ERC-20 venues need an approval first,
  // and the approval is a real transaction a human should see named rather than a hidden step.
  // Returns an empty array when the allowance already covers the amount, which is why the
  // caller must not assume a fixed length.
  depositCalls(args: {
    chain: ChainId;
    symbol: string;
    owner: string;
    amountBase: bigint;
  }): Promise<VenueCall[]>;

  // The calls that take money out. `amountBase` of null means everything, including whatever
  // interest arrived between the quote and the signature, which is a real gap on a rebasing
  // token and the reason this is not expressed as a number the caller computes.
  withdrawCalls(args: {
    chain: ChainId;
    symbol: string;
    owner: string;
    amountBase: bigint | null;
  }): Promise<VenueCall[]>;
};

// ---------- shared maths ----------

export const RAY = 10n ** 27n;
export const SECONDS_PER_YEAR = 31_536_000;

// A RAY-scaled annualised simple rate as a plain fraction. Kept in one place because doing
// it inline is how one call site ends up dividing by 1e18.
export function aprFromRay(rateRay: bigint): number {
  return Number(rateRay) / Number(RAY);
}

// The compounded equivalent. Aave accrues every second, so the effective rate is
// (1 + apr/n)^n - 1 with n the seconds in a year, which is within floating point noise of
// exp(apr) - 1 at any rate a lending pool will ever pay.
export function apyFromApr(apr: number): number {
  return Math.expm1(apr);
}

export function rateFromRay(rateRay: bigint): VenueRate {
  const apr = aprFromRay(rateRay);
  return { aprRay: rateRay.toString(), apr, apy: apyFromApr(apr) };
}

// ---------- base units ----------
//
// The same rule src/rails/uniswap.ts keeps, and for the same reason: at 18 decimals
// amount * 10 ** decimals is a thousand times past Number.MAX_SAFE_INTEGER and the low
// digits are rounding noise. At 6 decimals it survives, but a helper that is only correct
// for the decimals we happen to use today is a trap left for whoever adds DAI.

// NOTE ON THE THIRD COPY. src/intents.ts and src/rails/uniswap.ts each already carry a
// toBaseUnits, and this is a third. They are not folded together here because the other two
// live in modules that pull in viem, ABIs and deployment tables, and the point of this file
// is that the policy engine and the allocator can import it without any of that. The drift
// risk is real and is answered by a test rather than by a comment: tests/unit/yield.test.ts
// asserts this implementation agrees with the uniswap one across a table of amounts.

// String(amount), NOT amount.toFixed(20).
//
// JavaScript prints the SHORTEST decimal that round-trips to the same double, so
// String(56.292032) is '56.292032', which is what the person typed. toFixed(20) prints the
// float's true expansion, '56.29203199999999895908', and truncating THAT to six places gives
// 56.292031: one base unit short, every time, silently. Caught by a test rather than by a
// user finding they could not withdraw the balance the screen showed them.
export function decimalString(amount: number): string {
  if (!Number.isFinite(amount)) throw new Error(`amount is not finite: ${amount}`);
  const s = String(amount);
  if (!/e/i.test(s)) return s;
  // Exponential notation, which the digit walk below cannot read. Expanded by hand because
  // 1e-7 has to become 0.0000001 before it can be split on the decimal point.
  const parts = s.split(/e/i);
  const exp = Number(parts[1]);
  const negative = parts[0].startsWith('-');
  const bare = negative ? parts[0].slice(1) : parts[0];
  const split = bare.split('.');
  const digits = split[0] + (split[1] ?? '');
  const point = split[0].length + exp;
  let out: string;
  if (point <= 0) out = `0.${'0'.repeat(-point)}${digits}`;
  else if (point >= digits.length) out = digits + '0'.repeat(point - digits.length);
  else out = `${digits.slice(0, point)}.${digits.slice(point)}`;
  return negative ? `-${out}` : out;
}

export function toBaseUnits(amount: number, decimals: number): bigint {
  if (!Number.isFinite(amount)) throw new Error(`amount is not finite: ${amount}`);
  if (amount < 0) throw new Error(`amount is negative: ${amount}`);
  const s = decimalString(amount);
  const [whole, frac = ''] = s.split('.');
  const padded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded || '0');
}

export function fromBaseUnits(amount: bigint, decimals: number): number {
  const neg = amount < 0n;
  const abs = neg ? -amount : amount;
  const d = 10n ** BigInt(decimals);
  const whole = abs / d;
  const frac = abs % d;
  const out = Number(whole) + Number(frac) / Number(d);
  return neg ? -out : out;
}
