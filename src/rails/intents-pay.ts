// The NEAR Intents pay rail: a balance held inside intents.near paid out to an address on a
// real chain. A friend's wallet on Ethereum, a Solana account, our own wallet on Base.
//
// WHY IT EXISTS. Karim, 2026-09-16: "if I want to send eth that I have on near intents to a
// friend's wallet on eth mainnet, it should be able to do that. not over near intents, but
// genuinely on eth mainnet chain." Until this rail the only way out of the verifier to a chain
// was the withdraw rail, and that rail's whole claim was "our own wallet, re-derived from the
// key, and no other". This is the rail where the destination is somebody else's.
//
// THE FENCE, four parts, none of them optional:
//
//   1. THE ADDRESS IS DECODED, NOT MATCHED. src/chainscan validateAddress: an EVM address has to
//      be 40 hex and, when it carries capitals, pass its own EIP-55 checksum; a Solana address
//      has to decode to exactly 32 bytes; a NEAR id has to be one. A dropped digit is a total
//      loss on a chain, so a dropped digit is a refusal before any quote.
//
//   2. IT ALWAYS WAITS FOR A CLICK AND A TOUCH ID THAT NAMES THE RECEIVER, whatever the size
//      (src/proposals/execute.ts land(), src/vault/reason.ts). There is no allowlist for a
//      receiver since 2026-09-17: the gate is the card and the dialog, both of which show the
//      full address and the chain.
//
//   3. THE RECIPIENT IS IN THE QUOTE ECHO, checked on the dry quote at simulate time and again
//      on the live quote a moment before the key is touched. The signed intent hands the balance
//      to the solver's handle and says nothing about the far side; the echo is the only thing
//      tying the signature to the address and the chain the draft names. No echo, no signature.
//
//   4. THE CHAIN IS ASKED ABOUT THE ADDRESS FIRST. The builder reads the address's public
//      activity (transaction count, balance, whether it is a contract) and the card and the
//      summary say it: "never used on Ethereum, check it twice" is the sentence that catches a
//      pasted address that lost a character but still decodes. A contract cannot be paid the
//      chain's own coin at all (a contract without a receive path burns it).
//
// WHAT MOVES. The same symbol, out of the verifier and onto the chain: the flavor held (which
// bridged asset the balance arrived as) is spent, and the asset that is `symbol` on `network`
// is what the receiver gets. When those two are the same 1Click id it is a pure withdrawal
// through the POA or Omni bridge; when they differ (USDC that arrived from Ethereum, paid out
// on Base) 1Click swaps and pays out in one quote. Either way the four shared steps are
// src/rails/intents-spend.ts. The bridge charges a FLAT withdrawFee on top of the solver's
// percentage, which is why the floor is 300 bps and why the flat fee is named in every
// refusal and summary.
//
// THE PROOF IS THE PAYOUT HASH. 1Click reports the destination chain transaction on SUCCESS,
// and the receipt carries it with its explorer link. The receiver's holdings are read before
// and after as a second opinion when the chain answers; the hash is the proof either way.

import { formatUnits } from 'viem';
import type { IntentsPayDraft, Rail, RailHooks, RailResult, SendRecipient, SendSimulation, SimulationResult, ChainId } from '../types.ts';
import { baseUnits, oneLine, quoteEchoProblems, resolveAsset, toBaseUnits } from '../intents.ts';
import type { OneClickClient, OneClickQuote, OneClickToken, QuoteEcho, TokensFile } from '../intents.ts';
import { INTENTS_VERIFIER, intentsApi, liveIntentsSigner } from './intents-native.ts';
import type { IntentsApiPort, IntentsSignerPort } from './intents-native.ts';
import { spendFromIntents } from './intents-spend.ts';
import type { PreflightRunner } from '../preflight/live.ts';
import { describeHeld, deliveredAmount, deliveredNote, describeIncompleteDeposit, describeRefund, describeUnconfirmedSubmit, settledEvidence, uniqueTxids, withQuote } from './oneclick-words.ts';
import { NETWORKS, addressSummary, createChainFetchState, explorerAddressUrl, explorerTxUrl, validateAddress } from '../chainscan/index.ts';
import type { AddressSummary, ChainNetwork } from '../chainscan/index.ts';
import { pickOrExplain } from './asset-words.ts';

