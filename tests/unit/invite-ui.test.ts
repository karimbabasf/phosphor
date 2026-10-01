// Invite codes in the window: the first run's step, the claim on the addresses step, the toast a
// claim that ends late becomes, and the adapter every one of those calls goes through.
//
// The real ui/core/invite.js, ui/screens/invite.js and ui/screens/firstrun.js run over a DOM small
// enough to read (the pattern of firstrun-ui.test.ts), with the network replaced by a recorder
// that answers what the test says the app answered and a stream the test speaks on. What is
// proven: the step sits after the welcome and the terms in all four flows and is not counted; Skip
// is the quiet default and checks nothing; a pasted code is checked at once and a good one only
// remembered; each refusal is its own sentence; the claim fires once, on the addresses step, and
// its line follows it; an end that comes after the person moved on is a toast on Basic that
// close() never silences; close() wipes the code; and the code is never in the store, a toast, a
// sentence or the page after it was used. tsc never sees ui/, so this is the check.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

type Any = Record<string, any>;

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
const LINKS = read('../../ui/core/links.js');
const DOM = read('../../ui/core/dom.js');
const STATE = read('../../ui/core/state.js');
const ADAPTER = read('../../ui/core/invite.js');
const INVITE = read('../../ui/screens/invite.js');
const FIRSTRUN = read('../../ui/screens/firstrun.js');
const MONEYIN = read('../../ui/screens/moneyin.js');
const DEPOSIT = read('../../ui/screens/deposit.js');
const INDEX = read('../../ui/index.html');

/* A code the shape of a real one. Never funded, never issued: the shape is all that matters here. */
const CODE = 'PHOS-2X9QK-M7RTB-0HVFD-K3WPZ-A8GN4CJ';

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
    id: '',
    tabIndex: 0,
    inert: false,
    offsetTop: 0,
    offsetLeft: 0,
    offsetWidth: 480,
    dataset: {} as Record<string, string>,
    style: { setProperty(name: string, value: string) { (node.style as Any)[name] = value; } } as Any,
    childNodes: [] as Any[],
    parentNode: null as unknown as Any,
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
    /* The deposit card is a <dialog>. */
    showModal() { node.open = true; },
    close() { node.open = false; },
    querySelector(selector: string) { return find(node, selector)[0] ?? null; },
    querySelectorAll(selector: string) { return find(node, selector); },
  };
  return node;
}

/* The network picker (ui/screens/netpick.js) as its hosts see it: a stage, a way to move it, and
   the onStage call a host keys its own parts on. */
function netpickStub(): Any {
  const stub: Any = {
    render(host: Any, opts: Any) {
      const root = makeNode('div');
      root.className = 'netpick';
      host.appendChild(root);
      let stage = opts.stage === 'address' ? 'address' : 'network';
      const view = {
        stage: () => stage,
        go: (next: string) => {
          stage = next;
          if (typeof opts.onStage === 'function') opts.onStage(next, opts.network ?? null);
        },
        destroy: () => { root.remove(); },
        root,
      };
      if (typeof opts.onStage === 'function') opts.onStage(stage, opts.network ?? null);
      stub.last = view;
      return view;
    },
    name: (id: string) => id,
    networkOf: () => null,
  };
  return stub;
}

