// The mandate rail: arming a strategy through the same door every other write goes through.
//
// This is the third rule from the design spec made concrete. Phosphor's click used to
// authorise one transaction. This authorises a bounded PROGRAM: a set of symbols, a size cap,
// a cap on the borrowed multiple, an order rate, a maximum loss, an expiry, and the exact verbs
// the program may use. What the human approves is not a trade, it is a region of behaviour with
// a wall around it.
//
// Three consequences of riding the existing draft path rather than building a second one:
//
//   1. The budget rules govern mandate size for free, because amountUsd is the maximum notional
//      and humanClickAboveUsd and maxPerSessionUsd already read that field.
//   2. simulate() is where the human actually decides, so it renders the program to English and
//      computes the worst case. It signs nothing and it starts nothing.
//   3. sessionSpentUsd counts an armed mandate automatically, since that filter excludes
//      policy_change rather than listing what counts.
//
// Disarming deliberately has no rail and no draft. Stopping is always allowed and never waits
// on a click, which is the same reason the envelope check lets a close through after a breach.

import type { MandateDraft, Rail, RailResult, SimulationResult } from '../types.ts';
import { validateProgram } from '../strategy/grammar.ts';
import { renderProgram, worstCaseUsd } from '../strategy/render.ts';
import type { Mandate } from '../strategy/envelope.ts';

// The venue stands in for a counterparty address. Every other rail hands funds to a contract
// that must be on the policy allowlist, and evaluateRail refuses an unlisted one. A perp order
// moves nothing off the account: margin, position and profit all stay inside the Hyperliquid
// account the human already funded. The check still has to mean something, so the venue names
// itself here and main.ts seeds it, which keeps "an unseeded venue is dead, not cautious" true.
export const HYPERLIQUID_PERPS_COUNTERPARTY = 'hyperliquid-perps';

export type MandateRunner = {
  arm(mandate: Mandate, program: unknown): Promise<{ ok: boolean; detail: string }>;
  disarm(id: string, reason: string): Promise<{ ok: boolean; detail: string }>;
  status(): { armed: { id: string; symbol: string; since: string }[]; running: boolean };
};

export function mandateToEnvelope(d: MandateDraft, id: string): Mandate {
  return {
    id,
    programHash: d.programHash,
    symbol: d.symbol,
    maxNotionalUsd: d.maxNotionalUsd,
    maxLeverage: d.maxLeverage,
    maxOrdersPerMin: d.maxOrdersPerMin,
    maxLossUsd: d.maxLossUsd,
    expiresAt: d.expiresAt,
    allowedActions: d.allowedActions as Mandate['allowedActions'],
  };
}

export function mandateRail(deps: { runner: MandateRunner }): Rail<MandateDraft> {
  return {
    kind: 'mandate_arm',

    valueUsd: (draft) => draft.maxNotionalUsd,

    async simulate(draft): Promise<SimulationResult> {
      // Revalidate here rather than trusting what reached the draft. The proposal service
      // validated it too; doing it again costs nothing and means a program cannot arrive at
      // the approval screen through any path that skipped the check.
      const parsed = validateProgram(draft.program);
      if (!parsed.ok) {
        return { ok: false, summary: 'program rejected', error: parsed.errors.join('; ') };
      }

      const envelope = mandateToEnvelope(draft, 'preview');
      const worst = worstCaseUsd(parsed.program, envelope);
      const lines = renderProgram(parsed.program);

      // The summary is what the human reads before clicking, so it leads with the two numbers
      // that decide whether to click at all, then the program in English. JSON on this screen
      // would be an approval nobody can actually give.
      const head = [
        `Arm a bot on ${draft.symbol}.`,
        `Worst case if every stop fails: $${worst.toFixed(2)}.`,
        `Caps: $${draft.maxNotionalUsd.toFixed(2)} notional, ${draft.maxLeverage}x, ` +
          `${draft.maxOrdersPerMin} orders/min, stop-out at $${draft.maxLossUsd.toFixed(2)} down.`,
        `Expires ${draft.expiresAt}.`,
        `Allowed: ${draft.allowedActions.join(', ')}.`,
        '',
        'What it will do:',
      ];

      return { ok: true, summary: [...head, ...lines.map((l) => `  ${l}`)].join('\n') };
    },

    async execute(draft): Promise<RailResult> {
      const parsed = validateProgram(draft.program);
      if (!parsed.ok) return { ok: false, detail: `program rejected: ${parsed.errors.join('; ')}` };

      const id = `md_${Date.now().toString(36)}`;
      const envelope = mandateToEnvelope(draft, id);
      const armed = await deps.runner.arm(envelope, parsed.program);
      return { ok: armed.ok, detail: armed.detail };
    },
  };
}
