// The deadline, and what `stalled` is and is not.
//
// A card that counts up forever under "Waiting for the venue to credit it" is the app refusing
// to say the one thing a person needs: this is late. So a row says it itself. It is not a
// failure and it is not final: the same balance read that would have settled the row still
// settles it, because a stall is a statement about the clock and never about the money.

import test from 'node:test';
import assert from 'node:assert/strict';

import type { HlRead } from '../../src/ledger/hyperliquid.ts';
import type { Proposal } from '../../src/types.ts';
import { DEADLINE_SEC } from '../../src/proposals/view.ts';
import { makeCtx, railThat, landed, SELF_EVM } from './helpers/proposals.ts';

const POCKET = { venue: 'hyperliquid' as const, symbol: 'USDC', assetId: 'hl-usdc', account: SELF_EVM, decimals: 6, before: '0', after: null, floor: '5000000' };

function hlRead(collateral: number, fetchedAt: string): HlRead {
  return { ok: true, fetchedAt, account: SELF_EVM, collateralUsdc: collateral, availableUsdc: collateral, marginUsedUsd: 0, openPositions: 0, unified: false };
}

async function creditingRow(): Promise<{ h: ReturnType<typeof makeCtx>; row: Proposal; setHl: (r: HlRead | undefined) => void }> {
  let hl: HlRead | undefined;
  const rail = railThat('hl_deposit', async () => ({
    ok: false,
    settling: true,
    detail: 'the venue has not shown the credit inside the window',
    txids: ['0xintent'],
    evidence: { providerStage: 'SUCCESS', handle: 'h1' },
    pocket: POCKET,
  }));
  const h = makeCtx({ rails: [rail] });
  (h.ledger as { hyperliquid: () => HlRead | undefined }).hyperliquid = () => hl;
  const row = await landed(h, h.svc.proposeHlDeposit({ amount: 7.5425 }));
  return { h, row, setHl: (r) => { hl = r; } };
}

test('a row 601 seconds into crediting is marked late, and one a second short of it is not', async () => {
  const { h, row } = await creditingRow();
  const from = Date.parse(row.decidedAt ?? row.createdAt);
  const deadline = from + (DEADLINE_SEC.hl_deposit as number) * 1000;

  assert.equal(h.svc.markStalled(deadline), 0, 'not late until it is past the deadline');
  assert.equal(h.svc.view(h.svc.get(row.id) as Proposal, deadline).stage, 'crediting');

  assert.equal(h.svc.markStalled(deadline + 1000), 1);
  const view = h.svc.view(h.svc.get(row.id) as Proposal, deadline + 1000);
  assert.equal(view.stage, 'stalled');
  assert.equal(view.stageLabel, 'Late, nothing has changed');
  assert.equal(view.terminal, true);
  assert.equal(view.error?.code, 'deadline_passed');
  assert.match(view.error?.message ?? '', /Hyperliquid has not answered/);
  // The counter keeps running from the last real change: a stall that reset it to zero would
  // make the one number behind the word "late" meaningless.
  assert.equal(view.sinceChangeSec > 0, true);
  assert.equal(h.svc.get(row.id)?.status, 'needs_reconciliation', 'the status underneath is untouched');
});

test('a stalled row that is then credited settles forward to confirmed', async () => {
  const { h, row, setHl } = await creditingRow();
  const from = Date.parse(row.decidedAt ?? row.createdAt);
  assert.equal(h.svc.markStalled(from + (DEADLINE_SEC.hl_deposit as number) * 1000 + 1000), 1);
  assert.equal(h.svc.view(h.svc.get(row.id) as Proposal).stage, 'stalled');

  const stalled = h.svc.get(row.id) as Proposal;
  setHl(hlRead(7.0623, new Date(Date.parse(stalled.lastChangeAt ?? stalled.createdAt) + 1000).toISOString()));

  const view = h.svc.view(h.svc.get(row.id) as Proposal);
  assert.equal(view.stage, 'confirmed');
  assert.equal(h.svc.get(row.id)?.status, 'executed');
});

test('a row waiting on a person is never late, however long it sits there', async () => {
  const h = makeCtx({ rails: [railThat('hl_withdraw', async () => ({ ok: true, detail: 'unused' }))] });
  const pending = await h.svc.proposeHlWithdraw({ amount: 20 });
  assert.equal(pending.status, 'pending');
  assert.equal(h.svc.markStalled(Date.parse(pending.createdAt) + 86_400_000), 0);
  assert.equal(h.svc.view(h.svc.get(pending.id) as Proposal).stage, 'waiting_for_you');
});

test('a row is marked late once, not once per sweep', async () => {
  const { h, row } = await creditingRow();
  const late = Date.parse(row.decidedAt ?? row.createdAt) + (DEADLINE_SEC.hl_deposit as number) * 1000 + 1000;
  assert.equal(h.svc.markStalled(late), 1);
  assert.equal(h.svc.markStalled(late + 60_000), 0);
});

test('a stalled row says it still settles forward, so terminal is never read as finished', async () => {
  const { h, row } = await creditingRow();
  const late = Date.parse(row.decidedAt ?? row.createdAt) + (DEADLINE_SEC.hl_deposit as number) * 1000 + 1000;
  assert.equal(h.svc.markStalled(late), 1);

  const view = h.svc.view(h.svc.get(row.id) as Proposal, late);
  assert.equal(view.terminal, true, 'the app has stopped expecting the venue');
  assert.equal(view.settlesForward, true, 'and it is not finished: a credit still settles it');

  // Every other terminal stage is finished, and says so.
  const declined = await (async () => {
    const other = makeCtx({ rails: [railThat('hl_withdraw', async () => ({ ok: true, detail: 'unused' }))] });
    const pending = await other.svc.proposeHlWithdraw({ amount: 20 });
    await other.svc.refuse(pending.id);
    return other.svc.view(other.svc.get(pending.id) as Proposal);
  })();
  assert.equal(declined.terminal, true);
  assert.equal(declined.settlesForward, false);
});

test('the sweep stamps only a row that would read as stalled, not one still inside its rail', async () => {
  const h = makeCtx({ rails: [railThat('hl_withdraw', async () => ({ ok: true, detail: 'done' }))] });
  const pending = await h.svc.proposeHlWithdraw({ amount: 20 });
  // An approved row whose deadline has passed: it waits on the wallet, not on a venue, and
  // stamping it wrote an audit line saying a move was late while changing nothing visible.
  const long = Date.parse(pending.createdAt) + 86_400_000;
  assert.equal(h.svc.markStalled(long), 0);
  assert.equal(h.audit.tail(200).some((e) => e.msg.includes('marked late')), false);
});
