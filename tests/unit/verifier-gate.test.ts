// The release gate's verifier check (scripts/verifier-gate.ts, run by scripts/release-check.ts at
// --stage signed and printed by scripts/verifier-check.ts): a release refuses an intents.near
// build the chip vault was not spiked on, and refuses when the NEAR RPC gives no answer, until
// someone reruns the spike and pins the new pair. The sign job runs Node's own modules and the
// scripts beside them only (tests/unit/release-workflow.test.ts), so the gate keeps its own copy
// of the pair, the RPC and the account: each is held equal to the app's here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { releaseCheck } from '../../scripts/release-check.ts';
import { NEAR_RPC, NEAR_RPCS, SECOND_NEAR_RPC, SPIKED, VERIFIER_ACCOUNT, agreedVerifier, deployedVerifierOf, isSpiked, readDeployedVerifier, readDeployedVerifiers, verifierProblems } from '../../scripts/verifier-gate.ts';
import type { DeployedVerifier, ProviderAnswer } from '../../scripts/verifier-gate.ts';
import { nearChainSpec } from '../../src/chain/near.ts';
import { INTENTS_VERIFIER } from '../../src/ledger/intents.ts';
import { SPIKED_VERIFIER } from '../../src/relay/verifier.ts';
import { tempDir } from './helpers/tmp.ts';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

// What intents.near answered on 2026-10-04 (spike2, block 218539660).
const METADATA = {
  version: '0.4.5',
  link: 'https://github.com/near/intents/tree/a2dd140892b68140bf7e70814604d3ba074d656c',
  standards: [{ standard: 'dip4', version: '0.1.0' }, { standard: 'nep245', version: '1.0.0' }, { standard: 'nep330', version: '1.3.0' }],
};
const ACCOUNT = { amount: '124894964753447687473831213827', block_hash: '2KR9yoTPkcDmdJEkRrTmZVScbmvq7RZDPkTJHhFRy4rz', block_height: 218539660, code_hash: 'BtA1BEFNS619KkvXFsgcpQ21Tb5yMm32aaUkn7xNothk', locked: '0', storage_paid_at: 0, storage_usage: 12427357549 };
const OTHER_CODE = '7zv5vXAajgX7XvJorxmeMLE48EuJQdGjTHXSyFmhU2r7';

const viewResult = (value: unknown) => ({ result: [...Buffer.from(JSON.stringify(value), 'utf8')], logs: [], block_height: 218539660, block_hash: ACCOUNT.block_hash });

type Asked = { method_name?: string; request_type: string; account_id: string };

// A NEAR RPC that answers the two views, after `busy` answers of HTTP 429.
function rpc(metadata: unknown, account: unknown, busy = 0): { fetchImpl: typeof fetch; asked: Asked[] } {
  const asked: Asked[] = [];
  let left = busy;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const params = (JSON.parse(String(init.body)) as { params: Asked }).params;
    asked.push(params);
    if (left > 0) {
      left -= 1;
      return new Response('busy', { status: 429 });
    }
    const result = params.request_type === 'view_account' ? account : metadata;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, asked };
}

// The two providers' answers, in the gate's order: FastNEAR's, then dRPC's.
const both = (first: DeployedVerifier | null, second: DeployedVerifier | null = first): ProviderAnswer[] => [
  { ...NEAR_RPCS[0]!, deployed: first },
  { ...NEAR_RPCS[1]!, deployed: second },
];
const SPIKED_PAIR: DeployedVerifier = { version: '0.4.5', codeHash: SPIKED.codeHash };

test('the gate pins the same verifier, RPC and account the app does', () => {
  assert.deepEqual({ ...SPIKED }, { ...SPIKED_VERIFIER }, 'rerunning the spike pins the new pair in both places');
  assert.equal(NEAR_RPC, nearChainSpec().rpcUrl);
  assert.equal(VERIFIER_ACCOUNT, INTENTS_VERIFIER);
});

