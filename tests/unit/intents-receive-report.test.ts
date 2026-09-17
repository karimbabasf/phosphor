// The receive report: the bridge's round trips (one address per registry network and the token
// list), kept for a minute per account, and the token rows carrying the floor in the unit a
// person reads, with what it is worth when the price list has the asset.
//
// fetch is replaced for the test and counted. Nothing here reaches the bridge.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';

import { intentsReceiveReport } from '../../src/http/wallet.ts';
import type { IntentsReceiveNetwork } from '../../src/http/wallet.ts';
import { walletReads } from '../../src/http/read/wallet.ts';
import { RECEIVE_NETWORKS, receiveNetworkByBridge } from '../../src/rails/intents-address.ts';
import { base58Encode } from '../../src/chain/near.ts';
import type { Ctx } from '../../src/http/context.ts';

type Any = Record<string, any>;

// Two asks per registry network (the report shows an address only when two answers agree), plus
// the token list.
const CALLS_PER_READ = 2 * RECEIVE_NETWORKS.length + 1;

const USDC_ROW = {
  defuse_asset_identifier: 'eth:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  origin_chain_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  asset_name: 'USDC',
  decimals: 6,
  min_deposit_amount: '1000',
  intents_token_id: 'nep141:base-0x8335.omft.near',
};
const ETH_ROW = { defuse_asset_identifier: 'eth:1', asset_name: 'ETH', decimals: 18, min_deposit_amount: '100000000000' };
// The live list spells a chain's own coin with the word native in both places.
const BASE_ETH_ROW = {
  defuse_asset_identifier: 'eth:8453:native',
  origin_chain_address: 'native',
  asset_name: 'ETH',
  decimals: 18,
  min_deposit_amount: '1',
  intents_token_id: 'nep141:base.omft.near',
};
// Bitcoin twice on btc:mainnet, as the live list has it (two NEAR tokens for one coin).
const BTC_ROWS = [
  { defuse_asset_identifier: 'btc:mainnet:native', origin_chain_address: 'native', near_token_id: 'nbtc.bridge.near', asset_name: 'BTC', decimals: 8, min_deposit_amount: '5000', intents_token_id: 'nep141:nbtc.bridge.near' },
  { defuse_asset_identifier: 'btc:mainnet:native', origin_chain_address: 'native', near_token_id: 'btc.omft.near', asset_name: 'BTC', decimals: 8, min_deposit_amount: '7000', intents_token_id: 'nep141:btc.omft.near' },
];

function ctxFor(account: string | null, mode: 'live' | 'demo' = 'live', extra: Partial<Ctx> = {}): Ctx {
  return {
    cfg: { mode },
    keystore: {
      addressReport: () => ({ addresses: { evm: account, solana: null, near: null }, verified: true, tampered: false }),
    },
    ...extra,
  } as unknown as Ctx;
}

// An address with the shape the report checks for the network: the EVM chains one hex address
// each, Solana a 32-byte base58 key, NEAR an account id, Bitcoin a bech32 string, and the rest a
// plain printable token, which is all the report can ask of a chain it cannot decode.
export function shapedAddress(chain: string): string {
  if (chain.startsWith('eth:') || receiveNetworkByBridge(chain)?.kind === 'evm') return `0x${crypto.createHash('sha256').update(chain).digest('hex').slice(0, 40)}`;
  if (receiveNetworkByBridge(chain)?.kind === 'sol') return base58Encode(new Uint8Array(crypto.createHash('sha256').update(chain).digest()));
  if (chain === 'near:mainnet') return 'deposit-for-you.near';
  if (chain === 'btc:mainnet') return 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
  return `addr-for-${chain}`;
}

/* A bridge that answers every deposit_address with one address per network and the token
   list once, and counts how often it was asked. `down` makes every call throw. `address`
   chooses the string per network, so a test can make two networks share one. */
