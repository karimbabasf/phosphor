// The Hyperliquid trading key a vault derives from its owner key (src/keystore/derived.ts, HL-AGENT),
// the counter in vault.json that names it, and the session that holds it (src/keystore/store.ts).
//
// The vectors are the published ones (tests/fixtures/hl-agent-keys.ts, docs/trading.md), checked
// outside this code when they were written down; here each is checked again inside Node by a second
// route. The keystore is real, with a software P-256 key playing the enclave
// (tests/unit/helpers/owner-touch.ts); the owner keys are public test keys. Temp directories only.
// Rerun: node scripts/run-tests.ts tests/unit/hl-agent-key.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import {
  ALLOWANCE_INFO,
  DERIVE_SALT,
  GAS_INFO,
  HL_AGENT_INFO,
  MAX_HL_AGENT_VERSION,
  deriveAllowanceKey,
  deriveGasSeed,
  deriveHlAgentKey,
  evmAddressOf,
} from '../../src/keystore/derived.ts';
import { apiWallet as apiWalletDoor } from '../../src/keystore/index.ts';
import { OwnerTouchRequired } from '../../src/keystore/store.ts';
import { hlAgentPlan } from '../../src/hl/agent-key.ts';
import { readApiWallet } from '../../src/runner/keys.ts';
import { createVaultPrefs } from '../../src/vault/prefs.ts';
import type { VaultPrefs } from '../../src/vault/prefs.ts';
import { DERIVED_VECTORS } from '../fixtures/derived-keys.ts';
import { HL_AGENT_VECTORS } from '../fixtures/hl-agent-keys.ts';
import { agentVault } from './helpers/hl-agent.ts';
import { chipVault, teardown } from './helpers/owner-touch.ts';
import { tempDir } from './helpers/tmp.ts';

const [V, OTHER] = DERIVED_VECTORS;
const vector = (old: string, version: number) => HL_AGENT_VECTORS.find((x) => x.old === old && x.version === version)!;
const V1 = vector(V.old, 1);
const V2 = vector(V.old, 2);
const STORED = generatePrivateKey(); // an API wallet scripts/hl-agent.ts wrote into the file
const STORED_WALLET = { key: STORED, address: privateKeyToAccount(STORED).address };
const DAY = 86_400_000;

test.afterEach(teardown);

/* HKDF written out from RFC 5869 with HMAC: the second route to the same bytes. */
function hkdfByHand(ikm: Buffer, salt: Buffer, info: Buffer, length: number): Buffer {
  const prk = crypto.createHmac('sha256', salt).update(ikm).digest();
  const blocks: Buffer[] = [];
  let previous = Buffer.alloc(0);
  for (let i = 1; Buffer.concat(blocks).length < length; i += 1) {
    previous = crypto.createHmac('sha256', prk).update(Buffer.concat([previous, info, Buffer.from([i])])).digest();
    blocks.push(previous);
  }
  return Buffer.concat(blocks).subarray(0, length);
}

/* Every buffer zero-filled while `run` takes, as the hex it held just before (wipe() is fill(0)). */
function wipedDuring(run: () => void): string[] {
  const realFill = Buffer.prototype.fill;
  const wiped: string[] = [];
  Buffer.prototype.fill = function (this: Buffer, ...args: Parameters<Buffer['fill']>) {
    if (args[0] === 0) wiped.push(this.toString('hex'));
    return realFill.apply(this, args);
  } as Buffer['fill'];
  try {
    run();
  } finally {
    Buffer.prototype.fill = realFill;
  }
  return wiped;
}

function prefsIn(): { prefs: VaultPrefs; dir: string } {
  const dir = tempDir('phosphor-hl-agent-');
  return { prefs: createVaultPrefs(dir), dir };
}

// ---------- the derivation ----------

