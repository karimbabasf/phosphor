// An invite code never reaches the assistant through the chat.
//
// A code in the chat would go to the agent, its model provider and the transcript, so the box
// refuses the code's shape (ui/core/invite.js codeIn, the window's mirror of the backend's
// matcher) as it changes and again at every send, and the send door the cards use refuses it too.
// A refused code leaves the box for the invite field in Add money (ui/screens/invite.js open) and
// one line over the box says why. The real ui/screens/agent.js runs over the column's DOM stub
// (the pattern of agent-transcript-ui.test.ts). Every form the contract names is tried: upper,
// lower, no hyphens, spaces, PH0S and a whole link, and the plain messages that look most like
// one still go.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

import { GUARD_TEXTS } from '../fixtures/invite-code-texts.ts';

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
const DOM_SOURCE = read('../../ui/core/dom.js');
const ADAPTER = read('../../ui/core/invite.js');
const INVITE = read('../../ui/screens/invite.js');
const AGENT_SOURCE = read('../../ui/screens/agent.js');
const MARKDOWN_SOURCE = read('../../ui/core/markdown.js');
const MARKS_SOURCE = read('../../ui/design/marks.js');

type Any = Record<string, any>;

/* A code the shape of a real one. Never funded, never issued. */
const CODE = 'PHOS-2X9QK-M7RTB-0HVFD-K3WPZ-A8GN4CJ';
const BARE = '2X9QKM7RTB0HVFDK3WPZA8GN4CJ';
/* The sentences the contract's shape and its digit rule are tested on (CONTRACTS.md, Code shape). */
const PHOSPHOR = 'how does phosphor handle swaps between eth and near';
const PHOSPHORUS = 'phosphorus is used in fertilizer and in matches';
/* Prose with the shape and two digits: the guard holds it back, as the contract's rule does. */
const PHOSPHATES = 'phosphates cost 25 dollars per ton in 2026 so';

/* ---------- the column's DOM stub ---------- */

function make(tag: string): Any {
  const node: Any = {
    tag,
    className: '',
    children: [] as Any[],
    parentNode: null as unknown as Any,
    attrs: {} as Record<string, string>,
    dataset: {} as Record<string, string>,
    hidden: false,
    style: { setProperty(name: string, value: string) { node.style[name] = value; } } as Any,
    rows: 1,
    value: '',
    disabled: false,
    offsetHeight: 40,
    clientHeight: 38,
    scrollHeight: 38,
    scrollTop: 0,
    __on: {} as Record<string, Array<(event?: unknown) => void>>,
  };
  Object.defineProperty(node, 'textContent', {
    get(): string {
      if (node.children.length === 0) return node.__text ?? '';
      return node.children.map((c: Any) => c.textContent).join('');
    },
    set(value: string) {
      node.children.length = 0;
      node.__text = String(value);
    },
  });
  Object.defineProperty(node, 'firstChild', { get: () => node.children[0] ?? null });
  Object.defineProperty(node, 'lastChild', { get: () => node.children[node.children.length - 1] ?? null });
  Object.defineProperty(node, 'nextSibling', {
    get(): Any | null {
      const parent = node.parentNode;
      if (!parent) return null;
      const at = parent.children.indexOf(node);
      return at === -1 ? null : parent.children[at + 1] ?? null;
    },
  });
  node.appendChild = (child: Any) => node.insertBefore(child, null);
  node.insertBefore = (child: Any, before: Any) => {
    if (child.parentNode) child.parentNode.removeChild(child);
    const at = before === null ? node.children.length : node.children.indexOf(before);
    node.children.splice(at === -1 ? node.children.length : at, 0, child);
    child.parentNode = node;
    return child;
  };
  node.removeChild = (child: Any) => {
    const at = node.children.indexOf(child);
    if (at !== -1) node.children.splice(at, 1);
    child.parentNode = null;
    return child;
  };
  node.setAttribute = (name: string, value: string) => { node.attrs[name] = String(value); };
  node.getAttribute = (name: string) => (name in node.attrs ? node.attrs[name] : null);
  node.hasAttribute = (name: string) => name in node.attrs;
  node.removeAttribute = (name: string) => { delete node.attrs[name]; };
  node.addEventListener = (type: string, handler: (event?: unknown) => void) => { (node.__on[type] ??= []).push(handler); };
  node.removeEventListener = () => {};
  node.querySelector = (selector: string) => {
    if (!selector.startsWith('.')) return null;
    for (const child of node.children) {
      const found = all(child, selector.slice(1))[0];
      if (found) return found;
    }
    return null;
  };
  node.scrollTo = (opts: { top: number }) => { node.scrollTop = opts.top; };
  node.focus = () => { node.focused = true; };
  return node;
}

