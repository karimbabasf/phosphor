// The transcript's renderer, and the one property that makes it safe to point at a language
// model: nothing it is handed reaches the DOM as markup. Every node is built with createElement
// and every string lands through textContent, so a reply that contains <script>, an onclick or a
// link is a reply that PRINTS those characters.
//
// The second property is that it draws no control. A table is a table, a heading is a label no
// larger than the body, a link is its text. Nothing here can be clicked to decide anything.
//
// Run against the real ui/core/markdown.js over a stand-in DOM that records what was built.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const SOURCE = readFileSync(new URL('../../ui/core/markdown.js', import.meta.url), 'utf8');

type Node = {
  tag: string;
  className: string;
  children: Node[];
  parentNode: Node | null;
  attrs: Record<string, string>;
  textContent: string;
  firstChild: Node | null;
  appendChild(child: Node): Node;
  removeChild(child: Node): Node;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  removeAttribute(name: string): void;
};

function make(tag: string): Node {
  const node = {
    tag,
    className: '',
    children: [] as Node[],
    parentNode: null as Node | null,
    attrs: {} as Record<string, string>,
  } as unknown as Node;
  let text = '';
  Object.defineProperty(node, 'textContent', {
    get: () => (node.children.length === 0 ? text : node.children.map((c) => c.textContent).join('')),
    set: (value: string) => {
      node.children.length = 0;
      text = String(value);
    },
  });
  Object.defineProperty(node, 'firstChild', { get: () => node.children[0] ?? null });
  node.appendChild = (child) => {
    if (child.parentNode) child.parentNode.removeChild(child);
    node.children.push(child);
    child.parentNode = node;
    return child;
  };
  node.removeChild = (child) => {
    const at = node.children.indexOf(child);
    if (at !== -1) node.children.splice(at, 1);
    child.parentNode = null;
    return child;
  };
  node.setAttribute = (name, value) => {
    node.attrs[name] = String(value);
  };
  node.getAttribute = (name) => (name in node.attrs ? node.attrs[name] : null);
  node.hasAttribute = (name) => name in node.attrs;
  node.removeAttribute = (name) => {
    delete node.attrs[name];
  };
  return node;
}

function load() {
  const built: string[] = [];
  const sandbox: Record<string, unknown> = {
    console,
    document: {
      createElement: (tag: string) => {
        built.push(tag);
        return make(tag);
      },
    },
  };
  sandbox.window = sandbox;
  createContext(sandbox);
  runInContext(SOURCE, sandbox, { filename: 'ui/core/markdown.js' });
  const md = (sandbox as { PhosphorMarkdown: { renderInto: (host: Node, text: string) => void } }).PhosphorMarkdown;
  return {
    built,
    render(text: string): Node {
      const host = make('div');
      md.renderInto(host, text);
      return host;
    },
  };
}

function all(node: Node, tag: string, out: Node[] = []): Node[] {
  if (node.tag === tag) out.push(node);
  for (const child of node.children) all(child, tag, out);
  return out;
}

function withClass(node: Node, name: string, out: Node[] = []): Node[] {
  if (node.className.split(' ').includes(name)) out.push(node);
  for (const child of node.children) withClass(child, name, out);
  return out;
}

test('markup in a reply is printed, never parsed', () => {
  const md = load();
  const host = md.render('hello <script>alert(1)</script> <b onclick="x">bold</b>');
  assert.equal(all(host, 'script').length, 0);
  assert.equal(all(host, 'b').length, 0);
  assert.ok(host.textContent.includes('<script>alert(1)</script>'), host.textContent);
  assert.ok(host.textContent.includes('<b onclick="x">bold</b>'));
});

