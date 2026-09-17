/* The checks: what the app read for itself a moment before it signed, drawn as
   a rail rather than said as text.

   One folded section, "Checks", closed by default, under the receipt and inside
   the send card. Open, it is five nodes on a hairline, top to bottom in the
   order the backend ran them: a 10 px dot in the state's colour (green ok,
   amber to watch, red the one that stopped it), the plain-English label, the
   number on the right in mono, and one sentence under it. The gas node carries
   the hour of readings as a 120 by 28 sparkline with the vendor's limit dashed
   across it, so "it ran out of gas" is a picture of a line crossing a line.

   The backend (src/preflight/) is the only author of every word and number
   here: this file draws `preflight` as the row carries it and computes nothing
   about money. PhosphorDom sets text; nothing is read as markup. */
(function () {
  'use strict';

  var dom = window.PhosphorDom;

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var ORDER = ['gas', 'coverage', 'venue', 'balance', 'deadline'];
  var SPARK_W = 120;
  var SPARK_H = 28;

  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function text(value) {
    return value === null || value === undefined ? '' : String(value);
  }

  function num(value) {
    return typeof value === 'number' && isFinite(value) ? value : null;
  }

  function stateOf(check) {
    var s = text(check.state);
    return s === 'warn' || s === 'fail' ? s : 'ok';
  }

  /* ---------- svg ---------- */

  function svgEl(tag, attrs) {
    if (typeof document.createElementNS !== 'function') return null;
    var el = document.createElementNS(SVG_NS, tag);
    for (var key in attrs) {
      if (Object.prototype.hasOwnProperty.call(attrs, key)) el.setAttribute(key, String(attrs[key]));
    }
    return el;
  }

  function chevron() {
    var svg = svgEl('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' });
    if (!svg) return dom.el('span', 'checks-chevron');
    svg.setAttribute('class', 'checks-chevron');
    var fill = svgEl('path', { d: 'M9.5 6l6 6-6 6z', fill: 'currentColor', 'fill-opacity': '0.2', stroke: 'none' });
    var line = svgEl('path', { d: 'M9.5 6l6 6-6 6', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
    svg.appendChild(fill);
    svg.appendChild(line);
    return svg;
  }

  /* The hour of readings, oldest left, on a 120 by 28 box. The scale runs
     from zero to the larger of the readings and the limit, so the dashed
     limit is always on the picture and the line's distance to it is real.
     A single reading is a short flat line, so the picture is never empty. */
  function sparkline(series, limit, state) {
    var values = [];
    for (var i = 0; i < (Array.isArray(series) ? series.length : 0); i += 1) {
      var v = num(series[i]);
      if (v !== null) values.push(v);
    }
    if (!values.length) return null;
    var cap = num(limit);
    var top = 0;
    for (var j = 0; j < values.length; j += 1) if (values[j] > top) top = values[j];
    if (cap !== null && cap > top) top = cap;
    if (top <= 0) top = 1;
    /* A tenth of headroom, so the limit is a line across the picture rather
       than its top edge, and a reading that crossed it shows as crossing. */
    top *= 1.1;

    var pad = 2;
    var innerW = SPARK_W - pad * 2;
    var innerH = SPARK_H - pad * 2;
    function x(i) {
      return values.length === 1 ? pad : pad + (i * innerW) / (values.length - 1);
    }
    function y(v) {
      return pad + innerH - (Math.max(0, v) / top) * innerH;
    }

    var svg = svgEl('svg', { viewBox: '0 0 ' + SPARK_W + ' ' + SPARK_H, width: SPARK_W, height: SPARK_H, 'aria-hidden': 'true', focusable: 'false' });
    if (!svg) return null;
    svg.setAttribute('class', 'checks-spark');
    svg.setAttribute('data-points', String(values.length));

    if (cap !== null) {
      var ly = y(cap);
      svg.appendChild(svgEl('line', { class: 'checks-spark-limit', x1: 0, y1: ly.toFixed(1), x2: SPARK_W, y2: ly.toFixed(1) }));
    }

    var d = '';
    if (values.length === 1) {
      d = 'M' + pad + ' ' + y(values[0]).toFixed(1) + ' L' + (SPARK_W - pad) + ' ' + y(values[0]).toFixed(1);
    } else {
      for (var k = 0; k < values.length; k += 1) {
        d += (k === 0 ? 'M' : ' L') + x(k).toFixed(1) + ' ' + y(values[k]).toFixed(1);
      }
    }
    svg.appendChild(svgEl('path', { class: 'checks-spark-line', d: d }));

    var last = values[values.length - 1];
    var dot = svgEl('circle', { class: 'checks-spark-now', cx: (values.length === 1 ? SPARK_W - pad : x(values.length - 1)).toFixed(1), cy: y(last).toFixed(1), r: 2.5 });
    dot.setAttribute('data-state', state || 'ok');
    svg.appendChild(dot);
    return svg;
  }

  /* ---------- the rail ---------- */

  function node(check) {
    var state = stateOf(check);
    var li = dom.el('li', 'checks-node');
    dom.setAttr(li, 'data-id', text(check.id));
    dom.setAttr(li, 'data-state', state);

    var dot = dom.el('span', 'checks-dot');
    dom.setAttr(dot, 'aria-hidden', 'true');
    li.appendChild(dot);

    var main = dom.el('div', 'checks-main');
    var row = dom.el('div', 'checks-row');
    row.appendChild(dom.el('span', 'checks-label', text(check.label)));
    row.appendChild(dom.el('span', 'checks-value mono', text(check.value)));
    main.appendChild(row);
    if (check.detail) main.appendChild(dom.el('p', 'checks-detail', text(check.detail)));
    var spark = Array.isArray(check.series) && check.series.length ? sparkline(check.series, check.limit, state) : null;
    if (spark) main.appendChild(spark);
    li.appendChild(main);
    return li;
  }

  /* The five nodes in the backend's order. A check the row does not carry is
     simply not drawn: the rail never invents a green dot. */
  function rail(preflight) {
    var p = isObject(preflight) ? preflight : {};
    var checks = Array.isArray(p.checks) ? p.checks.filter(isObject) : [];
    var list = dom.el('ol', 'checks-rail');
    for (var i = 0; i < ORDER.length; i += 1) {
      for (var j = 0; j < checks.length; j += 1) {
        if (checks[j].id === ORDER[i]) list.appendChild(node(checks[j]));
      }
    }
    return list;
  }

  /* ---------- words ---------- */

  function summaryOf(preflight) {
    var p = isObject(preflight) ? preflight : {};
    var checks = Array.isArray(p.checks) ? p.checks.filter(isObject) : [];
    var total = checks.length;
    var failing = 0;
    var watching = 0;
    for (var i = 0; i < checks.length; i += 1) {
      var state = stateOf(checks[i]);
      if (state === 'fail') failing += 1;
      else if (state === 'warn') watching += 1;
    }
    if (p.verdict === 'hold') return 'Waiting on ' + failing + ' of ' + total;
    if (p.verdict === 'fail') return 'Stopped by ' + failing + ' of ' + total;
    if (watching > 0) return total + ' checks, ' + watching + ' to watch';
    return total + ' checks, all clear';
  }

  function whenWords(iso) {
    var t = Date.parse(text(iso));
    if (!isFinite(t)) return '';
    var d = new Date(t);
    function two(n) { return (n < 10 ? '0' : '') + n; }
    return 'Checked at ' + two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds());
  }

  /* ---------- the fold ---------- */

  /* Builds the folded section into `host` and returns it. `opts.open` starts
     it open, which only a proof or a test wants; a person opens it. */
  function fold(host, preflight, opts) {
    var o = opts || {};
    var p = isObject(preflight) ? preflight : null;
    if (!p) return null;
    var open = o.open === true;

    var section = dom.el('section', 'checks');
    dom.setAttr(section, 'data-verdict', text(p.verdict || 'ok'));

    var toggle = dom.el('button', 'checks-toggle');
    toggle.type = 'button';
    toggle.appendChild(dom.el('span', 'checks-toggle-word', 'Checks'));
    toggle.appendChild(dom.el('span', 'checks-summary', summaryOf(p)));
    toggle.appendChild(chevron());
    section.appendChild(toggle);

    var wrap = dom.el('div', 'checks-fold');
    var inner = dom.el('div', 'checks-fold-inner');
    var body = dom.el('div', 'checks-body');
    body.appendChild(rail(p));
    var when = whenWords(p.at);
    if (when) body.appendChild(dom.el('p', 'checks-when', when));
    inner.appendChild(body);
    wrap.appendChild(inner);
    section.appendChild(wrap);

    function apply() {
      dom.setAttr(section, 'data-open', open ? 'true' : 'false');
      dom.setAttr(toggle, 'aria-expanded', open ? 'true' : 'false');
      dom.setAttr(toggle, 'aria-label', (open ? 'Close' : 'Open') + ' the checks');
    }
    dom.on(toggle, 'click', function () {
      open = !open;
      apply();
    });
    apply();

    if (host) host.appendChild(section);
    return section;
  }

  window.PhosphorChecks = {
    fold: fold,
    rail: rail,
    node: node,
    sparkline: sparkline,
    summaryOf: summaryOf,
    ORDER: ORDER
  };
})();
