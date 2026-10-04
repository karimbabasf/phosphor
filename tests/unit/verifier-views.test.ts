// The verifier as the chip vault reads it: the simulate report's events and its payload count,
// the key and predecessor views, and which verifier is deployed. Two recorded runs against the
// live 0.4.4 verifier (tests/fixtures/verifier/simulate-0.4.4.json) go through the live port
// byte for byte, so the parser is held to what the chain said, not to a hand-written answer.
// Nothing here touches a network or a key.
//
// Run: node --test tests/unit/verifier-views.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { base58Encode } from '../../src/chain/near.ts';
import {
  SPIKED_VERIFIER,
  isSpikedVerifier,
  isVerifierPublicKey,
  liveVerifier,
  simulationOf,
  verifierEventOf,
  verifierEventOfJson,
  verifierSourceOf,
} from '../../src/relay/verifier.ts';
import type { SignedIntent, VerifierEvent } from '../../src/relay/verifier.ts';

type Recorded = { spike: string; signed: SignedIntent[]; rpcBody: { result: { result?: number[]; error?: string; logs: string[] } } };
const FIXTURE = JSON.parse(fs.readFileSync(new URL('../fixtures/verifier/simulate-0.4.4.json', import.meta.url), 'utf8')) as Record<'run1' | 'run2', Record<string, Recorded>>;

// A fetch that answers every call with one body and keeps what it was asked.
function answering(body: unknown | ((params: Record<string, unknown>) => unknown), status = 200) {
  const asked: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    const params = (JSON.parse(init.body) as { params: Record<string, unknown> }).params;
    const args = typeof params.args_base64 === 'string' ? JSON.parse(Buffer.from(params.args_base64, 'base64').toString('utf8')) : undefined;
    asked.push({ ...params, args });
    const answer = typeof body === 'function' ? (body as (p: Record<string, unknown>) => unknown)({ ...params, args }) : body;
    return { ok: status === 200, status, json: async () => answer } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, asked };
}

// A view's answer as NEAR sends it: the JSON value as an array of UTF-8 bytes.
function viewAnswer(value: unknown): unknown {
  return { jsonrpc: '2.0', id: 1, result: { block_hash: 'H9M37GJZt7SQRhxQPXWTZoMz4V7jwskgDqWUYj8bJzFc', block_height: 218538283, logs: [], result: [...Buffer.from(JSON.stringify(value))] } };
}

function decoded(entry: Recorded): { intents_executed: Array<{ intent_hash: string }>; logs: string[] } {
  return JSON.parse(Buffer.from(Uint8Array.from(entry.rpcBody.result.result!)).toString('utf8'));
}

// The recording run printed each event by name, and the predecessor event with its flag.
function names(events: readonly VerifierEvent[]): string {
  return events.map((e) => (e.event === 'set_auth_by_predecessor_id' ? `${e.event}(enabled=${e.data.enabled})` : e.event)).join(',');
}

const VAULT = '0xbb36a6ccc6d6a7a8929d9e7c06cd1fd305e20fb9';
const CHIP = 'p256:3ipJdQBSAUkyEWBUiszTzPdCkaLwdfi4HyvtVgyP6q8gMSZuXmts9fPbQEVMwVZUSDFwqzgZSemDSxaQ7xtkzVM8';
const RECOVERY = 'secp256k1:4g12EaqVtAmRKk5iXY5UbAJbpQvRnY57UGT6CfrcT7A5HC54deC9td5X2yDF162bXgMsaN1eR7oKs8g83iH1XNgd';
const OLD = 'secp256k1:41dQd2hdKXSMSGXhYnoh8v6b5qcqHh55SYb9Dg3D4kadzsfKbpeWYrBd2TnkbttJRxZkGiHhia1rQacNwj2tNeD1';
const P_A = 'ASgKWtnPLryDQqjsWTajsLhUf4PYSYAqkxWnW3T4xbxP';

