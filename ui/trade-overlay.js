/* PHOSPHOR trading overlays: the account drawn on top of the price.

   Loaded ONLY by the trading page. The pro page does not include this file, so the chart it
   renders is byte-for-byte the chart it rendered before this existed. chart.js calls in here
   through one guarded line and does not depend on the file being present.

   What is drawn here is not a study. An EMA is an opinion about price; an entry, a liquidation
   and a mandate wall are facts about money, and the difference is why they live in their own
   file with their own colour rules rather than beside the indicators.

   THE TWO WALLS. The idea this page is built around gets one paragraph because it is the whole
   argument. A leveraged position has two prices that end it. One is the liquidation, drawn by
   the venue, at which it takes the position and the margin behind it. The other is the mandate
   wall, drawn by the human, at the price where the loss they approved is reached and the bot
   stands down. Every other trading interface can only show the first, because in every other
   interface the second does not exist: there is nothing to draw, since the authority was never
   bounded in the first place. Showing both, with the human's wall nearer than the venue's, is
   the design's entire claim rendered as two lines on a chart.

   COLOUR. The app's law is that red belongs to the safety gate alone. It is extended here,
   deliberately and only this far: red is for the surfaces where something is taken from you.
   The liquidation line and the band beyond it are red. Nothing else on this canvas is, which
   keeps the eye's rule intact, because a red line still means exactly one thing. The mandate
   wall is bright phosphor, not red: it is the boundary that PROTECTS, and painting the guard
   rail the same colour as the cliff is how a person stops reading either.

   Everything is drawn from price and time, never from a stored pixel, so a pan or a zoom moves
   these with the candles and the value the agent measured against is the value on the glass. */

'use strict';

var TRADE_C_LIQ = '#ff3b30'; // the venue's wall. The one red on this canvas.
var TRADE_C_WALL = '#8cffab'; // the human's wall: the approved loss, reached.
var TRADE_C_LONG = '#33ff66';
var TRADE_C_SHORT = '#cc3a30'; // the chart's own down colour, dimmer than the gate red on purpose
var TRADE_LABEL_H = 13; // minimum vertical gap between two stacked labels, in CSS pixels

/* The overlay reads one global, set by ui/trade.js from the /api/trade payload. Absent means
   this is a page without an account behind it, and every function below no-ops. */
function tradeData() {
  return typeof window !== 'undefined' && window.TRADE ? window.TRADE : null;
}

function tradeRgba(hex, alpha) {
  var r = parseInt(hex.slice(1, 3), 16);
  var g = parseInt(hex.slice(3, 5), 16);
  var b = parseInt(hex.slice(5, 7), 16);
  return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
}

function tradeUsd(n) {
  var v = Number(n);
  if (!isFinite(v)) return '--';
  var sign = v < 0 ? '-' : '';
  var a = Math.abs(v);
  if (a >= 1000) return sign + '$' + Math.round(a).toLocaleString('en-US');
  return sign + '$' + a.toFixed(2);
}

function tradeSigned(n) {
  var v = Number(n);
  if (!isFinite(v)) return '--';
  return (v > 0 ? '+' : '') + tradeUsd(v).replace('$-', '-$');
}

/* Horizontal lines that land within a few pixels of each other would print their labels on top
   of one another, and two overlapping numbers on a risk surface is worse than one missing
   number. Labels are collected first, then pushed apart in one pass before any text is drawn.

   The push is downward from the top, which keeps the ordering of the lines: a label may move,
   but it never crosses another label, so the label above still belongs to the line above. */
function tradeStackLabels(items, top, bottom) {
  var sorted = items.slice().sort(function (a, b) {
    return a.y - b.y;
  });
  var lastY = -Infinity;
  for (var i = 0; i < sorted.length; i++) {
    var wanted = Math.max(sorted[i].y, top + TRADE_LABEL_H);
    if (wanted - lastY < TRADE_LABEL_H) wanted = lastY + TRADE_LABEL_H;
    sorted[i].labelY = wanted;
    lastY = wanted;
  }
  /* If the stack ran off the bottom, lift the whole run back on screen rather than letting the
     last few labels sit outside the pane where nothing can be read. */
  var overflow = lastY - (bottom - 2);
  if (overflow > 0) {
    for (var j = 0; j < sorted.length; j++) sorted[j].labelY -= overflow;
  }
  return sorted;
}

/* One horizontal price line with a label at the left and its price tagged at the right, where
   the price axis is. Off-pane lines are pinned to the edge with an arrow, matching what
   drawLevels already does for agent levels, so the two behave the same way under a zoom. */
