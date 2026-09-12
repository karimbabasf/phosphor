// The JSON indicator format: a closed tree of ops over the candle series, validated here and
// evaluated in evaluate.ts.
//
// This is the core of custom indicators and the only thing the evaluator ever sees. Pine is a
// translator onto this format (pine.ts) and can be deleted alone; a file the human wrote by
// hand in this format goes through the same schema. One shape means one surface to test.
//
// Every limit is a number in LIMITS and every rule is a sentence in an issue, because the
// person reading the refusal is a human editing a file, not an agent parsing an error.

import { z } from 'zod';

// A leaf is a number (broadcast as a constant), the name of a series, the name of an input,
// or 'prev' inside a recur step. A node is [op, ...args].
export type Expr = number | string | ExprNode;
export type ExprNode = [string, ...Expr[]];

export type Tone = 'up' | 'down' | 'warn' | 'agent' | 'text';

export type CustomInput = { default: number; min?: number; max?: number; int?: boolean; title?: string };

export type CustomPlot = { title: string; color?: Tone; expr: Expr; style?: 'line' | 'histogram' };

export type CustomIndicator = {
  title: string;
  overlay: boolean;
  inputs: Record<string, CustomInput>;
  plots: CustomPlot[];
  hlines?: { value: number; title?: string }[];
};

export const LIMITS = {
  nodes: 400,
  depth: 16,
  plots: 6,
  history: 500,
  period: 500,
  inputs: 12,
  hlines: 12,
  title: 64,
  plotTitle: 48,
} as const;

export const TONES: readonly Tone[] = ['up', 'down', 'warn', 'agent', 'text'];

// The candle series a tree can read. 'na' is the all-undefined series, which is how a JSON
// file says na: JSON has no NaN.
export const SERIES: readonly string[] = ['open', 'high', 'low', 'close', 'volume', 'hl2', 'hlc3', 'ohlc4', 'bar_index', 'na'];

// What each op is, for the validator and the evaluator both.
//
//   element   elementwise over its arguments; the only kind allowed above 'prev'
//   window    [op, source, period]: a rolling function; period is a literal or an input name
//   period    [op, period]: like window but over the candles themselves (atr)
//   shift     [op, source, n]: reads n bars back (hist, change with an explicit n)
//   cross     [op, a, b]: reads the previous bar of both
//   recur     [recur, init, step]: step may read 'prev', the value one bar back
export type OpKind = 'element' | 'window' | 'period' | 'shift' | 'cross' | 'recur' | 'tr';

export const OPS: Record<string, { kind: OpKind; min: number; max: number }> = {
  sma: { kind: 'window', min: 2, max: 2 },
  ema: { kind: 'window', min: 2, max: 2 },
  rma: { kind: 'window', min: 2, max: 2 },
  wma: { kind: 'window', min: 2, max: 2 },
  rsi: { kind: 'window', min: 2, max: 2 },
  stdev: { kind: 'window', min: 2, max: 2 },
  highest: { kind: 'window', min: 2, max: 2 },
  lowest: { kind: 'window', min: 2, max: 2 },
  atr: { kind: 'period', min: 1, max: 1 },
  tr: { kind: 'tr', min: 0, max: 0 },
  change: { kind: 'shift', min: 1, max: 2 },
  hist: { kind: 'shift', min: 2, max: 2 },
  crossover: { kind: 'cross', min: 2, max: 2 },
  crossunder: { kind: 'cross', min: 2, max: 2 },
  recur: { kind: 'recur', min: 2, max: 2 },
  abs: { kind: 'element', min: 1, max: 1 },
  sqrt: { kind: 'element', min: 1, max: 1 },
  log: { kind: 'element', min: 1, max: 1 },
  max: { kind: 'element', min: 2, max: 8 },
  min: { kind: 'element', min: 2, max: 8 },
  nz: { kind: 'element', min: 1, max: 2 },
  na: { kind: 'element', min: 1, max: 1 },
  '+': { kind: 'element', min: 2, max: 2 },
  '-': { kind: 'element', min: 1, max: 2 },
  '*': { kind: 'element', min: 2, max: 2 },
  '/': { kind: 'element', min: 2, max: 2 },
  '%': { kind: 'element', min: 2, max: 2 },
  '<': { kind: 'element', min: 2, max: 2 },
  '<=': { kind: 'element', min: 2, max: 2 },
  '>': { kind: 'element', min: 2, max: 2 },
  '>=': { kind: 'element', min: 2, max: 2 },
  '==': { kind: 'element', min: 2, max: 2 },
  '!=': { kind: 'element', min: 2, max: 2 },
  and: { kind: 'element', min: 2, max: 2 },
  or: { kind: 'element', min: 2, max: 2 },
  not: { kind: 'element', min: 1, max: 1 },
  '?': { kind: 'element', min: 3, max: 3 },
};

