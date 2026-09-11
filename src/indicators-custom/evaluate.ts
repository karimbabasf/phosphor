// The evaluator: a tree walk over Float64Array series with a work budget.
//
// No eval, no Function, no vm. The tree is data validated by schema.ts, and every op is a
// function in this file over typed arrays; NaN is na. What a custom indicator can do is
// exactly what this file can do, and what it can cost is bounded by WORK_BUDGET: every op
// charges the bars it touches, a rolling op charges bars times its period, and the moment
// the total passes the budget the compute stops. The compiled spec never throws: the render
// path in src/http/chart.ts cannot await and cannot catch, so a refusal comes back as a
// result whose plots are empty and whose state line says why.
//
// The four rolling averages mirror src/indicators-kit.ts operation for operation, on purpose.
// A custom SMA that differed from the built-in by a rounding rule would be two lines on one
// chart for one number, and the tests pin them equal to 1e-9.

import type { Candle } from '../types.ts';
import type { IndicatorResult, IndicatorSpec, ParamSpec, Plot } from '../indicators.ts';
import { drift, lastValue, num, versusPrice } from '../indicators-kit.ts';
import { LIMITS, OPS, SERIES } from './schema.ts';
import type { CustomIndicator, CustomInput, CustomPlot, Expr } from './schema.ts';

export const WORK_BUDGET = 2_000_000;

// An input with no bounds of its own is clamped here, wide enough for any period or
// multiplier and narrow enough that an agent cannot pass a number that turns into an
// Infinity three ops later.
const DEFAULT_BOUND = 1_000_000;

class BudgetError extends Error {}

type Env = {
  n: number;
  candles: Candle[];
  params: Record<string, number>;
  base: Map<string, Float64Array>;
  memo: Map<string, Float64Array>;
  work: number;
};

function charge(env: Env, amount: number): void {
  env.work += amount;
  if (env.work > WORK_BUDGET) throw new BudgetError(`work budget of ${WORK_BUDGET} evaluations exceeded`);
}

function blank(n: number): Float64Array {
  const out = new Float64Array(n);
  out.fill(NaN);
  return out;
}

function own(params: Record<string, number>, name: string): number {
  return Object.prototype.hasOwnProperty.call(params, name) ? (params[name] as number) : NaN;
}

function baseSeries(env: Env, name: string): Float64Array {
  const have = env.base.get(name);
  if (have !== undefined) return have;
  const out = new Float64Array(env.n);
  const cs = env.candles;
  switch (name) {
    case 'open':
      for (let i = 0; i < env.n; i++) out[i] = (cs[i] as Candle).o;
      break;
    case 'high':
      for (let i = 0; i < env.n; i++) out[i] = (cs[i] as Candle).h;
      break;
    case 'low':
      for (let i = 0; i < env.n; i++) out[i] = (cs[i] as Candle).l;
      break;
    case 'close':
      for (let i = 0; i < env.n; i++) out[i] = (cs[i] as Candle).c;
      break;
    case 'volume':
      for (let i = 0; i < env.n; i++) out[i] = (cs[i] as Candle).v;
      break;
    case 'hl2':
      for (let i = 0; i < env.n; i++) out[i] = ((cs[i] as Candle).h + (cs[i] as Candle).l) / 2;
      break;
    case 'hlc3':
      for (let i = 0; i < env.n; i++) out[i] = ((cs[i] as Candle).h + (cs[i] as Candle).l + (cs[i] as Candle).c) / 3;
      break;
    case 'ohlc4':
      for (let i = 0; i < env.n; i++) {
        const c = cs[i] as Candle;
        out[i] = (c.o + c.h + c.l + c.c) / 4;
      }
      break;
    case 'bar_index':
      for (let i = 0; i < env.n; i++) out[i] = i;
      break;
    default:
      out.fill(NaN);
  }
  env.base.set(name, out);
  return out;
}

