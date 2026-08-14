// What happens to an approval box when the app restarted underneath it.
//
// The approval token is minted once per boot (src/server.ts) and the page reads it once at load,
// so any restart leaves an open page holding a token the server has never heard of. ui/trade.js
// already cures that for a TRADE ACTION: reportWriteFailure re-reads /api/session and says so.
// The approval path went through APPROVALS.decide, which only printed the message, so every
// further click resent the same dead token and the box repeated "invalid approval token" with no
// way out that it ever mentioned. Observed live on 2026-08-14: 26 rejections against one
// proposal across three app restarts, all of them tokenPresent and none of them wrong clicks.
//
// The second assertion here is the important one. A stale token must NOT cause the click to be
// replayed: approval is a physical human decision, and retrying one on the human's behalf would
// let a click aimed at a dead token arm a bot with nobody deciding again.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

type Sandbox = Record<string, any>;

function loadApprovals(fetchImpl: any): Sandbox {
  const source = readFileSync(new URL('../../ui/approvals.js', import.meta.url), 'utf8');
  const sandbox: Sandbox = {
    window: {},
    document: { createElement: () => ({}) },
    console,
    fetch: fetchImpl,
  };
  createContext(sandbox);
  runInContext(source, sandbox, { filename: 'ui/approvals.js' });
  return sandbox.window.APPROVALS;
}

function fakeButtons() {
  return [{ disabled: false }, { disabled: false }];
}

function fakeError() {
  return { textContent: '', hidden: true };
}

// A server that has restarted: it rejects the old token the way src/server.ts does, and hands
// out the new one from /api/session.
function restartedServer(oldToken: string, newToken: string) {
  const posted: { token: unknown }[] = [];
  let sessionReads = 0;
  return {
    posted,
    sessionReads: () => sessionReads,
    fetchImpl: async (url: string) => {
      if (String(url) !== '/api/session') throw new Error('unexpected fetch ' + url);
      sessionReads += 1;
      return { ok: true, json: async () => ({ token: newToken }) };
    },
    postJson: async (_route: string, body: { token: unknown }) => {
      posted.push(body);
      if (body.token !== newToken) {
        const err = new Error('invalid approval token');
        (err as any).fromServer = true;
        throw err;
      }
      return { ok: true };
    },
    stale: oldToken,
  };
}

test('a dead approval token is refreshed, so the next click carries the live one', async () => {
  const srv = restartedServer('dead-token', 'live-token');
  const APPROVALS = loadApprovals(srv.fetchImpl);

  // The page still holds what it read at load, and never learns better on its own.
  const deps = { token: () => srv.stale, postJson: srv.postJson, onDecided: async () => {} };
  const errorNode = fakeError();

  await APPROVALS.decide('/api/approve', 'p1', fakeButtons(), errorNode, deps);
  assert.equal(srv.posted.length, 1, 'the first click posts once');
  assert.equal(srv.posted[0].token, 'dead-token');
  assert.equal(srv.sessionReads(), 1, 'a token failure re-reads /api/session');
  assert.match(errorNode.textContent, /restarted|refreshed/i, 'the box says what actually happened');
  assert.equal(errorNode.hidden, false);

  // The human clicks again. This is the whole point: the second click must land.
  await APPROVALS.decide('/api/approve', 'p1', fakeButtons(), errorNode, deps);
  assert.equal(srv.posted.length, 2, 'the second click posts once');
  assert.equal(srv.posted[1].token, 'live-token', 'and carries the refreshed token');
});

test('a stale token never replays the click: approval stays a human decision', async () => {
  const srv = restartedServer('dead-token', 'live-token');
  const APPROVALS = loadApprovals(srv.fetchImpl);
  const deps = { token: () => srv.stale, postJson: srv.postJson, onDecided: async () => {} };

  await APPROVALS.decide('/api/approve', 'p1', fakeButtons(), fakeError(), deps);

  assert.equal(srv.posted.length, 1, 'refreshing the token must not re-send the decision');
});

test('the buttons come back after a token failure, so the human can click again', async () => {
  const srv = restartedServer('dead-token', 'live-token');
  const APPROVALS = loadApprovals(srv.fetchImpl);
  const deps = { token: () => srv.stale, postJson: srv.postJson, onDecided: async () => {} };
  const buttons = fakeButtons();

  await APPROVALS.decide('/api/approve', 'p1', buttons, fakeError(), deps);

  for (const b of buttons) assert.equal(b.disabled, false);
});

test('a failure that is not about the token is left alone and reads as it did', async () => {
  let sessionReads = 0;
  const APPROVALS = loadApprovals(async () => {
    sessionReads += 1;
    return { ok: true, json: async () => ({ token: 'live-token' }) };
  });
  const deps = {
    token: () => 'whatever',
    postJson: async () => {
      throw new Error('the venue refused the order');
    },
    onDecided: async () => {},
  };
  const errorNode = fakeError();

  await APPROVALS.decide('/api/approve', 'p1', fakeButtons(), errorNode, deps);

  assert.equal(sessionReads, 0, 'no token in the message means no session read');
  assert.equal(errorNode.textContent, 'the venue refused the order');
});

test('a token that cannot be refreshed says to reload rather than claiming it is fixed', async () => {
  const APPROVALS = loadApprovals(async () => ({ ok: false, json: async () => ({}) }));
  const deps = {
    token: () => 'dead-token',
    postJson: async () => {
      throw new Error('invalid approval token');
    },
    onDecided: async () => {},
  };
  const errorNode = fakeError();

  await APPROVALS.decide('/api/approve', 'p1', fakeButtons(), errorNode, deps);

  assert.match(errorNode.textContent, /reload/i);
});
