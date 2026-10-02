// The updater signer is the one place a release holds the update key, and it runs on Node alone.
// These hold it to the key and signature format Tauri's own CLI writes (the repo's
// devDependency), in both directions, and to its refusals. src-tauri/src/update.rs checks its
// signatures with the plugin's own verifier on top.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decodeSecretKey, keyIdHex, scryptParams, signFile, verifyFile } from '../../scripts/updater-sign.ts';

const root = new URL('../../', import.meta.url);
const tauri = new URL('node_modules/.bin/tauri', root).pathname;
const script = new URL('scripts/updater-sign.ts', root).pathname;

/* A throwaway key from `tauri signer generate`, in a private temporary folder. */
function throwaway(password: string): { dir: string; key: string; pub: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-updater-sign-'));
  const key = path.join(dir, 'throwaway.key');
  execFileSync(tauri, ['signer', 'generate', '--ci', '-p', password, '-w', key], { stdio: 'pipe' });
  return { dir, key, pub: fs.readFileSync(`${key}.pub`, 'utf8') };
}

test('scrypt parameters are libsodium\'s for the limits a key stores', () => {
  assert.deepEqual(scryptParams(1048576, 33554432), { N: 32768, r: 8, p: 1 }); // what tauri signer generate writes
  assert.deepEqual(scryptParams(33554432, 1073741824), { N: 1048576, r: 8, p: 1 }); // minisign's sensitive limits
  assert.deepEqual(scryptParams(524288, 16777216), { N: 16384, r: 8, p: 1 }); // libsodium's interactive limits
  assert.deepEqual(scryptParams(32768, 1073741824), { N: 1024, r: 8, p: 1 }); // few operations, much memory
});

test('a key tauri wrote opens with its password, from its contents or its path, and not without', () => {
  const { dir, key, pub } = throwaway('correct horse');
  try {
    const opened = decodeSecretKey(fs.readFileSync(key, 'utf8'), 'correct horse');
    const line = Buffer.from(pub, 'base64').toString('utf8').split('\n')[1];
    assert.equal(Buffer.concat([Buffer.from('Ed'), opened.keyId, opened.publicKey]).toString('base64'), line);
    assert.match(Buffer.from(pub, 'base64').toString('utf8'), new RegExp(`minisign public key: ${keyIdHex(opened.keyId)}`));
    assert.ok(decodeSecretKey(key, 'correct horse').publicKey.equals(opened.publicKey));
    assert.throws(() => decodeSecretKey(key, 'wrong horse'), /did not open/);
    assert.throws(() => decodeSecretKey('not a key', ''), /not a password-protected minisign key/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('tauri\'s signature passes this check, and this signer\'s has tauri\'s shape and passes it too', () => {
  const { dir, key, pub } = throwaway('');
  try {
    const file = path.join(dir, 'Phosphor.app.tar.gz');
    fs.writeFileSync(file, 'the updater bundle');
    execFileSync(tauri, ['signer', 'sign', '-f', key, file], { stdio: 'pipe', env: { ...process.env, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '' } });
    const data = fs.readFileSync(file);
    const theirs = fs.readFileSync(`${file}.sig`, 'utf8');
    assert.ok(verifyFile(data, theirs, pub), 'tauri signer sign verifies here');

    const ours = signFile(data, decodeSecretKey(key, ''), 'timestamp:1790000000\tfile:Phosphor.app.tar.gz');
    assert.ok(verifyFile(data, ours, pub));
    const text = (sig: string) => Buffer.from(sig, 'base64').toString('utf8').split('\n');
    const [a, b] = [text(theirs), text(ours)];
    assert.equal(b.length, a.length, 'same number of lines, the last one empty');
    assert.equal(b[0], a[0], 'same untrusted comment');
    assert.deepEqual(Buffer.from(b[1], 'base64').subarray(0, 10), Buffer.from(a[1], 'base64').subarray(0, 10), 'prehashed ED and the same key id');
    assert.match(b[2], /^trusted comment: timestamp:\d+\tfile:Phosphor\.app\.tar\.gz$/);

    assert.ok(!verifyFile(Buffer.concat([data, Buffer.from('!')]), ours, pub), 'a changed file fails');
    const forged = Buffer.from(Buffer.from(ours, 'base64').toString('utf8').replace('timestamp:1790000000', 'timestamp:1790000001')).toString('base64');
    assert.ok(!verifyFile(data, forged, pub), 'a changed trusted comment fails');
    const other = throwaway('');
    try {
      assert.ok(!verifyFile(data, ours, other.pub), 'another key fails');
    } finally {
      fs.rmSync(other.dir, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the script writes a .sig only when it verifies against the key it was told to trust', () => {
  const { dir, key } = throwaway('pw');
  try {
    const file = path.join(dir, 'Phosphor.app.tar.gz');
    fs.writeFileSync(file, 'the updater bundle');
    const run = (args: string[], password: string) =>
      spawnSync(process.execPath, [script, file, ...args], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '', TAURI_SIGNING_PRIVATE_KEY: key, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password },
      });

    const wrong = run(['--public-key', `${key}.pub`], 'not pw');
    assert.notEqual(wrong.status, 0);
    assert.match(wrong.stderr, /did not open/);
    assert.ok(!fs.existsSync(`${file}.sig`));

    // A throwaway key is not the one installed copies trust: the shipped public key refuses it.
    const untrusted = run([], 'pw');
    assert.notEqual(untrusted.status, 0);
    assert.match(untrusted.stderr, /not the key installed copies trust; nothing was written/);
    assert.ok(!fs.existsSync(`${file}.sig`));

    const ok = run(['--public-key', `${key}.pub`], 'pw');
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /Phosphor\.app\.tar\.gz\.sig verifies against .*throwaway\.key\.pub/);
    assert.ok(verifyFile(fs.readFileSync(file), fs.readFileSync(`${file}.sig`, 'utf8'), fs.readFileSync(`${key}.pub`, 'utf8')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a key id prints the way minisign prints it, with no leading zeros', () => {
  // A key id is a little-endian u64 that minisign and tauri print as `{:X}`. Seen from tauri
  // signer generate: the id 0x0C8B6D7C134FFF23 is "minisign public key: C8B6D7C134FFF23".
  const id = (hex: string) => Buffer.from(hex.padStart(16, '0'), 'hex').reverse();
  assert.equal(keyIdHex(id('0C8B6D7C134FFF23')), 'C8B6D7C134FFF23');
  assert.equal(keyIdHex(id('00AB2B2A5CAE6A6F')), 'AB2B2A5CAE6A6F');
  assert.equal(keyIdHex(id('AB2B2A5CAE6A6FB9')), 'AB2B2A5CAE6A6FB9');
  assert.equal(keyIdHex(id('0')), '0');
});

test('the shipped public key is a minisign key the check can read, its comment naming its own id', () => {
  const conf = JSON.parse(fs.readFileSync(new URL('src-tauri/tauri.conf.json', root), 'utf8'));
  const text = Buffer.from(conf.plugins.updater.pubkey, 'base64').toString('utf8');
  const [, named, line] = text.match(/^untrusted comment: minisign public key: ([0-9A-F]{1,16})\n([A-Za-z0-9+/]{56})\n?$/) ?? [];
  assert.ok(line, text);
  const pk = Buffer.from(line, 'base64');
  assert.equal(pk.toString('latin1', 0, 2), 'Ed');
  assert.equal(keyIdHex(pk.subarray(2, 10)), named);
  assert.equal(named, 'AB2B2A5CAE6A6FB9');
});
