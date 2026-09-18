// A read that judges: the view drives the row forward instead of printing beside it.
//
// This is the fix for two sources of truth. The card said "Confirmed at 14:20" while the agent
// said "still settling", and underneath both of them a balance read already showed the money
// had landed. Nothing was wrong with either surface: they were reading a row nobody had judged
// against that balance. Now the read does the judging, so a stage can never contradict a
// balance that is newer than it.

import test from 'node:test';
import assert from 'node:assert/strict';

import type { HlRead } from '../../src/ledger/hyperliquid.ts';
import type { Proposal } from '../../src/types.ts';
import { makeCtx, railThat, landed, SELF_EVM } from './helpers/proposals.ts';

const CREDITED = 7.0623;

// A ledger whose Hyperliquid read the test moves, with a stamp it controls.
function hlRead(collateral: number, fetchedAt: string): HlRead {
  return {
    ok: true,
    fetchedAt,
    account: SELF_EVM,
    collateralUsdc: collateral,
    availableUsdc: collateral,
    marginUsedUsd: 0,
    openPositions: 0,
    unified: false,
  };
}

async function settlingRow(): Promise<{ h: ReturnType<typeof makeCtx>; row: Proposal; setHl: (r: HlRead | undefined) => void }> {
  let hl: HlRead | undefined;
  const rail = railThat('hl_deposit', async () => ({
    ok: false,
    settling: true,
    detail: 'the venue has not shown the credit inside the window',
    txids: ['0xintent'],
    evidence: { providerStage: 'SUCCESS', handle: 'h1' },
    pocket: { venue: 'hyperliquid', symbol: 'USDC', assetId: 'hl-usdc', account: SELF_EVM, decimals: 6, before: '0', after: null, floor: '5000000' },
  }));
  const h = makeCtx({ rails: [rail] });
  // The ledger the service reads. hyperliquid() is what judgeSettling measures the credit on.
  (h.ledger as { hyperliquid: () => HlRead | undefined }).hyperliquid = () => hl;
  const row = await landed(h, h.svc.proposeHlDeposit({ amount: 7.5425 }));
  return { h, row, setHl: (r) => { hl = r; } };
}

test('a crediting row read against a newer balance that rose comes back confirmed', async () => {
  const { h, row, setHl } = await settlingRow();
  assert.equal(row.status, 'needs_reconciliation');
  assert.equal(h.svc.view(row).stage, 'crediting');

  // The money lands, and the ledger's read is stamped after the row last moved.
  setHl(hlRead(CREDITED, new Date(Date.parse(row.lastChangeAt ?? row.createdAt) + 1000).toISOString()));

  const view = h.svc.view(h.svc.get(row.id) as Proposal);
  assert.equal(view.stage, 'confirmed');
  assert.equal(view.terminal, true);
  assert.equal(view.settledAt !== null, true, 'the settle stamped the row');
  assert.equal(h.svc.get(row.id)?.status, 'executed', 'the read wrote the judgment, it did not only report it');
});

test('a balance read older than the last stage change judges nothing', async () => {
  const { h, row, setHl } = await settlingRow();
  setHl(hlRead(CREDITED, new Date(Date.parse(row.lastChangeAt ?? row.createdAt) - 1000).toISOString()));

  const view = h.svc.view(h.svc.get(row.id) as Proposal);
  assert.equal(view.stage, 'crediting');
  assert.equal(h.svc.get(row.id)?.status, 'needs_reconciliation');
});

test('a balance that has not moved leaves the row exactly where it was', async () => {
  const { h, row, setHl } = await settlingRow();
  setHl(hlRead(0, new Date(Date.parse(row.lastChangeAt ?? row.createdAt) + 1000).toISOString()));

  const view = h.svc.view(h.svc.get(row.id) as Proposal);
  assert.equal(view.stage, 'crediting');
  assert.equal(view.waitingOn, 'Hyperliquid');
  assert.equal(h.svc.get(row.id)?.status, 'needs_reconciliation');
});
