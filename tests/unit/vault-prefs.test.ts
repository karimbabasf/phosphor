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

import { DEFAULT_IDLE_MINUTES, createVaultPrefs } from '../../src/vault/prefs.ts';
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
