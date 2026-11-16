// The deposit watch reports what actually happened to the money, phase by phase.
//
// A person who has just sent a test amount from an exchange used to get a count-up clock and
// nothing else until the ledger's next full refresh happened to notice the balance. Now each
// 3 s tick asks 1Click about the card's one-time address (GET /v0/status, through deps.status)
// and the verifier what it has credited (one mt_batch_balance_of for the watched asset), and the
// frame carries the phase, the hash, the explorer link, the confirmations on an EVM chain, the
// amount, a note on a refund or a short deposit, and the last read failure. Past the address's
// deadline with nothing seen, the address comes off the card. Every venue is a fake here:
// nothing reaches a network, the POA bridge is never asked, and a full ledger refresh from inside
// a tick would be an unexpected call.

import test from 'node:test';
import assert from 'node:assert/strict';

import type { Ledger } from '../../src/ledger/index.ts';
import type { IntentsRead } from '../../src/ledger/intents.ts';
import type { LedgerSnapshot } from '../../src/types.ts';
import type { OneClickStatus } from '../../src/intents.ts';
import type { OneTimeDeposit } from '../../src/rails/deposit-quote.ts';
import { createDepositWatch, type DepositState, type DepositToken } from '../../src/vault/watch.ts';

const ACCOUNT = '0x9858effd232b4033e47d90003d41ec34ecaeda94';
const USDC_ETH = 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near';
const USDC_CONTRACT = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const TOKEN = { assetId: USDC_ETH, decimals: 6, contract: USDC_CONTRACT };
const ADDRESS = '0x6f0ba7bb00000000000000000000000000000001';
const HASH = `0x${'fe'.repeat(32)}`;
const START = Date.parse('2026-09-16T10:00:00.000Z');
const HOUR = 60 * 60 * 1000;

type World = {
  // What 1Click says about the address, or an Error for a status read that fails.
  said: OneClickStatus | Error;
  statusAsks: Array<[string, string | undefined]>;
  // The verifier's answer in base units, or null for a verifier that is not answering.
  balance: string | null;
  head: number;
  receiptBlock: number | null;
  calls: string[];
  unexpected: string[];
  fetchImpl: typeof fetch;
};

function says(status: OneClickStatus['status'], over: Partial<OneClickStatus> = {}): OneClickStatus {
  return { found: true, status, reported: status, originTxHashes: [], destinationTxHashes: [], nearTxHashes: [], ...over };
}

const NOT_FOUND: OneClickStatus = { found: false, status: 'UNKNOWN', reported: 'not found', originTxHashes: [], destinationTxHashes: [], nearTxHashes: [] };

