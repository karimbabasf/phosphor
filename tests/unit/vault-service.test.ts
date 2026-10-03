// The vault service's rules (src-tauri/se-helper/main.swift), run for real against a stand-in
// keychain and enclave (tests/swift/VaultTestPlatform.swift) with no Touch ID: the file is compiled
// here with that stand-in, and every case below sends the service the JSON the relay sends it. The
// wallet files are the app's own, written by src/keystore/store.ts, so the material the service pins
// is exactly what Node sends. What this cannot prove is the real keychain and the real enclave; the
// signed run in the custody-service report does that half against the real access group.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { refusal } from '../../src/http/wallet.ts';
import { canonical } from '../../src/keystore/envelope.ts';
import { createKeystore } from '../../src/keystore/store.ts';
import type { EnclaveUnwrapRequest, Keystore } from '../../src/keystore/store.ts';
import { tempDir } from './helpers/tmp.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVICE = path.join(ROOT, 'src-tauri/se-helper/main.swift');
const SEAM = path.join(ROOT, 'tests/swift/VaultTestPlatform.swift');
const TEAM = 'TEAM4TESTS';
const GROUP = `${TEAM}.com.karimbabasf.phosphor.vault`;
const T0 = 1_800_000_000;

const work = tempDir('phosphor-vault-service-');
const swiftc = process.platform === 'darwin' && spawnSync('swiftc', ['--version'], { env: { ...process.env, TMPDIR: work } }).status === 0;
const skip = swiftc ? false : 'needs macOS with swiftc';

/* One compile per run, into this file's own temp folder, with its module cache and the compiler's
   own scratch files beside it, so all of it goes when the folder does. */
function compile(out: string, defines: string[], files: string[]): void {
  const args = ['-Onone', ...defines.flatMap((d) => ['-D', d]), '-module-name', 'se_helper', '-module-cache-path', path.join(work, 'mc'), '-o', out, ...files];
  const built = spawnSync('swiftc', args, { encoding: 'utf8', env: { ...process.env, TMPDIR: work } });
  assert.equal(built.status, 0, `swiftc: ${built.stderr}`);
}

const binary = path.join(work, 'vault-seam');
if (swiftc) compile(binary, ['PHOSPHOR_STDIO', 'PHOSPHOR_TESTSEAM'], [SERVICE, SEAM]);

type Answer = Record<string, unknown> & { ok: boolean; error?: string };
type Opts = { team?: string; now?: number; fail?: string; se?: boolean; touch?: 'cancel' };

class Mac {
  readonly store = path.join(tempDir('phosphor-vault-mac-'), 'keychain.json');

