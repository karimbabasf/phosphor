// How long the window may sit idle before the wallet locks, and whose choice that is.
//
// The default went from fifteen minutes to five in 0.10.13. A wallet that picked a time keeps
// it; a wallet that never picked follows the default, including one whose file still holds the
// fifteen that 0.10.12 and earlier saved beside every other write. The last test boots the real
// app, because the app's clock used to ignore this file altogether and lock at fifteen minutes
// whatever the Vault tab said.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { base58Encode } from '../../src/chain/near.ts';
import { DEFAULT_ALLOWANCE_USD, DEFAULT_IDLE_MINUTES, MAX_ALLOWANCE_USD, createVaultPrefs } from '../../src/vault/prefs.ts';
import { tempDir } from './helpers/tmp.ts';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

function tmpDir(): string {
  return tempDir('phosphor-vault-prefs-');
}

function onDisk(dir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(dir, 'vault.json'), 'utf8')) as Record<string, unknown>;
}

test('a wallet that never picked locks after five minutes, and backing up does not pick for it', () => {
  assert.equal(DEFAULT_IDLE_MINUTES, 5);
  const dir = tmpDir();
  const prefs = createVaultPrefs(dir);
  assert.equal(prefs.get().idleMinutes, 5);
  prefs.markBackedUp();
  assert.equal(prefs.get().idleMinutes, 5);
  assert.equal(onDisk(dir).idleMinutes, undefined, 'the default is not written down as if it were a choice');
  prefs.clearBackedUp();
  assert.equal(onDisk(dir).idleMinutes, undefined);
});

test('a time picked on purpose is kept, the old default included, through every other write', () => {
  for (const minutes of [5, 15, 60]) {
    const dir = tmpDir();
    const prefs = createVaultPrefs(dir);
    assert.equal(prefs.setIdleMinutes(minutes).idleMinutes, minutes);
    prefs.markBackedUp();
    prefs.clearBackedUp();
    assert.equal(createVaultPrefs(dir).get().idleMinutes, minutes);
    assert.deepEqual([onDisk(dir).idleMinutes, onDisk(dir).idleChosen], [minutes, true]);
  }
  assert.throws(() => createVaultPrefs(tmpDir()).setIdleMinutes(7), /one of 5, 15, 60/);
});

test('a file 0.10.12 wrote keeps a picked 5 or 60, and its saved fifteen reads as no choice', () => {
  const cases: [Record<string, unknown>, number][] = [
    [{ backedUp: true, backedUpAt: '2026-09-20T10:00:00.000Z', idleMinutes: 15 }, 5],
    [{ backedUp: false, backedUpAt: null, idleMinutes: 15 }, 5],
    [{ backedUp: false, backedUpAt: null, idleMinutes: 5 }, 5],
    [{ backedUp: true, backedUpAt: null, idleMinutes: 60 }, 60],
    [{ backedUp: false, backedUpAt: null, idleMinutes: 7 }, 5],
    [{ backedUp: true, backedUpAt: null }, 5],
  ];
  for (const [old, expected] of cases) {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'vault.json'), JSON.stringify(old, null, 2) + '\n');
    const prefs = createVaultPrefs(dir);
    assert.equal(prefs.get().idleMinutes, expected, JSON.stringify(old));
    assert.equal(prefs.get().backedUp, old.backedUp === true, 'the backed-up flag is read as it was');
    prefs.markBackedUp();
    assert.equal(createVaultPrefs(dir).get().idleMinutes, expected, `still ${expected} after the next write: ${JSON.stringify(old)}`);
  }
});

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

