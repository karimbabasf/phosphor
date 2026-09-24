/* Money in: the three steps of a deposit, run in place.

   The steps are ui/screens/netpick.js: the network, what it credits, the
   address. This fold used to be five cards that each said "Credits USDC,
   USDT, ..." and a button that opened the deposit card; the steps run here
   now, in the fold, so a person picks a network and reads the address without
   a dialog opening over the screen. The same component draws the wizard's
   addresses step: basic.js and firstrun.js both call render(host).

   The recovery phrase is not here any more (Karim, 2026-09-16: "remove this
   completely. that entire seedphrase button from the money in thing"). It
   lives on the Vault tab, in the phrase's own row: behind Touch ID on an
   enclave wallet, behind the password typed into that row on a password
   wallet. Nothing about the phrase is drawn in the conversation. */
(function () {
  'use strict';

  var dom = window.PhosphorDom;
  var api = window.PhosphorApi;

  var loading = null;

  /* The report, for anything that wants it whole. The steps read it through
     the same route and the backend keeps it for a minute, so this is cheap. */
  function load() {
    if (loading) return loading;
    loading = api.intentsReceive().then(function (result) {
      loading = null;
      return result.data || null;
    }).catch(function () {
      loading = null;
      return null;
    });
    return loading;
  }

  var steps = null;

  /* The fold renders again every time it opens. The steps that were there go
     with their watch subscription and their clock, not just their nodes. */
  function render(host, options) {
    var opts = options || {};
    if (steps) steps.destroy();
    dom.clear(host);
    var mount = dom.el('div', 'moneyin-steps');
    host.appendChild(mount);
    steps = window.PhosphorNetPick.render(mount, { context: opts.context || 'basic' });
    return steps;
  }

  /* ---------- a password wallet's words and its encrypted copy ----------

     Both happen on the Vault tab now, in place: the password is typed into
     the phrase's row at the moment of the reveal and held nowhere, and the
     words are shown there, never as a card in the conversation beside the
     assistant's messages. These two names stay for anything that still calls
     them, and hand over to the Vault. */
  function toVault(run) {
    var shell = window.PhosphorShell;
    if (shell && typeof shell.setView === 'function') shell.setView('vault', { fromClick: true });
    var vault = window.PhosphorVault;
    if (vault && typeof vault[run] === 'function') vault[run]();
  }

  window.PhosphorMoneyIn = {
    render: render,
    load: load,
    revealWithPassword: function () { toVault('startReveal'); },
    exportWithPassword: function () { toVault('startExport'); }
  };
})();
