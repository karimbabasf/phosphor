// A plan: one object, one shape, two homes.
//
// Drawn on the chart it is an idea. Armed it is what runs. Either way it is the same object,
// which is what lets "go" arm exactly what is on screen. The shape is closed on purpose: a
// surface an agent can extend at runtime is a surface nobody can audit, and the one thing the
// grammar it replaces got wrong was accepting verbs the runner then ignored.
//
// What is NOT in the vocabulary, and why. "Buy when it comes down to X" is a limit entry and
// "buy when it breaks X" is a stop entry, both held by the venue with zero latency, so there is
// no price-now or price-cross condition here. The conditions that remain are the ones the venue
// cannot hold: a bar close, a reclaim wick, volume, a time window. Nothing is at risk while any
// of them waits.

import { createHash } from 'node:crypto';
import { z } from 'zod';

export const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];
export const TIMEFRAME_SEC: Record<Timeframe, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '4h': 14_400,
  '1d': 86_400,
};

// The venue's own floor is $10 after lot rounding. Eleven leaves the rounding somewhere to go.
export const MIN_SIZE_USD = 11;
export const DEFAULT_SLIPPAGE_BPS = 30;
export const MAX_SLIPPAGE_BPS = 1000;
export const MAX_CONDITIONS = 6;
export const MAX_NOTE_CHARS = 120;
export const DEFAULT_EXPIRY_MS = 24 * 60 * 60 * 1000;
export const MAX_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

const price = z.number().finite().positive();

const refSchema = z.union([
  z.object({ px: price }).strict(),
  z.object({ line: z.string().regex(/^tl_\d+$/, 'line must be a drawn line id like tl_3') }).strict(),
]);

const conditionSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('close'),
      tf: z.enum(TIMEFRAMES),
      is: z.enum(['above', 'below']),
      at: refSchema,
      wick: z.literal('through').optional(),
    })
    .strict(),
  z.object({ type: z.literal('volume'), tf: z.enum(TIMEFRAMES), atLeast: z.number().finite().positive() }).strict(),
  z.object({ type: z.literal('time'), after: z.string().optional(), before: z.string().optional() }).strict(),
]);

const entrySchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('market'),
      maxSlippageBps: z.number().int().min(1).max(MAX_SLIPPAGE_BPS).default(DEFAULT_SLIPPAGE_BPS),
    })
    .strict(),
  z.object({ type: z.literal('limit'), px: price }).strict(),
  z
    .object({
      type: z.literal('stop'),
      px: price,
      maxSlippageBps: z.number().int().min(1).max(MAX_SLIPPAGE_BPS).default(DEFAULT_SLIPPAGE_BPS),
    })
    .strict(),
]);

// No semicolons and no control characters in the note: it is rendered into one line on the card
// and into the audit log, and a semicolon is the separator both use between facts. Written as
// escapes rather than the bytes themselves, and the two unicode line separators are in the
// class too: a line break in a note is a second card line the human did not ask about.
const noteSchema = z
  .string()
  .min(3)
  .max(MAX_NOTE_CHARS)
  // Line and paragraph separators, the NEL, zero-width characters and the bidi controls are refused
  // with the C0 set: each one can add a line to the card or make it read backwards, and a note is
  // one line a person reads under the plan.
  .regex(/^[^;\u0000-\u001f\u007f\u0085\u200b-\u200f\u2028-\u202e\u2066-\u2069]+$/, 'note may not carry semicolons, control or direction characters');

export const planInputSchema = z
  .object({
    // Checked before the case fold, not after: toUpperCase turns a sharp s into two letters, so
    // a symbol that fails the rule could otherwise arrive as one that passes it.
    symbol: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9]{1,12}$/, 'symbol must be a Hyperliquid coin: letters and digits, at most 12')
      .transform((s) => s.toUpperCase()),
    side: z.enum(['long', 'short']),
    sizeUsd: z.number().finite().min(MIN_SIZE_USD),
    leverage: z.number().int().min(1),
    entry: entrySchema,
    stop: price,
    target: price.optional(),
    when: z.array(conditionSchema).max(MAX_CONDITIONS).optional(),
    expiresAt: z.string().optional(),
    note: noteSchema.optional(),
  })
  .strict();

export type Ref = z.infer<typeof refSchema>;
export type Condition = z.infer<typeof conditionSchema>;
export type Entry = z.infer<typeof entrySchema>;
export type PlanInput = z.infer<typeof planInputSchema>;
export type Plan = PlanInput & { id: string };

