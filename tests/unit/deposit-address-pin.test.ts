// The deposit address is the one string on the money-in screen this app cannot check against
// anything it holds, and it used to be drawn as any non-empty string one RPC answer carried: a
// bridge, a proxy or a path that answered another address put it under the QR code, and a
// person sending from an exchange had nothing to notice. Three things hold it now
// (src/http/wallet.ts): the answer has to have the shape of an address on that network, two
// answers in a row have to agree, and the address last shown is pinned on disk per (account,
// network), so a later answer that differs is drawn as no address plus a sentence, never as
// a new QR code.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { depositAddressProblem, depositPinsPath, intentsReceiveReport } from '../../src/http/wallet.ts';
import { RECEIVE_NETWORKS, receiveNetworkByBridge, receiveNetworkOf } from '../../src/rails/intents-address.ts';
import { base58Encode } from '../../src/chain/near.ts';
import type { Ctx } from '../../src/http/context.ts';

type Any = Record<string, any>;

const EVM = '0xd7b2de5862008d949dd6e5d70d4c68ad1d4d5050';
const OTHER_EVM = '0x9999999999999999999999999999999999999999';

function shaped(chain: string): string {
  const kind = receiveNetworkByBridge(chain)?.kind;
  if (chain.startsWith('eth:') || kind === 'evm') return EVM;
  if (kind === 'sol') return base58Encode(new Uint8Array(crypto.createHash('sha256').update(chain).digest()));
  if (chain === 'near:mainnet') return 'deposit-for-you.near';
  if (chain === 'btc:mainnet') return 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
  return `addr-for-${chain}`;
}

/* A bridge whose deposit_address answer is a function of the network AND of how many times it
   has been asked for that network, so a test can make the second answer differ from the first. */
