// The strategy grammar: the whole vocabulary an agent may write, and the whole vocabulary the
// runner will execute. Anything not in this file cannot happen.
//
// It is a closed list of verbs on purpose. A surface that accepts arbitrary calls is a surface
// something can be talked into, so there is no verb here for moving value off the venue: no
// withdraw, no transfer, no approve, and no field anywhere that takes an address. The absence
// is structural rather than a check somebody remembered to write, which is why it survives a
// refactor. tests/injection.test.ts holds it from the outside.
//
// Two habits run through the schema below and both are about the human at the end of it:
//
//   1. Every identifier is capped at a length no address fits in. An EVM address needs 42
//      characters and a Solana one 44, and a chart handle like `tl_1` needs five. The cap is
//      the guard; the name on the field is only a label, and a label guards nothing.
//   2. Every free-text field refuses control characters and semicolons. The text lands on an
//      approval screen where render.ts separates rules by line and actions by semicolon, so
//      those are precisely the characters that let one field draw what looks like another.
//      Refusing them at the door is stronger than escaping them at the screen, because the
//      screen is not the only thing that will ever read a rendered line.
//
// Everything here is data. Nothing in this file signs, sends, holds state, or reads a price.

import { createHash } from 'node:crypto';
import { z } from 'zod';

export type Ref =
  | { kind: 'price'; value: number }
  | { kind: 'drawing'; id: string } // 'tl_1' | 'zn_1', from src/drawings.ts
  | { kind: 'indicator'; id: string; plot?: string };

export type Condition =
  | { op: 'price_above' | 'price_below' | 'price_cross_up' | 'price_cross_down'; ref: Ref }
  | { op: 'bar_close'; timeframeSec: number; side: 'above' | 'below'; ref: Ref }
  | { op: 'position'; state: 'flat' | 'long' | 'short' }
  | { op: 'pnl_pct'; cmp: 'gt' | 'lt'; value: number }
  | { op: 'elapsed'; since: 'arm' | 'entry'; cmp: 'gt' | 'lt'; seconds: number }
  | { op: 'and' | 'or'; of: Condition[] }
  | { op: 'not'; of: Condition };

export type Entry =
  | { type: 'market'; maxSlippageBps: number }
  | { type: 'limit'; ref: Ref; postOnly?: boolean };

export type Action =
  | { do: 'open'; side: 'long' | 'short'; sizeUsd: number; leverage: number; entry: Entry }
  | { do: 'add'; sizeUsd: number; entry: Entry }
  | { do: 'reduce'; fraction: number; exit: Entry }
  | { do: 'close'; exit: Entry }
  | { do: 'set_stop'; ref: Ref; trailPct?: number }
  | { do: 'set_target'; ref: Ref; fraction: number }
  | { do: 'cancel'; which: 'all' | 'entries' | 'exits' }
  | { do: 'stand_down'; reason: string }
  | { do: 'notify'; text: string };

export type Rule = { id: string; when: Condition; then: Action[]; once?: boolean; cooldownSec?: number };
export type Program = { symbol: string; rules: Rule[]; invalidate?: Condition };

// Generous for a chart handle, and short of the 42 characters an address needs.
const ID_MAX = 32;

// The only strings longer than an identifier. Both belong to verbs that place no order, so
// whatever an agent writes into them reaches a screen and never a signer.
const TEXT_MAX = 200;

// Perp tickers are short, and some carry a lowercase multiplier prefix such as kPEPE.
const SYMBOL_MAX = 12;

// Ten percent. A market order with a looser cap than this is not capped, it is an order at
// whatever the book happens to say, which is the thing a slippage limit exists to refuse.
const MAX_SLIPPAGE_BPS = 1000;

// Hyperliquid's ceiling is 40x on its deepest perp and lower on everything else. The mandate
// narrows this further at arming; the grammar only refuses what no venue would accept.
const MAX_LEVERAGE = 40;

