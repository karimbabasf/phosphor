// The one question this app asks about a token: two things are called USDC here, which did you
// mean. Two tiles, a plain line each, and no assetId on the face of the card.
//
// Run: node --test tests/unit/asset-pick-ui.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const ASSETPICK = readFileSync(new URL('../../ui/screens/assetpick.js', import.meta.url), 'utf8');

type Node = {
  tag: string;
  className: string;
  textContent: string;
  type: string;
  attrs: Record<string, string>;
  children: Node[];
  listeners: Record<string, Array<() => void>>;
  appendChild(c: Node): Node;
  setAttribute(name: string, value: string): void;
  addEventListener(type: string, fn: () => void): void;
};

function node(tag: string): Node {
  let ownText = '';
  const n: Node = {
    tag,
    className: '',
    type: '',
    attrs: {},
    children: [],
    listeners: {},
    get textContent() {
      return n.children.length ? n.children.map((c) => c.textContent).join(' ') : ownText;
    },
    set textContent(value: string) {
      ownText = String(value);
      n.children.length = 0;
    },
    appendChild(c: Node) {
      n.children.push(c);
      return c;
    },
    setAttribute(name: string, value: string) {
      n.attrs[name] = value;
    },
    addEventListener(type: string, fn: () => void) {
      (n.listeners[type] ??= []).push(fn);
    },
  };
  return n;
}

function all(n: Node, className: string, out: Node[] = []): Node[] {
  if (n.className.split(' ').includes(className)) out.push(n);
  for (const c of n.children) all(c, className, out);
  return out;
}

function fire(n: Node, type: string): void {
  for (const fn of n.listeners[type] ?? []) fn();
}

type Build = (host: Node, candidates: unknown[], onPick: (id: string) => void) => void;

/* The card in a sandbox, over the same stub DOM helpers ui/core/dom.js gives it. */
function build(host: Node, candidates: unknown[], onPick: (id: string) => void): void {
  const sandbox: Record<string, unknown> = {
    window: {
      PhosphorDom: {
        el: (tag: string, className?: string, text?: string) => {
          const n = node(tag);
          if (className) n.className = className;
          if (text !== undefined) n.textContent = text;
          return n;
        },
        clear: (n: Node) => {
          n.children.length = 0;
        },
        setText: (n: Node, text: string) => {
          n.textContent = text;
        },
        setAttr: (n: Node, name: string, value: string) => n.setAttribute(name, value),
        on: (n: Node, type: string, fn: () => void) => n.addEventListener(type, fn),
        usd: (v: number) => `$${v.toFixed(2)}`,
      },
      PhosphorMarks: {
        logo: (symbol: string) => {
          const n = node('span');
          n.className = 'logo';
          n.attrs['data-token'] = String(symbol).toUpperCase();
          return n;
        },
      },
    },
    console,
  };
  createContext(sandbox);
  runInContext(ASSETPICK, sandbox, { filename: 'ui/screens/assetpick.js' });
  const win = sandbox.window as { PhosphorAssetPick: { build: Build } };
  win.PhosphorAssetPick.build(host, candidates, onPick);
}

const candidates = [
  { assetId: '1cs_v1:hypercore:hip1:0x6d1e', decimals: 8, symbol: 'USDC', contractAddress: '0x6d1e', priceUsd: 1 },
  { assetId: '1cs_v1:hypercore:erc20:0xb883', decimals: 6, symbol: 'USDC', contractAddress: '0xb883', priceUsd: 1 },
];

test('two candidates draw two tiles, each with a plain distinguishing line', () => {
  const host = node('div');
  build(host, candidates, () => {});
  const tiles = all(host, 'assetpick-tile');
  assert.equal(tiles.length, 2);
  assert.ok(tiles[0]!.textContent.indexOf('USDC') >= 0);
  const notes = all(host, 'assetpick-note').map((n) => n.textContent);
  assert.deepEqual(notes, ['the spot one', 'the token contract one']);
});

/* The whole point of the card. An assetId on its face is the string that scares a person off
   reading the card at all, and the card exists to be read. */
test('no assetId and no contract address is printed on the face of the card', () => {
  const host = node('div');
  build(host, candidates, () => {});
  const face = all(host, 'assetpick-tile').map((t) => t.textContent).join(' ');
  assert.equal(face.indexOf('1cs_v1'), -1);
  assert.equal(face.indexOf('0x6d1e'), -1);
});

test('clicking a tile answers with that assetId', () => {
  const host = node('div');
  let answered = '';
  build(host, candidates, (id: string) => {
    answered = id;
  });
  fire(all(host, 'assetpick-tile')[1]!, 'click');
  assert.equal(answered, '1cs_v1:hypercore:erc20:0xb883');
});

/* Nothing in the id tells two candidates apart on every chain, so the fallbacks are the facts
   that actually differ: the decimals, and failing that the tail of the id, which is four
   characters and not sixty. */
test('two tokens the venue gives no flavour word are told apart by what differs', () => {
  const host = node('div');
  build(
    host,
    [
      { assetId: 'x:aaaa1111', decimals: 6, symbol: 'WIF', contractAddress: '0xa', priceUsd: null },
      { assetId: 'x:bbbb2222', decimals: 9, symbol: 'WIF', contractAddress: '0xb', priceUsd: null },
    ],
    () => {},
  );
  assert.deepEqual(all(host, 'assetpick-note').map((n) => n.textContent), ['6 decimals', '9 decimals']);
});
