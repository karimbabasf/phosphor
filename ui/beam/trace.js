/* The trace: what the assistant just did, shown where it happened.

   Every step the conversation opens says which tool it called. This file turns
   that into a place in the window and sends the beam there, so a person
   watching sees their holdings light up when the agent reads balances and the
   Trade tab light up when it touches the chart from another mode. It is the
   difference between an agent that reports what it did and one you can watch
   doing it.

   window.PhosphorTrace
     start()                     listen to steps, transactions and the ledger
     surfaceOf(tool)             -> { id, tone, leaves }
     surfaceForProposal(kind)    -> a data-surface id

   The beam flies for writes only. A read lands on a surface in the table
   below, so a card or a later write knows where it belongs, but a read in
   flight lights nothing: see WRITES.

   ONE TABLE ANSWERS BOTH. A proposal card and the tool that asked for it read
   the same row, because `propose_swap` is `swap` with a person in front of it.
   That is what keeps the card in the dock and the light on the panel pointing
   at the same thing rather than drifting apart over time.

   Nothing here writes to the DOM. Tool ids arrive from a language model, so the
   table is read through a guard rather than indexed directly. */
(function () {
  'use strict';

  /* Section 6 of the beam design, one row per surface. The verbs that move
     money sit beside the verbs that ask, deliberately: they land on the same
     panel and only the tone differs. Audited against the tool registry on
     2026-09-16: every read lands where its answer is shown, every write where
     it draws, and every propose verb on the dock, where the click is (see
     idFor). Money lives in two pockets now, NEAR Intents and Hyperliquid, so
     nothing here names a chain. */
  var SURFACE = {
    /* what you hold: the Money card */
    wallet: 'holdings',
    composition: 'holdings',
    watch: 'holdings',
    swap: 'holdings',
    intents_send: 'holdings',
    intents_pay: 'holdings',
    /* the rules */
    policy_show: 'rules',
    policy_change: 'rules',
    /* what happened */
    proposal_status: 'activity',
    log_tail: 'activity',
    /* money in */
    deposit: 'moneyin',
    /* the trading account */
    hl_deposit: 'account',
    hl_withdraw: 'account',
    trade: 'position',
    trade_change: 'position',
    trade_read: 'position',
    trade_batch: 'position',
    /* the chart */
    market_search: 'chart',
    chart_read: 'chart',
    chart_scan: 'chart',
    chart_batch: 'chart',
    chart_draw: 'chart',
    chart_snapshot: 'chart',
    chart_layout: 'chart',
    trade_plan: 'chart',
    trade_focus: 'chart',
    trade_highlight: 'chart',
    trade_overlay: 'chart',
    trade_clear: 'chart',
    /* the window itself */
    switch: 'tabs',
    set_theme: 'window',
    /* the assistant's own head: what it reads for itself, and the public
       chain data it looks up, which is shown in its own words */
    start: 'assistant',
    skill: 'assistant',
    profile_learned: 'assistant',
    research: 'assistant',
    chain_address: 'assistant',
    chain_transactions: 'assistant',
    chain_transaction: 'assistant',
    intents_activity: 'assistant'
  };

  /* Where every propose verb lands: the dock, which is where the click is.
     The world surface the request would touch is lit separately, amber, by
     the dock itself (ui/screens/decision.js reads surfaceForProposal). */
  var DOCK = 'dock';

  /* The one tool that leaves this machine. Its light goes out through the top
     of the window and comes back, rather than crossing to a panel, because
     nothing in this window is where it went. */
  var LEAVES = { research: true };

  /* THE BEAM FLIES FOR WRITES ONLY. A write is a tool that changes what the
     window shows (the chart's one write, a layout, a plan drawn as an idea, a
     highlight, an overlay, the focus, a clear, the theme, the view) or asks a
     person to click (every propose verb). A read lights nothing: the agent
     reads balances and the chart constantly, and a panel that scanned on every
     one of those was a window flashing for an agent thinking. The one read
     that still flies is research, because its light is about where the call
     went rather than that a call happened. */
  var WRITES = {
    chart_draw: true,
    chart_layout: true,
    trade_plan: true,
    trade_highlight: true,
    trade_overlay: true,
    trade_focus: true,
    trade_clear: true,
    set_theme: true,
    switch: true,
    watch: true
  };

  function writes(id) {
    if (WRITES[id] === true) return true;
    if (LEAVES[id] === true) return true;
    return id.indexOf('propose_') === 0;
  }

  var SKY_Y = -20;

  /* An id from a language model can name Object.prototype's own members, and a
     function is not a surface. */
  function lookup(id) {
    var hit = SURFACE[id];
    return typeof hit === 'string' ? hit : null;
  }

  function idFor(name) {
    var id = String(name || '').replace(/^mcp__phosphor__/, '');
    /* Asking lands on the dock, whatever is being asked: that is where the
       person's click is, and the flight is the app pointing at it. */
    if (id.indexOf('propose_') === 0) return DOCK;
    var hit = lookup(id);
    if (hit) return hit;
    if (id.indexOf('chart_') === 0 || id.indexOf('trade_') === 0) return 'chart';
    if (id.indexOf('agent_') === 0 || id.indexOf('chain_') === 0) return 'assistant';
    /* A tool nobody has mapped still came from the assistant, so it lights the
       assistant rather than nothing. */
    return 'assistant';
  }

  /* The aliases the switch tool accepts (src/mcp.ts), mapped to the view id
     the tab carries. So a beam for `switch` lands on the tab being gone TO,
     read from the tool's own argument, rather than on 'tabs' which is the tab
     being left. */
  var VIEW_ALIAS = {
    basic: 'basic', simple: 'basic', plain: 'basic',
    pro: 'pro', operator: 'pro', advanced: 'pro',
    trade: 'trade', trading: 'trade', hft: 'trade', perps: 'trade', hyperliquid: 'trade',
    vault: 'vault'
  };

  function switchTarget(input) {
    if (!input || typeof input !== 'object') return null;
    var mode = typeof input.mode === 'string' ? input.mode.trim().toLowerCase() : '';
    var view = VIEW_ALIAS[mode];
    return view ? 'tab-' + view : null;
  }

  /* WHERE THE LIGHT GOES. `input` is the scalar arguments the model sent
     (agent.js passes them on the step event), read only for `switch`, whose
     destination is the whole point of the call. */
  function surfaceOf(name, input) {
    var id = String(name || '').replace(/^mcp__phosphor__/, '');
    var target = id === 'switch' ? switchTarget(input) : null;
    return {
      id: target || idFor(id),
      /* Amber means a person has to click, and every propose verb ends there. */
      tone: id.indexOf('propose_') === 0 ? 'wait' : 'glow',
      leaves: LEAVES[id] === true
    };
  }

  /* KINDS THIS APP CAN NO LONGER PROPOSE AND STILL HAS TO DRAW.

     Earning and the pools left with the venues behind them, so no tool writes
     one of these any more. state/proposals.json keeps the rows that already
     executed, and one of those can still reach a card, so a kind with no tool
     is not the same thing as a kind with no home. Each of them moved money into
     or out of the wallet, so the wallet is where their light belongs. They are
     deliberately not in SURFACE: that table routes live tools, and a historic
     kind must not put a tool back on the map. */
  var HISTORIC = {
    yield_deposit: 'holdings',
    yield_withdraw: 'holdings',
    lp_add: 'holdings',
    lp_remove: 'holdings',
    mandate_arm: 'rules',
    mandate: 'rules'
  };

  function surfaceForProposal(kind) {
    var id = String(kind || '');
    var historic = HISTORIC[id];
    return lookup(id) || (typeof historic === 'string' ? historic : 'assistant');
  }

  /* The positions in the wallet report as one comparable string: where, which
     token and how much, and nothing that a price can move. A pocket that went
     stale counts, because a balance the app can no longer read is a change
     worth seeing. Sorted, so the order the pockets answered in is not a
     change. */
  function positionsOf(slice) {
    if (!slice || typeof slice !== 'object') return '';
    var out = [];
    var rows = slice.rows;
    if (Array.isArray(rows)) {
      for (var i = 0; i < rows.length; i += 1) {
        var row = rows[i] || {};
        out.push(String(row.chain) + '/' + String(row.tokenId) + '=' + String(row.quantity));
      }
    }
    var stale = slice.stale;
    if (Array.isArray(stale)) {
      for (var j = 0; j < stale.length; j += 1) out.push(String(stale[j]) + ':stale');
    }
    out.sort();
    return out.join('|');
  }

  /* ---------------------------------------------------------------- steps */

  var open = Object.create(null);
  var started = false;

  function beam() {
    return window.PhosphorBeam;
  }

  function onStep(event) {
    var detail = event && event.detail;
    if (!detail || !detail.id) return;
    var light = beam();
    if (!light) return;
    var key = String(detail.id);

    if (detail.state === 'live') {
      /* A read opens nothing, so its result has nothing to release either. */
      if (!writes(String(detail.name || '').replace(/^mcp__phosphor__/, ''))) return;
      var where = surfaceOf(detail.name, detail.input);
      open[key] = where;
      if (where.leaves) {
        var sky = { x: (window.innerWidth || 0) / 2, y: SKY_Y };
        light.fire({
          from: detail.node,
          to: sky,
          tone: where.tone,
          then: 'none',
          /* Out first, then back onto the assistant, which is what holds the
             scan while the network call runs. */
          done: function () {
            light.fire({ from: sky, to: where.id, tone: where.tone, then: 'hold' });
          }
        });
        return;
      }
      light.fire({ from: detail.node, to: where.id, tone: where.tone, then: 'hold' });
      return;
    }

    if (detail.state === 'done' || detail.state === 'error') {
      var opened = open[key];
      /* A result for a step this window never saw open releases nothing: the
         count of holds on a surface has to match, or a panel keeps a scan it
         has no call behind. */
      if (!opened) return;
      delete open[key];
      light.release(opened.id, detail.state === 'done');
    }
  }

  function start() {
    if (started) return;
    started = true;

    window.addEventListener('phosphor:step', onStep);

    var events = window.PhosphorEvents;
    if (events) {
      events.on('transactions', function () {
        var light = beam();
        if (light) light.decay('activity');
      });
    }

    /* What changed after an execution glows on its own, so money arriving looks
       like money arriving rather than like nothing. The first call is the
       subscription handing over what it already had, which is not a change.

       WHAT COUNTS AS MONEY ARRIVING, and this is the whole bug that was here.
       The subscription used to be on the raw ledger, which carries prices and
       the dollar value they produce. Those move on every price poll, and the
       state hub pushes up to 8 frames a second with a trading feed live, so
       the holdings panel lit for a reading of the market rather than for
       anything that happened to this wallet. On the basic screen, where
       holdings is the biggest thing on the page, it looked like a fault.

       A price is not a transaction. What is compared is the position itself:
       which pocket, which token, and how much of it is held, read off the
       wallet report the window draws (src/wallet.ts rows). A number on screen
       that moved because Ether moved still updates, it just does not announce
       itself as an event. */
    var store = window.PhosphorState;
    if (store) {
      var held = null;
      store.select('wallet', function (slice) {
        var next = positionsOf(slice);
        var first = held === null;
        var changed = held !== next;
        held = next;
        if (first || !changed) return;
        var light = beam();
        if (light) light.decay('holdings');
      });
    }
  }

  window.PhosphorTrace = {
    start: start,
    surfaceOf: surfaceOf,
    surfaceForProposal: surfaceForProposal
  };
})();
