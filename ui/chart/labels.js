/* The chart's one label column: the legend.

   Three things used to write text down the left edge of the plot with three
   different ideas of where the next line goes: the legend from the top, the
   level labels beside their lines, and the trade overlays through a stacking
   pass of their own. Two of them printing at the same y is a number nobody can
   read on the one surface where a misread number costs money. The levels and
   the account's lines name themselves on the price axis now (chart.js, the
   axis chips), so what is left on the left is the studies.

   One column. Everything that wants a line on the left feeds an item {y, text,
   tone} in here, and one pass places them: from y 16, on a 13 px pitch, eight
   pixels in from the left edge, pushed down and never up past a neighbour,
   lifted back on screen if the stack runs off the bottom, and cut at eight
   with a line that says how many more there were, whose names the engine
   gives on hover and focus. Order is kept, so the label above still belongs
   to the line above. The whole column sits on one plate (labelPlate), so no
   line of it is read against the candles under it.

   Plain browser script like the engine beside it: no imports, no framework.
   Nothing here touches the DOM or the tokens; the engine passes the ink. */

'use strict';

var LABEL_X = 8;
var LABEL_TOP = 16;
var LABEL_PITCH = 13;
var LABEL_MAX = 8;
/* The advance of a drawn part: a 7 px shape and a hair of air. */
var LABEL_GLYPH_W = 8;

/* Place a list of wanted items. Each item carries the y it would like, and
   either `text` or `parts` ([{text, tone}] for a line in more than one ink;
   a part may carry `glyph` instead of `text`, see labelGlyph, and a `width`
   to advance by whatever it measures, so a column of prices holds still
   while the digits under it tick).
   Returns the placed items in draw order, each with labelY, plus the count
   that did not fit and the items it holds, so the engine can name them
   where the count is read (chart.js syncFold). Pure: the same input places
   the same way every frame. */
function labelLayout(items, top, bottom) {
  var wanted = items.slice().sort(function (a, b) {
    return a.y - b.y;
  });
  var more = 0;
  var hidden = [];
  if (wanted.length > LABEL_MAX) {
    more = wanted.length - LABEL_MAX;
    hidden = wanted.slice(LABEL_MAX);
    wanted = wanted.slice(0, LABEL_MAX);
    /* The count line wants the last kept label's y, so the pitch below places
       it one line under. Wanting Infinity, as it used to, made the overflow
       correction below Infinity too, and the whole column left the canvas the
       moment a ninth label was asked for. */
    wanted.push({ y: wanted[wanted.length - 1].y, text: '+' + more + ' more', tone: 'text2', overflow: true });
  }
  var lastY = -Infinity;
  var floor = top + LABEL_TOP;
  for (var i = 0; i < wanted.length; i += 1) {
    var y = Math.max(wanted[i].y, floor);
    if (y - lastY < LABEL_PITCH) y = lastY + LABEL_PITCH;
    wanted[i].labelY = y;
    lastY = y;
  }
  var overflow = lastY - (bottom - 4);
  if (overflow > 0) {
    for (var j = 0; j < wanted.length; j += 1) wanted[j].labelY -= overflow;
  }
  return { placed: wanted, more: more, hidden: hidden };
}

/* How wide one placed line is: its parts and the air between them, as labelDraw lays them. */
function labelLineWidth(ctx, item) {
  var parts = item.parts || [{ text: item.text, tone: item.tone || 'text' }];
  var width = 0;
  for (var m = 0; m < parts.length; m += 1) {
    width += labelPartWidth(ctx, parts[m]) + (m < parts.length - 1 ? 6 : 0);
  }
  return width;
}

/* One plate behind a whole placed column: a ground as wide as the widest
   line and as tall as the run, docked to the plot's left edge with its free
   corners rounded, so what the column says is never read against whatever
   runs under it. `inks` is the engine's: the ground, and a hairline of light
   along the top (`light`, `hair` tall). Returns the plate's box, or null when
   there is nothing to back. */
var LABEL_PLATE_RADIUS = 7;

function labelPlate(ctx, placed, inks) {
  if (!placed.length || !inks) return null;
  var width = 0;
  var first = Infinity;
  var last = -Infinity;
  for (var i = 0; i < placed.length; i += 1) {
    width = Math.max(width, labelLineWidth(ctx, placed[i]));
    first = Math.min(first, placed[i].labelY);
    last = Math.max(last, placed[i].labelY);
  }
  if (!isFinite(first) || !isFinite(last)) return null;
  var r = LABEL_PLATE_RADIUS;
  var box = { x: 0, y: first - 9, w: LABEL_X + width + 7, h: last - first + 18 };
  ctx.fillStyle = inks.ground;
  if (typeof ctx.roundRect === 'function') {
    ctx.beginPath();
    ctx.roundRect(box.x, box.y, box.w, box.h, [0, r, r, 0]);
    ctx.fill();
  } else {
    ctx.fillRect(box.x, box.y, box.w, box.h);
  }
  if (inks.light) {
    ctx.fillStyle = inks.light;
    ctx.fillRect(box.x, box.y, Math.max(0, box.w - r), inks.hair || 1);
  }
  return box;
}

