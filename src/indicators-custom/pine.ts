// Pine v5 to the JSON indicator format.
//
// A translator, not an interpreter: it never evaluates anything. It reads the subset of Pine
// that covers the scripts people paste (inputs, assignments, var and :=, if blocks that assign,
// the ternary, [n] history, the ta.* and math.* functions the format has ops for, plot and
// hline) and writes the tree that evaluate.ts walks. Everything else is refused by name with
// the line number so the human can adapt the file, and the drawing calls the format has no
// place for (plotshape, fill, bgcolor, alerts) are dropped with a note rather than refused,
// because a script is usually still useful without them.
//
// Variables are inlined: a name used in three plots becomes the same subtree three times and
// the evaluator's memo makes it cost once. The one thing inlining cannot express is a variable
// that reads its own past, which is what `var` and `x[1]` are for, and that becomes the
// format's recur op. The placeholders that carry those references through the script are
// resolved at the end, when every := has been seen; see resolve().

import { customIndicatorSchema, LIMITS, SERIES } from './schema.ts';
import type { CustomIndicator, CustomInput, CustomPlot, Expr, ExprNode, Tone } from './schema.ts';

export type PineResult =
  | { ok: true; indicator: CustomIndicator; ignored: string[] }
  | { ok: false; line: number; message: string };

const SOURCE_CAP = 256 * 1024;
const TOKEN_CAP = 50_000;
const DEPTH_CAP = 32;

class Refusal extends Error {
  line: number;
  constructor(line: number, message: string) {
    super(message);
    this.line = line;
  }
}

function refuse(line: number, message: string): never {
  throw new Refusal(line, message);
}

// ---------- lines ----------

type Line = { no: number; indent: number; text: string };

// Comments off, blank lines out, a call spread over several lines joined into one, and the
// version tag read on the way past. Strings are respected so a // inside a title survives.
function logicalLines(source: string): { version: number | null; lines: Line[] } {
  const raw = source.split(/\r?\n/);
  const lines: Line[] = [];
  let version: number | null = null;
  let open: Line | null = null;
  let depth = 0;
  for (let i = 0; i < raw.length; i++) {
    const physical = raw[i] as string;
    const no = i + 1;
    const tag = /^\s*\/\/\s*@version\s*=\s*(\d+)/.exec(physical);
    if (tag !== null) {
      if (version === null) version = Number(tag[1]);
      continue;
    }
    let text = '';
    let quote: string | null = null;
    for (let k = 0; k < physical.length; k++) {
      const ch = physical[k] as string;
      if (quote !== null) {
        text += ch;
        if (ch === '\\' && k + 1 < physical.length) {
          text += physical[k + 1];
          k += 1;
        } else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        text += ch;
        continue;
      }
      if (ch === '/' && physical[k + 1] === '/') break;
      if (ch === '(' || ch === '[') depth += 1;
      if (ch === ')' || ch === ']') {
        depth -= 1;
        if (depth < 0) refuse(no, `unexpected '${ch}'`);
      }
      text += ch;
    }
    if (quote !== null) refuse(no, 'a string is never closed');
    const trimmed = text.trim();
    if (open !== null) {
      if (trimmed.length > 0) open.text += ` ${trimmed}`;
      if (depth === 0) {
        lines.push(open);
        open = null;
      }
      continue;
    }
    if (trimmed.length === 0) continue;
    const lead = /^[ \t]*/.exec(text)?.[0] ?? '';
    const indent = lead.replace(/\t/g, '    ').length;
    const line: Line = { no, indent, text: trimmed };
    if (depth > 0) open = line;
    else lines.push(line);
  }
  if (open !== null) refuse(open.no, "'(' is never closed");
  return { version, lines };
}

// ---------- tokens ----------

type Tok =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'id'; v: string }
  | { t: 'op'; v: string }
  | { t: 'hex'; v: string }
  | { t: 'eof' };

const OPS_LONG = [':=', '==', '!=', '<=', '>=', '=>'];
const OPS_SHORT = '+-*/%<>=?:,()[]';