  ask(request: Record<string, unknown>, opts: Opts = {}): Answer {
    const env: Record<string, string> = {
      PATH: '/usr/bin:/bin',
      PHOSPHOR_TEST_STORE: this.store,
      PHOSPHOR_TEST_TEAM: opts.team ?? TEAM,
      PHOSPHOR_TEST_NOW: String(opts.now ?? T0),
    };
    if (opts.fail !== undefined) env.PHOSPHOR_TEST_FAIL = opts.fail;
    if (opts.se === false) env.PHOSPHOR_TEST_SE = '0';
    if (opts.touch !== undefined) env.PHOSPHOR_TEST_TOUCH = opts.touch;
    const run = spawnSync(binary, [], { input: JSON.stringify(request) + '\n', env, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout) as Answer;
  }

  state(): { keys: { tag: string; group: string }[]; markers: { tag: string; group: string; body: string }[]; calls: string[]; blobs: number } {
    if (!fs.existsSync(this.store)) return { keys: [], markers: [], calls: [], blobs: 0 };
    return JSON.parse(fs.readFileSync(this.store, 'utf8'));
  }

  calls(): string[] {
    return this.state().calls;
  }

  /* Every call made after `from`, which is a count of calls taken earlier. */
  since(from: number): string[] {
    return this.calls().slice(from);
  }
}

/* A wallet file the app writes, wrapped to the key the service made. */
function walletFor(enclave: { keyBlob: string; publicKey: string }): Keystore {
  const keysPath = path.join(tempDir('phosphor-vault-wallet-'), 'keys.json');
  const store = createKeystore({ keysPath });
  store.createWithEnclave({ keyBlob: enclave.keyBlob, publicKey: enclave.publicKey, createdAt: new Date(T0 * 1000).toISOString() });
  store.lock();
  return store;
}

function made(mac: Mac, opts: Opts & { label?: string } = {}): { keyBlob: string; publicKey: string } {
  const answer = mac.ask({ op: 'create', ...(opts.label === undefined ? {} : { label: opts.label }) }, opts);
  assert.equal(answer.ok, true, JSON.stringify(answer));
  return { keyBlob: answer.keyBlob as string, publicKey: answer.publicKey as string };
}

const transport = crypto.randomBytes(32);

/* The relay's unwrap, and the backend's half of its answer: the sealed data key opened under the
   transport key with the request id as AAD, as src/vault/relay.ts does. */
function unwrap(mac: Mac, request: EnclaveUnwrapRequest, opts: Opts = {}): { answer: Answer; dek: Buffer | null } {
  const id = crypto.randomBytes(6).toString('hex');
  const answer = mac.ask({ op: 'unwrap', id, reason: 'Unlock Phosphor', transportKey: transport.toString('base64'), ...request }, opts);
  if (answer.ok !== true) return { answer, dek: null };
  const sealed = Buffer.from(answer.dekSealed as string, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', transport, sealed.subarray(0, 12));
  decipher.setAAD(Buffer.from(id, 'utf8'));
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  return { answer, dek: Buffer.concat([decipher.update(sealed.subarray(12, sealed.length - 16)), decipher.final()]) };
}

function opens(mac: Mac, wallet: Keystore, opts: Opts = {}): void {
  const { answer, dek } = unwrap(mac, wallet.enclaveRequest()!, opts);
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.deepEqual(wallet.unlockWithDataKey(dek!), { ok: true }, 'the data key opens the wallet it was asked for');
  wallet.lock();
}

function commit(mac: Mac, request: EnclaveUnwrapRequest, opts: Opts = {}): Answer {
  const { keyBlob, ephemeralPublicKey, ciphertext, aad, addresses } = request;
  return mac.ask({ op: 'commit', keyBlob, ephemeralPublicKey, ciphertext, aad, addresses }, opts);
}

const touched = (calls: string[]): string[] => calls.filter((c) => c.startsWith('agree'));

test('a build with no Team ID keeps the path it has today: a blob, no group, no marker', { skip }, () => {
  const mac = new Mac();
  const dev = { team: '' };
  const blob = made(mac, dev);
  assert.ok(!blob.keyBlob.startsWith('keychain:'), 'a device-bound blob');
  assert.equal(mac.ask({ op: 'create' }, dev).binding, 'device');
  assert.deepEqual(mac.calls().slice(0, 2), ['makeKey -', 'makeBlob'], 'it tries the keychain with no group, then makes a blob');
  opens(mac, walletFor(blob), dev);
  assert.equal(mac.ask({ op: 'probe' }, dev).keychainHome, false);
  assert.deepEqual(mac.ask({ op: 'status' }, dev), { ok: true, keychainHome: false, bound: false, key: null, marker: null });
  assert.equal(mac.ask({ op: 'commit', keyBlob: 'keychain:x' }, dev).error, 'keychain_unavailable');
  assert.equal(mac.ask({ op: 'sweep' }, dev).error, 'keychain_unavailable');
  assert.ok(!mac.calls().some((c) => / \S*\.com\.karimbabasf\.phosphor\.vault/.test(c)), 'no call ever names a group');
});

test('a build with a Team ID names <team>.com.karimbabasf.phosphor.vault on create and on every query', { skip }, () => {
  const mac = new Mac();
  const key = made(mac);
  assert.ok(key.keyBlob.startsWith('keychain:com.karimbabasf.phosphor.vault.'), key.keyBlob);
  const wallet = walletFor(key);
  opens(mac, wallet);
  assert.equal(commit(mac, wallet.enclaveRequest()!).ok, true);
  opens(mac, wallet);
  assert.equal(mac.ask({ op: 'status', keyBlob: key.keyBlob }).ok, true);
  assert.equal(mac.ask({ op: 'sweep' }).ok, true);
  assert.equal(mac.ask({ op: 'probe' }).keychainHome, true);
  const calls = mac.calls();
  assert.ok(calls.length > 10);
  for (const call of calls) {
    assert.ok(call.endsWith(` ${GROUP}`) || call.includes(` ${GROUP}`), `every keychain call names the group: ${call}`);
  }
  assert.equal(mac.state().blobs, 0);
});

test('create on a signed build that the keychain refuses is a refusal, never a blob', { skip }, () => {
  for (const status of ['-34018', '-25293', '-25308', '-26276']) {
    const mac = new Mac();
    const answer = mac.ask({ op: 'create' }, { fail: `makeKey=${status}` });
    assert.equal(answer.ok, false);
    assert.equal(answer.error, 'keychain_unavailable', status);
    assert.deepEqual(mac.calls(), [`makeKey ${GROUP}`], 'one try, in the group, and no blob after it');
    assert.equal(mac.state().blobs, 0);
  }
});

test('no Secure Enclave: create and unwrap refuse before any keychain call, and the window keeps the password path', { skip }, () => {
  const mac = new Mac();
  assert.equal(mac.ask({ op: 'create' }, { se: false }).error, 'se_unavailable');
  assert.equal(mac.ask({ op: 'create' }, { se: false, team: '' }).error, 'se_unavailable');
  assert.equal(mac.ask({ op: 'unwrap', keyBlob: 'AAAA' }, { se: false }).error, 'se_unavailable');
  assert.equal(mac.ask({ op: 'probe' }, { se: false }).secureEnclave, false, 'what makes enclave.ready false, so first run offers the password wallet');
  assert.deepEqual(mac.calls().filter((c) => !c.startsWith('markers')), []);
  const firstrun = fs.readFileSync(path.join(ROOT, 'ui/screens/firstrun.js'), 'utf8');
  assert.ok(firstrun.includes('vault.enclave && vault.enclave.ready === true ? FLOWS.enclave'), 'first run takes the enclave flow only when it is ready');
});

test('a device-bound key opens while nothing is bound, and once a marker exists it is refused before the enclave is asked', { skip }, () => {
  const mac = new Mac();
  const blobWallet = walletFor(made(mac, { team: '' }));
  opens(mac, blobWallet);
  const key = made(mac);
  const bound = walletFor(key);
  opens(mac, bound);
  assert.equal(commit(mac, bound.enclaveRequest()!).ok, true);
  const before = mac.calls().length;
  const { answer } = unwrap(mac, blobWallet.enclaveRequest()!);
  assert.equal(answer.error, 'blob_refused');
  assert.deepEqual(touched(mac.since(before)), [], 'refused with no dialog');
  // A blob from another Mac is refused the same way: the marker decides before the enclave could.
  const foreign = unwrap(mac, { ...blobWallet.enclaveRequest()!, keyBlob: crypto.randomBytes(64).toString('base64') }).answer;
  assert.equal(foreign.error, 'blob_refused');
  // A development build never reads markers: the same blob opens there as it does today.
  opens(mac, blobWallet, { team: '' });
});

test('the committed file opens, and a substitute wrapped to the real public key is refused before any touch', { skip }, () => {
  const mac = new Mac();
  const key = made(mac);
  const real = walletFor(key);
  opens(mac, real);
  assert.equal(commit(mac, real.enclaveRequest()!).ok, true);
  opens(mac, real, { now: T0 + 86_400 });

  // Anyone can wrap to the public key in the header: a whole other wallet, same key, same tag.
  const substitute = walletFor(key);
  let before = mac.calls().length;
  assert.equal(unwrap(mac, substitute.enclaveRequest()!).answer.error, 'pin_mismatch');
  assert.deepEqual(touched(mac.since(before)), []);

  // The real wrap with any one part changed: the header's addresses, the AAD, the wrapped key.
  const request = real.enclaveRequest()!;
  const edits: Partial<EnclaveUnwrapRequest>[] = [
    { addresses: Buffer.from('{"evm":"0x000000000000000000000000000000000000dead","near":null,"nearPublicKey":null,"solana":null}').toString('base64') },
    { aad: Buffer.from(Buffer.from(request.aad, 'base64').toString('utf8').replace('"hasMnemonic":true', '"hasMnemonic":false')).toString('base64') },
    { ciphertext: substitute.enclaveRequest()!.ciphertext },
    { ephemeralPublicKey: substitute.enclaveRequest()!.ephemeralPublicKey },
  ];
  for (const edit of edits) {
    before = mac.calls().length;
    assert.equal(unwrap(mac, { ...request, ...edit }).answer.error, 'pin_mismatch', JSON.stringify(Object.keys(edit)));
    assert.deepEqual(touched(mac.since(before)), []);
  }
  // A request with no addresses cannot be checked, so it is not let through.
  const { addresses: _dropped, ...bare } = request;
  assert.equal(mac.ask({ op: 'unwrap', id: 'x', reason: 'r', transportKey: transport.toString('base64'), ...bare }).error, 'bad_input');

  // The edit the attacker can make on disk, made on disk: the header's addresses in the file itself.
  const file = real.path();
  const text = fs.readFileSync(file, 'utf8');
  const doc = JSON.parse(text) as { header: { addresses: { evm: string } } };
  doc.header.addresses.evm = '0x000000000000000000000000000000000000dEaD';
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));
  assert.equal(unwrap(mac, real.enclaveRequest()!).answer.error, 'pin_mismatch');
  fs.writeFileSync(file, text);
  opens(mac, real);
});

