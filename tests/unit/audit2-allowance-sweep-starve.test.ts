// audit2 AU2-05: one held no-click row of an agent's no longer holds the sweep off.
//
// The attack: a swap an agent files with a floor above the quote is allowed by the policy, then held
// by the rail (intents-relay.ts price_moved); a held row sits `approved` for up to HELD_MAX_MS (15
// min), retried every 30 s. The sweep used to skip while ANY row was approved, waiting on a Touch ID
// or executing, so every sweep answered "a move is under way" and the allowance stayed above its
// size + 10 % (here $300 on a $100 size, as after a person-approved swap whose proceeds landed
// there), and the agent spent past the $110 line with no click.
// The rule held here (src/rails/allowance-sweep.ts, src/proposals/execute.ts reservedSpends): the
// sweep runs while rows are busy, and keeps the larger of the size and what those rows will spend
// (moveSpend), sending home what is over that plus 10 %. A held row holds back its own spend and no
// more, and a move a person approved keeps its money.
//
// Run: node scripts/run-tests.ts tests/unit/audit2-allowance-sweep-starve.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Proposal } from '../../src/types.ts';
import { USDC, allowanceWorld } from './helpers/allowance-world.ts';
import type { AllowanceWorld } from './helpers/allowance-world.ts';

const usdc = (n: number): bigint => BigInt(Math.round(n * 1e6));
const USDT = 'nep141:usdt.tether-token.near';

/* A no-click $2 swap the agent filed, run to its end, and a copy of its row left `approved` with
   heldSince, the way holdRow (execute.ts) leaves a row the rail held. The double quotes one fixed
   price, so the held state is written the way holdRow writes it. `edit` changes the copy. */
async function heldRow(w: AllowanceWorld, edit: (row: Proposal) => Proposal = (r) => r): Promise<Proposal> {
  const filed = await w.svc.proposeSwap({ chain: 'near', toChain: 'near', fromSymbol: 'USDC', toSymbol: 'USDT', amountIn: '2', by: 'agent-1' } as never);
  const ran = await w.svc.settled(filed.id, 5000);
  assert.equal(ran.decidedBy, 'policy', 'precondition: a no-click move');
  w.rows.put(edit({ ...ran, id: `${ran.id}-held`, status: 'approved', heldSince: new Date().toISOString(), result: undefined, settledAt: undefined } as Proposal));
  w.ledger.reread();
  return w.svc.get(`${ran.id}-held`)!;
}

// The sweep, asked as the timer asks. One the swap's settling started may have been planned before
// the held row was there: its last check refuses for the new row, and the next plans with it in view.
async function sweep(w: AllowanceWorld) {
  const first = await w.svc.sweepAllowance!('timer');
  if (first?.tried === true && first.result.state === 'done') return first;
  return w.svc.sweepAllowance!('timer');
}

test('AU2-05: an agent-held no-click row does not stop the sweep of what is over size + 10 %', async () => {
  const w = await allowanceWorld({ allowanceUsdc: usdc(300), sizeUsd: 100 });
  try {
    const row = await heldRow(w);
    console.log('agent row:', row.status, row.decidedBy, row.by, 'heldSince', row.heldSince);
    const swept = await sweep(w);
    const left = w.chain.balanceOf(w.account, USDC);
    const worth = left + w.chain.balanceOf(w.account, USDT);
    console.log('sweep:', JSON.stringify(swept, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)), 'allowance USDC now', left, 'USDC and USDT', worth);
    assert.ok(swept?.tried === true && swept.result.state === 'done', 'the sweep sent nothing home while an agent row was held');
    assert.ok(left >= usdc(2), `the held row's own 2 USDC stays: ${left}`);
    assert.ok(worth >= usdc(100) && worth <= usdc(110), `the allowance keeps its size and no more than 10 % over it: ${worth}`);

    // The agent spends with no click what is left, and no more.
    const spent: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const r = await w.svc.proposeHlDeposit({ amount: 90, by: 'agent-1' } as never);
      const done = await w.svc.settled(r.id, 5000);
      spent.push(`${done.status}/${done.decidedBy}`);
    }
    console.log('agent no-click hl_deposits of $90:', spent.join(', '), 'allowance USDC now', w.chain.balanceOf(w.account, USDC));
    assert.equal(spent.filter((s) => s.startsWith('executed')).length, 1, `one $90 deposit fits under the size, no second: ${spent.join(', ')}`);
  } finally {
    await w.stop();
  }
});

test('AU2-05: a move that starts between the plan and the signature and spends more than the plan kept stops the sweep at its last check', async () => {
  const w = await allowanceWorld({ allowanceUsdc: usdc(300), sizeUsd: 100 });
  try {
    const big = (r: Proposal): Proposal => {
      const draft = { ...(r.draft as Record<string, unknown>), amountIn: '250', ...('amountInExact' in r.draft ? { amountInExact: '250' } : {}) };
      return { ...r, draft: draft as never, decidedBy: 'human', by: undefined } as Proposal;
    };
    // Let the swap's own after-move sweep run first, then fill the allowance back to $300.
    await sweep(w);
    const row = await heldRow(w, big);
    w.rows.put({ ...row, status: 'refused' });
    w.chain.fund(w.account, USDC, usdc(300) - w.chain.balanceOf(w.account, USDC));
    w.ledger.reread();
    // The person's $250 move becomes approved after the plan is made, before the allowance key signs.
    const salt = w.chain.verifier.currentSalt;
    let planted = false;
    w.chain.verifier.currentSalt = async () => {
      if (!planted) {
        planted = true;
        w.rows.put({ ...row, status: 'approved' });
      }
      return salt();
    };
    const stopped = await w.svc.sweepAllowance!('timer');
    assert.ok(stopped?.tried === true && stopped.result.state === 'refused' && stopped.result.code === 'not_sent', stopped?.tried === true ? stopped.result.state : String(stopped?.why));
    assert.equal(w.chain.balanceOf(w.account, USDC), usdc(300), 'nothing went home');
    // The next sweep plans with the move in view, and keeps its 250.
    const next = await w.svc.sweepAllowance!('timer');
    assert.ok(next?.tried === true && next.result.state === 'done');
    assert.ok(w.chain.balanceOf(w.account, USDC) >= usdc(250));
  } finally {
    await w.stop();
  }
});

test('AU2-05: a move a person approved keeps its money: the sweep keeps its spend and sends home only what is over it plus 10 %', async () => {
  const w = await allowanceWorld({ allowanceUsdc: usdc(300), sizeUsd: 100 });
  try {
    // The same held row, as a person's $250 swap: approved by a click, held by the rail.
    const big = (r: Proposal): Proposal => {
      const draft = { ...(r.draft as Record<string, unknown>), amountIn: '250', ...('amountInExact' in r.draft ? { amountInExact: '250' } : {}) };
      return { ...r, draft: draft as never, decidedBy: 'human', by: undefined } as Proposal;
    };
    await heldRow(w, big);
    const swept = await sweep(w);
    const left = w.chain.balanceOf(w.account, USDC);
    console.log('sweep:', JSON.stringify(swept, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)), 'allowance USDC now', left);
    assert.ok(swept?.tried === true && swept.result.state === 'done', swept?.tried === true ? swept.result.state : String(swept?.why));
    assert.ok(left >= usdc(250), `the person's move keeps its 250 USDC: ${left}`);
    assert.ok(left <= usdc(275), `what is over 250 plus 10 % went home: ${left}`);
  } finally {
    await w.stop();
  }
});
