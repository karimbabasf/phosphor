// The send card, rendered.
//
// The one card a person reads before money leaves for somebody else, drawn by
// ui/screens/sendcard.js on two surfaces: the decision dock (the real decision.js, with the
// buttons) and the conversation (the real cards.js, from a tool answer that carries no draft).
// Rendered against the same stub DOM the other card tests use, and held to what a person would
// see: the full address in groups of four, a copy that puts the normalised address on the
// clipboard, an explorer link to the right explorer and nowhere else, the first-send badge, the
// stacked layout under 560 px, the fingerprint while Touch ID is up, and no deciding button of
// its own.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const read = (p: string): string => readFileSync(new URL(p, import.meta.url), 'utf8');
const SENDCARD = read('../../ui/screens/sendcard.js');
const DECISION = read('../../ui/screens/decision.js');
const CARDS = read('../../ui/screens/cards.js');
const LINKS = read('../../ui/core/links.js');
const CHECKS = read('../../ui/screens/checks.js');
import { fillChains } from '../fixtures/chains.ts';

type Node = {
  tag: string;
  className: string;
  textContent: string;
  hidden: boolean;
  disabled: boolean;
  type: string;
  href: string;
  target: string;
  rel: string;
  dataset: Record<string, string>;
  attrs: Record<string, string>;
  children: Node[];
  listeners: Record<string, Array<() => void>>;
  clientWidth: number;
  style: { setProperty: () => void };
  appendChild(c: Node): Node;
  insertBefore(c: Node, before: Node | null): Node;
  removeChild(c: Node): void;
  hasAttribute(name: string): boolean;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  setAttributeNS(ns: string, name: string, value: string): void;
  removeAttribute(name: string): void;
  addEventListener(type: string, fn: () => void): void;
  firstChild: Node | null;
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
    disabled: false,
    type: '',
    href: '',
    target: '',
    rel: '',
    dataset: {},
    attrs: {},
    children: [],
    listeners: {},
    clientWidth: 0,
    style: { setProperty() {} },
    appendChild(c) {
      n.children.push(c);
      return c;
    },
    insertBefore(c, before) {
      const at = before === null ? -1 : n.children.indexOf(before);
      if (at < 0) n.children.push(c);
      else n.children.splice(at, 0, c);
      return c;
    },
    removeChild(c) {
      n.children = n.children.filter((x) => x !== c);
    },
    hasAttribute: (name) => name in n.attrs,
    getAttribute: (name) => n.attrs[name] ?? null,
    setAttribute(name, value) {
      n.attrs[name] = value;
      if (name === 'class') n.className = value;
    },
    setAttributeNS(_ns, name, value) {
      n.attrs[name] = value;
    },
    removeAttribute(name) {
      delete n.attrs[name];
    },
    addEventListener(type, fn) {
      (n.listeners[type] ??= []).push(fn);
    },
    get firstChild() {
      return n.children[0] ?? null;
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
    clear(n: Node) {
      n.children = [];
    },
    on(n: Node, type: string, fn: () => void) {
      n.addEventListener(type, fn);
    },
    usd: (v: number, d?: number) => '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: d ?? 2, maximumFractionDigits: d ?? 2 }),
    fee: (v: number) => '$' + Number(v).toFixed(2),
    qty: (v: number) => String(v),
    pct: (v: number) => `${(v * 100).toFixed(1)}%`,
    ago: () => 'just now',
  };
}

function all(n: Node, className: string, out: Node[] = []): Node[] {
  if (String(n.className).split(' ').includes(className)) out.push(n);
  for (const c of n.children) all(c, className, out);
  return out;
}

function byAttr(n: Node, name: string, value?: string, out: Node[] = []): Node[] {
  const got = n.getAttribute(name);
  if (got !== null && (value === undefined || got === value)) out.push(n);
  for (const c of n.children) byAttr(c, name, value, out);
  return out;
}

function fire(n: Node, type: string): void {
  for (const fn of n.listeners[type] ?? []) fn();
}

function byTag(n: Node, tag: string, out: Node[] = []): Node[] {
  if (n.tag === tag) out.push(n);
  for (const c of n.children) byTag(c, tag, out);
  return out;
}

/* The dock and the card in one sandbox, the way index.html loads them, over the proposals and
   the vault slice the test hands in. The clipboard is a stub that records what was written. */