test('a fixed owner key gives a fixed trading key for each version: the published vectors', () => {
  for (const x of HL_AGENT_VECTORS) {
    const old = Buffer.from(x.old, 'hex');
    const key = deriveHlAgentKey(old, x.version);
    assert.equal(key.toString('hex'), x.key, `${x.old.slice(0, 8)} v${x.version}`);
    assert.equal(evmAddressOf(key), x.address);
    assert.equal(deriveHlAgentKey(old, x.version).toString('hex'), x.key, 'the same every time');
  }
});

test('each vector holds by a second route: HMAC by hand under "phosphor/hl-agent/v<n>", viem for the address', () => {
  for (const x of HL_AGENT_VECTORS) {
    const info = Buffer.from(`phosphor/hl-agent/v${x.version}`);
    assert.equal(hkdfByHand(Buffer.from(x.old, 'hex'), Buffer.from('phosphor'), info, 32).toString('hex'), x.key);
    assert.equal(privateKeyToAccount(`0x${x.key}`).address, x.address, 'noble and OpenSSL agree on the address');
  }
});

test('the label is its own: a new version is a new key, and none is ALLOWANCE, GAS or the owner key', () => {
  assert.equal(HL_AGENT_INFO, 'phosphor/hl-agent/v');
  assert.equal(DERIVE_SALT, 'phosphor');
  assert.ok(![ALLOWANCE_INFO, GAS_INFO].some((info) => info.startsWith(HL_AGENT_INFO)));
  for (const vec of [V, OTHER]) {
    const old = Buffer.from(vec.old, 'hex');
    const all = [vec.old, deriveAllowanceKey(old).toString('hex'), deriveGasSeed(old).toString('hex'), ...[1, 2, 3].map((n) => deriveHlAgentKey(old, n).toString('hex'))];
    assert.equal(new Set(all).size, all.length, 'six different keys from one owner key');
  }
  assert.notEqual(V1.address, V2.address);
});

test('a version is a whole number from 1, and only a real secp256k1 key derives anything', () => {
  const old = Buffer.from(V.old, 'hex');
  for (const bad of [0, -1, 1.5, Number.NaN, MAX_HL_AGENT_VERSION + 1, '1' as unknown as number]) {
    assert.throws(() => deriveHlAgentKey(old, bad), /whole number/, String(bad));
  }
  assert.equal(deriveHlAgentKey(old, MAX_HL_AGENT_VERSION).length, 32);
  const n = Buffer.from('fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141', 'hex');
  for (const bad of [Buffer.alloc(32), n, Buffer.alloc(31, 1)]) assert.throws(() => deriveHlAgentKey(bad, 1), /not a valid secp256k1 private key/);
});

// ---------- the counter ----------

test('the counter is written once the venue approved a key, only ever upward, and survives every other write', () => {
  const { prefs, dir } = prefsIn();
  assert.equal(prefs.get().hlAgent, undefined, 'no entry before the first approval');
  assert.deepEqual(hlAgentPlan(prefs.get(), V.vault), { trade: null, next: 1 });

  const set = prefs.setHlAgent({ account: V.vault, version: 1, address: V1.address, validUntil: 1_800_000_000_000 + 90 * DAY }, () => Date.parse('2026-10-04T12:00:00.000Z'));
  const expected = { account: V.vault.toLowerCase(), version: 1, address: V1.address.toLowerCase(), validUntil: 1_800_000_000_000 + 90 * DAY, approvedAt: '2026-10-04T12:00:00.000Z' };
  assert.deepEqual(set.hlAgent, expected);
  prefs.markBackedUp();
  prefs.setIdleMinutes(60);
  prefs.setAllowanceSize(25);
  assert.deepEqual(createVaultPrefs(dir).get().hlAgent, expected, 'every other write keeps it');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'vault.json'), 'utf8')).hlAgent, expected);
  assert.deepEqual(hlAgentPlan(prefs.get(), V.vault.toUpperCase().replace('0X', '0x')), { trade: 1, next: 2 }, 'the vault is matched in any case');

  for (const version of [1, 0]) {
    assert.throws(() => prefs.setHlAgent({ account: V.vault, version, address: V2.address, validUntil: 1 }), /not above 1|whole number/, `version ${version}`);
  }
  assert.equal(prefs.setHlAgent({ account: V.vault, version: 2, address: V2.address, validUntil: 2 }).hlAgent?.version, 2);
});