function fakeWorld(): World {
  const world: World = { said: says('PENDING_DEPOSIT'), statusAsks: [], balance: '0', head: 100, receiptBlock: null, calls: [], unexpected: [], fetchImpl: fetch };
  const json = (payload: unknown, status = 200): Response =>
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
  const nearView = (value: unknown): Response =>
    json({ jsonrpc: '2.0', id: 1, result: { result: [...Buffer.from(JSON.stringify(value), 'utf8')] } });
  world.fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = (typeof init?.body === 'string' ? JSON.parse(init.body) : {}) as Record<string, unknown>;
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
    // The POA bridge included: it is closing, and nothing in the watch may ask it.
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

// The one-time quote record the card hands the watch (src/http/deposit-open.ts).
function oneTime(over: Partial<OneTimeDeposit> = {}): OneTimeDeposit {
  return {
    account: ACCOUNT,
    chain: 'eth',
    network: 'eth:1',
    symbol: 'USDC',
    assetId: USDC_ETH,
    decimals: 6,
    address: ADDRESS,
    memo: null,
    minimumBase: '1100000',
    minimum: '1.1',
    deadline: new Date(START + 24 * HOUR).toISOString(),
    coldAt: null,
    mintedAt: new Date(START).toISOString(),
    correlationId: 'c-1',
    signature: null,
    timestamp: null,
    ...over,
  };
}

type Harness = {
  world: World;
  frames: DepositState[];
  refreshes: number;
  stateBroadcasts: number;
  clock: { t: number };
  watch: ReturnType<typeof createDepositWatch>;
  // Shows the card on Ethereum USDC with a one-time address, the way both card doors do.
  open: (record?: OneTimeDeposit, chain?: string, token?: DepositToken) => DepositState;
};

type RouteRead = (account: string, chain: string, assetId: string) => Promise<{ closed: string | null; link: string | null }>;

function build(options: { intents?: IntentsRead; account?: string | null; route?: RouteRead; noStatus?: boolean } = {}): Harness {
  const world = fakeWorld();
  const h: Harness = { world, frames: [], refreshes: 0, stateBroadcasts: 0, clock: { t: START }, watch: null as never, open: null as never };
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
    ...(options.noStatus === true
      ? {}
      : {
          status: async (address: string, memo?: string) => {
            world.statusAsks.push([address, memo]);
            world.calls.push('status');
            if (world.said instanceof Error) throw world.said;
            return world.said;
          },
        }),
    now: () => h.clock.t,
    pollMs: 5,
    ...(options.route === undefined ? {} : { route: options.route }),
  });
  h.open = (record = oneTime(), chain = 'eth', token: DepositToken = TOKEN) => h.watch.show(chain, record.symbol.toLowerCase(), record.address, token, record);
  return h;
}

async function until(h: Harness, test: (s: DepositState) => boolean, what = ''): Promise<DepositState> {
  const deadline = Date.now() + 3_000;
  while (!(h.watch.current() !== null && test(h.watch.current()!)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const state = h.watch.current();
  assert.ok(state !== null && test(state), `${what}: ${JSON.stringify(h.frames)} ${h.world.unexpected.join(',')}`);
  return state;
}

const phase = (h: Harness, p: string, what = '') => until(h, (s) => s.phase === p, what || p);

async function ticks(n: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5 * n + 10));
}

test('PENDING_DEPOSIT, then KNOWN_DEPOSIT_TX, then SUCCESS, then a balance rise walks watching, seen, bridged and credited, each said once, with the facts', async () => {
  const h = build();
  const shown = h.open();
  assert.equal(shown.phase, 'watching');
  assert.equal(shown.symbol, 'USDC');
  assert.equal(shown.address, ADDRESS);
  assert.equal(shown.oneTime, true);
  assert.equal(shown.memo, null);
  assert.equal(shown.deadline, oneTime().deadline);
  assert.equal(shown.minimum, '1.1', 'the minimum the quote minted the address with');
  assert.equal(shown.note, null);
  assert.equal(shown.baseline, 0);
  assert.equal(shown.error, null);
  await ticks(3);
  assert.equal(h.watch.current()?.phase, 'watching', 'nothing seen, nothing credited');
  assert.deepEqual(h.world.statusAsks[0], [ADDRESS, undefined], '1Click is asked about the card\'s own address, with no memo on a chain without one');
  assert.ok(h.world.calls.includes('verifier:mt_batch_balance_of'), 'and the verifier, for the one asset');
  assert.equal(h.refreshes, 0, 'no full refresh per tick');

  // 1Click has seen the transfer arrive on Ethereum, three blocks deep.
  h.clock.t += 12_000;
  h.world.said = says('KNOWN_DEPOSIT_TX', { originTxHashes: [HASH], depositedAmount: '5' });
  h.world.receiptBlock = 98;
  const seen = await phase(h, 'seen');
  assert.equal(seen.txHash, HASH);
  assert.equal(seen.explorerUrl, `https://etherscan.io/tx/${HASH}`);
  assert.equal(seen.confirmations, 3, 'head 100, mined in 98: three confirmations');
  assert.equal(seen.amount, 5, '1Click\'s depositedAmount');
  assert.equal(seen.ms, 12_000);
  assert.equal(seen.note, null);
  await ticks(3);
  assert.equal(h.frames.filter((f) => f.phase === 'seen').length, 1, 'the same facts are not said twice');

  // 1Click is done with it; the verifier has not caught up yet.
  h.clock.t += 30_000;
  h.world.said = says('SUCCESS', { originTxHashes: [HASH], depositedAmount: '5' });
  const bridged = await phase(h, 'bridged');
  assert.equal(bridged.txHash, HASH);
  assert.equal(bridged.amount, 5);
  assert.equal(h.refreshes, 0);

  // The verifier credits it.
  h.clock.t += 20_000;
  h.world.balance = '5000000';
  const credited = await phase(h, 'credited');
  assert.equal(credited.amount, 5, 'what landed, over the baseline');
  assert.equal(credited.txHash, HASH, 'the hash is kept through to the end');
  assert.equal(credited.ms, 62_000);
  await ticks(2);
  assert.equal(h.refreshes, 1, 'credited refreshes the ledger through the one seam, once');
  assert.ok(h.stateBroadcasts >= 1, 'and the window is told the state changed, not just the watch');

  assert.deepEqual(
    h.frames.map((f) => f.phase),
    ['watching', 'seen', 'bridged', 'credited'],
    'four phases, each announced once',
  );
  assert.deepEqual(h.world.unexpected, [], 'no other venue was called, the bridge least of all');
  h.watch.stop();
  assert.equal(h.watch.current()?.phase, 'credited', 'stop after credited changes nothing');
});