test('the app locks on the time the Vault tab shows: five minutes by default, an hour once picked', async (t) => {
  const dir = tmpDir();
  t.diagnostic(`backend data path: ${dir}`);
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'main.ts')], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: path.join(dir, 'home'),
      PHOSPHOR_MODE: 'demo',
      PHOSPHOR_PORT: String(port),
      PHOSPHOR_DATA_DIR: path.join(dir, 'data', 'state'),
      PHOSPHOR_CONFIG_DIR: path.join(dir, 'data'),
      PHOSPHOR_KEYS: path.join(dir, 'keys.enc.json'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const [token, nonce, seat, transport, relay] = Array.from({ length: 5 }, () => crypto.randomBytes(32).toString('hex'));
  child.stdin.write(`${token}\n${nonce}\n${seat}\n${transport}\n${relay}\n`);
  child.stdin.end();
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => (stderr += chunk));
  const origin = `http://127.0.0.1:${port}`;
  const post = async (route: string, body: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const res = await fetch(`${origin}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ token, ...body }),
    });
    return (await res.json()) as Record<string, unknown>;
  };

  try {
    const up = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 25_000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (!chunk.includes(origin)) return;
        clearTimeout(timer);
        resolve(true);
      });
    });
    assert.ok(up, `the backend never came up: ${stderr}`);

    const made = await post('/api/wallet/create', { password: crypto.randomBytes(12).toString('hex') });
    assert.equal(made.ok, true, JSON.stringify(made));
    const fresh = Number((await post('/api/activity', {})).idleLocksInSec);
    assert.ok(fresh > 290 && fresh <= 300, `a fresh wallet locks in five minutes, not ${fresh} s`);

    assert.equal((await post('/api/vault/prefs', { idleMinutes: 60 })).idleMinutes, 60);
    const picked = Number((await post('/api/activity', {})).idleLocksInSec);
    assert.ok(picked > 3590 && picked <= 3600, `the hour picked in the Vault tab is the hour the clock runs, not ${picked} s`);
  } finally {
    child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* The flag the bind flow reads names the wallet it was proven for (src/http/vault.ts,
   backupProven), so a key file swapped in from outside the app does not inherit it. */
test('a proof names its wallet in lower case, a clear forgets it, and a file from before names none', () => {
  const dir = tmpDir();
  const prefs = createVaultPrefs(dir);
  assert.equal(prefs.get().backedUpFor, null);
  const marked = prefs.markBackedUp(() => Date.parse('2026-10-02T10:00:00.000Z'), '0xAbC0000000000000000000000000000000000001');
  assert.deepEqual([marked.backedUp, marked.backedUpAt, marked.backedUpFor], [true, '2026-10-02T10:00:00.000Z', '0xabc0000000000000000000000000000000000001']);
  assert.equal(onDisk(dir).backedUpFor, '0xabc0000000000000000000000000000000000001');
  prefs.clearBackedUp();
  assert.equal(onDisk(dir).backedUpFor, undefined);
  assert.equal(createVaultPrefs(dir).get().backedUpFor, null);
  prefs.markBackedUp();
  assert.equal(createVaultPrefs(dir).get().backedUpFor, null, 'a proof with no wallet names none');

  const old = tmpDir();
  fs.writeFileSync(path.join(old, 'vault.json'), JSON.stringify({ backedUp: true, backedUpAt: '2026-09-20T10:00:00.000Z' }, null, 2) + '\n');
  assert.deepEqual(createVaultPrefs(old).get(), {
    backedUp: true,
    backedUpAt: '2026-09-20T10:00:00.000Z',
    backedUpFor: null,
    idleMinutes: 5,
    chip: null,
    allowance: { sizeUsd: 100 },
  });
});

// ---------- Phase 2: the chip entry and the allowance size ----------

const CHIP_TAG = 'com.karimbabasf.phosphor.chip.p2-test.0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0';

/* A P-256 public key as the chip service spells it: "p256:" and the base58 of x || y. */
function chipPublicKey(): string {
  const jwk = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  return 'p256:' + base58Encode(Buffer.concat([Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]));
}

test('the chip entry is written once the move is done, survives every other write, and names its vault', () => {
  const dir = tmpDir();
  const prefs = createVaultPrefs(dir);
  assert.equal(prefs.get().chip, null);
  prefs.markBackedUp();
  assert.equal(onDisk(dir).chip, undefined, 'nothing is written for a vault that never moved');
  const publicKey = chipPublicKey();
  const set = prefs.setChip({ keyRef: `chip:${CHIP_TAG}`, publicKey, account: '0xAbC0000000000000000000000000000000000001' }, () => Date.parse('2026-10-04T12:00:00.000Z'));
  const expected = { keyRef: `chip:${CHIP_TAG}`, publicKey, account: '0xabc0000000000000000000000000000000000001', migratedAt: '2026-10-04T12:00:00.000Z' };
  assert.deepEqual(set.chip, expected);
  prefs.markBackedUp();
  prefs.setIdleMinutes(60);
  prefs.setAllowanceSize(25);
  prefs.clearBackedUp();
  assert.deepEqual(createVaultPrefs(dir).get().chip, expected, 'every other write keeps it');
  assert.deepEqual(onDisk(dir).chip, expected);
  assert.equal(prefs.setChip(null).chip, null);
  assert.equal(onDisk(dir).chip, undefined);
  assert.equal(createVaultPrefs(dir).get().allowance.sizeUsd, 25, 'clearing the chip keeps the size');
});

test('the chip entry takes only a real key ref, a P-256 point and a 0x account', () => {
  const prefs = createVaultPrefs(tmpDir());
  const good = { keyRef: `chip:${CHIP_TAG}`, publicKey: chipPublicKey(), account: '0x' + 'ab'.repeat(20) };
  for (const keyRef of [
    CHIP_TAG,
    `keychain:${CHIP_TAG}`,
    'chip:com.karimbabasf.phosphor.vault.0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0',
    `chip:${CHIP_TAG.toLowerCase()}`,
    'chip:com.karimbabasf.phosphor.chip.Bad_Label.0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0',
    `chip:${CHIP_TAG}x`,
  ]) {
    assert.throws(() => prefs.setChip({ ...good, keyRef }), /chip key ref/, keyRef);
  }
  assert.doesNotThrow(() => prefs.setChip({ ...good, keyRef: 'chip:com.karimbabasf.phosphor.chip.0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0' }), 'the label is optional');
  const offCurve = 'p256:' + base58Encode(Buffer.alloc(64, 7));
  const short = 'p256:' + base58Encode(Buffer.alloc(33, 2));
  for (const publicKey of [good.publicKey.slice('p256:'.length), offCurve, short, 'p256:0OIl', 'ed25519:' + good.publicKey.slice(5)]) {
    assert.throws(() => prefs.setChip({ ...good, publicKey }), /P-256 point/, publicKey);
  }
  for (const account of ['0x' + 'ab'.repeat(19), 'ab'.repeat(20), 'vault.near']) {
    assert.throws(() => prefs.setChip({ ...good, account }), /0x address/, account);
  }
});

test('a chip entry the file holds and cannot read still counts as one', () => {
  for (const chip of [{}, 'yes', true, { keyRef: 7 }]) {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'vault.json'), JSON.stringify({ backedUp: false, backedUpAt: null, chip }) + '\n');
    assert.deepEqual(createVaultPrefs(dir).get().chip, { keyRef: '', publicKey: '', account: '', migratedAt: '' }, JSON.stringify(chip));
  }
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'vault.json'), JSON.stringify({ backedUp: false, backedUpAt: null, chip: null }) + '\n');
  assert.equal(createVaultPrefs(dir).get().chip, null, 'null is no entry');
});

test('the allowance is $100 until somebody picks, and a pick is a dollar amount in cents', () => {
  const dir = tmpDir();
  const prefs = createVaultPrefs(dir);
  assert.equal(DEFAULT_ALLOWANCE_USD, 100);
  assert.deepEqual(prefs.get().allowance, { sizeUsd: 100 });
  prefs.markBackedUp();
  assert.equal(onDisk(dir).allowance, undefined, 'the default is not written down as if it were a choice');
  assert.deepEqual(prefs.setAllowanceSize(0).allowance, { sizeUsd: 0 }, 'zero sends everything home');
  assert.deepEqual(prefs.setAllowanceSize(12.345).allowance, { sizeUsd: 12.35 });
  assert.deepEqual(onDisk(dir).allowance, { sizeUsd: 12.35 });
  for (const usd of [-1, Number.NaN, Number.POSITIVE_INFINITY, MAX_ALLOWANCE_USD + 1, '5' as unknown as number]) {
    assert.throws(() => prefs.setAllowanceSize(usd), /dollar amount/, String(usd));
  }
  fs.writeFileSync(path.join(dir, 'vault.json'), JSON.stringify({ backedUp: false, backedUpAt: null, allowance: { sizeUsd: -3 } }) + '\n');
  assert.deepEqual(createVaultPrefs(dir).get().allowance, { sizeUsd: 100 }, 'a size the file cannot hold reads as the default');
});
