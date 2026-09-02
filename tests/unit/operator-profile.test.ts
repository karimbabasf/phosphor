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
  assert.deepEqual(p.permissions.allow, ['mcp__phosphor__*'], 'the in-app driver holds the phosphor tools and nothing else');
});

test('neither profile can be talked into bypassing its own permissions', () => {
  for (const name of ['settings.json', 'driver.settings.json']) {
    const p = profile(name);
    assert.equal(p.permissions.disableBypassPermissionsMode, 'disable', `${name} must refuse bypassPermissions`);
    assert.equal(p.permissions.defaultMode, 'default', `${name} must not default to a looser mode`);
  }
});
