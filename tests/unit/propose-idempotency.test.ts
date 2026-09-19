// A repeat is answered with the row it already made.
//
// Two doors close the same hole. The duplicate guard refuses a caller's own repeat while the
// first is still running, with the id and the state of the row it is repeating. And a proposer
// that sends a clientKey is handed back the proposal that key already made, for a day, from the
// same session and for the same kind: an agent whose reply was lost repeats with the key and
// gets the same row, never a second spend.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeCtx, railThat, slowRail } from './helpers/proposals.ts';
import { makeHttp } from './helpers/http.ts';

function until(check: () => boolean, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (check()) return resolve(true);
      if (Date.now() - started > ms) return resolve(false);
      setTimeout(tick, 10);
    };
    tick();
  });
}

test('a repeat with the same clientKey returns the existing proposal', async () => {
  const h = makeCtx({ rails: [railThat('hl_deposit', async () => ({ ok: true, detail: 'done', txids: ['h1'] }))] });
  const door = makeHttp({ proposals: h.svc, dataDir: h.dataDir });
  const a = await door.post('hl_deposit', { amount: 10, clientKey: 'k1' });
  assert.equal(a.status, 200, JSON.stringify(a.json));
  const b = await door.post('hl_deposit', { amount: 10, clientKey: 'k1' });
  assert.equal(b.status, 200, JSON.stringify(b.json));
  assert.equal(b.json.id, a.json.id);
  assert.equal(h.store.list().length, 1, 'one row, not two');
  assert.equal(h.store.get(String(a.json.id))?.clientKey?.key, 'k1', 'the key is on the row');
  assert.equal(b.json.status, 'executed');
  assert.ok(b.json.result !== undefined, 'the repeat reads the settled row, sentence and all');
});

test('the clientKey is kept out of the duplicate fingerprint, so a different key is a different claim only when the params differ', async () => {
  const h = makeCtx({ rails: [railThat('hl_deposit', async () => ({ ok: true, detail: 'done', txids: ['h1'] }))] });
  const door = makeHttp({ proposals: h.svc, dataDir: h.dataDir });
  const a = await door.post('hl_deposit', { amount: 10, clientKey: 'k1' }, 'agent-a');
  // Another agent, same money, a different key: the ninety second guard still catches it.
  const b = await door.post('hl_deposit', { amount: 10, clientKey: 'k2' }, 'agent-b');
  assert.equal(b.status, 409, JSON.stringify(b.json));
  assert.equal(b.json.duplicate, a.json.id);
  assert.equal(b.json.status, 'executed', 'the refusal says what state the row it names is in');
});

/* The key is scoped to the session that chose it and to the kind it was sent with. It used to be
   one global namespace: agent B filing a withdraw with a key agent A had used for a deposit was
   answered 200 with A's row, read "executed", and its withdraw never ran. Now another session's
   key never matches, another kind under the same key is a new move, and the same key with
   different params is refused rather than answered with a row that moved something else. */
test('a client key is scoped to the session and the kind, and the same key with other params is refused', async () => {
  const h = makeCtx({ rails: [railThat('hl_deposit', async () => ({ ok: true, detail: 'done', txids: ['h1'] }))] });
  const door = makeHttp({ proposals: h.svc, dataDir: h.dataDir });
  const a = await door.post('hl_deposit', { amount: 10, clientKey: 'retry-1' }, 'agent-a');
  assert.equal(a.status, 200, JSON.stringify(a.json));

  // Another session, the same key, another kind: its own row, never A's.
  const b = await door.post('hl_withdraw', { amount: 80, clientKey: 'retry-1' }, 'agent-b');
  assert.equal(b.status, 200, JSON.stringify(b.json));
  assert.notEqual(b.json.id, a.json.id, 'another session with the same key gets its own row');
  assert.equal(h.store.get(String(b.json.id))?.kind, 'hl_withdraw', 'and its own move');

  // Another session, the same key, the same kind, other money: its own row too.
  const c = await door.post('hl_deposit', { amount: 11, clientKey: 'retry-1' }, 'agent-b');
  assert.equal(c.status, 200, JSON.stringify(c.json));
  assert.notEqual(c.json.id, a.json.id, 'a key never reaches across sessions');

  // The same session, the same key, another kind: a new move under the same key.
  const d = await door.post('hl_withdraw', { amount: 5, clientKey: 'retry-1' }, 'agent-a');
  assert.equal(d.status, 200, JSON.stringify(d.json));
  assert.notEqual(d.json.id, a.json.id, 'the key is per kind');

  // The same session, the same key, the same kind, a different amount: refused, naming the row.
  const e = await door.post('hl_deposit', { amount: 20, clientKey: 'retry-1' }, 'agent-a');
  assert.equal(e.status, 409, JSON.stringify(e.json));
  assert.equal(e.json.existing, a.json.id);
  assert.match(String(e.json.error), new RegExp(String(a.json.id)));

  // And the true repeat is still the row it already made.
  const f = await door.post('hl_deposit', { amount: 10, clientKey: 'retry-1' }, 'agent-a');
  assert.equal(f.status, 200, JSON.stringify(f.json));
  assert.equal(f.json.id, a.json.id);
  assert.equal(h.store.list().length, 4, 'four moves were made, and the refusal and the repeat made none');
});

