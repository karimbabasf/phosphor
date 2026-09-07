// The only test in this repo that can tell you the lockdown still works.
//
// Everything in tests/unit/driver.test.ts checks Phosphor's own logic against a list Phosphor
// wrote. This one asks Claude Code. It launches the real binary with each shipped profile, reads
// the tool list the child announces in its init event, and compares that to what the profile
// claims to permit. That is the only check that survives an upgrade: a deny list is a claim about
// somebody else's release notes, and on 2026-08-19 the claim in operator/settings.json was two
// releases out of date and had quietly started permitting WebFetch, WebSearch, SendMessage,
// RemoteTrigger and the Cron tools inside a profile whose README says it denies everything but
// reading.
//
// It skips when the claude CLI is absent, because a machine without it cannot run the driver
// either and a skipped test is honest where a passing one would be a lie. It costs no model
// tokens: the init event is emitted before the first turn, so the child is killed as soon as the
// first line of stdout has been read.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertMemory, childEnv, resolveClaudeBin } from '../src/driver.ts';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function claudeAvailable(): string | null {
  try {
    return resolveClaudeBin();
  } catch {
    return null;
  }
}

// Reads the init event and nothing else, then kills the child. Resolves with the whole event: the
// tool list is what the two profile tests read, and memory_paths is what the auto-memory test
// reads. Rejects on anything that is not a clean init, because "could not tell" has to fail.
function announcedInit(bin: string, settings: string, env?: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      bin,
      [
        '--print',
        '--output-format',
        'stream-json',
        '--verbose',
        '--settings',
        settings,
        '--setting-sources=',
        '--strict-mcp-config',
        '--permission-mode',
        'dontAsk',
        // A positional prompt rather than a stream-json stdin session, and it is never answered.
        // The init event is emitted while the session is being built, before the first request
        // goes out, so the child is killed below the moment that line is read. Streaming input
        // would instead sit waiting for a turn that this test has no reason to pay for.
        'unused',
      ],
      { cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'], env: env ?? process.env },
    );

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('timed out waiting for the init event'));
    }, 30_000);

    let buffer = '';
    let settled = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (settled) return;
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.type === 'system' && event.subtype === 'init') {
          settled = true;
          clearTimeout(timer);
          child.kill('SIGKILL');
          resolve(event);
          return;
        }
      }
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('the child exited before announcing an init event'));
    });
  });
}

const bin = claudeAvailable();

test(
  'the driver profile leaves the agent no tool but Phosphor',
  { skip: bin === null ? 'the claude CLI is not installed on this machine' : false },
  async () => {
    const init = await announcedInit(bin as string, path.join(REPO, 'operator', 'driver.settings.json'));
    const tools = Array.isArray(init.tools) ? (init.tools as string[]) : [];
    const builtins = tools.filter((t) => !t.startsWith('mcp__phosphor__'));
    assert.deepEqual(
      builtins,
      [],
      `operator/driver.settings.json is out of date: this Claude Code release still grants ${builtins.join(', ')}. ` +
        'Add them to the deny list. The in-app driver refuses to run until this is empty.',
    );
  },
);

test(
  'the operator profile grants reading and nothing else',
  { skip: bin === null ? 'the claude CLI is not installed on this machine' : false },
  async () => {
    const init = await announcedInit(bin as string, path.join(REPO, 'operator', 'settings.json'));
    const tools = Array.isArray(init.tools) ? (init.tools as string[]) : [];
    const builtins = tools.filter((t) => !t.startsWith('mcp__phosphor__')).sort();
    // Read alone, and scoped: operator/README.md says the operator can read the code it drives,
    // and the key file is denied by path. Grep and Glob left on 2026-09-01 because a search tool
    // reads files the path-scoped Read rule never gets to see the name of. Anything else here is
    // the README describing a profile that no longer exists.
    assert.deepEqual(
      builtins,
      ['Read'],
      `operator/settings.json is out of date: this Claude Code release grants ${builtins.join(', ')}, ` +
        'and operator/README.md claims it grants only Read.',
    );
  },
);

/* The auto-memory hole, asked of the binary rather than assumed.
   `--setting-sources=` keeps settings, hooks, plugins and CLAUDE.md out of the child. It does not
   cover auto-memory, which Claude Code loads from <config root>/projects/<cwd slug>/memory/ before
   the first turn: a file written there by anything on this machine became instructions in a
   session that can propose with the user's money. Reproduced on 2.1.263 with a canary, which the
   child read and named. src/driver.ts turns auto-memory off in the child's environment, and this
   is the check that the variable still does that in whatever release is installed. The child is
   spawned with the very environment childEnv builds, so a regression in that function fails here
   rather than in prose. */
test(
  'the driver child loads no memory of any kind',
  { skip: bin === null ? 'the claude CLI is not installed on this machine' : false },
  async () => {
    const init = await announcedInit(
      bin as string,
      path.join(REPO, 'operator', 'driver.settings.json'),
      childEnv(REPO, 4177, '11111111-2222-3333-4444-555555555555'),
    );

    assert.deepEqual(
      assertMemory(init.memory_paths),
      [],
      'this Claude Code release still loads auto-memory into the driver child. Anything that can ' +
        'write that file writes the system prompt of a session that moves money.',
    );
  },
);

/* Deny rules that name nothing.
   Not a hole, and that is why it is a separate test rather than a failure of the two above: the
   allow list is `mcp__phosphor__*` and assertSurface in src/driver.ts reads the announced surface
   back, so a tool the deny list misses is refused anyway. These three were the visible symptom of
   exactly the drift this file exists to catch. Claude Code 2.1.263 printed one line per rule on
   stderr for each of them, and a profile that names tools the release has never heard of is a
   profile nobody has checked against a release.

   Measured while removing them, and worth writing down because the report that found them said
   otherwise: the warning is printed under `--output-format text` and NOT under the
   `--output-format stream-json --verbose` the driver actually spawns with. So they never reached
   the window through the stderr forwarding in src/driver.ts. They were noise for anyone running
   the profile by hand, and a stale claim in a file whose whole job is to not be stale.

   A general check would need the release's full tool list, which nothing announces, so this names
   the three. The live tests above are the general check. */
test('neither profile names a tool this Claude Code release has never heard of', () => {
  const dead = ['SlashCommand', 'NotebookRead', 'MultiEdit'];
  for (const name of ['driver.settings.json', 'settings.json']) {
    const profile = JSON.parse(fs.readFileSync(path.join(REPO, 'operator', name), 'utf8')) as {
      permissions: { deny: string[] };
    };
    for (const tool of dead) {
      assert.ok(
        !profile.permissions.deny.includes(tool),
        `operator/${name} denies ${tool}, which matched no tool in 2.1.263. Check it against the ` +
          'installed release before putting it back.',
      );
    }
  }
});
