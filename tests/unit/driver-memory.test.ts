// The one context source `--setting-sources=` does not cover.
//
// The driver spawns Claude Code with no user, project or local settings, and the comment in
// src/driver.ts says that is what keeps somebody's hooks, plugins and CLAUDE.md out of a session
// that drives a wallet. Measured against 2.1.263 that claim held for all three and failed for a
// fourth thing nobody had listed: auto-memory. Claude Code loads
// <config root>/projects/<cwd slug>/memory/ before the first turn whatever the setting sources
// are, the child's cwd is the repo, so the path is computable by anyone who can write in the
// user's home directory. A file there is system-level context in every future driver session and
// it can file proposals; the ones at or below the policy click threshold execute with no click.
// Reproduced on 2.1.263: a canary written into that MEMORY.md came back named by the child.
//
// Two properties, neither needing the binary: the child is spawned with auto-memory turned off,
// and a child that loaded memory anyway is refused before it can act. tests/lockdown.test.ts asks
// the real binary what it actually loaded, which is the slow half.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertMemory, childEnv, createDriver, type DriverEvent } from '../../src/driver.ts';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

test('the child is spawned with auto-memory turned off', () => {
  const env = childEnv('/repo', 4177, 'session-1');
  assert.equal(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
});

test('a parent environment that turned auto-memory back on does not win', () => {
  const previous = process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY;
  process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '0';
  try {
    assert.equal(childEnv('/repo', 4177, 'session-1').CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY;
    else process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = previous;
  }
});

test('no memory at all is the only clean answer', () => {
  assert.deepEqual(assertMemory(undefined), [], 'a release that reports nothing reported no memory');
  assert.deepEqual(assertMemory(null), []);
  assert.deepEqual(assertMemory({}), []);
});

test('any memory path the child announces is an offender', () => {
  const found = assertMemory({ auto: '/Users/someone/.claude/projects/-repo/memory/' });
  assert.deepEqual(found, ['auto: /Users/someone/.claude/projects/-repo/memory/']);

  // Not only `auto`: a future release adding a second kind must fail here rather than pass by
  // being unlisted, which is the whole reason this reads the answer instead of naming a key.
  assert.equal(assertMemory({ auto: '/a/', org: '/b/' }).length, 2);
  assert.equal(assertMemory('somewhere').length, 1, 'a shape this app cannot read is not a pass');
});

test('an empty string is not a memory path', () => {
  assert.deepEqual(assertMemory({ auto: '' }), []);
});

test('a driver whose child announces memory is stopped before it can act', async () => {
  const events: DriverEvent[] = [];
  const driver = createDriver({
    repo: ROOT,
    port: 4177,
    /* A stand-in for the binary: it emits one init event saying it loaded auto-memory and then
       waits. So this drives the real parser over a real child, which is what makes it a
       regression test for the refusal rather than for the function the refusal calls. */
    claudeBin: path.join(ROOT, 'tests', 'fixtures', 'fake-claude-memory.sh'),
    settingsPath: path.join(ROOT, 'operator', 'driver.settings.json'),
    onEvent: (event) => events.push(event),
  });

  driver.start();
  const deadline = Date.now() + 5_000;
  while (driver.status().state !== 'failed' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  driver.stop();

  assert.equal(driver.status().state, 'failed', 'a child that loaded memory must not be driven');
  assert.equal(driver.status().running, false, 'and the child has to be taken down with it');
  const said = events.find((e) => e.kind === 'error');
  assert.ok(said !== undefined, 'the refusal has to reach the window');
  assert.match(said.message, /memory file/, said.message);
});
