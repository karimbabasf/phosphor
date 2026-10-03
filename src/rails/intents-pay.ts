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
//      has to decode to exactly 32 bytes; a NEAR id has to be one; a Bitcoin, XRP, Stellar, TON,
//      Tron or Cardano address has to pass its own checksum. A dropped digit is a total loss on
//      a chain, so a dropped digit is a refusal before any quote. The one form with no checksum,
//      a raw TON address (0:<hex>), is said on the card as carrying none.
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
// THE CHAINS WITH RULES OF THEIR OWN (2026-09-26). Past EVM, Solana and NEAR, a chain can refuse
// a payment the quote was happy to price: an XRP or Stellar account that demands a memo this app
// cannot send, an account that does not exist yet and a payment under the reserve that would
// create it, a Stellar token with no trustline, TRX to a Tron contract. src/rails/pay-rules.ts
// holds those rules; they run on fresh reads before the dry quote and again before the live one,
// and a rule the chain would not answer is a refusal.
//
// THE PROOF IS THE PAYOUT HASH. 1Click reports the destination chain transaction on SUCCESS,
// and the receipt carries it with its explorer link. The receiver's holdings are read before
// and after as a second opinion when the chain answers; the hash is the proof either way.

import { formatUnits } from 'viem';
import type { IntentsPayDraft, Rail, RailHooks, RailResult, SendRecipient, SendSimulation, SimulationResult, ChainId } from '../types.ts';
import { QuoteRefusal, VENUE_WORDS_LABEL, baseUnits, oneLine, quoteEchoProblems, resolveAsset, toBaseUnits, venueSaid } from '../intents.ts';
import type { OneClickClient, OneClickQuote, OneClickToken, QuoteEcho, TokensFile } from '../intents.ts';
import { INTENTS_VERIFIER, intentsApi, liveIntentsSigner } from './intents-native.ts';
import type { IntentsApiPort, IntentsSignerPort } from './intents-native.ts';
import { spendFromIntents } from './intents-spend.ts';
import type { PreflightRunner } from '../preflight/live.ts';
import { EXECUTE_MAX_AGE_MS, closedQuoteSentence, routeGate } from '../preflight/route-health.ts';
import type { RouteHealth } from '../preflight/route-health.ts';
import { describeHeld, deliveredAmount, deliveredNote, describeIncompleteDeposit, describeRefund, describeUnconfirmedSubmit, settledEvidence, uniqueTxids, withQuote } from './oneclick-words.ts';
import { reasonOf } from './reasons.ts';
import { addressSummary, createChainFetchState, explorerAddressUrl, explorerTxUrl, payTarget, scanNetworkOf } from '../chainscan/index.ts';
import type { AddressActivity, AddressSummary, ChainNetwork, PayTarget } from '../chainscan/index.ts';
import { pickOrExplain } from './asset-words.ts';
import { heldToPin, pinnedAssets } from './asset-pin.ts';
import { intentsDepositAddress, networkByVenue, poaSupportedTokens, spendNetworkOf } from './intents-address.ts';
import type { PayFamily, PoaToken } from './intents-address.ts';
import { depositFloorOf, needsTarget, ownDepositChain, payAddress, payChecks, paysOwnDeposit, readsOwnDeposit } from './pay-rules.ts';
import type { DepositFloor, OwnDeposit, PayNote } from './pay-rules.ts';

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

// How long each of the chain-rule reads may take (src/rails/pay-rules.ts): the ledger's rules for
// the receiver and the bridge's deposit address for our own account.
export const RULE_READ_MS = 6_000;

// How long the bridge's list of minimum deposits is kept: it is the same for everybody and moves
// rarely, and a payout should not wait on it twice in a minute.
export const FLOOR_LIST_TTL_MS = 5 * 60_000;

export function minReceivedForPay(amount: number): number {
  return amount * (1 - PAY_MAX_LOSS_BPS / 10_000);
}

