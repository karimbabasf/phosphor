// What the proxy says when a call to the app does not come back cleanly.
//
// One sentence for every failure was the bug behind 2026-09-15: "the control app is not
// running" reads as "it never happened, try again", and the rail was still running. Three
// sentences now, and the line between them is whether the request left this process.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyProxyError, NOT_RUNNING, STILL_WORKING, UNREADABLE_REPLY } from '../../src/mcp-errors.ts';

test('a refused connection is the only "not running": nothing was sent, so a retry is safe', () => {
  assert.equal(classifyProxyError({ code: 'ECONNREFUSED' }), NOT_RUNNING);
  assert.equal(classifyProxyError({ name: 'TypeError', message: 'fetch failed', cause: { code: 'ECONNREFUSED' } }), NOT_RUNNING);
  assert.equal(classifyProxyError({ name: 'TypeError', cause: { code: 'ENOTFOUND' } }), NOT_RUNNING);
});

test('a timeout, an abort or a reset after the request went out is "still working", not "not running"', () => {
  assert.equal(classifyProxyError({ name: 'TimeoutError' }), STILL_WORKING);
  assert.equal(classifyProxyError({ name: 'AbortError' }), STILL_WORKING);
  assert.equal(classifyProxyError({ code: 'ECONNRESET' }), STILL_WORKING);
  assert.equal(classifyProxyError({ code: 'EPIPE' }), STILL_WORKING);
  assert.equal(classifyProxyError({ name: 'TypeError', message: 'fetch failed', cause: { code: 'UND_ERR_SOCKET', message: 'other side closed' } }), STILL_WORKING);
  assert.equal(classifyProxyError(new Error('socket hang up')), STILL_WORKING);
});

test('the still-working sentence tells the agent to check a proposal before repeating', () => {
  assert.match(STILL_WORKING, /proposal_status/);
  assert.match(STILL_WORKING, /before repeating/);
  assert.doesNotMatch(STILL_WORKING, /not running/);
});

// The proxy returns this when res.json() throws: the app answered, the body would not parse,
// and a retry could double a move. The catch block that uses it is in src/mcp.ts, which starts
// an stdio server on import and so cannot be unit tested; the sentence it hands back is here.
test('an unreadable reply says the app answered and to check before repeating', () => {
  assert.match(UNREADABLE_REPLY, /could not be read/);
  assert.match(UNREADABLE_REPLY, /proposal_status/);
  assert.doesNotMatch(UNREADABLE_REPLY, /not running/);
});
