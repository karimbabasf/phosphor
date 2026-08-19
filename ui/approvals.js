/* The approval surface, rendered the same way on both windows.
 *
 * The pro page and the trade page each have their own boot, their own fetch helper and
 * their own token, so this file takes those as deps rather than reaching for globals.
 * What it will not take is a second opinion about what a proposal says: a click that
 * moves money has to be preceded by the same facts on whichever screen it happens on,
 * and two renderers is how two screens start disagreeing about what is being approved.
 *
 * Everything here is read from the proposal the server sent. The client composes no
 * sentence about money and decides nothing about the gate.
 */
(function (global) {
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function usd(n) {
    var v = Number(n);
    if (!isFinite(v)) return 'n/a';
    return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function clock(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toTimeString().slice(0, 8);
  }

  function headlineFor(proposal) {
    var draft = proposal.draft || {};
    if (draft.kind === 'consolidate') {
      var legs = (draft.legs || []).length;
      return 'consolidate ' + draft.symbol + ' to ' + draft.toChain + '  ' + usd(draft.totalUsd) +
        '  (' + legs + (legs === 1 ? ' leg)' : ' legs)');
    }
    if (draft.kind === 'policy_change') return 'policy change: ' + draft.sentence;
    if (draft.kind === 'transfer' && draft.leg) {
      return 'transfer ' + draft.leg.symbol + ' ' + draft.leg.fromChain + ' to ' + draft.leg.toChain +
        '  ' + usd(draft.leg.amountUsd);
    }
    // A swap's VENUE decides its custody and its on-chain vs off-chain nature, so it belongs in
    // the headline, not buried one line down in a simulation string the eye skips. Same-chain
    // reads "on arb"; cross-chain reads "arb to sol" so the two chains are both visible.
    if (draft.kind === 'swap') {
      var where = draft.chain === draft.toChain
        ? 'on ' + draft.chain
        : draft.chain + ' to ' + draft.toChain;
      return 'swap ' + draft.fromSymbol + ' to ' + draft.toSymbol + ' ' + where +
        ' via ' + draft.venue + '  ' + usd(draft.amountUsd);
    }
    return String(proposal.kind);
  }

  function diffOf(before, after) {
    var b = before || [];
    var a = after || [];
    var removed = [];
    var added = [];
    var i;
    for (i = 0; i < b.length; i++) if (a.indexOf(b[i]) === -1) removed.push(b[i]);
    for (i = 0; i < a.length; i++) if (b.indexOf(a[i]) === -1) added.push(a[i]);
    return { removed: removed, added: added };
  }

  /* A rendered sentence that carries a LIST is the reason an approval box filled with
     addresses. policyDiff holds sentences, not fields, so adding one destination to an
     allowlist of seven makes one long string differ from another long string: diffOf then
     correctly reports one line removed and one line added, and the screen prints all eight
     addresses twice while the human hunts for the one that changed.

     The approval box is where somebody decides whether to allow something. A reader who has to
     spot one changed token inside twenty lines of hex is a reader who approves without
     checking, so this is a safety property of the screen and not a tidiness preference.

     Splitting on the first colon is enough: every sentence renderSentences writes puts the rule
     name before it and the values after. Anything that does not fit that shape falls through
     and is printed whole, which is the safe direction. */
  function splitRule(line) {
    var text = String(line);
    var at = text.indexOf(':');
    if (at === -1) return null;
    var items = text.slice(at + 1).split(',');
    var cleaned = [];
    for (var i = 0; i < items.length; i++) {
      var item = items[i].trim().replace(/\.$/, '');
      if (item.length > 0) cleaned.push(item);
    }
    if (cleaned.length < 2) return null;
    return { label: text.slice(0, at).trim(), items: cleaned };
  }

  /* Pairs a removed sentence with the added sentence that replaced it, by rule name, and
     reduces the pair to the items that actually moved. Returns entries the caller renders:
     kind 'changed' carries a label plus item-level adds and drops, kind 'line' is a whole
     sentence that had no partner and is shown as it always was. */
  function refineDiff(diff) {
    var out = [];
    var removed = diff.removed.slice();
    var added = diff.added.slice();
    var usedAdded = {};

    for (var r = 0; r < removed.length; r++) {
      var beforeRule = splitRule(removed[r]);
      var matched = -1;
      if (beforeRule) {
        for (var a = 0; a < added.length; a++) {
          if (usedAdded[a]) continue;
          var afterRule = splitRule(added[a]);
          if (afterRule && afterRule.label === beforeRule.label) {
            matched = a;
            break;
          }
        }
      }
      if (matched === -1) {
        out.push({ kind: 'line', sign: '-', text: removed[r] });
        continue;
      }
      usedAdded[matched] = true;
      var afterItems = splitRule(added[matched]).items;
      var gained = [];
      var lost = [];
      var j;
      for (j = 0; j < afterItems.length; j++) {
        if (beforeRule.items.indexOf(afterItems[j]) === -1) gained.push(afterItems[j]);
      }
      for (j = 0; j < beforeRule.items.length; j++) {
        if (afterItems.indexOf(beforeRule.items[j]) === -1) lost.push(beforeRule.items[j]);
      }
      out.push({
        kind: 'changed',
        label: beforeRule.label,
        gained: gained,
        lost: lost,
        unchanged: afterItems.length - gained.length,
      });
    }
    for (var k = 0; k < added.length; k++) {
      if (!usedAdded[k]) out.push({ kind: 'line', sign: '+', text: added[k] });
    }
    return out;
  }

  /* The approval token this module has refreshed for itself, or null while the page's own is
     believed good. The token is minted once per app boot (src/server.ts) and each page reads it
     once at load, so ANY restart leaves an open page holding one the server has never heard of.
     ui/trade.js already cures that for a trade action (reportWriteFailure, trade.js:1280); the
     approval path was missed, so every further click resent the dead token and the box repeated
     "invalid approval token" without ever naming the cure. Observed 2026-08-14: 26 rejections
     against one proposal across three restarts, every one of them with a token present.

     Held here rather than written back into the page's own TOKEN because this module cannot
     assign another script's variable, and because both pages share this one path. */
  var refreshed = null;

  async function refreshToken() {
    try {
      var res = await fetch('/api/session', { headers: { accept: 'application/json' } });
      if (!res.ok) return false;
      var body = await res.json();
      if (typeof body.token !== 'string' || body.token.length === 0) return false;
      refreshed = body.token;
      return true;
    } catch (err) {
      return false;
    }
  }

  async function decide(route, id, buttons, errorNode, deps) {
    for (var i = 0; i < buttons.length; i++) buttons[i].disabled = true;
    errorNode.hidden = true;
    try {
      await deps.postJson(route, { id: id, token: refreshed !== null ? refreshed : deps.token() });
      await deps.onDecided();
    } catch (err) {
      var message = (err && err.message) || String(err);
      /* A dead token is refreshed and the click is deliberately NOT replayed. Approval is a
         physical human decision, and re-sending one on the human's behalf would let a click
         aimed at a token the server had already forgotten arm a bot with nobody deciding a
         second time. That is the exact property this screen exists to hold, so the cure stops
         at making the NEXT click work and says so. */
      if (/token/i.test(message)) {
        message = (await refreshToken())
          ? 'The app restarted, so this page was holding a dead approval token. It has been refreshed: click again to decide.'
          : 'Approval token is stale and could not be refreshed. Reload the page.';
      }
      errorNode.textContent = message;
      errorNode.hidden = false;
      // Re-enable only on failure. A click that landed leaves the buttons dead until the
      // refresh removes the block, so a second click cannot ride on a stale render.
      for (var j = 0; j < buttons.length; j++) buttons[j].disabled = false;
    }
  }

  function pendingBlock(proposal, deps) {
    var wrap = el('div', 'pending');

    var head = el('div');
    head.appendChild(el('span', 'tag', 'PENDING  '));
    head.appendChild(el('span', 'head', headlineFor(proposal)));
    wrap.appendChild(head);
    wrap.appendChild(el('div', 'meta', proposal.id + '   created ' + clock(proposal.createdAt)));

    var simulation = proposal.simulation;
    if (simulation) {
      if (simulation.summary) {
        var summaryLines = String(simulation.summary).split('\n');
        for (var i = 0; i < summaryLines.length; i++) wrap.appendChild(el('div', 'sim', summaryLines[i]));
      }
      if (simulation.error) wrap.appendChild(el('div', 'sim red', simulation.error));
      if (simulation.policyDiff) {
        var diff = diffOf(simulation.policyDiff.before, simulation.policyDiff.after);
        var entries = refineDiff(diff);
        for (var e = 0; e < entries.length; e++) {
          var entry = entries[e];
          if (entry.kind === 'line') {
            wrap.appendChild(el('div', entry.sign === '-' ? 'diff-before' : 'diff-after', entry.sign + ' ' + entry.text));
            continue;
          }
          // The rule name, then only what moved. The count of what stayed is kept because
          // "one added to seven" and "one added to nothing" are different decisions.
          var kept = entry.unchanged === 1 ? '1 entry unchanged' : entry.unchanged + ' entries unchanged';
          wrap.appendChild(el('div', 'sim', entry.label + '  (' + kept + ')'));
          for (var g = 0; g < entry.lost.length; g++) {
            wrap.appendChild(el('div', 'diff-before', '  - ' + entry.lost[g]));
          }
          for (var n = 0; n < entry.gained.length; n++) {
            wrap.appendChild(el('div', 'diff-after', '  + ' + entry.gained[n]));
          }
        }
        if (!entries.length) {
          wrap.appendChild(el('div', 'diff-before', 'no visible rule change'));
        }
      }
    }

    var reasons = (proposal.verdict && proposal.verdict.reasons) || [];
    for (var n = 0; n < reasons.length; n++) wrap.appendChild(el('div', 'reason', 'why: ' + reasons[n]));

    var error = el('div', 'sim red');
    error.hidden = true;

    var approve = el('button', 'btn approve', '[ APPROVE ]');
    approve.type = 'button';
    var refuse = el('button', 'btn refuse', '[ REFUSE ]');
    refuse.type = 'button';
    approve.addEventListener('click', function () {
      decide('/api/approve', proposal.id, [approve, refuse], error, deps);
    });
    refuse.addEventListener('click', function () {
      decide('/api/refuse', proposal.id, [approve, refuse], error, deps);
    });

    var actions = el('div', 'actions');
    actions.appendChild(approve);
    actions.appendChild(refuse);
    wrap.appendChild(actions);
    wrap.appendChild(error);
    return wrap;
  }

  /* box: where the blocks go. state: the /api/state payload, verbatim. deps: how this
     page talks to the server. Returns how many are pending, so a page that hides an
     empty panel can decide that without re-reading the state itself. */
  function render(box, state, deps) {
    var s = state || {};
    box.textContent = '';
    var pending = [];
    var proposals = s.proposals || [];
    for (var i = 0; i < proposals.length; i++) {
      if (proposals[i].status === 'pending') pending.push(proposals[i]);
    }
    if (!pending.length) {
      var empty = el('div', 'gate-empty', 'no pending approvals');
      // An empty gate means two different things depending on whether the gate is on.
      // Say which one this is.
      if (s.gate && s.gate.required === false) {
        empty.textContent = 'no pending approvals: ';
        empty.appendChild(el('span', 'off', 'the gate is disabled, every proposal auto-approves'));
      }
      box.appendChild(empty);
      return 0;
    }
    pending.sort(function (a, b) {
      return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
    });
    for (var j = 0; j < pending.length; j++) box.appendChild(pendingBlock(pending[j], deps));
    return pending.length;
  }

  global.APPROVALS = {
    render: render,
    // Exported for the basic view, which draws its own single ask and reuses this click.
    decide: decide,
    headlineFor: headlineFor,
    diffOf: diffOf,
    // Exported to be tested directly. What it decides is how much of a rule change a human
    // actually reads before clicking APPROVE, so it is worth asserting on rather than
    // eyeballing on a screenshot.
    refineDiff: refineDiff,
  };
})(window);
