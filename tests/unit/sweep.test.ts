// The secret sweep's two structural rules, held to their word. The sweep sat red for days on
// Cargo.lock's crate checksums and on a twelve word comment, and while it was red gitleaks
// was the only scan that ran. Each rule here excuses exactly one shape and nothing beside it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KNOWN_PUBLIC_CONSTANTS, isMnemonicRun, publicFormat, scanContent, type Finding } from '../../scripts/sweep.ts';

// Made from characters, never written out: a 64 hex value that is on no allowlist and is not
// regular enough to be excused as a ruler.
const DIGEST = Array.from({ length: 64 }, (_, i) => '0123456789abcdef'[(i * 7 + 3) % 16]).join('');

function findings(file: string, content: string): Finding[] {
  const out: Finding[] = [];
  scanContent('worktree', file, content, out);
  return out;
}

test('a Cargo.lock checksum line is a crate digest, and the same value anywhere else still trips', () => {
  const lockfile = ['[[package]]', 'name = "serde"', 'version = "1.0.219"', `checksum = "${DIGEST}"`].join('\n');
  assert.deepEqual(findings('src-tauri/Cargo.lock', lockfile), [], 'the checksum line tripped');
  assert.equal(publicFormat('src-tauri/Cargo.lock', `checksum = "${DIGEST}"`)?.note, 'crate checksum from the registry index');

  const smuggled = findings('src-tauri/Cargo.lock', `source = "${DIGEST}"\n# ${DIGEST}\nchecksum = "${DIGEST}" # trailing`);
  assert.deepEqual(smuggled.map((f) => f.line), [1, 2, 3], 'a value outside the checksum field of a lockfile was excused');

  const elsewhere = findings('src/config.ts', `checksum = "${DIGEST}"`);
  assert.equal(elsewhere.length, 1, 'the lockfile shape excused a value in a source file');
  assert.equal(elsewhere[0].pattern, 'hex64');
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

test('a public hex constant is excused whatever its case, and never printed in a finding', () => {
  const [value] = [...KNOWN_PUBLIC_CONSTANTS.keys()].filter((k) => /^[0-9a-f]{64}$/.test(k));
  assert.deepEqual(findings('a.ts', `const h = '0x${value.toUpperCase()}';`), []);
  const [found] = findings('a.ts', `const h = '0x${DIGEST}';`);
  assert.equal(found.fingerprint.length, 8);
  assert.equal(JSON.stringify(found).includes(DIGEST), false, 'a finding carries the value it found');
});