test('the renderer never assigns innerHTML and builds no control', () => {
  assert.equal(/\.innerHTML\s*=/.test(SOURCE), false);
  assert.equal(/insertAdjacentHTML|outerHTML|document\.write|createContextualFragment/.test(SOURCE), false);
  const md = load();
  md.render('# Title\n\n- one\n- [two](https://x.test)\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```\ncode\n```\n**bold** `x` *em*');
  const tags = new Set(md.built);
  const allowed = new Set(['div', 'p', 'ul', 'ol', 'li', 'strong', 'em', 'code', 'pre', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'span']);
  for (const tag of tags) assert.ok(allowed.has(tag), `the renderer built a <${tag}>`);
  assert.equal(tags.has('a'), false, 'a link is text, not a control');
  assert.equal(tags.has('button'), false);
  assert.equal(tags.has('input'), false);
});

test('a table is a real table built element by element', () => {
  const md = load();
  const host = md.render('| Level | Price | Change |\n|---|---:|---:|\n| Support | 63,200 | -1.4% |\n| Target | 66,000 | +2.9% |');
  const tables = all(host, 'table');
  assert.equal(tables.length, 1);
  assert.equal(all(host, 'thead').length, 1);
  assert.equal(all(host, 'th').map((n) => n.textContent).join('|'), 'Level|Price|Change');
  const rows = all(all(host, 'tbody')[0], 'tr');
  assert.equal(rows.length, 2);
  assert.equal(all(rows[0], 'td').map((n) => n.textContent).join('|'), 'Support|63,200|-1.4%');
  // Numbers sit in mono, right aligned, so a column of prices lines up on its decimal.
  const numeric = all(rows[0], 'td')[1];
  assert.ok(numeric.className.split(' ').includes('num'), numeric.className);
  // A signed delta is toned: down for a loss, up for a gain, and the sign stays in the text.
  assert.equal(withClass(rows[0], 'down').length, 1);
  assert.equal(withClass(rows[1], 'up').length, 1);
  assert.ok(withClass(host, 'chat-table').length === 1, 'the table sits in a wrapper that can scroll sideways');
});

test('a heading is a label, never larger than the body', () => {
  const md = load();
  const host = md.render('## What I see\n\nThe trend is up.');
  const heads = withClass(host, 'chat-h');
  assert.equal(heads.length, 1);
  assert.equal(heads[0].textContent, 'What I see');
  assert.equal(all(host, 'h1').length + all(host, 'h2').length + all(host, 'h3').length, 0, 'a heading element carries browser sizing');
});

test('a link prints as its text and the address is not a control', () => {
  const md = load();
  const host = md.render('see [the docs](https://example.test/x) and https://bare.test/y');
  assert.equal(all(host, 'a').length, 0);
  assert.ok(host.textContent.includes('see the docs and https://bare.test/y'), host.textContent);
  assert.equal(host.textContent.includes('example.test'), false, 'the address of a link is not printed as a click target');
});

test('bold, code, fenced code and lists render as their elements', () => {
  const md = load();
  const host = md.render('**Stop** at `63,200`\n\n- first\n- second\n\n1. one\n2. two\n\n```\nema 50\n```');
  assert.equal(all(host, 'strong')[0].textContent, 'Stop');
  assert.equal(all(host, 'code')[0].textContent, '63,200');
  assert.equal(all(host, 'ul').length, 1);
  assert.equal(all(host, 'ol').length, 1);
  assert.equal(all(host, 'li').map((n) => n.textContent).join('|'), 'first|second|one|two');
  assert.equal(all(host, 'pre').length, 1);
  assert.equal(all(host, 'pre')[0].textContent, 'ema 50');
});

test('a signed percentage or dollar delta in prose is toned and a date is not', () => {
  const md = load();
  const host = md.render('Up +3.2% since 2026-09-11, funding -$0.40, ETH-USD unchanged.');
  const ups = withClass(host, 'up').map((n) => n.textContent);
  const downs = withClass(host, 'down').map((n) => n.textContent);
  assert.deepEqual(ups, ['+3.2%']);
  assert.deepEqual(downs, ['-$0.40']);
  assert.ok(host.textContent.includes('2026-09-11'));
});

test('an empty or non-string reply renders nothing and throws nothing', () => {
  const md = load();
  assert.equal(md.render('').children.length, 0);
  assert.equal(md.render((undefined as unknown) as string).children.length, 0);
});
