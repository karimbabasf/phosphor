// The checks fold, rendered.
//
// ui/screens/checks.js draws a proposal's preflight (src/preflight/) as a folded rail of five
// nodes under the receipt and inside the send card. Held to what a person would see: the five
// nodes in the backend's order, a dot and a number in the state's colour, the sentence under
// each, the sparkline on the gas node with the vendor's limit dashed across it, and a fold that
// opens and closes on its one button. Nothing here computes a number: every word is the row's.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const CHECKS = readFileSync(new URL('../../ui/screens/checks.js', import.meta.url), 'utf8');

type Node = {
  tag: string;
  className: string;
  textContent: string;
  hidden: boolean;
  type: string;
  attrs: Record<string, string>;
  children: Node[];
  listeners: Record<string, Array<() => void>>;
  appendChild(c: Node): Node;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  addEventListener(type: string, fn: () => void): void;
};

function node(tag: string): Node {
  let ownText = '';
  const n: Node = {
    tag,
    className: '',
    get textContent() {
      return n.children.length ? n.children.map((c) => c.textContent).join('') : ownText;
    },
    set textContent(value: string) {
      n.children.length = 0;
      ownText = String(value);
    },
    hidden: false,
    type: '',
    attrs: {},
    children: [],
    listeners: {},
    appendChild(c) {
      n.children.push(c);
      return c;
    },
    getAttribute: (name) => n.attrs[name] ?? null,
    setAttribute(name, value) {
      n.attrs[name] = value;
      if (name === 'class') n.className = value;
    },
    addEventListener(type, fn) {
      (n.listeners[type] ??= []).push(fn);
    },
  };
  return n;
}

function domFor() {
  return {
    el(tag: string, className?: string, text?: unknown) {
      const n = node(tag);
      if (className) n.className = className;
      if (text !== undefined && text !== null) n.textContent = String(text);
      return n;
    },
    setText(n: Node, text: unknown) {
      n.textContent = text === undefined || text === null ? '' : String(text);
    },
    setAttr(n: Node, name: string, value: unknown) {
      if (value === null || value === false || value === undefined) delete n.attrs[name];
      else n.attrs[name] = value === true ? '' : String(value);
    },
    setHidden(n: Node, hidden: boolean) {
      n.hidden = !!hidden;
    },
    on(n: Node, type: string, fn: () => void) {
      n.addEventListener(type, fn);
    },
  };
}

function all(n: Node, className: string, out: Node[] = []): Node[] {
  if (String(n.className).split(' ').includes(className)) out.push(n);
  for (const c of n.children) all(c, className, out);
  return out;
}

function byTag(n: Node, tag: string, out: Node[] = []): Node[] {
  if (n.tag === tag) out.push(n);
  for (const c of n.children) byTag(c, tag, out);
  return out;
}

function fire(n: Node, type: string): void {
  for (const fn of n.listeners[type] ?? []) fn();
}

type Checks = {
  fold: (host: Node, preflight: unknown, opts?: Record<string, unknown>) => Node | null;
  rail: (preflight: unknown) => Node;
  sparkline: (series: unknown, limit?: unknown, state?: string) => Node | null;
  summaryOf: (preflight: unknown) => string;
  ORDER: string[];
};

function load(): Checks {
  const sandbox: Record<string, unknown> = {
    window: { PhosphorDom: domFor() },
    document: { createElement: (tag: string) => node(tag), createElementNS: (_ns: string, tag: string) => node(tag) },
    console,
  };
  createContext(sandbox);
  runInContext(CHECKS, sandbox, { filename: 'ui/screens/checks.js' });
  return (sandbox.window as { PhosphorChecks: Checks }).PhosphorChecks;
}

const SERIES = [145392, 145390, 145401, 145388, 160210, 201455, 300024];