function constant(env: Env, value: number): Float64Array {
  const key = `#${value}`;
  const have = env.base.get(key);
  if (have !== undefined) return have;
  const out = new Float64Array(env.n);
  out.fill(Number.isFinite(value) ? value : NaN);
  env.base.set(key, out);
  return out;
}

function leaf(env: Env, node: number | string): Float64Array {
  if (typeof node === 'number') return constant(env, node);
  if (SERIES.includes(node)) return baseSeries(env, node);
  return constant(env, own(env.params, node));
}

// A period argument is a literal or an input name; either way it is rounded and clamped
// here, so a period that arrived through the agent's params is bounded twice: once by the
// input's own range in normaliseParams and once by the format's hard cap.
function period(params: Record<string, number>, arg: Expr, lo: number, hi: number): number {
  const raw = typeof arg === 'number' ? arg : typeof arg === 'string' ? own(params, arg) : NaN;
  const rounded = Math.round(raw);
  if (!Number.isFinite(rounded)) return lo;
  return Math.min(hi, Math.max(lo, rounded));
}

function truthy(v: number): boolean {
  return v !== 0 && !Number.isNaN(v);
}

// One implementation of every elementwise op, used bar by bar. NaN in is NaN out for the
// arithmetic; the logic ops decide what they can (false and na is false) and pass na on
// otherwise. Anything that leaves the finite range comes back as na rather than Infinity,
// because an Infinity two ops later is a comparison that silently answers true.
function scalar(op: string, a: number[]): number {
  const x = a[0] as number;
  const y = a[1] as number;
  let r: number;
  switch (op) {
    case '+':
      r = x + y;
      break;
    case '-':
      r = a.length === 1 ? -x : x - y;
      break;
    case '*':
      r = x * y;
      break;
    case '/':
      r = y === 0 ? NaN : x / y;
      break;
    case '%':
      r = y === 0 ? NaN : x % y;
      break;
    case '<':
      r = Number.isNaN(x) || Number.isNaN(y) ? NaN : x < y ? 1 : 0;
      break;
    case '<=':
      r = Number.isNaN(x) || Number.isNaN(y) ? NaN : x <= y ? 1 : 0;
      break;
    case '>':
      r = Number.isNaN(x) || Number.isNaN(y) ? NaN : x > y ? 1 : 0;
      break;
    case '>=':
      r = Number.isNaN(x) || Number.isNaN(y) ? NaN : x >= y ? 1 : 0;
      break;
    case '==':
      r = Number.isNaN(x) || Number.isNaN(y) ? NaN : x === y ? 1 : 0;
      break;
    case '!=':
      r = Number.isNaN(x) || Number.isNaN(y) ? NaN : x !== y ? 1 : 0;
      break;
    case 'and':
      if ((!Number.isNaN(x) && x === 0) || (!Number.isNaN(y) && y === 0)) r = 0;
      else if (Number.isNaN(x) || Number.isNaN(y)) r = NaN;
      else r = 1;
      break;
    case 'or':
      if (truthy(x) || truthy(y)) r = 1;
      else if (Number.isNaN(x) || Number.isNaN(y)) r = NaN;
      else r = 0;
      break;
    case 'not':
      r = Number.isNaN(x) ? NaN : x === 0 ? 1 : 0;
      break;
    case '?':
      r = Number.isNaN(x) ? NaN : x !== 0 ? y : (a[2] as number);
      break;
    case 'abs':
      r = Math.abs(x);
      break;
    case 'sqrt':
      r = Math.sqrt(x);
      break;
    case 'log':
      r = Math.log(x);
      break;
    case 'max':
      r = Math.max(...a);
      break;
    case 'min':
      r = Math.min(...a);
      break;
    case 'nz':
      r = Number.isNaN(x) ? (a.length > 1 ? y : 0) : x;
      break;
    case 'na':
      r = Number.isNaN(x) ? 1 : 0;
      break;
    default:
      throw new Error(`no elementwise op '${op}'`);
  }
  return Number.isFinite(r) ? r : NaN;
}