// A condition a human cannot read is a condition a human cannot check, and the approval screen
// is the only place this program is ever reviewed. The cap is for the reader, not the parser:
// renderProgram walks the same tree and has to stay legible at the end of it.
const MAX_CONDITION_DEPTH = 6;

function hasControlChars(s: string): boolean {
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

const identifier = z
  .string()
  .min(1)
  .max(ID_MAX)
  .regex(/^[A-Za-z0-9_.:-]+$/, 'letters, digits, and _ . : - only');

const displayText = z
  .string()
  .min(1)
  .max(TEXT_MAX)
  .refine((s) => !hasControlChars(s) && !s.includes(';'), 'no control characters and no semicolons');

const symbol = z
  .string()
  .min(1)
  .max(SYMBOL_MAX)
  .regex(/^[A-Za-z0-9]+$/, 'letters and digits only');

const usdAmount = z.number().finite().positive();
const fraction = z.number().gt(0).max(1);

export const REF_SCHEMA: z.ZodType<Ref> = z.discriminatedUnion('kind', [
  // A price ref is a level on the chart, so it is positive by construction. Positivity is
  // load-bearing rather than cosmetic: render.ts divides by an entry price to work out how far
  // a stop sits from it.
  z.object({ kind: z.literal('price'), value: z.number().finite().positive() }).strict(),
  z.object({ kind: z.literal('drawing'), id: identifier }).strict(),
  z.object({ kind: z.literal('indicator'), id: identifier, plot: identifier.optional() }).strict(),
]);

export const CONDITION_SCHEMA: z.ZodType<Condition> = z.lazy(() =>
  z.discriminatedUnion('op', [
    z
      .object({
        op: z.enum(['price_above', 'price_below', 'price_cross_up', 'price_cross_down']),
        ref: REF_SCHEMA,
      })
      .strict(),
    z
      .object({
        op: z.literal('bar_close'),
        timeframeSec: z.number().int().positive().max(604_800),
        side: z.enum(['above', 'below']),
        ref: REF_SCHEMA,
      })
      .strict(),
    z.object({ op: z.literal('position'), state: z.enum(['flat', 'long', 'short']) }).strict(),
    z.object({ op: z.literal('pnl_pct'), cmp: z.enum(['gt', 'lt']), value: z.number().finite() }).strict(),
    z
      .object({
        op: z.literal('elapsed'),
        since: z.enum(['arm', 'entry']),
        cmp: z.enum(['gt', 'lt']),
        seconds: z.number().int().min(0).max(31_536_000),
      })
      .strict(),
    z.object({ op: z.enum(['and', 'or']), of: z.array(CONDITION_SCHEMA).min(1).max(8) }).strict(),
    z.object({ op: z.literal('not'), of: CONDITION_SCHEMA }).strict(),
  ]),
);

export const ENTRY_SCHEMA: z.ZodType<Entry> = z.discriminatedUnion('type', [
  z
    .object({ type: z.literal('market'), maxSlippageBps: z.number().int().min(0).max(MAX_SLIPPAGE_BPS) })
    .strict(),
  z.object({ type: z.literal('limit'), ref: REF_SCHEMA, postOnly: z.boolean().optional() }).strict(),
]);

export const ACTION_SCHEMA: z.ZodType<Action> = z.discriminatedUnion('do', [
  z
    .object({
      do: z.literal('open'),
      side: z.enum(['long', 'short']),
      sizeUsd: usdAmount,
      leverage: z.number().int().min(1).max(MAX_LEVERAGE),
      entry: ENTRY_SCHEMA,
    })
    .strict(),
  z.object({ do: z.literal('add'), sizeUsd: usdAmount, entry: ENTRY_SCHEMA }).strict(),
  z.object({ do: z.literal('reduce'), fraction, exit: ENTRY_SCHEMA }).strict(),
  z.object({ do: z.literal('close'), exit: ENTRY_SCHEMA }).strict(),
  // A trailing stop only ever moves toward the position, so the percentage bounds the give-back
  // from the best price seen rather than the give-back from entry. render.ts treats it that way.
  z.object({ do: z.literal('set_stop'), ref: REF_SCHEMA, trailPct: z.number().gt(0).max(100).optional() }).strict(),
  z.object({ do: z.literal('set_target'), ref: REF_SCHEMA, fraction }).strict(),
  z.object({ do: z.literal('cancel'), which: z.enum(['all', 'entries', 'exits']) }).strict(),
  z.object({ do: z.literal('stand_down'), reason: displayText }).strict(),
  z.object({ do: z.literal('notify'), text: displayText }).strict(),
]);

export const RULE_SCHEMA: z.ZodType<Rule> = z
  .object({
    id: identifier,
    when: CONDITION_SCHEMA,
    then: z.array(ACTION_SCHEMA).min(1).max(8),
    once: z.boolean().optional(),
    cooldownSec: z.number().int().min(0).max(86_400).optional(),
  })
  .strict();

function conditionDepth(c: Condition): number {
  if (c.op === 'and' || c.op === 'or') return 1 + Math.max(...c.of.map(conditionDepth));
  if (c.op === 'not') return 1 + conditionDepth(c.of);
  return 1;
}

export const PROGRAM_SCHEMA: z.ZodType<Program> = z
  .object({
    symbol,
    rules: z.array(RULE_SCHEMA).min(1).max(32),
    invalidate: CONDITION_SCHEMA.optional(),
  })
  .strict()
  .superRefine((p, ctx) => {
    // Rule ids are how the runner remembers that a `once` rule already fired and when a
    // cooldown started. Two rules sharing an id share that bookkeeping, so one rule silently
    // disarms the other. Nothing errors; the strategy just quietly stops being the one the
    // human read.
    const seen = new Set<string>();
    for (const [i, r] of p.rules.entries()) {
      if (seen.has(r.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['rules', i, 'id'], message: `duplicate rule id '${r.id}'` });
      }
      seen.add(r.id);
    }

    const trees: Array<[Condition, (string | number)[]]> = p.rules.map((r, i) => [r.when, ['rules', i, 'when']]);
    if (p.invalidate) trees.push([p.invalidate, ['invalidate']]);
    for (const [tree, path] of trees) {
      const depth = conditionDepth(tree);
      if (depth > MAX_CONDITION_DEPTH) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message: `condition nests ${depth} deep, over the ${MAX_CONDITION_DEPTH} limit`,
        });
      }
    }
  });

