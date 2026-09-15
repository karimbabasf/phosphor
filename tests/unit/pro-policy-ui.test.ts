// The Policy card on the Pro screen.
//
// Karim, 2026-09-14: "this thing should be policy and not limits, we shouldnt have limits
// unless specified. we should have a policy that is simple and easy to read and understand."
//
// So the card draws one .rule row per rule that is set, in the app's own voice, from the
// server's sentences (src/policy/render.ts): what gets asked, what gets refused at once, what
// gets refused over a day, what is held back for gas, where money may go. The one meter on the
// card sits under the daily rule and is drawn only while a daily cap exists; the sub line
// counts only the rules that are drawn. Nothing on the card ever says "$0 of $0".
//
// Run against the REAL ui/screens/pro.js, ui/core/dom.js and ui/design/marks.js over a
// stand-in DOM, the way the other *-ui tests do.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

type Any = Record<string, any>;

const DOM = readFileSync(new URL('../../ui/core/dom.js', import.meta.url), 'utf8');
const MARKS = readFileSync(new URL('../../ui/design/marks.js', import.meta.url), 'utf8');
const PRO = readFileSync(new URL('../../ui/screens/pro.js', import.meta.url), 'utf8');

function makeStyle(): Any {
  const props: Record<string, string> = {};
  const style: Any = {
    setProperty: (name: string, value: string) => {
      props[name] = value;
    },
    removeProperty: (name: string) => {
      delete props[name];
    },
    getPropertyValue: (name: string) => props[name] ?? '',
  };
  return style;
}

function makeNode(tagName: string): Any {
  const attrs: Record<string, string> = {};
  const listeners: Record<string, Array<(ev: unknown) => void>> = {};
  const node: Any = {
    tagName,
    id: '',
    className: '',
    textContent: '',
    hidden: false,
    dataset: {},
    style: makeStyle(),
    childNodes: [],
    parentNode: null,
    listeners,
    get children() {
      return node.childNodes;
    },
    get firstChild() {
      return node.childNodes[0] ?? null;
    },
    get nextSibling() {
      const siblings = node.parentNode?.childNodes ?? [];
      return siblings[siblings.indexOf(node) + 1] ?? null;
    },
    appendChild(child: Any) {
      child.parentNode?.removeChild(child);
      child.parentNode = node;
      node.childNodes.push(child);
      return child;
    },
    insertBefore(child: Any, before: Any) {
      child.parentNode?.removeChild(child);
      child.parentNode = node;
      const at = before === null ? node.childNodes.length : node.childNodes.indexOf(before);
      node.childNodes.splice(at < 0 ? node.childNodes.length : at, 0, child);
      return child;
    },
    removeChild(child: Any) {
      const at = node.childNodes.indexOf(child);
      if (at >= 0) node.childNodes.splice(at, 1);
      child.parentNode = null;
      return child;
    },
    setAttribute: (name: string, value: string) => {
      attrs[name] = value;
    },
    getAttribute: (name: string) => attrs[name] ?? null,
    hasAttribute: (name: string) => name in attrs,
    removeAttribute: (name: string) => {
      delete attrs[name];
    },
    addEventListener: (type: string, fn: (ev: unknown) => void) => {
      (listeners[type] = listeners[type] ?? []).push(fn);
    },
    removeEventListener: () => {},
    click: () => {
      for (const fn of listeners.click ?? []) fn({ preventDefault() {} });
    },
    querySelectorAll: () => [],
  };
  return node;
}

/* The card wearing a surface id, wherever the deck put it. */
function bySurface(node: Any, surface: string): Any | undefined {
  if (node.dataset?.surface === surface) return node;
  for (const child of node.childNodes) {
    const found = bySurface(child, surface);
    if (found) return found;
  }
  return undefined;
}

function withClass(node: Any, name: string, out: Any[] = []): Any[] {
  if (String(node.className).split(' ').includes(name)) out.push(node);
  for (const child of node.childNodes) withClass(child, name, out);
  return out;
}

function textOf(node: Any): string {
  const own = node.textContent ? [String(node.textContent)] : [];
  return own.concat(node.childNodes.map(textOf)).filter((s: string) => s !== '').join(' ');
}

