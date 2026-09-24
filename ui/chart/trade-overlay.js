/* PHOSPHOR trading overlays: the account drawn on top of the price.

   Loaded ONLY by the trading page. chart.js calls in here through one guarded line and does
   not depend on the file being present.

   What is drawn here is not a study. An EMA is an opinion about price; an entry, a liquidation
   and a plan's stop are facts about money, and the difference is why they live in their own
   file rather than beside the indicators.

   THE TWO WALLS. A leveraged position has two prices that end it. One is the liquidation,
   drawn by the venue, at which it takes the position and the margin behind it. The other is
   the plan's stop, drawn by the human when they approved the plan, at the price where the loss
   they accepted is reached and the venue closes it for them. Showing both, with the human's
   nearer than the venue's, is the design's whole claim rendered as two lines.

   THE PLAN BAND. A plan that has not fired yet is drawn as its shape: the entry line in the
   agent's ink, the stop under it in the down ink with the band between them washed the same,
   the target above it in the window's ink with its own wash. That is how a strategy is shown
   without a word of prose, and it is the one memorable thing on this canvas.

   COLOUR. Every ink is a token, asked for by meaning through chartInk in chart.js: the
   liquidation is --down and nothing else on this canvas is that colour at full strength; a
   wall is --warn, the colour this window uses for anything waiting on a person; the agent's
   plans are --agent; the entry of a live position is plain text. No hex lives here.

   Everything is drawn from price and time, never from a stored pixel, so a pan or a zoom moves
   these with the candles and the value the agent measured against is the value on the glass.
   Labels are not drawn here at all: they go into the chart's one label column (chartLabel), so
   an entry and a stop three pixels apart cannot print on top of each other. */

'use strict';

/* The overlay reads one global, set by ui/screens/trade.js from the /api/trade payload. Absent means
   this is a page without an account behind it, and every function below no-ops. */
function tradeData() {
  return typeof window !== 'undefined' && window.TRADE ? window.TRADE : null;
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

/* One horizontal price line, with its label handed to the column. An off-pane line becomes a
   chip on the price axis (chartAxisChip), as drawLevels does for agent levels, so the two behave
   the same way under a zoom. Off-range is the NORMAL case for a stop that sits a long way down,
   and the chip carries the short word (spec.chip) rather than the whole label. */
function tradeLine(ctx, L, spec) {
  var y = L.yOf(spec.price);
  var top = L.priceTop;
  var bottom = L.priceTop + L.priceHeight;
  var text = spec.label + '  ' + priceText(spec.price, L.decimals);
  if (y < top || y > bottom) {
    chartAxisChip({ price: spec.price, edge: y < top ? 'top' : 'bottom', word: spec.chip || spec.label, tone: spec.tone, ring: spec.ring === true });
    return;
  }
  ctx.strokeStyle = chartInk(spec.tone, spec.alpha === undefined ? 0.85 : spec.alpha);
  ctx.lineWidth = spec.width || 1;
  ctx.setLineDash(spec.dash || []);
  ctx.beginPath();
  ctx.moveTo(0, hair(y));
  ctx.lineTo(L.plotWidth, hair(y));
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.lineWidth = 1;
  // Above the line, as a level's label sits, so the dashes do not run through the words.
  chartLabel({ y: y - 7, text: text, tone: spec.tone, ring: spec.ring === true });
}

/* The band beyond a wall: the region of price where the position no longer belongs to you.
   Drawn as a wash rather than a fill so the candles inside it stay readable, because a trader
   whose danger zone hides the price action will turn the danger zone off. */
function tradeBand(ctx, L, fromPrice, direction, tone, alpha) {
  var y = L.yOf(fromPrice);
  var top = L.priceTop;
  var bottom = L.priceTop + L.priceHeight;
  var y0 = direction === 'down' ? Math.max(y, top) : top;
  var y1 = direction === 'down' ? bottom : Math.min(y, bottom);
  if (y1 <= y0) return;
  ctx.fillStyle = chartInk(tone, alpha);
  ctx.fillRect(0, y0, L.plotWidth, y1 - y0);
}

/* The wash between two prices, clipped to the pane. The plan band is two of these. */
function tradeSpan(ctx, L, priceA, priceB, tone, alpha) {
  var top = L.priceTop;
  var bottom = L.priceTop + L.priceHeight;
  var ya = L.yOf(priceA);
  var yb = L.yOf(priceB);
  var aIn = ya >= top && ya <= bottom;
  var bIn = yb >= top && yb <= bottom;
  /* A plan whose lines are both off the pane tints nothing: a wash over every candle on screen
     says nothing about where the plan is. */
  if (!aIn && !bIn) return;
  var y0 = Math.max(top, Math.min(ya, yb));
  var y1 = Math.min(bottom, Math.max(ya, yb));
  if (y1 <= y0) return;
  if (aIn && bIn) {
    ctx.fillStyle = chartInk(tone, alpha);
    ctx.fillRect(0, y0, L.plotWidth, y1 - y0);
    return;
  }
  /* One line on the pane: the wash leaves it and fades out within 48 px, toward the line that
     is off the pane, so it reads as the side the plan runs to and not as a colour on the chart. */
  var from = aIn ? ya : yb;
  var dir = (aIn ? yb : ya) > from ? 1 : -1;
  var to = from + dir * 48;
  var g0 = Math.max(top, Math.min(from, to));
  var g1 = Math.min(bottom, Math.max(from, to));
  if (g1 <= g0) return;
  if (typeof ctx.createLinearGradient === 'function') {
    var grad = ctx.createLinearGradient(0, from, 0, to);
    grad.addColorStop(0, chartInk(tone, alpha));
    grad.addColorStop(1, chartInk(tone, 0));
    ctx.fillStyle = grad;
  } else {
    ctx.fillStyle = chartInk(tone, alpha);
  }
  ctx.fillRect(0, g0, L.plotWidth, g1 - g0);
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
    var tone = buy ? 'up' : 'down';
    // Size carries information, so it is drawn: a 6px triangle is a nibble and a 10px one is
    // the trade that mattered. Clamped so one outlier cannot cover the pane.
    var size = Math.max(4, Math.min(9, 4 + Math.sqrt(Math.abs(f.notionalUsd)) / 12));
    var tip = buy ? y + 3 : y - 3;
    ctx.fillStyle = chartInk(tone, f.liquidation ? 1 : 0.8);
    ctx.beginPath();
    ctx.moveTo(x, tip + (buy ? -size : size));
    ctx.lineTo(x - size * 0.7, tip);
    ctx.lineTo(x + size * 0.7, tip);
    ctx.closePath();
    ctx.fill();
    // A liquidation is ringed, because "the venue closed this for you" is not the same event
    // as "you closed this" and the two must never look alike on a chart.
    if (f.liquidation) {
      ctx.strokeStyle = chartInk('down', 1);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, size + 3, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = 1;
    }
    if (chartSpotOn('fill', f.tid)) {
      ctx.strokeStyle = chartInk('warn', 0.95);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, size + 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = 1;
    }
  }
}

