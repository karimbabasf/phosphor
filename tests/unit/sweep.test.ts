// The secret sweep's two structural rules, held to their word. The sweep sat red for days on
// Cargo.lock's crate checksums and on a twelve word comment, and while it was red gitleaks
// was the only scan that ran. Each rule here excuses exactly one shape and nothing beside it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { FAKE_PEM_FIXTURE, KNOWN_PUBLIC_CONSTANTS, historyCheck, historyScope, isMnemonicRun, publicFormat, scanContent, type Finding } from '../../scripts/sweep.ts';

// Made from characters, never written out: a 64 hex value that is on no allowlist and is not
// regular enough to be excused as a ruler.
const DIGEST = Array.from({ length: 64 }, (_, i) => '0123456789abcdef'[(i * 7 + 3) % 16]).join('');

function findings(file: string, content: string): Finding[] {
  const out: Finding[] = [];
  scanContent('worktree', file, content, out);
  return out;
}

const CRATES_IO = 'source = "registry+https://github.com/rust-lang/crates.io-index"';

test('a Cargo.lock checksum line is a crate digest only inside a crates.io package block of the one lockfile', () => {
  const lockfile = ['[[package]]', 'name = "serde"', 'version = "1.0.219"', CRATES_IO, `checksum = "${DIGEST}"`, '', '[[package]]', 'name = "other"'].join('\n');
  assert.deepEqual(findings('src-tauri/Cargo.lock', lockfile), [], 'the checksum line tripped');
  assert.equal(publicFormat('src-tauri/Cargo.lock', lockfile.split('\n'), 4)?.note, 'crate checksum from the registry index');

  const smuggled = findings('src-tauri/Cargo.lock', `source = "${DIGEST}"\n# ${DIGEST}\nchecksum = "${DIGEST}" # trailing`);
  assert.deepEqual(smuggled.map((f) => f.line), [1, 2, 3], 'a value outside the checksum field of a lockfile was excused');

  // The reviewer's plant: a checksum line with no package block above it, one under a git
  // source, one under a block that a blank line already closed, and one in a lockfile that is
  // not this repo's. Each is a finding.
  const planted: Array<[string, string]> = [
    ['src-tauri/Cargo.lock', `checksum = "${DIGEST}"`],
    ['src-tauri/Cargo.lock', ['[[package]]', 'name = "x"', 'source = "git+https://github.com/x/y#abc"', `checksum = "${DIGEST}"`].join('\n')],
    ['src-tauri/Cargo.lock', ['[[package]]', 'name = "x"', CRATES_IO, '', `checksum = "${DIGEST}"`].join('\n')],
    ['src-tauri/Cargo.lock', ['[metadata]', CRATES_IO, `checksum = "${DIGEST}"`].join('\n')],
    ['scratch/Cargo.lock', ['[[package]]', 'name = "x"', CRATES_IO, `checksum = "${DIGEST}"`].join('\n')],
    ['Cargo.lock', ['[[package]]', 'name = "x"', CRATES_IO, `checksum = "${DIGEST}"`].join('\n')],
  ];
  for (const [file, content] of planted) {
    const found = findings(file, content);
    assert.equal(found.length, 1, `${file}: a planted checksum line was excused: ${JSON.stringify(content)}`);
    assert.equal(found[0].pattern, 'hex64');
  }

  const elsewhere = findings('src/config.ts', `checksum = "${DIGEST}"`);
  assert.equal(elsewhere.length, 1, 'the lockfile shape excused a value in a source file');
});

test('a bridge token line is excused only when both of its address fields carry the same value', () => {
  const file = 'tests/fixtures/poa-tokens.json';
  const row = (a: string, b: string) =>
    `    {"defuse_asset_identifier":"aptos:mainnet:0x${a}","origin_chain_address":"0x${b}","near_token_id":"aptos-1.omft.near","decimals":6,"standard":"nep141"},`;
  assert.deepEqual(findings(file, row(DIGEST, DIGEST)), [], 'a bridge token row tripped');
  const other = DIGEST.slice(1) + '0';
  assert.equal(findings(file, row(DIGEST, other)).length, 2, 'two different values on one bridge row were excused');
  assert.equal(findings('tests/fixtures/other.json', row(DIGEST, DIGEST)).length, 2, 'the bridge shape excused a value in another fixture');
});

test('a mnemonic is twelve seed words, not any twelve short words', () => {
  assert.equal(isMnemonicRun('already receives every waiting row and the twenty most recent decided ones'), false);
  assert.equal(isMnemonicRun('abandon '.repeat(11) + 'about'), true);
  assert.equal(isMnemonicRun('abandon '.repeat(10) + 'about'), false, 'eleven words is not a mnemonic length');
  const prose = findings('ui/screens/agent.js', '     already receives every waiting row and the twenty most recent decided ones\n');
  assert.deepEqual(prose, []);
  const seed = findings('notes.md', `"${'abandon '.repeat(11)}about"`);
  assert.deepEqual(seed.map((f) => f.pattern), ['mnemonic']);
});