export function validateProgram(raw: unknown): { ok: true; program: Program } | { ok: false; errors: string[] } {
  const parsed = PROGRAM_SCHEMA.safeParse(raw);
  if (parsed.success) return { ok: true, program: parsed.data };
  const errors = parsed.error.issues.map((issue) => {
    const where = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    // Truncated because an unrecognized-key issue quotes the offending key back, and the key
    // came from whoever sent the program. An error is a message to a human, not a channel for
    // one.
    return `${where}: ${issue.message}`.slice(0, 200);
  });
  return { ok: false, errors };
}

// Recursively sorted keys, so two programs that differ only in the order their fields were
// written hash the same. JSON.stringify drops undefined-valued keys, which is what makes an
// absent optional and an explicitly-undefined one agree.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = canonical((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

// The identity a mandate binds to. checkEnvelope refuses everything when the running program's
// hash does not match the one the human approved, so this has to be a function of what the
// program MEANS and nothing else: key order is formatting, a changed number is not.
export function programHash(p: Program): string {
  return createHash('sha256').update(JSON.stringify(canonical(p))).digest('hex');
}

// What the program can actually do, which is what the arm path narrows allowedActions to.
// A note for that path: a mandate built from this alone cannot get flat, because a program
// whose rules only open carries no `close` or `cancel` here, and checkEnvelope tests
// allowedActions before it lets a safety verb through.
export function actionVerbs(p: Program): Action['do'][] {
  const verbs = new Set<Action['do']>();
  for (const rule of p.rules) for (const action of rule.then) verbs.add(action.do);
  return [...verbs].sort();
}