function fire(node: Any, type: string, event: Record<string, unknown> = {}): void {
  for (const handler of node.__on[type] ?? []) handler({ preventDefault: () => {}, ...event });
}

function all(node: Any, className: string, found: Any[] = []): Any[] {
  if (String(node.className).split(' ').includes(className)) found.push(node);
  for (const child of node.children) all(child, className, found);
  return found;
}

/* ---------- the window ---------- */

function build(view = 'basic') {
  const sends: string[] = [];
  const handed: Array<{ screen: string; code: string }> = [];
  const views: string[] = [];
  const driverHandlers: Array<(frame: unknown) => void> = [];
  const host = make('div');
  const composerHost = make('div');

  const sandbox: Any = {
    console,
    navigator: {},
    document: { createElement: (tag: string) => make(tag), addEventListener: () => {}, documentElement: { dataset: {} }, body: make('body') },
  };
  const win: Any = {
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    getComputedStyle: () => ({ lineHeight: '21px', paddingTop: '8px', paddingBottom: '8px' }),
    dispatchEvent: () => true,
    addEventListener: () => {},
    PhosphorNet: { readable: (e: Error) => String(e.message), postJson: () => Promise.reject(new Error('no network in this test')) },
    PhosphorShell: {
      setPending: () => {},
      view: () => view,
      setView: (name: string) => { views.push(name); view = name; },
    },
    PhosphorToast: { show: () => {} },
    PhosphorApi: {
      driver: (body: { action: string; text?: string }) => {
        if (body.action === 'prompt') sends.push(String(body.text));
        return Promise.resolve({});
      },
      driverState: () => Promise.resolve({ data: { state: 'ready', chats: [{ id: 'c1', transcript: [] }] } }),
      connection: () => Promise.resolve({ command: '', connected: [] }),
    },
    PhosphorEvents: {
      on: (type: string, handler: (frame: unknown) => void) => {
        if (type === 'driver') driverHandlers.push(handler);
        return () => {};
      },
    },
    PhosphorIcons: { svg: (name: string, className: string) => { const n = make('svg'); n.className = 'icon ' + (className || ''); n.setAttribute('data-icon', name); return n; } },
    PhosphorMotion: { reduced: () => false, spring: () => 'linear', animate: () => ({ finished: Promise.resolve(), stop: () => {} }) },
    PhosphorState: { select: () => () => {} },
    /* Where a refused code is handed: the screens' Add money, recorded. */
    PhosphorBasic: { addMoney: (opts: Any) => { handed.push({ screen: 'basic', code: opts.invite }); } },
    PhosphorPro: { addMoney: (opts: Any) => { handed.push({ screen: 'pro', code: opts.invite }); } },
  };
  sandbox.window = win;
  sandbox.CustomEvent = function CustomEventStub(this: Any, type: string) { this.type = type; };
  createContext(sandbox);
  runInContext(DOM_SOURCE, sandbox, { filename: 'ui/core/dom.js' });
  runInContext(ADAPTER, sandbox, { filename: 'ui/core/invite.js' });
  runInContext(INVITE, sandbox, { filename: 'ui/screens/invite.js' });
  runInContext(MARKS_SOURCE, sandbox, { filename: 'ui/design/marks.js' });
  runInContext(MARKDOWN_SOURCE, sandbox, { filename: 'ui/core/markdown.js' });
  runInContext(AGENT_SOURCE, sandbox, { filename: 'ui/screens/agent.js' });

  const agent = win.PhosphorAgent;
  agent.mount(host, { composerHost });
  agent.start();
  for (const handler of driverHandlers) handler({ chat: 'c1', event: { kind: 'status', state: 'ready' } });

  const composer = all(composerHost, 'agent-composer')[0];
  const input = all(composerHost, 'composer-input')[0];
  const aside = all(composerHost, 'composer-aside')[0];
  return {
    win,
    host,
    sends,
    handed,
    views,
    input,
    aside,
    /* Typed, then sent with Enter or the send arrow. */
    send(text: string) {
      input.value = text;
      fire(composer, 'submit');
    },
    /* Pasted: the value lands and the box hears it changed. */
    paste(text: string) {
      input.value = text;
      fire(input, 'input');
    },
    said: () => all(host, 'chat-said').map((n: Any) => n.textContent),
    asideText: () => (aside.hidden ? '' : aside.textContent),
  };
}

