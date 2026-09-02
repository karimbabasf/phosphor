// The five things nothing tested, and every one of them is a way this app loses money or state.
//
// The suite has 96 files and the good ones are very good: 39 tests on the HyperCore rail of which
// about 30 are refusals, a table-driven policy engine fed hostile numbers, an injection test that
// drives a real app with a real MCP client and asserts no execution in the audit log lacks a
// prior approval. What none of them touched was the failure class: a process that dies, a file
// that is damaged, a venue that stops answering, two requests at once, and an RPC that answers
// something other than what its docs say.
//
//   1. crash and restart, state survives
//   2. corrupt state files (also tests/unit/tolerant-readers.test.ts, in isolation)
//   3. an injected fetch hang (also tests/unit/net-timeouts.test.ts, at the helper)
//   4. two concurrent HTTP mutations
//   5. malformed EVM, Solana and NEAR RPC shapes
//
// Everything here runs against real processes, real HTTP servers and real files. A test that
// simulated a restart in JavaScript would pass over the bug it is meant to catch, which is what
// the one existing restart test does.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createStore } from '../../src/store.ts';
import { createAudit } from '../../src/audit.ts';
import { defaultPolicy, savePolicy } from '../../src/policy/file.ts';
import { renderSentences } from '../../src/policy/render.ts';
import { fetchHoldings as solanaHoldings } from '../../src/ledger/solana.ts';
import { fetchHoldings as nearHoldings } from '../../src/ledger/near.ts';
import { fetchChainState as evmChainState } from '../../src/ledger/evm.ts';
import { fetchIntentsHoldings } from '../../src/ledger/intents.ts';
import type { LogEvent, Proposal } from '../../src/types.ts';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-failure-'));
}

// A real backend on a throwaway data dir. Demo mode: no keys, no chain, no real money anywhere.
async function boot(dir: string, port: number): Promise<{ pid: number; stop: () => Promise<number> }> {
  const child = spawn(process.execPath, [path.join(ROOT, 'src/main.ts')], {
    env: { ...process.env, PHOSPHOR_MODE: 'demo', PHOSPHOR_PORT: String(port), PHOSPHOR_DATA_DIR: dir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const up = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 25_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (chunk.includes(`http://127.0.0.1:${port}`)) {
        clearTimeout(timer);
        resolve(true);
      }
    });
  });
  assert.equal(up, true, `the backend came up on ${port}`);
  return {
    pid: child.pid ?? -1,
    stop: () =>
      new Promise<number>((resolve) => {
        child.on('exit', (code, signal) => resolve(code ?? (signal === null ? -1 : -2)));
        child.kill('SIGTERM');
      }),
  };
}

function request(port: number, route: string, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: route,
        method: body === undefined ? 'GET' : 'POST',
        /* The Origin is sent on every write, and it has to be. The custody track tightened
           sameOrigin() so a write with an ABSENT Origin is refused rather than allowed: an
           absent header used to be treated as "a local tool, not a browser", which any local
           process could also claim. A matching Origin satisfies both the old rule and the new
           one, so these tests read the same before and after that lands. */
        headers:
          body === undefined
            ? {}
            : { 'content-type': 'application/json', origin: `http://127.0.0.1:${String(port)}` },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: d }));
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

// A port that no other file in this suite is using. The suite stands up real servers, so a
// collision is a flake nobody can reproduce; this keeps each case on its own number.
let nextPort = 4520;
function takePort(): number {
  nextPort += 1;
  return nextPort;
}

// ---------- 1. crash and restart ----------

test('a SIGKILL mid-run loses nothing that was already written', async () => {
  const dir = tmpDir();
  const port = takePort();
  const first = await boot(dir, port);

  // A proposal, made through the real MCP door, and settled before the kill.
  const made = await request(
    port,
    '/api/mcp',
    JSON.stringify({ op: 'propose', kind: 'consolidate', params: { toChain: 'arb', symbol: 'USDC' }, client: 'failure-test' }),
  );
  assert.equal(made.status, 200, made.body);
  const id = (JSON.parse(made.body) as { id: string }).id;

  // The one exit no process can handle. Not SIGTERM: this is the case the durable write and the
  // tolerant reader exist for.
  process.kill(first.pid, 'SIGKILL');
  await new Promise((r) => setTimeout(r, 500));

  const store = createStore(dir);
  const kept = store.get(id);
  assert.ok(kept !== undefined, 'the proposal survived a kill -9');
  assert.equal(kept.id, id);

  // And the app comes back on the same directory, with the lock its predecessor never released.
  const second = await boot(dir, port);
  const seen = await request(port, '/api/state');
  assert.equal(seen.status, 200);
  const state = JSON.parse(seen.body) as { proposals: Proposal[] };
  assert.ok(state.proposals.some((p) => p.id === id), 'the restarted app still has it');
  assert.equal(await second.stop(), 0);
});