function tradeLine(ctx, L, spec) {
  var y = L.yOf(spec.price);
  var top = L.priceTop;
  var bottom = L.priceTop + L.priceHeight;
  if (y < top || y > bottom) {
    ctx.fillStyle = tradeRgba(spec.colour, 0.55);
    ctx.fillText(
      (y < top ? '↑ ' : '↓ ') + spec.label + ' ' + priceText(spec.price, L.decimals),
      4,
      y < top ? top + 6 : bottom - 6
    );
    return null;
  }
  ctx.strokeStyle = tradeRgba(spec.colour, spec.alpha === undefined ? 0.85 : spec.alpha);
  ctx.lineWidth = spec.width || 1;
  ctx.setLineDash(spec.dash || []);
  ctx.beginPath();
  ctx.moveTo(0, hair(y));
  ctx.lineTo(L.plotWidth, hair(y));
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.lineWidth = 1;
  return { y: y, label: spec.label, price: spec.price, colour: spec.colour };
}

/* The band beyond a wall: the region of price where the position no longer belongs to you.
   Drawn as a wash rather than a fill so the candles inside it stay readable, because a trader
   whose danger zone hides the price action will turn the danger zone off. */
function tradeBand(ctx, L, fromPrice, direction, colour, alpha) {
  var y = L.yOf(fromPrice);
  var top = L.priceTop;
  var bottom = L.priceTop + L.priceHeight;
  var y0 = direction === 'down' ? Math.max(y, top) : top;
  var y1 = direction === 'down' ? bottom : Math.min(y, bottom);
  if (y1 <= y0) return;
  ctx.fillStyle = tradeRgba(colour, alpha);
  ctx.fillRect(0, y0, L.plotWidth, y1 - y0);
}

/* Where this account actually traded, at the bar it traded on. A fill is the one mark on the
   chart that is neither an opinion nor a plan: it already happened. Buys point up from below
   the bar, sells point down from above it, so a scalp in and out of one bar reads as two
   marks and not as one ambiguous blob. */
function drawTradeFills(ctx, L, fills) {
  var candles = CHART.candles;
  if (!candles.length || !fills.length) return;
  var granularity = CHART.view.granularitySec;
  var firstT = candles[0].t;

  for (var i = 0; i < fills.length; i++) {
    var f = fills[i];
    var index = Math.round((f.tSec - firstT) / granularity);
    if (index < L.start - 1 || index > L.end + 1) continue;
    var x = L.xOf(index);
    if (x < -8 || x > L.plotWidth + 8) continue;
    var y = L.yOf(f.px);
    if (y < L.priceTop || y > L.priceTop + L.priceHeight) continue;

    var buy = f.side === 'buy' || f.side === 'B';
    var colour = buy ? TRADE_C_LONG : TRADE_C_SHORT;
    // Size carries information, so it is drawn: a 6px triangle is a nibble and a 10px one is
    // the trade that mattered. Clamped so one outlier cannot cover the pane.
    var size = Math.max(4, Math.min(9, 4 + Math.sqrt(Math.abs(f.notionalUsd)) / 12));
    var tip = buy ? y + 3 : y - 3;
    ctx.fillStyle = tradeRgba(colour, f.liquidation ? 1 : 0.8);
    ctx.beginPath();
    ctx.moveTo(x, tip + (buy ? -size : size));
    ctx.lineTo(x - size * 0.7, tip);
    ctx.lineTo(x + size * 0.7, tip);
    ctx.closePath();
    ctx.fill();
    // A liquidation is ringed, because "the venue closed this for you" is not the same event
    // as "you closed this" and the two must never look alike on a chart.
    if (f.liquidation) {
      ctx.strokeStyle = TRADE_C_LIQ;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, size + 3, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = 1;
    }
  }
}

/* Resting orders sit at the right edge as ticks rather than as full-width lines. A working
   order is a smaller fact than a position, and drawing nine of them across the pane buries the
   candles under a ladder. The tick is at the price, the size is beside it. */
function drawTradeOrders(ctx, L, orders) {
  ctx.font = CHART_FONT;
  for (var i = 0; i < orders.length; i++) {
    var o = orders[i];
    var px = o.kind === 'trigger' ? o.triggerPx : o.px;
    if (!isFinite(px)) continue;
    var y = L.yOf(px);
    if (y < L.priceTop || y > L.priceTop + L.priceHeight) continue;
    var buy = o.side === 'buy' || o.side === 'B';
    var colour = buy ? TRADE_C_LONG : TRADE_C_SHORT;
    ctx.strokeStyle = tradeRgba(colour, 0.5);
    ctx.setLineDash([1, 3]);
    ctx.beginPath();
    ctx.moveTo(L.plotWidth * 0.72, hair(y));
    ctx.lineTo(L.plotWidth, hair(y));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = tradeRgba(colour, 0.75);
    var tag = (buy ? '▸ ' : '◂ ') + tradeUsd(o.notionalUsd) + (o.reduceOnly ? ' R' : '');
    ctx.fillText(tag, L.plotWidth * 0.72 - ctx.measureText(tag).width - 4, y + 3);
  }
}

/* The entry point of the whole file, called from drawScene. Everything above it draws one
   kind of object; this decides what there is to draw and in what order.

   Order matters and is chosen: bands first so they sit under the candles' own ink, then the
   lines, then the labels last so nothing is ever painted over a number. */