test('both recorded runs read through the live port exactly as the recording run printed them', async () => {
  let accepted = 0;
  let refused = 0;
  for (const run of ['run1', 'run2'] as const) {
    for (const [name, entry] of Object.entries(FIXTURE[run])) {
      const { fetchImpl, asked } = answering(entry.rpcBody);
      const sim = await liveVerifier(fetchImpl).simulate!(entry.signed);
      assert.equal(asked[0]!.method_name, 'simulate_intents');
      assert.deepEqual(asked[0]!.args, { signed: entry.signed }, `${run} ${name}: the bundle went out as it was signed`);
      assert.ok(sim !== null, `${run} ${name}: an answer`);
      if (entry.rpcBody.result.result !== undefined) {
        accepted += 1;
        assert.ok(sim.ok, `${run} ${name}: accepted`);
        const events = sim.events ?? [];
        assert.equal(`executed=${sim.intentHashes.length} events=${names(events)} checks=all`, entry.spike, `${run} ${name}`);
        const raw = decoded(entry);
        assert.deepEqual(sim.intentHashes, raw.intents_executed.map((e) => e.intent_hash));
        assert.equal(events.length, raw.logs.length, `${run} ${name}: one event per log line`);
        assert.equal(events.filter((e) => e.event === 'other').length, 0, `${run} ${name}: every line typed`);
        const last = events[events.length - 1]!;
        assert.ok(last.event === 'intents_executed' && last.data.length === entry.signed.length, `${run} ${name}: intents_executed last, one entry per payload`);
      } else {
        refused += 1;
        assert.ok(!sim.ok, `${run} ${name}: refused`);
        // The run printed the RPC's error as a quoted string, cut short for the long ones.
        const printed = entry.spike.replace(/^"/, '').replace(/\\"/g, '"');
        const said = printed.slice(printed.indexOf('panic_msg: "') + 'panic_msg: "'.length).replace(/" \}\)"$/, '');
        assert.ok(sim.refusal.startsWith(said), `${run} ${name}: "${sim.refusal}" is what the run printed`);
      }
    }
  }
  assert.deepEqual({ accepted, refused }, { accepted: 16, refused: 16 });
});

test("the parser reads every key event and the predecessor event of T10, T10r and T10p, each tied to its payload", async () => {
  const sim = simulationOf(decoded(FIXTURE.run2.T10p!), 3);
  assert.ok(sim.ok);
  assert.deepEqual(sim.events!.slice(0, 4), [
    { event: 'public_key_added', data: { intent_hash: P_A, account_id: VAULT, public_key: CHIP } },
    { event: 'public_key_added', data: { intent_hash: P_A, account_id: VAULT, public_key: RECOVERY } },
    { event: 'public_key_removed', data: { intent_hash: P_A, account_id: VAULT, public_key: OLD } },
    { event: 'set_auth_by_predecessor_id', data: { intent_hash: P_A, account_id: VAULT, enabled: false } },
  ]);
  const executed = sim.events![4]!;
  assert.equal(executed.event, 'intents_executed');
  assert.deepEqual(executed.event === 'intents_executed' && executed.data.map((e) => e.intent_hash), sim.intentHashes);
  assert.equal(sim.intentHashes[0], P_A, 'all four ride on P_a, the first payload');

  // T10 and T10r in both runs: the key events and nothing else before intents_executed.
  for (const run of ['run1', 'run2'] as const) {
    const t10 = simulationOf(decoded(FIXTURE[run].T10!), 3);
    const t10r = simulationOf(decoded(FIXTURE[run].T10r!), 6);
    assert.ok(t10.ok && t10r.ok);
    assert.equal(names(t10.events!), 'public_key_added,public_key_added,public_key_removed,intents_executed');
    assert.equal(names(t10r.events!), 'public_key_added,public_key_added,public_key_removed,public_key_added,public_key_added,public_key_removed,public_key_removed,intents_executed');
    // T10r's last four key events are the restore payload's, the fourth payload of six.
    const restore = t10r.intentHashes[3];
    assert.deepEqual(t10r.events!.slice(3, 7).map((e) => e.event !== 'other' && !Array.isArray(e.data) && e.data.intent_hash), [restore, restore, restore, restore]);
  }

  // A second `enabled: false` emits nothing; turning it back on emits the fourth payload's event.
  const again = simulationOf(decoded(FIXTURE.run2['T10p.again']!), 4);
  assert.ok(again.ok);
  assert.equal(again.events!.filter((e) => e.event === 'set_auth_by_predecessor_id').length, 1);
  const chipOn = simulationOf(decoded(FIXTURE.run2['T10p.chipOn']!), 4);
  assert.ok(chipOn.ok);
  assert.deepEqual(chipOn.events![4], { event: 'set_auth_by_predecessor_id', data: { intent_hash: chipOn.intentHashes[3], account_id: VAULT, enabled: true } });
});