test('a fake PEM block is excused only as the exact block, and a real header still trips', () => {
  const fake = FAKE_PEM_FIXTURE;
  assert.ok(fake.startsWith(['-----BEGIN', 'EC PRIVATE KEY-----'].join(' ')) && fake.split('\\n').length === 3, 'the fixture is one line with two escaped newlines');
  assert.ok(KNOWN_PUBLIC_CONSTANTS.has(fake), 'the fixture is on the allowlist by its whole one-line value');
  assert.deepEqual(findings('a.ts', `const pem = '${fake}';`), []);
  const other = fake.replace('MHQCAQEEIBc', 'MHQCAQEEIBd');
  assert.deepEqual(findings('a.ts', `const pem = '${other}';`).map((f) => f.pattern), ['pem-block'], 'a different body was excused');
  const header = ['-----BEGIN', 'EC PRIVATE KEY-----'].join(' '); // assembled, so this file never holds a bare header
  assert.deepEqual(findings('key.pem', header).map((f) => f.pattern), ['pem-block'], 'a header on its own line was excused');
});

test('a public hex constant is excused whatever its case, and never printed in a finding', () => {
  const [value] = [...KNOWN_PUBLIC_CONSTANTS.keys()].filter((k) => /^[0-9a-f]{64}$/.test(k));
  assert.deepEqual(findings('a.ts', `const h = '0x${value.toUpperCase()}';`), []);
  const [found] = findings('a.ts', `const h = '0x${DIGEST}';`);
  assert.equal(found.fingerprint.length, 8);
  assert.equal(JSON.stringify(found).includes(DIGEST), false, 'a finding carries the value it found');
});

// The history scope. A throwaway repo holds one planted digest per kind of ref: the branch being
// released (HEAD), a remote-tracking branch whose local branch is gone, a tag on a commit no
// branch holds, and a local scratch branch that never left the clone. Git runs without the
// global and system config, so a signing key or a hook on this Mac cannot change what is built.
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'sweep',
  GIT_AUTHOR_EMAIL: 'sweep@example.invalid',
  GIT_COMMITTER_NAME: 'sweep',
  GIT_COMMITTER_EMAIL: 'sweep@example.invalid',
};

const planted = (k: number) => Array.from({ length: 64 }, (_, i) => '0123456789abcdef'[(i * 7 + k) % 16]).join('');

function plantedRepo(): { dir: string; done: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-history-'));
  const dir = path.join(root, 'work');
  fs.mkdirSync(dir);
  const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, env: GIT_ENV, stdio: 'pipe' });
  const commit = (file: string, text: string) => {
    fs.writeFileSync(path.join(dir, file), text);
    run('add', file);
    run('commit', '-q', '-m', file);
  };
  run('init', '-q', '-b', 'main');
  commit('readme.txt', 'nothing to see\n');
  run('update-ref', 'refs/remotes/origin/main', 'HEAD');
  run('checkout', '-q', '-b', 'old-feature');
  commit('remote.txt', `${planted(1)}\n`);
  run('update-ref', 'refs/remotes/origin/old-feature', 'HEAD');
  run('checkout', '-q', 'main');
  run('branch', '-q', '-D', 'old-feature');
  run('checkout', '-q', '--detach');
  commit('tag.txt', `${planted(3)}\n`);
  run('tag', 'v0.0.1');
  run('checkout', '-q', '-b', 'scratch', 'main');
  commit('scratch.txt', `${planted(5)}\n`);
  run('checkout', '-q', 'main');
  commit('head.txt', `${planted(7)}\n`);
  return { dir, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('the history scan reads what a push can publish, HEAD, the remote branches and the tags, and no local scratch branch', () => {
  const { dir, done } = plantedRepo();
  try {
    const seen = (scope: string) => historyCheck(scope, dir).findings.map((f) => f.file).sort();
    assert.deepEqual(seen('published'), ['head.txt', 'remote.txt', 'tag.txt']);
    assert.deepEqual(seen('all'), ['head.txt', 'remote.txt', 'scratch.txt', 'tag.txt'], 'the old scope, every ref, still works by flag');
    assert.deepEqual(seen('scratch'), ['scratch.txt']);
    const pushed = historyCheck('origin/main', dir);
    assert.equal(pushed.ok, true, pushed.detail);
    assert.match(pushed.detail, /^\d+ blobs reachable from origin\/main scanned$/);
    const unknown = historyCheck('no-such-branch', dir);
    assert.equal(unknown.ok, false, 'a revision git does not know passed as an empty history');
    assert.match(unknown.detail, /^cannot list the history of no-such-branch/);
    assert.equal(historyCheck('--all', dir).ok, false, 'a scope starting with a dash reached git as an option');
  } finally {
    done();
  }
});

test('a shallow clone fails the history check instead of passing on a tip with nothing behind it', () => {
  const { dir, done } = plantedRepo();
  try {
    const shallow = path.join(path.dirname(dir), 'shallow');
    execFileSync('git', ['clone', '-q', '--depth', '1', '--branch', 'main', pathToFileURL(dir).href, shallow], { env: GIT_ENV, stdio: 'pipe' });
    const result = historyCheck('published', shallow);
    assert.equal(result.ok, false);
    assert.match(result.detail, /^shallow clone/);
  } finally {
    done();
  }
});

test('--history takes published, all or one revision, and anything else stops the sweep', () => {
  assert.equal(historyScope([]), 'published');
  assert.equal(historyScope(['--history=all']), 'all');
  assert.equal(historyScope(['--history=origin/main']), 'origin/main');
  assert.throws(() => historyScope(['--history', 'origin/main']), /unknown argument --history/, 'a space instead of = fell back to the default scope');
  assert.throws(() => historyScope(['--history=']), /unknown argument/);
  assert.throws(() => historyScope(['--all']), /unknown argument --all/);
});
