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

  async function decide(route, id, buttons, errorNode, deps) {
    for (var i = 0; i < buttons.length; i++) buttons[i].disabled = true;
    errorNode.hidden = true;
    try {
      await deps.postJson(route, { id: id, token: deps.token() });
      await deps.onDecided();
    } catch (err) {
      errorNode.textContent = err.message || String(err);
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
        for (var r = 0; r < diff.removed.length; r++) {
          wrap.appendChild(el('div', 'diff-before', '- ' + diff.removed[r]));
        }
        for (var a = 0; a < diff.added.length; a++) {
          wrap.appendChild(el('div', 'diff-after', '+ ' + diff.added[a]));
        }
        if (!diff.removed.length && !diff.added.length) {
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
  };
})(window);
