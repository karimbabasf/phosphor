// The old fee account: the NEAR implicit account a 0.10.16 wallet paid NEAR into, so that it could
// put every vault move on chain itself. Phosphor pays NEAR's fee for every vault move now, as it
// does for swaps (src/vault/submit.ts sends each one through the NEAR Intents relay), so nothing
// is ever paid into this account again, and what it holds goes back to the vault in one transfer.
//
// ITS ID IS DERIVED, NEVER TYPED. The keystore derives its ed25519 seed from the owner key at every
// open (src/keystore/derived.ts) and its id is the hex of that key's public half. The NEAR goes to
// the vault's own NEAR deposit address, the one the Receive row shows for NEAR (src/http/wallet.ts
// intentsReceiveReport): computed here, never taken from a request, so no person and no agent can
// name where it goes.

import { NearTxError, YOCTO_PER_NEAR, transferAll, viewAccount } from '../chain/near-tx.ts';
import type { NearRpcDeps, SubmitDeps, TransferOutcome } from '../chain/near-tx.ts';

/* What the account keeps when its NEAR goes back: its own storage (an implicit account with its one
   key stores 182 bytes, 0.00182 NEAR) and the transfer's fee, well under the rest. */
export const OLD_GAS_KEEP_YOCTO = 3n * 10n ** 21n;
// The least a return carries: under 0.01 NEAR the window offers none.
export const OLD_GAS_LEAST_YOCTO = 10n ** 22n;

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

/* What a return would bring to the vault: what the account holds less what it keeps, when that is
   at least OLD_GAS_LEAST_YOCTO. Null for an account NEAR never saw or one with less; undefined when
   NEAR did not answer. */
export async function readOldGas(account: string, near: NearRpcDeps = {}): Promise<{ near: string } | null | undefined> {
  try {
    const view = await viewAccount(account, near);
    const back = view.found ? view.amount - OLD_GAS_KEEP_YOCTO : 0n;
    return back >= OLD_GAS_LEAST_YOCTO ? { near: nearText(back) } : null;
  } catch {
    return undefined;
  }
}

export type OldGasReturn =
  | { ok: true; near: string; txHash: string }
  | { ok: false; code: 'gas_empty' | 'gas_return_failed'; detail: string; txHash: string | null };

/* Sends what the old fee account holds, less what it keeps, to `to` (the vault's NEAR deposit
   address) in one transfer signed by the account's own seed. Done only when NEAR says the transfer
   ran; a send with no final answer is never signed again here, and the next read of the account
   says what became of it. */
export async function returnOldGas(request: { seed: Uint8Array; to: string }, near: SubmitDeps = {}): Promise<OldGasReturn> {
  let outcome: TransferOutcome;
  try {
    outcome = await transferAll({ seed: request.seed, receiverId: request.to, keep: OLD_GAS_KEEP_YOCTO, least: OLD_GAS_LEAST_YOCTO }, near);
  } catch (err) {
    if (err instanceof NearTxError && err.code === 'gas_empty') return { ok: false, code: 'gas_empty', detail: err.message, txHash: null };
    return { ok: false, code: 'gas_return_failed', detail: err instanceof Error ? err.message : String(err), txHash: null };
  }
  if (outcome.status === 'executed') return { ok: true, near: nearText(outcome.amount), txHash: outcome.txHash };
  return { ok: false, code: 'gas_return_failed', detail: `${outcome.status}: ${outcome.reason ?? ''}`, txHash: outcome.txHash };
}
