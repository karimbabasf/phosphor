(function () {
  var dom = window.PhosphorDom;

  /* WHAT TELLS TWO TOKENS OF ONE TICKER APART, in words a person can use.

     The assetId says it exactly and says it in a string nobody will read. These three facts are
     what actually differ on the live list, in the order they are worth knowing: the venue's own
     word for the flavour (hip1 is the spot book, erc20 is the token contract), then the decimals,
     then the price. A candidate none of them separates falls back to the last four characters of
     its id, which is the only honest thing left and is still four characters, not sixty. */
  var FLAVOURS = { hip1: 'the spot one', erc20: 'the token contract one', nep141: 'the NEAR one', nep245: 'the bridged one' };

  function flavourOf(candidate, others) {
    var parts = String(candidate.assetId).split(':');
    for (var i = 0; i < parts.length; i += 1) {
      if (FLAVOURS[parts[i]]) return FLAVOURS[parts[i]];
    }
    for (var j = 0; j < others.length; j += 1) {
      if (others[j] !== candidate && others[j].decimals !== candidate.decimals) {
        return candidate.decimals + ' decimals';
      }
    }
    var id = String(candidate.assetId);
    return 'ending ' + id.slice(-4);
  }

  function build(host, candidates, onPick) {
    dom.clear(host);
    var head = dom.el('div', 'dock-head');
    var ticker = candidates.length ? candidates[0].symbol : '';
    head.appendChild(dom.el('h2', 'title', 'Two things are called ' + ticker + ' here.'));
    host.appendChild(head);
    host.appendChild(dom.el('p', 'body dim', 'They are different coins. Pick the one you meant.'));

    var list = dom.el('div', 'assetpick-list');
    for (var i = 0; i < candidates.length; i += 1) {
      list.appendChild(tile(candidates[i], candidates, onPick));
    }
    host.appendChild(list);
  }

  function tile(candidate, others, onPick) {
    var b = dom.el('button', 'assetpick-tile');
    b.type = 'button';
    var marks = window.PhosphorMarks;
    if (marks && typeof marks.logo === 'function') b.appendChild(marks.logo(candidate.symbol, 24));
    var words = dom.el('div', 'assetpick-words');
    words.appendChild(dom.el('p', 'assetpick-ticker', candidate.symbol));
    words.appendChild(dom.el('p', 'assetpick-note', flavourOf(candidate, others)));
    b.appendChild(words);
    if (candidate.priceUsd !== null && candidate.priceUsd !== undefined) {
      b.appendChild(dom.el('p', 'assetpick-usd', dom.usd(candidate.priceUsd)));
    }
    dom.on(b, 'click', function () { onPick(candidate.assetId); });
    return b;
  }

  window.PhosphorAssetPick = { build: build };
})();