function loadDock(proposals: unknown[], vault: Record<string, unknown> = {}) {
  const dock = node('div');
  const card = node('div');
  card.clientWidth = 640;
  const clipboard: string[] = [];
  const approved: string[] = [];
  let listener: (() => void) | null = null;
  const sandbox: Record<string, unknown> = {
    window: {
      PhosphorDom: domFor(),
      PhosphorNet: { readable: (e: Error) => String(e.message) },
      PhosphorApi: { approve: (id: string) => { approved.push(id); return Promise.resolve({}); }, refuse: () => Promise.resolve({}) },
      PhosphorState: {
        select: (name: string, fn: () => void) => {
          if (name === 'proposals') listener = fn;
        },
        get: () => ({ proposals, vault, policy: { outbound: { humanClickAboveUsd: 100 } } }),
      },
      PhosphorShell: { updateField: () => {}, setPending: () => {}, refresh: () => Promise.resolve() },
      PhosphorIcons: { svg: (name: string) => { const n = node('svg'); n.className = 'icon'; n.attrs['data-icon'] = name; return n; } },
      PhosphorMarks: { logo: (symbol: string) => { const n = node('span'); n.className = 'logo'; n.attrs['data-token'] = String(symbol).toUpperCase(); return n; } },
      setTimeout: () => 0,
      clearTimeout: () => {},
    },
    navigator: { clipboard: { writeText: (text: string) => { clipboard.push(text); return Promise.resolve(); } } },
    document: {
      createElement: (tag: string) => node(tag),
      createElementNS: (_ns: string, tag: string) => node(tag),
      getElementById: (id: string) => (id === 'overlay' ? dock : id === 'overlay-card' ? card : null),
      addEventListener: () => {},
    },
    console,
    URL,
  };
  createContext(sandbox);
  fillChains(sandbox, (src, name) => runInContext(src, sandbox, { filename: name }));
  runInContext(LINKS, sandbox, { filename: 'ui/core/links.js' });
  runInContext(CHECKS, sandbox, { filename: 'ui/screens/checks.js' });
  runInContext(SENDCARD, sandbox, { filename: 'ui/screens/sendcard.js' });
  runInContext(DECISION, sandbox, { filename: 'ui/screens/decision.js' });
  const win = sandbox.window as { PhosphorDecision: { boot: () => void; render: () => void }; PhosphorSendCard: Record<string, (...a: unknown[]) => unknown> };
  win.PhosphorDecision.boot();
  return {
    card,
    clipboard,
    approved,
    sendCard: win.PhosphorSendCard,
    render: () => {
      if (listener !== null) listener();
      else win.PhosphorDecision.render();
    },
  };
}

const FRIEND = '0xb583f41992Cd21b2F2345e194a36D33684BB5DB0';

function payProposal(over: Record<string, unknown> = {}, draftOver: Record<string, unknown> = {}) {
  return {
    id: 'p-pay',
    kind: 'intents_pay',
    status: 'pending',
    createdAt: '2026-09-17T10:00:00.000Z',
    draft: {
      kind: 'intents_pay',
      symbol: 'ETH',
      originAsset: 'nep141:eth.omft.near',
      network: 'ethereum',
      amount: 0.01,
      amountUsd: 24.4,
      minReceived: 0.0097,
      from: '0x1111111111111111111111111111111111111111',
      to: FRIEND,
      toChecksum: 'valid',
      counterparty: 'intents.near',
      recipient: { known: false, count: 0, lastAt: null, activity: { network: 'ethereum', address: FRIEND, ok: true, txCount: 42, balance: { amount: '0.51', symbol: 'ETH' }, isContract: false, lastSeen: null, source: 'blockscout' }, ownAddress: false },
      ...draftOver,
    },
    simulation: {
      ok: true,
      summary: 'intents pay: 0.01 ETH ...',
      send: {
        destinationAsset: 'nep141:eth.omft.near',
        arrives: '0.00994',
        arrivesAtLeast: '0.0098406',
        feeUsd: 0.15,
        bridgeFee: '0.000035',
        etaSeconds: 17,
        activity: 'This address has 42 transactions on Ethereum and holds 0.51 ETH.',
        explorer: `https://etherscan.io/address/${FRIEND}`,
      },
    },
    verdict: { outcome: 'needs_approval', reasons: ['Money leaving for another address always needs a human click, whatever the size.'] },
    ...over,
  };
}