// The whole shape plus the expiry rule, which needs a clock the schema does not have. Every
// error names the field so the agent can fix the plan without asking anyone.
export function validatePlanInput(
  raw: unknown,
  nowMs: number,
): { ok: true; plan: PlanInput } | { ok: false; errors: string[] } {
  const parsed = planInputSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.length === 0 ? '(root)' : i.path.join('.')}: ${i.message}`),
    };
  }
  const plan = parsed.data;
  if (plan.expiresAt === undefined) {
    plan.expiresAt = new Date(nowMs + DEFAULT_EXPIRY_MS).toISOString();
  } else {
    const at = Date.parse(plan.expiresAt);
    if (!Number.isFinite(at)) return { ok: false, errors: ['expiresAt: must be an ISO timestamp'] };
    if (at <= nowMs) return { ok: false, errors: ['expiresAt: is already in the past'] };
    if (at - nowMs > MAX_EXPIRY_MS) return { ok: false, errors: ['expiresAt: at most seven days ahead'] };
    plan.expiresAt = new Date(at).toISOString();
  }
  if (plan.when !== undefined && plan.when.length === 0) delete plan.when;
  // A time window is two clock readings the watcher compares against now. A string that does
  // not parse would make a condition that never holds, and a plan that never fires is a plan
  // the human was asked about for nothing.
  for (const [n, c] of (plan.when ?? []).entries()) {
    if (c.type !== 'time') continue;
    const after = c.after === undefined ? null : Date.parse(c.after);
    const before = c.before === undefined ? null : Date.parse(c.before);
    if (after !== null && !Number.isFinite(after)) return { ok: false, errors: [`when.${n}.after: must be an ISO timestamp`] };
    if (before !== null && !Number.isFinite(before)) return { ok: false, errors: [`when.${n}.before: must be an ISO timestamp`] };
    if (after !== null && before !== null && before <= after) return { ok: false, errors: [`when.${n}: before must come after after`] };
  }
  return { ok: true, plan };
}

// Minted by the app, never by the agent. Base36 of the clock, plus a sequence when two plans land
// in one millisecond. An id is never reused: the registry keeps done rows, so a later mint cannot
// collide with a live one.
export function mintPlanId(nowMs: number, seq = 0): string {
  return `pl_${nowMs.toString(36)}${seq > 0 ? seq.toString(36) : ''}`;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = canonical(v);
    }
    return out;
  }
  return value;
}

// The draft carries this beside the plan, and the human clicks on both: what runs is what was
// approved, byte for byte, whichever order the keys arrived in.
export function planHash(plan: Plan): string {
  return createHash('sha256').update(JSON.stringify(canonical(plan))).digest('hex');
}

// ---------- English ----------

export type PlanRiskLines = {
  marginUsd: number;
  maxLossUsd: number;
  stopSlipUsd: number;
  entryRef: number;
  liquidationPx: number;
  notionalUsd: number;
  amountUsd: number;
};

function money(usd: number): string {
  return '$' + usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// A price as a person would write it: no exponent, no trailing zeroes, at most eight decimals.
export function px(value: number): string {
  return value.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
}

function refText(r: Ref): string {
  return 'px' in r ? px(r.px) : `line ${r.line}`;
}

export function renderCondition(c: Condition): string {
  if (c.type === 'close') {
    if (c.wick === 'through') {
      const other = c.is === 'above' ? 'below' : 'above';
      return `a ${c.tf} bar wicks ${other} ${refText(c.at)} and closes back ${c.is} it`;
    }
    return `a ${c.tf} bar closes ${c.is} ${refText(c.at)}`;
  }
  if (c.type === 'volume') return `volume on the ${c.tf} is at least ${px(c.atLeast)}x its 20-bar average`;
  const parts: string[] = [];
  if (c.after !== undefined) parts.push(`after ${c.after}`);
  if (c.before !== undefined) parts.push(`before ${c.before}`);
  return parts.length === 0 ? 'any time' : parts.join(' and ');
}

function entryText(e: Entry): string {
  if (e.type === 'market') return `market, up to ${e.maxSlippageBps} bps slippage`;
  if (e.type === 'limit') return `limit at ${px(e.px)}, resting on the venue`;
  return `stop entry at ${px(e.px)}, then up to ${e.maxSlippageBps} bps slippage`;
}

// The same lines on the approval card and in the trade rail, so the sentence the human clicked
// is the sentence they watch. Numbers on the risk lines come from src/trade/risk.ts; without a
// risk figure the plan still reads, it only says less.
export function renderPlan(plan: Plan, risk?: PlanRiskLines): string[] {
  const side = plan.side === 'long' ? 'Long' : 'Short';
  const lines: string[] = [];
  lines.push(
    `${side} ${plan.symbol}: ${money(plan.sizeUsd)} notional at ${plan.leverage}x` +
      (risk === undefined ? '.' : `, ${money(risk.marginUsd)} of collateral at stake, isolated.`),
  );
  lines.push(`Entry: ${entryText(plan.entry)}.`);
  lines.push(
    `Stop ${px(plan.stop)}` +
      (risk === undefined
        ? '.'
        : `: max loss ${money(risk.maxLossUsd)} with fees, and up to ${money(risk.stopSlipUsd)} more if the stop fills 10% past its trigger.`),
  );
  lines.push(plan.target === undefined ? 'No target.' : `Target ${px(plan.target)}.`);
  const when = plan.when ?? [];
  lines.push(when.length === 0 ? 'When: now.' : `When: ${when.map(renderCondition).join(', and ')}.`);
  if (risk !== undefined) lines.push(`Liquidation near ${px(risk.liquidationPx)}.`);
  lines.push(`Expires ${plan.expiresAt ?? 'when the app says'}.`);
  if (plan.note !== undefined) lines.push(`Note: ${plan.note}`);
  return lines;
}
