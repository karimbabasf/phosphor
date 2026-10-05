// The top-up rail: a vault_top_up draft, from the vault to the allowance (PHASE2-PLAN.md C8).
//
// The money never leaves the verifier and never reaches anyone else: the vault's chip key signs
// one transfer to the allowance behind one Touch ID, and the gas account sends it
// (src/vault/allowance.ts, src/vault/submit.ts). Nothing here signs with a key this process holds.
//
// A top-up runs only on a person's click: the engine never allows one on its own
// (src/policy/engine.ts), and this rail refuses one the policy decided as well. The accounts are
// the app's own, read when it runs: a draft naming any other vault or allowance is refused before
// the touch. A send that comes back without a final answer is waited on here, by the submitter's
// rule and never by signing again, until NEAR says it ran or never can; past that the row settles
// by the allowance's balance, as every rail's does. A refusal that came after the signed bundle
// left this Mac (simulate was asked) is such a send: the RPC saw the bytes, and anyone holding them
// can run them until their deadline, so the row waits on NEAR and never says nothing was sent.

import { baseUnitsToDecimal, decimalToBaseUnits } from '../intents.ts';
import { INTENTS_VERIFIER } from '../ledger/intents.ts';
import type { PocketRead } from '../ledger/settle.ts';
import type { Rail, RailHooks, RailResult, SimulationResult, VaultTopUpDraft } from '../types.ts';
import type { AllowanceService, CoinAmount } from '../vault/allowance.ts';
import type { VaultResult } from '../vault/submit.ts';
import { ReasonError } from './reasons.ts';
import type { ReasonCode } from './reasons.ts';

// Where both accounts live: the one counterparty a top-up names, on the venue allowlist already.
export const VAULT_TOP_UP_COUNTERPARTY = INTENTS_VERIFIER;

export type VaultTopUpDeps = { allowance?: AllowanceService };

function coinOf(draft: VaultTopUpDraft): CoinAmount {
  return { asset: draft.asset, symbol: draft.symbol, decimals: draft.decimals, base: decimalToBaseUnits(draft.amount, draft.decimals) };
}

function words(coin: CoinAmount): string {
  return `${baseUnitsToDecimal(coin.base, coin.decimals)} ${coin.symbol}`;
}

/* The accounts the draft names, against the app's own at this moment. Throws (nothing signed) on a
   vault that has not moved to the chip, or a draft naming another vault or allowance. */
function accountsFor(service: AllowanceService, draft: VaultTopUpDraft): { vault: string; allowance: string } {
  const acc = service.accounts();
  if (acc.kind !== 'chip' || acc.vault === null) {
    throw new ReasonError('not_available', 'your vault is not on this Mac\'s Touch ID key, so there is no vault to top up from; nothing was signed');
  }
  if (acc.allowance === null) throw new ReasonError('not_available', 'the wallet is locked: unlock it once so the app knows your allowance; nothing was signed');
  const vault = acc.vault.toLowerCase();
  const allowance = acc.allowance.toLowerCase();
  if (draft.from.toLowerCase() !== vault || draft.to.toLowerCase() !== allowance) {
    throw new ReasonError('invalid_request', `the top-up names ${draft.from} to ${draft.to}, not this app's vault ${vault} and allowance ${allowance}; nothing was signed`);
  }
  if (draft.counterparty !== VAULT_TOP_UP_COUNTERPARTY) throw new ReasonError('invalid_request', `a top-up moves only inside ${VAULT_TOP_UP_COUNTERPARTY}; nothing was signed`);
  return { vault, allowance };
}

// A refusal's vault or chip code, as the cause a row carries (src/rails/reasons.ts).
function causeOf(code: string, detail: string): ReasonCode {
  if (code === 'user_cancel') return 'declined';
  if (code === 'kill_switch' || code === 'rules_unreadable') return code;
  if (code === 'simulate_refused' && /insufficient balance/i.test(detail)) return 'insufficient_balance';
  // NEAR proved the send never ran and never can (src/vault/submit.ts, dead): over, and nothing moved.
  if (code === 'vault_dead') return 'venue_failed_nothing_moved';
  return 'not_sent';
}

