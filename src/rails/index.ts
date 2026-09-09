// The rail registry: the one table that knows every rail exists.
//
// types.ts says the dispatch table is "the only place that knows they all exist, which is
// what lets a rail be added without touching the engine". This is that table. The proposal
// service asks it for a rail and never names one, so adding a fifth rail is an edit here
// and nowhere else.
//
// Two things are deliberate:
//
//   1. 'swap' maps to ONE rail that dispatches on venue. Two venues share the kind
//      (oneclick cross-chain, intents-native inside the verifier), and the alternative,
//      keying the registry on kind+venue, would push that pair into every call site. Each
//      rail still refuses a draft for the other venue on its own (requireVenue in both
//      modules), so this dispatch is a router, not the check.
//
//   2. Demo mode holds NO rails. The demo ledger is a fixture, not a chain: there is
//      nothing for a swap to quote against and nothing for a bridge deposit to land in.
//      An empty registry makes every rail proposal refuse with a reason that says so,
//      which is better than a rail reaching for an RPC and a private key that the demo
//      user never meant to involve.

import type { AppConfig, ChainId, Rail, SwapDraft, WriteDraft } from '../types.ts';
import type { OneClickClient, TokensFile } from '../intents.ts';
import { oneClickClient } from '../intents.ts';
import { hypercoreDepositRail } from './hypercore-deposit.ts';
import { ONECLICK_COUNTERPARTY, oneClickRail } from './oneclick.ts';
import { INTENTS_NATIVE_COUNTERPARTY, intentsNativeRail } from './intents-native.ts';
import { intentsDepositRail } from './intents-deposit.ts';
import { intentsWithdrawRail } from './intents-withdraw.ts';
import { HYPERLIQUID_PERPS_COUNTERPARTY, mandateRail } from './mandate.ts';
import type { MandateRunner } from './mandate.ts';
import { isRailDraft, isRailKind, RAIL_KINDS } from './kinds.ts';
import type { RailDraft, RailKind } from './kinds.ts';

// The kinds themselves live in ./kinds.ts, which imports no runtime code, so the policy
// engine can share this list without also importing every rail's RPC and config. Re-exported
// here because the registry has always been where the rest of the app reaches for them.
export type { RailDraft, RailKind };
export { isRailDraft, isRailKind, RAIL_KINDS };

export type RailRegistry = {
  // The rail that owns this draft, or null when none does: consolidate, transfer and
  // policy_change ride their own paths, and demo mode owns no rails at all.
  for(draft: WriteDraft): Rail | null;
  kinds(): RailKind[];
};

export type RailDeps = {
  cfg: AppConfig;
  tokens: TokensFile; // data/tokens.json, for the 1Click asset id lookup
  runner: MandateRunner; // owns the armed bots; the mandate rail only starts and stops them
};

// Refuses by name rather than by silence. There is no fallback venue any more: a swap for a
// venue this app does not run used to fall through to Uniswap, which meant a draft meant for
// somewhere else was quietly executed on an on-chain DEX. Naming the venue in the error is
// what turns "nothing happened" into a sentence a human can act on.
function unknownSwapVenue(venue: string): Rail<SwapDraft> {
  const refuse = (): never => {
    throw new Error(
      `no rail runs swaps on '${venue}'; this app swaps through 1Click (venue 'oneclick') or ` +
        "inside the NEAR Intents verifier (venue 'intents-native')",
    );
  };
  return {
    kind: 'swap',
    valueUsd: (draft) => draft.amountUsd,
    simulate: async () => refuse(),
    execute: async () => refuse(),
  };
}

// One rail for kind 'swap', routing on the draft's venue.
function swapRail(deps: RailDeps, client: OneClickClient): Rail<SwapDraft> {
  const oneclick = oneClickRail({
    keysPath: deps.cfg.keysPath,
    tokens: deps.tokens,
    client,
  });
  const intentsNative = intentsNativeRail({
    keysPath: deps.cfg.keysPath,
    tokens: deps.tokens,
    client,
  });
  // Explicit per venue, with no default. Each rail still refuses a draft for another venue on
  // its own, so this is a router and not the check.
  const pick = (draft: SwapDraft): Rail<SwapDraft> => {
    if (draft.venue === 'oneclick') return oneclick;
    if (draft.venue === 'intents-native') return intentsNative;
    return unknownSwapVenue(draft.venue);
  };

  return {
    kind: 'swap',
    valueUsd: (draft) => pick(draft).valueUsd(draft),
    simulate: (draft) => pick(draft).simulate(draft),
    execute: (draft) => pick(draft).execute(draft),
  };
}

