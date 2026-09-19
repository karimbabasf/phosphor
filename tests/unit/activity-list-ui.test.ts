// The Activity list (ui/screens/receipts.js): the window, the kind, the pages and the empty state.
//
// Pro's Activity card and Basic's Activity fold mount the same list. It opens on the last 24
// hours, offers 7 days and All, narrows by kind, reads a page at a time from GET /api/receipts
// with the server's cursor, and never leaves a blank card: a window with nothing in it is a
// sentence with the one click that widens it. A row click emits receipt:open and nothing else.
//
// Run against the REAL ui/screens/receipts.js and ui/core/dom.js over a stand-in DOM, with the
// network, the row renderer and the event bus stubbed at their seams.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

type Any = Record<string, any>;

const DOM = readFileSync(new URL('../../ui/core/dom.js', import.meta.url), 'utf8');
const LIST = readFileSync(new URL('../../ui/screens/receipts.js', import.meta.url), 'utf8');

function makeNode(tagName: string): Any {
  const attrs: Record<string, string> = {};
  const listeners: Record<string, Array<(e: Any) => void>> = {};
  const node: Any = {
    tagName,
    className: '',
    textContent: '',
    hidden: false,
    disabled: false,
    dataset: {},
    style: { setProperty() {}, removeProperty() {} },
    childNodes: [],
    parentNode: null,
    get children() {
      return node.childNodes;
    },
    get firstChild() {
      return node.childNodes[0] ?? null;
    },
    get nextSibling() {
      const siblings = node.parentNode?.childNodes ?? [];
      return siblings[siblings.indexOf(node) + 1] ?? null;
    },
    appendChild(child: Any) {
      return node.insertBefore(child, null);
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
    setAttribute: (name: string, value: string) => {
      attrs[name] = String(value);
    },
    getAttribute: (name: string) => attrs[name] ?? null,
    hasAttribute: (name: string) => name in attrs,
    removeAttribute: (name: string) => {
      delete attrs[name];
    },
    addEventListener: (type: string, fn: (e: Any) => void) => {
      (listeners[type] ??= []).push(fn);
    },
    removeEventListener: () => {},
    click: () => {
      for (const fn of listeners.click ?? []) fn({ preventDefault() {} });
    },
  };
  return node;
}

function withClass(node: Any, name: string, out: Any[] = []): Any[] {
  if (String(node.className).split(' ').includes(name)) out.push(node);
  for (const child of node.childNodes) withClass(child, name, out);
  return out;
}

const HOUR = 3_600_000;

function receipt(id: string, hoursAgo: number, kind = 'swap'): Any {
  return { id, kind, at: new Date(Date.now() - hoursAgo * HOUR).toISOString(), feesUsd: 0.01, headline: `did ${id}` };
}

type Rig = {
  host: Any;
  head: Any;
  list: Any;
  mod: Any;
  calls: string[];
  emitted: Any[];
  respond: (fn: (params: URLSearchParams) => Any) => void;
  fire: (type: string) => void;
  settle: () => Promise<void>;
};

function boot(options: Any = {}): Rig {
  const calls: string[] = [];
  const emitted: Any[] = [];
  const handlers: Record<string, Array<(p: Any) => void>> = {};
  let answer: (params: URLSearchParams) => Any = () => ({ receipts: [], total: 0, hasMore: false, feesUsd: 0 });
  const document: Any = { createElement: (tag: string) => makeNode(tag) };
  const window: Any = {
    document,
    PhosphorNet: {
      getJson: (path: string) => {
        calls.push(path);
        const params = new URL('http://x' + path).searchParams;
        const data = answer(params);
        return data instanceof Error ? Promise.reject(data) : Promise.resolve({ data, fresh: true });
      },
    },
    PhosphorReceipt: {
      row: () => {
        const n = makeNode('button');
        n.className = 'tx receipt-row';
        return n;
      },
      updateRow: (node: Any, r: Any) => {
        node.textContent = r.headline;
      },
    },
    PhosphorEvents: {
      on: (type: string, fn: (p: Any) => void) => {
        (handlers[type] ??= []).push(fn);
      },
      emit: (type: string, payload: Any) => {
        emitted.push({ type, payload });
      },
    },
  };
  window.window = window;
  const ctx = createContext({ window, document, console, Promise, Date, Math, isFinite });
  runInContext(DOM, ctx);
  runInContext(LIST, ctx);
  const host = makeNode('div');
  const head = makeNode('div');
  const list = window.PhosphorReceipts.list(host, { filtersHost: head, ...options });
  return {
    host,
    head,
    list,
    mod: window.PhosphorReceipts,
    calls,
    emitted,
    respond: (fn) => {
      answer = fn;
    },
    fire: (type) => {
      for (const fn of handlers[type] ?? []) fn({});
    },
    settle: async () => {
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
    },
  };
}

function pressed(head: Any): string[] {
  return withClass(head, 'chip-filter').filter((c) => c.getAttribute('aria-pressed') === 'true').map((c) => c.dataset.id);
}

function rows(host: Any): string[] {
  return withClass(host, 'receipt-row').map((r) => r.dataset.key);
}

test('the list opens on the last 24 hours and every kind, and asks the server for exactly that', async () => {
  const rig = boot();
  rig.respond(() => ({ receipts: [receipt('a', 2), receipt('b', 5)], total: 2, hasMore: false, feesUsd: 0.02 }));
  await rig.list.load();
  await rig.settle();
  assert.equal(rig.calls.length, 1);
  const params = new URL('http://x' + rig.calls[0]).searchParams;
  assert.equal(params.get('limit'), '25');
  assert.equal(params.get('kind'), null, 'every kind is no kind parameter');
  const since = Number(params.get('since'));
  assert.ok(Math.abs(Date.now() - 24 * HOUR - since) < 5_000, 'since is 24 hours ago');
  assert.deepEqual(pressed(rig.head), ['24h', 'all']);
  assert.deepEqual(rows(rig.host), ['a', 'b']);
  assert.equal(withClass(rig.host, 'activity-more').length, 0, 'nothing more to show');
});

test('a window with nothing in it is a sentence with the one click that widens it', async () => {
  const rig = boot();
  rig.respond((params) => {
    const since = Number(params.get('since'));
    const wide = Date.now() - since > 2 * 24 * HOUR;
    return wide
      ? { receipts: [receipt('old', 49)], total: 1, hasMore: false, feesUsd: 0.01 }
      : { receipts: [], total: 0, hasMore: false, feesUsd: 0 };
  });
  await rig.list.load();
  await rig.settle();
  assert.deepEqual(rows(rig.host), []);
  assert.equal(withClass(rig.host, 'activity-empty-line')[0].textContent, 'Nothing in the last 24 hours.');
  const link = withClass(rig.host, 'activity-link')[0];
  assert.equal(link.textContent, 'Show 7 days?');
  link.click();
  await rig.settle();
  assert.deepEqual(pressed(rig.head), ['7d', 'all']);
  assert.deepEqual(rows(rig.host), ['old']);
  assert.equal(withClass(rig.host, 'activity-empty').length, 0);
});

test('All time with nothing at all says so and offers no wider window', async () => {
  const rig = boot({ window: 'all' });
  await rig.list.load();
  await rig.settle();
  assert.equal(new URL('http://x' + rig.calls[0]).searchParams.get('since'), null, 'all time sends no since');
  assert.equal(withClass(rig.host, 'activity-empty-line')[0].textContent, 'Nothing has happened yet.');
  assert.equal(withClass(rig.host, 'activity-link').length, 0);
  assert.ok(withClass(rig.host, 'activity-empty-note')[0].textContent.includes('every action lands here as a receipt'));
});

test('a kind chip narrows the ask, and an empty kind names itself', async () => {
  const rig = boot();
  rig.respond((params) => (params.get('kind') === 'swap'
    ? { receipts: [], total: 0, hasMore: false, feesUsd: 0 }
    : { receipts: [receipt('m', 1, 'hl_deposit')], total: 1, hasMore: false, feesUsd: 0.3 }));
  await rig.list.load();
  await rig.settle();
  withClass(rig.head, 'chip-filter').find((c) => c.dataset.id === 'swap')!.click();
  await rig.settle();
  assert.equal(new URL('http://x' + rig.calls[1]).searchParams.get('kind'), 'swap');
  assert.deepEqual(pressed(rig.head), ['24h', 'swap']);
  assert.equal(withClass(rig.host, 'activity-empty-line')[0].textContent, 'No swaps in the last 24 hours.');
});

test('Show more asks for the page older than the last row and appends it', async () => {
  const rig = boot();
  const first = [receipt('a', 1), receipt('b', 2)];
  const second = [receipt('c', 3), receipt('d', 4)];
  rig.respond((params) => (params.get('before') === null
    ? { receipts: first, total: 4, hasMore: true, feesUsd: 0.04 }
    : { receipts: second, total: 4, hasMore: false, feesUsd: 0.04 }));
  await rig.list.load();
  await rig.settle();
  const more = withClass(rig.host, 'activity-more')[0];
  assert.ok(more, 'a page is waiting, so Show more is drawn');
  assert.equal(withClass(more, 'btn-label')[0].textContent, 'Show more');
  more.click();
  await rig.settle();
  const params = new URL('http://x' + rig.calls[1]).searchParams;
  assert.equal(params.get('before'), String(Date.parse(first[1]!.at)), 'the cursor is the last row on screen');
  assert.ok(params.get('since') !== null, 'the window rides along with the cursor');
  assert.deepEqual(rows(rig.host), ['a', 'b', 'c', 'd']);
  assert.equal(withClass(rig.host, 'activity-more').length, 0, 'the last page draws no Show more');
});

test('a row click emits receipt:open with the receipt and its source, and nothing else', async () => {
  const rig = boot({ source: 'activity' });
  const a = receipt('a', 1);
  rig.respond(() => ({ receipts: [a], total: 1, hasMore: false, feesUsd: 0.01 }));
  await rig.list.load();
  await rig.settle();
  withClass(rig.host, 'receipt-row')[0].click();
  assert.equal(rig.emitted.length, 1);
  assert.equal(rig.emitted[0].type, 'receipt:open');
  assert.equal(rig.emitted[0].payload.source, 'activity');
  assert.equal(rig.emitted[0].payload.receipt.id, 'a');
});

test('Basic\'s compact list hides the chips, shows a few rows, and See all opens the whole thing', async () => {
  const rig = boot({ compact: true, chips: false, limit: 5 });
  rig.respond((params) => {
    const limit = Number(params.get('limit'));
    const all = Array.from({ length: 8 }, (_, i) => receipt(`r${i}`, i + 1));
    return { receipts: all.slice(0, limit), total: 8, hasMore: limit < 8, feesUsd: 0.08 };
  });
  await rig.list.load();
  await rig.settle();
  assert.equal(new URL('http://x' + rig.calls[0]).searchParams.get('limit'), '5');
  assert.equal(withClass(rig.head, 'activity-filters')[0].hidden, true, 'no chips in the fold');
  assert.equal(rows(rig.host).length, 5);
  const seeAll = withClass(rig.host, 'activity-more')[0];
  assert.equal(withClass(seeAll, 'btn-label')[0].textContent, 'See all');
  seeAll.click();
  await rig.settle();
  assert.equal(new URL('http://x' + rig.calls[1]).searchParams.get('limit'), '25');
  assert.equal(withClass(rig.head, 'activity-filters')[0].hidden, false, 'See all brings the chips');
  assert.equal(rows(rig.host).length, 8);
  assert.equal(withClass(rig.host, 'activity-more').length, 0);
});

test('the head line is told the window, the count, the total and the fees', async () => {
  const seen: Any[] = [];
  const rig = boot({ onMeta: (m: Any) => seen.push(m) });
  rig.respond(() => ({ receipts: [receipt('a', 1)], total: 3, hasMore: true, feesUsd: 0.12 }));
  await rig.list.load();
  await rig.settle();
  const last = seen[seen.length - 1];
  assert.equal(last.words, 'last 24 hours');
  assert.equal(last.count, 1);
  assert.equal(last.total, 3);
  assert.equal(last.feesUsd, 0.12);
  assert.equal(last.state, 'ready');
});

test('a transactions frame re-reads every list that has read once, at the depth it is showing', async () => {
  const rig = boot();
  rig.respond((params) => {
    const limit = Number(params.get('limit'));
    const all = Array.from({ length: 60 }, (_, i) => receipt(`r${i}`, i * 0.1));
    const from = params.get('before') === null ? 0 : 25;
    return { receipts: all.slice(from, from + limit), total: 60, hasMore: from + limit < 60, feesUsd: 0.6 };
  });
  await rig.list.load();
  await rig.settle();
  withClass(rig.host, 'activity-more')[0].click();
  await rig.settle();
  assert.equal(rows(rig.host).length, 50);
  rig.fire('transactions');
  await rig.settle();
  assert.equal(new URL('http://x' + rig.calls[2]).searchParams.get('limit'), '50', 'the refresh keeps the depth');
  assert.equal(new URL('http://x' + rig.calls[2]).searchParams.get('before'), null, 'the refresh starts from the top');
});

test('a read that fails is said in words, with a way to try again', async () => {
  const rig = boot();
  let broken = true;
  rig.respond(() => (broken ? new Error('down') : { receipts: [receipt('a', 1)], total: 1, hasMore: false, feesUsd: 0 }));
  await rig.list.load();
  await rig.settle();
  assert.equal(withClass(rig.host, 'activity-empty-line')[0].textContent, 'The app could not read what happened.');
  broken = false;
  withClass(rig.host, 'activity-link')[0].click();
  await rig.settle();
  assert.deepEqual(rows(rig.host), ['a']);
});

/* The dock opens the receipt for the row a Yes has just settled, and it asks this module for
   it. When the list became a mounted component the module level load() went with it, and the
   dock's call fell through to close(): every approval since 2026-09-15 has flashed "Approved."
   and then shown nothing at all. One read by id, off the same route the list reads. */
test('a receipt can be read by id, for the dock that just decided it', async () => {
  const rig = boot();
  rig.respond(() => ({ receipts: [receipt('a', 1), receipt('b', 2)], total: 2, hasMore: false, feesUsd: 0.02 }));
  await rig.settle();

  assert.equal((await rig.mod.find('b'))?.id, 'b');
  assert.equal(await rig.mod.find('gone'), null, 'a row that is not there is null, never a throw');
  assert.equal(await rig.mod.find(''), null, 'no id is no row');

  rig.respond(() => new Error('the app is down'));
  assert.equal(await rig.mod.find('a'), null, 'a read that fails is null, and the dock closes');
});