test('the counter is the data folder\'s: another wallet trades with nothing it approved, and its next version goes on from it', () => {
  const { prefs } = prefsIn();
  prefs.setHlAgent({ account: V.vault, version: 3, address: V1.address, validUntil: 5 });
  assert.deepEqual(hlAgentPlan(prefs.get(), OTHER.vault), { trade: null, next: 4 });
  assert.deepEqual(hlAgentPlan(prefs.get(), V.vault), { trade: 3, next: 4 });
});

test('an entry the counter cannot read is no entry, and bad input is refused before anything is written', () => {
  for (const hlAgent of [{}, 'v1', { account: V.vault, version: 0, address: V1.address, validUntil: 1, approvedAt: 'x' }, { account: 'vault.near', version: 1, address: V1.address, validUntil: 1, approvedAt: 'x' }]) {
    const dir = tempDir('phosphor-hl-agent-');
    fs.writeFileSync(path.join(dir, 'vault.json'), JSON.stringify({ backedUp: false, backedUpAt: null, hlAgent }) + '\n');
    assert.equal(createVaultPrefs(dir).get().hlAgent, undefined, JSON.stringify(hlAgent));
  }
  const { prefs, dir } = prefsIn();
  const good = { account: V.vault, version: 1, address: V1.address, validUntil: 1 };
  for (const bad of [{ ...good, account: 'ab'.repeat(20) }, { ...good, address: 'vault.near' }, { ...good, version: 1.5 }, { ...good, validUntil: 0 }, { ...good, validUntil: Number.NaN }]) {
    assert.throws(() => prefs.setHlAgent(bad), Error, JSON.stringify(bad));
  }
  assert.equal(fs.existsSync(path.join(dir, 'vault.json')), false, 'nothing was written');
});

// ---------- the session ----------

test('an open derives the next trading key beside ALLOWANCE and GAS, and it never trades before the venue approved it', () => {
  const v = agentVault(V.old, { stored: STORED });
  assert.equal(v.store.hlAgentAccount(1), null, 'nothing before the open');
  v.open();
  assert.throws(() => v.store.evmPrivateKey(), OwnerTouchRequired, 'a vault on the chip: no owner key in the session');
  assert.equal(v.store.hlAgentAccount(1), V1.address, 'version 1, the next one, is made at the open');
  assert.equal(v.store.hlAgentAccount(2), null, 'and nothing else');
  // Until the venue approved it, the key the file holds still trades, as before the move.
  assert.deepEqual(v.store.apiWallet(), STORED_WALLET);
  assert.equal(readApiWallet(v.keysPath).key, STORED);
});

test('once vault.json names the approved version, the derived key is the one that trades, and the stored one is never served beside it', () => {
  const v = agentVault(V.old, { stored: STORED });
  v.open();
  v.prefs.setHlAgent({ account: v.vault, version: 1, address: V1.address, validUntil: Date.now() + 90 * DAY });
  assert.deepEqual(v.store.apiWallet(), { key: `0x${V1.key}`, address: V1.address }, 'the key made at the open trades at once: no second touch');
  assert.deepEqual(apiWalletDoor(v.keysPath), { key: `0x${V1.key}`, address: V1.address }, 'through the door the runner reads');
  assert.deepEqual(readApiWallet(v.keysPath), { key: `0x${V1.key}`, source: 'present', address: V1.address });
  // A version this open did not make serves none, never the stored key the approval replaced.
  v.prefs.setHlAgent({ account: v.vault, version: 2, address: V2.address, validUntil: Date.now() + 90 * DAY });
  assert.equal(v.store.apiWallet(), null);
  assert.equal(readApiWallet(v.keysPath).source, 'absent');
  v.store.lock();
  v.open();
  assert.deepEqual(v.store.apiWallet(), { key: `0x${V2.key}`, address: V2.address }, 'the next open makes it');
  const third = v.store.hlAgentAccount(3);
  assert.ok(third !== null && ![V1.address, V2.address].includes(third), 'and version 3 is the next one, a key of its own');
});

