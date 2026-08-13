// The NEAR Intents withdrawal rail: a balance held inside intents.near leaves the verifier
// and lands in one of this app's own wallets on a real chain. The mirror of
// src/rails/intents-deposit.ts, and the last leg of deposit -> swap -> withdraw.
//
// WHY IT IS NOT THE intents-native SWAP RAIL WITH A DIFFERENT ARGUMENT. That rail keeps both
// legs inside the verifier and enforces it: requireVenue refuses a draft whose `from` and `to`
// differ, because "the destination stops existing" is the entire security claim in its header.
// A withdrawal is the case where a destination does exist, on a chain, chosen by us. Bolting a
// recipient onto that rail would put recipientType and a chain address on the swap tool
// surface and quietly retire the claim. A separate kind keeps the swap rail's promise literally
// true and puts this rail's weaker promise where it can be read.
//
// THE SEQUENCE, four steps, one signature, nothing sent on any chain by us:
//   1. POST /v0/quote, depositType INTENTS, recipientType DESTINATION_CHAIN -> a deposit handle
//   2. POST /v0/generate-intent -> an erc191 payload transferring our balance to that handle
//   3. check the payload, sign it with the EVM key, POST /v0/submit-intent
//   4. GET /v0/status until SUCCESS, REFUNDED or FAILED
// The solver takes the balance inside the verifier and pays out on the destination chain.
//
// WHAT IS DIFFERENT ABOUT THIS RAIL, AND IT IS THE WHOLE REASON TO READ THIS HEADER:
//
//   THE DESTINATION IS IN THE QUOTE, NOT IN THE SIGNATURE. The intent we sign says "give N of
//   this asset to the solver's handle" and says nothing at all about where the payout goes.
//   That is a real gap and it cannot be closed by reading the payload harder: the far side
//   simply is not in the bytes. What closes it instead is the quote echo. The API returns the
//   request it priced, verbatim, in `quoteRequest` (verified live 2026-08-13), so the recipient
//   and the recipient type we sent are checked against the draft in the same breath as the
//   amounts, on the dry quote at simulate time and again on the live quote a moment before the
//   key is touched. checkQuoteEcho() below is that check, and a missing echo is a refusal
//   rather than a shrug, because with no echo there is nothing tying the signature to a
//   destination at all.
//
//   THE DESTINATION IS AN ADDRESS THIS APP MAY HOLD NO KEY FOR. Every other rail delivers to
//   the signer, or to a contract on a verified deployment table. A withdrawal to Solana goes to
//   whatever config.local.json says our Solana wallet is, and the app cannot prove it holds
//   that key. That trust is not new: recipientFor() in src/proposals.ts already sends a
//   consolidation to the same string, and the ledger already reports its balance as ours. It
//   is stated here because this is the rail where a wrong entry is unrecoverable and immediate.
//   Three things narrow it: the address is never named by the caller (the MCP tool has no
//   address field, and tests/injection.test.ts holds that), the format is decoded rather than
//   pattern-matched so a truncated or transposed key is refused before any quote, and on the
//   EVM chains, where a key does exist, config must agree with it or the draft is refused.
//
//   NEAR IS NOT A DESTINATION. cfg.addresses.near carries an account id nobody signed for, and
//   the one in the repo's own config is a testnet id. Paying a mainnet withdrawal to it would
//   be a plain loss, so the chain is refused by name.
//
// THIS RAIL IS MAINNET ONLY, for the reason in src/rails/intents-native.ts: intents.testnet has
// never had code deployed, so there is no verifier holding a balance to withdraw.

import { formatUnits, getAddress, isAddress } from 'viem';
import type {
  AppConfig,
  ChainId,
  IntentsWithdrawDraft,
  Network,
  Rail,
  RailResult,
  SimulationResult,
} from '../types.ts';
import { ONECLICK_TERMINAL, oneLine, resolveAsset, toBaseUnits } from '../intents.ts';
import type { OneClickQuote, OneClickStatus, TokensFile } from '../intents.ts';
import {
  INTENTS_NO_TESTNET_REASON,
  INTENTS_SIGNING_STANDARD,
  INTENTS_VERIFIER,
  base58Decode,
  checkIntentPayload,
  intentsApi,
  liveIntentsSigner,
} from './intents-native.ts';
import type { IntentsApiPort, IntentsSignerPort } from './intents-native.ts';