function elementwise(env: Env, op: string, args: Float64Array[]): Float64Array {
  charge(env, env.n);
  const out = new Float64Array(env.n);
  const tmp: number[] = new Array<number>(args.length);
  for (let i = 0; i < env.n; i++) {
    for (let k = 0; k < args.length; k++) tmp[k] = (args[k] as Float64Array)[i] as number;
    out[i] = scalar(op, tmp);
  }
  return out;
}

// ---------- rolling ops ----------
//
// Each one restarts after a NaN, so a window that straddles a hole is a hole, and each one
// is the kit's arithmetic in the kit's order on a dense input.

function smaVec(env: Env, x: Float64Array, p: number): Float64Array {
  charge(env, env.n);
  const out = blank(env.n);
  let sum = 0;
  let start = 0;
  for (let i = 0; i < env.n; i++) {
    const v = x[i] as number;
    if (Number.isNaN(v)) {
      sum = 0;
      start = i + 1;
      continue;
    }
    sum += v;
    const have = i - start + 1;
    if (have > p) sum -= x[i - p] as number;
    if (have >= p) out[i] = sum / p;
  }
  return out;
}

function smoothVec(env: Env, x: Float64Array, p: number, kind: 'ema' | 'rma'): Float64Array {
  charge(env, env.n);
  const out = blank(env.n);
  const alpha = 2 / (p + 1);
  let prev = NaN;
  let seedSum = 0;
  let seeded = 0;
  for (let i = 0; i < env.n; i++) {
    const v = x[i] as number;
    if (Number.isNaN(v)) {
      // Before the seed a hole restarts the seed; after it the average simply skips the bar,
      // which is what emaSparse in the kit does for the wave family.
      if (Number.isNaN(prev)) {
        seedSum = 0;
        seeded = 0;
      }
      continue;
    }
    if (Number.isNaN(prev)) {
      seedSum += v;
      seeded += 1;
      if (seeded < p) continue;
      prev = seedSum / p;
      out[i] = prev;
      continue;
    }
    prev = kind === 'ema' ? v * alpha + prev * (1 - alpha) : (prev * (p - 1) + v) / p;
    out[i] = prev;
  }
  return out;
}

function wmaVec(env: Env, x: Float64Array, p: number): Float64Array {
  charge(env, env.n * p);
  const out = blank(env.n);
  const denom = (p * (p + 1)) / 2;
  for (let i = p - 1; i < env.n; i++) {
    let acc = 0;
    for (let k = 0; k < p; k++) acc += (x[i - p + 1 + k] as number) * (k + 1);
    out[i] = acc / denom;
  }
  return out;
}

function stdevVec(env: Env, x: Float64Array, p: number): Float64Array {
  const mean = smaVec(env, x, p);
  charge(env, env.n * p);
  const out = blank(env.n);
  for (let i = p - 1; i < env.n; i++) {
    const m = mean[i] as number;
    if (Number.isNaN(m)) continue;
    let acc = 0;
    for (let k = 0; k < p; k++) {
      const d = (x[i - k] as number) - m;
      acc += d * d;
    }
    out[i] = Math.sqrt(acc / p);
  }
  return out;
}

// Rolling extreme with a monotonic deque: linear in the bars whatever the period, so a
// 500-bar highest costs the same as a 5-bar one and the budget is not spent on it.
function extremeVec(env: Env, x: Float64Array, p: number, highest: boolean): Float64Array {
  charge(env, env.n);
  const out = blank(env.n);
  const dq: number[] = [];
  let head = 0;
  let lastHole = -1;
  for (let i = 0; i < env.n; i++) {
    const v = x[i] as number;
    if (Number.isNaN(v)) {
      lastHole = i;
      dq.length = 0;
      head = 0;
      continue;
    }
    while (dq.length > head) {
      const tail = x[dq[dq.length - 1] as number] as number;
      if (highest ? tail <= v : tail >= v) dq.pop();
      else break;
    }
    dq.push(i);
    while ((dq[head] as number) <= i - p) head += 1;
    if (i >= p - 1 && i - lastHole >= p) out[i] = x[dq[head] as number] as number;
  }
  return out;
}

