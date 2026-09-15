// Money in, in three steps, run over a small DOM.
//
// ui/screens/netpick.js is driven with the real ui/core/dom.js, the real state
// store and the real vendored QR encoder and decoder. Every route is a stub
// that records the call, nothing starts the app, and the "Mac" remembers the
// acknowledgement only when a test says it does.

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
const SOURCE = read('../../ui/screens/netpick.js');

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
    width: 0,
    height: 0,
    tabIndex: 0,
    focused: false,
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
    appendChild(child: Any) {
      child.parentNode?.removeChild(child);
      child.parentNode = node;
      node.childNodes.push(child);
      return child;
    },
    removeChild(child: Any) {
      const at = node.childNodes.indexOf(child);
      if (at >= 0) node.childNodes.splice(at, 1);
      child.parentNode = null;
      return child;
    },
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
    focus() { node.focused = true; focusedNow = node; },
    querySelector(selector: string) { return find(node, selector)[0] ?? null; },
    querySelectorAll(selector: string) { return find(node, selector); },
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

let focusedNow: Any | null = null;

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
const buttonNamed = (root: Any, label: string): Any => find(root, 'button').find((b: Any) => b.textContent === label) as Any;

/* ---------- the report ---------- */

const EVM = '0x7d4e1f0a2c9b8e6d3f5a1c7b9e0d2f4a6c8b0e1d';
const SOL = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';

function token(symbol: string, decimals: number, raw: string, human: string, contract: string | null = null): Any {
  return { symbol, decimals, minDeposit: raw, minDepositHuman: human, contract };
}

