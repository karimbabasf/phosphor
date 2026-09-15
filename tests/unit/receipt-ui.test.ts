// The receipt card: the one surface in the window that shows a hash, opened as a popover over
// the window or posted inline into the assistant thread, with one way out to an explorer.
//
// What these pin: the card says the kind in a word, the outcome in a chip and the two legs of
// the move signed and coloured; the hash is short on screen and whole on hover and on Copy;
// the link out is the server's https url and nothing else; and the popover closes on Esc, on
// the backdrop and on its own control. Run against the REAL ui/screens/receipt.js, ui/core/dom.js
// and ui/design/marks.js over a stand-in DOM, the way the other *-ui tests do. PhosphorIcons is a
// stub that records the icon's name, so an assertion can say which icon a state chose.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

type Any = Record<string, any>;

const DOM = readFileSync(new URL('../../ui/core/dom.js', import.meta.url), 'utf8');
const MARKS = readFileSync(new URL('../../ui/design/marks.js', import.meta.url), 'utf8');
const RECEIPT = readFileSync(new URL('../../ui/screens/receipt.js', import.meta.url), 'utf8');

function makeStyle(): Any {
  const props: Record<string, string> = {};
  return {
    setProperty: (name: string, value: string) => {
      props[name] = value;
    },
    removeProperty: (name: string) => {
      delete props[name];
    },
    getPropertyValue: (name: string) => props[name] ?? '',
  };
}