// Own-property lookup, because OPS is a plain object and 'constructor' is a key on every
// plain object: a tree whose op is 'constructor' must read as unknown, not as a function.
export function opDef(op: string): { kind: OpKind; min: number; max: number } | undefined {
  return Object.prototype.hasOwnProperty.call(OPS, op) ? OPS[op] : undefined;
}

const NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,23}$/;

// Names an input may not take. The series names would shadow the candles, 'prev' is the recur
// leaf, and anything on Object.prototype would either vanish on assignment ('__proto__') or
// read back a function where a number was expected ('constructor'). 'prototype' is not on
// Object.prototype but is the other half of that family, so it is named outright.
const DENIED = new Set(['prev', 'prototype', 'constructor', '__proto__']);

function inputNameAllowed(name: string): boolean {
  if (!NAME_RE.test(name)) return false;
  if (SERIES.includes(name) || DENIED.has(name)) return false;
  if (name in Object.prototype) return false;
  return true;
}

// Control and format characters both: a zero-width joiner or a bidi override in a title is a
// title that reads as something it is not, in the legend and in the digest.
const UNCLEAN = /[\p{Cc}\p{Cf}]/u;

function cleanText(max: number, what: string): z.ZodType<string> {
  return z
    .string()
    .min(1, `${what} must not be empty`)
    .max(max, `${what} must be at most ${max} characters`)
    .refine((s) => !UNCLEAN.test(s), `${what} must not carry control or format characters`)
    .refine((s) => s.trim() === s, `${what} must not start or end with a space`);
}

const finite = z.number().finite();

const inputSchema = z
  .object({
    default: finite,
    min: finite.optional(),
    max: finite.optional(),
    int: z.boolean().optional(),
    title: cleanText(LIMITS.plotTitle, 'input title').optional(),
  })
  .strict()
  .refine((i) => (i.min === undefined || i.min <= i.default) && (i.max === undefined || i.max >= i.default), {
    message: 'default must sit between min and max',
  });

const inputsSchema = z
  .record(
    z.string().refine(inputNameAllowed, {
      message: 'an input name is a letter followed by up to 23 letters, digits or underscores, and may not be a series name, prev, or a JavaScript prototype name',
    }),
    inputSchema,
  )
  .refine((r) => Object.keys(r).length <= LIMITS.inputs, { message: `at most ${LIMITS.inputs} inputs` });

// An unknown name is quoted back so the human can find it, but a name is whatever string the
// file put there: a hundred kilobytes, or a bidi override that would turn the sentence around.
// Forty visible characters is enough to find anything in a file.
function quoted(name: string): string {
  const clean = name.replace(/[\p{C}\p{Z}]/gu, (ch) => `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`);
  return `'${clean.length > 40 ? `${clean.slice(0, 40)}...` : clean}'`;
}

// The tree is validated by a walk rather than a recursive zod schema, because the walk has to
// stop the moment a limit is crossed. A recursive schema would parse a hundred thousand nodes
// before saying they are too many.
type Issue = { path: (string | number)[]; message: string };

type WalkState = {
  inputs: Set<string>;
  nodes: number;
  issues: Issue[];
};

function periodIssue(op: string, arg: unknown, lo: number, hi: number, inputs: Set<string>): string | null {
  if (typeof arg === 'number') {
    if (!Number.isInteger(arg)) return `${op}: the period must be a whole number`;
    if (arg < lo || arg > hi) return `${op}: the period must be between ${lo} and ${hi}`;
    return null;
  }
  if (typeof arg === 'string' && inputs.has(arg)) return null;
  return `${op}: the period must be a number or an input name`;
}