function boot(): { host: Any; render: (state: Any) => void } {
  const host = makeNode('div');
  host.id = 'view-pro';
  let subscriber: ((state: Any) => void) | null = null;
  let current: Any = {};
  const document: Any = {
    createElement: (tag: string) => makeNode(tag),
    createElementNS: (_ns: string, tag: string) => makeNode(tag),
    getElementById: (id: string) => (id === 'view-pro' ? host : null),
    body: { dataset: { view: 'pro' } },
    hidden: false,
    documentElement: makeNode('html'),
  };
  const window: Any = {
    document,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    PhosphorMotion: { reduced: () => true },
    PhosphorNet: { readable: (err: unknown) => String(err) },
    PhosphorApi: { trade: () => Promise.resolve({ data: null }) },
    PhosphorState: {
      subscribe: (fn: (state: Any) => void) => {
        subscriber = fn;
      },
      get: () => current,
      loaded: () => false,
    },
    PhosphorReceipts: { list: () => ({ load: () => Promise.resolve([]), setWindow: () => {}, setKind: () => {}, expand: () => {}, get: () => [] }) },
    // The icon set (ui/design/icons.js): one stand-in svg per name, so every rule can be
    // checked for the icon it asked for.
    PhosphorIcons: { svg: (name: string) => { const n = makeNode('svg'); n.className = 'icon'; n.dataset.icon = name; return n; } },
    PhosphorShell: { setView: () => {} },
  };
  window.window = window;
  const ctx = createContext({ window, document, console, Promise });
  runInContext(DOM, ctx);
  runInContext(MARKS, ctx);
  runInContext(PRO, ctx);
  window.PhosphorPro.boot();
  return {
    host,
    render: (state: Any) => {
      current = state;
      subscriber!(state);
    },
  };
}

const SENTENCES = [
  'Refuse any single transaction above $10,000.',
  'Refuse more than $25,000 in any 24 hours.',
  'Ask me before anything above $100.',
  'Additional allowed destinations: 0xabc, 0xdef, oneclick:1click.chaindefuser.com, intents.near.',
  'Keep at least $1 of gas on base.',
  'Keep at least $1 of gas on arb.',
  'Keep at least $0.50 of gas on sol.',
];

const POLICY = {
  outbound: { destinationAllowlist: ['0xabc', '0xdef', 'oneclick:1click.chaindefuser.com', 'intents.near'] },
  approval: { thresholdUsd: 100 },
};

function panelOf(host: Any): Any {
  const panel = bySurface(host, 'rules');
  assert.ok(panel, 'the policy panel keeps the rules surface');
  return panel;
}

test('the card is called Policy and keeps the surface the beam aims at', () => {
  const { host, render } = boot();
  render({ policy: POLICY, sentences: SENTENCES, dailyLimit: { capUsd: 25_000, spentUsd: 1150.2, resetsAt: null } });
  const panel = panelOf(host);
  const title = withClass(panel, 'card-title')[0];
  assert.equal(title.textContent, 'Policy');
  assert.equal(panel.dataset.surface, 'rules');
});

test('five rules, in the app voice, in the order a person needs them', () => {
  const { host, render } = boot();
  render({ policy: POLICY, sentences: SENTENCES, dailyLimit: { capUsd: 25_000, spentUsd: 1150.2, resetsAt: null } });
  const panel = panelOf(host);
  const rules = withClass(panel, 'rule');
  assert.equal(rules.length, 5);
  assert.deepEqual(
    rules.map((r) => r.dataset.rule),
    ['ask', 'refuse', 'daily', 'gas', 'destinations'],
  );
  const lines = rules.map((r) => withClass(r, 'rule-line')[0].textContent);
  assert.deepEqual(lines, [
    'Asks you before anything above $100.',
    'Refuses any single transaction above $10,000.',
    'Refuses more than $25,000 in any 24 hours.',
    'Keeps gas back on each chain.',
    'Pays only 2 wallets of yours, 1Click and NEAR Intents.',
  ]);
  // The gas floors, one chip per chain under the sentence, each wearing the chain's mark.
  assert.deepEqual(withClass(rules[3], 'gas-chip-text').map((n) => n.textContent), ['Base $1', 'Arbitrum $1', 'Solana $0.50']);
  assert.equal(withClass(rules[3], 'gas-chip-mark').length, 3);
  // Every rule carries its icon, from the set, by what the rule does.
  assert.deepEqual(
    rules.map((r) => withClass(r, 'rule-glyph')[0].childNodes[0].dataset.icon),
    ['waiting', 'refused', 'refused', 'lock', 'send'],
  );
  // The rules sit in four groups with a heading each, in the order a person needs them.
  const groups = withClass(panel, 'rule-group');
  assert.deepEqual(groups.map((g) => g.dataset.group), ['ask', 'refuse', 'keep', 'pay']);
  assert.deepEqual(groups.map((g) => textOf(withClass(g, 'rule-group-title')[0])), ['Asks first', 'Refuses', 'Keeps', 'Pays only']);
  assert.deepEqual(groups.map((g) => withClass(g, 'rule').length), [1, 2, 1, 1]);
  // The sub line counts what is drawn and says what was spent.
  assert.equal(withClass(panel, 'card-meta')[0].textContent, '5 rules, $1,150.20 spent today');
  // The foot is one line.
  const foot = withClass(panel, 'meta').find((n) => /Ask your assistant/.test(n.textContent))!;
  assert.equal(foot.textContent, 'Ask your assistant to change a rule. Every change waits for your click.');
});

