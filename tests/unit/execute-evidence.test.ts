// The record exists the moment the evidence does, and the balances on a row are the wallet's.
//
// A rail used to hand back its hash only when it returned, three to five minutes after the
// intent was submitted. A quit or a crash inside that window (SETTLE_CAP_MS is 32 s) left an
// `executing` row with no hash and no handle: the boot sweep could only say "may or may not
// have sent", the cap charged nothing, and reconcile had nothing to ask 1Click about. Now the
// rail hands the executor its evidence through RailHooks.onEvidence as it appears, and the
// executor writes it before the rail's watch loop starts.
//
// And the balances: since 2026-09-09 the live ledger keeps chain holdings empty on purpose
// (the money sits in the verifier and on Hyperliquid), and walletUsd summed those holdings,
// so every receipt read "before $0.00, after $0.00". The total is the wallet's total.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { landed, makeCtx, railThat, slowRail } from './helpers/proposals.ts';

function until(check: () => boolean, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (check()) return resolve(true);
      if (Date.now() - started > ms) return resolve(false);
      setTimeout(tick, 20);
    };
    tick();
  });
}

test('evidence a rail hands back mid-flight is on the row while it is still executing, and the boot sweep keeps it', async () => {
  const slow = slowRail('hl_deposit');
  const h = makeCtx({ rails: [slow.rail] });
  const pending = h.svc.proposeHlDeposit({ amount: 10 });
  await slow.started();
  const hooks = slow.hooks();
  assert.ok(hooks?.onEvidence !== undefined, 'the executor handed the rail no hooks');

  const signedQuote = { correlationId: 'c-1', timestamp: '2026-09-15T00:00:00.000Z', signature: 'ed25519:sig', depositAddress: 'dep1' };
  hooks.onEvidence({ handle: 'dep1', deadline: '2026-09-16T00:00:00.000Z', quote: signedQuote });
  hooks.onEvidence({ txids: ['h1'], handle: 'dep1' });

  const row = h.store.list()[0];
  assert.equal(row.status, 'executing');
  assert.deepEqual(row.result?.txids, ['h1']);
  assert.equal(row.result?.evidence?.handle, 'dep1');
  assert.equal(row.result?.evidence?.deadline, '2026-09-16T00:00:00.000Z');
  // The signed 1Click quote is kept as a rail handed it over, so a dispute has the vendor's own commitment.
  assert.deepEqual(row.result?.evidence?.quote, signedQuote);
  assert.equal(h.eventTypes().filter((t) => t === 'submitted').length, 2, 'each piece of evidence is an audit line');

  // The process dies here. The next boot finds the row with its evidence, not without it.
  const moved = h.svc.reconcileOnBoot();
  assert.equal(moved.length, 1);
  assert.equal(moved[0].status, 'needs_reconciliation');
  assert.deepEqual(moved[0].result?.txids, ['h1']);
  assert.equal(moved[0].result?.evidence?.handle, 'dep1');
  assert.deepEqual(moved[0].result?.evidence?.quote, signedQuote);
  assert.match(moved[0].result?.detail ?? '', /may already have sent/);
  assert.equal(h.svc.dailyLimit(25_000).spentUsd, 10, 'a hash on the row is money that left, and it counts');

  slow.release({ ok: true, detail: 'late', txids: ['h1'] });
  await pending;
});

/* A Hyperliquid withdrawal killed while polling carried its handle and nonce and no pocket, so
   the boot sweep wrote executed on 1Click's SUCCESS alone (review L1, 2026-09-20). The pocket
   rides with the first piece of evidence and the executor keeps it on the executing row. */
test('a pocket a rail hands back mid-flight is on the row while it is still executing, and the boot sweep keeps it', async () => {
  const slow = slowRail('hl_deposit');
  const h = makeCtx({ rails: [slow.rail] });
  const pending = h.svc.proposeHlDeposit({ amount: 10 });
  await slow.started();
  const hooks = slow.hooks();
  assert.ok(hooks?.onEvidence !== undefined, 'the executor handed the rail no hooks');

  const pocket = { venue: 'intents' as const, account: 'acct', assetId: 'asset', symbol: 'USDC', decimals: 6, before: '5000000', after: null, floor: '7718000' };
  hooks.onEvidence({ handle: 'dep1', nonce: '1786600000000', pocket });
  hooks.onEvidence({ handle: 'dep1', providerStage: 'PROCESSING' });

  const row = h.store.list()[0];
  assert.equal(row.status, 'executing');
  assert.deepEqual(row.pocket, pocket, 'the before-read is on the row before the wait');
  assert.equal(row.result?.evidence?.nonce, '1786600000000');
  assert.equal(row.result?.evidence?.providerStage, 'PROCESSING', 'a later piece without a pocket adds to the row');
  assert.deepEqual(h.store.list()[0].pocket, pocket, 'and does not take the pocket off it');

  const moved = h.svc.reconcileOnBoot();
  assert.equal(moved.length, 1);
  assert.equal(moved[0].status, 'needs_reconciliation');
  assert.deepEqual(moved[0].pocket, pocket);

  slow.release({ ok: true, detail: 'late', txids: ['h1'] });
  await pending;
});

