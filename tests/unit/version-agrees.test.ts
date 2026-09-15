// One version, three files that must say it. package.json is what the app reports (src/version.ts),
// Cargo.toml is what the shell binary carries, tauri.conf.json is what the bundle, the DMG name and
// the updater compare against. A release that bumps two of the three ships an app that either
// refuses its own update or offers it forever, so the disagreement is caught here, before a tag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SEMVER = /^\d+\.\d+\.\d+$/;

function versions(): Record<string, string> {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version: string };
  const conf = JSON.parse(readFileSync(path.join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8')) as { version: string };
  const cargo = readFileSync(path.join(ROOT, 'src-tauri', 'Cargo.toml'), 'utf8');
  const cargoVersion = /^version\s*=\s*"([^"]+)"/m.exec(cargo)?.[1] ?? '';
  return { 'package.json': pkg.version, 'src-tauri/tauri.conf.json': conf.version, 'src-tauri/Cargo.toml': cargoVersion };
}

test('package.json, Cargo.toml and tauri.conf.json carry the same plain semver', () => {
  const found = versions();
  for (const [file, version] of Object.entries(found)) {
    assert.match(version, SEMVER, `${file} version "${version}" is not plain MAJOR.MINOR.PATCH`);
  }
  const distinct = new Set(Object.values(found));
  assert.equal(distinct.size, 1, `the three version files disagree: ${JSON.stringify(found)}`);
});