function drawTradeOverlays(ctx, L) {
  var data = tradeData();
  if (!data) return;
  var show = data.overlays || {};
  var symbol = String(data.symbol || '').toUpperCase();
  // Only the focused symbol's account objects belong on this chart. A BTC liquidation line
  // drawn on an ETH chart is not a bug the eye catches; it is a bug the eye trusts.
  var chartCoin = String((CHART.view.product || '').split('-')[0] || '').toUpperCase();
  if (chartCoin && symbol && chartCoin !== symbol) return;

  var positions = (data.positions || []).filter(function (p) {
    return String(p.coin).toUpperCase() === chartCoin;
  });
  var mandates = (data.mandates || []).filter(function (m) {
    return String(m.symbol).toUpperCase() === chartCoin && m.armed;
  });

  ctx.font = CHART_FONT;
  var labels = [];

  for (var i = 0; i < positions.length; i++) {
    var p = positions[i];
    var long = p.side === 'long';

    /* The venue's wall, and the region past it. Drawn before anything else so a liquidation
       that is close reads as a closing wall rather than as one more line in a list. */
    if (show.liquidation && isFinite(p.liqPx) && p.liqPx > 0) {
      tradeBand(ctx, L, p.liqPx, long ? 'down' : 'up', TRADE_C_LIQ, 0.07);
      var liqLine = tradeLine(ctx, L, {
        price: p.liqPx,
        colour: TRADE_C_LIQ,
        label: 'LIQ ' + p.coin,
        width: 1.5,
        alpha: 0.9
      });
      if (liqLine) labels.push(liqLine);
    }

    /* The human's wall. Nearer than the liquidation whenever a mandate is armed, which is the
       point: the loss you approved is reached before the venue ever gets to act. */
    if (show.mandateWall) {
      for (var m = 0; m < mandates.length; m++) {
        var wall = mandates[m].wallPx;
        if (!isFinite(wall) || wall <= 0) continue;
        tradeBand(ctx, L, wall, long ? 'down' : 'up', TRADE_C_WALL, 0.05);
        var wallLine = tradeLine(ctx, L, {
          price: wall,
          colour: TRADE_C_WALL,
          label: 'MANDATE STOP-OUT ' + tradeUsd(mandates[m].envelope.maxLossUsd),
          dash: [7, 3],
          width: 1.5,
          alpha: 0.95
        });
        if (wallLine) labels.push(wallLine);
      }
    }

    if (show.position && isFinite(p.entryPx) && p.entryPx > 0) {
      var winning = p.unrealisedUsd >= 0;
      var entryLine = tradeLine(ctx, L, {
        price: p.entryPx,
        colour: winning ? TRADE_C_LONG : TRADE_C_SHORT,
        label:
          (long ? 'LONG ' : 'SHORT ') +
          tradeUsd(p.notionalUsd) +
          ' @ ' +
          p.leverage +
          'x  ' +
          tradeSigned(p.unrealisedUsd),
        width: 1.5,
        alpha: 0.9
      });
      if (entryLine) labels.push(entryLine);
    }
  }

  if (show.stops || show.targets) {
    var triggers = (data.orders || []).filter(function (o) {
      if (String(o.coin).toUpperCase() !== chartCoin) return false;
      if (o.kind !== 'trigger') return false;
      return o.role === 'stop' ? show.stops : show.targets;
    });
    for (var t = 0; t < triggers.length; t++) {
      var tr = triggers[t];
      var line = tradeLine(ctx, L, {
        price: tr.triggerPx,
        colour: tr.role === 'stop' ? TRADE_C_SHORT : TRADE_C_LONG,
        label: (tr.role === 'stop' ? 'STOP ' : 'TARGET ') + tradeUsd(tr.notionalUsd),
        dash: [4, 4],
        alpha: 0.8
      });
      if (line) labels.push(line);
    }
  }

  if (show.orders) {
    drawTradeOrders(
      ctx,
      L,
      (data.orders || []).filter(function (o) {
        return String(o.coin).toUpperCase() === chartCoin && o.kind !== 'trigger';
      })
    );
  }

  if (show.fills) {
    drawTradeFills(
      ctx,
      L,
      (data.fills || []).filter(function (f) {
        return String(f.coin).toUpperCase() === chartCoin;
      })
    );
  }

  /* Labels last, and pushed apart first. Two risk numbers printed on top of each other is the
     one failure mode that makes this whole overlay worse than nothing. */
  var stacked = tradeStackLabels(labels, L.priceTop, L.priceTop + L.priceHeight);
  for (var s = 0; s < stacked.length; s++) {
    var item = stacked[s];
    var text = item.label + '  ' + priceText(item.price, L.decimals);
    var w = ctx.measureText(text).width;
    // A pad behind the text, because these sit over candles and a number that has to be
    // guessed at is a number that will be misread.
    ctx.fillStyle = tradeRgba('#0b0d0b', 0.72);
    ctx.fillRect(2, item.labelY - 9, w + 6, 11);
    ctx.fillStyle = item.colour;
    ctx.fillText(text, 5, item.labelY);
  }
}