function tokenize(line: Line, budget: { tokens: number }): Tok[] {
  const out: Tok[] = [];
  const s = line.text;
  let i = 0;
  while (i < s.length) {
    const ch = s[i] as string;
    // A no-break space is whitespace: scripts pasted from a web page carry them between
    // tokens. It is not a confusable, since it can never be part of a name.
    if (ch === ' ' || ch === '\t' || ch === ' ') {
      i += 1;
      continue;
    }
    budget.tokens += 1;
    if (budget.tokens > TOKEN_CAP) refuse(line.no, 'the script is too long to read');
    const num = /^(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/.exec(s.slice(i));
    if (num !== null) {
      out.push({ t: 'num', v: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*/.exec(s.slice(i));
    if (id !== null) {
      out.push({ t: 'id', v: id[0] });
      i += id[0].length;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let k = i + 1;
      let v = '';
      while (k < s.length && s[k] !== ch) {
        if (s[k] === '\\' && k + 1 < s.length) k += 1;
        v += s[k];
        k += 1;
      }
      out.push({ t: 'str', v });
      i = k + 1;
      continue;
    }
    const hex = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?/.exec(s.slice(i));
    if (hex !== null) {
      out.push({ t: 'hex', v: hex[0] });
      i += hex[0].length;
      continue;
    }
    const two = s.slice(i, i + 2);
    if (OPS_LONG.includes(two)) {
      out.push({ t: 'op', v: two });
      i += 2;
      continue;
    }
    if (OPS_SHORT.includes(ch)) {
      out.push({ t: 'op', v: ch });
      i += 1;
      continue;
    }
    refuse(line.no, `unexpected character '${ch}'`);
  }
  out.push({ t: 'eof' });
  return out;
}

// ---------- values and bindings ----------

type Val =
  | { kind: 'expr'; expr: Expr }
  | { kind: 'str'; v: string }
  | { kind: 'color'; tone: Tone; conditional: boolean }
  | { kind: 'enum'; v: string }
  | { kind: 'plot'; name: string }
  | { kind: 'input'; input: CustomInput }
  | { kind: 'source'; name: string };

type Binding =
  | { kind: 'input' }
  | { kind: 'series'; name: string }
  | { kind: 'color'; tone: Tone }
  | { kind: 'plot' }
  | { kind: 'variable'; isVar: boolean; init: Expr | null; current: Expr; line: number };

type Env = Map<string, Binding>;

type Script = {
  title: string | null;
  overlay: boolean;
  inputs: Record<string, CustomInput>;
  plots: (CustomPlot & { line: number })[];
  hlines: { value: number; title?: string }[];
  ignored: string[];
  vars: Env;
  order: string[];
};

const IGNORED = new Set(['plotshape', 'plotchar', 'plotcandle', 'plotbar', 'plotarrow', 'fill', 'bgcolor', 'barcolor', 'alertcondition', 'alert']);
const REFUSED_NAMESPACES = ['request', 'array', 'matrix', 'map', 'label', 'line', 'table', 'box', 'polyline', 'str', 'strategy', 'syminfo', 'timeframe', 'ticker', 'chart', 'session', 'time', 'runtime', 'log', 'linefill'];
const REFUSED_NAMES = new Set(['time', 'time_close', 'timenow', 'hlcc4', 'dayofweek', 'hour', 'minute', 'second', 'year', 'month', 'dayofmonth', 'last_bar_index', 'barstate.isconfirmed']);
const TYPES = new Set(['float', 'int', 'bool', 'string', 'color', 'series', 'simple', 'const']);
const ENUM_PREFIXES = ['plot.', 'hline.', 'shape.', 'location.', 'display.', 'format.', 'size.', 'xloc.', 'yloc.', 'extend.', 'scale.', 'text.', 'font.'];

const TA_WINDOW: Record<string, string> = {
  'ta.sma': 'sma',
  'ta.ema': 'ema',
  'ta.rma': 'rma',
  'ta.wma': 'wma',
  'ta.rsi': 'rsi',
  'ta.stdev': 'stdev',
  'ta.highest': 'highest',
  'ta.lowest': 'lowest',
};
const MATH: Record<string, string> = {
  'math.abs': 'abs',
  'math.max': 'max',
  'math.min': 'min',
  'math.sqrt': 'sqrt',
  'math.log': 'log',
};

const NAMED_TONES: Record<string, Tone> = {
  green: 'up',
  lime: 'up',
  teal: 'up',
  olive: 'up',
  red: 'down',
  maroon: 'down',
  fuchsia: 'down',
  orange: 'warn',
  yellow: 'warn',
  white: 'text',
  gray: 'text',
  silver: 'text',
  black: 'text',
  blue: 'agent',
  aqua: 'agent',
  navy: 'agent',
  purple: 'agent',
};

// The name tables are plain objects, so a script naming 'constructor' would otherwise read a
// function out of them. Own properties only.
function lookup<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

// A colour the app has no token for lands on the agent tint, which is the one colour that
// always reads as "something an agent put here". Warm reds and greens keep their meaning.
function toneOfRgb(r: number, g: number, b: number): Tone {
  const hi = Math.max(r, g, b);
  const lo = Math.min(r, g, b);
  if (hi - lo < 40) return 'text';
  if (b === hi) return 'agent';
  if (r === hi) return g > r * 0.55 ? 'warn' : 'down';
  return 'up';
}

function toneOfHex(hex: string): Tone {
  return toneOfRgb(parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16));
}

// ---------- the parser ----------

type Ctx = {
  script: Script;
  env: Env;
  line: Line;
  toks: Tok[];
  pos: number;
  // The name on the left of the = or := being translated, so a reference to it on the right
  // can be told apart from a reference from another statement.
  assigning: string | null;
  depth: number;
};

function peek(c: Ctx, ahead = 0): Tok {
  return c.toks[c.pos + ahead] ?? { t: 'eof' };
}

function next(c: Ctx): Tok {
  const t = peek(c);
  c.pos += 1;
  return t;
}

function isOp(t: Tok, v: string): boolean {
  return t.t === 'op' && t.v === v;
}

function isId(t: Tok, v: string): boolean {
  return t.t === 'id' && t.v === v;
}

function expectOp(c: Ctx, v: string): void {
  const t = next(c);
  if (!isOp(t, v)) refuse(c.line.no, `expected '${v}'`);
}

function asExpr(c: Ctx, v: Val, what: string): Expr {
  if (v.kind === 'expr') return v.expr;
  if (v.kind === 'source') return v.name;
  if (v.kind === 'str') refuse(c.line.no, `${what} cannot be a string`);
  if (v.kind === 'color') refuse(c.line.no, `${what} cannot be a colour`);
  if (v.kind === 'plot') refuse(c.line.no, `${v.name} is a plot, not a value`);
  if (v.kind === 'input') refuse(c.line.no, 'an input must be assigned to a name');
  refuse(c.line.no, `${what} cannot be ${v.v}`);
}

// A period or history index: a whole number or the name of an input. Anything else cannot be
// a fixed window, and the format has no variable-window op.
function periodArg(c: Ctx, v: Val, fn: string, lo: number, hi: number): number | string {
  if (v.kind === 'expr') {
    if (typeof v.expr === 'number') {
      if (!Number.isInteger(v.expr) || v.expr < lo || v.expr > hi) refuse(c.line.no, `the length of ${fn} must be a whole number between ${lo} and ${hi}`);
      return v.expr;
    }
    if (typeof v.expr === 'string' && c.env.get(v.expr)?.kind === 'input') return v.expr;
  }
  refuse(c.line.no, `the length of ${fn} must be a number or an input`);
}

type Args = { positional: Val[]; named: Map<string, Val> };

function parseArgs(c: Ctx): Args {
  expectOp(c, '(');
  const args: Args = { positional: [], named: new Map() };
  if (isOp(peek(c), ')')) {
    next(c);
    return args;
  }
  for (;;) {
    const t = peek(c);
    if (t.t === 'id' && isOp(peek(c, 1), '=')) {
      next(c);
      next(c);
      args.named.set(t.v, parseValue(c));
    } else {
      args.positional.push(parseValue(c));
    }
    const sep = next(c);
    if (isOp(sep, ')')) return args;
    if (!isOp(sep, ',')) refuse(c.line.no, "expected ',' or ')'");
  }
}

function arg(args: Args, index: number, name: string): Val | undefined {
  return args.named.get(name) ?? args.positional[index];
}

function argString(c: Ctx, args: Args, index: number, name: string, fn: string): string | undefined {
  const v = arg(args, index, name);
  if (v === undefined) return undefined;
  if (v.kind !== 'str') refuse(c.line.no, `${fn}: ${name} must be a string`);
  return v.v;
}

function argNumber(c: Ctx, args: Args, index: number, name: string, fn: string): number | undefined {
  const v = arg(args, index, name);
  if (v === undefined) return undefined;
  if (v.kind === 'expr' && typeof v.expr === 'number') return v.expr;
  refuse(c.line.no, `${fn}: ${name} must be a number`);
}

function argBool(c: Ctx, args: Args, index: number, name: string, fn: string): boolean | undefined {
  const v = arg(args, index, name);
  if (v === undefined) return undefined;
  if (v.kind === 'expr' && (v.expr === 0 || v.expr === 1)) return v.expr === 1;
  refuse(c.line.no, `${fn}: ${name} must be true or false`);
}

function parseValue(c: Ctx): Val {
  return parseTernary(c);
}

function parseTernary(c: Ctx): Val {
  const cond = parseOr(c);
  if (!isOp(peek(c), '?')) return cond;
  next(c);
  const a = parseTernary(c);
  expectOp(c, ':');
  const b = parseTernary(c);
  if (a.kind === 'color' || b.kind === 'color') {
    const tone = a.kind === 'color' ? a.tone : b.kind === 'color' ? b.tone : 'agent';
    return { kind: 'color', tone, conditional: true };
  }
  return { kind: 'expr', expr: ['?', asExpr(c, cond, 'a condition'), asExpr(c, a, 'a branch'), asExpr(c, b, 'a branch')] };
}

function binary(c: Ctx, below: (c: Ctx) => Val, ops: string[]): Val {
  let left = below(c);
  for (;;) {
    const t = peek(c);
    const op = t.t === 'op' || t.t === 'id' ? t.v : null;
    if (op === null || !ops.includes(op)) return left;
    next(c);
    const right = below(c);
    left = { kind: 'expr', expr: [op, asExpr(c, left, `the left of ${op}`), asExpr(c, right, `the right of ${op}`)] };
  }
}

function parseOr(c: Ctx): Val {
  return binary(c, parseAnd, ['or']);
}

function parseAnd(c: Ctx): Val {
  return binary(c, parseEquality, ['and']);
}

function parseEquality(c: Ctx): Val {
  return binary(c, parseComparison, ['==', '!=']);
}

function parseComparison(c: Ctx): Val {
  return binary(c, parseAdditive, ['<', '<=', '>', '>=']);
}

function parseAdditive(c: Ctx): Val {
  return binary(c, parseMultiplicative, ['+', '-']);
}

function parseMultiplicative(c: Ctx): Val {
  return binary(c, parseUnary, ['*', '/', '%']);
}

function parseUnary(c: Ctx): Val {
  const t = peek(c);
  if (isOp(t, '-')) {
    next(c);
    const v = parseUnary(c);
    const e = asExpr(c, v, 'a negated value');
    return { kind: 'expr', expr: typeof e === 'number' ? -e : ['-', e] };
  }
  if (isOp(t, '+')) {
    next(c);
    return parseUnary(c);
  }
  if (isId(t, 'not')) {
    next(c);
    return { kind: 'expr', expr: ['not', asExpr(c, parseUnary(c), 'not')] };
  }
  return parsePostfix(c);
}

// [n] history. On a script variable it is the previous bar's committed value, which only
// exists once every := has been seen, so it becomes a placeholder here.
function parsePostfix(c: Ctx): Val {
  const base = parsePrimary(c);
  if (!isOp(peek(c), '[')) return base;
  next(c);
  const index = parseValue(c);
  expectOp(c, ']');
  const n = periodArg(c, index, '[]', 0, LIMITS.history);
  if (base.kind === 'source') return { kind: 'expr', expr: ['hist', base.name, n] };
  const expr = asExpr(c, base, 'a history');
  if (n === 0) return { kind: 'expr', expr };
  if (typeof expr === 'object' && expr[0] === '@ref') {
    const name = expr[1] as string;
    return { kind: 'expr', expr: n === 1 ? ['@prev', name] : ['hist', ['@final', name], n] };
  }
  return { kind: 'expr', expr: ['hist', expr, n] };
}

function parsePrimary(c: Ctx): Val {
  const t = next(c);
  if (t.t === 'num') return { kind: 'expr', expr: t.v };
  if (t.t === 'str') return { kind: 'str', v: t.v };
  if (t.t === 'hex') return { kind: 'color', tone: toneOfHex(t.v), conditional: false };
  if (isOp(t, '(')) {
    c.depth += 1;
    if (c.depth > DEPTH_CAP) refuse(c.line.no, 'the expression is too deep');
    const v = parseValue(c);
    expectOp(c, ')');
    c.depth -= 1;
    return v;
  }
  if (t.t !== 'id') refuse(c.line.no, t.t === 'eof' ? 'the line ends where a value was expected' : `unexpected '${t.v}'`);
  const name = t.v;
  const call = isOp(peek(c), '(');
  if (name === 'true') return { kind: 'expr', expr: 1 };
  if (name === 'false') return { kind: 'expr', expr: 0 };
  if (name === 'na' && !call) return { kind: 'expr', expr: 'na' };
  if (SERIES.includes(name) && name !== 'na') return { kind: 'expr', expr: name };
  if (name === 'ta.tr' && !call) return { kind: 'expr', expr: ['tr'] };
  if (name.startsWith('color.')) return parseColor(c, name, call);
  for (const prefix of ENUM_PREFIXES) if (name.startsWith(prefix)) return { kind: 'enum', v: name };
  if (call) return parseCall(c, name);
  const bound = c.env.get(name);
  if (bound !== undefined) return reference(c, name, bound);
  // `x = nz(x[1]) + 1` is legal Pine: a declaration may read its own history, and before var
  // existed it was how every running value was written.
  if (name === c.assigning) {
    if (isOp(peek(c), '[')) return { kind: 'expr', expr: ['@ref', name] };
    refuse(c.line.no, `${name} is used in its own declaration; write ${name}[1] for the previous bar`);
  }
  const ns = name.split('.')[0] as string;
  if (REFUSED_NAMESPACES.includes(ns) || REFUSED_NAMES.has(name)) refuse(c.line.no, `${name} is not supported`);
  if (name === 'if' || name === 'switch' || name === 'for' || name === 'while') refuse(c.line.no, `${name} as an expression is not supported`);
  refuse(c.line.no, `unknown name '${name}'`);
}

// A reference to a script variable is the variable's current expression, inlined, except
// inside its own := where the carried value is what the right hand side means. A var that
// has not been assigned yet on this bar carries last bar's value, and that is a placeholder
// too, because whether anything ever assigns it decides what it resolves to.
function reference(c: Ctx, name: string, b: Binding): Val {
  switch (b.kind) {
    case 'input':
      return { kind: 'expr', expr: name };
    case 'series':
      return { kind: 'source', name: b.name };
    case 'color':
      return { kind: 'color', tone: b.tone, conditional: false };
    case 'plot':
      return { kind: 'plot', name };
    case 'variable': {
      if (isOp(peek(c), '[')) return { kind: 'expr', expr: ['@ref', name] };
      if (c.assigning === name && b.line === c.line.no) refuse(c.line.no, `${name} is used in its own declaration; write ${name}[1] for the previous bar`);
      return { kind: 'expr', expr: b.current };
    }
  }
}

function parseColor(c: Ctx, name: string, call: boolean): Val {
  if (!call) {
    const key = name.slice('color.'.length);
    return { kind: 'color', tone: lookup(NAMED_TONES, key) ?? 'agent', conditional: false };
  }
  const args = parseArgs(c);
  if (name === 'color.new') {
    const inner = args.positional[0] ?? args.named.get('color');
    if (inner !== undefined && inner.kind === 'color') return inner;
    return { kind: 'color', tone: 'agent', conditional: false };
  }
  if (name === 'color.rgb') {
    const r = argNumber(c, args, 0, 'red', 'color.rgb') ?? 0;
    const g = argNumber(c, args, 1, 'green', 'color.rgb') ?? 0;
    const b = argNumber(c, args, 2, 'blue', 'color.rgb') ?? 0;
    return { kind: 'color', tone: toneOfRgb(r, g, b), conditional: false };
  }
  return { kind: 'color', tone: 'agent', conditional: false };
}

function parseCall(c: Ctx, name: string): Val {
  if (name === 'nz' || name === 'na') {
    const args = parseArgs(c);
    const x = args.positional[0];
    if (x === undefined || args.positional.length > (name === 'nz' ? 2 : 1)) refuse(c.line.no, `${name} takes ${name === 'nz' ? 'one or two' : 'one'} argument`);
    const out: ExprNode = [name, asExpr(c, x, name)];
    const y = args.positional[1];
    if (y !== undefined) out.push(asExpr(c, y, name));
    return { kind: 'expr', expr: out };
  }
  if (name === 'ta.tr') {
    parseArgs(c);
    return { kind: 'expr', expr: ['tr'] };
  }
  if (name === 'ta.atr') {
    const args = parseArgs(c);
    const n = args.positional[0];
    if (n === undefined) refuse(c.line.no, 'ta.atr takes a length');
    return { kind: 'expr', expr: ['atr', periodArg(c, n, 'ta.atr', 1, LIMITS.period)] };
  }
  if (name === 'ta.change') {
    const args = parseArgs(c);
    const x = args.positional[0];
    if (x === undefined) refuse(c.line.no, 'ta.change takes a source');
    const out: ExprNode = ['change', asExpr(c, x, 'ta.change')];
    const n = args.positional[1];
    if (n !== undefined) out.push(periodArg(c, n, 'ta.change', 1, LIMITS.history));
    return { kind: 'expr', expr: out };
  }
  if (name === 'ta.crossover' || name === 'ta.crossunder') {
    const args = parseArgs(c);
    const a = args.positional[0];
    const b = args.positional[1];
    if (a === undefined || b === undefined) refuse(c.line.no, `${name} takes two series`);
    return { kind: 'expr', expr: [name.slice(3), asExpr(c, a, name), asExpr(c, b, name)] };
  }
  const window = lookup(TA_WINDOW, name);
  if (window !== undefined) {
    const args = parseArgs(c);
    let source = args.positional[0];
    let length = args.positional[1] ?? args.named.get('length');
    // ta.highest(10) is the highest high; the one-argument form names the length alone.
    if ((window === 'highest' || window === 'lowest') && length === undefined && source !== undefined) {
      length = source;
      source = { kind: 'expr', expr: window === 'highest' ? 'high' : 'low' };
    }
    if (source === undefined || length === undefined) refuse(c.line.no, `${name} takes a source and a length`);
    return { kind: 'expr', expr: [window, asExpr(c, source, name), periodArg(c, length, name, 1, LIMITS.period)] };
  }
  const math = lookup(MATH, name);
  if (math !== undefined) {
    const args = parseArgs(c);
    const want = math === 'max' || math === 'min' ? 2 : 1;
    if (args.positional.length < want || args.positional.length > (want === 2 ? 8 : 1)) refuse(c.line.no, `${name} takes ${want === 2 ? 'two or more' : 'one'} argument${want === 2 ? 's' : ''}`);
    return { kind: 'expr', expr: [math, ...args.positional.map((v) => asExpr(c, v, name))] };
  }
  if (name === 'input' || name.startsWith('input.')) return parseInput(c, name);
  if (name === 'plot' || name === 'hline') refuse(c.line.no, `${name} must be a statement on its own line`);
  if (IGNORED.has(name)) refuse(c.line.no, `${name} cannot be used as a value`);
  const bound = c.env.get(name);
  if (bound !== undefined) refuse(c.line.no, `${name} is not a function`);
  refuse(c.line.no, `${name} is not supported`);
}

function parseInput(c: Ctx, name: string): Val {
  const args = parseArgs(c);
  const fn = name;
  if (name === 'input.source') {
    const v = arg(args, 0, 'defval');
    if (v === undefined || v.kind !== 'expr' || typeof v.expr !== 'string' || !SERIES.includes(v.expr) || v.expr === 'na') {
      if (v !== undefined && v.kind === 'source') return { kind: 'source', name: v.name };
      refuse(c.line.no, 'input.source takes one of open, high, low, close, volume, hl2, hlc3, ohlc4');
    }
    return { kind: 'source', name: v.expr };
  }
  if (name !== 'input' && name !== 'input.int' && name !== 'input.float' && name !== 'input.bool') refuse(c.line.no, `${name} is not supported`);
  const raw = arg(args, 0, 'defval');
  if (raw === undefined) refuse(c.line.no, `${fn} needs a default value`);
  if (raw.kind !== 'expr' || typeof raw.expr !== 'number') refuse(c.line.no, `${fn}: the default must be a number${name === 'input.bool' ? ', true or false' : ''}`);
  const input: CustomInput = { default: raw.expr };
  const title = argString(c, args, 1, 'title', fn);
  if (name === 'input.bool') {
    input.min = 0;
    input.max = 1;
    input.int = true;
  } else {
    const min = argNumber(c, args, 2, 'minval', fn);
    const max = argNumber(c, args, 3, 'maxval', fn);
    if (min !== undefined) input.min = min;
    if (max !== undefined) input.max = max;
    input.int = name === 'input.int' || (name === 'input' && Number.isInteger(raw.expr));
  }
  if (title !== undefined) input.title = title;
  return { kind: 'input', input };
}

// ---------- statements ----------

function expectEnd(c: Ctx): void {
  const t = peek(c);
  if (t.t !== 'eof') refuse(c.line.no, `unexpected '${t.t === 'op' || t.t === 'id' ? t.v : t.t === 'num' ? String(t.v) : t.t}' at the end of the line`);
}

function ctxFor(script: Script, env: Env, line: Line, toks: Tok[], pos: number): Ctx {
  return { script, env, line, toks, pos, assigning: null, depth: 0 };
}

function declareInput(c: Ctx, name: string, v: Val): void {
  if (v.kind !== 'input') return;
  if (Object.keys(c.script.inputs).length >= LIMITS.inputs) refuse(c.line.no, `at most ${LIMITS.inputs} inputs`);
  if (SERIES.includes(name) || name === 'prev' || name in Object.prototype || name === 'prototype') refuse(c.line.no, `${name} cannot be the name of an input`);
  c.script.inputs[name] = v.input;
  c.env.set(name, { kind: 'input' });
}

function bindValue(c: Ctx, name: string, v: Val, isVar: boolean): void {
  if (v.kind === 'input') {
    if (isVar) refuse(c.line.no, 'an input cannot be var');
    declareInput(c, name, v);
    return;
  }
  if (v.kind === 'source') {
    c.env.set(name, { kind: 'series', name: v.name });
    return;
  }
  if (v.kind === 'color') {
    c.env.set(name, { kind: 'color', tone: v.tone });
    return;
  }
  const expr = asExpr(c, v, name);
  if (isVar) c.env.set(name, { kind: 'variable', isVar: true, init: expr, current: ['@carry', name], line: c.line.no });
  else c.env.set(name, { kind: 'variable', isVar: false, init: null, current: expr, line: c.line.no });
}

function handlePlot(c: Ctx, inBlock: boolean): void {
  if (inBlock) refuse(c.line.no, 'plot inside an if block is not supported');
  const args = parseArgs(c);
  expectEnd(c);
  const series = arg(args, 0, 'series');
  if (series === undefined) refuse(c.line.no, 'plot needs a series');
  const expr = asExpr(c, series, 'the plotted series');
  if (c.script.plots.length >= LIMITS.plots) refuse(c.line.no, `at most ${LIMITS.plots} plots`);
  const title = argString(c, args, 1, 'title', 'plot') ?? `Plot ${c.script.plots.length + 1}`;
  const plot: CustomPlot & { line: number } = { title, expr, line: c.line.no };
  const color = arg(args, 2, 'color');
  if (color !== undefined) {
    if (color.kind !== 'color') refuse(c.line.no, 'plot: color must be a colour');
    plot.color = color.tone;
    if (color.conditional) c.script.ignored.push(`conditional colour on line ${c.line.no}: the plot is drawn in one tone`);
  }
  const style = arg(args, 4, 'style');
  if (style !== undefined && style.kind === 'enum' && (style.v === 'plot.style_histogram' || style.v === 'plot.style_columns')) plot.style = 'histogram';
  c.script.plots.push(plot);
}

function handleHline(c: Ctx, inBlock: boolean): void {
  if (inBlock) refuse(c.line.no, 'hline inside an if block is not supported');
  const args = parseArgs(c);
  expectEnd(c);
  const v = arg(args, 0, 'price');
  let value: number | null = null;
  if (v !== undefined && v.kind === 'expr') {
    if (typeof v.expr === 'number') value = v.expr;
    else if (typeof v.expr === 'string' && c.env.get(v.expr)?.kind === 'input') value = (c.script.inputs[v.expr] as CustomInput).default;
  }
  if (value === null) refuse(c.line.no, 'hline takes a number or an input');
  if (c.script.hlines.length >= LIMITS.hlines) refuse(c.line.no, `at most ${LIMITS.hlines} hlines`);
  const title = argString(c, args, 1, 'title', 'hline');
  c.script.hlines.push(title === undefined ? { value } : { value, title });
}

function handleIndicator(c: Ctx): void {
  const args = parseArgs(c);
  expectEnd(c);
  const title = argString(c, args, 0, 'title', 'indicator');
  if (title === undefined) refuse(c.line.no, 'indicator needs a title');
  c.script.title = title;
  c.script.overlay = argBool(c, args, 2, 'overlay', 'indicator') ?? false;
}

// One statement. Returns the index of the next line to read.
function statement(script: Script, env: Env, lines: Line[], at: number, budget: { tokens: number }, inBlock: boolean): number {
  const line = lines[at] as Line;
  const toks = tokenize(line, budget);
  const c = ctxFor(script, env, line, toks, 0);
  const first = toks[0] as Tok;
  if (toks.some((t) => isOp(t, '=>'))) refuse(line.no, 'function definitions are not supported');
  if (first.t !== 'id') refuse(line.no, 'a line must start with a name');
  const word = first.v;
  if (word === 'if') return handleIf(script, env, lines, at, budget);
  if (word === 'else') refuse(line.no, 'else without an if');
  if (word === 'for' || word === 'while' || word === 'switch' || word === 'import' || word === 'export' || word === 'method' || word === 'type' || word === 'library') {
    refuse(line.no, `${word} is not supported`);
  }
  if (word === 'varip') refuse(line.no, 'varip is not supported; var is');
  if (word === 'strategy' || word === 'study') refuse(line.no, `${word}() is not supported; this is an indicator`);
  if (word === 'indicator') {
    next(c);
    if (inBlock) refuse(line.no, 'indicator() must be at the top level');
    handleIndicator(c);
    return at + 1;
  }
  if (word === 'plot' && isOp(peek(c, 1), '(')) {
    next(c);
    handlePlot(c, inBlock);
    return at + 1;
  }
  if (word === 'hline' && isOp(peek(c, 1), '(')) {
    next(c);
    handleHline(c, inBlock);
    return at + 1;
  }
  if (IGNORED.has(word) && isOp(peek(c, 1), '(')) {
    script.ignored.push(`${word} on line ${line.no} is ignored: the chart has no place for it`);
    return at + 1;
  }
  // [var] [type...] name (= | :=) value
  let pos = 0;
  let isVar = false;
  if (isId(toks[pos] as Tok, 'var')) {
    isVar = true;
    pos += 1;
  }
  while ((toks[pos] as Tok).t === 'id' && TYPES.has((toks[pos] as { v: string }).v) && (toks[pos + 1] as Tok).t === 'id') pos += 1;
  const nameTok = toks[pos] as Tok;
  const opTok = toks[pos + 1] as Tok;
  if (nameTok.t !== 'id' || !(isOp(opTok, '=') || isOp(opTok, ':='))) {
    const ns = word.split('.')[0] as string;
    if (REFUSED_NAMESPACES.includes(ns) || word.includes('.')) refuse(line.no, `${word} is not supported`);
    refuse(line.no, `cannot read this line; a statement is an assignment, an if, a plot or an hline`);
  }
  const name = nameTok.v;
  if (name.includes('.')) refuse(line.no, `${name} cannot be assigned`);
  const assign = (opTok as { v: string }).v;
  c.pos = pos + 2;
  c.assigning = name;
  const head = peek(c);
  if (head.t === 'id' && (head.v === 'if' || head.v === 'switch' || head.v === 'for' || head.v === 'while')) refuse(line.no, `${head.v} as an expression is not supported`);
  if (assign === '=' && head.t === 'id' && (head.v === 'plot' || head.v === 'hline') && isOp(peek(c, 1), '(')) {
    next(c);
    if (head.v === 'plot') handlePlot(c, inBlock);
    else handleHline(c, inBlock);
    env.set(name, { kind: 'plot' });
    return at + 1;
  }
  const value = parseValue(c);
  expectEnd(c);
  const existing = env.get(name);
  if (assign === '=') {
    if (existing !== undefined && !(inBlock && existing.kind === 'variable')) refuse(line.no, `${name} is already declared; use := to assign it`);
    if (isVar && inBlock) refuse(line.no, 'var inside an if block is not supported');
    bindValue(c, name, value, isVar);
    if (!script.order.includes(name)) script.order.push(name);
    return at + 1;
  }
  if (isVar) refuse(line.no, 'var goes with =, not :=');
  if (existing === undefined) refuse(line.no, `${name} is assigned before it is declared`);
  if (existing.kind !== 'variable') refuse(line.no, `${name} is ${existing.kind === 'input' ? 'an input' : existing.kind === 'plot' ? 'a plot' : 'not a variable'} and cannot be assigned`);
  env.set(name, { ...existing, current: asExpr(c, value, name) });
  return at + 1;
}

function cloneEnv(env: Env): Env {
  const out: Env = new Map();
  for (const [k, v] of env) out.set(k, v.kind === 'variable' ? { ...v } : v);
  return out;
}

function block(script: Script, env: Env, lines: Line[], at: number, indent: number, budget: { tokens: number }): number {
  let i = at;
  const bodyIndent = lines[i]?.indent ?? -1;
  if (i >= lines.length || bodyIndent <= indent) refuse((lines[at - 1] as Line).no, 'if needs an indented block under it');
  while (i < lines.length && (lines[i] as Line).indent > indent) {
    if ((lines[i] as Line).indent !== bodyIndent) refuse((lines[i] as Line).no, 'the block is not indented evenly');
    i = statement(script, env, lines, i, budget, true);
  }
  return i;
}

// if cond / block / [else if cond / block]* / [else / block]. Every variable a branch assigns
// becomes cond ? then : else on the way out, so the block is a ternary over the variables it
// touched and nothing else.
function handleIf(script: Script, env: Env, lines: Line[], at: number, budget: { tokens: number }): number {
  const line = lines[at] as Line;
  const toks = tokenize(line, budget);
  const c = ctxFor(script, env, line, toks, 1);
  const cond = asExpr(c, parseValue(c), 'the if condition');
  expectEnd(c);
  const thenEnv = cloneEnv(env);
  let i = block(script, thenEnv, lines, at + 1, line.indent, budget);
  const elseEnv = cloneEnv(env);
  const after = lines[i];
  if (after !== undefined && after.indent === line.indent) {
    const afterToks = tokenize(after, budget);
    if (isId(afterToks[0] as Tok, 'else')) {
      if (isId(afterToks[1] as Tok, 'if')) {
        // Rewrite `else if x` as an `if x` line and run it in the else environment.
        const rewritten: Line[] = lines.slice();
        rewritten[i] = { no: after.no, indent: after.indent, text: after.text.replace(/^else\s+/, '') };
        i = handleIf(script, elseEnv, rewritten, i, budget);
      } else {
        if ((afterToks[1] as Tok).t !== 'eof') refuse(after.no, "unexpected text after 'else'");
        i = block(script, elseEnv, lines, i + 1, after.indent, budget);
      }
    }
  }
  for (const [name, base] of env) {
    if (base.kind !== 'variable') continue;
    const t = thenEnv.get(name);
    const e = elseEnv.get(name);
    if (t === undefined || e === undefined || t.kind !== 'variable' || e.kind !== 'variable') continue;
    if (t.current === base.current && e.current === base.current) continue;
    env.set(name, { ...base, current: ['?', cond, t.current, e.current] });
  }
  return i;
}

// ---------- resolution ----------
//
// Three placeholders leave the parser: @carry name (a var's value before any := on this bar),
// @prev name (the variable's value at the end of the previous bar) and @final name (its value
// at the end of this bar). A variable whose final expression reads its own @carry or @prev is
// a recurrence and becomes [recur, init, step] with those leaves as prev; every other
// placeholder is the referenced variable's resolved expression, shifted where it has to be.

function placeholderOf(e: Expr): [string, string] | null {
  if (typeof e !== 'object') return null;
  const op = e[0];
  if (op === '@carry' || op === '@prev' || op === '@final') return [op, e[1] as string];
  return null;
}

function refersToSelf(e: Expr, name: string): boolean {
  if (typeof e !== 'object') return false;
  const ph = placeholderOf(e);
  if (ph !== null) return ph[1] === name && ph[0] !== '@final';
  for (let i = 1; i < e.length; i++) if (refersToSelf(e[i] as Expr, name)) return true;
  return false;
}

type Resolver = {
  vars: Env;
  done: Map<string, Expr>;
  stack: string[];
  memo: Map<Expr, Expr>;
};

function resolveExpr(r: Resolver, e: Expr, self: string | null): Expr {
  if (typeof e !== 'object') return e;
  const ph = placeholderOf(e);
  if (ph !== null) {
    const [op, name] = ph;
    if (self !== null && name === self) {
      if (op === '@carry') return 'prev';
      if (op === '@prev') return ['?', ['==', 'bar_index', 0], 'na', 'prev'];
      throw new Refusal(0, `${name} reads its own final value`);
    }
    const b = r.vars.get(name);
    if (b === undefined || b.kind !== 'variable') throw new Refusal(0, `${name} is not a variable`);
    if (op === '@final') return resolveVar(r, name);
    if (op === '@prev') return ['hist', resolveVar(r, name), 1];
    const init = b.isVar && b.init !== null ? resolveExpr(r, b.init, null) : 'na';
    return ['?', ['==', 'bar_index', 0], init, ['hist', resolveVar(r, name), 1]];
  }
  const cached = self === null ? r.memo.get(e) : undefined;
  if (cached !== undefined) return cached;
  const out: ExprNode = [e[0]];
  for (let i = 1; i < e.length; i++) out.push(resolveExpr(r, e[i] as Expr, self));
  if (self === null) r.memo.set(e, out);
  return out;
}

function resolveVar(r: Resolver, name: string): Expr {
  const have = r.done.get(name);
  if (have !== undefined) return have;
  const b = r.vars.get(name);
  if (b === undefined || b.kind !== 'variable') throw new Refusal(0, `${name} is not a variable`);
  if (r.stack.includes(name)) throw new Refusal(b.line, `${[...r.stack.slice(r.stack.indexOf(name)), name].join(' and ')} depend on each other through their history`);
  r.stack.push(name);
  let out: Expr;
  if (refersToSelf(b.current, name)) {
    const init = b.isVar && b.init !== null ? resolveExpr(r, b.init, null) : 'na';
    out = ['recur', init, resolveExpr(r, b.current, name)];
  } else {
    out = resolveExpr(r, b.current, null);
  }
  r.stack.pop();
  r.done.set(name, out);
  return out;
}

// ---------- entry ----------

function translate(source: string): PineResult {
  if (source.length > SOURCE_CAP) refuse(0, `the script is too large (${Math.round(source.length / 1024)} KB, the cap is ${SOURCE_CAP / 1024} KB)`);
  const { version, lines } = logicalLines(source);
  if (version !== 5) refuse(1, version === null ? 'add //@version=5 as the first line' : `//@version=${version} is not supported; only //@version=5`);
  const script: Script = { title: null, overlay: false, inputs: {}, plots: [], hlines: [], ignored: [], vars: new Map(), order: [] };
  const budget = { tokens: 0 };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as Line;
    if (line.indent !== 0) refuse(line.no, 'unexpected indentation');
    i = statement(script, script.vars, lines, i, budget, false);
  }
  if (script.title === null) refuse(1, 'indicator(...) is missing');
  if (script.plots.length === 0) refuse(lines[lines.length - 1]?.no ?? 1, 'the script plots nothing');
  const r: Resolver = { vars: script.vars, done: new Map(), stack: [], memo: new Map() };
  const plots: CustomPlot[] = [];
  for (const plot of script.plots) {
    let expr: Expr;
    try {
      expr = resolveExpr(r, plot.expr, null);
    } catch (err) {
      if (err instanceof Refusal) throw new Refusal(err.line === 0 ? plot.line : err.line, err.message);
      throw err;
    }
    const out: CustomPlot = { title: plot.title, expr };
    if (plot.color !== undefined) out.color = plot.color;
    if (plot.style !== undefined) out.style = plot.style;
    plots.push(out);
  }
  const indicator: CustomIndicator = { title: script.title, overlay: script.overlay, inputs: script.inputs, plots };
  if (script.hlines.length > 0) indicator.hlines = script.hlines;
  const valid = customIndicatorSchema.safeParse(indicator);
  if (!valid.success) {
    const issue = valid.error.issues[0];
    const plotIndex = issue !== undefined && issue.path[0] === 'plots' && typeof issue.path[1] === 'number' ? issue.path[1] : null;
    const line = plotIndex !== null ? (script.plots[plotIndex]?.line ?? 0) : 0;
    refuse(line, issue?.message ?? 'the translated indicator does not validate');
  }
  return { ok: true, indicator: valid.data, ignored: script.ignored };
}

export function translatePine(source: string): PineResult {
  try {
    return translate(source);
  } catch (err) {
    if (err instanceof Refusal) return { ok: false, line: err.line, message: err.message };
    return { ok: false, line: 0, message: `translator error: ${err instanceof Error ? err.message : String(err)}` };
  }
}