// Same fixed account as the swap rail, and for the same reason: the funds are spent inside the
// verifier, so the counterparty is the verifier and not a per-quote address. One allowlist
// entry already covers both, which is what makes this rail usable under a policy a human
// approved before it existed.
export const INTENTS_WITHDRAW_COUNTERPARTY = INTENTS_VERIFIER;

// Chains a withdrawal may land on. NEAR is absent deliberately; see the header.
export const WITHDRAW_DESTINATIONS: ChainId[] = ['eth', 'base', 'arb', 'sol'];

// The chains where a configured address can be checked against the key rather than trusted.
const EVM_DESTINATIONS: ChainId[] = ['eth', 'base', 'arb'];

// A Solana public key is 32 bytes. Nothing else is.
const SOLANA_KEY_BYTES = 32;

// The most a withdrawal may lose between leaving the verifier and arriving in the wallet, in
// basis points of the amount withdrawn. A constant here and NOT an argument on the tool, for
// the reason DEPOSIT_MAX_LOSS_BPS gives: a tolerance an agent can widen is a tolerance an agent
// can set to 100%.
//
// 300bps rather than the deposit rail's 200, and the difference is not slack. A withdrawal pays
// a FLAT withdrawFee, so the loss in percentage terms depends on the size, which a deposit's
// proportional fee never did. Measured live 2026-08-13:
//   0.1 SOL   -> withdrawFee 138816 lamports, solver floor 1.24% under the input
//   0.002 ETH -> withdrawFee 0.000035 ETH,    solver floor 2.83% under the input
// The ETH number is a $0.066 fee on a $3.78 withdrawal. Both clear 300bps; a 200bps floor would
// have refused the ETH one for being honest.
//
// The consequence is deliberate and is the useful half of the constant: below roughly $2.50 of
// ETH the flat fee alone breaches 300bps and the rail refuses. A withdrawal that loses a
// twentieth of itself to fees should not quietly proceed, and the refusal says to withdraw more
// at once.
export const WITHDRAW_MAX_LOSS_BPS = 300;

// The least that may arrive for a given amount withdrawn. Exported so the proposal builder and
// the tests derive it the same way.
export function minReceivedFor(amount: number): number {
  return amount * (1 - WITHDRAW_MAX_LOSS_BPS / 10_000);
}

// Our own wallet on a chain, read from the address book and nowhere else. Returns null when the
// app has no address configured for that chain, which is a refusal and never a default.
export function ourWalletOn(chain: ChainId, addresses: AppConfig['addresses']): string | null {
  const book: Partial<Record<ChainId, string[]>> = {
    eth: addresses.evm,
    base: addresses.evm,
    arb: addresses.evm,
    sol: addresses.solana,
    near: addresses.near,
  };
  const first = (book[chain] ?? []).find((a) => a.trim() !== '');
  return first ?? null;
}

// Whether a string is an address of the shape this chain actually uses, decoded rather than
// matched. A regex over base58 characters accepts a Solana key with a digit dropped; decoding
// it and counting the bytes does not, and a dropped digit is a total loss.
//
// Returns the problem, or null when the address is well formed.
export function addressProblem(chain: ChainId, address: string): string | null {
  const trimmed = address.trim();
  if (trimmed === '') return `no address is configured for ${chain}`;

  if (EVM_DESTINATIONS.includes(chain)) {
    return isAddress(trimmed, { strict: false })
      ? null
      : `${oneLine(trimmed, 60)} is not an EVM address, so it cannot be our wallet on ${chain}`;
  }

  if (chain === 'sol') {
    const bytes = base58Decode(trimmed);
    if (bytes === null) return `${oneLine(trimmed, 60)} is not base58, so it cannot be a Solana address`;
    if (bytes.length !== SOLANA_KEY_BYTES) {
      return (
        `${oneLine(trimmed, 60)} decodes to ${bytes.length} bytes, not the ${SOLANA_KEY_BYTES} a Solana ` +
        'address is; a truncated or mistyped key would send this withdrawal nowhere it can be recovered from'
      );
    }
    return null;
  }

  return `${chain} is not a chain this rail can withdraw to`;
}

