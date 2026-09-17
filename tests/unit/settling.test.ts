// A move the venue confirmed and the balance has not shown yet is SETTLING: a third answer
// beside executed and failed, and the one that keeps a second copy from being signed.
//
// The rail says so with `settling: true` and hands over the pocket it read either side of the
// move. The executor lands the row as needs_reconciliation (it carries a hash, so it counts
// against the cap, and it has a screen), and re-judges it on every ledger refresh against the
// read the wallet panel is about to show: risen by the floor is executed, risen by less is the
// short fill, not risen is left alone. A person clicking re-check gets the same judgment off a
// fresh read. Nothing in here signs anything twice; the spy rail counts.

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

function pocket(over: Partial<PocketRead> = {}): PocketRead {
  return {
    venue: 'intents',
    account: ACCOUNT,
    assetId: USDT_ASSET,
    symbol: 'USDT',
    decimals: 6,
    before: '5000000',
    after: '5000000',
    floor: '99000000',
    ...over,
  };
}

function settlingResult(over: Partial<RailResult> = {}): RailResult {
  return {
    ok: false,
    settling: true,
    detail: `${SETTLING_SENTENCE} Watched USDT for ${SELF_EVM} inside intents.near for 90s over 31 reads; intent 0xintent.`,
    txids: ['0xintent'],
    pocket: pocket(),
    ...over,
  };
}

function seededPolicy(): Policy {
  const p = defaultPolicy();
  p.outbound.destinationAllowlist = venueAllowlist();
  p.sentences = renderSentences(p);
  return p;
}

/* A ledger whose verifier read the test moves by hand, with the refresh listeners the live
   ledger has: refresh() tells them, which is what carries a balance that moved into the row. */
