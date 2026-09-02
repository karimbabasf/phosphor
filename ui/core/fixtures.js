/* Development fixtures for the screens whose routes are not on this branch yet.

   Reached with ?screen=firstrun | lock | migrate | receipt | unknown. They are
   development scaffolding for building and screenshotting those screens against
   the contract in spec section 4. Nothing here is reachable without the query
   string, and no production path reads this file. */
(function () {
  'use strict';

  var params = new URLSearchParams(window.location.search);
  var screen = params.get('screen') || '';

  var RECEIVE = {
    chains: [
      {
        id: 'eth',
        name: 'Ethereum',
        address: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
        warning: 'Send only Ethereum or tokens on Ethereum to this address.'
      },
      {
        id: 'base',
        name: 'Base',
        address: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
        warning: 'Send only tokens on Base to this address.'
      },
      {
        id: 'arb',
        name: 'Arbitrum',
        address: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
        warning: 'Send only tokens on Arbitrum to this address.'
      },
      {
        id: 'sol',
        name: 'Solana',
        address: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
        warning: 'Send only Solana or tokens on Solana to this address.'
      },
      {
        id: 'near',
        name: 'NEAR',
        address: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
        warning: 'Send only NEAR or tokens on NEAR to this address.'
      }
    ]
  };

  var RECEIPTS = {
    receipts: [
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
          { chain: 'arb', hash: '0x9f2c1ae4b7d05c8813fbd2a6e0417cc9de5b6a1f8340d7e2b5c9018a3f6de274', url: 'https://arbiscan.io/tx/0x9f2c' }
        ],
        balanceBefore: 52013.21,
        balanceAfter: 52012.39,
        status: 'executed'
      },
      {
        id: 'rcp_02',
        kind: 'yield_deposit',
        at: new Date(Date.now() - 1000 * 60 * 62).toISOString(),
        summary: 'Put US dollars to work',
        fromChain: 'base',
        toChain: 'base',
        amount: 5000,
        symbol: 'USDC',
        feesUsd: 0.04,
        txids: [
          { chain: 'base', hash: '0x41ba7cd9e2f80516a3c7d84be91f0c25d7a6b3e8420fc19d5e7a80b3c6f19d42', url: 'https://basescan.org/tx/0x41ba' }
        ],
        balanceBefore: 52013.25,
        balanceAfter: 52013.21,
        status: 'executed'
      },
      {
        id: 'rcp_03',
        kind: 'intents_deposit',
        at: new Date(Date.now() - 1000 * 60 * 60 * 5).toISOString(),
        summary: 'Moved US dollars between chains',
        fromChain: 'eth',
        toChain: 'sol',
        amount: 1200,
        symbol: 'USDC',
        feesUsd: 1.94,
        txids: [
          { chain: 'eth', hash: '0xc7e1d3a95b40f826d1c9e4a7b3086f52dc1a9e4b7350f28cd6a1b93e5074cf81', url: 'https://etherscan.io/tx/0xc7e1' }
        ],
        balanceBefore: 52015.19,
        balanceAfter: 52013.25,
        status: 'needs_reconciliation'
      }
    ]
  };

  var LOCK = { state: 'locked', idleLocksInSec: null };
  var DAILY = { capUsd: 2500, spentUsd: 812.44, resetsAt: new Date(Date.now() + 1000 * 60 * 60 * 9).toISOString() };

  var overrides = {};

  if (screen === 'lock') {
    overrides.lock = { state: 'locked', idleLocksInSec: null };
  } else if (screen === 'firstrun') {
    overrides.lock = { state: 'no_wallet', idleLocksInSec: null };
  } else if (screen === 'migrate') {
    overrides.lock = { state: 'needs_migration', idleLocksInSec: null };
  }

  /* A fixture run answers from this file, so the screens under a ?screen= flag
     never reach for a route that would 404 in the console. */
  window.PhosphorFixtures = {
    screen: screen,
    active: screen !== '',
    receive: function () { return RECEIVE; },
    receipts: function () { return RECEIPTS; },
    lock: function () { return LOCK; },
    dailyLimit: function () { return DAILY; },
    /* Applied over a real /api/state payload so the rest of the window stays
       live while one screen is being built. */
    applyToState: function (state) {
      if (!overrides.lock) return state;
      var next = Object.assign({}, state);
      next.lock = overrides.lock;
      if (!next.dailyLimit) next.dailyLimit = DAILY;
      return next;
    },
    /* The receipt and unknown-outcome cards open on load under their flags. */
    openCard: function () {
      if (screen === 'receipt') return RECEIPTS.receipts[0];
      if (screen === 'unknown') return RECEIPTS.receipts[2];
      return null;
    }
  };
})();
