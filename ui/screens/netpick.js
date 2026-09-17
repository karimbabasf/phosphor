/* Money in, in three steps: the network, what it credits, the address.

   Karim, 2026-09-15, on the screens this replaces: "first you select the
   network you want to deposit from ... have it all colorless, and then when the
   mouse hovers on one of the buttons for the network it becomes colorful, but
   the real network color. then it shows a list, a proper list with the tokens
   like a wallet would show ... the address looks shit, it looks scary, should
   be simple and easy to use. if there is one address then what is the point of
   choosing the layer and token if they are literally the same, it's
   misleading."

   And 2026-09-16: "make them either fit in one row or something and also idk i
   feel like near supports much more networks, like bitcoin addresses and stuff
   like that. so build the rails for everything as well."

   So: six quick tiles in one row that never wraps, colourless at rest and in
   their brand colour under the pointer, and under them a search over every
   network the bridge credits (the backend's registry, thirty-odd today, read
   off the report so a network the bridge adds is on this list without a
   window change). Then the tokens that network credits, searchable, each with
   its minimum in the unit a person types, or "No minimum" where the bridge's
   floor is dust; each token with a contract is a row that copies that
   contract, read back byte for byte before the window says Copied. Then one
   address, and nothing to choose beside it.

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

  /* The six networks an exchange withdraw screen lists first, each with its
     brand colour, for the one row of tiles: the five the app has always
     credited and Bitcoin. Every other network comes off the report, where the
     backend's registry names it, colours it and says what it credits. The
     colours here are the chains' own (Base's brand blue is #0052FF, marks.js
     has the coin file's #0000FF). `words` is the network in the words an
     exchange's withdraw screen uses. */
  var NETWORKS = [
    { id: 'eth', name: 'Ethereum', mark: 'ETH', colour: '#627EEA', words: 'Ethereum (ERC-20)', native: 'ETH', kind: 'evm', popular: true },
    { id: 'base', name: 'Base', mark: 'BASE', colour: '#0052FF', words: 'Base', native: 'ETH', kind: 'evm', popular: true },
    { id: 'arb', name: 'Arbitrum', mark: 'ARB', colour: '#12AAFF', words: 'Arbitrum One', native: 'ETH', kind: 'evm', popular: true },
    { id: 'sol', name: 'Solana', mark: 'SOL', colour: '#9945FF', accent: '#14F195', words: 'Solana (SPL)', native: 'SOL', kind: 'sol', popular: true },
    { id: 'near', name: 'NEAR', mark: 'NEAR', colour: '#00EC97', words: 'NEAR Protocol', native: 'NEAR', kind: 'near', popular: true },
    { id: 'btc', name: 'Bitcoin', mark: 'BTC', colour: '#F7931A', words: 'Bitcoin (BTC)', native: 'BTC', kind: 'other', popular: true }
  ];
  var EVM = ['eth', 'base', 'arb'];

  /* Four modules of quiet zone, which is what a reader needs to find the edge,
     and no fewer than three pixels a module: the decoder here reads the same
     pixels a phone will. */
  var QUIET = 4;
  var QR_TARGET_PX = 176;
  var MIN_SCALE = 3;

  /* Every network the window has heard of: the six above, and every one a
     report named, kept across renders so a watcher line or a toast can say
     "Bitcoin" for a watch this render never drew. A report's row wins over the
     static entry for the fields it carries, so the backend's registry is the
     source of truth once it has been read. */
  var known = {};

  function remember(report) {
    var rows = report && Array.isArray(report.networks) ? report.networks : [];
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i];
      if (!row || typeof row.id !== 'string') continue;
      known[row.id] = merged(staticOf(row.id), row);
    }
  }

  function staticOf(id) {
    for (var i = 0; i < NETWORKS.length; i += 1) {
      if (NETWORKS[i].id === id) return NETWORKS[i];
    }
    return null;
  }

  /* The metadata of a network, never its address: the report row carries the
     address too, and a merged object that held one would be a second place an
     address lives. */
  function merged(base, row) {
    var out = {};
    var keys = ['id', 'name', 'mark', 'colour', 'accent', 'words', 'native', 'kind', 'popular'];
    for (var i = 0; i < keys.length; i += 1) {
      var key = keys[i];
      if (row && row[key] !== undefined && row[key] !== null && row[key] !== '') out[key] = row[key];
      else if (base && base[key] !== undefined) out[key] = base[key];
    }
    if (!out.name) out.name = String(out.id || '');
    if (!out.mark) out.mark = String(out.native || out.name || '?');
    if (!out.words) out.words = out.name;
    if (!out.kind) out.kind = 'other';
    return out;
  }

  function networkOf(id) {
    if (known[id]) return known[id];
    var base = staticOf(id);
    return base ? merged(base, null) : null;
  }

  function networkWords(chain) {
    var n = networkOf(chain);
    return n ? n.words : String(chain || '');
  }

  function networkName(chain) {
    var n = networkOf(chain);
    return n ? n.name : String(chain || '');
  }

  /* The list a search runs over: the report's networks in the report's order
     (popular first, then by name), or the six while no report has landed. */
  function allNetworks(report) {
    var rows = report && Array.isArray(report.networks) ? report.networks : [];
    if (!rows.length) return NETWORKS.map(function (n) { return merged(n, null); });
    var out = [];
    for (var i = 0; i < rows.length; i += 1) {
      if (rows[i] && typeof rows[i].id === 'string') out.push(networkOf(rows[i].id) || merged(null, rows[i]));
    }
    return out;
  }

  /* What starts with the letters typed, then what merely contains them, over
     the name, the exchange's words and the coin. */
  function filterNetworks(list, query) {
    var q = String(query || '').trim().toUpperCase();
    if (!q) return list.slice();
    var starts = [];
    var holds = [];
    for (var i = 0; i < list.length; i += 1) {
      var n = list[i];
      var hay = [n.name, n.words, n.native, n.id].join(' ').toUpperCase();
      if (String(n.name).toUpperCase().indexOf(q) === 0 || String(n.native || '').toUpperCase().indexOf(q) === 0) starts.push(n);
      else if (hay.indexOf(q) >= 0) holds.push(n);
    }
    return starts.concat(holds);
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

  /* The floor, as the report states it, or worked out here from the raw
     figure when a report predates the `minimum` field. A floor worth under a
     cent, or under a millionth of the coin where no price is known, is dust:
     the bridge would credit it, and no exchange lets a person send it, so the
     row says "No minimum" rather than printing eighteen zeros. */
  var DUST = 0.000001;

  function minimumOf(token) {
    if (!token) return null;
    var given = token.minimum && typeof token.minimum === 'object' ? token.minimum : null;
    var amount = given && typeof given.amount === 'string' ? given.amount : token.minDepositHuman;
    if (typeof amount !== 'string' || !amount) return null;
    var usd = given && typeof given.usd === 'number' && isFinite(given.usd) ? given.usd : null;
    var shown;
    if (given && typeof given.shown === 'boolean') shown = given.shown;
    else shown = Number(amount) >= DUST || (usd !== null && usd >= 0.01);
    return { shown: shown, amount: amount, symbol: String(token.symbol), usd: usd };
  }

  function minimumWords(token) {
    var min = minimumOf(token);
    if (!min) return '';
    if (!min.shown) return 'No minimum';
    var words = 'Min ' + min.amount + ' ' + min.symbol;
    if (min.usd !== null && min.usd >= 0.01) words += ', about ' + dom.usd(min.usd, min.usd < 1 ? 2 : 0);
    return words;
  }

  /* "0x8335...2913": the ends a person checks against the explorer. */
  function shortContract(contract) {
    var text = String(contract || '');
    if (text.length <= 14) return text;
    return text.slice(0, 6) + '...' + text.slice(-4);
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

  /* The shape an address has, from the network it is on: the registry's word
     for it, or the five the window has always known. */
  function kindOf(networkId) {
    var n = networkOf(networkId);
    if (n && n.kind && n.kind !== 'other') return n.kind;
    if (networkId === 'sol') return 'sol';
    if (networkId === 'near') return 'near';
    if (EVM.indexOf(networkId) >= 0) return 'evm';
    return n ? 'other' : null;
  }

  /* The shape read off the address itself, for a caller that did not say. */
  function inferKind(text) {
    if (/^0x[0-9a-fA-F]{40}$/.test(text)) return 'evm';
    if (/^[0-9a-f]{64}$/.test(text) || text.indexOf('.') >= 0) return 'near';
    return 'sol';
  }

  function fours(text) {
    var out = [];
    for (var i = 0; i < text.length; i += 4) out.push(text.slice(i, i + 4));
    return out;
  }

  /* Groups a person can check against the sending screen, even for each kind
     of address. An EVM address is "0x" on its own and then the forty hex
     characters in ten groups of four, so no group is ever an orphan of two.
     A Solana address is groups of four with any short remainder last. A NEAR
     address is an account name, never split. */
  function chunks(address, kind) {
    var text = String(address);
    var k = kind || inferKind(text);
    if (k === 'near') return [text];
    if (k === 'evm' && /^0x/i.test(text)) return ['0x'].concat(fours(text.slice(2)));
    return fours(text);
  }

  /* The address as one block: the whole string for a screen reader, then the
     groups, all one size and one weight, the "0x" quiet, the first and last
     group in the text colour and the rest one step quieter. Nothing is bold
     and nothing jumps in size: a person reads it left to right, checks the
     ends, and is done. */
  function addressBlock(address, kind) {
    var block = dom.el('div', 'deposit-address mono');
    block.appendChild(dom.el('span', 'sr-only', address));
    var parts = chunks(address, kind);
    var shown = dom.el('span', 'deposit-chunks');
    shown.setAttribute('aria-hidden', 'true');
    if (parts.length > 1 && parts[0] === '0x') {
      shown.appendChild(dom.el('span', 'addr-prefix', parts[0]));
      parts = parts.slice(1);
    }
    if (parts.length === 1) {
      shown.appendChild(dom.el('span', 'addr-whole', parts[0]));
    } else {
      for (var i = 0; i < parts.length; i += 1) {
        var end = i === 0 || i === parts.length - 1;
        shown.appendChild(dom.el('span', end ? 'addr-end' : 'addr-mid', parts[i]));
      }
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
     rather than reported as copied. Resolves true only on a read-back match.
     `what` names the thing in the sentence: an address by default, a memo, or
     a token's contract, so "Copied" never leaves a person unsure whether the
     clipboard holds the place to send to or the coin's contract. */
  function copyChecked(address, say, what) {
    var noun = what || 'address';
    var Noun = noun.charAt(0).toUpperCase() + noun.slice(1);
    var clip = window.navigator ? window.navigator.clipboard : null;
    if (!clip || typeof clip.writeText !== 'function') {
      say('This window cannot reach the clipboard. Read the ' + noun + ' from the screen.');
      return Promise.resolve(false);
    }
    var unread = Noun + ' copied, but the clipboard could not be read back. Check it ends in ...' + tail(address) + ' before you send.';
    return clip.writeText(address)
      .then(function () {
        if (typeof clip.readText !== 'function') {
          say(unread);
          return false;
        }
        return clip.readText().then(function (back) {
          if (sameBytes(back, address)) {
            say(Noun + ' copied, ends in ...' + tail(address));
            return true;
          }
          say('The clipboard does not hold the ' + noun + ': something else is in it. Copy again, or read it from the screen.');
          return false;
        }, function () {
          say(unread);
          return false;
        });
      })
      .catch(function () {
        say('The copy did not work. Read the ' + noun + ' from the screen.');
        return false;
      });
  }

  /* ---------- the watcher line ---------- */

  function elapsed(startedAt) {
    var then = new Date(startedAt).getTime();
    if (!isFinite(then)) return '0:00';
    var seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
    var minutes = Math.floor(seconds / 60);
    var rest = seconds % 60;
    return minutes + ':' + (rest < 10 ? '0' : '') + rest;
  }

  function shortAddress(address) {
    var text = String(address || '');
    if (text.length <= 14) return text;
    return text.slice(0, 6) + '...' + text.slice(-4);
  }

  function seconds(ms) {
    return String(Math.max(1, Math.round(ms / 1000)));
  }

  /* What the line says for a frame: plain words, with every number marked so it
     can be set in the mono face. A part is a string or { mono: '0:42' }. The
     phases come from src/vault/watch.ts: watching (this app asking), seen (the
     bridge saw the transfer arrive, confirming), bridged (the bridge is done,
     the verifier is crediting), credited (the balance went up), stopped. */
  function watcherParts(deposit) {
    var symbol = deposit.symbol || '';
    var network = networkName(deposit.chain);
    var amount = typeof deposit.amount === 'number' ? [{ mono: dom.qty(deposit.amount) }, ' ' + symbol] : null;
    if (deposit.phase === 'watching') {
      var where = deposit.address ? ['Watching ' + network + ' for a deposit to ', { mono: shortAddress(deposit.address) }] : ['Watching ' + network + ' for your deposit'];
      return where.concat([', ', { mono: elapsed(deposit.startedAt) }]);
    }
    if (deposit.phase === 'seen') {
      var parts = ['Seen on ' + network + ': '].concat(amount || ['a deposit']);
      if (typeof deposit.confirmations === 'number') {
        return parts.concat([', ', { mono: String(deposit.confirmations) }, deposit.confirmations === 1 ? ' confirmation' : ' confirmations']);
      }
      return parts.concat([', confirming']);
    }
    if (deposit.phase === 'bridged') {
      return ['Bridged into NEAR Intents: '].concat(amount || ['your deposit']).concat([', crediting']);
    }
    if (deposit.phase === 'credited') {
      var landed = typeof deposit.ms === 'number' ? ['Landed in ', { mono: seconds(deposit.ms) }, ' s: '] : ['Landed: '];
      return landed.concat(amount || [symbol]).concat([' is in your balance']);
    }
    return ['Stopped watching.'];
  }

  /* One renderer for every surface that shows a watch: the picker's address
     step and the first run's money step draw the same line off the same frame,
     so a deposit reads the same wherever the person is standing. The mark
     carries the phase (a breathing dot, then the check), the words say it, the
     hash is a link to the explorer, and the last read failure sits under it in
     the quiet face. The clock runs only while watching. `stop: false` leaves
     the Stop button off, for a surface that has nowhere to put it. */
  function watcherLine(host, options) {
    var opts = options || {};
    var node = dom.el('div', 'deposit-watch');
    node.setAttribute('role', 'status');
    node.hidden = true;
    var mark = dom.el('span', 'deposit-watch-mark');
    node.appendChild(mark);
    var body = dom.el('div', 'deposit-watch-body');
    var text = dom.el('span', 'body deposit-watch-text');
    body.appendChild(text);
    var link = dom.el('a', 'deposit-watch-link', 'View');
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.hidden = true;
    body.appendChild(link);
    var note = dom.el('span', 'meta deposit-watch-note');
    note.hidden = true;
    body.appendChild(note);
    node.appendChild(body);
    var stop = null;
    if (opts.stop !== false) {
      stop = button('Stop watching', 'btn-quiet btn-sm');
      dom.on(stop, 'click', function () {
        window.PhosphorShell.setPending(stop, true, 'Stopping');
        api.depositStop()
          .catch(function (err) { window.PhosphorToast.show(net.readable(err), 'down'); })
          .finally(function () { window.PhosphorShell.setPending(stop, false); });
      });
      node.appendChild(stop);
    }
    host.appendChild(node);

    var tick = 0;
    var markPhase = null;
    var last = null;

    function drawMark(phase) {
      if (markPhase === phase) return;
      markPhase = phase;
      dom.clear(mark);
      mark.appendChild(phase === 'credited' ? icon('done', 'deposit-watch-check') : dom.el('span', 'dot'));
    }

    function write(parts) {
      dom.clear(text);
      for (var i = 0; i < parts.length; i += 1) {
        var part = parts[i];
        text.appendChild(typeof part === 'string' ? dom.el('span', '', part) : dom.el('span', 'mono', part.mono));
      }
    }

    function startTick() {
      if (tick) return;
      tick = window.setInterval(function () { if (last) render(last); }, 1000);
    }

    function stopTick() {
      if (!tick) return;
      window.clearInterval(tick);
      tick = 0;
    }

    function render(deposit) {
      if (!deposit || typeof deposit.phase !== 'string') {
        last = null;
        node.hidden = true;
        stopTick();
        return;
      }
      last = deposit;
      node.hidden = false;
      node.dataset.phase = deposit.phase;
      write(watcherParts(deposit));
      var url = typeof deposit.explorerUrl === 'string' && /^https:\/\//.test(deposit.explorerUrl) ? deposit.explorerUrl : null;
      link.hidden = url === null;
      if (url !== null) link.href = url;
      var why = typeof deposit.error === 'string' && deposit.error !== '' ? deposit.error : null;
      note.hidden = why === null;
      dom.setText(note, why === null ? '' : why);
      drawMark(deposit.phase);
      if (stop) dom.setHidden(stop, deposit.phase === 'credited' || deposit.phase === 'stopped');
      if (deposit.phase === 'watching') startTick();
      else stopTick();
    }

    function destroy() {
      stopTick();
      last = null;
      if (node.parentNode) node.parentNode.removeChild(node);
    }

    return { node: node, text: text, stop: stop, render: render, destroy: destroy };
  }

  /* ---------- the component ---------- */

  function render(host, options) {
    var opts = options || {};
    if (host.__netpick && typeof host.__netpick.destroy === 'function') host.__netpick.destroy();
    var root = dom.el('div', 'netpick');
    root.dataset.context = opts.context || 'basic';
    dom.clear(host);
    host.appendChild(root);

    remember(opts.report || null);

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
          remember(state.report);
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

    /* Six tiles in one row that never wraps, then a search over every network
       the bridge credits. The list draws only while there is a query or the
       person asked for all of them: thirty rows under six tiles would push
       the whole fold off the screen for the one network they came for. */
    function stageNetworks() {
      var node = dom.el('div');
      node.appendChild(dom.el('p', 'netpick-lead', 'Pick the network you are sending on.'));
      var grid = dom.el('div', 'netpick-grid');
      grid.setAttribute('role', 'group');
      grid.setAttribute('aria-label', 'Networks');
      var tiles = [];
      NETWORKS.forEach(function (base, index) {
        var n = networkOf(base.id) || base;
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
        markUnavailable(tile, n.id);
        if (state.network === n.id) tile.setAttribute('aria-current', 'true');
        dom.on(tile, 'click', function () { pick(n.id); });
        dom.on(tile, 'keydown', function (event) { onTileKey(event, index); });
        tiles.push(tile);
        grid.appendChild(tile);
      });
      node.appendChild(grid);

      /* The search over all of them. */
      var search = dom.el('div', 'netpick-search netpick-netsearch');
      search.appendChild(icon('search', 'netpick-search-icon'));
      var input = dom.el('input', 'input netpick-search-input');
      input.type = 'text';
      input.name = 'network-search';
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.setAttribute('aria-label', 'Search networks');
      search.appendChild(input);
      node.appendChild(search);

      var list = dom.el('div', 'netpick-list netpick-netlist');
      list.setAttribute('role', 'list');
      list.setAttribute('aria-label', 'All networks');
      list.hidden = true;
      node.appendChild(list);

      var empty = dom.el('p', 'netpick-empty');
      empty.hidden = true;
      node.appendChild(empty);

      var foot = dom.el('div', 'netpick-netfoot');
      var all = dom.el('button', 'netpick-link');
      all.type = 'button';
      all.dataset.role = 'all-networks';
      foot.appendChild(all);
      node.appendChild(foot);

      var query = '';
      var showAll = false;

      function placeholder() {
        var total = allNetworks(state.report).length;
        input.placeholder = total > NETWORKS.length
          ? 'Search all ' + total + ' networks'
          : 'Search networks';
      }

      function fillList() {
        var every = allNetworks(state.report);
        var others = every.length - NETWORKS.length;
        dom.setText(all, showAll ? 'Fewer networks' : (others > 0 ? 'All ' + every.length + ' networks' : ''));
        dom.setHidden(foot, others <= 0);
        var q = query.trim();
        if (!q && !showAll) {
          dom.setHidden(list, true);
          dom.setHidden(empty, true);
          return;
        }
        var shown = filterNetworks(every, q);
        dom.clear(list);
        dom.setHidden(empty, shown.length > 0);
        dom.setHidden(list, shown.length === 0);
        if (!shown.length) {
          dom.setText(empty, 'No network called ' + q + '. Check the name your exchange uses.');
          return;
        }
        shown.forEach(function (n) { list.appendChild(networkRow(n)); });
      }

      dom.on(input, 'input', function () {
        query = input.value || '';
        fillList();
      });
      dom.on(all, 'click', function () {
        showAll = !showAll;
        fillList();
      });

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

      placeholder();
      fillList();

      /* The report is read behind the tiles, so a network the bridge refused
         is greyed by the time the pointer gets there, and the search knows
         every network by the time a letter is typed. */
      if (!state.report) {
        load().then(function () {
          if (!state.alive || state.stageNode !== node) return;
          tiles.forEach(function (tile) { markUnavailable(tile, tile.dataset.network); });
          placeholder();
          fillList();
        });
      }
      show('network', node);
    }

    function markUnavailable(tile, id) {
      var known = reportNetwork(id);
      if (!known || !known.unavailable) return;
      tile.dataset.unavailable = 'true';
      tile.setAttribute('aria-disabled', 'true');
      tile.title = 'Not available right now: ' + known.unavailable;
    }

    /* One network in the list: the mark, the name, and at the right what it
       credits, three symbols and a count for the rest. */
    function networkRow(n) {
      var row = dom.el('button', 'net-row');
      row.type = 'button';
      row.setAttribute('role', 'listitem');
      row.dataset.network = n.id;
      setVar(row, '--net', n.colour || 'var(--text-2)');
      row.appendChild(logo(n.mark, 24));
      var main = dom.el('div', 'net-row-main');
      main.appendChild(dom.el('span', 'net-row-name', n.name));
      if (n.words && n.words !== n.name) main.appendChild(dom.el('span', 'net-row-words', n.words));
      row.appendChild(main);
      var known = reportNetwork(n.id);
      var accepts = known && Array.isArray(known.accepts) ? known.accepts : [];
      /* The symbols in a wallet's order, each once: a bridge that lists one
         coin twice (two routes in) is still one coin to send. */
      var symbols = [];
      var seen = {};
      var sorted = sortTokens(accepts, n.native);
      for (var i = 0; i < sorted.length; i += 1) {
        var sym = String(sorted[i].symbol);
        if (!seen[sym]) { seen[sym] = true; symbols.push(sym); }
      }
      var side = dom.el('span', 'net-row-side');
      if (known && known.unavailable) {
        row.dataset.unavailable = 'true';
        row.title = 'Not available right now: ' + known.unavailable;
        dom.setText(side, 'Unavailable');
      } else if (symbols.length) {
        dom.setText(side, symbols.slice(0, 3).join(', ') + (symbols.length > 3 ? ' +' + (symbols.length - 3) : ''));
      }
      row.appendChild(side);
      dom.on(row, 'click', function () { pick(n.id); });
      return row;
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

      /* What the last copy did, in words, under the list: the sentence a
         screen reader hears and the one a person checks the paste against. */
      var said = dom.el('p', 'meta netpick-copied');
      said.setAttribute('role', 'status');
      body.appendChild(said);
      var say = function (sentence) { dom.setText(said, sentence); };

      function fill() {
        dom.clear(list);
        var shown = filterTokens(tokens, state.query);
        dom.setHidden(empty, shown.length > 0);
        dom.setHidden(list, shown.length === 0);
        if (!shown.length) {
          dom.setText(empty, 'No token called ' + state.query.trim() + ' on ' + n.name + '.');
          return;
        }
        shown.forEach(function (token) { list.appendChild(tokenRow(token, say)); });
      }

      dom.on(input, 'input', function () {
        state.query = input.value || '';
        fill();
      });
      fill();

      /* Behind the developer switch: the bridge's own id for this network. */
      var bridge = dom.el('p', 'netpick-dev mono');
      bridge.setAttribute('data-dev-only', '');
      dom.setText(bridge, 'Bridge network id: ' + (network && typeof network.bridge === 'string' && network.bridge ? network.bridge : bridgeId(n.id)));
      body.appendChild(bridge);

      body.appendChild(ackBlock(n, network, tokens));
    }

    function bridgeId(id) {
      return { eth: 'eth:1', base: 'eth:8453', arb: 'eth:42161', sol: 'sol:mainnet', near: 'near:mainnet' }[id] || id;
    }

    /* One token, one row: the mark, the symbol, the minimum in the unit a
       person types, never the bridge's base units, and where the token has a
       contract, the contract's ends under the symbol and a copy glyph at the
       right. The whole row is the button: a click writes the contract to the
       clipboard, reads it back, compares it byte for byte, and only then says
       Copied, with the last four characters, so what was pasted can be checked
       against what was shown. The chain's own coin has no contract and says
       so; its row does nothing. */
    function tokenRow(token, say) {
      var contract = typeof token.contract === 'string' && token.contract && token.contract !== 'native' ? token.contract : null;
      var row = dom.el(contract ? 'button' : 'div', 'token-row');
      if (contract) row.type = 'button';
      row.setAttribute('role', 'listitem');
      row.dataset.symbol = String(token.symbol);
      row.appendChild(logo(token.symbol, 24));
      var main = dom.el('div', 'token-main');
      main.appendChild(dom.el('span', 'token-symbol', token.symbol));
      var line = dom.el('span', 'token-contract mono');
      if (contract) {
        row.dataset.contract = contract;
        row.setAttribute('aria-label', 'Copy the ' + token.symbol + ' contract address');
        row.title = contract;
        dom.setText(line, shortContract(contract));
      } else {
        dom.setText(line, 'The chain\'s own coin, no contract');
        line.className = 'token-contract token-native';
      }
      main.appendChild(line);
      row.appendChild(main);
      var side = dom.el('span', 'token-side');
      var min = dom.el('span', 'token-min mono');
      dom.setText(min, minimumWords(token));
      side.appendChild(min);
      if (contract) {
        var glyph = dom.el('span', 'token-copy');
        glyph.setAttribute('aria-hidden', 'true');
        glyph.appendChild(icon('copy', 'token-copy-icon'));
        glyph.appendChild(icon('done', 'token-copied-icon'));
        side.appendChild(glyph);
        dom.on(row, 'click', function () {
          if (row.disabled) return;
          row.disabled = true;
          copyChecked(contract, function (sentence) { if (say) say(sentence); }, token.symbol + ' contract')
            .then(function (ok) {
              if (!ok || !state.alive) return;
              row.dataset.copied = 'true';
              dom.setText(line, 'Contract copied, ends in ...' + tail(contract));
              if (row.__copiedTimer) window.clearTimeout(row.__copiedTimer);
              row.__copiedTimer = window.setTimeout(function () {
                row.__copiedTimer = 0;
                delete row.dataset.copied;
                dom.setText(line, shortContract(contract));
              }, COPIED_MS);
            })
            .finally(function () { row.disabled = false; });
        });
      }
      row.appendChild(side);
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

      if (state.watch) state.watch.destroy();
      state.watch = watcherLine(node);

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
      var memoText = typeof network.memo === 'string' && network.memo ? network.memo : null;
      dom.clear(body);

      /* A memo network (Stellar today) hands everybody one address and tells
         the deposits apart by memo, so a send without the memo is credited to
         nobody and not refunded. No QR of the bare address, then: a wallet
         that scans one sends without the memo. The address and the memo each
         get their own Copy, and the card says why (security review,
         2026-09-16). */
      if (memoText === null) {
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
      } else {
        body.dataset.state = 'shown';
        body.dataset.memo = 'true';
      }

      var side = dom.el('div', 'deposit-side');
      side.appendChild(addressBlock(address, kindOf(n.id)));

      var tools = dom.el('div', 'deposit-tools');
      var copy = button(memoText === null ? 'Copy' : 'Copy address', 'btn-ghost btn-sm');
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
              dom.setText(copy.firstChild, memoText === null ? 'Copy' : 'Copy address');
              delete copy.dataset.copied;
            }, COPIED_MS);
          })
          .finally(function () { copy.disabled = false; });
      });

      if (memoText !== null) {
        var memoBlock = dom.el('div', 'deposit-memo');
        memoBlock.appendChild(dom.el('p', 'label', 'Memo, required with the address'));
        memoBlock.appendChild(dom.el('p', 'deposit-memo-value mono', memoText));
        var memoTools = dom.el('div', 'deposit-tools');
        var copyMemo = button('Copy memo', 'btn-ghost btn-sm');
        copyMemo.dataset.role = 'copy-memo';
        var saidMemo = dom.el('span', 'meta deposit-copied');
        saidMemo.setAttribute('role', 'status');
        memoTools.appendChild(copyMemo);
        memoTools.appendChild(saidMemo);
        memoBlock.appendChild(memoTools);
        dom.on(copyMemo, 'click', function () {
          copyMemo.disabled = true;
          copyChecked(memoText, function (sentence) { dom.setText(saidMemo, sentence); }, 'memo')
            .finally(function () { copyMemo.disabled = false; });
        });
        var memoWarn = dom.el('p', 'deposit-memo-warn');
        dom.setText(memoWarn, 'Paste the memo into the memo or tag field on the sending side. This address is shared with other people and the memo is what credits the money to you; without it the deposit goes to nobody and is not refunded. No QR code here, because a scanned address leaves the memo out.');
        memoBlock.appendChild(memoWarn);
        side.appendChild(memoBlock);
      }
      body.appendChild(side);

      var notes = dom.el('div', 'deposit-notes');
      var plain = dom.el('p', 'deposit-plain');
      dom.setText(plain, sharedWords(n, network));
      notes.appendChild(plain);

      if (token) {
        var minLine = dom.el('p', 'deposit-min');
        var min = minimumOf(token);
        minLine.appendChild(dom.el('span', '', min && min.shown
          ? minimumWords(token).replace(/^Min /, 'Minimum ') + '.'
          : 'No minimum for ' + token.symbol + '.'));
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

    /* Which networks this address also serves, from the report's own byte
       comparison, never from a table: the bridge hands the EVM chains one
       address, and the sentence names the ones it actually did. */
    function sharedWords(n, network) {
      var ids = network && Array.isArray(network.sharedWith) ? network.sharedWith : null;
      if (ids === null && EVM.indexOf(n.id) >= 0) ids = EVM.filter(function (id) { return id !== n.id; });
      var names = [];
      for (var i = 0; ids && i < ids.length; i += 1) names.push(networkName(ids[i]));
      if (!names.length) return 'Choose ' + n.words + ' on the sending side. Anything sent here from another network is lost.';
      /* Three named and the rest counted: sixteen EVM chains in one sentence
         is a sentence nobody reads to the end. */
      var list;
      if (names.length <= 3) list = names.length === 1 ? names[0] : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
      else list = names.slice(0, 3).join(', ') + ' and ' + (names.length - 3) + ' more';
      return n.name + ', ' + list + ' use this same address. The network you send on is what decides where it lands, so choose ' + n.words + ' on the sending side.';
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
          state.watch.render({ phase: 'stopped', chain: n.id, symbol: symbol, error: 'Not watching for this deposit: ' + net.readable(err) });
        });
    }

    function followWatch() {
      if (!state.unsubscribe) state.unsubscribe = store.select('deposit', function (deposit) { renderWatcher(deposit); });
      var live = store.get() ? store.get().deposit : null;
      renderWatcher(live && state.deposit && live.startedAt === state.deposit.startedAt ? live : state.deposit);
    }

    /* The line follows the watch this step started and no other: a frame for a
       watch begun elsewhere (another network, the agent's card) hides it. */
    function renderWatcher(deposit) {
      if (!state.watch || !state.alive) return;
      var mine = deposit && state.watchStart && deposit.startedAt === state.watchStart;
      state.watch.render(mine ? Object.assign({}, deposit, { symbol: deposit.symbol || state.symbol || '' }) : null);
    }

    function destroy() {
      state.alive = false;
      if (state.watch) state.watch.destroy();
      state.watch = null;
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
      /* A network the window has not heard of yet (one the report names and
         the six do not) is read off the report before its step is drawn,
         rather than falling back to the tiles because the name was unknown
         for a moment. */
      if ((stage === 'address' || stage === 'tokens') && state.network && !networkOf(state.network) && !state.report) {
        load().then(function () {
          if (!state.alive) return;
          go(stage, null);
        });
        return;
      }
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
    networkOf: networkOf,
    allNetworks: allNetworks,
    filterNetworks: filterNetworks,
    remember: remember,
    minimumWords: minimumWords,
    shortContract: shortContract,
    defaultSymbol: defaultSymbol,
    sortTokens: sortTokens,
    filterTokens: filterTokens,
    ackRemembered: ackRemembered,
    rememberAck: rememberAck,
    chunks: chunks,
    kindOf: kindOf,
    addressBlock: addressBlock,
    drawChecked: drawChecked,
    copyChecked: copyChecked,
    sameBytes: sameBytes,
    watcherLine: watcherLine,
    watcherParts: watcherParts
  };
})();
