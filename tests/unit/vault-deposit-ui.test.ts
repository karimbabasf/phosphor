// The deposit card's three checks, run for real.
//
// The card is the one place in the window an address is drawn, and each check
// is asserted by running ui/screens/deposit.js over a small DOM with the real
// ui/core/dom.js, the real state store, the real vendored QR encoder and the
// real vendored decoder. The canvas below is a pixel buffer, so the QR the
// card draws is the QR the decoder reads back: a decoder swapped for one that
// answers a different string has to leave the card blank.
//
// Nothing here starts the app. Every route is a stub that records the call.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

type Any = Record<string, any>;

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
const DOM = read('../../ui/core/dom.js');
const STATE = read('../../ui/core/state.js');
const QR = read('../../ui/vendor/qrcode.js');
const JSQR = read('../../ui/vendor/jsqr.js');
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
    focus() {},
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
      { id: 'eth', name: 'Ethereum', address: ADDRESS, memo: null, unavailable: null, accepts: [{ symbol: 'USDC', minDeposit: '1', decimals: 6 }, { symbol: 'ETH', minDeposit: '0.001', decimals: 18 }], warning: WARNING },
      { id: 'sol', name: 'Solana', address: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', memo: null, unavailable: null, accepts: [{ symbol: 'USDC', minDeposit: '1', decimals: 6 }], warning: 'Solana only. Anything sent here from another network is lost.' },
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
};

function build(options: { report?: Any; vault?: Any; decoder?: (data: unknown) => Any | null } = {}): World {
  const body = makeNode('body');
  const page = makeNode('div');
  const calls: Any[] = [];
  const toasts: string[] = [];
  const clipboard = { held: '', readable: true };
  const cards: Any[] = [];

  const doc: Any = {
    body,
    createElement: makeNode,
    getElementById: (id: string) => (id === 'page' ? page : null),
    addEventListener() {},
  };

  const sandbox: Any = {
    console,
    document: doc,
    setTimeout: (fn: () => void) => { setTimeout(fn, 0); return 1; },
    clearTimeout() {},
    setInterval: () => 1,
    clearInterval() {},
    devicePixelRatio: 1,
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
  sandbox.PhosphorDecision = { showCard: (build: (host: Any, done: () => void) => void) => { const host = makeNode('div'); cards.push(host); build(host, () => {}); } };
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
  runInContext(DOM, sandbox, { filename: 'ui/core/dom.js' });
  runInContext(STATE, sandbox, { filename: 'ui/core/state.js' });
  runInContext(QR, sandbox, { filename: 'ui/vendor/qrcode.js' });
  runInContext(JSQR, sandbox, { filename: 'ui/vendor/jsqr.js' });
  if (options.decoder) sandbox.jsQR = options.decoder;
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
  };
}

function frame(overrides: Any = {}): Any {
  return Object.assign({ phase: 'watching', chain: 'eth', symbol: 'USDC', address: ADDRESS, startedAt: '2026-09-14T10:00:00.000Z', baseline: 0, amount: null, txHash: null, ms: null }, overrides);
}

/* ---------- the source ---------- */

test('no string reaches the DOM as markup', () => {
  assert.equal(/\.innerHTML\s*=/.test(SOURCE), false, 'deposit.js assigns innerHTML');
  assert.equal(/insertAdjacentHTML|outerHTML|document\.write/.test(SOURCE), false);
});

test('the address is fetched, never taken from the frame alone', () => {
  // The frame that opens the card names the watch; the address it draws comes
  // off /api/intents-receive and the frame's copy has to agree with it.
  assert.ok(SOURCE.includes('api.intentsReceive()'), 'the card does not fetch the report');
  assert.ok(SOURCE.includes("'The address the watcher holds is not the one this wallet reports."), 'a frame address that disagrees is not refused');
});

/* ---------- check 2: the QR reads back ---------- */

test('the QR is drawn, decoded back off the same pixels, and matches the address', async () => {
  const world = build();
  world.deposit.onFrame(frame());
  await flush();
  const dialog = world.dialog();
  assert.ok(dialog && dialog.open, 'the frame did not open the card');
  const bodyNode = find(dialog, '.deposit-body')[0];
  assert.equal(bodyNode.dataset.state, 'shown');
  assert.equal(find(dialog, 'canvas').length, 1, 'no QR on the card');
  const ends = find(dialog, '.addr-end').map((n: Any) => n.textContent);
  assert.deepEqual(ends, ['0x7d', '0e1d'], 'the first and last four are not the large ones');
  const whole = find(dialog, '.sr-only')[0];
  assert.equal(whole.textContent, ADDRESS, 'the whole address is not there for a screen reader');
  const mid = find(dialog, '.addr-mid').map((n: Any) => n.textContent).join('');
  assert.equal('0x7d' + mid + '0e1d', ADDRESS, 'the chunks do not add back up to the address');
});

