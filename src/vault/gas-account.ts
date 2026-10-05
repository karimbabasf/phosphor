// The gas account (GAS): the NEAR implicit account that puts every vault move on chain with one
// execute_intents call (src/vault/submit.ts), paid for in NEAR it holds.
//
// ITS ID IS DERIVED, NEVER TYPED. The keystore derives GAS's ed25519 seed from the owner key at
// every open (src/keystore/derived.ts) and its id is the hex of that key's public half. A NEAR
// payout cannot be refunded once it leaves (a native NEAR transfer cannot fail), so the one address
// this app pays NEAR to for its own use comes from that derivation and from nothing a person or an
// agent can type.
//
// FUNDING, the R4 route (reports/spike2.md R4, CONTRACTS.md "1Click (U7, U10)"): an ordinary payout
// of NEAR on the NEAR chain to the 64-hex id, through the pay rail (src/rails/intents-pay.ts).
// 1Click turns wNEAR held inside NEAR Intents into native NEAR (native_withdraw), fee 0, and the
// first payment creates the account. It is a proposal like any payout: a click and a Touch ID that
// names the gas account.
//
// LOW means a submit would be refused: NEP-642 holds the attached gas at its purchase price, so GAS
// needs gasNeededYocto free before anything is signed (src/chain/near-tx.ts, GAS_LOW_YOCTO 0.06 NEAR
// at today's price). The window shows it beside a refill.

import { GAS_LOW_YOCTO, YOCTO_PER_NEAR, viewAccount } from '../chain/near-tx.ts';
import type { NearRpcDeps } from '../chain/near-tx.ts';

// What one funding may pay: enough for hundreds of moves, and no more than the loss the docs name
// for a compromised Node (about 0.5 NEAR), with room for a refill on top.
export const GAS_FUND_MIN_NEAR = 0.1;
export const GAS_FUND_MAX_NEAR = 1;

export function isGasAccount(id: unknown): id is string {
  return typeof id === 'string' && /^[0-9a-f]{64}$/.test(id);
}

// The derived id, or null until this process has opened the wallet once.
export function gasAccountOf(keystore: { derivedAccounts(): { gas: string } | null }): string | null {
  const gas = keystore.derivedAccounts()?.gas ?? null;
  return isGasAccount(gas) ? gas : null;
}

/* NEAR in base units as the window shows it: at most four places, trailing zeros trimmed, never
   rounded up ("0.4985" for 498_512_345... yocto). */
export function nearText(yocto: bigint): string {
  const whole = yocto / YOCTO_PER_NEAR;
  const frac = ((yocto % YOCTO_PER_NEAR) * 10_000n) / YOCTO_PER_NEAR;
  const places = frac.toString().padStart(4, '0').replace(/0+$/, '');
  return places === '' ? whole.toString() : `${whole}.${places}`;
}

export type GasRead = { amount: bigint | null; low: boolean | null };

/* What GAS holds now: an account NEAR has never seen holds nothing yet. Null when NEAR did not
   answer. */
export async function readGas(account: string, near: NearRpcDeps = {}): Promise<GasRead> {
  try {
    const view = await viewAccount(account, near);
    const amount = view.found ? view.amount : 0n;
    return { amount, low: amount < GAS_LOW_YOCTO };
  } catch {
    return { amount: null, low: null };
  }
}

// The funding amount the route takes, in NEAR, or null.
export function fundingNear(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  if (raw < GAS_FUND_MIN_NEAR || raw > GAS_FUND_MAX_NEAR) return null;
  // Four places at most: what a person types, and what the card shows.
  return Number(raw.toFixed(4)) === raw ? raw : null;
}