function report(overrides: Any = {}): Any {
  return Object.assign({
    account: EVM.toLowerCase(),
    verified: true,
    tampered: false,
    networks: [
      {
        id: 'eth', name: 'Ethereum', address: EVM, memo: null, unavailable: null, warning: 'w',
        accepts: [
          token('WBTC', 8, '10000', '0.0001', '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599'),
          token('USDT', 6, '1000', '0.001', '0xdac17f958d2ee523a2206206994597c13d831ec7'),
          token('DAI', 18, '1000000000000000', '0.001', '0x6b175474e89094c44da98b954eedeac495271d0f'),
          token('USDC', 6, '1000', '0.001', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'),
          token('ETH', 18, '100000000000', '0.0000001'),
          token('PYUSD', 6, '1000', '0.001', '0x6c3ea9036406852006290770bedfcaba0e23a0e8'),
        ],
      },
      { id: 'base', name: 'Base', address: EVM, memo: null, unavailable: null, warning: 'w', accepts: [token('USDC', 6, '1000', '0.001', '0x8335'), token('ETH', 18, '100000000000', '0.0000001')] },
      { id: 'arb', name: 'Arbitrum', address: null, memo: null, unavailable: 'the bridge refused eth:42161: down for maintenance', warning: 'w', accepts: [] },
      { id: 'sol', name: 'Solana', address: SOL, memo: null, unavailable: null, warning: 'w', accepts: [token('USDC', 6, '1000', '0.001', 'EPjF'), token('SOL', 9, '10000000', '0.01')] },
      { id: 'near', name: 'NEAR', address: 'abc.near', memo: null, unavailable: null, warning: 'w', accepts: [token('NEAR', 24, '100000000000000000000000', '0.1')] },
    ],
  }, overrides);
}

type World = {
  sandbox: Any;
  pick: Any;
  host: Any;
  store: Any;
  calls: Any[];
  timers: Array<() => void>;
  stored: Record<string, string>;
  render: (opts?: Any) => Any;
};

function build(options: { report?: Any; ack?: boolean; vault?: Any; withDeposit?: boolean } = {}): World {
  const body = makeNode('body');
  const host = makeNode('div');
  body.appendChild(host);
  const calls: Any[] = [];
  const timers: Array<() => void> = [];
  const stored: Record<string, string> = options.ack ? { 'phosphor.depositAck': '1' } : {};
  focusedNow = null;

  const doc: Any = { body, createElement: makeNode, getElementById: () => null, addEventListener() {} };
  const sandbox: Any = {
    console,
    document: doc,
    setTimeout: (fn: () => void) => { timers.push(fn); return timers.length; },
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
        writeText: (text: string) => { calls.push({ route: 'clipboard', text }); return Promise.resolve(); },
        readText: () => Promise.resolve(calls.filter((c) => c.route === 'clipboard').pop()?.text ?? ''),
      },
    },
  };
  sandbox.window = sandbox;
  sandbox.PhosphorNet = { readable: (e: Any) => String(e && e.message ? e.message : e) };
  sandbox.PhosphorShell = {
    setPending(button: Any, pending: boolean, label: string) { button.disabled = !!pending; button.pendingLabel = pending ? label : ''; },
    refresh: () => Promise.resolve(),
  };
  sandbox.PhosphorToast = { show: (message: string) => { calls.push({ route: 'toast', message }); } };
  sandbox.PhosphorLock = { focus() { calls.push({ route: 'lockFocus' }); } };
  if (options.withDeposit) {
    sandbox.PhosphorDeposit = {
      startWatch: (chain: string, symbol: string, address: string | null) => {
        calls.push({ route: 'deposit.startWatch', chain, symbol, address });
        return Promise.resolve({ phase: 'watching', chain, symbol, address, startedAt: '2026-09-15T09:00:00.000Z', baseline: 0, amount: null, txHash: null, ms: null });
      },
    };
  }
  sandbox.PhosphorApi = {
    intentsReceive: () => { calls.push({ route: '/api/intents-receive' }); return Promise.resolve({ data: options.report ?? report(), fresh: true }); },
    depositShow: (chain: string, symbol: string, address: string | null) => {
      calls.push({ route: '/api/deposit/show', chain, symbol, address });
      return Promise.resolve({ ok: true, deposit: { phase: 'watching', chain, symbol, address, startedAt: '2026-09-15T09:00:00.000Z', baseline: 0, amount: null, txHash: null, ms: null } });
    },
    depositStop: () => { calls.push({ route: '/api/deposit/stop' }); return Promise.resolve({ ok: true }); },
    vaultUnlock: (purpose?: string) => { calls.push({ route: '/api/vault/unlock', purpose }); return Promise.resolve({ ok: true }); },
  };

  createContext(sandbox);
  runInContext(DOM, sandbox, { filename: 'ui/core/dom.js' });
  runInContext(STATE, sandbox, { filename: 'ui/core/state.js' });
  runInContext(QR, sandbox, { filename: 'ui/vendor/qrcode.js' });
  runInContext(JSQR, sandbox, { filename: 'ui/vendor/jsqr.js' });
  runInContext(SOURCE, sandbox, { filename: 'ui/screens/netpick.js' });

  const store = sandbox.PhosphorState;
  store.put({ lock: { state: 'unlocked' }, vault: Object.assign({ custody: 'secure-enclave', backedUp: true }, options.vault ?? {}), deposit: null });

  return {
    sandbox,
    pick: sandbox.PhosphorNetPick,
    host,
    store,
    calls,
    timers,
    stored,
    render: (opts: Any = {}) => sandbox.PhosphorNetPick.render(host, Object.assign({ context: 'basic' }, opts)),
  };
}

const root = (world: World): Any => find(world.host, '.netpick')[0];
const stage = (world: World): string => root(world).dataset.stage;

/* ---------- the source ---------- */

test('no string reaches the DOM as markup', () => {
  assert.equal(/\.innerHTML\s*=/.test(SOURCE), false, 'netpick.js assigns innerHTML');
  assert.equal(/insertAdjacentHTML|outerHTML|document\.write/.test(SOURCE), false);
});

/* ---------- step one to step two to step three ---------- */

