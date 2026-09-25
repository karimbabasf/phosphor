/* One mark per coin, so a person can tell the rows apart before reading them.

   Karim, 2026-09-09: "I want to be able to tell the difference between each
   token ... just show the token symbol but colored please and not in a cheap
   way, find quality pictures, or just white. like literally white photos."
   Karim, 2026-09-23, on the balances panel drawing a dim glyph inside a tinted
   ring: the logos are shit.

   So a coin is drawn the way its brand draws it: the logo file in ui/logos/
   (see ATTRIBUTION.md there), in full colour and at full opacity, with nothing
   behind it: no disc, no wash. Every file keeps its mark inside the middle 18
   units of a 24 unit box, so a row of them sits at one optical size whatever
   the box, and being vector each is sharp at 1x and 2x. The files share one
   round geometry: a brand drawn on a square (Base's block, PEPE's tile) is its
   round mark, and a brand drawn as a dark disc carries a faint light edge in
   its file so it does not vanish on the warm ground (Karim, 2026-09-23: the
   real logos, never tinted discs). A coin with no file draws its own picture
   from this app's cache when there is one (Karim, 2026-09-25: "the pictures
   are out there, we just have to find them and use them"), and otherwise a
   neutral monogram at that same size, never a stand-in glyph. */
(function () {
  'use strict';

  /* The brand colours, one per logo, read off the logo files in ui/logos/ (or
     the project's brand page where the logo is a gradient or a dark disc).
     Each logo carries its coin's as --coin, for a surface that wants to echo
     the coin; nothing paints the mark itself with it. */
  var COLOURS = {
    ETH: '#627EEA',
    SOL: '#9945FF',
    USDC: '#2775CA',
    USDT: '#009393',
    DAI: '#FDC134',
    USDS: '#FFC700',
    PYUSD: '#3B6FEF',
    USDE: '#8A9BB8',
    NEAR: '#00EC97',
    WNEAR: '#00EC97',
    BTC: '#F7931A',
    HYPE: '#97FCE4',
    ARB: '#12AAFF',
    AVAX: '#E84142',
    BASE: '#0052FF',
    OP: '#FE0420',
    POL: '#8247E5',
    BNB: '#F0B90B',
    XRP: '#FFFFFF',
    DOGE: '#C2A633',
    LINK: '#2E61DE',
    WBTC: '#F09242',
    TON: '#0098EA',
    SUI: '#4BA2FF',
    APT: '#BA6BFF',
    TRX: '#C4342B',
    LTC: '#345D9D',
    ADA: '#246DD3',
    DOT: '#E6007A',
    AAVE: '#9391F7',
    ABS: '#054729',
    ADI: '#FE7109',
    AURORA: '#63B836',
    BCH: '#58BE92',
    BERA: '#FB9942',
    COW: '#97A0D1',
    DASH: '#008DE4',
    EURE: '#0072AA',
    FOGO: '#FF3D00',
    GMX: '#4E09F8',
    GNO: '#00A6C4',
    GRAM: '#30A1F5',
    HAPI: '#FFF700',
    KNC: '#31CB9E',
    MOG: '#FCAF1E',
    MON: '#836EF9',
    MOVE: '#FBDA4F',
    NPRO: '#1BD6D5',
    PEPE: '#4F9843',
    ROBINHOOD: '#CCFF00',
    SAFE: '#049F67',
    SCROLL: '#FFEEDA',
    SHIB: '#EB9A2E',
    STRK: '#0C0C4F',
    SWEAT: '#FF0D74',
    UNI: '#FF0A6F',
    XLM: '#FFFFFF',
    ZEC: '#ECB244',
    /* A wrapped or bridged ticker wears the file of the coin it carries, so it
       takes that coin's colour too. */
    WETH: '#627EEA',
    CBBTC: '#F7931A',
    HEMIBTC: '#F7931A',
    XBTC: '#F7931A',
    'BTC(OMNI)': '#F7931A',
    USDT0: '#009393',
    'USDC.E': '#2775CA',
    XDAI: '#FDC134',
    FXRP: '#FFFFFF'
  };

  /* The logos shipped as files in ui/logos/<ticker>.svg (see ATTRIBUTION.md there).
     Listed here so a ticker with no file draws its fallback at once instead of
     asking the server for a file that is not there. WNEAR wears NEAR's. */
  var LOGOS = [
    'BTC', 'ETH', 'SOL', 'USDC', 'USDT', 'NEAR', 'ARB', 'BASE', 'HYPE', 'OP', 'AVAX', 'POL',
    'BNB', 'XRP', 'DOGE', 'LINK', 'WBTC', 'DAI', 'TON', 'SUI', 'APT', 'TRX', 'LTC', 'ADA', 'DOT',
    'PYUSD', 'USDE',
    'AAVE', 'ABS', 'ADI', 'AURORA', 'BCH', 'BERA', 'COW', 'DASH', 'EURE', 'FOGO', 'GMX', 'GNO',
    'GRAM', 'HAPI', 'KNC', 'MOG', 'MON', 'MOVE', 'NPRO', 'PEPE', 'ROBINHOOD', 'SAFE', 'SCROLL',
    'SHIB', 'STRK', 'SWEAT', 'UNI', 'XLM', 'ZEC',
    'WETH', 'CBBTC', 'HEMIBTC', 'XBTC', 'BTC(OMNI)', 'USDT0', 'USDC.E', 'XDAI', 'FXRP',
    'ALEO', 'FRAX', 'SPX', 'XAUT', 'XPL', 'XLAYER', 'NBTC', 'USDCX'
  ];

  function colourFor(symbol) {
    var key = String(symbol === null || symbol === undefined ? '' : symbol).trim().toUpperCase();
    return COLOURS[key] || '';
  }

  /* A wrapped or bridged coin wears the file of the coin it carries, so two
     rows in one list would read as one coin twice. Wallets tell them apart
     with a small badge at the mark's lower right, and so does this: the
     chain's own mark where the ticker names the chain it lives on (Base on
     cbBTC, NEAR on nBTC, Gnosis on xDAI), and otherwise a letter, W for a
     wrapped coin and the ticker's own first letter for a bridged one. */
  var BADGES = {
    WETH: { letter: 'W' },
    WNEAR: { letter: 'W' },
    CBBTC: { mark: 'BASE' },
    NBTC: { mark: 'NEAR' },
    XDAI: { mark: 'GNO' },
    HEMIBTC: { letter: 'H' },
    XBTC: { letter: 'X' },
    'BTC(OMNI)': { letter: 'O' },
    USDT0: { letter: '0' },
    'USDC.E': { letter: 'E' },
    USDCX: { letter: 'X' },
    FXRP: { letter: 'F' }
  };

  function badgeFor(symbol) {
    var key = String(symbol === null || symbol === undefined ? '' : symbol).trim().toUpperCase();
    return hasOwn(BADGES, key) ? BADGES[key] : null;
  }

  /* Drawn with inline styles off the design tokens, so the badge goes wherever
     a logo goes without a sheet of its own: a disc about half the mark's size,
     sitting just off its corner, cut out of the surface by a ring of the
     slab's colour. */
  function addBadge(node, badge) {
    node.style.setProperty('position', 'relative');
    var disc = document.createElement('span');
    disc.className = 'logo-badge';
    disc.setAttribute('aria-hidden', 'true');
    disc.style.cssText = 'position:absolute;right:-10%;bottom:-10%;width:48%;height:48%;display:grid;place-items:center;overflow:hidden;border-radius:50%;background:var(--bg-3);box-shadow:0 0 0 1.5px var(--bg-1);pointer-events:none';
    if (badge.mark) {
      var img = document.createElement('img');
      img.alt = '';
      img.decoding = 'async';
      img.draggable = false;
      img.style.cssText = 'display:block;width:134%;height:134%;max-width:none';
      img.onerror = function () { if (disc.parentNode) disc.parentNode.removeChild(disc); };
      img.src = './logos/' + badge.mark.toLowerCase() + '.svg';
      disc.appendChild(img);
    } else {
      var letter = document.createElement('span');
      letter.textContent = badge.letter;
      letter.style.cssText = 'font-family:var(--font-ui);font-size:calc(var(--logo) * 0.3);font-weight:600;line-height:1;color:var(--text)';
      disc.appendChild(letter);
    }
    node.appendChild(disc);
  }

  /* Case and whitespace tolerant, because a symbol reaches this from a wallet
     row, from a server sentence and from a name like "Ether (ETH)". wNEAR is
     the same coin as NEAR wearing a wrapper and draws NEAR's logo; the symbol
     beside it stays whatever the row says. */
  function tickerOf(symbol) {
    var key = String(symbol === null || symbol === undefined ? '' : symbol).trim().toUpperCase();
    return key === 'WNEAR' ? 'NEAR' : key;
  }

  /* The real mark, as an image: <span class="logo" data-token="ETH"
     style="--logo: 24px"><img src="./logos/eth.svg" alt=""></span>. The size
     rides on the node as --logo, which the stylesheet reads. A ticker with no
     file draws its picture from the cache, and with no picture either, or a
     file that fails to load, becomes its monogram: never an emoji, never a
     broken image, never somebody else's mark. */
  function logo(symbol, size) {
    var ticker = tickerOf(symbol);
    var node = document.createElement('span');
    node.className = 'logo';
    node.setAttribute('data-token', ticker);
    node.setAttribute('aria-hidden', 'true');
    if (size) node.style.setProperty('--logo', size + 'px');
    var colour = colourFor(symbol);
    if (colour) node.style.setProperty('--coin', colour);
    if (LOGOS.indexOf(ticker) < 0) {
      readPictures();
      return pictureOf(ticker) ? picture(node, ticker) : fallback(node, ticker);
    }
    var img = document.createElement('img');
    img.alt = '';
    img.decoding = 'async';
    img.draggable = false;
    img.onerror = function () { fallback(node, ticker); };
    img.src = './logos/' + ticker.toLowerCase() + '.svg';
    node.appendChild(img);
    var badge = badgeFor(symbol);
    if (badge) addBadge(node, badge);
    return node;
  }

  /* The monogram: the ticker's first letter or digit ("$WIF" is a W) in the
     UI face, on a quiet neutral disc the size a logo's mark is drawn at. */
  function fallback(node, ticker) {
    node.textContent = '';
    node.setAttribute('data-fallback', 'true');
    var initial = document.createElement('span');
    initial.className = 'logo-initial';
    var first = /[\p{L}\p{N}]/u.exec(ticker);
    initial.textContent = first ? first[0] : '?';
    node.appendChild(initial);
    return node;
  }

  /* The coin pictures (2026-09-25). The backend keeps a picture for every coin
     1Click lists, fetched once from CoinGecko and checked to be a PNG, JPEG or
     WebP (src/ledger/pictures.ts), and serves it itself, so the page loads
     none from anywhere else. This asks which coins have one (/api/coin-images):
     when a coin with no file first needs a mark, then on the state frames that
     keep arriving, soon while more are still coming and every five minutes
     once they have all come, never on a timer. A monogram drawn before its
     picture was known becomes the picture in place, on every surface at once.
     A picture that will not load is the monogram again and is not tried again. */
  var PICTURES_SOON_MS = 5 * 1000;
  var PICTURES_LATER_MS = 5 * 60 * 1000;
  var COINGECKO_ID = /^[a-z0-9][a-z0-9._-]{0,99}$/;
  var pictures = { ids: Object.create(null), broken: Object.create(null), fill: Object.create(null), at: 0, settled: false, pending: false, watching: false };

  /* HOW BIG A PICTURE DRAWS. A coin's picture is as a rule a round mark
     filling its image edge to edge, so it draws at the three quarters every
     file and monogram fills. VVV's is its bare mark on a clear ground, about
     two thirds of its image, and at three quarters it came out half the size
     of every logo beside it (2026-09-25). So a picture is measured when it
     loads: the box its opaque pixels fill, as a share of the image. Art that
     fills less than PICTURE_FULL of it is drawn larger, up to the whole box,
     so the mark lands where a disc's would; a disc picture is left exactly as
     it was. The measure is kept per picture, so the next mark of that coin is
     drawn at its size from the start. */
  var PICTURE_SIDE = 0.75;
  var PICTURE_FULL = 0.9;
  // Alpha, of 255, past which a pixel is art: a shadow or an edge fainter than this is not.
  var OPAQUE = 32;
  // The side, in pixels, a picture is read back at: enough to find its edges, cheap on every load.
  var MEASURE = 64;

  // The side a picture's image draws at, as a share of the box, for art filling `fill` of it.
  function pictureSide(fill) {
    if (typeof fill !== 'number' || !(fill > 0) || fill >= PICTURE_FULL) return PICTURE_SIDE;
    return Math.min(1, PICTURE_SIDE / fill);
  }

  /* How much of an image its art fills: the opaque pixels' box, its longer
     side as a share of the image's. `data` is RGBA, four bytes a pixel, row by
     row; 0 when nothing in it is opaque. */
  function artFill(data, width, height) {
    var left = width;
    var right = -1;
    var top = height;
    var bottom = -1;
    for (var y = 0; y < height; y += 1) {
      for (var x = 0; x < width; x += 1) {
        if (data[(y * width + x) * 4 + 3] < OPAQUE) continue;
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
    if (right < 0) return 0;
    return Math.max((right - left + 1) / width, (bottom - top + 1) / height);
  }

  /* A loaded picture read back off a small canvas. It comes from this app's
     own server, so the read is allowed; anything that stops it leaves the
     picture at the three quarters it always had. */
  function measure(img) {
    try {
      var canvas = document.createElement('canvas');
      canvas.width = MEASURE;
      canvas.height = MEASURE;
      var context = canvas.getContext('2d');
      if (!context) return 1;
      context.drawImage(img, 0, 0, MEASURE, MEASURE);
      return artFill(context.getImageData(0, 0, MEASURE, MEASURE).data, MEASURE, MEASURE);
    } catch (error) {
      return 1;
    }
  }

  // Sized from its measure, when there is one; a disc picture carries no size of its own.
  function fit(img, id) {
    var side = pictureSide(pictures.fill[id]);
    if (side === PICTURE_SIDE) return;
    img.style.width = Math.round(side * 1000) / 10 + '%';
    img.style.height = img.style.width;
  }

  function pictureOf(ticker) {
    if (pictures.broken[ticker]) return '';
    var id = pictures.ids[ticker];
    return typeof id === 'string' ? id : '';
  }

  function readPictures() {
    var net = window.PhosphorNet;
    if (!net || typeof net.getJson !== 'function') return;
    watch();
    if (pictures.pending) return;
    var wait = pictures.settled ? PICTURES_LATER_MS : PICTURES_SOON_MS;
    if (pictures.at && Date.now() - pictures.at < wait) return;
    var reading = net.getJson('/api/coin-images');
    if (!reading || typeof reading.then !== 'function') return;
    pictures.pending = true;
    reading
      .then(function (result) {
        var data = result && result.data ? result.data : null;
        var named = data && data.symbols && typeof data.symbols === 'object' ? data.symbols : {};
        var ids = Object.create(null);
        Object.keys(named).forEach(function (ticker) {
          if (typeof named[ticker] === 'string' && COINGECKO_ID.test(named[ticker])) ids[ticker] = named[ticker];
        });
        pictures.ids = ids;
        pictures.settled = !!(data && data.settled === true);
        upgrade();
      })
      .catch(function () {})
      .then(function () {
        pictures.pending = false;
        pictures.at = Date.now();
      });
  }

  /* Once a coin has needed a picture, every state frame asks again when it is
     time to. Subscribed before the read above starts, because the store calls
     a new subscriber at once. */
  function watch() {
    var store = window.PhosphorState;
    if (pictures.watching || !store || typeof store.subscribe !== 'function') return;
    pictures.watching = true;
    store.subscribe(function () { readPictures(); });
  }

  function upgrade() {
    if (typeof document.querySelectorAll !== 'function') return;
    var nodes = document.querySelectorAll('.logo[data-fallback][data-token]');
    for (var i = 0; i < nodes.length; i += 1) {
      var ticker = nodes[i].getAttribute('data-token');
      if (pictureOf(ticker)) picture(nodes[i], ticker);
    }
  }

  /* The picture, from this app's own server, drawn to the same three quarters
     of the box as a file or a monogram (components.css), or larger when its
     art is small (HOW BIG A PICTURE DRAWS, above). */
  function picture(node, ticker) {
    var id = pictureOf(ticker);
    node.textContent = '';
    node.removeAttribute('data-fallback');
    node.setAttribute('data-picture', 'true');
    var img = document.createElement('img');
    img.alt = '';
    img.decoding = 'async';
    img.draggable = false;
    fit(img, id);
    img.onload = function () {
      if (typeof pictures.fill[id] !== 'number') pictures.fill[id] = measure(img);
      fit(img, id);
    };
    img.onerror = function () {
      pictures.broken[ticker] = true;
      node.removeAttribute('data-picture');
      fallback(node, ticker);
    };
    img.src = '/api/coin-image?id=' + encodeURIComponent(id);
    node.appendChild(img);
    return node;
  }

  /* The agents' own marks, files in ui/logos/agents/ (see ATTRIBUTION.md there),
     keyed by the catalog's agent id. Claude Code and Claude Desktop are both
     Claude. A brand drawn in one colour (Grok, Hermes) is drawn through its
     file in the text colour, so it reads on whatever ground the theme sets
     rather than as black on black. */
  var AGENT_LOGOS = { claude: 'claude', desktop: 'claude', codex: 'codex', grok: 'grok', hermes: 'hermes' };
  var ONE_COLOUR = { grok: true, hermes: true };

  /* An agent's mark, in the same box and at the same size as a coin's logo.
     Another agent is any MCP client at all, so it draws the icon set's link
     rather than anybody's brand; an id this file does not know draws the
     monogram of its name. */
  function agent(id, size, name) {
    var key = String(id === null || id === undefined ? '' : id).trim().toLowerCase();
    var node = document.createElement('span');
    node.className = 'logo';
    node.setAttribute('data-agent', key);
    node.setAttribute('aria-hidden', 'true');
    if (size) node.style.setProperty('--logo', size + 'px');
    var icons = window.PhosphorIcons;
    if (key === 'mcp' && icons && typeof icons.svg === 'function') {
      node.appendChild(icons.svg('link', 'logo-icon'));
      return node;
    }
    var file = hasOwn(AGENT_LOGOS, key) ? AGENT_LOGOS[key] : '';
    if (!file) return fallback(node, String(name || key).toUpperCase());
    var src = './logos/agents/' + file + '.svg';
    if (ONE_COLOUR[file]) {
      var ink = document.createElement('span');
      ink.className = 'logo-ink';
      ink.style.setProperty('-webkit-mask-image', 'url("' + src + '")');
      ink.style.setProperty('mask-image', 'url("' + src + '")');
      node.appendChild(ink);
      return node;
    }
    var img = document.createElement('img');
    img.alt = '';
    img.decoding = 'async';
    img.draggable = false;
    img.onerror = function () { fallback(node, String(name || key).toUpperCase()); };
    img.src = src;
    node.appendChild(img);
    return node;
  }

  function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  window.PhosphorMarks = { colourFor: colourFor, colour: colourFor, logo: logo, agent: agent, badgeFor: badgeFor, pictureSide: pictureSide, artFill: artFill, COLOURS: COLOURS, LOGOS: LOGOS, AGENT_LOGOS: AGENT_LOGOS, BADGES: BADGES };
})();