test('a key no marker names opens while nothing is bound or in its first ten minutes, and never after', { skip }, () => {
  const unbound = new Mac();
  const old = walletFor(made(unbound));
  opens(unbound, old, { now: T0 + 86_400 });

  const mac = new Mac();
  const first = walletFor(made(mac));
  const second = walletFor(made(mac));
  opens(mac, first, { now: T0 + 60 });
  assert.equal(commit(mac, first.enclaveRequest()!, { now: T0 + 60 }).ok, true);
  opens(mac, second, { now: T0 + 590 });
  const before = mac.calls().length;
  assert.equal(unwrap(mac, second.enclaveRequest()!, { now: T0 + 601 }).answer.error, 'not_committed');
  assert.deepEqual(touched(mac.since(before)), []);
  assert.equal(unwrap(mac, second.enclaveRequest()!, { now: T0 - 3_600 }).answer.error, 'not_committed', 'a key from the future is not fresh');
  // And an orphan cannot be committed later to get around it.
  assert.equal(commit(mac, second.enclaveRequest()!, { now: T0 + 601 }).error, 'stale_key');
});

test('sweep deletes only keys no marker names past their first minutes, never a marked key, and nothing until something is bound', { skip }, () => {
  const mac = new Mac();
  const a1 = made(mac, { label: 'a' });
  assert.equal(mac.ask({ op: 'sweep', label: 'a' }, { now: T0 + 3_600 }).error, 'nothing_bound');
  assert.equal(mac.state().keys.length, 1, 'with nothing bound, nothing is swept');
  const wallet = walletFor(a1);
  assert.equal(commit(mac, wallet.enclaveRequest()!).ok, true);
  const a2 = made(mac, { label: 'a' });
  const a3 = made(mac, { label: 'a', now: T0 + 500 });
  const b1 = made(mac, { label: 'b' });
  const tags = (): string[] => mac.state().keys.map((k) => k.tag).sort();
  const tag = (k: { keyBlob: string }): string => k.keyBlob.slice('keychain:'.length);

  assert.deepEqual(mac.ask({ op: 'sweep', label: 'a' }, { now: T0 + 700 }), { ok: true, deleted: 1, kept: 2 });
  assert.deepEqual(tags(), [tag(a1), tag(a3), tag(b1)].sort(), 'the old unmarked key went; the marked one and the fresh one stayed');
  assert.ok(!tags().includes(tag(a2)));
  assert.equal(mac.ask({ op: 'sweep', label: 'b' }, { now: T0 + 700 }).error, 'nothing_bound', 'a label is its own scope');
  assert.deepEqual(tags(), [tag(a1), tag(a3), tag(b1)].sort());

  assert.deepEqual(mac.ask({ op: 'sweep' }, { now: T0 + 86_400 }), { ok: true, deleted: 2, kept: 1 });
  assert.deepEqual(tags(), [tag(a1)], 'a year from now the marked key is still there');
  assert.equal(mac.state().markers.length, 1, 'sweep never touches a marker');
  opens(mac, wallet, { now: T0 + 86_400 });
  assert.equal(mac.ask({ op: 'sweep', label: 'NOT A LABEL' }).error, 'bad_input');

  // A key outside the vault prefix is never considered, and a delete that fails keeps the key.
  const failing = new Mac();
  const kept = walletFor(made(failing));
  assert.equal(commit(failing, kept.enclaveRequest()!).ok, true);
  made(failing);
  assert.deepEqual(failing.ask({ op: 'sweep' }, { now: T0 + 700, fail: 'deleteKey=-25244' }), { ok: true, deleted: 0, kept: 2 });
});