test('a payload count that differs from intents_executed is refused, and the old reading is kept without one', async () => {
  const t10p = decoded(FIXTURE.run2.T10p!);
  assert.deepEqual(simulationOf(t10p, 4), { ok: false, refusal: 'the simulation reported 3 executed payloads for 4 signed' });
  assert.deepEqual(simulationOf(t10p, 2), { ok: false, refusal: 'the simulation reported 3 executed payloads for 2 signed' });
  const unnamed = { ...t10p, intents_executed: t10p.intents_executed.map((e, i) => (i === 1 ? { account_id: VAULT } : e)) };
  assert.deepEqual(simulationOf(unnamed, 3), { ok: false, refusal: 'the simulation left 1 of 3 executed payloads without an intent hash' });
  // Without a count, simulationOf answers what it always did (scripts/invite/money.ts reads it so).
  const loose = simulationOf(unnamed);
  assert.ok(loose.ok);
  assert.equal(loose.intentHashes.length, 2);
  assert.deepEqual(simulationOf({ intents_executed: [{ intent_hash: P_A }] }), { ok: true, intentHashes: [P_A] }, 'no logs, no events key');

  // Through the live port the count is the bundle's own length.
  const entry = FIXTURE.run2.T10p!;
  const { fetchImpl } = answering(entry.rpcBody);
  const port = liveVerifier(fetchImpl);
  assert.deepEqual(await port.simulate!([...entry.signed, entry.signed[1]!]), { ok: false, refusal: 'the simulation reported 3 executed payloads for 4 signed' });
  assert.equal((await port.simulate!(entry.signed))?.ok, true);
});

