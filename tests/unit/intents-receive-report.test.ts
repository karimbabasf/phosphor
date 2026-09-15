// The receive report: the bridge's six round trips, kept for a minute per account, and the
// token rows carrying the floor in the unit a person reads.
//
// fetch is replaced for the test and counted. Nothing here reaches the bridge.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { intentsReceiveReport } from '../../src/http/wallet.ts';
import type { Ctx } from '../../src/http/context.ts';

type Any = Record<string, any>;

const USDC_ROW = {
  defuse_asset_identifier: 'eth:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  asset_name: 'USDC',
  decimals: 6,
  min_deposit_amount: '1000',
  intents_token_id: 'nep141:base-0x8335.omft.near',
};
const ETH_ROW = { defuse_asset_identifier: 'eth:1', asset_name: 'ETH', decimals: 18, min_deposit_amount: '100000000000' };

function ctxFor(account: string | null, mode: 'live' | 'demo' = 'live'): Ctx {
  return {
    cfg: { mode },
    keystore: {
      addressReport: () => ({ addresses: { evm: account, solana: null, near: null }, verified: true, tampered: false }),
    },
  } as unknown as Ctx;
}

/* A bridge that answers every deposit_address with one address per network and the token
   list once, and counts how often it was asked. `down` makes every call throw. */
function bridge(options: { down?: boolean; tokens?: unknown[] } = {}): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init: Any = {}) => {
    const body = JSON.parse(init.body ?? '{}') as { method: string; params: Any[] };
    calls.push(body.method);
    if (options.down) throw new Error('no route to the bridge');
    const answer = body.method === 'supported_tokens'
      ? { result: { tokens: options.tokens ?? [USDC_ROW, ETH_ROW] } }
      : { result: { address: `addr-for-${String(body.params[0]?.chain)}`, chain: body.params[0]?.chain } };
    return { ok: true, status: 200, json: async () => answer } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

test('the token rows carry the floor in base units and in the unit a person reads, plus the contract', async () => {
  const net = bridge();
  try {
    const report = await intentsReceiveReport(ctxFor('0xAAAA000000000000000000000000000000000001'));
    const base = report.networks.find((n) => n.id === 'base');
    assert.ok(base, 'no Base row');
    assert.deepEqual(base.accepts, [{
      symbol: 'USDC',
      minDeposit: '1000',
      minDepositHuman: '0.001',
      decimals: 6,
      contract: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    }]);
    const eth = report.networks.find((n) => n.id === 'eth');
    assert.deepEqual(eth?.accepts, [{ symbol: 'ETH', minDeposit: '100000000000', minDepositHuman: '0.0000001', decimals: 18, contract: null }]);
    assert.equal(base.address, 'addr-for-eth:8453');
  } finally {
    net.restore();
  }
});

test('the bridge is asked once a minute per account; force asks again; a second account is its own entry', async () => {
  const net = bridge();
  try {
    const one = ctxFor('0xBBBB000000000000000000000000000000000002');
    await intentsReceiveReport(one);
    assert.equal(net.calls.length, 6, 'five addresses and one token list');
    await intentsReceiveReport(one);
    await intentsReceiveReport(one);
    assert.equal(net.calls.length, 6, 'a second read inside the minute went back to the bridge');
    await intentsReceiveReport(one, { force: true });
    assert.equal(net.calls.length, 12, 'force did not ask again');
    await intentsReceiveReport(ctxFor('0xCCCC000000000000000000000000000000000003'));
    assert.equal(net.calls.length, 18, 'another account read the first one\'s cache');
  } finally {
    net.restore();
  }
});

test('a bridge that was down is not remembered as down: the next call asks again', async () => {
  const down = bridge({ down: true });
  const account = '0xDDDD000000000000000000000000000000000004';
  try {
    const report = await intentsReceiveReport(ctxFor(account));
    assert.ok(report.networks.every((n) => n.address === null && n.unavailable !== null), 'a down bridge drew an address');
    assert.equal(down.calls.length, 6);
    await intentsReceiveReport(ctxFor(account));
    assert.equal(down.calls.length, 12, 'the failed answer was served from the cache');
  } finally {
    down.restore();
  }
  const up = bridge();
  try {
    const report = await intentsReceiveReport(ctxFor(account));
    assert.ok(report.networks.every((n) => n.address !== null), 'the bridge came back and the report did not');
  } finally {
    up.restore();
  }
});

test('verified is read fresh on every call, never from the cached bridge half', async () => {
  const net = bridge();
  try {
    let verified = false;
    const ctx = {
      cfg: { mode: 'live' },
      keystore: { addressReport: () => ({ addresses: { evm: '0xEEEE000000000000000000000000000000000005', solana: null, near: null }, verified, tampered: false }) },
    } as unknown as Ctx;
    assert.equal((await intentsReceiveReport(ctx)).verified, false);
    verified = true;
    const again = await intentsReceiveReport(ctx);
    assert.equal(again.verified, true, 'the wallet opened and the report still said unverified');
    assert.equal(net.calls.length, 6, 'the flip cost a bridge round trip');
  } finally {
    net.restore();
  }
});

test('PHOSPHOR_DEMO_RECEIVE stands in for the bridge in demo mode only', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-receive-'));
  const file = path.join(dir, 'receive.json');
  fs.writeFileSync(file, JSON.stringify({ addresses: { eth: '0xfixture', base: '0xfixture', sol: 'SoLfixture' }, tokens: [USDC_ROW, ETH_ROW] }));
  const was = process.env.PHOSPHOR_DEMO_RECEIVE;
  process.env.PHOSPHOR_DEMO_RECEIVE = file;
  const net = bridge();
  try {
    const demo = await intentsReceiveReport(ctxFor('0xFFFF000000000000000000000000000000000006', 'demo'));
    assert.equal(net.calls.length, 0, 'demo mode with a fixture still asked the bridge');
    assert.equal(demo.networks.find((n) => n.id === 'base')?.address, '0xfixture');
    assert.equal(demo.networks.find((n) => n.id === 'base')?.accepts[0]?.minDepositHuman, '0.001');
    const near = demo.networks.find((n) => n.id === 'near');
    assert.equal(near?.address, null);
    assert.equal(near?.unavailable, 'not in the demo fixture');

    await intentsReceiveReport(ctxFor('0xFFFF000000000000000000000000000000000007', 'live'));
    assert.equal(net.calls.length, 6, 'live mode read the demo fixture');
  } finally {
    net.restore();
    if (was === undefined) delete process.env.PHOSPHOR_DEMO_RECEIVE;
    else process.env.PHOSPHOR_DEMO_RECEIVE = was;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
