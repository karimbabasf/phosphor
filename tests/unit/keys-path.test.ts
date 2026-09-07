// Where the key file lives, and the one property that matters: a data directory the owner did
// not choose never reaches the wallet the owner actually uses.
//
// The bug this pins down: keysPath was derived from the REPO FOLDER NAME and never consulted
// dataDir, so a demo backend on a throwaway data dir opened the real ~/.phosphor/keys.json,
// reported needs_migration against it, and could destroy it through POST /api/wallet/migrate.
//
// Every test here points HOME at a temp directory, so none of them reads, writes or looks at
// the real ~/.phosphor.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { assertOutsideRepo, loadConfig } from '../../src/config.ts';
import { createKeystore, destroyPlaintext } from '../../src/keystore/store.ts';
import { defaultParams } from '../../src/keystore/kdf.ts';

// The address a legacy key file would leak if the scoping were wrong. It is a plain address
// with no private key beside it, which is enough: addresses() falls back to it, so seeing it
// out of a scratch instance is the leak itself.
const LEGACY_EVM = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';

function scratch(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// loadConfig reads process.env and os.homedir() directly, so every case runs with a known
// environment and puts back whatever was there.
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(vars)) {
    saved.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return fn();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

// A home directory holding the legacy global key file, exactly as an install from before the
// keystore existed leaves it.
function homeWithLegacyKeys(): string {
  const home = scratch('phosphor-home-');
  fs.mkdirSync(path.join(home, '.phosphor'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.phosphor', 'keys.json'),
    JSON.stringify({ evm: { address: LEGACY_EVM } }, null, 2),
  );
  return home;
}

function repo(): string {
  const root = scratch('phosphor-repo-');
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ port: 4177, mode: 'live' }));
  return root;
}

test('a demo instance on a scratch data dir reports no_wallet, never the legacy wallet', () => {
  const home = homeWithLegacyKeys();
  const root = repo();
  const dataDir = scratch('phosphor-demo-data-');

  const cfg = withEnv(
    { HOME: home, PHOSPHOR_KEYS: undefined, PHOSPHOR_MODE: 'demo', PHOSPHOR_DATA_DIR: dataDir, PHOSPHOR_CONFIG_DIR: undefined },
    () => loadConfig(root),
  );

  assert.equal(cfg.keysPath, path.join(dataDir, 'keys.json'), 'the key file belongs to the data dir it was given');
  assert.notEqual(cfg.keysPath, path.join(home, '.phosphor', 'keys.json'));

  const keystore = createKeystore({ keysPath: cfg.keysPath, mode: cfg.mode });
  assert.equal(keystore.state(), 'no_wallet', 'a scratch data dir holds no wallet, so there is nothing to migrate');
  assert.deepEqual(keystore.addresses(), { evm: null, solana: null, near: null, nearPublicKey: null });
});

test('the real default data dir still opens the legacy key file, so an existing install keeps working', () => {
  const home = homeWithLegacyKeys();
  const root = repo();

  const cfg = withEnv(
    { HOME: home, PHOSPHOR_KEYS: undefined, PHOSPHOR_MODE: 'live', PHOSPHOR_DATA_DIR: undefined, PHOSPHOR_CONFIG_DIR: undefined },
    () => loadConfig(root),
  );

  assert.equal(cfg.dataDir, path.join(root, 'state'));
  assert.equal(cfg.keysPath, path.join(home, '.phosphor', 'keys.json'));
  assert.equal(createKeystore({ keysPath: cfg.keysPath, mode: cfg.mode }).addresses().evm, LEGACY_EVM);
});

test('an explicit PHOSPHOR_KEYS still wins over both, because a person said where the key is', () => {
  const home = homeWithLegacyKeys();
  const root = repo();
  const dataDir = scratch('phosphor-demo-data-');
  const chosen = path.join(scratch('phosphor-chosen-'), 'keys.json');

  const cfg = withEnv(
    { HOME: home, PHOSPHOR_KEYS: chosen, PHOSPHOR_MODE: 'demo', PHOSPHOR_DATA_DIR: dataDir, PHOSPHOR_CONFIG_DIR: undefined },
    () => loadConfig(root),
  );

  assert.equal(cfg.keysPath, chosen);
});