test('the dock draws the send card: the head, the route with the full address in groups, the facts and the first-send badge', () => {
  const ui = loadDock([payProposal()], { custody: 'secure-enclave' });
  ui.render();
  const root = all(ui.card, 'sendcard')[0];
  assert.ok(root, 'no send card was drawn');
  assert.equal(root.getAttribute('data-kind'), 'intents_pay');

  assert.equal(all(root, 'sendcard-verb')[0]?.textContent, 'Pay');
  assert.equal(all(root, 'sendcard-amount')[0]?.textContent, '0.01 ETH');
  assert.equal(all(root, 'sendcard-usd')[0]?.textContent, '$24.40');
  const pill = all(root, 'sendcard-status')[0];
  assert.equal(pill?.textContent, 'Waiting for you');
  assert.equal(pill?.getAttribute('data-tone'), 'warn');

  // The route: three nodes, two arrows, the destination naming the chain with its mark.
  const nodes = byAttr(root, 'data-node');
  assert.deepEqual(nodes.map((n) => n.getAttribute('data-node')), ['from', 'via', 'to']);
  assert.equal(all(nodes[0]!, 'logo')[0]?.getAttribute('data-token'), 'ETH');
  assert.equal(all(nodes[1]!, 'sendcard-node-name')[0]?.textContent, 'NEAR Intents bridge');
  assert.equal(all(nodes[1]!, 'sendcard-info')[0]?.getAttribute('data-tip'), '1Click sends it out for you; if it cannot, the money comes back to your balance.');
  assert.equal(all(nodes[2]!, 'sendcard-node-name')[0]?.textContent, 'Ethereum');
  assert.equal(all(nodes[2]!, 'logo')[0]?.getAttribute('data-token'), 'ETH');
  assert.equal(all(root, 'sendcard-arrow').length, 2);

  // The address, whole, in groups of four, and the normalised spelling on the node.
  const groups = all(root, 'sendcard-group').map((g) => g.textContent);
  assert.deepEqual(groups, ['0xb5', '83f4', '1992', 'Cd21', 'b2F2', '345e', '194a', '36D3', '3684', 'BB5D', 'B0']);
  assert.equal(groups.join(''), FRIEND);
  assert.equal(all(root, 'sendcard-address')[0]?.getAttribute('data-address'), FRIEND);

  // The facts, two columns, in this order and no other.
  const labels = all(root, 'sendcard-fact-label').map((l) => l.children[0]?.textContent ?? l.textContent);
  assert.deepEqual(labels, ['Chain', 'Token', 'Method', 'Arrives at least', 'Fee', 'Time']);
  const values = all(root, 'sendcard-fact-value').map((v) => v.textContent);
  assert.deepEqual(values, ['Ethereum', 'ETH', 'NEAR Intents payout', '0.0098406 ETH', '$0.15 (0.000035 ETH bridge)', 'about 17 s']);
  assert.equal(all(root, 'sendcard-fact-value')[3]?.getAttribute('data-tone'), 'up', 'what arrives is green');

  // First send, in amber with a dot, then the chain's sentence.
  const line = all(root, 'sendcard-recipient-line')[0];
  assert.equal(line?.getAttribute('data-first'), 'true');
  assert.ok(all(line!, 'dot').length === 1);
  assert.ok(line?.textContent.includes('First send to this address.'));
  assert.equal(all(root, 'sendcard-activity')[0]?.textContent, 'This address has 42 transactions on Ethereum and holds 0.51 ETH.');

  // The slot the preflight stream fills, empty for now, at the bottom of the card.
  const slot = byAttr(root, 'data-checks')[0];
  assert.ok(slot, 'no data-checks slot');
  assert.equal(slot.children.length, 0);
  assert.equal(root.children[root.children.length - 1], slot);

  // Nothing of the generic ask remains: no "Where it goes" list, no summary block.
  assert.equal(all(ui.card, 'destinations').length, 0);
  assert.equal(all(ui.card, 'dock-summary').length, 0);
});

test('copy puts the normalised address on the clipboard, and the explorer link is https on the chain\'s own explorer', () => {
  const ui = loadDock([payProposal()]);
  ui.render();
  const root = all(ui.card, 'sendcard')[0]!;
  const copy = all(root, 'sendcard-copy')[0];
  assert.ok(copy);
  fire(copy!, 'click');
  assert.deepEqual(ui.clipboard, [FRIEND]);
  const link = all(root, 'sendcard-explorer')[0];
  assert.ok(link, 'no explorer link');
  assert.equal(link!.href, `https://etherscan.io/address/${FRIEND}`);
  assert.equal(link!.target, '_blank');
  assert.match(link!.rel, /noopener/);
});

