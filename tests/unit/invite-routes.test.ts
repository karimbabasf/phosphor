// The two invite routes over real HTTP, on a loopback port with a temp data directory and a temp
// keysPath, against the fake chain in helpers/invite-world.ts. What is held here: the window
// token, the contract's answers, and the code reaching no answer, state, log or Activity row.
// Spec: docs/superpowers/specs/2026-10-01-invite-codes-design.md, "The app" and "Tests".

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

import { createServer } from '../../src/server.ts';
import { createTradeView } from '../../src/trade/view.ts';
import { MAX_AGENTS, createAgents } from '../../src/agents.ts';
import { createAudit } from '../../src/audit.ts';
import { createStore } from '../../src/store.ts';
import { defaultPolicy } from '../../src/policy/file.ts';
import { createMarketData } from '../../src/market/index.ts';
import { createKeystore } from '../../src/keystore/index.ts';
import { defaultParams } from '../../src/keystore/kdf.ts';
import { PROPOSE_KINDS, READ_TOOLS, VIEW_TOOLS } from '../../src/http/context.ts';
import type { Ctx } from '../../src/http/context.ts';
import { INVITE_COUNTERPARTY_LABEL, chainReadsWith } from '../../src/http/read/chain.ts';
import { createChainFetchState } from '../../src/chainscan/index.ts';
import type { AppConfig, LedgerSnapshot } from '../../src/types.ts';
import { inviteLink } from '../../src/invite/code.ts';
import { EXPECTED_TOOLS } from '../tool-surface.ts';
import { stubView } from '../fixtures/view.ts';
import { CODE, CODE_ADDRESS, SECRET, freshWorld, oneclickOf, relayOf, verifierOf } from './helpers/invite-world.ts';
import type { World } from './helpers/invite-world.ts';
import { TEST_QUOTE_KEY } from './helpers/signed-quote.ts';
import { tempDir } from './helpers/tmp.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PASSWORD = 'a long enough password';
const DATA = CODE.slice(5).replace(/-/g, '');
// Every form the parser accepts, for the leak checks and the log tail.
const FORMS = [CODE, CODE.toLowerCase(), `PHOS${DATA}`, CODE.replace(/-/g, ' '), CODE.replace('PHOS', 'PH0S'), inviteLink(CODE)];

function snapshot(): LedgerSnapshot {
  return { mode: 'live', fetchedAt: new Date().toISOString(), prices: {} };
}

type Booted = {
  url: string;
  token: string;
  dataDir: string;
  world: World;
  audit: ReturnType<typeof createAudit>;
  server: ReturnType<typeof createServer>;
  post: (route: string, body: unknown, opts?: { contentType?: string; origin?: string }) => Promise<{ status: number; text: string; json: any }>;
  get: (route: string) => Promise<{ status: number; text: string; json: any }>;
  close: () => Promise<void>;
};