test('a malformed or misplaced commit is refused and changes nothing', { skip }, () => {
  const mac = new Mac();
  const key = made(mac);
  const request = walletFor(key).enclaveRequest()!;
  const other = walletFor(key).enclaveRequest()!;
  const uuid = key.keyBlob.slice(-36);
  const bad: [string, Record<string, unknown>][] = [
    ['no fields', {}],
    ['a blob', { ...request, keyBlob: crypto.randomBytes(64).toString('base64') }],
    ['a tag outside the prefix', { ...request, keyBlob: `keychain:com.example.other.${uuid}` }],
    ['a tag with no UUID', { ...request, keyBlob: 'keychain:com.karimbabasf.phosphor.vault.x' }],
    ['a lower-case UUID', { ...request, keyBlob: `keychain:com.karimbabasf.phosphor.vault.${uuid.toLowerCase()}` }],
    ['a bad label', { ...request, keyBlob: `keychain:com.karimbabasf.phosphor.vault.A_B.${uuid}` }],
    ['two labels', { ...request, keyBlob: `keychain:com.karimbabasf.phosphor.vault.a.b.${uuid}` }],
    ['an ephemeral key that is not base64', { ...request, ephemeralPublicKey: 'not base64!' }],
    ['a short ephemeral key', { ...request, ephemeralPublicKey: crypto.randomBytes(64).toString('base64') }],
    ['an ephemeral key that is not X9.63', { ...request, ephemeralPublicKey: Buffer.concat([Buffer.from([5]), crypto.randomBytes(64)]).toString('base64') }],
    ['a short wrap', { ...request, ciphertext: crypto.randomBytes(59).toString('base64') }],
    ['no AAD', { ...request, aad: '' }],
    ['no addresses', { ...request, addresses: undefined }],
  ];
  for (const [what, fields] of bad) {
    assert.equal(mac.ask({ op: 'commit', ...fields }).error, 'bad_input', what);
  }
  const missing = `keychain:com.karimbabasf.phosphor.vault.${crypto.randomUUID().toUpperCase()}`;
  assert.equal(commit(mac, { ...request, keyBlob: missing }).error, 'no_key');
  assert.equal(commit(mac, request, { now: T0 + 600 }).error, 'stale_key');
  assert.equal(mac.state().markers.length, 0, 'no refusal wrote a marker');

  const first = commit(mac, request, { now: T0 + 30 });
  assert.equal(first.ok, true);
  assert.deepEqual(commit(mac, request, { now: T0 + 90 }), first, 'the same commit again is the same answer');
  assert.equal(commit(mac, other, { now: T0 + 90 }).error, 'marker_exists', 'a key is committed to one file, once');
  assert.equal(mac.state().markers.length, 1);
});

