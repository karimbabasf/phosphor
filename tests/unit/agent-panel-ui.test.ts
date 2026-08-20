// The agent panel is the one surface in the app whose whole content is written by a language
// model, and it sits in a window that holds an approval button. So these tests are not about
// whether it looks right. They are about the three rules that outrank how it looks:
//
//   - it never renders a control that decides anything. The gate is elsewhere, and an approval
//     button inside a transcript authored by the thing being approved is the design this app
//     exists to argue against;
//   - every string reaches the DOM as text. One innerHTML here is a script-injection surface
//     next to a signing key;
//   - the phase machine always lands somewhere a person can act from. Ready arriving 40ms
//     after the start (which is what actually happens: the driver reports ready on the child's
//     spawn event) must still open the prompt box, and a stop must always end on the globe.
//
// Driven through the file's own public surface, in a vm with a small fake DOM, the same way
// tests/unit/transition-ui.test.ts drives the character fall.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const SOURCE = readFileSync(new URL('../../ui/driver-chat.js', import.meta.url), 'utf8');

/** Every request the panel makes goes through the session token first, so a POST is several
 *  microtasks behind the click that caused it. This drains them. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

type Any = Record<string, any>;

/** Every button the panel is allowed to build, by class. A new one fails this list on purpose:
 *  the point of the list is that adding a control here is a decision somebody had to make. */
const ALLOWED_BUTTONS = ['chat-globe', 'chat-jump', 'chat-btn chat-stop', 'chat-btn chat-confirm-yes', 'chat-btn chat-confirm-no', 'chat-btn chat-send'];

function makeNode(tag: string, created: Any[]): Any {
  let text = '';
  const node: Any = {
    tagName: tag.toUpperCase(),
    className: '',
    hidden: false,
    value: '',
    style: {},
    children: [] as Any[],
    attrs: {} as Record<string, string>,
    listeners: {} as Record<string, Array<(ev: Any) => void>>,
    scrollTop: 0,
    scrollHeight: 400,
    clientHeight: 400,
    parentNode: null as Any | null,
    classList: { add: (c: string) => { node.className = (node.className + ' ' + c).trim(); } },
    appendChild(child: Any) {
      node.children.push(child);
      child.parentNode = node;
      return child;
    },
    removeChild(child: Any) {
      node.children = node.children.filter((c: Any) => c !== child);
      child.parentNode = null;
      return child;
    },
    setAttribute(k: string, v: string) { node.attrs[k] = v; },
    getAttribute(k: string) { return node.attrs[k] ?? null; },
    addEventListener(kind: string, fn: (ev: Any) => void) {
      (node.listeners[kind] ??= []).push(fn);
    },
    focus() { node.focused = true; },
    fire(kind: string, ev: Any = {}) {
      for (const fn of node.listeners[kind] ?? []) fn({ preventDefault() {}, stopPropagation() {}, ...ev });
    },
    get firstChild() { return node.children[0] ?? null; },
    get childElementCount() { return node.children.length; },
    /* A real setter, because the panel empties the transcript by assigning '' to it and a
       plain field would have kept every row while reporting none. */
    get textContent() { return text; },
    set textContent(value: string) {
      text = String(value);
      for (const c of node.children) c.parentNode = null;
      node.children = [];
    },
  };
  created.push(node);
  return node;
}

interface Harness {
  chat: Any;
  root: Any;
  created: Any[];
  posts: Any[];
  globeCalls: string[];
  tick(ms: number): void;
  find(cls: string): Any;
  rows(): string[];
  phase(): string | null;
}

