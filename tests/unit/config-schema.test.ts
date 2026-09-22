// What loadConfig refuses to boot on.
//
// Two defects sat behind these tests. Unknown keys were dropped in silence, so a live
// config.local.json carrying "approvalGate": false read as a switch that turns the approval gate
// off and was in fact nothing at all; an owner could believe either polarity meant something.
// And no configured address was ever checked for shape, so "phosphor.testnet" sat in the live
// address book as an allowlisted, unvalidated destination for a cross-chain swap: the policy
// engine folds every configured address into the set it trusts, and the account does not exist
// on NEAR mainnet.
//
// Both are boot-time questions, which is the point. A wrong address is not a thing to refuse
// halfway through a swap, and a dead key is not a thing to discover after trusting it.
//
// Run: node --test tests/unit/config-schema.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../src/config.ts';

const EVM = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const SOL = 'So11111111111111111111111111111111111111112';
// A 64-character hex implicit account, the other shape a mainnet NEAR account takes.
const NEAR_IMPLICIT = 'aec6b4afd08c0ace0f392c4d1b8aa9c44ce9bbd558903c4b702ce1cb1ea941b2'.padEnd(64, '0');

// A whole config root: the committed template plus whatever local override the case is about.
// Keys are pinned inside the scratch directory so the default resolver never probes the real
// home directory, and dataDir sits beside them so loadConfig's mkdir lands in the temp tree.
function root(local: Record<string, unknown> | null, base?: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-schema-'));
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify(base ?? { mode: 'live', port: 4177, addresses: {}, dataDir: 'state' }),
  );
  if (local !== null) fs.writeFileSync(path.join(dir, 'config.local.json'), JSON.stringify(local));
  return dir;
}

function load(local: Record<string, unknown> | null, base?: Record<string, unknown>) {
  const dir = root(local, base);
  const saved = process.env.PHOSPHOR_KEYS;
  process.env.PHOSPHOR_KEYS = path.join(os.tmpdir(), 'phosphor-schema-keys', 'keys.json');
  try {
    return loadConfig(dir);
  } finally {
    if (saved === undefined) delete process.env.PHOSPHOR_KEYS;
    else process.env.PHOSPHOR_KEYS = saved;
  }
}

// ---------- unknown keys ----------

test('an unknown key in config.local.json fails the load, and the message names the key', () => {
  assert.throws(() => load({ approvalGate: false }), /approvalGate/);
});

test('the message names the file the key is in, so the owner knows which one to edit', () => {
  assert.throws(() => load({ network: 'mainnet' }), /config\.local\.json/);
});

test('an unknown key in the committed template fails just as hard', () => {
  assert.throws(
    () => load(null, { mode: 'live', addresses: {}, slippageTolerance: 500 }),
    /slippageTolerance/,
  );
});

test('a documentation key beginning with an underscore is not an unknown key', () => {
  const cfg = load({ _comment: 'real addresses live here', addresses: { evm: EVM } });
  assert.equal(cfg.addresses.evm, EVM);
});

test('every key the app actually reads still loads', () => {
  const cfg = load({
    mode: 'demo',
    port: 4200,
    addresses: { evm: EVM },
    candleProducts: ['ETH-USD'],
    dataDir: 'state',
    skills: ['phosphor-analysis'],
    driver: { autostart: false },
    chainscan: { blockscoutApiKey: 'bs-key', nearblocksApiKey: 'nb-key' },
  });
  assert.equal(cfg.port, 4200);
  assert.deepEqual(cfg.candleProducts, ['ETH-USD']);
  assert.deepEqual(cfg.chainscan, { blockscoutApiKey: 'bs-key', nearblocksApiKey: 'nb-key' });
});

test('a chain lookup key nobody knows is refused, and no key at all is the default', () => {
  assert.throws(() => load({ chainscan: { etherscanApiKey: 'x' } }), /chainscan.*etherscanApiKey/);
  assert.equal(load({}).chainscan, undefined);
});

test('a config written before the consolidate path went still loads', () => {
  const cfg = load({ port: 4200, economicTransferUsd: 10 });
  assert.equal(cfg.port, 4200);
  assert.equal('economicTransferUsd' in cfg, false, 'the retired key is accepted and not carried');
});

test('a key of the wrong type is refused rather than coerced', () => {
  assert.throws(() => load({ port: '4177' }), /port/);
});

// ---------- addresses ----------

test('the one address is the EVM account, checked for its shape', () => {
  const cfg = load({ addresses: { evm: EVM } });
  assert.deepEqual(cfg.addresses, { evm: EVM });
});