test('the pin is the one the protocol documents', { skip }, () => {
  const mac = new Mac();
  const key = made(mac);
  const wallet = walletFor(key);
  const request = wallet.enclaveRequest()!;
  assert.equal(commit(mac, request).ok, true);
  const tag = key.keyBlob.slice('keychain:'.length);
  const hash = crypto.createHash('sha256').update('phosphor-vault-pin-v1').update(Buffer.from([0]));
  for (const part of [Buffer.from(tag, 'utf8'), ...[request.ephemeralPublicKey, request.ciphertext, request.aad, request.addresses].map((b) => Buffer.from(b, 'base64'))]) {
    const n = Buffer.alloc(4);
    n.writeUInt32BE(part.length);
    hash.update(n).update(part);
  }
  const [marker] = mac.state().markers;
  assert.equal(marker.tag, tag, 'the marker is filed under the key it binds');
  assert.equal(marker.group, GROUP);
  assert.deepEqual(JSON.parse(Buffer.from(marker.body, 'base64').toString('utf8')), { pin: hash.digest('base64'), v: 1 });
  // The addresses part is the header's addresses as the file stores them, in canonical JSON.
  const header = JSON.parse(fs.readFileSync(wallet.path(), 'utf8')).header as { addresses: Record<string, string | null> };
  assert.equal(Buffer.from(request.addresses, 'base64').toString('utf8'), canonical(header.addresses));
  assert.match(canonical(header.addresses), /^\{"evm":"0x[0-9a-fA-F]{40}","near":null,"nearPublicKey":null,"solana":null\}$/);
});

