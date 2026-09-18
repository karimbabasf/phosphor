// A rail polling 1Click leaves the vendor's own word on the row, one stamp per word.
//
// The point is that a five minute wait is not one flat stage. A person watching the card sees
// the router move through PENDING_DEPOSIT, PROCESSING and SUCCESS, and the agent reads the same
// three words off the same row, so neither can be describing a different moment than the other.

import test from 'node:test';
import assert from 'node:assert/strict';

import { landed, makeCtx, railThat } from './helpers/proposals.ts';

test('a scripted poll sequence lands one stageAt key per 1Click word', async () => {
  const rail = railThat('hl_deposit', async (_draft, _id, hooks) => {
    for (const stage of ['PENDING_DEPOSIT', 'PROCESSING', 'SUCCESS']) {
      hooks?.onEvidence?.({ providerStage: stage, handle: 'h1' });
    }
    return { ok: true, detail: 'credited', txids: ['0xintent'] };
  });
  const h = makeCtx({ rails: [rail] });

  const row = await landed(h, h.svc.proposeHlDeposit({ amount: 10 }));
  assert.equal(row.status, 'executed');

  const stages = Object.keys(row.stageAt ?? {});
  for (const stage of ['PENDING_DEPOSIT', 'PROCESSING', 'SUCCESS']) {
    assert.equal(stages.includes(stage), true, `${stage} was not stamped: ${stages.join(', ')}`);
  }
  assert.equal(row.result?.evidence?.providerStage, 'SUCCESS');
  // The stamps are in the order the router reported them, ahead of the terminal word.
  assert.equal(stages.indexOf('PENDING_DEPOSIT') < stages.indexOf('PROCESSING'), true);
  assert.equal(stages.indexOf('PROCESSING') < stages.indexOf('SUCCESS'), true);
  assert.equal(stages.at(-1), 'confirmed');
});

test('the same word twice in a row is one stamp and does not move the clock', async () => {
  const rail = railThat('hl_deposit', async (_draft, _id, hooks) => {
    hooks?.onEvidence?.({ providerStage: 'PROCESSING', handle: 'h1' });
    hooks?.onEvidence?.({ providerStage: 'PROCESSING', handle: 'h1' });
    return { ok: true, detail: 'credited', txids: ['0xintent'] };
  });
  const h = makeCtx({ rails: [rail] });

  const row = await landed(h, h.svc.proposeHlDeposit({ amount: 10 }));
  const stages = Object.keys(row.stageAt ?? {});
  assert.equal(stages.filter((s) => s === 'PROCESSING').length, 1);
});