test('a malformed clientKey is refused at the door before anything is drafted', async () => {
  const h = makeCtx({ rails: [railThat('hl_deposit', async () => ({ ok: true, detail: 'done' }))] });
  const door = makeHttp({ proposals: h.svc, dataDir: h.dataDir });
  for (const bad of ['', 'a'.repeat(65), 'has space', 'semi;colon', 42]) {
    const r = await door.post('hl_deposit', { amount: 10, clientKey: bad });
    assert.equal(r.status, 400, `clientKey ${JSON.stringify(bad)} was accepted`);
    assert.match(String(r.json.error), /clientKey/);
  }
  assert.equal(h.store.list().length, 0);
});

test('the same session repeating while the first is still running is refused with the live row', async () => {
  const slow = slowRail('hl_deposit');
  const h = makeCtx({ rails: [slow.rail] });
  const door = makeHttp({ proposals: h.svc, dataDir: h.dataDir });
  // The first reply outlives the cap in the incident; here the door is not awaited so the repeat
  // can arrive while the rail is out.
  const first = door.post('hl_deposit', { amount: 10 }, 'agent-a');
  await slow.started();
  // The row exists and the guard knows its id; the rail is still out.
  await until(() => (door.duplicates.find('hl_deposit', { amount: 10 }, 'someone-else')?.id ?? '') !== '', 2000);
  const again = await door.post('hl_deposit', { amount: 10 }, 'agent-a');
  assert.equal(again.status, 409, JSON.stringify(again.json));
  assert.equal(again.json.status, 'executing');
  assert.match(String(again.json.error), /proposal_status/);
  assert.equal(h.store.list().length, 1, 'one row, not two');

  // The first reply is the decision, so it is already in hand while the rail is out: it says
  // `executing` and the settled row appears on the store when the rail answers.
  const reply = await first;
  assert.equal(reply.json.status, 'executing');
  assert.equal(again.json.duplicate, reply.json.id);

  slow.release({ ok: true, detail: 'done', txids: ['h1'] });
  await h.svc.settle(5_000);
  assert.equal(h.store.get(String(reply.json.id))?.status, 'executed');
});

/* The window holds for an UNCONFIRMED first move too. needs_reconciliation read as terminal, so
   once the first $10 landed unconfirmed with its handle, an identical repeat a second later from
   the same session walked through the guard and the daily ceiling was the only wall left. */
test('a same-session repeat of a move that landed unconfirmed is refused with the first row and told not to send again', async () => {
  const h = makeCtx({
    rails: [railThat('hl_deposit', async () => ({ ok: false, detail: '1click reported SUCCESS but the venue has not shown it; quote handle dep-1.', txids: ['intent-h1'], evidence: { handle: 'dep-1' } }))],
  });
  const door = makeHttp({ proposals: h.svc, dataDir: h.dataDir });
  const first = await door.post('hl_deposit', { amount: 10 }, 'agent-a');
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.equal(first.json.status, 'executing', 'the reply is the decision, and the rail answers behind it');
  await h.svc.settle(5_000);
  assert.equal(h.store.get(String(first.json.id))?.status, 'needs_reconciliation');

  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const again = await door.post('hl_deposit', { amount: 10 }, 'agent-a');
  assert.equal(again.status, 409, JSON.stringify(again.json));
  assert.equal(again.json.duplicate, first.json.id);
  assert.equal(again.json.status, 'needs_reconciliation');
  assert.match(String(again.json.error), /the first one is unconfirmed, do not send it again; read proposal_status/);
  assert.match(String(again.json.error), new RegExp(String(first.json.id)));
  assert.equal(h.store.list().length, 1, 'one row, not two');
});
