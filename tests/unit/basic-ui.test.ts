// The balances panel, and what keeps it honest.
//
// The panel is a total, a caption, one row per coin and one way to add money. Each part is a
// place to lie to someone who has never held a wallet: a dollar figure for a coin nobody can
// price, a row that glows when nothing moved, a list that reads as empty while it is loading.
//
// It drives the real ui/screens/basic.js (with ui/core/dom.js, ui/core/state.js and
// ui/design/marks.js beside it) against a DOM small enough to read: the node operations those
// files use, nothing more, so the assertions are about the panel rather than a framework.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

type Any = Record<string, any>;

const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
const DOM_SOURCE = read('../../ui/core/dom.js');
const STATE_SOURCE = read('../../ui/core/state.js');
const MARKS_SOURCE = read('../../ui/design/marks.js');
const BASIC_SOURCE = read('../../ui/screens/basic.js');

function make(tag: string): Any {
  const props: Record<string, string> = {};
  const node: Any = {
    tag,
    className: '',
    children: [] as Any[],
    parentNode: null as Any | null,
    attrs: {} as Record<string, string>,
    dataset: {} as Record<string, string>,
    hidden: false,
    style: {
      props,
      setProperty: (name: string, value: string) => { props[name] = value; },
      removeProperty: (name: string) => { delete props[name]; },
    },
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
  node.addEventListener = (type: string, handler: (event?: unknown) => void) => {
    (node.__on[type] ??= []).push(handler);
  };
  node.removeEventListener = () => {};
  node.focus = () => { node.focused = true; };
  node.querySelector = () => null;
  return node;
}

/* Every node carrying a class, flattened. An svg built in its namespace takes its class by
   attribute, so both spellings count. */
function all(node: Any, className: string, found: Any[] = []): Any[] {
  const classes = `${node.className} ${node.attrs.class ?? ''}`.split(' ');
  if (classes.includes(className)) found.push(node);
  for (const child of node.children) all(child, className, found);
  return found;
}

function click(node: Any): void {
  for (const handler of node.__on.click ?? []) handler({ preventDefault: () => {} });
}

type Holding = { symbol: string; name: string; quantityLine: string; valueLine: string | null; valueUsd: number | null };

function coin(symbol: string, valueUsd: number | null, quantityLine: string, name = symbol): Holding {
  return { symbol, name, quantityLine, valueUsd, valueLine: valueUsd === null ? null : `$${valueUsd.toFixed(2)}` };
}

function frame(totalLine: string, holdings: Holding[], over: Any = {}): Any {
  return {
    basic: { totalUsd: 1000, totalLine, caption: 'in your balance', warning: null, holdings, smallLine: null, emptyLine: null, ...over },
    proposals: [],
    lock: { state: 'unlocked' },
    wallet: { stale: [] },
  };
}

function build(options: { loaded?: boolean } = {}) {
  const host = make('section');
  const timers: Array<{ id: number; fn: () => void; ms: number }> = [];
  const calls: Any[] = [];
  let seq = 0;
  const win: Any = {
    setTimeout: (fn: () => void, ms: number) => { seq += 1; timers.push({ id: seq, fn, ms }); return seq; },
    clearTimeout: (id: number) => {
      const at = timers.findIndex((t) => t.id === id);
      if (at !== -1) timers.splice(at, 1);
    },
    addEventListener: () => {},
    PhosphorMotion: { reduced: () => false },
    PhosphorMoneyIn: {
      render: (target: Any, opts: Any) => {
        calls.push({ route: 'moneyin.render', opts });
        target.appendChild(make('div'));
        return { destroy: () => calls.push({ route: 'moneyin.destroy' }) };
      },
    },
    PhosphorIcons: { svg: (name: string) => { const n = make('svg'); n.className = 'icon'; n.dataset.icon = name; return n; } },
  };
  const sandbox: Any = {
    console,
    window: win,
    document: {
      createElement: (tag: string) => make(tag),
      createElementNS: (_ns: string, tag: string) => make(tag),
      getElementById: (id: string) => (id === 'view-basic' ? host : null),
    },
  };
  createContext(sandbox);
  runInContext(DOM_SOURCE, sandbox, { filename: 'ui/core/dom.js' });
  runInContext(STATE_SOURCE, sandbox, { filename: 'ui/core/state.js' });
  runInContext(MARKS_SOURCE, sandbox, { filename: 'ui/design/marks.js' });
  runInContext(BASIC_SOURCE, sandbox, { filename: 'ui/screens/basic.js' });
  win.PhosphorBasic.boot();
  if (options.loaded === false) win.PhosphorState.loaded = () => false;

  return {
    host,
    calls,
    timers,
    put: (state: Any) => win.PhosphorState.put(state),
    one: (className: string) => all(host, className)[0],
    rows: () => all(host, 'bal-row'),
    row: (symbol: string): Any => all(host, 'bal-row').find((r) => r.dataset.key === symbol)!,
    runTimers() {
      const due = timers.splice(0, timers.length);
      for (const timer of due) timer.fn();
    },
  };
}

const COINS = [
  coin('USDC', 6200, '6,200.00', 'US dollars (USDC)'),
  coin('ETH', 3785.1, '1.42', 'Ether (ETH)'),
  coin('NEAR', 1372.41, '310.50'),
];

test('the total is the figure and the caption under it, both from the view', () => {
  const panel = build();
  panel.put(frame('$11,357.51', COINS));
  const total = panel.one('bal-total');
  assert.equal(total.textContent, '$11,357.51');
  assert.ok(total.className.split(' ').includes('num'), 'the total is not set as a figure (Geist, tabular lining numerals)');
  assert.equal(panel.one('bal-caption').textContent, 'in your balance');

  panel.put(frame('$11,357.51', COINS, { caption: 'checking your new balance' }));
  assert.equal(panel.one('bal-caption').textContent, 'checking your new balance');
});

/* Soft depth (Karim picked it on 2026-09-23): the total sits inside a ring that splits it by coin.
   Each priced coin is one piece, in the order the list reads, sized by its share; a coin too
   small to draw as more than a dot joins "the rest"; a coin whose brand is green wears the neutral
   because green is the app's own light. */
function pieceLength(piece: Any): number {
  return Number(String(piece.style.strokeDasharray ?? '').split(' ')[0]);
}

test('the ring splits the total by coin, largest first, and a sliver joins the rest', () => {
  const panel = build();
  panel.put(frame('$11,407.51', [...COINS, coin('SOL', 50, '0.30')]));
  const pieces = all(panel.host, 'bal-ring-piece');
  assert.equal(pieces.length, 4, 'USDC, ETH, NEAR and the rest');
  const [usdc, eth, near, rest] = pieces.map(pieceLength);
  assert.ok(usdc! > eth! && eth! > near! && near! > rest!, 'the pieces are not in the order the list reads');
  assert.ok(Math.abs(usdc! / eth! - (6200 - 0) / 3785.1) < 0.2, 'a piece is not sized by its share');
  assert.equal(pieces[2].style.stroke, '#e6ddd2', 'NEAR painted the ring green, the app\'s own light');
  assert.equal(pieces[3].style.stroke, '#e6ddd2', 'the rest is not the neutral');
  assert.notEqual(pieces[0].style.stroke, '#e6ddd2', 'USDC lost its own colour');

  panel.put(frame('$11,407.51', [coin('USDC', 5700, '5,700.00'), coin('ETH', 4285.1, '1.61'), COINS[2]!, coin('SOL', 50, '0.30')]));
  const after = all(panel.host, 'bal-ring-piece');
  assert.equal(after[0], pieces[0], 'a piece was rebuilt rather than moved to the new split');
  assert.ok(pieceLength(after[0]) < usdc!, 'USDC\'s piece did not shrink with the swap');
});

test('one coin is the whole ring, and an empty wallet draws only the track', () => {
  const panel = build();
  panel.put(frame('$6,200.00', [COINS[0]!]));
  const pieces = all(panel.host, 'bal-ring-piece');
  assert.equal(pieces.length, 1);
  assert.ok(pieceLength(pieces[0]) > 678, 'one coin does not close the ring');

  const empty = build();
  empty.put(frame('$0.00', [], { emptyLine: 'Nothing here yet. Money you add shows up here as it lands.' }));
  assert.equal(all(empty.host, 'bal-ring-piece').length, 0);
  assert.equal(all(empty.host, 'bal-ring-track').length, 1);
});

test('a short caption sits in the disc under the figure, a long one under the ring', () => {
  const panel = build();
  panel.put(frame('$11,357.51', COINS));
  assert.equal(panel.one('bal-caption').parentNode, panel.one('bal-centre'));
  assert.equal(panel.one('bal-under').hidden, true);

  panel.put(frame('$11,357.51', COINS, { caption: 'in your balance, not counting WIF and BONK' }));
  assert.equal(panel.one('bal-caption').parentNode, panel.one('bal-under'));
  assert.equal(panel.one('bal-under').hidden, false);
});

test('each tile carries its coin\'s colour, and a green brand wears the neutral at half strength', () => {
  const panel = build();
  panel.put(frame('$11,957.51', [...COINS, coin('BTC', 600, '0.0053')]));
  assert.equal(panel.row('USDC').style.props['--tint'], '#3b8cff', 'USDC lost the blue it is told apart from ETH by');
  assert.match(panel.row('BTC').style.props['--tint'] ?? '', /^hsl\(3\d, /, 'BTC is not its own orange, lifted');
  assert.equal(panel.row('NEAR').style.props['--tint'], '#e6ddd2');
  assert.equal(panel.row('NEAR').style.props['--tint-share'], '12%');
});

test('one row per coin: its mark, its symbol, how much of it, and the dollars at the right', () => {
  const panel = build();
  panel.put(frame('$11,357.51', COINS));
  assert.deepEqual(panel.rows().map((r) => r.dataset.key), ['USDC', 'ETH', 'NEAR']);
  const eth = panel.row('ETH');
  assert.equal(all(eth, 'bal-sym')[0].textContent, 'ETH');
  assert.equal(all(eth, 'bal-amt')[0].textContent, '1.42');
  assert.equal(all(eth, 'bal-usd')[0].textContent, '$3785.10');
  assert.equal(eth.getAttribute('aria-label'), 'Ether (ETH), 1.42, $3785.10', 'a screen reader hears the plain name and both figures');
  assert.equal(eth.children[0], all(eth, 'bal-coin')[0], 'the mark leads the row');
});

/* Karim, 2026-09-23, on a dim glyph in a tinted ring and a generic target for WBTC: the logos
   are shit. A row's mark is the coin's own logo file, drawn as its brand draws it, and nothing
   sits behind it. */
function markOf(panel: ReturnType<typeof build>, symbol: string): Any {
  return all(panel.row(symbol), 'bal-coin')[0];
}

test('each row draws its coin\'s own logo file, WBTC included, with no disc behind it', () => {
  const panel = build();
  panel.put(frame('$11,357.51', [...COINS, coin('SOL', 800, '4.10'), coin('WBTC', 600, '0.0061')]));
  for (const [symbol, file] of [['USDC', 'usdc'], ['ETH', 'eth'], ['SOL', 'sol'], ['WBTC', 'wbtc']]) {
    const mark = markOf(panel, symbol!);
    assert.ok(mark.className.split(' ').includes('logo'), `${symbol}: the mark is the shared logo`);
    assert.equal(mark.getAttribute('data-token'), symbol);
    assert.equal(mark.getAttribute('data-fallback'), null, `${symbol} drew its monogram`);
    assert.equal(mark.children.length, 1);
    assert.equal(mark.children[0].tag, 'img');
    assert.equal(mark.children[0].src, `./logos/${file}.svg`);
    assert.equal(all(mark, 'logo-initial').length, 0);
  }
});

test('wNEAR draws NEAR\'s logo and keeps its own symbol', () => {
  const panel = build();
  panel.put(frame('$1,372.41', [coin('wNEAR', 1372.41, '310.50', 'Wrapped NEAR (wNEAR)')]));
  const mark = markOf(panel, 'wNEAR');
  assert.equal(mark.getAttribute('data-token'), 'NEAR');
  assert.equal(mark.children[0].src, './logos/near.svg');
  assert.equal(all(panel.row('wNEAR'), 'bal-sym')[0].textContent, 'wNEAR');
});

test('a coin with no logo draws its first letter on a neutral disc, never a stand-in glyph', () => {
  const panel = build();
  panel.put(frame('$1,000.00', [coin('$WIF', 1000, '400.00'), coin('PENGU', null, '9,000')]));
  for (const [symbol, letter] of [['$WIF', 'W'], ['PENGU', 'P']]) {
    const mark = markOf(panel, symbol!);
    assert.equal(mark.getAttribute('data-fallback'), 'true');
    assert.equal(all(mark, 'img').length + mark.children.filter((c: Any) => c.tag === 'img').length, 0, `${symbol} asked for a file that is not there`);
    const initial = all(mark, 'logo-initial')[0];
    assert.equal(initial.textContent, letter);
    assert.ok(!initial.className.split(' ').includes('mono'), 'the monogram is in the UI face');
  }
});

test('a coin with no price says "price unavailable", never $0.00', () => {
  const panel = build();
  panel.put(frame('$6,200.00', [COINS[0]!, coin('WIF', null, '12.50')], { caption: 'in your balance, not counting WIF' }));
  const usd = all(panel.row('WIF'), 'bal-usd')[0];
  assert.equal(usd.textContent, 'price unavailable');
  assert.equal(usd.getAttribute('data-unpriced'), 'true');
  assert.doesNotMatch(panel.host.textContent, /\$0\.00/);
  assert.equal(panel.one('bal-caption').textContent, 'in your balance, not counting WIF');
});

test('a row that moved rolls to its new figure and lights once, then decays', () => {
  const panel = build();
  panel.put(frame('$11,357.51', COINS));
  const usdc = panel.row('USDC');
  assert.equal(usdc.dataset.lit, undefined, 'the first fill is not a change');
  panel.runTimers();

  panel.put(frame('$10,857.51', [coin('USDC', 5700, '5,700.00', 'US dollars (USDC)'), COINS[1]!, COINS[2]!]));
  assert.equal(panel.row('USDC'), usdc, 'the row kept its identity across a render');
  assert.equal(all(usdc, 'bal-usd')[0].textContent, '$5700.00');
  assert.equal(usdc.dataset.lit, 'true', 'the row that moved did not light');
  assert.equal(panel.row('ETH').dataset.lit, undefined, 'a row that did not move lit');
  const light = panel.timers.find((t) => t.ms === 120);
  assert.ok(light, 'the light comes in over 120 ms before it starts to decay');
  panel.runTimers();
  assert.equal(usdc.dataset.lit, undefined, 'the light never left');
});

test('the light arrives and decays on the two glow tokens', () => {
  const css = read('../../ui/design/basic.css');
  assert.match(css, /\.bal-row\[data-lit="true"\]::before\s*\{[^}]*transition-duration:\s*var\(--dur-glow-in\);/, 'the light does not arrive in 120 ms');
  assert.match(css, /\.bal-row::before\s*\{[^}]*transition:\s*opacity var\(--dur-glow-out\)/, 'the light does not decay over 2.4 s');
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(reduced, /\.bal-row::before \{ display: none; \}/, 'the light still runs under reduced motion');
});

test('balances under a cent fold into one quiet line', () => {
  const panel = build();
  panel.put(frame('$11,357.51', COINS));
  assert.equal(panel.one('bal-small').hidden, true);
  panel.put(frame('$11,357.51', COINS, { smallLine: '2 tiny balances under a cent, not listed' }));
  assert.equal(panel.one('bal-small').hidden, false);
  assert.equal(panel.one('bal-small').textContent, '2 tiny balances under a cent, not listed');
});

test('an empty wallet is a calm sentence, and the list waits while the first read is out', () => {
  const loading = build({ loaded: false });
  loading.put(frame('', [], { emptyLine: 'Nothing here yet. Money you add shows up here as it lands.' }));
  assert.equal(loading.one('bal-empty').hidden, true, 'an empty list before the first read would say the wallet is empty');
  assert.ok(all(loading.host, 'skel').length > 0, 'the list shows it is loading');

  const panel = build();
  panel.put(frame('$0.00', [], { emptyLine: 'Nothing here yet. Money you add shows up here as it lands.' }));
  assert.equal(panel.rows().length, 0);
  assert.equal(panel.one('bal-empty').hidden, false);
  assert.equal(panel.one('bal-empty').textContent, 'Nothing here yet. Money you add shows up here as it lands.');
  assert.equal(all(panel.host, 'skel').length, 0, 'the skeleton left once the read arrived');
  /* The empty wallet's one thing to do is the slab's main key (hunt A, 2026-09-23). */
  assert.equal(panel.one('bal').getAttribute('data-empty'), 'true', 'Add money is a quiet key on an empty wallet');
  panel.put(frame('$11,357.51', COINS));
  assert.equal(panel.one('bal').getAttribute('data-empty'), null);
});

test('Add money opens the deposit steps in the panel, over nothing, and Done puts the list back', () => {
  const panel = build();
  panel.put(frame('$11,357.51', COINS));
  const add = panel.one('bal-add');
  assert.equal(add.tag, 'button');
  assert.equal(add.textContent, 'Add money');
  assert.equal(all(add, 'icon')[0].dataset.icon, 'deposit');

  click(add);
  const flow = panel.one('bal-flow');
  assert.equal(flow.hidden, false);
  assert.equal(panel.one('bal-list').hidden, true, 'the rows step aside while the steps run');
  assert.equal(panel.one('bal-total').textContent, '$11,357.51', 'the total stays in view to watch the money land');
  const opened = panel.calls.find((c) => c.route === 'moneyin.render');
  assert.ok(opened, 'the existing deposit steps were not opened');

  click(panel.one('bal-done'));
  assert.equal(flow.hidden, true);
  assert.equal(panel.one('bal-list').hidden, false);
  assert.ok(panel.calls.some((c) => c.route === 'moneyin.destroy'), 'the steps kept their watch after Done');
  assert.equal(add.focused, true, 'focus goes back to the control that opened the steps');
});

test('the panel carries nothing but the balance: no rules strip, no folds, no brake', () => {
  const source = BASIC_SOURCE.replace(/\/\*[\s\S]*?\*\//g, ' ');
  for (const gone of ['strip', 'fold(', 'PhosphorReceipts', 'alloc', 'Nothing is connected', 'Freeze everything', 'phosphor:agent-phase']) {
    assert.ok(!source.includes(gone), `ui/screens/basic.js still draws ${gone}`);
  }
});
