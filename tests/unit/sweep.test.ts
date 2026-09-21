// The secret sweep's two structural rules, held to their word. The sweep sat red for days on
// Cargo.lock's crate checksums and on a twelve word comment, and while it was red gitleaks
// was the only scan that ran. Each rule here excuses exactly one shape and nothing beside it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FAKE_PEM_FIXTURE, KNOWN_PUBLIC_CONSTANTS, isMnemonicRun, publicFormat, scanContent, type Finding } from '../../scripts/sweep.ts';

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