async function boot(): Promise<Booted> {
  const dataDir = tempDir('phosphor-invite-routes-');
  const token = crypto.randomBytes(32).toString('hex');
  process.env.PHOSPHOR_WINDOW_TOKEN = token;
  const keysPath = path.join(dataDir, 'keys', 'keys.json');
  const keystore = createKeystore({ keysPath, mode: 'live', kdf: () => ({ ...defaultParams(), N: 2 ** 14 }) });
  const audit = createAudit(dataDir);
  const world = freshWorld();
  const cfg: AppConfig = { mode: 'live', port: 0, addresses: {}, candleProducts: ['BTC-USD'], dataDir, keysPath };
  const server = createServer({
    cfg,
    audit,
    store: createStore(dataDir),
    keystore,
    riskRows: [],
    ledger: { snapshot, intents: () => undefined, hyperliquid: () => undefined, refresh: async () => snapshot() },
    market: createMarketData({ fetchImpl: (async () => ({ ok: true, json: async () => [], text: async () => '', headers: new Headers() })) as unknown as typeof fetch }),
    proposals: {
      proposePolicyChange: async () => { throw new Error('unused'); },
      proposeSwap: async () => { throw new Error('unused'); },
      proposeHlDeposit: async () => { throw new Error('unused'); },
      proposeHlWithdraw: async () => { throw new Error('unused'); },
      proposeSend: async () => { throw new Error('unused'); },
      proposeTrade: async () => { throw new Error('unused'); },
      proposeTradeChange: async () => { throw new Error('unused'); },
      approve: async () => { throw new Error('unused'); },
      refuse: async () => { throw new Error('unused'); },
      get: () => undefined,
      list: () => [],
      view: (p) => stubView(p),
      markStalled: () => 0,
      sessionSpentUsd: () => 0,
      releaseQueued: async () => 0,
      reconcileOnBoot: () => [],
      reconcileOpen: async () => 0,
      settled: async () => { throw new Error('unused'); },
      reconcile: () => Promise.reject(new Error('not wired in this stub')),
      acknowledge: () => Promise.reject(new Error('not wired in this stub')),
      settle: () => Promise.resolve(true),
      dailyLimit: (capUsd: number) => ({ capUsd, spentUsd: 0, resetsAt: null }),
    },
    getPolicy: () => defaultPolicy(),
    setKill: () => {},
    agents: createAgents(Date.now, MAX_AGENTS, { secret: 's'.repeat(64) }),
    getView: () => 'pro',
    setView: () => {},
    trade: {
      view: createTradeView('BTC'),
      payload: () => ({}) as never,
      read: () => ({}),
      batch: () => [],
      action: async () => ({ ok: false, detail: 'no venue in this test' }),
      plan: () => ({ ok: false as const, error: 'no venue in this test' }),
      meta: () => null,
      mark: () => null,
      free: () => null,
      onUpdate: () => {},
      stop: () => {},
    },
    invite: {
      verifier: verifierOf(world),
      relay: relayOf(world),
      oneclick: oneclickOf(world),
      quoteKey: TEST_QUOTE_KEY,
      now: () => world.mac,
      sleep: async (ms) => {
        world.mac += ms;
        world.chain += ms;
      },
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const read = async (res: Response) => {
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      // not JSON
    }
    return { status: res.status, text, json };
  };
  return {
    url,
    token,
    dataDir,
    world,
    audit,
    server,
    post: async (route, body, opts = {}) =>
      read(
        await fetch(`${url}${route}`, {
          method: 'POST',
          headers: { 'content-type': opts.contentType ?? 'application/json', origin: opts.origin ?? url },
          body: typeof body === 'string' ? body : JSON.stringify(body),
        }),
      ),
    get: async (route) => read(await fetch(`${url}${route}`, { headers: { 'x-phosphor-token': token } })),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// Every byte under a directory, keys file and all, as text.
function everyFile(dir: string): string {
  let out = '';
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    out += entry.isDirectory() ? everyFile(full) : fs.readFileSync(full, 'latin1');
  }
  return out;
}

function assertNoCode(where: string, text: string): void {
  for (const form of [...FORMS, DATA, DATA.toLowerCase(), Buffer.from(SECRET).toString('hex')]) {
    assert.ok(!text.includes(form), `${where} carries the code (${form})`);
  }
}

test('no token, a wrong token or another origin is a 403 on both routes, and the knock carries no code', async () => {
  const b = await boot();
  try {
    for (const route of ['/api/invite/check', '/api/invite/claim']) {
      const none = await b.post(route, { code: CODE });
      assert.equal(none.status, 403);
      const wrong = await b.post(route, { token: 'f'.repeat(64), code: CODE });
      assert.equal(wrong.status, 403);
      const foreign = await b.post(route, { token: b.token, code: CODE }, { origin: 'https://evil.example' });
      assert.equal(foreign.status, 403);
      for (const answer of [none, wrong, foreign]) assertNoCode(`the ${route} refusal`, answer.text);
    }
    assert.equal(b.world.reads, 0, 'nothing was read for a request without the token');
    assertNoCode('the audit log', JSON.stringify(b.audit.tail(200)));
  } finally {
    await b.close();
  }
});

test('the check answers the contract: typo with no network call, then the amount, route and net', async () => {
  const b = await boot();
  try {
    const typo = await b.post('/api/invite/check', { token: b.token, code: CODE.slice(0, -2) });
    assert.deepEqual(typo, { status: 200, text: typo.text, json: { ok: false, reason: 'typo' } });
    assert.equal(b.world.reads, 0);
    for (const form of FORMS) {
      const ok = await b.post('/api/invite/check', { token: b.token, code: form });
      assert.equal(ok.status, 200);
      assert.deepEqual(ok.json, { ok: true, amount: '5.00', asset: 'USDC', route: 'relay', net: '5.00' }, form);
    }
    b.world.balances.set(CODE_ADDRESS, 0n);
    assert.deepEqual((await b.post('/api/invite/check', { token: b.token, code: CODE })).json, { ok: false, reason: 'empty' });
  } finally {
    await b.close();
  }
});

test('a claim needs an open wallet, lands, and the code is in no answer, state, log or Activity row', async () => {
  const b = await boot();
  try {
    const before = await b.post('/api/invite/claim', { token: b.token, code: CODE });
    assert.deepEqual(before.json, { ok: false, reason: 'wallet-locked' });
    assert.equal(before.status, 200);

    const made = await b.post('/api/wallet/create', { token: b.token, password: PASSWORD });
    assert.equal(made.status, 200);
    const wallet = String(made.json.addresses.evm).toLowerCase();

    const claimed = await b.post('/api/invite/claim', { token: b.token, code: inviteLink(CODE) });
    assert.equal(claimed.status, 202);
    assert.equal(claimed.json.ok, true);
    assert.match(claimed.json.claim, /^[0-9a-f]{16}$/);
    await b.server.invites.idle();
    assert.equal(b.world.balances.get(wallet), 5_000_000n, 'the money is in the new wallet');

    const state = await b.get('/api/state');
    assert.deepEqual(state.json.invite, { claim: claimed.json.claim, status: 'landed', amount: '5.00' });
    const log = await b.get('/api/log?limit=500');
    const report = await b.get('/api/log?limit=500&for=report');
    const transactions = await b.get('/api/transactions');
    const receipts = await b.get('/api/receipts');
    for (const [where, text] of [
      ['/api/state', state.text],
      ['/api/log', log.text],
      ['/api/log for a report', report.text],
      ['/api/transactions', transactions.text],
      ['/api/receipts', receipts.text],
      ['the claim answer', claimed.text],
      ['every file in the data directory', everyFile(b.dataDir)],
    ] as const) {
      assertNoCode(where, text);
    }
    const line = (log.json as Array<{ type: string; data: Record<string, unknown> }>).find((e) => e.type === 'invite_claimed');
    assert.ok(line !== undefined);
    assert.equal(line.data.codeAddress, CODE_ADDRESS);
    assert.equal(line.data.receiver, wallet);
    assert.ok(!(log.json as Array<{ type: string }>).some((e) => e.type === 'executed'));

    const receipt = (receipts.json.receipts as Array<Record<string, unknown>>).find((r) => r.kind === 'invite');
    assert.ok(receipt !== undefined, 'Activity has the invite row');
    assert.equal(receipt.headline, 'Invite: +5 USDC');
    assert.equal(receipt.status, 'executed');
    assert.deepEqual(receipt.received, { symbol: 'USDC', amount: 5 });
    const moves = await b.get('/api/receipts?kind=move');
    assert.ok((moves.json.receipts as Array<{ kind: string }>).some((r) => r.kind === 'invite'), 'filed under money moved');

    // A second claim of the same code: used.
    const again = await b.post('/api/invite/claim', { token: b.token, code: CODE });
    assert.deepEqual(again.json, { ok: false, reason: 'empty' });
  } finally {
    await b.close();
  }
});

test('the log tail redacts every accepted form of a code, whoever wrote it', async () => {
  const b = await boot();
  try {
    for (const form of FORMS) b.audit.append('driver_prompt', `the person typed: ${form} please`, { prompt: `use ${form}` });
    for (const route of ['/api/log?limit=50', '/api/log?limit=50&for=report']) {
      const log = await b.get(route);
      assertNoCode(route, log.text);
      assert.ok(log.text.includes('[redacted]'), `${route} redacted nothing`);
      assert.ok(log.text.includes('the person typed:'), `${route} lost the line around the code`);
    }
  } finally {
    await b.close();
  }
});

test('no error quotes the input, whatever is posted', async () => {
  const b = await boot();
  try {
    const nearMiss = CODE.slice(0, -1) + (CODE.endsWith('0') ? '1' : '0');
    const answers = [
      await b.post('/api/invite/check', { token: b.token, code: nearMiss }),
      await b.post('/api/invite/claim', { token: b.token, code: nearMiss }),
      await b.post('/api/invite/check', { token: b.token, code: { nested: CODE } }),
      await b.post('/api/invite/check', `{"token":"${b.token}","code":"${CODE}"`),
      await b.post('/api/invite/claim', `code=${CODE}`, { contentType: 'text/plain' }),
      await b.post('/api/invite/check', { token: b.token, code: `${CODE}${'Z'.repeat(2000)}` }),
    ];
    for (const answer of answers) {
      assertNoCode(`a ${answer.status}`, answer.text);
      assert.ok(!answer.text.includes(nearMiss) && !answer.text.includes(nearMiss.slice(5)), 'a near miss was echoed');
    }
    assertNoCode('the audit log', JSON.stringify(b.audit.tail(200)));
  } finally {
    await b.close();
  }
});

test('the tool surface is unchanged: no agent tool, read or op reaches an invite', () => {
  for (const list of [EXPECTED_TOOLS, READ_TOOLS, VIEW_TOOLS, PROPOSE_KINDS]) {
    assert.ok(!list.some((t) => /invite/i.test(t)), `an invite tool on ${list.join(',')}`);
  }
  for (const file of ['src/mcp.ts', 'src/http/mcp.ts', 'src/http/propose.ts', 'src/http/view.ts']) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    // The agent's door neither imports the claim nor names its routes or the service.
    assert.ok(!/\/api\/invite|invite\/(claim|code|payload|signer|store)|ctx\.invites|invite_(check|claim)/.test(source), `${file} reaches invites`);
  }
});

test("intents_activity labels a counterparty this app claimed an invite from, and nothing else", async () => {
  const audit = createAudit(tempDir('phosphor-invite-label-'));
  audit.append('invite_claimed', 'An invite code paid 5.00 USDC into this wallet.', { claim: 'c1', codeAddress: CODE_ADDRESS, receiver: '0x9858effd232b4033e47d90003d41ec34ecaeda94', asset: 'USDC', amount: '5.00', intentHash: 'h', route: 'relay' });
  const row = (counterparty: string) => ({
    transaction_hash: '9fRHzGWLtKvuGEtGAxkUgFAqZeVmbrPDPSvQETDjZhyZ',
    token_id: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
    base_meta: { symbol: 'USDC', decimals: 6 },
    delta_amount: '5000000',
    cause: 'TRANSFER',
    involved_account_id: counterparty,
    block_timestamp: '1790000000000000000',
  });
  const reads = chainReadsWith({
    fetchImpl: (async () => new Response(JSON.stringify({ data: [row(CODE_ADDRESS), row('0x1111111111111111111111111111111111111111')] }), { status: 200 })) as unknown as typeof fetch,
    state: createChainFetchState(),
    now: () => 1,
    sleep: async () => {},
    reader: () => {
      throw new Error('no rpc in this test');
    },
  });
  let text = '';
  const res = { writeHead: () => res, end: (chunk: unknown) => { text = String(chunk); } } as unknown as http.ServerResponse;
  const ctx = { cfg: { keysPath: '/nonexistent/keys.json', addresses: { evm: '0x9858effd232b4033e47d90003d41ec34ecaeda94' } }, audit } as unknown as Ctx;
  await reads.intents_activity(ctx, {}, {}, res);
  const rows = (JSON.parse(text) as { rows: Array<{ counterparty: string; counterpartyLabel?: string }> }).rows;
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.counterpartyLabel, INVITE_COUNTERPARTY_LABEL);
  assert.equal(rows[1]!.counterpartyLabel, undefined);
});