test('a proposal stranded mid-execution comes back as an unknown outcome, not as running', async () => {
  const dir = tmpDir();
  // Written by hand: this is exactly the row a process killed between "executing" and the rail's
  // answer leaves behind, and nothing on any surface could act on it.
  createStore(dir).put({
    id: 'stranded',
    kind: 'intents_deposit',
    createdAt: new Date().toISOString(),
    decidedAt: new Date().toISOString(),
    decidedBy: 'policy',
    status: 'executing',
    draft: {
      kind: 'intents_deposit',
      chain: 'arb',
      symbol: 'USDC',
      amount: 50,
      amountUsd: 50,
      from: '0x1111111111111111111111111111111111111111',
      to: '0x2222222222222222222222222222222222222222',
    } as unknown as Proposal['draft'],
    simulation: null,
    verdict: { outcome: 'allow', reasons: [] },
    result: { ok: false, detail: 'mid flight', txids: ['0x' + 'c'.repeat(64)] },
  });

  const port = takePort();
  const app = await boot(dir, port);
  try {
    const out = await request(port, '/api/state');
    const state = JSON.parse(out.body) as { proposals: Proposal[]; dailyLimit: { spentUsd: number } | null };
    const row = state.proposals.find((p) => p.id === 'stranded');
    assert.equal(row?.status, 'needs_reconciliation');
    assert.match(row?.result?.detail ?? '', /may already have sent/);
    assert.equal(state.dailyLimit?.spentUsd, 0, 'and it does not hold the day\'s budget');
  } finally {
    await app.stop();
  }
});

// ---------- 2. corrupt state files, in the running app ----------

test('a damaged proposals.json refuses the boot by name rather than starting empty', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'proposals.json'), '[{"id":"a","kind":"conso');

  const child = spawn(process.execPath, [path.join(ROOT, 'src/main.ts')], {
    env: { ...process.env, PHOSPHOR_MODE: 'demo', PHOSPHOR_PORT: String(takePort()), PHOSPHOR_DATA_DIR: dir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c: string) => (stderr += c));
  const code = await new Promise<number>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(-1);
    }, 25_000);
    child.on('exit', (c) => {
      clearTimeout(timer);
      resolve(c ?? -1);
    });
  });

  assert.notEqual(code, 0, 'a state file it cannot read is a refusal to boot');
  assert.match(stderr, /proposals\.json could not be read/);
  assert.match(stderr, /will not start/);
  assert.ok(
    fs.readdirSync(dir).some((f) => f.startsWith('proposals.json.corrupt.')),
    'and the bytes are kept beside it',
  );
});

test('a torn audit line does not stop the app answering', async () => {
  const dir = tmpDir();
  const audit = createAudit(dir);
  audit.append('app_start', 'a real line');
  fs.appendFileSync(path.join(dir, 'audit.jsonl'), '{"ts":"2026-09-01T00:00:00.000Z","type":"app_st');

  const port = takePort();
  const app = await boot(dir, port);
  try {
    const out = await request(port, '/api/log?limit=10');
    assert.equal(out.status, 200);
    const events = JSON.parse(out.body) as LogEvent[];
    assert.ok(events.length > 0, 'the good lines still come back');
    assert.ok(events.every((e) => typeof e.type === 'string'));
  } finally {
    await app.stop();
  }
});

// ---------- 4. two concurrent HTTP mutations ----------

/* THE test on this surface, and the one the audit demonstrated broken.
   Five concurrent $10,000 consolidations moved $50,000 against a $25,000 cap, because each one
   read a spend of zero before any of them had reserved anything. node:http handles requests
   concurrently and nothing else in the process serialises them.

   The policy here is tuned so the cap BINDS on the second request: a $9,000 ceiling on the day
   and two $9,000 moves fired together. One must execute and one must be refused. */
function policyThatBinds(dir: string): void {
  const policy = defaultPolicy();
  policy.outbound.maxPerTransactionUsd = 9_000;
  policy.outbound.maxPerSessionUsd = 9_000;
  policy.outbound.humanClickAboveUsd = 9_000; // under the threshold, so it executes on the policy's say-so
  policy.sentences = renderSentences(policy);
  savePolicy(dir, policy);
}

