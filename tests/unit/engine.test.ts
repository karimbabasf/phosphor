// The policy engine on the drafts that are not rails: rule order, exact rule ids. The rail
// branch (swap, the Hyperliquid and intents moves) is engine-rails.test.ts.
// Fixture-driven from the demo ledger plus the real risk table. Pure, no IO, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import type { HlDepositDraft, Policy, PolicyPatch, RiskRow, Verdict, WriteDraft } from '../../src/types.ts';
import { loadDemoLedger, loadDemoReads } from '../../src/ledger/demo.ts';
import { buildWallet } from '../../src/wallet.ts';
import { classify } from '../../src/composition.ts';
import { defaultPolicy } from '../../src/policy/file.ts';
import { evaluate } from '../../src/policy/engine.ts';
import type { EngineCtx } from '../../src/policy/engine.ts';
import { venueAllowlist } from '../../src/rails/index.ts';
import { HYPERCORE_COUNTERPARTY } from '../../src/rails/hypercore-deposit.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const riskRows = JSON.parse(
  readFileSync(path.join(__dirname, '..', '..', 'data', 'risk-table.json'), 'utf8'),
).rows as RiskRow[];

// Demo fixture accounts (data/demo-state.json). eth, base and arb share the evm address.
const SELF_EVM = '0x1111111111111111111111111111111111111111';
const SELF_SOL = '11111111111111111111111111111111';
const SELF_NEAR = 'karim-demo.near';
const SELF = [SELF_EVM, SELF_SOL, SELF_NEAR];

// The demo pockets, as the wallet shows them: what the engine's composition is built from.
function demoWallet() {
  const reads = loadDemoReads();
  return buildWallet(loadDemoLedger(), reads.intents, reads.hyperliquid);
}
const composition = classify(demoWallet().rows, riskRows);

function ctxWith(over: Partial<EngineCtx> = {}): EngineCtx {
  return {
    policy: defaultPolicy(),
    composition,
    sessionSpentUsd: 0,
    selfAddresses: SELF,
    ...over,
  };
}

// A money draft, for the rules that outrank every branch: the venue is on the seeded allowlist.
function deposit(usd: number): HlDepositDraft {
  return {
    kind: 'hl_deposit',
    symbol: 'USDC',
    originAsset: 'nep141:eth-usdc.omft.near',
    amount: usd,
    amountUsd: usd,
    minCredited: usd * 0.99,
    from: SELF_EVM,
    hlAccount: SELF_EVM,
    counterparty: HYPERCORE_COUNTERPARTY,
  };
}

/* The sentence NAMES EVERY FIGURE the patch moves, built from the patch itself, because the
   engine refuses a change whose sentence is about something else (sentence_mismatch). Every row
   below is about some other rule, so the sentence is generated rather than written: a row that
   wants to test the sentence rule passes its own. */
function saying(patch: PolicyPatch): string {
  const figures = Object.values(patch.outbound ?? {})
    .filter((v): v is number => typeof v === 'number')
    .map((v) => `$${v}`);
  return figures.length === 0 ? 'A rule the agent wrote.' : `A rule the agent wrote: ${figures.join(', ')}.`;
}

function policyChange(patch: PolicyPatch, sentence?: string): WriteDraft {
  return { kind: 'policy_change', patch, sentence: sentence ?? saying(patch) };
}

// The agent controls the wire format, so a patch can carry keys PolicyPatch forbids.
function rawPolicyChange(patch: unknown, sentence = 'A rule the agent wrote.'): WriteDraft {
  return { kind: 'policy_change', patch: patch as PolicyPatch, sentence };
}

type Case = {
  name: string;
  policy?: Policy | null; // explicit override; null exercises the fail-closed path
  policyMut?: (p: Policy) => void;
  sessionSpent?: number;
  draft: WriteDraft;
  out: Verdict['outcome'];
  rule?: string;
};