const LINE = 'Invite codes never go to your assistant. Yours is waiting in Add money.';

/* Every form the contract names, plus the two a person is most likely to send: a code in a
   sentence and one broken over lines. */
/* What the box keeps of each: the code goes, the person's own words stay. */
const LEFT: Record<string, string> = {
  'a whole link': 'https://phosphor.money/invite#',
  'in a sentence': 'hey, here is my invite: thanks!',
};

const FORMS: Array<[string, string]> = [
  ['upper', CODE],
  ['lower', CODE.toLowerCase()],
  ['no hyphens', 'PHOS' + BARE],
  ['spaces', 'PHOS 2X9QK M7RTB 0HVFD K3WPZ A8GN4CJ'],
  ['PH0S', 'PH0S-2X9QK-M7RTB-0HVFD-K3WPZ-A8GN4CJ'],
  ['a whole link', 'https://phosphor.money/invite#' + CODE],
  ['in a sentence', 'hey, here is my invite: phos-2x9qk-m7rtb-0hvfd-k3wpz-a8gn4cj thanks!'],
  ['over lines', 'PHOS-2X9QK-M7RTB\n0HVFD-K3WPZ-A8GN4CJ'],
  ['hyphens and spaces', 'phos - 2x9qk - m7rtb - 0hvfd - k3wpz - a8gn4cj'],
  ['no-break spaces', 'PHOS\u00a02X9QK\u00a0M7RTB\u00a00HVFD\u00a0K3WPZ\u00a0A8GN4CJ'],
];

test('every form of a code is kept out of the chat at send, and goes to the invite field instead', () => {
  for (const [name, text] of FORMS) {
    const world = build();
    world.send(text);
    assert.deepEqual(world.sends, [], `${name}: the code was sent to the assistant`);
    assert.deepEqual(world.said(), [], `${name}: the code landed in the transcript`);
    assert.equal(world.input.value, LEFT[name] ?? '', `${name}: the box kept the wrong words`);
    assert.equal(world.asideText(), LINE, `${name}: nothing said why`);
    assert.equal(world.handed.length, 1, `${name}: the code did not go to Add money`);
    assert.equal(world.handed[0].screen, 'basic');
    const kept = world.handed[0].code.replace(/[\s-]/g, '').toUpperCase().replace(/^PH0S/, 'PHOS');
    assert.equal(kept, 'PHOS' + BARE, `${name}: Add money got something other than the code: ${world.handed[0].code}`);
  }
});

