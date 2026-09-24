// The rail registry: the one table that knows every rail exists.
//
// types.ts says the dispatch table is "the only place that knows they all exist, which is
// what lets a rail be added without touching the engine". This is that table. The proposal
// service asks it for a rail and never names one, so adding a fifth rail is an edit here
// and nowhere else.
//
// Two things are deliberate:
//
//   1. 'swap' is a balance inside the verifier changing what it holds, and two rails do it:
//      the solver relay (one atomic token_diff, src/rails/intents-relay.ts) and the 1Click
//      transfer it replaced (src/rails/intents-native.ts), kept one config line away for a
//      month after the flip (`swap.rail`, src/config.ts). Both are built; the draft's venue
//      picks, so a row written under either rail reaches the rail that wrote it. The
//      chain-side 1Click venue went with the chain wallets (2026-09-16); rows it wrote still
//      render as history.
//
//   2. Demo mode holds NO LIVE rails. The demo ledger is a fixture, not a chain, so nothing
//      here may reach for an RPC and a private key that the demo user never meant to involve.
//      It holds the demo rails instead (./demo.ts): five kinds that sign nothing, send
//      nothing and walk the stages a real rail reports, against the fixture's own balances.
//      They are built here and only here, and only under this mode.

import type { AppConfig, ChainId, Rail, WriteDraft } from '../types.ts';
import type { OneClickToken, TokensFile } from '../intents.ts';
import { ONECLICK_COUNTERPARTY, oneClickClient } from '../intents.ts';
import { intentsActivity } from '../chainscan/index.ts';
import type { IntentsActivity } from '../chainscan/index.ts';
import { demoRails } from './demo.ts';
import { hypercoreDepositRail } from './hypercore-deposit.ts';
import { hypercoreWithdrawRail } from './hypercore-withdraw.ts';
import { INTENTS_NATIVE_COUNTERPARTY, intentsNativeRail } from './intents-native.ts';
import { INTENTS_RELAY_VENUE, intentsRelayRail } from './intents-relay.ts';
import { swapRailOf } from '../config.ts';
import { intentsSendRail } from './intents-send.ts';
import { intentsPayRail } from './intents-pay.ts';
import { createLivePreflight } from '../preflight/live.ts';
import { relayClient } from '../relay/client.ts';
import type { RelayStatus } from '../relay/client.ts';
import { liveVerifier } from '../relay/verifier.ts';
import { HYPERLIQUID_PERPS_COUNTERPARTY, tradeRail } from '../trade/rail.ts';
import type { TradeDeps } from '../trade/rail.ts';
import { isRailDraft, isRailKind, RAIL_KINDS } from './kinds.ts';
import type { RailDraft, RailKind } from './kinds.ts';

// The kinds themselves live in ./kinds.ts, which imports no runtime code, so the policy
// engine can share this list without also importing every rail's RPC and config. Re-exported
// here because the registry has always been where the rest of the app reaches for them.
export type { RailDraft, RailKind };
export { isRailDraft, isRailKind, RAIL_KINDS };

export type RailRegistry = {
  // The rail that owns this draft, or null when none does: policy_change rides its own path,
  // and a trade needs a runner no fixture has.
  for(draft: WriteDraft): Rail | null;
  kinds(): RailKind[];
  /* The relay swap rail's after-the-fact reads, for reconciliation (src/proposals/reconcile.ts):
     the relay's own status by intent hash, and whether the verifier has spent a nonce. Here
     rather than on the proposal service because the registry is the one table that knows which
     venues exist; absent in demo mode and in any registry a test builds without one, where a
     relay row is judged by its balance alone. Neither read signs anything. */
  relay?: RelayLookup;
  /* What the swap reads (src/proposals/swap-reads.ts) ask the venue and the chain: the token
     list the swap rails resolve against, one balance inside the verifier, and the account's
     intents ledger history. All three are reads. Absent in demo mode and in any registry a test
     builds by hand, where the swap reads say there is no venue to ask. */
  swap?: SwapLookup;
};

export type SwapLookup = {
  tokens(): Promise<OneClickToken[]>;
  balance(accountId: string, assetId: string): Promise<bigint | null>;
  activity(accountId: string, limit: number): Promise<IntentsActivity>;
};

export type RelayLookup = {
  status(intentHash: string): Promise<RelayStatus>;
  nonceUsed(accountId: string, nonce: string): Promise<boolean | null>;
  // Whether the verifier still accepts a nonce's salt. Optional the safe way round: a lookup
  // without it reads as "no answer", and no failed verdict is ever written on an unspent nonce
  // without one (src/proposals/reconcile.ts). The live registry always carries it.
  saltValid?(salt: Uint8Array): Promise<boolean | null>;
};

