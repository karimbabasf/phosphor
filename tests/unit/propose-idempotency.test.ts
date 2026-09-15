// A repeat is answered with the row it already made.
//
// Two doors close the same hole. The duplicate guard refuses a caller's own repeat while the
// first is still running, with the id and the state of the row it is repeating. And a proposer
// that sends a clientKey is handed back the proposal that key already made, for a day, whatever
// the params and whoever asks: an agent whose reply was lost repeats with the key and gets the
// same row, never a second spend.

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
  assert.equal(h.store.get(String(a.json.id))?.clientKey, 'k1', 'the key is on the row');
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

  slow.release({ ok: true, detail: 'done', txids: ['h1'] });
  const reply = await first;
  assert.equal(reply.json.status, 'executed');
  assert.equal(again.json.duplicate, reply.json.id);
});