test('a pasted code leaves the box the moment it lands, before anything can send it', () => {
  for (const [name, text] of FORMS) {
    const world = build();
    world.paste(text);
    assert.equal(world.input.value, LEFT[name] ?? '', `${name}: the pasted code sat in the box`);
    assert.equal(world.asideText(), LINE);
    assert.equal(world.handed.length, 1);
    assert.deepEqual(world.sends, [], `${name}: something was sent`);
    // What is left is the person's to send, and it holds no code.
    world.send(world.input.value);
    assert.deepEqual(world.sends, LEFT[name] ? [LEFT[name]] : [], `${name}: the words left were not sent as they stood`);
  }
});

test('the guard takes out only what the matcher found, every match, and leaves the person\'s other words', () => {
  const shape = (world: Any): Any => world.win.PhosphorInviteApi;
  for (const { name, text, code } of GUARD_TEXTS) {
    if (!code) continue;
    const world = build();
    world.paste(text);
    const left = world.input.value;
    assert.equal(shape(world).codeIn(left), null, `${name}: a code is still in the box`);
    assert.equal(world.asideText(), LINE, `${name}: nothing said why`);
    assert.deepEqual(world.sends, [], `${name}: something was sent`);
    // Every character left was in the text, in order: nothing was added but a space at a seam.
    let from = 0;
    for (const ch of left) {
      const at = text.indexOf(ch, from);
      assert.ok(ch === ' ' || at >= 0, `${name}: the box gained a character`);
      if (at >= 0) from = at + 1;
    }
  }
  const exact: Array<[string, string]> = [
    ['phosphorus is used in fertilizer and in matches ' + CODE, PHOSPHORUS],
    ['two codes: ' + CODE + ' and ' + CODE.toLowerCase() + ' for you', 'two codes: and for you'],
    ['my code\n' + CODE + '\nsee you', 'my code see you'],
  ];
  for (const [text, words] of exact) {
    const world = build();
    world.paste(text);
    assert.equal(world.input.value, words);
    assert.equal(world.handed.length, 1);
    assert.deepEqual(world.sends, []);
  }
  // A code from a card's Try again leaves the person's draft alone.
  const draft = build();
  draft.paste('swap 10 usdc to eth');
  assert.equal(draft.win.PhosphorAgent.send('try again with ' + CODE), false);
  assert.equal(draft.input.value, 'swap 10 usdc to eth', 'the draft went with a code it never held');
});

test('the plain messages that look most like a code still go, and the line goes with the next key', () => {
  const plain = [
    'Phosphor send 50 usdc to my wallet please',
    'Phosphor what is my balance today please and thanks',
    'phosphate and phosphorus prices over the last thirty days',
    'What is PHOS?',
    'PHOS-2X9QK-M7RTB-0HVFD',
    'Phosphor-powered wallets are my favourite thing to talk about today',
    PHOSPHOR,
    PHOSPHORUS,
  ];
  const world = build();
  for (const text of plain) world.send(text);
  assert.deepEqual(world.sends, plain, 'a plain message was refused as a code');
  assert.equal(world.handed.length, 0);
  assert.equal(world.asideText(), '');

  world.paste(CODE);
  assert.equal(world.asideText(), LINE);
  world.paste('h');
  assert.equal(world.asideText(), '', 'the line stayed after the next key');
});

test('the send door the cards use refuses a code too', () => {
  const world = build();
  assert.equal(world.win.PhosphorAgent.send('try again with ' + CODE), false);
  assert.deepEqual(world.sends, []);
  assert.equal(world.handed.length, 1);
  assert.equal(world.win.PhosphorAgent.send('Try that swap again.'), true);
  assert.deepEqual(world.sends, ['Try that swap again.']);
});

test('the field opens on the tab the person is on when it has Add money, and on Basic otherwise', () => {
  const pro = build('pro');
  pro.send(CODE);
  assert.deepEqual(pro.handed.map((h) => h.screen), ['pro']);
  assert.deepEqual(pro.views, [], 'Pro was switched away from');
  for (const view of ['trade', 'vault']) {
    const world = build(view);
    world.send(CODE);
    assert.deepEqual(world.views, ['basic'], `${view}: did not go to Basic`);
    assert.deepEqual(world.handed.map((h) => h.screen), ['basic']);
  }
});

