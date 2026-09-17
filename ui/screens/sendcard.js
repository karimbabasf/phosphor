/* The send card: what a person reads before money leaves for somebody else.

   One renderer for the two surfaces that show a send, the decision dock
   (ui/screens/decision.js, where the buttons live) and the conversation
   (ui/screens/cards.js, where the same card folds under the assistant's
   turn). Both hand it the same fields: the proposal's draft and simulation
   as the server wrote them, never the assistant's words.

   Top to bottom, and nothing else: the head (Pay or Send, the amount, the
   dollars, a status pill), the route (your balance, the bridge, the
   destination with the full address in groups of four, copyable, with its
   explorer link), the facts in two columns, the recipient line (first send in
   amber, or how many times before), and an empty slot the preflight checks
   will fill. Every explainer is behind an (i) a person hovers, never inline.

   Nothing here reads a value as markup: PhosphorDom sets text, and the one
   link out is an https url the server built for one of five explorers. The
   card decides nothing: the dock owns the buttons, and this file never calls
   the approve route. */
(function () {
  'use strict';

  var dom = window.PhosphorDom;

  var STACK_BELOW = 560;
  var SVG_NS = 'http://www.w3.org/2000/svg';

  /* The chain a payout lands on, by name, and the mark that stands for it.
     A network id the table does not know is said as the id itself. */
  var NETWORKS = {
    ethereum: { name: 'Ethereum', mark: 'ETH' },
    base: { name: 'Base', mark: 'BASE' },
    arbitrum: { name: 'Arbitrum', mark: 'ARB' },
    solana: { name: 'Solana', mark: 'SOL' },
    near: { name: 'NEAR', mark: 'NEAR' },
    bitcoin: { name: 'Bitcoin', mark: 'BTC' }
  };

  /* Only a url the server built (src/chainscan) and only for one of these
     hosts reaches an <a>: this is the one place the card hands the system
     browser a string. */
  var EXPLORER_HOSTS = ['etherscan.io', 'basescan.org', 'arbiscan.io', 'solscan.io', 'nearblocks.io', 'mempool.space'];

  var BRIDGE_TIP = '1Click sends it out for you; if it cannot, the money comes back to your balance.';
  var ARRIVES_TIP = 'The least the solver may deliver. The app refuses the live quote if it promises less.';
  var FEE_TIP = 'The solver\'s cut plus the bridge\'s flat fee. Both are already taken out of what arrives.';

  var STATUS = {
    pending: ['Waiting for you', 'warn'],
    pending_unlock: ['Unlock to decide', 'warn'],
    awaiting_touch: ['Touch ID', 'warn'],
    held: ['Holding', 'warn'],
    approved: ['Sending', 'ink'],
    executing: ['Sending', 'ink'],
    needs_reconciliation: ['Unconfirmed', 'warn'],
    executed: ['Sent', 'up'],
    refused: ['Refused', 'down'],
    policy_refused: ['Refused', 'down'],
    failed: ['Failed', 'down']
  };

  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function text(value) {
    return value === null || value === undefined ? '' : String(value);
  }

  function num(value) {
    return typeof value === 'number' && isFinite(value) ? value : null;
  }

  /* The last preflight the row ran, or null. Every attempt appends one; the
     card draws the newest. */
  function preflightOf(p) {
    var list = Array.isArray(p.preflight) ? p.preflight : [];
    for (var i = list.length - 1; i >= 0; i -= 1) if (isObject(list[i])) return list[i];
    return null;
  }

  /* A row the preflight is holding: approved, nothing signed, stamped with
     when the hold began. The reason is the newest preflight's. */
  function heldOf(p, preflight) {
    if (p.status !== 'approved' || typeof p.heldSince !== 'string') return null;
    var since = Date.parse(p.heldSince);
    return {
      since: isFinite(since) ? since : null,
      reason: preflight && preflight.holdReason ? text(preflight.holdReason) : 'Waiting for the checks to clear'
    };
  }

  /* ---------- what the card draws ---------- */

  /* The card's fields from a proposal as the store holds it: draft, simulation,
     verdict, status. `to` and the recipient facts are the app's normalised
     values, never the assistant's argument. */
  function viewOf(proposal) {
    var p = isObject(proposal) ? proposal : {};
    var draft = isObject(p.draft) ? p.draft : {};
    var sim = isObject(p.simulation) ? p.simulation : null;
    var send = sim && isObject(sim.send) ? sim.send : null;
    var kind = text(draft.kind || p.kind);
    var recipient = isObject(draft.recipient) ? draft.recipient : null;
    var network = kind === 'intents_pay' ? text(draft.network) : 'intents';
    var preflight = preflightOf(p);
    var held = heldOf(p, preflight);
    return {
      kind: kind,
      status: held ? 'held' : text(p.status || 'pending'),
      symbol: text(draft.symbol),
      amount: num(draft.amount),
      amountUsd: num(draft.amountUsd),
      network: network,
      to: text(draft.to),
      recipient: recipient,
      send: send,
      simulated: sim !== null,
      refusedWhy: refusedWhy(p),
      result: isObject(p.result) ? p.result : null,
      preflight: preflight,
      held: held
    };
  }

  /* The same fields from a tool answer in the conversation, which carries no
     draft: the server puts the normalised send facts on the reply as `send`
     (src/http/propose.ts), and the tool's own arguments fill what is left. */
  function viewOfToolData(input, data) {
    var args = isObject(input) ? input : {};
    var d = isObject(data) ? data : {};
    var facts = isObject(d.send) ? d.send : {};
    var sim = isObject(d.simulation) ? d.simulation : null;
    var where = text(facts.where || args.where);
    var kind = text(facts.kind || (where === 'intents' ? 'intents_send' : 'intents_pay'));
    return {
      kind: kind,
      status: text(d.status || 'pending'),
      symbol: text(facts.symbol || args.symbol).toUpperCase(),
      amount: num(facts.amount !== undefined ? facts.amount : args.amount),
      amountUsd: num(facts.amountUsd),
      network: where === 'intents' || where === '' ? 'intents' : where,
      to: text(facts.to || args.to),
      recipient: isObject(facts.recipient) ? facts.recipient : null,
      send: sim && isObject(sim.send) ? sim.send : null,
      simulated: sim !== null,
      refusedWhy: refusedWhy(d),
      result: isObject(d.result) ? d.result : null,
      preflight: preflightOf(d),
      held: null
    };
  }

  function refusedWhy(p) {
    var verdict = isObject(p.verdict) ? p.verdict : null;
    if (p.status === 'policy_refused' && verdict && Array.isArray(verdict.reasons) && verdict.reasons.length) {
      return text(verdict.reasons[verdict.reasons.length - 1]);
    }
    if (p.status === 'refused') return 'You said no.';
    if (p.status === 'failed' && isObject(p.result) && p.result.detail) return text(p.result.detail);
    return '';
  }

  /* ---------- words ---------- */

  function verbOf(view) {
    var done = view.status === 'executed';
    if (view.kind === 'intents_send') return done ? 'Sent' : 'Send';
    return done ? 'Paid' : 'Pay';
  }

  function networkName(id) {
    if (id === 'intents') return 'NEAR Intents';
    return NETWORKS[id] ? NETWORKS[id].name : text(id);
  }

  function methodOf(view) {
    return view.kind === 'intents_send' ? 'Inside NEAR Intents' : 'NEAR Intents payout';
  }

  function statusOf(view) {
    var pair = STATUS[view.status] || STATUS.pending;
    var word = pair[0];
    if (view.status === 'executed') word = view.kind === 'intents_send' ? 'Sent' : 'Paid';
    return { word: word, tone: pair[1] };
  }

  /* The address in groups of four so a person can check it against what they
     typed, group by group. A named NEAR account stays whole: splitting
     alice.near into syllables helps nobody. */
  function groupsOf(address) {
    var s = text(address);
    if (s === '') return [];
    if (!/^0x[0-9a-fA-F]{40}$/.test(s) && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return [s];
    var out = [];
    for (var i = 0; i < s.length; i += 4) out.push(s.slice(i, i + 4));
    return out;
  }

  function etaWords(seconds) {
    var s = num(seconds);
    if (s === null) return '';
    if (s < 60) return 'about ' + Math.max(1, Math.round(s)) + ' s';
    return 'about ' + Math.round(s / 60) + ' min';
  }

  /* How long the row has been held, in whole minutes, for the hold line. */
  function heldWords(held, now) {
    var reason = held.reason;
    if (held.since === null) return reason + '.';
    var minutes = Math.max(0, Math.floor(((num(now) !== null ? now : Date.now()) - held.since) / 60000));
    return reason + ' (' + (minutes < 1 ? 'under a minute' : minutes + ' min') + ').';
  }

  function dayWords(iso) {
    var t = Date.parse(text(iso));
    if (!isFinite(t)) return '';
    var d = new Date(t);
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return d.getDate() + ' ' + months[d.getMonth()];
  }

  function isExplorerUrl(url) {
    if (typeof url !== 'string' || url.indexOf('https://') !== 0) return false;
    var host = url.slice(8).split('/')[0].toLowerCase();
    return EXPLORER_HOSTS.indexOf(host) !== -1;
  }

  /* ---------- small parts ---------- */

  function logo(symbol, size) {
    var marks = window.PhosphorMarks;
    if (marks && typeof marks.logo === 'function') return marks.logo(symbol, size);
    return dom.el('span', 'logo', '');
  }

  function icon(name) {
    var icons = window.PhosphorIcons;
    if (icons && typeof icons.svg === 'function') return icons.svg(name);
    return dom.el('span', 'icon', '');
  }

  /* The (i): a button with the explainer on it, drawn by the stylesheet on
     hover and on focus, and read out by a screen reader through its label. */
  function info(tip) {
    var b = dom.el('button', 'sendcard-info');
    b.type = 'button';
    dom.setAttr(b, 'data-tip', tip);
    dom.setAttr(b, 'aria-label', tip);
    b.appendChild(dom.el('span', '', 'i'));
    return b;
  }

  /* An arrow drawn here rather than a glyph: it points right on one row and
     the stylesheet turns it down when the route stacks. */
  function arrow() {
    var wrap = dom.el('span', 'sendcard-arrow');
    dom.setAttr(wrap, 'aria-hidden', 'true');
    if (typeof document.createElementNS === 'function') {
      var svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('focusable', 'false');
      var path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', 'M4 12h14M13 7l5 5-5 5');
      svg.appendChild(path);
      wrap.appendChild(svg);
    }
    return wrap;
  }

  /* The fingerprint on the primary button while the dialog is up. */
  function fingerprint() {
    var wrap = dom.el('span', 'sendcard-finger');
    dom.setAttr(wrap, 'aria-hidden', 'true');
    if (typeof document.createElementNS === 'function') {
      var svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('focusable', 'false');
      var path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', 'M6 11a6 6 0 0 1 12 0v3M9 11a3 3 0 0 1 6 0v6M12 11v9M4 7.5A9 9 0 0 1 20 7.5M8 20.5a12 12 0 0 1-2-6.5');
      svg.appendChild(path);
      wrap.appendChild(svg);
    }
    return wrap;
  }

  function copyToClipboard(value, label) {
    if (!(navigator.clipboard && navigator.clipboard.writeText)) return;
    navigator.clipboard.writeText(value).then(function () {
      dom.setText(label, 'Copied');
      window.setTimeout(function () { dom.setText(label, 'Copy'); }, 1500);
    }).catch(function () { /* the address is on screen to read */ });
  }

  function fact(host, label, value, tip, tone) {
    var cell = dom.el('div', 'sendcard-fact');
    var head = dom.el('span', 'sendcard-fact-label');
    head.appendChild(dom.el('span', 'sendcard-fact-word', label));
    if (tip) head.appendChild(info(tip));
    cell.appendChild(head);
    var body = dom.el('span', 'sendcard-fact-value mono', value);
    if (tone) dom.setAttr(body, 'data-tone', tone);
    cell.appendChild(body);
    host.appendChild(cell);
  }

  /* ---------- the parts ---------- */

  function head(view) {
    var node = dom.el('header', 'sendcard-head');
    var title = dom.el('div', 'sendcard-title');
    title.appendChild(dom.el('p', 'sendcard-verb', verbOf(view)));
    var figure = dom.el('p', 'sendcard-amount mono');
    dom.setText(figure, (view.amount === null ? '' : dom.qty(view.amount) + ' ') + view.symbol);
    title.appendChild(figure);
    if (view.amountUsd !== null) title.appendChild(dom.el('p', 'sendcard-usd', dom.usd(view.amountUsd)));
    node.appendChild(title);
    var status = statusOf(view);
    var pill = dom.el('span', 'chip sendcard-status', status.word);
    dom.setAttr(pill, 'data-tone', status.tone);
    node.appendChild(pill);
    return node;
  }

  /* A node's first row is its mark and its name on one line, so the three
     nodes and the arrows between them share a top edge whatever wraps below. */
  function node(role, mark, name, small) {
    var n = dom.el('div', 'sendcard-node');
    dom.setAttr(n, 'data-node', role);
    var head = dom.el('div', 'sendcard-node-head');
    if (mark) head.appendChild(logo(mark, 20));
    head.appendChild(dom.el('p', 'sendcard-node-name' + (small ? ' sendcard-node-name--small' : ''), name));
    n.appendChild(head);
    return n;
  }

  function route(view) {
    var wrap = dom.el('div', 'sendcard-route');
    wrap.appendChild(node('from', view.symbol, 'Your NEAR Intents balance', false));
    wrap.appendChild(arrow());

    var via = node('via', '', 'NEAR Intents bridge', true);
    via.children[0].appendChild(info(BRIDGE_TIP));
    wrap.appendChild(via);
    wrap.appendChild(arrow());

    var inside = view.network === 'intents';
    var to = node('to', inside ? 'NEAR' : (NETWORKS[view.network] ? NETWORKS[view.network].mark : ''), inside ? 'NEAR Intents account' : networkName(view.network), false);

    var address = dom.el('p', 'sendcard-address mono');
    var groups = groupsOf(view.to);
    for (var i = 0; i < groups.length; i += 1) address.appendChild(dom.el('span', 'sendcard-group', groups[i]));
    dom.setAttr(address, 'data-address', view.to);
    to.appendChild(address);

    var actions = dom.el('div', 'sendcard-address-actions');
    var copy = dom.el('button', 'btn btn-quiet btn-sm sendcard-copy');
    copy.type = 'button';
    copy.appendChild(icon('copy'));
    var copyLabel = dom.el('span', 'btn-label', 'Copy');
    copy.appendChild(copyLabel);
    dom.on(copy, 'click', function () { copyToClipboard(view.to, copyLabel); });
    actions.appendChild(copy);

    var explorer = view.send ? view.send.explorer : null;
    if (isExplorerUrl(explorer)) {
      var link = dom.el('a', 'btn btn-quiet btn-sm sendcard-explorer');
      link.href = explorer;
      link.target = '_blank';
      link.rel = 'noreferrer noopener';
      link.appendChild(dom.el('span', 'btn-label', 'Explorer'));
      link.appendChild(icon('external'));
      actions.appendChild(link);
    }
    to.appendChild(actions);
    wrap.appendChild(to);
    return wrap;
  }

  function facts(view) {
    var grid = dom.el('dl', 'sendcard-facts');
    var s = view.send;
    fact(grid, 'Chain', networkName(view.network));
    fact(grid, 'Token', view.symbol);
    fact(grid, 'Method', methodOf(view));
    var arrives = s && s.arrivesAtLeast ? text(s.arrivesAtLeast) + ' ' + view.symbol : (view.simulated ? 'Not quoted' : 'Being quoted');
    fact(grid, 'Arrives at least', arrives, ARRIVES_TIP, s && s.arrivesAtLeast ? 'up' : '');
    var fee = s && num(s.feeUsd) !== null ? dom.fee(num(s.feeUsd)) : (view.simulated ? 'Not quoted' : 'Being quoted');
    if (s && s.bridgeFee) fee += ' (' + text(s.bridgeFee) + ' ' + view.symbol + ' bridge)';
    fact(grid, 'Fee', fee, FEE_TIP);
    var eta = s ? etaWords(s.etaSeconds) : '';
    fact(grid, 'Time', eta || (view.simulated ? 'Not quoted' : 'Being quoted'));
    return grid;
  }

  function recipientLine(view) {
    var wrap = dom.el('div', 'sendcard-recipient');
    var r = view.recipient;
    var first = !r || r.known !== true;
    var line = dom.el('p', 'sendcard-recipient-line');
    dom.setAttr(line, 'data-first', first ? 'true' : 'false');
    if (first) {
      line.appendChild(dom.el('span', 'dot', ''));
      line.appendChild(dom.el('span', '', 'First send to this address.'));
    } else {
      var count = num(r.count) || 0;
      var when = dayWords(r.lastAt);
      line.appendChild(dom.el('span', '', 'Sent here ' + count + (count === 1 ? ' time' : ' times') + (when ? ', last ' + when : '') + '.'));
    }
    wrap.appendChild(line);

    var activity = view.send && view.send.activity ? text(view.send.activity) : '';
    if (!activity && r && r.ownAddress === true) activity = 'This is your own address on ' + networkName(view.network) + '.';
    if (!activity && view.network !== 'intents') activity = 'This address was not checked on ' + networkName(view.network) + '.';
    if (activity) {
      var sentence = dom.el('p', 'sendcard-activity', activity);
      if (r && r.ownAddress === true) dom.setAttr(sentence, 'data-own', 'true');
      wrap.appendChild(sentence);
    }
    return wrap;
  }

  /* ---------- layout ---------- */

  /* The route stacks under 560 px of column and the arrows turn down. A
     class rather than a media query, because the card lives in a column whose
     width is the split's and not the window's, and so a test can hold it. The
     width measured is the host's (the dock card, or the thread card's body):
     the card itself is never wider than 520 px, so its own width says nothing. */
  function layout(root, width) {
    var narrow = typeof width === 'number' && width > 0 && width < STACK_BELOW;
    var classes = String(root.className || '').split(' ').filter(function (c) { return c && c !== 'sendcard--stacked'; });
    if (narrow) classes.push('sendcard--stacked');
    root.className = classes.join(' ');
    return narrow;
  }

  function watch(host, root) {
    if (typeof ResizeObserver !== 'function') return;
    if (host.__sendcardObserver) host.__sendcardObserver.disconnect();
    var ro = new ResizeObserver(function (entries) {
      if (!root.isConnected) { ro.disconnect(); host.__sendcardObserver = null; return; }
      for (var i = 0; i < entries.length; i += 1) layout(root, entries[i].contentRect.width);
    });
    ro.observe(host);
    host.__sendcardObserver = ro;
  }

  /* ---------- the card ---------- */

  /* Builds the card into `host` and returns the root. `opts.width` is the
     column width when the caller knows it; `opts.now` the clock for the hold
     line, and `opts.checksOpen` starts the checks unfolded (proofs only). */
  function build(host, view, opts) {
    var o = opts || {};
    var root = dom.el('section', 'sendcard');
    dom.setAttr(root, 'data-kind', view.kind);
    dom.setAttr(root, 'data-status', view.status);
    dom.setAttr(root, 'aria-label', verbOf(view) + ' ' + (view.amount === null ? '' : dom.qty(view.amount) + ' ') + view.symbol + ', ' + statusOf(view).word);

    root.appendChild(head(view));

    /* Held: the person already decided and the app is waiting for the chain.
       The line says what for and how long, and asks nothing. */
    if (view.held) {
      var hold = dom.el('p', 'sendcard-hold', heldWords(view.held, o.now) + ' Nothing is signed until it clears.');
      dom.setAttr(hold, 'data-tone', 'warn');
      root.appendChild(hold);
    }

    root.appendChild(route(view));
    root.appendChild(facts(view));
    root.appendChild(recipientLine(view));

    if (view.refusedWhy) {
      var why = dom.el('p', 'sendcard-why', view.refusedWhy);
      dom.setAttr(why, 'data-tone', 'down');
      root.appendChild(why);
    }

    /* The checks the app ran before signing, folded. Empty until the row has
       run once, and the stylesheet gives an empty slot no height. */
    var checks = dom.el('div', 'sendcard-checks');
    dom.setAttr(checks, 'data-checks', '');
    if (view.preflight && window.PhosphorChecks && typeof window.PhosphorChecks.fold === 'function') {
      window.PhosphorChecks.fold(checks, view.preflight, { open: o.checksOpen === true });
    }
    root.appendChild(checks);

    var width = typeof o.width === 'number' ? o.width : (typeof host.clientWidth === 'number' ? host.clientWidth : 0);
    if (width > 0) layout(root, width);
    watch(host, root);
    host.appendChild(root);
    return root;
  }

  /* The hold sentence for a row that is not a send (the dock draws it under a
     HyperCore deposit that is holding): the same words as the card's own line. */
  function heldLine(proposal, now) {
    var p = isObject(proposal) ? proposal : {};
    var held = heldOf(p, preflightOf(p));
    return held ? heldWords(held, now) + ' Nothing is signed until it clears.' : '';
  }

  window.PhosphorSendCard = {
    build: build,
    viewOf: viewOf,
    heldLine: heldLine,
    preflightOf: preflightOf,
    viewOfToolData: viewOfToolData,
    layout: layout,
    groupsOf: groupsOf,
    fingerprint: fingerprint,
    networkName: networkName,
    isExplorerUrl: isExplorerUrl,
    STACK_BELOW: STACK_BELOW
  };
})();
