// The deposit watch reports what actually happened to the money, phase by phase.
//
// A person who has just sent a test amount from an exchange used to get a count-up clock and
// nothing else until the ledger's next full refresh happened to notice the balance. Now each
// 3 s tick asks the bridge what it has seen (recent_deposits) and the verifier what it has
// credited (one mt_batch_balance_of for the watched asset), and the frame carries the phase,
// the hash, the explorer link, the confirmations on an EVM chain, the amount, and the last
// read failure. Every venue is a fake fetch here, the research.ts way: nothing reaches a
// network, and a full ledger refresh from inside a tick would be an unexpected call.

import test from 'node:test';
import assert from 'node:assert/strict';

import type { Ledger } from '../../src/ledger/index.ts';
import type { IntentsRead } from '../../src/ledger/intents.ts';
import type { LedgerSnapshot } from '../../src/types.ts';
import { createDepositWatch, type DepositState } from '../../src/vault/watch.ts';

const ACCOUNT = '0x9858effd232b4033e47d90003d41ec34ecaeda94';
const USDC_ETH = 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near';
const USDC_CONTRACT = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const TOKEN = { assetId: USDC_ETH, decimals: 6, contract: USDC_CONTRACT };

type BridgeRow = { txHash: string; amount: string; status: string; asset: string };

type World = {
  rows: BridgeRow[];
  // The verifier's answer in base units, or null for a verifier that is not answering.
  balance: string | null;
  head: number;
  receiptBlock: number | null;
  calls: string[];
  unexpected: string[];
  fetchImpl: typeof fetch;
};

function fakeWorld(): World {
  const world: World = { rows: [], balance: '0', head: 100, receiptBlock: null, calls: [], unexpected: [], fetchImpl: fetch };
  const json = (payload: unknown, status = 200): Response =>
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
  const nearView = (value: unknown): Response =>
    json({ jsonrpc: '2.0', id: 1, result: { result: [...Buffer.from(JSON.stringify(value), 'utf8')] } });
  world.fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = (typeof init?.body === 'string' ? JSON.parse(init.body) : {}) as Record<string, unknown>;
    if (url === 'https://bridge.chaindefuser.com/rpc') {
      world.calls.push(`bridge:${String(body.method)}`);
      const deposits = world.rows.map((r) => ({
        tx_hash: r.txHash,
        chain: 'eth:1',
        defuse_asset_identifier: r.asset,
        decimals: 6,
        amount: r.amount,
        account_id: ACCOUNT,
        address: '0x6f0bA7BBdeadbeef',
        status: r.status,
      }));
      return json({ id: 'phosphor', jsonrpc: '2.0', result: { deposits, total: deposits.length, hasMore: false, limit: 10, offset: 0 } }, 201);
    }
    if (url.includes('fastnear')) {
      const params = (body.params ?? {}) as { method_name?: string };
      world.calls.push(`verifier:${String(params.method_name)}`);
      if (world.balance === null) return json({ jsonrpc: '2.0', id: 1, error: { cause: { name: 'UNAVAILABLE' } } });
      return nearView([world.balance]);
    }
    if (url === 'https://ethereum-rpc.publicnode.com') {
      world.calls.push(`evm:${String(body.method)}`);
      if (body.method === 'eth_getTransactionReceipt') {
        const result = world.receiptBlock === null ? null : { blockNumber: `0x${world.receiptBlock.toString(16)}`, status: '0x1' };
        return json({ jsonrpc: '2.0', id: 1, result });
      }
      if (body.method === 'eth_blockNumber') return json({ jsonrpc: '2.0', id: 1, result: `0x${world.head.toString(16)}` });
    }
    world.unexpected.push(url);
    throw new Error(`unexpected request ${url}`);
  }) as typeof fetch;
  return world;
}

// The ledger as the watch sees it: the last known holdings for the baseline, nothing else.
function ledgerWith(intents: IntentsRead | undefined): Ledger {
  const snapshot = { holdings: [], mode: 'live', prices: {}, priceAsOf: {} } as unknown as LedgerSnapshot;
  return {
    snapshot: () => snapshot,
    intents: () => intents,
    hyperliquid: () => undefined,
    refresh: async () => snapshot,
  };
}

