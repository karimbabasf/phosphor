/* One mark per coin, so a person can tell the rows apart before reading them.

   Karim, 2026-09-09: "I want to be able to tell the difference between each
   token ... just show the token symbol but colored please and not in a cheap
   way, find quality pictures, or just white. like literally white photos."
   Karim, 2026-09-23, on the balances panel drawing a dim glyph inside a tinted
   ring: the logos are shit.

   So a coin is drawn the way its brand draws it: the logo file in ui/logos/
   (see LICENSE.md there), in full colour and at full opacity, with nothing
   behind it: no disc, no wash. Every file keeps its mark inside the middle 18
   units of a 24 unit box, so a row of them sits at one optical size whatever
   the box, and being vector each is sharp at 1x and 2x. The files share one
   round geometry: a brand drawn on a square (Base's block, PEPE's tile) is its
   round mark, and a brand drawn as a dark disc carries a faint light edge in
   its file so it does not vanish on the warm ground (Karim, 2026-09-23: the
   real logos, never tinted discs). A coin with no file draws a neutral
   monogram at that same size, never a stand-in glyph. */
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

  /* The logos shipped as files in ui/logos/<ticker>.svg (see LICENSE.md there).
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
     file, or a file that fails to load, becomes its monogram: never an emoji,
     never a broken image, never somebody else's mark. */
  function logo(symbol, size) {
    var ticker = tickerOf(symbol);
    var node = document.createElement('span');
    node.className = 'logo';
    node.setAttribute('data-token', ticker);
    node.setAttribute('aria-hidden', 'true');
    if (size) node.style.setProperty('--logo', size + 'px');
    var colour = colourFor(symbol);
    if (colour) node.style.setProperty('--coin', colour);
    if (LOGOS.indexOf(ticker) < 0) return fallback(node, ticker);
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

  /* The agents' own marks, files in ui/logos/agents/ (see LICENSE.md there),
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

  window.PhosphorMarks = { colourFor: colourFor, colour: colourFor, logo: logo, agent: agent, badgeFor: badgeFor, COLOURS: COLOURS, LOGOS: LOGOS, AGENT_LOGOS: AGENT_LOGOS, BADGES: BADGES };
})();
