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
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveClaudeBin } from '../src/driver.ts';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function claudeAvailable(): string | null {
  try {
    return resolveClaudeBin();
  } catch {
    return null;
  }
}

// Reads the init event and nothing else, then kills the child. Resolves with the announced tool
// list. Rejects on anything that is not a clean init, because "could not tell" has to fail.
function announcedTools(bin: string, settings: string): Promise<string[]> {
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
      { cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'] },
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
          resolve(Array.isArray(event.tools) ? (event.tools as string[]) : []);
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
    const tools = await announcedTools(bin as string, path.join(REPO, 'operator', 'driver.settings.json'));
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
    const tools = await announcedTools(bin as string, path.join(REPO, 'operator', 'settings.json'));
    const builtins = tools.filter((t) => !t.startsWith('mcp__phosphor__')).sort();
    // Read, Grep and Glob are deliberate: operator/README.md says the operator can read the code
    // it drives. Anything else here is the README describing a profile that no longer exists.
    assert.deepEqual(
      builtins,
      ['Glob', 'Grep', 'Read'],
      `operator/settings.json is out of date: this Claude Code release grants ${builtins.join(', ')}, ` +
        'and operator/README.md claims it grants only Read, Grep and Glob.',
    );
  },
);