function rsiVec(env: Env, x: Float64Array, p: number): Float64Array {
  charge(env, env.n);
  const gains = blank(env.n);
  const losses = blank(env.n);
  for (let i = 1; i < env.n; i++) {
    const now = x[i] as number;
    const before = x[i - 1] as number;
    if (Number.isNaN(now) || Number.isNaN(before)) continue;
    const change = now - before;
    gains[i] = change > 0 ? change : 0;
    losses[i] = change < 0 ? -change : 0;
  }
  const avgGain = smoothVec(env, gains, p, 'rma');
  const avgLoss = smoothVec(env, losses, p, 'rma');
  const out = blank(env.n);
  for (let i = 0; i < env.n; i++) {
    const g = avgGain[i] as number;
    const l = avgLoss[i] as number;
    if (Number.isNaN(g) || Number.isNaN(l)) continue;
    // The kit's rule: no movement at all is 50, not the formula's 100.
    out[i] = l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l);
  }
  return out;
}

function trVec(env: Env): Float64Array {
  const key = '#tr';
  const have = env.base.get(key);
  if (have !== undefined) return have;
  charge(env, env.n);
  const out = new Float64Array(env.n);
  for (let i = 0; i < env.n; i++) {
    const c = env.candles[i] as Candle;
    if (i === 0) {
      out[i] = c.h - c.l;
      continue;
    }
    const prev = (env.candles[i - 1] as Candle).c;
    out[i] = Math.max(c.h - c.l, Math.abs(c.h - prev), Math.abs(c.l - prev));
  }
  env.base.set(key, out);
  return out;
}

function shiftVec(env: Env, x: Float64Array, n: number, diff: boolean): Float64Array {
  charge(env, env.n);
  const out = blank(env.n);
  for (let i = n; i < env.n; i++) {
    const back = x[i - n] as number;
    const r = diff ? (x[i] as number) - back : back;
    out[i] = Number.isFinite(r) ? r : NaN;
  }
  return out;
}

function crossVec(env: Env, a: Float64Array, b: Float64Array, over: boolean): Float64Array {
  charge(env, env.n);
  const out = blank(env.n);
  for (let i = 1; i < env.n; i++) {
    const an = a[i] as number;
    const bn = b[i] as number;
    const ap = a[i - 1] as number;
    const bp = b[i - 1] as number;
    if (Number.isNaN(an) || Number.isNaN(bn) || Number.isNaN(ap) || Number.isNaN(bp)) continue;
    out[i] = over ? (an > bn && ap <= bp ? 1 : 0) : an < bn && ap >= bp ? 1 : 0;
  }
  return out;
}

// ---------- recursion ----------
//
// [recur, init, step]: out[i] = step with prev = (i === 0 ? init[i] : out[i - 1]). Every
// subtree of the step that does not read prev is an ordinary vector, computed once through
// the memo; only the spine that touches prev is walked bar by bar, and the schema has
// already made sure that spine is elementwise.

function dependsOnPrev(node: Expr, deps: Set<Expr>): boolean {
  if (typeof node === 'string') return node === 'prev';
  if (typeof node === 'number') return false;
  let any = false;
  for (let i = 1; i < node.length; i++) if (dependsOnPrev(node[i] as Expr, deps)) any = true;
  if (any) deps.add(node);
  return any;
}

function countNodes(node: Expr): number {
  if (!Array.isArray(node)) return 1;
  let n = 1;
  for (let i = 1; i < node.length; i++) n += countNodes(node[i] as Expr);
  return n;
}