function matches(node: Any, selector: string): boolean {
  const parts = selector.trim().match(/^([a-z][a-z0-9]*)?((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/i);
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

/* Every text a person can read: what is not hidden, and not inside something hidden. */
function visibleText(node: Any): string[] {
  const out: string[] = [];
  const walk = (n: Any): void => {
    if (n.hidden) return;
    if (n.childNodes.length === 0) {
      if (n.textContent !== '') out.push(n.textContent);
      return;
    }
    for (const child of n.childNodes) walk(child);
  };
  walk(node);
  return out;
}

/* Every string the page holds anywhere: text, a field's value, an attribute. */
function everything(node: Any): string {
  const out: string[] = [];
  const walk = (n: Any): void => {
    out.push(String(n.value ?? ''), String(n.id ?? ''));
    if (n.childNodes.length === 0) out.push(n.textContent);
    for (const child of n.childNodes) walk(child);
  };
  walk(node);
  return out.join('\n');
}

const buttonNamed = (root: Any, label: string): Any => find(root, 'button').find((b: Any) => !b.hidden && b.textContent === label) as Any;
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const title = (screen: Any): string => (find(screen, 'h1')[0] ?? {}).textContent ?? '';

/* ---------- the window ---------- */

type Answer = Record<string, unknown> | Error;
type World = {
  sandbox: Any;
  screen: Any;
  body: Any;
  calls: Any[];
  toasts: Array<{ words: string; tone: string }>;
  answers: Record<string, Answer>;
  store: Any;
  logs: string[];
  emit: (type: string, frame: Any) => void;
};

const ENCLAVE = {
  custody: null,
  state: 'no_wallet',
  enclave: { attached: true, ready: true, capability: { secureEnclave: true, biometry: 'touchid', canAuthenticate: true }, keyMadeAt: null, binding: 'device' },
  foreign: false,
  waiting: null,
  backedUp: false,
  backedUpAt: null,
  idleMinutes: 15,
  hasMnemonic: true,
};
const SOFTWARE = { ...ENCLAVE, enclave: { attached: true, ready: false, capability: null, keyMadeAt: null, binding: null } };
const FOREIGN = { ...ENCLAVE, foreign: true };

const GOOD = { ok: true, amount: '5.00', asset: 'USDC', route: 'relay', net: '5.00' };

function build(options: { terms?: boolean; vault?: Any; money?: boolean; deposit?: boolean } = {}): World {
  const nodes: Record<string, Any> = {};
  for (const id of ['screen-firstrun', 'page']) nodes[id] = makeNode('div');
  const body = makeNode('body');
  const calls: Any[] = [];
  const toasts: Array<{ words: string; tone: string }> = [];
  const logs: string[] = [];
  const answers: Record<string, Answer> = {
    'agent-scan': { ok: true, agents: [], picked: null },
    '/api/invite/check': GOOD,
    '/api/invite/claim': { ok: true, claim: 'c-1' },
  };
  const handlers: Record<string, Array<(frame: Any) => void>> = {};

  const doc: Any = {
    body,
    head: makeNode('head'),
    documentElement: makeNode('html'),
    createElement: makeNode,
    getElementById: (id: string) => nodes[id] ?? null,
    querySelectorAll: () => [],
    addEventListener() {},
  };
  /* Everything the window says to its console, so a test can say the code was never in it. */
  const record = (...args: unknown[]): void => { logs.push(args.map(String).join(' ')); };
  const sandbox: Any = {
    console: { log: record, warn: record, error: record, info: record },
    URL,
    document: doc,
    Promise,
    setTimeout: (fn: () => void) => { setTimeout(fn, 0); return 1; },
    clearTimeout() {},
    setInterval: () => 1,
    clearInterval() {},
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame: (fn: (now: number) => void) => { fn(0); return 1; },
    cancelAnimationFrame() {},
    navigator: {},
  };
  sandbox.window = sandbox;
  const answerFor = (key: string): Promise<unknown> => {
    const answer = answers[key];
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve(answer ?? {});
  };
  sandbox.PhosphorNet = {
    readable: (e: Any) => `RAW:${String(e && e.message ? e.message : e)}`,
    postJson: (path: string, payload: Any) => { calls.push({ route: path, ...payload }); return answerFor(path); },
  };
  sandbox.PhosphorEvents = {
    on: (type: string, fn: (frame: Any) => void) => { (handlers[type] ||= []).push(fn); return () => {}; },
  };
  sandbox.PhosphorMotion = { reduced: () => true };
  sandbox.PhosphorShell = {
    setPending(button: Any, pending: boolean) {
      button.disabled = !!pending;
      if (pending) button.dataset.pending = 'true';
      else delete button.dataset.pending;
    },
    refresh: () => { calls.push({ route: 'refresh' }); return Promise.resolve(); },
    setView: (name: string) => { calls.push({ route: 'setView', view: name }); },
    view: () => 'basic',
  };
  sandbox.PhosphorToast = { show: (words: string, tone: string) => { toasts.push({ words, tone }); } };
  sandbox.PhosphorMoneyIn = { render: (host: Any) => { host.appendChild(makeNode('div')); return { destroy() {} }; } };
  sandbox.PhosphorApi = {
    vaultCreate: () => Promise.resolve({ ok: true, addresses: { evm: '0xabc' } }),
    vaultRestore: () => Promise.resolve({ ok: true, addresses: {} }),
    vaultBackupProven: () => Promise.resolve({ ok: true }),
    walletCreate: () => Promise.resolve({ ok: true, mnemonic: 'abandon ability able about above absent absorb abstract absurd abuse access accident'.split(' '), addresses: {} }),
    walletImport: () => Promise.resolve({ ok: true, addresses: {} }),
    connection: () => Promise.resolve({ missing: true }),
    driver: (payload: Any) => { calls.push({ route: '/api/driver', ...payload }); return answerFor(payload.action); },
  };
  if (options.terms) {
    let accepted = false;
    sandbox.PhosphorTerms = {
      required: () => !accepted,
      content: (card: Any) => { const p = makeNode('p'); p.textContent = 'The terms.'; card.appendChild(p); return p; },
      accept: () => { accepted = true; return Promise.resolve({ ok: true }); },
    };
  }

  if (options.money || options.deposit) {
    sandbox.PhosphorNetPick = netpickStub();
    sandbox.PhosphorApi.intentsReceive = () => Promise.resolve({ data: null });
    sandbox.PhosphorApi.depositShow = (chain: string, symbol: string) => Promise.resolve({ ok: true, deposit: { chain, symbol, phase: 'watching', startedAt: '2026-10-01T12:00:00Z' } });
  }

  createContext(sandbox);
  runInContext(LINKS, sandbox, { filename: 'ui/core/links.js' });
  runInContext(DOM, sandbox, { filename: 'ui/core/dom.js' });
  runInContext(STATE, sandbox, { filename: 'ui/core/state.js' });
  runInContext(ADAPTER, sandbox, { filename: 'ui/core/invite.js' });
  runInContext(INVITE, sandbox, { filename: 'ui/screens/invite.js' });
  runInContext(FIRSTRUN, sandbox, { filename: 'ui/screens/firstrun.js' });
  if (options.money || options.deposit) runInContext(MONEYIN, sandbox, { filename: 'ui/screens/moneyin.js' });
  if (options.deposit) runInContext(DEPOSIT, sandbox, { filename: 'ui/screens/deposit.js' });

  const store = sandbox.PhosphorState;
  store.put({ lock: { state: 'no_wallet', idleLocksInSec: null }, vault: options.vault ?? ENCLAVE, agents: { members: [] } });
  sandbox.PhosphorInvite.boot();
  sandbox.PhosphorFirstRun.boot();
  const emit = (type: string, frame: Any): void => {
    for (const fn of handlers[type] ?? []) fn({ type, ...frame });
    for (const fn of handlers['*'] ?? []) fn({ type, ...frame });
  };
  return { sandbox, screen: nodes['screen-firstrun'], body, calls, toasts, answers, store, logs, emit };
}

const field = (screen: Any): Any => find(screen, 'input.invite-input')[0];
const said = (screen: Any): string => {
  const node = find(screen, '.firstrun-invite-said').find((n: Any) => !n.hidden);
  return node ? node.textContent : '';
};
const actionRow = (screen: Any): Any => find(screen, '.screen-actions')[0];
const primary = (screen: Any): Any => actionRow(screen).childNodes[actionRow(screen).childNodes.length - 1];
const checks = (world: World): Any[] => world.calls.filter((c) => c.route === '/api/invite/check');
const claims = (world: World): Any[] => world.calls.filter((c) => c.route === '/api/invite/claim');

/* The welcome's Get started, and the invite step it lands on. */
function toInvite(world: World): Any {
  world.sandbox.PhosphorFirstRun.open();
  buttonNamed(world.screen, 'Get started').click();
  assert.equal(title(world.screen), 'Got an invite code?', 'Get started did not reach the invite step');
  return world.screen;
}

/* A code pasted into the step: the value lands, then the paste event. */
async function paste(world: World, code = CODE): Promise<void> {
  const input = field(world.screen);
  input.value = code;
  input.dispatch('input');
  input.dispatch('paste');
  await flush();
  await flush();
}

/* ---------- the step, in every flow ---------- */

test('the invite step sits after the welcome in all four flows and is not counted by the progress', async () => {
  // The source says it: every flow has it second, and UNCOUNTED names it beside the welcome and the terms.
  const flows = /var FLOWS = \{([\s\S]*?)\};/.exec(FIRSTRUN)?.[1] ?? '';
  for (const name of ['create', 'import', 'enclave', 'foreign']) {
    assert.match(flows, new RegExp(`${name}: \\['welcome', 'invite', `), `${name} does not open welcome, invite`);
  }
  assert.match(FIRSTRUN, /var UNCOUNTED = \['welcome', 'terms', 'invite'\];/);

  const cases: Array<[string, Any, string, string | null, string]> = [
    ['enclave', ENCLAVE, 'Create your wallet', null, 'Step 1 of 3'],
    ['create', SOFTWARE, 'Create or bring a wallet', null, 'Step 1 of 9'],
    ['import', SOFTWARE, 'Create or bring a wallet', 'I already have one', 'Step 1 of 8'],
    ['foreign', FOREIGN, 'Made on another Mac', null, 'Step 1 of 3'],
  ];
  for (const [name, vault, first, pick, count] of cases) {
    const world = build({ vault });
    const screen = toInvite(world);
    assert.equal(find(screen, '.screen-progress').length, 0, `${name}: the invite step is counted`);
    assert.ok(!visibleText(screen).some((t) => /^Step \d/.test(t)), `${name}: the invite step says a step number`);
    buttonNamed(screen, 'Skip').click();
    assert.equal(title(screen), first, `${name}: Skip did not reach the flow's own first step`);
    if (pick) {
      (find(screen, '.choice').find((c: Any) => c.textContent.startsWith(pick)) as Any).click();
    }
    assert.ok(visibleText(screen).includes(count), `${name}: the first wallet step is not ${count}: ${visibleText(screen).filter((t) => t.startsWith('Step')).join()}`);
    assert.equal(checks(world).length, 0, `${name}: Skip checked a code`);
  }
});

test('the terms come first, then the invite, and Back from the invite goes to the welcome once they are accepted', async () => {
  const world = build({ terms: true });
  world.sandbox.PhosphorFirstRun.open();
  buttonNamed(world.screen, 'Get started').click();
  assert.equal(title(world.screen), 'Before you start');
  buttonNamed(world.screen, 'Accept and continue').click();
  await flush();
  assert.equal(title(world.screen), 'Got an invite code?', 'the invite step does not follow the terms');
  buttonNamed(world.screen, 'Back').click();
  assert.ok(buttonNamed(world.screen, 'Get started'), 'Back from the invite did not reach the welcome');
});

test('Skip is the quiet default: Use code is an outline until the field holds something, and Skip checks nothing', () => {
  const world = build();
  const screen = toInvite(world);
  assert.deepEqual(visibleText(screen).slice(0, 3), ['Got an invite code?', 'Paste it and $5 lands in your wallet once it\'s made.', 'Invite code']);
  const skip = buttonNamed(screen, 'Skip');
  assert.equal(skip.className, 'btn btn-quiet', 'Skip is louder than a quiet key');
  const use = buttonNamed(screen, 'Use code');
  assert.equal(use.className, 'btn btn-primary btn-lg');
  assert.equal(use.disabled, true, 'Use code can be pressed with nothing in the field');
  assert.equal(field(screen).focused, true, 'the field did not take the cursor, so a paste lands nowhere');
  // The field reads a code one character at a time and remembers nothing.
  assert.equal(field(screen).autocomplete, 'off');
  assert.equal(field(screen).spellcheck, false);
  assert.equal(field(screen).getAttribute('autocorrect'), 'off');
  field(screen).value = 'P';
  field(screen).dispatch('input');
  assert.equal(use.disabled, false, 'Use code did not come alive with something to check');
  skip.click();
  assert.equal(checks(world).length, 0);
  assert.equal(title(screen), 'Create your wallet');
});

test('a pasted code is checked at once, a good one says what is waiting, and Continue moves on without claiming', async () => {
  const world = build({ vault: SOFTWARE });
  const screen = toInvite(world);
  await paste(world);
  assert.equal(checks(world).length, 1, 'the paste was not checked');
  assert.equal(checks(world)[0].code, CODE, 'the check did not carry the code');
  assert.equal(said(screen), 'Nice. $5 is waiting for you.');
  assert.equal(find(screen, '.firstrun-invite-said')[0].getAttribute('data-tone'), 'good');
  assert.equal(primary(screen).textContent, 'Continue');
  assert.equal(buttonNamed(screen, 'Skip'), undefined, 'Skip is still offered over a good code');
  primary(screen).click();
  assert.equal(title(screen), 'Create or bring a wallet');
  assert.equal(claims(world).length, 0, 'the check claimed the money before there was a wallet');
  // Back finds the code still good, and an edit takes that back.
  buttonNamed(screen, 'Back').click();
  assert.equal(title(screen), 'Got an invite code?');
  assert.equal(field(screen).value, CODE);
  assert.equal(said(screen), 'Nice. $5 is waiting for you.');
  field(screen).value = CODE + 'X';
  field(screen).dispatch('input');
  assert.equal(said(screen), '');
  assert.equal(primary(screen).textContent, 'Use code');
  assert.ok(buttonNamed(screen, 'Skip'));
});

test('a typed code is checked by Use code, or by Enter in the field', async () => {
  const world = build();
  const screen = toInvite(world);
  field(screen).value = CODE.toLowerCase();
  field(screen).dispatch('input');
  assert.equal(checks(world).length, 0, 'typing alone checked the code');
  field(screen).dispatch('keydown', { key: 'Enter' });
  await flush();
  assert.equal(checks(world).length, 1);
  assert.equal(said(screen), 'Nice. $5 is waiting for you.');
});

test('each refusal is its own calm sentence over the same Use code, and nothing the network said is printed', async () => {
  const cases: Array<[Answer, string]> = [
    [{ ok: false, reason: 'typo' }, 'That code has a typo. Check it and try again.'],
    [{ ok: false, reason: 'empty' }, 'This code was already used, or it has a typo.'],
    [{ ok: false, reason: 'offline' }, 'Couldn\'t check the code right now. You can add it later from Add money.'],
    [{ ok: false, reason: 'locked' }, 'This code can\'t pay out right now. Ask whoever sent it for a new one.'],
    [{ ok: false, reason: 'busy' }, 'A code is already on its way to your wallet. Give it a minute.'],
    [Object.assign(new Error('Failed to fetch'), { status: 0 }), 'Couldn\'t check the code right now. You can add it later from Add money.'],
    [Object.assign(new Error('missing or wrong token'), { status: 403 }), 'Couldn\'t check the code right now. You can add it later from Add money.'],
    [Object.assign(new Error('not found'), { status: 404 }), 'Couldn\'t check the code right now. You can add it later from Add money.'],
    [{ ok: false, reason: 'something the app never said before' }, 'Couldn\'t check the code right now. You can add it later from Add money.'],
  ];
  for (const [answer, words] of cases) {
    const world = build();
    world.answers['/api/invite/check'] = answer;
    const screen = toInvite(world);
    await paste(world);
    assert.equal(said(screen), words);
    assert.equal(find(screen, '.firstrun-invite-said')[0].getAttribute('data-tone'), 'warn');
    assert.equal(primary(screen).textContent, 'Use code', 'a refused code turned the key into Continue');
    assert.equal(primary(screen).disabled, false, 'Use code cannot be pressed again');
    assert.ok(buttonNamed(screen, 'Skip'), 'Skip went away with a refusal');
    assert.ok(!visibleText(screen).some((t) => /RAW:|Failed to fetch|token|not found/.test(t)), 'a network word reached the screen');
    // An edit takes the sentence back.
    field(screen).value = 'PHOS';
    field(screen).dispatch('input');
    assert.equal(said(screen), '');
  }
});

test('an answer for a code that was edited, skipped or left behind is dropped', async () => {
  const world = build({ vault: SOFTWARE });
  let release: (value: unknown) => void = () => {};
  world.sandbox.PhosphorNet.postJson = (path: string, payload: Any) => {
    world.calls.push({ route: path, ...payload });
    return new Promise((resolve) => { release = resolve; });
  };
  const screen = toInvite(world);
  await paste(world);
  assert.equal(primary(screen).dataset.pending, 'true', 'the check does not show it is checking');
  buttonNamed(screen, 'Skip').click();
  release(GOOD);
  await flush();
  assert.equal(title(screen), 'Create or bring a wallet');
  buttonNamed(screen, 'Back').click();
  assert.equal(field(screen).value, '', 'Skip left the code in the field');
  assert.equal(said(screen), '', 'a late answer for a skipped code was shown');
});

/* ---------- the claim ---------- */

/* The enclave flow from a good code to the addresses step. */
async function toAddresses(world: World): Promise<Any> {
  const screen = toInvite(world);
  await paste(world);
  primary(screen).click(); // Continue
  buttonNamed(screen, 'Create wallet').click();
  await flush();
  await flush();
  assert.equal(title(screen), 'Your addresses');
  return screen;
}

const claimLine = (screen: Any): string => {
  const node = find(screen, '.firstrun-claim')[0];
  return node && !node.hidden ? node.textContent : '';
};

test('the claim fires once, on the addresses step, and its line follows it to the end', async () => {
  const world = build();
  const screen = await toAddresses(world);
  assert.equal(claims(world).length, 1, 'the claim did not fire on the addresses step');
  assert.equal(claims(world)[0].code, CODE);
  await flush();
  assert.equal(claimLine(screen), 'Adding $5 to your wallet. This can take up to two minutes.');
  assert.equal(find(screen, '.firstrun-claim')[0].getAttribute('data-tone'), 'wait');
  world.emit('invite', { claim: 'c-1', status: 'landed', amount: '5.00', asset: 'USDC' });
  assert.equal(claimLine(screen), '$5 USDC is in your wallet.');
  assert.equal(find(screen, '.firstrun-claim')[0].getAttribute('data-tone'), 'good');
  assert.equal(world.toasts.length, 0, 'an end said in place was said again as a toast');
  // The code left the page with the claim.
  assert.ok(!everything(screen).includes(CODE), 'the code is still on the page after the claim');
});

test('the software flow claims once: back to the addresses step shows the claim again and never fires a second', async () => {
  const world = build({ vault: SOFTWARE });
  const screen = toInvite(world);
  await paste(world);
  primary(screen).click(); // Continue
  buttonNamed(screen, 'Continue').click(); // choose: a new wallet
  find(screen, 'input').forEach((i: Any) => { i.value = 'a long enough password'; });
  buttonNamed(screen, 'Continue').click(); // password
  await flush();
  find(screen, 'input[type="checkbox"]')[0].checked = true;
  find(screen, 'input[type="checkbox"]')[0].dispatch('change');
  buttonNamed(screen, 'Continue').click(); // words
  find(screen, 'input.input').forEach((i: Any) => { i.value = 'word'; });
  buttonNamed(screen, 'Continue').click(); // prove
  await flush();
  assert.equal(title(screen), 'Your addresses');
  await flush();
  assert.equal(claims(world).length, 1);
  buttonNamed(screen, 'Continue').click(); // addresses
  assert.equal(title(screen), 'Add money');
  buttonNamed(screen, 'Back').click();
  assert.equal(title(screen), 'Your addresses');
  assert.equal(claims(world).length, 1, 'a second visit fired a second claim');
  assert.equal(claimLine(screen), 'Adding $5 to your wallet. This can take up to two minutes.');
});

test('a claim the app refuses says so on the step, in words about the money, never the network\'s', async () => {
  const cases: Array<[Answer, string]> = [
    [{ ok: false, reason: 'empty' }, 'This code was already used, or it has a typo.'],
    [{ ok: false, reason: 'offline' }, 'Your $5 didn\'t come through. Add the code again from Add money.'],
    [{ ok: false, reason: 'wallet-locked' }, 'Your $5 didn\'t come through. Add the code again from Add money.'],
    [new Error('Failed to fetch'), 'Your $5 didn\'t come through. Add the code again from Add money.'],
  ];
  for (const [answer, words] of cases) {
    const world = build();
    world.answers['/api/invite/claim'] = answer;
    const screen = await toAddresses(world);
    await flush();
    assert.equal(claimLine(screen), words);
    assert.equal(world.toasts.length, 0);
  }
});

test('an end that comes after the person moved on is a toast on Basic, and close() never silences it', async () => {
  // Landed while the first run was still up, past the addresses step: held, then said on Basic.
  const world = build();
  const screen = await toAddresses(world);
  await flush();
  buttonNamed(screen, 'Continue').click(); // addresses: on to the assistant step
  assert.equal(title(screen), 'Your assistant');
  world.emit('invite', { claim: 'c-1', status: 'landed', amount: '5.00', asset: 'USDC' });
  assert.equal(world.toasts.length, 0, 'a toast was raised behind the first run');
  buttonNamed(screen, 'Do this later').click(); // the last step: the first run closes
  assert.equal(screen.hidden, true, 'the first run did not close');
  assert.deepEqual(world.toasts, [{ words: '$5 USDC is in your wallet.', tone: 'up' }]);

  // Failed after the first run closed: a toast at once.
  const late = build();
  const lateScreen = await toAddresses(late);
  await flush();
  buttonNamed(lateScreen, 'Continue').click();
  buttonNamed(lateScreen, 'Do this later').click();
  assert.equal(lateScreen.hidden, true);
  assert.equal(late.toasts.length, 0);
  late.emit('invite', { claim: 'c-1', status: 'failed', amount: '5.00', asset: 'USDC' });
  assert.deepEqual(late.toasts, [{ words: 'Your $5 didn\'t come through. Add the code again from Add money.', tone: 'down' }]);
  // Said once: the same end again (the stream and the state both carry it) is not a second toast.
  late.emit('invite', { claim: 'c-1', status: 'failed' });
  late.store.put({ ...late.store.get(), invite: { claim: 'c-1', status: 'failed', amount: '5.00' } });
  assert.equal(late.toasts.length, 1);
});

test('the claim\'s answer can come after the step was left, and its frame can beat it', async () => {
  // The step was left before the 202: the end is still said, on Basic.
  const world = build();
  let release: (value: unknown) => void = () => {};
  const post = world.sandbox.PhosphorNet.postJson;
  world.sandbox.PhosphorNet.postJson = (path: string, payload: Any) => {
    if (path !== '/api/invite/claim') return post(path, payload);
    world.calls.push({ route: path, ...payload });
    return new Promise((resolve) => { release = resolve; });
  };
  const screen = await toAddresses(world);
  assert.equal(claimLine(screen), 'Adding $5 to your wallet. This can take up to two minutes.');
  buttonNamed(screen, 'Continue').click();
  buttonNamed(screen, 'Do this later').click();
  // The frame first, then the 202 it belongs to.
  world.emit('invite', { claim: 'c-9', status: 'landed', amount: '4.99', asset: 'USDC' });
  release({ ok: true, claim: 'c-9' });
  await flush();
  assert.deepEqual(world.toasts, [{ words: '$4.99 USDC is in your wallet.', tone: 'up' }]);
});

test('a window that opens while a claim runs says how it ends; one already over is history', () => {
  const world = build();
  world.store.put({ ...world.store.get(), invite: { claim: 'old', status: 'landed', amount: '5.00' } });
  assert.equal(world.toasts.length, 0, 'a claim that ended before this window was said again');
  world.store.put({ ...world.store.get(), invite: { claim: 'c-2', status: 'running', amount: '5.00' } });
  world.emit('invite', { claim: 'c-2', status: 'landed', amount: '5.00', asset: 'USDC' });
  assert.deepEqual(world.toasts, [{ words: '$5 USDC is in your wallet.', tone: 'up' }]);
  // The contract's word for the frame's field is read too.
  world.store.put({ ...world.store.get(), invite: { claim: 'c-3', status: 'running', amount: '5.00' } });
  world.emit('event', { kind: 'invite', claim: 'c-3', status: 'failed', amount: '5.00' });
  assert.equal(world.toasts[1]?.words, 'Your $5 didn\'t come through. Add the code again from Add money.');
});

/* ---------- the code goes nowhere ---------- */

test('close() wipes the code with the phrase and the password, and nothing else ever held it', async () => {
  const world = build();
  const screen = toInvite(world);
  await paste(world);
  assert.equal(said(screen), 'Nice. $5 is waiting for you.');
  world.sandbox.PhosphorFirstRun.close();
  assert.ok(!everything(screen).includes(CODE), 'the code is still on the closed card');
  world.sandbox.PhosphorFirstRun.open();
  buttonNamed(screen, 'Get started').click();
  assert.equal(field(screen).value, '', 'the code came back after close()');
  assert.equal(said(screen), '');
  assert.equal(primary(screen).textContent, 'Use code');
  // close() names the code beside the phrase and the password.
  const closeFn = FIRSTRUN.slice(FIRSTRUN.indexOf('function close()'), FIRSTRUN.indexOf('function dropInvite()'));
  assert.match(closeFn, /draft\.mnemonic = \[\];[\s\S]*draft\.password = '';[\s\S]*dropInvite\(\);/);
  assert.match(FIRSTRUN, /function dropInvite\(\) \{\s*draft\.invite = '';/);

  // Never in the state, a toast, the console or a sentence on the way through a whole claim.
  const whole = build();
  const addresses = await toAddresses(whole);
  whole.emit('invite', { claim: 'c-1', status: 'landed', amount: '5.00', asset: 'USDC' });
  buttonNamed(addresses, 'Continue').click();
  buttonNamed(addresses, 'Do this later').click();
  const forms = [CODE, CODE.toLowerCase(), CODE.replace(/-/g, '')];
  for (const form of forms) {
    assert.ok(!JSON.stringify(whole.store.get()).includes(form), 'the code reached the store');
    assert.ok(!whole.toasts.some((t) => t.words.includes(form)), 'the code reached a toast');
    assert.ok(!whole.logs.some((l) => l.includes(form)), 'the code reached the console');
    assert.ok(!everything(addresses).includes(form), 'the code is on the page');
  }
});

/* ---------- the adapter ---------- */

test('the adapter: one door for both routes, every failure is offline, and the frame is read under either name', async () => {
  const world = build();
  const door = world.sandbox.PhosphorInviteApi;
  assert.deepEqual({ ...(await door.check(CODE)) }, { ok: true, amount: '5.00', asset: 'USDC', route: 'relay', net: '5.00' });
  world.answers['/api/invite/check'] = { ok: true, amount: '5.00', asset: 'USDC', route: 'oneclick', net: '4.99' };
  assert.equal((await door.check(CODE)).net, '4.99');
  world.answers['/api/invite/check'] = Object.assign(new Error('nope'), { status: 403 });
  assert.deepEqual({ ...(await door.check(CODE)) }, { ok: false, reason: 'offline' });
  world.answers['/api/invite/claim'] = { ok: true, claim: 'abc' };
  assert.deepEqual({ ...(await door.claim(CODE)) }, { ok: true, claim: 'abc' });
  world.answers['/api/invite/claim'] = { ok: false, reason: 'wallet-locked' };
  assert.deepEqual({ ...(await door.claim(CODE)) }, { ok: false, reason: 'wallet-locked' });
  world.answers['/api/invite/claim'] = { ok: true };
  assert.deepEqual({ ...(await door.claim(CODE)) }, { ok: false, reason: 'offline' }, 'a 202 with no claim id was taken as a claim');
  // Both routes carry the code in the body and nothing else of the window's: net.js adds the token.
  for (const call of world.calls.filter((c) => String(c.route).startsWith('/api/invite/'))) {
    assert.deepEqual(Object.keys(call).sort(), ['code', 'route']);
  }
  assert.equal(door.outcomeOf({ claim: 'x', status: 'exploded' }), null);
  assert.equal(door.outcomeOf({ status: 'landed' }), null);
  // The adapter is the only file in ui/ that names the routes.
  for (const [name, source] of [['firstrun.js', FIRSTRUN], ['invite.js', INVITE]] as const) {
    assert.equal(/\/api\/invite/.test(source), false, `${name} calls a route itself`);
  }
  // Loaded before the screens that use it, and the screen before the chat that hands codes to it.
  const at = (src: string): number => INDEX.indexOf(`<script src="${src}" defer></script>`);
  assert.ok(at('./core/invite.js') > at('./core/api.js') && at('./core/invite.js') < at('./screens/agent.js'));
  assert.ok(at('./screens/invite.js') > 0 && at('./screens/invite.js') < at('./screens/agent.js'));
  assert.match(INDEX, /<link rel="stylesheet" href="\.\/design\/invite\.css">/);
});

/* ---------- Add money ---------- */

const lineOf = (host: Any): Any => find(host, '.invite-line')[0];
const lineSaid = (host: Any): string => {
  const node = find(host, '.invite-said').find((n: Any) => !n.hidden);
  return node ? node.textContent : '';
};
const lineField = (host: Any): Any => find(host, 'input.invite-input')[0];
const lineKey = (host: Any): Any => find(host, 'button.invite-use')[0];

/* The Add money fold, as Basic and Pro open it. */
function fold(world: World, options: Any = {}): { host: Any; steps: Any } {
  const host = makeNode('div');
  const steps = world.sandbox.PhosphorMoneyIn.render(host, { context: 'basic', ...options });
  return { host, steps };
}

test('Add money: Have an invite code? opens the field, a good code turns the key into Add $5, and that click claims', async () => {
  const world = build({ money: true });
  const { host } = fold(world);
  const toggle = buttonNamed(host, 'Have an invite code?');
  assert.ok(toggle, 'no invite line under the network step');
  assert.equal(toggle.className, 'btn btn-quiet btn-sm invite-open');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(find(host, '.invite-box')[0].hidden, true, 'the field is open before anyone asked');
  toggle.click();
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(find(host, '.invite-box')[0].hidden, false);
  assert.equal(lineField(host).focused, true);
  assert.equal(lineKey(host).textContent, 'Use code');
  assert.equal(lineKey(host).disabled, true, 'Use code can be pressed on an empty field');
  lineField(host).value = CODE;
  lineField(host).dispatch('input');
  assert.equal(lineKey(host).disabled, false);
  lineKey(host).click();
  await flush();
  assert.equal(checks(world).length, 1);
  assert.equal(lineSaid(host), 'Nice. $5 is waiting for you.');
  assert.equal(lineKey(host).textContent, 'Add $5');
  assert.equal(claims(world).length, 0, 'the check claimed the money before the click');
  lineKey(host).click();
  assert.equal(claims(world).length, 1, 'Add $5 did not claim');
  assert.equal(claims(world)[0].code, CODE);
  assert.equal(lineField(host).value, '', 'the code stayed in the field once it was used');
  assert.equal(lineSaid(host), 'Adding $5 to your wallet. This can take up to two minutes.');
  assert.equal(find(host, '.invite-open')[0].hidden, true, 'a second code can be started over a running claim');
  await flush();
  world.emit('invite', { claim: 'c-1', status: 'landed', amount: '5.00', asset: 'USDC' });
  assert.equal(lineSaid(host), '$5 USDC is in your wallet.');
  assert.equal(find(host, '.invite-said')[0].getAttribute('data-tone'), 'good');
  assert.equal(find(host, '.invite-open')[0].hidden, false);
  assert.equal(find(host, '.invite-box')[0].hidden, true);
  assert.equal(world.toasts.length, 0, 'an end said on the line was said again as a toast');
  assert.ok(!everything(host).includes(CODE));
  // Open again for another code: the old claim's line is let go of.
  buttonNamed(host, 'Have an invite code?').click();
  assert.equal(lineSaid(host), '');
  assert.equal(lineKey(host).textContent, 'Use code');
});

test('Add money: a paste is checked at once, and each refusal says what to do in the field\'s own words', async () => {
  const cases: Array<[string, Answer, string]> = [
    ['check', { ok: false, reason: 'typo' }, 'That code has a typo. Check it and try again.'],
    ['check', { ok: false, reason: 'empty' }, 'This code was already used, or it has a typo.'],
    ['check', { ok: false, reason: 'offline' }, 'Couldn\'t check the code right now. Try again in a moment.'],
    ['check', new Error('Failed to fetch'), 'Couldn\'t check the code right now. Try again in a moment.'],
    ['check', { ok: false, reason: 'locked' }, 'This code can\'t pay out right now. Ask whoever sent it for a new one.'],
    ['check', { ok: false, reason: 'busy' }, 'A code is already on its way to your wallet. Give it a minute.'],
    ['claim', { ok: false, reason: 'wallet-locked' }, 'Your $5 didn\'t come through. Paste the code again to try once more.'],
    ['claim', { ok: false, reason: 'empty' }, 'This code was already used, or it has a typo.'],
    ['claim', new Error('Failed to fetch'), 'Your $5 didn\'t come through. Paste the code again to try once more.'],
  ];
  for (const [route, answer, words] of cases) {
    const world = build({ money: true });
    world.answers[`/api/invite/${route}`] = answer;
    const { host } = fold(world);
    buttonNamed(host, 'Have an invite code?').click();
    lineField(host).value = CODE;
    lineField(host).dispatch('input');
    lineField(host).dispatch('paste');
    await flush();
    await flush();
    assert.equal(checks(world).length, 1, `${words}: the paste was not checked`);
    if (route === 'claim') {
      lineKey(host).click();
      await flush();
    }
    assert.equal(lineSaid(host), words);
    assert.equal(find(host, '.invite-said')[0].getAttribute('data-tone'), 'warn');
    assert.equal(find(host, '.invite-box')[0].hidden, false, `${words}: the field closed on a problem`);
    assert.equal(lineKey(host).textContent, 'Use code');
    assert.equal(world.toasts.length, 0);
    assert.ok(!visibleText(host).some((t) => /RAW:|Failed to fetch/.test(t)));
  }
});

test('Add money: the line is on the network step only, a code from the chat opens it there, and the first run draws none', async () => {
  const world = build({ money: true });
  const { host, steps } = fold(world);
  assert.equal(lineOf(host).hidden, false);
  steps.go('tokens');
  assert.equal(lineOf(host).hidden, true, 'the line stayed under the token list');
  steps.go('address');
  assert.equal(lineOf(host).hidden, true, 'the line sits under an address');
  // Handed over from the chat while an address is up: back to the tiles, the field open with it, checked.
  assert.equal(world.sandbox.PhosphorMoneyIn.invite(CODE), true);
  assert.equal(steps.stage(), 'network');
  assert.equal(lineOf(host).hidden, false);
  assert.equal(lineField(host).value, CODE);
  await flush();
  assert.equal(checks(world).length, 1);
  assert.equal(lineSaid(host), 'Nice. $5 is waiting for you.');
  assert.equal(claims(world).length, 0, 'a code from the chat was claimed without a click');
  // Rendered with the code, as Basic does when the fold was closed.
  const second = fold(world, { invite: CODE });
  assert.equal(lineField(second.host).value, CODE);
  // The first run has its own step.
  const first = fold(world, { context: 'firstrun' });
  assert.equal(lineOf(first.host), undefined);
  // Closing the fold takes the line, and the code, with it.
  second.steps.destroy();
  assert.equal(lineOf(second.host), undefined);
});

test('Add money: a claim already running shows on the line, and a line off screen does not swallow its end', async () => {
  // Started by the first run, shown by the fold opened after it.
  const world = build({ money: true });
  world.sandbox.PhosphorInvite.claim(CODE, { amount: '5.00', asset: 'USDC' });
  await flush();
  const { host } = fold(world);
  assert.equal(lineSaid(host), 'Adding $5 to your wallet. This can take up to two minutes.');
  assert.equal(find(host, '.invite-open')[0].hidden, true);
  world.emit('invite', { claim: 'c-1', status: 'landed', amount: '5.00', asset: 'USDC' });
  assert.equal(lineSaid(host), '$5 USDC is in your wallet.');
  assert.equal(world.toasts.length, 0);

  // Started here, then the picker moved on: the end is a toast.
  const away = build({ money: true });
  const fresh = fold(away);
  buttonNamed(fresh.host, 'Have an invite code?').click();
  lineField(fresh.host).value = CODE;
  lineField(fresh.host).dispatch('input');
  lineKey(fresh.host).click();
  await flush();
  lineKey(fresh.host).click();
  await flush();
  fresh.steps.go('tokens');
  away.emit('invite', { claim: 'c-1', status: 'failed', amount: '5.00', asset: 'USDC' });
  assert.deepEqual(away.toasts, [{ words: 'Your $5 didn\'t come through. Add the code again from Add money.', tone: 'down' }]);
});

test('the deposit card keeps the line to the step titled Add money, and closing the card wipes the code', async () => {
  const world = build({ deposit: true });
  await world.sandbox.PhosphorDeposit.open({ chain: 'eth', symbol: 'ETH' });
  const dialog = find(world.body, 'dialog')[0];
  assert.ok(dialog && dialog.open, 'the deposit card did not open');
  const line = lineOf(dialog);
  assert.ok(line, 'the deposit card has no invite line');
  assert.equal(line.hidden, true, 'the line sits under the address the card opened on');
  // Change network: the tiles, under the title Add money, with the line.
  world.sandbox.PhosphorNetPick.last.go('network');
  assert.equal(find(dialog, '.deposit-title-text')[0].textContent, 'Add money');
  assert.equal(line.hidden, false);
  buttonNamed(dialog, 'Have an invite code?').click();
  lineField(dialog).value = CODE;
  lineField(dialog).dispatch('input');
  world.sandbox.PhosphorDeposit.close();
  assert.equal(dialog.open, false);
  assert.ok(!everything(dialog).includes(CODE), 'the code stayed in the closed card');
  // Opened again, the card draws a fresh line.
  await world.sandbox.PhosphorDeposit.open({ chain: 'eth', symbol: 'ETH' });
  assert.equal(find(dialog, '.invite-line').length, 1);
});
