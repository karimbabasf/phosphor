// scripts/vault-check.ts, the read-only check docs/verify.md gives anyone: who can move a vault,
// asked of two NEAR RPC providers at one final block. It prints an answer only when the two agree,
// and fails closed, naming both answers, when they disagree or one gives none. Every RPC here is a
// fake that answers the way FastNear and dRPC answered live on 2026-10-05.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PROVIDERS, VERIFIER_ACCOUNT, accountIdOf, argsOf, checkVault, exitCodeOf, isPublicKey, report } from '../../scripts/vault-check.ts';
import type { Provider } from '../../scripts/vault-check.ts';
import { nearChainSpec } from '../../src/chain/near.ts';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

// Throwaway keys and account from the spike's second run (tests/fixtures/verifier/simulate-0.4.4.json).
const VAULT = '0xbb36a6ccc6d6a7a8929d9e7c06cd1fd305e20fb9';
const CHIP = 'p256:3ipJdQBSAUkyEWBUiszTzPdCkaLwdfi4HyvtVgyP6q8gMSZuXmts9fPbQEVMwVZUSDFwqzgZSemDSxaQ7xtkzVM8';
const PAPER = 'secp256k1:4g12EaqVtAmRKk5iXY5UbAJbpQvRnY57UGT6CfrcT7A5HC54deC9td5X2yDF162bXgMsaN1eR7oKs8g83iH1XNgd';
const OLD = 'secp256k1:41dQd2hdKXSMSGXhYnoh8v6b5qcqHh55SYb9Dg3D4kadzsfKbpeWYrBd2TnkbttJRxZkGiHhia1rQacNwj2tNeD1';
const STRANGER = 'p256:3H638KALmLxevCpXzDj8dgxEZdV56z3ubYLoxgtb4fQV6fDurM5dsyzAvc67uCBR9kt23PJdB9Li1p6np3UrsJCk';

// Final blocks the providers read live on 2026-10-05, and one at the first's height that is not it.
const LOW = { height: 218617622, hash: '4FzqHTseRPXNDwiQHgghHfqvPnD5CJcQCQNiMtnV8Rkf' };
const HIGH = { height: 218617643, hash: '9YY1z3ZPZx5uz1He4F3HCJxGFJWfnDPVATDK8f7xpWKB' };
const FORK = { height: LOW.height, hash: 'ASgKWtnPLryDQqjsWTajsLhUf4PYSYAqkxWnW3T4xbxP' };
const BLOCKS = [LOW, HIGH, FORK];

const A: Provider = { name: 'A', url: 'http://a.test' };
const B: Provider = { name: 'B', url: 'http://b.test' };

// What a moved vault reads: its chip and its paper, the door shut, the old key off.
const MOVED = { keys: [PAPER, CHIP], auth: false, has: { [OLD]: false, [CHIP]: true } as Record<string, boolean> };

type Script = {
  final: { height: number; hash: string } | 'busy' | 'down';
  state?: { keys: string[]; auth: boolean; has: Record<string, boolean> };
  flat?: string; // a view that ran and failed
  elsewhere?: boolean; // answers a view for another block than the one asked
};
type Asked = { url: string; method: string; params: Record<string, unknown> };

function fakeRpc(scripts: Record<string, Script>): { fetchImpl: typeof fetch; asked: Asked[] } {
  const asked: Asked[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { method: string; params: Record<string, unknown> };
    asked.push({ url, method: body.method, params: body.params });
    const script = scripts[url]!;
    if (script.final === 'down') throw new TypeError('fetch failed');
    if (script.final === 'busy') return new Response('Rate limits exceeded', { status: 429 });
    const reply = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 'vault-check', result }), { status: 200 });
    if (body.method === 'block') return reply({ header: { height: script.final.height, hash: script.final.hash } });
    const block = script.elsewhere ? HIGH : BLOCKS.find((b) => b.hash === body.params.block_id)!;
    const at = { block_height: block.height, block_hash: block.hash, logs: [] };
    const method = String(body.params.method_name);
    if (script.flat === method) return reply({ ...at, error: 'wasm execution failed with error: MethodResolveError(MethodNotFound)' });
    const args = JSON.parse(Buffer.from(String(body.params.args_base64), 'base64').toString('utf8')) as { public_key?: string };
    const state = script.state!;
    const value = method === 'public_keys_of' ? state.keys : method === 'is_auth_by_predecessor_id_enabled' ? state.auth : (state.has[args.public_key!] ?? false);
    return reply({ ...at, result: [...Buffer.from(JSON.stringify(value), 'utf8')] });
  }) as typeof fetch;
  return { fetchImpl, asked };
}

const fast = { providers: [A, B], pauseMs: 0 };