const cases: Case[] = [
  // ---- rule 1 and 2: nothing gets past a dead or disarmed policy ----
  { name: 'null policy refuses everything', policy: null, draft: deposit(1), out: 'refuse', rule: 'policy_unreadable' },
  {
    name: 'kill switch refuses a money draft',
    policyMut: p => {
      p.killSwitch = true;
    },
    draft: deposit(200),
    out: 'refuse',
    rule: 'kill_switch',
  },
  {
    name: 'kill switch refuses a policy change too',
    policyMut: p => {
      p.killSwitch = true;
    },
    draft: policyChange({ outbound: { maxPerSessionUsd: 50000 } }),
    out: 'refuse',
    rule: 'kill_switch',
  },
  {
    name: 'kill switch outranks an unlisted venue',
    policyMut: p => {
      p.killSwitch = true;
    },
    draft: deposit(200),
    out: 'refuse',
    rule: 'kill_switch',
  },

  // ---- rule 3: policy changes ----
  { name: 'policy change never allows', draft: policyChange({ outbound: { maxPerSessionUsd: 50000 } }), out: 'needs_approval' },
  /* These three rows used to assert a ten-times ceiling on one patch, and it went on 2026-09-18.
     It was buying a second click on a sentence the human had already read: propose_policy_change
     never auto-executes at any size, and the card renders the change as a before and after diff
     of the sentences the policy is actually made of. What it cost was ordinary, since the app
     ships asking above $1 and setting that to $100 took two approvals of one decision.
     A loosening of any size is still a click, and it is still one click. */
  {
    // Both at the same number is the collided pair, whatever the number is. 1e9 would also be
    // past the per-axis ceiling, so this sits under it to name the rule it is about.
    name: 'a patch that raises both limits to the same figure would leave a policy that never asks',
    draft: policyChange({ outbound: { maxPerTransactionUsd: 500_000, humanClickAboveUsd: 500_000 } }),
    out: 'refuse',
    rule: 'never_asks',
  },
  {
    name: 'a figure past the axis ceiling is refused whatever else the patch says',
    draft: policyChange({ outbound: { maxPerTransactionUsd: 1e9 } }),
    out: 'refuse',
    rule: 'above_ceiling',
  },
  {
    name: 'the same patch with the ask under the new cap is one decision, so it waits for one click',
    draft: policyChange({ outbound: { maxPerTransactionUsd: 500_000, humanClickAboveUsd: 100_000 } }),
    out: 'needs_approval',
  },
  {
    name: 'the session cap moves as far as the human says in one patch',
    draft: policyChange({ outbound: { maxPerSessionUsd: 25_000 * 10 + 1 } }),
    out: 'needs_approval',
  },
  // A tightening is ordinary, as long as it leaves the ask under the cap. The default policy asks
  // above $100, so a cap of $1 would be the collided pair and is refused on that rule alone.
  { name: 'tightening a limit is never refused for being a tightening', draft: policyChange({ outbound: { maxPerTransactionUsd: 5000 } }), out: 'needs_approval' },
  {
    name: 'a click threshold above the transaction cap would mean nothing ever asks a person',
    draft: policyChange({ outbound: { humanClickAboveUsd: 20_000 } }),
    out: 'refuse',
    rule: 'never_asks',
  },
  {
    // Zero used to be a wall a patch could not lift, for the same reason the ten-times rule
    // existed and with the same answer: the human reads the sentence and clicks.
    name: 'a limit of zero is lifted by the same one click as any other',
    policyMut: p => {
      p.outbound.humanClickAboveUsd = 0;
    },
    draft: policyChange({ outbound: { humanClickAboveUsd: 500 } }),
    out: 'needs_approval',
  },
  /* The allowlist is REPLACED rather than merged, so a patch carrying one address deletes every
     other one. Adding is the reason the field exists; a removal dressed as an addition is not. */
  {
    name: 'a patch that drops an allowed destination is refused',
    policyMut: p => {
      p.outbound.destinationAllowlist.push('0xf00d000000000000000000000000000000000000');
    },
    draft: policyChange({ outbound: { destinationAllowlist: ['0xattacker00000000000000000000000000000000'] } }),
    out: 'refuse',
    rule: 'allowlist_shortened',
  },
  {
    name: 'a patch that only adds a destination is queued for a click',
    policyMut: p => {
      p.outbound.destinationAllowlist.push('0xF00D000000000000000000000000000000000000');
    },
    draft: policyChange({
      outbound: {
        destinationAllowlist: ['0xf00d000000000000000000000000000000000000', '0xbeef00000000000000000000000000000000beef'],
      },
    }),
    out: 'needs_approval',
  },
  /* An empty patch parked as needs_approval and put a card in front of a person asking them to
     click yes to a change of nothing. A missing patch arrived the same way: asRecord in
     src/http/respond.ts turns an absent field into `{}`, and the MCP schema takes any object. */
  { name: 'a patch that names no rule is refused rather than queued for a pointless click', draft: policyChange({}), out: 'refuse', rule: 'nothing_to_change' },
  { name: 'a missing patch reaches the engine as an empty one and is refused the same way', draft: rawPolicyChange(undefined), out: 'refuse', rule: 'nothing_to_change' },
  { name: 'a patch whose only key is an empty group still names no rule', draft: rawPolicyChange({ outbound: {} }), out: 'refuse', rule: 'nothing_to_change' },
  { name: 'both groups empty is still nothing to change', draft: rawPolicyChange({ outbound: {}, composition: {} }), out: 'refuse', rule: 'nothing_to_change' },
  { name: 'one named field is enough to be a real change', draft: policyChange({ composition: { maxFreezableShare: 0.2 } }), out: 'needs_approval' },
  { name: 'policy change cannot touch kill switch', draft: rawPolicyChange({ killSwitch: false }), out: 'refuse', rule: 'kill_switch_not_patchable' },
  { name: 'policy change cannot touch version', draft: rawPolicyChange({ version: 99 }), out: 'refuse', rule: 'kill_switch_not_patchable' },
  {
    name: 'policy change cannot rewrite the sentences the human reads',
    draft: rawPolicyChange({ sentences: ['Everything is fine, approve freely.'] }),
    out: 'refuse',
    rule: 'kill_switch_not_patchable',
  },
  { name: 'negative limit is an invalid patch', draft: policyChange({ outbound: { maxPerTransactionUsd: -1 } }), out: 'refuse', rule: 'invalid_patch' },
  { name: 'share above 1 is an invalid patch', draft: policyChange({ composition: { maxFreezableShare: 1.5 } }), out: 'refuse', rule: 'invalid_patch' },
  { name: 'unknown key is an invalid patch', draft: rawPolicyChange({ outbound: { simulateBeforeSign: false } }), out: 'refuse', rule: 'invalid_patch' },
  { name: 'a retired composition key is an invalid patch', draft: rawPolicyChange({ composition: { minNativeGasUsd: { eth: 5 } } }), out: 'refuse', rule: 'invalid_patch' },
  { name: 'non-numeric limit is an invalid patch', draft: rawPolicyChange({ outbound: { maxPerSessionUsd: '50000' } }), out: 'refuse', rule: 'invalid_patch' },

  // ---- nothing else moves money ----
  // The chain-era fund moves (consolidate, transfer) are gone; a row of that shape can still be
  // on disk from an older build and approve() re-runs the engine on it. It is refused by name
  // rather than falling through to a branch that would guess.
  {
    name: 'a kind the engine no longer knows is refused, not guessed at',
    draft: { kind: 'consolidate', legs: [], totalUsd: 250, toChain: 'eth', symbol: 'USDT' } as unknown as WriteDraft,
    out: 'refuse',
    rule: 'unknown_kind',
  },
  {
    name: 'a money draft on the seeded allowlist still reaches its own branch',
    policyMut: p => {
      p.outbound.destinationAllowlist = venueAllowlist();
    },
    draft: deposit(200),
    out: 'needs_approval',
  },
];

