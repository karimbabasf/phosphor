/* Phosphor API surface. One function per route in the contract.

   Some of these routes do not exist on this branch yet. A read against a route
   the backend has not learned resolves with { missing: true } instead of
   throwing, so a screen renders the honest empty state rather than an error
   the person cannot act on. */
(function () {
  'use strict';

  var net = window.PhosphorNet;

  /* Which half of the contract this backend has learned.

     A fetch against a route the server has never heard of is logged by the
     browser as a console error whether or not the caller catches it, so the
     window does not probe. It reads two fields off /api/state instead: `lock`
     lands with custody and `dailyLimit` lands with reliability, and each one
     arrives in the same commit as the routes beside it. Until they do, the
     screens render the honest empty state and nothing is requested. */
  var has = { custody: false, reliability: false };

  function learn(state) {
    if (!state || typeof state !== 'object') return;
    has.custody = state.lock !== undefined && state.lock !== null;
    has.reliability = state.dailyLimit !== undefined && state.dailyLimit !== null;
  }

  var MISSING_READ = { data: { missing: true }, fresh: true, status: 404 };
  var MISSING_WRITE = { missing: true };

  function readOrMissing(path, options, gate) {
    if (gate === false) return Promise.resolve(MISSING_READ);
    return net.getJson(path, options).catch(function (err) {
      if (err && err.status === 404) return MISSING_READ;
      throw err;
    });
  }

  function writeOrMissing(path, body, options, gate) {
    if (gate === false) return Promise.resolve(MISSING_WRITE);
    return net.postJson(path, body, options).catch(function (err) {
      if (err && err.status === 404) return MISSING_WRITE;
      throw err;
    });
  }

  var api = {
    /* ---------- routes that exist today ---------- */

    state: function (options) {
      return net.getJson('/api/state', options);
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

    health: function () {
      return readOrMissing('/api/health', {}, has.reliability);
    },

    unlock: function (password) {
      return writeOrMissing('/api/unlock', { password: password }, { busy: 'lock', label: 'Unlocking' }, has.custody);
    },

    lock: function () {
      return writeOrMissing('/api/lock', {}, { busy: 'lock', label: 'Locking' }, has.custody);
    },

    walletCreate: function (password) {
      return writeOrMissing('/api/wallet/create', { password: password }, { busy: 'wallet', label: 'Making your wallet' }, has.custody);
    },

    walletImport: function (payload) {
      return writeOrMissing('/api/wallet/import', payload, { busy: 'wallet', label: 'Bringing your wallet in' }, has.custody);
    },

    walletMigrate: function (password) {
      return writeOrMissing('/api/wallet/migrate', { password: password }, { busy: 'wallet', label: 'Encrypting your keys' }, has.custody);
    },

    receive: function () {
      return readOrMissing('/api/receive', {}, has.custody);
    },

    receipts: function (limit) {
      return readOrMissing('/api/receipts?limit=' + (limit || 25), { busy: 'activity', label: 'Reading what happened' }, has.reliability);
    },

    reconcile: function (id) {
      return writeOrMissing('/api/reconcile', { id: id }, { busy: 'reconcile', label: 'Checking again' }, has.reliability);
    }
  };

  api.learn = learn;
  api.has = has;

  window.PhosphorApi = api;
})();