function bridge(options: { down?: boolean; tokens?: unknown[]; address?: (chain: string) => string } = {}): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init: Any = {}) => {
    const body = JSON.parse(init.body ?? '{}') as { method: string; params: Any[] };
    calls.push(body.method);
    if (options.down) throw new Error('no route to the bridge');
    const chain = String(body.params[0]?.chain);
    const answer = body.method === 'supported_tokens'
      ? { result: { tokens: options.tokens ?? [USDC_ROW, ETH_ROW] } }
      : { result: { address: options.address ? options.address(chain) : shapedAddress(chain), chain } };
    return { ok: true, status: 200, json: async () => answer } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

let nextAccount = 0x1000;
// Every test gets its own account, because the report keeps the bridge's answer per account.
function account(): string {
  nextAccount += 1;
  return `0x${nextAccount.toString(16).padStart(40, '0')}`;
}

function net(report: { networks: IntentsReceiveNetwork[] }, id: string): IntentsReceiveNetwork {
  const row = report.networks.find((n) => n.id === id);
  assert.ok(row, `no ${id} row`);
  return row;
}

test('the token rows carry the floor in base units and in the unit a person reads, plus the contract', async () => {
  const net_ = bridge();
  try {
    const report = await intentsReceiveReport(ctxFor(account()));
    const base = net(report, 'base');
    assert.deepEqual(base.accepts, [{
      symbol: 'USDC',
      // The verifier's id, so the deposit watch can read this one balance.
      assetId: 'nep141:base-0x8335.omft.near',
      decimals: 6,
      minDeposit: '1000',
      minDepositHuman: '0.001',
      // No price list in this ctx, so the floor is judged on its own size: a thousandth is shown.
      minimum: { shown: true, amount: '0.001', usd: null },
      // The contract as the chain spells it, off origin_chain_address, not the lowercased id.
      contract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    }]);
    const eth = net(report, 'eth');
    // A ten millionth of an ETH, unpriced, is under the millionth-of-a-unit cut: "No minimum".
    assert.deepEqual(eth.accepts, [{ symbol: 'ETH', assetId: '', decimals: 18, minDeposit: '100000000000', minDepositHuman: '0.0000001', minimum: { shown: false, amount: '0.0000001', usd: null }, contract: null }]);
    assert.equal(base.address, shapedAddress('eth:8453'));
  } finally {
    net_.restore();
  }
});

test('every row carries the registry fields the window draws by, and the six quick tiles come first', async () => {
  const b = bridge();
  try {
    const report = await intentsReceiveReport(ctxFor(account()));
    assert.equal(report.networks.length, RECEIVE_NETWORKS.length);
    assert.deepEqual(report.networks.slice(0, 6).map((n) => n.id), ['eth', 'base', 'arb', 'sol', 'near', 'btc']);
    const rest = report.networks.slice(6);
    assert.ok(rest.every((n) => !n.popular), 'a popular network sorted after the six');
    assert.deepEqual(rest.map((n) => n.name), [...rest.map((n) => n.name)].sort((x, y) => x.localeCompare(y, 'en')), 'the rest are not by name');
    const btc = net(report, 'btc');
    assert.deepEqual(
      { name: btc.name, words: btc.words, bridge: btc.bridge, kind: btc.kind, native: btc.native, mark: btc.mark, colour: btc.colour, popular: btc.popular },
      { name: 'Bitcoin', words: 'Bitcoin (BTC)', bridge: 'btc:mainnet', kind: 'other', native: 'BTC', mark: 'BTC', colour: '#F7931A', popular: true },
    );
    assert.equal(btc.address, shapedAddress('btc:mainnet'));
    assert.deepEqual(Object.keys(btc), ['id', 'name', 'words', 'bridge', 'kind', 'native', 'mark', 'colour', 'popular', 'address', 'memo', 'unavailable', 'sharedWith', 'warning', 'accepts', 'changed']);
  } finally {
    b.restore();
  }
});

test('the bridge is asked once a minute per account; force asks again; a second account is its own entry', async () => {
  const b = bridge();
  try {
    const one = ctxFor(account());
    await intentsReceiveReport(one);
    assert.equal(b.calls.length, CALLS_PER_READ, 'one address per network and one token list');
    await intentsReceiveReport(one);
    await intentsReceiveReport(one);
    assert.equal(b.calls.length, CALLS_PER_READ, 'a second read inside the minute went back to the bridge');
    await intentsReceiveReport(one, { force: true });
    assert.equal(b.calls.length, 2 * CALLS_PER_READ, 'force did not ask again');
    await intentsReceiveReport(ctxFor(account()));
    assert.equal(b.calls.length, 3 * CALLS_PER_READ, 'another account read the first one\'s cache');
  } finally {
    b.restore();
  }
});

test('a bridge that was down is not remembered as down: the next call asks again', async () => {
  const down = bridge({ down: true });
  const who = account();
  try {
    const report = await intentsReceiveReport(ctxFor(who));
    assert.ok(report.networks.every((n) => n.address === null && n.unavailable !== null), 'a down bridge drew an address');
    assert.ok(report.networks.every((n) => n.sharedWith.length === 0 && / only\. /.test(n.warning)), 'a row with no address claimed to share one');
    assert.equal(down.calls.length, CALLS_PER_READ);
    await intentsReceiveReport(ctxFor(who));
    assert.equal(down.calls.length, 2 * CALLS_PER_READ, 'the failed answer was served from the cache');
  } finally {
    down.restore();
  }
  const up = bridge();
  try {
    const report = await intentsReceiveReport(ctxFor(who));
    assert.ok(report.networks.every((n) => n.address !== null), 'the bridge came back and the report did not');
  } finally {
    up.restore();
  }
});

test('verified is read fresh on every call, never from the cached bridge half', async () => {
  const b = bridge();
  try {
    let verified = false;
    const who = account();
    const ctx = {
      cfg: { mode: 'live' },
      keystore: { addressReport: () => ({ addresses: { evm: who, solana: null, near: null }, verified, tampered: false }) },
    } as unknown as Ctx;
    assert.equal((await intentsReceiveReport(ctx)).verified, false);
    verified = true;
    const again = await intentsReceiveReport(ctx);
    assert.equal(again.verified, true, 'the wallet opened and the report still said unverified');
    assert.equal(b.calls.length, CALLS_PER_READ, 'the flip cost a bridge round trip');
  } finally {
    b.restore();
  }
});

test('PHOSPHOR_DEMO_RECEIVE stands in for the bridge in demo mode only, and may name only some networks', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-receive-'));
  const file = path.join(dir, 'receive.json');
  fs.writeFileSync(file, JSON.stringify({
    addresses: { eth: '0xfixture', base: '0xfixture', sol: 'SoLfixture', btc: 'bc1fixture' },
    tokens: [USDC_ROW, ETH_ROW, ...BTC_ROWS],
    prices: { 'nep141:base-0x8335.omft.near': 1, 'nep141:nbtc.bridge.near': 100000, 'nep141:btc.omft.near': 100000 },
  }));
  const was = process.env.PHOSPHOR_DEMO_RECEIVE;
  process.env.PHOSPHOR_DEMO_RECEIVE = file;
  const b = bridge();
  try {
    const demo = await intentsReceiveReport(ctxFor(account(), 'demo'));
    assert.equal(b.calls.length, 0, 'demo mode with a fixture still asked the bridge');
    assert.equal(demo.networks.length, RECEIVE_NETWORKS.length, 'a fixture naming four networks drew fewer rows');
    assert.equal(net(demo, 'base').address, '0xfixture');
    // A real floor of a thousandth is shown whatever the price says: a price can reveal a
    // floor the unit rule would have called dust, never hide one.
    assert.deepEqual(net(demo, 'base').accepts[0]?.minimum, { shown: true, amount: '0.001', usd: 0.001 });
    assert.deepEqual(net(demo, 'btc').accepts.map((a) => a.minimum), [{ shown: true, amount: '0.00007', usd: 7 }]);
    assert.deepEqual(net(demo, 'eth').sharedWith, ['base']);
    assert.deepEqual(net(demo, 'base').sharedWith, ['eth']);
    const near = net(demo, 'near');
    assert.equal(near.address, null);
    assert.equal(near.unavailable, 'not in the demo fixture');
    assert.equal(net(demo, 'ltc').unavailable, 'not in the demo fixture');

    await intentsReceiveReport(ctxFor(account(), 'live'));
    assert.equal(b.calls.length, CALLS_PER_READ, 'live mode read the demo fixture');
  } finally {
    b.restore();
    if (was === undefined) delete process.env.PHOSPHOR_DEMO_RECEIVE;
    else process.env.PHOSPHOR_DEMO_RECEIVE = was;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- the live list, as the bridge answered it ----------

const LIVE = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'poa-tokens.json'), 'utf8')) as {
  result: { tokens: Array<Record<string, unknown>> };
};