test('a QR that reads back as anything else draws nothing and says so', async () => {
  const world = build({ decoder: () => ({ data: ADDRESS.slice(0, -1) + 'e' }) });
  world.deposit.onFrame(frame());
  await flush();
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
  world.deposit.onFrame(frame());
  await flush();
  const bodyNode = find(world.dialog(), '.deposit-body')[0];
  assert.equal(bodyNode.dataset.state, 'refused');
  assert.equal(find(world.dialog(), 'canvas').length, 0);
});

test('the frame address and the fetched address have to agree', async () => {
  const world = build();
  world.deposit.onFrame(frame({ address: ADDRESS.slice(0, -1) + 'f' }));
  await flush();
  const bodyNode = find(world.dialog(), '.deposit-body')[0];
  assert.equal(bodyNode.dataset.state, 'refused');
  assert.ok(textOf(bodyNode).join(' ').includes('not the one this wallet reports'));
});

/* ---------- check 3: the copy reads back ---------- */

test('Copy writes the clipboard, reads it back, and says the last four', async () => {
  const world = build();
  world.deposit.onFrame(frame());
  await flush();
  const copy = find(world.dialog(), '.btn-ghost').find((n: Any) => n.textContent === 'Copy') as Any;
  assert.ok(copy, 'no Copy button');
  copy.click();
  await flush();
  await flush();
  assert.equal(world.clipboard.held, ADDRESS);
  const said = find(world.dialog(), '.deposit-copied')[0];
  assert.equal(said.textContent, 'Copied, ends in ...0e1d');
});

test('a clipboard that reads back something else is not reported as copied', async () => {
  const world = build();
  world.deposit.onFrame(frame());
  await flush();
  world.sandbox.navigator.clipboard.readText = () => Promise.resolve('something else');
  const copy = find(world.dialog(), '.btn-ghost').find((n: Any) => n.textContent === 'Copy') as Any;
  copy.click();
  await flush();
  await flush();
  const said = find(world.dialog(), '.deposit-copied')[0];
  assert.ok(said.textContent.includes('does not hold the address'), said.textContent);
  assert.equal(said.textContent.includes('Copied'), false);
});