function recurVec(env: Env, init: Expr, step: Expr): Float64Array {
  const initV = evalVec(env, init);
  const deps = new Set<Expr>();
  dependsOnPrev(step, deps);
  charge(env, env.n * countNodes(step));
  const out = blank(env.n);
  const at = (node: Expr, i: number, prev: number): number => {
    if (node === 'prev') return prev;
    if (!Array.isArray(node) || !deps.has(node)) return evalVec(env, node)[i] as number;
    const op = node[0];
    if ((OPS[op]?.kind ?? 'element') !== 'element') throw new Error(`'${op}' cannot read prev`);
    const args: number[] = [];
    for (let k = 1; k < node.length; k++) args.push(at(node[k] as Expr, i, prev));
    return scalar(op, args);
  };
  for (let i = 0; i < env.n; i++) {
    const prev = i === 0 ? (initV[0] as number) : (out[i - 1] as number);
    out[i] = at(step, i, prev);
  }
  return out;
}

// ---------- the walk ----------

function evalNode(env: Env, node: [string, ...Expr[]]): Float64Array {
  const op = node[0];
  const def = OPS[op];
  if (def === undefined) throw new Error(`unknown op '${op}'`);
  const args = node.slice(1) as Expr[];
  switch (def.kind) {
    case 'element':
      return elementwise(
        env,
        op,
        args.map((a) => evalVec(env, a)),
      );
    case 'window': {
      const x = evalVec(env, args[0] as Expr);
      const p = period(env.params, args[1] as Expr, 1, LIMITS.period);
      switch (op) {
        case 'sma':
          return smaVec(env, x, p);
        case 'ema':
          return smoothVec(env, x, p, 'ema');
        case 'rma':
          return smoothVec(env, x, p, 'rma');
        case 'wma':
          return wmaVec(env, x, p);
        case 'stdev':
          return stdevVec(env, x, p);
        case 'highest':
          return extremeVec(env, x, p, true);
        case 'lowest':
          return extremeVec(env, x, p, false);
        case 'rsi':
          return rsiVec(env, x, p);
        default:
          throw new Error(`no rolling op '${op}'`);
      }
    }
    case 'period':
      return smoothVec(env, trVec(env), period(env.params, args[0] as Expr, 1, LIMITS.period), 'rma');
    case 'tr':
      return trVec(env);
    case 'shift': {
      const x = evalVec(env, args[0] as Expr);
      const lo = op === 'hist' ? 0 : 1;
      const n = args.length > 1 ? period(env.params, args[1] as Expr, lo, LIMITS.history) : 1;
      return shiftVec(env, x, n, op === 'change');
    }
    case 'cross':
      return crossVec(env, evalVec(env, args[0] as Expr), evalVec(env, args[1] as Expr), op === 'crossover');
    case 'recur':
      return recurVec(env, args[0] as Expr, args[1] as Expr);
  }
}

function evalVec(env: Env, node: Expr): Float64Array {
  if (!Array.isArray(node)) return leaf(env, node);
  // Keyed on the serialised subtree: a Pine variable used by three plots is inlined three
  // times by the translator, and this is what makes it cost once.
  const key = JSON.stringify(node);
  const have = env.memo.get(key);
  if (have !== undefined) return have;
  const out = evalNode(env, node);
  env.memo.set(key, out);
  return out;
}

// ---------- warmup ----------

function lookback(node: Expr, params: Record<string, number>): number {
  if (!Array.isArray(node)) return 1;
  const op = node[0];
  const def = OPS[op];
  const args = node.slice(1) as Expr[];
  if (def === undefined) return 1;
  switch (def.kind) {
    case 'element':
      return Math.max(1, ...args.map((a) => lookback(a, params)));
    case 'window': {
      const p = period(params, args[1] as Expr, 1, LIMITS.period);
      const base = lookback(args[0] as Expr, params);
      return op === 'rsi' ? base + p : base + p - 1;
    }
    case 'period':
      return period(params, args[0] as Expr, 1, LIMITS.period);
    case 'tr':
      return 1;
    case 'shift': {
      const lo = op === 'hist' ? 0 : 1;
      const n = args.length > 1 ? period(params, args[1] as Expr, lo, LIMITS.history) : 1;
      return lookback(args[0] as Expr, params) + n;
    }
    case 'cross':
      return Math.max(lookback(args[0] as Expr, params), lookback(args[1] as Expr, params)) + 1;
    case 'recur':
      return Math.max(lookback(args[0] as Expr, params), lookback(args[1] as Expr, params));
  }
}

