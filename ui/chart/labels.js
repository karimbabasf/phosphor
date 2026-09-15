/* The chart's one label column.

   Three things used to write text down the left edge of the plot with three
   different ideas of where the next line goes: the legend from the top, the
   level labels beside their lines, and the trade overlays through a stacking
   pass of their own. Two of them printing at the same y is a number nobody can
   read on the one surface where a misread number costs money.

   So there is one column. Everything that wants a line on the left feeds an
   item {y, text, tone} in here, and one pass places them: from y 16, on a
   13 px pitch, pushed down and never up past a neighbour, lifted back on
   screen if the stack runs off the bottom, and cut at eight with a line that
   says how many more there were. Order is kept, so the label above still
   belongs to the line above.

   Plain browser script like the engine beside it: no imports, no framework.
   Nothing here touches the DOM or the tokens; the engine passes the ink. */

'use strict';

var LABEL_X = 5;
var LABEL_TOP = 16;
var LABEL_PITCH = 13;
var LABEL_MAX = 8;
/* The advance of a drawn part: a 7 px shape and a hair of air. */
var LABEL_GLYPH_W = 8;

/* Place a list of wanted items. Each item carries the y it would like, and
   either `text` or `parts` ([{text, tone}] for a line in more than one ink;
   a part may carry `glyph` instead of `text`, see labelGlyph).
   Returns the placed items in draw order, each with labelY, plus the count
   that did not fit. Pure: the same input places the same way every frame. */
function labelLayout(items, top, bottom) {
  var wanted = items.slice().sort(function (a, b) {
    return a.y - b.y;
  });
  var more = 0;
  if (wanted.length > LABEL_MAX) {
    more = wanted.length - LABEL_MAX;
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
  return { placed: wanted, more: more };
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
    var width = 0;
    for (var m = 0; m < parts.length; m += 1) {
      width += labelPartWidth(ctx, parts[m]) + (m < parts.length - 1 ? 6 : 0);
    }
    if (pad) {
      ctx.fillStyle = pad;
      ctx.fillRect(x - 3, item.labelY - 8, width + 6, 15);
    }
    for (var p = 0; p < parts.length; p += 1) {
      var ink = inkOf(parts[p].tone || 'text', parts[p].alpha === undefined ? 0.9 : parts[p].alpha);
      if (parts[p].glyph) {
        labelGlyph(ctx, parts[p].glyph, x, item.labelY, ink);
      } else {
        ctx.fillStyle = ink;
        ctx.fillText(parts[p].text, x, item.labelY);
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

function labelPartWidth(ctx, part) {
  return part.glyph ? LABEL_GLYPH_W : ctx.measureText(part.text).width;
}

/* A part drawn rather than typed, so no font decides what a cross or an
   arrow looks like: `close` is the cross that removes a line, a 1.5 px stroke;
   `up` and `down` are filled triangles saying which edge a label went off.
   Seven pixels wide, centred on the middle of the text beside it (four above
   the baseline), in the ink the part asked for. */
function labelGlyph(ctx, name, x, baseline, ink) {
  var cx = x + LABEL_GLYPH_W / 2;
  var cy = baseline - 4;
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
