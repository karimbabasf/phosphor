// The policy engine. Pure, no IO: it takes a draft plus a snapshot of the world and returns
// one of exactly three outcomes. There is no override path and no fourth outcome, so every
// caller either gets `allow` (small enough to auto-execute), `needs_approval` (a human clicks)
// or `refuse` (nothing happens).
//
// Two habits run through this file, both because a wrong answer here loses money:
//   1. Fail closed. Missing policy, missing quote, unreadable numbers and unknown issuers all
//      resolve to the pessimistic reading.
//   2. Never trust the draft's own arithmetic. The agent authors the draft, so declared totals
//      and declared usd values are treated as claims and re-derived from the legs.
//
// Rule order is normative (see the plan's Task D section). First refusal wins; reasons
// accumulate so the UI can show the whole chain of reasoning, not just the last line.

import { z } from 'zod';
import { isRailKind } from '../rails/kinds.ts';
import type { CompositionView, LedgerSnapshot, Policy, PolicyPatch, Verdict, WriteDraft } from '../types.ts';

export type EngineCtx = {
  policy: Policy | null;
  composition: CompositionView;
  ledger: LedgerSnapshot;
  sessionSpentUsd: number;
  // Auto-approved fund-moving usd in the same 24h window: only rows a policy 'allow' executed,
  // never a human click. Optional so every existing EngineCtx literal stays valid; absent is 0.
  autoApprovedSpentUsd?: number;
  selfAddresses: string[];
};

// Structural shape of a PolicyPatch on the wire. Strict everywhere: an unknown key is an
// invalid patch rather than a silently ignored one, since a patch that half applies is worse
// than a patch that is refused.
/* An upper bound as well as a lower one. Not a policy judgement: a cap of 1e308 is still a
   finite number, and every comparison downstream is arithmetic on it. Beyond the safe integer
   range the arithmetic stops being reliable, so a patch asking for it is refused as malformed
   rather than accepted and quietly rounded. The rules that stop a cap being RAISED too far are
   in policyChangeCeiling below, because those need the policy in force to compare against. */
