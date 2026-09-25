// The coin pictures in the window (2026-09-25): a coin with no hand-picked file in ui/logos drew a
// letter on a disc, VVV a "V". Now the order is the hand-picked file first, then the coin's picture
// from the local server's cache (src/ledger/pictures.ts), then the monogram. Every surface draws
// through PhosphorMarks.logo, so every one of them gets the picture, including a monogram it drew
// before the pictures were known, which becomes the picture in place.
//
// Run against the REAL ui/design/marks.js over a stand-in DOM, the way the other *-ui tests do.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

type Any = Record<string, any>;

const MARKS = readFileSync(new URL('../../ui/design/marks.js', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../../ui/design/components.css', import.meta.url), 'utf8');

function makeNode(tagName: string): Any {
  const attrs: Record<string, string> = {};
  const style: Any = {
    setProperty: (name: string, value: string) => { style[name] = value; },
  };
  const node: Any = {
    tagName,
    className: '',
    style,
    childNodes: [],
    parentNode: null,
    get children() { return node.childNodes; },
    get textContent(): string {
      if (node.childNodes.length === 0) return node.__text ?? '';
      return node.childNodes.map((c: Any) => c.textContent).join('');
    },
    set textContent(value: string) {
      for (const child of node.childNodes) child.parentNode = null;
      node.childNodes = [];
      node.__text = String(value);
    },
    appendChild(child: Any) {
      child.parentNode = node;
      node.childNodes.push(child);
      return child;
    },
    removeChild(child: Any) {
      node.childNodes.splice(node.childNodes.indexOf(child), 1);
      child.parentNode = null;
      return child;
    },
    setAttribute: (name: string, value: string) => { attrs[name] = String(value); },
    getAttribute: (name: string) => (name in attrs ? attrs[name] : null),
    hasAttribute: (name: string) => name in attrs,
    removeAttribute: (name: string) => { delete attrs[name]; },
  };
  return node;
}

function walk(node: Any, out: Any[] = []): Any[] {
  out.push(node);
  for (const child of node.childNodes) walk(child, out);
  return out;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

type Rig = {
  marks: Any;
  body: Any;
  asked: string[];
  answer: { data: Any; fails: boolean };
  clock: { now: number };
  frame(): void;
  draw(symbol: string): Any;
};

function boot(options: { net?: boolean; data?: Any } = {}): Rig {
  const body = makeNode('body');
  const asked: string[] = [];
  const answer = { data: options.data ?? { symbols: {}, settled: true }, fails: false };
  const clock = { now: Date.parse('2026-09-25T20:30:00Z') };
  const subscribers: Array<() => void> = [];
  class FakeDate extends Date {
    static now() { return clock.now; }
  }
  const document: Any = {
    createElement: (tag: string) => makeNode(tag),
    // The one selector marks.js asks for: every monogram that names a coin.
    querySelectorAll: (selector: string) => {
      assert.equal(selector, '.logo[data-fallback][data-token]');
      return walk(body).filter((n) => n.className === 'logo' && n.hasAttribute('data-fallback') && n.hasAttribute('data-token'));
    },
  };
  const window: Any = { document };
  if (options.net !== false) {
    window.PhosphorNet = {
      getJson: (path: string) => {
        asked.push(path);
        if (answer.fails) return Promise.reject(Object.assign(new Error('no'), { status: 502 }));
        return Promise.resolve({ data: answer.data, fresh: true });
      },
    };
    window.PhosphorState = { subscribe: (fn: () => void) => { subscribers.push(fn); } };
  }
  window.window = window;
  const ctx = createContext({ window, document, Date: FakeDate, console });
  runInContext(MARKS, ctx, { filename: 'ui/design/marks.js' });
  const marks = window.PhosphorMarks;
  return {
    marks,
    body,
    asked,
    answer,
    clock,
    frame: () => { for (const fn of subscribers) fn(); },
    draw: (symbol: string) => body.appendChild(marks.logo(symbol, 24)),
  };
}

function img(node: Any): Any {
  return node.childNodes.find((c: Any) => c.tagName === 'img') ?? null;
}

const PICTURES = { symbols: { VVV: 'venice-token', ETH: 'ethereum', TRUMP: 'official-trump' }, settled: true };

test('a hand-picked file wins, then the cached picture from the local server, then the monogram', async () => {
  const rig = boot({ data: PICTURES });
  rig.draw('VVV');
  await tick();
  const vvv = rig.draw('VVV');
  assert.equal(vvv.getAttribute('data-picture'), 'true');
  assert.equal(vvv.getAttribute('data-fallback'), null);
  assert.equal(img(vvv).src, '/api/coin-image?id=venice-token', 'the picture is not the local server\'s');
  // ETH has its own file, and the file is what it draws, whatever the pictures hold.
  const eth = rig.draw('eth');
  assert.equal(img(eth).src, './logos/eth.svg');
  assert.equal(eth.getAttribute('data-picture'), null);
  // A coin with neither is its monogram.
  const wif = rig.draw('$WIF');
  assert.equal(wif.getAttribute('data-fallback'), 'true');
  assert.equal(wif.textContent, 'W');
  assert.equal(img(wif), null);
  assert.deepEqual(rig.asked, ['/api/coin-images'], 'the pictures were asked for more than once, or per coin');
  // Drawn to the same three quarters of the box as every file and monogram, and round.
  assert.match(CSS, /\.logo\[data-picture\] > img \{[^}]*width: 75%;[^}]*height: 75%;[^}]*border-radius: var\(--radius-pill\);/);
});

test('a monogram drawn before the pictures were known becomes the picture in place, on every surface', async () => {
  const rig = boot({ data: PICTURES });
  const tile = rig.draw('VVV');
  const row = rig.draw('vvv');
  const trump = rig.draw('TRUMP');
  assert.equal(tile.getAttribute('data-fallback'), 'true', 'a picture before anything said there was one');
  await tick();
  for (const node of [tile, row]) {
    assert.equal(node.getAttribute('data-fallback'), null);
    assert.equal(img(node).src, '/api/coin-image?id=venice-token');
    assert.equal(node.textContent, '', 'the letter stayed beside the picture');
  }
  assert.equal(img(trump).src, '/api/coin-image?id=official-trump');
});

test('a picture that fails to load is the monogram again, and is not asked for again', async () => {
  const rig = boot({ data: { symbols: { VVV: 'venice-token' }, settled: false } });
  const vvv = rig.draw('VVV');
  await tick();
  img(vvv).onerror();
  assert.equal(vvv.getAttribute('data-fallback'), 'true');
  assert.equal(vvv.getAttribute('data-picture'), null);
  assert.equal(vvv.textContent, 'V');
  rig.clock.now += 10_000;
  rig.frame();
  await tick();
  assert.equal(rig.asked.length, 2);
  assert.equal(vvv.getAttribute('data-fallback'), 'true', 'a broken picture was put back');
  assert.equal(rig.draw('VVV').getAttribute('data-fallback'), 'true');
});

test('the pictures are read again soon while more are coming, rarely once settled, and never on a timer', async () => {
  const rig = boot({ data: { symbols: {}, settled: false } });
  const vvv = rig.draw('VVV');
  await tick();
  assert.equal(rig.asked.length, 1);
  // A state frame a second later asks nothing; one five seconds on asks again.
  rig.clock.now += 1_000;
  rig.frame();
  await tick();
  assert.equal(rig.asked.length, 1);
  rig.answer.data = { symbols: { VVV: 'venice-token' }, settled: true };
  rig.clock.now += 5_000;
  rig.frame();
  await tick();
  assert.equal(rig.asked.length, 2);
  assert.equal(img(vvv).src, '/api/coin-image?id=venice-token', 'the picture that landed was not put in place');
  // Settled: a minute on asks nothing, five minutes on asks again.
  rig.clock.now += 60_000;
  rig.frame();
  await tick();
  assert.equal(rig.asked.length, 2);
  rig.clock.now += 5 * 60_000;
  rig.frame();
  await tick();
  assert.equal(rig.asked.length, 3);
  // A failed read keeps what it had.
  rig.answer.fails = true;
  rig.clock.now += 5 * 60_000;
  rig.frame();
  await tick();
  assert.equal(img(rig.draw('VVV')).src, '/api/coin-image?id=venice-token');
  assert.doesNotMatch(MARKS, /setInterval|setTimeout/, 'the pictures are read on a clock of their own');
});

test('a hand-picked coin never asks for the pictures, and an id that is not a CoinGecko id is ignored', async () => {
  const rig = boot({ data: { symbols: { VVV: 'https://evil.example/x.png', PENGU: 'pudgy-penguins', BAD: '../keys' }, settled: true } });
  rig.draw('ETH');
  rig.draw('USDC');
  await tick();
  assert.deepEqual(rig.asked, [], 'a coin with its own file asked for the pictures');
  const vvv = rig.draw('VVV');
  const bad = rig.draw('BAD');
  const pengu = rig.draw('PENGU');
  await tick();
  assert.equal(vvv.getAttribute('data-fallback'), 'true', 'a URL was taken for a CoinGecko id');
  assert.equal(bad.getAttribute('data-fallback'), 'true');
  assert.equal(img(pengu).src, '/api/coin-image?id=pudgy-penguins');
});

test('with no server to ask, every logo is what it was: the file or the monogram', () => {
  const rig = boot({ net: false });
  assert.equal(img(rig.draw('ETH')).src, './logos/eth.svg');
  const vvv = rig.draw('VVV');
  assert.equal(vvv.getAttribute('data-fallback'), 'true');
  assert.equal(vvv.textContent, 'V');
});