function preflightOf(over: Record<string, unknown> = {}) {
  return {
    at: '2026-09-15T19:15:40.000Z',
    verdict: 'hold',
    holdReason: 'Waiting for Arbitrum gas to settle',
    checks: [
      { id: 'gas', label: 'Arbitrum gas', state: 'fail', value: '300,024 / 300,000', detail: "1Click's relayer sweeps the payout with a 300,000 gas limit. Right now the sweep needs about 300,024, 155,024 of it L1 data, 2.1x the hourly average.", series: SERIES, limit: 300000 },
      { id: 'coverage', label: 'Fee covers the payout', state: 'ok', value: '4.6x', detail: '$0.34 fee against about $0.07 of gas on Arbitrum (300,024 units at today\'s price).' },
      { id: 'venue', label: 'Venue answering', state: 'ok', value: '212 ms', detail: 'A dry quote answered in 212 ms and the status endpoint is reachable.' },
      { id: 'balance', label: 'Balance', state: 'ok', value: '50 USDC', detail: 'USDC inside NEAR Intents reads 50 USDC, and this move needs 10 USDC.' },
      { id: 'deadline', label: 'Quote still valid', state: 'warn', value: '4 min', detail: 'The quote is good until 2026-09-15T19:20:00.000Z; the intent is signed and submitted within seconds of this check.' },
    ],
    ...over,
  };
}

test('the fold draws five nodes in the backend\'s order, each with its label, its number and its sentence', () => {
  const checks = load();
  const host = node('div');
  const section = checks.fold(host, preflightOf());
  assert.ok(section, 'nothing was drawn');
  assert.equal(host.children[0], section);
  assert.equal(section.getAttribute('data-verdict'), 'hold');

  const nodes = all(section, 'checks-node');
  assert.deepEqual(nodes.map((n) => n.getAttribute('data-id')), ['gas', 'coverage', 'venue', 'balance', 'deadline']);
  assert.deepEqual(all(section, 'checks-label').map((n) => n.textContent), ['Arbitrum gas', 'Fee covers the payout', 'Venue answering', 'Balance', 'Quote still valid']);
  assert.deepEqual(all(section, 'checks-value').map((n) => n.textContent), ['300,024 / 300,000', '4.6x', '212 ms', '50 USDC', '4 min']);
  assert.ok(all(section, 'checks-value').every((n) => n.className.includes('mono')), 'the numbers are mono');
  assert.equal(all(section, 'checks-detail').length, 5);
  assert.match(all(section, 'checks-detail')[0]!.textContent, /2\.1x the hourly average/);
  assert.equal(all(section, 'checks-rail')[0]?.tag, 'ol');
  assert.equal(all(section, 'checks-when')[0]?.textContent.slice(0, 11), 'Checked at ');
});

test('states map to the node and the dot: ok, warn, fail', () => {
  const checks = load();
  const section = checks.fold(node('div'), preflightOf())!;
  const nodes = all(section, 'checks-node');
  assert.deepEqual(nodes.map((n) => n.getAttribute('data-state')), ['fail', 'ok', 'ok', 'ok', 'warn']);
  for (const n of nodes) assert.equal(all(n, 'checks-dot').length, 1, 'one dot per node');
  // A state the backend never writes is drawn as ok rather than as nothing.
  const odd = checks.fold(node('div'), preflightOf({ checks: [{ id: 'venue', label: 'Venue answering', state: 'weird', value: '1 ms', detail: '' }] }))!;
  assert.equal(all(odd, 'checks-node')[0]?.getAttribute('data-state'), 'ok');
});