test('the tiles are the five networks, and a tile leads to the tokens it credits', async () => {
  const world = build({ ack: true });
  const view = world.render();
  assert.equal(stage(world), 'network');
  assert.ok(textOf(root(world)).includes('Pick the network you are sending on.'));
  const tiles = find(world.host, '.net-tile');
  assert.deepEqual(tiles.map((t: Any) => t.dataset.network), ['eth', 'base', 'arb', 'sol', 'near']);
  assert.deepEqual(find(world.host, '.net-tile-name').map((n: Any) => n.textContent), ['Ethereum', 'Base', 'Arbitrum', 'Solana', 'NEAR']);
  assert.deepEqual(tiles.map((t: Any) => t.style['--net']), ['#627EEA', '#0052FF', '#12AAFF', '#9945FF', '#00EC97'], 'a tile does not carry its real network colour');
  assert.equal(tiles[3].style['--net-accent'], '#14F195');
  // The report is read behind the tiles: the network the bridge refused is greyed once it lands.
  await flush();
  assert.equal(tiles[2].dataset.unavailable, 'true');
  assert.equal(tiles[2].getAttribute('aria-disabled'), 'true');
  assert.equal(tiles[0].dataset.unavailable, undefined);

  tiles[1].click();
  await flush();
  assert.equal(stage(world), 'tokens');
  assert.equal(view.network(), 'base');
  assert.ok(textOf(root(world)).includes('Tokens credited on Base'));
  assert.deepEqual(find(world.host, '.token-row').map((r: Any) => r.dataset.symbol), ['ETH', 'USDC']);
  assert.equal(world.calls.filter((c) => c.route === '/api/intents-receive').length, 1, 'the report was read twice');

  buttonNamed(world.host, 'Change network').click();
  assert.equal(stage(world), 'network');
  assert.equal(find(world.host, '.net-tile')[1].getAttribute('aria-current'), 'true', 'the tile picked before is not marked');
});

test('the token list is sorted the way a wallet sorts: the chain coin, USDC, USDT, then by name', async () => {
  const world = build({ ack: true });
  world.render({ stage: 'tokens', network: 'eth' });
  await flush();
  assert.deepEqual(find(world.host, '.token-row').map((r: Any) => r.dataset.symbol), ['ETH', 'USDC', 'USDT', 'DAI', 'PYUSD', 'WBTC']);
  assert.deepEqual(world.pick.sortTokens([{ symbol: 'b' }, { symbol: 'USDT' }, { symbol: 'a' }, { symbol: 'SOL' }, { symbol: 'USDC' }], 'SOL').map((t: Any) => t.symbol), ['SOL', 'USDC', 'USDT', 'a', 'b']);
});

test('every minimum is in the token\'s own unit, in mono at the right, and the base units never reach the screen', async () => {
  const world = build({ ack: true });
  world.render({ stage: 'tokens', network: 'eth' });
  await flush();
  const mins = find(world.host, '.token-min');
  assert.deepEqual(mins.map((n: Any) => n.textContent), ['min 0.0000001 ETH', 'min 0.001 USDC', 'min 0.001 USDT', 'min 0.001 DAI', 'min 0.001 PYUSD', 'min 0.0001 WBTC']);
  assert.ok(mins.every((n: Any) => String(n.className).split(' ').includes('mono')), 'a minimum is not in mono');
  const words = textOf(root(world)).join(' ');
  assert.equal(/\b1000\b|100000000000|1000000000000000/.test(words), false, 'a raw base-unit figure is on screen: ' + words);
});

test('the search narrows by prefix first, then by what contains the letters, and says when nothing does', async () => {
  const world = build({ ack: true });
  world.render({ stage: 'tokens', network: 'eth' });
  await flush();
  const input = find(world.host, '.netpick-search-input')[0];
  assert.equal(input.placeholder, 'Search tokens');
  input.value = 'us';
  input.dispatch('input');
  assert.deepEqual(find(world.host, '.token-row').map((r: Any) => r.dataset.symbol), ['USDC', 'USDT', 'PYUSD'], 'prefix matches do not come before substring matches');
  input.value = 'd';
  input.dispatch('input');
  assert.deepEqual(find(world.host, '.token-row').map((r: Any) => r.dataset.symbol), ['DAI', 'USDC', 'USDT', 'PYUSD']);
  input.value = 'zzz';
  input.dispatch('input');
  assert.equal(find(world.host, '.token-row').length, 0);
  const empty = find(world.host, '.netpick-empty')[0];
  assert.equal(empty.hidden, false);
  assert.equal(empty.textContent, 'No token called zzz on Ethereum.');
  assert.equal(find(world.host, '.netpick-list')[0].hidden, true);
  input.value = '';
  input.dispatch('input');
  assert.equal(find(world.host, '.token-row').length, 6);
  assert.equal(empty.hidden, true);
});

/* ---------- the acknowledgement ---------- */