// The funds are spent inside the verifier, so the counterparty is the verifier: the same
// allowlist entry the swap, send and HyperCore rails use.
export const INTENTS_PAY_COUNTERPARTY = INTENTS_VERIFIER;

// The most a payout may lose between leaving our balance and landing on the chain, in basis
// points. A constant and not a tool argument, for the reason every rail gives. 300 rather than
// the send rail's 100 because a chain payout pays a FLAT bridge fee, so the loss in percentage
// terms depends on the size (measured 2026-09-17: 0.000035 ETH on Ethereum, 0.0024 USDC on
// Base). Below roughly $2.50 of ETH the flat fee alone breaches this and the rail refuses,
// naming the fee, which is the useful half of the constant: a payout that loses a twentieth of
// itself to fees should not quietly proceed.
export const PAY_MAX_LOSS_BPS = 300;

// The tolerance asked for on a pure withdrawal (the same 1Click id in and out): nothing is
// swapped, so nothing can slip, and the default 100 bps would only push the guarantee down.
// A real cross-chain pair keeps the API default.
export const PAY_SAME_ASSET_SLIPPAGE_BPS = 10;

export function minReceivedForPay(amount: number): number {
  return amount * (1 - PAY_MAX_LOSS_BPS / 10_000);
}

// The chain id the token registry and the gas-asset table know a payout network by. Bitcoin
// is a network this app can look up and not one it can pay: the registry has no row for it,
// and a payout without a table behind the asset id would be matching remote text.
export function networkChain(network: ChainNetwork): ChainId | null {
  switch (network) {
    case 'ethereum':
      return 'eth';
    case 'base':
      return 'base';
    case 'arbitrum':
      return 'arb';
    case 'solana':
      return 'sol';
    case 'near':
      return 'near';
    case 'bitcoin':
      return null;
  }
}

// A chain balance as a person reads it: the explorer's eighteen decimals say nothing a card
// needs. Four places above one, six below, and the raw string when it is not a number.
function roundAmount(raw: string): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  return n.toLocaleString('en-US', { maximumFractionDigits: Math.abs(n) >= 1 ? 4 : 6 });
}

/* The one sentence about the receiver, from what the chain said at propose time. Plain
   English, one fact per clause, and a fresh address is told to check twice: that is the
   sentence that catches a pasted address which lost a character but still decodes. */
export function recipientSentence(network: ChainNetwork, recipient: SendRecipient): string {
  const label = NETWORKS[network].label;
  const own = recipient.ownAddress ? `This is your own address on ${label}. ` : '';
  const a = recipient.activity;
  if (a === null || a.network !== network) return `${own}This address could not be checked on ${label} right now.`.trim();
  if (!a.ok || a.txCount === null) {
    return `${own}This address could not be checked on ${label}${a.error ? ` (${oneLine(a.error, 80)})` : ''}.`.trim();
  }
  const holds = a.balance === null ? null : `holds ${roundAmount(a.balance.amount)} ${a.balance.symbol}`;
  if (a.isContract === true) {
    return `${own}This address is a contract on ${label} with ${a.txCount} transactions${holds === null ? '' : `; it ${holds}`}.`.trim();
  }
  if (a.txCount === 0 && (a.balance === null || Number(a.balance.amount) === 0)) {
    return `${own}This address has never been used on ${label}. Check it twice.`.trim();
  }
  return `${own}This address has ${a.txCount} transaction${a.txCount === 1 ? '' : 's'} on ${label}${holds === null ? '' : ` and ${holds}`}.`.trim();
}