test('an explorer url the server did not build for one of the five explorers never becomes a link', () => {
  const evil = payProposal();
  (evil.simulation.send as { explorer: string }).explorer = 'https://etherscan.io.evil.tld/address/x';
  const ui = loadDock([evil]);
  ui.render();
  assert.equal(all(ui.card, 'sendcard-explorer').length, 0);
  const http = payProposal();
  (http.simulation.send as { explorer: string }).explorer = 'http://etherscan.io/address/x';
  const ui2 = loadDock([http]);
  ui2.render();
  assert.equal(all(ui2.card, 'sendcard-explorer').length, 0);
});

test('a receiver the book knows is said with its count and last date, in grey', () => {
  const ui = loadDock([payProposal({}, { recipient: { known: true, count: 3, lastAt: '2026-09-12T10:00:00.000Z', activity: null, ownAddress: false } })]);
  ui.render();
  const line = all(ui.card, 'sendcard-recipient-line')[0];
  assert.equal(line?.getAttribute('data-first'), 'false');
  assert.equal(all(line!, 'dot').length, 0);
  assert.equal(line?.textContent, 'Sent here 3 times, last 12 Sep.');
});

test('a send inside NEAR Intents names the account node and the method, with no explorer', () => {
  const inside = payProposal(
    { id: 'p-send', kind: 'intents_send' },
    { kind: 'intents_send', symbol: 'USDC', network: undefined, to: FRIEND.toLowerCase(), recipient: { known: false, count: 0, lastAt: null, activity: null, ownAddress: false } },
  );
  (inside.simulation.send as { explorer: string | null; activity: string }).explorer = null;
  (inside.simulation.send as { activity: string }).activity = 'This account holds 12.5 USDC inside NEAR Intents.';
  const ui = loadDock([inside]);
  ui.render();
  const root = all(ui.card, 'sendcard')[0]!;
  assert.equal(root.getAttribute('data-kind'), 'intents_send');
  assert.equal(all(root, 'sendcard-verb')[0]?.textContent, 'Send');
  const nodes = byAttr(root, 'data-node');
  assert.equal(all(nodes[2]!, 'sendcard-node-name')[0]?.textContent, 'NEAR Intents account');
  assert.equal(all(nodes[2]!, 'logo')[0]?.getAttribute('data-token'), 'NEAR');
  const values = all(root, 'sendcard-fact-value').map((v) => v.textContent);
  assert.equal(values[0], 'NEAR Intents');
  assert.equal(values[2], 'Inside NEAR Intents');
  assert.equal(all(root, 'sendcard-explorer').length, 0);
  assert.equal(all(root, 'sendcard-group').join('').length > 0, true);
});

test('the route stacks under 560 px and not above, by a class the card owns', () => {
  const ui = loadDock([payProposal()]);
  ui.render();
  const root = all(ui.card, 'sendcard')[0]!;
  assert.equal(root.className.includes('sendcard--stacked'), false, 'a 640 px column stacked');
  assert.equal(ui.sendCard.layout(root, 480), true);
  assert.ok(root.className.split(' ').includes('sendcard--stacked'));
  assert.equal(ui.sendCard.layout(root, 559), true);
  assert.equal(ui.sendCard.layout(root, 560), false);
  assert.equal(root.className.includes('sendcard--stacked'), false);
  assert.equal(ui.sendCard.STACK_BELOW, 560);
});