export function createRails(deps: RailDeps): RailRegistry {
  if (deps.cfg.mode === 'demo') {
    return { for: () => null, kinds: () => [] };
  }

  /* ONE 1Click client for every rail that talks to 1Click, built here and injected.
     Each rail used to construct its own, and the client caches the token list per instance
     (src/intents.ts:415-428), so five rails meant five fetches of the same ~186-row list and
     five copies of it in memory. Sharing the instance makes the first rail to ask pay for it
     and the rest read the cache. The rails still accept their own client, which is what the
     tests inject. */
  const client = oneClickClient();

  const table: Record<RailKind, Rail> = {
    swap: swapRail(deps, client) as Rail,
    hl_deposit: hypercoreDepositRail({
      keysPath: deps.cfg.keysPath,
      tokens: deps.tokens,
      client,
    }) as Rail,
    intents_deposit: intentsDepositRail({
      keysPath: deps.cfg.keysPath,
      tokens: deps.tokens,
      client,
    }) as Rail,
    // The only rail that is handed the address book. It pays out to a wallet on a real chain,
    // so it re-derives the destination from config itself rather than trusting the draft that
    // reaches it; see the header of intents-withdraw.ts.
    intents_withdraw: intentsWithdrawRail({
      keysPath: deps.cfg.keysPath,
      tokens: deps.tokens,
      addresses: deps.cfg.addresses,
      client,
    }) as Rail,
    mandate_arm: mandateRail({ runner: deps.runner }) as Rail,
  };

  return {
    for: (draft: WriteDraft) => (isRailKind(draft.kind) ? table[draft.kind] : null),
    kinds: () => [...RAIL_KINDS],
  };
}

// Every counterparty a rail can hand funds to on this network, lowercased.
//
/* The CONTRACTS on that list, each labelled with the venue and chain it belongs to.
   EMPTY, and that is the shape of this app now rather than a hole in it. Both surviving
   venues are reached by a venue STRING and not by a contract we can verify a deployment for:
   1Click mints a deposit address per quote, the intents verifier is a NEAR account, and a
   perp order hands funds to nobody. The third-party EVM contracts that used to fill this list
   (the Uniswap router and position manager, the Aave pools) went with their rails.

   Kept as a function rather than deleted because it is the seam a contract venue would come
   back through, and because venueAllowlist() and the sentence venues.ts writes about it must
   keep reading the same source. */
export function verifiedVenueContracts(): Array<{ address: string; venue: string; chain: ChainId }> {
  return [];
}

// This is what the policy allowlist has to contain for the rails to be usable at all:
// evaluateRail refuses an unlisted counterparty outright (rule 'destination_not_allowed'),
// never as needs_approval, so a missing entry does not mean "ask a human", it means the
// rail is dead. Seeding it is main.ts's job.
//
// The addresses come from the verified deployment tables and nowhere else. No agent input
// reaches this list, which is what makes "the agent cannot name where the money goes" true
// for the rails as well as for a transfer.
export function venueAllowlist(): string[] {
  const out = new Set<string>(verifiedVenueContracts().map((v) => v.address));

  // Hyperliquid funding used to add Bridge2's address here. It routes through 1Click now, so
  // it has no address of its own to list either, and its counterparty string IS ONECLICK_COUNTERPARTY:
  // one host, one allowlist entry, added just below.

  // 1Click mints a fresh deposit address per quote, so no address of its own can ever sit
  // on a static list; the venue string is the allowlist entry (see the comment on
  out.add(ONECLICK_COUNTERPARTY.toLowerCase());

  // The intents-native rail is the opposite case, and it is the reason that rail exists: its
  // counterparty is the verifier contract account itself, one fixed value for every swap
  // forever, so this really is an address on a static list rather than a venue string
  // standing in for one that cannot be listed.
  out.add(INTENTS_NATIVE_COUNTERPARTY.toLowerCase());

  // The perps venue, a third kind of entry again. A perp order hands funds to nobody: margin,
  // position and profit all stay inside the Hyperliquid account the human already funded, so
  // there is no destination to list. The venue string stands in so the destination check still
  // has something to check rather than being skipped for this one rail.
  out.add(HYPERLIQUID_PERPS_COUNTERPARTY.toLowerCase());

  return [...out];
}
