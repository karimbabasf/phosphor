import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { proofOut } from '../../scripts/proof-out.ts';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

// A proof run writes its pictures into the public repo's docs only when asked to with --docs;
// by default they land under scripts/scratch/, which git ignores.

test('proofOut defaults to scripts/scratch, takes docs/screenshots only with --docs, and PROOF_OUT wins', () => {
  assert.equal(proofOut('chat-proof', 'chat', ['node', 'x.ts'], {}), path.join(ROOT, 'scripts', 'scratch', 'chat-proof'));
  assert.equal(proofOut('chat-proof', 'chat', ['node', 'x.ts', '--docs'], {}), path.join(ROOT, 'docs', 'screenshots', 'chat'));
  assert.equal(proofOut('window-proof', '', ['node', 'x.ts', '--docs'], {}), path.join(ROOT, 'docs', 'screenshots'));
  assert.equal(proofOut('chat-proof', 'chat', ['node', 'x.ts', '--docs'], { PROOF_OUT: '/tmp/shots' }), '/tmp/shots');
  assert.equal(proofOut('checks-proof', '', ['node', 'x.ts'], { PROOF_OUT_DIR: '/tmp/older' }), '/tmp/older');
  assert.equal(proofOut('card-proof-1280', undefined, ['node', 'x.ts'], { PROOF_OUT: '' }), path.join(ROOT, 'scripts', 'scratch', 'card-proof-1280'));
});

test('git ignores the scratch folder the proofs write into', () => {
  const ignored = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split('\n').map((line) => line.trim());
  assert.ok(ignored.includes('scripts/scratch/'), '.gitignore lists scripts/scratch/');
});

test('no script names a folder under docs/ as its output except through proofOut', () => {
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'scratch') walk(file);
        continue;
      }
      // sweep.ts names those folders only to say where an allowlisted value was found.
      if (!entry.name.endsWith('.ts') || ['proof-out.ts', 'sweep.ts'].includes(path.relative(path.join(ROOT, 'scripts'), file))) continue;
      const code = fs.readFileSync(file, 'utf8').split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
      if (/'docs',\s*'screenshots'|docs\/screenshots|'ready-for-people'|ready-for-people\/evidence/.test(code)) offenders.push(path.relative(ROOT, file));
    }
  };
  walk(path.join(ROOT, 'scripts'));
  assert.deepEqual(offenders, []);
});