test('every status word 1Click has maps to its phase, its note and its error', async () => {
  const table: Array<[string, OneClickStatus, string, RegExp | null, RegExp | null]> = [
    ['PENDING_DEPOSIT', says('PENDING_DEPOSIT'), 'watching', null, null],
    ['not found yet', NOT_FOUND, 'watching', null, null],
    ['a word the spec does not have', says('UNKNOWN', { reported: 'MYSTERY' }), 'watching', null, null],
    ['KNOWN_DEPOSIT_TX', says('KNOWN_DEPOSIT_TX'), 'seen', null, null],
    ['PROCESSING', says('PROCESSING'), 'seen', null, null],
    ['INCOMPLETE_DEPOSIT', says('INCOMPLETE_DEPOSIT'), 'seen', /^This deposit is under the minimum for this address, so NEAR Intents returns it to your balance instead\.$/, null],
    ['REFUNDED', says('REFUNDED'), 'seen', /^NEAR Intents did not convert this deposit and put it back in your balance instead\.$/, null],
    ['SUCCESS', says('SUCCESS'), 'bridged', null, null],
    ['FAILED', says('FAILED'), 'watching', null, /^NEAR Intents says this deposit failed \(FAILED\)\. It is checking your balance anyway\.$/],
  ];
  for (const [name, said, want, note, error] of table) {
    const h = build();
    h.world.said = said;
    h.open();
    if (want === 'watching') {
      await until(h, () => h.world.statusAsks.length >= 3, `${name}: asked`);
      await ticks(2);
    } else {
      await phase(h, want, name);
    }
    const s = h.watch.current()!;
    assert.equal(s.phase, want, name);
    if (note === null) assert.equal(s.note, null, `${name}: no note`);
    else assert.match(s.note ?? '', note, `${name}: note`);
    if (error === null) assert.equal(s.error, null, `${name}: no error`);
    else assert.match(s.error ?? '', error, `${name}: error`);
    // Up while nothing is seen; off once money is seen at it (one deposit per address).
    assert.equal(s.address, want === 'watching' ? ADDRESS : null, `${name}: the address`);
    h.watch.stop();
  }
});

test('a status read that fails is said on the line, is not a phase, and is cleared when 1Click answers again', async () => {
  const h = build();
  h.world.said = new Error('1click status http 503');
  h.open();
  const failing = await until(h, (s) => s.error !== null, 'the failure is said');
  assert.equal(failing.error, 'NEAR Intents is not answering about this address, retrying');
  assert.equal(failing.phase, 'watching');
  await ticks(3);
  assert.equal(h.frames.filter((f) => f.error !== null).length, 1, 'said once, not per tick');
  h.world.said = says('PENDING_DEPOSIT');
  await until(h, (s) => s.error === null, 'cleared');
  h.watch.stop();
});

