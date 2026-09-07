/* Phosphor API surface. One function per route in the contract.

   Some of these routes do not exist on this branch yet. A read against a route
   the backend has not learned resolves with { missing: true } instead of
   throwing, so a screen renders the honest empty state rather than an error
   the person cannot act on. */
(function () {
  'use strict';

  var net = window.PhosphorNet;

  /* Which half of the contract this backend has learned.

   Every route in the contract exists now. The gate that used to sit here read a
   field off /api/state to decide whether a route had landed yet, so a screen
   never fetched something the backend had not learned and never logged a 404
   the caller could not act on. Both tracks have merged and there is nothing
   left to gate. */

  function writeOrMissing(path, body, options) {
    return net.postJson(path, body, options).catch(function (err) {
      if (err && err.status === 404) return { missing: true };
      throw err;
    });
  }

  var api = {
    /* ---------- routes that exist today ---------- */

    state: function (options) {
      return net.getJson('/api/state', options);
    },

    /* The proposal history, a page at a time. /api/state carries what is still waiting
       plus the last twenty decided, and nothing else: the full list grows for the life of
       a data directory and used to be 98% of the biggest response in the app.

       `query` is a search string the caller builds, '?limit=50&before=<id>'. `before` is
       the id of the last row of the page before it, which the previous answer returns as
       `nextBefore`; null there means that was the last page. */
    proposals: function (query) {
      return net.getJson('/api/proposals' + (query || ''), { busy: 'activity', label: 'Reading what happened' });
    },

    driverState: function () {
      return net.getJson('/api/driver', { noCache: true });
    },

    driver: function (payload, options) {
      return net.postJson('/api/driver', payload, options);
    },

    approve: function (id) {
      return net.postJson('/api/approve', { id: id }, { busy: 'decision', label: 'Approving' });
    },

    refuse: function (id) {
      return net.postJson('/api/refuse', { id: id }, { busy: 'decision', label: 'Refusing' });
    },

    kill: function (on) {
      return net.postJson('/api/kill', { on: on }, { busy: 'kill', label: on ? 'Freezing' : 'Unfreezing' });
    },

    yieldWithdraw: function (payload) {
      return net.postJson('/api/yield/withdraw', payload, { busy: 'yield', label: 'Bringing it back' });
    },

    transactions: function () {
      return net.getJson('/api/transactions', { busy: 'activity', label: 'Reading what happened' });
    },

    chart: function (query) {
      return net.getJson('/api/chart' + (query || ''), { busy: 'chart', label: 'Reading prices' });
    },

    trade: function () {
      return net.getJson('/api/trade', { busy: 'trade', label: 'Reading the account' });
    },

    tradeAction: function (payload) {
      return net.postJson('/api/trade/action', payload, { busy: 'trade', label: 'Sending' });
    },

    /* ---------- the driver connection line ---------- */

    connection: function () {
      return writeOrMissing('/api/driver', { action: 'connection' }).catch(function () {
        return MISSING_WRITE;
      });
    },

    /* ---------- routes from the contract, not on this branch yet ---------- */

    /* No token, and deliberately outside the busy contract: this is what the
       shell asks while the stream is down, and a spinner on the one call that
       answers "is the app there" would be reporting on itself. */
    health: function () {
      return net.getJson('/api/health', { noCache: true });
    },

    unlock: function (password) {
      return net.postJson('/api/unlock', { password: password }, { busy: 'lock', label: 'Unlocking' });
    },

    lock: function () {
      return net.postJson('/api/lock', {}, { busy: 'lock', label: 'Locking' });
    },

    walletCreate: function (password) {
      return net.postJson('/api/wallet/create', { password: password }, { busy: 'wallet', label: 'Making your wallet' });
    },

    walletImport: function (payload) {
      return net.postJson('/api/wallet/import', payload, { busy: 'wallet', label: 'Bringing your wallet in' });
    },

    walletMigrate: function (password) {
      return net.postJson('/api/wallet/migrate', { password: password }, { busy: 'wallet', label: 'Encrypting your keys' });
    },

    receive: function () {
      return net.getJson('/api/receive', { noCache: true });
    },

    receipts: function (limit) {
      return net.getJson('/api/receipts?limit=' + (limit || 25), { busy: 'activity', label: 'Reading what happened' });
    },

    /* Reveal is two halves on purpose. The POST proves the password and hands
       back a nonce and no material; the GET spends that nonce once, so an
       unattended unlocked window is not a key dump and a reveal cannot be
       replayed out of a log. The material is never cached and never stored. */
    revealStart: function (password, what) {
      return net.postJson('/api/wallet/reveal', { password: password, what: what },
        { busy: 'reveal', label: 'Checking your password' });
    },

    revealFetch: function (nonce) {
      return net.getJson('/api/wallet/reveal/' + encodeURIComponent(nonce), { noCache: true })
        .then(function (result) { return result.data; });
    },

    walletExport: function (password, path) {
      return net.postJson('/api/wallet/export', { password: password, path: path },
        { busy: 'wallet', label: 'Writing the backup' });
    },

    reconcile: function (id) {
      return net.postJson('/api/reconcile', { id: id }, { busy: 'reconcile', label: 'Checking again' });
    }
  };

  window.PhosphorApi = api;
})();