test('the dock\'s buttons around a send say what the click starts, and go dead with a fingerprint while Touch ID is up', async () => {
  const enclave = loadDock([payProposal()], { custody: 'secure-enclave' });
  enclave.render();
  let labels = all(enclave.card, 'btn-label').map((l) => l.textContent);
  assert.deepEqual(labels.filter((l) => l !== 'Copy' && l !== 'Explorer'), ['No', 'Approve, then Touch ID']);

  const password = loadDock([payProposal()], { custody: 'password' });
  password.render();
  labels = all(password.card, 'btn-label').map((l) => l.textContent);
  assert.deepEqual(labels.filter((l) => l !== 'Copy' && l !== 'Explorer'), ['No', 'Approve']);

  const touching = loadDock([payProposal({ status: 'awaiting_touch' })], { custody: 'secure-enclave', waiting: { reason: 'Approve: Pay 0.01 ETH to 0xb583...5DB0 on Ethereum ($24.40)' } });
  touching.render();
  const primary = all(touching.card, 'btn-primary')[0]!;
  assert.equal(primary.disabled, true);
  assert.equal(primary.getAttribute('data-touch'), 'true');
  assert.equal(all(primary, 'sendcard-finger').length, 1, 'no fingerprint on the waiting button');
  assert.equal(all(primary, 'btn-label')[0]?.textContent, 'Waiting for Touch ID');
  assert.equal(all(touching.card, 'sendcard-status')[0]?.textContent, 'Touch ID');
  assert.equal(all(touching.card, 'touch-reason')[0]?.textContent, 'Approve: Pay 0.01 ETH to 0xb583...5DB0 on Ethereum ($24.40)');

  // The yes is the dock's: clicking it approves that proposal and nothing in the card does.
  const yes = all(enclave.card, 'btn-primary')[0]!;
  fire(yes, 'click');
  assert.deepEqual(enclave.approved, ['p-pay']);
  await new Promise((resolve) => setImmediate(resolve));
});

test('a refused send keeps the card and says why in red', () => {
  const refused = payProposal({ status: 'policy_refused', verdict: { outcome: 'refuse', rule: 'simulation_required', reasons: ['Simulation failed, so nothing is signed: the receiving address is unusable.'] } });
  const ui = loadDock([refused]);
  // A refused row is not waiting, so the dock does not draw it; the card itself still can.
  const host = node('div');
  ui.sendCard.build(host, ui.sendCard.viewOf(refused), {});
  const root = all(host, 'sendcard')[0]!;
  assert.equal(all(root, 'sendcard-status')[0]?.textContent, 'Refused');
  assert.equal(all(root, 'sendcard-status')[0]?.getAttribute('data-tone'), 'down');
  const why = all(root, 'sendcard-why')[0];
  assert.equal(why?.getAttribute('data-tone'), 'down');
  assert.match(why?.textContent ?? '', /receiving address is unusable/);
});

test('nothing in the card reaches the DOM as markup, and the card never approves', () => {
  assert.equal(/\.innerHTML\s*=|insertAdjacentHTML|outerHTML|document\.write/.test(SENDCARD), false);
  assert.equal(/api\.approve|\/api\/approve|PhosphorApi/.test(SENDCARD), false, 'the send card touches the approve route');
  const long = new RegExp(`[${String.fromCharCode(0x2014, 0x2013)}]`);
  assert.equal(long.test(SENDCARD), false, 'a long dash reached sendcard.js');
  assert.equal(long.test(read('../../ui/design/sendcard.css')), false, 'a long dash reached sendcard.css');
});

/* The conversation: cards.js draws the same card from a tool answer that carries no draft, so
   the address comes off the reply's `send` facts (src/http/propose.ts) and never off the
   assistant's argument. */
