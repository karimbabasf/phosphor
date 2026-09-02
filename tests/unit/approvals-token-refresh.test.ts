// What happens to an approval box when the app restarted underneath it.
//
// The window token is injected into the window the shell opened (window.__PHOSPHOR_TOKEN__) and
// each page reads it once at load, so a page holding a stale copy of it posts a token the
// server refuses. The approval path went through APPROVALS.decide, which only printed the
// message, so every further click resent the same dead token and the box repeated "invalid
// approval token" with no way out that it ever mentioned. Observed live on 2026-08-14: 26
// rejections against one proposal across three app restarts, all of them tokenPresent and none
// of them wrong clicks.
//
// The second assertion here is the important one. A stale token must NOT cause the click to be
// replayed: approval is a physical human decision, and retrying one on the human's behalf would
// let a click aimed at a dead token arm a bot with nobody deciding again.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

type Sandbox = Record<string, any>;

function loadApprovals(injectedToken: string | undefined): Sandbox {
  const source = readFileSync(new URL('../../ui/approvals.js', import.meta.url), 'utf8');
  const sandbox: Sandbox = {
    document: { createElement: () => ({}) },
    console,
  };
  sandbox.window = sandbox;
  sandbox.__PHOSPHOR_TOKEN__ = injectedToken;
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

// A server that refuses everything but the live token, the way src/http/mutation.ts does.
function restartedServer(oldToken: string, newToken: string) {
  const posted: { token: unknown }[] = [];
  return {
    posted,
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

test('a dead approval token is re-read, so the next click carries the live one', async () => {
  const srv = restartedServer('dead-token', 'live-token');
  const APPROVALS = loadApprovals('live-token');

  // The page still holds what it read at load, and never learns better on its own.
  const deps = { token: () => srv.stale, postJson: srv.postJson, onDecided: async () => {} };
  const errorNode = fakeError();

  await APPROVALS.decide('/api/approve', 'p1', fakeButtons(), errorNode, deps);
  assert.equal(srv.posted.length, 1, 'the first click posts once');
  assert.equal(srv.posted[0].token, 'dead-token');
  assert.match(errorNode.textContent, /re-read|dead/i, 'the box says what actually happened');
  assert.equal(errorNode.hidden, false);

  // The human clicks again. This is the whole point: the second click must land.
  await APPROVALS.decide('/api/approve', 'p1', fakeButtons(), errorNode, deps);
  assert.equal(srv.posted.length, 2, 'the second click posts once');
  assert.equal(srv.posted[1].token, 'live-token', 'and carries the injected token');
});

test('a stale token never replays the click: approval stays a human decision', async () => {
  const srv = restartedServer('dead-token', 'live-token');
  const APPROVALS = loadApprovals('live-token');
  const deps = { token: () => srv.stale, postJson: srv.postJson, onDecided: async () => {} };

  await APPROVALS.decide('/api/approve', 'p1', fakeButtons(), fakeError(), deps);

  assert.equal(srv.posted.length, 1, 'refreshing the token must not re-send the decision');
});

test('the buttons come back after a token failure, so the human can click again', async () => {
  const srv = restartedServer('dead-token', 'live-token');
  const APPROVALS = loadApprovals('live-token');
  const deps = { token: () => srv.stale, postJson: srv.postJson, onDecided: async () => {} };
  const buttons = fakeButtons();

  await APPROVALS.decide('/api/approve', 'p1', buttons, fakeError(), deps);

  for (const b of buttons) assert.equal(b.disabled, false);
});

test('a failure that is not about the token is left alone and reads as it did', async () => {
  const APPROVALS = loadApprovals('live-token');
  const deps = {
    token: () => 'whatever',
    postJson: async () => {
      throw new Error('the venue refused the order');
    },
    onDecided: async () => {},
  };
  const errorNode = fakeError();

  await APPROVALS.decide('/api/approve', 'p1', fakeButtons(), errorNode, deps);

  assert.equal(errorNode.textContent, 'the venue refused the order');
});

test('a window with no injected token says to open the app again rather than claiming a fix', async () => {
  const APPROVALS = loadApprovals(undefined);
  const deps = {
    token: () => 'dead-token',
    postJson: async () => {
      throw new Error('invalid approval token');
    },
    onDecided: async () => {},
  };
  const errorNode = fakeError();

  await APPROVALS.decide('/api/approve', 'p1', fakeButtons(), errorNode, deps);

  assert.match(errorNode.textContent, /open the app again/i);
});