test('event lines: any version reads, anything untyped comes back whole as other', () => {
  const line = (event: string, data: unknown, extra: Record<string, unknown> = {}) => `EVENT_JSON:${JSON.stringify({ standard: 'dip4', version: '0.4.3', event, data, ...extra })}`;
  const key = { intent_hash: P_A, account_id: VAULT, public_key: CHIP };
  assert.deepEqual(verifierEventOf(line('public_key_added', key)), { event: 'public_key_added', data: key });
  // 0.4.2 wrote version 0.3.0 for the same event; the version is never read.
  const old = `EVENT_JSON:${JSON.stringify({ standard: 'dip4', version: '0.3.0', event: 'public_key_removed', data: key })}`;
  assert.deepEqual(verifierEventOf(old), { event: 'public_key_removed', data: key });
  const transfer = { intent_hash: P_A, account_id: VAULT, receiver_id: 'bob.near', tokens: { 'nep141:usdc.near': '1000000' } };
  assert.deepEqual(verifierEventOf(line('transfer', [transfer])), { event: 'transfer', data: [transfer] });
  assert.deepEqual(verifierEventOf(line('transfer', [{ ...transfer, memo: 'rent' }])), { event: 'transfer', data: [{ ...transfer, memo: 'rent' }] });

  const others: Array<[string, unknown]> = [
    ['a plain log', 'Transfer 5 from a to b'],
    ['not JSON', 'EVENT_JSON:{"standard":'],
    ['another standard', `EVENT_JSON:${JSON.stringify({ standard: 'nep245', version: '1.0.0', event: 'mt_transfer', data: [] })}`],
    ['an event no vault bundle makes', line('token_diff', [{ intent_hash: P_A, account_id: VAULT, diff: {} }])],
    ['a key event from a function call, with no intent_hash', line('public_key_added', { account_id: VAULT, public_key: CHIP })],
    ['a field it was not taught', line('public_key_added', { ...key, note: 'x' })],
    ['a key that is not a key', line('public_key_added', { ...key, public_key: 'p256:abc' })],
    ['an account that is not an account', line('public_key_removed', { ...key, account_id: 'Vault' })],
    ['a flag that is not a boolean', line('set_auth_by_predecessor_id', { intent_hash: P_A, account_id: VAULT, enabled: 'false' })],
    ['a transfer with a decimal amount', line('transfer', [{ ...transfer, tokens: { 'nep141:usdc.near': '1.5' } }])],
    ['an empty transfer list', line('transfer', [])],
    ['intents_executed with a nonce that is not 32 bytes', line('intents_executed', [{ intent_hash: P_A, account_id: VAULT, nonce: 'AAAA' }])],
    ['an extra top-level key', line('public_key_added', key, { extra: 1 })],
    ['not a string', { event: 'public_key_added' }],
  ];
  for (const [why, raw] of others) {
    const read = verifierEventOf(raw);
    assert.equal(read.event, 'other', why);
    assert.equal(read.event === 'other' && read.line, typeof raw === 'string' ? raw : JSON.stringify(raw), `${why}: kept whole`);
  }

  // An event a transaction's receipts hand over already parsed reads the same as its line.
  for (const raw of decoded(FIXTURE.run2.T10p!).logs) {
    assert.deepEqual(verifierEventOfJson(JSON.parse(raw.slice('EVENT_JSON:'.length))), verifierEventOf(raw));
  }
  const mt = { standard: 'nep245', version: '1.0.0', event: 'mt_transfer', data: [] };
  assert.deepEqual(verifierEventOfJson(mt), { event: 'other', line: `EVENT_JSON:${JSON.stringify(mt)}` });
});

test('keys are read the way the verifier spells them', () => {
  assert.ok(isVerifierPublicKey(CHIP));
  assert.ok(isVerifierPublicKey(OLD));
  assert.ok(isVerifierPublicKey('ed25519:FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z'));
  const p256Of = (bytes: number) => `p256:${base58Encode(new Uint8Array(bytes).fill(0x77))}`;
  assert.ok(isVerifierPublicKey(p256Of(64)));
  const ed25519Of = (bytes: number) => `ed25519:${base58Encode(new Uint8Array(bytes).fill(0x77))}`;
  assert.ok(isVerifierPublicKey(ed25519Of(32)));
  for (const bad of [p256Of(63), p256Of(65), ed25519Of(31), ed25519Of(64), CHIP.replace('p256', 'secp256r1'), 'p256:', OLD.replace('secp256k1:', 'secp256k1:0'), CHIP.replace(':', ''), 'constructor:abc', 42]) {
    assert.equal(isVerifierPublicKey(bad), false, String(bad));
  }
});