test('the sparkline draws on the gas node when a series exists, with the limit dashed and the last point in the state\'s colour', () => {
  const checks = load();
  const section = checks.fold(node('div'), preflightOf())!;
  const nodes = all(section, 'checks-node');
  const spark = all(nodes[0]!, 'checks-spark');
  assert.equal(spark.length, 1, 'the gas node carries the sparkline');
  assert.equal(spark[0]!.getAttribute('viewBox'), '0 0 120 28');
  assert.equal(spark[0]!.getAttribute('width'), '120');
  assert.equal(spark[0]!.getAttribute('height'), '28');
  assert.equal(spark[0]!.getAttribute('data-points'), String(SERIES.length));
  assert.equal(all(spark[0]!, 'checks-spark-limit').length, 1, 'the vendor limit is a line');
  const line = all(spark[0]!, 'checks-spark-line')[0]!;
  assert.match(line.getAttribute('d') ?? '', /^M2\.0 .* L118\.0 /, 'the path spans the box');
  const now = all(spark[0]!, 'checks-spark-now')[0]!;
  assert.equal(now.getAttribute('data-state'), 'fail');
  // The last reading sits above the limit, so its dot is above the dashed line (smaller y).
  const limitY = Number(all(spark[0]!, 'checks-spark-limit')[0]!.getAttribute('y1'));
  assert.ok(Number(now.getAttribute('cy')) <= limitY, 'the surge sits at or above the limit on the picture');
  assert.ok(limitY > 2, 'the limit is a line across the picture, not its top edge');
  // No series, no picture: the other four nodes carry none.
  for (const n of nodes.slice(1)) assert.equal(all(n, 'checks-spark').length, 0);
});

test('a single reading is still a line, and a series without a limit draws no dashed line', () => {
  const checks = load();
  const one = checks.sparkline([145392], 300000, 'ok')!;
  assert.equal(one.getAttribute('data-points'), '1');
  assert.match(all(one, 'checks-spark-line')[0]!.getAttribute('d') ?? '', /^M2 .* L118 /);
  const eth = checks.sparkline([0.9, 1.1, 5.0], undefined, 'fail')!;
  assert.equal(all(eth, 'checks-spark-limit').length, 0);
  assert.equal(checks.sparkline([], 300000), null);
});

test('the fold is closed by default, opens and closes on its button, and says what it holds', () => {
  const checks = load();
  const section = checks.fold(node('div'), preflightOf())!;
  const toggle = byTag(section, 'button')[0]!;
  assert.equal(toggle.type, 'button');
  assert.equal(section.getAttribute('data-open'), 'false');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(all(toggle, 'checks-toggle-word')[0]?.textContent, 'Checks');
  assert.equal(all(toggle, 'checks-summary')[0]?.textContent, 'Waiting on 1 of 5');
  assert.equal(all(toggle, 'checks-chevron').length, 1);
  fire(toggle, 'click');
  assert.equal(section.getAttribute('data-open'), 'true');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  fire(toggle, 'click');
  assert.equal(section.getAttribute('data-open'), 'false');

  const open = checks.fold(node('div'), preflightOf(), { open: true })!;
  assert.equal(open.getAttribute('data-open'), 'true');
});

test('the summary line reads the verdict: all clear, to watch, waiting, stopped', () => {
  const checks = load();
  const clear = preflightOf({ verdict: 'ok', checks: preflightOf().checks.map((c) => ({ ...c, state: 'ok' })) });
  assert.equal(checks.summaryOf(clear), '5 checks, all clear');
  const watch = preflightOf({ verdict: 'ok', checks: preflightOf().checks.map((c) => ({ ...c, state: c.id === 'gas' ? 'warn' : 'ok' })) });
  assert.equal(checks.summaryOf(watch), '5 checks, 1 to watch');
  assert.equal(checks.summaryOf(preflightOf()), 'Waiting on 1 of 5');
  assert.equal(checks.summaryOf(preflightOf({ verdict: 'fail' })), 'Stopped by 1 of 5');
});

test('nothing is drawn for a row without checks, and a check the row lacks is not invented', () => {
  const checks = load();
  const host = node('div');
  assert.equal(checks.fold(host, null), null);
  assert.equal(host.children.length, 0);
  const three = checks.rail({ checks: preflightOf().checks.slice(0, 3) });
  assert.equal(all(three, 'checks-node').length, 3);
});
