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
import { classify } from '../composition.ts';
import type { Position } from '../composition.ts';
import type { CompositionView, Policy, PolicyAxisChange, PolicyPatch, RiskRow, Verdict, WriteDraft } from '../types.ts';

export type EngineCtx = {
  policy: Policy | null;
  // What is held now, by issuer and freeze power, over the intents balances and the trading
  // account. The composition rules judge the state a move would leave behind, built from this.
  composition: CompositionView;
  // The risk table, for classifying an asset a move would bring in that nothing holds yet.
  // Optional so every hand-built context stays valid; absent, an unknown asset is unclassified
  // and counts as freezable, which is the pessimistic answer.
  riskRows?: RiskRow[];
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

/* HOW FAR ONE PATCH MAY MOVE THE WALLS, and why the ten-times rule is gone.

   A policy change is the one draft that removes the controls on every draft after it, so for a
   month one patch could not loosen a limit by more than ten times, and raising one from zero was
   refused outright. Both rules existed to force a human to read what was happening.

   THEY WERE PAYING FOR SOMETHING ALREADY BOUGHT. propose_policy_change is in ALWAYS_CLICK_TOOLS
   (src/persona.ts): it never auto-executes at any size, and the card renders the change as a
   before and after diff of the sentences a person actually reads. So the human read it once and
   clicked. The staircase bought a second click on the same sentence and nothing else, and what
   it cost was ordinary: setting the ask threshold from its $1 starting point to $100 took two
   approvals of the same decision, and the refusal blamed the person for asking plainly.

   WHAT IS LEFT IS THE RULE THAT IS ABOUT COHERENCE RATHER THAN SIZE. A click threshold above the
   hard cap means nothing ever waits for anybody, and that is not a loosening a person can read
   off the sentence, because each number looks reasonable on its own. It is checked in both
   directions now: raising the ask past the cap is refused, and lowering the cap under the ask is
   clamped rather than refused, because refusing a tightening fails in the wrong direction. */

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

/* WHAT A CLICK IS ACTUALLY AGREEING TO, and the check that the sentence is about it.

   The card shows the agent's own sentence. The file gets the agent's patch. Nothing held the
   two together, so the audit's one-click walk carried the sentence "adjust the freezable cap"
   over a patch that set every money limit to nine quadrillion dollars: a person read a sentence
   about issuer exposure and clicked away every spending wall in the app. The rendered diff is a
   compensating control on a surface this file does not own, and it is the only one there was.

   So every money axis the patch moves has to be NAMED IN THE SENTENCE, with its new figure.
   That is a cheap thing for an honest patch to satisfy, since the sentence exists to describe
   the change, and it is not satisfiable at all by a sentence about something else.

   THE MATCH IS DELIBERATELY FORGIVING ABOUT SPELLING and strict about the number. Dollars,
   thousands separators and trailing cents are stripped from the sentence before the figure is
   looked for, so "$1,000", "1000" and "$1,000.00" all name a thousand; the boundary check is
   what keeps "$1,000" from counting as naming a hundred. */
function namesFigure(sentence: string, value: number): boolean {
  const plain = sentence.replace(/[$,]/g, '');
  return [String(value), value.toFixed(2)].some((spelling) => {
    const pattern = new RegExp(`(?<![\\d.])${spelling.replace(/\./g, '\\.')}(?!\\d)`);
    return pattern.test(plain);
  });
}

/* The money axes, before and after, for the card to print. `factor` is how far the number moved,
   which is the one thing a reader cannot get from two figures at a glance ("$1 to $100" and
   "$10,000 to $1,000,000" read the same until you count the zeros). Null where the old value was
   zero, because every multiple of nothing is nothing. */
const MONEY_AXES = ['maxPerTransactionUsd', 'maxPerSessionUsd', 'humanClickAboveUsd', 'autoApproveDailyUsd'] as const;

export function policyChanges(patch: PolicyPatch, policy: Policy): PolicyAxisChange[] {
  const o = patch.outbound;
  if (o === undefined) return [];
  const out: PolicyAxisChange[] = [];
  for (const axis of MONEY_AXES) {
    const after = o[axis];
    if (after === undefined) continue;
    const before = policy.outbound[axis] ?? 0;
    if (after === before) continue;
    out.push({ axis, before, after, factor: before > 0 ? Math.round((after / before) * 100) / 100 : null });
  }
  return out;
}

function sentenceMismatch(changes: PolicyAxisChange[], sentence: string, reasons: string[]): Verdict | null {
  const unsaid = changes.filter((c) => !namesFigure(sentence, c.after));
  if (unsaid.length === 0) return null;
  return refusal(
    reasons,
    'sentence_mismatch',
    `The sentence on this change does not name ${unsaid.map((c) => `${c.axis} at ${money(c.after)}`).join(', ')}, so a person clicking it would be agreeing to something it does not say. Write the sentence the change actually makes, with every figure in it.`,
  );
}

/* THE CEILING NO CLICK CAN PASS, per axis, in dollars.

   Every other rule here bounds a patch against the policy in force, which means a determined
   sequence of clicks walks anywhere: the walls are relative, so each step looks small beside the
   one before it. This one is absolute. Above it the patch is refused however it is worded and
   however many times it is asked, and the only way past is a person opening policy.json in an
   editor, which is a different act from clicking yes on a card an agent wrote.

   The numbers are the largest figure each axis could carry and still be a wallet somebody is
   operating by hand rather than a limit that has stopped meaning anything. A person who wants
   more edits the policy file. */
export const AXIS_CEILING_USD: Readonly<Record<'maxPerTransactionUsd' | 'maxPerSessionUsd' | 'humanClickAboveUsd' | 'autoApproveDailyUsd', number>> = {
  maxPerTransactionUsd: 1_000_000,
  // The ask threshold lives under the cap by the rule below, so this is a second wall behind
  // that one rather than a different number to reason about.
  humanClickAboveUsd: 1_000_000,
  maxPerSessionUsd: 10_000_000,
  autoApproveDailyUsd: 10_000_000,
};

function aboveCeiling(patch: PolicyPatch, reasons: string[]): Verdict | null {
  const o = patch.outbound;
  if (o === undefined) return null;
  for (const [axis, ceiling] of Object.entries(AXIS_CEILING_USD) as Array<[keyof typeof AXIS_CEILING_USD, number]>) {
    const next = o[axis];
    if (next === undefined) continue;
    // Finite is already the schema's job; it is asserted again because this is the wall that is
    // supposed to hold when something upstream of it does not.
    if (!Number.isFinite(next) || next > ceiling) {
      return refusal(
        reasons,
        'above_ceiling',
        `${axis} cannot go past ${money(ceiling)} through a patch, and this asks for ${money(next)}. That ceiling is not a rule a click can move: a person edits policy.json to go higher.`,
      );
    }
  }
  return null;
}

/* NOTHING EVER ASKS, CHECKED ON THE POLICY THE PATCH WOULD LEAVE BEHIND.

   The ask threshold decides `allow` against `needs_approval`, and the hard cap decides
   `needs_approval` against `refuse`. Set the ask at or above the cap and the middle band is
   empty: every move small enough to be allowed at all is also small enough to run with nobody
   watching. That is the one policy state a person cannot read off either number on its own,
   because each of them looks reasonable alone.

   IT IS THE POST-PATCH PAIR, not the direction of travel. The guard this replaces fired only
   when a patch RAISED the ask, so the identical collision reached by lowering the cap went
   straight through and the policy quietly stopped asking. This reads the two numbers the patch
   would leave in the file, whichever axis it names and whichever way each one moved.

   AND IT REFUSES RATHER THAN CLAMPING. The clamp that stood here for a day rewrote the ask down
   to the new cap and called it a tightening, which turned `{cap: 1000, ask: 2000}` against a
   $100 cap into a tenfold LOOSENING landing on cap == ask == 1000: the exact state this rule
   exists to prevent, reported in a sentence that was false in both halves. A patch nobody wrote
   is not a patch anybody clicked. The refusal names both numbers and the fix, and the pair goes
   in one patch, which is still one click. */
function collides(cap: number, ask: number): boolean {
  return ask >= cap;
}

function neverAsks(patch: PolicyPatch, policy: Policy, reasons: string[]): Verdict | null {
  const o = patch.outbound ?? {};
  const cap = o.maxPerTransactionUsd ?? policy.outbound.maxPerTransactionUsd;
  const ask = o.humanClickAboveUsd ?? policy.outbound.humanClickAboveUsd;
  if (!collides(cap, ask)) return null;
  return refusal(
    reasons,
    'never_asks',
    `Asking above ${money(ask)} and refusing above ${money(cap)} means nothing ever asks you: everything small enough to be allowed is also small enough to run on its own. Put the ask below the cap, both in the same patch.`,
  );
}

function policyChangeCeiling(patch: PolicyPatch, policy: Policy, reasons: string[]): Verdict | null {
  const o = patch.outbound;
  if (o === undefined) return null;

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

   One lowercased set. Every address here is an EVM address (two legitimate spellings of the
   same 20 bytes), a NEAR account id (lowercase by its own rule) or a venue string on the
   allowlist, which is not an address at all. The Solana-shaped exact comparison went with the
   Solana address book (2026-09-16): nothing this app holds is keyed by base58 any more. */
type AddressSet = Set<string>;

function addressSet(...lists: string[][]): AddressSet {
  return new Set(lists.flat().map((a) => lower(a.trim())));
}

function isOurs(set: AddressSet, destination: string): boolean {
  return set.has(lower(destination.trim()));
}

function money(usd: number): string {
  return '$' + usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/* A refusal carries its rule twice on purpose: `rule` is what it has always been, and
   `reasonCodes` is the list the agent and the eval grader read, so neither has to parse prose to
   learn WHY something was refused. Every refusal has exactly one code; a needs_approval verdict
   can carry several, or none. */
function refusal(reasons: string[], rule: string, line: string): Verdict {
  return { outcome: 'refuse', reasons: [...reasons, line], rule, reasonCodes: [rule] };
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
  // intents_send and intents_pay are the two drafts whose `to` is meant to be somebody else's,
  // and since 2026-09-17 this rule does not bind them (decision 3 of the new-user pass). The
  // allowlist was a second click that named the same address a day earlier; the gate for a
  // send is the card and the Touch ID sentence that show the full address and the chain, and
  // src/proposals/execute.ts land() holds every send to that click at any size. The
  // counterparty rule above still binds: the verifier is the only venue a send passes through.
  if (draft.kind === 'intents_send' || draft.kind === 'intents_pay') return null;
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

  const wanted = parsed.data as PolicyPatch;

  // The absolute wall first: a figure past it is refused whatever else the patch is doing, and
  // no rule under it can make a number that large safe.
  const tooBig = aboveCeiling(wanted, reasons);
  if (tooBig !== null) return tooBig;

  // Then the pair the patch would leave in the file: a policy that never asks is the one
  // outcome no later rule can make safe either.
  const empty = neverAsks(wanted, policy, reasons);
  if (empty !== null) return empty;

  const incoherent = policyChangeCeiling(wanted, policy, reasons);
  if (incoherent !== null) return incoherent;

  /* The sentence last, so a patch refused on its numbers is refused for its numbers rather than
     for how it was described. What survives to here is a coherent change under every wall, and
     the only question left is whether the sentence a person will read is about it. */
  const changes = policyChanges(wanted, policy);
  const lying = sentenceMismatch(changes, draft.sentence, reasons);
  if (lying !== null) return lying;

  reasons.push('Policy changes always require a human click.');
  return {
    outcome: 'needs_approval',
    reasons,
    // `limits_changed` says money limits moved, so it rides only when some did: a patch that
    // only touches composition changes no limit and says so by carrying neither.
    reasonCodes: changes.length > 0 ? ['limits_changed'] : [],
    changes,
  };
}

// Issuer for a symbol: what the composition says it holds, else the risk table, else
// 'unclassified' (the same pessimism as composition.ts).
function issuerOf(symbol: string, ctx: EngineCtx): string {
  const held = ctx.composition.rows.find(r => r.symbol === symbol);
  if (held !== undefined) return held.issuer;
  const risk = (ctx.riskRows ?? []).find(r => r.symbol === symbol);
  return risk ? risk.issuer : 'unclassified';
}

// A cap keyed 'circle' must still bind an issuer named 'Circle'; a silently unapplied cap is a
// money bug. Exact key first, then a case-insensitive scan, then the catch-all.
function issuerCap(issuer: string, caps: Record<string, number>): number {
  if (caps[issuer] !== undefined) return caps[issuer];
  const hit = Object.keys(caps).find(k => k !== 'default' && lower(k) === lower(issuer));
  if (hit !== undefined) return caps[hit];
  return caps.default ?? 1;
}

// classify() needs issuer and freeze power per symbol. The composition already carries them
// for what is held, and the risk table covers an asset a move brings in; a symbol in neither
// is left out so classify() applies its own pessimistic path.
function riskRowsFor(ctx: EngineCtx): RiskRow[] {
  const bySymbol = new Map<string, RiskRow>();
  for (const row of ctx.riskRows ?? []) bySymbol.set(row.symbol, row);
  for (const row of ctx.composition.rows) {
    if (!row.classified || bySymbol.has(row.symbol)) continue;
    bySymbol.set(row.symbol, {
      symbol: row.symbol,
      issuer: row.issuer,
      freezable: row.freezable,
      // Descriptive fields, never read by classify().
      freezeMechanism: '',
      reserveType: 'unknown',
      depegWorstUsd: 0,
      depegNote: '',
      sourceUrl: '',
    });
  }
  return [...bySymbol.values()];
}

/* The issued coins the portfolio would hold if this move landed, in dollars. Every rail draft
   moves a value the app priced (amountUsd), and what comes back is priced at the same dollars,
   which is what a cap on a share of the portfolio needs: a swap is value-neutral up to slippage,
   a send leaves for good, a Hyperliquid move keeps USDC as USDC in a pocket we own, and a trade
   moves nothing off the venue. Clones, never mutates. */
function postPositions(draft: RailDraft, ctx: EngineCtx): Position[] {
  const positions: Position[] = ctx.composition.rows.map(r => ({ symbol: r.symbol, chain: r.chain, quantity: r.amount, valueUsd: r.usd }));
  const take = (symbol: string, usd: number): void => {
    let left = usd;
    for (const p of positions) {
      if (p.symbol !== symbol || left <= 0) continue;
      const taken = Math.min(p.valueUsd, left);
      p.valueUsd -= taken;
      left -= taken;
    }
  };
  const give = (symbol: string, chain: Position['chain'], usd: number): void => {
    const existing = positions.find(p => p.symbol === symbol && p.chain === chain) ?? positions.find(p => p.symbol === symbol);
    if (existing !== undefined) existing.valueUsd += usd;
    else positions.push({ symbol, chain, quantity: 0, valueUsd: usd });
  };
  if (draft.kind === 'swap') {
    take(draft.fromSymbol, draft.amountUsd);
    give(draft.toSymbol, 'intents', draft.amountUsd);
  } else if (draft.kind === 'intents_send' || draft.kind === 'intents_pay') {
    take(draft.symbol, draft.amountUsd);
  }
  return positions;
}

// What a draft brings in or moves, for the forbidden issuer rule: a swap is judged on what it
// buys, every other move on the asset it carries.
function symbolOf(draft: RailDraft): string {
  if (draft.kind === 'swap') return draft.toSymbol;
  if (draft.kind === 'trade') return '';
  return draft.symbol;
}

function pct(share: number): string {
  return (share * 100).toFixed(2) + '%';
}

// The composition rules, over the state a move would leave behind. The engine judges the
// resulting state rather than the delta: a portfolio already past a cap cannot make further
// moves until a human changes the policy or the caps stop being breached.
function compositionProblem(draft: RailDraft, policy: Policy, ctx: EngineCtx, reasons: string[]): Verdict | null {
  const symbol = symbolOf(draft);
  if (symbol !== '') {
    const issuer = issuerOf(symbol, ctx);
    const forbidden = policy.composition.forbiddenIssuers.find(f => lower(f) === lower(issuer));
    if (forbidden !== undefined) {
      return refusal(reasons, 'forbidden_issuer', `${symbol} is issued by ${issuer}, which the policy forbids.`);
    }
  }

  const post = classify(postPositions(draft, ctx), riskRowsFor(ctx));
  for (const [issuer, share] of Object.entries(post.byIssuer)) {
    const cap = issuerCap(issuer, policy.composition.maxIssuerShare);
    if (share > cap) {
      return refusal(
        reasons,
        'max_issuer_share',
        `After this move ${issuer} would hold ${pct(share)} of the portfolio, above its ${pct(cap)} cap.`,
      );
    }
  }
  if (post.freezableShare > policy.composition.maxFreezableShare) {
    return refusal(
      reasons,
      'max_freezable_share',
      `After this move ${pct(post.freezableShare)} of the portfolio would be freezable, above the ${pct(policy.composition.maxFreezableShare)} cap.`,
    );
  }
  return null;
}

// A rail hands funds to a venue. What is checked is the size of the move, who is receiving
// it, and the composition it leaves behind, in that order.
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
  const allowed = addressSet(ctx.selfAddresses, policy.outbound.destinationAllowlist);
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

  const composition = compositionProblem(draft, policy, ctx, reasons);
  if (composition !== null) return composition;

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
