// One source of truth, asserted: the agent's read and the window's state carry the same object.
//
// This is the assertion the whole build turns on. The card said "Confirmed at 14:20" while the
// agent said "still settling", and both were reading real fields off the same row through two
// different derivations. There is one derivation now, so the two surfaces cannot disagree, and
// the way to hold that true is to compare them byte for byte at one instant.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { createServer } from '../../src/server.ts';
import { createTradeView } from '../../src/trade/view.ts';
import { MAX_AGENTS, createAgents } from '../../src/agents.ts';
import { createAudit } from '../../src/audit.ts';
import { createStore } from '../../src/store.ts';
import { defaultPolicy } from '../../src/policy/file.ts';
import { createMarketData } from '../../src/market/index.ts';
import { createProposalService } from '../../src/proposals.ts';
import { venueAllowlist } from '../../src/rails/index.ts';
import { renderSentences } from '../../src/policy/render.ts';
import { savePolicy } from '../../src/policy/file.ts';
import { loadDemoLedger } from '../../src/ledger/demo.ts';
import type { AppConfig, LedgerSnapshot, Proposal, ProposalView, Rail, RiskRow } from '../../src/types.ts';
import type { ProposalView as View } from '../../src/proposals/view.ts';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const riskRows = (JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'risk-table.json'), 'utf8')) as { rows: RiskRow[] }).rows;
const SELF = '0x1111111111111111111111111111111111111111';
const SEAT = 's'.repeat(64);

const rail: Rail = {
  kind: 'hl_deposit',
  valueUsd: () => 0,
  simulate: async () => ({ ok: true, summary: 'scripted' }),
  execute: async (_draft, _id, hooks) => {
    hooks?.onEvidence?.({ providerStage: 'PROCESSING', handle: 'h1' });
    return {
      ok: false,
      settling: true,
      detail: 'the venue has not shown the credit inside the window',
      txids: ['0xintent'],
      evidence: { providerStage: 'PROCESSING', handle: 'h1' },
      pocket: { venue: 'hyperliquid', symbol: 'USDC', assetId: 'hl-usdc', account: SELF, decimals: 6, before: '0', after: null, floor: '5000000' },
    };
  },
};

async function boot(): Promise<{ url: string; close: () => Promise<void>; id: string }> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-status-view-'));
  const cfg: AppConfig = { mode: 'live', port: 0, addresses: { evm: SELF }, candleProducts: [], dataDir, keysPath: path.join(dataDir, 'keys.json') };
  const snapshot: LedgerSnapshot = { ...loadDemoLedger(), mode: 'live' };
  const ledger = {
    snapshot: () => snapshot,
    intents: () => ({
      ok: true,
      fetchedAt: new Date().toISOString(),
      holdings: [{ accountId: SELF.toLowerCase(), assetId: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near', symbol: 'USDC', originChain: 'eth' as const, amount: 100, decimals: 6 }],
    }),
    hyperliquid: () => undefined,
    refresh: async () => snapshot,
  };
  const policy = defaultPolicy();
  policy.outbound.destinationAllowlist = venueAllowlist();
  policy.sentences = renderSentences(policy);
  savePolicy(dataDir, policy);

  const audit = createAudit(dataDir);
  const store = createStore(dataDir);
  const proposals = createProposalService({
    cfg,
    audit,
    store,
    ledger,
    riskRows,
    dataDir,
    rails: { for: (d) => (d.kind === 'hl_deposit' ? rail : null), kinds: () => ['hl_deposit'] },
  });
  const row = await proposals.settled((await proposals.proposeHlDeposit({ amount: 10 })).id, 5000);

  // The seat secret every op on /api/mcp carries (src/http/mcp.ts), and one occupant in it.
  const agents = createAgents(Date.now, MAX_AGENTS, { secret: SEAT });
  agents.claim({ session: 'unnamed-session', client: 'test' });

  const server = createServer({
    cfg,
    audit,
    store,
    riskRows,
    ledger,
    market: createMarketData({ fetchImpl: (async () => ({ ok: true, json: async () => [], text: async () => '', headers: new Headers() })) as unknown as typeof fetch }),
    proposals,
    getPolicy: () => policy,
    setKill: () => {},
    agents,
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
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, id: row.id, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function get(base: string, route: string): Promise<{ status: number; json: unknown }> {
  const u = new URL(base + route);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: d === '' ? null : JSON.parse(d) }));
    });
    req.on('error', reject);
    req.end();
  });
}

function post(base: string, route: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const u = new URL(base + route);
  const payload = JSON.stringify({ secret: SEAT, ...(body as Record<string, unknown>) });
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), origin: `http://${u.host}` } },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: d === '' ? null : JSON.parse(d) }));
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

test('proposal_status and state.proposals[].view are the same object for the same row', async () => {
  const app = await boot();
  try {
    const read = await post(app.url, '/api/mcp', { op: 'read', tool: 'proposal_status', args: { id: app.id } });
    assert.equal(read.status, 200);
    const fromTool = read.json as View;

    const state = await get(app.url, '/api/state');
    const rows = (state.json as { proposals: Array<Proposal & { view: View }> }).proposals;
    const fromState = rows.find((p) => p.id === app.id)?.view;
    assert.ok(fromState !== undefined, 'every proposal in the state payload carries its view');

    /* The clocks are the one pair that can differ, because they are read against `now` and the
       two calls are milliseconds apart. Everything that describes the row is compared whole. */
    const { elapsedSec: _a, sinceChangeSec: _b, ...toolRest } = fromTool;
    const { elapsedSec: _c, sinceChangeSec: _d, ...stateRest } = fromState;
    assert.deepEqual(stateRest, toolRest);
    assert.ok(Math.abs(fromState.elapsedSec - fromTool.elapsedSec) <= 1);

    assert.equal(fromTool.stage, 'PROCESSING');
    assert.equal(fromTool.stageLabel, 'The router is working');
    assert.equal(fromTool.providerStage, 'PROCESSING');
    assert.equal(fromTool.waitingOn, '1Click');
  } finally {
    await app.close();
  }
});

test('an unknown id is a 404 that names it', async () => {
  const app = await boot();
  try {
    const read = await post(app.url, '/api/mcp', { op: 'read', tool: 'proposal_status', args: { id: 'nope' } });
    assert.equal(read.status, 404);
    assert.match(JSON.stringify(read.json), /nope/);
  } finally {
    await app.close();
  }
});

test('the ProposalView type is re-exported from the shared contract', () => {
  const sample: ProposalView | null = null;
  assert.equal(sample, null);
});