test('the acknowledgement gates the address once per install: ticked, remembered, then one small button', async () => {
  const world = build();
  const view = world.render({ stage: 'address', network: 'eth' });
  await flush();
  assert.equal(stage(world), 'tokens', 'with no acknowledgement the address step opened anyway');
  const ack = find(world.host, '.ack-text')[0];
  assert.equal(ack.textContent, 'I understand only the tokens above are credited here. Anything else sent to this address is lost.');
  const go = buttonNamed(world.host, 'Show the address');
  assert.equal(go.disabled, true);
  assert.ok(String(go.className).includes('btn-primary'), 'the first-time button is not the primary one');
  const box = find(world.host, '.ack-input')[0];
  assert.equal(box.type, 'checkbox');
  go.click();
  assert.equal(stage(world), 'tokens', 'a click on the disabled button moved on');
  box.checked = true;
  box.dispatch('change');
  assert.equal(go.disabled, false);
  assert.equal(find(world.host, '.ack-row')[0].dataset.checked, 'true');
  go.click();
  await flush();
  assert.equal(stage(world), 'address');
  assert.equal(world.stored['phosphor.depositAck'], '1', 'the acknowledgement was not remembered');
  assert.equal(world.pick.ackRemembered(), true);

  // Remembered: the list ends in a small ghost button and no box.
  view.go('tokens', 'sol');
  await flush();
  assert.equal(find(world.host, '.ack-input').length, 0);
  const again = buttonNamed(world.host, 'Show the address');
  assert.equal(again.disabled, false);
  assert.ok(String(again.className).includes('btn-sm'), 'the remembered button is not the small one');
  assert.equal(find(world.host, '.netpick-ack')[0].dataset.remembered, 'true');
});

/* ---------- step three ---------- */

test('the address step draws one address after its checks, starts the watch, and offers no token or network choice', async () => {
  const world = build({ ack: true });
  world.render({ stage: 'address', network: 'base' });
  await flush();
  assert.equal(stage(world), 'address');
  const body = find(world.host, '.deposit-body')[0];
  assert.equal(body.dataset.state, 'shown');
  assert.equal(find(body, 'canvas').length, 1, 'no QR');
  assert.equal(find(body, '.sr-only')[0].textContent, EVM);
  assert.equal(find(body, '.addr-prefix')[0].textContent, '0x');
  const ends = find(body, '.addr-end').map((n: Any) => n.textContent);
  assert.deepEqual(ends, ['7d4e', '0e1d']);
  assert.equal('0x7d4e' + find(body, '.addr-mid').map((n: Any) => n.textContent).join('') + '0e1d', EVM);
  const text = textOf(root(world));
  assert.ok(text.includes('Send on Base only.'));
  assert.ok(text.some((t) => t.startsWith('Ethereum, Base and Arbitrum use this same address.') && t.endsWith('choose Base on the sending side.')));
  assert.ok(find(body, '.deposit-min')[0].textContent.startsWith('Minimum 0.001 USDC.'), 'the minimum line does not carry the human number');
  assert.equal(find(world.host, 'button.chip').length, 0, 'chips on the address step');
  assert.equal(find(world.host, '.token-row').length, 0, 'the token list is on the address step');
  assert.ok(buttonNamed(world.host, 'Change network'), 'no way back');
  // The watch starts once the address is on screen, for the default token.
  assert.deepEqual(world.calls.find((c) => c.route === '/api/deposit/show'), { route: '/api/deposit/show', chain: 'base', symbol: 'USDC', address: EVM });
  await flush();
  world.store.put(Object.assign({}, world.store.get(), { deposit: { phase: 'watching', chain: 'base', symbol: 'USDC', address: EVM, startedAt: '2026-09-15T09:00:00.000Z' } }));
  const watch = find(world.host, '.deposit-watch')[0];
  assert.equal(watch.hidden, false);
  assert.equal(watch.dataset.phase, 'watching');
  assert.ok(find(watch, '.deposit-watch-text')[0].textContent.startsWith('Watching for your deposit, '));
  // The watch is started through the deposit card when it is loaded, so the card can absorb the echo.
  const viaCard = build({ ack: true, withDeposit: true });
  viaCard.render({ stage: 'address', network: 'sol' });
  await flush();
  assert.deepEqual(viaCard.calls.find((c) => c.route === 'deposit.startWatch'), { route: 'deposit.startWatch', chain: 'sol', symbol: 'USDC', address: SOL });
  assert.equal(viaCard.calls.some((c) => c.route === '/api/deposit/show'), false);
});

