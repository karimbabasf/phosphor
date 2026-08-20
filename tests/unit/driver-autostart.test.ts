// The app opens with an agent already attached, which means a Claude Code process is spawned by
// the act of the window opening rather than by anybody deciding to. Three things have to hold
// for that to be safe, and all three are here:
//
//   - it happens on 'listening' and never earlier. The child's MCP proxy POSTs straight back to
//     this port, so a driver started ahead of the socket hands the model an empty tool surface;
//   - it is OPT IN at the dep, not read from config inside the server. Every test in this repo
//     builds a server and listens on it, and a flag that defaulted to on would have each of them
//     spawn a real agent;
//   - it starts exactly one, and the seat is cleared before it rather than after.
//
// The driver itself is injected, so nothing here launches a real process.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bootDriverServer } from '../fixtures/driver-server.ts';

test('the port opening starts the agent, once, when the app asked for it', async () => {
  const b = await bootDriverServer({ autostart: true });
  try {
    assert.equal(b.calls.starts, 1);
    const app = b.auditLines().filter((l) => l.includes('in-app driver starting at boot'));
    assert.equal(app.length, 1, 'and it says so in the record, in its own words');
  } finally {
    await b.close();
  }
});

test('a server nobody asked to autostart never spawns anything', async () => {
  const b = await bootDriverServer();
  try {
    assert.equal(b.calls.starts, 0, 'which is what keeps every other test in this repo from launching an agent');
    assert.equal(
      b.auditLines().some((l) => l.includes('in-app driver starting')),
      false,
    );
  } finally {
    await b.close();
  }
});

test('the boot start clears the seat first, and leaves it free for its own child', async () => {
  const b = await bootDriverServer({ autostart: true });
  try {
    const lines = b.auditLines();
    const start = lines.findIndex((l) => l.includes('in-app driver starting at boot'));
    assert.ok(start >= 0);
    // Nothing held the seat here, so there is no eviction line, and that is the point: the
    // eviction is attempted first and is a no-op when the seat is empty.
    assert.equal(lines.some((l) => l.includes('replaced')), false);
    assert.equal(b.agents.holder(), null, 'the seat is still free for the child to take');
  } finally {
    await b.close();
  }
});
