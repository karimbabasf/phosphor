// What a failure says (src/err-text.ts): an Error's message and never its stack, in an answer, an
// audit line or a proposal's error. CodeQL js/stack-trace-exposure flagged every route that turned
// a caught value into text with String(err), which hands back whatever the value's own toString
// writes, a stack included.

import test from 'node:test';
import assert from 'node:assert/strict';
import type http from 'node:http';

import { errText } from '../../src/err-text.ts';
import { errText as answerText } from '../../src/http/respond.ts';
import { errText as proposalText } from '../../src/proposals/lifecycle.ts';
import { failure } from '../../src/chainscan/common.ts';
import { sendHealth } from '../../src/http/health.ts';
import type { Ctx } from '../../src/http/context.ts';

const STACK = new Error('the store could not be read').stack ?? '';
// A thrown value that is not an Error and whose string form is a stack: what String(err) sent.
const carrying = { toString: () => STACK };

test('an Error is said by its message and never by its stack', () => {
  const err = new Error('the proposal file will not read');
  assert.ok((err.stack ?? '').includes('\n    at '), 'the test needs an error that carries a stack');
  assert.equal(errText(err), 'the proposal file will not read');
});

test('a thrown value whose string form is a stack is not said at all', () => {
  assert.ok(String(carrying).includes('\n    at '), 'what String(err) used to send');
  assert.equal(errText(carrying), 'no reason was given');
  for (const thrown of [null, undefined, 42, {}, { message: 7 }]) assert.equal(errText(thrown), 'no reason was given');
});

test('a thrown string and an error-like object from a library keep their words', () => {
  assert.equal(errText('the venue said no'), 'the venue said no');
  assert.equal(errText({ message: 'insufficient funds', code: -32000 }), 'insufficient funds');
});

test('the answers, the proposals and the chain reads say a failure the one way', () => {
  assert.equal(answerText, errText);
  assert.equal(proposalText, errText);
  assert.equal(failure(carrying), 'no reason was given');
  assert.equal(failure(new Error('timed out after 8000ms')), 'timed out after 8000ms');
});

test('a health answer whose store threw a stack carries the failure and not the stack', () => {
  const ctx = {
    proposals: { list: () => { throw carrying; } },
    getPolicy: () => { throw new Error('policy.json is not JSON'); },
    audit: { lastError: () => null },
    keystore: { state: () => 'locked' },
  } as unknown as Ctx;
  let body = '';
  const res = { req: undefined, writeHead: () => res, end: (chunk: string) => { body = chunk; } } as unknown as http.ServerResponse;
  sendHealth(ctx, res, true);
  const health = JSON.parse(body) as { lastError: string };
  assert.equal(health.lastError, 'no reason was given');
  assert.ok(!body.includes('    at '), body);
});