const READ_OK: IntentsRead = { holdings: [], ok: true, fetchedAt: '2026-09-16T10:00:00.000Z', failures: 0 };

type Harness = {
  world: World;
  frames: DepositState[];
  refreshes: number;
  stateBroadcasts: number;
  clock: { t: number };
  watch: ReturnType<typeof createDepositWatch>;
};

function build(options: { intents?: IntentsRead; account?: string | null } = {}): Harness {
  const world = fakeWorld();
  const h: Harness = { world, frames: [], refreshes: 0, stateBroadcasts: 0, clock: { t: Date.parse('2026-09-16T10:00:00.000Z') }, watch: null as never };
  h.watch = createDepositWatch({
    ledger: ledgerWith('intents' in options ? options.intents : READ_OK),
    sse: {
      broadcast: (frame) => h.frames.push({ ...(frame as DepositState) }),
      broadcastState: () => {
        h.stateBroadcasts += 1;
      },
    },
    account: () => ('account' in options ? (options.account ?? null) : ACCOUNT),
    refresh: async () => {
      h.refreshes += 1;
    },
    fetchImpl: world.fetchImpl,
    now: () => h.clock.t,
    pollMs: 5,
  });
  return h;
}

async function until(h: Harness, phase: string, what = ''): Promise<DepositState> {
  const deadline = Date.now() + 3_000;
  while (h.watch.current()?.phase !== phase && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const state = h.watch.current();
  assert.equal(state?.phase, phase, `${what}: ${JSON.stringify(h.frames)} ${h.world.unexpected.join(',')}`);
  return state as DepositState;
}

async function ticks(n: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5 * n + 10));
}

test('PENDING then COMPLETED then a balance rise walks watching, seen, bridged and credited, each said once, with the facts', async () => {
  const h = build();
  const shown = h.watch.show('eth', 'usdc', '0x6f0bA7BBdeadbeef', TOKEN);
  assert.equal(shown.phase, 'watching');
  assert.equal(shown.symbol, 'USDC');
  assert.equal(shown.baseline, 0);
  assert.equal(shown.error, null);
  await ticks(3);
  assert.equal(h.watch.current()?.phase, 'watching', 'nothing seen, nothing credited');
  assert.ok(h.world.calls.includes('bridge:recent_deposits'), 'the bridge is asked while watching');
  assert.ok(h.world.calls.includes('verifier:mt_batch_balance_of'), 'and the verifier, for the one asset');
  assert.equal(h.refreshes, 0, 'no full refresh per tick');

  // The bridge has seen the transfer arrive on Ethereum, three blocks deep.
  h.clock.t += 12_000;
  h.world.rows = [{ txHash: '0xfeed', amount: '5000000', status: 'PENDING', asset: `eth:1:${USDC_CONTRACT}` }];
  h.world.receiptBlock = 98;
  const seen = await until(h, 'seen', 'the pending row');
  assert.equal(seen.txHash, '0xfeed');
  assert.equal(seen.explorerUrl, 'https://etherscan.io/tx/0xfeed');
  assert.equal(seen.confirmations, 3, 'head 100, mined in 98: three confirmations');
  assert.equal(seen.amount, 5, 'the row amount, scaled by the row decimals');
  assert.equal(seen.ms, 12_000);
  await ticks(3);
  assert.equal(h.frames.filter((f) => f.phase === 'seen').length, 1, 'the same facts are not said twice');
  assert.ok(h.world.calls.includes('bridge:recent_deposits'), 'the bridge is still asked while seen');

  // The bridge is done with it; the verifier has not caught up yet.
  h.clock.t += 30_000;
  h.world.rows = [{ txHash: '0xfeed', amount: '5000000', status: 'COMPLETED', asset: `eth:1:${USDC_CONTRACT}` }];
  const bridged = await until(h, 'bridged', 'the completed row');
  assert.equal(bridged.txHash, '0xfeed');
  assert.equal(bridged.amount, 5);
  assert.equal(h.refreshes, 0);

  // The verifier credits it.
  h.clock.t += 20_000;
  h.world.balance = '5000000';
  const credited = await until(h, 'credited', 'the balance rise');
  assert.equal(credited.amount, 5, 'what landed, over the baseline');
  assert.equal(credited.txHash, '0xfeed', 'the hash is kept through to the end');
  assert.equal(credited.ms, 62_000);
  await ticks(2);
  assert.equal(h.refreshes, 1, 'credited refreshes the ledger through the one seam, once');
  assert.ok(h.stateBroadcasts >= 1, 'and the window is told the state changed, not just the watch');

  assert.deepEqual(
    h.frames.map((f) => f.phase),
    ['watching', 'seen', 'bridged', 'credited'],
    'four phases, each announced once',
  );
  assert.deepEqual(h.world.unexpected, [], 'no other venue was called');
  h.watch.stop();
  assert.equal(h.watch.current()?.phase, 'credited', 'stop after credited changes nothing');
});

