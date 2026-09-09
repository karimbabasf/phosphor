/* Development hooks, and nothing else.

   Every route in the contract exists now, so the lock, the first run, the
   migration and Money in are all reached by doing the real thing: lock the app,
   start with no keystore, leave a plaintext key file where the backend can find
   it, open the fold. Those fixtures are gone with the gates that needed them.

   What is left is states that cannot be produced on demand, because each one
   needs history, or money, or a backend in a state a dev run cannot conjure: a
   receipt needs an action that already executed, the unknown outcome needs a
   proposal the chain never answered for, a queued request needs a locked wallet
   an agent asked something of, and the three wallet shapes need somebody's real
   balances. Each hook renders the REAL component with fixture data, so what is
   on screen is the code that ships. None of them is reachable without the query
   string and no production path reads this file.

   THE WALLET HOOKS ARE POST-CUT AND HAVE TO STAY THAT WAY. Phosphor holds money
   in two places: the NEAR Intents verifier and the Hyperliquid account. Every
   wallet row below is therefore kind 'intents' on place 'intents', which is what
   buildWallet emits now that the chain readers are gone. A fixture carrying
   eight coins across eleven chains would be a screen tuned against a wallet this
   app can no longer produce, which is worse than no fixture: it looks right in a
   screenshot and wrong on the owner's window. */
(function () {
  'use strict';

  var params = new URLSearchParams(window.location.search);
  var screen = params.get('screen') || '';

  var RECEIPTS = [
    {
      id: 'rcp_01',
      kind: 'swap',
      at: new Date(Date.now() - 1000 * 60 * 14).toISOString(),
      summary: 'Swapped US dollars for Ethereum',
      fromChain: 'arb',
      toChain: 'arb',
      amount: 2500,
      symbol: 'USDC',
      feesUsd: 0.82,
      txids: [
        { chain: 'arb', hash: '0x9f2c1ae4b7d05c8813fbd2a6e0417cc9de5b6a1f8340d7e2b5c9018a3f6de274', url: 'https://arbiscan.io/tx/0x9f2c1ae4b7d05c8813fbd2a6e0417cc9de5b6a1f8340d7e2b5c9018a3f6de274' }
      ],
      balanceBefore: 52013.21,
      balanceAfter: 52012.39,
      status: 'executed'
    },
    {
      id: 'rcp_02',
      kind: 'intents_deposit',
      at: new Date(Date.now() - 1000 * 60 * 60 * 5).toISOString(),
      summary: 'Moved US dollars between chains',
      fromChain: 'eth',
      toChain: 'sol',
      amount: 1200,
      symbol: 'USDC',
      feesUsd: 1.94,
      txids: [
        { chain: 'eth', hash: '0xc7e1d3a95b40f826d1c9e4a7b3086f52dc1a9e4b7350f28cd6a1b93e5074cf81', url: 'https://etherscan.io/tx/0xc7e1d3a95b40f826d1c9e4a7b3086f52dc1a9e4b7350f28cd6a1b93e5074cf81' }
      ],
      balanceBefore: 52015.19,
      balanceAfter: 52013.25,
      status: 'needs_reconciliation'
    }
  ];


  /* The verifier's own shape: an asset id and the account it credits, so a row
     here can be checked against `npm run intents-balance` rather than believed. */
  function intentsRow(symbol, assetId, quantity, priceUsd, priced) {
    return {
      kind: 'intents',
      chain: 'intents',
      symbol: symbol,
      tokenId: assetId,
      quantity: quantity,
      priceUsd: priceUsd,
      valueUsd: priced === false ? 0 : quantity * priceUsd,
      share: 0,
      native: false,
      priced: priced !== false,
      intents: { accountId: 'phosphor.near', assetId: assetId }
    };
  }

  /* What a funded wallet looks like now: a handful of balances in one place. */
  function heldWallet() {
    var rows = [
      intentsRow('USDC', 'nep141:base-0x833589f.omft.near', 18402.55, 1),
      intentsRow('ETH', 'nep141:eth.omft.near', 4.2183, 3186.08),
      intentsRow('SOL', 'nep141:sol.omft.near', 61.402, 160.01),
      intentsRow('NEAR', 'wrap.near', 4820.5, 1.9)
    ];
    var total = 0;
    for (var i = 0; i < rows.length; i += 1) total += rows[i].valueUsd;
    for (var j = 0; j < rows.length; j += 1) rows[j].share = total > 0 ? rows[j].valueUsd / total : 0;
    rows.sort(function (a, b) { return b.valueUsd - a.valueUsd; });
    return { rows: rows, totalUsd: total, byChain: { intents: total }, stale: [], emptyCount: 2 };
  }

  var WALLETS = {
    /* Money in one place, which is every wallet this app has. */
    wallet: function () { return heldWallet(); },

    /* Nothing held. Not an error and not a bug: a new wallet looks like this,
       and the window has to say so in a sentence rather than with a blank list. */
    empty: function () {
      return { rows: [], totalUsd: 0, byChain: {}, stale: [], emptyCount: 0 };
    },

    /* The verifier did not answer. What is held is UNKNOWN, which is a different
       fact from zero, and the window must never print the second when it means
       the first. buildWallet pushes 'intents' onto stale for exactly this. */
    unread: function () {
      return { rows: [], totalUsd: 0, byChain: {}, stale: ['intents'], emptyCount: 0 };
    }
  };

  var QUEUED = {
    id: 'req_queued',
    kind: 'swap',
    createdAt: new Date(Date.now() - 1000 * 60 * 3).toISOString(),
    status: 'pending_unlock',
    draft: {
      kind: 'swap',
      chain: 'arb',
      toChain: 'arb',
      fromSymbol: 'USDC',
      toSymbol: 'WETH',
      venue: 'uniswap-v3',
      amountUsd: 1500
    },
    simulation: { feeUsd: 0.74, priceImpact: 0.0008 },
    verdict: { reason: 'It is above the $100 you said to ask about.' }
  };

  window.PhosphorFixtures = {
    screen: screen,
    active: screen !== '',

    /* Applied over a real /api/state payload, so everything except the one
       thing being previewed is live. */
    applyToState: function (state) {
      if (WALLETS[screen]) {
        var swapped = Object.assign({}, state);
        swapped.wallet = WALLETS[screen]();
        return swapped;
      }
      if (screen !== 'pendingunlock') return state;
      var next = Object.assign({}, state);
      next.lock = { state: 'locked', idleLocksInSec: null };
      next.proposals = [QUEUED].concat(Array.isArray(state.proposals) ? state.proposals : []);
      return next;
    },

    /* The wallet shapes on their own, for a harness that mounts a screen with no
       backend behind it at all. */
    wallet: function (name) {
      var make = WALLETS[name] || WALLETS.wallet;
      return make();
    },

    /* The receipt and the unknown-outcome cards open on load under their flags. */
    openCard: function () {
      if (screen === 'receipt') return RECEIPTS[0];
      if (screen === 'unknown') return RECEIPTS[1];
      return null;
    }
  };
})();