// ---------- the spec ----------

function plotKeys(titles: string[]): string[] {
  const seen = new Map<string, number>();
  return titles.map((title, k) => {
    const base =
      title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || `plot${k + 1}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base}-${count}`;
  });
}

function toPlot(plot: CustomPlot, key: string, k: number, values: Float64Array | null, n: number): Plot {
  const style = plot.style ?? 'line';
  const out: (number | null)[] = new Array<number | null>(n).fill(null);
  if (values !== null) {
    for (let i = 0; i < n; i++) {
      const v = values[i] as number;
      out[i] = Number.isFinite(v) ? v : null;
    }
  }
  const result: Plot = {
    key,
    label: plot.title,
    style,
    // One hue per indicator, so the plots separate by brightness: the first is the line the
    // eye should land on.
    emphasis: Math.max(0.4, 0.9 - k * 0.12),
    values: out,
  };
  if (style === 'histogram') result.signed = true;
  if (plot.color !== undefined) result.tone = plot.color;
  return result;
}

function stateLine(ind: CustomIndicator, candles: Candle[], plots: Plot[]): string {
  const first = plots[0] as Plot;
  if (ind.overlay) return versusPrice(candles, first.values, ind.title);
  const parts: string[] = [];
  let any = false;
  for (const p of plots) {
    const v = lastValue(p.values);
    if (v !== null) any = true;
    parts.push(`${p.label} ${v === null ? 'no value yet' : num(v)}`);
  }
  if (!any) return `${ind.title}: not enough history yet`;
  return `${ind.title}: ${parts.join(', ')}, ${drift(first.values, 5)}`;
}

function compute(ind: CustomIndicator, keys: string[], candles: Candle[], params: Record<string, number>): IndicatorResult {
  const n = candles.length;
  const guides = (ind.hlines ?? []).map((h) => ({ value: h.value, label: h.title ?? num(h.value) }));
  const env: Env = { n, candles, params, base: new Map(), memo: new Map(), work: 0 };
  try {
    const plots = ind.plots.map((plot, k) => toPlot(plot, keys[k] as string, k, evalVec(env, plot.expr), n));
    return { plots, guides, range: null, state: stateLine(ind, candles, plots) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const plots = ind.plots.map((plot, k) => toPlot(plot, keys[k] as string, k, null, n));
    return { plots, guides, range: null, state: `${ind.title}: refused, ${message}` };
  }
}

// A validated indicator becomes a catalogue entry like any built-in: same params, same
// label, same compute signature, so the chart, indicator_list and the browser treat it as
// one more type. The type is 'custom:<slug>' and the slug is the loader's business.
export function compile(ind: CustomIndicator, slug: string): IndicatorSpec {
  const names = Object.keys(ind.inputs);
  const params: ParamSpec[] = names.map((name) => {
    const input = ind.inputs[name] as CustomInput;
    return {
      name,
      def: input.default,
      min: input.min ?? Math.min(-DEFAULT_BOUND, input.default),
      max: input.max ?? Math.max(DEFAULT_BOUND, input.default),
      int: input.int ?? false,
    };
  });
  const keys = plotKeys(ind.plots.map((p) => p.title));
  return {
    type: `custom:${slug}`,
    pane: ind.overlay ? 'price' : 'own',
    summary: `${ind.title}, a custom indicator from indicators/${slug}`,
    params,
    label: (p) => {
      if (names.length === 0) return ind.title;
      const values = names.map((name) => num(Number.isFinite(p[name]) ? (p[name] as number) : (ind.inputs[name] as CustomInput).default));
      return `${ind.title} ${values.join('/')}`;
    },
    warmup: (p) => Math.max(1, ...ind.plots.map((plot) => lookback(plot.expr, p))),
    compute: (candles, p) => compute(ind, keys, candles, p),
  };
}