test('the daily rule carries the one meter, with what was used at its right end', () => {
  const { host, render } = boot();
  render({ policy: POLICY, sentences: SENTENCES, dailyLimit: { capUsd: 25_000, spentUsd: 1150.2, resetsAt: null } });
  const panel = panelOf(host);
  const meters = withClass(panel, 'rule-meter');
  assert.equal(meters.length, 1);
  const daily = withClass(panel, 'rule').find((r) => r.dataset.rule === 'daily')!;
  assert.equal(withClass(daily, 'rule-meter').length, 1, 'the meter sits under the daily rule');
  assert.equal(meters[0].style.getPropertyValue('--used'), '4.60%');
  assert.equal(meters[0].getAttribute('data-spent'), 'true');
  assert.equal(withClass(daily, 'rule-figure')[0].textContent, '$1,150.20 used');
  assert.equal(withClass(panel, 'meter').length, 0, 'the wide Limit per day meter is gone');
  assert.ok(!/Limit per day/.test(textOf(panel)));
});

test('nothing spent is said in words, and the meter draws no fill', () => {
  const { host, render } = boot();
  render({ policy: POLICY, sentences: SENTENCES, dailyLimit: { capUsd: 25_000, spentUsd: 0, resetsAt: null } });
  const panel = panelOf(host);
  assert.equal(withClass(panel, 'card-meta')[0].textContent, '5 rules, nothing spent today');
  const meter = withClass(panel, 'rule-meter')[0];
  assert.equal(meter.style.getPropertyValue('--used'), '0.00%');
  assert.equal(meter.getAttribute('data-spent'), null);
  assert.equal(withClass(panel, 'rule-figure')[0].textContent, '$0 used');
});

test('a policy with no daily cap draws no daily rule, no meter and no zero of zero', () => {
  const { host, render } = boot();
  const sentences = SENTENCES.filter((s) => !/in any 24 hours/.test(s));
  render({ policy: POLICY, sentences, dailyLimit: null });
  const panel = panelOf(host);
  const rules = withClass(panel, 'rule');
  assert.equal(rules.length, 4);
  assert.deepEqual(rules.map((r) => r.dataset.rule), ['ask', 'refuse', 'gas', 'destinations']);
  assert.equal(withClass(panel, 'rule-meter').length, 0);
  assert.equal(withClass(panel, 'rule-figure').length, 0);
  assert.equal(withClass(panel, 'card-meta')[0].textContent, '4 rules');
  assert.ok(!/\$0 of \$0/.test(textOf(panel)));
});

test('a daily sentence with no counter behind it is a rule without a gauge', () => {
  const { host, render } = boot();
  render({ policy: POLICY, sentences: SENTENCES, dailyLimit: null });
  const panel = panelOf(host);
  assert.equal(withClass(panel, 'rule').length, 5);
  assert.equal(withClass(panel, 'rule-meter').length, 0);
  assert.equal(withClass(panel, 'card-meta')[0].textContent, '5 rules');
});

test('rules that are not set are not drawn, and the count follows', () => {
  const { host, render } = boot();
  render({
    policy: { outbound: { destinationAllowlist: [] }, approval: { thresholdUsd: 100 } },
    sentences: ['Ask me before anything above $100.', 'Refuse any single transaction above $10,000.'],
    dailyLimit: null,
  });
  const panel = panelOf(host);
  const rules = withClass(panel, 'rule');
  assert.deepEqual(rules.map((r) => r.dataset.rule), ['ask', 'refuse']);
  assert.equal(withClass(panel, 'card-meta')[0].textContent, '2 rules');
  assert.equal(withClass(panel, 'allowlist').length, 0);
});

test('the destinations rule opens onto the addresses and folds them again', () => {
  const { host, render } = boot();
  render({ policy: POLICY, sentences: SENTENCES, dailyLimit: null });
  const panel = panelOf(host);
  const door = withClass(panel, 'rule').find((r) => r.dataset.rule === 'destinations')!;
  assert.equal(door.tagName, 'button');
  assert.ok(String(door.className).split(' ').includes('opens'));
  assert.equal(withClass(door, 'chev').length, 1);
  const box = withClass(panel, 'allowlist')[0];
  assert.equal(box.hidden, true);
  assert.equal(door.getAttribute('aria-expanded'), 'false');
  assert.deepEqual(withClass(box, 'addr').map((n) => n.textContent), ['0xabc', '0xdef']);
  door.click();
  assert.equal(box.hidden, false);
  assert.equal(door.getAttribute('aria-expanded'), 'true');
  assert.equal(door.getAttribute('data-open'), 'true');
  // A frame that arrives while the list is open leaves it open.
  render({ policy: POLICY, sentences: SENTENCES, dailyLimit: null });
  const again = withClass(panelOf(host), 'allowlist')[0];
  assert.equal(again.hidden, false);
});

