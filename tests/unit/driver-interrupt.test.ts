// Stopping the answer is not stopping the agent, and the app has to keep them apart.
//
// Before `interrupt` existed there was exactly one way out of a turn going wrong, and it was the
// destructive one: kill the session, lose the conversation, wait for a cold start. So a human who
// asked the wrong question paid for it with everything said so far. Two controls with two
// outcomes is the whole feature, and these tests exist to stop them collapsing back into one.
//
// The route is behind the same approval token as every other write on this surface, which is the
// property that stops a page in another tab reaching into a session it does not own. That is
// asserted here rather than assumed, because `interrupt` is the newest action on the route and a
// new action is exactly where an auth check gets forgotten.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bootDriverServer } from '../fixtures/driver-server.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('an interrupt reaches the driver and keeps the session running', async () => {
  const b = await bootDriverServer({ state: 'thinking' });
  try {
    const res = await b.driver({ action: 'interrupt' });
    assert.equal(res.status, 200);
    assert.equal(res.body.interrupted, true);
    assert.equal(b.calls.interrupts, 1);
    // The distinction the feature exists for: nothing was stopped, and nothing was restarted.
    assert.equal(b.calls.stops, 0);
    assert.equal(b.calls.starts, 0);
    assert.equal(res.body.running, true);
  } finally {
    await b.close();
  }
});

test('an interrupt with no turn in flight is a quiet no, not an error', async () => {
  // A human presses stop as the answer lands. Nothing was cancelled and nothing went wrong, so
  // the answer is 200 with interrupted:false. An error here would put a red line in the window
  // for something the human did nothing wrong to cause.
  const b = await bootDriverServer({ state: 'ready' });
  try {
    const res = await b.driver({ action: 'interrupt' });
    assert.equal(res.status, 200);
    assert.equal(res.body.interrupted, false);
    assert.equal(b.calls.interrupts, 1);
  } finally {
    await b.close();
  }
});

test('an interrupt that landed is written into the record', async () => {
  const b = await bootDriverServer({ state: 'thinking' });
  try {
    await b.driver({ action: 'interrupt' });
    const lines = b.auditLines().filter((l) => l.includes('stopped the answer in progress'));
    assert.equal(lines.length, 1, 'the log has to be able to answer why the agent went quiet');
  } finally {
    await b.close();
  }
});

test('an interrupt that did nothing writes nothing', async () => {
  const b = await bootDriverServer({ state: 'ready' });
  try {
    await b.driver({ action: 'interrupt' });
    assert.equal(
      b.auditLines().some((l) => l.includes('stopped the answer in progress')),
      false,
      'a log that records non-events is a log nobody reads',
    );
  } finally {
    await b.close();
  }
});

test('an interrupt without the approval token is refused', async () => {
  const b = await bootDriverServer({ state: 'thinking' });
  try {
    const res = await fetch(`${b.url}/api/driver`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'interrupt' }),
    });
    assert.ok(res.status === 400 || res.status === 403, `expected a refusal, got ${res.status}`);
    assert.equal(b.calls.interrupts, 0, 'and the driver was never reached');
  } finally {
    await b.close();
  }
});

test('an interrupt with somebody else token is refused', async () => {
  const b = await bootDriverServer({ state: 'thinking' });
  try {
    const res = await fetch(`${b.url}/api/driver`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'interrupt', token: 'not-the-token' }),
    });
    assert.equal(res.status, 403);
    assert.equal(b.calls.interrupts, 0);
  } finally {
    await b.close();
  }
});

test('stop is still the destructive one, and interrupt did not become it', async () => {
  const b = await bootDriverServer({ state: 'thinking' });
  try {
    await b.driver({ action: 'stop' });
    assert.equal(b.calls.stops, 1);
    assert.equal(b.calls.interrupts, 0);
  } finally {
    await b.close();
  }
});

test('an unknown action is still refused by name', async () => {
  // The route grew a fourth action. A typo in the window must not fall through to one of the
  // three that do something.
  const b = await bootDriverServer({ state: 'thinking' });
  try {
    const res = await b.driver({ action: 'interupt' });
    assert.equal(res.status, 400);
    assert.equal(b.calls.interrupts, 0);
    assert.equal(b.calls.stops, 0);
  } finally {
    await b.close();
  }
});

test('the stop is announced once, not twice', () => {
  // Seen on the live app: the route pushed its own status event AND the driver emitted one
  // from interrupt(), so the window printed "the human stopped this answer" on two lines. The
  // route no longer speaks for the driver, and this reads the source to say so, because the
  // duplicate is invisible in any assertion about the route's own answer.
  const source = fs.readFileSync(path.join(ROOT, 'src', 'server.ts'), 'utf8');
  const route = source.slice(source.indexOf("if (action === 'interrupt')"), source.indexOf("if (action === 'stop')"));
  assert.ok(route.length > 0, 'the interrupt branch moved');
  assert.ok(!route.includes('driverEvent('), 'the interrupt route emits a driver event of its own');
});