test('a network that is not EVM says so in its own words, and NEAR and Solana get their own address', async () => {
  const world = build({ ack: true });
  world.render({ stage: 'address', network: 'sol' });
  await flush();
  const text = textOf(root(world));
  assert.ok(text.includes('Send on Solana only.'));
  assert.ok(text.some((t) => t.startsWith('Choose Solana (SPL) on the sending side.')));
  assert.equal(text.some((t) => t.includes('Ethereum, Base and Arbitrum')), false);
  assert.equal(find(world.host, '.sr-only')[0].textContent, SOL);
  // Base58, forty-four characters: eleven even groups, no prefix, no orphan.
  const groups = find(world.host, '.addr-end, .addr-mid').map((n: Any) => n.textContent);
  assert.equal(find(world.host, '.addr-prefix').length, 0);
  assert.equal(groups.length, 11);
  assert.ok(groups.every((g: string) => g.length === 4));
  assert.equal(groups.join(''), SOL);

  const near = build({ ack: true });
  near.render({ stage: 'address', network: 'near' });
  await flush();
  assert.deepEqual(find(near.host, '.addr-whole').map((n: Any) => n.textContent), ['abc.near'], 'a NEAR account name was split');
  assert.equal(find(near.host, '.addr-end, .addr-mid').length, 0);
});

test('the groups are even for each kind of address: 0x then tens of four, base58 with the remainder last, a NEAR name whole', () => {
  const world = build();
  // Arrays cross the vm boundary with the sandbox's prototype, so they are copied before the strict compare.
  const chunks = (address: string, kind?: string): string[] => Array.from(world.pick.chunks(address, kind) as string[]);
  assert.deepEqual(chunks(EVM, 'evm'), ['0x', '7d4e', '1f0a', '2c9b', '8e6d', '3f5a', '1c7b', '9e0d', '2f4a', '6c8b', '0e1d']);
  assert.deepEqual(chunks(EVM), chunks(EVM, 'evm'), 'the kind is not read off the address when the caller did not say');
  assert.deepEqual(chunks('9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFi', 'sol').slice(-2), ['9Pus', 'VFi'], 'the short remainder is not the last group');
  assert.deepEqual(chunks(SOL, 'sol').map((g: string) => g.length), [4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4]);
  assert.deepEqual(chunks('alice.near', 'near'), ['alice.near']);
  const implicit = '7f2a9c4e1b8d3f6a0c5e2b9d4f7a1c8e3b6d9f2a5c8e1b4d7f0a3c6e9b2d5f8a';
  assert.deepEqual(chunks(implicit), [implicit], 'a 64 hex NEAR account was split');
  assert.deepEqual(chunks('alice.near'), ['alice.near']);
  assert.equal(world.pick.kindOf('base'), 'evm');
  assert.equal(world.pick.kindOf('sol'), 'sol');
  assert.equal(world.pick.kindOf('near'), 'near');
});

test('Copy says Copied for a moment once the clipboard reads back, and the status line keeps the last four', async () => {
  const world = build({ ack: true });
  world.render({ stage: 'address', network: 'eth' });
  await flush();
  const copy = buttonNamed(world.host, 'Copy');
  copy.click();
  await flush();
  await flush();
  assert.equal(world.calls.find((c) => c.route === 'clipboard')?.text, EVM);
  assert.equal(copy.textContent, 'Copied');
  assert.equal(copy.dataset.copied, 'true');
  assert.equal(find(world.host, '.deposit-copied')[0].textContent, 'Copied, ends in ...0e1d');
  const back = world.timers[world.timers.length - 1];
  back?.();
  assert.equal(copy.textContent, 'Copy');
  assert.equal(copy.dataset.copied, undefined);
});

test('an unverified wallet gets one button and no address; Touch ID then redraws', async () => {
  let verified = false;
  const world = build({ ack: true, report: report({ verified: false }) });
  world.sandbox.PhosphorApi.intentsReceive = () => Promise.resolve({ data: report({ verified }) });
  world.render({ stage: 'address', network: 'eth' });
  await flush();
  const body = find(world.host, '.deposit-body')[0];
  assert.equal(body.dataset.state, 'unverified');
  assert.equal(find(body, 'canvas').length, 0);
  const buttons = find(body, 'button');
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].textContent, 'Touch ID to show the address');
  verified = true;
  buttons[0].click();
  await flush();
  await flush();
  assert.equal(world.calls.find((c) => c.route === '/api/vault/unlock')?.purpose, 'address');
  assert.equal(body.dataset.state, 'shown');
  assert.equal(find(body, 'canvas').length, 1);
});

