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
     panel and only the tone differs. */
  var SURFACE = {
    /* what you hold */
    balances: 'holdings',
    wallet: 'holdings',
    composition: 'holdings',
    gas_report: 'holdings',
    swap: 'holdings',
    consolidate: 'holdings',
    intents_withdraw: 'holdings',
    /* earning */
    yield_read: 'earning',
    yield_auto: 'earning',
    yield_deposit: 'earning',
    yield_withdraw: 'earning',
    /* the rules */
    policy_show: 'rules',
    policy_change: 'rules',
    mandate_catalog: 'rules',
    mandate: 'rules',
    mandate_arm: 'rules',
    /* what happened */
    proposal_status: 'activity',
    log_tail: 'activity',
    /* money in */
    intents_deposit: 'moneyin',
    /* the trading account */
    hl_deposit: 'account',
    trade_read: 'position',
    /* the chart */
    candles: 'chart',
    market_search: 'chart',
    indicator_catalog: 'chart',
    watch: 'chart',
    /* the window itself */
    switch: 'tabs',
    set_theme: 'window',
    /* the assistant's own head */
    start: 'assistant',
    skill: 'assistant',
    research: 'assistant'
  };

  /* The one tool that leaves this machine. Its light goes out through the top
     of the window and comes back, rather than crossing to a panel, because
     nothing in this window is where it went. */
  var LEAVES = { research: true };

  var SKY_Y = -20;

  /* An id from a language model can name Object.prototype's own members, and a
     function is not a surface. */
  function lookup(id) {
    var hit = SURFACE[id];
    return typeof hit === 'string' ? hit : null;
  }

  function idFor(name) {
    var id = String(name || '').replace(/^mcp__phosphor__/, '');
    var hit = lookup(id);
    if (hit) return hit;
    /* Asking to do a thing lands where doing it lands. */
    if (id.indexOf('propose_') === 0) {
      hit = lookup(id.slice('propose_'.length));
      if (hit) return hit;
    }
    if (id.indexOf('chart_') === 0 || id.indexOf('trade_') === 0) return 'chart';
    if (id.indexOf('yield_') === 0) return 'earning';
    if (id.indexOf('agent_') === 0) return 'assistant';
    /* A tool nobody has mapped still came from the assistant, so it lights the
       assistant rather than nothing. */
    return 'assistant';
  }

  function surfaceOf(name) {
    var id = String(name || '').replace(/^mcp__phosphor__/, '');
    return {
      id: idFor(id),
      /* Amber means a person has to click, and every propose verb ends there. */
      tone: id.indexOf('propose_') === 0 ? 'wait' : 'glow',
      leaves: LEAVES[id] === true
    };
  }

  function surfaceForProposal(kind) {
    return lookup(String(kind || '')) || 'assistant';
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
      var where = surfaceOf(detail.name);
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
       subscription handing over what it already had, which is not a change. */
    var store = window.PhosphorState;
    if (store) {
      var seen = false;
      store.select('ledger', function () {
        if (!seen) {
          seen = true;
          return;
        }
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
