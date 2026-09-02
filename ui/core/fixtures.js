/* Three development hooks, and nothing else.

   Every route in the contract exists now, so the lock, the first run, the
   migration and Money in are all reached by doing the real thing: lock the app,
   start with no keystore, leave a plaintext key file where the backend can find
   it, open the fold. Those fixtures are gone with the gates that needed them.

   What is left is three states that cannot be produced on demand, because each
   one needs history or a backend in a state a dev run cannot conjure: a receipt
   needs an action that already executed, the unknown outcome needs a proposal
   the chain never answered for, and a queued request needs a locked wallet an
   agent asked something of. Each hook renders the REAL component with fixture
   data, so what is on screen is the code that ships. None of them is reachable
   without the query string and no production path reads this file. */
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
      if (screen !== 'pendingunlock') return state;
      var next = Object.assign({}, state);
      next.lock = { state: 'locked', idleLocksInSec: null };
      next.proposals = [QUEUED].concat(Array.isArray(state.proposals) ? state.proposals : []);
      return next;
    },

    /* The receipt and the unknown-outcome cards open on load under their flags. */
    openCard: function () {
      if (screen === 'receipt') return RECEIPTS[0];
      if (screen === 'unknown') return RECEIPTS[1];
      return null;
    }
  };
})();
