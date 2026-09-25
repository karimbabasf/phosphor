// The deposit card's three checks, run for real.
//
// The card draws ui/screens/netpick.js at its address step, and each check is
// asserted by running deposit.js and netpick.js over a small DOM with the real
// ui/core/dom.js, the real state store, the real vendored QR encoder and the
// real vendored decoder. The canvas below is a pixel buffer, so the QR the
// card draws is the QR the decoder reads back: a decoder swapped for one that
// answers a different string has to leave the card blank.
//
// Nothing here starts the app. Every route is a stub that records the call.
// Nothing is remembered on this "Mac": every address waits for the tick.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

type Any = Record<string, any>;

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
const LINKS = read('../../ui/core/links.js');
const DOM = read('../../ui/core/dom.js');
const STATE = read('../../ui/core/state.js');
const QR = read('../../ui/vendor/qrcode.js');
const JSQR = read('../../ui/vendor/jsqr.js');
const NETPICK = read('../../ui/screens/netpick.js');
const SOURCE = read('../../ui/screens/deposit.js');

/* ---------- a DOM small enough to read ---------- */

function makeNode(tagName: string): Any {
  const attrs: Record<string, string> = {};
  const listeners: Record<string, Array<(event: Any) => void>> = {};
  let ownText = '';
  const node: Any = {
    tagName: tagName.toUpperCase(),
    className: '',
    hidden: false,
    disabled: false,
    type: '',
    name: '',
    value: '',
    rows: 0,
    width: 0,
    height: 0,
    open: false,
    dataset: {} as Record<string, string>,
    style: {} as Record<string, string>,
    childNodes: [] as Any[],
    parentNode: null as unknown as Any,
    listeners,
    get textContent(): string {
      return node.childNodes.length ? node.childNodes.map((c: Any) => c.textContent).join('') : ownText;
    },
    set textContent(value: string) {
      ownText = String(value);
      for (const child of node.childNodes) child.parentNode = null;
      node.childNodes = [];
    },
    get firstChild() { return node.childNodes[0] ?? null; },
    get children() { return node.childNodes; },
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
    insertBefore(child: Any, before: Any | null) {
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
    remove() { node.parentNode?.removeChild(node); },
    setAttribute(name: string, value: string) { attrs[name] = String(value); },
    getAttribute(name: string) { return name in attrs ? attrs[name] : null; },
    hasAttribute(name: string) { return name in attrs; },
    removeAttribute(name: string) { delete attrs[name]; },
    addEventListener(type: string, fn: (event: Any) => void) { (listeners[type] ||= []).push(fn); },
    removeEventListener() {},
    dispatch(type: string, event: Any = {}) {
      for (const fn of listeners[type] ?? []) fn(Object.assign({ target: node, currentTarget: node, preventDefault() {} }, event));
    },
    click() { node.dispatch('click'); },
    focus() { node.focused = true; },
    scrollIntoView() {},
    getBoundingClientRect: () => ({ width: 0, height: 0 }),
    querySelector(selector: string) { return find(node, selector)[0] ?? null; },
    querySelectorAll(selector: string) { return find(node, selector); },
    showModal() { node.open = true; },
    close() { node.open = false; },
  };
  if (tagName === 'canvas') {
    let pixels: Uint8ClampedArray | null = null;
    const ctx: Any = {
      fillStyle: '#000000',
      setTransform() {},
      fillRect(x: number, y: number, w: number, h: number) {
        if (!pixels) pixels = new Uint8ClampedArray(node.width * node.height * 4);
        const v = ctx.fillStyle === '#FFFFFF' ? 255 : 0;
        for (let yy = y; yy < y + h; yy += 1) {
          for (let xx = x; xx < x + w; xx += 1) {
            const at = (yy * node.width + xx) * 4;
            pixels[at] = v; pixels[at + 1] = v; pixels[at + 2] = v; pixels[at + 3] = 255;
          }
        }
      },
      getImageData(_x: number, _y: number, w: number, h: number) {
        return { data: pixels ?? new Uint8ClampedArray(w * h * 4), width: w, height: h };
      },
    };
    node.getContext = () => ctx;
  }
  return node;
}

/* Enough of a selector engine for the screens: a class, a tag, an attribute
   with a value, a tag with an attribute, and comma lists. */
function matches(node: Any, selector: string): boolean {
  const parts = selector.trim().match(/^([a-z]+)?((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/i);
  if (!parts) return false;
  const [, tag, classes, attrsPart] = parts;
  if (tag && node.tagName !== tag.toUpperCase()) return false;
  for (const cls of classes.split('.').filter(Boolean)) {
    if (!String(node.className).split(' ').includes(cls)) return false;
  }
  for (const raw of attrsPart.match(/\[[^\]]+\]/g) ?? []) {
    const m = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(raw);
    if (!m) return false;
    const value = m[1] === 'type' ? node.type : node.getAttribute(m[1]);
    if (m[2] === undefined ? value === null : value !== m[2]) return false;
  }
  return true;
}

function find(root: Any, selector: string): Any[] {
  const out: Any[] = [];
  const wanted = selector.split(',').map((s) => s.trim());
  const walk = (n: Any): void => {
    for (const child of n.childNodes) {
      if (wanted.some((w) => matches(child, w))) out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

function textOf(node: Any): string[] {
  const out: string[] = [];
  const walk = (n: Any): void => {
    if (n.childNodes.length === 0) {
      if (n.textContent !== '') out.push(n.textContent);
      return;
    }
    for (const child of n.childNodes) walk(child);
  };
  walk(node);
  return out;
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/* ---------- the window ---------- */

const ADDRESS = '0x7d4e1f0a2c9b8e6d3f5a1c7b9e0d2f4a6c8b0e1d';
const WARNING = 'Ethereum, Base and Arbitrum share this address, but send only on the network you picked.';

function report(overrides: Any = {}): Any {
  return Object.assign({
    account: ADDRESS.toLowerCase(),
    verified: true,
    tampered: false,
    networks: [
      { id: 'eth', name: 'Ethereum', address: ADDRESS, memo: null, unavailable: null, accepts: [{ symbol: 'USDC', minDeposit: '1000000', minDepositHuman: '1', decimals: 6, contract: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' }, { symbol: 'ETH', minDeposit: '1000000000000000', minDepositHuman: '0.001', decimals: 18, contract: null }], warning: WARNING },
      { id: 'sol', name: 'Solana', address: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', memo: null, unavailable: null, accepts: [{ symbol: 'USDC', minDeposit: '1000000', minDepositHuman: '1', decimals: 6, contract: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }], warning: 'Solana only. Anything sent here from another network is lost.' },
    ],
    note: 'These addresses belong to the NEAR Intents bridge. It forwards what it receives to your intents balance.',
  }, overrides);
}

type World = {
  sandbox: Any;
  deposit: Any;
  store: Any;
  body: Any;
  dialog: () => Any;
  calls: Any[];
  toasts: string[];
  clipboard: { held: string; readable: boolean };
  card: () => Any | null;
  stored: Record<string, string>;
};

function build(options: { report?: Any; vault?: Any; decoder?: (data: unknown) => Any | null; notice?: boolean } = {}): World {
  const body = makeNode('body');
  const page = makeNode('div');
  const calls: Any[] = [];
  const toasts: string[] = [];
  const clipboard = { held: '', readable: true };
  const cards: Any[] = [];
  const stored: Record<string, string> = {};

  const doc: Any = {
    body,
    createElement: makeNode,
    getElementById: (id: string) => (id === 'page' ? page : id === 'notice' && options.notice ? makeNode('div') : null),
    addEventListener() {},
  };

  const sandbox: Any = {
    console,
    URL,
    document: doc,
    setTimeout: (fn: () => void) => { setTimeout(fn, 0); return 1; },
    clearTimeout() {},
    setInterval: () => 1,
    clearInterval() {},
    devicePixelRatio: 1,
    localStorage: {
      getItem: (key: string) => (key in stored ? stored[key] : null),
      setItem: (key: string, value: string) => { stored[key] = String(value); },
    },
    navigator: {
      clipboard: {
        writeText: (text: string) => { clipboard.held = text; return Promise.resolve(); },
        readText: () => (clipboard.readable ? Promise.resolve(clipboard.held) : Promise.reject(new Error('denied'))),
      },
    },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.PhosphorNet = { readable: (e: Any) => String(e && e.message ? e.message : e) };
  sandbox.PhosphorShell = {
    setPending(button: Any, pending: boolean, label: string) { button.disabled = !!pending; button.pendingLabel = pending ? label : ''; },
    refresh: () => Promise.resolve(),
    setView() {},
    view: () => 'vault',
  };
  sandbox.PhosphorToast = { show: (message: string) => { toasts.push(message); } };
  sandbox.PhosphorDecision = { showCard: (build: (host: Any, done: () => void) => void, opts?: Any) => { const host = makeNode('div'); host.opts = opts; cards.push(host); build(host, () => {}); } };
  sandbox.PhosphorVault = { startReveal() { calls.push({ route: 'startReveal' }); } };
  sandbox.PhosphorLock = { focus() { calls.push({ route: 'lockFocus' }); } };
  sandbox.PhosphorApi = {
    intentsReceive: () => { calls.push({ route: '/api/intents-receive' }); return Promise.resolve({ data: options.report ?? report(), fresh: true }); },
    depositShow: (chain: string, symbol: string, address: string | null) => {
      calls.push({ route: '/api/deposit/show', chain, symbol, address });
      return Promise.resolve({ ok: true, deposit: { phase: 'watching', chain, symbol, address, startedAt: '2026-09-14T10:00:00.000Z', baseline: 0, amount: null, txHash: null, ms: null } });
    },
    depositStop: () => { calls.push({ route: '/api/deposit/stop' }); return Promise.resolve({ ok: true }); },
    vaultUnlock: (purpose?: string) => { calls.push({ route: '/api/vault/unlock', purpose }); return Promise.resolve({ ok: true, released: 0 }); },
  };

  createContext(sandbox);
  runInContext(LINKS, sandbox, { filename: 'ui/core/links.js' });
  runInContext(DOM, sandbox, { filename: 'ui/core/dom.js' });
  runInContext(STATE, sandbox, { filename: 'ui/core/state.js' });
  runInContext(QR, sandbox, { filename: 'ui/vendor/qrcode.js' });
  runInContext(JSQR, sandbox, { filename: 'ui/vendor/jsqr.js' });
  if (options.decoder) sandbox.jsQR = options.decoder;
  runInContext(NETPICK, sandbox, { filename: 'ui/screens/netpick.js' });
  runInContext(SOURCE, sandbox, { filename: 'ui/screens/deposit.js' });

  const store = sandbox.PhosphorState;
  store.put({ lock: { state: 'unlocked' }, vault: Object.assign({ custody: 'secure-enclave', backedUp: true }, options.vault ?? {}), deposit: null });
  sandbox.PhosphorDeposit.boot();

  const dialog = (): Any => body.childNodes.find((n: Any) => n.tagName === 'DIALOG') as Any;
  return {
    sandbox,
    deposit: sandbox.PhosphorDeposit,
    store,
    body,
    dialog,
    calls,
    toasts,
    clipboard,
    card: () => (cards.length ? cards[cards.length - 1] : null),
    stored,
  };
}

/* The card opens on the token list and its acknowledgement: tick the box, then Show the address. */
async function acknowledge(within: Any): Promise<void> {
  const box = find(within, '.ack-input')[0];
  assert.ok(box, 'no acknowledgement box under the token list');
  box.checked = true;
  box.dispatch('change');
  const go = find(within, 'button').find((b: Any) => b.dataset.role === 'show-address') as Any;
  assert.ok(go, 'no Show the address button');
  go.click();
  await flush();
}

/* The card opens only when a screen hands over a network (the Vault's Addresses card): a watch
   the agent starts never opens it (hunt-b 18). Every test opens it that way, and past the
   acknowledgement unless it says not. */
async function openCard(world: World, overrides: Any = {}, options: { ack?: boolean } = {}): Promise<Any> {
  await world.deposit.open(Object.assign({ chain: 'eth', symbol: 'USDC' }, overrides));
  await flush();
  if (options.ack !== false) await acknowledge(world.dialog());
  return world.dialog();
}

function frame(overrides: Any = {}): Any {
  return Object.assign({ phase: 'watching', chain: 'eth', symbol: 'USDC', address: ADDRESS, startedAt: '2026-09-14T10:00:00.000Z', baseline: 0, amount: null, txHash: null, explorerUrl: null, confirmations: null, ms: null, error: null }, overrides);
}

/* ---------- the source ---------- */

test('no string reaches the DOM as markup', () => {
  for (const [name, text] of [['deposit.js', SOURCE], ['netpick.js', NETPICK]]) {
    assert.equal(/\.innerHTML\s*=/.test(text), false, name + ' assigns innerHTML');
    assert.equal(/insertAdjacentHTML|outerHTML|document\.write/.test(text), false, name);
  }
});

test('the address is fetched, never taken from the frame alone', () => {
  // The frame that opens the card names the watch; the address it draws comes
  // off /api/intents-receive and the frame's copy has to agree with it.
  assert.ok(NETPICK.includes('api.intentsReceive()'), 'the component does not fetch the report');
  assert.ok(NETPICK.includes("'The address the watcher holds is not the one this wallet reports."), 'a frame address that disagrees is not refused');
});

/* ---------- check 2: the QR reads back ---------- */

test('the QR is drawn, decoded back off the same pixels, and matches the address', async () => {
  const world = build();
  await openCard(world);
  const dialog = world.dialog();
  assert.ok(dialog && dialog.open, 'the frame did not open the card');
  const bodyNode = find(dialog, '.deposit-body')[0];
  assert.equal(bodyNode.dataset.state, 'shown');
  assert.equal(find(dialog, 'canvas').length, 1, 'no QR on the card');
  assert.equal(find(dialog, '.addr-prefix')[0].textContent, '0x', 'the 0x is not its own quiet token');
  const ends = find(dialog, '.addr-end').map((n: Any) => n.textContent);
  assert.deepEqual(ends, ['7d4e', '0e1d'], 'the first and last group are not the ones in the text colour');
  const whole = find(find(dialog, '.deposit-address')[0], '.sr-only')[0];
  assert.equal(whole.textContent, ADDRESS, 'the whole address is not there for a screen reader');
  const mids = find(dialog, '.addr-mid').map((n: Any) => n.textContent);
  assert.equal(mids.length, 8, 'ten groups of four, two of them the ends');
  assert.ok(mids.every((m: string) => m.length === 4), 'a group that is not four characters: ' + mids.join(' '));
  assert.equal('0x7d4e' + mids.join('') + '0e1d', ADDRESS, 'the chunks do not add back up to the address');
});

test('a QR that reads back as anything else draws nothing and says so', async () => {
  const world = build({ decoder: () => ({ data: ADDRESS.slice(0, -1) + 'e' }) });
  await openCard(world);
  const dialog = world.dialog();
  const bodyNode = find(dialog, '.deposit-body')[0];
  assert.equal(bodyNode.dataset.state, 'refused');
  assert.equal(find(dialog, 'canvas').length, 0, 'a QR that failed the read-back is on screen');
  assert.equal(find(dialog, '.deposit-address').length, 0, 'the address was drawn beside a failed QR');
  assert.equal(find(dialog, '.btn-ghost').length, 0, 'a Copy button was drawn for an address that was refused');
  const text = textOf(bodyNode).join(' ');
  assert.ok(text.includes('Nothing is shown'), text);
  assert.ok(text.includes('read back as a different address'), text);
});

test('a decoder that reads nothing back is a refusal, not a pass', async () => {
  const world = build({ decoder: () => null });
  await openCard(world);
  const bodyNode = find(world.dialog(), '.deposit-body')[0];
  assert.equal(bodyNode.dataset.state, 'refused');
  assert.equal(find(world.dialog(), 'canvas').length, 0);
});

test('the watch\'s address and the fetched address have to agree', async () => {
  const world = build();
  await openCard(world, { address: ADDRESS.slice(0, -1) + 'f' });
  const bodyNode = find(world.dialog(), '.deposit-body')[0];
  assert.equal(bodyNode.dataset.state, 'refused');
  assert.ok(textOf(bodyNode).join(' ').includes('not the one this wallet reports'));
});

/* ---------- check 3: the copy reads back ---------- */

test('Copy writes the clipboard, reads it back, and says the last four', async () => {
  const world = build();
  await openCard(world);
  const copy = find(world.dialog(), 'button').find((n: Any) => n.dataset.role === 'copy') as Any;
  assert.ok(copy, 'no Copy button');
  copy.click();
  await flush();
  await flush();
  assert.equal(world.clipboard.held, ADDRESS);
  const said = find(world.dialog(), '.deposit-copied')[0];
  assert.equal(said.textContent, 'Address copied, ends in ...0e1d');
});

test('a clipboard that reads back something else is not reported as copied', async () => {
  const world = build();
  await openCard(world);
  world.sandbox.navigator.clipboard.readText = () => Promise.resolve('something else');
  const copy = find(world.dialog(), 'button').find((n: Any) => n.dataset.role === 'copy') as Any;
  copy.click();
  await flush();
  await flush();
  const said = find(world.dialog(), '.deposit-copied')[0];
  assert.ok(said.textContent.includes('does not hold the address'), said.textContent);
  assert.equal(said.textContent.includes('Copied'), false);
});

test('a clipboard that cannot be read back says so, with the last four to check by hand', async () => {
  const world = build();
  await openCard(world);
  world.clipboard.readable = false;
  const copy = find(world.dialog(), 'button').find((n: Any) => n.dataset.role === 'copy') as Any;
  copy.click();
  await flush();
  await flush();
  const said = find(world.dialog(), '.deposit-copied')[0];
  assert.ok(said.textContent.includes('could not be read back'), said.textContent);
  assert.ok(said.textContent.includes('...0e1d'), said.textContent);
});

/* ---------- check 1: the wallet is open ---------- */

test('an unverified report shows one button, which posts /api/vault/unlock with purpose address', async () => {
  const world = build({ report: report({ verified: false }) });
  await openCard(world);
  const dialog = world.dialog();
  const bodyNode = find(dialog, '.deposit-body')[0];
  assert.equal(bodyNode.dataset.state, 'unverified');
  assert.equal(find(dialog, 'canvas').length, 0, 'an unverified address was drawn');
  assert.equal(find(dialog, '.deposit-address').length, 0);
  const buttons = find(bodyNode, 'button');
  assert.equal(buttons.length, 1, 'more than one button on the unverified card');
  assert.equal(buttons[0].textContent, 'Touch ID to show the address');
  buttons[0].click();
  await flush();
  const unlock = world.calls.find((c) => c.route === '/api/vault/unlock');
  assert.ok(unlock, 'the button did not post /api/vault/unlock');
  assert.equal(unlock.purpose, 'address');
});

/* ---------- the words on the card ---------- */

test('the card says the network once, plainly, and the minimum in the unit a person types', async () => {
  const world = build();
  await openCard(world);
  const dialog = world.dialog();
  const text = textOf(dialog);
  assert.ok(text.includes('Send on Ethereum only.'), 'the address step does not name the network');
  assert.ok(text.includes('When you send, pick Ethereum (ERC-20) as the network. Base and Arbitrum use this same address.'), 'the sending-side sentence is missing');
  const min = find(dialog, '.deposit-min')[0];
  assert.equal(min.textContent, 'Minimums: ETH 0.001, USDC 1.');
  assert.equal(text.some((t) => t.includes('1000000')), false, 'the raw base units reached the screen');
  assert.equal(find(dialog, 'button.chip').length, 0, 'a chip on the card: the network was picked and a token does not change the address');
  assert.equal(world.deposit.networkWords('sol'), 'Solana (SPL)');
  assert.equal(world.deposit.networkWords('arb'), 'Arbitrum One');
  assert.equal(world.deposit.networkWords('near'), 'NEAR Protocol');
  assert.equal(world.deposit.networkWords('base'), 'Base');
});

test('a row click posts /api/deposit/show with the chain, the asset and the address it knows', async () => {
  const world = build();
  await world.deposit.open({ chain: 'sol', symbol: 'USDC', address: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin' });
  await flush();
  const show = world.calls.find((c) => c.route === '/api/deposit/show');
  assert.deepEqual(show, { route: '/api/deposit/show', chain: 'sol', symbol: 'USDC', address: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin' });
  assert.ok(world.dialog().open);
  assert.equal(world.deposit.defaultSymbol([{ symbol: 'ETH' }, { symbol: 'USDC' }]), 'USDC');
  assert.equal(world.deposit.defaultSymbol([{ symbol: 'SOL' }]), 'SOL');
});

/* ---------- the watcher ---------- */

test('the watcher says what is happening to the money: waiting, arriving, almost there, in your balance', async () => {
  const world = build();
  await openCard(world);
  const dialog = world.dialog();
  const watch = find(dialog, '.deposit-watch')[0];
  const line = (): string => find(dialog, '.deposit-watch-text')[0].textContent;
  const link = find(dialog, '.deposit-watch-link')[0];
  const note = find(dialog, '.deposit-watch-note')[0];
  const base = world.store.get();

  // No stopwatch, no second copy of the address, no Stop (hunt-b 61).
  world.store.put(Object.assign({}, base, { deposit: frame() }));
  assert.equal(watch.dataset.phase, 'watching');
  assert.match(line(), /^(Waiting for your deposit on Ethereum|Still waiting for your deposit on Ethereum, \d+ min so far)$/);
  assert.equal(line().includes('0x7d4e'), false, 'the address is said a second time');
  assert.equal(find(watch, 'button').length, 0, 'the line offers a Stop');
  assert.equal(link.hidden, true, 'nothing to link to yet');
  assert.equal(note.hidden, true);
  assert.equal(find(watch, '.deposit-ring').length, 1, 'the ring is not drawn while it waits');

  // No confirmations, no bridge words (hunt-b 62).
  world.store.put(Object.assign({}, base, { deposit: frame({ phase: 'seen', amount: 5, txHash: '0xabc', explorerUrl: 'https://etherscan.io/tx/0xabc', confirmations: 2, ms: 12000 }) }));
  assert.equal(watch.dataset.phase, 'seen');
  assert.equal(line(), 'Arriving on Ethereum: 5 USDC');
  assert.equal(link.hidden, false, 'the transfer is a link');
  assert.equal(link.href, 'https://etherscan.io/tx/0xabc');
  assert.equal(find(watch, '.deposit-ring').length, 1, 'the ring was drawn again rather than filled');

  world.store.put(Object.assign({}, base, { deposit: frame({ phase: 'bridged', amount: 5, txHash: '0xabc', explorerUrl: 'https://etherscan.io/tx/0xabc', ms: 30000 }) }));
  assert.equal(watch.dataset.phase, 'bridged');
  assert.equal(line(), 'Almost there: 5 USDC');

  world.store.put(Object.assign({}, base, { deposit: frame({ phase: 'credited', amount: 5, txHash: '0xabc', explorerUrl: 'https://etherscan.io/tx/0xabc', ms: 41000 }) }));
  assert.equal(watch.dataset.phase, 'credited');
  assert.equal(line(), '5 USDC is in your balance');
  assert.ok(find(watch, '.deposit-watch-check').length === 1, 'the check replaces the ring');
  assert.equal(find(watch, '.deposit-ring').length, 0);

  // A read that keeps failing is said under the line in plain words, and clears when it works;
  // the watch's own reason rides behind the developer switch.
  world.store.put(Object.assign({}, base, { deposit: frame({ startedAt: '2026-09-14T10:00:00.000Z', error: 'The verifier is not answering, retrying' }) }));
  assert.equal(note.hidden, false);
  assert.equal(note.textContent, 'Checking is slow right now. The app keeps trying.');
  const raw = find(dialog, '.deposit-watch-raw')[0];
  assert.ok(raw.hasAttribute('data-dev-only'));
  assert.equal(raw.textContent, 'The verifier is not answering, retrying');
  world.store.put(Object.assign({}, base, { deposit: frame({ error: null }) }));
  assert.equal(note.hidden, true);

  // A link that is not https never becomes one.
  world.store.put(Object.assign({}, base, { deposit: frame({ phase: 'seen', txHash: '0xabc', explorerUrl: 'javascript:alert(1)' }) }));
  assert.equal(link.hidden, true);
});

test('closing the card stops nothing, and nothing on the card stops the watch', async () => {
  const world = build();
  await openCard(world);
  const dialog = world.dialog();
  assert.equal(find(find(dialog, '.deposit-watch')[0], 'button').length, 0, 'a Stop on the watcher line');
  const closeBtn = find(dialog, '.btn-quiet').find((n: Any) => n.textContent === 'Close') as Any;
  assert.ok(closeBtn, 'no Close on the card');
  assert.equal(closeBtn.getAttribute('aria-label'), 'Close');
  closeBtn.click();
  assert.equal(dialog.open, false);
  assert.equal(world.calls.some((c) => c.route === '/api/deposit/stop'), false, 'closing the card stopped the watch');
});

/* The agent's deposit used to open this card over the conversation with no click, while the
   thread drew a second card for the same watch (hunt-b 18). A watch frame never opens it now. */
test('a watch the agent starts never opens the card, and a frame never reopens one the person closed', async () => {
  const world = build();
  world.deposit.onFrame(frame());
  await flush();
  assert.ok(!world.dialog() || !world.dialog().open, 'a watching frame opened the card over the conversation');
  world.deposit.onFrame(frame({ startedAt: '2026-09-14T11:00:00.000Z' }));
  assert.ok(!world.dialog() || !world.dialog().open, 'a fresh watch opened the card');

  await openCard(world);
  const dialog = world.dialog();
  assert.equal(dialog.open, true);
  world.deposit.close();
  world.deposit.onFrame(frame());
  assert.equal(dialog.open, false, 'the same watch reopened the card');
});

test('the card is titled with the step, opens on its title, and names the network once', async () => {
  const world = build();
  const dialog = await openCard(world);
  const title = find(dialog, '.deposit-title')[0];
  assert.equal(find(title, '.deposit-title-text')[0].textContent, 'Send on Ethereum only.');
  assert.equal(title.focused, true, 'the card opened on Close, not on what it says');
  assert.equal(dialog.getAttribute('aria-labelledby'), title.id);
});

/* ---------- the backup card ---------- */

test('the first credited deposit on a wallet that is not backed up opens the backup card, once', async () => {
  const world = build({ vault: { custody: 'secure-enclave', backedUp: false } });
  await openCard(world);
  const dialog = world.dialog();
  const base = world.store.get();
  const landed = frame({ phase: 'credited', amount: 5, ms: 41000 });
  world.store.put(Object.assign({}, base, { deposit: landed }));
  const backup = find(dialog, '.deposit-backup')[0];
  assert.equal(backup.hidden, false, 'no backup card on the first landed deposit');
  const text = textOf(backup);
  assert.ok(text.includes('You have money in. Back up now.'));
  const buttons = find(backup, 'button');
  assert.equal(buttons.length, 2, 'the backup card has the X and Back up now, nothing else');
  assert.equal(buttons[0].getAttribute('aria-label'), 'Not now');
  assert.equal(buttons[1].textContent, 'Back up now');
  buttons[1].click();
  assert.equal(dialog.open, false, 'Back up now left the deposit card open');
  assert.ok(world.calls.some((c) => c.route === 'startReveal'), 'Back up now did not go to Reveal');

  // The same landed watch again, later: no second card.
  world.deposit.onFrame(frame({ startedAt: '2026-09-14T12:00:00.000Z' }));
  await flush();
  world.store.put(Object.assign({}, world.store.get(), { deposit: landed }));
  assert.equal(world.card(), null, 'a second backup card for the same watch');
});

test('a credited deposit on a wallet that is backed up asks for nothing', async () => {
  const world = build({ vault: { custody: 'secure-enclave', backedUp: true } });
  await openCard(world);
  world.store.put(Object.assign({}, world.store.get(), { deposit: frame({ phase: 'credited', amount: 5, ms: 41000 }) }));
  assert.equal(find(world.dialog(), '.deposit-backup')[0].hidden, true);
  assert.equal(world.card(), null);
});

test('money that lands after the card was closed is said once, as a toast', async () => {
  const world = build();
  await openCard(world);
  world.deposit.close();
  const landed = frame({ phase: 'credited', amount: 5, ms: 41000 });
  world.store.put(Object.assign({}, world.store.get(), { deposit: landed }));
  assert.deepEqual(world.toasts, ['5 USDC is in your balance']);
  world.store.put(Object.assign({}, world.store.get(), { deposit: Object.assign({}, landed, { ms: 42000 }) }));
  assert.equal(world.toasts.length, 1, 'the same landing was said twice');
});

test('Change network goes back to the tiles, and a different network is a fresh watch', async () => {
  const base = { id: 'base', name: 'Base', address: '0x1111111111111111111111111111111111111111', memo: null, unavailable: null, accepts: [{ symbol: 'USDC', minDeposit: '1000000', minDepositHuman: '1', decimals: 6, contract: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' }], warning: WARNING };
  const world = build({ report: report({ networks: report().networks.concat([base]) }) });
  await openCard(world);
  const dialog = world.dialog();
  const pick = find(dialog, '.netpick')[0];
  assert.equal(pick.dataset.stage, 'address');
  const back = find(dialog, '.netpick-back')[0];
  assert.ok(back, 'no way back to the network tiles');
  back.click();
  assert.equal(pick.dataset.stage, 'network');
  const tiles = find(dialog, '.net-tile');
  assert.deepEqual(tiles.map((t: Any) => t.dataset.network), ['eth', 'base', 'arb', 'sol', 'near', 'btc']);
  (tiles[1] as Any).click();
  await flush();
  assert.equal(pick.dataset.stage, 'tokens');
  // A new network asks for the tick again: nothing was remembered from the first one.
  assert.equal(find(dialog, '.ack-input').length, 1, 'the acknowledgement was not asked for again');
  const go = find(dialog, 'button').find((b: Any) => b.textContent === 'Show the address') as Any;
  assert.equal(go.disabled, true, 'the address button is live before the box is ticked');
  await acknowledge(dialog);
  assert.equal(pick.dataset.stage, 'address');
  const show = world.calls.filter((c) => c.route === '/api/deposit/show').pop();
  assert.deepEqual(show, { route: '/api/deposit/show', chain: 'base', symbol: 'USDC', address: base.address });
  assert.equal(find(find(dialog, '.deposit-address')[0], '.sr-only')[0].textContent, base.address, 'the address drawn is not Base\'s');
});

test('every time the card opens it lands on the token list, and the address waits for the tick', async () => {
  const world = build();
  await openCard(world, {}, { ack: false });
  const dialog = world.dialog();
  const pick = find(dialog, '.netpick')[0];
  assert.equal(pick.dataset.stage, 'tokens');
  assert.equal(find(dialog, 'canvas').length, 0, 'the address was drawn before the acknowledgement');
  const rows = find(dialog, '.token-row');
  assert.deepEqual(rows.map((r: Any) => r.dataset.symbol), ['ETH', 'USDC'], 'the chain\'s own coin is not first');
  assert.deepEqual(find(dialog, '.token-min').map((n: Any) => n.textContent), ['Min 0.001 ETH', 'Min 1 USDC']);
  const go = find(dialog, 'button').find((b: Any) => b.textContent === 'Show the address') as Any;
  assert.equal(go.disabled, true, 'the address button is live before the box is ticked');
  const box = find(dialog, '.ack-input')[0];
  box.checked = true;
  box.dispatch('change');
  assert.equal(go.disabled, false);
  go.click();
  await flush();
  assert.equal(pick.dataset.stage, 'address');
  assert.equal(find(dialog, 'canvas').length, 1, 'no QR after the acknowledgement');
  assert.deepEqual(Object.keys(world.stored), [], 'the acknowledgement was written down');
  assert.equal(world.calls.filter((c) => c.route === '/api/deposit/show').length, 1, 'the card started a second watch for the watch it was opened with');

  // Closed and opened again for the same watch: the list and the box again, no address.
  world.deposit.close();
  const reopened = await openCard(world, {}, { ack: false });
  assert.equal(find(reopened, '.netpick')[0].dataset.stage, 'tokens', 'the second open went straight to the address');
  assert.equal(find(reopened, '.ack-input').length, 1, 'the second open did not ask again');
  assert.equal(find(reopened, 'canvas').length, 0, 'the address was drawn before the second tick');
  await acknowledge(reopened);
  assert.equal(find(reopened, '.netpick')[0].dataset.stage, 'address');
  assert.deepEqual(Object.keys(world.stored), [], 'the second acknowledgement was written down');
});

/* ---------- the reminder at every start ---------- */

test('with money in and the phrase not proven, the backup card is up once per start, with an X that puts it away', async () => {
  const world = build({ vault: { custody: 'secure-enclave', backedUp: false } });
  assert.equal(world.card(), null, 'a card before the window knows what it holds');
  world.store.put(Object.assign({}, world.store.get(), { basic: { totalUsd: 12.5 } }));
  const card = world.card();
  assert.ok(card, 'no reminder with money in and no backup');
  /* In the thread it is one quiet line in the balances panel's words, never the big card with
     a green button: the panel's foot says the same thing (lead, 2026-09-23). */
  assert.equal(card.opts && card.opts.quiet, true, 'the reminder asked the thread for a card, not a line');
  assert.ok(textOf(card).includes('Your recovery phrase is not backed up yet.'), String(textOf(card)));
  const buttons = find(card, 'button');
  assert.equal(buttons.length, 2, 'the line has its action and the X, nothing else');
  assert.equal(buttons[0].textContent, 'Back it up');
  assert.ok(!String(buttons[0].className).includes('btn-primary'), 'the reminder is green');
  assert.equal(buttons[1].getAttribute('aria-label'), 'Not now');
  buttons[0].click();
  assert.ok(world.calls.some((c) => c.route === 'startReveal'), 'Back it up did not go to Reveal');
  // A later frame with the same facts does not raise a second card this session.
  world.store.put(Object.assign({}, world.store.get(), { basic: { totalUsd: 13 } }));
  assert.equal(world.card(), card, 'the reminder came back inside one session');
});

test('the reminder waits while a request is waiting, and never shows for an empty or proven wallet', async () => {
  const waiting = build({ vault: { custody: 'secure-enclave', backedUp: false } });
  waiting.store.put(Object.assign({}, waiting.store.get(), { basic: { totalUsd: 12.5 }, proposals: [{ id: 'p1', status: 'pending' }] }));
  assert.equal(waiting.card(), null, 'the reminder covered a request waiting on the person');
  waiting.store.put(Object.assign({}, waiting.store.get(), { proposals: [] }));
  assert.ok(waiting.card(), 'the reminder did not come once the request was answered');

  const empty = build({ vault: { custody: 'secure-enclave', backedUp: false } });
  empty.store.put(Object.assign({}, empty.store.get(), { basic: { totalUsd: 0 } }));
  assert.equal(empty.card(), null, 'a reminder for a wallet holding nothing');

  const proven = build({ vault: { custody: 'secure-enclave', backedUp: true } });
  proven.store.put(Object.assign({}, proven.store.get(), { basic: { totalUsd: 500 } }));
  assert.equal(proven.card(), null, 'a reminder for a wallet whose phrase is proven');
});

/* The frame's notice carries "not backed up" at the foot of the window whenever it is true, so
   the thread does not say it a second time. */
test('with the frame\'s notice on the page, the thread shows no backup reminder of its own', () => {
  const world = build({ vault: { custody: 'secure-enclave', backedUp: false }, notice: true });
  world.store.put(Object.assign({}, world.store.get(), { basic: { totalUsd: 12.5 } }));
  assert.equal(world.card(), null, 'the thread said what the notice already says');
});