test('the gate asks two keyless NEAR RPCs that two different companies run', () => {
  assert.deepEqual(NEAR_RPCS.map((r) => [r.name, r.url]), [['FastNEAR', NEAR_RPC], ['dRPC', SECOND_NEAR_RPC]]);
  const hosts = NEAR_RPCS.map((r) => new URL(r.url));
  for (const url of hosts) {
    assert.equal(url.protocol, 'https:');
    assert.equal(url.search + url.username + url.password, '', `${url.host}: no key in the address`);
    // FastNEAR runs the near.org endpoints since their 2025 deprecation: never a second voice.
    assert.equal(/(^|\.)near\.org$/.test(url.hostname), false, url.host);
  }
  const roots = hosts.map((u) => u.hostname.split('.').slice(-2).join('.'));
  assert.equal(new Set(roots).size, 2, `one organization behind both: ${roots.join(', ')}`);
});

test('the deployed verifier is read from contract_source_metadata and view_account on intents.near', async () => {
  assert.deepEqual(deployedVerifierOf(viewResult(METADATA), ACCOUNT), { version: '0.4.5', codeHash: SPIKED.codeHash });
  const { fetchImpl, asked } = rpc(viewResult(METADATA), ACCOUNT);
  const deployed = await readDeployedVerifier({ fetchImpl, rpcUrl: 'http://rpc.test', pauseMs: 0 });
  assert.deepEqual(deployed, { version: '0.4.5', codeHash: SPIKED.codeHash });
  assert.equal(isSpiked(deployed!), true);
  assert.deepEqual(asked.map((p) => `${p.request_type} ${p.account_id} ${p.method_name ?? ''}`.trim()).sort(), ['call_function intents.near contract_source_metadata', 'view_account intents.near']);
});

test('a busy RPC is asked again, and an RPC that never answers is no answer, never a verifier', async () => {
  const busy = rpc(viewResult(METADATA), ACCOUNT, 2);
  assert.deepEqual(await readDeployedVerifier({ fetchImpl: busy.fetchImpl, rpcUrl: 'http://rpc.test', pauseMs: 0 }), { version: '0.4.5', codeHash: SPIKED.codeHash });
  const down = (async () => {
    throw new TypeError('fetch failed');
  }) as typeof fetch;
  assert.equal(await readDeployedVerifier({ fetchImpl: down, rpcUrl: 'http://rpc.test', pauseMs: 0 }), null);
  // A view that ran and failed answers flat inside `result`: no answer.
  const panicked = rpc({ error: 'wasm execution failed with error: MethodResolveError(MethodNotFound)', logs: [] }, ACCOUNT);
  assert.equal(await readDeployedVerifier({ fetchImpl: panicked.fetchImpl, rpcUrl: 'http://rpc.test', pauseMs: 0, tries: 2 }), null);
  assert.equal(panicked.asked.length, 4, 'two tries of two views');
  assert.equal(deployedVerifierOf(viewResult(METADATA), { ...ACCOUNT, code_hash: 'not base58 0OIl' }), null);
  assert.equal(deployedVerifierOf(viewResult({ ...METADATA, version: 'v 1' }), ACCOUNT), null);
  assert.equal(deployedVerifierOf(viewResult(METADATA), { ...ACCOUNT, code_hash: '1111' }), null, 'a hash is 32 bytes of base58');
});

test('only the spiked build passes; another version, other code under the same version, or no answer stops a release', () => {
  assert.deepEqual(verifierProblems(both(SPIKED_PAIR)), []);
  const upgraded = verifierProblems(both({ version: '0.4.6', codeHash: OTHER_CODE }));
  assert.equal(upgraded.length, 1);
  assert.match(upgraded[0]!, /intents\.near is 0\.4\.6 \(code 7zv5vX.*\), not 0\.4\.5 \(code BtA1BE.*\), the build the chip vault was spiked on: rerun the spike/);
  assert.match(upgraded[0]!, /scripts\/verifier-gate\.ts and src\/relay\/verifier\.ts/);
  assert.equal(verifierProblems(both({ version: '0.4.5', codeHash: OTHER_CODE })).length, 1, 'the hash pins the build, not the version string');
  const unread = verifierProblems(both(null));
  assert.deepEqual(unread.map((p) => /could not be read from (FastNEAR \(free\.rpc\.fastnear\.com\)|dRPC \(near\.drpc\.org\)): the NEAR RPC did not answer/.test(p)), [true, true]);
});