function fakeLedger(): Ledger & { setUsdt(amountBase: string | null): void; refreshes: number } {
  const snapshot: LedgerSnapshot = { ...loadDemoLedger(), mode: 'live' };
  const listeners = new Set<() => void>();
  let usdt: string | null = '5000000';
  const holdings = (): IntentsHolding[] => [
    { accountId: ACCOUNT, assetId: USDC_ASSET, symbol: 'USDC', originChain: 'eth', amount: 100, amountBase: '100000000', decimals: 6 },
    ...(usdt === null
      ? []
      : [{ accountId: ACCOUNT, assetId: USDT_ASSET, symbol: 'USDT', originChain: 'near', amount: Number(usdt) / 1e6, amountBase: usdt, decimals: 6 }]),
  ];
  const ledger = {
    refreshes: 0,
    setUsdt(amountBase: string | null) {
      usdt = amountBase;
    },
    snapshot: () => snapshot,
    intents: () => ({ ok: true, fetchedAt: new Date().toISOString(), holdings: holdings() }),
    hyperliquid: () => undefined,
    refresh: async () => {
      ledger.refreshes += 1;
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

function spyRail(result: RailResult | (() => RailResult)): { registry: RailRegistry; executed: WriteDraft[] } {
  const executed: WriteDraft[] = [];
  const rail: Rail = {
    kind: 'swap',
    valueUsd: () => 0,
    simulate: async () => ({ ok: true, summary: 'spy rail' }),
    execute: async (draft) => {
      executed.push(draft);
      return typeof result === 'function' ? result() : result;
    },
  };
  return { registry: { for: (d) => (d.kind === 'swap' ? rail : null), kinds: () => ['swap'] }, executed };
}

function setup(result: RailResult | ((ledger: ReturnType<typeof fakeLedger>) => RailResult) = settlingResult(), seed: Proposal[] = []) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-settling-'));
  const cfg: AppConfig = {
    mode: 'live',
    port: 4177,
    addresses: { evm: SELF_EVM },
    candleProducts: [],
    dataDir,
    keysPath: path.join(dataDir, 'keys.json'),
  };
  savePolicy(dataDir, seededPolicy());
  const audit = createAudit(dataDir);
  const store = createStore(dataDir);
  for (const p of seed) store.put(p);
  const ledger = fakeLedger();
  const rails = spyRail(typeof result === 'function' ? () => result(ledger) : result);
  const svc = createProposalService({ cfg, audit, store, ledger, riskRows, rails: rails.registry, dataDir });
  return { svc, store, ledger, rails, audit, lines: () => audit.tail(50).reverse() };
}

const swap = { chain: 'arb' as const, fromSymbol: 'USDC', toSymbol: 'USDT', amountIn: 50, minAmountOut: 49.5 };

/* A propose under the click threshold answers with the executing row and runs the rail behind
   it (src/proposals/execute.ts executeRail); the settled row is what these tests judge. */
async function landed(h: ReturnType<typeof setup>, first: Promise<Proposal>): Promise<Proposal> {
  const p = await first;
  return p.status === 'executing' ? h.svc.settled(p.id, 5_000) : p;
}

test('a rail that says settling lands the proposal as needs_reconciliation, with its pocket and without the word failed', async () => {
  const h = setup();
  const p = await landed(h, h.svc.proposeSwap(swap));
  assert.equal(p.verdict.outcome, 'allow', 'under the click threshold, so the rail ran');
  assert.equal(p.status, 'needs_reconciliation');
  assert.equal(p.result?.ok, false);
  assert.match(p.result?.detail ?? '', /balance has not shown it yet/);
  assert.deepEqual(p.pocket, pocket());
  assert.deepEqual(p.result?.txids, ['0xintent']);
  assert.equal(h.rails.executed.length, 1, 'the rail ran once');

  const line = h.lines().find((e) => e.msg.startsWith(`${p.id}:`));
  assert.ok(line !== undefined, 'the audit has the line');
  assert.equal(line?.type, 'execution_unconfirmed', 'the log type is not execution_failed');
  assert.match(line?.msg ?? '', /settling\./);
  assert.doesNotMatch(line?.msg ?? '', /fail/i);
  assert.ok(Math.abs(h.svc.sessionSpentUsd() - 50) < 1e-9, 'a settling row with a hash counts against the cap');
});

test('a later ledger refresh that shows the rise settles the row to executed, and the rail is not asked again', async () => {
  const h = setup();
  const p = await landed(h, h.svc.proposeSwap(swap));
  assert.equal(p.status, 'needs_reconciliation');

  h.ledger.setUsdt('104500000');
  await h.ledger.refresh();

  const done = h.store.get(p.id);
  assert.equal(done?.status, 'executed');
  assert.equal(done?.result?.ok, true);
  assert.match(done?.result?.detail ?? '', /confirmed on a later read/);
  assert.match(done?.result?.detail ?? '', /rose by 99\.5 USDT/);
  assert.match(done?.result?.detail ?? '', /5 before, 104\.5 after/);
  assert.equal(done?.pocket?.after, '104500000');
  assert.deepEqual(done?.result?.txids, ['0xintent'], 'the evidence stays');
  assert.equal(h.rails.executed.length, 1, 'nothing was signed twice');
});

test('a refresh that shows no rise leaves the row exactly as it was', async () => {
  const h = setup();
  const p = await landed(h, h.svc.proposeSwap(swap));
  await h.ledger.refresh();
  await h.ledger.refresh();
  const same = h.store.get(p.id);
  assert.equal(same?.status, 'needs_reconciliation');
  assert.equal(same?.result?.detail, p.result?.detail, 'not rewritten on every poll');
});

test('a later read that rose by less than the floor is the short fill, not a success', async () => {
  const h = setup();
  const p = await landed(h, h.svc.proposeSwap(swap));
  h.ledger.setUsdt('6000000');
  await h.ledger.refresh();
  const short = h.store.get(p.id);
  assert.equal(short?.status, 'failed');
  assert.match(short?.result?.detail ?? '', /rose by 1 USDT, below the 99 USDT floor/);
  assert.match(short?.result?.detail ?? '', /before signing another/);
});

test('re-check on a settling row reads the balance rather than asking a chain about an intent hash', async () => {
  const h = setup();
  const p = await landed(h, h.svc.proposeSwap(swap));

  const still = await h.svc.reconcile(p.id);
  assert.equal(still.status, 'needs_reconciliation');
  assert.match(still.result?.detail ?? '', /Re-read at .*USDT for .* reads 5, not up from 5/);
  assert.ok(still.result?.detail?.startsWith(SETTLING_SENTENCE));
  assert.ok(h.ledger.refreshes >= 1, 'the click took a fresh read');

  h.ledger.setUsdt('104500000');
  const done = await h.svc.reconcile(p.id);
  assert.equal(done.status, 'executed');
  assert.match(done.result?.detail ?? '', /confirmed on a later read/);
});

test('a settling row found on disk at boot is watched too', async () => {
  const seeded: Proposal = {
    id: 'from-last-run',
    kind: 'swap',
    createdAt: new Date().toISOString(),
    status: 'needs_reconciliation',
    draft: { kind: 'swap', venue: 'intents-native', chain: 'near', toChain: 'near', fromSymbol: 'USDC', toSymbol: 'USDT', amountIn: 100, amountUsd: 100, minAmountOut: 99, from: SELF_EVM, to: SELF_EVM, counterparty: 'intents.near', quote: null },
    simulation: null,
    verdict: { outcome: 'allow', reasons: [] },
    decidedBy: 'policy',
    decidedAt: new Date().toISOString(),
    result: { ok: false, detail: SETTLING_SENTENCE, txids: ['0xintent'] },
    pocket: pocket(),
  };
  const h = setup(settlingResult(), [seeded]);
  h.ledger.setUsdt('104500000');
  await h.ledger.refresh();
  assert.equal(h.store.get('from-last-run')?.status, 'executed');
});

// ---------- the receipt's before and after ----------
//
// `balances` used to sum snapshot().holdings, which is always empty on a live ledger, so every
// live receipt read "$0 before, $0 after". The figure is now the pocket the move went through:
// the rail's own reads where it took them, the ledger's read of that pocket otherwise.

async function drained(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

test('a receipt carries the rail\'s own before and after for the pocket that moved, off the read the rail decided on', async () => {
  const h = setup({
    ok: true,
    detail: 'swapped 100 USDC for 99.5 USDT inside intents.near',
    txids: ['0xintent'],
    pocket: pocket({ after: '104500000' }),
  });
  const p = await landed(h, h.svc.proposeSwap(swap));
  assert.equal(p.status, 'executed');
  assert.deepEqual(p.balances, { beforeUsd: 5, afterUsd: 104.5 });
  await drained();
  assert.deepEqual(h.store.get(p.id)?.balances, { beforeUsd: 5, afterUsd: 104.5 }, 'no ledger poll overwrote the rail\'s numbers');
  assert.equal(h.ledger.refreshes, 0, 'the rail already read the after, so no re-read was needed for the receipt');
});

test('without a rail read, the before and after are the intents pocket as the ledger read it, not zero', async () => {
  const h = setup((ledger) => {
    // The move lands while the rail runs; the ledger sees it on the re-read afterwards.
    ledger.setUsdt('104500000');
    return { ok: true, detail: 'spy rail', txids: ['0xintent'] };
  });
  const p = await landed(h, h.svc.proposeSwap(swap));
  assert.equal(p.status, 'executed', p.result?.detail ?? '');
  assert.equal(p.balances?.beforeUsd, 105, '100 USDC and 5 USDT inside the verifier before');
  await drained();
  assert.equal(h.store.get(p.id)?.balances?.afterUsd, 204.5, '100 USDC and 104.5 USDT after the re-read');
  assert.ok(h.ledger.refreshes >= 1, 'the after came off a fresh read');
});

test('a Hyperliquid pocket is priced as its USDC', async () => {
  const h = setup({
    ok: true,
    detail: 'funded',
    txids: ['0xintent'],
    pocket: { venue: 'hyperliquid', account: ACCOUNT, assetId: 'USDC', symbol: 'USDC', decimals: 6, before: '0', after: '9659400', floor: '9600000' },
  });
  const p = await landed(h, h.svc.proposeSwap(swap));
  assert.deepEqual(p.balances, { beforeUsd: 0, afterUsd: 9.6594 });
});

test('a settled row gets its after priced from the read that settled it', async () => {
  const h = setup();
  const p = await landed(h, h.svc.proposeSwap(swap));
  assert.deepEqual(p.balances, { beforeUsd: 5, afterUsd: null }, 'settling: the after is not known yet');
  h.ledger.setUsdt('104500000');
  await h.ledger.refresh();
  assert.deepEqual(h.store.get(p.id)?.balances, { beforeUsd: 5, afterUsd: 104.5 });
});