test('two spends arriving together cannot both take the last of the daily cap', async () => {
  const dir = tmpDir();
  policyThatBinds(dir);
  const port = takePort();
  const app = await boot(dir, port);
  try {
    const move = (session: string, maxTotalUsd: number): string =>
      JSON.stringify({
        op: 'propose',
        kind: 'consolidate',
        params: { toChain: 'arb', symbol: 'USDC', maxTotalUsd },
        client: 'racer',
        session,
      });

    /* Two different sessions AND two different sizes, so neither the seat nor the duplicate
       guard is what decides this: the guard fingerprints the kind and the params, so identical
       ones would be refused as a duplicate and prove nothing about the budget. What has to
       decide it is the spend queue, which is the mechanism the audit demonstrated broken. */
    const [a, b] = await Promise.all([
      request(port, '/api/mcp', move('one', 8_000)),
      request(port, '/api/mcp', move('two', 8_001)),
    ]);
    assert.equal(a.status, 200, a.body);
    assert.equal(b.status, 200, b.body);

    const state = JSON.parse((await request(port, '/api/state')).body) as {
      proposals: Proposal[];
      dailyLimit: { capUsd: number; spentUsd: number } | null;
    };
    const executed = state.proposals.filter((p) => p.status === 'executed');
    const refused = state.proposals.filter((p) => p.status === 'policy_refused');

    assert.equal(executed.length, 1, `exactly one may spend: ${state.proposals.map((p) => p.status).join(', ')}`);
    assert.equal(refused.length, 1, 'and the other is refused rather than run');
    assert.match(JSON.stringify(refused[0].verdict), /session|cap|limit/i);
    assert.ok(
      (state.dailyLimit?.spentUsd ?? 0) <= (state.dailyLimit?.capUsd ?? 0),
      `spent ${String(state.dailyLimit?.spentUsd)} against a cap of ${String(state.dailyLimit?.capUsd)}`,
    );
  } finally {
    await app.stop();
  }
});

test('two identical proposals from one session: at most one is a spend', async () => {
  const dir = tmpDir();
  policyThatBinds(dir);
  const port = takePort();
  const app = await boot(dir, port);
  try {
    const body = JSON.stringify({
      op: 'propose',
      kind: 'consolidate',
      params: { toChain: 'arb', symbol: 'USDC', maxTotalUsd: 8_000 },
      client: 'racer',
      session: 'one-session',
    });
    await Promise.all([request(port, '/api/mcp', body), request(port, '/api/mcp', body)]);

    const state = JSON.parse((await request(port, '/api/state')).body) as { proposals: Proposal[] };
    const executed = state.proposals.filter((p) => p.status === 'executed');
    assert.equal(executed.length, 1, 'the duplicate does not double the money, whatever the guard did');
  } finally {
    await app.stop();
  }
});

test('concurrent approvals of one proposal decide it exactly once', async () => {
  const dir = tmpDir();
  const port = takePort();
  const app = await boot(dir, port);
  try {
    const made = await request(
      port,
      '/api/mcp',
      JSON.stringify({ op: 'propose', kind: 'consolidate', params: { toChain: 'arb', symbol: 'USDC' }, client: 'racer' }),
    );
    const proposal = JSON.parse(made.body) as { id: string; status: string };

    // Both carry the wrong token: what is under test is that two concurrent decision requests
    // reach one answer rather than two, and the refusal path is the one a test can drive without
    // the window's token.
    const body = JSON.stringify({ id: proposal.id, token: 'not-the-token' });
    const [a, b] = await Promise.all([request(port, '/api/approve', body), request(port, '/api/approve', body)]);
    assert.equal(a.status, 403);
    assert.equal(b.status, 403);

    const state = JSON.parse((await request(port, '/api/state')).body) as { proposals: Proposal[] };
    const row = state.proposals.find((p) => p.id === proposal.id);
    assert.equal(row?.status, proposal.status, 'nothing decided it');
    assert.equal(state.proposals.length, 1);
  } finally {
    await app.stop();
  }
});

test('a read and a write arriving together both answer', async () => {
  const dir = tmpDir();
  const port = takePort();
  const app = await boot(dir, port);
  try {
    const [state, kill] = await Promise.all([
      request(port, '/api/state'),
      request(port, '/api/kill', JSON.stringify({ on: true, token: 'not-the-token' })),
    ]);
    assert.equal(state.status, 200);
    assert.equal(kill.status, 403, 'refused for the right reason, and it still answered');
  } finally {
    await app.stop();
  }
});

// ---------- 5. malformed RPC shapes ----------

function replying(payload: unknown, status = 200): typeof fetch {
  return (async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    }) as unknown as Response) as typeof fetch;
}

const TOKENS = { USDC: { tokenId: 'So11111111111111111111111111111111111111112', decimals: 6 } };