test('the matcher is the contract\'s composer guard: the canonical shape and two digits in the whole match', () => {
  const world = build();
  const codeIn = world.win.PhosphorInviteApi.codeIn;
  // Exactly the shape CONTRACTS.md and src/invite/code.ts write, with its flags.
  const CANONICAL = String.raw`PH[O0]S(?:[\s-]+|(?=[0-9A-Z]{5}))[0-9A-Z](?:[\s-]*[0-9A-Z]){26}(?![0-9A-Z])`;
  assert.ok(ADAPTER.includes(`/${CANONICAL}/gi`), 'ui/core/invite.js does not carry the canonical regex exactly');
  const shape = new RegExp(CANONICAL, 'i');
  for (const [name, text] of FORMS) {
    assert.ok(shape.test(text), `${name}: the canonical shape misses it, so the form list is wrong`);
    assert.ok(codeIn(text), `${name} was not found`);
  }
  // The word Phosphor is PHOS and letters: the shape alone keeps it out.
  assert.equal(shape.test(PHOSPHOR), false);
  assert.equal(codeIn(PHOSPHOR), null);
  // Prose that fills the shape with letters alone is a message.
  assert.ok(shape.test(PHOSPHORUS), 'the sentence no longer fills the shape, so this case proves nothing');
  assert.equal(codeIn(PHOSPHORUS), null);

  /* 27 data characters behind the prefix, built to sit on either side of the rule. */
  const data = (prefix: string, text: string): string => {
    assert.equal(text.length, 27, `a test code has ${text.length} data characters`);
    return prefix + '-' + text;
  };
  const letters = 'ABCDEFGHJKMNPQRSTVWXYZABCDE';
  // Two digits as typed; one is not enough, and an O, I or L is a letter here.
  assert.equal(codeIn(data('PHOS', letters)), null);
  assert.equal(codeIn(data('PHOS', '2' + letters.slice(0, 26))), null, 'one digit was taken for a code');
  assert.ok(codeIn(data('PHOS', '2' + letters.slice(0, 25) + '7')), 'two digits were let through');
  assert.equal(codeIn(data('PHOS', 'OIL' + letters.slice(0, 23) + '7')), null, 'an O, I or L was counted as a digit');
  // The whole match is counted, so the zero of PH0S is one of the two.
  assert.ok(codeIn(data('PH0S', '2' + letters.slice(0, 26))), 'the zero of PH0S was not counted');
  // The first data character is not looked at: the layout fact is not part of the rule.
  for (const first of ['8', '9', 'P', 'Z', 'a']) {
    assert.ok(codeIn(data('PHOS', first + BARE.slice(1))), `a code starting ${first} went through`);
  }
  // So prose with the shape and two digits is held back too: the rule's known cost.
  assert.ok(shape.test(PHOSPHATES));
  assert.ok(codeIn(PHOSPHATES), 'the guard is looser than the contract');
  // Too short, the wrong prefix, a data character after the 27th, or nothing at all.
  assert.equal(codeIn('PHOS-2X9QK-M7RTB-0HVFD-K3WPZ-A8GN4C'), null);
  assert.equal(codeIn('PHAS-' + BARE), null);
  assert.equal(codeIn(CODE + 'X'), null);
  assert.equal(codeIn(''), null);
  assert.equal(codeIn(null), null);
  // Prose that fills the shape does not hide a code after it.
  assert.ok(codeIn(PHOSPHORUS + ' ' + CODE));
  assert.ok(codeIn('phosphor phosphor ' + CODE));
  // A long paste costs nothing: one pass, no backtracking blow-up.
  const started = Date.now();
  codeIn('phos ' + 'a '.repeat(50_000));
  codeIn('phos'.repeat(20_000));
  assert.ok(Date.now() - started < 500, 'the matcher is slow on a long paste');
});