test('the registry covers every network prefix in the live token list, once each, under a distinct id', () => {
  const prefixes = new Set(LIVE.result.tokens.map((r) => String(r.defuse_asset_identifier).split(':').slice(0, 2).join(':')));
  const bridges = RECEIVE_NETWORKS.map((n) => n.bridge);
  assert.deepEqual([...prefixes].sort(), [...bridges].sort(), 'the registry and the bridge disagree about the networks');
  assert.equal(new Set(RECEIVE_NETWORKS.map((n) => n.id)).size, RECEIVE_NETWORKS.length, 'two networks share an id');
  assert.deepEqual(RECEIVE_NETWORKS.filter((n) => n.popular).map((n) => n.id), ['eth', 'base', 'arb', 'sol', 'near', 'btc']);
  for (const n of RECEIVE_NETWORKS) {
    assert.match(n.colour, /^#[0-9A-F]{6}$/, `${n.id} has no brand hex`);
    assert.ok(n.name !== '' && n.words !== '' && n.native !== '' && n.mark !== '', `${n.id} is missing a word`);
  }
});

test('over the live list, no row calls the word native a contract, BTC is one row with the larger floor, and every token has a floor sentence', async () => {
  const b = bridge({ tokens: LIVE.result.tokens });
  try {
    const report = await intentsReceiveReport(ctxFor(account()));
    const every = report.networks.flatMap((n) => n.accepts);
    assert.ok(every.length > 150, `only ${every.length} token rows off a 227 row list`);
    assert.ok(every.every((a) => a.contract !== 'native' && a.contract !== ''), 'the word native became a contract');
    assert.equal(net(report, 'base').accepts.find((a) => a.symbol === 'ETH')?.contract, null, 'Base ETH is the chain\'s own coin');
    assert.equal(net(report, 'base').accepts.find((a) => a.symbol === 'USDC')?.contract, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    assert.equal(net(report, 'aptos').accepts.find((a) => a.symbol === 'APT')?.contract, '0x1::aptos_coin::AptosCoin', 'the coin type is what an explorer takes');
    assert.deepEqual(net(report, 'btc').accepts.map((a) => [a.symbol, a.minDeposit, a.contract]), [['BTC', '5000', null]]);
    // Aleo lists ALEO twice under two contracts (public and private), which is two rows.
    assert.equal(net(report, 'aleo').accepts.filter((a) => a.symbol === 'ALEO').length, 2);
    assert.ok(every.every((a) => a.minimum.amount === a.minDepositHuman && a.minimum.usd === null), 'no price list, yet a dollar figure appeared');
    // PEPE floors at one base unit of eighteen: not a minimum anybody can see.
    assert.equal(net(report, 'eth').accepts.find((a) => a.symbol === 'PEPE')?.minimum.shown, false);
    assert.equal(net(report, 'hypercore').accepts[0]?.minimum.shown, true);
    assert.ok(report.networks.every((n) => n.accepts.length > 0), 'a network with nothing it credits');
  } finally {
    b.restore();
  }
});

test('BTC keeps the larger of its two floors, whichever order the bridge lists them in', async () => {
  for (const rows of [BTC_ROWS, [...BTC_ROWS].reverse()]) {
    const b = bridge({ tokens: rows });
    try {
      const report = await intentsReceiveReport(ctxFor(account()));
      assert.deepEqual(net(report, 'btc').accepts.map((a) => [a.minDeposit, a.minDepositHuman]), [['7000', '0.00007']]);
    } finally {
      b.restore();
    }
  }
});

test('the price list turns a floor into dollars and decides whether it is shown; a broken list costs nothing', async () => {
  const b = bridge({ tokens: [USDC_ROW, ETH_ROW, BASE_ETH_ROW] });
  try {
    const priced = await intentsReceiveReport(ctxFor(account(), 'live', {
      intentsPrices: async () => new Map([['nep141:base-0x8335.omft.near', 0.9997], ['nep141:base.omft.near', 4000]]),
    } as Partial<Ctx>));
    const base = net(priced, 'base');
    assert.deepEqual(base.accepts.find((a) => a.symbol === 'USDC')?.minimum, { shown: true, amount: '0.001', usd: 0.001 }, 'a price hid a floor the unit rule shows');
    // One wei of ETH at four thousand dollars is a millionth of a cent: not shown, but priced.
    assert.deepEqual(base.accepts.find((a) => a.symbol === 'ETH')?.minimum, { shown: false, amount: '0.000000000000000001', usd: 0 });
    // ETH on Ethereum has no price in this list: judged on its own size.
    assert.deepEqual(net(priced, 'eth').accepts[0]?.minimum, { shown: false, amount: '0.0000001', usd: null });

    const broken = await intentsReceiveReport(ctxFor(account(), 'live', { intentsPrices: async () => { throw new Error('1click is down'); } } as Partial<Ctx>));
    assert.deepEqual(net(broken, 'base').accepts.find((a) => a.symbol === 'USDC')?.minimum, { shown: true, amount: '0.001', usd: null });
  } finally {
    b.restore();
  }
});

test('sharedWith is computed from byte-equal addresses, and the warning names the popular ones and counts the rest', async () => {
  // Every EVM network and HyperCore answer with one address, as the live bridge does; the rest
  // are their own.
  const evm = new Set(RECEIVE_NETWORKS.filter((n) => n.kind === 'evm').map((n) => n.bridge));
  const b = bridge({ address: (chain) => (evm.has(chain) ? `0x${'ab'.repeat(20)}` : shapedAddress(chain)) });
  try {
    const report = await intentsReceiveReport(ctxFor(account()));
    const eth = net(report, 'eth');
    assert.equal(eth.sharedWith.length, evm.size - 1);
    assert.ok(eth.sharedWith.includes('hypercore') && eth.sharedWith.includes('bnb') && !eth.sharedWith.includes('eth'));
    assert.equal(eth.warning, `Ethereum shares this address with Base, Arbitrum and ${evm.size - 3} more, but send only on "Ethereum (ERC-20)", and only an asset it credits.`);
    assert.equal(net(report, 'op').warning, `Optimism shares this address with Ethereum, Base, Arbitrum and ${evm.size - 4} more, but send only on "Optimism (OP Mainnet)", and only an asset it credits.`);
    assert.deepEqual(net(report, 'sol').sharedWith, []);
    assert.equal(net(report, 'sol').warning, 'Solana only. Anything sent here from another network is lost.');
    assert.equal(net(report, 'btc').warning, 'Bitcoin only. Anything sent here from another network is lost.');
  } finally {
    b.restore();
  }
});

test('a network the bridge lists that the registry does not know is a row under its raw key, asked for like the rest', async () => {
  const stranger = { defuse_asset_identifier: 'newchain:mainnet:native', origin_chain_address: 'native', asset_name: 'NEW', decimals: 9, min_deposit_amount: '1000000000', intents_token_id: 'nep141:newchain.omft.near' };
  const b = bridge({ tokens: [USDC_ROW, stranger] });
  try {
    const report = await intentsReceiveReport(ctxFor(account()));
    assert.equal(b.calls.length, CALLS_PER_READ + 2, 'the stranger was not asked for');
    const row = net(report, 'newchain:mainnet');
    assert.deepEqual(
      { name: row.name, words: row.words, bridge: row.bridge, kind: row.kind, native: row.native, popular: row.popular, address: row.address },
      { name: 'newchain:mainnet', words: 'newchain:mainnet', bridge: 'newchain:mainnet', kind: 'other', native: 'NEW', popular: false, address: 'addr-for-newchain:mainnet' },
    );
    assert.deepEqual(row.accepts.map((a) => [a.symbol, a.minDepositHuman, a.contract]), [['NEW', '1', null]]);
    assert.equal(report.networks.length, RECEIVE_NETWORKS.length + 1);
  } finally {
    b.restore();
  }
});

// ---------- the agent's deposit tool on top of the report ----------

function captured(): { res: http.ServerResponse; body: () => Any } {
  let text = '';
  const res = {
    writeHead() {
      return res;
    },
    end(chunk?: unknown) {
      text = String(chunk ?? '');
    },
  } as unknown as http.ServerResponse;
  return { res, body: () => JSON.parse(text) as Any };
}

function toolCtx(report: Any): { ctx: Ctx; shown: Any[]; audited: string[] } {
  const shown: Any[] = [];
  const audited: string[] = [];
  const ctx = {
    intentsReceive: async () => report,
    deposits: { show: (chain: string, symbol: string, address: string | null) => { shown.push({ chain, symbol, address }); return { phase: 'watching' }; } },
    audit: { append: (_type: string, line: string) => { audited.push(line); } },
    keystore: { custody: () => 'password', state: () => 'locked', enclave: () => null, header: () => null },
    vault: { attached: () => false, enclaveReady: () => false, capability: () => 'none', waiting: () => null },
    vaultPrefs: { get: () => ({ backedUp: false, backedUpAt: null, idleMinutes: 15 }) },
  } as unknown as Ctx;
  return { ctx, shown, audited };
}

test('the agent deposit tool takes a registry id or a plain name, answers in the words an exchange uses, and relays a memo', async () => {
  const b = bridge({ tokens: [USDC_ROW, ...BTC_ROWS, { defuse_asset_identifier: 'stellar:mainnet:native', origin_chain_address: 'native', asset_name: 'XLM', decimals: 7, min_deposit_amount: '1', intents_token_id: 'nep245:v2_1.omni.hot.tg:1100_x' }] });
  let report: Any;
  try {
    report = await intentsReceiveReport(ctxFor(account()));
  } finally {
    b.restore();
  }
  const stellar = report.networks.find((n: Any) => n.id === 'stellar');
  stellar.memo = '177237517';

  for (const chain of ['btc', 'Bitcoin', 'BITCOIN ']) {
    const { ctx, shown, audited } = toolCtx(report);
    const a = captured();
    await walletReads.deposit(ctx, {}, { chain, asset: 'btc' }, a.res);
    const out = a.body();
    assert.equal(out.ok, true, `${chain}: ${JSON.stringify(out)}`);
    assert.equal(out.chain, 'btc');
    assert.equal(out.network, 'Bitcoin (BTC)');
    assert.equal(out.asset, 'BTC');
    assert.equal(out.minDeposit, '0.00007');
    assert.equal(out.addressFingerprint, 'bc1qw5...f3t4');
    assert.match(out.relay, /choose the network "Bitcoin \(BTC\)"/);
    assert.doesNotMatch(out.relay, /memo/);
    assert.deepEqual(shown, [{ chain: 'btc', symbol: 'BTC', address: shapedAddress('btc:mainnet') }]);
    assert.equal(audited.length, 1);
  }

  for (const [chain, id] of [['bnb chain', 'bnb'], ['BEP-20', 'bnb'], ['Binance Smart Chain', 'bnb'], ['matic', 'polygon'], ['Optimism', 'op'], ['avalanche', 'avax'], ['Arbitrum One', 'arb'], ['ethereum', 'eth'], ['Gnosis Chain', 'gnosis'], ['hyperliquid', 'hypercore'], ['TRC20', 'tron']]) {
    const a = captured();
    await walletReads.deposit(toolCtx(report).ctx, {}, { chain, asset: 'nothing' }, a.res);
    const out = a.body();
    // The asset is wrong on purpose: the refusal names the network, which proves the alias resolved.
    assert.equal(out.ok, false);
    assert.match(String(out.reason), new RegExp(`not credited on ${report.networks.find((n: Any) => n.id === id).words.replace(/[()]/g, '\\$&')}`), `${chain} did not resolve to ${id}`);
  }

  const memo = captured();
  await walletReads.deposit(toolCtx(report).ctx, {}, { chain: 'stellar', asset: 'XLM' }, memo.res);
  assert.equal(memo.body().memo, '177237517');
  assert.match(memo.body().relay, /needs the memo 177237517/);

  const unknown = captured();
  await walletReads.deposit(toolCtx(report).ctx, {}, { chain: 'ETH mainnet on binance', asset: 'USDC' }, unknown.res);
  assert.equal(unknown.body().ok, false);
  assert.match(String(unknown.body().reason), /chain must be one of eth, base, arb, sol, near, btc, .*plasma \(got ETH mainnet on binance\)/);
  assert.equal(unknown.body().accepted.find((row: Any) => row.chain === 'bnb').network, 'BNB Smart Chain (BEP-20)');
});