test('a network the bridge refused, an edited wallet file, and a token it does not credit each draw nothing and say why', async () => {
  const refused = build({ ack: true });
  refused.render({ stage: 'tokens', network: 'arb' });
  await flush();
  assert.equal(find(refused.host, '.token-row').length, 0);
  assert.ok(textOf(root(refused)).join(' ').includes('No deposit address on Arbitrum right now: the bridge refused eth:42161: down for maintenance'));
  assert.equal(buttonNamed(refused.host, 'Show the address'), undefined, 'an address button on a network with no address');

  const tampered = build({ ack: true, report: report({ tampered: true }) });
  tampered.render({ stage: 'tokens', network: 'eth' });
  await flush();
  assert.ok(textOf(root(tampered)).join(' ').includes('The wallet file on this Mac has been edited'));

  const wrong = build({ ack: true });
  wrong.render({ stage: 'address', network: 'sol', symbol: 'DOGE' });
  await flush();
  const body = find(wrong.host, '.deposit-body')[0];
  assert.equal(body.dataset.state, 'refused');
  assert.ok(textOf(body).join(' ').includes('DOGE is not credited on Solana. Sending it there loses it.'));
  assert.equal(wrong.calls.some((c) => c.route === '/api/deposit/show'), false, 'a watch started for a token that is not credited');
});

/* ---------- the Vault card and the developer switch ---------- */

test('in the Vault card the address is handed off, the way back is not offered, and the contract sits behind the developer switch', async () => {
  const world = build({ ack: true });
  const handed: Any[] = [];
  world.render({ context: 'vault', stage: 'tokens', network: 'eth', onAddress: (network: string, symbol: string, row: Any) => { handed.push({ network, symbol, address: row.address }); } });
  await flush();
  assert.equal(root(world).dataset.context, 'vault');
  assert.equal(buttonNamed(world.host, 'Change network'), undefined, 'a Change network link under a network menu');
  const contracts = find(world.host, '.token-contract');
  assert.equal(contracts.length, 5, 'a contract row per token that has one');
  assert.ok(contracts.every((c: Any) => c.hasAttribute('data-dev-only')), 'a contract is on screen without the switch');
  assert.equal(contracts[0].textContent, '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
  const dev = find(world.host, '.netpick-dev')[0];
  assert.ok(dev.hasAttribute('data-dev-only'));
  assert.equal(dev.textContent, 'Bridge network id: eth:1');
  buttonNamed(world.host, 'Show the address').click();
  assert.deepEqual(handed, [{ network: 'eth', symbol: 'USDC', address: EVM }]);
  assert.equal(stage(world), 'tokens', 'the Vault card drew the address itself');
});

/* ---------- keyboard and teardown ---------- */

test('the arrow keys walk the tiles and destroy takes the component off the page', () => {
  const world = build({ ack: true });
  const view = world.render();
  const tiles = find(world.host, '.net-tile');
  assert.deepEqual(tiles.map((t: Any) => t.tabIndex), [0, -1, -1, -1, -1]);
  tiles[0].dispatch('keydown', { key: 'ArrowRight' });
  assert.equal(focusedNow, tiles[1]);
  assert.deepEqual(tiles.map((t: Any) => t.tabIndex), [-1, 0, -1, -1, -1]);
  tiles[1].dispatch('keydown', { key: 'End' });
  assert.equal(focusedNow, tiles[4]);
  tiles[4].dispatch('keydown', { key: 'ArrowRight' });
  assert.equal(focusedNow, tiles[4], 'the focus fell off the end');
  tiles[4].dispatch('keydown', { key: 'Home' });
  assert.equal(focusedNow, tiles[0]);
  view.destroy();
  assert.equal(find(world.host, '.netpick').length, 0);
  world.store.put(Object.assign({}, world.store.get(), { deposit: { phase: 'watching', chain: 'eth', symbol: 'USDC', startedAt: 'x' } }));
});