export type RailDeps = {
  cfg: AppConfig;
  tokens: TokensFile; // data/tokens.json, for the 1Click asset id lookup
  trade: TradeDeps; // the plan runner and the venue facts a plan is priced against
  // The ledger's prices, for the preflight's fee check (gas priced in dollars). Absent means
  // the check cannot price gas and says so; it never holds on a missing price.
  prices?: () => Record<string, number>;
  // One ledger read, for the demo rails alone: a demo move changes the fixture's balances and
  // the settling row has to be judged against the read that shows it. Absent means a demo move
  // waits for the app's own poll instead.
  refresh?: () => Promise<unknown>;
};

export function createRails(deps: RailDeps): RailRegistry {
  if (deps.cfg.mode === 'demo') {
    return demoRails({ cfg: deps.cfg, refresh: deps.refresh ?? (async () => undefined) });
  }

  /* ONE 1Click client for every rail that talks to 1Click, built here and injected.
     Each rail used to construct its own, and the client caches the token list per instance
     (src/intents.ts:415-428), so five rails meant five fetches of the same ~186-row list and
     five copies of it in memory. Sharing the instance makes the first rail to ask pay for it
     and the rest read the cache. The rails still accept their own client, which is what the
     tests inject. */
  const client = oneClickClient();

  /* ONE preflight for the two rails whose payout lands on a chain, so the hour of gas
     readings it keeps is one hour (src/preflight/live.ts). A HyperCore deposit ends in the
     vendor's Arbitrum sweep and a payout ends on the chain the draft names; both run the
     checks on the live quote before the intent is generated. */
  const preflight = createLivePreflight({ prices: deps.prices ?? (() => ({})) });

  /* BOTH SWAP RAILS, whatever the switch says. The switch decides which venue proposeSwap
     stamps on a new draft; a row already on disk names the venue it was written under, and
     that is the rail that must answer for it (a held retry, a reconcile), or a flip of the
     switch would strand every open swap of the other kind. */
  const relaySwap = intentsRelayRail({
    keysPath: deps.cfg.keysPath,
    tokens: deps.tokens,
    client,
  }) as Rail;
  const oneClickSwap = intentsNativeRail({
    keysPath: deps.cfg.keysPath,
    tokens: deps.tokens,
    client,
  }) as Rail;
  const defaultSwap = swapRailOf(deps.cfg) === 'relay' ? relaySwap : oneClickSwap;
  const swapFor = (draft: WriteDraft): Rail => {
    const venue = (draft as { venue?: unknown }).venue;
    if (venue === INTENTS_RELAY_VENUE) return relaySwap;
    if (venue === 'intents-native') return oneClickSwap;
    // No venue on the draft (a bare kind, a row from before venues were stamped): the switch decides.
    return defaultSwap;
  };

  const table: Record<RailKind, Rail> = {
    swap: defaultSwap,
    hl_deposit: hypercoreDepositRail({
      keysPath: deps.cfg.keysPath,
      client,
      preflight,
    }) as Rail,
    hl_withdraw: hypercoreWithdrawRail({
      keysPath: deps.cfg.keysPath,
      client,
    }) as Rail,
    // The two rails whose destination is somebody else's: a send stays inside the verifier and
    // reads the receiver's balance back as the proof; a pay leaves it for an address on a real
    // chain and carries the payout hash. Neither is ever skipped past the click.
    intents_send: intentsSendRail({
      keysPath: deps.cfg.keysPath,
      client,
    }) as Rail,
    intents_pay: intentsPayRail({
      keysPath: deps.cfg.keysPath,
      tokens: deps.tokens,
      client,
      preflight,
    }) as Rail,
    trade: tradeRail(deps.trade) as Rail,
  };

  const relayReads = relayClient();
  const verifier = liveVerifier();

  return {
    for: (draft: WriteDraft) => (draft.kind === 'swap' ? swapFor(draft) : isRailKind(draft.kind) ? table[draft.kind] : null),
    kinds: () => [...RAIL_KINDS],
    relay: {
      status: (intentHash) => relayReads.status(intentHash),
      nonceUsed: (accountId, nonce) => verifier.nonceUsed(accountId, nonce),
      saltValid: (salt) => verifier.isValidSalt?.(salt) ?? Promise.resolve(null),
    },
    swap: {
      tokens: () => client.tokens(),
      balance: (accountId, assetId) => verifier.balance(accountId, assetId).catch(() => null),
      activity: (accountId, limit) => intentsActivity(accountId, limit, { keys: deps.cfg.chainscan }),
    },
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

  // Hyperliquid funding used to add Bridge2's address here. It spends the intents balance now,
  // so its counterparty is the verifier, the entry added a few lines down.

  // 1Click mints a fresh deposit address per quote, so no address of its own can ever sit
  // on a static list; the venue string is the allowlist entry, and the Hyperliquid withdraw
  // rail names it (src/intents.ts).
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