/* Every venue poll hands the executor its word, and each hand-over wrote an audit line, rewrote
   proposals.json and sent three frames, changed or not: 151 `submitted` lines over 19 moves in
   the live log, 21 for one of them (R5, 2026-09-23). A piece that changes nothing writes nothing. */
test('evidence that repeats what the row already says writes no audit line and no row', async () => {
  const slow = slowRail('hl_deposit');
  const h = makeCtx({ rails: [slow.rail] });
  const pending = h.svc.proposeHlDeposit({ amount: 10 });
  await slow.started();
  const hooks = slow.hooks();
  assert.ok(hooks?.onEvidence !== undefined, 'the executor handed the rail no hooks');

  const put = h.store.put.bind(h.store);
  let writes = 0;
  h.store.put = (row) => {
    writes += 1;
    return put(row);
  };
  const submitted = () => h.eventTypes().filter((t) => t === 'submitted').length;

  hooks.onEvidence({ handle: 'dep1' });
  hooks.onEvidence({ handle: 'dep1', providerStage: 'PROCESSING' });
  assert.equal(submitted(), 2);
  assert.equal(writes, 2);

  for (let i = 0; i < 5; i += 1) hooks.onEvidence({ providerStage: 'PROCESSING' });
  hooks.onEvidence({ handle: 'dep1' });
  assert.equal(submitted(), 2, 'five polls that said the same word are not five audit lines');
  assert.equal(writes, 2, 'and not five rewrites of proposals.json');

  hooks.onEvidence({ providerStage: 'SUCCESS', txids: ['h1'] });
  assert.equal(submitted(), 3, 'a new word is written the moment it arrives');
  assert.equal(h.store.list()[0].result?.evidence?.providerStage, 'SUCCESS');

  slow.release({ ok: true, detail: 'late', txids: ['h1'] });
  await pending;
});

test('the balance before a move is the wallet total, read from the verifier, not the empty chain holdings', async () => {
  const h = makeCtx({
    intentsUsdc: 24.78,
    rails: [railThat('hl_deposit', async () => ({ ok: true, detail: 'funded', txids: ['h2'] }))],
  });
  const p = await landed(h, h.svc.proposeHlDeposit({ amount: 10 }));
  assert.equal(p.status, 'executed');
  assert.equal(p.balances?.beforeUsd, 24.78);
});

test('the balance before is null, not zero, when the verifier read failed', async () => {
  const h = makeCtx({
    intents: { ok: false, fetchedAt: new Date().toISOString(), holdings: [], error: 'rpc down' },
    rails: [railThat('swap', async () => ({ ok: true, detail: 'swapped', txids: ['h3'] }))],
  });
  const p = await landed(h, h.svc.proposeSwap({ chain: 'arb', fromSymbol: 'USDT', toSymbol: 'USDC', amountIn: 50, minAmountOut: 49 }));
  assert.equal(p.status, 'executed', JSON.stringify(p.verdict));
  assert.equal(p.balances?.beforeUsd, null, 'a total the app could not read is not a total of zero');
});

test('the balance after waits for a ledger read stamped later than the settlement', async () => {
  const h = makeCtx({
    intentsUsdc: 30,
    rails: [railThat('hl_deposit', async () => ({ ok: true, detail: 'funded', txids: ['h4'] }))],
  });
  // The first two reads after the fill are stamped before it: what a refresh that started
  // before the rail returned carries. The third is fresh.
  const stale = new Date(Date.now() - 60_000).toISOString();
  let reads = 0;
  const intents = h.ledger.intents;
  h.ledger.intents = () => {
    const read = intents();
    return read === undefined ? undefined : { ...read, fetchedAt: reads < 3 ? stale : new Date().toISOString() };
  };
  const refresh = h.ledger.refresh;
  h.ledger.refresh = async () => {
    reads += 1;
    return refresh();
  };
  const p = await landed(h, h.svc.proposeHlDeposit({ amount: 10 }));
  assert.equal(p.status, 'executed');
  assert.ok(await until(() => typeof h.store.get(p.id)?.balances?.afterUsd === 'number', 6000), 'the after balance never landed');
  assert.equal(reads, 3, `the after was read on a stale stamp after ${reads} read(s)`);
  assert.equal(h.store.get(p.id)?.balances?.afterUsd, 30);
});