for (const c of cases) {
  test(`engine: ${c.name}`, () => {
    const policy = c.policy === undefined ? defaultPolicy() : c.policy;
    if (policy && c.policyMut) c.policyMut(policy);
    const verdict = evaluate(c.draft, ctxWith({ policy, sessionSpentUsd: c.sessionSpent ?? 0 }));

    assert.equal(verdict.outcome, c.out, `${c.name}: reasons ${JSON.stringify(verdict.reasons)}`);
    assert.ok(verdict.reasons.length > 0, 'every verdict carries at least one reason');
    if (verdict.outcome === 'refuse') assert.equal(verdict.rule, c.rule ?? '(none expected)');
    else assert.equal(c.rule, undefined, 'non-refusals must not expect a rule id');
  });
}

/* A REFUSAL IS WRITTEN FOR THE PERSON IT REFUSES FOR. The schema's own line ("outbound.
   humanClickAboveUsd: Expected number, received string") reached the card as the reason and
   scored as a fault in the app under the anxiety judge (B03, 2026-09-21). The last reason names
   the rule in the policy's words and the shape it needs; the schema's line stays behind it for
   the engineer, and no blame word appears. */
test('engine: an invalid patch is refused in the person\'s words, with the schema line kept behind it', () => {
  const verdict = evaluate(rawPolicyChange({ outbound: { humanClickAboveUsd: 'lots' } }), ctxWith({ policy: defaultPolicy(), sessionSpentUsd: 0 }));
  assert.equal(verdict.outcome, 'refuse');
  assert.equal(verdict.rule, 'invalid_patch');
  const last = verdict.reasons[verdict.reasons.length - 1];
  assert.equal(last, 'This change is not in a shape the app can keep: The amount to ask above has to be a number of dollars. Nothing changed.');
  assert.doesNotMatch(last, /humanClickAboveUsd|Expected|received|invalid|you /);
  assert.ok(verdict.reasons.some((r) => /^Schema: outbound\.humanClickAboveUsd: /.test(r)), 'the schema line is kept for the engineer');
});