test('status reads the binding with no dialog and tells the committed file from a substitute', { skip }, () => {
  const mac = new Mac();
  assert.deepEqual(mac.ask({ op: 'status' }), { ok: true, keychainHome: true, bound: false, key: null, marker: null });
  const key = made(mac);
  const real = walletFor(key).enclaveRequest()!;
  const substitute = walletFor(key).enclaveRequest()!;
  assert.deepEqual(mac.ask({ op: 'status', ...real }), { ok: true, keychainHome: true, bound: false, key: { present: true, fresh: true }, marker: null, pinMatches: false });
  assert.equal(commit(mac, real).ok, true);
  const later = { now: T0 + 3_600 };
  assert.deepEqual(mac.ask({ op: 'status', ...real }, later), {
    ok: true, keychainHome: true, bound: true, key: { present: true, fresh: false }, marker: { at: new Date(T0 * 1000).toISOString().replace('.000Z', 'Z') }, pinMatches: true,
  });
  assert.equal(mac.ask({ op: 'status', ...substitute }, later).pinMatches, false);
  const gone = `keychain:com.karimbabasf.phosphor.vault.${crypto.randomUUID().toUpperCase()}`;
  assert.deepEqual(mac.ask({ op: 'status', keyBlob: gone }), { ok: true, keychainHome: true, bound: true, key: { present: false, fresh: false }, marker: null });
  assert.equal(mac.ask({ op: 'status', keyBlob: 'keychain:nope' }).error, 'bad_input');
  assert.equal(mac.ask({ op: 'status', ...real, ciphertext: 'AAAA' }).error, 'bad_input');
  assert.deepEqual(touched(mac.calls()), []);
});

test('a keychain home the service cannot read refuses every blob, every create and every commit', { skip }, () => {
  const mac = new Mac();
  const blobWallet = walletFor(made(mac, { team: '' }));
  const key = made(mac);
  const wallet = walletFor(key);
  const unreadable = { fail: 'markers=-34018,keys=-34018,makeKey=-34018,addMarker=-34018' };
  const before = mac.calls().length;
  assert.equal(unwrap(mac, blobWallet.enclaveRequest()!, unreadable).answer.error, 'keychain_unavailable', 'it cannot prove no marker forbids the blob');
  assert.equal(unwrap(mac, wallet.enclaveRequest()!, unreadable).answer.error, 'keychain_unavailable');
  assert.equal(mac.ask({ op: 'create' }, unreadable).error, 'keychain_unavailable');
  assert.equal(commit(mac, wallet.enclaveRequest()!, unreadable).error, 'keychain_unavailable');
  assert.equal(mac.ask({ op: 'sweep' }, unreadable).error, 'keychain_unavailable');
  assert.equal(mac.ask({ op: 'status' }, unreadable).error, 'keychain_unavailable');
  assert.equal(mac.ask({ op: 'probe' }, unreadable).keychainHome, false);
  assert.deepEqual(touched(mac.since(before)), []);
  assert.equal(mac.state().blobs, 1, 'only the development build made a blob');
  // A marker that does not read as one still marks the Mac bound, and opens nothing.
  const state = mac.state();
  fs.writeFileSync(mac.store, JSON.stringify({ ...state, markers: [{ tag: key.keyBlob.slice(9), group: GROUP, body: Buffer.from('{}').toString('base64'), created: T0 }] }));
  assert.equal(unwrap(mac, blobWallet.enclaveRequest()!).answer.error, 'blob_refused');
  assert.equal(unwrap(mac, wallet.enclaveRequest()!).answer.error, 'pin_mismatch');
});