test('two providers that agree at one final block: the keys, the flag, the block, and exit 0', async () => {
  const { fetchImpl, asked } = fakeRpc({ [A.url]: { final: HIGH, state: MOVED }, [B.url]: { final: LOW, state: MOVED } });
  const check = await checkVault('0xBB36a6ccc6d6a7a8929d9e7c06cd1fd305e20fb9', { ...fast, fetchImpl, keys: [OLD] });
  assert.equal(check.ok, true);
  assert.equal(exitCodeOf(check), 0);
  assert.equal(check.account, VAULT, 'an EIP-55 address is asked as the lower case account NEAR stores');
  assert.deepEqual(check.ok && check.block, LOW, 'the lower of the two final blocks, so both providers have it');
  const queries = asked.filter((a) => a.method === 'query');
  assert.equal(queries.length, 6, 'three views from each provider');
  for (const q of queries) {
    assert.equal(q.params.block_id, LOW.hash, 'every view at the one block');
    assert.equal(q.params.finality, undefined);
    assert.equal(JSON.parse(Buffer.from(String(q.params.args_base64), 'base64').toString('utf8')).account_id, VAULT);
  }
  assert.deepEqual(report(check).slice(0, 7), [
    `vault ${VAULT} on intents.near, block ${LOW.height}`,
    'keys it holds: 2',
    `  ${CHIP}  a P-256 key, the kind a Touch ID key is`,
    `  ${PAPER}  a secp256k1 key, the kind an EVM key such as a paper key is`,
    `has ${OLD}: no`,
    'predecessor auth: off',
    'the vault\'s own 0x key is never in that list: ask for it with --key',
  ]);
  const text = report(check).join('\n');
  assert.match(text, /both providers agree:\n  A http:\/\/a\.test: block 218617622 4Fzq\S+, keys p256:\S+ secp256k1:\S+, predecessor auth off, has secp256k1:41dQ\S+: no\n  B http:\/\/b\.test: block 218617622 /);
});

test('a provider that reads other keys or another flag is a disagreement: exit 1, both answers named', async () => {
  for (const other of [{ ...MOVED, keys: [...MOVED.keys, STRANGER] }, { ...MOVED, auth: true }, { ...MOVED, has: { [OLD]: true } }]) {
    const { fetchImpl } = fakeRpc({ [A.url]: { final: LOW, state: MOVED }, [B.url]: { final: LOW, state: other } });
    const check = await checkVault(VAULT, { ...fast, fetchImpl, keys: [OLD] });
    assert.equal(check.ok, false);
    assert.equal(!check.ok && check.why, 'disagree');
    assert.equal(exitCodeOf(check), 1);
    const lines = report(check);
    assert.equal(lines[0], `vault ${VAULT} on intents.near: the two providers disagree, so neither answer can be trusted`);
    assert.match(lines[1]!, /^ {2}A http:\/\/a\.test: block 218617622 .*predecessor auth off, has secp256k1:41dQ\S+: no$/);
    assert.match(lines[2]!, /^ {2}B http:\/\/b\.test: block 218617622 /);
    assert.notEqual(lines[1]!.slice(lines[1]!.indexOf(': ')), lines[2]!.slice(lines[2]!.indexOf(': ')));
  }
});

test('two final blocks at one height with different hashes are a disagreement, and no view is asked', async () => {
  const { fetchImpl, asked } = fakeRpc({ [A.url]: { final: LOW, state: MOVED }, [B.url]: { final: FORK, state: MOVED } });
  const check = await checkVault(VAULT, { ...fast, fetchImpl });
  assert.equal(exitCodeOf(check), 1);
  assert.deepEqual(report(check).slice(1), [`  A http://a.test: final block ${LOW.height} ${LOW.hash}`, `  B http://b.test: final block ${FORK.height} ${FORK.hash}`]);
  assert.equal(asked.filter((a) => a.method === 'query').length, 0);
});

