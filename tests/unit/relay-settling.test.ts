// A relay swap that landed settling has no short fill. Its diff is atomic: the verifier applied
// exactly the signed credit or nothing, so a later read that rose by less than the floor is
// another credit landing in the same window, never this swap filling short. The generic
// judgment (src/proposals/execute.ts judgeSettling) wrote `failed` on that read, and the sweep
// never re-asks a failed row, so a swap the relay had reported SETTLED could end as failed
// with the money there. The relay row stays instead, and the verifier is asked by the nonce.
// The 1Click swap keeps the short fill byte for byte: its transfer can settle short.
//
// Run: node --test tests/unit/relay-settling.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AppConfig, LedgerSnapshot, Policy, Proposal, Rail, RailResult, RiskRow, WriteDraft } from '../../src/types.ts';
import type { Ledger } from '../../src/ledger/index.ts';
import type { RailRegistry } from '../../src/rails/index.ts';
import type { IntentsHolding } from '../../src/ledger/intents.ts';
import type { PocketRead } from '../../src/ledger/settle.ts';
import { SETTLING_SENTENCE } from '../../src/ledger/settle.ts';
import { createAudit } from '../../src/audit.ts';
import { createStore } from '../../src/store.ts';
import { loadDemoLedger } from '../../src/ledger/demo.ts';
import { defaultPolicy, savePolicy } from '../../src/policy/file.ts';
import { renderSentences } from '../../src/policy/render.ts';
import { createProposalService } from '../../src/proposals.ts';
import { venueAllowlist } from '../../src/rails/index.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(path.dirname(__dirname));
const riskRows = (JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'risk-table.json'), 'utf8')) as { rows: RiskRow[] }).rows;

const SELF_EVM = '0x1111111111111111111111111111111111111111';
const ACCOUNT = SELF_EVM.toLowerCase();
const USDT_ASSET = 'nep141:usdt.tether-token.near';
const USDC_ASSET = 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near';
const NONCE = 'Vij2xgAlKBKzADZykFdbpB8CcBXsE9wRhklzE4/mgS8=';

function pocket(): PocketRead {
  return { venue: 'intents', account: ACCOUNT, assetId: USDT_ASSET, symbol: 'USDT', decimals: 6, before: '5000000', after: null, floor: '49500000' };
}

function settlingResult(): RailResult {
  return {
    ok: false,
    settling: true,
    detail: `${SETTLING_SENTENCE} Watched USDT for ${SELF_EVM} inside intents.near for 90s over 31 reads; intent h1.`,
    txids: ['h1'],
    pocket: pocket(),
    evidence: { handle: 'h1', nonce: NONCE, deadline: new Date(Date.now() + 90_000).toISOString(), providerStage: 'SETTLED' },
  };
}

function seededPolicy(): Policy {
  const p = defaultPolicy();
  p.outbound.destinationAllowlist = venueAllowlist();
  p.sentences = renderSentences(p);
  return p;
}