test('a fresh default install with no legacy file gets a per-project key, not a global one', () => {
  const home = scratch('phosphor-home-');
  const root = repo();

  const cfg = withEnv(
    { HOME: home, PHOSPHOR_KEYS: undefined, PHOSPHOR_MODE: 'live', PHOSPHOR_DATA_DIR: undefined, PHOSPHOR_CONFIG_DIR: undefined },
    () => loadConfig(root),
  );

  assert.equal(cfg.keysPath, path.join(home, '.phosphor', path.basename(root), 'keys.json'));
});

// ---------- the second lock on the same door ----------

test('demo mode refuses to migrate, so a demo process cannot shred a plaintext key file', async () => {
  const dir = scratch('phosphor-migrate-');
  const keysPath = path.join(dir, 'keys.json');
  fs.writeFileSync(keysPath, JSON.stringify({ evm: { address: LEGACY_EVM } }));

  const store = createKeystore({ keysPath, mode: 'demo', kdf: () => ({ ...defaultParams(), N: 2 ** 14 }) });
  await assert.rejects(() => store.migrate('a long enough password'), /demo mode never migrates/);
  assert.ok(fs.existsSync(keysPath), 'and the file it refused to migrate is still there');
});

test('destroyPlaintext refuses outright while the process is in demo mode', () => {
  const dir = scratch('phosphor-destroy-');
  const target = path.join(dir, 'keys.json');
  fs.writeFileSync(target, JSON.stringify({ evm: { address: LEGACY_EVM } }));

  withEnv({ PHOSPHOR_MODE: 'demo', ACC_MODE: undefined }, () => {
    assert.throws(() => destroyPlaintext(target), /demo mode never destroys/);
  });
  assert.ok(fs.existsSync(target));
});

/* The installed app is the one case where a data directory the repo default does not name is
   still the app's own. It lives under Application Support, and the wallet it opens is the wallet
   it has always opened: an upgrade that moved it would be an app coming up as though the keys
   were gone. src-tauri/src/backend.rs sets PHOSPHOR_APP_DATA=1 to say so, and nothing else does. */
test('the installed app keeps the key file it has always had, wherever its data directory is', () => {
  const home = homeWithLegacyKeys();
  const root = repo();
  const support = scratch('phosphor-support-');

  const cfg = withEnv(
    {
      HOME: home,
      PHOSPHOR_KEYS: undefined,
      PHOSPHOR_MODE: 'live',
      PHOSPHOR_DATA_DIR: path.join(support, 'state'),
      PHOSPHOR_CONFIG_DIR: support,
      PHOSPHOR_APP_DATA: '1',
    },
    () => loadConfig(root),
  );

  assert.equal(cfg.keysPath, path.join(home, '.phosphor', 'keys.json'));
});

test('without that flag the same data directory carries its own wallet', () => {
  const home = homeWithLegacyKeys();
  const root = repo();
  const support = scratch('phosphor-support-');

  const cfg = withEnv(
    {
      HOME: home,
      PHOSPHOR_KEYS: undefined,
      PHOSPHOR_MODE: 'demo',
      PHOSPHOR_DATA_DIR: path.join(support, 'state'),
      PHOSPHOR_CONFIG_DIR: support,
      PHOSPHOR_APP_DATA: undefined,
    },
    () => loadConfig(root),
  );

  assert.equal(cfg.keysPath, path.join(support, 'state', 'keys.json'));
});

// A home directory as it looks AFTER the legacy wallet has been migrated: the plaintext file is
// gone, because migrating consumed it, and the encrypted one is what remains.
function homeWithMigratedKeys(): string {
  const home = scratch('phosphor-home-');
  fs.mkdirSync(path.join(home, '.phosphor'), { recursive: true });
  fs.writeFileSync(path.join(home, '.phosphor', 'keys.enc.json'), JSON.stringify({ header: {} }));
  return home;
}