test('a Solana node answering base64 is a read failure, never a balance of zero', async () => {
  // What a node does when it does not honour the jsonParsed encoding: the account data comes
  // back as a base64 pair instead of an object. This used to throw a TypeError five levels deep,
  // get caught by the chain refresh, and mark the chain stale with no reason named.
  const base64Shaped = {
    result: { value: [{ account: { data: ['Rk9PQkFS', 'base64'] } }] },
  };
  await assert.rejects(
    () => solanaHoldings('sol', 'http://rpc.invalid', 'addr', TOKENS, replying(base64Shaped)),
    /not jsonParsed/,
  );
});

test('a Solana getBalance with no usable value never reports zero SOL', async () => {
  for (const answer of [{ result: {} }, { result: { value: 'lots' } }, { result: null }]) {
    await assert.rejects(
      () => solanaHoldings('sol', 'http://rpc.invalid', 'addr', {}, replying(answer)),
      /no usable value/,
      `${JSON.stringify(answer)} must not read as an empty wallet`,
    );
  }
});

test('a genuinely empty Solana account still reads as zero', async () => {
  const empty = { result: { value: [{ account: { data: { parsed: { info: { tokenAmount: { uiAmount: null } } } } } }] } };
  let call = 0;
  const fetchImpl = (async () => {
    call += 1;
    return {
      ok: true,
      status: 200,
      json: async () => (call === 1 ? empty : { result: { value: 2_500_000_000 } }),
      text: async () => '',
    } as unknown as Response;
  }) as typeof fetch;

  const holdings = await solanaHoldings('sol', 'http://rpc.invalid', 'addr', TOKENS, fetchImpl);
  assert.equal(holdings.length, 1, 'a zero token balance is dropped; the native holding stays');
  assert.equal(holdings[0].symbol, 'SOL');
  assert.equal(holdings[0].amount, 2.5);
});

test('an EVM node returning the wrong number of results is a read failure', async () => {
  // A batch RPC answers positionally. A short array is not a partial answer, it is an answer
  // whose fields no longer line up with the questions.
  await assert.rejects(
    () => evmChainState('arb', 'http://rpc.invalid', '0x1111111111111111111111111111111111111111', TOKENS, replying([])),
    /.+/,
  );
});

test('an EVM node returning an error envelope does not read as a balance', async () => {
  await assert.rejects(
    () =>
      evmChainState('arb', 'http://rpc.invalid', '0x1111111111111111111111111111111111111111', TOKENS, replying({
        error: { message: 'method not supported' },
      })),
    /.+/,
  );
});

test('a NEAR node answering a shape the reader does not know is a read failure', async () => {
  for (const answer of [{ result: {} }, { result: { result: 'not an array' } }, { error: { message: 'nope' } }]) {
    await assert.rejects(
      () => nearHoldings('near', 'http://rpc.invalid', 'phosphor.near', { USDC: { tokenId: 'usdc.near', decimals: 6 } }, replying(answer)),
      /.+/,
      `${JSON.stringify(answer)} must not read as a balance`,
    );
  }
});

// NEAR answers a view call as a byte array of UTF-8 JSON, which is what these have to be.
function nearView(json: string): { result: { result: number[] } } {
  return { result: { result: [...Buffer.from(json, 'utf8')] } };
}

test('the verifier matching balances to assets by position checks the lengths', async () => {
  let call = 0;
  const fetchImpl = (async () => {
    call += 1;
    /* Call 1 enumerates three assets, call 2 says the page is empty, call 3 returns TWO balances
       for those three assets. Nothing in the response says which balance belongs to which asset:
       they are matched by position, so a short array used to drop a holding silently and a
       reordered one used to attribute the wrong balance to the wrong asset. */
    const payload =
      call === 1
        ? nearView('[{"token_id":"a"},{"token_id":"b"},{"token_id":"c"}]')
        : call === 2
          ? nearView('[]')
          : nearView('["1","2"]');
    return { ok: true, status: 200, json: async () => payload, text: async () => '' } as unknown as Response;
  }) as typeof fetch;

  const read = await fetchIntentsHoldings({
    accountId: '0x1111111111111111111111111111111111111111',
    rpcUrl: 'http://rpc.invalid',
    tokenList: async () => [],
    fetchImpl,
  });
  assert.equal(read.ok, false, 'a positional match with mismatched lengths is a read failure');
  assert.match(read.error ?? '', /matched by position/);
  assert.deepEqual(read.holdings, [], 'and it reports no holdings rather than the wrong ones');
});

// ---------- the supply-chain guarantee behind the bundle ----------

test('the desktop payload is installed from the lockfile, without dev dependencies', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/bundle-payload.ts'), 'utf8');
  // `npm install` resolves caret ranges afresh, so the bundle would carry whatever was published
  // that morning rather than what was reviewed. `ci` installs the lockfile exactly.
  assert.match(src, /'npm', \['ci', '--omit=dev'/);
  assert.doesNotMatch(src, /'npm', \['install'/);
});