const usdField = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER);
const shareField = z.number().finite().min(0).max(1);
const patchSchema = z
  .object({
    outbound: z
      .object({
        maxPerTransactionUsd: usdField.optional(),
        maxPerSessionUsd: usdField.optional(),
        humanClickAboveUsd: usdField.optional(),
        autoApproveDailyUsd: usdField.optional(),
        destinationAllowlist: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    composition: z
      .object({
        maxIssuerShare: z.record(z.string(), shareField).optional(),
        maxFreezableShare: shareField.optional(),
        forbiddenIssuers: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

// Fields a patch may never reach. killSwitch is human-only hardware; version and sentences are
// what the human reads to know what the policy is.
const UNPATCHABLE = ['killSwitch', 'version', 'sentences'];

/* HOW FAR ONE PATCH MAY MOVE THE WALLS, and why there is a limit at all.

   A policy change is the one draft that removes the controls on every draft after it, and until
   now the only thing standing in front of it was a click on a card that named the change in the
   agent's own words. `humanClickAboveUsd: 1e9` with the sentence "cap the freezable share"
   came back needs_approval, so the whole attack was one click on a card that said "Change your
   limits" and nothing else. The card now renders the diff (src/view/basic.ts), and these three
   rules are the half that does not depend on anybody reading it.

   They are RELATIVE to the policy in force rather than absolute, because an absolute dollar
   ceiling is a number nobody can justify: it is wrong for a wallet holding $500 and wrong for
   one holding $5m. Ten times is a wall a legitimate change walks up to in steps, each of them
   read and clicked, and it is a wall an "adjust the freezable cap" patch never touches. */
const MAX_RAISE_FACTOR = 10;

/* A patch that names no rule at all. `{}` is what a caller sends when it forgets the field:
   asRecord in src/http/respond.ts turns a missing `patch` into an empty object, and the MCP
   schema is `z.object({}).passthrough()`, so both a missing patch and an empty one arrive here
   the same way. Both used to park as needs_approval, which put a card in front of a person
   asking them to click yes to a change of nothing. That is worse than a wasted click: the whole
   weight of this app rests on a click meaning something, and a click that changes nothing is
   practice at clicking yes.
   `{ outbound: {} }` counts as empty too, which is why this looks at the leaves rather than at
   the top-level keys. */
function patchNamesNothing(patch: PolicyPatch): boolean {
  return [patch.outbound, patch.composition].every(
    group => group === undefined || Object.values(group).every(value => value === undefined),
  );
}

// The caps that get looser as they get bigger. The share fields are already bounded at 1 by
// their own schema, so they do not belong here.
const RAISABLE_CAPS = ['maxPerTransactionUsd', 'maxPerSessionUsd', 'humanClickAboveUsd', 'autoApproveDailyUsd'] as const;

function policyChangeCeiling(patch: PolicyPatch, policy: Policy, reasons: string[]): Verdict | null {
  const o = patch.outbound;
  if (o === undefined) return null;

  /* A click threshold above the transaction cap is a click threshold that never fires: every
     move small enough to be allowed at all is then small enough to auto-execute. Checked against
     the cap as it would stand AFTER the patch, and only when the patch is the thing RAISING the
     threshold. A patch that merely lowers the transaction cap under a threshold it never touched
     is a tightening, and refusing a tightening is the wrong direction to fail in.
     First, because it names the specific thing being asked for. Raising the threshold past the
     cap also trips the ten-times rule below, and "nothing would ever wait for you" is the more
     useful sentence to hand somebody. */
  if (o.humanClickAboveUsd !== undefined && o.humanClickAboveUsd > policy.outbound.humanClickAboveUsd) {
    const perTransaction = o.maxPerTransactionUsd ?? policy.outbound.maxPerTransactionUsd;
    if (o.humanClickAboveUsd > perTransaction) {
      return refusal(
        reasons,
        'click_threshold_above_cap',
        `This patch would ask for a click above ${money(o.humanClickAboveUsd)} while refusing anything above ${money(perTransaction)}, so nothing would ever wait for you. Lower the click threshold, or raise the transaction limit first.`,
      );
    }
  }

  for (const field of RAISABLE_CAPS) {
    const next = o[field];
    if (next === undefined) continue;
    // autoApproveDailyUsd is the one raisable cap that can be absent on an old policy. A field
    // that was never set is not one this patch is RAISING, so setting it is not gated by the
    // raise factor; it is just a value being written for the first time.
    const current = policy.outbound[field];
    if (current === undefined) continue;
    if (next <= current) continue;
    /* Zero is not a small number here, it is a different policy: humanClickAboveUsd at 0 means
       every action waits for a person, and maxPerTransactionUsd at 0 means nothing moves. Ten
       times zero is zero, so raising either is not a step, it is a reversal, and a person writes
       that in the file themselves. */
    if (current === 0) {
      return refusal(
        reasons,
        'cap_raised_from_zero',
        `This patch raises ${field} from ${money(0)} to ${money(next)}. A limit of zero is not a small limit, it is a rule that nothing passes, and lifting it is a decision for the policy file rather than for a patch.`,
      );
    }
    if (next > current * MAX_RAISE_FACTOR) {
      return refusal(
        reasons,
        'cap_raised_too_far',
        `This patch raises ${field} from ${money(current)} to ${money(next)}, more than ${MAX_RAISE_FACTOR} times. One change may loosen a limit by up to ${MAX_RAISE_FACTOR} times; past that, make it in steps you read each time.`,
      );
    }
  }

  /* The allowlist is REPLACED rather than merged (see mergePatch), so a patch carrying one
     address deletes every other one. Adding is fine and is the reason the field exists;
     dropping an address a person put there is a removal dressed as an addition, and it is the
     removals that a diff read in a hurry is most likely to miss. */
  if (o.destinationAllowlist !== undefined) {
    const next = new Set(o.destinationAllowlist.map(lower));
    const dropped = policy.outbound.destinationAllowlist.filter(a => !next.has(lower(a)));
    if (dropped.length > 0) {
      return refusal(
        reasons,
        'allowlist_shortened',
        `This patch drops ${dropped.length} allowed destination(s) (${dropped.join(', ')}). A patch may add destinations; removing one is a decision for the policy file.`,
      );
    }
  }

  return null;
}

function lower(s: string): string {
  return s.toLowerCase();
}

/* ---------- who counts as one of our own addresses ----------

   This used to be one lowercased Set, which is right for an EVM address and wrong for base58.
   src/rails/intents-withdraw.ts states the rule: "base58 case carries key material, and two
   strings differing only in case are two different accounts." The rail compares case-correctly
   and catches it; this layer, which is meant to hold regardless of which rail ran, did not. A
   Solana payout to a case variant of our address is not theft, it is a total loss.

   So a Solana-shaped destination is compared EXACTLY, and everything else keeps the
   case-insensitive comparison it had: an EVM address has two legitimate spellings of the same
   20 bytes, a NEAR account id is lowercase by its own rule, and a venue string on the allowlist
   is not an address at all.

   The shape test only decides WHICH comparison to use. It is not an address check, and the rails
   decode properly before anything is signed. `0x` prefixed hex cannot match it, because 0 is not
   in the base58 alphabet, and neither can a NEAR id, which is either 64 hex characters or
   carries a dot. */
const SOLANA_SHAPED = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/* The two sets, and why there are two.
   src/proposals/lifecycle.ts lowercases every address before it reaches this engine, so the real
   casing of a configured address does not survive the trip. The ledger's holdings do carry it,
   and so does the policy allowlist, and those are the two places an exact spelling can come from.

   A Solana destination matches when it is one of those exact spellings. When NO exact spelling
   for it exists anywhere, the engine has only the lowercased copy and genuinely cannot tell the
   two apart, so it allows rather than refusing an address that may well be ours. That case is a
   chain we hold nothing on, where the exact spelling never reached this layer at all. */
type AddressSet = { exact: Set<string>; lowered: Set<string> };

function addressSet(lowered: string[], exact: string[]): AddressSet {
  return {
    exact: new Set(exact.map((a) => a.trim())),
    lowered: new Set([...lowered, ...exact].map((a) => lower(a.trim()))),
  };
}

function isOurs(set: AddressSet, destination: string): boolean {
  const value = destination.trim();
  if (!SOLANA_SHAPED.test(value)) return set.lowered.has(lower(value));
  if (set.exact.has(value)) return true;
  // An exact spelling exists for this account and it is not the one we were handed.
  const contradicted = [...set.exact].some((a) => lower(a) === lower(value));
  return !contradicted && set.lowered.has(lower(value));
}

function money(usd: number): string {
  return '$' + usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function refusal(reasons: string[], rule: string, line: string): Verdict {
  return { outcome: 'refuse', reasons: [...reasons, line], rule };
}

// The rail kinds (a swap, the Hyperliquid and intents moves, a trade) hand funds to a
// venue and get something else back, so there is no from-chain/to-chain pair to walk.
// They are governed on their own branch. Anything with no branch is refused as
// 'unknown_kind', which is fail-closed by design.
type RailDraft = Extract<WriteDraft, { counterparty: string } | { kind: 'hl_deposit' }>;

// The kind list is not repeated here, and it does not come from the rail registry either.
//
// Repeating it cost an afternoon: a kind added to the registry and missing from the copy here
// did not throw, it fell past the rail branch into the fund-move branch, found no legs, and
// was refused as 'nothing_to_move'. A refusal whose stated reason had nothing to do with the
// real cause. The value checked was not the value used, which is the shape of every real bug
// in this build.
//
// Importing the registry instead would fix the drift and break something else: the engine is
// the part that decides whether money moves, and it stays pure, with no config, RPC host or
// deployment table in its module graph. ../rails/kinds.ts is the list on its own, importing
// no runtime code, so both sides read the same one and neither pulls in the other.
function isRailDraft(draft: WriteDraft): draft is RailDraft {
  return isRailKind(draft.kind);
}

// Where the funds actually go. This is the address the allowlist has to bless, and it is
// a contract we chose rather than an arbitrary recipient, which is why rails get an
// allowlist check on the venue instead of the leg-destination check.
function counterpartyOf(draft: RailDraft): string {
  return draft.counterparty;
}

// Where the OUTPUT lands, which is a different question from who we hand the funds to.
// A swap hands a balance to the verifier and the verifier credits draft.to; allowlisting
// only the verifier says nothing about who receives the proceeds, and an account id we hold
// no key for is a balance that exists, reads as a success, and can never be spent by anyone
// but its owner. Returns null when the kind has no destination.
function destinationOf(draft: RailDraft): string | null {
  if (draft.kind === 'swap') return draft.to;
  // intents_send is the one draft whose `to` is meant to be somebody else's account, and this
  // is the rule that decides whose: one of ours, or an entry a human put on the allowlist.
  if (draft.kind === 'intents_send') return draft.to;
  // hl_deposit gained one on 2026-08-20. The old Bridge2 mechanism credited whoever sent the
  // tokens, so there was nothing here to check; the 1Click route names the account it credits,
  // so funding a Hyperliquid account that is not ours is now a thing this can refuse.
  if (draft.kind === 'hl_deposit') return draft.hlAccount;
  // hl_withdraw lands inside the verifier, in the account the app's own key owns. The rail
  // refuses any other `to`; this is the same rule in the layer that does not depend on which
  // rail ran, and the reason a withdraw tool with no destination field is still governed.
  if (draft.kind === 'hl_withdraw') return draft.to;
  return null;
}

// Rule 3. A policy change is the one draft that can never be auto-executed.
function evaluatePolicyChange(draft: Extract<WriteDraft, { kind: 'policy_change' }>, policy: Policy, reasons: string[]): Verdict {
  const patch = draft.patch as unknown as Record<string, unknown>;
  const raw = patch !== null && typeof patch === 'object' ? patch : {};

  // Checked before the schema so an attempt on the kill switch is named as such rather than
  // reported as a generic unknown key.
  const forbidden = UNPATCHABLE.filter(k => Object.prototype.hasOwnProperty.call(raw, k));
  if (forbidden.length > 0) {
    return refusal(
      reasons,
      'kill_switch_not_patchable',
      `A patch may not touch ${forbidden.join(', ')}: the kill switch, the version and the policy sentences are human-only.`,
    );
  }

  /* An ABSENT patch, before the schema gets to call it malformed. It is the same ask as an empty
     one and deserves the same answer: over HTTP a missing field already arrives as `{}` (asRecord
     in src/http/respond.ts), so leaving this to the schema would have made the engine's answer
     depend on which door the caller used. A patch that is present but is not an object is a
     different fault and stays `invalid_patch`. */
  if (draft.patch === undefined || draft.patch === null) {
    return refusal(reasons, 'nothing_to_change', 'Patch names no rule, so there is nothing to change and nothing to approve.');
  }

  const parsed = patchSchema.safeParse(draft.patch);
  if (!parsed.success) {
    const detail = parsed.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    return refusal(reasons, 'invalid_patch', `Patch is not a valid policy change: ${detail}`);
  }

  // Same shape as nothing_to_move for a draft with no legs, and for the same reason: an empty
  // ask is refused where it is made rather than carried to a human as a decision.
  if (patchNamesNothing(parsed.data as PolicyPatch)) {
    return refusal(reasons, 'nothing_to_change', 'Patch names no rule, so there is nothing to change and nothing to approve.');
  }

  const tooFar = policyChangeCeiling(parsed.data as PolicyPatch, policy, reasons);
  if (tooFar !== null) return tooFar;

  reasons.push('Policy changes always require a human click.');
  return { outcome: 'needs_approval', reasons };
}

// A rail hands funds to a venue contract. What can be checked is the size of the move and
// who is receiving it; what cannot be checked is a post-move composition, because the
// engine does not know what a pool or an exchange will hand back. So this branch enforces
// the money rules strictly and is honest about the rest rather than inventing a post-state.
function evaluateRail(draft: RailDraft, policy: Policy, ctx: EngineCtx, reasons: string[]): Verdict {
  const usd = draft.amountUsd;
  const counterparty = counterpartyOf(draft);
  reasons.push(`${draft.kind} of ${money(usd)} to ${counterparty}.`);

  if (!Number.isFinite(usd) || usd <= 0) {
    return refusal(reasons, 'invalid_amount', `${draft.kind} declares ${usd} USD, which cannot be checked against a limit.`);
  }

  // The venue must be explicitly blessed. Unlike a transfer, the recipient here is a
  // contract the app chose, so an unknown one means either a misconfiguration or a
  // rail pointed somewhere it should not be. Both are refusals.
  const allowed = addressSet(ctx.selfAddresses, [
    ...ctx.ledger.holdings.map((h) => h.address),
    ...policy.outbound.destinationAllowlist,
  ]);
  if (!isOurs(allowed, counterparty)) {
    return refusal(
      reasons,
      'destination_not_allowed',
      `${draft.kind} sends funds to ${counterparty}, which is not on the allowlist. Add the venue to the policy before using this rail.`,
    );
  }

  // The proceeds, checked separately and against the same list. Allowlisting the router a
  // swap passes through says nothing about who receives what comes out of it: a draft naming
  // the real router as counterparty and an attacker's address as `to` would otherwise pass
  // every rule here and auto-execute under the click threshold. The tool surface does not
  // currently expose `to`, which is what stops that today, but a governance rule that holds
  // only because of the shape of the caller is not a governance rule.
  const destination = destinationOf(draft);
  if (destination !== null && !isOurs(allowed, destination)) {
    return refusal(
      reasons,
      'destination_not_allowed',
      `${draft.kind} would deliver the proceeds to ${destination}, which is neither one of our own addresses nor on the allowlist.`,
    );
  }

  if (usd > policy.outbound.maxPerTransactionUsd) {
    return refusal(
      reasons,
      'max_per_transaction',
      `${money(usd)} is above the ${money(policy.outbound.maxPerTransactionUsd)} per-transaction limit.`,
    );
  }

  if (ctx.sessionSpentUsd + usd > policy.outbound.maxPerSessionUsd) {
    return refusal(
      reasons,
      'max_per_session',
      `${money(ctx.sessionSpentUsd)} already moved this session plus ${money(usd)} is above the ${money(policy.outbound.maxPerSessionUsd)} session limit.`,
    );
  }

  if (usd > policy.outbound.humanClickAboveUsd) {
    reasons.push(`${money(usd)} is above the ${money(policy.outbound.humanClickAboveUsd)} click threshold.`);
    return { outcome: 'needs_approval', reasons };
  }

  const ceiling = autoApproveCeilingReason(policy, ctx, usd);
  if (ceiling !== null) {
    reasons.push(ceiling);
    return { outcome: 'needs_approval', reasons };
  }

  reasons.push('Within every limit.');
  return { outcome: 'allow', reasons };
}

export function evaluate(draft: WriteDraft, ctx: EngineCtx): Verdict {
  const reasons: string[] = [];

  // 1. No readable policy means no writes at all.
  if (ctx.policy === null) {
    return refusal(reasons, 'policy_unreadable', 'Policy file is unreadable, so every write is refused.');
  }
  const policy = ctx.policy;

  // 2. The kill switch outranks everything below it.
  if (policy.killSwitch) {
    return refusal(reasons, 'kill_switch', 'Kill switch is on: all writes refused.');
  }

  // 3. Policy changes.
  if (draft.kind === 'policy_change') return evaluatePolicyChange(draft, policy, reasons);

  // 3b. Rails: a swap, the Hyperliquid moves, the intents moves, a trade.
  if (isRailDraft(draft)) return evaluateRail(draft, policy, ctx, reasons);

  // Nothing else moves money. A kind this engine does not know (a row from an older build, or
  // a draft no rail answers for) is refused rather than guessed at.
  const kind = (draft as { kind: string }).kind;
  return refusal(reasons, 'unknown_kind', `${kind} is not a kind this app moves money for.`);
}

/* The auto-approved daily ceiling, checked only for a move that would otherwise be allowed (a
   move above the click threshold already waits, and keeps its own reason). Past the ceiling the
   next auto move waits for a click, so a stream of sub-threshold moves cannot run unattended up
   to the whole session cap. Returns the reason to push, or null when the ceiling does not bind
   or is not set. */
function autoApproveCeilingReason(policy: Policy, ctx: EngineCtx, usd: number): string | null {
  const ceiling = policy.outbound.autoApproveDailyUsd;
  if (ceiling === undefined) return null;
  const spent = ctx.autoApprovedSpentUsd ?? 0;
  if (spent + usd <= ceiling) return null;
  return `Auto-approved moves in the last 24 hours already total ${money(spent)}; with ${money(usd)} more that passes the ${money(ceiling)} ceiling, so this one waits for a click.`;
}