/* Migrating the legacy wallet used to hide it.

   defaultKeysPath chose between the per-project path and the global one by asking which held a
   `keys.json`, and migration deletes exactly that file. So the boot after a migration found
   neither candidate, fell through to the per-project path, looked for a keystore beside it,
   found none, and told the owner of a funded mainnet wallet that they had no wallet. The keys
   were never lost. They were at ~/.phosphor/keys.enc.json the whole time, which the app had
   stopped looking at.

   The resolution has to ask about the wallet, not about one of the two files a wallet can be
   stored as. */
test('a migrated global wallet is still found once the plaintext file is gone', () => {
  const home = homeWithMigratedKeys();
  const root = repo();

  const cfg = withEnv(
    { HOME: home, PHOSPHOR_KEYS: undefined, PHOSPHOR_MODE: 'live', PHOSPHOR_DATA_DIR: undefined, PHOSPHOR_CONFIG_DIR: undefined },
    () => loadConfig(root),
  );

  assert.equal(
    cfg.keysPath,
    path.join(home, '.phosphor', 'keys.json'),
    'the global location still owns the wallet, because the keystore that migration wrote sits there',
  );

  const keystore = createKeystore({ keysPath: cfg.keysPath, mode: cfg.mode });
  assert.equal(keystore.state(), 'locked', 'a migrated wallet reads as locked, never as absent');
});

// The other direction, so the fix cannot quietly pin every install to the global path: a home
// with nothing in it at all still gets a project-local wallet.
test('a home with no wallet anywhere still starts a new one project-local', () => {
  const home = scratch('phosphor-home-');
  const root = repo();

  const cfg = withEnv(
    { HOME: home, PHOSPHOR_KEYS: undefined, PHOSPHOR_MODE: 'live', PHOSPHOR_DATA_DIR: undefined, PHOSPHOR_CONFIG_DIR: undefined },
    () => loadConfig(root),
  );

  assert.equal(cfg.keysPath, path.join(home, '.phosphor', path.basename(root), 'keys.json'));
});

// ---------- the repo boundary, against a filesystem rather than against a string ----------
//
// Private keys inside a git working copy are one `git add -f` from being published, and keeping
// them outside it is meant to be structural. The check compared strings, and two strings that
// are not equal can still be one directory: on a default APFS volume the filesystem is case
// insensitive, so a lowercase spelling of the repo root judged the path outside the working copy
// while the filesystem resolved it to exactly that directory. A symlink did the same with no
// typo at all. `npm run sweep` reported the same false pass, from its own copy of the check.

test('a differently cased spelling of the repo root is still the repo root', () => {
  const root = scratch('phosphor-root-');
  const inside = path.join(root, 'state', 'keys.json');
  fs.mkdirSync(path.dirname(inside), { recursive: true });
  fs.writeFileSync(inside, '{}');

  assert.throws(() => assertOutsideRepo(inside, root), /outside the repo/, 'the plain spelling was always caught');

  // The same directory, spelled in a case the volume accepts. Skipped where it does not: a
  // case-sensitive volume genuinely has no such path, and the check is right to allow it.
  const shouted = root.toUpperCase();
  let sameDirectory = false;
  try {
    sameDirectory = fs.realpathSync.native(shouted) === fs.realpathSync.native(root);
  } catch {
    sameDirectory = false;
  }
  if (sameDirectory) {
    assert.throws(() => assertOutsideRepo(path.join(shouted, 'state', 'keys.json'), root), /outside the repo/);
  }
});

test('a symlink pointing into the working copy is not a way out of it', () => {
  const root = scratch('phosphor-root-');
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  const elsewhere = path.join(scratch('phosphor-link-'), 'state');
  fs.symlinkSync(path.join(root, 'state'), elsewhere);

  assert.throws(() => assertOutsideRepo(path.join(elsewhere, 'keys.json'), root), /outside the repo/);
});

test('a key file genuinely outside the working copy is still allowed', () => {
  const root = scratch('phosphor-root-');
  assert.doesNotThrow(() => assertOutsideRepo(path.join(scratch('phosphor-home-'), '.phosphor', 'keys.json'), root));
});