/* The side mark on an order tag: a filled triangle five pixels tall, its point on the side
   the order takes, centred on the middle of the text beside it, then a hair of air. */
var ORDER_GLYPH_W = 9;

function orderGlyph(ctx, buy, x, baseline, ink) {
  var cy = baseline - 4;
  var dir = buy ? 1 : -1;
  ctx.fillStyle = ink;
  ctx.beginPath();
  ctx.moveTo(x + 3 + dir * 3, cy);
  ctx.lineTo(x + 3 - dir * 2, cy - 2.5);
  ctx.lineTo(x + 3 - dir * 2, cy + 2.5);
  ctx.closePath();
  ctx.fill();
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
    var tone = buy ? 'up' : 'down';
    ctx.strokeStyle = chartInk(tone, 0.5);
    ctx.setLineDash([1, 3]);
    ctx.beginPath();
    ctx.moveTo(L.plotWidth * 0.72, hair(y));
    ctx.lineTo(L.plotWidth, hair(y));
    ctx.stroke();
    ctx.setLineDash([]);
    // The side as a drawn triangle ahead of the words: pointing right for a buy, left for a
    // sell, the same ink as the words. Everything sits to the left of the dotted line's start.
    var tag = tradeUsd(o.notionalUsd) + (o.reduceOnly ? ' reduce' : '');
    var width = ORDER_GLYPH_W + textWidth(ctx, tag);
    var tagX = L.plotWidth * 0.72 - width - 4;
    orderGlyph(ctx, buy, tagX, y + 3, chartInk(tone, 0.75));
    ctx.fillStyle = chartInk(tone, 0.75);
    drawText(ctx, tag, tagX + ORDER_GLYPH_W, y + 3);
    drawSpotRing(ctx, tagX, y + 3, width, chartSpotOn('order', String(o.oid)));
  }
}

/* The price a plan enters at, as far as the window can know it: the limit or trigger it named,
   the fill it got once it has one, the reference the risk figure was priced from, or nothing. */
function planEntryPx(plan) {
  if (typeof plan.fillPx === 'number' && isFinite(plan.fillPx)) return plan.fillPx;
  if (plan.entry && typeof plan.entry.px === 'number' && isFinite(plan.entry.px)) return plan.entry.px;
  if (plan.risk && typeof plan.risk.entryRef === 'number' && isFinite(plan.risk.entryRef)) return plan.risk.entryRef;
  return null;
}

