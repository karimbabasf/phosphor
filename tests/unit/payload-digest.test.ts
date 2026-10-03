// The payload digest: the rule scripts/payload-digest.ts hashes the staged payload by, which the
// shell repeats before every start (src-tauri/src/payload.rs, tested in cargo test against the
// staged bundle) and which docs/security.md tells anyone to repeat with shasum. These tests hold
// the three to one answer, and hold the bundler to a payload that can be hashed at all.
//
// Temp directories only. Nothing here stages a bundle.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { payloadDigest } from '../../scripts/payload-digest.ts';
import { tempDir } from './helpers/tmp.ts';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

function tree(files: Record<string, string | Buffer>): string {
  const root = tempDir('phosphor-payload-digest-');
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  return root;
}

// The command docs/security.md gives under "Check a release yourself", read out of the page so the
// page cannot drift from the rule.
function documentedCommand(): string {
  const page = fs.readFileSync(path.join(ROOT, 'docs', 'security.md'), 'utf8');
  const line = page.split('\n').map((l) => l.trim()).find((l) => l.startsWith('find . -type f'));
  assert.ok(line !== undefined, 'docs/security.md gives the shasum command');
  return line;
}

// Names whose byte order and a locale's order disagree, a dotfile npm packages carry, nesting
// deeper than one level, an empty file and a Finder file that is left out.
const FIXTURE = {
  'src/main.ts': 'console.log("main");\n',
  'src/a-b.ts': 'export {};\n',
  'src/a/b.ts': 'export const b = 1;\n',
  'src/a.b.ts': 'export const c = 2;\n',
  'Zeta.json': '{}\n',
  'alpha.json': '{"a":1}\n',
  'node_modules/pkg/.eslintrc': 'root: true\n',
  'node_modules/pkg/lib/deep/x.js': 'module.exports = 1;\n',
  'ui/empty.css': '',
  'ui/.DS_Store': 'Bud1',
};

test('the digest is what shasum gives for the same files, by the command docs/security.md prints', () => {
  const root = tree(FIXTURE);
  const ours = payloadDigest(root);
  assert.deepEqual(ours.problems, []);
  assert.equal(ours.files, Object.keys(FIXTURE).length - 1, 'every file but the .DS_Store');
  const theirs = execFileSync('/bin/sh', ['-c', documentedCommand()], { cwd: root, encoding: 'utf8' }).trim().split(/\s+/)[0];
  assert.equal(ours.digest, theirs);
  // The lines themselves are shasum's, in byte order of the paths.
  const lines = execFileSync('/bin/sh', ['-c', documentedCommand().replace(/ \| shasum -a 256$/, '')], { cwd: root, encoding: 'utf8' });
  assert.equal(ours.manifest, lines);
  assert.deepEqual(
    ours.manifest.trim().split('\n').map((l) => l.slice(66)),
    ['Zeta.json', 'alpha.json', 'node_modules/pkg/.eslintrc', 'node_modules/pkg/lib/deep/x.js', 'src/a-b.ts', 'src/a.b.ts', 'src/a/b.ts', 'src/main.ts', 'ui/empty.css'],
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('content and names decide the digest, and modes and times do not', () => {
  const a = tree(FIXTURE);
  const b = tree(FIXTURE);
  fs.chmodSync(path.join(b, 'src', 'main.ts'), 0o755);
  fs.utimesSync(path.join(b, 'alpha.json'), new Date(0), new Date(0));
  assert.equal(payloadDigest(a).digest, payloadDigest(b).digest);
  fs.appendFileSync(path.join(b, 'src', 'main.ts'), ' ');
  assert.notEqual(payloadDigest(a).digest, payloadDigest(b).digest, 'one byte more is another digest');
  fs.renameSync(path.join(a, 'alpha.json'), path.join(a, 'alpha2.json'));
  assert.notEqual(payloadDigest(a).digest, payloadDigest(tree(FIXTURE)).digest, 'a renamed file is another digest');
  for (const dir of [a, b]) fs.rmSync(dir, { recursive: true, force: true });
});

test('a link, a backslash in a name and a Mach-O file cannot ship', () => {
  const root = tree({ 'src/main.ts': 'x\n', 'lib/addon.node': Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), crypto.randomBytes(64)]) });
  fs.symlinkSync(path.join(root, 'src', 'main.ts'), path.join(root, 'src', 'linked.ts'));
  fs.writeFileSync(path.join(root, 'src', 'back\\slash.ts'), 'x\n');
  const problems = payloadDigest(root).problems.join('\n');
  assert.match(problems, /src\/linked\.ts is neither a file nor a folder/);
  assert.match(problems, /back\\\\slash\.ts.*newline or a backslash/);
  assert.match(problems, /lib\/addon\.node is a Mach-O file/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('the bundler seals the payload npm left without its own files, and the boot check cannot change it', () => {
  const bundler = fs.readFileSync(path.join(ROOT, 'scripts', 'bundle-payload.ts'), 'utf8');
  const dropped = /const DROP_PACKAGES = \[([^\]]*)\]/.exec(bundler)?.[1] ?? '';
  for (const name of ["'.bin'", "'.package-lock.json'"]) assert.ok(dropped.includes(name), `node_modules/${name} is dropped`);
  const steps = ['stagePayload();', 'const digest = sealPayload();', 'await verifyBoots();', 'unchangedSince(digest);'].map((s) => bundler.lastIndexOf(s));
  assert.ok(steps.every((at, i) => at > 0 && (i === 0 || at > steps[i - 1])), 'staged, sealed, booted, then proved untouched');

  const build = fs.readFileSync(path.join(ROOT, 'src-tauri', 'build.rs'), 'utf8');
  assert.match(build, /payload\/phosphor\.sha256/);
  assert.match(build, /cargo:rustc-env=PHOSPHOR_PAYLOAD_DIGEST=/);
  // A development copy keeps files an older payload had; it is cleared before tauri_build copies.
  const cleared = build.indexOf('remove_dir_all(profile)');
  assert.ok(cleared > 0 && cleared < build.indexOf('tauri_build::build()'), 'the copy next to a development binary is cleared, then copied whole');
  const shell = fs.readFileSync(path.join(ROOT, 'src-tauri', 'src', 'payload.rs'), 'utf8');
  assert.match(shell, /pub const BUILT_FOR: &str = env!\("PHOSPHOR_PAYLOAD_DIGEST"\);/);
});