function fakeLedger(): Ledger & { setUsdt(amountBase: string): void } {
  const snapshot: LedgerSnapshot = { ...loadDemoLedger(), mode: 'live' };
  const listeners = new Set<() => void>();
  let usdt = '5000000';
  const holdings = (): IntentsHolding[] => [
    { accountId: ACCOUNT, assetId: USDC_ASSET, symbol: 'USDC', originChain: 'eth', amount: 100, amountBase: '100000000', decimals: 6 },
    { accountId: ACCOUNT, assetId: USDT_ASSET, symbol: 'USDT', originChain: 'near', amount: Number(usdt) / 1e6, amountBase: usdt, decimals: 6 },
  ];
  const ledger = {
    setUsdt(amountBase: string) {
      usdt = amountBase;
    },
    snapshot: () => snapshot,
    intents: () => ({ ok: true, fetchedAt: new Date().toISOString(), holdings: holdings() }),
    hyperliquid: () => undefined,
    refresh: async () => {
      for (const fn of listeners) fn();
      return snapshot;
    },
    onRefresh: (fn: () => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
  return ledger;
}

function spyRail(): { registry: RailRegistry; executed: WriteDraft[] } {
  const executed: WriteDraft[] = [];
  const rail: Rail = {
    kind: 'swap',
    valueUsd: () => 0,
    simulate: async () => ({ ok: true, summary: 'spy rail' }),
    execute: async (draft) => {
      executed.push(draft);
      return settlingResult();
    },
  };
  return { registry: { for: (d) => (d.kind === 'swap' ? rail : null), kinds: () => ['swap'] }, executed };
}

function setup(rail: 'relay' | 'oneclick') {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-relay-settling-'));
  const cfg: AppConfig = { mode: 'live', port: 4177, addresses: { evm: SELF_EVM }, candleProducts: [], dataDir, keysPath: path.join(dataDir, 'keys.json'), swap: { rail } };
  savePolicy(dataDir, seededPolicy());
  const audit = createAudit(dataDir);
  const store = createStore(dataDir);
  const ledger = fakeLedger();
  const rails = spyRail();
  const svc = createProposalService({ cfg, audit, store, ledger, riskRows, rails: rails.registry, dataDir });
  return { svc, store, ledger, rails, lines: () => audit.tail(50).reverse() };
}

const swap = { chain: 'arb' as const, fromSymbol: 'USDC', toSymbol: 'USDT', amountIn: 50, minAmountOut: 49.5 };

async function landed(h: ReturnType<typeof setup>, first: Promise<Proposal>): Promise<Proposal> {
  const p = await first;
  return p.status === 'executing' ? h.svc.settled(p.id, 5_000) : p;
}

test('a relay swap that rose by less than the floor stays settling: no short fill, no failed, the verifier decides', async () => {
  const h = setup('relay');
  const p = await landed(h, h.svc.proposeSwap(swap));
  assert.equal(p.draft.kind === 'swap' ? p.draft.venue : '', 'intents-relay');
  assert.equal(p.status, 'needs_reconciliation');
  h.ledger.setUsdt('6000000');
  await h.ledger.refresh();
  const row = h.store.get(p.id);
  assert.equal(row?.status, 'needs_reconciliation', 'an atomic diff has no short fill');
  assert.equal(row?.result?.detail, p.result?.detail, 'nothing written for a rise that is not this swap');
  assert.equal(row?.result?.evidence?.nonce, NONCE, 'the nonce the sweep asks by is still there');
  assert.equal(h.rails.executed.length, 1, 'nothing signed again');
  assert.equal(h.lines().some((l) => l.type === 'execution_failed'), false);
});

test('a relay swap that rose by the floor or more is executed on that read, as before', async () => {
  const h = setup('relay');
  const p = await landed(h, h.svc.proposeSwap(swap));
  h.ledger.setUsdt('54500000');
  await h.ledger.refresh();
  const row = h.store.get(p.id);
  assert.equal(row?.status, 'executed');
  assert.match(row?.result?.detail ?? '', /rose by 49\.5 USDT/);
  assert.equal(row?.pocket?.after, '54500000');
});

test('a 1Click swap that rose by less than the floor is still the short fill, byte for byte', async () => {
  const h = setup('oneclick');
  const p = await landed(h, h.svc.proposeSwap(swap));
  assert.equal(p.draft.kind === 'swap' ? p.draft.venue : '', 'intents-native');
  h.ledger.setUsdt('6000000');
  await h.ledger.refresh();
  const row = h.store.get(p.id);
  assert.equal(row?.status, 'failed');
  assert.equal(
    row?.result?.detail,
    `A later read shows the balance inside intents.near rose by 1 USDT, below the 49.5 USDT floor this move was approved with (5 before, 6 after). Read the balance for ${ACCOUNT} before signing another.`,
  );
  assert.equal(h.lines().some((l) => l.type === 'execution_failed'), true);
});
