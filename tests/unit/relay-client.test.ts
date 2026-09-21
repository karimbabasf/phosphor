// The relay client against a fixture transport: what goes on the wire, what comes back typed,
// and what is refused. Nothing here reaches the network.
//
// Run: node --test tests/unit/relay-client.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RELAY_API_KEY_ENV, RELAY_URL, relayClient } from '../../src/relay/client.ts';
import { INTENTS_API_KEY_ENV } from '../../src/rails/intents-native.ts';
import { READ_TIMEOUT_MS, VENUE_WRITE_TIMEOUT_MS } from '../../src/net.ts';

const USDC = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const USDT = 'nep141:usdt.tether-token.near';

type Call = { url: string; body: Record<string, unknown>; headers: Record<string, string>; signal: AbortSignal | null | undefined };

// A transport that answers each call from a queue and records what it was sent.
function transport(answers: Array<unknown | Error | { httpStatus: number; body: unknown }>): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}));
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown>, headers, signal: init?.signal });
    const next = answers.shift();
    if (next instanceof Error) throw next;
    const http = next !== null && typeof next === 'object' && 'httpStatus' in (next as object) ? (next as { httpStatus: number; body: unknown }) : null;
    const status = http?.httpStatus ?? 200;
    const payload = http === null ? next : http.body;
    return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function rpc(result: unknown): unknown {
  return { jsonrpc: '2.0', id: 1, result };
}

const QUOTE = {
  quote_hash: 'Cw6dV7MV3NvKRNrXjLpymkWneBzuhTjrgEYuQLwnnCg6',
  defuse_asset_identifier_in: USDC,
  defuse_asset_identifier_out: USDT,
  amount_in: '2000000',
  amount_out: '1961996',
  expiration_time: '2026-09-21T02:36:18.974Z',
};

test('the relay and the 1Click client read the partner key from the same variable', () => {
  assert.equal(RELAY_API_KEY_ENV, INTENTS_API_KEY_ENV);
  assert.equal(RELAY_URL, 'https://solver-relay-v2.chaindefuser.com/rpc');
});

test('quote sends the four fields as the relay names them, under a read deadline, and types the answer', async () => {
  const t = transport([rpc([QUOTE])]);
  const client = relayClient({ fetchImpl: t.fetchImpl, apiKey: '' });
  const quotes = await client.quote({ assetIn: USDC, assetOut: USDT, exactAmountIn: '2000000' });
  assert.deepEqual(quotes, [{ quoteHash: QUOTE.quote_hash, assetIn: USDC, assetOut: USDT, amountIn: '2000000', amountOut: '1961996', expirationTime: QUOTE.expiration_time }]);
  const call = t.calls[0];
  assert.equal(call.url, RELAY_URL);
  assert.equal(call.body['method'], 'quote');
  assert.deepEqual(call.body['params'], [
    { defuse_asset_identifier_in: USDC, defuse_asset_identifier_out: USDT, exact_amount_in: '2000000', min_deadline_ms: 60_000 },
  ]);
  assert.ok(call.signal instanceof AbortSignal, 'every call carries a deadline');
  assert.equal(call.headers['X-API-Key'], undefined, 'an empty key means no header at all');
  assert.equal(READ_TIMEOUT_MS, 10_000);
});

test('the key is sent as X-API-Key when present and appears in no error', async () => {
  const t = transport([{ httpStatus: 401, body: { error: 'unauthorised' } }]);
  const client = relayClient({ fetchImpl: t.fetchImpl, apiKey: 'jwt-secret-value' });
  await assert.rejects(() => client.quote({ assetIn: USDC, assetOut: USDT, exactAmountIn: '1' }), (err: Error) => {
    assert.match(err.message, /relay quote failed: unauthorised/);
    assert.equal(err.message.includes('jwt-secret-value'), false);
    return true;
  });
  assert.equal(t.calls[0].headers['X-API-Key'], 'jwt-secret-value');
});

test('a null quote result is an empty list, a malformed entry is dropped, and a non-list is an error', async () => {
  const t = transport([
    rpc(null),
    rpc([QUOTE, { ...QUOTE, amount_out: 1961996 }, { ...QUOTE, amount_in: '' }, { ...QUOTE, expiration_time: 'soon' }, 'junk']),
    rpc({ unexpected: true }),
  ]);
  const client = relayClient({ fetchImpl: t.fetchImpl, apiKey: '' });
  const req = { assetIn: USDC, assetOut: USDT, exactAmountIn: '2000000' };
  assert.deepEqual(await client.quote(req), []);
  const quotes = await client.quote(req);
  assert.equal(quotes.length, 1, 'a numeric amount, an empty amount and an unparseable expiry are not quotes');
  await assert.rejects(() => client.quote(req), /instead of a list/);
});

