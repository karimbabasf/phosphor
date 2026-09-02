// The rail venues an existing policy.json does not allow, and the one proposal that offers to
// add them.
//
// A FRESH install seeds the allowlist with every rail venue (see src/main.ts). An EXISTING
// policy.json is never rewritten, not even to add one, because an app whose whole claim is that
// software does not change the rules behind your back cannot change the rules behind your back.
// So on every install that predates a venue, the contracts this version verified on chain were
// named once in the audit log and then left out, and evaluateRail refuses an unlisted
// counterparty OUTRIGHT rather than as needs_approval: those rails were not gated, they were
// dead, and the only sentence anybody saw was one about an allowlist nobody was going to edit.
//
// A proposal is the way out that keeps the claim intact. The app asks, a person clicks, and the
// decision card carries the exact addresses being added as a policy diff. Nothing here can
// approve itself: evaluatePolicyChange returns needs_approval for every patch there has ever
// been, and this files the proposal through the same door an agent's would come through.
//
// Deduplicated by CONTENT rather than by a flag on disk, so the second boot after a person has
// left the proposal sitting does not file a second one, and a proposal that covers only some of
// what is missing does not suppress one that covers the rest.

import type { ChainId, Policy, PolicyPatch, Proposal } from '../types.ts';
import type { Audit } from '../audit.ts';
import { verifiedVenueContracts } from '../rails/index.ts';

const CHAIN_NAMES: Record<string, string> = {
  eth: 'Ethereum',
  base: 'Base',
  arb: 'Arbitrum',
  sol: 'Solana',
  near: 'NEAR',
};

const COUNTS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];

function count(n: number): string {
  return n < COUNTS.length ? COUNTS[n] : String(n);
}

// "Arbitrum and Base", "Arbitrum, Base and Ethereum".
function joinWords(words: string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

const lower = (s: string): string => s.toLowerCase();

/* What the seeded list holds that the policy in force does not. Venue STRINGS are included as
   well as contract addresses: a rail whose counterparty is `intents.near` is just as dead
   without its entry as one whose counterparty is a Uniswap router. */
export function missingVenues(policy: Policy | null, seeded: readonly string[]): string[] {
  if (policy === null) return [];
  const allowed = new Set(policy.outbound.destinationAllowlist.map(lower));
  return seeded.map(lower).filter((venue) => !allowed.has(venue));
}

/* The sentence on the decision card. It names how many contracts, which venues and which chains,
   and it is built from what is actually missing rather than written down, so it can never say
   six when two are being added. With every mainnet contract missing, which is the case on an
   install that predates them, it reads:

     Allow the six contracts this version of Phosphor verified on chain
     (Aave on Arbitrum and Base, Uniswap on Arbitrum and Base) */
export function venueGapSentence(missing: readonly string[]): string {
  const known = new Map(verifiedVenueContracts().map((v) => [lower(v.address), v]));
  const contracts = missing.map(lower).filter((address) => known.has(address));

  const byVenue = new Map<string, Set<ChainId>>();
  for (const address of contracts) {
    const found = known.get(address);
    if (found === undefined) continue;
    const chains = byVenue.get(found.venue) ?? new Set<ChainId>();
    chains.add(found.chain);
    byVenue.set(found.venue, chains);
  }

  const parts = [...byVenue]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([venue, chains]) => `${venue} on ${joinWords([...chains].map((c) => CHAIN_NAMES[c] ?? c).sort())}`);

  const noun = contracts.length === 1 ? 'contract' : 'contracts';
  const head = `Allow the ${count(contracts.length)} ${noun} this version of Phosphor verified on chain`;
  const named = parts.length === 0 ? '' : ` (${parts.join(', ')})`;

  // Venue strings are not contracts and there is nothing to verify on chain about them, so they
  // are named separately rather than counted in with the addresses.
  const venueStrings = missing.map(lower).filter((address) => !known.has(address));
  const also = venueStrings.length === 0 ? '' : `, and allow ${joinWords(venueStrings)}`;

  return `${head}${named}${also}`;
}

// A proposal that already offers everything currently missing. Waiting on a click or waiting on
// the lock both count: neither is a reason to file a second one.
export function pendingVenueGap(list: readonly Proposal[], missing: readonly string[]): Proposal | undefined {
  const wanted = missing.map(lower);
  return list.find((p) => {
    if (p.kind !== 'policy_change') return false;
    if (p.status !== 'pending' && p.status !== 'pending_unlock') return false;
    if (p.draft.kind !== 'policy_change') return false;
    const offered = new Set((p.draft.patch.outbound?.destinationAllowlist ?? []).map(lower));
    return wanted.every((venue) => offered.has(venue));
  });
}

/* One proposal, or none. Returns what it filed so a caller can log it; null means there was
   nothing to ask for, or the question is already on screen. */
export async function proposeVenueGap(deps: {
  policy: Policy | null;
  seeded: readonly string[];
  list: () => Proposal[];
  propose: (params: { patch: PolicyPatch; sentence: string }) => Promise<Proposal>;
  audit: Pick<Audit, 'append'>;
}): Promise<Proposal | null> {
  const missing = missingVenues(deps.policy, deps.seeded);
  if (missing.length === 0 || deps.policy === null) return null;

  const already = pendingVenueGap(deps.list(), missing);
  if (already !== undefined) {
    deps.audit.append('proposal_created', `the venue allowlist is still short, and proposal ${already.id} already asks to fix it`, {
      id: already.id,
      missing,
    });
    return null;
  }

  /* The patch carries the WHOLE list it wants in force, because mergePatch replaces
     destinationAllowlist rather than appending to it. Existing entries first and unchanged, so
     the diff a person reads is exactly the addresses being added. */
  const patch: PolicyPatch = {
    outbound: { destinationAllowlist: [...deps.policy.outbound.destinationAllowlist, ...missing] },
  };
  const filed = await deps.propose({ patch, sentence: venueGapSentence(missing) });
  deps.audit.append('proposal_created', `asked to allow ${missing.length} rail venue(s) the policy does not list`, {
    id: filed.id,
    missing,
  });
  return filed;
}
