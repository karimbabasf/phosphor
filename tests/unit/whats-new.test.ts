import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { whatsNew } from '../../src/whats-new.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function rootWith(changelog: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whats-new-'));
  fs.mkdirSync(path.join(dir, 'docs'));
  fs.writeFileSync(path.join(dir, 'docs', 'changelog.md'), changelog);
  return dir;
}

const LOG = '# Changelog\n\nintro\n\n## 0.10.3\n\n- three\n\n## 0.10.2\n\n- two\n\n## 0.10.0\n\n- zero\n';

test('no since gives the newest entry only', () => {
  const out = whatsNew(rootWith(LOG), '');
  assert.match(out, /## 0\.10\.3/);
  assert.doesNotMatch(out, /0\.10\.2/);
});

test('since gives every entry after the version they had, by number not by text', () => {
  const out = whatsNew(rootWith(LOG), '0.10.0');
  assert.match(out, /## 0\.10\.3[\s\S]*## 0\.10\.2/);
  assert.doesNotMatch(out, /zero/);
  assert.match(whatsNew(rootWith(LOG), '0.10.3'), /Nothing is newer than 0\.10\.3/);
});

test('a copy with no changelog says so instead of failing', () => {
  assert.match(whatsNew(fs.mkdtempSync(path.join(os.tmpdir(), 'whats-new-')), ''), /carries no changelog/);
});

test('the real changelog opens on the version in package.json, and the bundle ships it', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version: string };
  assert.ok(whatsNew(ROOT, '').startsWith(`## ${pkg.version}`));
  assert.match(fs.readFileSync(path.join(ROOT, 'scripts', 'bundle-payload.ts'), 'utf8'), /'docs\/changelog\.md'/);
});