test('publishIntent sends the signed bytes untouched under a write deadline and types OK and FAILED', async () => {
  const payload = '{"signer_id":"0xabc","verifying_contract":"intents.near"}';
  const t = transport([rpc({ status: 'OK', intent_hash: '9cM3Y6Q4' }), rpc({ status: 'FAILED', reason: 'error simulating intents: insufficient balance' }), rpc({ status: 'MAYBE' })]);
  const client = relayClient({ fetchImpl: t.fetchImpl, apiKey: '' });
  const req = { quoteHashes: [QUOTE.quote_hash], standard: 'erc191', payload, signature: 'secp256k1:abc' };

  assert.deepEqual(await client.publishIntent(req), { status: 'OK', intentHash: '9cM3Y6Q4' });
  const sent = t.calls[0].body['params'] as Array<Record<string, unknown>>;
  assert.deepEqual(sent[0], { quote_hashes: [QUOTE.quote_hash], signed_data: { standard: 'erc191', payload, signature: 'secp256k1:abc' } });
  assert.equal(t.calls[0].body['method'], 'publish_intent');
  assert.ok(t.calls[0].signal instanceof AbortSignal);
  assert.equal(VENUE_WRITE_TIMEOUT_MS, 30_000);

  assert.deepEqual(await client.publishIntent(req), { status: 'FAILED', reason: 'error simulating intents: insufficient balance' });
  await assert.rejects(() => client.publishIntent(req), /status MAYBE, which this app does not know/);
});

test('status carries the word as spelled, the NEAR hash when there is one, and the filled amounts', async () => {
  const t = transport([
    rpc({ intent_hash: 'h1', status: 'PENDING' }),
    rpc({ intent_hash: 'h1', status: 'SETTLED', status_details: 'Settled in block 1', data: { hash: '8yFNEk7GmRcM3NMJihwCKXt8ZANLpL2koVFWWH1MEEj' }, filled_amounts: ['2000000', '1961996', 7] }),
    rpc({ intent_hash: 'h1', status: 'SOMETHING_NEW', data: {} }),
    rpc({ intent_hash: 'h1' }),
  ]);
  const client = relayClient({ fetchImpl: t.fetchImpl, apiKey: '' });
  assert.deepEqual(await client.status('h1'), { intentHash: 'h1', status: 'PENDING', statusDetails: null, nearTxHash: null, filledAmounts: [] });
  assert.deepEqual(await client.status('h1'), {
    intentHash: 'h1',
    status: 'SETTLED',
    statusDetails: 'Settled in block 1',
    nearTxHash: '8yFNEk7GmRcM3NMJihwCKXt8ZANLpL2koVFWWH1MEEj',
    filledAmounts: ['2000000', '1961996'],
  });
  const unknown = await client.status('h1');
  assert.equal(unknown.status, 'SOMETHING_NEW', 'a word this app does not know is passed up as itself');
  await assert.rejects(() => client.status('h1'), /no status word/);
  assert.deepEqual((t.calls[0].body['params'] as unknown[])[0], { intent_hash: 'h1' });
});

test('a hash the relay reports is a base58 string of a hash length, or it is no hash at all', async () => {
  const t = transport([
    rpc({ intent_hash: 'h1', status: 'TX_BROADCASTED', data: { hash: 'javascript:alert(1)' } }),
    rpc({ intent_hash: 'h1', status: 'TX_BROADCASTED', data: { hash: '../../..' } }),
    rpc({ status: 'OK', intent_hash: 'not a hash at all' }),
  ]);
  const client = relayClient({ fetchImpl: t.fetchImpl, apiKey: '' });
  assert.equal((await client.status('h1')).nearTxHash, null);
  assert.equal((await client.status('h1')).nearTxHash, null);
  await assert.rejects(() => client.publishIntent({ quoteHashes: [], standard: 'erc191', payload: '{}', signature: 's' }), /no intent hash/);
});

test('a JSON-RPC error, an HTTP error and an empty body are errors with the relay words in them', async () => {
  const t = transport([{ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Invalid params' } }, { httpStatus: 503, body: null }, 'not json at all']);
  const client = relayClient({ fetchImpl: t.fetchImpl, apiKey: '' });
  await assert.rejects(() => client.status('h1'), /relay get_status failed: Invalid params/);
  await assert.rejects(() => client.status('h1'), /relay get_status failed: 503/);
  await assert.rejects(() => client.status('h1'), /no JSON body|no status word/);
});
