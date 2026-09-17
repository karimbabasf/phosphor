// The four chain read ops as the agent calls them, over an injected fetch. What the door adds
// on top of src/chainscan: a 400 with the reason for a shape that fails, a closed network
// enum, the limit clamped, the config keys handed to the fetch, and intents_activity reading
// this app's own account when none is given.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type http from 'node:http';

import { chainReadsWith } from '../../src/http/read/chain.ts';
import { createChainFetchState } from '../../src/chainscan/index.ts';
import type { ChainDeps } from '../../src/chainscan/index.ts';
import type { Ctx } from '../../src/http/context.ts';

function captured(): { res: http.ServerResponse; status: () => number; body: () => Record<string, unknown> } {
  let text = '';
  let code = 0;
  const res = {
    writeHead(status: number) {
      code = status;
      return res;
    },
    end(chunk?: unknown) {
      text = String(chunk ?? '');
    },
  } as unknown as http.ServerResponse;
  return { res, status: () => code, body: () => JSON.parse(text) as Record<string, unknown> };
}

type Handler = (url: string, init: RequestInit | undefined) => Response;

function deps(routes: Record<string, Handler>, seen: Array<{ url: string; init: RequestInit | undefined }> = []): ChainDeps {
  let now = 1_000_000;
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, init });
    const u = new URL(url);
    const handler = routes[u.host + u.pathname] ?? routes[u.host];
    return handler === undefined ? new Response('{"message":"Not found"}', { status: 404 }) : handler(url, init);
  }) as unknown as typeof fetch;
  return {
    fetchImpl,
    state: createChainFetchState(),
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
    // No RPC in these tests: the indexer answers or the lookup fails by name.
    reader: () => {
      throw new Error('no rpc in this test');
    },
  };
}

const json = (value: unknown): Response => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });

// A ctx with no keystore: the own account falls back to the configured EVM address.
const OWN = '0x1111111111111111111111111111111111111111';
function ctx(extra: Record<string, unknown> = {}): Ctx {
  return { cfg: { keysPath: '/nonexistent/keys.json', addresses: { evm: OWN }, ...extra } } as unknown as Ctx;
}

const VITALIK = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';

test('chain_address refuses a bad network or address with a 400 and the reason, before any request', async () => {
  const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
  const reads = chainReadsWith(deps({}, seen));
  for (const [args, why] of [
    [{ network: 'polygon', address: VITALIK }, /network must be one of ethereum, base, arbitrum, solana, near, bitcoin/],
    [{ network: 'ethereum', address: 'https://evil.tld/x' }, /not an address on Ethereum/],
    [{ network: 'ethereum' }, /no address given/],
    [{ network: 'solana', address: VITALIK }, /not a Solana address/],
  ] as const) {
    const { res, status, body } = captured();
    await reads.chain_address(ctx(), {}, { ...args }, res);
    assert.equal(status(), 400, JSON.stringify(args));
    assert.match(String(body().error), why);
  }
  assert.deepEqual(seen, []);
});

test('chain_address answers the summary and hands the configured keys to the fetch', async () => {
  const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
  const reads = chainReadsWith(
    deps({
      [`eth.blockscout.com/api/v2/addresses/${VITALIK}`]: () => json({ coin_balance: '1000000000000000000', is_contract: false }),
      [`eth.blockscout.com/api/v2/addresses/${VITALIK}/counters`]: () => json({ transactions_count: '3' }),
      [`eth.blockscout.com/api/v2/addresses/${VITALIK}/tokens`]: () => json({ items: [] }),
    }, seen),
  );
  const { res, status, body } = captured();
  await reads.chain_address(ctx({ chainscan: { blockscoutApiKey: 'bs-key' } }), {}, { network: 'ethereum', address: VITALIK.toLowerCase() }, res);
  assert.equal(status(), 200);
  const answer = body();
  assert.equal(answer.ok, true);
  assert.equal(answer.txCount, 3);
  assert.deepEqual(answer.balance, { amount: '1', symbol: 'ETH' });
  assert.equal(answer.explorer, `https://etherscan.io/address/${VITALIK}`);
  assert.equal(typeof answer.note, 'string');
  assert.ok(seen.every((s) => s.url.includes('apikey=bs-key')), 'the blockscout key was not sent');
  assert.ok(!JSON.stringify(answer).includes('bs-key'), 'the key reached the answer');
});

test('chain_transactions clamps the limit to 25 and chain_transaction checks the hash', async () => {
  const items = Array.from({ length: 50 }, (_, i) => ({ hash: `0x${i.toString(16).padStart(64, '0')}`, timestamp: '2026-09-15T10:00:00.000000Z', from: { hash: VITALIK }, to: { hash: VITALIK }, value: '0', status: 'ok', method: 'x', raw_input: '0x00' }));
  const reads = chainReadsWith(deps({ [`base.blockscout.com/api/v2/addresses/${VITALIK}/transactions`]: () => json({ items }) }));
  const a = captured();
  await reads.chain_transactions(ctx(), {}, { network: 'base', address: VITALIK, limit: 500 }, a.res);
  assert.equal(a.status(), 200);
  assert.equal((a.body().rows as unknown[]).length, 25);
  const b = captured();
  await reads.chain_transactions(ctx(), {}, { network: 'base', address: VITALIK, limit: 'seven' }, b.res);
  assert.equal((b.body().rows as unknown[]).length, 10, 'an unreadable limit is the default');
  const c = captured();
  await reads.chain_transaction(ctx(), {}, { network: 'base', hash: 'not a hash' }, c.res);
  assert.equal(c.status(), 400);
  assert.match(String(c.body().error), /not an EVM transaction hash/);
});

test('a source that fails is a 200 with ok false and the failure named, not a 400 and not a throw', async () => {
  const reads = chainReadsWith(deps({ 'api.nearblocks.io': () => new Response('slow down', { status: 429 }), 'free.rpc.fastnear.com': () => new Response('x', { status: 503 }) }));
  const { res, status, body } = captured();
  await reads.intents_activity(ctx(), {}, { account: VITALIK }, res);
  assert.equal(status(), 200);
  assert.equal(body().ok, false);
  assert.match(String(body().error), /nearblocks: http 429; rpc: http 503/);
});

test('intents_activity reads this app\'s own account when none is given, lowercased, and says so', async () => {
  const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
  const reads = chainReadsWith(deps({ 'api.nearblocks.io': () => json({ data: [] }) }, seen));
  const a = captured();
  await reads.intents_activity(ctx(), {}, {}, a.res);
  assert.equal(a.status(), 200);
  assert.equal(a.body().account, OWN);
  assert.equal(a.body().own, true);
  assert.ok(seen[0].url.startsWith(`https://api.nearblocks.io/v3/accounts/${OWN}/mt-txns?contract=intents.near&limit=10`), seen[0].url);
  const b = captured();
  await reads.intents_activity(ctx(), {}, { account: VITALIK, limit: 3 }, b.res);
  assert.equal(b.body().account, VITALIK.toLowerCase());
  assert.equal(b.body().own, false);
  assert.ok(seen[1].url.endsWith('limit=3'));
  // No wallet and no configured address: the tool says so rather than looking up nothing.
  const c = captured();
  await reads.intents_activity(ctx({ addresses: {} }), {}, {}, c.res);
  assert.equal(c.status(), 400);
  assert.match(String(c.body().error), /no account/);
});