/* One plan as its shape. Bands first so they sit under the candles' own ink, then the three
   lines. The stop leg follows the planStop overlay, because it is the one line here a person
   might want off while they read the price action; the entry and target stay, since a plan
   with no entry drawn is a plan that is not on the chart at all. */
function drawPlan(ctx, L, plan, showStop) {
  var entry = planEntryPx(plan);
  if (entry === null) return;
  var ring = chartSpotOn('plan', plan.id);
  var side = plan.side === 'short' ? 'short' : 'long';
  var stop = typeof plan.stop === 'number' && isFinite(plan.stop) ? plan.stop : null;
  var target = typeof plan.target === 'number' && isFinite(plan.target) ? plan.target : null;

  if (stop !== null && showStop) tradeSpan(ctx, L, entry, stop, 'down', 0.05);
  if (target !== null) tradeSpan(ctx, L, entry, target, 'ink', 0.05);

  // tradeLine writes the price after the label, so the label is the word alone: "Plan long"
  // becomes "Plan long  64,100" on the glass. Carrying the price in the label as well printed
  // every plan line's price twice.
  tradeLine(ctx, L, {
    price: entry,
    tone: 'agent',
    label: 'Plan ' + side,
    chip: 'Plan ' + side,
    dash: [6, 4],
    alpha: 0.85,
    ring: ring
  });
  if (stop !== null && showStop) {
    tradeLine(ctx, L, { price: stop, tone: 'down', label: 'Stop', chip: 'Stop', dash: [6, 4], alpha: 0.8 });
  }
  if (target !== null) {
    tradeLine(ctx, L, { price: target, tone: 'ink', label: 'Target', chip: 'Target', dash: [6, 4], alpha: 0.8 });
  }
}

/* The entry point of the whole file, called from drawScene. Everything above it draws one
   kind of object; this decides what there is to draw and in what order.

   Order matters and is chosen: bands first so they sit under the candles' own ink, then the
   lines. The labels are not drawn here at all: they were handed to the column as the lines
   went down, and the hud places them in one pass with the legend. */
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
  var plans = (data.plans || []).filter(function (p) {
    return String(p.symbol).toUpperCase() === chartCoin && p.status !== 'done';
  });

  ctx.font = CHART_FONT;

  for (var i = 0; i < positions.length; i++) {
    var p = positions[i];
    var long = p.side === 'long';

    /* The venue's wall, and the region past it. Drawn before anything else so a liquidation
       that is close reads as a closing wall rather than as one more line in a list. */
    if (show.liquidation && isFinite(p.liqPx) && p.liqPx > 0) {
      tradeBand(ctx, L, p.liqPx, long ? 'down' : 'up', 'down', 0.07);
      tradeLine(ctx, L, {
        price: p.liqPx,
        tone: 'down',
        label: 'Liquidation ' + p.coin,
        chip: 'Liquidation',
        width: 1.5,
        alpha: 0.9
      });
    }

    if (show.position && isFinite(p.entryPx) && p.entryPx > 0) {
      tradeLine(ctx, L, {
        price: p.entryPx,
        tone: 'text',
        label: (long ? 'Long ' : 'Short ') + tradeUsd(p.notionalUsd) + ' at ' + p.leverage + 'x  ' + tradeSigned(p.unrealisedUsd),
        chip: 'Entry',
        width: 1.5,
        alpha: 0.9,
        ring: chartSpotOn('position', String(p.coin).toUpperCase())
      });
    }
  }

  /* The plans on this coin, each as its band. The plan's stop is the human's wall: the price
     at which the loss they approved is reached, sitting nearer than the venue's liquidation. */
  for (var k = 0; k < plans.length; k++) drawPlan(ctx, L, plans[k], show.planStop !== false);

  if (show.stops || show.targets) {
    var triggers = (data.orders || []).filter(function (o) {
      if (String(o.coin).toUpperCase() !== chartCoin) return false;
      if (o.kind !== 'trigger') return false;
      return o.role === 'stop' ? show.stops : show.targets;
    });
    for (var t = 0; t < triggers.length; t++) {
      var tr = triggers[t];
      tradeLine(ctx, L, {
        price: tr.triggerPx,
        tone: tr.role === 'stop' ? 'down' : 'ink',
        label: (tr.role === 'stop' ? 'Stop ' : 'Target ') + tradeUsd(tr.notionalUsd),
        chip: tr.role === 'stop' ? 'Stop' : 'Target',
        dash: [4, 4],
        alpha: 0.8,
        ring: chartSpotOn('order', String(tr.oid))
      });
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
}