export type IntentsWithdrawRailDeps = {
  network: Network;
  keysPath: string;
  tokens: TokensFile;
  addresses: AppConfig['addresses'];
  apiKey?: string;
  signer?: IntentsSignerPort;
  api?: IntentsApiPort;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  now?: () => number;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  maxDeadlineMs?: number;
};

export type IntentsWithdrawRail = Rail<IntentsWithdrawDraft>;

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function baseUnits(value: unknown, field: string): bigint {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error(`1click quote is missing ${field}`);
  }
  try {
    return BigInt(value);
  } catch {
    throw new Error(`1click quote returned a non-integer ${field}: ${oneLine(value, 40)}`);
  }
}

export function intentsWithdrawRail(deps: IntentsWithdrawRailDeps): IntentsWithdrawRail {
  const { network, keysPath, tokens, addresses } = deps;
  const signer = deps.signer ?? liveIntentsSigner;
  const sleep = deps.sleepImpl ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const pollIntervalMs = deps.pollIntervalMs ?? 5_000;
  const pollTimeoutMs = deps.pollTimeoutMs ?? 5 * 60_000;
  // Four days, matching the swap rail. See MAX_DEADLINE_MS there for why the deadline is not
  // what prevents replay and the nonce is.
  const maxDeadlineMs = deps.maxDeadlineMs ?? 4 * 24 * 60 * 60 * 1000;
  const api = deps.api ?? intentsApi({ apiKey: deps.apiKey ?? '', fetchImpl: deps.fetchImpl });

  type Plan = {
    asset: string; // the 1Click asset id; the same one on both sides, since nothing is swapped
    decimals: number;
    amountBase: bigint;
    minReceivedBase: bigint;
    to: string; // our wallet, re-derived here rather than taken from the draft
  };

  function requireVenue(draft: IntentsWithdrawDraft): void {
    if (draft.counterparty !== INTENTS_WITHDRAW_COUNTERPARTY) {
      throw new Error(
        `intents withdraw drafts must name ${INTENTS_WITHDRAW_COUNTERPARTY} as the counterparty ` +
          `(got ${oneLine(draft.counterparty, 60)}); the verifier account is fixed and never comes from a quote`,
      );
    }
  }

  // The destination, resolved from this rail's own copy of the address book and compared
  // against what the draft says. The proposal service already resolves it the same way, so this
  // is the second of two independent derivations: a draft that reached the rail carrying any
  // other address, however it got there, is refused before a quote is asked for.
  function resolveDestination(draft: IntentsWithdrawDraft): string {
    if (!WITHDRAW_DESTINATIONS.includes(draft.chain)) {
      throw new Error(
        `this rail withdraws to ${WITHDRAW_DESTINATIONS.join(', ')} only, not ${draft.chain}. ` +
          'A NEAR payout would go to an account id nobody signed for, which is why it is excluded.',
      );
    }

    const configured = ourWalletOn(draft.chain, addresses);
    if (configured === null) {
      throw new Error(
        `no ${draft.chain} address is configured, so this app has no wallet of its own to withdraw to. ` +
          'Add one to config.local.json.',
      );
    }

    const problem = addressProblem(draft.chain, configured);
    if (problem !== null) throw new Error(`the configured ${draft.chain} address is unusable: ${problem}`);

    // EVM addresses compare case-insensitively because the checksum is presentational. A Solana
    // address does not: base58 case carries key material, and two strings differing only in case
    // are two different accounts.
    const same = EVM_DESTINATIONS.includes(draft.chain)
      ? draft.to.trim().toLowerCase() === configured.trim().toLowerCase()
      : draft.to.trim() === configured.trim();
    if (!same) {
      throw new Error(
        `the draft withdraws to ${oneLine(draft.to, 60)} but our configured ${draft.chain} wallet is ` +
          `${oneLine(configured, 60)}; this rail pays out to our own address and no other`,
      );
    }

    return configured.trim();
  }

  async function plan(draft: IntentsWithdrawDraft): Promise<Plan> {
    requireVenue(draft);
    const to = resolveDestination(draft);

    // resolveAsset, so the gas asset of a chain is nameable: inside the verifier a withdrawn
    // ETH is nep141:eth.omft.near and a SOL is nep141:sol.omft.near, and data/tokens.json has
    // no row for an asset with no contract address.
    const list = await api.tokens();
    const asset = resolveAsset(draft.chain, draft.symbol, tokens, list);

    return {
      asset: asset.assetId,
      decimals: asset.decimals,
      amountBase: toBaseUnits(draft.amount, asset.decimals),
      minReceivedBase: toBaseUnits(draft.minReceived, asset.decimals),
      to,
    };
  }

  // What the solver is promising. Run on the dry quote at simulate time and again on the live
  // quote at execute time, because the live quote is a different quote with a different fee.
  function checkQuote(draft: IntentsWithdrawDraft, p: Plan, quote: OneClickQuote): string[] {
    const problems: string[] = [];

    const amountIn = baseUnits(quote.amountIn, 'amountIn');
    if (amountIn !== p.amountBase) {
      problems.push(
        `the quote spends ${formatUnits(amountIn, p.decimals)} ${draft.symbol}, not the ${draft.amount} the draft names`,
      );
    }

    const minOut = baseUnits(quote.minAmountOut, 'minAmountOut');
    if (minOut < p.minReceivedBase) {
      // The flat withdrawFee is almost always why, and naming it turns "refused" into an
      // instruction: withdraw more at once and the same fee stops mattering.
      const fee =
        typeof quote.withdrawFee === 'string' && quote.withdrawFee !== ''
          ? `, of which ${formatUnits(baseUnits(quote.withdrawFee, 'withdrawFee'), p.decimals)} ${draft.symbol} is a flat withdrawal fee`
          : '';
      problems.push(
        `the solver would deliver as little as ${formatUnits(minOut, p.decimals)} ${draft.symbol}, below the ` +
          `${draft.minReceived} floor the draft names${fee}. That floor is ${WITHDRAW_MAX_LOSS_BPS / 100}% of the ` +
          'amount, so a withdrawal this small loses too much of itself; withdraw more at once.',
      );
    }

    return problems;
  }

  // The check that stands in for reading the destination out of the signed payload, because the
  // payload does not contain one. See the header.
  //
  // `raw` is the whole quote response. The API echoes the request it priced in `quoteRequest`,
  // so every field that decides where the money goes is compared against the draft here. A
  // missing echo is refused: without it the signature is tied to no destination at all.
  function checkQuoteEcho(draft: IntentsWithdrawDraft, p: Plan, raw: unknown): string[] {
    if (raw === null || typeof raw !== 'object') {
      return [`the quote response is not an object (got ${oneLine(raw, 60)})`];
    }
    const echo = (raw as Record<string, unknown>)['quoteRequest'];
    if (echo === null || typeof echo !== 'object' || Array.isArray(echo)) {
      return [
        'the quote carries no quoteRequest echo, so there is nothing tying it to the destination the draft ' +
          `names. The signed intent hands our balance to a solver handle and does not name ${oneLine(p.to, 60)} ` +
          'anywhere, so without the echo this withdrawal cannot be checked and is refused.',
      ];
    }
    const req = echo as Record<string, unknown>;
    const problems: string[] = [];

    const say = (field: string): string => oneLine(req[field], 60);

    // The two that decide where the payout lands. Exact string comparison, including case: the
    // recipient we sent was our configured address verbatim.
    if (req['recipient'] !== p.to) {
      problems.push(`the quote was priced to pay ${say('recipient')}, not our wallet ${oneLine(p.to, 60)}`);
    }
    if (req['recipientType'] !== 'DESTINATION_CHAIN') {
      problems.push(
        `the quote pays out as ${say('recipientType')}, not DESTINATION_CHAIN; a withdrawal that credits ` +
          'another intents balance instead of a wallet is not what was approved',
      );
    }

    // The input side. depositType INTENTS is what makes this spend the verifier balance rather
    // than expect a transfer from the wallet, and refundType INTENTS is what puts a failed
    // withdrawal back where it started instead of pushing it onto a chain by another route.
    if (req['depositType'] !== 'INTENTS') {
      problems.push(`the quote takes its input as ${say('depositType')}, not the INTENTS balance the draft spends`);
    }
    if (req['refundType'] !== 'INTENTS') {
      problems.push(`a refund on this quote goes to ${say('refundType')}, not back to our balance inside the verifier`);
    }
    if (typeof req['refundTo'] !== 'string' || (req['refundTo'] as string).toLowerCase() !== draft.from.toLowerCase()) {
      problems.push(`a refund on this quote goes to ${say('refundTo')}, not to our account ${draft.from}`);
    }

    // The asset and the size, checked here as well as in checkQuote so the echo is a complete
    // second opinion rather than a partial one.
    if (req['originAsset'] !== p.asset || req['destinationAsset'] !== p.asset) {
      problems.push(
        `the quote moves ${say('originAsset')} to ${say('destinationAsset')}, not the ${oneLine(p.asset, 60)} ` +
          'the draft withdraws on both sides',
      );
    }
    if (req['amount'] !== p.amountBase.toString()) {
      problems.push(`the quote was priced for ${say('amount')} base units, not the ${p.amountBase.toString()} approved`);
    }

    return problems;
  }

  function priceLines(draft: IntentsWithdrawDraft, p: Plan, quote: OneClickQuote): string[] {
    const inUsd = Number(quote.amountInUsd);
    const outUsd = Number(quote.amountOutUsd);
    const feeUsd = Number.isFinite(inUsd) && Number.isFinite(outUsd) ? inUsd - outUsd : NaN;
    return [
      `intents withdraw: ${draft.amount} ${draft.symbol} held inside ${INTENTS_VERIFIER} -> ` +
        `${oneLine(quote.amountOutFormatted, 40)} ${draft.symbol} to our ${draft.chain} wallet ${p.to}`,
      `fee ${Number.isFinite(feeUsd) ? '$' + feeUsd.toFixed(4) : 'unknown'}, eta ~${Number(quote.timeEstimate)}s, ` +
        `solver floor ${oneLine(quote.minAmountOut, 40)} base units, draft floor ${draft.minReceived} ${draft.symbol}`,
    ];
  }

  function valueUsd(draft: IntentsWithdrawDraft): number {
    return Number.isFinite(draft.amountUsd) ? draft.amountUsd : Infinity;
  }

  // The account id we spend inside the verifier, which is the EVM address lowercased. Read from
  // the key, never from the draft, and compared against the draft rather than the other way
  // round: a draft authored for another account would sign an intent that spends nothing and
  // release a signature for no reason.
  function requireOwner(draft: IntentsWithdrawDraft): string {
    const owner = signer.address(keysPath).toLowerCase();
    if (draft.from.toLowerCase() !== owner) {
      throw new Error(`draft spends the balance of ${draft.from} but the configured key is ${owner}`);
    }
    return owner;
  }

  // On an EVM chain the configured wallet is checkable against the key, so it is checked. This
  // is the difference between an eth withdrawal and a sol one, and it is worth being explicit
  // that only one of them has this backstop.
  function requireEvmDestinationIsOurs(draft: IntentsWithdrawDraft, p: Plan, owner: string): void {
    if (!EVM_DESTINATIONS.includes(draft.chain)) return;
    if (getAddress(p.to).toLowerCase() !== owner) {
      throw new Error(
        `the configured ${draft.chain} wallet ${p.to} is not the address this app holds the key for (${owner}); ` +
          'on an EVM chain the two must agree or the withdrawal is paid to somebody else',
      );
    }
  }

  async function simulate(draft: IntentsWithdrawDraft): Promise<SimulationResult> {
    try {
      const p = await plan(draft);
      const owner = requireOwner(draft);
      requireEvmDestinationIsOurs(draft, p, owner);

      const response = await api.quote({
        dry: true,
        originAsset: p.asset,
        destinationAsset: p.asset, // a withdrawal does not change the asset
        amount: p.amountBase.toString(),
        account: owner,
        recipient: p.to,
        recipientType: 'DESTINATION_CHAIN',
      });

      const lines = priceLines(draft, p, response.quote);
      const problems = [
        ...checkQuote(draft, p, response.quote),
        ...checkQuoteEcho(draft, p, response.raw),
      ];
      if (problems.length > 0) {
        const joined = problems.join('; ');
        return { ok: false, summary: [`REFUSED: ${joined}`, ...lines].join('\n'), error: joined };
      }

      if (network !== 'mainnet') {
        return {
          ok: false,
          summary: [`CANNOT EXECUTE on ${network}: ${INTENTS_NO_TESTNET_REASON}`, ...lines].join('\n'),
          error: INTENTS_NO_TESTNET_REASON,
        };
      }

      lines.push(
        `execution signs one intent with the EVM key and sends nothing on any chain; the solver pays out on ${draft.chain}`,
      );
      lines.push(
        EVM_DESTINATIONS.includes(draft.chain)
          ? `the destination is the address this app holds the key for, checked against it`
          : `the destination comes from config.local.json and this app holds NO ${draft.chain} key to check it ` +
            `against: approving this vouches for ${p.to} being your wallet`,
      );
      return { ok: true, summary: lines.join('\n') };
    } catch (err) {
      const message = errText(err);
      return { ok: false, summary: `intents withdraw simulation failed: ${message}`, error: message };
    }
  }

  async function execute(draft: IntentsWithdrawDraft): Promise<RailResult> {
    // First line, before any network call and any key read. No verifier on testnet means no
    // balance to withdraw.
    if (network !== 'mainnet') throw new Error(INTENTS_NO_TESTNET_REASON);

    const p = await plan(draft);
    const owner = requireOwner(draft);
    requireEvmDestinationIsOurs(draft, p, owner);

    const response = await api.quote({
      dry: false,
      originAsset: p.asset,
      destinationAsset: p.asset,
      amount: p.amountBase.toString(),
      account: owner,
      recipient: p.to,
      recipientType: 'DESTINATION_CHAIN',
    });
    const quote = response.quote;

    const problems = [...checkQuote(draft, p, quote), ...checkQuoteEcho(draft, p, response.raw)];
    if (problems.length > 0) throw new Error(`live quote does not match the approved draft: ${problems.join('; ')}`);

    // For an INTENTS deposit type this is a handle inside the verifier rather than a chain
    // address, and nothing is ever sent to it. It ties the signed intent back to this quote,
    // which is what binds the signature to the destination checked above.
    const depositAddress = quote.depositAddress;
    if (typeof depositAddress !== 'string' || depositAddress.trim() === '') {
      throw new Error(`the quote carries no deposit handle to attach an intent to (got ${oneLine(depositAddress, 60)})`);
    }

    const generated = await api.generateIntent({ signerId: owner, depositAddress });

    if (generated.standard !== INTENTS_SIGNING_STANDARD) {
      throw new Error(
        `generate-intent returned a ${oneLine(generated.standard, 40)} payload, but this rail signs ` +
          `${INTENTS_SIGNING_STANDARD} only`,
      );
    }

    // The same reader the swap rail uses. A withdrawal comes back as a 'transfer' to the deposit
    // handle, which that reader binds to our own quote. originAsset and destinationAsset are the
    // same id here because nothing is swapped; the token_diff branch cannot be satisfied by one
    // entry that must be both negative and above a floor, so a payload of that shape is refused
    // rather than misread.
    const payloadProblems = checkIntentPayload(generated.payload, {
      signerId: owner,
      originAsset: p.asset,
      destinationAsset: p.asset,
      amountBase: p.amountBase,
      minOutBase: p.minReceivedBase,
      now: now(),
      maxDeadlineMs,
      depositAddress,
    });
    if (payloadProblems.length > 0) {
      throw new Error(`refusing to sign the intent 1click generated: ${payloadProblems.join('; ')}`);
    }

    // Signed exactly as returned: the signature has to cover the same bytes the verifier will
    // parse, so the payload string is never re-serialised.
    const payload = generated.payload as string;
    const signature = await signer.signErc191(keysPath, payload);

    const submitted = await api.submitIntent({ payload, signature });
    const evidence = `intent ${submitted.intentHash}, quote handle ${oneLine(depositAddress, 80)}`;

    const watch = await watchStatus(depositAddress);

    if (watch.status === 'SUCCESS') {
      return {
        ok: true,
        detail:
          `withdrew ${draft.amount} ${draft.symbol} from ${INTENTS_VERIFIER}; ` +
          `${oneLine(quote.amountOutFormatted, 40)} ${draft.symbol} paid out to our ${draft.chain} wallet ${p.to}; ` +
          `${evidence}. The balance inside the verifier is now smaller by that amount.`,
        txids: [submitted.intentHash, ...watch.destinationTxHashes],
      };
    }

    if (watch.status === 'REFUNDED' || watch.status === 'FAILED') {
      return {
        ok: false,
        detail:
          `1click reported ${watch.reported} after the intent was submitted; ${evidence}. ` +
          `A refund is credited back to ${owner} inside ${INTENTS_VERIFIER}, which is where the balance started.`,
        txids: [submitted.intentHash, ...watch.originTxHashes, ...watch.destinationTxHashes],
      };
    }

    // Timed out. The signature is released and the intent submitted, so the balance may well
    // move after this returns. Saying "failed" without that sentence is how someone signs a
    // second withdrawal for money that is already on its way.
    return {
      ok: false,
      detail:
        `the intent was submitted but 1click did not reach a terminal status within ` +
        `${Math.round(pollTimeoutMs / 1000)}s (last status ${watch.reported}); ${evidence}. ` +
        `THE INTENT IS SIGNED AND SUBMITTED and the payout may still land: check the ${draft.chain} wallet ` +
        `${p.to} and the balance inside ${INTENTS_VERIFIER} before signing another.`,
      txids: [submitted.intentHash],
    };
  }

  // Polls until terminal, out of attempts, or out of time. Never throws once the intent has
  // been submitted: a status endpoint that goes down after the money has moved must not become
  // an unhandled rejection.
  async function watchStatus(depositAddress: string): Promise<OneClickStatus> {
    const deadline = now() + pollTimeoutMs;
    const maxPolls = Math.max(1, Math.ceil(pollTimeoutMs / pollIntervalMs));
    let last: OneClickStatus = {
      found: false,
      status: 'PENDING_DEPOSIT',
      reported: 'not polled',
      originTxHashes: [],
      destinationTxHashes: [],
    };

    for (let attempt = 0; attempt < maxPolls; attempt += 1) {
      try {
        last = await api.status(depositAddress);
        if ((ONECLICK_TERMINAL as readonly string[]).includes(last.status)) return last;
      } catch (err) {
        last = { ...last, reported: `status check failed: ${oneLine(errText(err), 80)}` };
      }
      if (now() >= deadline) break;
      await sleep(pollIntervalMs);
    }

    return last;
  }

  return { kind: 'intents_withdraw', valueUsd, simulate, execute };
}