test('the vault views ask the contract by name and read only a clean yes, no or list', async () => {
  const { fetchImpl, asked } = answering((p: Record<string, unknown>) => {
    const method = p.method_name as string;
    if (method === 'has_public_key') return viewAnswer((p.args as { public_key: string }).public_key === OLD);
    if (method === 'public_keys_of') return viewAnswer([CHIP, RECOVERY]);
    return viewAnswer(false);
  });
  const port = liveVerifier(fetchImpl);
  assert.equal(await port.hasPublicKey!(VAULT.toUpperCase().replace('0X', '0x'), OLD), true);
  assert.deepEqual(asked[0], { request_type: 'call_function', finality: 'final', account_id: 'intents.near', method_name: 'has_public_key', args_base64: asked[0]!.args_base64, args: { account_id: VAULT, public_key: OLD } });
  assert.equal(await port.hasPublicKey!(VAULT, CHIP, 'blockhash1'), false);
  assert.equal(asked[1]!.block_id, 'blockhash1', 'read at that block');
  assert.equal(asked[1]!.finality, undefined);
  assert.deepEqual(await port.publicKeysOf!(VAULT), [CHIP, RECOVERY]);
  assert.deepEqual(asked[2]!.args, { account_id: VAULT });
  assert.equal(await port.isAuthByPredecessorIdEnabled!(VAULT), false);
  assert.deepEqual(asked[3]!.args, { account_id: VAULT });
  assert.equal(asked[3]!.method_name, 'is_auth_by_predecessor_id_enabled');
  // A key that is not a key is never sent.
  const before = asked.length;
  assert.equal(await port.hasPublicKey!(VAULT, 'p256:abc'), null);
  assert.equal(asked.length, before);

  for (const [why, body] of [
    ['a list with a non-key in it', viewAnswer([CHIP, 'p256:abc'])],
    ['a list that is not a list', viewAnswer({ keys: [] })],
  ] as const) {
    assert.equal(await liveVerifier(answering(body).fetchImpl).publicKeysOf!(VAULT), null, why);
  }
  assert.equal(await liveVerifier(answering(viewAnswer('true')).fetchImpl).isAuthByPredecessorIdEnabled!(VAULT), null, 'a string is not a yes');
  assert.equal(await liveVerifier(answering(viewAnswer(true), 502).fetchImpl).hasPublicKey!(VAULT, OLD), null, 'an HTTP error is no answer');
});

// The flat failures, as the NEAR RPC sent them on 2026-10-04: a view that ran and failed answers
// HTTP 200 with `result.error` beside the block, never a value.
const FLAT = {
  badAccountId: { jsonrpc: '2.0', result: { block_hash: 'H9M37GJZt7SQRhxQPXWTZoMz4V7jwskgDqWUYj8bJzFc', block_height: 218538283, error: 'wasm execution failed with error: HostError(GuestPanic { panic_msg: "Failed to deserialize input from JSON. Error: `invalid value: \\"0xA1A1\\", the Account ID contains an invalid character \'A\' at index 2 at line 1 column 23`" })', logs: [] }, id: 1 },
  badKey: { jsonrpc: '2.0', result: { block_hash: 'H9M37GJZt7SQRhxQPXWTZoMz4V7jwskgDqWUYj8bJzFc', block_height: 218538283, error: 'wasm execution failed with error: HostError(GuestPanic { panic_msg: "Failed to deserialize input from JSON. Error: `invalid length at line 1 column 82`" })', logs: [] }, id: 1 },
  noMethod: { jsonrpc: '2.0', result: { block_hash: 'F5bSWci3eaa8vW2AVhDw74dPPhhwcTvcNuYsjFfchUUQ', block_height: 218538284, error: 'wasm execution failed with error: MethodResolveError(MethodNotFound)', logs: [] }, id: 1 },
  missingAccount: { jsonrpc: '2.0', result: { block_hash: 'F5bSWci3eaa8vW2AVhDw74dPPhhwcTvcNuYsjFfchUUQ', block_height: 218538284, error: 'access key ed25519:FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z does not exist while viewing', logs: [] }, id: 1 },
  unknownAccount: { jsonrpc: '2.0', error: { name: 'HANDLER_ERROR', cause: { info: { block_hash: 'F5bSWci3eaa8vW2AVhDw74dPPhhwcTvcNuYsjFfchUUQ', block_height: 218538284, requested_account_id: 'b'.repeat(64) }, name: 'UNKNOWN_ACCOUNT' }, code: -32000, message: 'Server error', data: `account ${'b'.repeat(64)} does not exist while viewing` }, id: 1 },
};

test("a flat view failure, the missing-account one among them, is no answer and never a value", async () => {
  for (const [why, body] of Object.entries(FLAT)) {
    const port = liveVerifier(answering(body).fetchImpl);
    assert.equal(await port.hasPublicKey!(VAULT, OLD), null, `${why}: has_public_key`);
    assert.equal(await port.publicKeysOf!(VAULT), null, `${why}: public_keys_of`);
    assert.equal(await port.isAuthByPredecessorIdEnabled!(VAULT), null, `${why}: is_auth_by_predecessor_id_enabled`);
    assert.equal(await port.nonceUsed(VAULT, 'n'), null, `${why}: is_nonce_used`);
    assert.equal(await port.balance(VAULT, 'nep141:usdc.near', 'blockhash1'), null, `${why}: a balance at a block`);
    assert.equal(await port.sourceMetadata!(), null, `${why}: the deployed verifier`);
  }
});