test('the two providers must agree: one silent, or two answers that differ, fails closed, and the words name both answers', async () => {
  const oneSilent = verifierProblems(both(SPIKED_PAIR, null));
  assert.equal(oneSilent.length, 1);
  assert.match(oneSilent[0]!, /^intents\.near could not be read from dRPC \(near\.drpc\.org\): the NEAR RPC did not answer/);
  const split = verifierProblems(both(SPIKED_PAIR, { version: '0.4.6', codeHash: OTHER_CODE }));
  assert.equal(split.length, 1);
  assert.match(split[0]!, /^the NEAR RPCs disagree about intents\.near: FastNEAR \(free\.rpc\.fastnear\.com\) says 0\.4\.5 \(code BtA1BEFNS619KkvXFsgcpQ21Tb5yMm32aaUkn7xNothk\), dRPC \(near\.drpc\.org\) says 0\.4\.6 \(code 7zv5vXAajgX7XvJorxmeMLE48EuJQdGjTHXSyFmhU2r7\), so nobody can say which build is deployed/);
  // A spiked answer beside a stranger's never passes, whichever provider gives which.
  assert.match(verifierProblems(both({ version: '0.4.5', codeHash: OTHER_CODE }, SPIKED_PAIR))[0]!, /disagree/);
  assert.equal(agreedVerifier(both(SPIKED_PAIR, { version: '0.4.5', codeHash: OTHER_CODE })), null);
  assert.match(verifierProblems([{ ...NEAR_RPCS[0]!, deployed: SPIKED_PAIR }])[0]!, /fewer than two NEAR RPCs/);
  // Each provider is asked at its own address, both views each.
  const asked: string[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const params = (JSON.parse(String(init.body)) as { params: Asked }).params;
    asked.push(`${new URL(url).host} ${params.request_type}`);
    const account = url === SECOND_NEAR_RPC ? { ...ACCOUNT, code_hash: OTHER_CODE } : ACCOUNT;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: params.request_type === 'view_account' ? account : viewResult(METADATA) }), { status: 200 });
  }) as typeof fetch;
  const answers = await readDeployedVerifiers({ fetchImpl, pauseMs: 0 });
  assert.deepEqual(answers.map((a) => [a.name, a.deployed]), [['FastNEAR', SPIKED_PAIR], ['dRPC', { version: '0.4.5', codeHash: OTHER_CODE }]]);
  assert.deepEqual(asked.sort(), ['free.rpc.fastnear.com call_function', 'free.rpc.fastnear.com view_account', 'near.drpc.org call_function', 'near.drpc.org view_account']);
  assert.match(verifierProblems(answers)[0]!, /disagree/);
});

test('the signed stage asks which verifier is deployed and fails on any but the spiked one; the built stage never asks', async () => {
  // An app with no payload: checkApp names that and stops, so only the verifier lines differ.
  const dir = tempDir('verifier-gate-');
  const app = path.join(dir, 'Phosphor.app');
  try {
    const run = async (stage: string, deployed: DeployedVerifier | null, second: DeployedVerifier | null = deployed) => {
      const lines: string[] = [];
      let reads = 0;
      const code = await releaseCheck(['--app', app, '--checkout', ROOT, '--stage', stage], {
        readVerifier: async () => {
          reads += 1;
          return both(deployed, second);
        },
        out: (line) => lines.push(line),
        err: (line) => lines.push(line),
      });
      return { code, text: lines.join('\n'), reads };
    };
    const upgraded = await run('signed', { version: '0.4.6', codeHash: OTHER_CODE });
    assert.equal(upgraded.code, 1);
    assert.equal(upgraded.reads, 1);
    assert.match(upgraded.text, /has no payload at Contents\/Resources\/phosphor/);
    assert.match(upgraded.text, /intents\.near is 0\.4\.6 .*rerun the spike/);
    const unread = await run('signed', null);
    assert.match(unread.text, /intents\.near could not be read/);
    const split = await run('signed', SPIKED_PAIR, { version: '0.4.6', codeHash: OTHER_CODE });
    assert.equal(split.code, 1);
    assert.match(split.text, /the NEAR RPCs disagree about intents\.near/);
    const spiked = await run('signed', { version: '0.4.5', codeHash: SPIKED.codeHash });
    assert.equal(spiked.code, 1, 'the missing payload still fails it');
    assert.doesNotMatch(spiked.text, /intents\.near/);
    const built = await run('built', { version: '0.4.6', codeHash: OTHER_CODE });
    assert.equal(built.reads, 0);
    assert.doesNotMatch(built.text, /intents\.near/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
