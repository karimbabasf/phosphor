/* The yield panel: what the stablecoin is earning, and the way back out.
 *
 * The ORDER of this panel is its argument, and it is taken from 1inch's Aqua, which is the
 * only large yield product that gets this right. Aqua's overview leads each row with earned
 * fees and treats the rate as secondary, and its own docs call the percentage "an
 * observation, not a promise" and "a rear-view mirror". So here:
 *
 *   1. The dollars earned, largest thing on the panel.
 *   2. The percentage under it, smaller, with the window it covers printed beside it.
 *   3. The caveat under that, verbatim from the server.
 *   4. The position, the principal, and the rate the venue pays RIGHT NOW, which is a
 *      different number from what we earned and is never allowed to stand in for it.
 *   5. The ledger: every movement of principal with a hash a reader can open.
 *
 * This file composes no sentence about money and computes no percentage. Every number and
 * every caveat comes from src/yield/positions.ts through /api/state. A client that did its
 * own maths would be a second opinion about what the money did, and there is only one.
 */
(function (global) {
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  /* Yield is small numbers for a long time. Two decimals would print $0.00 for the first
     several hours of a real position, which reads as "it is not working". Six places is what
     a 6-decimal stablecoin actually carries, so this shows the whole truth and no more. */
  function earned(n) {
    var v = Number(n);
    if (!isFinite(v)) return 'n/a';
    var sign = v > 0 ? '+' : '';
    if (v !== 0 && Math.abs(v) < 0.01) return sign + '$' + v.toFixed(6);
    return sign + '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
  }

  function money(n) {
    var v = Number(n);
    if (!isFinite(v)) return 'n/a';
    return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
  }

  function rate(fraction) {
    var v = Number(fraction);
    if (!isFinite(v)) return 'n/a';
    return (v * 100).toFixed(2) + '%';
  }

  function clock(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toTimeString().slice(0, 8);
  }

  function shortHash(h) {
    return String(h).slice(0, 10) + '...';
  }

  /* One row per venue the app can reach, so the allocator's decision is visible rather than
     only its outcome. A loop whose reasoning is invisible looks broken on the tick where it
     is right to sit still. */
  function venueRows(view) {
    var wrap = el('div', 'y-venues');
    wrap.appendChild(el('div', 'y-sub', 'WHERE IT COULD GO'));
    var table = el('table', 'grid y-venue-table');
    var tbody = el('tbody');
    for (var i = 0; i < view.venues.length; i++) {
      var v = view.venues[i];
      var tr = el('tr');
      tr.appendChild(el('td', 'y-venue-chain', v.chain));
      tr.appendChild(el('td', 'y-venue-name', v.venue));
      var rateCell = el('td', 'c-num');
      rateCell.textContent = v.rate ? rate(v.rate.apy) : '--';
      tr.appendChild(rateCell);
      var note = el('td', 'y-venue-note');
      if (!v.healthy) {
        note.textContent = v.note || 'unavailable';
        tr.classList.add('y-venue-down');
      } else if (view.best && view.best.chain === v.chain) {
        note.textContent = 'best reachable';
        tr.classList.add('y-venue-best');
      } else if (Number(v.idleUsd) > 0) {
        note.textContent = money(v.idleUsd) + ' idle here';
      }
      tr.appendChild(note);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }

  function ledgerRows(holding) {
    var wrap = el('div', 'y-ledger');
    wrap.appendChild(el('div', 'y-sub', 'LEDGER'));
    if (holding.credits.length === 0) {
      wrap.appendChild(el('p', 'y-empty', 'Nothing has moved yet.'));
      return wrap;
    }
    var table = el('table', 'grid y-ledger-table');
    var tbody = el('tbody');
    for (var i = 0; i < holding.credits.length; i++) {
      var c = holding.credits[i];
      var tr = el('tr');
      tr.appendChild(el('td', 'y-when', clock(c.at)));
      tr.appendChild(el('td', 'y-kind', c.kind));
      var amt = Number(c.amountBase) / Math.pow(10, holding.decimals);
      tr.appendChild(el('td', 'c-num', (c.kind === 'withdraw' ? '-' : '+') + amt.toFixed(6)));
      var links = el('td', 'y-hashes');
      for (var t = 0; t < c.txids.length; t++) {
        var a = el('a', 'y-hash', shortHash(c.txids[t]));
        // The prefix comes from the server, which knows the position's chain. The client used
        // to build it from the network alone and always produced an Arbiscan URL, so every
        // hash on a Base position linked to a transaction that is not there.
        a.href = (holding.explorerTx || '') + c.txids[t];
        a.target = '_blank';
        a.rel = 'noreferrer noopener';
        links.appendChild(a);
        if (t < c.txids.length - 1) links.appendChild(document.createTextNode(' '));
      }
      tr.appendChild(links);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }

  function render(node, state) {
    if (!node) return 0;
    node.textContent = '';
    var view = state && state.yield;

    if (!view) {
      node.appendChild(el('p', 'y-empty', 'The yield allocator is not running in this window.'));
      return 0;
    }

    if (view.stale) {
      node.appendChild(
        el('p', 'y-stale', 'Could not read the chain just now, so these are the last good numbers: ' + (view.error || 'unknown error')),
      );
    }

    if (view.positions.length === 0) {
      node.appendChild(el('p', 'y-empty', 'Nothing is earning yet.'));
      node.appendChild(venueRows(view));
      if (view.decisions && view.decisions.length > 0) {
        node.appendChild(el('div', 'y-sub', 'ALLOCATOR'));
        node.appendChild(el('p', 'y-decision', view.decisions[0].detail));
      }
      return 0;
    }

    for (var p = 0; p < view.positions.length; p++) {
      var h = view.positions[p];
      var card = el('div', 'y-card');

      /* The headline, and it is the DOLLARS. Aqua leads with earned fees and the ordering is
         the honesty: a percentage read first is a percentage that gets remembered as a rate
         the product promised. */
      if (h.basisKnown === false) {
        /* A balance on chain with no deposit of ours behind it: a fresh data dir, a store
           restored short, or a position somebody supplied with this key outside the app.
           This used to print the whole balance as earnings, because the cost basis derived
           to zero and zero subtracts like a real number. Found 2026-08-20 by running the e2e
           on a throwaway data dir against a live 56.29 USDC position. */
        card.appendChild(el('p', 'y-earned dim', 'earnings unknown'));
        card.appendChild(
          el(
            'p',
            'y-rate y-rate-held',
            'This app has no record of the deposit that opened this position, so it cannot say what the money cost or what it has made. The balance below is read from the chain and is correct.',
          ),
        );
      } else {
        card.appendChild(el('p', 'y-earned', earned(h.earnedUsd) + ' earned'));
      }

      var r = h.realized;
      if (r && r.annualisedPct !== null) {
        card.appendChild(el('p', 'y-rate', r.annualisedPct.toFixed(2) + '% annualised, observed over ' + r.windowLabel));
      } else if (r) {
        /* Under an hour the server sends no percentage, and this says why rather than
           printing nothing. Annualising twelve minutes of interest is arithmetically correct
           and rhetorically a lie, and the panel should be seen refusing to tell it. */
        card.appendChild(
          el('p', 'y-rate y-rate-held', 'No rate yet: ' + r.windowLabel + ' is too short a window to annualise honestly.'),
        );
      }
      if (r) card.appendChild(el('p', 'y-caveat', r.caveat));

      var facts = el('table', 'grid y-facts');
      var fb = el('tbody');
      var fact = function (k, v) {
        var tr = el('tr');
        tr.appendChild(el('td', 'y-k', k));
        tr.appendChild(el('td', 'y-v', v));
        fb.appendChild(tr);
      };
      fact('holding', h.valueUsd.toFixed(6) + ' ' + h.symbol + ' as ' + h.receiptSymbol);
      fact('principal', money(h.principalUsd));
      fact('where', h.venue + ' on ' + h.chain);
      fact('venue rate now', h.rate ? rate(h.rate.apy) + ' APY' : 'unavailable');
      if (h.openedAt) fact('working since', new Date(h.openedAt).toLocaleString());
      facts.appendChild(fb);
      card.appendChild(facts);

      /* The way out, and it is one press. Aqua's close is one transaction with no queue and
         no cooldown, and anything slower than that has to be said on the way IN, not here.
         This files a proposal; it does not approve one. Above the click threshold it lands
         in the same gate at the top of this window that everything else lands in. */
      var actions = el('div', 'y-actions');
      var btn = el('button', 'btn y-withdraw', '[ WITHDRAW ]');
      btn.type = 'button';
      btn.dataset.chain = h.chain;
      actions.appendChild(btn);
      actions.appendChild(el('span', 'y-error'));
      card.appendChild(actions);

      card.appendChild(ledgerRows(h));
      node.appendChild(card);
    }

    node.appendChild(venueRows(view));

    if (view.decisions && view.decisions.length > 0) {
      var d = el('div', 'y-allocator');
      d.appendChild(el('div', 'y-sub', 'ALLOCATOR' + (view.autoAllocate ? '' : ' (watching only)')));
      d.appendChild(el('p', 'y-decision', view.decisions[0].detail));
      d.appendChild(el('p', 'y-decision-when', 'last looked ' + (view.lastTickAt ? clock(view.lastTickAt) : 'never')));
      node.appendChild(d);
    }

    return view.positions.length;
  }

  global.YIELD = { render: render };
})(window);
