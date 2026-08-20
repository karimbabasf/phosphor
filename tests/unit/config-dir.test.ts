// Installed, the app reads its code from inside a read-only .app bundle, so the writable
// half of the config cannot live next to the committed template any more. PHOSPHOR_CONFIG_DIR
// moves config.local.json out on its own. These tests defend the two halves of that: the
// override actually redirects the local file, and leaving it unset changes nothing at all,
// which is what keeps `npm run app` and every other test honest.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../src/config.ts';

function scratch(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-config-'));
}

// loadConfig reads process.env directly, so every case runs with a known environment and
// puts back whatever was there. Keys are pinned outside the temp root because the default
// resolver probes the real home directory and would otherwise vary by machine.
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

function write(dir: string, file: string, body: unknown): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), JSON.stringify(body, null, 2));
}

const KEYS = path.join(os.tmpdir(), 'phosphor-config-keys', 'keys.json');

test('with no override, config.local.json is read from the root, exactly as before', () => {
  const root = scratch();
  write(root, 'config.json', { network: 'testnet', port: 4177, economicTransferUsd: 10 });
  write(root, 'config.local.json', { port: 5000 });

  const cfg = withEnv({ PHOSPHOR_CONFIG_DIR: undefined, PHOSPHOR_KEYS: KEYS }, () => loadConfig(root));

  assert.equal(cfg.port, 5000);
});

test('PHOSPHOR_CONFIG_DIR moves config.local.json out of the root', () => {
  const root = scratch();
  const support = scratch();
  write(root, 'config.json', { network: 'testnet', port: 4177 });
  write(support, 'config.local.json', { port: 6000, addresses: { evm: ['0xabc'] } });

  const cfg = withEnv({ PHOSPHOR_CONFIG_DIR: support, PHOSPHOR_KEYS: KEYS }, () => loadConfig(root));

  assert.equal(cfg.port, 6000);
  assert.deepEqual(cfg.addresses.evm, ['0xabc']);
});

test('the override wins outright: a stale config.local.json left in the root is not read', () => {
  const root = scratch();
  const support = scratch();
  write(root, 'config.json', { network: 'testnet', port: 4177 });
  write(root, 'config.local.json', { port: 7777 });
  write(support, 'config.local.json', { port: 6000 });

  const cfg = withEnv({ PHOSPHOR_CONFIG_DIR: support, PHOSPHOR_KEYS: KEYS }, () => loadConfig(root));

  assert.equal(cfg.port, 6000);
});

test('config.json still comes from the root, because the template ships with the code', () => {
  const root = scratch();
  const support = scratch();
  write(root, 'config.json', { network: 'testnet', port: 4177, economicTransferUsd: 42 });
  write(support, 'config.local.json', { port: 6000 });

  const cfg = withEnv({ PHOSPHOR_CONFIG_DIR: support, PHOSPHOR_KEYS: KEYS }, () => loadConfig(root));

  assert.equal(cfg.economicTransferUsd, 42);
  assert.equal(cfg.port, 6000);
});

test('an override directory with no config.local.json falls back to the template alone', () => {
  const root = scratch();
  const support = scratch();
  write(root, 'config.json', { network: 'testnet', port: 4177 });

  const cfg = withEnv({ PHOSPHOR_CONFIG_DIR: support, PHOSPHOR_KEYS: KEYS }, () => loadConfig(root));

  assert.equal(cfg.port, 4177);
});

test('a corrupt config.local.json still stops the boot when it sits in the override directory', () => {
  const root = scratch();
  const support = scratch();
  write(root, 'config.json', { network: 'testnet', port: 4177 });
  fs.mkdirSync(support, { recursive: true });
  fs.writeFileSync(path.join(support, 'config.local.json'), '{ not json');

  assert.throws(
    () => withEnv({ PHOSPHOR_CONFIG_DIR: support, PHOSPHOR_KEYS: KEYS }, () => loadConfig(root)),
    /config\.local\.json is present but unparseable/,
  );
});
