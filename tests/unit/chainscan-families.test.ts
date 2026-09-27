// The readers for every network past the first six, and the chain head, over an injected
// fetch. The fixtures are the shapes each source answered with on 2026-09-26 (the live run in
// scripts/chain-reader-live.ts), trimmed to the fields read. What is asserted is what reaches
// the agent: amounts as exact decimal strings, a status that means what the chain said, a gap
// named rather than filled with a zero, one request where the source allows one, and the
// bucket and cache bounds on the new hosts.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatUnits, getAddress } from 'viem';

import { addressActivity, addressSummary, chainFetch, chainHead, createChainFetchState, transaction, transactions } from '../../src/chainscan/index.ts';
import type { ChainDeps } from '../../src/chainscan/index.ts';
import { headTtl } from '../../src/chainscan/families.ts';
import { recipientSentence } from '../../src/rails/intents-pay.ts';
import { POA_DEPOSIT } from '../fixtures/poa-deposit-addresses.ts';

type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

// Routed by host and path, or by host alone; anything else is the 404 a missing route earns.
function fakeFetch(routes: Record<string, Handler>, seen: string[]): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    seen.push(url);
    const u = new URL(url);
    const handler = routes[u.host + u.pathname] ?? routes[u.host];
    return handler === undefined ? new Response('{"message":"Not found"}', { status: 404 }) : await handler(url, init);
  }) as unknown as typeof fetch;
}

const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const text = (body: string, status = 200): Response => new Response(body, { status, headers: { 'content-type': 'application/json' } });
const bodyOf = (init: RequestInit | undefined): any => JSON.parse(String(init?.body ?? 'null'));

// A JSON-RPC host that answers by method, single or batched. A value wrapped as { error } is
// answered as a JSON-RPC error.
function rpcHost(answers: Record<string, unknown>): Handler {
  return (_url, init) => {
    const one = (call: { id: number; method: string }) => {
      const a = answers[call.method] as { error?: string } | undefined;
      if (a === undefined) return { jsonrpc: '2.0', id: call.id, error: { code: -32601, message: 'Method not found' } };
      if (a !== null && typeof a === 'object' && 'error' in a) return { jsonrpc: '2.0', id: call.id, error: { code: -32602, message: a.error } };
      return { jsonrpc: '2.0', id: call.id, result: a };
    };
    const b = bodyOf(init);
    return json(Array.isArray(b) ? b.map(one) : one(b));
  };
}

const NOW = Date.parse('2026-09-27T04:12:40.000Z');