function makeNode(tagName: string): Any {
  const attrs: Record<string, string> = {};
  const listeners: Record<string, Array<(event: Any) => void>> = {};
  const node: Any = {
    tagName,
    id: '',
    className: '',
    textContent: '',
    hidden: false,
    open: false,
    dataset: {},
    style: makeStyle(),
    childNodes: [],
    parentNode: null,
    get children() {
      return node.childNodes;
    },
    get firstChild() {
      return node.childNodes[0] ?? null;
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
    remove() {
      node.parentNode?.removeChild(node);
    },
    setAttribute: (name: string, value: string) => {
      attrs[name] = value;
    },
    getAttribute: (name: string) => attrs[name] ?? null,
    hasAttribute: (name: string) => name in attrs,
    removeAttribute: (name: string) => {
      delete attrs[name];
    },
    addEventListener: (type: string, fn: (event: Any) => void) => {
      (listeners[type] ??= []).push(fn);
    },
    removeEventListener: () => {},
    fire: (type: string, event: Any = {}) => {
      for (const fn of listeners[type] ?? []) fn({ target: node, preventDefault() {}, ...event });
    },
    // The native dialog's two verbs. close() fires the close event the way the browser does.
    showModal() {
      node.open = true;
    },
    close() {
      node.open = false;
      node.fire('close');
    },
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  return node;
}

function withClass(node: Any, name: string, out: Any[] = []): Any[] {
  if (String(node.className).split(' ').includes(name)) out.push(node);
  for (const child of node.childNodes) withClass(child, name, out);
  return out;
}

function text(node: Any): string {
  if (!node) return '';
  if (node.childNodes.length === 0) return String(node.textContent ?? '');
  return node.childNodes.map((c: Any) => text(c)).join('');
}

type Rig = {
  window: Any;
  body: Any;
  timers: Array<() => void>;
  clipboard: string[];
  animated: Array<{ frames: Any; options: Any }>;
  bus: Record<string, Array<(payload: Any) => void>>;
};

function boot(over: { reduced?: boolean; motion?: boolean } = {}): Rig {
  const body = makeNode('body');
  const timers: Array<() => void> = [];
  const clipboard: string[] = [];
  const animated: Array<{ frames: Any; options: Any }> = [];
  const bus: Record<string, Array<(payload: Any) => void>> = {};
  const document: Any = {
    createElement: (tag: string) => makeNode(tag),
    createElementNS: (_ns: string, tag: string) => makeNode(tag),
    getElementById: () => null,
    body,
    hidden: false,
  };
  const window: Any = {
    document,
    setTimeout: (fn: () => void) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimeout: () => {},
    PhosphorMotion: { reduced: () => over.reduced === true },
    PhosphorIcons: {
      svg: (name: string, className?: string) => {
        const node = makeNode('svg');
        node.className = 'icon' + (className ? ' ' + className : '');
        node.dataset.icon = name;
        return node;
      },
    },
    PhosphorNet: { readable: (err: unknown) => String(err) },
    PhosphorApi: { reconcile: () => Promise.resolve({ status: 'executed' }) },
    PhosphorEvents: {
      on: (type: string, fn: (payload: Any) => void) => {
        (bus[type] ??= []).push(fn);
        return () => {};
      },
      emit: (type: string, payload: Any) => {
        for (const fn of bus[type] ?? []) fn(payload);
      },
    },
  };
  if (over.motion !== false) {
    window.Motion = {
      animate: (_node: Any, frames: Any, options: Any) => {
        animated.push({ frames, options });
      },
    };
  }
  window.window = window;
  const navigator: Any = {
    clipboard: {
      writeText: (value: string) => {
        clipboard.push(value);
        return Promise.resolve();
      },
    },
  };
  const ctx = createContext({ window, document, navigator, console, Promise, URL });
  runInContext(DOM, ctx);
  runInContext(MARKS, ctx);
  runInContext(RECEIPT, ctx);
  return { window, body, timers, clipboard, animated, bus };
}

const HASH = '0x' + 'ab'.repeat(32);
const SELF = '0x2dd9131edF3CC393B757463C85b2C870A6F3180a';

function swap(over: Any = {}): Any {
  return {
    id: 'p1',
    kind: 'swap',
    at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    headline: 'Swapped 0.002 ETH for 4.98 USDC',
    summary: 'swapped 0.002 ETH for 4.9811 USDC on intents.near, quote q-1, fee $0.02',
    fromChain: 'arb',
    toChain: 'arb',
    amount: 0.002,
    symbol: 'ETH',
    received: { symbol: 'USDC', amount: 4.9811 },
    feesUsd: 0.02,
    valueUsd: 5,
    venue: 'intents.near',
    wallet: SELF,
    txids: [{ chain: 'arb', hash: HASH, url: `https://arbiscan.io/tx/${HASH}`, explorer: 'Arbiscan' }],
    balanceBefore: 25.56,
    balanceAfter: 25.54,
    status: 'executed',
    ...over,
  };
}

test('receipt.js exposes the popover, the inline card and the Activity row', () => {
  const rig = boot();
  const R = rig.window.PhosphorReceipt;
  for (const name of ['open', 'close', 'card', 'row', 'updateRow', 'fill', 'kindWord', 'chainName']) {
    assert.equal(typeof R[name], 'function', `${name} is a function`);
  }
});

test('the inline card says the kind, the outcome, both legs and the four facts', () => {
  const rig = boot();
  const card = rig.window.PhosphorReceipt.card(swap());
  assert.equal(card.dataset.inline, 'true');
  assert.equal(withClass(card, 'receipt-close').length, 0, 'no close control inline');
  assert.equal(text(withClass(card, 'receipt-kind')[0]), 'Swap');
  assert.equal(withClass(card, 'receipt-kind')[0].childNodes[0].dataset.icon, 'swap');
  const chip = withClass(card, 'receipt-status')[0];
  assert.equal(text(chip), 'Done');
  assert.equal(chip.dataset.tone, 'up');
  assert.equal(chip.childNodes[0].dataset.icon, 'done');
  assert.equal(text(withClass(card, 'receipt-time')[0]), '2 hours ago');

  const legs = withClass(card, 'receipt-leg');
  assert.equal(legs.length, 2);
  assert.equal(legs[0].dataset.dir, 'out');
  assert.equal(text(withClass(legs[0], 'receipt-amount')[0]), '-0.002 ETH');
  assert.equal(legs[1].dataset.dir, 'in');
  assert.equal(text(withClass(legs[1], 'receipt-amount')[0]), '+4.9811 USDC');
  assert.equal(withClass(card, 'receipt-arrow')[0].dataset.icon, 'swap', 'the swap icon sits between the legs');
  const logos = withClass(card, 'logo');
  assert.deepEqual(logos.map((l: Any) => l.getAttribute('data-token')), ['ETH', 'USDC'], 'the real marks, at 32');
  assert.equal(logos[0].style.getPropertyValue('--logo'), '32px');

  const cells = withClass(card, 'receipt-cell').map((c: Any) => [text(c.childNodes[0]), text(c.childNodes[1])]);
  assert.deepEqual(cells, [
    ['Value', '$5.00'],
    ['Fee', '$0.02'],
    ['Venue', 'NEAR Intents'],
    ['Wallet', '0x2dd9...180a'],
  ]);
  assert.equal(withClass(card, 'receipt-cell')[3].childNodes[1].title, SELF, 'the whole address on hover');
});

test('the hash is short on screen, whole on hover and whole on Copy, and Copy says so for a beat', () => {
  const rig = boot();
  const card = rig.window.PhosphorReceipt.card(swap());
  const hash = withClass(card, 'receipt-tx-hash')[0];
  assert.equal(text(hash), '0xabab...abab');
  assert.equal(hash.title, HASH);
  const copy = withClass(card, 'receipt-copy')[0];
  const label = withClass(copy, 'btn-label')[0];
  assert.equal(text(label), 'Copy');
  copy.fire('click');
  assert.deepEqual(rig.clipboard, [HASH], 'the whole hash, never the short one');
  return Promise.resolve().then(() => {
    assert.equal(text(label), 'Copied');
    assert.equal(rig.timers.length, 1);
    rig.timers[0]();
    assert.equal(text(label), 'Copy');
  });
});

test('the one link out names the explorer and opens in the system browser', () => {
  const rig = boot();
  const card = rig.window.PhosphorReceipt.card(swap());
  const view = withClass(card, 'receipt-view')[0];
  assert.equal(view.tagName, 'a');
  assert.equal(view.href, `https://arbiscan.io/tx/${HASH}`);
  assert.equal(view.target, '_blank');
  assert.equal(view.rel, 'noreferrer noopener');
  assert.equal(text(withClass(view, 'btn-label')[0]), 'View on Arbiscan');
});

test('a txid the server did not name is named from its host, and one with no https url gets no link', () => {
  const rig = boot();
  const R = rig.window.PhosphorReceipt;
  const unnamed = R.card(swap({ txids: [{ chain: 'hyperliquid', hash: HASH, url: `https://app.hyperliquid.xyz/explorer/tx/${HASH}` }] }));
  assert.equal(text(withClass(withClass(unnamed, 'receipt-view')[0], 'btn-label')[0]), 'View on Hyperliquid explorer');
  const bare = R.card(swap({ txids: [{ chain: 'intents', hash: HASH, url: null, explorer: null }] }));
  assert.equal(withClass(bare, 'receipt-view').length, 0, 'no url, no button');
  assert.equal(withClass(bare, 'receipt-tx-hash').length, 1, 'the hash still shows');
  const hostile = R.card(swap({ txids: [{ chain: 'arb', hash: HASH, url: 'javascript:alert(1)', explorer: 'Arbiscan' }] }));
  assert.equal(withClass(hostile, 'receipt-view').length, 0, 'only https leaves the window');
  const plain = R.card(swap({ txids: [{ chain: 'arb', hash: HASH, url: `http://arbiscan.io/tx/${HASH}`, explorer: 'Arbiscan' }] }));
  assert.equal(withClass(plain, 'receipt-view').length, 0, 'http is not https');
});

test('a move that did not go through shows what would have left, unsigned and quiet, and nothing arriving', () => {
  const rig = boot();
  const card = rig.window.PhosphorReceipt.card(swap({ status: 'failed', received: null, txids: [], feesUsd: null }));
  const chip = withClass(card, 'receipt-status')[0];
  assert.equal(text(chip), 'Failed');
  assert.equal(chip.dataset.tone, 'down');
  assert.equal(chip.childNodes[0].dataset.icon, 'refused');
  const legs = withClass(card, 'receipt-leg');
  assert.equal(legs.length, 1);
  const amount = withClass(legs[0], 'receipt-amount')[0];
  assert.equal(text(amount), '0.002 ETH');
  assert.ok(amount.className.includes('dim'));
  assert.equal(withClass(card, 'receipt-arrow').length, 0);
  assert.equal(withClass(card, 'receipt-foot').length, 0, 'no hash, no footer');
  const fee = withClass(card, 'receipt-cell').find((c: Any) => text(c.childNodes[0]) === 'Fee');
  assert.equal(text(fee?.childNodes[1]), 'none yet', 'an unknown fee is not a zero');
});

test('a deposit with no recorded arrival names where the money went instead of inventing an amount', () => {
  const rig = boot();
  const card = rig.window.PhosphorReceipt.card(swap({
    kind: 'intents_deposit', fromChain: 'base', toChain: 'intents', received: null, venue: 'intents.near', symbol: 'USDC', amount: 25,
  }));
  assert.equal(text(withClass(card, 'receipt-kind')[0]), 'Deposit');
  assert.equal(text(withClass(card, 'receipt-leg-place')[0]), 'to NEAR Intents');
  const labels = withClass(card, 'receipt-cell').map((c: Any) => text(c.childNodes[0]));
  assert.deepEqual(labels, ['Value', 'Fee', 'Chain', 'Wallet'], 'a move between places names the route, not the venue');
  const chain = withClass(card, 'receipt-cell').find((c: Any) => text(c.childNodes[0]) === 'Chain');
  assert.equal(text(chain?.childNodes[1]), 'Base to NEAR Intents');
});

test('every kind has a word, and a fill mapped by the trade screen says which way it went', () => {
  const rig = boot();
  const word = (r: Any): string => rig.window.PhosphorReceipt.kindWord(r);
  assert.equal(word({ kind: 'swap' }), 'Swap');
  assert.equal(word({ kind: 'hl_deposit' }), 'Deposit');
  assert.equal(word({ kind: 'intents_deposit' }), 'Deposit');
  assert.equal(word({ kind: 'hl_withdraw' }), 'Withdrawal');
  assert.equal(word({ kind: 'intents_withdraw' }), 'Withdrawal');
  assert.equal(word({ kind: 'transfer' }), 'Sent');
  assert.equal(word({ kind: 'consolidate' }), 'Moved');
  assert.equal(word({ kind: 'lp_remove' }), 'Liquidity removed');
  assert.equal(word({ kind: 'policy_change' }), 'Rule changed');
  assert.equal(word({ kind: 'mandate_arm' }), 'Bot armed');
  assert.equal(word({ kind: 'trade', side: 'buy' }), 'Bought');
  assert.equal(word({ kind: 'trade', side: 'sell' }), 'Sold');
  assert.equal(word({ kind: 'trade', side: 'sell', closed: true }), 'Trade closed');
  assert.equal(word({ kind: 'something_else' }), 'Receipt', 'an unknown kind still opens');
  const name = rig.window.PhosphorReceipt.chainName;
  assert.equal(name('intents'), 'NEAR Intents');
  assert.equal(name('hyperliquid'), 'Hyperliquid');
  assert.equal(name('base'), 'Base');
});

test('the popover is a native dialog that closes on Esc, on the backdrop and on its own control', () => {
  const rig = boot();
  const R = rig.window.PhosphorReceipt;
  assert.equal(R.isOpen(), false);

  const dialog = R.open(swap());
  assert.equal(dialog.tagName, 'dialog');
  assert.equal(dialog.open, true, 'showModal was called');
  assert.equal(rig.body.childNodes.includes(dialog), true);
  assert.equal(R.isOpen(), true);
  const card = withClass(dialog, 'receipt-card')[0];
  assert.equal(card.dataset.inline, undefined, 'the popover card is not the inline one');
  assert.equal(withClass(card, 'receipt-close').length, 1);

  // Esc: the browser fires cancel on the dialog.
  dialog.fire('cancel');
  assert.equal(R.isOpen(), false);
  assert.equal(rig.body.childNodes.includes(dialog), false, 'a closed dialog leaves the document');

  // The backdrop: a click whose target is the dialog box itself, not the card.
  const second = R.open(swap());
  card.fire('click');
  second.fire('click', { target: card });
  assert.equal(R.isOpen(), true, 'a click inside the card is not a close');
  second.fire('click', { target: second });
  assert.equal(R.isOpen(), false);

  // The close control.
  const third = R.open(swap());
  withClass(third, 'receipt-close')[0].fire('click');
  assert.equal(R.isOpen(), false);
  assert.equal(rig.body.childNodes.length, 0, 'nothing left behind');
});

test('opening a second receipt replaces the first, and receipt:open on the bus opens the popover', () => {
  const rig = boot();
  const R = rig.window.PhosphorReceipt;
  const first = R.open(swap({ id: 'a' }));
  const second = R.open(swap({ id: 'b' }));
  assert.notEqual(first, second);
  assert.deepEqual(rig.body.childNodes, [second], 'one popover at a time');
  R.close();
  assert.equal(rig.bus['receipt:open']?.length, 1, 'the bus handler is registered at load');
  rig.window.PhosphorEvents.emit('receipt:open', { receipt: swap({ id: 'c' }), source: 'activity' });
  assert.equal(R.isOpen(), true);
  assert.equal(rig.body.childNodes[0].dataset.source, 'activity');
  rig.window.PhosphorEvents.emit('receipt:open', { receipt: null });
  assert.equal(R.isOpen(), true, 'an empty payload changes nothing');
});

test('moment 3: the card enters at 0.96 over 220 ms, and reduced motion keeps only the fade', () => {
  const full = boot();
  full.window.PhosphorReceipt.open(swap());
  assert.equal(full.animated.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(full.animated[0].frames)), { opacity: [0, 1], scale: [0.96, 1] });
  assert.equal(full.animated[0].options.duration, 0.22);

  const calm = boot({ reduced: true });
  calm.window.PhosphorReceipt.open(swap());
  assert.deepEqual(JSON.parse(JSON.stringify(calm.animated[0].frames)), { opacity: [0, 1] });

  const bare = boot({ motion: false });
  const dialog = bare.window.PhosphorReceipt.open(swap());
  assert.equal(dialog.open, true, 'no motion library is not a reason not to open');
});

test('the unknown outcome says so before the numbers and keeps Check it again', () => {
  const rig = boot();
  const card = rig.window.PhosphorReceipt.card(swap({ status: 'needs_reconciliation' }));
  const note = withClass(card, 'receipt-note')[0];
  assert.ok(text(note).startsWith('We sent this and cannot read what happened to it. Do not send it again.'));
  const chip = withClass(card, 'receipt-status')[0];
  assert.equal(text(chip), 'Unknown');
  assert.equal(chip.dataset.tone, 'warn');
  const actions = withClass(card, 'receipt-actions')[0];
  assert.equal(actions.childNodes.length, 2, 'Check it again beside the link out');
  assert.equal(text(withClass(actions.childNodes[0], 'btn-label')[0]), 'Check it again');
});

test('the Activity row still builds and updates the way the list expects', () => {
  const rig = boot();
  const R = rig.window.PhosphorReceipt;
  const row = R.row();
  assert.equal(row.tagName, 'button');
  assert.equal(row.childNodes.length, 5);
  R.updateRow(row, swap());
  assert.equal(text(row.childNodes[1]), 'Swapped 0.002 ETH for 4.98 USDC');
  assert.equal(text(row.childNodes[2]), '2 hours ago, $0.02 in fees');
  assert.equal(text(row.childNodes[3]), '-0.002 ETH');
  assert.equal(text(row.childNodes[4]), '+4.9811 USDC');
  assert.equal(row.childNodes[4].getAttribute('data-dir'), 'in');
});
