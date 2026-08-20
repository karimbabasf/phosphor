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
//      (uniswap-v3 same-chain, oneclick cross-chain), and the alternative, keying the
//      registry on kind+venue, would push that pair into every call site. Each rail still
//      refuses a draft for the other venue on its own (requireVenue in both modules), so
//      this dispatch is a router, not the check.
//
//   2. Demo mode holds NO rails. The demo ledger is a fixture, not a chain: there is
//      nothing for a swap to quote against and nothing for a bridge deposit to land in.
//      An empty registry makes every rail proposal refuse with a reason that says so,
//      which is better than a rail reaching for an RPC and a private key that the demo
//      user never meant to involve.

import type { AppConfig, Network, Rail, SwapDraft, WriteDraft } from '../types.ts';
import type { TokensFile } from '../intents.ts';
import { uniswapRails } from './uniswap.ts';
import { chainsWithDeployment, deploymentFor } from './uniswap-abi.ts';
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

// One rail for kind 'swap', routing on the draft's venue.
function swapRail(deps: RailDeps): Rail<SwapDraft> {
  const uniswap = uniswapRails(deps.cfg).swap;
  const oneclick = oneClickRail({
    network: deps.cfg.network,
    keysPath: deps.cfg.keysPath,
    tokens: deps.tokens,
  });
  const intentsNative = intentsNativeRail({
    network: deps.cfg.network,
    keysPath: deps.cfg.keysPath,
    tokens: deps.tokens,
  });
  // Explicit per venue, not a two-way test with a default. uniswap is the fallback because
  // it was here first, and a new venue falling into it silently would route a draft meant
  // for NEAR Intents into an on-chain DEX swap. Each rail still refuses a draft for another
  // venue on its own, so this is a router and not the check.
  const pick = (draft: SwapDraft): Rail<SwapDraft> => {
    if (draft.venue === 'oneclick') return oneclick;
    if (draft.venue === 'intents-native') return intentsNative;
    return uniswap;
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

  const uniswap = uniswapRails(deps.cfg);
  const table: Record<RailKind, Rail> = {
    swap: swapRail(deps) as Rail,
    // The TRADING network, not the wallet one: this rail funds a Hyperliquid account, and
    // which Hyperliquid that is has its own setting. Passing cfg.network here would fund the
    // mainnet account while the runner traded testnet, which is the exact split cfg.tradingNetwork
    // exists to make unexpressible.
    hl_deposit: hypercoreDepositRail({
      network: deps.cfg.tradingNetwork,
      keysPath: deps.cfg.keysPath,
      tokens: deps.tokens,
    }) as Rail,
    intents_deposit: intentsDepositRail({
      network: deps.cfg.network,
      keysPath: deps.cfg.keysPath,
      tokens: deps.tokens,
    }) as Rail,
    // The only rail that is handed the address book. It pays out to a wallet on a real chain,
    // so it re-derives the destination from config itself rather than trusting the draft that
    // reaches it; see the header of intents-withdraw.ts.
    intents_withdraw: intentsWithdrawRail({
      network: deps.cfg.network,
      keysPath: deps.cfg.keysPath,
      tokens: deps.tokens,
      addresses: deps.cfg.addresses,
    }) as Rail,
    lp_add: uniswap.lpAdd as Rail,
    lp_remove: uniswap.lpRemove as Rail,
    mandate_arm: mandateRail({ runner: deps.runner }) as Rail,
  };

  return {
    for: (draft: WriteDraft) => (isRailKind(draft.kind) ? table[draft.kind] : null),
    kinds: () => [...RAIL_KINDS],
  };
}

// Every counterparty a rail can hand funds to on this network, lowercased.
//
// This is what the policy allowlist has to contain for the rails to be usable at all:
// evaluateRail refuses an unlisted counterparty outright (rule 'destination_not_allowed'),
// never as needs_approval, so a missing entry does not mean "ask a human", it means the
// rail is dead. Seeding it is main.ts's job.
//
// The addresses come from the verified deployment tables and nowhere else. No agent input
// reaches this list, which is what makes "the agent cannot name where the money goes" true
// for the rails as well as for a transfer.
export function venueAllowlist(network: Network): string[] {
  const out = new Set<string>();

  for (const chain of chainsWithDeployment(network)) {
    const dep = deploymentFor(network, chain);
    out.add(dep.router.toLowerCase()); // SwapRouter02, for kind 'swap'
    out.add(dep.positionManager.toLowerCase()); // NPM, for lp_add and lp_remove
  }

  // Hyperliquid funding used to add Bridge2's address here. It routes through 1Click now, so
  // it has no address of its own to list either, and its counterparty string IS ONECLICK_COUNTERPARTY:
  // one host, one allowlist entry, added just below.

  // 1Click mints a fresh deposit address per quote, so no address of its own can ever sit
  // on a static list; the venue string is the allowlist entry (see the comment on
  // ONECLICK_COUNTERPARTY). It is listed on testnet too, where the rail is mainnet-only:
  // the rail's own network guard is what stops a testnet send, and leaving the venue off
  // would replace its plain "NEAR Intents has no testnet" refusal with a misleading
  // "not on the allowlist".
  out.add(ONECLICK_COUNTERPARTY.toLowerCase());

  // The intents-native rail is the opposite case, and it is the reason that rail exists: its
  // counterparty is the verifier contract account itself, one fixed value for every swap
  // forever, so this really is an address on a static list rather than a venue string
  // standing in for one that cannot be listed. Same testnet reasoning as above.
  out.add(INTENTS_NATIVE_COUNTERPARTY.toLowerCase());

  // The perps venue, a third kind of entry again. A perp order hands funds to nobody: margin,
  // position and profit all stay inside the Hyperliquid account the human already funded, so
  // there is no destination to list. The venue string stands in so the destination check still
  // has something to check rather than being skipped for this one rail.
  out.add(HYPERLIQUID_PERPS_COUNTERPARTY.toLowerCase());

  return [...out];
}