function walk(node: unknown, path: (string | number)[], depth: number, inRecur: boolean, underWindow: boolean, st: WalkState): void {
  if (st.issues.length > 0) return;
  st.nodes += 1;
  if (st.nodes > LIMITS.nodes) {
    st.issues.push({ path, message: `more than ${LIMITS.nodes} nodes across the plots` });
    return;
  }
  if (typeof node === 'number') {
    if (!Number.isFinite(node)) st.issues.push({ path, message: 'a number must be finite' });
    return;
  }
  if (typeof node === 'string') {
    if (node === 'prev') {
      if (!inRecur) st.issues.push({ path, message: "'prev' only has a value inside a recur step" });
      else if (underWindow) st.issues.push({ path, message: "'prev' cannot be fed to an op that reads other bars; only elementwise ops may sit between recur and prev" });
      return;
    }
    if (!SERIES.includes(node) && !st.inputs.has(node)) st.issues.push({ path, message: `unknown name ${quoted(node)}` });
    return;
  }
  if (!Array.isArray(node) || node.length === 0 || typeof node[0] !== 'string') {
    st.issues.push({ path, message: 'a node is [op, ...args], a number, or a name' });
    return;
  }
  if (depth > LIMITS.depth) {
    st.issues.push({ path, message: `an expression deeper than ${LIMITS.depth} levels` });
    return;
  }
  const op = node[0];
  const def = opDef(op);
  if (def === undefined) {
    st.issues.push({ path, message: `unknown op ${quoted(op)}` });
    return;
  }
  const args = node.slice(1);
  if (args.length < def.min || args.length > def.max) {
    const want = def.min === def.max ? `${def.min}` : `${def.min} to ${def.max}`;
    st.issues.push({ path, message: `${op} takes ${want} arguments, got ${args.length}` });
    return;
  }
  switch (def.kind) {
    case 'element':
      args.forEach((a, i) => walk(a, [...path, i + 1], depth + 1, inRecur, underWindow, st));
      return;
    case 'window': {
      const bad = periodIssue(op, args[1], 1, LIMITS.period, st.inputs);
      if (bad !== null) {
        st.issues.push({ path: [...path, 2], message: bad });
        return;
      }
      st.nodes += 1;
      walk(args[0], [...path, 1], depth + 1, inRecur, true, st);
      return;
    }
    case 'period': {
      const bad = periodIssue(op, args[0], 1, LIMITS.period, st.inputs);
      if (bad !== null) st.issues.push({ path: [...path, 1], message: bad });
      st.nodes += 1;
      return;
    }
    case 'tr':
      return;
    case 'shift': {
      if (args.length === 2) {
        const lo = op === 'hist' ? 0 : 1;
        const bad = periodIssue(op, args[1], lo, LIMITS.history, st.inputs);
        if (bad !== null) {
          st.issues.push({ path: [...path, 2], message: bad });
          return;
        }
        st.nodes += 1;
      }
      walk(args[0], [...path, 1], depth + 1, inRecur, true, st);
      return;
    }
    case 'cross':
      walk(args[0], [...path, 1], depth + 1, inRecur, true, st);
      walk(args[1], [...path, 2], depth + 1, inRecur, true, st);
      return;
    case 'recur': {
      if (inRecur) {
        st.issues.push({ path, message: 'a recur inside a recur step is not supported' });
        return;
      }
      walk(args[0], [...path, 1], depth + 1, false, underWindow, st);
      walk(args[1], [...path, 2], depth + 1, true, false, st);
      return;
    }
  }
}

export function validateExprs(exprs: unknown[], inputs: Iterable<string>, pathPrefix: (i: number) => (string | number)[]): Issue[] {
  const st: WalkState = { inputs: new Set(inputs), nodes: 0, issues: [] };
  for (let i = 0; i < exprs.length; i++) {
    walk(exprs[i], pathPrefix(i), 1, false, false, st);
    if (st.issues.length > 0) break;
  }
  return st.issues;
}

const shape = z
  .object({
    title: cleanText(LIMITS.title, 'title'),
    overlay: z.boolean(),
    inputs: inputsSchema,
    plots: z
      .array(
        z
          .object({
            title: cleanText(LIMITS.plotTitle, 'plot title'),
            color: z.enum(['up', 'down', 'warn', 'agent', 'text']).optional(),
            expr: z.custom<Expr>((v) => typeof v === 'number' || typeof v === 'string' || Array.isArray(v), 'expr is a number, a name, or [op, ...args]'),
            style: z.enum(['line', 'histogram']).optional(),
          })
          .strict(),
      )
      .min(1, 'plots: at least one plot')
      .max(LIMITS.plots, `plots: at most ${LIMITS.plots} plots`),
    hlines: z
      .array(z.object({ value: finite, title: cleanText(LIMITS.plotTitle, 'hline title').optional() }).strict())
      .max(LIMITS.hlines, `hlines: at most ${LIMITS.hlines}`)
      .optional(),
  })
  .strict();

export const customIndicatorSchema: z.ZodType<CustomIndicator> = shape.superRefine((ind, ctx) => {
  const issues = validateExprs(
    ind.plots.map((p) => p.expr),
    Object.keys(ind.inputs),
    (i) => ['plots', i, 'expr'],
  );
  for (const issue of issues) ctx.addIssue({ code: z.ZodIssueCode.custom, path: issue.path, message: issue.message });
});