function load(opts: { startFails?: string; driver?: Any } = {}): Harness {
  const created: Any[] = [];
  const posts: Any[] = [];
  const globeCalls: string[] = [];
  const timers: Array<{ id: number; at: number; fn: () => void }> = [];
  let now = 0;
  let nextTimer = 1;

  const document: Any = {
    createElement: (tag: string) => makeNode(tag, created),
    addEventListener: () => {},
    removeEventListener: () => {},
    hidden: false,
    activeElement: null,
  };

  const sandbox: Any = {
    document,
    setTimeout: (fn: () => void, ms: number) => {
      const id = nextTimer++;
      timers.push({ id, at: now + (ms || 0), fn });
      return id;
    },
    clearTimeout: (id: number) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    fetch: (url: string, init?: Any) => {
      if (url === '/api/session') return Promise.resolve({ ok: true, json: () => Promise.resolve({ token: 'T' }) });
      if (url === '/api/driver' && init) {
        const body = JSON.parse(init.body);
        posts.push(body);
        if (body.action === 'start' && opts.startFails !== undefined) {
          return Promise.resolve({ ok: false, json: () => Promise.resolve({ error: opts.startFails }) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(opts.driver ?? { state: 'off', transcript: [] }) });
    },
  };
  sandbox.window = sandbox;
  sandbox.PhosphorGlobe = {
    create: () => ({
      start: () => globeCalls.push('start'),
      stop: () => globeCalls.push('stop'),
      running: () => true,
    }),
  };
  sandbox.PHOSPHOR_RAIN = {
    // The panel hands the fall a host and a callback; the callback is the swap. Fired at once
    // here, which is the same thing the real file does when animation is unavailable.
    swap: (apply: () => void) => apply(),
    playing: () => false,
  };

  const context = createContext(sandbox);
  runInContext(SOURCE, context);

  const root = makeNode('div', created);
  const chat = sandbox.PhosphorChat;
  chat.mount(root, { intro: ['one', 'two', 'three'], veil: 'rain' });

  function walk(node: Any, out: Any[]): Any[] {
    out.push(node);
    for (const c of node.children) walk(c, out);
    return out;
  }
  function find(cls: string): Any {
    const hit = walk(root, []).find((n) => n.className === cls || n.className.split(' ').includes(cls));
    assert.ok(hit, `no element with class ${cls}`);
    return hit;
  }

  return {
    chat,
    root,
    created,
    posts,
    globeCalls,
    tick(ms: number) {
      const until = now + ms;
      for (;;) {
        const next = timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        timers.splice(timers.indexOf(next), 1);
        now = next.at;
        next.fn();
      }
      now = until;
    },
    find,
    rows: () => find('chat-list').children.map((r: Any) => r.children.map((c: Any) => c.textContent).join('|')),
    phase: () => root.getAttribute('data-phase'),
  };
}

test('the panel never builds a control that decides anything', () => {
  const h = load();
  h.chat.push({ kind: 'status', state: 'starting' });
  h.tick(1000);
  h.chat.push({ kind: 'status', state: 'ready' });
  h.chat.push({ kind: 'text', text: 'I would like to send $500 to 0xabc.' });
  h.chat.push({ kind: 'tool', name: 'mcp__phosphor__propose', input: {} });
  h.chat.push({ kind: 'tool_result', name: 'mcp__phosphor__propose', ok: true });
  h.chat.push({ kind: 'error', message: 'nope' });
  h.tick(1000);

  const buttons = h.created.filter((n) => n.tagName === 'BUTTON');
  assert.ok(buttons.length > 0, 'the panel builds no buttons at all, which means this test is not looking at it');
  for (const b of buttons) {
    assert.ok(
      ALLOWED_BUTTONS.includes(b.className),
      `the panel built a button this test does not know about: "${b.className}". If it approves, refuses or arms anything, it does not belong here.`,
    );
  }
});

test('no string reaches the DOM as markup', () => {
  assert.equal(/\.innerHTML\s*=/.test(SOURCE), false, 'driver-chat.js assigns innerHTML');
  assert.equal(/insertAdjacentHTML|outerHTML|document\.write/.test(SOURCE), false);

  const h = load();
  h.chat.push({ kind: 'status', state: 'starting' });
  h.tick(1000);
  h.chat.push({ kind: 'status', state: 'ready' });
  const nasty = '<img src=x onerror="alert(1)">';
  h.chat.push({ kind: 'text', text: nasty });
  const row = h.find('chat-list').children.at(-1);
  assert.equal(row.children[1].textContent, nasty, 'the tag is held as text, exactly as written');
  assert.equal(row.children[1].children.length, 0, 'and it built no elements');
});

test('markdown markers are taken off, and the text is kept', () => {
  const h = load();
  h.chat.push({ kind: 'status', state: 'starting' });
  h.tick(1000);
  h.chat.push({ kind: 'status', state: 'ready' });
  h.chat.push({ kind: 'text', text: '```\n  BANNER\n```\n\nThe kill switch is **off**, see `policy_show`.' });
  const text = h.find('chat-list').children.at(-1).children[1].textContent;
  assert.equal(text.includes('```'), false);
  assert.equal(text.includes('**'), false);
  assert.equal(text.includes('`'), false);
  assert.ok(text.includes('BANNER'));
  assert.ok(text.includes('The kill switch is off, see policy_show.'));
});

test('ready arriving mid-intro still opens the box, and the intro is not cut off', () => {
  const h = load();
  h.chat.push({ kind: 'status', state: 'starting' });
  h.tick(40); // the driver reports ready on the child's spawn event, which is this fast
  h.chat.push({ kind: 'status', state: 'ready' });
  assert.equal(h.phase(), 'booting', 'the box does not open on top of a half-printed intro');
  h.tick(1000);
  assert.equal(h.phase(), 'live');
  assert.deepEqual(h.rows(), ['|one', '|two', '|three'], 'all three intro lines printed');
  assert.equal(h.find('chat-form').hidden, false);
  assert.equal(h.find('chat-input').focused, true);
});

test('a start that is refused lands back on the globe, with the reason on it', async () => {
  const h = load({ startFails: 'the driver is already running' });
  h.find('chat-globe').fire('click');
  assert.equal(h.phase(), 'booting', 'the intro starts printing before the wire answers');
  await flush();
  assert.equal(h.phase(), 'idle');
  assert.equal(h.find('chat-globe-sub').textContent, 'the driver is already running');
  assert.equal(h.find('chat-list').children.length, 0, 'and the transcript is cleared with it');
});

test('stopping asks first, and only the second press sends anything', async () => {
  const h = load();
  h.chat.push({ kind: 'status', state: 'starting' });
  h.tick(1000);
  h.chat.push({ kind: 'status', state: 'ready' });

  h.find('chat-stop').fire('click');
  await flush();
  assert.equal(h.find('chat-confirm').hidden, false);
  assert.equal(h.find('chat-form').hidden, true, 'the prompt box is not live behind a question');
  assert.equal(h.posts.filter((p) => p.action === 'stop').length, 0, 'asking is not stopping');

  h.find('chat-confirm-no').fire('click');
  await flush();
  assert.equal(h.find('chat-confirm').hidden, true);
  assert.equal(h.phase(), 'live', 'cancel puts it back where it was');
  assert.equal(h.posts.filter((p) => p.action === 'stop').length, 0);

  h.find('chat-stop').fire('click');
  h.find('chat-confirm-yes').fire('click');
  h.tick(1000);
  await flush();
  assert.equal(h.posts.filter((p) => p.action === 'stop').length, 1);
  assert.equal(h.phase(), 'idle', 'and it always ends on the globe');
  assert.equal(h.find('chat-list').children.length, 0);
});

test('the globe turns only while the panel is idle', () => {
  const h = load();
  assert.deepEqual(h.globeCalls, ['start'], 'it is turning the moment the panel is mounted');
  h.chat.push({ kind: 'status', state: 'starting' });
  assert.equal(h.globeCalls.at(-1), 'stop', 'and it stops the moment something is starting');
  h.tick(1000);
  h.chat.push({ kind: 'status', state: 'ready' });
  assert.equal(h.globeCalls.at(-1), 'stop');
  h.chat.push({ kind: 'status', state: 'stopped' });
  h.tick(1000);
  assert.equal(h.globeCalls.at(-1), 'start', 'and it is turning again when there is no agent');
});

test('a prompt is sent once, the box is cleared, and the transcript follows the newest line', async () => {
  const h = load();
  h.chat.push({ kind: 'status', state: 'starting' });
  h.tick(1000);
  h.chat.push({ kind: 'status', state: 'ready' });

  const list = h.find('chat-list');
  list.scrollHeight = 4000;
  list.clientHeight = 400;
  list.scrollTop = 0; // the reader is at the top
  list.fire('scroll');
  assert.equal(h.find('chat-jump').hidden, true, 'nothing has arrived yet, so there is nothing to jump to');

  h.chat.push({ kind: 'text', text: 'a line arrives while the reader is up here' });
  assert.equal(h.find('chat-jump').hidden, false, 'a panel that has been left behind says so');

  const input = h.find('chat-input');
  input.value = '  do the thing  ';
  h.find('chat-form').fire('submit');
  assert.equal(input.value, '', 'the box is cleared before the request resolves');
  assert.equal(list.scrollTop, list.scrollHeight, 'your own message always returns to the bottom');
  assert.equal(h.find('chat-jump').hidden, true);
  await flush();
  assert.deepEqual(h.posts.filter((p) => p.action === 'prompt').map((p) => p.text), ['do the thing']);
});

test('a window that opens onto an agent the app started prints the intro anyway', async () => {
  // What autostart leaves behind: the driver is up and the transcript holds nothing but the
  // status events it emitted on the way. Nobody pressed anything, so nobody has seen the intro.
  const h = load({ driver: { state: 'ready', running: true, transcript: [{ kind: 'status', state: 'starting' }, { kind: 'status', state: 'ready' }] } });
  h.chat.load();
  await flush();
  assert.equal(h.phase(), 'booting');
  h.tick(1000);
  assert.equal(h.phase(), 'live');
  assert.deepEqual(h.rows(), ['|one', '|two', '|three']);
  assert.equal(h.find('chat-input').focused, true);
});

test('a reload in the middle of a conversation goes back to the conversation, not to the intro', async () => {
  const h = load({
    driver: {
      state: 'ready',
      running: true,
      transcript: [
        { kind: 'status', state: 'ready' },
        { kind: 'said', text: 'what do I hold?' },
        { kind: 'text', text: 'Nothing on any chain.' },
      ],
    },
  });
  h.chat.load();
  await flush();
  assert.equal(h.phase(), 'live');
  h.tick(1000);
  assert.deepEqual(h.rows(), ['you|what do I hold?', 'agent|Nothing on any chain.']);
});
