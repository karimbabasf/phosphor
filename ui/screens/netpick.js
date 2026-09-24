/* Money in, in three steps: the network, what can be sent on it, the address.

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
   network the bridge takes money on (the backend's registry, thirty-odd
   today, read off the report so a network the bridge adds is on this list
   without a window change). Then the tokens that can be sent on that
   network, searchable, each with its minimum in the unit a person types, or
   "No minimum" where the bridge's floor is dust; no token row copies
   anything (its contract read as the address to send to). Then one address,
   and nothing to choose beside it.

   One component, four hosts. The Money in fold and the wizard's addresses
   step run all three steps in place. The deposit card opens at the step its
   caller asks for. The Vault tab's Addresses card runs step two under its own
   network menu and hands step three to the deposit card. The chat's deposit
   card ('chat') draws step three inside the thread, compact, with no way back
   to the tiles: the agent already named the network. The address is drawn
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
  /* A watch with nothing seen after this long says how long it has waited. */
  var LATE_MS = 10 * 60 * 1000;

  /* The one list writes every href in this window (core/links.js). */
  function setHref(anchor, url) {
    var links = window.PhosphorLinks;
    return !!links && typeof links.setHref === 'function' && links.setHref(anchor, url);
  }

  /* The six networks an exchange withdraw screen lists first, for the one row
     of tiles: the five the app has always taken money on and Bitcoin. Every
     other network comes off the report, where the backend's registry names it
     and says what can be sent on it. A tile's colour is its logo's
     (colourOf: ui/design/marks.js is the one table), so the hover never
     disagrees with the mark beside it; the colours here stand in only where
     that table is not loaded. `words` is the network in the words an
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

  /* The colour a network wears under the pointer: its logo's, from the one
     table in ui/design/marks.js, so Stellar's hover is Stellar's mark and not
     a purple the registry once picked. The registry's colour is the fallback
     for a mark the table does not know. */
  function colourOf(n) {
    var marks = window.PhosphorMarks;
    var own = n && marks && typeof marks.colourFor === 'function' ? marks.colourFor(n.mark) : '';
    return own || (n && n.colour) || '';
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

  /* The floors of the first two tokens in the list, for the address step:
     the list is something to read, not a choice, so the step names the two a
     person most likely holds rather than one it guessed ("Minimums: ETH none,
     USDC 0.001."). The rest are one click away. */
  function minimumsWords(tokens) {
    var list = Array.isArray(tokens) ? tokens : [];
    var parts = [];
    for (var i = 0; i < list.length && parts.length < 2; i += 1) {
      var min = minimumOf(list[i]);
      if (min) parts.push(min);
    }
    if (!parts.length) return '';
    if (parts.length === 1) {
      return parts[0].shown ? 'Minimum ' + parts[0].amount + ' ' + parts[0].symbol + '.' : 'No minimum for ' + parts[0].symbol + '.';
    }
    return 'Minimums: ' + parts.map(function (m) { return m.symbol + ' ' + (m.shown ? m.amount : 'none'); }).join(', ') + '.';
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

  function button(label, kind, pending) {
    var node = dom.el('button', 'btn ' + (kind || 'btn-ghost'));
    node.type = 'button';
    node.appendChild(dom.el('span', 'btn-label', label));
    if (pending) dom.setAttr(node, 'data-pending-label', pending);
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
     ends, and is done. It is set in Geist Mono (.addr), the one face that
     keeps a 0 and an O, and a 1 and an l, apart. */
  function addressBlock(address, kind) {
    var block = dom.el('div', 'deposit-address addr');
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
  function drawChecked(canvas, address, targetPx) {
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
    var target = typeof targetPx === 'number' && targetPx > 0 ? targetPx : QR_TARGET_PX;
    var scale = Math.max(MIN_SCALE, Math.floor(target / total));
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

  function waitedMs(startedAt) {
    var then = new Date(startedAt).getTime();
    if (!isFinite(then)) return null;
    return Math.max(0, Date.now() - then);
  }

  /* What the line says for a frame, in plain words, with every figure marked
     so it is set in the figure face. A part is a string or { num: '25' }. The
     phases come from src/vault/watch.ts: watching (nothing seen yet), seen
     (the transfer is on its way in), bridged (it is being added to the
     balance), credited (the balance went up), stopped (the app stopped
     checking; money sent still arrives). There is no clock while it waits: a
     time shows only once the wait is long enough to wonder about. */
  function watcherParts(deposit) {
    var symbol = deposit.symbol || '';
    var network = networkName(deposit.chain);
    var amount = typeof deposit.amount === 'number' && deposit.amount > 0 ? [{ num: dom.qty(deposit.amount) }, ' ' + symbol] : null;
    if (deposit.phase === 'watching') {
      var waited = waitedMs(deposit.startedAt);
      if (waited !== null && waited >= LATE_MS) {
        return ['Still waiting for your deposit on ' + network + ', ', { num: String(Math.floor(waited / 60000)) }, ' min so far'];
      }
      return ['Waiting for your deposit on ' + network];
    }
    if (deposit.phase === 'seen') {
      return amount ? ['Arriving on ' + network + ': '].concat(amount) : ['Your deposit is arriving on ' + network];
    }
    if (deposit.phase === 'bridged') {
      return amount ? ['Almost there: '].concat(amount) : ['Almost there'];
    }
    if (deposit.phase === 'credited') {
      return (amount || [symbol || 'Your deposit']).concat([' is in your balance']);
    }
    if (typeof deposit.unstarted === 'string') {
      return ['This app could not start checking for your deposit. Money you send still arrives in your balance.'];
    }
    return ['Stopped checking for this deposit. Money you sent still arrives in your balance.'];
  }

  /* A read that keeps failing, in words a person can use. The watch's own
     reason names the service it is waiting on, which is the app's business:
     it rides behind the developer switch. */
  function troubleWords(error) {
    if (typeof error !== 'string' || error === '') return null;
    if (/^Cannot check the /.test(error)) return 'This line cannot follow this coin. Your deposit still arrives in your balance.';
    return 'Checking is slow right now. The app keeps trying.';
  }

  /* One renderer for every surface that shows a watch: the picker's address
     step and the first run's money step draw the same line off the same frame,
     so a deposit reads the same wherever the person is standing. The mark is a
     small ring that fills in the ink as the money comes in (a third when it is
     seen, two thirds while it is added, then the check), the words say it, the
     transfer is a link to the explorer, and a read that keeps failing sits
     under it in the quiet face. Nothing on the line stops the watch: closing
     the card is the only way out a person needs, and the watch ends on its
     own (src/vault/watch.ts). */
  function watcherLine(host) {
    var node = dom.el('div', 'deposit-watch');
    node.setAttribute('role', 'status');
    node.hidden = true;
    var mark = dom.el('span', 'deposit-watch-mark');
    mark.setAttribute('aria-hidden', 'true');
    node.appendChild(mark);
    var body = dom.el('div', 'deposit-watch-body');
    var text = dom.el('span', 'deposit-watch-text');
    body.appendChild(text);
    var link = dom.el('a', 'deposit-watch-link', 'View');
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.hidden = true;
    body.appendChild(link);
    var note = dom.el('span', 'meta deposit-watch-note');
    note.hidden = true;
    body.appendChild(note);
    var raw = dom.el('span', 'meta deposit-watch-raw');
    raw.setAttribute('data-dev-only', '');
    raw.hidden = true;
    body.appendChild(raw);
    node.appendChild(body);
    host.appendChild(node);

    var tick = 0;
    var markPhase = null;
    var last = null;

    /* The check springs in once, the moment the money lands; a line drawn
       already landed shows it still. */
    function drawMark(phase) {
      if (markPhase === phase) return;
      var was = markPhase;
      markPhase = phase;
      dom.clear(mark);
      if (phase !== 'credited') {
        mark.appendChild(dom.el('span', 'deposit-ring'));
        return;
      }
      var check = icon('done', 'deposit-watch-check');
      mark.appendChild(check);
      var motion = window.PhosphorMotion;
      if (was !== null && typeof check.animate === 'function' && !reducedMotion()) {
        var ease = motion && typeof motion.spring === 'function' ? motion.spring() : 'cubic-bezier(0.34, 1.4, 0.64, 1)';
        check.animate([{ opacity: 0, transform: 'scale(0.4)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 480, easing: ease });
      }
    }

    function write(parts) {
      dom.clear(text);
      for (var i = 0; i < parts.length; i += 1) {
        var part = parts[i];
        text.appendChild(typeof part === 'string' ? dom.el('span', '', part) : dom.el('span', 'num', part.num));
      }
    }

    /* While it waits the line only has to notice the moment it becomes late
       and count the minutes after, so a slow tick is enough. */
    function startTick() {
      if (tick) return;
      tick = window.setInterval(function () { if (last) render(last); }, 15000);
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
      /* One node, repainted every phase. The list clears the href when the read
         has no url yet, so the View link cannot be left pointing at the phase
         before this one. */
      link.hidden = !setHref(link, deposit.explorerUrl);
      var why = troubleWords(deposit.error);
      note.hidden = why === null;
      dom.setText(note, why === null ? '' : why);
      var rawWords = why !== null ? String(deposit.error) : (typeof deposit.unstarted === 'string' ? deposit.unstarted : '');
      raw.hidden = rawWords === '';
      dom.setText(raw, rawWords);
      drawMark(deposit.phase);
      if (deposit.phase === 'watching') startTick();
      else stopTick();
    }

    function destroy() {
      stopTick();
      last = null;
      if (node.parentNode) node.parentNode.removeChild(node);
    }

    return { node: node, text: text, render: render, destroy: destroy };
  }

  /* ---------- the component ---------- */

  function render(host, options) {
    var opts = options || {};
    if (host.__netpick && typeof host.__netpick.destroy === 'function') host.__netpick.destroy();
    var root = dom.el('div', 'netpick');
    root.dataset.context = opts.context || 'basic';
    dom.clear(host);
    host.appendChild(root);

    /* Escape steps back the way Change network does: the tokens and the
       address return to the tiles, wherever that way back is offered. On the
       tiles it asks the host to put the steps away: through onDismiss where
       the host passed one (the deposit card), and otherwise as a
       'netpick:dismiss' event that bubbles out of the picker, which a fold
       that renders it through another module (the Money in fold) cancels to
       say it closed. Nobody listening, the key is left alone. */
    dom.on(root, 'keydown', function (event) {
      if (event.key !== 'Escape' || !state.alive) return;
      if (state.stage === 'network' || state.stage === null) {
        if (askDismiss()) event.preventDefault();
        return;
      }
      if (!backOffered()) return;
      event.preventDefault();
      stageNetworks();
    });

    function askDismiss() {
      if (typeof opts.onDismiss === 'function') {
        opts.onDismiss();
        return true;
      }
      if (typeof root.dispatchEvent !== 'function' || typeof window.CustomEvent !== 'function') return false;
      var asked = new window.CustomEvent('netpick:dismiss', { bubbles: true, cancelable: true });
      return root.dispatchEvent(asked) === false;
    }

    /* The Vault card has its own network menu and the chat's card was opened
       on the network the agent named: neither offers a way back to the tiles. */
    function backOffered() {
      return opts.context !== 'vault' && opts.context !== 'chat';
    }

    var compact = opts.context === 'chat';

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
      unsubscribe: null
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

    /* One stage on screen at a time, through the window's one grammar
       (ui/design/motion.js swap): the stage leaving fades out, then the
       picker's height slides to the one arriving while it fades in, so the
       panel around it never jumps. With motion reduced the swap is a swap.

       The pressed control leaves with its stage, so the focus would fall to
       the page and a keyboard user would start again at the top of the
       window. Where the focus was inside the stage that left, or was already
       lost, it lands on the new stage's first stop: the tile of the network
       in hand, or the step's title. */
    function show(stage, node) {
      var prev = state.stageNode;
      var hadFocus = holdsFocus(prev);
      state.stage = stage;
      state.stageNode = node;
      root.dataset.stage = stage;
      node.className = 'netpick-stage netpick-' + stage;
      if (typeof opts.onStage === 'function') opts.onStage(stage, state.network);
      var motion = window.PhosphorMotion;
      var put = function () {
        if (!state.alive) return;
        if (prev && prev.parentNode === root) root.removeChild(prev);
        if (state.stageNode !== node || node.parentNode === root) return;
        root.appendChild(node);
        if (prev && (hadFocus || focusLost())) focusStage(node);
      };
      if (!prev) {
        put();
        if (motion && typeof motion.enter === 'function') motion.enter(node, { scale: false });
        return;
      }
      if (motion && typeof motion.swap === 'function') motion.swap(root, prev, put, { fade: node });
      else put();
    }

    function holdsFocus(node) {
      var active = document.activeElement;
      return !!node && !!active && typeof node.contains === 'function' && node.contains(active);
    }

    function focusLost() {
      var active = document.activeElement;
      return active === null || (!!active && active === document.body);
    }

    function focusStage(node) {
      var target = node.__first;
      if (target && typeof target.focus === 'function') target.focus({ preventScroll: true });
    }

    /* ---------- step one: the network ---------- */

    /* Six tiles in one row that never wraps, then a search over every network
       the app takes money on. The list draws only while there is a query or
       the person asked to browse it: thirty rows under six tiles would push
       the whole fold off the screen for the one network they came for. It
       opens and closes by sliding the step's height, and a search that
       changes it fades the rows in, so nothing appears or vanishes in one
       frame. */
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
        setVar(tile, '--net', colourOf(n));
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
        if (tile.tabIndex === 0) node.__first = tile;
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

      var list = dom.el('div', 'netpick-list netpick-netlist scrolls');
      list.setAttribute('role', 'list');
      list.setAttribute('aria-label', 'All networks');
      list.hidden = true;
      node.appendChild(list);
      var cutList = edges(list);

      var empty = dom.el('p', 'netpick-empty');
      empty.hidden = true;
      node.appendChild(empty);

      /* One way into the whole list, in words the search above does not
         already say. */
      var foot = dom.el('div', 'netpick-netfoot');
      var all = dom.el('button', 'netpick-link');
      all.type = 'button';
      all.dataset.role = 'all-networks';
      var allWords = dom.el('span', '');
      all.appendChild(allWords);
      all.appendChild(icon('chevron-down', 'netpick-link-chev'));
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

      function fillList(animate) {
        var every = allNetworks(state.report);
        var others = every.length - NETWORKS.length;
        dom.setText(allWords, others > 0 ? (showAll ? 'Hide the list' : 'Browse the list') : '');
        all.setAttribute('aria-expanded', showAll ? 'true' : 'false');
        dom.setHidden(foot, others <= 0);
        var q = query.trim();
        var open = !!q || showAll;
        var wasOpen = !list.hidden || !empty.hidden;
        var shown = open ? filterNetworks(every, q) : [];
        var change = function () {
          dom.clear(list);
          dom.setHidden(list, !open || shown.length === 0);
          dom.setHidden(empty, !open || shown.length > 0);
          if (open && !shown.length) dom.setText(empty, 'No network called ' + q + '. Check the name your exchange uses.');
          shown.forEach(function (n) { list.appendChild(networkRow(n)); });
          cutList();
        };
        var motion = window.PhosphorMotion;
        if (!animate || !motion || typeof motion.morph !== 'function' || state.stageNode !== node) {
          change();
          return;
        }
        if (wasOpen && !open) {
          motion.swap(node, [list, empty], change);
          return;
        }
        motion.morph(node, change, { fade: wasOpen ? null : [list, empty] });
        if (wasOpen && open && typeof list.animate === 'function' && !reducedMotion()) {
          list.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: 180, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' });
        }
      }

      dom.on(input, 'input', function () {
        query = input.value || '';
        fillList(true);
      });
      dom.on(all, 'click', function () {
        showAll = !showAll;
        fillList(true);
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

    /* The bridge refused this network just now. The tile stays whole (a
       faded tile reads as broken, not as busy), its name steps back to the
       quiet tone and a second line says so; the click still leads to the
       sentence instead of an address. */
    function markUnavailable(tile, id) {
      var known = reportNetwork(id);
      if (!known || !known.unavailable || tile.dataset.unavailable === 'true') return;
      tile.dataset.unavailable = 'true';
      tile.setAttribute('aria-disabled', 'true');
      tile.title = 'Not available now';
      tile.appendChild(dom.el('span', 'net-tile-note', 'Not available'));
    }

    /* A list that scrolls inside itself says where it is cut
       (components.css .scrolls[data-cut]), so the last row in view fades
       rather than ending on a hard edge, and a person sees there is more. */
    function edges(list) {
      function cut() {
        var top = list.scrollTop > 2;
        var bottom = list.scrollTop + list.clientHeight < list.scrollHeight - 2;
        dom.setAttr(list, 'data-cut', top && bottom ? 'both' : (top ? 'top' : (bottom ? 'bottom' : null)));
      }
      dom.on(list, 'scroll', cut);
      return function () {
        if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(cut);
        else cut();
      };
    }

    /* One network in the list: the mark, the name, and at the right what can
       be sent on it, three symbols and a count for the rest. */
    function networkRow(n) {
      var row = dom.el('button', 'net-row');
      row.type = 'button';
      row.setAttribute('role', 'listitem');
      row.dataset.network = n.id;
      setVar(row, '--net', colourOf(n) || 'var(--text-2)');
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
        dom.setText(side, 'Not available now');
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

    /* The line above steps two and three: the network's mark and the step's
       title, which wraps rather than cutting the network's name, and the way
       back to step one beside it where the room allows and under it where it
       does not (deposit.css). The title is where the focus lands when a step
       arrives, so it takes focus without being a stop in the tab order. */
    function stageHead(node, n, text, withBack) {
      var head = dom.el('div', 'netpick-head');
      var title = dom.el('div', 'netpick-title');
      var titleMark = dom.el('span', 'netpick-title-mark');
      setVar(titleMark, '--net', colourOf(n));
      titleMark.appendChild(logo(n.mark, 20));
      title.appendChild(titleMark);
      var words = dom.el('span', 'netpick-title-text', text);
      words.setAttribute('tabindex', '-1');
      title.appendChild(words);
      head.appendChild(title);
      node.__first = words;
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

    /* ---------- step two: what can be sent on it ---------- */

    function stageTokens() {
      var n = networkOf(state.network);
      if (!n) return stageNetworks();
      var node = dom.el('div');

      node.appendChild(stageHead(node, n, 'What you can send on ' + n.name, backOffered()));

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
        body.appendChild(unavailableRefusal(n, network));
        return;
      }

      var tokens = sortTokens(network.accepts, n.native);
      if (!tokens.length) {
        body.appendChild(refusal('Nothing can be sent on ' + n.name + ' right now, so there is no address to show.'));
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

      /* The list scrolls behind the search at a height that leaves the
         acknowledgement and its button above the fold of a 900 px window. */
      var list = dom.el('div', 'netpick-list scrolls');
      list.setAttribute('role', 'list');
      list.setAttribute('aria-label', 'What you can send on ' + n.name);
      body.appendChild(list);
      var cutList = edges(list);

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
        cutList();
      }

      dom.on(input, 'input', function () {
        state.query = input.value || '';
        fill();
      });
      fill();

      /* Behind the developer switch: the bridge's own id for this network. */
      var bridge = dom.el('p', 'netpick-dev id');
      bridge.setAttribute('data-dev-only', '');
      dom.setText(bridge, 'Bridge network id: ' + (network && typeof network.bridge === 'string' && network.bridge ? network.bridge : bridgeId(n.id)));
      body.appendChild(bridge);

      body.appendChild(ackBlock(n, network, tokens));
    }

    function bridgeId(id) {
      return { eth: 'eth:1', base: 'eth:8453', arb: 'eth:42161', sol: 'sol:mainnet', near: 'near:mainnet' }[id] || id;
    }

    /* One token, one row: the mark, the symbol and the minimum in the unit a
       person types, never the bridge's base units. Nothing on it copies.
       It used to show the token's contract under the symbol with a copy glyph,
       and that read as the address to send to (Karim, 2026-09-22): a coin sent
       to its own token contract is gone. The contract is shown only behind the
       developer switch now, labelled, to read against an explorer. */
    function tokenRow(token) {
      var contract = typeof token.contract === 'string' && token.contract && token.contract !== 'native' ? token.contract : null;
      var row = dom.el('div', 'token-row');
      row.setAttribute('role', 'listitem');
      row.dataset.symbol = String(token.symbol);
      row.appendChild(logo(token.symbol, 24));
      var main = dom.el('div', 'token-main');
      main.appendChild(dom.el('span', 'token-symbol', token.symbol));
      var line = dom.el('span', contract ? 'token-contract addr' : 'token-contract token-native');
      line.setAttribute('data-dev-only', '');
      dom.setText(line, contract ? 'Token contract ' + contract : 'The chain\'s own coin, no contract');
      main.appendChild(line);
      row.appendChild(main);
      var side = dom.el('span', 'token-side');
      var min = dom.el('span', 'token-min mono');
      dom.setText(min, minimumWords(token));
      side.appendChild(min);
      row.appendChild(side);
      return row;
    }

    /* Under the list, once per install: a person says they have read what can
       be sent here before the address is shown. This is the one place the
       loss is said. Remembered, it is one small button.

       The tick brings the button into view: the acknowledgement card reads
       like the end of the panel, and on a short window the button sat under
       the frame's notice with nothing saying it was there. */
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
        drawn.appendChild(icon('check', 'ack-check'));
        row.appendChild(drawn);
        row.appendChild(dom.el('span', 'ack-text', 'I understand only the tokens above can be sent here. Anything else sent to this address is lost.'));
        wrap.appendChild(row);
        go.disabled = true;
        dom.on(box, 'change', function () {
          go.disabled = !box.checked;
          if (box.checked) row.dataset.checked = 'true';
          else delete row.dataset.checked;
          if (box.checked && typeof go.scrollIntoView === 'function') {
            go.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
          }
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
      node.appendChild(stageHead(node, n, 'Send on ' + n.name + ' only.', backOffered()));

      var body = dom.el('div', 'deposit-body');
      node.appendChild(body);

      if (state.watch) state.watch.destroy();
      state.watch = watcherLine(node);

      show('address', node);
      skeleton(body);
      /* The QR libraries come with the first address drawn, not with the
         window (ui/core/lazy.js). */
      var lazy = window.PhosphorLazy;
      Promise.all([load(), lazy ? lazy.load('qr') : null]).then(function () {
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

    /* A step that cannot show an address says why in its place. A network
       that is only closed for now is news, in the quiet banner; a sign that
       something is wrong with the address itself (an edited wallet file, a
       code that reads back wrong, a coin that would be lost) is a warning.
       Nothing here is a loss, so nothing here is red. */
    function refusal(why, tone) {
      var banner = dom.el('div', 'banner netpick-refusal');
      if (tone) banner.dataset.tone = tone;
      banner.appendChild(dom.el('span', '', why));
      return banner;
    }

    /* The bridge's own reason names its route ("the bridge refused
       eth:42161: ..."), which is the app's business: the person reads that
       the network is closed for now and what to do, and the reason rides
       behind the developer switch. */
    function unavailableRefusal(n, network) {
      var banner = refusal(n.name + ' is not taking deposits right now. Try again later, or pick another network.');
      var raw = dom.el('span', 'netpick-dev', String(network.unavailable));
      raw.setAttribute('data-dev-only', '');
      banner.appendChild(raw);
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
        return refuse(body, 'The wallet file on this Mac has been edited, so no address in it can be trusted.', 'warn');
      }
      if (!report || !network) {
        return refuse(body, state.failed
          ? 'The addresses could not be read. ' + state.failed
          : 'This wallet has no deposit address on ' + n.name + (report && report.reason ? ': ' + report.reason : '.'));
      }
      if (network.unavailable) {
        dom.clear(body);
        body.appendChild(unavailableRefusal(n, network));
        body.dataset.state = 'refused';
        return;
      }
      if (typeof network.address !== 'string' || !network.address.length) {
        /* A row the report marks changed carries no address on purpose: the
           bridge's answer and the one pinned on disk disagree, and neither
           is drawn. The sentence takes the address's place. */
        return typeof network.changed === 'string' && network.changed
          ? refuse(body, network.changed, 'warn')
          : refuse(body, 'No deposit address on ' + n.name + ' right now.');
      }
      var token = tokenOf(network, state.symbol) || tokenOf(network, defaultSymbol(network.accepts, n.native));
      if (state.symbol && !tokenOf(network, state.symbol)) {
        return refuse(body, state.symbol + ' is not on the list for ' + n.name + '. Sending it there loses it.', 'warn');
      }

      /* Check 1: the wallet is open, so this address was derived from the keys
         and not read off an unauthenticated header. */
      if (report.verified !== true) return askToOpen(body, n);

      /* The watch that opened the card may carry an address of its own. If it
         does, and it is a watch on this network, it has to be this one. */
      if (state.deposit && state.deposit.chain === n.id
        && typeof state.deposit.address === 'string' && state.deposit.address.length
        && !sameBytes(state.deposit.address, network.address)) {
        return refuse(body, 'The address the watcher holds is not the one this wallet reports. Nothing is shown.', 'warn');
      }

      var address = network.address;
      var memoText = typeof network.memo === 'string' && network.memo ? network.memo : null;
      dom.clear(body);

      /* A memo network (Stellar today) hands everybody one address and tells
         the deposits apart by memo, so a send without the memo reaches
         nobody's balance and is not refunded. No QR of the bare address,
         then: a wallet that scans one sends without the memo. The address and
         the memo each get their own Copy, and the card says why (security
         review, 2026-09-16). */
      if (memoText === null) {
        var qr = dom.el('div', 'qr deposit-qr');
        var canvas = dom.el('canvas');
        canvas.setAttribute('role', 'img');
        canvas.setAttribute('aria-label', 'QR code of the deposit address');
        qr.appendChild(canvas);
        var check = drawChecked(canvas, address, compact ? 128 : QR_TARGET_PX);
        if (!check.ok) {
          return refuse(body, 'Nothing is shown: ' + check.why + ' Close this and open it again. If it happens twice, do not send money until it is fixed.', 'warn');
        }
        body.dataset.state = 'shown';
        body.appendChild(qr);
      } else {
        body.dataset.state = 'shown';
        body.dataset.memo = 'true';
      }

      /* The address in a well, and under it the one thing a person came for:
         Copy, the width of the column. Only the sentence under it changes
         once the clipboard reads back (it carries the check), and it goes
         once it has been read. */
      var side = dom.el('div', 'deposit-side');
      var well = dom.el('div', 'deposit-well');
      well.appendChild(addressBlock(address, kindOf(n.id)));
      side.appendChild(well);
      side.appendChild(copyTools(address, 'Copy address', 'copy', 'address'));

      if (memoText !== null) {
        var memoBlock = dom.el('div', 'deposit-memo');
        memoBlock.appendChild(dom.el('p', 'label', 'Memo, required with the address'));
        var memoWell = dom.el('div', 'deposit-well');
        memoWell.appendChild(dom.el('p', 'deposit-memo-value addr', memoText));
        memoBlock.appendChild(memoWell);
        memoBlock.appendChild(copyTools(memoText, 'Copy memo', 'copy-memo', 'memo'));
        var memoWarn = dom.el('p', 'deposit-memo-warn');
        dom.setText(memoWarn, 'Paste the memo into the memo or tag field on the sending side. This address is shared with other people and the memo is what puts the money in your balance; without it the deposit goes to nobody and is not refunded. No QR code here, because a scanned address leaves the memo out.');
        memoBlock.appendChild(memoWarn);
        side.appendChild(memoBlock);
      }
      body.appendChild(side);

      var notes = dom.el('div', 'deposit-notes');
      /* The bridge answered a different address than the one pinned on disk for this network
         (src/http/wallet.ts pinAddresses). The pinned one is what is drawn above; this line is
         the reason to stop and look before sending anything. */
      if (typeof network.changed === 'string' && network.changed) {
        var changed = dom.el('p', 'deposit-changed');
        changed.setAttribute('role', 'alert');
        dom.setText(changed, network.changed);
        notes.appendChild(changed);
      }
      var plain = dom.el('p', 'deposit-plain');
      dom.setText(plain, sharedWords(n, network));
      notes.appendChild(plain);

      var accepts = sortTokens(network.accepts, n.native);
      var floors = minimumsWords(accepts);
      if (floors) {
        var minLine = dom.el('p', 'deposit-min');
        minLine.appendChild(dom.el('span', '', floors));
        if (accepts.length > 2) {
          var more = dom.el('button', 'netpick-link');
          more.type = 'button';
          more.appendChild(dom.el('span', '', 'All ' + accepts.length + ' tokens'));
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

    /* What to pick on the sending side, and which networks this address also
       serves, from the report's own byte comparison, never from a table: the
       bridge hands the EVM chains one address, and the sentence names the ones
       it actually did. The loss is said once, in the acknowledgement; here is
       only what to do. */
    function sharedWords(n, network) {
      var ids = network && Array.isArray(network.sharedWith) ? network.sharedWith : null;
      if (ids === null && EVM.indexOf(n.id) >= 0) ids = EVM.filter(function (id) { return id !== n.id; });
      var names = [];
      for (var i = 0; ids && i < ids.length; i += 1) names.push(networkName(ids[i]));
      var pick = 'When you send, pick ' + n.words + ' as the network.';
      if (!names.length) return pick;
      /* Two named and the rest counted: sixteen EVM chains in one sentence
         is a sentence nobody reads to the end. */
      var list;
      if (names.length <= 2) list = names.join(' and ');
      else list = names.slice(0, 2).join(', ') + ' and ' + (names.length - 2) + ' more';
      return pick + ' ' + list + ' use this same address.';
    }

    /* Copy, the width of its column, and the sentence under it. The sentence
       is the answer: it says the clipboard read back what was written and the
       last four to check, then fades once it has been read (deposit.css). A
       copy that could not be checked says so and stays. The line keeps its
       height either way, so nothing under it moves. */
    function copyTools(text, label, role, noun) {
      var tools = dom.el('div', 'deposit-tools');
      var copy = dom.el('button', 'btn');
      copy.type = 'button';
      copy.dataset.role = role;
      copy.appendChild(icon('copy', 'deposit-copy-icon'));
      copy.appendChild(dom.el('span', 'btn-label', label));
      var said = dom.el('p', 'meta deposit-copied');
      said.setAttribute('role', 'status');
      tools.appendChild(copy);
      tools.appendChild(said);
      var busy = false;
      dom.on(copy, 'click', function () {
        if (busy) return;
        busy = true;
        var sentence = '';
        copyChecked(text, function (words) { sentence = words; }, noun).then(function (ok) {
          busy = false;
          if (!state.alive) return;
          dom.clear(said);
          if (ok) said.appendChild(icon('done', 'deposit-copied-check'));
          said.appendChild(dom.el('span', '', sentence));
          said.removeAttribute('data-said');
          /* A second copy restarts the fade: the attribute comes off and goes
             back on either side of a layout read. */
          if (typeof said.getBoundingClientRect === 'function') said.getBoundingClientRect();
          said.setAttribute('data-said', ok ? 'ok' : 'problem');
        });
      });
      return tools;
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
      var go = button(enclave ? 'Touch ID to show the address' : 'Unlock to show the address', 'btn-primary', 'Waiting for Touch ID');
      actions.appendChild(go);
      body.appendChild(actions);

      var error = dom.el('p', 'body netpick-error');
      error.hidden = true;
      body.appendChild(error);

      dom.on(go, 'click', function () {
        if (!enclave) {
          if (typeof opts.onDismiss === 'function') opts.onDismiss();
          if (window.PhosphorLock) window.PhosphorLock.focus();
          return;
        }
        error.hidden = true;
        window.PhosphorShell.setPending(go, true);
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
          state.watch.render({ phase: 'stopped', chain: n.id, symbol: symbol, unstarted: net.readable(err) });
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