test('a malformed EVM address is refused at load', () => {
  assert.throws(() => load({ addresses: { evm: EVM.slice(0, -2) } }), /not an EVM address/);
  assert.throws(() => load({ addresses: { evm: SOL } }), /not an EVM address/);
  assert.throws(() => load({ addresses: { evm: '' } }), /empty/);
});

test('an address book written before the chain wallets went still loads, and only the EVM entry is carried', () => {
  // The old shape: one list per chain. The first EVM entry is the account; Solana and NEAR
  // signed nothing after 2026-09-16 and are accepted so the file loads, then ignored.
  const cfg = load({ addresses: { evm: [EVM], solana: [SOL], near: ['phosphor.near', NEAR_IMPLICIT] } });
  assert.deepEqual(cfg.addresses, { evm: EVM });
  const empty = load({ addresses: { evm: [], solana: [], near: [] } });
  assert.deepEqual(empty.addresses, {});
});

test('an empty address book is the safe default and loads', () => {
  const cfg = load({ addresses: {} });
  assert.deepEqual(cfg.addresses, {});
});

test('the committed template at the repo root loads unchanged', () => {
  const repo = path.resolve(import.meta.dirname, '..', '..');
  const template = JSON.parse(fs.readFileSync(path.join(repo, 'config.json'), 'utf8')) as Record<string, unknown>;
  const cfg = load(null, template);
  assert.equal(cfg.mode, 'live');
});

// ---------- the mode, from the environment ----------

/* The config file's mode goes through z.enum(['live','demo']). The environment override did
   not: it was a bare cast, so ACC_MODE=Demo was carried as a Mode nothing would ever match.
   That matters because the two halves of the app read the mode with opposite polarity. Every
   demo gate asks `=== 'demo'` and every safety reading in main.ts asks `=== 'live'`, so a third
   spelling boots the live rails, the live ledger and the real keystore with the venue-credited
   check, the one-click status, the intents prices and the recipient history all switched off. A
   deposit would then settle on the solver's word alone. One typo in a shell, four safety
   readings gone and nothing said. */
function loadWithMode(value: string | undefined, name = 'ACC_MODE') {
  const dir = root(null);
  const saved = new Map<string, string | undefined>();
  for (const key of ['PHOSPHOR_KEYS', 'ACC_MODE', 'PHOSPHOR_MODE']) saved.set(key, process.env[key]);
  delete process.env.ACC_MODE;
  delete process.env.PHOSPHOR_MODE;
  process.env.PHOSPHOR_KEYS = path.join(os.tmpdir(), 'phosphor-schema-keys', 'keys.json');
  if (value !== undefined) process.env[name] = value;
  try {
    return loadConfig(dir);
  } finally {
    for (const [key, previous] of saved) {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  }
}

test('a mode the app does not have refuses to boot rather than becoming a third mode', () => {
  assert.throws(() => loadWithMode('Demo'), /Demo/);
  assert.throws(() => loadWithMode('Demo'), /live.*demo|demo.*live/);
});

test('the same refusal on the other spellings and the other variable name', () => {
  for (const bad of ['LIVE', 'Live', 'DEMO', 'prod', 'demo ', 'test']) {
    assert.throws(() => loadWithMode(bad), /not a mode|PHOSPHOR_MODE|ACC_MODE/, `${bad} booted`);
  }
  assert.throws(() => loadWithMode('Demo', 'PHOSPHOR_MODE'), /Demo/);
});

test('the two real modes still come through the environment', () => {
  assert.equal(loadWithMode('demo').mode, 'demo');
  assert.equal(loadWithMode('live').mode, 'live');
  assert.equal(loadWithMode('demo', 'PHOSPHOR_MODE').mode, 'demo');
});

/* An empty variable is a shell mistake, `ACC_MODE=$SOMETHING_UNSET`, and env() has always read
   an empty string as absent. It stays absent here, which lands on the config file and so on
   live: all the gates on, no demo state, nothing moved by the typo. Fail closed. */
test('an empty mode is absent, which is the live default, not a third mode', () => {
  assert.equal(loadWithMode('').mode, 'live');
  assert.equal(loadWithMode(undefined).mode, 'live');
});

/* The driver block reached nobody: parsed, checked and then left off the config, so
   `driver.claudeBin` in config.json never pointed the in-app chat anywhere (found 2026-09-20 by
   the scripted eval's stand-in agent being ignored for the real Claude Code). */
test('the driver block rides on the config it was parsed from', () => {
  const cfg = load(null, { mode: 'demo', port: 4177, addresses: {}, dataDir: 'state', driver: { claudeBin: '/tmp/fake-claude', autostart: true, model: 'claude-sonnet-5' } });
  assert.deepEqual(cfg.driver, { claudeBin: '/tmp/fake-claude', autostart: true, model: 'claude-sonnet-5' });
  assert.equal(load(null).driver, undefined, 'no block, no field');
});
