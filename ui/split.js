/* split.js: the gaps between the panels, made draggable.
 *
 * WHY. The deck divides the window by a ratio this file picked for somebody it has never
 * met. A person reading candles wants the middle column; a person talking to the agent
 * wants the left one. Karim, 2026-08-19: "between the components I need a sort of draggable
 * thing that makes everything draggable to some extent like if the user wants the agent
 * bigger or the chart, yk between the borders". So every gutter is a handle.
 *
 * WHAT THIS IS NOT. Not a layout engine. The deck is still a CSS grid of flex columns and
 * every default is a CSS default: a handle writes ONE custom property and the stylesheet
 * does the rest. Nothing here reads layout per frame either. The geometry is measured once,
 * when the pointer goes down, and a move is arithmetic on the numbers taken then. That is
 * why the drag maths lives in splitBegin/splitAt, which touch no DOM at all.
 *
 * THE FLOOR THAT IS NOT A PREFERENCE. Every pane has a minimum so it cannot be dragged to
 * nothing. The APPROVAL GATE's is bigger than the rest and it is the reason the minimums
 * exist at all: a gate that can be dragged out of sight is a window that can be arranged to
 * hide the one control that stops money moving. It is a safety surface, not a panel.
 *
 * THE KEYBOARD IS NOT A CHECKBOX. This is a wallet. Every handle is a real focusable
 * separator: arrows move it, Enter puts it back. Nothing here is reachable only by a pointer.
 *
 * WHAT IT TELLS THE REST OF THE PAGE. Two events. `phosphor:split` fires once per animation
 * frame while a boundary moves, because the box-drawing frames are measured in characters
 * and have to be redrawn on the frame the boundary moved, not after it stops. A plain
 * `resize` fires once, on release, for everything that already listens for one (the chart's
 * ResizeObserver picks the canvas up on its own; the donut and the basic canvases do not).
 */

'use strict';

var SPLIT_PREFIX = 'phosphor.split.';
var SPLIT_STEP = 16;       /* one arrow press, in px: a nudge, not a jump */
var SPLIT_DOUBLE_MS = 400; /* two presses this close together are one double click */

/* EVERY HANDLE ON BOTH DECKS, and the only place their numbers are written down.
 *
 *   axis     'x' is a vertical bar between columns, 'y' a horizontal one between panels.
 *   sign     +1 when moving the pointer along the axis GROWS the sized pane, -1 when it
 *            shrinks it (the pane below or to the right of the handle).
 *   pane     the thing being sized, and the thing measured.
 *   host     where the property is written. A column's width belongs to the grid, so it is
 *            written on the deck; a panel's height belongs to the panel.
 *   give     the pane that pays for it, and giveMin the floor it may not be pushed under.
 *            No give means the handle only takes from slack that is already spare.
 *   min      the floor for the sized pane itself.
 *
 * The minimums are measured, not guessed: 380 for a chart column is where candles stop
 * being read and start being estimated (the same number ui/trade.css states for a chart's
 * height), 240 for the agent column is a transcript line that still holds a sentence, and
 * 96 for the gate is one pending proposal with its two buttons still on screen.
 */
var SPLIT_PAGES = {
  pro: {
    /* The agent is on the RIGHT, so dragging right makes it smaller: sign -1. The name is
       deck-agent rather than the old deck-a on purpose. A stored width from the layout where
       the agent was the LEFT column would be read back and applied to a column on the other
       side of the screen, which is not a size anybody chose. A new name is how that entry
       gets left behind instead of misapplied. */
    'deck-agent': {
      axis: 'x', sign: -1, min: 240,
      pane: '.col-agent', host: '.deck', prop: '--deck-agent',
      give: '.col-mid', giveMin: 380,
    },
    /* The wallet is the sized one and the chart is the give, never the other way round: the
       chart is the growing panel in that column, so whatever the wallet does not take it
       gets back automatically, and the chart canvas is resized by the browser rather than
       by a second number this file would have to keep true. */
    'chart-wallet': {
      axis: 'y', sign: -1, min: 120,
      pane: '.panel-wallet', host: '.panel-wallet', prop: '--split-h',
      give: '#panel-chart', giveMin: 200,
    },
  },
  trade: {
    /* The trading page keeps its rail: liquidation distance, account health and the tape are
       not chrome and a perpetuals screen without them is a worse screen. What it takes from
       the pro deck is the ORDER. The agent is the last column here too, so "the chat is on
       the right" is true on every screen in this app. Renamed for the same reason as the pro
       deck's: a stored width for a column that has moved is not a size anybody chose. */
    'deck-agent': {
      axis: 'x', sign: -1, min: 240,
      pane: '.col-agent', host: '.deck', prop: '--deck-agent',
      give: '.col-mid', giveMin: 380,
    },
    'deck-rail': {
      axis: 'x', sign: -1, min: 240,
      pane: '.col-rail', host: '.deck', prop: '--deck-rail',
      give: '.col-mid', giveMin: 380,
    },
    'chart-book': {
      axis: 'y', sign: -1, min: 120,
      pane: '.panel-tbook', host: '.panel-tbook', prop: '--split-h',
      give: '#panel-chart', giveMin: 200,
    },
    /* Same floor as the pro deck's gate, for the same reason. The tape is the give because
       it is the growing panel in that column. */
    'gate-tape': {
      axis: 'y', sign: 1, min: 96,
      pane: '.panel-tgate', host: '.panel-tgate', prop: '--split-h',
      give: '.panel-thistory', giveMin: 140,
    },
  },
};