export function vaultTopUpRail(deps: VaultTopUpDeps): Rail<VaultTopUpDraft> {
  function service(): AllowanceService {
    if (deps.allowance === undefined) throw new ReasonError('not_available', 'this app has no vault on a Touch ID key to top up from; nothing was signed');
    return deps.allowance;
  }

  async function simulate(draft: VaultTopUpDraft): Promise<SimulationResult> {
    try {
      const s = service();
      const { vault } = accountsFor(s, draft);
      const coin = coinOf(draft);
      if (coin.base <= 0n) throw new ReasonError('invalid_request', 'a top-up moves more than nothing');
      const held = await s.balance(vault, coin.asset);
      if (held === null) throw new ReasonError('balance_unread', `your vault's ${coin.symbol} could not be read just now`);
      if (held < coin.base) {
        throw new ReasonError('insufficient_balance', `your vault holds ${baseUnitsToDecimal(held, coin.decimals)} ${coin.symbol}, less than the ${words(coin)} this top-up moves`);
      }
      const pinned = { assetId: coin.asset, decimals: coin.decimals };
      return {
        ok: true,
        summary: `Moves ${words(coin)} from your vault to your allowance. One Touch ID signs it with your vault's key, and the gas account sends it inside NEAR Intents.`,
        developer: `transfer ${coin.base} of ${coin.asset} from ${vault} to ${draft.to.toLowerCase()}, signed by the chip (webauthn), sent with execute_intents`,
        assets: { origin: pinned, destination: pinned },
      };
    } catch (err) {
      const reason = (err as { reason?: ReasonCode }).reason;
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, summary: `top-up simulation failed: ${message}`, error: message, ...(reason === undefined ? {} : { reason }) };
    }
  }

  async function execute(draft: VaultTopUpDraft, proposalId?: string, hooks?: RailHooks): Promise<RailResult> {
    const s = service();
    // A person's click and nothing else: the engine never allows a top-up, and neither does this rail.
    if (hooks?.decidedBy !== 'human') throw new ReasonError('needs_approval', 'a top-up from your vault runs only on your click; nothing was signed');
    if (proposalId === undefined) throw new ReasonError('invalid_request', 'a top-up runs as a proposal of its own; nothing was signed');
    const { vault, allowance } = accountsFor(s, draft);
    const coin = coinOf(draft);
    const before = await s.balance(allowance, coin.asset);
    const pocket = (after: bigint | null): PocketRead | undefined =>
      before === null
        ? undefined
        : { venue: 'intents', account: allowance, assetId: coin.asset, symbol: coin.symbol, decimals: coin.decimals, before: before.toString(), after: after === null ? null : after.toString(), floor: coin.base.toString() };

    const first = await s.topUp({ id: proposalId, coin, lastCheck: hooks?.lastCheck });
    const sentHash = first.state === 'sent' || first.state === 'checking' ? first.txHash : null;
    const left = first.state === 'sent' || first.state === 'checking' || (first.state === 'refused' && first.released);
    // A send left this Mac: the row carries its hash and the allowance's balance before it, so a
    // process that stops in the wait below is settled by that balance, never signed again.
    if (left) hooks?.onEvidence?.({ txids: sentHash === null ? [] : [sentHash], ...(pocket(null) === undefined ? {} : { pocket: pocket(null) }) });
    const result: VaultResult = left
      ? await s.awaitSettled({ id: proposalId, account: vault, balances: [{ account: vault, asset: coin.asset, amount: null }, { account: allowance, asset: coin.asset, amount: null }] }, first)
      : first;
    return railResult(result, coin, vault, allowance, pocket, sentHash, left);
  }

  return {
    kind: 'vault_top_up',
    valueUsd: (draft) => draft.amountUsd,
    simulate,
    execute,
  };
}

function railResult(result: VaultResult, coin: CoinAmount, vault: string, allowance: string, pocket: (after: bigint | null) => PocketRead | undefined, sentHash: string | null, left: boolean): RailResult {
  const what = `${words(coin)} from your vault ${vault} to your allowance ${allowance}`;
  switch (result.state) {
    case 'done': {
      const after = result.balances.find((b) => b.account === allowance)?.amount ?? null;
      const read = pocket(after);
      return {
        ok: true,
        detail: `moved ${what}; NEAR confirmed it at block ${result.block.hash} (${new Date(result.block.atMs).toISOString()})${result.gasBurnt === null ? '' : `, ${result.gasBurnt} gas burnt`}`,
        txids: result.txHash === null ? [] : [result.txHash],
        ...(read === undefined ? {} : { pocket: read }),
      };
    }
    case 'refused':
      if (result.released) return unsettled(`${result.code}: ${result.detail}`, what, sentHash, pocket, true);
      return { ok: false, reason: causeOf(result.code, result.detail), detail: `the top-up of ${what} did not go (${result.code}): ${result.detail}` };
    case 'settling':
      return left
        ? unsettled(result.detail, what, sentHash, pocket, true)
        : { ok: false, reason: 'not_sent', detail: `the top-up of ${what} was not signed (vault_settling): ${result.detail}` };
    case 'sent':
    case 'checking':
      return unsettled(result.detail, what, result.txHash ?? sentHash, pocket, true);
    case 'unknown':
    case 'mismatch':
      return { ...unsettled(result.detail, what, result.txHash ?? sentHash, pocket, false), reason: 'stuck_unknown' };
  }
}

/* A send that left with no final answer, or one that ran and does not read right: never failed,
   never signed again. The row waits on the allowance's balance (the pocket), and the journal holds
   every new vault signature back until NEAR has settled this one. */
function unsettled(detail: string, what: string, txHash: string | null, pocket: (after: bigint | null) => PocketRead | undefined, settling: boolean): RailResult {
  const read = pocket(null);
  return {
    ok: false,
    detail: `the top-up of ${what} was sent and NEAR has not settled it yet: ${detail}. Nothing will be signed again for it.`,
    txids: txHash === null ? [] : [txHash],
    ...(settling ? { settling: true } : {}),
    ...(read === undefined ? {} : { pocket: read }),
  };
}
