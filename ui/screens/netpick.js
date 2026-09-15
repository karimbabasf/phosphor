/* Money in, in three steps: the network, what it credits, the address.

   Karim, 2026-09-15, on the screens this replaces: "first you select the
   network you want to deposit from ... have it all colorless, and then when the
   mouse hovers on one of the buttons for the network it becomes colorful, but
   the real network color. then it shows a list, a proper list with the tokens
   like a wallet would show ... the address looks shit, it looks scary, should
   be simple and easy to use. if there is one address then what is the point of
   choosing the layer and token if they are literally the same, it's
   misleading."

   So: one network, picked once, on a tile that wears its brand colour only
   under the pointer. Then the tokens that network credits, searchable, each
   with its minimum in the unit a person types. Then one address, and nothing
   to choose beside it: a token does not change the address, so the card offers
   no token chips and no network chips, only a way back.

   One component, three hosts. The Money in fold and the wizard's addresses
   step run all three steps in place. The deposit card opens at the step its
   caller asks for. The Vault tab's Addresses card runs step two under its own
   network menu and hands step three to the deposit card. The address is drawn
   by one function, after the same three checks the card has always run: the
   wallet is open, the QR reads back as the same bytes, the clipboard reads
   back what was written. */
(function () {
  'use strict';

  var dom = window.PhosphorDom;
  var api = window.PhosphorApi;
  var net = window.PhosphorNet;
  var store = window.PhosphorState;

  var ACK_KEY = 'phosphor.depositAck';
  var EASE = [0.16, 1, 0.3, 1];
  var COPIED_MS = 1500;

  /* The five networks the bridge credits, in the order an exchange lists them,
     each with its brand colour. ui/design/marks.js carries a colour per coin
     for the marks; the network colours are the chains' own (Base's brand blue
     is #0052FF, marks.js has the coin file's #0000FF), so they are written
     here where a tile reads them. `words` is the network in the words an
     exchange's withdraw screen uses. */
  var NETWORKS = [
    { id: 'eth', name: 'Ethereum', mark: 'ETH', colour: '#627EEA', words: 'Ethereum (ERC-20)', native: 'ETH' },
    { id: 'base', name: 'Base', mark: 'BASE', colour: '#0052FF', words: 'Base', native: 'ETH' },
    { id: 'arb', name: 'Arbitrum', mark: 'ARB', colour: '#12AAFF', words: 'Arbitrum One', native: 'ETH' },
    { id: 'sol', name: 'Solana', mark: 'SOL', colour: '#9945FF', accent: '#14F195', words: 'Solana (SPL)', native: 'SOL' },
    { id: 'near', name: 'NEAR', mark: 'NEAR', colour: '#00EC97', words: 'NEAR Protocol', native: 'NEAR' }
  ];
  var EVM = ['eth', 'base', 'arb'];

  /* Four modules of quiet zone, which is what a reader needs to find the edge,
     and no fewer than three pixels a module: the decoder here reads the same
     pixels a phone will. */
  var QUIET = 4;
  var QR_TARGET_PX = 176;
  var MIN_SCALE = 3;

  function networkOf(id) {
    for (var i = 0; i < NETWORKS.length; i += 1) {
      if (NETWORKS[i].id === id) return NETWORKS[i];
    }
    return null;
  }

  function networkWords(chain) {
    var n = networkOf(chain);
    return n ? n.words : String(chain || '');
  }

  function networkName(chain) {
    var n = networkOf(chain);
    return n ? n.name : String(chain || '');
  }

  /* ---------- the acknowledgement, once per install ---------- */

  function ackRemembered() {
    try { return window.localStorage.getItem(ACK_KEY) === '1'; } catch (e) { return false; }
  }

  function rememberAck() {
    try { window.localStorage.setItem(ACK_KEY, '1'); } catch (e) { /* private window */ }
  }

  /* ---------- the tokens, sorted and searched ---------- */

  /* The chain's own coin first, then the two dollars an exchange sends most,
     then the rest by name: the list a wallet shows, not the bridge's order. */
  function sortTokens(accepts, nativeSymbol) {
    var list = Array.isArray(accepts) ? accepts.filter(function (t) { return t && t.symbol; }) : [];
    var rank = function (t) {
      var s = String(t.symbol).toUpperCase();
      if (s === String(nativeSymbol || '').toUpperCase()) return 0;
      if (s === 'USDC') return 1;
      if (s === 'USDT') return 2;
      return 3;
    };
    return list.slice().sort(function (a, b) {
      var ra = rank(a);
      var rb = rank(b);
      if (ra !== rb) return ra - rb;
      var sa = String(a.symbol).toUpperCase();
      var sb = String(b.symbol).toUpperCase();
      return sa < sb ? -1 : (sa > sb ? 1 : 0);
    });
  }

  /* What starts with the letters typed, then what merely contains them. */
  function filterTokens(tokens, query) {
    var q = String(query || '').trim().toUpperCase();
    if (!q) return tokens.slice();
    var starts = [];
    var holds = [];
    for (var i = 0; i < tokens.length; i += 1) {
      var s = String(tokens[i].symbol).toUpperCase();
      if (s.indexOf(q) === 0) starts.push(tokens[i]);
      else if (s.indexOf(q) >= 0) holds.push(tokens[i]);
    }
    return starts.concat(holds);
  }

  /* USDC where the network credits it, else the chain's own coin, else the
     first thing it does credit: the asset an exchange most often sends. */
  function defaultSymbol(accepts, nativeSymbol) {
    var list = Array.isArray(accepts) ? accepts : [];
    var i;
    for (i = 0; i < list.length; i += 1) {
      if (list[i] && String(list[i].symbol).toUpperCase() === 'USDC') return 'USDC';
    }
    for (i = 0; i < list.length; i += 1) {
      if (list[i] && nativeSymbol && String(list[i].symbol).toUpperCase() === String(nativeSymbol).toUpperCase()) return list[i].symbol;
    }
    return list.length && list[0] ? String(list[0].symbol) : '';
  }

  function tokenOf(network, symbol) {
    var accepts = network && Array.isArray(network.accepts) ? network.accepts : [];
    for (var i = 0; i < accepts.length; i += 1) {
      if (accepts[i] && String(accepts[i].symbol).toUpperCase() === String(symbol || '').toUpperCase()) return accepts[i];
    }
    return null;
  }

  function minimumWords(token) {
    if (!token) return '';
    var floor = token.minDepositHuman;
    if (typeof floor !== 'string' || !floor) return '';
    return floor + ' ' + token.symbol;
  }

  /* ---------- small helpers that survive the test harness ---------- */

  function setVar(node, name, value) {
    if (node.style && typeof node.style.setProperty === 'function') node.style.setProperty(name, value);
    else if (node.style) node.style[name] = value;
  }

  function logo(symbol, size) {
    var marks = window.PhosphorMarks;
    if (marks && typeof marks.logo === 'function') return marks.logo(symbol, size);
    var node = dom.el('span', 'logo');
    node.setAttribute('aria-hidden', 'true');
    node.appendChild(dom.el('span', 'logo-initial mono', String(symbol || '?').charAt(0)));
    return node;
  }

  function icon(name, className) {
    var icons = window.PhosphorIcons;
    if (icons && typeof icons.svg === 'function') return icons.svg(name, className);
    return dom.el('span', 'icon ' + (className || ''));
  }

  function button(label, kind) {
    var node = dom.el('button', 'btn ' + (kind || 'btn-ghost'));
    node.type = 'button';
    node.appendChild(dom.el('span', 'btn-label', label));
    return node;
  }

  function reducedMotion() {
    var motion = window.PhosphorMotion;
    return !!(motion && typeof motion.reduced === 'function' && motion.reduced());
  }

  /* Byte for byte. Two strings that print the same and differ in one code
     unit are two different addresses. */
  function sameBytes(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i += 1) {
      if (a.charCodeAt(i) !== b.charCodeAt(i)) return false;
    }
    return true;
  }

  function tail(address) {
    return String(address).slice(-4);
  }

  /* Groups of four. The first four and the last four are the ones a person
     checks against the sending screen; a length that does not divide leaves
     its remainder in the group before the last, never in the ends. */
  function chunks(address) {
    var text = String(address);
    if (text.length <= 8) return text.length > 4 ? [text.slice(0, 4), text.slice(4)] : [text];
    var out = [text.slice(0, 4)];
    var middle = text.slice(4, -4);
    for (var i = 0; i < middle.length; i += 4) out.push(middle.slice(i, i + 4));
    out.push(text.slice(-4));
    return out;
  }

  /* The address as one block: the whole string for a screen reader, then the
     groups, all one size and one weight, the two ends in the text colour and
     the middle one step quieter. Nothing is bold and nothing jumps in size:
     a person reads it left to right, checks the ends, and is done. */
  function addressBlock(address) {
    var block = dom.el('div', 'deposit-address mono');
    block.appendChild(dom.el('span', 'sr-only', address));
    var parts = chunks(address);
    var shown = dom.el('span', 'deposit-chunks');
    shown.setAttribute('aria-hidden', 'true');
    for (var i = 0; i < parts.length; i += 1) {
      var end = i === 0 || i === parts.length - 1;
      shown.appendChild(dom.el('span', end ? 'addr-end' : 'addr-mid', parts[i]));
    }
    block.appendChild(shown);
    return block;
  }

  /* Dark modules on a light quiet zone, which is the way round the QR standard
     specifies and the one every scanner reads. Then the check: the pixels are
     read back off the same canvas and decoded, and the string has to be the
     address. Anything short of that is a refusal with a reason. */
  function drawChecked(canvas, address) {
    if (typeof window.qrcode !== 'function') return { ok: false, why: 'The QR encoder did not load.' };
    if (typeof window.jsQR !== 'function') return { ok: false, why: 'The QR checker did not load.' };

    var code;
    try {
      code = window.qrcode(0, 'M');
      code.addData(address);
      code.make();
    } catch (err) {
      return { ok: false, why: 'The address could not be encoded.' };
    }

    var count = code.getModuleCount();
    var total = count + QUIET * 2;
    var scale = Math.max(MIN_SCALE, Math.floor(QR_TARGET_PX / total));
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var size = total * scale;

    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    canvas.style.width = size + 'px';
    canvas.style.height = size + 'px';

    var ctx = canvas.getContext('2d');
    if (!ctx) return { ok: false, why: 'This window cannot draw a QR code.' };
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#000000';
    for (var row = 0; row < count; row += 1) {
      for (var col = 0; col < count; col += 1) {
        if (!code.isDark(row, col)) continue;
        ctx.fillRect((col + QUIET) * scale, (row + QUIET) * scale, scale, scale);
      }
    }

    var image;
    try {
      image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    } catch (err) {
      return { ok: false, why: 'The drawn code could not be read back.' };
    }
    var decoded = null;
    try {
      decoded = window.jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' });
    } catch (err) {
      decoded = null;
    }
    if (!decoded || typeof decoded.data !== 'string') return { ok: false, why: 'The QR code did not read back at all.' };
    if (!sameBytes(decoded.data, address)) return { ok: false, why: 'The QR code read back as a different address.' };
    return { ok: true };
  }

  /* Write, read back, and say what was found. A clipboard that cannot be read
     back is said to be that, with the last four characters to check by hand,
     rather than reported as copied. Resolves true only on a read-back match. */
  function copyChecked(address, say) {
    var clip = window.navigator ? window.navigator.clipboard : null;
    if (!clip || typeof clip.writeText !== 'function') {
      say('This window cannot reach the clipboard. Read the address from the screen.');
      return Promise.resolve(false);
    }
    var unread = 'Copied, but the clipboard could not be read back. Check it ends in ...' + tail(address) + ' before you send.';
    return clip.writeText(address)
      .then(function () {
        if (typeof clip.readText !== 'function') {
          say(unread);
          return false;
        }
        return clip.readText().then(function (back) {
          if (sameBytes(back, address)) {
            say('Copied, ends in ...' + tail(address));
            return true;
          }
          say('The clipboard does not hold the address: something else is in it. Copy again, or read it from the screen.');
          return false;
        }, function () {
          say(unread);
          return false;
        });
      })
      .catch(function () {
        say('The copy did not work. Read the address from the screen.');
        return false;
      });
  }

  /* ---------- the watcher line ---------- */

  function landedWords(deposit) {
    var symbol = deposit.symbol || '';
    return 'Landed: ' + (typeof deposit.amount === 'number' ? dom.qty(deposit.amount) + ' ' + symbol : symbol)
      + (typeof deposit.ms === 'number' ? ' in ' + Math.max(1, Math.round(deposit.ms / 1000)) + ' s' : '');
  }

  function elapsed(startedAt) {
    var then = new Date(startedAt).getTime();
    if (!isFinite(then)) return '0:00';
    var seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
    var minutes = Math.floor(seconds / 60);
    var rest = seconds % 60;
    return minutes + ':' + (rest < 10 ? '0' : '') + rest;
  }

  /* ---------- the component ---------- */

  function render(host, options) {
    var opts = options || {};
    if (host.__netpick && typeof host.__netpick.destroy === 'function') host.__netpick.destroy();
    var root = dom.el('div', 'netpick');
    root.dataset.context = opts.context || 'basic';
    dom.clear(host);
    host.appendChild(root);

    var state = {
      stage: null,
      network: opts.network || null,
      symbol: opts.symbol || null,
      report: opts.report || null,
      loading: null,
      failed: null,
      deposit: opts.deposit || null,
      watchStart: opts.deposit && opts.deposit.startedAt ? opts.deposit.startedAt : null,
      query: '',
      alive: true,
      stageNode: null,
      watch: null,
      tick: 0,
      unsubscribe: null,
      copiedTimer: 0
    };

    /* The report is what step two and three draw from. Step one needs nothing
       from it: the five tiles are the five networks, and the report only
       decides which of them is greyed as unavailable. */
    function load(force) {
      if (state.report && !force) return Promise.resolve(state.report);
      if (state.loading) return state.loading;
      state.failed = null;
      state.loading = api.intentsReceive()
        .then(function (result) {
          state.loading = null;
          state.report = result && result.data ? result.data : null;
          return state.report;
        })
        .catch(function (err) {
          state.loading = null;
          state.failed = net.readable(err);
          return null;
        });
      return state.loading;
    }

    function reportNetwork(id) {
      var networks = state.report && Array.isArray(state.report.networks) ? state.report.networks : [];
      for (var i = 0; i < networks.length; i += 1) {
        if (networks[i] && networks[i].id === id) return networks[i];
      }
      return null;
    }

    /* One stage on screen at a time. The one leaving fades and lifts away over
       150 ms; the one arriving fades and settles down over 300 ms. With motion
       reduced, or where motion.dev is not loaded, the swap is a swap. */
    function show(stage, node) {
      var prev = state.stageNode;
      state.stage = stage;
      state.stageNode = node;
      root.dataset.stage = stage;
      node.className = 'netpick-stage netpick-' + stage;
      if (typeof opts.onStage === 'function') opts.onStage(stage, state.network);
      var Motion = window.Motion;
      var animated = !!(Motion && typeof Motion.animate === 'function') && !reducedMotion();
      if (!prev) {
        root.appendChild(node);
        if (animated) Motion.animate(node, { opacity: [0, 1], y: [10, 0] }, { duration: 0.3, ease: EASE });
        return;
      }
      if (!animated) {
        if (prev.parentNode === root) root.removeChild(prev);
        root.appendChild(node);
        return;
      }
      var leaving = Motion.animate(prev, { opacity: [1, 0], y: [0, -6] }, { duration: 0.15, ease: EASE });
      var arrive = function () {
        if (!state.alive || state.stageNode !== node) return;
        if (prev.parentNode === root) root.removeChild(prev);
        root.appendChild(node);
        Motion.animate(node, { opacity: [0, 1], y: [10, 0] }, { duration: 0.3, ease: EASE });
      };
      var done = leaving && leaving.finished ? leaving.finished : Promise.resolve();
      done.then(arrive, arrive);
    }

    /* ---------- step one: the network ---------- */

    function stageNetworks() {
      var node = dom.el('div');
      node.appendChild(dom.el('p', 'netpick-lead', 'Pick the network you are sending on.'));
      var grid = dom.el('div', 'netpick-grid');
      grid.setAttribute('role', 'group');
      grid.setAttribute('aria-label', 'Networks');
      var tiles = [];
      NETWORKS.forEach(function (n, index) {
        var tile = dom.el('button', 'net-tile');
        tile.type = 'button';
        tile.dataset.network = n.id;
        setVar(tile, '--net', n.colour);
        if (n.accent) setVar(tile, '--net-accent', n.accent);
        tile.tabIndex = (state.network ? state.network === n.id : index === 0) ? 0 : -1;
        var mark = dom.el('span', 'net-tile-mark');
        mark.appendChild(logo(n.mark, 28));
        tile.appendChild(mark);
        tile.appendChild(dom.el('span', 'net-tile-name', n.name));
        var known = reportNetwork(n.id);
        if (known && known.unavailable) {
          tile.dataset.unavailable = 'true';
          tile.setAttribute('aria-disabled', 'true');
          tile.title = 'Not available right now: ' + known.unavailable;
        }
        if (state.network === n.id) tile.setAttribute('aria-current', 'true');
        dom.on(tile, 'click', function () { pick(n.id); });
        dom.on(tile, 'keydown', function (event) { onTileKey(event, index); });
        tiles.push(tile);
        grid.appendChild(tile);
      });
      node.appendChild(grid);

      /* Arrow keys move between the tiles, Enter or Space picks the one under
         the focus. The tiles are buttons, so Enter and Space already click. */
      function onTileKey(event, index) {
        var next = index;
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = Math.min(tiles.length - 1, index + 1);
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = Math.max(0, index - 1);
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = tiles.length - 1;
        else return;
        event.preventDefault();
        tiles[index].tabIndex = -1;
        tiles[next].tabIndex = 0;
        tiles[next].focus();
      }

      /* The report is read behind the tiles, so a network the bridge refused
         is greyed by the time the pointer gets there. */
      if (!state.report) {
        load().then(function () {
          if (!state.alive || state.stageNode !== node) return;
          tiles.forEach(function (tile) {
            var known = reportNetwork(tile.dataset.network);
            if (known && known.unavailable) {
              tile.dataset.unavailable = 'true';
              tile.setAttribute('aria-disabled', 'true');
              tile.title = 'Not available right now: ' + known.unavailable;
            }
          });
        });
      }
      show('network', node);
    }

    function pick(id) {
      state.network = id;
      state.query = '';
      stageTokens();
    }

    /* The line above steps two and three: the network's mark and name, and
       the way back to step one. */
    function stageHead(n, text, withBack) {
      var head = dom.el('div', 'netpick-head');
      var title = dom.el('div', 'netpick-title');
      var titleMark = dom.el('span', 'netpick-title-mark');
      setVar(titleMark, '--net', n.colour);
      titleMark.appendChild(logo(n.mark, 20));
      title.appendChild(titleMark);
      title.appendChild(dom.el('span', 'netpick-title-text', text));
      head.appendChild(title);
      if (withBack) {
        var back = dom.el('button', 'netpick-back');
        back.type = 'button';
        back.appendChild(icon('chevron-right', 'netpick-back-icon'));
        back.appendChild(dom.el('span', '', 'Change network'));
        dom.on(back, 'click', function () { stageNetworks(); });
        head.appendChild(back);
      }
      return head;
    }

    /* ---------- step two: what it credits ---------- */

    function stageTokens() {
      var n = networkOf(state.network);
      if (!n) return stageNetworks();
      var node = dom.el('div');

      node.appendChild(stageHead(n, 'Tokens credited on ' + n.name, opts.context !== 'vault'));

      var body = dom.el('div', 'netpick-tokens-body');
      node.appendChild(body);
      show('tokens', node);

      var pending = dom.el('div', 'stack-2');
      for (var i = 0; i < 3; i += 1) {
        var skel = dom.el('div', 'skel');
        skel.style.height = '44px';
        pending.appendChild(skel);
      }
      body.appendChild(pending);

      load().then(function () {
        if (!state.alive || state.stageNode !== node) return;
        dom.clear(body);
        drawTokens(body, n);
      });
    }

    function drawTokens(body, n) {
      var network = reportNetwork(n.id);
      if (state.report && state.report.tampered) {
        body.appendChild(refusal('The wallet file on this Mac has been edited, so no address in it can be trusted.'));
        return;
      }
      if (!state.report || !network) {
        var why = state.failed
          ? 'The addresses could not be read. ' + state.failed
          : (state.report && state.report.reason
            ? state.report.reason.charAt(0).toUpperCase() + state.report.reason.slice(1) + '.'
            : 'This wallet has no deposit address on ' + n.name + ' yet.');
        body.appendChild(refusal(why));
        if (state.failed) {
          body.appendChild(retryRow(function () {
            load(true).then(function () {
              if (!state.alive || state.stage !== 'tokens') return;
              dom.clear(body);
              drawTokens(body, n);
            });
          }));
        }
        return;
      }
      if (network.unavailable) {
        body.appendChild(refusal('No deposit address on ' + n.name + ' right now: ' + network.unavailable));
        return;
      }

      var tokens = sortTokens(network.accepts, n.native);
      if (!tokens.length) {
        body.appendChild(refusal('The bridge credits nothing on ' + n.name + ' right now, so there is no address to show.'));
        return;
      }

      var search = dom.el('div', 'netpick-search');
      search.appendChild(icon('search', 'netpick-search-icon'));
      var input = dom.el('input', 'input netpick-search-input');
      input.type = 'text';
      input.name = 'token-search';
      input.placeholder = 'Search tokens';
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.setAttribute('aria-label', 'Search tokens');
      input.setAttribute('autocapitalize', 'characters');
      search.appendChild(input);
      body.appendChild(search);

      var list = dom.el('div', 'netpick-list');
      list.setAttribute('role', 'list');
      list.setAttribute('aria-label', 'Tokens credited on ' + n.name);
      body.appendChild(list);

      var empty = dom.el('p', 'netpick-empty');
      empty.hidden = true;
      body.appendChild(empty);

      function fill() {
        dom.clear(list);
        var shown = filterTokens(tokens, state.query);
        dom.setHidden(empty, shown.length > 0);
        dom.setHidden(list, shown.length === 0);
        if (!shown.length) {
          dom.setText(empty, 'No token called ' + state.query.trim() + ' on ' + n.name + '.');
          return;
        }
        shown.forEach(function (token) { list.appendChild(tokenRow(token)); });
      }

      dom.on(input, 'input', function () {
        state.query = input.value || '';
        fill();
      });
      fill();

      /* Behind the developer switch: the bridge's own id for this network. */
      var bridge = dom.el('p', 'netpick-dev mono');
      bridge.setAttribute('data-dev-only', '');
      dom.setText(bridge, 'Bridge network id: ' + bridgeId(n.id));
      body.appendChild(bridge);

      body.appendChild(ackBlock(n, network, tokens));
    }

    function bridgeId(id) {
      return { eth: 'eth:1', base: 'eth:8453', arb: 'eth:42161', sol: 'sol:mainnet', near: 'near:mainnet' }[id] || id;
    }

    /* One token, one row: the mark, the symbol, and the minimum in the unit a
       person types, never the bridge's base units. */
    function tokenRow(token) {
      var row = dom.el('div', 'token-row');
      row.setAttribute('role', 'listitem');
      row.dataset.symbol = String(token.symbol);
      row.appendChild(logo(token.symbol, 24));
      var main = dom.el('div', 'token-main');
      main.appendChild(dom.el('span', 'token-symbol', token.symbol));
      if (token.contract) {
        var contract = dom.el('span', 'token-contract mono');
        contract.setAttribute('data-dev-only', '');
        dom.setText(contract, token.contract);
        main.appendChild(contract);
      }
      row.appendChild(main);
      var floor = minimumWords(token);
      var min = dom.el('span', 'token-min mono');
      dom.setText(min, floor ? 'min ' + floor : 'no minimum');
      row.appendChild(min);
      return row;
    }

    /* Under the list, once per install: a person says they have read what is
       credited before the address is shown. Remembered, it is one small button. */
    function ackBlock(n, network, tokens) {
      var wrap = dom.el('div', 'netpick-ack');
      var go = button('Show the address', ackRemembered() ? 'btn-ghost btn-sm' : 'btn-primary');
      go.dataset.role = 'show-address';
      if (!ackRemembered()) {
        var row = dom.el('label', 'ack-row');
        var box = dom.el('input', 'ack-input');
        box.type = 'checkbox';
        box.name = 'deposit-ack';
        row.appendChild(box);
        var drawn = dom.el('span', 'ack-box');
        drawn.setAttribute('aria-hidden', 'true');
        drawn.appendChild(icon('done', 'ack-check'));
        row.appendChild(drawn);
        row.appendChild(dom.el('span', 'ack-text', 'I understand only the tokens above are credited here. Anything else sent to this address is lost.'));
        wrap.appendChild(row);
        go.disabled = true;
        dom.on(box, 'change', function () {
          go.disabled = !box.checked;
          if (box.checked) row.dataset.checked = 'true';
          else delete row.dataset.checked;
        });
        dom.on(go, 'click', function () {
          if (!box.checked) return;
          rememberAck();
          proceed(n, network, tokens);
        });
      } else {
        wrap.dataset.remembered = 'true';
        dom.on(go, 'click', function () { proceed(n, network, tokens); });
      }
      var actions = dom.el('div', 'netpick-actions');
      actions.appendChild(go);
      wrap.appendChild(actions);
      return wrap;
    }

    function proceed(n, network, tokens) {
      var symbol = state.symbol && tokenOf(network, state.symbol) ? state.symbol : defaultSymbol(tokens, n.native);
      state.symbol = symbol;
      if (typeof opts.onAddress === 'function') {
        opts.onAddress(n.id, symbol, network);
        return;
      }
      stageAddress();
    }

    /* ---------- step three: the address ---------- */

    function stageAddress() {
      var n = networkOf(state.network);
      if (!n) return stageNetworks();
      var node = dom.el('div');
      node.appendChild(stageHead(n, 'Send on ' + n.name + ' only.', true));

      var body = dom.el('div', 'deposit-body');
      node.appendChild(body);

      var watch = dom.el('div', 'deposit-watch');
      watch.setAttribute('role', 'status');
      watch.hidden = true;
      watch.appendChild(dom.el('span', 'dot'));
      var watchText = dom.el('span', 'body deposit-watch-text');
      watch.appendChild(watchText);
      var stop = button('Stop watching', 'btn-quiet btn-sm');
      dom.on(stop, 'click', function () {
        window.PhosphorShell.setPending(stop, true, 'Stopping');
        api.depositStop()
          .catch(function (err) { window.PhosphorToast.show(net.readable(err), 'down'); })
          .finally(function () { window.PhosphorShell.setPending(stop, false); });
      });
      watch.appendChild(stop);
      node.appendChild(watch);
      state.watch = { node: watch, text: watchText, stop: stop };

      show('address', node);
      skeleton(body);
      load().then(function () {
        if (!state.alive || state.stageNode !== node) return;
        drawAddress(body, n);
      });
      followWatch();
    }

    function skeleton(host) {
      dom.clear(host);
      var skel = dom.el('div', 'skel');
      skel.style.height = '120px';
      host.appendChild(skel);
    }

    function refusal(why) {
      var banner = dom.el('div', 'banner');
      banner.dataset.tone = 'down';
      banner.appendChild(dom.el('span', '', why));
      return banner;
    }

    function retryRow(fn) {
      var row = dom.el('div', 'netpick-actions');
      var retry = button('Try again', 'btn-ghost btn-sm');
      dom.on(retry, 'click', fn);
      row.appendChild(retry);
      return row;
    }

    function refuse(body, why) {
      dom.clear(body);
      body.appendChild(refusal(why));
      body.dataset.state = 'refused';
    }

    /* The checks, then the address. Nothing is drawn until every one passes,
       and each failure names itself in the address's place. */
    function drawAddress(body, n) {
      var report = state.report;
      var network = reportNetwork(n.id);
      if (report && report.tampered) {
        return refuse(body, 'The wallet file on this Mac has been edited, so no address in it can be trusted.');
      }
      if (!report || !network) {
        return refuse(body, state.failed
          ? 'The addresses could not be read. ' + state.failed
          : 'This wallet has no deposit address on ' + n.name + (report && report.reason ? ': ' + report.reason : '.'));
      }
      if (network.unavailable) {
        return refuse(body, 'No deposit address on ' + n.name + ' right now: ' + network.unavailable);
      }
      if (typeof network.address !== 'string' || !network.address.length) {
        return refuse(body, 'No deposit address on ' + n.name + ' right now.');
      }
      var token = tokenOf(network, state.symbol) || tokenOf(network, defaultSymbol(network.accepts, n.native));
      if (state.symbol && !tokenOf(network, state.symbol)) {
        return refuse(body, state.symbol + ' is not credited on ' + n.name + '. Sending it there loses it.');
      }

      /* Check 1: the wallet is open, so this address was derived from the keys
         and not read off an unauthenticated header. */
      if (report.verified !== true) return askToOpen(body, n);

      /* The watch that opened the card may carry an address of its own. If it
         does, and it is a watch on this network, it has to be this one. */
      if (state.deposit && state.deposit.chain === n.id
        && typeof state.deposit.address === 'string' && state.deposit.address.length
        && !sameBytes(state.deposit.address, network.address)) {
        return refuse(body, 'The address the watcher holds is not the one this wallet reports. Nothing is shown.');
      }

      var address = network.address;
      dom.clear(body);

      var qr = dom.el('div', 'qr deposit-qr');
      var canvas = dom.el('canvas');
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', 'QR code of the deposit address');
      qr.appendChild(canvas);
      var check = drawChecked(canvas, address);
      if (!check.ok) {
        return refuse(body, 'Nothing is shown: ' + check.why + ' Close this and open it again. If it happens twice, do not send money until it is fixed.');
      }

      body.dataset.state = 'shown';
      body.appendChild(qr);

      var side = dom.el('div', 'deposit-side');
      side.appendChild(addressBlock(address));

      if (network.memo) {
        var memo = dom.el('p', 'deposit-memo');
        memo.appendChild(dom.el('span', 'label', 'Memo, required: '));
        memo.appendChild(dom.el('span', 'mono', network.memo));
        side.appendChild(memo);
      }

      var tools = dom.el('div', 'deposit-tools');
      var copy = button('Copy', 'btn-ghost btn-sm');
      copy.dataset.role = 'copy';
      var said = dom.el('span', 'meta deposit-copied');
      said.setAttribute('role', 'status');
      tools.appendChild(copy);
      tools.appendChild(said);
      side.appendChild(tools);
      dom.on(copy, 'click', function () {
        copy.disabled = true;
        copyChecked(address, function (sentence) { dom.setText(said, sentence); })
          .then(function (ok) {
            if (!ok || !state.alive) return;
            dom.setText(copy.firstChild, 'Copied');
            copy.dataset.copied = 'true';
            if (state.copiedTimer) window.clearTimeout(state.copiedTimer);
            state.copiedTimer = window.setTimeout(function () {
              state.copiedTimer = 0;
              dom.setText(copy.firstChild, 'Copy');
              delete copy.dataset.copied;
            }, COPIED_MS);
          })
          .finally(function () { copy.disabled = false; });
      });
      body.appendChild(side);

      var notes = dom.el('div', 'deposit-notes');
      var plain = dom.el('p', 'deposit-plain');
      dom.setText(plain, EVM.indexOf(n.id) >= 0
        ? 'Ethereum, Base and Arbitrum use this same address. The network you send on is what decides where it lands, so choose ' + n.name + ' on the sending side.'
        : 'Choose ' + n.words + ' on the sending side. Anything sent here from another network is lost.');
      notes.appendChild(plain);

      if (token) {
        var floor = minimumWords(token);
        var minLine = dom.el('p', 'deposit-min');
        minLine.appendChild(dom.el('span', '', floor ? 'Minimum ' : 'No minimum for ' + token.symbol + '.'));
        if (floor) minLine.appendChild(dom.el('span', 'mono', floor));
        if (floor) minLine.appendChild(dom.el('span', '', '.'));
        var accepts = Array.isArray(network.accepts) ? network.accepts : [];
        if (accepts.length > 1) {
          var more = dom.el('button', 'netpick-link');
          more.type = 'button';
          more.appendChild(dom.el('span', '', 'All ' + accepts.length + ' tokens and minimums'));
          dom.on(more, 'click', function () { stageTokens(); });
          minLine.appendChild(dom.el('span', '', ' '));
          minLine.appendChild(more);
        }
        notes.appendChild(minLine);
      }
      body.appendChild(notes);

      /* The address is on screen, so the app starts listening for money on
         it, unless it already is: the deposit card opens with a watch the
         backend started, and a second start for the same network and token
         would only replace it. A different network or token is a new watch. */
      var watchSymbol = token ? token.symbol : state.symbol;
      var held = state.deposit;
      var same = held && held.chain === n.id && String(held.symbol || '').toUpperCase() === String(watchSymbol || '').toUpperCase();
      if (!same) startWatch(n, watchSymbol, address);
    }

    /* Check 1 failed: one button, the system dialog, then a fresh fetch. On a
       password wallet the lock screen is the way in and this steps aside. */
    function askToOpen(body, n) {
      dom.clear(body);
      body.dataset.state = 'unverified';
      var snapshot = store.get() || {};
      var vault = snapshot.vault || {};
      var enclave = vault.custody === 'secure-enclave';

      body.appendChild(dom.el('p', 'body', enclave
        ? 'The address is shown only once this Mac has opened the wallet, so it comes from your keys and not from a file anything could edit.'
        : 'The address is shown only once the wallet is unlocked, so it comes from your keys and not from a file anything could edit.'));

      var actions = dom.el('div', 'screen-actions');
      var go = button(enclave ? 'Touch ID to show the address' : 'Unlock to show the address', 'btn-primary');
      actions.appendChild(go);
      body.appendChild(actions);

      var error = dom.el('p', 'body down');
      error.hidden = true;
      body.appendChild(error);

      dom.on(go, 'click', function () {
        if (!enclave) {
          if (typeof opts.onDismiss === 'function') opts.onDismiss();
          if (window.PhosphorLock) window.PhosphorLock.focus();
          return;
        }
        error.hidden = true;
        window.PhosphorShell.setPending(go, true, 'Waiting for Touch ID');
        api.vaultUnlock('address')
          .then(function (answer) {
            if (answer && answer.ok === false) {
              if (answer.code !== 'user_cancel') {
                dom.setText(error, answer.error || 'That did not work.');
                error.hidden = false;
              }
              return;
            }
            window.PhosphorShell.refresh({});
            return load(true).then(function () {
              if (!state.alive || state.stage !== 'address') return;
              drawAddress(body, n);
            });
          })
          .catch(function (err) {
            dom.setText(error, net.readable(err));
            error.hidden = false;
          })
          .finally(function () {
            window.PhosphorShell.setPending(go, false);
          });
      });
    }

    /* ---------- the watch ---------- */

    function startWatch(n, symbol, address) {
      var starter = window.PhosphorDeposit && typeof window.PhosphorDeposit.startWatch === 'function'
        ? window.PhosphorDeposit.startWatch
        : function (chain, sym, addr) {
          return api.depositShow(chain, sym, addr).then(function (answer) {
            return answer && answer.ok !== false && answer.deposit ? answer.deposit : null;
          });
        };
      starter(n.id, symbol, address)
        .then(function (deposit) {
          if (!state.alive || !deposit) return;
          state.deposit = deposit;
          state.watchStart = deposit.startedAt || null;
          followWatch();
        })
        .catch(function (err) {
          if (!state.alive || !state.watch) return;
          state.watch.node.hidden = false;
          state.watch.node.dataset.phase = 'stopped';
          dom.setText(state.watch.text, 'Not watching for this deposit: ' + net.readable(err));
          state.watch.stop.hidden = true;
        });
    }

    function followWatch() {
      if (!state.unsubscribe) state.unsubscribe = store.select('deposit', function (deposit) { renderWatcher(deposit); });
      var live = store.get() ? store.get().deposit : null;
      renderWatcher(live && state.deposit && live.startedAt === state.deposit.startedAt ? live : state.deposit);
    }

    function renderWatcher(deposit) {
      if (!state.watch || !state.alive) return;
      var watch = state.watch;
      if (!deposit || !state.watchStart || deposit.startedAt !== state.watchStart) {
        watch.node.hidden = true;
        stopTick();
        return;
      }
      watch.node.hidden = false;
      watch.node.dataset.phase = deposit.phase;
      var symbol = deposit.symbol || state.symbol || '';
      var text = '';
      if (deposit.phase === 'watching') {
        text = 'Watching for your deposit, ' + elapsed(deposit.startedAt);
        startTick();
      } else if (deposit.phase === 'seen') {
        text = 'Seen on ' + networkWords(deposit.chain) + ': '
          + (typeof deposit.amount === 'number' ? dom.qty(deposit.amount) + ' ' + symbol : 'a deposit') + ', confirming';
        stopTick();
      } else if (deposit.phase === 'landed') {
        text = landedWords(Object.assign({}, deposit, { symbol: symbol }));
        stopTick();
      } else {
        text = 'Stopped watching.';
        stopTick();
      }
      dom.setText(watch.text, text);
      dom.setHidden(watch.stop, deposit.phase !== 'watching' && deposit.phase !== 'seen');
    }

    function startTick() {
      if (state.tick) return;
      state.tick = window.setInterval(function () {
        var snapshot = store.get() || {};
        renderWatcher(snapshot.deposit || null);
      }, 1000);
    }

    function stopTick() {
      if (!state.tick) return;
      window.clearInterval(state.tick);
      state.tick = 0;
    }

    function destroy() {
      state.alive = false;
      stopTick();
      if (state.copiedTimer) window.clearTimeout(state.copiedTimer);
      if (state.unsubscribe) state.unsubscribe();
      state.unsubscribe = null;
      if (root.parentNode === host) host.removeChild(root);
      if (host.__netpick === view) host.__netpick = null;
    }

    /* Where to start. A caller that already knows the network opens on its
       tokens, or on its address once the acknowledgement has been given. */
    function go(stage, network) {
      if (network) state.network = network;
      if (stage === 'address' && state.network) {
        if (ackRemembered()) stageAddress();
        else stageTokens();
      } else if (stage === 'tokens' && state.network) {
        stageTokens();
      } else {
        stageNetworks();
      }
    }

    go(opts.stage || 'network', opts.network || null);

    var view = {
      destroy: destroy,
      go: go,
      stage: function () { return state.stage; },
      network: function () { return state.network; },
      root: root
    };
    host.__netpick = view;
    return view;
  }

  window.PhosphorNetPick = {
    render: render,
    NETWORKS: NETWORKS,
    words: networkWords,
    name: networkName,
    defaultSymbol: defaultSymbol,
    sortTokens: sortTokens,
    filterTokens: filterTokens,
    ackRemembered: ackRemembered,
    rememberAck: rememberAck,
    chunks: chunks,
    drawChecked: drawChecked,
    copyChecked: copyChecked,
    sameBytes: sameBytes
  };
})();
