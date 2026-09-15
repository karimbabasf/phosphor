// What the window says when a call does not come back cleanly.
//
// The approve card timed out on a stalled SSE frame and told the person "Nothing left your
// wallet" while the rail was still running: the same lie the MCP proxy told the agent on
// 2026-09-15. A write that timed out is the app still working, not a failure, so a timeout now
// says the move is still running and points at Activity, and never claims the wallet is untouched.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const SOURCE = readFileSync(new URL('../../ui/core/net.js', import.meta.url), 'utf8');

type Readable = (err: unknown, nothingLeft?: boolean) => string;

function load(): Readable {
  const sandbox: Record<string, unknown> = {
    window: { location: { search: '' } },
    document: { addEventListener: () => {} },
    console,
    setTimeout,
    clearTimeout,
    URLSearchParams,
    fetch: () => Promise.reject(new Error('no network in this test')),
  };
  runInContext(SOURCE, createContext(sandbox));
  const net = (sandbox.window as { PhosphorNet: { readable: Readable } }).PhosphorNet;
  return net.readable;
}

const timeout = (): Error => {
  const e = new Error('The operation timed out.');
  e.name = 'TimeoutError';
  return e;
};

test('a timed out write says the move is still running, never that nothing left the wallet', () => {
  const readable = load();
  const message = readable(timeout(), true);
  assert.doesNotMatch(message, /Nothing left/i, 'the timeout must not claim the wallet is untouched');
  assert.match(message, /still running/i);
  assert.match(message, /Activity/);
});

test('an ordinary error still carries "Nothing left your wallet" when the caller knows it', () => {
  const readable = load();
  assert.match(readable(new Error('boom'), true), /Nothing left your wallet/);
  assert.doesNotMatch(readable(new Error('boom'), false), /Nothing left/);
});

test('a dropped connection reads as the app not answering', () => {
  const readable = load();
  assert.match(readable(new Error('Failed to fetch')), /not answering/i);
});