test('the thread draws the send card from the reply\'s send facts, not from the tool argument', () => {
  const sandbox: Record<string, unknown> = {
    window: {
      PhosphorDom: domFor(),
      PhosphorIcons: { svg: (name: string) => { const n = node('svg'); n.className = 'icon'; n.attrs['data-icon'] = name; return n; } },
      PhosphorMarks: { logo: (symbol: string) => { const n = node('span'); n.className = 'logo'; n.attrs['data-token'] = String(symbol).toUpperCase(); return n; } },
      PhosphorReceipt: { chainName: (id: string) => id },
      setTimeout: () => 0,
    },
    navigator: {},
    document: { createElement: (tag: string) => node(tag), createElementNS: (_ns: string, tag: string) => node(tag), addEventListener: () => {} },
    console,
    URL,
  };
  createContext(sandbox);
  fillChains(sandbox, (src, name) => runInContext(src, sandbox, { filename: name }));
  runInContext(LINKS, sandbox, { filename: 'ui/core/links.js' });
  runInContext(SENDCARD, sandbox, { filename: 'ui/screens/sendcard.js' });
  runInContext(CARDS, sandbox, { filename: 'ui/screens/cards.js' });
  const cards = (sandbox.window as { PhosphorCards: { render: (kind: string, data: unknown, extra: unknown) => Node; kindFor: (name: string) => string } }).PhosphorCards;
  assert.equal(cards.kindFor('propose_send'), 'move');
  const reply = {
    id: 'p-pay',
    status: 'pending',
    verdict: { outcome: 'needs_approval', reasons: [] },
    simulation: payProposal().simulation,
    send: { kind: 'intents_pay', where: 'ethereum', to: FRIEND, symbol: 'ETH', amount: 0.01, amountUsd: 24.4, recipient: { known: false, count: 0, lastAt: null, ownAddress: false } },
  };
  // The argument spells the address in lowercase; the card shows the app's checksummed spelling.
  // The thread draws every move in one skeleton (ui/screens/cards.js moveCard): the receiver
  // is the whole address on the leg the money lands on, in groups of four, with a Copy.
  const card = cards.render('move', reply, { name: 'propose_send', input: { to: FRIEND.toLowerCase(), symbol: 'eth', amount: 0.01, where: 'ethereum', confirmed: true } });
  const address = all(card, 'tcard-leg-address')[0];
  assert.ok(address, 'the thread drew no address on the send card');
  assert.equal(all(address!, 'tcard-leg-group').map((g) => g.textContent).join(''), FRIEND);
  assert.equal(address!.getAttribute('data-address'), FRIEND);
  const from = all(card, 'tcard-leg').find((leg) => leg.getAttribute('data-leg') === 'from');
  assert.ok(from?.textContent.includes('0.01 ETH'), String(from?.textContent));
  assert.ok(all(card, 'tcard-line').some((line) => line.textContent === 'This addressfirst send'), 'the first send is not named');
  assert.equal(all(card, 'btn-primary').length, 0, 'the thread card grew a deciding button');
  assert.equal(all(card, 'tcard-title')[0]?.textContent, 'Pay');
  assert.equal(all(card, 'sendcard').length, 0, 'the dock\'s own card is nested inside the thread card');
});

// ---------- the checks and the hold ----------
//
// Once a row has run, it carries the checks the app made before signing (src/preflight/), and
// the card draws them folded in the slot. A row the preflight is holding is approved with
// heldSince: the pill says Holding, a line under the head says what for and how long, and the
// dock shows it with no button, because there is nothing to decide.

const PREFLIGHT = {
  at: '2026-09-17T10:05:00.000Z',
  verdict: 'hold',
  holdReason: 'Waiting for Ethereum gas to settle',
  checks: [
    { id: 'gas', label: 'Ethereum gas', state: 'fail', value: '5.0 gwei', detail: 'The base fee on Ethereum is 5.00 gwei, 5.0x the hourly average.', series: [1, 1.1, 0.9, 5] },
    { id: 'coverage', label: 'Fee covers the payout', state: 'ok', value: '2.3x', detail: '$0.15 fee against about $0.07 of gas on Ethereum.' },
    { id: 'venue', label: 'Venue answering', state: 'ok', value: '180 ms', detail: 'A dry quote answered in 180 ms and the status endpoint is reachable.' },
    { id: 'balance', label: 'Balance', state: 'ok', value: '0.2 ETH', detail: 'ETH inside NEAR Intents reads 0.2 ETH, and this move needs 0.01 ETH.' },
    { id: 'deadline', label: 'Quote still valid', state: 'ok', value: '10 min', detail: 'The quote is good until 2026-09-17T10:15:00.000Z.' },
  ],
};

test('a row that ran its checks draws them folded in the slot, closed, with the five nodes inside', () => {
  const ui = loadDock([payProposal({ status: 'pending', preflight: [PREFLIGHT] })]);
  ui.render();
  const root = all(ui.card, 'sendcard')[0]!;
  const slot = byAttr(root, 'data-checks')[0]!;
  const fold = all(slot, 'checks')[0];
  assert.ok(fold, 'the checks fold is in the slot');
  assert.equal(fold.getAttribute('data-open'), 'false', 'closed by default');
  assert.equal(all(fold, 'checks-node').length, 5);
  assert.equal(all(fold, 'checks-summary')[0]?.textContent, 'Waiting on 1 of 5');
  assert.equal(all(fold, 'checks-spark').length, 1, 'the gas node has its sparkline');
  // The newest attempt is the one drawn.
  const older = { ...PREFLIGHT, at: '2026-09-17T10:04:00.000Z', verdict: 'ok', checks: PREFLIGHT.checks.map((c) => ({ ...c, state: 'ok' })) };
  const twice = loadDock([payProposal({ status: 'pending', preflight: [older, PREFLIGHT] })]);
  twice.render();
  assert.equal(all(twice.card, 'checks-summary')[0]?.textContent, 'Waiting on 1 of 5');
});