/* WHICH CHAINS THIS APP WILL PAY OUT ON. Not a list of chains it knows: a list of chains whose
   addresses it can decode itself and whose receiver it can ask the chain about. The bridge
   accepts money from thirty five and this app hands money to every one but two since 2026-09-26.
   Those two are refused by name, and the sentence says what is missing rather than pretending
   the chain is unknown: it is on the deposit card, a person can see it. */
export function payFamilyOf(network: string): PayFamily | null {
  return spendNetworkOf(network)?.pay ?? null;
}

// Why a chain the deposit card lists is not one a payout lands on.
const NO_PAY_WHY: Readonly<Record<string, string>> = {
  zec: 'no public Zcash reader answers, so the chain cannot be asked about the address before money goes to it',
  aleo: 'Aleo is a privacy chain, and how a payout is delivered there has not been checked',
};

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`;
}

export function payRefusal(network: string): string | null {
  const net = spendNetworkOf(network);
  if (net === undefined) {
    return (
      `"${oneLine(network, 40)}" is not a place this app can send to: say 'intents' to keep the money inside ` +
      'NEAR Intents, or a chain id the deposit card offers, such as eth, base, arb, sol or near'
    );
  }
  if (net.pay === null) {
    return (
      `this app cannot check ${article(net.name)} address yet, so it will not pay one. Money can still ` +
      `come IN on ${net.name} through the deposit card, and it can be swapped into any coin, ` +
      `but a payout is not sent there: ${NO_PAY_WHY[net.id] ?? 'this app has no decoder for this chain'}`
    );
  }
  return null;
}

// The chain's word, for every sentence a person reads. The registry's name, never an id.
export function payLabel(network: string): string {
  return spendNetworkOf(network)?.name ?? String(network);
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
export function recipientSentence(network: string, recipient: SendRecipient): string {
  const label = payLabel(network);
  /* The activity was read by the chainscan, which names chains its own way (optimism, not op),
     so the two are compared through that mapping rather than as strings. */
  const scan = scanNetworkOf(network);
  const own = recipient.ownAddress ? `This is your own address on ${label}. ` : '';
  const a = recipient.activity;
  if (a === null || a.network !== scan) return `${own}This address could not be checked on ${label} right now.`.trim();
  const holds = a.balance === null ? null : `holds ${roundAmount(a.balance.amount)} ${a.balance.symbol}`;
  /* Most readers past the first six answer the balance and no count (a TON, XRP or Stellar
     account says what it holds, not how often it was used), so a read with a balance is an
     answer, and an empty one still gets the check-twice sentence. */
  if (a.ok && a.txCount === null && a.balance !== null && a.isContract !== true) {
    return Number(a.balance.amount) === 0
      ? `${own}This address holds no ${a.balance.symbol} on ${label} right now. Check it twice.`.trim()
      : `${own}This address ${holds} on ${label}.`.trim();
  }
  if (!a.ok || a.txCount === null) {
    return `${own}This address could not be checked on ${label}${a.error ? ` (${oneLine(a.error, 80)})` : ''}.`.trim();
  }
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
  receiverRead?: (network: string, address: string) => Promise<AddressSummary | null>;
  // The checks run on the live quote before the intent is generated (src/preflight/). The
  // registry wires the live one; absent means none, which is the tests of the rail itself.
  preflight?: PreflightRunner;
  // The receiver's rules on the XRP Ledger and Stellar (src/chainscan/destination.ts), read
  // fresh before each quote. Null is a ledger that did not answer, and a payout is refused on it.
  payTarget?: (network: string, address: string) => Promise<PayTarget | null>;
  // Our own bridge deposit address on the chain, which on a memo chain may be the one address
  // the bridge shares with everybody. Null is a bridge that did not answer, and a payout is
  // refused on it.
  ownDeposit?: (account: string, network: string) => Promise<OwnDeposit | null>;
  // The least the bridge credits of the paid token on the chain (src/rails/pay-rules.ts
  // DepositFloor), which binds a payout to our own deposit address. Null is a bridge that did not
  // answer, and on that payout it is a refusal.
  depositFloor?: (network: string, asset: { assetId: string; native: boolean; contract: string | null }) => Promise<DepositFloor | null>;
  // Whether NEAR Intents is taking payouts to the chain right now (src/preflight/route-health.ts).
  // The registry wires the live one; absent, no route is called closed.
  routes?: RouteHealth;
};

export type IntentsPayRail = Rail<IntentsPayDraft>;

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// The chain readers whose token rows carry a coin name and no contract (src/chainscan/families.ts).
const SYMBOL_ONLY_TOKEN_VIEWS: ReadonlySet<string> = new Set(['hyperliquid']);

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
    ((network: string, address: string) => {
      /* Every chain the scan can read has an answer here (src/chainscan/networks.ts); on a chain
         it cannot, the card says the address could not be checked, the honest word for it. */
      const scan = scanNetworkOf(network);
      if (scan === null) return Promise.resolve(null);
      return addressSummary(scan, address, { fetchImpl, state: createChainFetchState() }).catch(() => null);
    });
  /* Six seconds each, side by side: they run inside a propose, after the eight second receiver
     read and the four second route check, and the proxy gives the whole reply thirty. A read
     that runs out is null, and on a chain where it matters null is a refusal. */
  const targetRead =
    deps.payTarget ??
    ((network: string, address: string) => {
      const scan = scanNetworkOf(network);
      if (scan === null) return Promise.resolve(null);
      return payTarget(scan, address, { fetchImpl, state: createChainFetchState(), deadline: Date.now() + RULE_READ_MS }).catch(() => null);
    });
  const ownDepositRead =
    deps.ownDeposit ??
    ((account: string, network: string) =>
      Promise.race([
        intentsDepositAddress(account, network, fetchImpl).then(
          (d): OwnDeposit => ({ address: d.address, memo: d.memo }),
          () => null,
        ),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), RULE_READ_MS).unref()),
      ]));
  // The list never throws: an empty one is a bridge that did not answer, since it lists dozens.
  let floorList: { at: number; rows: PoaToken[] } | null = null;
  const floorRead =
    deps.depositFloor ??
    (async (network: string, asset: { assetId: string; native: boolean; contract: string | null }): Promise<DepositFloor | null> => {
      if (floorList === null || now() - floorList.at > FLOOR_LIST_TTL_MS) {
        const rows = await Promise.race([
          poaSupportedTokens(fetchImpl),
          new Promise<PoaToken[]>((resolve) => setTimeout(() => resolve([]), RULE_READ_MS).unref()),
        ]);
        if (rows.length === 0) return null;
        floorList = { at: now(), rows };
      }
      return depositFloorOf(floorList.rows, network, asset);
    });

  type Plan = {
    chain: string;
    originAsset: string; // the 1Click id spent, the flavor held
    originNetwork: string; // the chain that flavor came in on, by name: the summary names it, never the id
    destinationAsset: string; // the 1Click id the receiver is paid in
    native: boolean; // the destination is the chain's own coin
    tokenId: string | null; // the destination token's contract or mint, for the balance read
    decimals: number;
    amountBase: bigint;
    minReceivedBase: bigint;
    to: string; // the receiver as the chain spells it, decoded here rather than trusted
    given: string | null; // the spelling the draft was given, when the payout sends another of the same account
    issuer: string | null; // the destination token's contract or issuer on the chain
    priceUsd: number | null; // the held coin's price on the venue's list, for a minimum said in dollars
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

  function requireChain(draft: IntentsPayDraft): string {
    const refused = payRefusal(draft.network);
    if (refused !== null) throw new Error(refused);
    return draft.network;
  }

  // The receiver, decoded again here rather than trusted, by the chain's own rules for a payout
  // address (src/rails/pay-rules.ts payAddress). Our own address is allowed (that is what a
  // withdrawal to our wallet is now) and the summary says so.
  function requireReceiver(draft: IntentsPayDraft): { to: string; given: string | null } {
    const family = payFamilyOf(draft.network);
    if (family === null) throw new Error(payRefusal(draft.network) ?? `this app cannot pay out on ${payLabel(draft.network)}`);
    const checked = payAddress(draft.network, draft.to);
    if (!checked.ok) throw new Error(`the receiving address is unusable: ${checked.reason}`);
    return { to: checked.to, given: draft.toGiven ?? checked.given };
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
    if (native && a !== null && a.network === scanNetworkOf(draft.network) && a.isContract === true) {
      throw new Error(
        `${draft.to} is a contract on ${payLabel(draft.network)}, and ${draft.symbol} sent to a contract ` +
          'that cannot receive it is lost; pay a wallet, or a token the contract can hold',
      );
    }
  }

  async function plan(draft: IntentsPayDraft): Promise<Plan> {
    requireVenue(draft);
    const chain = requireChain(draft);
    const { to, given } = requireReceiver(draft);
    const list = await api.tokens();
    const held = findHeld(list, draft);
    const destination = pickOrExplain(
      resolveAsset(chain, draft.symbol.toUpperCase(), tokens, list),
      draft.symbol,
      chain,
    );
    if (destination.decimals !== held.decimals) {
      throw new Error(
        `${draft.symbol} has ${held.decimals} decimals inside the verifier and ${destination.decimals} on ${payLabel(draft.network)}; ` +
          'the amount would be wrong by a power of ten, so nothing is quoted',
      );
    }
    refuseContractForNative(draft, destination.native);
    // The two coins the card priced, once it has (src/rails/asset-pin.ts).
    const origin = heldToPin(draft.assets?.origin, { assetId: held.assetId, decimals: held.decimals }, draft.symbol);
    const paid = heldToPin(draft.assets?.destination, { assetId: destination.assetId, decimals: destination.decimals }, `${draft.symbol} on ${payLabel(draft.network)}`);
    const listed = list.find((t) => t.assetId === paid.assetId);
    return {
      chain,
      originAsset: origin.assetId,
      originNetwork: networkByVenue(held.blockchain)?.name ?? held.blockchain,
      destinationAsset: paid.assetId,
      native: destination.native,
      tokenId: destination.native ? null : (tokens[chain as ChainId]?.[draft.symbol.toUpperCase()]?.tokenId ?? null),
      decimals: origin.decimals,
      amountBase: toBaseUnits(draft.amount, origin.decimals),
      minReceivedBase: toBaseUnits(draft.minReceived, paid.decimals),
      to,
      given,
      issuer: destination.native ? null : (listed?.contractAddress ?? null) || null,
      priceUsd: typeof held.price === 'number' && Number.isFinite(held.price) && held.price > 0 ? held.price : null,
      slippageBps: held.assetId === destination.assetId ? PAY_SAME_ASSET_SLIPPAGE_BPS : undefined,
    };
  }

  /* The chain's own rules for this receiver, on reads taken now (src/rails/pay-rules.ts). Run
     before the dry quote and again before the live one: an account can set RequireDestTag, or
     be created, between the card and the click. `activity` is what the chain reader said about
     the receiver, at propose time for the dry quote and fresh for the live one. */
  async function chainRules(draft: IntentsPayDraft, p: Plan, owner: string, activity: AddressActivity | null): Promise<{ problems: string[]; notes: PayNote[]; own: boolean }> {
    const [target, own, floor] = await Promise.all([
      needsTarget(draft.network) ? targetRead(draft.network, p.to) : Promise.resolve(undefined),
      readsOwnDeposit(draft.network) ? ownDepositRead(owner, ownDepositChain(draft.network)) : Promise.resolve(undefined),
      readsOwnDeposit(draft.network)
        ? floorRead(draft.network, { assetId: p.destinationAsset, native: p.native, contract: p.issuer }).catch(() => null)
        : Promise.resolve(undefined),
    ]);
    const checked = payChecks({
      network: draft.network,
      symbol: draft.symbol.toUpperCase(),
      native: p.native,
      issuer: p.issuer,
      amount: draft.amount,
      minReceived: draft.minReceived,
      to: p.to,
      given: p.given,
      activity,
      target,
      own,
      floor,
    });
    return { ...checked, own: paysOwnDeposit({ network: draft.network, to: p.to, own }) };
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
    const label = payLabel(draft.network);
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
    const label = payLabel(draft.network);
    const feeUsd = feeUsdOf(quote);
    const fee = flatFee(quote, p);
    return [
      `intents pay: ${draft.amount} ${draft.symbol} held inside ${INTENTS_VERIFIER} by ${draft.from} -> ` +
        `${oneLine(quote.amountOutFormatted, 40)} ${draft.symbol} paid out to ${p.to} on ${label}` +
        (p.originAsset === p.destinationAsset ? '' : ` (swapped on the way from the ${draft.symbol} from ${p.originNetwork})`),
      `fee ${feeUsd === null ? 'unknown' : '$' + feeUsd.toFixed(4)}${fee === null ? '' : `, of which ${fee} ${draft.symbol} is the bridge's flat fee`}, ` +
        `eta ~${Number(quote.timeEstimate)}s, solver floor ${units(baseUnits(quote.minAmountOut, 'minAmountOut'), p.decimals)} ${draft.symbol}, ` +
        `draft floor ${units(p.minReceivedBase, p.decimals)} ${draft.symbol}`,
    ];
  }

  function sendFacts(draft: IntentsPayDraft, p: Plan, quote: OneClickQuote, notes: PayNote[]): SendSimulation {
    return {
      destinationAsset: p.destinationAsset,
      arrives: oneLine(quote.amountOutFormatted, 40),
      arrivesAtLeast: units(baseUnits(quote.minAmountOut, 'minAmountOut'), p.decimals),
      feeUsd: feeUsdOf(quote),
      bridgeFee: flatFee(quote, p),
      etaSeconds: Number.isFinite(Number(quote.timeEstimate)) ? Number(quote.timeEstimate) : null,
      activity: recipientSentence(draft.network, draft.recipient),
      explorer: scanNetworkOf(draft.network) === null ? null : explorerAddressUrl(scanNetworkOf(draft.network) as ChainNetwork, p.to),
      ...(notes.length === 0 ? {} : { notes }),
    };
  }

  // 1Click refuses an amount the bridge floor eats with "try at least N" in base units. Said
  // in the asset, on the chain, and in dollars where the coin has a price, so the instruction
  // is one a person can act on.
  function floorWords(draft: IntentsPayDraft, p: Plan, message: string): string | null {
    const m = /try at least (\d+)/.exec(message);
    if (m === null) return null;
    const least = units(BigInt(m[1]), p.decimals);
    const usd = p.priceUsd === null ? '' : ` (about $${(Number(least) * p.priceUsd).toFixed(2)})`;
    return (
      `the bridge will not pay out less than ${least} ${draft.symbol} on ${payLabel(draft.network)}${usd}, ` +
      'its flat fee grossed up; send at least that, and more to keep the fee small against the amount'
    );
  }

  // 1Click keeps its own list of exchange addresses on Stellar and refuses to pay one (live,
  // 2026-09-26: "Cant withdraw to exchange on stellar"). Said as what it means: the exchange
  // needs a memo and the payout carries none.
  function exchangeWords(draft: IntentsPayDraft, message: string): string | null {
    if (!/withdraw to exchange/i.test(message)) return null;
    return (
      `the payout service will not pay an exchange address on ${payLabel(draft.network)}: an exchange needs a memo to credit a deposit, ` +
      'and a payout carries none; pay a personal wallet address'
    );
  }

  /* 1Click's own words for a refusal the rail has no sentence for. The chains past EVM, Solana
     and NEAR brought refusals of their own (a trustline, "recipient is not valid"), and every one
     is a stranger's text: it reaches the agent quoted and labeled, the way src/chainscan's
     DATA_NOTE and the route check's STATUS_DATA_LABEL carry theirs. */
  function venueWords(err: unknown, message: string): string {
    if (!(err instanceof QuoteRefusal)) return message;
    // The live client labels them where it reads them (src/rails/intents-native.ts readJson);
    // a port that did not is labeled here, never twice.
    return message.includes(VENUE_WORDS_LABEL) ? `1Click refused the quote: ${message}` : `1Click refused the quote. ${venueSaid('1Click', message)}`;
  }

  // 1Click refusing the pair, said as NEAR Intents not taking payouts to the chain.
  function closedWords(draft: IntentsPayDraft, err: unknown): string | null {
    return closedQuoteSentence(err, draft.network, 'payout');
  }

  // Whether NEAR Intents is taking payouts to this chain right now (src/preflight/route-health.ts).
  // `maxAgeMs` is set right before the signature, where a minute-old answer is not one about now.
  function routeCheck(draft: IntentsPayDraft, owner: string, maxAgeMs?: number): ReturnType<typeof routeGate> {
    return routeGate(deps.routes, { network: draft.network, direction: 'out', account: owner, ...(maxAgeMs === undefined ? {} : { maxAgeMs }) }, 'payout', 'agent');
  }

  /* A payout to our own deposit address lands as a deposit, so the deposit route into the chain
     is the one that decides whether it comes back: TON deposits were paused on 2026-09-27 while
     payouts to TON were not, and that payout would have sat at the bridge. */
  function ownRouteCheck(draft: IntentsPayDraft, owner: string, maxAgeMs?: number): ReturnType<typeof routeGate> {
    return routeGate(deps.routes, { network: draft.network, direction: 'in', account: owner, ...(maxAgeMs === undefined ? {} : { maxAgeMs }) }, 'own_deposit', 'agent');
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
    const route = await routeCheck(draft, owner);
    if (route.closed !== null) return { ok: false, summary: route.closed, error: route.closed, reason: 'route_closed' };
    const rules = await chainRules(draft, p, owner, draft.recipient.activity);
    if (rules.problems.length > 0) {
      const joined = rules.problems.join('; ');
      return { ok: false, summary: `intents pay simulation failed: ${joined}`, error: joined };
    }
    const inRoute = rules.own ? await ownRouteCheck(draft, owner) : { closed: null, notice: null };
    if (inRoute.closed !== null) return { ok: false, summary: inRoute.closed, error: inRoute.closed, reason: 'route_closed' };
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
      // A route NEAR Intents reports trouble on goes ahead, and says so first.
      const lines = [...[route.notice, inRoute.notice].filter((n): n is string => n !== null), ...priceLines(draft, p, response.quote)];
      const send = sendFacts(draft, p, response.quote, rules.notes);
      lines.push(send.activity);
      for (const note of rules.notes) lines.push(note.text);
      const problems = [...checkQuote(draft, p, response.quote), ...quoteEchoProblems(response.raw, echoWant(draft, p))];
      if (problems.length > 0) {
        const joined = problems.join('; ');
        return { ok: false, summary: [`REFUSED: ${joined}`, ...lines].join('\n'), error: joined, send };
      }
      lines.push(
        `execution signs one intent with the EVM key; 1Click's bridge pays out on ${payLabel(draft.network)}, ` +
          `and if it cannot, the money comes back to your balance inside ${INTENTS_VERIFIER}`,
      );
      lines.push('this payout always waits for your click and, on an enclave wallet, a Touch ID that names the receiver');
      const assets = { origin: { assetId: p.originAsset, decimals: p.decimals }, destination: { assetId: p.destinationAsset, decimals: p.decimals } };
      return { ok: true, summary: lines.join('\n'), send, assets };
    } catch (err) {
      const message = errText(err);
      const closed = closedWords(draft, err);
      if (closed !== null) return { ok: false, summary: closed, error: closed, reason: 'route_closed' };
      const said = floorWords(draft, p, message) ?? exchangeWords(draft, message) ?? venueWords(err, message);
      return { ok: false, summary: `intents pay simulation failed: ${said}`, error: said };
    }
  }

  // The receiver's holding of the paid asset as the chain read answered it, formatted, or null.
  function holdingOf(read: AddressSummary | null, p: Plan): string | null {
    if (read === null || !read.ok) return null;
    if (p.native) return read.balance?.amount ?? null;
    // A chain read with no token view (an EVM chain read over its RPC, NEAR) says nothing about
    // a token, and a token it did not list is not a zero balance. Nor does a view that lists by
    // coin name with no contract (Hyperliquid's spot book): no row in it is this token for sure,
    // and the money may sit on the perp side it never lists.
    if (p.tokenId === null || read.tokensSource === null || SYMBOL_ONLY_TOKEN_VIEWS.has(read.tokensSource)) return null;
    const want = p.tokenId.toLowerCase();
    const row = read.tokens.find((t) => (t.contract ?? '').toLowerCase() === want);
    return row === undefined ? '0' : row.amount;
  }

  async function execute(draft: IntentsPayDraft, _proposalId?: string, hooks?: RailHooks): Promise<RailResult> {
    pinnedAssets(draft.assets);
    const p = await plan(draft);
    const owner = requireOwner(draft);
    const label = payLabel(draft.network);
    // Asked again here, fresh: the route may have closed while the card waited for its click. A
    // closed answer now saves the live quote; the answer that counts is asked right before the
    // signature (beforeSign below), after the receiver read, which can take many seconds.
    const route = await routeCheck(draft, owner, EXECUTE_MAX_AGE_MS);
    if (route.closed !== null) return { ok: false, detail: route.closed, reason: 'route_closed' };
    const before = await receiverRead(draft.network, p.to);
    // The chain's rules again, on reads taken now, before the live quote: the card may have
    // waited minutes for its click. A rule that fails here throws, like every refusal before the
    // signature.
    const rules = await chainRules(draft, p, owner, before);
    if (rules.problems.length > 0) throw new Error(rules.problems.join('; '));
    if (rules.own) {
      const inRoute = await ownRouteCheck(draft, owner, EXECUTE_MAX_AGE_MS);
      if (inRoute.closed !== null) return { ok: false, detail: inRoute.closed, reason: 'route_closed' };
    }

    // The four shared steps: live quote, echo check, generated intent checked and signed,
    // submitted and watched. Every refusal before the signature throws out of here; after it
    // nothing does, and a submit that did not answer comes back as signed and unsubmitted.
    const preflight = deps.preflight;
    let spent: Awaited<ReturnType<typeof spendFromIntents>>;
    try {
      spent = await spendFromIntents(
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
          beforeSign: async () =>
            (await routeCheck(draft, owner, EXECUTE_MAX_AGE_MS)).closed ?? (rules.own ? (await ownRouteCheck(draft, owner, EXECUTE_MAX_AGE_MS)).closed : null),
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
    } catch (err) {
      // Everything before the signature throws; 1Click refusing the pair on the live quote is
      // one of those, and it gets the same sentence the dry quote would have. The route closing
      // before the signature is another, with its own sentence already.
      if (reasonOf(err) === 'route_closed') return { ok: false, detail: errText(err), reason: 'route_closed' };
      const closed = closedWords(draft, err);
      if (closed !== null) return { ok: false, detail: closed, reason: 'route_closed' };
      // 1Click refusing the live quote for a reason of its own gets the dry quote's sentences, its
      // words quoted and labeled, never rethrown bare (review L5, 2026-09-27).
      if (err instanceof QuoteRefusal) {
        const message = errText(err);
        throw new Error(floorWords(draft, p, message) ?? exchangeWords(draft, message) ?? venueWords(err, message));
      }
      throw err;
    }
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
      const scan = scanNetworkOf(draft.network);
      const explorer = hash === undefined || scan === null ? null : explorerTxUrl(scan, hash);
      const payoutWords =
        hash === undefined
          ? `1click reported SUCCESS with no payout hash yet: look for it at ${(scan === null ? null : explorerAddressUrl(scan, p.to)) ?? p.to}`
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