test('a memo chain asks 1Click with the memo, half of where the money goes', async () => {
  const h = build();
  h.open(oneTime({ chain: 'xrp', network: 'xrp:mainnet', symbol: 'XRP', address: 'rEXAMPLEaddress0000000000000', memo: '4242' }), 'xrp', { assetId: 'nep141:xrp.omft.near', decimals: 6, contract: null });
  await until(h, () => h.world.statusAsks.length > 0);
  assert.deepEqual(h.world.statusAsks[0], ['rEXAMPLEaddress0000000000000', '4242']);
  assert.equal(h.watch.current()?.memo, '4242');
  h.watch.stop();
});

test('the hash 1Click names is held to the chain\'s shape before it is printed or linked', async () => {
  // Not a hash on Ethereum: seen, but no hash, no link, and no confirmations asked for.
  const bad = build();
  bad.world.said = says('KNOWN_DEPOSIT_TX', { originTxHashes: ['javascript:alert(1)'], depositedAmount: '2' });
  bad.open();
  const seen = await phase(bad, 'seen');
  assert.equal(seen.txHash, null);
  assert.equal(seen.explorerUrl, null);
  assert.equal(seen.confirmations, null);
  assert.equal(seen.amount, 2, 'the amount still reads');
  assert.equal(bad.world.calls.some((c) => c.startsWith('evm:')), false, 'no receipt is asked for a hash that is not one');
  bad.watch.stop();

  // Solana: base58, linked to the explorer, and no EVM confirmations.
  const sol = build();
  const solHash = '5'.repeat(88);
  sol.world.said = says('PROCESSING', { originTxHashes: [solHash] });
  sol.open(oneTime({ chain: 'sol', network: 'sol:mainnet' }), 'sol', { assetId: 'nep141:sol-usdc.omft.near', decimals: 6, contract: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' });
  const solSeen = await phase(sol, 'seen');
  assert.equal(solSeen.txHash, solHash);
  assert.equal(solSeen.explorerUrl, `https://solscan.io/tx/${solHash}`);
  assert.equal(solSeen.confirmations, null);
  assert.equal(sol.world.calls.some((c) => c.startsWith('evm:')), false);
  sol.watch.stop();

  // A chain this file has no shape for: plain letters and digits only, and never a link.
  const xrpToken = { assetId: 'nep141:xrp.omft.near', decimals: 6, contract: null };
  const plain = build();
  plain.world.said = says('PROCESSING', { originTxHashes: ['ABCDEF0123456789ABCDEF0123456789'] });
  plain.open(oneTime({ chain: 'xrp', network: 'xrp:mainnet', symbol: 'XRP' }), 'xrp', xrpToken);
  const plainSeen = await phase(plain, 'seen');
  assert.equal(plainSeen.txHash, 'ABCDEF0123456789ABCDEF0123456789');
  assert.equal(plainSeen.explorerUrl, null);
  plain.watch.stop();

  const spaced = build();
  spaced.world.said = says('PROCESSING', { originTxHashes: ['<b>not a hash</b>'] });
  spaced.open(oneTime({ chain: 'xrp', network: 'xrp:mainnet', symbol: 'XRP' }), 'xrp', xrpToken);
  assert.equal((await phase(spaced, 'seen')).txHash, null);
  spaced.watch.stop();
});

test('the amount is 1Click\'s depositedAmount when it reads as a positive number, and nothing otherwise', async () => {
  for (const [text, want] of [
    ['1.5', 1.5],
    ['0', null],
    ['abc', null],
    [undefined, null],
  ] as const) {
    const h = build();
    h.world.said = says('PROCESSING', text === undefined ? {} : { depositedAmount: text });
    h.open();
    assert.equal((await phase(h, 'seen')).amount, want, String(text));
    h.watch.stop();
  }
});

test('past the deadline with nothing seen the address is expired: address and memo come off, 1Click is not asked again, and a late credit still wins', async () => {
  const h = build();
  h.open(oneTime({ deadline: new Date(START + HOUR).toISOString(), memo: '77' }));
  await until(h, () => h.world.statusAsks.length > 0);
  assert.equal(h.watch.current()?.phase, 'watching');

  h.clock.t = START + HOUR;
  const expired = await phase(h, 'expired', 'at the deadline');
  assert.equal(expired.address, null, 'an address past its deadline is never drawn again');
  assert.equal(expired.memo, null);
  assert.equal(expired.ms, HOUR);
  const asked = h.world.statusAsks.length;
  await ticks(4);
  assert.equal(h.world.statusAsks.length, asked, 'nothing more to ask 1Click about');
  assert.equal(h.frames.filter((f) => f.phase === 'expired').length, 1, 'said once');

  // Money that was on its way and lands anyway is still the person's: credited wins.
  h.world.balance = '3000000';
  const credited = await phase(h, 'credited', 'a late deposit');
  assert.equal(credited.amount, 3);
  assert.equal(credited.address, null, 'and the address stays off');
  h.watch.stop();
});

test('a deposit already seen when the deadline passes is not expired: the money is on its way', async () => {
  const h = build();
  h.open(oneTime({ deadline: new Date(START + HOUR).toISOString() }));
  h.world.said = says('KNOWN_DEPOSIT_TX', { originTxHashes: [HASH] });
  await phase(h, 'seen');
  h.clock.t = START + 2 * HOUR - 1;
  await ticks(4);
  assert.equal(h.watch.current()?.phase, 'seen');
  // Off since the deposit was seen, not since the deadline (the test below).
  assert.equal(h.watch.current()?.address, null);
  h.watch.stop();
});

/* ONE DEPOSIT PER ADDRESS. A one-time address takes one deposit, so once money is seen at it, by
   1Click's word or by the balance, it comes off the frame and is never drawn again: a second send
   to it may be lost. Before, only the deadline took it down, and the card kept showing an address
   that had already been used. The watch goes on asking 1Click about it, by its record. */
test('once money is seen at the address, by 1Click or by the balance, address and memo come off the frame and stay off', async () => {
  const seen = build();
  seen.open(oneTime({ memo: '77' }));
  await until(seen, () => seen.world.statusAsks.length > 0);
  assert.equal(seen.watch.current()?.address, ADDRESS, 'drawn while nothing is seen');
  seen.world.said = says('KNOWN_DEPOSIT_TX', { originTxHashes: [HASH] });
  const arriving = await phase(seen, 'seen');
  assert.equal(arriving.address, null, 'the address that has its deposit is not drawn');
  assert.equal(arriving.memo, null);
  assert.equal(arriving.txHash, HASH, 'the rest of the frame is as before');
  const asked = seen.world.statusAsks.length;
  seen.world.said = says('SUCCESS');
  const bridged = await phase(seen, 'bridged');
  assert.ok(seen.world.statusAsks.length > asked, '1Click is still asked, by the record');
  assert.deepEqual(seen.world.statusAsks.at(-1), [ADDRESS, '77']);
  assert.equal(bridged.address, null);
  assert.ok(seen.frames.filter((f) => f.phase !== 'watching').every((f) => f.address === null && f.memo === null), 'no frame after watching carries it');
  seen.watch.stop();

  const credited = build();
  credited.open();
  await until(credited, () => credited.world.statusAsks.length > 0);
  credited.world.balance = '3000000';
  const landed = await phase(credited, 'credited', 'a rise with 1Click saying nothing');
  assert.equal(landed.address, null);
  credited.watch.stop();
});

test('credited is the verifier\'s word and wins over anything 1Click says, then 1Click is not asked again', async () => {
  const h = build();
  h.world.said = says('KNOWN_DEPOSIT_TX', { originTxHashes: [HASH] });
  h.open();
  await phase(h, 'seen');
  h.world.balance = '4000000';
  await phase(h, 'credited');
  const asked = h.world.statusAsks.length;
  h.world.said = says('FAILED');
  await ticks(4);
  const s = h.watch.current()!;
  assert.equal(s.phase, 'credited');
  assert.equal(s.error, null, 'a late FAILED after the balance rose is not said');
  assert.equal(h.world.statusAsks.length, asked);
  h.watch.stop();
});

test('a card with no one-time record, or a watch with no line to 1Click, never asks about an address', async () => {
  const bare = build();
  bare.watch.show('eth', 'USDC', null, TOKEN);
  await ticks(4);
  assert.equal(bare.world.statusAsks.length, 0);
  assert.equal(bare.watch.current()?.oneTime, false);
  assert.equal(bare.watch.held(), null);
  bare.watch.stop();

  const offline = build({ noStatus: true });
  offline.open();
  await ticks(4);
  assert.equal(offline.watch.current()?.phase, 'watching');
  assert.equal(offline.watch.current()?.error, null);
  assert.equal(offline.watch.held()?.address, ADDRESS, 'held() hands back the whole record for the reuse check');
  offline.world.balance = '1000000';
  await phase(offline, 'credited', 'the balance alone still moves the card');
  offline.watch.stop();
});

test('the watch keeps reading the balance for a minute after credited, then stops on its own and stays credited', async () => {
  const h = build();
  h.open();
  h.world.balance = '2000000';
  await phase(h, 'credited');
  const before = h.world.calls.length;
  await ticks(3);
  assert.ok(h.world.calls.length > before, 'still reading in the first minute');
  assert.ok(!h.world.calls.slice(before).includes('status'), 'but only the verifier: 1Click has nothing left to say');

  h.clock.t += 61_000;
  await ticks(3);
  const settled = h.world.calls.length;
  await ticks(4);
  assert.equal(h.world.calls.length, settled, 'a minute after credited the watch stops asking');
  assert.equal(h.watch.current()?.phase, 'credited', 'and the frame stays credited, never stopped');
});

test('a verifier that is not answering is said on the line and cleared when it answers again', async () => {
  const h = build();
  h.world.balance = null;
  h.open();
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

test('the baseline comes from the ledger when it has read the account, and from the first verifier read when it has not', async () => {
  // Read already: 2 USDC known, the watch credits only the rise.
  const known = build({
    intents: { ...READ_OK, holdings: [{ accountId: ACCOUNT, assetId: USDC_ETH, symbol: 'USDC', originChain: 'eth', amount: 2, amountBase: '2000000', decimals: 6 }] },
  });
  const shown = known.open();
  assert.equal(shown.baseline, 2);
  known.world.balance = '2000000';
  await ticks(4);
  assert.equal(known.watch.current()?.phase, 'watching', 'the balance it already had is not a deposit');
  known.world.balance = '2500000';
  const credited = await phase(known, 'credited');
  assert.equal(credited.amount, 0.5);
  known.watch.stop();

  // Never read (a wallet the ledger has not seen yet): the first answer is the baseline, so
  // an imported wallet's history is not announced as money that just landed.
  const fresh = build({ intents: undefined });
  fresh.world.balance = '7000000';
  fresh.open();
  await ticks(4);
  assert.equal(fresh.watch.current()?.phase, 'watching');
  assert.equal(fresh.watch.current()?.baseline, 7);
  fresh.world.balance = '8000000';
  const rose = await phase(fresh, 'credited');
  assert.equal(rose.amount, 1);
  fresh.watch.stop();
});

test('once the vault has moved, the baseline is the vault row, never the allowance row the same read carries (PHASE2-PLAN.md C6)', async () => {
  const allowance = '0xf6beee2877dc58331cfa06c66cc47b5f2535a379';
  const row = (accountId: string, amountBase: string) => ({ accountId, assetId: USDC_ETH, symbol: 'USDC', originChain: 'eth', amount: Number(amountBase) / 1e6, amountBase, decimals: 6 });
  // The vault holds no USDC yet and the allowance 5: a watch matching by asset alone would start
  // from 5, and a 3 USDC deposit landing in the vault would never read as credited.
  const h = build({ intents: { ...READ_OK, holdings: [row(allowance, '5000000')] } });
  assert.equal(h.open().baseline, 0);
  h.world.balance = '3000000';
  const credited = await phase(h, 'credited');
  assert.equal(credited.amount, 3);
  h.watch.stop();
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
    status: async (address) => {
      world.calls.push(`status:${address}`);
      return says('PENDING_DEPOSIT');
    },
    pollMs: 5,
  });
  // Real time here: a deadline a day after now, not after the harness clock.
  watch.show('eth', 'USDC', ADDRESS, TOKEN, oneTime({ deadline: new Date(Date.now() + 24 * HOUR).toISOString() }));
  await ticks(4);
  assert.equal(world.calls.length, 0, 'no account to ask about');
  account = ACCOUNT;
  await ticks(4);
  assert.ok(world.calls.includes('verifier:mt_batch_balance_of'));
  assert.ok(world.calls.includes(`status:${ADDRESS}`));
  watch.stop();
  assert.equal(watch.current()?.phase, 'stopped');
  assert.equal(frames[frames.length - 1]?.phase, 'stopped');
});

test('a card left open polls eagerly for ten minutes, then one tick in five, and gives up after two hours', async () => {
  const h = build({ intents: undefined });
  h.open(oneTime({ deadline: new Date(START + 24 * HOUR).toISOString() }));
  await ticks(6);
  const eager = h.world.statusAsks.length;
  assert.ok(eager >= 4, `eager polling asked 1Click: ${eager}`);

  h.clock.t += 11 * 60 * 1000;
  const before = h.world.statusAsks.length;
  await ticks(10);
  const slow = h.world.statusAsks.length - before;
  assert.ok(slow >= 1 && slow <= 3, `one poll in five after ten minutes: ${slow} asks over 10 ticks`);

  h.clock.t += 2 * 60 * 60 * 1000;
  await ticks(8);
  assert.equal(h.watch.current()?.phase, 'stopped');
  h.watch.stop();
});

test('a route that closes while the card is up is said on the watch\'s own tick: the frame carries the sentence and the status page, and no timer of its own asks', async () => {
  let closed = false;
  const asked: Array<[string, string, string]> = [];
  const h = build({
    route: async (account, chain, assetId) => {
      asked.push([account, chain, assetId]);
      return closed ? { closed: 'NEAR Intents has paused Ethereum deposits right now, so no address is shown. Money sent now may not arrive.', link: 'https://status.near-intents.org/posts/dashboard' } : { closed: null, link: null };
    },
  });
  const shown = h.open();
  assert.equal(shown.paused, null);
  await ticks(3);
  assert.equal(h.watch.current()?.paused, null);
  const polls = h.world.statusAsks.length;
  // Asked once per poll, beside 1Click and the verifier: the same loop, not a second one.
  assert.ok(asked.length > 0 && asked.length <= polls + 1, `${asked.length} route asks for ${polls} polls`);
  assert.deepEqual(asked[0], [ACCOUNT, 'eth', TOKEN.assetId], 'the exact asset the card is for');

  closed = true;
  const now = await until(h, (s) => s.paused !== null, 'the pause reaches the frame');
  assert.match(String(now.paused), /^NEAR Intents has paused Ethereum deposits/);
  assert.equal(now.statusLink, 'https://status.near-intents.org/posts/dashboard');
  assert.equal(now.phase, 'watching', 'the watch keeps listening: money already sent still gets its word');
  assert.equal(h.frames.filter((f) => f.paused !== null).length, 1, 'said once');
  h.watch.stop();
});
