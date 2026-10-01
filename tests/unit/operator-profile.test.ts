// The two launch profiles, read as files rather than as prose.
//
// tests/lockdown.test.ts already runs the real Claude Code binary against both and compares the
// tool surface it reports. That test needs the binary and a network, so it is the slow half.
// This is the fast half: the deny list is a fact about a JSON file, and the one rule that
// matters most is cheap to assert on every run.
//
// P1-1: the operator profile denied Read on the key path and allowed Grep and Glob with no path
// at all, so Grep(pattern: "0x[0-9a-f]{64}", path: "~/.phosphor") put the key in a transcript
// that leaves the machine. A search tool is a read tool that never has to name the file.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

type Profile = { permissions: { deny: string[]; allow: string[]; defaultMode: string; disableBypassPermissionsMode: string } };

function profile(name: string): Profile {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'operator', name), 'utf8')) as Profile;
}

test('the operator profile denies every tool that can read a file by pattern', () => {
  const p = profile('settings.json');
  for (const tool of ['Grep', 'Glob']) {
    assert.ok(p.permissions.deny.includes(tool), `${tool} must be denied: it reads files the Read deny rule names by path`);
    assert.ok(!p.permissions.allow.includes(tool), `${tool} must not also be allowed`);
  }
  assert.ok(p.permissions.deny.includes('Read(~/.phosphor/**)'), 'the key path stays denied to Read');
  assert.ok(p.permissions.allow.includes('Read'), 'Read itself stays, so the operator can read the code it drives');
});

test('the driver profile denies the whole file surface, not only the key path', () => {
  const p = profile('driver.settings.json');
  for (const tool of ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash']) {
    assert.ok(p.permissions.deny.includes(tool), `${tool} must be denied in the in-app driver profile`);
  }
  // Web search on Karim's decision of 2026-09-23: the agent researches anything, not only crypto.
  // WebFetch is off since 2026-10-01 (audit finding 3): pages come through mcp__phosphor__web_read.
  assert.deepEqual(p.permissions.allow, ['mcp__phosphor__*', 'WebSearch'], 'the in-app driver holds the phosphor tools and web search, and nothing else');
  assert.ok(!p.permissions.deny.includes('WebSearch'), 'WebSearch is allowed and denied at once');
  assert.ok(p.permissions.deny.includes('WebFetch'), 'WebFetch must be denied: it fetched any address the model wrote');
});

/* The fourth wall for the page reader that is off: --tools leaves it out, the deny list names it,
   the surface check refuses a session that announces it, and this hook refuses a call to it before
   it runs. Exit 2 is the code that blocks a call; the reason goes to the model on stderr. */
test('the driver profile refuses a WebFetch call before it runs', () => {
  const p = JSON.parse(fs.readFileSync(path.join(ROOT, 'operator', 'driver.settings.json'), 'utf8')) as {
    hooks: { PreToolUse?: Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }> };
  };
  const rule = p.hooks.PreToolUse?.find((h) => h.matcher === 'WebFetch');
  assert.ok(rule !== undefined, 'a PreToolUse hook on WebFetch');
  assert.equal(rule.hooks.length, 1);
  assert.equal(rule.hooks[0].type, 'command');
  assert.match(rule.hooks[0].command, /exit 2$/, 'the hook blocks: any other exit code lets the call run');
});

test('neither profile can be talked into bypassing its own permissions', () => {
  for (const name of ['settings.json', 'driver.settings.json']) {
    const p = profile(name);
    assert.equal(p.permissions.disableBypassPermissionsMode, 'disable', `${name} must refuse bypassPermissions`);
    assert.equal(p.permissions.defaultMode, 'default', `${name} must not default to a looser mode`);
  }
});
