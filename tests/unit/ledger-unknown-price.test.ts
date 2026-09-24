// A price the ledger could not read is absent, never 0.
//
// The first refresh with the price feed down wrote 0 for ETH, SOL and NEAR, and a price of 0
// reads as "worth nothing" to any reader that forgets to ask whether it is a price at all: a
// balance a person owns shown as $0.00 (R5, "money-display bugs"). Unknown stays unknown.
//
// Run: node --test tests/unit/ledger-unknown-price.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AppConfig } from '../../src/types.ts';
import { createLedger } from '../../src/ledger/index.ts';
import { loadDemoLedger } from '../../src/ledger/demo.ts';

// No keys file: no wallet, so the ledger reads prices and nothing else.
function config(): AppConfig {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-price-'));
  return { mode: 'live', keysPath: path.join(dir, 'keys.json'), port: 4177, addresses: {}, candleProducts: [], dataDir: dir };
}

test('a price feed that is down on the first refresh leaves the prices absent, not 0, and a later outage keeps the last read', async () => {
  let feed: 'down' | 'up' = 'down';
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (!url.includes('coinbase.com')) throw new Error(`unexpected request ${url}`);
    if (feed === 'down') return new Response('unavailable', { status: 503 });
    return new Response(JSON.stringify([[0, 0, 0, 0, 3000, 0]]), { status: 200 });
  }) as typeof fetch;
  const ledger = createLedger(config(), { fetchImpl, log: () => {} });

  const first = await ledger.refresh();
  for (const symbol of ['ETH', 'SOL', 'NEAR']) {
    assert.equal(symbol in first.prices, false, `${symbol} was given a price nobody read: ${first.prices[symbol]}`);
  }

  feed = 'up';
  const read = await ledger.refresh();
  assert.equal(read.prices.ETH, 3000);
  const stamp = read.priceAsOf?.ETH;

  feed = 'down';
  const after = await ledger.refresh();
  assert.equal(after.prices.ETH, 3000, 'the last read price stays for display');
  assert.equal(after.priceAsOf?.ETH, stamp, 'and keeps the time it was read, so it ages out of governing');
});

test('the demo fixture carries only the prices it has, never a 0 for one it lacks', () => {
  for (const price of Object.values(loadDemoLedger().prices)) assert.ok(price > 0, `a demo price of ${price}`);
});