/* Draw one placed column. `inkOf(tone, alpha)` is the engine's own palette, so
   the column has no colour of its own; `pad` is the ground behind a label that
   sits over candles. Returns the boxes it drew, one per item, so a caller can
   turn a label into a hit target without measuring twice. */
function labelDraw(ctx, placed, inkOf, pad) {
  var boxes = [];
  for (var i = 0; i < placed.length; i += 1) {
    var item = placed[i];
    var parts = item.parts || [{ text: item.text, tone: item.tone || 'text' }];
    var x = LABEL_X;
    var width = labelLineWidth(ctx, item);
    if (pad) {
      ctx.fillStyle = pad;
      if (typeof ctx.roundRect === 'function') {
        ctx.beginPath();
        ctx.roundRect(x - 4, item.labelY - 8, width + 8, 16, 4);
        ctx.fill();
      } else {
        ctx.fillRect(x - 3, item.labelY - 8, width + 6, 15);
      }
    }
    for (var p = 0; p < parts.length; p += 1) {
      /* A part may carry its own ink (a study's hue, which is no tone of the palette). */
      var ink = parts[p].ink || inkOf(parts[p].tone || 'text', parts[p].alpha === undefined ? 0.9 : parts[p].alpha);
      if (parts[p].glyph) {
        labelGlyph(ctx, parts[p].glyph, x, item.labelY, ink);
      } else {
        ctx.fillStyle = ink;
        labelDrawText(ctx, parts[p].text, x, item.labelY);
      }
      x += labelPartWidth(ctx, parts[p]) + 6;
    }
    /* The spotlight: an amber ring around the label the agent is pointing at,
       the same ring a rail row gets, so the eye reads one gesture in two places. */
    if (item.ring) {
      ctx.strokeStyle = inkOf('warn', 0.95);
      ctx.lineWidth = 1.5;
      ctx.strokeRect(LABEL_X - 4.5, item.labelY - 9.5, width + 9, 18);
      ctx.lineWidth = 1;
    }
    boxes.push({ x: LABEL_X - 3, y: item.labelY - 8, w: width + 6, h: 15, item: item });
  }
  return boxes;
}

/* A swatch is a short stroke of a study's line, wider than the other drawn parts. */
var LABEL_SWATCH_W = 12;

function labelPartWidth(ctx, part) {
  var measured = part.glyph ? (part.glyph === 'swatch' ? LABEL_SWATCH_W : LABEL_GLYPH_W) : labelTextWidth(ctx, part.text);
  return typeof part.width === 'number' && part.width > measured ? part.width : measured;
}

/* A part drawn rather than typed, so no font decides what a cross or an
   arrow looks like: `close` is the cross that removes a line, a 1.5 px stroke;
   `up` and `down` are filled triangles saying which edge a label went off;
   `agent` is the dot that marks an object the agent drew, in the agent's own
   ink, where the word [agent] used to be typed in front of every label.
   Seven pixels wide, centred on the middle of the text beside it (four above
   the baseline), in the ink the part asked for. */
function labelGlyph(ctx, name, x, baseline, ink) {
  var cx = x + LABEL_GLYPH_W / 2;
  var cy = baseline - 4;
  if (name === 'swatch') {
    /* The study's own line in miniature: 10 by 2.5, round at both ends, so the name beside it
       is matched to its line by colour before it is read. */
    ctx.fillStyle = ink;
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') ctx.roundRect(x, cy - 1.25, LABEL_SWATCH_W - 2, 2.5, 1.25);
    else ctx.rect(x, cy - 1.25, LABEL_SWATCH_W - 2, 2.5);
    ctx.fill();
    return;
  }
  if (name === 'agent') {
    ctx.fillStyle = ink;
    ctx.beginPath();
    ctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  if (name === 'close') {
    ctx.strokeStyle = ink;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx - 3, cy - 3);
    ctx.lineTo(cx + 3, cy + 3);
    ctx.moveTo(cx + 3, cy - 3);
    ctx.lineTo(cx - 3, cy + 3);
    ctx.stroke();
    ctx.lineWidth = 1;
    return;
  }
  var dir = name === 'up' ? -1 : 1;
  ctx.fillStyle = ink;
  ctx.beginPath();
  ctx.moveTo(cx, cy + dir * 3);
  ctx.lineTo(cx - 3.5, cy - dir * 2);
  ctx.lineTo(cx + 3.5, cy - dir * 2);
  ctx.closePath();
  ctx.fill();
}

/* The label column's figures are the engine's tabular Geist (chart.js chartText), and plain
   canvas text where the engine is not loaded. */
function labelDrawText(ctx, text, x, y) {
  var t = typeof window !== 'undefined' && window.chartText;
  if (t && typeof t.draw === 'function') t.draw(ctx, text, x, y);
  else ctx.fillText(text, x, y);
}

function labelTextWidth(ctx, text) {
  var t = typeof window !== 'undefined' && window.chartText;
  return t && typeof t.width === 'function' ? t.width(ctx, text) : ctx.measureText(text).width;
}
