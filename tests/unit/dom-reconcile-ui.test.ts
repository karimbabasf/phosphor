// The reconciler owns the host it is given.
//
// It used to own only the nodes it had named itself, tracked on a __keyed map, and that is
// the whole of this bug: an empty state appended by hand was invisible to it. The first row
// of a populated pass goes in at parent.firstChild, so the rows landed ABOVE the empty block
// and the block never left. On screen that is six fills listed with "Nothing yet. Fills and
// cancels land here as they happen." underneath them, which is the window telling a person
// two opposite things about their money at the same time.
//
// The second half is dom.clear(), which took the nodes out of the document and left the map
// naming them. A pass after a clear reused elements that were no longer anywhere, and
// skipped building the ones it believed were already on screen.
//
// The invariant these tests hold: a host is showing its rows or its empty state, never both.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const SOURCE = readFileSync(new URL('../../ui/core/dom.js', import.meta.url), 'utf8');

type Any = Record<string, any>;

// A node with the four things the reconciler moves things by: firstChild, nextSibling,
// insertBefore and removeChild. Enough of an element to be reconciled into, and no more.
function makeEl(tag: string): Any {
  const el: Any = {
    tagName: tag,
    className: '',
    textContent: '',
    dataset: Object.create(null) as Any,
    children: [] as Any[],
    parentNode: null as unknown as Any,
    get firstChild() {
      return el.children[0] ?? null;
    },
    get nextSibling() {
      const parent = el.parentNode;
      if (!parent) return null;
      return parent.children[parent.children.indexOf(el) + 1] ?? null;
    },
    appendChild(child: Any) {
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = el;
      el.children.push(child);
      return child;
    },
    insertBefore(child: Any, ref: Any | null) {
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = el;
      const at = ref ? el.children.indexOf(ref) : -1;
      if (at < 0) el.children.push(child);
      else el.children.splice(at, 0, child);
      return child;
    },
    removeChild(child: Any) {
      const at = el.children.indexOf(child);
      if (at >= 0) el.children.splice(at, 1);
      child.parentNode = null;
      return child;
    },
  };
  return el;
}

function load(): Any {
  const window: Any = { PhosphorMotion: { reduced: () => true } };
  const context = createContext({
    window,
    document: { createElement: (tag: string) => makeEl(tag) },
  });
  runInContext(SOURCE, context);
  return window.PhosphorDom;
}

// The row shapes every screen uses: a keyed row, and an empty block that is not keyed
// because no screen has ever built one through the reconciler.
function rows(dom: Any, host: Any, items: Array<{ id: string; text: string }>): void {
  dom.reconcile(
    host,
    items,
    (item: Any) => item.id,
    () => makeEl('div'),
    (node: Any, item: Any) => {
      node.textContent = item.text;
    },
  );
}

function emptyBlock(): Any {
  const block = makeEl('div');
  block.className = 'empty';
  block.textContent = 'Nothing yet';
  return block;
}

test('rows replace a hand appended empty state rather than stacking on top of it', () => {
  const dom = load();
  const host = makeEl('div');

  host.appendChild(emptyBlock());
  assert.equal(host.children.length, 1);

  rows(dom, host, [{ id: 'a', text: 'first' }, { id: 'b', text: 'second' }]);

  assert.equal(host.children.length, 2, 'the empty block must not survive the rows');
  assert.deepEqual(host.children.map((n: Any) => n.textContent), ['first', 'second']);
  assert.equal(host.children.filter((n: Any) => n.className === 'empty').length, 0);
});

test('an empty pass takes the whole host, so a stale row cannot outlive its data', () => {
  const dom = load();
  const host = makeEl('div');

  rows(dom, host, [{ id: 'a', text: 'first' }]);
  assert.equal(host.children.length, 1);

  // Every screen draws its empty state after reconciling with nothing, so the host has to be
  // empty by the time it appends one.
  rows(dom, host, []);
  assert.equal(host.children.length, 0);

  host.appendChild(emptyBlock());
  assert.equal(host.children.length, 1);
  assert.equal(host.children[0].className, 'empty');
});

test('a loading skeleton leaves the same way the empty state does', () => {
  // Pro appends skeleton bars straight to the money list while the first frame is in
  // flight, and only deleted a dataset flag when the wallet arrived. The bars stayed
  // under the real rows.
  const dom = load();
  const host = makeEl('div');
  for (let i = 0; i < 3; i += 1) {
    const bar = makeEl('div');
    bar.className = 'skel';
    host.appendChild(bar);
  }

  rows(dom, host, [{ id: 'a', text: 'ETH' }]);

  assert.equal(host.children.length, 1);
  assert.equal(host.children[0].textContent, 'ETH');
});

test('clear takes the reconciler map with the nodes', () => {
  const dom = load();
  const host = makeEl('div');

  rows(dom, host, [{ id: 'a', text: 'first' }]);
  const before = host.children[0];

  dom.clear(host);
  assert.equal(host.children.length, 0);

  // Same key, so the old map would have handed back the detached node and put nothing on
  // screen. It has to build a new one.
  rows(dom, host, [{ id: 'a', text: 'again' }]);
  assert.equal(host.children.length, 1);
  assert.notEqual(host.children[0], before, 'a cleared node must not come back');
  assert.equal(host.children[0].textContent, 'again');
});

test('a row that survives the data keeps the element it had', () => {
  // The reason the reconciler exists: the row somebody is hovering or has focused stays
  // where it is across a refresh.
  const dom = load();
  const host = makeEl('div');

  rows(dom, host, [{ id: 'a', text: 'first' }, { id: 'b', text: 'second' }]);
  const a = host.children[0];
  const b = host.children[1];

  rows(dom, host, [{ id: 'b', text: 'second' }, { id: 'c', text: 'third' }]);

  assert.equal(host.children.length, 2);
  assert.equal(host.children[0], b, 'b is the same element it was');
  assert.equal(host.children[1].textContent, 'third');
  assert.equal(a.parentNode, null, 'a left the data, so it leaves the document');
});

test('the order on screen is the order of the data', () => {
  const dom = load();
  const host = makeEl('div');

  rows(dom, host, [{ id: 'a', text: 'a' }, { id: 'b', text: 'b' }, { id: 'c', text: 'c' }]);
  rows(dom, host, [{ id: 'c', text: 'c' }, { id: 'a', text: 'a' }, { id: 'b', text: 'b' }]);

  assert.deepEqual(host.children.map((n: Any) => n.textContent), ['c', 'a', 'b']);
});