function bridge(answer: (chain: string, nth: number) => string): { calls: Map<string, number>; restore: () => void } {
  const calls = new Map<string, number>();
  const real = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init: Any = {}) => {
    const body = JSON.parse(init.body ?? '{}') as { method: string; params: Any[] };
    if (body.method === 'supported_tokens') {
      return { ok: true, status: 200, json: async () => ({ result: { tokens: [{ defuse_asset_identifier: 'eth:1', asset_name: 'ETH', decimals: 18, min_deposit_amount: '1' }] } }) } as unknown as Response;
    }
    const chain = String(body.params[0]?.chain);
    const nth = (calls.get(chain) ?? 0) + 1;
    calls.set(chain, nth);
    return { ok: true, status: 200, json: async () => ({ result: { address: answer(chain, nth), chain } }) } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

let nextAccount = 0x2000;
function ctxFor(dataDir: string): { ctx: Ctx; account: string } {
  nextAccount += 1;
  const account = `0x${nextAccount.toString(16).padStart(40, '0')}`;
  const ctx = {
    cfg: { mode: 'live', dataDir },
    keystore: { addressReport: () => ({ addresses: { evm: account, solana: null, near: null }, verified: true, tampered: false }) },
  } as unknown as Ctx;
  return { ctx, account };
}

function row(report: Any, id: string): Any {
  const found = report.networks.find((n: Any) => n.id === id);
  assert.ok(found, `no ${id} row`);
  return found;
}

test('an answer that is not an address on the network is not shown, and the row says why', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-pin-'));
  const b = bridge((chain) => (chain === 'eth:1' ? '0x1234' : chain === 'sol:mainnet' ? 'not base58 at all!' : chain === 'btc:mainnet' ? 'send here: bc1q...' : shaped(chain)));
  try {
    const report = await intentsReceiveReport(ctxFor(dir).ctx);
    for (const [id, why] of [
      ['eth', /not an address on Ethereum \(not an address on Ethereum: expected 0x followed by 40 hex/],
      ['sol', /not an address on Solana \(not a Solana address/],
      ['btc', /not an address on Bitcoin \(not a Bitcoin address/],
    ] as const) {
      const r = row(report, id);
      assert.equal(r.address, null, `${id} drew a malformed address`);
      assert.match(String(r.unavailable), why);
    }
    assert.equal(row(report, 'base').address, EVM, 'a well-formed answer on another network still draws');
  } finally {
    b.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('every network is asked twice, and two answers that differ draw nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-pin-'));
  const b = bridge((chain, nth) => (chain === 'eth:1' && nth === 2 ? OTHER_EVM : shaped(chain)));
  try {
    const report = await intentsReceiveReport(ctxFor(dir).ctx);
    for (const net of RECEIVE_NETWORKS) assert.equal(b.calls.get(net.bridge), 2, `${net.id} was asked ${b.calls.get(net.bridge)} times`);
    const eth = row(report, 'eth');
    assert.equal(eth.address, null);
    assert.match(String(eth.unavailable), /two different addresses for this network within a second, so neither is shown/);
    assert.equal(row(report, 'base').address, EVM);
  } finally {
    b.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the address shown is pinned on disk per account and network, and a later answer that differs is drawn as no address with a sentence', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-pin-'));
  let swap = false;
  const b = bridge((chain) => (swap && chain === 'eth:1' ? OTHER_EVM : shaped(chain)));
  const { ctx, account } = ctxFor(dir);
  try {
    const first = await intentsReceiveReport(ctx);
    assert.equal(row(first, 'eth').address, EVM);
    assert.equal(row(first, 'eth').changed, null);
    const pins = JSON.parse(fs.readFileSync(depositPinsPath(dir), 'utf8')) as Record<string, { address: string; memo: string | null; shownAt: string }>;
    assert.equal(pins[`${account}|eth:1`].address, EVM, 'the first sight is pinned');
    assert.equal(pins[`${account}|sol:mainnet`].address, shaped('sol:mainnet'));
    assert.equal(fs.statSync(depositPinsPath(dir)).mode & 0o777, 0o600);

    // The bridge changes its answer for Ethereum. The row shows NO address (the pin is a
    // comparison key, never a destination: a file another local process can write must not
    // put an address in front of a person), says so, and the pin is left as it was. Base still
    // answers the same address and is untouched.
    swap = true;
    const second = await intentsReceiveReport(ctx, { force: true });
    const eth = row(second, 'eth');
    assert.equal(eth.address, null, 'neither the changed answer nor the pinned address is drawn');
    assert.equal(eth.unavailable, null);
    assert.match(String(eth.changed), /^The bridge now answers a different address for Ethereum \(ending \.\.\.999999\) than the one shown before \(ending \.\.\.[0-9a-fA-F]{6}\)\./);
    assert.match(String(eth.changed), /no address is shown/);
    assert.match(String(eth.changed), /do not send anything until you know why/);
    assert.equal(row(second, 'base').changed, null);
    assert.equal(row(second, 'base').address, EVM);
    const again = JSON.parse(fs.readFileSync(depositPinsPath(dir), 'utf8')) as Record<string, { address: string }>;
    assert.equal(again[`${account}|eth:1`].address, EVM, 'the pin did not move');

    // The bridge comes back to the pinned address: the sentence goes away.
    swap = false;
    const third = await intentsReceiveReport(ctx, { force: true });
    assert.equal(row(third, 'eth').changed, null);
    assert.equal(row(third, 'eth').address, EVM);
  } finally {
    b.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the pin survives a restart and never crosses accounts, and an unreadable pin file pins afresh', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-pin-'));
  const b = bridge((chain) => shaped(chain));
  try {
    const one = ctxFor(dir);
    await intentsReceiveReport(one.ctx);
    const two = ctxFor(dir);
    await intentsReceiveReport(two.ctx);
    const pins = JSON.parse(fs.readFileSync(depositPinsPath(dir), 'utf8')) as Record<string, unknown>;
    assert.ok(pins[`${one.account}|eth:1`] !== undefined && pins[`${two.account}|eth:1`] !== undefined, 'each account has its own pin');

    fs.writeFileSync(depositPinsPath(dir), 'not json');
    const report = await intentsReceiveReport(one.ctx, { force: true });
    assert.equal(row(report, 'eth').address, EVM);
    assert.equal(row(report, 'eth').changed, null);
    const fresh = JSON.parse(fs.readFileSync(depositPinsPath(dir), 'utf8')) as Record<string, { address: string }>;
    assert.equal(fresh[`${one.account}|eth:1`].address, EVM, 'pinned afresh');
  } finally {
    b.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('depositAddressProblem rules by the chain where it knows one and by plainness where it does not', () => {
  const eth = receiveNetworkOf('eth')!;
  const sol = receiveNetworkOf('sol')!;
  const near = receiveNetworkOf('near')!;
  const btc = receiveNetworkOf('btc')!;
  const xrp = receiveNetworkOf('xrp')!;
  assert.equal(depositAddressProblem(eth, EVM), null);
  assert.match(String(depositAddressProblem(eth, '0xD7b2de5862008D949dD6e5d70D4c68Ad1D4d5050')), /checksum/);
  assert.match(String(depositAddressProblem(eth, 'deposit-for-you.near')), /expected 0x followed by 40 hex/);
  assert.equal(depositAddressProblem(sol, shaped('sol:mainnet')), null);
  assert.match(String(depositAddressProblem(sol, EVM)), /not a Solana address/);
  assert.equal(depositAddressProblem(near, 'deposit-for-you.near'), null);
  assert.match(String(depositAddressProblem(near, 'Deposit.near')), /not a NEAR account id/);
  assert.equal(depositAddressProblem(btc, 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'), null);
  assert.match(String(depositAddressProblem(btc, 'addr-for-btc:mainnet')), /not a Bitcoin address/);
  assert.equal(depositAddressProblem(xrp, 'rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH'), null);
  assert.match(String(depositAddressProblem(xrp, 'send it here please')), /no spaces/);
  assert.match(String(depositAddressProblem(xrp, 'short')), /10 to 128/);
});

test('a pin file rewritten by another process cannot put its address on the card: the mismatch draws no address', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-pin-'));
  const b = bridge((chain) => shaped(chain));
  const { ctx, account } = ctxFor(dir);
  try {
    const first = await intentsReceiveReport(ctx);
    assert.equal(row(first, 'eth').address, EVM);
    // Any process running as this user can write the data dir. It writes the attacker's
    // address as the pin for Ethereum.
    fs.writeFileSync(depositPinsPath(dir), JSON.stringify({ [`${account}|eth:1`]: { address: OTHER_EVM, memo: null, shownAt: '2026-09-17T00:00:00Z' } }));
    const poisoned = await intentsReceiveReport(ctx, { force: true });
    const eth = row(poisoned, 'eth');
    assert.equal(eth.address, null, 'the poisoned pin is not drawn, and neither is the live answer');
    assert.match(String(eth.changed), /no address is shown/);
    assert.equal(row(poisoned, 'base').address, EVM, 'other networks are untouched');
  } finally {
    b.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
