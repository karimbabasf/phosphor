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
const ALLOWED_BUTTONS = ['chat-globe', 'chat-jump', 'chat-btn chat-halt', 'chat-btn chat-stop', 'chat-btn chat-confirm-yes', 'chat-btn chat-confirm-no', 'chat-btn chat-send'];

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
    /* Element children only, the way the real property counts. Text nodes are children here
       too, and counting them would make the transcript cap fire on the wrong number. */
    get childElementCount() { return node.children.filter((c: Any) => c.tagName !== '#TEXT').length; },
    /* A real setter, because the panel empties the transcript by assigning '' to it and a
       plain field would have kept every row while reporting none.
       The getter walks the children, because an agent answer is no longer one string: it is a
       run of text nodes and lit <b> elements, and a getter that returned only this node's own
       text would report the answer as empty. */
    get textContent() {
      if (node.children.length === 0) return text;
      return node.children.map((c: Any) => c.textContent).join('');
    },
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
  badge: Any;
  tick(ms: number): void;
  find(cls: string): Any;
  rows(): string[];
  facts(): string[];
  phase(): string | null;
}

function load(opts: { startFails?: string; driver?: Any; veilNeverFires?: boolean; intro?: Any } = {}): Harness {
  const created: Any[] = [];
  const posts: Any[] = [];
  const globes: Any[] = [];
  const timers: Array<{ id: number; at: number; fn: () => void }> = [];
  let now = 0;
  let nextTimer = 1;

  const document: Any = {
    createElement: (tag: string) => makeNode(tag, created),
    /* Real text nodes. The panel builds the agent's answer as text nodes with lit <b> elements
       between them rather than as one string, which is how it highlights a figure without ever
       putting a string into the DOM as markup. A harness without this cannot see that. */
    createTextNode: (value: string) => {
      const n = makeNode('#text', created);
      n.textContent = String(value);
      return n;
    },
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
  /* One record per globe, in the order the panel creates them: the idle one that fills the
     panel, then the badge in the corner of the live one. A stub that reported `running: true`
     forever was fine while there was one globe and is not fine now: the panel is entitled to
     ask which of the two is turning, and the answer has to be true. */
  sandbox.PhosphorGlobe = {
    create: () => {
      const calls: string[] = [];
      let on = false;
      const globe: Any = {
        calls,
        drive: null,
        start: () => { if (on) return; on = true; calls.push('start'); },
        stop: () => { on = false; calls.push('stop'); },
        /* A tripwire, and the one method here the real object does not have. ui/agent-globe.js
           dropped `hold` with the badge's dull state, so a panel that reached for it would
           throw in a browser and print a stack about an undefined function. Recorded instead,
           so the test below fails with the reason rather than with the symptom. */
        hold: () => { on = false; calls.push('hold'); },
        tune: (next: Any) => { globe.drive = next; },
        running: () => on,
      };
      globes.push(globe);
      return globe;
    },
  };
  sandbox.PHOSPHOR_RAIN = {
    // The panel hands the fall a host and a callback; the callback is the swap. Fired at once
    // here, which is the same thing the real file does when animation is unavailable.
    // veilNeverFires is the failure this panel has to survive rather than an exotic case: a
    // canvas run that throws, a tab that is thrown away mid-fall, any reason the action never
    // gets called. The panel may not depend on an animation to reach a state a person can use.
    swap: (apply: () => void) => {
      if (!opts.veilNeverFires) apply();
    },
    playing: () => false,
  };

  const context = createContext(sandbox);
  runInContext(SOURCE, context);

  const root = makeNode('div', created);
  const chat = sandbox.PhosphorChat;
  chat.mount(root, { intro: opts.intro ?? ['one', 'two', 'three'], veil: 'rain' });

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

  function all(): Any[] {
    const out: Any[] = [];
    (function walkAll(node: Any) {
      out.push(node);
      for (const c of node.children) walkAll(c);
    })(root);
    return out;
  }

  return {
    chat,
    root,
    created,
    posts,
    // The idle globe is the first one the panel builds and the badge is the second.
    globeCalls: globes[0].calls,
    badge: globes[1],
    facts: () =>
      all()
        .filter((n: Any) => n.className === 'chat-intro-fact')
        .map((n: Any) => (n.getAttribute('data-in') ? '+ ' : '- ') + n.children.map((c: Any) => c.textContent).join(': ')),
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
  const body = row.children[1];
  assert.equal(body.textContent, nasty, 'the tag is held as text, exactly as written');
  /* The answer is built as a run of text nodes with lit <b> elements between them, which is how
     a figure is highlighted without a string ever being parsed. So "it built no elements" is no
     longer the invariant; "it built nothing but those two kinds" is, and it is the stronger one:
     an <img> reaching this list would fail here whether it came from a string or from code. */
  for (const child of body.children) {
    const kind = child.tagName === '#TEXT' ? '#text' : child.tagName + '.' + child.className;
    assert.ok(
      kind === '#text' || kind === 'B.chat-fig',
      `the answer built a ${kind}, and the only things allowed in it are text and a lit figure`,
    );
  }
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

/* THE TEST THE OTHERS COULD NOT BE. Karim hit this twice on 2026-08-20: pressing STOP AGENT took
   the whole composer away and left no way to confirm, cancel or type, and the agent kept running
   because YES was never clickable. Every test above drives `chat-confirm-yes` by firing a click
   at the node, and a click fired at a node whose parent is hidden still runs its handler, so the
   suite was blind to it by construction. This one asks the question the others cannot: is the
   control a person is being asked to press actually on screen. */
function onScreen(node: Any): boolean {
  for (let n: Any = node; n; n = n.parentNode) if (n.hidden) return false;
  return true;
}

test('the question a stop asks is reachable, and so are both of its answers', async () => {
  const h = load();
  h.chat.push({ kind: 'status', state: 'starting' });
  h.tick(1000);
  h.chat.push({ kind: 'status', state: 'ready' });
  assert.equal(onScreen(h.find('chat-input')), true, 'the box is there before the question');

  h.find('chat-stop').fire('click');
  await flush();

  assert.equal(onScreen(h.find('chat-confirm')), true, 'the question is on screen');
  assert.equal(onScreen(h.find('chat-confirm-yes')), true, 'and YES can be pressed');
  assert.equal(onScreen(h.find('chat-confirm-no')), true, 'and so can CANCEL');
  // What hiding the form was for, done to the one element it was ever about.
  assert.equal(onScreen(h.find('chat-input')), false, 'the box is not invited to be typed in');

  h.find('chat-confirm-no').fire('click');
  await flush();
  assert.equal(onScreen(h.find('chat-input')), true, 'cancel gives the box back');
  assert.equal(onScreen(h.find('chat-confirm')), false);
});

test('stopping asks first, and only the second press sends anything', async () => {
  const h = load();
  h.chat.push({ kind: 'status', state: 'starting' });
  h.tick(1000);
  h.chat.push({ kind: 'status', state: 'ready' });

  h.find('chat-stop').fire('click');
  await flush();
  assert.equal(h.find('chat-confirm').hidden, false);
  // The INPUT, not the form. The form is what carries the question, and asserting it was
  // hidden is what let the panel ship with no way to answer.
  assert.equal(h.find('chat-input').hidden, true, 'the prompt box is not live behind a question');
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

/* Karim, 2026-08-20: "once i stop the agent it doesnt quit it and show the globe like I
   wanted, it simply just removes the text input bar."
   That is a panel stuck in `closing`: the form is hidden, the globe is hidden, and the dead
   transcript is still standing. It happens whenever the fall does not call back, and the panel
   had nothing else that could put it right, because setState refuses to act while closing so
   the veil can own the landing. It still owns it when it works. These two are the floor. */
test('a stop lands on the globe even when the fall never calls back', async () => {
  const h = load({ veilNeverFires: true });
  h.chat.push({ kind: 'status', state: 'starting' });
  h.tick(1000);
  h.chat.push({ kind: 'status', state: 'ready' });
  h.chat.push({ kind: 'text', text: 'a line worth losing' });

  h.find('chat-stop').fire('click');
  h.find('chat-confirm-yes').fire('click');
  await flush();
  assert.equal(h.phase(), 'closing', 'the fall is asked for and is holding the panel');

  // The server says the session is gone while the panel is mid-teardown, which is the exact
  // moment the old code dropped the fact on the floor.
  h.chat.push({ kind: 'status', state: 'stopped' });
  h.tick(2000);
  assert.equal(h.phase(), 'idle', 'and it is on the globe anyway');
  assert.equal(h.find('chat-globe').hidden, false);
  assert.equal(h.find('chat-list').children.length, 0, 'with the dead conversation cleared');
});

test('a start that never reports lands on the globe with a reason, not on a printed intro', () => {
  const h = load();
  h.find('chat-globe').fire('click');
  h.tick(1000);
  assert.equal(h.phase(), 'booting', 'the intro prints while the process comes up');

  // Nothing else ever arrives: the event stream dropped, or the child never announced itself.
  h.tick(30000);
  assert.equal(h.phase(), 'idle');
  assert.equal(h.find('chat-globe').hidden, false);
  assert.equal(h.find('chat-globe-sub').textContent, 'the agent did not come up');
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
  /* The panel is put back live one statement before the driver state arrives, which is the one
     moment the badge is up with nothing to report. It draws NOTHING there rather than a dull
     held frame: a light that spins before anything is known is a light that lies, and a light
     dimmed to mean "no agent" is the big globe's sentence said quietly in a corner. The state
     lands in the same synchronous turn, so what a person sees is a badge that starts turning. */
  assert.deepEqual(
    h.badge.calls,
    ['stop', 'stop', 'start'],
    'blank while the state is unknown, turning the moment it lands, and never held dull',
  );
  assert.equal(h.badge.running(), true, 'and it is turning again once the state lands');
});

/** Up, live, and with an answer being written. Three of the four tests below need this. */
function thinking(): Harness {
  const h = load();
  h.chat.push({ kind: 'status', state: 'starting' });
  h.tick(1000);
  h.chat.push({ kind: 'status', state: 'thinking' });
  return h;
}

test('the stop for an answer is there only while there is an answer', () => {
  const h = load();
  const halt = h.find('chat-halt');
  assert.equal(halt.disabled, true, 'nothing to stop before the agent is even up');

  h.chat.push({ kind: 'status', state: 'starting' });
  h.tick(1000);
  assert.equal(halt.disabled, true, 'nor while it is starting');

  h.chat.push({ kind: 'status', state: 'thinking' });
  assert.equal(halt.disabled, false, 'an answer is being written: now it can be stopped');

  h.chat.push({ kind: 'status', state: 'ready' });
  assert.equal(halt.disabled, true, 'the turn ended, so the control goes with it');

  // Disabled, not removed. A control that leaves the bar takes the bar width with it, and the
  // button beside this one is the one that ends the conversation.
  assert.equal(halt.hidden, false);
});

test('stopping an answer is one press and asks nothing', async () => {
  const h = thinking();
  h.find('chat-halt').fire('click');
  await flush();

  const sent = h.posts.filter((p: Any) => p.action !== undefined);
  assert.deepEqual(sent.map((p: Any) => p.action), ['interrupt'], 'one request, and it is the cheap one');
  assert.equal(h.find('chat-confirm').hidden, true, 'no question was asked');
  assert.equal(h.phase(), 'live', 'and the conversation is still standing');
  assert.equal(h.find('chat-halt').disabled, true, 'the press reads as landed before the wire answers');
});

test('escape in the prompt box stops the answer, and passes through when there is none', async () => {
  const h = thinking();
  let stopped = 0;
  h.find('chat-input').fire('keydown', { key: 'Escape', stopPropagation: () => { stopped += 1; } });
  await flush();
  assert.deepEqual(h.posts.map((p: Any) => p.action), ['interrupt']);
  assert.equal(stopped, 1, 'and it is not also read by whatever else on the page listens for Escape');

  // The turn is over. Escape now belongs to the rest of the page.
  h.chat.push({ kind: 'status', state: 'ready' });
  h.find('chat-input').fire('keydown', { key: 'Escape', stopPropagation: () => { stopped += 1; } });
  await flush();
  assert.equal(h.posts.length, 1, 'nothing was sent');
  assert.equal(stopped, 1, 'and the key was left alone');
});

/* ---------- the boot card ----------
   The intro is the app's own statement about the process it just started, and every fact in it
   is checked against operator/driver.settings.json and against assertSurface in src/driver.ts.
   So what these two pin is not that it looks like a card: it is that the facts a window handed
   the panel are the facts on screen, and that a panel handed three plain strings still prints
   three plain rows. The second is not a legacy path. It is what a harness and a console can
   drive, and a panel that can only render a card is a panel nobody can drive by hand. */

const CARD = {
  mark: 'PHOSPHOR',
  title: 'AGENT LINK',
  facts: [
    { label: 'process', value: 'a local agent, spawned under this window' },
    { label: 'tools', value: 'phosphor only, checked on connect' },
    { label: 'denied', value: 'shell, files, web of its own' },
  ],
};

test('the boot card prints its facts, one per beat, and the bar fills with them', () => {
  const h = load({ intro: CARD });
  h.chat.push({ kind: 'status', state: 'starting' });

  // Beat one is the card itself: the frame is on screen and no fact has landed in it yet.
  assert.equal(h.find('chat-intro-mark').textContent, 'PHOSPHOR');
  assert.equal(h.find('chat-intro-title').textContent, 'AGENT LINK');
  assert.deepEqual(h.facts(), [
    '- process: a local agent, spawned under this window',
    '- tools: phosphor only, checked on connect',
    '- denied: shell, files, web of its own',
  ]);
  assert.equal(h.find('chat-intro-fill').style.clipPath, 'inset(0 100% 0 0)', 'nothing is linked yet');

  h.tick(140);
  assert.equal(h.facts()[0].charAt(0), '+', 'the first fact lands on the next beat');
  assert.equal(h.facts()[1].charAt(0), '-', 'and only the first');
  assert.equal(h.find('chat-intro-fill').style.clipPath, 'inset(0 67% 0 0)');

  h.tick(1000);
  assert.deepEqual(h.facts().map((f: string) => f.charAt(0)), ['+', '+', '+']);
  assert.equal(h.find('chat-intro-fill').style.clipPath, 'inset(0 0% 0 0)', 'the link is made');

  // One card, not three rows: the whole print is a single child of the transcript.
  assert.equal(h.find('chat-list').children.length, 1);
});

test('the card is one element and holds no control', () => {
  const h = load({ intro: CARD });
  h.chat.push({ kind: 'status', state: 'starting' });
  h.tick(1000);

  const card = h.find('chat-list').children[0];
  assert.equal(card.className, 'chat-intro');
  function walk(node: Any, out: Any[]): Any[] {
    out.push(node);
    for (const c of node.children) walk(c, out);
    return out;
  }
  const tags = walk(card, []).map((n: Any) => n.tagName);
  assert.equal(tags.includes('BUTTON'), false, 'the panel may never render a control that decides anything');
  assert.equal(tags.includes('A'), false);
  assert.equal(tags.includes('INPUT'), false);
});

test('a panel handed three plain strings still prints three plain rows', () => {
  const h = load(); // the default intro is ['one', 'two', 'three']
  h.chat.push({ kind: 'status', state: 'starting' });
  h.tick(1000);
  assert.deepEqual(h.rows(), ['|one', '|two', '|three']);
  assert.equal(h.facts().length, 0, 'and builds no card at all');
});

/* ---------- the link light ----------
   Karim, 2026-08-20: "a warden globe that glows and is animated when working and dull when
   stopped." It is a status light, so what it has to get right is the state, and there is one
   thing under it that costs real battery: whether it is turning. A badge that keeps turning
   after the agent has stopped is the whole failure.

   THE DULL HALF OF THAT SENTENCE IS THE BIG GLOBE, not a dull badge. `stopped`, `off` and
   `failed` all send the panel to idle, where the badge is hidden and a globe that fills the
   panel is the answer, so a dimmed badge could only ever have been drawn into a corner nobody
   was looking at. The badge now has three settings, one per state a lit panel can be in, and
   anything else takes it off the screen. */

test('the badge has one setting per state a lit panel can be in, and no dull fourth', () => {
  const h = load();
  assert.equal(h.find('chat-badge').hidden, true, 'there is no link to report while the globe is the panel');
  assert.equal(h.badge.running(), false);

  h.chat.push({ kind: 'status', state: 'starting' });
  assert.equal(h.find('chat-badge').hidden, false, 'it is up as soon as something is coming up');
  assert.equal(h.badge.running(), true);

  h.tick(1000);
  h.chat.push({ kind: 'status', state: 'ready' });
  const waiting = h.badge.drive;
  assert.equal(h.badge.running(), true, 'alive, but quiet');

  h.chat.push({ kind: 'status', state: 'thinking' });
  assert.ok(h.badge.drive.rate > waiting.rate, 'working turns faster than waiting');
  assert.ok(h.badge.drive.gain > waiting.gain, 'and burns brighter');

  h.chat.push({ kind: 'status', state: 'ready' });
  assert.deepEqual(h.badge.drive, waiting, 'and drops straight back when the turn ends');
});

test('a stopped agent costs no frames, and the light is put away with the panel', () => {
  const h = load();
  h.chat.push({ kind: 'status', state: 'starting' });
  h.tick(1000);
  h.chat.push({ kind: 'status', state: 'thinking' });
  assert.equal(h.badge.running(), true);

  // failed leaves the phase on the globe, which is where a dead process belongs.
  h.chat.push({ kind: 'status', state: 'failed', detail: 'the agent stopped' });
  h.tick(2000);
  assert.equal(h.phase(), 'idle');
  assert.equal(h.badge.running(), false, 'nothing is turning in a corner nobody can see');
  assert.equal(h.find('chat-badge').hidden, true);
  assert.equal(
    h.badge.calls.includes('hold'),
    false,
    'a dead driver takes the badge off the screen; it never holds a dull frame in a hidden corner',
  );
});

/* The state that used to exist and could not be reached: every way an agent can end sends the
   panel to the globe, so there is no path on which a dimmed badge is on screen. Driven the way
   a real stop drives it, one route per ending, because the three do not share a branch. */
test('every way an agent ends puts the badge away rather than dimming it', async () => {
  for (const ending of ['stopped', 'off', 'failed']) {
    const h = load();
    h.chat.push({ kind: 'status', state: 'starting' });
    h.tick(1000);
    h.chat.push({ kind: 'status', state: 'thinking' });
    assert.equal(h.badge.running(), true, `${ending}: the badge is up while the agent works`);

    h.chat.push({ kind: 'status', state: ending });
    h.tick(2000);
    assert.equal(h.phase(), 'idle', `${ending}: lands on the globe`);
    assert.equal(h.find('chat-badge').hidden, true, `${ending}: and the badge is gone with it`);
    assert.equal(h.badge.calls.includes('hold'), false, `${ending}: never dimmed and kept`);
    assert.equal(h.badge.running(), false, `${ending}: and never left turning`);
  }

  // The human's own stop, which is the route through the veil rather than through a status.
  const h = load();
  h.chat.push({ kind: 'status', state: 'starting' });
  h.tick(1000);
  h.chat.push({ kind: 'status', state: 'ready' });
  h.find('chat-stop').fire('click');
  h.find('chat-confirm-yes').fire('click');
  h.tick(2000);
  await flush();
  assert.equal(h.phase(), 'idle', 'a confirmed stop lands on the globe');
  assert.equal(h.find('chat-badge').hidden, true);
  assert.equal(h.badge.calls.includes('hold'), false);
});

test('exactly one globe turns, whatever the panel is doing', () => {
  const h = load();
  const idle = () => h.globeCalls.at(-1) === 'start';
  const both = () => idle() && h.badge.running();

  assert.equal(both(), false);
  h.chat.push({ kind: 'status', state: 'starting' });
  assert.equal(both(), false, 'the idle globe went the moment the badge arrived');
  h.tick(1000);
  h.chat.push({ kind: 'status', state: 'thinking' });
  assert.equal(both(), false);
  h.chat.push({ kind: 'status', state: 'stopped' });
  h.tick(2000);
  assert.equal(both(), false, 'and the badge went the moment the idle globe came back');
  assert.equal(idle(), true);
  assert.equal(h.badge.running(), false);
});

test('the record says the human stopped the answer', () => {
  const h = thinking();
  // What src/server.ts pushes down the event stream once the turn is cancelled.
  h.chat.push({ kind: 'status', state: 'ready', detail: 'the human stopped this answer' });

  assert.deepEqual(h.rows().at(-1), '|the human stopped this answer');
  const row = h.find('chat-list').children.at(-1);
  assert.equal(row.className, 'chat-row chat-status', 'as a status line, which is the dim one');
});