test('the lock wipes every trading key the open made, and the next open wipes the last open\'s', () => {
  const v = agentVault(V.old);
  v.prefs.setHlAgent({ account: V.vault, version: 1, address: V1.address, validUntil: Date.now() + DAY });
  v.open();
  assert.equal(v.store.hlAgentAccount(1), V1.address);
  assert.equal(v.store.hlAgentAccount(2), V2.address);
  const atLock = wipedDuring(() => v.store.lock());
  assert.ok(atLock.includes(V1.key) && atLock.includes(V2.key), 'the 32 bytes of both trading keys were overwritten by the lock');
  assert.equal(v.store.hlAgentAccount(1), null, 'and nothing is served while shut');
  assert.throws(() => v.store.apiWallet(), /locked/);

  v.open();
  const atReopen = wipedDuring(() => v.open());
  assert.ok(atReopen.includes(V1.key) && atReopen.includes(V2.key), 'an open over an open wipes what the first made');
  assert.deepEqual(v.store.apiWallet(), { key: `0x${V1.key}`, address: V1.address });
});

test('no trading key is ever written anywhere: every file the wallet and the counter wrote is searched for it', () => {
  const v = agentVault(V.old, { stored: STORED });
  v.open();
  v.prefs.setHlAgent({ account: v.vault, version: 1, address: V1.address, validUntil: Date.now() + DAY });
  assert.equal(v.store.apiWallet()?.key, `0x${V1.key}`);
  v.store.lock();
  v.open();
  v.store.lock();
  const forms = [V1, V2].flatMap((x) => {
    const raw = Buffer.from(x.key, 'hex');
    return [x.key, x.key.toUpperCase(), raw.toString('base64'), raw.toString('base64url'), raw.toString('latin1')];
  });
  const files = [path.dirname(v.keysPath), v.prefsDir].flatMap((d) => fs.readdirSync(d).map((f) => path.join(d, f)));
  assert.ok(files.some((f) => f.endsWith('keys.enc.json')) && files.some((f) => f.endsWith('vault.json')), `the wallet file and vault.json were written: ${files.join(', ')}`);
  for (const file of files) {
    const body = fs.readFileSync(file).toString('latin1');
    for (const form of forms) assert.equal(body.includes(form), false, `${path.basename(file)} holds a trading key`);
  }
});

test('kind key: with no approved derived key the session trades exactly as before, and an unwired keystore derives nothing', () => {
  const v = agentVault(V.old, { stored: STORED, moved: false });
  v.open();
  assert.equal(v.store.evmPrivateKey(), `0x${V.old}`, 'kind key: the owner key is in the session');
  assert.deepEqual(v.store.apiWallet(), STORED_WALLET);

  const plain = chipVault(OTHER.old, { moved: false });
  plain.open();
  assert.equal(plain.store.hlAgentAccount(1), null, 'no plan wired: nothing derived');
  assert.equal(plain.store.apiWallet(), null, 'and no trading key that was not there before');
});

test('a plan that throws names nothing, and the session trades as it did before the plan', () => {
  const v = agentVault(V.old, { stored: STORED });
  v.store.planHlAgentsWith(() => {
    throw new Error('vault.json unreadable');
  });
  v.open();
  assert.equal(v.store.hlAgentAccount(1), null);
  assert.deepEqual(v.store.apiWallet(), STORED_WALLET);
});