/* The in-memory copy of what storage holds, which is what keeps a handle working when
   localStorage throws. It does throw: a locked-down browser profile refuses it outright.
   Same shape and same reason as COLLAPSE_MEM in ui/app.js. */
var SPLIT_MEM = {};
var SPLIT_LIVE = [];

function splitKey(page, id) {
  return SPLIT_PREFIX + page + '.' + id;
}

/* Null means "no stored size", which is not the same as zero: it is the difference between
   a person who has never touched this handle and one who dragged it shut. A stored value
   that is not a positive number is treated as absent rather than repaired, because the only
   way to get one is for something else to have written over the key. */
function splitRead(page, id) {
  var key = splitKey(page, id);
  if (SPLIT_MEM[key] !== undefined) return SPLIT_MEM[key];
  try {
    var raw = window.localStorage.getItem(key);
    if (raw === null) return null;
    var px = parseInt(raw, 10);
    return isFinite(px) && px > 0 ? px : null;
  } catch (err) {
    return null;
  }
}

function splitWrite(page, id, px) {
  var key = splitKey(page, id);
  var value = Math.round(px);
  SPLIT_MEM[key] = value;
  try {
    window.localStorage.setItem(key, String(value));
  } catch (err) {
    // Nothing to do: the in-memory copy above still carries this session.
  }
}

function splitForget(page, id) {
  var key = splitKey(page, id);
  delete SPLIT_MEM[key];
  try {
    window.localStorage.removeItem(key);
  } catch (err) {
    // Same as above.
  }
}

function splitClamp(px, min, max) {
  /* min wins a contradiction. A window too small for both floors is a window where the
     safety surface keeps its height and the other pane overflows into its own scroll. */
  if (max < min) return min;
  if (px < min) return min;
  if (px > max) return max;
  return px;
}

function splitSizeOf(node, horiz) {
  var rect = node.getBoundingClientRect();
  return horiz ? rect.width : rect.height;
}

/* Everything a drag needs, read once. `max` is what the sized pane already holds plus what
   the give can spare, so a pane can never be grown past the point where its neighbour hits
   its own floor. */
function splitBounds(h) {
  var horiz = h.conf.axis === 'x';
  var size = splitSizeOf(h.pane, horiz);
  var room = h.give ? Math.max(0, splitSizeOf(h.give, horiz) - h.conf.giveMin) : 0;
  return { size: size, min: h.conf.min, max: Math.max(h.conf.min, size + room) };
}

function splitBegin(h, pos) {
  h.bounds = splitBounds(h);
  h.from = pos;
  h.start = h.bounds.size;
}

/* The whole of the drag, and it touches no DOM: a pointer coordinate in, a clamped size
   out. Every pointermove, every arrow press and every test goes through this one line. */
function splitAt(h, pos) {
  return splitClamp(h.start + (pos - h.from) * h.conf.sign, h.bounds.min, h.bounds.max);
}

/* ONE property write, and it is the only place a size reaches the page. data-sized is what
   the stylesheet keys the fixed flex-basis off; the property carries the number. */
function splitApply(h, px) {
  h.size = Math.round(px);
  h.host.style.setProperty(h.conf.prop, h.size + 'px');
  h.pane.setAttribute('data-sized', '');
  h.node.setAttribute('aria-valuenow', String(h.size));
}

/* Back to the CSS default, which is a property removed rather than a number restored: the
   default lives in the stylesheet and this file does not hold a copy of it to drift from. */
function splitReset(h) {
  h.size = null;
  h.host.style.removeProperty(h.conf.prop);
  h.pane.removeAttribute('data-sized');
  h.node.removeAttribute('aria-valuenow');
  splitForget(h.page, h.id);
}

/* A stored size is a preference, not an instruction. It is clamped against the window as it
   is now, and the clamped result is NOT written back: a laptop opened on a small external
   screen must not overwrite the layout chosen on the big one. */
function splitRestore(h) {
  var stored = splitRead(h.page, h.id);
  if (stored === null) return;
  h.bounds = splitBounds(h);
  splitApply(h, splitClamp(stored, h.bounds.min, h.bounds.max));
}

/* `final` means the pointer has been let go. The frames are redrawn on every frame of a
   drag because they are text measured in characters and would otherwise be the wrong width
   for as long as the drag lasts; everything heavier waits for the release. */
function splitNotify(final) {
  window.dispatchEvent(new CustomEvent('phosphor:split'));
  if (final) window.dispatchEvent(new Event('resize'));
}

function splitMove(h, pos) {
  h.pending = pos;
  if (h.frame) return;
  h.frame = window.requestAnimationFrame(function () {
    h.frame = 0;
    splitApply(h, splitAt(h, h.pending));
    splitNotify(false);
  });
}