// contract_source_metadata and view_account for intents.near as they answered on 2026-10-04.
// The metadata's build_info (a container digest and the build command) is left out: nothing reads it.
const METADATA = {
  version: '0.4.4',
  link: 'https://github.com/near/intents/tree/a2dd140892b68140bf7e70814604d3ba074d656c',
  standards: [{ standard: 'dip4', version: '0.1.0' }, { standard: 'nep245', version: '1.0.0' }, { standard: 'nep330', version: '1.3.0' }],
};
const ACCOUNT = { amount: '124894964753447687473831213827', block_hash: '2KR9yoTPkcDmdJEkRrTmZVScbmvq7RZDPkTJHhFRy4rz', block_height: 218539660, code_hash: 'EHTzkKyabhTGuKpvET5hBi7xPdKacuesMc91dDGkWvqb', locked: '0', storage_paid_at: 0, storage_usage: 12427357549 };

test('the deployed verifier is named by version and code hash, and only the spiked pair is spiked', async () => {
  const { fetchImpl, asked } = answering((p: Record<string, unknown>) => (p.request_type === 'view_account' ? { jsonrpc: '2.0', id: 1, result: ACCOUNT } : viewAnswer(METADATA)));
  const source = await liveVerifier(fetchImpl).sourceMetadata!();
  assert.deepEqual(source, { version: '0.4.4', link: METADATA.link, codeHash: SPIKED_VERIFIER.codeHash });
  assert.equal(isSpikedVerifier(source!), true);
  assert.deepEqual(asked.map((a) => [a.request_type, a.method_name ?? null, a.account_id]).sort(), [['call_function', 'contract_source_metadata', 'intents.near'], ['view_account', null, 'intents.near']]);

  assert.equal(isSpikedVerifier({ ...source!, version: '0.4.5' }), false, 'a new version');
  assert.equal(isSpikedVerifier({ ...source!, codeHash: '7zv5vXAajgX7XvJorxmeMLE48EuJQdGjTHXSyFmhU2r7' }), false, 'the same version string on other code');
  assert.equal(verifierSourceOf({ ...METADATA, link: undefined }, ACCOUNT)?.link, null);
  assert.equal(verifierSourceOf({ version: 7 }, ACCOUNT), null);
  assert.equal(verifierSourceOf(METADATA, { ...ACCOUNT, code_hash: 'x' }), null);
  assert.equal(verifierSourceOf(METADATA, null), null);
});

test('a balance at a block is the ledger read taken at that block; without one it is the ledger read itself', async () => {
  const { fetchImpl, asked } = answering(viewAnswer(['5000000']));
  const port = liveVerifier(fetchImpl);
  assert.equal(await port.balance(VAULT.toUpperCase().replace('0X', '0x'), 'nep141:usdc.near', 'blockhash1'), 5_000_000n);
  assert.deepEqual([asked[0]!.method_name, asked[0]!.block_id, asked[0]!.args], ['mt_batch_balance_of', 'blockhash1', { account_id: VAULT, token_ids: ['nep141:usdc.near'] }]);
  assert.equal(await port.balance(VAULT, 'nep141:usdc.near'), 5_000_000n);
  assert.deepEqual([asked[1]!.method_name, asked[1]!.finality, asked[1]!.block_id], ['mt_batch_balance_of', 'final', undefined]);
  for (const bad of [['5.0'], [5], [], ['1', '2'], 'x']) {
    assert.equal(await liveVerifier(answering(viewAnswer(bad)).fetchImpl).balance(VAULT, 'nep141:usdc.near', 'b'), null, JSON.stringify(bad));
  }
});