test('a cancelled touch is a cancel, and the file stays bound', { skip }, () => {
  const mac = new Mac();
  const wallet = walletFor(made(mac));
  assert.equal(unwrap(mac, wallet.enclaveRequest()!, { touch: 'cancel' }).answer.error, 'user_cancel');
  opens(mac, wallet);
  assert.equal(commit(mac, wallet.enclaveRequest()!).ok, true);
  assert.equal(unwrap(mac, wallet.enclaveRequest()!, { touch: 'cancel' }).answer.error, 'user_cancel');
  opens(mac, wallet);
});

test('every refusal of the keychain home has a calm sentence, and the lock screen says the ones an unlock can meet', () => {
  const main = fs.readFileSync(SERVICE, 'utf8');
  const codes = new Set([...main.matchAll(/Fail\(code: "([a-z_]+)"/g), ...main.matchAll(/failure\("([a-z_]+)"/g)].map((m) => m[1]));
  // What the service answered before it had a keychain home; the window maps those where they reach it.
  const before = ['bad_input', 'se_unavailable', 'user_cancel', 'interaction_required', 'auth_failed', 'foreign_key', 'crypto_failed'];
  const home = [...codes].filter((c) => !before.includes(c)).sort();
  assert.deepEqual(home, ['blob_refused', 'keychain_unavailable', 'marker_exists', 'no_key', 'not_committed', 'nothing_bound', 'pin_mismatch', 'stale_key']);
  for (const code of home) {
    const said = String(refusal(code).error);
    assert.notEqual(said, 'That did not work.', code);
    assert.ok(!/marker|\bpin\b|\btag\b|group|commit|sweep|entitlement|-\d{4,5}/i.test(said), `${code} is said in the person's words: ${said}`);
  }
  const lock = fs.readFileSync(path.join(ROOT, 'ui/screens/lock.js'), 'utf8');
  for (const code of ['keychain_unavailable', 'blob_refused', 'pin_mismatch', 'not_committed']) {
    assert.ok(lock.includes(`code === '${code}'`), `the lock screen says ${code}`);
  }
});

test('the stand-in keychain is never in a shipped build', { skip }, () => {
  const main = fs.readFileSync(SERVICE, 'utf8');
  const build = fs.readFileSync(path.join(ROOT, 'scripts/build-se-helper.sh'), 'utf8');
  const bundle = fs.readFileSync(path.join(ROOT, 'scripts/bundle-payload.ts'), 'utf8');
  for (const text of [build, bundle]) {
    assert.ok(!text.includes('PHOSPHOR_TESTSEAM') && !text.includes('VaultTestPlatform') && !text.includes('tests/swift'), 'no build script names the seam');
  }
  assert.equal(main.split('TestPlatform()').length, 2, 'main.swift builds it in one place');
  assert.match(main, /#if PHOSPHOR_TESTSEAM\nlet platform: Platform = TestPlatform\(\)\n#else\nlet platform: Platform = SystemPlatform\(\)\n#endif/);
  assert.ok(fs.readFileSync(SEAM, 'utf8').trimEnd().endsWith('#endif') && fs.readFileSync(SEAM, 'utf8').includes('#if PHOSPHOR_TESTSEAM\n'), 'the seam file compiles to nothing without the flag');
  // The shipped service and the development helper, compiled the way the build script does, alone:
  // they build, and neither carries a byte of the stand-in.
  for (const [name, defines] of [['service', []], ['dev', ['PHOSPHOR_STDIO']]] as [string, string[]][]) {
    const out = path.join(work, `shipped-${name}`);
    compile(out, defines, [SERVICE]);
    const bytes = fs.readFileSync(out);
    for (const needle of ['PHOSPHOR_TEST', 'TestPlatform', 'keychain.json']) {
      assert.equal(bytes.indexOf(needle), -1, `${name} carries ${needle}`);
    }
  }
});
