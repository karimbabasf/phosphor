// latest.json is what every installed copy reads to learn about a release, so its shape is
// asserted here rather than discovered by an app that silently finds no update. The signature
// travels as the content of the .sig file, not a path; the URL is the versioned release asset,
// never /latest/, so a manifest fetched during the next release cannot point at a bundle that
// has moved; and the date is RFC 3339, which is what the plugin parses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildManifest, checksumLines } from '../../scripts/release-manifest.ts';

const input = {
  version: '0.4.0',
  tag: 'v0.4.0',
  notes: 'First installable release.',
  signature: 'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQo=\n',
  tarballName: 'Phosphor_0.4.0_aarch64.app.tar.gz',
  repo: 'karimbabasf/phosphor',
  now: new Date('2026-09-14T22:15:03.512Z'),
};

test('the manifest points the Apple silicon build at the versioned asset with the trimmed signature', () => {
  const manifest = buildManifest(input);
  assert.equal(manifest.version, '0.4.0');
  assert.equal(manifest.notes, 'First installable release.');
  assert.equal(manifest.pub_date, '2026-09-14T22:15:03Z');
  assert.deepEqual(Object.keys(manifest.platforms), ['darwin-aarch64']);
  assert.equal(
    manifest.platforms['darwin-aarch64'].url,
    'https://github.com/karimbabasf/phosphor/releases/download/v0.4.0/Phosphor_0.4.0_aarch64.app.tar.gz',
  );
  assert.equal(manifest.platforms['darwin-aarch64'].signature, 'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQo=');
});

test('a tag that does not match the version is refused before anything is published', () => {
  assert.throws(() => buildManifest({ ...input, tag: 'v0.4.1' }), /tag v0.4.1 does not match version 0.4.0/);
});

test('an empty signature is refused, because an unsigned manifest installs nothing', () => {
  assert.throws(() => buildManifest({ ...input, signature: '  \n' }), /signature is empty/);
});

test('checksum lines are in the shasum format, one file per line, basename only', () => {
  const lines = checksumLines([
    { name: 'Phosphor-macOS-arm64.dmg', sha256: 'a'.repeat(64) },
    { name: 'Phosphor_0.4.0_aarch64.app.tar.gz', sha256: 'b'.repeat(64) },
  ]);
  assert.equal(lines, `${'a'.repeat(64)}  Phosphor-macOS-arm64.dmg\n${'b'.repeat(64)}  Phosphor_0.4.0_aarch64.app.tar.gz\n`);
});
