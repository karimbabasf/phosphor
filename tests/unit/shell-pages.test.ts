// The shell's two pages, src-tauri/frontend/update.html and index.html, run in a small stand-in
// document and driven through the same window functions the shell evals (update.rs, main.rs).
// What a person reads in each state, which keys show, and which IPC command a key sends.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
const UPDATE = read('../../src-tauri/frontend/update.html');
const SPLASH = read('../../src-tauri/frontend/index.html');

type Listener = (e: { key?: string }) => void;

class El {
  id: string;
  hidden = false;
  open = false;
  className = '';
  textContent = '';
  tagName: string;
  style: Record<string, string> = {};
  scrollTop = 0;
  clientHeight = 0;
  scrollHeight = 0;
  offsetWidth = 0;
  firstElementChild: El | null = null;
  attrs = new Map<string, string>();
  listeners = new Map<string, Listener[]>();
  classList = { add: () => {}, remove: () => {} };
  constructor(id: string, tag: string, hidden: boolean) {
    this.id = id;
    this.tagName = tag;
    this.hidden = hidden;
  }
  setAttribute(k: string, v: string) { this.attrs.set(k, String(v)); }
  removeAttribute(k: string) { this.attrs.delete(k); }
  hasAttribute(k: string) { return this.attrs.has(k); }
  getAttribute(k: string) { return this.attrs.get(k) ?? null; }
  addEventListener(type: string, fn: Listener) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  click() { for (const fn of this.listeners.get('click') ?? []) fn({}); }
  querySelector() { return null; }
}

/** Loads a page's markup ids and runs its script with `init` set first, as the shell's
    initialization script is. Returns the elements and the IPC commands the page sent. */
function load(html: string, init: Record<string, unknown>) {
  const els = new Map<string, El>();
  for (const m of html.matchAll(/<(\w+)([^>]*?)\sid="([^"]+)"([^>]*)>/g)) {
    const attrs = m[2] + m[4];
    els.set(m[3], new El(m[3], m[1].toUpperCase(), /\shidden(?=[\s>/]|$)/.test(attrs)));
  }
  for (const el of els.values()) if (el.id === 'progress') el.firstElementChild = new El('', 'I', false);
  const body = new El('body', 'BODY', false);
  const docListeners: Listener[] = [];
  const sent: string[] = [];
  const window: Record<string, unknown> = {
    ...init,
    __TAURI_INTERNALS__: { invoke: (cmd: string) => { sent.push(cmd); return Promise.resolve(); } },
  };
  const document = {
    body,
    activeElement: body,
    getElementById: (id: string) => els.get(id) ?? null,
    addEventListener: (_: string, fn: Listener) => docListeners.push(fn),
  };
  const script = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
  vm.runInNewContext(script, { window, document, requestAnimationFrame: () => 0, String, Number, Math });
  const el = (id: string) => {
    const found = els.get(id);
    assert.ok(found, `no #${id}`);
    return found;
  };
  const shown = (id: string) => !el(id).hidden;
  const call = (name: string, ...args: unknown[]) => (window[name] as (...a: unknown[]) => void)(...args);
  const key = (k: string) => docListeners.forEach((fn) => fn({ key: k }));
  return { el, shown, call, key, sent, body };
}

const OFFER = { state: 'offer', version: '0.10.13', current: '0.10.12', notes: 'Notes.' };

test('the update window says Downloading, then Checking the update with a moving bar, then Installing', () => {
  const page = load(UPDATE, { __PHOSPHOR_UPDATE__: OFFER });
  page.el('install').click();
  assert.deepEqual(page.sent, ['update_install']);
  const bar = page.el('progress');
  const fill = bar.firstElementChild!;
  assert.equal(page.el('installing').textContent, 'Downloading', 'nothing is installing before the download');
  assert.ok(bar.hasAttribute('data-indeterminate'));
  assert.equal(fill.style.width, '', 'an inline width would hide the moving bar under its 30% rule');

  page.call('__phosphorProgress', 0.42);
  assert.equal(page.el('installing').textContent, 'Downloading 42%');
  assert.equal(fill.style.width, '42%');
  page.call('__phosphorProgress', 1);
  assert.notEqual(page.el('installing').textContent, 'Installing', 'the bar sits full while the check runs, so it must not say Installing');

  // update.rs calls this before vet(): the signature check takes 1.7 to 8 s.
  page.call('__phosphorChecking');
  assert.equal(page.el('installing').textContent, 'Checking the update');
  assert.ok(bar.hasAttribute('data-indeterminate'));
  assert.equal(fill.style.width, '');

  // update.rs calls this right before update.install.
  page.call('__phosphorInstalling');
  assert.equal(page.el('installing').textContent, 'Installing');
  assert.ok(bar.hasAttribute('data-indeterminate'));
  assert.ok(!page.shown('later'), 'no way out while the swap runs');
});

test('every window hook update.rs calls is defined by the page', () => {
  const page = load(UPDATE, { __PHOSPHOR_UPDATE__: OFFER });
  const rust = read('../../src-tauri/src/update.rs');
  const hooks = new Set([...rust.matchAll(/window\.(__phosphor\w+)/g)].map((m) => m[1]));
  assert.ok(hooks.has('__phosphorChecking') && hooks.has('__phosphorInstalling'), [...hooks].join(', '));
  for (const hook of hooks) assert.doesNotThrow(() => page.call(hook, 1), hook);
  // In install(): the page hears of the check before vet() runs and of the swap right before it.
  const install = rust.slice(rust.indexOf('async fn install('), rust.indexOf('pub(crate) fn port_for('));
  const at = (s: string) => {
    const i = install.indexOf(s);
    assert.ok(i >= 0, s);
    return i;
  };
  assert.ok(at('CHECKING') < at('vet(') && at('vet(') < at('INSTALLING') && at('INSTALLING') < at('update.install('));
});

const ALTERED = {
  title: 'Phosphor needs a fresh copy',
  message: 'Some of its files changed.',
  detail: 'The files in Phosphor.app are not the ones this copy was built with.',
  kind: 'altered',
};

test('the altered splash offers phosphor.money in place of Try again, and Details sits in its own well', () => {
  const page = load(SPLASH, { __PHOSPHOR_SPLASH__: { state: 'starting' } });
  page.call('__phosphorFailed', ALTERED);
  assert.equal(page.body.getAttribute('data-state'), 'failed');
  assert.ok(page.shown('get') && page.shown('quit') && !page.shown('retry'));
  assert.equal(page.el('failed-detail').textContent, ALTERED.detail);
  page.el('get').click();
  assert.deepEqual(page.sent, ['splash_get_phosphor']);
});