export type IntentsPayRailDeps = {
  keysPath: string;
  tokens: TokensFile; // data/tokens.json, the registry the destination asset is resolved from
  apiKey?: string;
  signer?: IntentsSignerPort;
  api?: IntentsApiPort;
  client?: OneClickClient; // the registry's shared 1Click client, so the token list is fetched once
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  now?: () => number;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  maxDeadlineMs?: number;
  quoteKey?: string;
  // The receiver's holdings on the chain, read before the quote and after the payout. Defaults
  // to the chainscan read on a fresh cache, so the after-read is not the before-read served
  // twice; a test hands in its own. A failed read is null, never a throw.
  receiverRead?: (network: ChainNetwork, address: string) => Promise<AddressSummary | null>;
  // The checks run on the live quote before the intent is generated (src/preflight/). The
  // registry wires the live one; absent means none, which is the tests of the rail itself.
  preflight?: PreflightRunner;
};

export type IntentsPayRail = Rail<IntentsPayDraft>;

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

export function intentsPayRail(deps: IntentsPayRailDeps): IntentsPayRail {
  const { keysPath, tokens } = deps;
  const signer = deps.signer ?? liveIntentsSigner;
  const sleep = deps.sleepImpl ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const pollIntervalMs = deps.pollIntervalMs ?? 5_000;
  const pollTimeoutMs = deps.pollTimeoutMs ?? 5 * 60_000;
  const maxDeadlineMs = deps.maxDeadlineMs ?? 4 * 24 * 60 * 60 * 1000;
  const api = deps.api ?? intentsApi({ apiKey: deps.apiKey ?? '', fetchImpl: deps.fetchImpl, client: deps.client });
  const fetchImpl = deps.fetchImpl ?? fetch;
  const receiverRead =
    deps.receiverRead ??
    ((network: ChainNetwork, address: string) =>
      addressSummary(network, address, { fetchImpl, state: createChainFetchState() }).catch(() => null));

  type Plan = {
    chain: ChainId;
    originAsset: string; // the 1Click id spent, the flavor held
    destinationAsset: string; // the 1Click id the receiver is paid in
    native: boolean; // the destination is the chain's own coin
    tokenId: string | null; // the destination token's contract or mint, for the balance read
    decimals: number;
    amountBase: bigint;
    minReceivedBase: bigint;
    to: string; // the receiver as the chain spells it, decoded here rather than trusted
    slippageBps: number | undefined;
  };

  function requireVenue(draft: IntentsPayDraft): void {
    if (draft.counterparty !== INTENTS_PAY_COUNTERPARTY) {
      throw new Error(
        `intents pay drafts must name ${INTENTS_PAY_COUNTERPARTY} as the counterparty ` +
          `(got ${oneLine(draft.counterparty, 60)}); the verifier account is fixed and never comes from a quote`,
      );
    }
  }

  // The account whose balance is spent, read from the key and compared against the draft.
  function requireOwner(draft: IntentsPayDraft): string {
    const owner = signer.address(keysPath).toLowerCase();
    if (draft.from.toLowerCase() !== owner) {
      throw new Error(`draft spends the balance of ${draft.from} but the configured key is ${owner}`);
    }
    return owner;
  }

  function requireChain(draft: IntentsPayDraft): ChainId {
    const chain = networkChain(draft.network);
    if (chain === null) {
      throw new Error(`${NETWORKS[draft.network].label} is not a network this rail pays out on yet: there is no token table behind it`);
    }
    return chain;
  }

  // The receiver, decoded again here rather than trusted. Our own address is allowed (that is
  // what a withdrawal to our wallet is now) and the summary says so.
  function requireReceiver(draft: IntentsPayDraft): string {
    const checked = validateAddress(draft.network, draft.to);
    if (!checked.ok) throw new Error(`the receiving address is unusable: ${checked.reason}`);
    return checked.normalized;
  }

  function findHeld(list: OneClickToken[], draft: IntentsPayDraft): OneClickToken {
    const asset = list.find((t) => t.assetId === draft.originAsset);
    if (asset === undefined) {
      throw new Error(`1click does not list ${oneLine(draft.originAsset, 60)}, the ${draft.symbol} flavor the draft spends`);
    }
    if (asset.symbol.toUpperCase() !== draft.symbol.toUpperCase()) {
      throw new Error(`${oneLine(draft.originAsset, 60)} is ${asset.symbol} on the 1click list, not the ${draft.symbol} the draft names`);
    }
    return asset;
  }

  // A contract cannot be paid the chain's coin: without a receive path the coin is burned, and
  // the bridge's payout does not revert for us. A token payout to a contract (a Safe, say) is
  // allowed and the summary says it is a contract.
  function refuseContractForNative(draft: IntentsPayDraft, native: boolean): void {
    const a = draft.recipient.activity;
    if (native && a !== null && a.network === draft.network && a.isContract === true) {
      throw new Error(
        `${draft.to} is a contract on ${NETWORKS[draft.network].label}, and ${draft.symbol} sent to a contract ` +
          'that cannot receive it is lost; pay a wallet, or a token the contract can hold',
      );
    }
  }

  async function plan(draft: IntentsPayDraft): Promise<Plan> {
    requireVenue(draft);
    const chain = requireChain(draft);
    const to = requireReceiver(draft);
    const list = await api.tokens();
    const held = findHeld(list, draft);
    const destination = pickOrExplain(
      resolveAsset(chain, draft.symbol.toUpperCase(), tokens, list),
      draft.symbol,
      chain,
    );
    if (destination.decimals !== held.decimals) {
      throw new Error(
        `${draft.symbol} has ${held.decimals} decimals inside the verifier and ${destination.decimals} on ${NETWORKS[draft.network].label}; ` +
          'the amount would be wrong by a power of ten, so nothing is quoted',
      );
    }
    refuseContractForNative(draft, destination.native);
    return {
      chain,
      originAsset: held.assetId,
      destinationAsset: destination.assetId,
      native: destination.native,
      tokenId: destination.native ? null : (tokens[chain]?.[draft.symbol.toUpperCase()]?.tokenId ?? null),
      decimals: held.decimals,
      amountBase: toBaseUnits(draft.amount, held.decimals),
      minReceivedBase: toBaseUnits(draft.minReceived, destination.decimals),
      to,
      slippageBps: held.assetId === destination.assetId ? PAY_SAME_ASSET_SLIPPAGE_BPS : undefined,
    };
  }

  function units(value: bigint, decimals: number): string {
    return formatUnits(value, decimals);
  }

  function flatFee(quote: OneClickQuote, p: Plan): string | null {
    if (typeof quote.withdrawFee !== 'string' || quote.withdrawFee === '') return null;
    const fee = baseUnits(quote.withdrawFee, 'withdrawFee');
    return fee > 0n ? units(fee, p.decimals) : null;
  }

  // What the solver is promising. Run on the dry quote at simulate time and again on the live
  // quote at execute time, because the live quote is a different quote with a different fee.
  function checkQuote(draft: IntentsPayDraft, p: Plan, quote: OneClickQuote): string[] {
    const problems: string[] = [];
    const amountIn = baseUnits(quote.amountIn, 'amountIn');
    if (amountIn !== p.amountBase) {
      problems.push(`the quote spends ${units(amountIn, p.decimals)} ${draft.symbol}, not the ${draft.amount} the draft names`);
    }
    const minOut = baseUnits(quote.minAmountOut, 'minAmountOut');
    if (minOut < p.minReceivedBase) {
      // The flat bridge fee is almost always why, and naming it turns "refused" into an
      // instruction: send more at once and the same fee stops mattering.
      const fee = flatFee(quote, p);
      problems.push(
        `the solver would deliver as little as ${units(minOut, p.decimals)} ${draft.symbol}, below the ` +
          `${units(p.minReceivedBase, p.decimals)} floor the draft names${fee === null ? '' : `, of which ${fee} ${draft.symbol} is a flat bridge fee`}. ` +
          `That floor is ${PAY_MAX_LOSS_BPS / 100}% of the amount, so a payout this small loses too much of itself; send more at once.`,
      );
    }
    return problems;
  }

  function echoWant(draft: IntentsPayDraft, p: Plan): QuoteEcho {
    const label = NETWORKS[draft.network].label;
    return {
      recipient: p.to,
      recipientVerb: 'pay',
      recipientNoun: 'named receiver',
      recipientType: 'DESTINATION_CHAIN',
      recipientTypeWhy: `a quote that credits an intents balance instead of paying a wallet on ${label} is not what was approved`,
      depositType: 'INTENTS',
      refundType: 'INTENTS',
      refundTypeWhy: 'back to our balance inside the verifier',
      refundTo: draft.from,
      originAsset: p.originAsset,
      destinationAsset: p.destinationAsset,
      amount: p.amountBase.toString(),
      noEcho:
        `there is nothing tying it to the address the draft names. The signed intent hands our balance to a solver handle ` +
        `and does not name ${oneLine(p.to, 60)} or ${label} anywhere, so without the echo this payout cannot be checked and is refused.`,
    };
  }

  function feeUsdOf(quote: OneClickQuote): number | null {
    const inUsd = Number(quote.amountInUsd);
    const outUsd = Number(quote.amountOutUsd);
    return Number.isFinite(inUsd) && Number.isFinite(outUsd) ? round4(inUsd - outUsd) : null;
  }

  function priceLines(draft: IntentsPayDraft, p: Plan, quote: OneClickQuote): string[] {
    const label = NETWORKS[draft.network].label;
    const feeUsd = feeUsdOf(quote);
    const fee = flatFee(quote, p);
    return [
      `intents pay: ${draft.amount} ${draft.symbol} held inside ${INTENTS_VERIFIER} by ${draft.from} -> ` +
        `${oneLine(quote.amountOutFormatted, 40)} ${draft.symbol} paid out to ${p.to} on ${label}` +
        (p.originAsset === p.destinationAsset ? '' : ` (swapped from the ${oneLine(p.originAsset, 40)} flavor on the way)`),
      `fee ${feeUsd === null ? 'unknown' : '$' + feeUsd.toFixed(4)}${fee === null ? '' : `, of which ${fee} ${draft.symbol} is the bridge's flat fee`}, ` +
        `eta ~${Number(quote.timeEstimate)}s, solver floor ${units(baseUnits(quote.minAmountOut, 'minAmountOut'), p.decimals)} ${draft.symbol}, ` +
        `draft floor ${units(p.minReceivedBase, p.decimals)} ${draft.symbol}`,
    ];
  }

  function sendFacts(draft: IntentsPayDraft, p: Plan, quote: OneClickQuote): SendSimulation {
    return {
      destinationAsset: p.destinationAsset,
      arrives: oneLine(quote.amountOutFormatted, 40),
      arrivesAtLeast: units(baseUnits(quote.minAmountOut, 'minAmountOut'), p.decimals),
      feeUsd: feeUsdOf(quote),
      bridgeFee: flatFee(quote, p),
      etaSeconds: Number.isFinite(Number(quote.timeEstimate)) ? Number(quote.timeEstimate) : null,
      activity: recipientSentence(draft.network, draft.recipient),
      explorer: explorerAddressUrl(draft.network, p.to),
    };
  }

  // 1Click refuses an amount the bridge floor eats with "try at least N" in base units. Said
  // in the asset, on the chain, so the instruction is one a person can act on.
  function floorWords(draft: IntentsPayDraft, p: Plan, message: string): string | null {
    const m = /try at least (\d+)/.exec(message);
    if (m === null) return null;
    return (
      `1Click's bridge will not pay out less than ${units(BigInt(m[1]), p.decimals)} ${draft.symbol} on ${NETWORKS[draft.network].label} ` +
      '(its flat fee grossed up); send at least that, and more to keep the fee small against the amount'
    );
  }

  function valueUsd(draft: IntentsPayDraft): number {
    return Number.isFinite(draft.amountUsd) ? draft.amountUsd : Infinity;
  }

  async function simulate(draft: IntentsPayDraft): Promise<SimulationResult> {
    let p: Plan;
    let owner: string;
    try {
      p = await plan(draft);
      owner = requireOwner(draft);
    } catch (err) {
      const message = errText(err);
      return { ok: false, summary: `intents pay simulation failed: ${message}`, error: message };
    }
    try {
      const response = await api.quote({
        dry: true,
        originAsset: p.originAsset,
        destinationAsset: p.destinationAsset,
        amount: p.amountBase.toString(),
        account: owner,
        recipient: p.to,
        recipientType: 'DESTINATION_CHAIN',
        ...(p.slippageBps === undefined ? {} : { slippageToleranceBps: p.slippageBps }),
      });
      const lines = priceLines(draft, p, response.quote);
      const send = sendFacts(draft, p, response.quote);
      lines.push(send.activity);
      const problems = [...checkQuote(draft, p, response.quote), ...quoteEchoProblems(response.raw, echoWant(draft, p))];
      if (problems.length > 0) {
        const joined = problems.join('; ');
        return { ok: false, summary: [`REFUSED: ${joined}`, ...lines].join('\n'), error: joined, send };
      }
      lines.push(
        `execution signs one intent with the EVM key; 1Click's bridge pays out on ${NETWORKS[draft.network].label}, ` +
          `and if it cannot, the money comes back to your balance inside ${INTENTS_VERIFIER}`,
      );
      lines.push('this payout always waits for your click and, on an enclave wallet, a Touch ID that names the receiver');
      return { ok: true, summary: lines.join('\n'), send };
    } catch (err) {
      const message = errText(err);
      const floor = floorWords(draft, p, message);
      return { ok: false, summary: `intents pay simulation failed: ${floor ?? message}`, error: floor ?? message };
    }
  }

  // The receiver's holding of the paid asset as the chain read answered it, formatted, or null.
  function holdingOf(read: AddressSummary | null, p: Plan): string | null {
    if (read === null || !read.ok) return null;
    if (p.native) return read.balance?.amount ?? null;
    if (p.tokenId === null) return null;
    const want = p.tokenId.toLowerCase();
    const row = read.tokens.find((t) => (t.contract ?? '').toLowerCase() === want);
    return row === undefined ? '0' : row.amount;
  }

  async function execute(draft: IntentsPayDraft, _proposalId?: string, hooks?: RailHooks): Promise<RailResult> {
    const p = await plan(draft);
    const owner = requireOwner(draft);
    const label = NETWORKS[draft.network].label;
    const before = await receiverRead(draft.network, p.to);

    // The four shared steps: live quote, echo check, generated intent checked and signed,
    // submitted and watched. Every refusal before the signature throws out of here; after it
    // nothing does, and a submit that did not answer comes back as signed and unsubmitted.
    const preflight = deps.preflight;
    const spent = await spendFromIntents(
      {
        api,
        signer,
        keysPath,
        now,
        sleep,
        pollIntervalMs,
        pollTimeoutMs,
        maxDeadlineMs,
        quoteKey: deps.quoteKey,
        ...(preflight === undefined ? {} : { preflight: (quote, port) => preflight.run('intents_pay', draft, quote, port) }),
      },
      {
        owner,
        originAsset: p.originAsset,
        destinationAsset: p.destinationAsset,
        amountBase: p.amountBase,
        minOutBase: p.minReceivedBase,
        recipient: p.to,
        recipientType: 'DESTINATION_CHAIN',
        ...(p.slippageBps === undefined ? {} : { slippageToleranceBps: p.slippageBps }),
        echo: echoWant(draft, p),
        checkQuote: (quote) => checkQuote(draft, p, quote),
      },
      hooks,
    );
    if (!spent.signed) return describeHeld(spent.preflight);
    if (!spent.submitted) {
      return withQuote(describeUnconfirmedSubmit({ error: spent.error, handle: spent.depositAddress, deadline: spent.deadline }), spent.signedQuote);
    }
    const { quote, depositAddress, watch, signedQuote } = spent;
    const evidence = `intent ${spent.intentHash}, quote handle ${oneLine(depositAddress, 80)}`;

    if (watch.status === 'SUCCESS') {
      const after = await receiverRead(draft.network, p.to);
      const was = holdingOf(before, p);
      const is = holdingOf(after, p);
      const balanceWords =
        was === null || is === null
          ? `the receiver's ${draft.symbol} balance was not read back, so the payout hash is the proof`
          : `the receiver's ${draft.symbol} balance ${was} -> ${is}`;
      const hash = watch.destinationTxHashes[0];
      const explorer = hash === undefined ? null : explorerTxUrl(draft.network, hash);
      const payoutWords =
        hash === undefined
          ? `1click reported SUCCESS with no payout hash yet: look for it at ${explorerAddressUrl(draft.network, p.to) ?? p.to}`
          : `payout ${hash}${explorer === null ? '' : ` (${explorer})`}`;
      return {
        ok: true,
        detail:
          `paid ${draft.amount} ${draft.symbol} from ${INTENTS_VERIFIER} to ${p.to} on ${label}; ` +
          `${deliveredAmount(watch, quote.amountOutFormatted)} ${draft.symbol} arrived (${deliveredNote(watch)}); ${payoutWords}; ` +
          `${balanceWords}; ${evidence}. The balance inside the verifier is now smaller by ${draft.amount} ${draft.symbol}.`,
        txids: uniqueTxids(spent.intentHash, watch),
        evidence: { ...settledEvidence(watch, depositAddress), ...(explorer === null ? {} : { explorerUrl: explorer }), quote: signedQuote },
      };
    }

    if (watch.status === 'REFUNDED' || watch.status === 'FAILED') {
      return withQuote(describeRefund(watch, depositAddress, {
        symbol: draft.symbol,
        refundTarget: `${owner} inside ${INTENTS_VERIFIER}, where the balance started`,
        evidence,
        primaryTxid: spent.intentHash,
      }), signedQuote);
    }

    if (watch.status === 'INCOMPLETE_DEPOSIT') {
      return withQuote(describeIncompleteDeposit(watch, depositAddress, {
        symbol: draft.symbol,
        quotedIn: oneLine(quote.amountInFormatted, 40),
        refundTarget: `${owner} inside ${INTENTS_VERIFIER}`,
        evidence,
        primaryTxid: spent.intentHash,
      }), signedQuote);
    }

    // Timed out. The signature is released and the intent submitted, so the payout may well
    // land after this returns. Saying "failed" without that sentence is how someone signs a
    // second payout for money that is already on its way.
    return {
      ok: false,
      detail:
        `the intent was submitted but 1click did not reach a terminal status within ` +
        `${Math.round(pollTimeoutMs / 1000)}s (last status ${watch.reported}); ${evidence}. ` +
        `THE INTENT IS SIGNED AND SUBMITTED and the payout may still land, so it is unconfirmed: check ${p.to} on ${label} ` +
        `and the balance inside ${INTENTS_VERIFIER} before signing another.`,
      txids: uniqueTxids(spent.intentHash, watch),
      evidence: { handle: oneLine(depositAddress, 80), quote: signedQuote },
    };
  }

  return { kind: 'intents_pay', valueUsd, simulate, execute };
}