test('the watch keeps reading the balance for a minute after credited, then stops on its own and stays credited', async () => {
  const h = build();
  h.watch.show('eth', 'USDC', null, TOKEN);
  h.world.balance = '2000000';
  await until(h, 'credited');
  const before = h.world.calls.length;
  await ticks(3);
  assert.ok(h.world.calls.length > before, 'still reading in the first minute');
  assert.ok(!h.world.calls.slice(before).includes('bridge:recent_deposits'), 'but only the verifier: the bridge has nothing left to say');

  h.clock.t += 61_000;
  await ticks(3);
  const settled = h.world.calls.length;
  await ticks(4);
  assert.equal(h.world.calls.length, settled, 'a minute after credited the watch stops asking');
  assert.equal(h.watch.current()?.phase, 'credited', 'and the frame stays credited, never stopped');
});

test('a completed row that was there when the watch began is history, not the deposit being watched', async () => {
  const h = build();
  h.world.rows = [{ txHash: '0xold', amount: '9000000', status: 'COMPLETED', asset: `eth:1:${USDC_CONTRACT}` }];
  h.watch.show('eth', 'USDC', null, TOKEN);
  await ticks(4);
  assert.equal(h.watch.current()?.phase, 'watching', 'yesterday\'s deposit does not light up today\'s card');

  h.world.rows.push({ txHash: '0xnew', amount: '1000000', status: 'PENDING', asset: `eth:1:${USDC_CONTRACT}` });
  const seen = await until(h, 'seen');
  assert.equal(seen.txHash, '0xnew');
  assert.equal(seen.amount, 1);
});

test('a row for another asset on the same chain is not this deposit', async () => {
  const h = build();
  h.watch.show('eth', 'USDC', null, TOKEN);
  h.world.rows = [{ txHash: '0xother', amount: '1', status: 'PENDING', asset: 'eth:1:native' }];
  await ticks(4);
  assert.equal(h.watch.current()?.phase, 'watching');
  h.world.rows.push({ txHash: '0xmine', amount: '3000000', status: 'PENDING', asset: `eth:1:${USDC_CONTRACT.toLowerCase()}` });
  const seen = await until(h, 'seen');
  assert.equal(seen.txHash, '0xmine', 'the contract is matched whatever its case');
});

test('a verifier that is not answering is said on the line and cleared when it answers again', async () => {
  const h = build();
  h.world.balance = null;
  h.watch.show('eth', 'USDC', null, TOKEN);
  const deadline = Date.now() + 2_000;
  while (h.watch.current()?.error === null && Date.now() < deadline) await ticks(1);
  assert.match(h.watch.current()?.error ?? '', /verifier/);
  assert.equal(h.watch.current()?.phase, 'watching', 'a miss is not a phase');
  assert.equal(h.frames.filter((f) => f.error !== null).length, 1, 'said once, not per tick');

  h.world.balance = '0';
  const cleared = Date.now() + 2_000;
  while (h.watch.current()?.error !== null && Date.now() < cleared) await ticks(1);
  assert.equal(h.watch.current()?.error, null);
});