test('a held row says Holding, what it waits for and for how long, and the dock shows it without a button', () => {
  const now = Date.parse('2026-09-17T10:07:30.000Z');
  const held = payProposal({ status: 'approved', heldSince: '2026-09-17T10:05:00.000Z', decidedBy: 'human', decidedAt: '2026-09-17T10:05:00.000Z', preflight: [PREFLIGHT] });
  const ui = loadDock([held]);
  ui.render();
  const root = all(ui.card, 'sendcard')[0];
  assert.ok(root, 'the dock draws the held send');
  assert.equal(root.getAttribute('data-status'), 'held');
  const pill = all(root, 'sendcard-status')[0];
  assert.equal(pill?.textContent, 'Holding');
  assert.equal(pill?.getAttribute('data-tone'), 'warn');
  const line = all(root, 'sendcard-hold')[0];
  assert.ok(line, 'the hold line is under the head');
  assert.match(line.textContent, /^Waiting for Ethereum gas to settle \((\d+ min|under a minute)\)\. Nothing is signed until it clears\.$/);
  assert.equal(root.children[1], line, 'right under the head');
  const deciding = byTag(ui.card, 'button').filter((b) => /^(Yes|No|Approve|Approve, then Touch ID)$/.test(all(b, 'btn-label')[0]?.textContent ?? ''));
  assert.equal(deciding.length, 0, 'no Yes or No: nothing to decide');
  assert.equal(all(ui.card, 'dock-actions').length, 0);
  assert.equal(all(ui.card, 'checks').length, 1, 'the checks are on the card');

  // Built directly with a clock: two and a half minutes in reads as 2 min.
  const view = ui.sendCard.viewOf(held) as Record<string, unknown>;
  const host = node('div');
  ui.sendCard.build(host, view, { now });
  assert.equal(all(host, 'sendcard-hold')[0]?.textContent, 'Waiting for Ethereum gas to settle (2 min). Nothing is signed until it clears.');
  assert.equal(ui.sendCard.heldLine(held, now), 'Waiting for Ethereum gas to settle (2 min). Nothing is signed until it clears.');
});

test('an approved row that is not held is Sending, with no hold line', () => {
  const ui = loadDock([payProposal({ status: 'approved' })]);
  ui.render();
  const view = ui.sendCard.viewOf(payProposal({ status: 'approved' })) as Record<string, unknown>;
  const host = node('div');
  ui.sendCard.build(host, view, {});
  assert.equal(all(host, 'sendcard-status')[0]?.textContent, 'Sending');
  assert.equal(all(host, 'sendcard-hold').length, 0);
  assert.equal(all(ui.card, 'sendcard').length, 0, 'the dock has nothing to show for a row that is sending');
});

/* A payout on a chain the card never had a row for. The five-row table in this file printed the
   raw id for everything else, which is the scary-string failure the card exists to avoid. */
test('a payout on a chain the card never had a row for still names it and draws its mark', () => {
  const ui = loadDock([payProposal({}, { network: 'ton', symbol: 'GRAM' })]);
  ui.render();
  const names = all(ui.card, 'sendcard-node-name').map((n) => n.textContent);
  assert.ok(names.includes('TON'), names.join(' | '));
  assert.ok(!names.some((n) => n === 'ton'));
});

test('a payout says what it is worth in dollars', () => {
  const ui = loadDock([payProposal({}, { network: 'base', symbol: 'USDC', amount: 50, amountUsd: 50 })]);
  ui.render();
  assert.equal(all(ui.card, 'sendcard-usd')[0]?.textContent, '$50.00');
});

/* A coin the venue quotes no price for is the one case where the number that catches a mistake is
   missing, so the card has to say the check is missing rather than leave a gap that reads as
   nothing to see. */
test('a coin with no price says so where the dollars would be', () => {
  const ui = loadDock([payProposal({}, { network: 'ton', symbol: 'GRAM', amount: 12, amountUsd: null })]);
  ui.render();
  const usd = all(ui.card, 'sendcard-usd')[0];
  assert.equal(usd?.textContent, 'We cannot price this');
  assert.equal(usd?.getAttribute('data-unpriced'), 'true');
});