function deps(routes: Record<string, Handler>, seen: string[] = [], extra: Partial<ChainDeps> = {}): ChainDeps & { advance: (ms: number) => void; waits: number[] } {
  let now = NOW;
  const waits: number[] = [];
  return {
    fetchImpl: fakeFetch(routes, seen),
    state: createChainFetchState(),
    now: () => now,
    sleep: async (ms: number) => {
      waits.push(ms);
      now += ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
    waits,
    ...extra,
  };
}

const EVM = '0x9e3ed65340a913b96ba7b86d5d5876dde623946e';
const EVM_TX = '0x46e0a62630b76fbb65b819669b28a95c77b1b4f16bb52a07f3faffae904b1895';

// ---------- EVM over its own RPC ----------

test('an EVM chain past the first three is read in one batched RPC call: balance, nonce and code', async () => {
  const seen: string[] = [];
  const d = deps({ 'mainnet.optimism.io': rpcHost({ eth_getBalance: '0xba2e0a8a3f5d8a7', eth_getTransactionCount: '0x1365c14', eth_getCode: '0x' }) }, seen);
  const summary = await addressSummary('optimism', EVM, d);
  assert.equal(summary.ok, true);
  assert.equal(summary.source, 'rpc');
  assert.deepEqual(summary.balance, { amount: formatUnits(0xba2e0a8a3f5d8a7n, 18), symbol: 'ETH' });
  assert.equal(summary.txCount, 0x1365c14);
  assert.equal(summary.isContract, false);
  assert.equal(summary.explorer, `https://optimistic.etherscan.io/address/${getAddress(EVM)}`);
  // No indexer, so no token view and no second request pretending to be one.
  assert.equal(summary.tokensSource, null);
  assert.deepEqual(summary.tokens, []);
  assert.equal(seen.length, 1);
  // Code is a contract; an EIP-7702 delegation is an account that signs.
  for (const [code, isContract] of [['0x6080604052', true], ['0xef0100aabbccddeeff00112233445566778899aabbcc', false]] as const) {
    const a = await addressActivity('bnb', EVM, deps({ 'bsc-dataseed.bnbchain.org': rpcHost({ eth_getBalance: '0x0', eth_getTransactionCount: '0x0', eth_getCode: code }) }));
    assert.equal(a.isContract, isContract, code);
  }
});

test('an EVM transaction over RPC reads its receipt, adds a rollup\'s L1 fee, and never calls a refused receipt pending', async () => {
  const tx = { hash: EVM_TX, from: EVM, to: '0x4200000000000000000000000000000000000006', value: '0xde0b6b3a7640000', blockNumber: '0x9626206' };
  const receipt = { status: '0x1', blockNumber: '0x9626206', gasUsed: '0x5208', effectiveGasPrice: '0x3b9aca00', l1Fee: '0x10' };
  const ok = await transaction('optimism', EVM_TX, deps({ 'mainnet.optimism.io': rpcHost({ eth_getTransactionByHash: tx, eth_getTransactionReceipt: receipt, eth_blockNumber: '0x962623e' }) }));
  assert.equal(ok.ok, true);
  assert.equal(ok.tx?.status, 'success');
  assert.equal(ok.tx?.value, '1');
  assert.equal(ok.tx?.fee, formatUnits(0x5208n * 0x3b9aca00n + 0x10n, 18));
  assert.equal(ok.tx?.block, 0x9626206);
  assert.equal(ok.tx?.confirmations, 0x962623e - 0x9626206 + 1);
  assert.equal(ok.explorer, `https://optimistic.etherscan.io/tx/${EVM_TX}`);
  const reverted = await transaction('optimism', EVM_TX, deps({ 'mainnet.optimism.io': rpcHost({ eth_getTransactionByHash: tx, eth_getTransactionReceipt: { ...receipt, status: '0x0' }, eth_blockNumber: '0x962623e' }) }));
  assert.equal(reverted.tx?.status, 'failed');
  const waiting = await transaction('optimism', EVM_TX, deps({ 'mainnet.optimism.io': rpcHost({ eth_getTransactionByHash: { ...tx, blockNumber: null }, eth_getTransactionReceipt: null, eth_blockNumber: '0x962623e' }) }));
  assert.equal(waiting.tx?.status, 'pending');
  // publicnode's answer for a receipt a few minutes old, verbatim: a question not answered.
  const refused = await transaction('bnb', EVM_TX, deps({ 'bsc-dataseed.bnbchain.org': rpcHost({ eth_getTransactionByHash: tx, eth_getTransactionReceipt: { error: 'Archive requests require a personal token.' }, eth_blockNumber: '0x962623e' }) }));
  assert.equal(refused.ok, true);
  assert.equal(refused.tx?.status, 'unknown');
  assert.match(refused.error ?? '', /^receipt: Archive requests/);
  const none = await transaction('optimism', EVM_TX, deps({ 'mainnet.optimism.io': rpcHost({ eth_getTransactionByHash: null, eth_getTransactionReceipt: null, eth_blockNumber: '0x1' }) }));
  assert.equal(none.ok, false);
  assert.match(none.error ?? '', /no such transaction/);
});

// ---------- the chain head ----------

test('the chain head is the latest block and its age, cached fifteen seconds and not a minute', async () => {
  const seen: string[] = [];
  const block = { number: '0x18dc0c5', timestamp: `0x${(NOW / 1000 - 13).toString(16)}` };
  const d = deps({ 'ethereum-rpc.publicnode.com': rpcHost({ eth_getBlockByNumber: block }) }, seen);
  assert.deepEqual(await chainHead('ethereum', d), { height: 0x18dc0c5, time: new Date(NOW - 13_000).toISOString(), ageSec: 13 });
  // The Blockscout networks take their head from the RPC beside the indexer.
  assert.equal(new URL(seen[0]).host, 'ethereum-rpc.publicnode.com');
  d.advance(10_000);
  assert.equal((await chainHead('ethereum', d))?.ageSec, 23, 'the cached block grows older');
  assert.equal(seen.length, 1, 'inside fifteen seconds the head is not asked again');
  d.advance(5_001);
  await chainHead('ethereum', d);
  assert.equal(seen.length, 2, 'past fifteen seconds it is');
});

test('two asks for one chain head at the same moment share one request', async () => {
  const seen: string[] = [];
  const answer = rpcHost({ eth_getBlockByNumber: { number: '0x18dc0c5', timestamp: `0x${(NOW / 1000 - 13).toString(16)}` } });
  // The answer arrives a turn later, so the second ask comes while the first is on the wire.
  const d = deps({ 'ethereum-rpc.publicnode.com': async (url, init) => (await new Promise((resolve) => setImmediate(resolve)), answer(url, init)) }, seen);
  const [a, b] = await Promise.all([chainHead('ethereum', d), chainHead('ethereum', d)]);
  assert.equal(seen.length, 1, 'one request for both');
  assert.deepEqual(a, { height: 0x18dc0c5, time: new Date(NOW - 13_000).toISOString(), ageSec: 13 });
  assert.deepEqual(b, a);
});

// BlockCypher's Dogecoin chain answer, the tip moving on every ask, and the tip's own answer.
function dogeHost(): Record<string, Handler> {
  let n = 0;
  return {
    'api.blockcypher.com/v1/doge/main': () => (n++, json({ height: 6391209 + n, hash: n.toString(16).padStart(64, '0') })),
    'api.blockcypher.com': () => json({ time: new Date(NOW - 60_000).toISOString(), balance: 0 }),
  };
}

test('Dogecoin\'s head is kept six minutes, so head reads spend at most a fifth of BlockCypher\'s 100 an hour', async () => {
  const seen: string[] = [];
  // Two requests a head against 100 an hour: at most 10 heads, one per six minutes. Blockchain.com's
  // one call per 10 s gives Bitcoin Cash 50 s; every other host clears the fifteen-second floor.
  assert.deepEqual([headTtl('dogecoin'), headTtl('bitcoincash'), headTtl('ethereum'), headTtl('solana')], [360_000, 50_000, 15_000, 15_000]);
  const d = deps(dogeHost(), seen);
  assert.equal((await chainHead('dogecoin', d))?.height, 6391210);
  assert.equal(seen.length, 2, 'the chain answer, then the tip for its time');
  d.advance(5 * 60_000);
  assert.equal((await chainHead('dogecoin', d))?.height, 6391210, 'five minutes on, the kept head');
  assert.equal(seen.length, 2, 'inside six minutes no request at all');
  // The route gate rebuilds about once a minute while the screen is open: an hour of that.
  seen.length = 0;
  for (let minute = 0; minute < 60; minute++) {
    d.advance(60_000);
    assert.notEqual(await chainHead('dogecoin', d), null, `minute ${minute}`);
  }
  assert.ok(seen.length <= 20, `${seen.length} BlockCypher requests in an hour of heads`);
  assert.deepEqual(d.waits, [], 'and never a wait on the bucket');
});

test('a chain head never waits on the bucket: with no request free it answers at once with the kept head or null, and an address read still waits its turn', async () => {
  const seen: string[] = [];
  // The bucket runs on the injected clock and the request's own deadline on the real one, so
  // the call's deadline is ahead of both.
  const d = deps(dogeHost(), seen, { deadline: Math.max(NOW, Date.now()) + 120_000 });
  const drain = async (from: number) => {
    for (const n of [from, from + 1, from + 2]) await chainFetch(`https://api.blockcypher.com/v1/doge/main/addrs/${n}/balance`, {}, d);
  };
  await drain(1);
  assert.equal(seen.length, 3);
  assert.equal(await chainHead('dogecoin', d), null, 'nothing kept and nothing free: null');
  assert.deepEqual([seen.length, d.waits], [3, []], 'no request and no wait');
  // The agent's own address read still waits for the next slot, 36 s at 100 an hour.
  await chainFetch('https://api.blockcypher.com/v1/doge/main/addrs/4/balance', {}, d);
  assert.deepEqual([seen.length, d.waits], [4, [36_000]]);
  // A head read once the bucket refills, then the bucket drained again past its six minutes.
  d.advance(3 * 36_000);
  const read = await chainHead('dogecoin', d);
  assert.equal(read?.height, 6391210);
  assert.equal(seen.length, 6);
  d.advance(6 * 60_000 + 1);
  await drain(5);
  const kept = await chainHead('dogecoin', d);
  assert.equal(kept?.height, 6391210, 'no request free: the kept head, at once');
  assert.equal(kept?.ageSec, (read?.ageSec ?? 0) + 6 * 60, 'its block older by the time that passed');
  assert.deepEqual([seen.length, d.waits], [9, [36_000]], 'no request for it and no wait');
  // Past twice the six minutes a kept head says more about this cache than about the chain.
  d.advance(6 * 60_000);
  await drain(8);
  assert.equal(await chainHead('dogecoin', d), null);
  assert.deepEqual([seen.length, d.waits], [12, [36_000]]);
});

test('every family reads its head from its own endpoint in the shape it answers', async () => {
  const at = (s: number) => Math.round(NOW / 1000 - s);
  const cases: Array<[Parameters<typeof chainHead>[0], Record<string, Handler>, number, number | null]> = [
    ['bitcoin', { 'mempool.space/api/blocks': () => json([{ height: 968781, timestamp: at(896) }, { height: 968780 }]) }, 968781, 896],
    ['litecoin', { 'litecoinspace.org/api/blocks': () => json([{ height: 3185067, timestamp: at(465) }]) }, 3185067, 465],
    ['bitcoincash', { 'api.blockchain.info/haskoin-store/bch/block/best': () => json({ height: 970415, time: at(1103), mainchain: true }) }, 970415, 1103],
    ['dash', { 'insight.dash.org/insight-api/blocks': () => json({ blocks: [{ height: 2545642, time: at(31) }] }) }, 2545642, 31],
    ['xrp', { 'xrplcluster.com': () => json({ result: { ledger: { ledger_index: '107263187', close_time: at(5) - 946_684_800 }, validated: true } }) }, 107263187, 5],
    ['ton', { 'toncenter.com/api/v3/masterchainInfo': () => json({ last: { workchain: -1, seqno: 95334250, gen_utime: String(at(1)) } }) }, 95334250, 1],
    ['tron', { 'api.trongrid.io/wallet/getblock': () => json({ blockID: '00', block_header: { raw_data: { number: 86603842, timestamp: (at(3)) * 1000 } } }) }, 86603842, 3],
    ['sui', { 'graphql.mainnet.sui.io/graphql': () => json({ data: { checkpoint: { sequenceNumber: 327384211, timestamp: new Date(NOW - 3000).toISOString() } } }) }, 327384211, 3],
    ['aptos', { 'api.mainnet.aptoslabs.com/v1': () => json({ chain_id: 1, block_height: '1073276011', ledger_timestamp: String((NOW - 400) * 1000) }) }, 1073276011, 0],
    ['cardano', { 'api.koios.rest/api/v1/tip': () => json([{ block_no: 13993496, block_time: at(1) }]) }, 13993496, 1],
    ['stellar', { 'horizon.stellar.org': () => json({ history_latest_ledger: 64639632, history_latest_ledger_closed_at: new Date(NOW - 8000).toISOString() }) }, 64639632, 8],
    ['starknet', { 'starknet-rpc.publicnode.com': rpcHost({ starknet_getBlockWithTxHashes: { block_number: 15508160, timestamp: at(6), transactions: [] } }) }, 15508160, 6],
    ['near', { 'free.rpc.fastnear.com': rpcHost({ block: { header: { height: 217438460, timestamp: String(BigInt(NOW - 2000) * 1_000_000n) } } }) }, 217438460, 2],
    ['hypercore', { 'rpc.hyperliquid.xyz/evm': rpcHost({ eth_getBlockByNumber: { number: '0x2cd1b4f', timestamp: `0x${at(1).toString(16)}` } }) }, 0x2cd1b4f, 1],
    ['aleo', { 'api.explorer.provable.com/v1/mainnet/latest/height': () => json(22307110) }, 22307110, null],
  ];
  for (const [network, routes, height, age] of cases) {
    const head = await chainHead(network, deps(routes));
    assert.equal(head?.height, height, `${network}: ${JSON.stringify(head)}`);
    assert.equal(head?.ageSec, age, network);
    if (age === null) assert.equal(head?.time, null, `${network} gives a height and no time`);
  }
  // Solana takes the finalized slot, then that slot's time.
  const sol = await chainHead('fogo', deps({ 'mainnet.fogo.io': rpcHost({ getSlot: 773210911, getBlockTime: at(3) }) }));
  assert.deepEqual(sol, { height: 773210911, time: new Date(at(3) * 1000).toISOString(), ageSec: 3 });
  // Dogecoin: the chain answer carries the tip's hash, the tip's own answer its time.
  const tip = 'a'.repeat(64);
  const doge = await chainHead('dogecoin', deps({ 'api.blockcypher.com/v1/doge/main': () => json({ height: 6391209, hash: tip }), [`api.blockcypher.com/v1/doge/main/blocks/${tip}`]: () => json({ height: 6391209, time: new Date(NOW - 173_000).toISOString() }) }));
  assert.deepEqual(doge, { height: 6391209, time: new Date(NOW - 173_000).toISOString(), ageSec: 173 });
});

test('the chain head never throws: a dead source, an answer with no height, and a network with no source are all null', async () => {
  const thrower = { fetchImpl: (async () => { throw new Error('connect ECONNREFUSED'); }) as unknown as typeof fetch, state: createChainFetchState() };
  assert.equal(await chainHead('tron', thrower), null);
  assert.equal(await chainHead('ton', deps({ 'toncenter.com/api/v3/masterchainInfo': () => json({ last: {} }) })), null);
  const seen: string[] = [];
  assert.equal(await chainHead('zcash', deps({}, seen)), null);
  assert.deepEqual(seen, []);
});

// ---------- UTXO chains ----------

test('Bitcoin Cash reads balance and count from the Haskoin store, and a dropped transaction reads failed', async () => {
  const bch = POA_DEPOSIT['bch:mainnet'];
  const seen: string[] = [];
  const a = await addressActivity('bitcoincash', bch, deps({ [`api.blockchain.info/haskoin-store/bch/address/${encodeURIComponent(bch)}/balance`]: () => json({ address: bch, confirmed: 8753499723, unconfirmed: -1000, utxo: 3, txs: 100378, received: 1 }) }, seen));
  assert.deepEqual([a.ok, a.balance?.amount, a.balance?.symbol, a.txCount, a.source], [true, '87.53498723', 'BCH', 100378, 'haskoin']);
  assert.equal(seen.length, 1);
  const hash = '13acf8ceaf9f5d8e32361a28392becbf3feeb2b593f6b35bd32ff36cf1933dca';
  const route = `api.blockchain.info/haskoin-store/bch/transaction/${hash}`;
  const row = { txid: hash, fee: 800, time: 1790481702, deleted: false, block: { height: 970413, position: 1 }, outputs: [{ value: 1000, address: null }, { value: 2500 }] };
  const mined = await transaction('bitcoincash', hash, deps({ [route]: () => json(row) }));
  assert.deepEqual([mined.tx?.status, mined.tx?.block, mined.tx?.fee, mined.tx?.value, mined.tx?.time], ['success', 970413, '0.000008', '0.000035', '2026-09-27T04:01:42.000Z']);
  assert.equal((await transaction('bitcoincash', hash, deps({ [route]: () => json({ ...row, block: { mempool: 1790481702 } }) }))).tx?.status, 'pending');
  assert.equal((await transaction('bitcoincash', hash, deps({ [route]: () => json({ ...row, deleted: true }) }))).tx?.status, 'failed');
});

test('Dogecoin keeps a whale\'s balance exact past 2^53 satoshis, and a double spend reads failed', async () => {
  const doge = 'DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L';
  // Raw text: 12345678901234567890 cannot survive JSON.stringify of a number.
  const a = await addressActivity('dogecoin', doge, deps({ [`api.blockcypher.com/v1/doge/main/addrs/${doge}/balance`]: () => text('{"address":"x","final_balance":12345678901234567890,"final_n_tx":1484}') }));
  assert.deepEqual([a.balance?.amount, a.txCount], ['123456789012.3456789', 1484]);
  const hash = 'f7f07e2b888cdb0cb0de8ebcaf39a3f8c5422160f9c1d98001033e0540592897';
  const route = `api.blockcypher.com/v1/doge/main/txs/${hash}`;
  const row = { hash, block_height: 6391190, confirmations: 20, confirmed: '2026-09-27T04:12:30Z', fees: 91200000, total: 280715678, double_spend: false };
  const mined = await transaction('dogecoin', hash, deps({ [route]: () => json(row) }));
  assert.deepEqual([mined.tx?.status, mined.tx?.block, mined.tx?.confirmations, mined.tx?.fee, mined.tx?.value], ['success', 6391190, 20, '0.912', '2.80715678']);
  assert.equal((await transaction('dogecoin', hash, deps({ [route]: () => json({ ...row, block_height: -1, confirmations: 0 }) }))).tx?.status, 'pending');
  assert.equal((await transaction('dogecoin', hash, deps({ [route]: () => json({ ...row, double_spend: true }) }))).tx?.status, 'failed');
});

test('Dash reads satoshi fields from Insight, and its whole-coin fee comes out exact', async () => {
  const dash = 'XcQi5LrrgGP1BUzSSymggXEyetAP1HH1Sf';
  const a = await addressActivity('dash', dash, deps({ [`insight.dash.org/insight-api/addr/${dash}`]: () => json({ addrStr: dash, balanceSat: 150000000, unconfirmedBalanceSat: -2270, txApperances: 2, unconfirmedTxApperances: 1 }) }));
  assert.deepEqual([a.balance?.amount, a.txCount], ['1.4999773', 3]);
  const hash = '6b84b20907756c4be508a73fb9abadebb98779beb6c8eac62c8d19132688aad7';
  const route = `insight.dash.org/insight-api/tx/${hash}`;
  const mined = await transaction('dash', hash, deps({ [route]: () => json({ txid: hash, blockheight: 2545636, confirmations: 3, time: 1790482465, fees: 0.0000227, valueOut: 1.5 }) }));
  assert.deepEqual([mined.tx?.status, mined.tx?.fee, mined.tx?.value, mined.tx?.block], ['success', '0.0000227', '1.5', 2545636]);
  assert.equal((await transaction('dash', hash, deps({ [route]: () => json({ txid: hash, blockheight: -1, confirmations: 0 }) }))).tx?.status, 'pending');
});

// ---------- account chains ----------

test('the XRP Ledger: a balance in drops, an account never funded reads as never used, and a tec result reads failed', async () => {
  const xrp = POA_DEPOSIT['xrp:mainnet'];
  const answer = (result: unknown): Handler => () => json({ result });
  const funded = await addressActivity('xrp', xrp, deps({ 'xrplcluster.com': answer({ account_data: { Account: xrp, Balance: '479897864', Sequence: 568913 }, status: 'success', validated: true }) }));
  assert.deepEqual([funded.ok, funded.balance?.amount, funded.balance?.symbol, funded.txCount], [true, '479.897864', 'XRP', null]);
  const never = await addressActivity('xrp', xrp, deps({ 'xrplcluster.com': answer({ account: xrp, error: 'actNotFound', status: 'error' }) }));
  assert.deepEqual([never.ok, never.balance?.amount, never.txCount], [true, '0', 0]);
  const broken = await addressActivity('xrp', xrp, deps({ 'xrplcluster.com': answer({ error: 'tooBusy', status: 'error' }) }));
  assert.deepEqual([broken.ok, broken.error], [false, 'xrpl tooBusy']);
  const hash = '007DB4DA82228D6FEDD94C72E736D6B49CDAA63B3B316A57A5CC82C17ACCC700';
  const row = { hash, Account: xrp, Destination: 'rEb8TK3gBgk5auZkwc6sHnwrGVJH8DuaLh', Amount: '1000000', Fee: '12', TransactionType: 'Payment', date: 843797512, ledger_index: 107262771, validated: true, meta: { TransactionResult: 'tesSUCCESS' } };
  const ok = await transaction('xrp', hash.toLowerCase(), deps({ 'xrplcluster.com': (_u, init) => (assert.equal(bodyOf(init).params[0].transaction, hash), json({ result: row })) }));
  assert.deepEqual([ok.tx?.status, ok.tx?.time, ok.tx?.value, ok.tx?.fee, ok.tx?.block, ok.tx?.method], ['success', '2026-09-27T04:11:52.000Z', '1', '0.000012', 107262771, 'Payment']);
  assert.equal((await transaction('xrp', hash, deps({ 'xrplcluster.com': answer({ ...row, meta: { TransactionResult: 'tecPATH_DRY' } }) }))).tx?.status, 'failed');
  assert.equal((await transaction('xrp', hash, deps({ 'xrplcluster.com': answer({ ...row, validated: false }) }))).tx?.status, 'pending');
  assert.equal((await transaction('xrp', hash, deps({ 'xrplcluster.com': answer({ ...row, Amount: { currency: 'USD', value: '5' } }) }))).tx?.value, null, 'an issued currency is not the chain\'s coin');
  assert.match((await transaction('xrp', hash, deps({ 'xrplcluster.com': answer({ error: 'txnNotFound', status: 'error' }) }))).error ?? '', /no such transaction/);
});

test('TON: the balance from toncenter, an address it has never seen reads as never used, and an aborted transaction reads failed', async () => {
  const ton = POA_DEPOSIT['ton:mainnet'];
  const a = await addressActivity('ton', ton, deps({ 'toncenter.com/api/v3/account': (url) => (assert.equal(new URL(url).searchParams.get('address'), ton), json({ balance: '5077999986', status: 'uninit' })) }));
  assert.deepEqual([a.ok, a.balance?.amount, a.balance?.symbol, a.txCount, a.isContract], [true, '5.077999986', 'GRAM', null, null]);
  const unseen = await addressActivity('ton', ton, deps({ 'toncenter.com/api/v3/account': () => json({ error: 'not found' }, 404) }));
  assert.deepEqual([unseen.ok, unseen.balance?.amount, unseen.txCount], [true, '0', 0]);
  const b64 = 'cieoCGqvUTuB6ra6D9OJRM+h6SnGOgBsZtmqC5K0me8=';
  const hex = '7227a8086aaf513b81eab6ba0fd38944cfa1e929c63a006c66d9aa0b92b499ef';
  const row = { hash: b64, now: 1790482314, mc_block_seqno: 95330262, total_fees: '2487', description: { aborted: false, compute_ph: { skipped: false, success: true, exit_code: 0 }, action: { success: true, valid: true } } };
  const route = (r: unknown): Handler => (url) => (assert.equal(new URL(url).searchParams.get('hash'), hex), json({ transactions: r === null ? [] : [r] }));
  const ok = await transaction('ton', b64, deps({ 'toncenter.com/api/v3/transactions': route(row) }));
  assert.deepEqual([ok.hash, ok.tx?.status, ok.tx?.block, ok.tx?.fee, ok.tx?.time], [hex, 'success', 95330262, '0.000002487', '2026-09-27T04:11:54.000Z']);
  assert.equal((await transaction('ton', hex, deps({ 'toncenter.com/api/v3/transactions': route({ ...row, description: { ...row.description, aborted: true } }) }))).tx?.status, 'failed');
  assert.equal((await transaction('ton', hex, deps({ 'toncenter.com/api/v3/transactions': route({ ...row, description: { aborted: false, compute_ph: { success: false } } }) }))).tx?.status, 'failed');
  assert.match((await transaction('ton', hex, deps({ 'toncenter.com/api/v3/transactions': route(null) }))).error ?? '', /no such transaction/);
});

test('Tron: one account call answers the balance and the TRC-20 balances it can scale, and a reverted contract call reads failed', async () => {
  const tron = 'TCw6YaWm3y6DvxY7M8hrCDnrJGeGMumzGJ';
  const seen: string[] = [];
  const account = { balance: 1432085059962, trc20: [{ TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t: '2500000' }, { TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf: '999' }], latest_opration_time: 1790482311000 };
  const summary = await addressSummary('tron', tron, deps({ [`api.trongrid.io/v1/accounts/${tron}`]: () => json({ data: [account], success: true }) }, seen));
  assert.deepEqual([summary.ok, summary.balance?.amount, summary.balance?.symbol, summary.lastSeen], [true, '1432085.059962', 'TRX', '2026-09-27T04:11:51.000Z']);
  // USDT's six decimals are known; a contract whose decimals are not is left out, not guessed.
  assert.deepEqual(summary.tokens, [{ symbol: 'USDT', name: 'Tether USD', amount: '2.5', contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', usd: null }]);
  assert.equal(summary.tokensSource, 'trongrid');
  assert.equal(seen.length, 1, 'the tokens came in the same answer');
  const fresh = await addressSummary('tron', POA_DEPOSIT['tron:mainnet'], deps({ 'api.trongrid.io': () => json({ data: [], success: true }) }));
  assert.deepEqual([fresh.ok, fresh.balance?.amount, fresh.txCount, fresh.tokens], [true, '0', 0, []]);
  const hash = '0d5f10a46f0d71fecba5fa19fc555388fd35f1ab9d059e2a793ac0a1c90dfb8c';
  const info = (row: unknown): Handler => (_u, init) => (assert.deepEqual(bodyOf(init), { value: hash }), json(row));
  const plain = await transaction('tron', hash, deps({ 'api.trongrid.io/wallet/gettransactioninfobyid': info({ id: hash, blockNumber: 86603800, blockTimeStamp: 1790482311000, receipt: { net_usage: 281 } }) }));
  assert.deepEqual([plain.tx?.status, plain.tx?.block, plain.tx?.fee, plain.tx?.time], ['success', 86603800, '0', '2026-09-27T04:11:51.000Z']);
  const reverted = await transaction('tron', hash, deps({ 'api.trongrid.io/wallet/gettransactioninfobyid': info({ id: hash, blockNumber: 1, fee: 345000, receipt: { result: 'REVERT' } }) }));
  assert.deepEqual([reverted.tx?.status, reverted.tx?.fee], ['failed', '0.345']);
  assert.equal((await transaction('tron', hash, deps({ 'api.trongrid.io/wallet/gettransactioninfobyid': info({ id: hash, blockNumber: 1, result: 'FAILED' }) }))).tx?.status, 'failed');
  assert.match((await transaction('tron', hash, deps({ 'api.trongrid.io/wallet/gettransactioninfobyid': info({}) }))).error ?? '', /no such transaction in any block/);
});

test('Sui through the foundation\'s GraphQL: the address goes as a variable, a GraphQL error is named, FAILURE reads failed', async () => {
  const sui = '0x34729f8dd6d4e9bf5243b327c6462552a2d092808c537b9bbae7ee1a0e080a39';
  const a = await addressActivity('sui', sui, deps({ 'graphql.mainnet.sui.io/graphql': (_u, init) => {
    const b = bodyOf(init);
    assert.deepEqual(b.variables, { a: sui });
    assert.ok(!b.query.includes(sui), 'the address is never spliced into the query');
    return json({ data: { address: { balance: { totalBalance: '9947537644736' } } } });
  } }));
  assert.deepEqual([a.ok, a.balance?.amount, a.balance?.symbol], [true, '9947.537644736', 'SUI']);
  const err = await addressActivity('sui', sui, deps({ 'graphql.mainnet.sui.io/graphql': () => json({ errors: [{ message: 'Request timed out' }] }) }));
  assert.deepEqual([err.ok, err.error], [false, 'graphql Request timed out']);
  const digest = '5rUBM925nTuZVqLN99g9TRoR8WYi3bWrimNcMkfgkKpi';
  const tx = await transaction('sui', digest, deps({ 'graphql.mainnet.sui.io/graphql': () => json({ data: { transaction: { sender: { address: sui }, effects: { status: 'FAILURE', timestamp: '2026-09-27T04:12:32.044Z', checkpoint: { sequenceNumber: 327377078 } } } } }) }));
  assert.deepEqual([tx.tx?.status, tx.tx?.from, tx.tx?.block, tx.tx?.time], ['failed', sui, 327377078, '2026-09-27T04:12:32.044Z']);
  assert.match((await transaction('sui', digest, deps({ 'graphql.mainnet.sui.io/graphql': () => json({ data: { transaction: null } }) }))).error ?? '', /no such transaction/);
});

test('Aptos and Movement: the account and its coin read in parallel, an unknown account has sent nothing, a pending transaction says so', async () => {
  const apt = '0xd503b95164384a5ebbccbb5c4bdc8b4a5893d9651e9953abda8e1c22fcc1181d';
  const seen: string[] = [];
  const a = await addressActivity('aptos', apt, deps({
    [`api.mainnet.aptoslabs.com/v1/accounts/${apt}`]: () => json({ sequence_number: '31017', authentication_key: apt }),
    [`api.mainnet.aptoslabs.com/v1/accounts/${apt}/balance/0x1::aptos_coin::AptosCoin`]: () => text('1087015225470'),
  }, seen));
  assert.deepEqual([a.ok, a.balance?.amount, a.balance?.symbol, a.txCount], [true, '10870.1522547', 'APT', 31017]);
  assert.equal(seen.length, 2);
  const mv = POA_DEPOSIT['movement:mainnet'];
  const unknown = await addressActivity('movement', mv, deps({
    [`mainnet.movementnetwork.xyz/v1/accounts/${mv}`]: () => json({ message: 'Account not found', error_code: 'account_not_found' }, 404),
    [`mainnet.movementnetwork.xyz/v1/accounts/${mv}/balance/0x1::aptos_coin::AptosCoin`]: () => text('0'),
  }));
  assert.deepEqual([unknown.ok, unknown.balance?.amount, unknown.balance?.symbol, unknown.txCount], [true, '0', 'MOVE', 0]);
  const hash = '0xf73224c5e8676111cc26cb38b0ae2d7be81a0c9ed4ca4e62767548ae13e02824';
  const route = `api.mainnet.aptoslabs.com/v1/transactions/by_hash/${hash}`;
  const failed = await transaction('aptos', hash, deps({ [route]: () => json({ type: 'user_transaction', hash, success: false, vm_status: 'Move abort', gas_used: '10', gas_unit_price: '100', timestamp: '1790482354228370', sender: apt }) }));
  assert.deepEqual([failed.tx?.status, failed.tx?.fee, failed.tx?.time, failed.tx?.from], ['failed', '0.00001', '2026-09-27T04:12:34.228Z', apt]);
  assert.equal((await transaction('aptos', hash, deps({ [route]: () => json({ type: 'pending_transaction', hash }) }))).tx?.status, 'pending');
  assert.match((await transaction('aptos', hash, deps({ [route]: () => json({ error_code: 'transaction_not_found' }, 404) }))).error ?? '', /no such transaction/);
});

test('Cardano through Koios asks only for the columns it reads, and an address the chain never saw reads as never used', async () => {
  const addr = 'addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x';
  const seen: string[] = [];
  const a = await addressActivity('cardano', addr, deps({ 'api.koios.rest/api/v1/address_info': (_u, init) => (assert.deepEqual(bodyOf(init), { _addresses: [addr] }), json([{ address: addr, balance: '1000000' }])) }, seen));
  assert.deepEqual([a.ok, a.balance?.amount, a.balance?.symbol], [true, '1', 'ADA']);
  assert.equal(new URL(seen[0]).searchParams.get('select'), 'address,balance', 'a busy address\'s UTXO set stays out of the body');
  const never = await addressActivity('cardano', POA_DEPOSIT['cardano:mainnet'], deps({ 'api.koios.rest/api/v1/address_info': () => json([]) }));
  assert.deepEqual([never.ok, never.balance?.amount, never.txCount], [true, '0', 0]);
  const hash = '50c13ecc7b73ce186f4a70a9bf691c3e745b28a63348b4bb82a0ab80086ee40f';
  const tx = await transaction('cardano', hash, deps({ 'api.koios.rest/api/v1/tx_info': () => json([{ tx_hash: hash, block_height: 13993423, tx_timestamp: 1790482351, fee: '196433', total_output: '5000000' }]) }));
  assert.deepEqual([tx.tx?.status, tx.tx?.block, tx.tx?.fee, tx.tx?.value], ['success', 13993423, '0.196433', '5']);
  assert.match((await transaction('cardano', hash, deps({ 'api.koios.rest/api/v1/tx_info': () => json([]) }))).error ?? '', /no such transaction in any block/);
});

test('Stellar: the native balance and the trustlines come in one Horizon answer, and an account never funded reads as never used', async () => {
  const g = POA_DEPOSIT['stellar:mainnet'];
  const seen: string[] = [];
  const summary = await addressSummary('stellar', g, deps({ [`horizon.stellar.org/accounts/${g}`]: () => json({ sequence: '248663909060353907', last_modified_time: '2026-09-27T04:10:21Z', balances: [
    { balance: '12.5000000', asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN' },
    { balance: '223963.5153079', asset_type: 'native' },
  ] }) }, seen));
  assert.deepEqual([summary.balance?.amount, summary.lastSeen, summary.tokensSource], ['223963.5153079', '2026-09-27T04:10:21.000Z', 'horizon']);
  assert.deepEqual(summary.tokens, [{ symbol: 'USDC', name: '', amount: '12.5', contract: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN', usd: null }]);
  assert.equal(seen.length, 1);
  const never = await addressActivity('stellar', g, deps({ 'horizon.stellar.org': () => json({ title: 'Resource Missing' }, 404) }));
  assert.deepEqual([never.ok, never.balance?.amount, never.txCount], [true, '0', 0]);
  const hash = '27d5a9d7f9874932e163ce3cf97e7317c62059ed4e7abfb8ed07e4c1fc6b112c';
  const tx = await transaction('stellar', hash, deps({ [`horizon.stellar.org/transactions/${hash}`]: () => json({ hash, successful: false, ledger: 64639307, created_at: '2026-09-27T04:11:56Z', fee_charged: '36203', source_account: g }) }));
  assert.deepEqual([tx.tx?.status, tx.tx?.block, tx.tx?.fee, tx.tx?.from], ['failed', 64639307, '0.0036203', g]);
});

test('Starknet: nonce and STRK balance in one batch, the high half of the u256 counted, an undeployed account has sent nothing', async () => {
  const addr = '0x04678eb497e96599c92b45f342c2bd284321fe219c60a9b6293d80f0fbfa61b5';
  const a = await addressActivity('starknet', addr, deps({ 'starknet-rpc.publicnode.com': (url, init) => {
    const calls = bodyOf(init);
    // The RPC takes a felt without its leading zeros.
    assert.equal(calls[0].params[1], '0x4678eb497e96599c92b45f342c2bd284321fe219c60a9b6293d80f0fbfa61b5');
    return rpcHost({ starknet_getNonce: '0xa8e100', starknet_call: ['0x183d69156eea2f99e3da', '0x1'] })(url, init);
  } }));
  assert.deepEqual([a.ok, a.txCount, a.balance?.symbol], [true, 0xa8e100, 'STRK']);
  assert.equal(a.balance?.amount, formatUnits(0x183d69156eea2f99e3dan + (1n << 128n), 18));
  const undeployed = await addressActivity('starknet', POA_DEPOSIT['starknet:mainnet'], deps({ 'starknet-rpc.publicnode.com': rpcHost({ starknet_getNonce: { error: 'Contract not found' }, starknet_call: ['0x0', '0x0'] }) }));
  assert.deepEqual([undeployed.ok, undeployed.txCount, undeployed.balance?.amount], [true, 0, '0']);
  const hash = '0x492e0d1794ac2f17437c82fabf003674f5e2ed8ab8248d0fee74f78ab4d6d15';
  const reverted = await transaction('starknet', hash, deps({ 'starknet-rpc.publicnode.com': rpcHost({ starknet_getTransactionReceipt: { execution_status: 'REVERTED', finality_status: 'ACCEPTED_ON_L2', block_number: 15507241, actual_fee: { amount: '0x2a8087f3ed85b39', unit: 'FRI' } } }) }));
  assert.deepEqual([reverted.tx?.status, reverted.tx?.block, reverted.tx?.fee], ['failed', 15507241, formatUnits(0x2a8087f3ed85b39n, 18)]);
  const inEth = await transaction('starknet', hash, deps({ 'starknet-rpc.publicnode.com': rpcHost({ starknet_getTransactionReceipt: { execution_status: 'SUCCEEDED', block_number: 1, actual_fee: { amount: '0x1', unit: 'WEI' } } }) }));
  assert.deepEqual([inEth.tx?.status, inEth.tx?.fee], ['success', null], 'a fee paid in ETH is not called STRK');
});

test('Aleo: the public balance from the credits mapping, none is zero, anything else is not a balance; a rejected transaction reads failed', async () => {
  const aleo = 'aleo1anfvarnm27e2s5j6mzx3kzakx5eryc69re96x6grzkm9nkapkgpq4vyy5t';
  const route = `api.explorer.provable.com/v1/mainnet/program/credits.aleo/mapping/account/${aleo}`;
  assert.equal((await addressActivity('aleo', aleo, deps({ [route]: () => json('51787173u64') }))).balance?.amount, '51.787173');
  const none = await addressActivity('aleo', aleo, deps({ [route]: () => json(null) }));
  assert.deepEqual([none.ok, none.balance?.amount, none.txCount], [true, '0', null], 'no public credit says nothing about private use');
  const odd = await addressActivity('aleo', aleo, deps({ [route]: () => json('lots') }));
  assert.deepEqual([odd.ok, odd.error], [false, 'the answer was not a balance']);
  const id = 'at1slsjfd5pdpyksvzd0y7n3zs9g2lxgh86rmvtk7xuzzcatlz0ssrsg4t2gv';
  const tx = await transaction('aleo', id, deps({ [`api.explorer.provable.com/v1/mainnet/transaction/confirmed/${id}`]: () => json({ status: 'rejected', type: 'execute', index: 0 }) }));
  assert.deepEqual([tx.tx?.status, tx.tx?.method], ['failed', 'execute']);
});

test('HyperCore: the spot balances come in one answer, each at its own precision, and an order the venue refused reads failed', async () => {
  const user = '0xac487c027ffe32021bbba77e30786f8c8f353201';
  const seen: string[] = [];
  const summary = await addressSummary('hypercore', getAddress(user), deps({ 'api.hyperliquid.xyz/info': (_u, init) => {
    assert.deepEqual(bodyOf(init), { type: 'spotClearinghouseState', user });
    return json({ balances: [{ coin: 'USDC', token: 0, total: '2388487.7042694902', hold: '0.0' }, { coin: 'HYPE', token: 150, total: '2490.85299728', hold: '0.0' }] });
  } }, seen));
  assert.deepEqual([summary.ok, summary.balance?.amount, summary.balance?.symbol, summary.tokensSource], [true, '2490.85299728', 'HYPE', 'hyperliquid']);
  assert.deepEqual(summary.tokens, [{ symbol: 'USDC', name: '', amount: '2388487.7042694902', contract: null, usd: null }]);
  assert.equal(seen.length, 1);
  const hash = '0x2e4667ba841af8b12fc004454b56f30202c200a01f1e1783d20f130d431ed29b';
  const refused = await transaction('hypercore', hash, deps({ 'rpc.hyperliquid.xyz/explorer': () => json({ type: 'txDetails', tx: { time: 1790482425070, user, action: { type: 'order' }, block: 1162565363, hash, error: 'Insufficient margin to place order.' } }) }));
  assert.deepEqual([refused.tx?.status, refused.tx?.method, refused.tx?.block, refused.tx?.from], ['failed', 'order', 1162565363, user]);
  assert.match((await transaction('hypercore', hash, deps({ 'rpc.hyperliquid.xyz/explorer': () => json({ type: 'error', message: 'Unexpected error (code=358)' }) }))).error ?? '', /no such transaction/);
});

// ---------- the network nobody answers for ----------

test('Zcash is decoded and not read: every lookup says why, and nothing goes on the wire', async () => {
  const seen: string[] = [];
  const d = deps({}, seen);
  const z = POA_DEPOSIT['zec:mainnet'];
  const a = await addressSummary('zcash', z, d);
  assert.deepEqual([a.ok, a.source], [false, 'none']);
  assert.match(a.error ?? '', /^Zcash cannot be read by this app: no keyless public Zcash explorer/);
  assert.match((await transactions('zcash', z, 5, d)).error ?? '', /^Zcash cannot be read/);
  assert.match((await transaction('zcash', 'a'.repeat(64), d)).error ?? '', /^Zcash cannot be read/);
  // A bad address is still refused by its shape first.
  assert.match((await addressActivity('zcash', 'zs1xyz', d)).error ?? '', /transparent Zcash/);
  assert.deepEqual(seen, []);
});

// ---------- lists ----------

test('a history is listed where the source keeps one (Litecoin, Fogo) and named as missing where it does not', async () => {
  const ltc = 'LMyZuSZ19kzqDW11D2gbA5TgyP6jnjEZKt';
  const list = await transactions('litecoin', ltc, 5, deps({ [`litecoinspace.org/api/address/${ltc}/txs`]: () => json([{ txid: 'b'.repeat(64), status: { confirmed: true, block_time: 1790482278 }, vin: [], vout: [{ scriptpubkey_address: ltc, value: 160000 }] }]) }));
  assert.deepEqual([list.ok, list.source, list.rows[0]?.value, list.rows[0]?.symbol], [true, 'litecoinspace.org', '0.0016', 'LTC']);
  const fogo = POA_DEPOSIT['fogo:mainnet'];
  const sigs = await transactions('fogo', fogo, 2, deps({ 'mainnet.fogo.io': rpcHost({ getSignaturesForAddress: [{ signature: 'LaoihSchWpZatv2FMDT22viNx84CWekqNaM4UDhLMpSSc5UJV6n2nJSvXi1PKrssfe9peAwmp1HCUX19zxS4xCf', blockTime: 1790482471, err: null, memo: 'claim at evil.tld' }] }) }));
  assert.deepEqual([sigs.ok, sigs.source, sigs.rows.length, sigs.rows[0]?.symbol], [true, 'fogo-rpc', 1, 'FOGO']);
  assert.ok(!JSON.stringify(sigs).includes('evil.tld'), 'the memo is dropped');
  const seen: string[] = [];
  const none = await transactions('tron', 'TCw6YaWm3y6DvxY7M8hrCDnrJGeGMumzGJ', 5, deps({}, seen));
  assert.equal(none.ok, false);
  assert.match(none.error ?? '', /no transaction list on Tron/);
  assert.equal(none.explorer, 'https://tronscan.org/#/address/TCw6YaWm3y6DvxY7M8hrCDnrJGeGMumzGJ');
  assert.deepEqual(seen, []);
});

// ---------- the fetch bounds on the new hosts ----------

test('the new hosts have their own buckets: toncenter one per 1.33 s, BlockCypher three and then its hourly rate', async () => {
  const seen: string[] = [];
  const d = deps({ 'toncenter.com': () => json({}), 'api.blockcypher.com': () => json({}) }, seen);
  await chainFetch('https://toncenter.com/api/v3/account?address=a', {}, d);
  await chainFetch('https://toncenter.com/api/v3/account?address=b', {}, d);
  assert.deepEqual(d.waits, [1334], 'toncenter answers one keyless call a second, and a little slower keeps clear of it');
  for (const n of [1, 2, 3]) await chainFetch(`https://api.blockcypher.com/v1/doge/main/addrs/${n}/balance`, {}, d);
  assert.deepEqual(d.waits, [1334], 'BlockCypher\'s burst of three is free');
  // The fourth call inside the hour would wait 36 s, past a 30 s call: refused, not slept.
  await assert.rejects(chainFetch('https://api.blockcypher.com/v1/doge/main/addrs/4/balance', {}, { ...d, deadline: (d.now as () => number)() + 30_000 }), /rate limit for api\.blockcypher\.com: the next slot is 36000ms away/);
  assert.equal(seen.length, 5);
});

test('a whole number past 2^53 arrives as its own digits, and every other number as it always did', async () => {
  const d = deps({ 'mempool.space': () => text('{"big":12345678901234567890,"neg":-9007199254740993,"safe":42,"frac":1.5,"exp":1e21}') });
  assert.deepEqual(await chainFetch('https://mempool.space/api/x', {}, d), { big: '12345678901234567890', neg: '-9007199254740993', safe: 42, frac: 1.5, exp: 1e21 });
});

// ---------- the pay card ----------

test('a payout on a chain past the first six is read under its own name and said in the card\'s words', async () => {
  const activity = await addressActivity('optimism', EVM, deps({ 'mainnet.optimism.io': rpcHost({ eth_getBalance: '0xba2e0a8a3f5d8a7', eth_getTransactionCount: '0x1365c14', eth_getCode: '0x' }) }));
  const sentence = recipientSentence('op', { activity, ownAddress: false } as unknown as Parameters<typeof recipientSentence>[1]);
  assert.equal(sentence, 'This address has 20339732 transactions on Optimism and holds 0.838479 ETH.');
});