test('confirmations are only asked for on an EVM chain, and a chain without a reader gets none', async () => {
  const h = build();
  h.watch.show('sol', 'USDC', null, { assetId: 'nep141:sol-usdc.omft.near', decimals: 6, contract: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' });
  h.world.rows = [{ txHash: '', amount: '4000000', status: 'PENDING', asset: 'sol:mainnet:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }];
  const seen = await until(h, 'seen');
  assert.equal(seen.confirmations, null);
  assert.equal(seen.explorerUrl, null, 'no hash, no link');
  assert.equal(seen.amount, 4);
  assert.equal(h.world.calls.some((c) => c.startsWith('evm:')), false);
});

test('the baseline comes from the ledger when it has read the account, and from the first verifier read when it has not', async () => {
  // Read already: 2 USDC known, the watch credits only the rise.
  const known = build({
    intents: { ...READ_OK, holdings: [{ accountId: ACCOUNT, assetId: USDC_ETH, symbol: 'USDC', originChain: 'eth', amount: 2, amountBase: '2000000', decimals: 6 }] },
  });
  const shown = known.watch.show('eth', 'USDC', null, TOKEN);
  assert.equal(shown.baseline, 2);
  known.world.balance = '2000000';
  await ticks(4);
  assert.equal(known.watch.current()?.phase, 'watching', 'the balance it already had is not a deposit');
  known.world.balance = '2500000';
  const credited = await until(known, 'credited');
  assert.equal(credited.amount, 0.5);
  known.watch.stop();

  // Never read (a wallet the ledger has not seen yet): the first answer is the baseline, so
  // an imported wallet's history is not announced as money that just landed.
  const fresh = build({ intents: undefined });
  fresh.world.balance = '7000000';
  fresh.watch.show('eth', 'USDC', null, TOKEN);
  await ticks(4);
  assert.equal(fresh.watch.current()?.phase, 'watching');
  assert.equal(fresh.watch.current()?.baseline, 7);
  fresh.world.balance = '8000000';
  const rose = await until(fresh, 'credited');
  assert.equal(rose.amount, 1);
  fresh.watch.stop();
});

test('no wallet yet means nothing is asked, and the watch picks up when the wallet appears', async () => {
  let account = null as string | null;
  const world = fakeWorld();
  const frames: DepositState[] = [];
  const watch = createDepositWatch({
    ledger: ledgerWith(undefined),
    sse: { broadcast: (frame) => frames.push(frame as DepositState) },
    account: () => account,
    refresh: async () => undefined,
    fetchImpl: world.fetchImpl,
    pollMs: 5,
  });
  watch.show('eth', 'USDC', null, TOKEN);
  await ticks(4);
  assert.equal(world.calls.length, 0, 'no account to ask about');
  account = ACCOUNT;
  await ticks(4);
  assert.ok(world.calls.includes('verifier:mt_batch_balance_of'));
  watch.stop();
  assert.equal(watch.current()?.phase, 'stopped');
  assert.equal(frames[frames.length - 1]?.phase, 'stopped');
});

test('a card left open polls eagerly for ten minutes, then one tick in five, and gives up after two hours', async () => {
  const world = fakeWorld();
  let clock = 1_000_000;
  const frames: DepositState[] = [];
  const watch = createDepositWatch({
    ledger: ledgerWith(undefined),
    sse: { broadcast: (frame) => frames.push(frame as DepositState) },
    account: () => ACCOUNT,
    refresh: async () => undefined,
    fetchImpl: world.fetchImpl,
    pollMs: 5,
    now: () => clock,
  });
  watch.show('eth', 'USDC', null, TOKEN);
  await ticks(6);
  const eager = world.calls.length;
  assert.ok(eager >= 4, `eager polling asked the bridge: ${eager}`);

  clock += 11 * 60 * 1000;
  const before = world.calls.length;
  await ticks(10);
  const slow = world.calls.length - before;
  assert.ok(slow >= 2 && slow <= 6, `one poll in five after ten minutes: ${slow} calls over 10 ticks`);

  clock += 2 * 60 * 60 * 1000;
  await ticks(8);
  assert.equal(watch.current()?.phase, 'stopped');
  watch.stop();
});
