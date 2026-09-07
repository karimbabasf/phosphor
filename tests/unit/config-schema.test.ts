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
    JSON.stringify(base ?? { mode: 'live', port: 4177, addresses: { evm: [], solana: [], near: [] }, dataDir: 'state' }),
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
    () => load(null, { mode: 'live', addresses: { evm: [], solana: [], near: [] }, slippageTolerance: 500 }),
    /slippageTolerance/,
  );
});

test('a documentation key beginning with an underscore is not an unknown key', () => {
  const cfg = load({ _comment: 'real addresses live here', addresses: { evm: [EVM], solana: [], near: [] } });
  assert.deepEqual(cfg.addresses.evm, [EVM]);
});

test('every key the app actually reads still loads', () => {
  const cfg = load({
    mode: 'demo',
    port: 4200,
    addresses: { evm: [EVM], solana: [SOL], near: ['phosphor.near'] },
    economicTransferUsd: 10,
    candleProducts: ['ETH-USD'],
    dataDir: 'state',
    skills: ['phosphor-analysis'],
    driver: { autostart: false },
    yield: { autoAllocate: false, intervalMs: 60000, dustUsd: 5 },
  });
  assert.equal(cfg.port, 4200);
  assert.equal(cfg.economicTransferUsd, 10);
});

test('a key of the wrong type is refused rather than coerced', () => {
  assert.throws(() => load({ port: '4177' }), /port/);
});

// ---------- addresses ----------

test('a .testnet account in addresses.near is refused at load', () => {
  assert.throws(
    () => load({ mode: 'live', addresses: { evm: [], solana: [], near: ['phosphor.testnet'] } }),
    /phosphor\.testnet/,
  );
});

test('and the refusal says it is the mainnet rule, since the account is syntactically fine', () => {
  assert.throws(
    () => load({ mode: 'live', addresses: { evm: [], solana: [], near: ['phosphor.testnet'] } }),
    /mainnet/,
  );
});

test('a named mainnet account and an implicit one both load', () => {
  const cfg = load({ mode: 'live', addresses: { evm: [], solana: [], near: ['phosphor.near', NEAR_IMPLICIT] } });
  assert.deepEqual(cfg.addresses.near, ['phosphor.near', NEAR_IMPLICIT]);
});

test('a malformed EVM address is refused at load', () => {
  assert.throws(() => load({ addresses: { evm: [EVM.slice(0, -2)], solana: [], near: [] } }), /not an EVM address/);
});

test('a Solana address with a character dropped is refused at load', () => {
  assert.throws(() => load({ addresses: { evm: [], solana: [SOL.slice(0, -1)], near: [] } }), /Solana/);
});

test('an address on the wrong family is refused, both ways round', () => {
  assert.throws(() => load({ addresses: { evm: [SOL], solana: [], near: [] } }), /not an EVM address/);
  assert.throws(() => load({ addresses: { evm: [], solana: [EVM], near: [] } }), /Solana/);
});

test('an empty address book is the safe default and loads', () => {
  const cfg = load({ addresses: { evm: [], solana: [], near: [] } });
  assert.deepEqual(cfg.addresses, { evm: [], solana: [], near: [] });
});

test('the committed template at the repo root loads unchanged', () => {
  const repo = path.resolve(import.meta.dirname, '..', '..');
  const template = JSON.parse(fs.readFileSync(path.join(repo, 'config.json'), 'utf8')) as Record<string, unknown>;
  const cfg = load(null, template);
  assert.equal(cfg.mode, 'live');
});