test('an allowlist of venues alone is a static rule: nothing to open, no caret', () => {
  const { host, render } = boot();
  render({
    policy: { outbound: { destinationAllowlist: ['oneclick:1click.chaindefuser.com', 'intents.near', 'hyperliquid-perps'] } },
    sentences: SENTENCES,
    dailyLimit: null,
  });
  const panel = panelOf(host);
  const door = withClass(panel, 'rule').find((r) => r.dataset.rule === 'destinations')!;
  assert.equal(door.tagName, 'div');
  assert.equal(withClass(door, 'rule-line')[0].textContent, 'Pays only 1Click, NEAR Intents and Hyperliquid.');
  assert.equal(withClass(door, 'chev').length, 0);
  assert.equal(withClass(panel, 'allowlist').length, 0);
});

test('a sentence the card does not know the shape of is kept whole under Refuses, and the kill switch leads', () => {
  const { host, render } = boot();
  render({
    policy: POLICY,
    sentences: SENTENCES.concat(['Never move funds into: Tether.', 'KILL SWITCH ON: all writes refused.']),
    dailyLimit: { capUsd: 25_000, spentUsd: 0, resetsAt: null },
  });
  const panel = panelOf(host);
  const rules = withClass(panel, 'rule');
  assert.deepEqual(
    rules.map((r) => r.dataset.rule),
    ['kill', 'ask', 'refuse', 'daily', 'other', 'gas', 'destinations'],
  );
  assert.equal(withClass(rules[0], 'rule-line')[0].textContent, 'Refuses everything while the kill switch is on.');
  assert.equal(rules[0].dataset.tone, 'down');
  assert.equal(rules[0].parentNode.className, 'rules', 'the kill switch sits above every group');
  assert.equal(withClass(rules[4], 'rule-line')[0].textContent, 'Never move funds into: Tether.');
  assert.equal(rules[4].parentNode.parentNode.dataset.group, 'refuse', 'a sentence of unknown shape is a refusal');
  assert.equal(withClass(panel, 'card-meta')[0].textContent, '7 rules, nothing spent today');
});

test('no policy at all is said in words, not as an empty box', () => {
  const { host, render } = boot();
  render({ policy: {}, sentences: [], dailyLimit: null });
  const panel = panelOf(host);
  assert.equal(withClass(panel, 'rule').length, 0);
  assert.equal(withClass(panel, 'empty-title')[0].textContent, 'No rules set');
  assert.equal(withClass(panel, 'card-meta')[0].textContent, '0 rules');
});

/* Twenty rules must still read. A group with more than five rows folds to its heading and a
   count, opens on a click, and stays open across the next frame. */
test('a group over five rows folds to its heading and a count, and opens on a click', () => {
  const { host, render } = boot();
  const extra = ['Never move funds into: Tether.', 'Never move funds into: Maker.', 'Never move funds into: Paxos.',
    'Never move funds into: Ethena.', 'Never move funds into: Sky.'];
  const frame = { policy: POLICY, sentences: SENTENCES.concat(extra), dailyLimit: null };
  render(frame);
  const panel = panelOf(host);
  const refuses = withClass(panel, 'rule-group').find((g) => g.dataset.group === 'refuse')!;
  const head = withClass(refuses, 'rule-group-title')[0];
  assert.equal(head.tagName, 'button', 'over five rows the heading is the control');
  assert.equal(withClass(head, 'rule-group-count')[0].textContent, '7');
  assert.equal(head.getAttribute('aria-expanded'), 'false');
  const rows = withClass(refuses, 'rule-group-rows')[0];
  assert.equal(rows.hidden, true, 'the rows start folded');
  assert.equal(withClass(refuses, 'rule').length, 7, 'folded rows are still drawn, for the count');
  head.click();
  assert.equal(rows.hidden, false);
  assert.equal(head.getAttribute('aria-expanded'), 'true');
  render(frame);
  const again = withClass(panelOf(host), 'rule-group').find((g) => g.dataset.group === 'refuse')!;
  assert.equal(withClass(again, 'rule-group-rows')[0].hidden, false, 'the choice survives a frame');
  // Under five rows the heading is static.
  const asks = withClass(panelOf(host), 'rule-group').find((g) => g.dataset.group === 'ask')!;
  assert.equal(withClass(asks, 'rule-group-title')[0].tagName, 'h3');
  assert.equal(withClass(panelOf(host), 'card-meta')[0].textContent, '10 rules');
});
