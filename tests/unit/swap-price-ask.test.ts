// A rail that could not check its price says so, and the move waits for a click (re-audit R-M1).
//
// The relay rail checks every relay quote against 1Click's signed price for the same question
// (src/rails/intents-relay.ts). When there is no signed price to check by, its simulation passes
// with `ask`, and the proposal waits for a click whatever its size (src/proposals/draft.ts). At
// execute the rail holds a move the policy decided and runs one a person clicked, so the executor
// tells it which (RailHooks.decidedBy). Both halves are proven here on a scripted rail.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { DecidedBy, Rail, RailHooks, RailResult } from '../../src/types.ts';
import { UNCHECKED_PRICE_ASK } from '../../src/rails/intents-relay.ts';
import { landed, makeCtx, railThat } from './helpers/proposals.ts';

const SWAP = { chain: 'eth', fromSymbol: 'USDC', toSymbol: 'USDT', amountIn: '20', minAmountOut: 19 };

// A swap rail whose simulation passes, asking for a click when told to, and which records who
// decided each move it runs.
function swapRail(ask: string | undefined, decided: Array<DecidedBy | undefined>): Rail {
  const base = railThat('swap', async (_draft, _id, hooks: RailHooks | undefined): Promise<RailResult> => {
    decided.push(hooks?.decidedBy);
    return { ok: true, detail: 'swapped' };
  });
  return {
    ...base,
    async simulate() {
      return { ok: true, summary: 'scripted swap', ...(ask === undefined ? {} : { ask }) };
    },
  };
}

test('a swap whose price the rail could not check waits for a click under the line, with the sentence that says why', async () => {
  const decided: Array<DecidedBy | undefined> = [];
  const h = makeCtx({ rails: [swapRail(UNCHECKED_PRICE_ASK, decided)] });
  const p = await landed(h, h.svc.proposeSwap(SWAP));
  assert.equal(p.status, 'pending');
  assert.equal(p.verdict.outcome, 'needs_approval');
  assert.equal(p.verdict.reasons.at(-1), UNCHECKED_PRICE_ASK);
  assert.deepEqual(decided, [], 'nothing ran');

  // A click runs it, and the rail is told a person decided.
  const approved = await landed(h, h.svc.approve(p.id));
  assert.equal(approved.status, 'executed', String(approved.result?.detail));
  assert.deepEqual(decided, ['human']);
});

test('the same swap with its price checked runs under the line, and the rail is told the policy decided', async () => {
  const decided: Array<DecidedBy | undefined> = [];
  const h = makeCtx({ rails: [swapRail(undefined, decided)] });
  const p = await landed(h, h.svc.proposeSwap(SWAP));
  assert.equal(p.status, 'executed', String(p.result?.detail));
  assert.equal(p.decidedBy, 'policy');
  assert.deepEqual(decided, ['policy']);
});
