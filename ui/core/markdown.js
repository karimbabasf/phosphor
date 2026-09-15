/* The transcript's renderer. A reply is text a language model wrote, and it
   reaches the screen as elements this file built and strings this file set
   through textContent, never as markup. That is the whole trust boundary of
   the conversation column, and it is why this is a hand-written walk over a
   few block shapes rather than a markdown library: a library's job is to turn
   text into HTML, and HTML is the one thing a reply must never become.

   What it renders: paragraphs, bold, inline and fenced code, headings as
   labels (never larger than the body), bullet and numbered lists, and GFM
   tables as real table elements with numbers in mono. A link prints as its
   text. Signed percentages and dollar deltas are toned up or down, because a
   column of them is what an analysis is made of and the sign is the fact. */
(function () {
  'use strict';

  var TABLE_RULE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
  var HEADING = /^(#{1,6})\s+(.*)$/;
  var BULLET = /^\s*[-*+]\s+(.*)$/;
  var NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
  var FENCE = /^\s*```/;
  /* A figure, with or without the ticker it is counted in: 4.98, $12.50,
     +3.2%, 0.049 SOL. A cell that is one of these sits in the number column,
     right aligned and in mono, so a column of them reads down its point. */
  var NUMERIC = /^[+-]?\$?\d[\d,]*(\.\d+)?%?(\s[A-Z][A-Z0-9.]{1,6})?$/;
  /* A signed figure: +3.2%, -$0.40, +1,250. The lookbehind keeps a date's
     second half (2026-09-11) and a ticker's dash (ETH-USD) out of it. */
  var SIGNED = /(?<![\w$.\-])([+-]\$?\d[\d,]*(?:\.\d+)?%?)(?![\w.%])/g;
  var INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\([^)\n]*\))|(\*[^*\n]+\*)|(\b_[^_\n]+_\b)/g;

  function el(tag, className) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  function text(node, value) {
    node.textContent = String(value);
    return node;
  }

  /* ---------- inline ---------- */

  /* Plain text with its signed figures wrapped. Everything else is one text
     node, which is what keeps the cost of a long reply at one allocation. */
  function plain(host, value) {
    var last = 0;
    var m;
    SIGNED.lastIndex = 0;
    while ((m = SIGNED.exec(value)) !== null) {
      if (m.index > last) host.appendChild(text(el('span'), value.slice(last, m.index)));
      host.appendChild(text(el('span', 'md-n ' + (m[1].charAt(0) === '-' ? 'down' : 'up')), m[1]));
      last = m.index + m[0].length;
    }
    if (last < value.length) host.appendChild(text(el('span'), value.slice(last)));
  }

  /* The matches are collected before any of them is rendered: a bold span
     renders through this same function, and a nested call over one shared
     global regex would reset the cursor the outer loop is walking. */
  function inline(host, value) {
    var hits = [];
    var m;
    INLINE.lastIndex = 0;
    while ((m = INLINE.exec(value)) !== null) hits.push({ at: m.index, hit: m[0], kind: m[1] ? 1 : m[2] ? 2 : m[3] ? 3 : 4 });
    var last = 0;
    for (var i = 0; i < hits.length; i += 1) {
      var h = hits[i];
      if (h.at > last) plain(host, value.slice(last, h.at));
      if (h.kind === 1) host.appendChild(text(el('code'), h.hit.slice(1, -1)));
      else if (h.kind === 2) inline(host.appendChild(el('strong')), h.hit.slice(2, -2));
      else if (h.kind === 3) inline(host, h.hit.slice(1, h.hit.indexOf(']')));
      else inline(host.appendChild(el('em')), h.hit.slice(1, -1));
      last = h.at + h.hit.length;
    }
    if (last < value.length) plain(host, value.slice(last));
  }

  /* ---------- blocks ---------- */

  function cells(line) {
    var s = line.trim();
    if (s.charAt(0) === '|') s = s.slice(1);
    if (s.charAt(s.length - 1) === '|') s = s.slice(0, -1);
    var out = s.split('|');
    for (var i = 0; i < out.length; i += 1) out[i] = out[i].trim();
    return out;
  }

  function aligns(rule) {
    var out = [];
    var parts = cells(rule);
    for (var i = 0; i < parts.length; i += 1) {
      var p = parts[i];
      out.push(p.charAt(p.length - 1) === ':' ? 'num' : '');
    }
    return out;
  }

  function table(host, lines) {
    var wrap = el('div', 'chat-table');
    var tbl = el('table');
    var head = el('thead');
    var row = el('tr');
    var names = cells(lines[0]);
    var align = aligns(lines[1]);
    for (var i = 0; i < names.length; i += 1) {
      var th = el('th', align[i] || '');
      inline(th, names[i]);
      row.appendChild(th);
    }
    head.appendChild(row);
    tbl.appendChild(head);
    var body = el('tbody');
    for (var r = 2; r < lines.length; r += 1) {
      var tr = el('tr');
      var vals = cells(lines[r]);
      for (var c = 0; c < names.length; c += 1) {
        var value = vals[c] === undefined ? '' : vals[c];
        var td = el('td', align[c] || (NUMERIC.test(value) ? 'num' : ''));
        inline(td, value);
        tr.appendChild(td);
      }
      body.appendChild(tr);
    }
    tbl.appendChild(body);
    wrap.appendChild(tbl);
    host.appendChild(wrap);
  }

  function list(host, ordered, items) {
    var node = el(ordered ? 'ol' : 'ul', 'chat-list');
    for (var i = 0; i < items.length; i += 1) {
      inline(node.appendChild(el('li')), items[i]);
    }
    host.appendChild(node);
  }

  function paragraph(host, lines) {
    var p = el('p', 'chat-p');
    inline(p, lines.join('\n'));
    host.appendChild(p);
  }

  function renderInto(host, source) {
    if (!host) return;
    while (host.firstChild) host.removeChild(host.firstChild);
    if (typeof source !== 'string' || source === '') return;
    var lines = source.replace(/\r\n?/g, '\n').split('\n');
    var para = [];
    var i = 0;

    function flush() {
      if (para.length) paragraph(host, para);
      para = [];
    }

    while (i < lines.length) {
      var line = lines[i];

      if (FENCE.test(line)) {
        flush();
        var code = [];
        i += 1;
        while (i < lines.length && !FENCE.test(lines[i])) {
          code.push(lines[i]);
          i += 1;
        }
        i += 1;
        var pre = el('pre', 'chat-code');
        pre.appendChild(text(el('code'), code.join('\n')));
        host.appendChild(pre);
        continue;
      }

      if (line.trim() === '') {
        flush();
        i += 1;
        continue;
      }

      var heading = HEADING.exec(line);
      if (heading) {
        flush();
        inline(host.appendChild(el('div', 'chat-h')), heading[2].trim());
        i += 1;
        continue;
      }

      if (line.indexOf('|') !== -1 && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]) && lines[i + 1].indexOf('|') !== -1) {
        flush();
        var rows = [line, lines[i + 1]];
        i += 2;
        while (i < lines.length && lines[i].indexOf('|') !== -1 && lines[i].trim() !== '') {
          rows.push(lines[i]);
          i += 1;
        }
        table(host, rows);
        continue;
      }

      if (BULLET.test(line) || NUMBERED.test(line)) {
        flush();
        var ordered = NUMBERED.test(line);
        var pattern = ordered ? NUMBERED : BULLET;
        var items = [];
        while (i < lines.length && pattern.test(lines[i])) {
          items.push(pattern.exec(lines[i])[1]);
          i += 1;
        }
        list(host, ordered, items);
        continue;
      }

      para.push(line);
      i += 1;
    }
    flush();
  }

  window.PhosphorMarkdown = { renderInto: renderInto };
})();
