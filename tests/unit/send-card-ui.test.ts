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
  };
  createContext(sandbox);
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

const FRIEND = '0xd7b2de5862008D949dD6e5d70D4c68Ad1D4d5050';

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
  assert.deepEqual(groups, ['0xd7', 'b2de', '5862', '008D', '949d', 'D6e5', 'd70D', '4c68', 'Ad1D', '4d50', '50']);
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

  const touching = loadDock([payProposal({ status: 'awaiting_touch' })], { custody: 'secure-enclave', waiting: { reason: 'Approve: Pay 0.01 ETH to 0xd7b2...5050 on Ethereum ($24.40)' } });
  touching.render();
  const primary = all(touching.card, 'btn-primary')[0]!;
  assert.equal(primary.disabled, true);
  assert.equal(primary.getAttribute('data-touch'), 'true');
  assert.equal(all(primary, 'sendcard-finger').length, 1, 'no fingerprint on the waiting button');
  assert.equal(all(primary, 'btn-label')[0]?.textContent, 'Waiting for Touch ID');
  assert.equal(all(touching.card, 'sendcard-status')[0]?.textContent, 'Touch ID');
  assert.equal(all(touching.card, 'touch-reason')[0]?.textContent, 'Approve: Pay 0.01 ETH to 0xd7b2...5050 on Ethereum ($24.40)');

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
  };
  createContext(sandbox);
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
  const card = cards.render('move', reply, { name: 'propose_send', input: { to: FRIEND.toLowerCase(), symbol: 'eth', amount: 0.01, where: 'ethereum', confirmed: true } });
  const root = all(card, 'sendcard')[0];
  assert.ok(root, 'the thread drew no send card');
  assert.equal(all(root!, 'sendcard-group').map((g) => g.textContent).join(''), FRIEND);
  assert.equal(all(root!, 'sendcard-amount')[0]?.textContent, '0.01 ETH');
  assert.equal(all(root!, 'sendcard-recipient-line')[0]?.getAttribute('data-first'), 'true');
  assert.equal(all(card, 'btn-primary').length, 0, 'the thread card grew a deciding button');
  assert.equal(all(card, 'tcard-title')[0]?.textContent, 'Pay');
});