test('a clipboard that cannot be read back says so, with the last four to check by hand', async () => {
  const world = build();
  world.deposit.onFrame(frame());
  await flush();
  world.clipboard.readable = false;
  const copy = find(world.dialog(), '.btn-ghost').find((n: Any) => n.textContent === 'Copy') as Any;
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
  world.deposit.onFrame(frame());
  await flush();
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

test('the network is named in exchange words, the minimum is stated, and the warning is verbatim', async () => {
  const world = build();
  world.deposit.onFrame(frame());
  await flush();
  const text = textOf(world.dialog());
  assert.ok(text.includes('Deposit USDC on Ethereum (ERC-20)'), 'the title does not name the network the way an exchange does');
  assert.ok(text.some((t) => t.includes('choose the network "Ethereum (ERC-20)"')));
  assert.ok(text.some((t) => t.includes('Minimum 1 USDC')));
  assert.ok(text.includes(WARNING), 'the warning line is not the report\'s, word for word');
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

test('the watcher moves through watching, seen and landed, with the time it took', async () => {
  const world = build();
  world.deposit.onFrame(frame());
  await flush();
  const dialog = world.dialog();
  const watch = find(dialog, '.deposit-watch')[0];
  const line = (): string => find(dialog, '.deposit-watch-text')[0].textContent;
  const base = world.store.get();

  world.store.put(Object.assign({}, base, { deposit: frame() }));
  assert.equal(watch.dataset.phase, 'watching');
  assert.ok(line().startsWith('Watching for your deposit, '), line());

  world.store.put(Object.assign({}, base, { deposit: frame({ phase: 'seen', amount: 5, txHash: 'abc', ms: 12000 }) }));
  assert.equal(watch.dataset.phase, 'seen');
  assert.equal(line(), 'Seen on Ethereum (ERC-20): 5 USDC, confirming');

  world.store.put(Object.assign({}, base, { deposit: frame({ phase: 'landed', amount: 5, txHash: 'abc', ms: 41000 }) }));
  assert.equal(watch.dataset.phase, 'landed');
  assert.equal(line(), 'Landed: 5 USDC in 41 s');
  const stop = find(watch, 'button')[0];
  assert.equal(stop.hidden, true, 'Stop is offered after the money landed');
});

test('closing the card stops nothing; only Stop posts /api/deposit/stop', async () => {
  const world = build();
  world.deposit.onFrame(frame());
  await flush();
  const dialog = world.dialog();
  const stop = find(find(dialog, '.deposit-watch')[0], 'button')[0];
  const closeBtn = find(dialog, '.btn-quiet').find((n: Any) => n.textContent === 'Close') as Any;
  closeBtn.click();
  assert.equal(dialog.open, false);
  assert.equal(world.calls.some((c) => c.route === '/api/deposit/stop'), false, 'closing the card stopped the watch');
  stop.click();
  await flush();
  assert.ok(world.calls.some((c) => c.route === '/api/deposit/stop'));
});

test('a second frame for the same watch does not reopen a card the person closed', async () => {
  const world = build();
  world.deposit.onFrame(frame());
  await flush();
  const dialog = world.dialog();
  world.deposit.close();
  world.deposit.onFrame(frame());
  assert.equal(dialog.open, false, 'the same watch reopened the card');
  world.deposit.onFrame(frame({ startedAt: '2026-09-14T11:00:00.000Z' }));
  assert.equal(world.dialog().open, true, 'a fresh watch did not open the card');
});

/* ---------- the backup card ---------- */

test('the first landed deposit on a wallet that is not backed up opens the backup card, once', async () => {
  const world = build({ vault: { custody: 'secure-enclave', backedUp: false } });
  world.deposit.onFrame(frame());
  await flush();
  const dialog = world.dialog();
  const base = world.store.get();
  const landed = frame({ phase: 'landed', amount: 5, ms: 41000 });
  world.store.put(Object.assign({}, base, { deposit: landed }));
  const backup = find(dialog, '.deposit-backup')[0];
  assert.equal(backup.hidden, false, 'no backup card on the first landed deposit');
  const text = textOf(backup);
  assert.ok(text.includes('You have money in. Back up now.'));
  const buttons = find(backup, 'button');
  assert.equal(buttons.length, 1, 'the backup card has more than one button');
  assert.equal(buttons[0].textContent, 'Back up now');
  buttons[0].click();
  assert.equal(dialog.open, false, 'Back up now left the deposit card open');
  assert.ok(world.calls.some((c) => c.route === 'startReveal'), 'Back up now did not go to Reveal');

  // The same landed watch again, later: no second card.
  world.deposit.onFrame(frame({ startedAt: '2026-09-14T12:00:00.000Z' }));
  await flush();
  world.store.put(Object.assign({}, world.store.get(), { deposit: landed }));
  assert.equal(world.card(), null, 'a second backup card for the same watch');
});

test('a landed deposit on a wallet that is backed up asks for nothing', async () => {
  const world = build({ vault: { custody: 'secure-enclave', backedUp: true } });
  world.deposit.onFrame(frame());
  await flush();
  world.store.put(Object.assign({}, world.store.get(), { deposit: frame({ phase: 'landed', amount: 5, ms: 41000 }) }));
  assert.equal(find(world.dialog(), '.deposit-backup')[0].hidden, true);
  assert.equal(world.card(), null);
});

test('money that lands after the card was closed is said once, as a toast', async () => {
  const world = build();
  world.deposit.onFrame(frame());
  await flush();
  world.deposit.close();
  const landed = frame({ phase: 'landed', amount: 5, ms: 41000 });
  world.store.put(Object.assign({}, world.store.get(), { deposit: landed }));
  assert.deepEqual(world.toasts, ['Landed: 5 USDC in 41 s']);
  world.store.put(Object.assign({}, world.store.get(), { deposit: Object.assign({}, landed, { ms: 42000 }) }));
  assert.equal(world.toasts.length, 1, 'the same landing was said twice');
});

test('an EVM card offers the other two EVM networks as chips, and a chip starts a fresh watch there', async () => {
  const base = { id: 'base', name: 'Base', address: '0x1111111111111111111111111111111111111111', memo: null, unavailable: null, accepts: [{ symbol: 'USDC', minDeposit: '1', decimals: 6 }], warning: WARNING };
  const world = build({ report: report({ networks: report().networks.concat([base]) }) });
  world.deposit.onFrame(frame());
  await flush();
  const dialog = world.dialog();
  const chips = find(dialog, 'button.chip').filter((c: Any) => /Ethereum|Base|Arbitrum/.test(c.textContent));
  assert.deepEqual(chips.map((c: Any) => c.textContent), ['Ethereum (ERC-20)', 'Base']);
  assert.deepEqual(chips.map((c: Any) => c.getAttribute('aria-pressed')), ['true', 'false']);
  chips[1].click();
  await flush();
  const show = world.calls.find((c) => c.route === '/api/deposit/show');
  assert.deepEqual(show, { route: '/api/deposit/show', chain: 'base', symbol: 'USDC', address: base.address });

  // Solana offers no network chips: there is nothing to choose.
  const sol = build();
  sol.deposit.onFrame(frame({ chain: 'sol', address: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin' }));
  await flush();
  assert.equal(find(sol.dialog(), 'button.chip').filter((c: Any) => /Ethereum|Base|Arbitrum|Solana/.test(c.textContent)).length, 0);
});