test('a provider that gives no answer fails closed: exit 2, its reason named beside the other answer', async () => {
  const cases: [Script, RegExp][] = [
    [{ final: 'busy' }, /B http:\/\/b\.test: no answer \(block: HTTP 429\)/],
    [{ final: 'down' }, /B http:\/\/b\.test: no answer \(block: fetch failed\)/],
    [{ final: LOW, state: MOVED, flat: 'is_auth_by_predecessor_id_enabled' }, /no answer \(is_auth_by_predecessor_id_enabled: wasm execution failed/],
    [{ final: LOW, state: MOVED, elsewhere: true }, /no answer \(public_keys_of: answered for another block than 218617622\)/],
    [{ final: LOW, state: { ...MOVED, keys: [CHIP, 'p256:short'] } }, /no answer \(public_keys_of: not a list of keys\)/],
  ];
  for (const [script, said] of cases) {
    const { fetchImpl, asked } = fakeRpc({ [A.url]: { final: LOW, state: MOVED }, [B.url]: script });
    const check = await checkVault(VAULT, { ...fast, fetchImpl });
    assert.equal(!check.ok && check.why, 'missing');
    assert.equal(exitCodeOf(check), 2);
    const text = report(check).join('\n');
    assert.match(text, /a provider gave no answer, and one provider alone is not enough/);
    assert.match(text, /A http:\/\/a\.test: block 218617622 \S+, keys p256:\S+ secp256k1:\S+, predecessor auth off/, 'the answer that came is still shown');
    assert.match(text, said);
    if (typeof script.final === 'string') assert.equal(asked.filter((a) => a.url === B.url).length, 3, 'asked three times before it counts as no answer');
  }
});

test('the vault\'s own 0x key is asked by name: a list without it says nothing about it', async () => {
  const unmoved = { keys: [], auth: true, has: { [OLD]: true } };
  const { fetchImpl, asked } = fakeRpc({ [A.url]: { final: LOW, state: unmoved }, [B.url]: { final: LOW, state: unmoved } });
  const check = await checkVault(VAULT, { ...fast, fetchImpl, keys: [OLD, OLD] });
  assert.equal(exitCodeOf(check), 0);
  assert.deepEqual(check.ok && check.named, { [OLD]: true });
  const has = asked.filter((a) => a.params.method_name === 'has_public_key');
  assert.equal(has.length, 2, 'one key asked once of each provider');
  assert.deepEqual(JSON.parse(Buffer.from(String(has[0]!.params.args_base64), 'base64').toString('utf8')), { account_id: VAULT, public_key: OLD });
  const lines = report(check);
  assert.ok(lines.includes('keys it holds: none'));
  assert.ok(lines.includes(`has ${OLD}: yes, it can sign for the vault`));
  assert.ok(lines.includes('predecessor auth: on (the account itself can also act through NEAR)'));
});

test('an account or a key it would not send is refused before anything is asked', async () => {
  const { fetchImpl, asked } = fakeRpc({});
  // A mistyped vault is a valid NEAR name, and the verifier would read it as a vault that never moved.
  for (const account of ['', 'a', '0x zz', 'Bob..near', 'x'.repeat(65), '-bob.near', '0xNOT-AN-ACCOUNT', VAULT.slice(0, 41), `${VAULT}0`]) {
    await assert.rejects(checkVault(account, { ...fast, fetchImpl }), /is not a vault address \(0x and 40 hex characters\) or a NEAR account id/);
  }
  for (const key of ['p256:short', 'ed25519:', CHIP.replace('p256', 'secp256r1'), `${CHIP}0`, PAPER.replace('4g12', '4g1l'), 'p256:' + '1'.repeat(200)]) {
    await assert.rejects(checkVault(VAULT, { ...fast, fetchImpl, keys: [key] }), /is not a public key/);
  }
  assert.equal(asked.length, 0);
  assert.equal(accountIdOf(' 0xBB36A6CCC6D6A7A8929D9E7C06CD1FD305E20FB9 '), VAULT);
  assert.equal(accountIdOf('intents.near'), 'intents.near');
  for (const key of [CHIP, PAPER, OLD, STRANGER]) assert.equal(isPublicKey(key), true);
  assert.deepEqual(argsOf([VAULT, '--key', OLD, '--key', CHIP]), { account: VAULT, keys: [OLD, CHIP] });
  for (const argv of [[], ['--key', OLD], [VAULT, '--key'], [VAULT, VAULT], [VAULT, '--simulate']]) assert.equal(argsOf(argv), null);
});

test('it only reads: one block and views of intents.near, from two organizations, with Node alone', async () => {
  const { fetchImpl, asked } = fakeRpc({ [A.url]: { final: LOW, state: MOVED }, [B.url]: { final: HIGH, state: MOVED } });
  await checkVault(VAULT, { ...fast, fetchImpl, keys: [OLD, CHIP] });
  assert.deepEqual([...new Set(asked.map((a) => a.method))].sort(), ['block', 'query']);
  for (const a of asked.filter((x) => x.method === 'block')) assert.deepEqual(a.params, { finality: 'final' });
  for (const a of asked.filter((x) => x.method === 'query')) {
    assert.equal(a.params.request_type, 'call_function');
    assert.equal(a.params.account_id, VERIFIER_ACCOUNT);
    assert.ok(['public_keys_of', 'is_auth_by_predecessor_id_enabled', 'has_public_key'].includes(String(a.params.method_name)));
  }
  assert.equal(new Set(PROVIDERS.map((p) => new URL(p.url).hostname.split('.').slice(-2).join('.'))).size, 2, 'two organizations, not two names for one');
  assert.ok(PROVIDERS.some((p) => p.url === nearChainSpec().rpcUrl), 'one of them is the RPC the app reads');
  const source = fs.readFileSync(path.join(ROOT, 'scripts', 'vault-check.ts'), 'utf8');
  const imports = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
  assert.ok(imports.length > 0 && imports.every((m) => m!.startsWith('node:')), 'a clone runs it with no npm install');
});