function splitEnd(h) {
  if (h.frame) {
    window.cancelAnimationFrame(h.frame);
    h.frame = 0;
  }
  h.active = false;
  document.body.classList.remove('splitting');
  document.body.classList.remove('splitting-' + h.conf.axis);
  if (h.size !== null && h.size !== undefined) splitWrite(h.page, h.id, h.size);
  splitNotify(true);
}

/* Two arrows and a reset, which is the whole keyboard. Bounds are re-read on every press
   rather than cached: a keyboard user has all the time in the world between two presses and
   the window may have changed shape in one of them. */
function splitKeydown(h, ev) {
  if (ev.key === 'Enter' || ev.key === ' ') {
    splitReset(h);
    splitNotify(true);
    ev.preventDefault();
    return;
  }
  var horiz = h.conf.axis === 'x';
  var step = 0;
  if (ev.key === (horiz ? 'ArrowLeft' : 'ArrowUp')) step = -SPLIT_STEP;
  else if (ev.key === (horiz ? 'ArrowRight' : 'ArrowDown')) step = SPLIT_STEP;
  else return;

  /* Through splitBegin and splitAt, the same two the pointer uses, so a handle where
     dragging right SHRINKS the pane shrinks it on the right arrow too. A keyboard that
     disagreed with the mouse about which way a boundary moves would be worse than none. */
  splitBegin(h, 0);
  splitApply(h, splitAt(h, step));
  splitWrite(h.page, h.id, h.size);
  splitNotify(true);
  ev.preventDefault();
}

function splitWire(h) {
  h.node.addEventListener('pointerdown', function (ev) {
    if (ev.button !== undefined && ev.button !== 0) return;
    var now = Date.now();
    var again = now - h.lastDown < SPLIT_DOUBLE_MS;
    h.lastDown = now;
    /* A double press is "put this back". Counted here rather than listened for as a dblclick,
       because the handler below calls preventDefault on pointerdown to stop the drag selecting
       text, and what a browser does with the click events after that is not something to hang
       a control on. Two presses is also the same gesture on a touch screen, where dblclick is
       not. */
    if (again) {
      splitReset(h);
      splitNotify(true);
      ev.preventDefault();
      return;
    }
    splitBegin(h, h.conf.axis === 'x' ? ev.clientX : ev.clientY);
    h.active = true;
    /* Two classes: one kills text selection, the other holds the right resize cursor over
       the whole document while the pointer is captured and may be anywhere. */
    document.body.classList.add('splitting');
    document.body.classList.add('splitting-' + h.conf.axis);
    /* Capture, so a fast drag that outruns the 22px gutter keeps moving the boundary
       instead of stopping the moment the pointer leaves the handle. */
    if (h.node.setPointerCapture) h.node.setPointerCapture(ev.pointerId);
    h.node.focus();
    ev.preventDefault();
  });
  h.node.addEventListener('pointermove', function (ev) {
    if (!h.active) return;
    splitMove(h, h.conf.axis === 'x' ? ev.clientX : ev.clientY);
  });
  h.node.addEventListener('pointerup', function () {
    if (h.active) splitEnd(h);
  });
  h.node.addEventListener('pointercancel', function () {
    if (h.active) splitEnd(h);
  });
  h.node.addEventListener('keydown', function (ev) {
    splitKeydown(h, ev);
  });
}

function splitBoot() {
  var deck = document.querySelector('.deck[data-split]');
  if (!deck) return;
  var page = deck.getAttribute('data-split');
  var table = SPLIT_PAGES[page];
  if (!table) return;

  var nodes = deck.querySelectorAll('[data-split-handle]');
  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i];
    var id = node.getAttribute('data-split-handle');
    var conf = table[id];
    /* A handle with no entry in the table above is markup that got ahead of this file. It
       stays inert rather than guessing at a geometry nobody wrote down. */
    if (!conf) continue;
    var pane = document.querySelector(conf.pane);
    var host = conf.host === conf.pane ? pane : document.querySelector(conf.host);
    if (!pane || !host) continue;
    SPLIT_LIVE.push({
      page: page, id: id, conf: conf, node: node, pane: pane, host: host,
      give: conf.give ? document.querySelector(conf.give) : null,
      bounds: null, size: null, frame: 0, from: 0, start: 0, pending: 0, active: false, lastDown: 0,
    });
  }

  /* Columns before panels, and it is not cosmetic: a panel's height depends on how wide its
     column is, so restoring a height against a column that is about to move would clamp it
     against a layout that never existed. */
  for (var x = 0; x < SPLIT_LIVE.length; x++) {
    if (SPLIT_LIVE[x].conf.axis === 'x') splitRestore(SPLIT_LIVE[x]);
  }
  for (var y = 0; y < SPLIT_LIVE.length; y++) {
    if (SPLIT_LIVE[y].conf.axis === 'y') splitRestore(SPLIT_LIVE[y]);
  }
  for (var w = 0; w < SPLIT_LIVE.length; w++) splitWire(SPLIT_LIVE[w]);
}
