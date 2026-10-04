// The vault service's intent grammar (src-tauri/se-helper/IntentGrammar.swift), run for real: the
// grammar and its token table are compiled here with a driver (tests/swift/GrammarDriver.swift) that
// answers one JSON line per request, and every payload below is the bytes the service will be handed.
// What the chip key signs is decided by these rules alone, so they are held three ways: a corpus of
// every accept and every refusal, each sentence byte for byte (tests/fixtures/intent-grammar/corpus.ts);
// 10 000 mutated payloads that must read the same in Node's JSON.parse whenever the grammar accepts
// them; and the Secure Enclave's own DER signatures from spike2 (tests/fixtures/intent-grammar/chip-der.json).

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { base58Encode } from '../../src/chain/near.ts';
import { NATIVE_ASSET } from '../../src/intents.ts';
import { NONCE_LIFE_AFTER_DEADLINE_MS } from '../../src/rails/intents-relay.ts';
import { buildNonce, decodeNonce } from '../../src/relay/payload.ts';
import { chipTokenRows, REGISTRY } from '../../scripts/gen-chip-tokens.ts';
import { ACCEPTED, CASES, CHIP, NOW_MS, PINS, RECOVERY, RULES, U128_MAX, USDC, VAULT, nonceAt, payload } from '../fixtures/intent-grammar/corpus.ts';
import type { Case } from '../fixtures/intent-grammar/corpus.ts';
import { developerTools } from './helpers/no-dialog.ts';
import { tempDir } from './helpers/tmp.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GRAMMAR = ['src-tauri/se-helper/IntentGrammar.swift', 'src-tauri/se-helper/TokenTable.swift'].map((f) => path.join(ROOT, f));
const DRIVER = path.join(ROOT, 'tests/swift/GrammarDriver.swift');
const SERVICE = path.join(ROOT, 'src-tauri/se-helper/main.swift');
const CHIP_OPS = path.join(ROOT, 'src-tauri/se-helper/ChipOps.swift');
const SEAM = path.join(ROOT, 'tests/swift/VaultTestPlatform.swift');
const DER_FIXTURE = path.join(ROOT, 'tests/fixtures/intent-grammar/chip-der.json');
const LIVE_FIXTURE = path.join(ROOT, 'tests/fixtures/intent-grammar/live-webauthn.json');

const work = tempDir('phosphor-grammar-');
const swiftc = developerTools() && spawnSync('swiftc', ['--version'], { env: { ...process.env, TMPDIR: work } }).status === 0;
const skip = swiftc ? false : 'needs macOS with swiftc';

const N = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
const HALF = N >> 1n;
// sha256("phosphor.money") || 05 || 00000000, as the verifier accepted it live (CONTRACTS, spike2).
const AUTHENTICATOR_DATA = '3075916cb46e3a48567140f0b539d3b30dfd49356330fc3ac2b6953244dc3d310500000000';

let built: string | null = null;

/* One compile per run, into this file's own temp folder with its module cache beside it. */
function driverBinary(): string {
  if (built !== null) return built;
  const out = path.join(work, 'grammar-driver');
  const args = ['-Onone', '-parse-as-library', '-module-name', 'grammar_driver', '-module-cache-path', path.join(work, 'mc'), '-o', out, ...GRAMMAR, DRIVER];
  const run = spawnSync('swiftc', args, { encoding: 'utf8', env: { ...process.env, TMPDIR: work } });
  assert.equal(run.status, 0, `swiftc: ${run.stderr}`);
  built = out;
  return out;
}

type Answer = { ok: boolean; rule?: string; message?: string; sentence?: string; parsed?: unknown } & Record<string, unknown>;

function drive(requests: Record<string, unknown>[]): Answer[] {
  const input = requests.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const run = spawnSync(driverBinary(), [], { input, encoding: 'utf8', maxBuffer: 1 << 28, env: { PATH: '/usr/bin:/bin', TMPDIR: work } });
  assert.equal(run.status, 0, `the driver exited ${run.status}: ${run.stderr}`);
  const lines = run.stdout.split('\n').filter((line) => line !== '');
  assert.equal(lines.length, requests.length, 'one answer per request');
  return lines.map((line) => JSON.parse(line) as Answer);
}

type Context = { payload: string; nowMs?: number; pins?: typeof PINS; chip?: Buffer };

/* The payload goes as its UTF-8 bytes, so the grammar reads exactly them. A JSON string would pass
   through JSONSerialization first, which drops a leading byte order mark (see the test on it below). */
const parseRequest = (c: Context) => ({
  op: 'parse',
  payloadHex: Buffer.from(c.payload, 'utf8').toString('hex'),
  nowMs: c.nowMs ?? NOW_MS,
  chip: (c.chip ?? CHIP).toString('hex'),
  pins: c.pins ?? PINS,
});

const VERB = /^(confirm|move|send|remove) /;

test('every corpus case is accepted with its sentence byte for byte, or refused by its rule', { skip }, (t) => {
  const answers = drive(CASES.map(parseRequest));
  CASES.forEach((c: Case, i) => {
    const a = answers[i];
    if ('sentence' in c) {
      assert.equal(a.ok, true, `${c.name}: refused ${a.rule}: ${a.message}`);
      assert.equal(a.sentence, c.sentence, c.name);
      assert.deepEqual(a.parsed, JSON.parse(c.payload), `${c.name}: the grammar read it as Node does`);
      assert.ok(c.sentence.length <= 120 && VERB.test(c.sentence), `${c.name}: verb first, 120 characters at most`);
    } else {
      assert.equal(a.ok, false, `${c.name}: accepted as "${a.sentence}"`);
      assert.equal(a.rule, c.rule, `${c.name}: ${a.message}`);
      if (c.says !== undefined) assert.ok(a.message?.includes(c.says), `${c.name}: "${a.message}" does not name ${c.says}`);
    }
  });
  const ruled = new Set(CASES.flatMap((c) => ('rule' in c ? [c.rule] : [])));
  assert.deepEqual(RULES.filter((rule) => !ruled.has(rule)), [], 'every rule in the grammar has a case');
  assert.ok(CASES.length >= 60);
  t.diagnostic(`${CASES.length} corpus cases: ${ACCEPTED.length} accepted, ${CASES.length - ACCEPTED.length} refused, ${ruled.size} rules`);
});

test('the chip key never signs add_public_key or set_auth_by_predecessor_id, however the payload dresses it', { skip }, () => {
  const p256 = `p256:${base58Encode(Buffer.alloc(64, 0x33))}`;
  const top = (intents: unknown[]) => payload({ intents });
  const transfer = { intent: 'transfer', receiver_id: PINS.allowance, tokens: { [USDC]: '1' } };
  const dressed: [string, string][] = [
    ['set_auth_by_predecessor_id off', top([{ intent: 'set_auth_by_predecessor_id', enabled: false }])],
    ['set_auth_by_predecessor_id on', top([{ intent: 'set_auth_by_predecessor_id', enabled: true }])],
    ['set_auth_by_predecessor_id with nothing else', top([{ intent: 'set_auth_by_predecessor_id' }])],
    ['add_public_key of a new p256 key', top([{ intent: 'add_public_key', public_key: p256 }])],
    ['add_public_key of the paper key', top([{ intent: 'add_public_key', public_key: RECOVERY }])],
    ['add_public_key of the signing chip', top([{ intent: 'add_public_key', public_key: `p256:${base58Encode(CHIP)}` }])],
    ['the whole rekey P_a: add, add, remove, predecessor auth off', top([
      { intent: 'add_public_key', public_key: p256 },
      { intent: 'add_public_key', public_key: RECOVERY },
      { intent: 'remove_public_key', public_key: `secp256k1:${base58Encode(Buffer.alloc(64, 0x17))}` },
      { intent: 'set_auth_by_predecessor_id', enabled: false },
    ])],
    ['a top-up, then predecessor auth on', top([transfer, { intent: 'set_auth_by_predecessor_id', enabled: true }])],
    ['a top-up, then a new key', top([transfer, { intent: 'add_public_key', public_key: p256 }])],
    ['a transfer that is also set_auth_by_predecessor_id', top([transfer]).replace('"intent":"transfer"', '"intent":"transfer","intent":"set_auth_by_predecessor_id"')],
    ['set_auth_by_predecessor_id that is also a transfer', top([transfer]).replace('"intent":"transfer"', '"intent":"set_auth_by_predecessor_id","intent":"transfer"')],
    ['add_public_key spelled with an escape', top([{ intent: 'add_public_key', public_key: p256 }]).replace('add_public_key', 'add\\u005fpublic_key')],
    ['Add_public_key with a capital', top([{ intent: 'Add_public_key', public_key: p256 }])],
    ['set_auth_by_predecessor_id in a list of five', top([transfer, transfer, transfer, transfer, { intent: 'set_auth_by_predecessor_id', enabled: true }])],
  ];
  const answers = drive(dressed.map(([, p]) => parseRequest({ payload: p })));
  dressed.forEach(([name], i) => {
    assert.equal(answers[i].ok, false, `${name}: accepted as "${answers[i].sentence}"`);
    assert.notEqual(answers[i].rule, 'driver', name);
  });
  // The two kinds are refused by name, not merely as kinds the grammar does not know.
  assert.equal(answers[0].rule, 'refused_kind');
  assert.equal(answers[3].rule, 'refused_kind');
});

/* A seeded generator, so a failing mutant can be run again (GRAMMAR_SEED). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

type Mutation = (s: string[], r: () => number) => string[];

const pick = <T>(items: readonly T[], r: () => number): T => items[Math.floor(r() * items.length)];
const place = (s: string[], r: () => number): number => Math.floor(r() * (s.length + 1));
const PRINTABLE = Array.from({ length: 95 }, (_, i) => String.fromCharCode(0x20 + i));
const ODD = ['\t', '\n', '\r', '\u0000', '\u007f', '\u00e9', '\u00a0', '\u2028', '\ufeff', '\u{1d7d9}'];
const LOOKALIKE: Record<string, string> = { a: '\u0430', c: '\u0441', e: '\u0435', i: '\u0456', o: '\u043e', p: '\u0440', x: '\u0445' };
const MEMBERS = [
  '"signer_id":"evil.near",', '"intent":"add_public_key",', '"intent":"set_auth_by_predecessor_id",', '"receiver_id":"evil.near",',
  '"tokens":{},', '"public_key":"p256:x",', '"memo":"",', '"enabled":false,', `"${USDC}":"1",`, '"nonce":"AAAA",',
  '"verifying_contract":"evil.near",', '"intents":[],',
];
const VALUES = [
  PINS.allowance, VAULT, 'alice.near', '0x12ab5678deadbeefdeadbeefdeadbeef90abcd34', 'ab'.repeat(32), 'evil.near', '1', '999', '1000000',
  U128_MAX, '0', USDC, 'nep141:wrap.near', 'nep141:usdt.tether-token.near', 'nep141:eth.omft.near', 'nep141:evil.near', 'transfer',
  'remove_public_key', 'add_public_key', 'set_auth_by_predecessor_id', RECOVERY, 'intents.near',
];
/* Values of one field for another of the same field: most of these leave a payload the grammar
   takes, saying something new, which is where a parser that reads differently would show. */
const SAME_KIND: [RegExp, string[]][] = [
  [/^nep141:/, [...chipTokenRows(JSON.parse(fs.readFileSync(REGISTRY, 'utf8')) as Record<string, unknown>, NATIVE_ASSET).map((r) => r.assetId), 'nep141:evil.near']],
  [/^[1-9][0-9]*$/, ['1', '7', '999', '1000000', '2500000', '123456789012345678901234567890', U128_MAX, '0', '01']],
  [/^(0x[0-9a-f]{40}|[0-9a-f]{64}|[a-z0-9_-]+(\.[a-z0-9_-]+)*\.near)$/, [PINS.allowance, VAULT, 'alice.near', 'bob.near', '0x12ab5678deadbeefdeadbeefdeadbeef90abcd34', 'ab'.repeat(32), 'Alice.near']],
  [/^(secp256k1|p256|ed25519):/, [RECOVERY, ...[0x17, 0x18, 0x19].map((b) => `secp256k1:${base58Encode(Buffer.alloc(64, b))}`), `p256:${base58Encode(Buffer.alloc(64, 0x34))}`, `ed25519:${base58Encode(Buffer.alloc(32, 0x45))}`, `p256:${base58Encode(CHIP)}`]],
];

/* Positions outside every string, where JSON allows whitespace. */
function between(s: string[]): number[] {
  const out: number[] = [];
  let inString = false;
  s.forEach((c, i) => {
    if (c === '"') inString = !inString;
    else if (!inString && /[{}[\],:]/.test(c)) out.push(i, i + 1);
  });
  return out;
}

const MUTATIONS: Mutation[] = [
  (s, r) => {
    const text = s.join('');
    const quoted = [...text.matchAll(/"([^"\\]*)"/g)].filter((m) => SAME_KIND.some(([kind]) => kind.test(m[1])));
    if (quoted.length === 0) return s;
    const m = pick(quoted, r);
    const pool = SAME_KIND.find(([kind]) => kind.test(m[1]))?.[1] ?? [m[1]];
    return Array.from(text.slice(0, m.index) + JSON.stringify(pick(pool, r)) + text.slice(m.index + m[0].length));
  },
  (s, r) => {
    const spots = between(s);
    return spots.length === 0 ? s : s.toSpliced(pick(spots, r), 0, pick([' ', '\t', '\n', '\r', '\r\n', '  '], r));
  },
  (s, r) => s.toSpliced(Math.floor(r() * s.length), 1, pick(r() < 0.8 ? PRINTABLE : ODD, r)),
  (s, r) => s.toSpliced(Math.floor(r() * s.length), 1),
  (s, r) => s.toSpliced(place(s, r), 0, pick(r() < 0.8 ? PRINTABLE : ODD, r)),
  (s, r) => s.toSpliced(place(s, r), 0, pick([' ', '\t', '\n', '\r', '  '], r)),
  (s, r) => {
    const braces = s.flatMap((c, i) => (c === '{' ? [i] : []));
    return braces.length === 0 ? s : s.toSpliced(pick(braces, r) + 1, 0, ...pick(MEMBERS, r));
  },
  (s, r) => {
    const letters = s.flatMap((c, i) => (/[a-z_.]/.test(c) ? [i] : []));
    if (letters.length === 0) return s;
    const i = pick(letters, r);
    return s.toSpliced(i, 1, ...`\\u00${s[i].charCodeAt(0).toString(16)}`);
  },
  (s, r) => {
    const letters = s.flatMap((c, i) => (/[a-zA-Z]/.test(c) ? [i] : []));
    if (letters.length === 0) return s;
    const i = pick(letters, r);
    return s.toSpliced(i, 1, s[i] === s[i].toLowerCase() ? s[i].toUpperCase() : s[i].toLowerCase());
  },
  (s, r) => {
    const digits = s.flatMap((c, i) => (/[0-9]/.test(c) ? [i] : []));
    return digits.length === 0 ? s : s.toSpliced(pick(digits, r), 1, String(Math.floor(r() * 10)));
  },
  (s, r) => {
    const i = Math.floor(r() * (s.length - 1));
    return s.toSpliced(i, 2, s[i + 1], s[i]);
  },
  (s, r) => s.slice(0, Math.floor(r() * s.length)),
  (s, r) => {
    const a = Math.floor(r() * s.length);
    const b = Math.min(s.length, a + 1 + Math.floor(r() * 40));
    return s.toSpliced(place(s, r), 0, ...s.slice(a, b));
  },
  (s, r) => {
    // One quoted value for another the grammar might take: often still a valid payload, read anew.
    const text = s.join('');
    const quoted = [...text.matchAll(/"([^"\\]*)"/g)];
    if (quoted.length === 0) return s;
    const m = pick(quoted, r);
    return Array.from(text.slice(0, m.index) + JSON.stringify(pick(VALUES, r)) + text.slice(m.index + m[0].length));
  },
  (s, r) => {
    const text = s.join('');
    const numbers = [...text.matchAll(/"([0-9]+)"/g)];
    if (numbers.length === 0) return s;
    const m = pick(numbers, r);
    return Array.from(text.slice(0, m.index) + m[1] + text.slice(m.index + m[0].length));
  },
  (s, r) => {
    const letters = s.flatMap((c, i) => (c in LOOKALIKE ? [i] : []));
    if (letters.length === 0) return s;
    const i = pick(letters, r);
    return s.toSpliced(i, 1, LOOKALIKE[s[i]]);
  },
];

test('10 000 mutated payloads: every one the grammar accepts reads the same in JSON.parse, and none crashes it', { skip }, (t) => {
  const seed = Number(process.env.GRAMMAR_SEED ?? 20261004);
  const random = mulberry32(seed);
  const mutants: { base: Case; text: string }[] = [];
  for (let i = 0; i < 10_000; i += 1) {
    const base = pick(ACCEPTED, random);
    let chars = Array.from(base.payload);
    const rounds = 1 + Math.floor(random() * 3);
    for (let k = 0; k < rounds; k += 1) chars = pick(MUTATIONS, random)(chars, random);
    mutants.push({ base, text: chars.join('') });
  }
  const answers = drive(mutants.map((m) => parseRequest({ ...m.base, payload: m.text })));
  let accepted = 0;
  let changed = 0;
  const refusals: Record<string, number> = {};
  answers.forEach((a, i) => {
    const { base, text } = mutants[i];
    if (!a.ok) {
      assert.notEqual(a.rule, 'driver', `mutant ${i}: ${a.message}`);
      refusals[a.rule ?? '?'] = (refusals[a.rule ?? '?'] ?? 0) + 1;
      return;
    }
    accepted += 1;
    if (text !== base.payload) changed += 1;
    let node: unknown;
    assert.doesNotThrow(() => {
      node = JSON.parse(text);
    }, `mutant ${i} was accepted and JSON.parse refuses it: ${JSON.stringify(text)}`);
    assert.deepEqual(a.parsed, node, `mutant ${i} reads differently in JSON.parse: ${JSON.stringify(text)}`);
    assert.ok(typeof a.sentence === 'string' && a.sentence.length <= 120 && VERB.test(a.sentence), `mutant ${i}: ${a.sentence}`);
  });
  const byRule = Object.entries(refusals).sort(([x], [y]) => (x < y ? -1 : 1)).map(([rule, n]) => `${rule} ${n}`).join(', ');
  t.diagnostic(`seed ${seed}: ${mutants.length} mutants, ${accepted} accepted (${changed} differ from their seed payload), ${mutants.length - accepted} refused: ${byRule}`);
  assert.ok(changed >= 500, `only ${changed} accepted mutants differ from their seed, too few for the property to mean much`);
});

type DerFixture = { runs: { run: string; keys: { x963: string; signatures: { message: string; der: string; raw: string; low: string; high: boolean }[] }[] }[] };
const fixture = JSON.parse(fs.readFileSync(DER_FIXTURE, 'utf8')) as DerFixture;

function p256Key(x963: Buffer): crypto.KeyObject {
  return crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: x963.subarray(1, 33).toString('base64url'), y: x963.subarray(33, 65).toString('base64url') }, format: 'jwk' });
}

const verifies = (key: crypto.KeyObject, message: Buffer, raw: Buffer): boolean => crypto.verify('sha256', message, { key, dsaEncoding: 'ieee-p1363' }, raw);
const big = (b: Buffer): bigint => BigInt(`0x${b.toString('hex') || '0'}`);
const hex32 = (v: bigint): string => v.toString(16).padStart(64, '0');

function derInteger(v: bigint): Buffer {
  let h = v.toString(16);
  if (h.length % 2 === 1) h = `0${h}`;
  let b = Buffer.from(h, 'hex');
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return Buffer.concat([Buffer.from([0x02, b.length]), b]);
}

function der(r: bigint, s: bigint): Buffer {
  const body = Buffer.concat([derInteger(r), derInteger(s)]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

test("all 123 of spike2's Secure Enclave signatures convert to its r || s and low-S forms, and verify", { skip }, (t) => {
  const items = fixture.runs.flatMap((run) => run.keys.flatMap((k) => k.signatures.map((s) => ({ ...s, key: p256Key(Buffer.from(k.x963, 'hex')) }))));
  assert.equal(fixture.runs[0].keys.reduce((n, k) => n + k.signatures.length, 0), 61, "spike2 run 1's 61");
  assert.equal(items.length, 123);
  const answers = drive(items.map((s) => ({ op: 'der', der: s.der })));
  const lengths: Record<number, number> = {};
  let high = 0;
  answers.forEach((a, i) => {
    const s = items[i];
    assert.equal(a.ok, true, `signature ${i}: ${a.message}`);
    assert.equal(a.raw, s.raw, `signature ${i}: r || s`);
    assert.equal(a.low, s.low, `signature ${i}: low S`);
    assert.equal(s.high, s.raw !== s.low);
    assert.ok(big(Buffer.from(String(a.low), 'hex').subarray(32)) <= HALF, `signature ${i}: S is low`);
    assert.ok(verifies(s.key, Buffer.from(s.message, 'hex'), Buffer.from(String(a.low), 'hex')), `signature ${i} verifies`);
    lengths[s.der.length / 2] = (lengths[s.der.length / 2] ?? 0) + 1;
    if (s.high) high += 1;
  });
  t.diagnostic(`${items.length} chip signatures, ${high} came back high, DER lengths ${JSON.stringify(lengths)}: all convert and verify`);
});

test('a DER signature with a short r or s (69 bytes or less) converts and verifies', { skip }, (t) => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const found: { message: Buffer; der: Buffer; r: bigint; s: bigint }[] = [];
  let shortR = 0;
  let shortS = 0;
  for (let i = 0; i < 400_000 && (shortR < 8 || shortS < 8); i += 1) {
    const message = crypto.randomBytes(69);
    const raw = crypto.sign('sha256', message, { key: privateKey, dsaEncoding: 'ieee-p1363' });
    const r = big(raw.subarray(0, 32));
    const sig = big(raw.subarray(32));
    const s = sig > HALF ? N - sig : sig;
    if (der(r, s).length > 69) continue;
    if (r < 1n << 247n) shortR += 1;
    if (s < 1n << 247n) shortS += 1;
    // The short form and its high-S twin: both must come back as the same low r || s.
    found.push({ message, der: der(r, s), r, s }, { message, der: der(r, N - s), r, s });
  }
  assert.ok(shortR >= 8 && shortS >= 8, `found ${shortR} short r and ${shortS} short s`);
  const answers = drive(found.map((f) => ({ op: 'der', der: f.der.toString('hex') })));
  answers.forEach((a, i) => {
    const f = found[i];
    assert.equal(a.ok, true, String(a.message));
    assert.equal(a.low, hex32(f.r) + hex32(f.s), `case ${i}: padded on the left and low`);
    assert.ok(verifies(publicKey, f.message, Buffer.from(String(a.low), 'hex')));
  });
  // Shorter than any signature turns up: r = s = 1, and an r of 31 bytes that needs its zero byte.
  const crafted = drive([{ op: 'der', der: '3006020101020101' }, { op: 'der', der: der(1n << 247n, N - 1n).toString('hex') }]);
  assert.deepEqual(crafted.map((a) => a.low), [hex32(1n) + hex32(1n), hex32(1n << 247n) + hex32(1n)]);
  t.diagnostic(`${found.length / 2} signatures with DER of 69 bytes or less (${shortR} short r, ${shortS} short s), each low and high: all convert and verify`);
});

test('DER that is not exactly a sequence of two minimal integers in 1 to n - 1 is refused', { skip }, () => {
  const n = derInteger(N).toString('hex');
  const one = '020101';
  const bad: [string, string][] = [
    ['nothing', ''],
    ['a sequence tag alone', '30'],
    ['a set, not a sequence', `3106${one}${one}`],
    ['a length that overstates', `3007${one}${one}`],
    ['a length that understates', `3005${one}${one}`],
    ['a long-form length', `308106${one}${one}`],
    ['a bit string for r', `3006030101${one}`],
    ['one integer', `3003${one}`],
    ['three integers', `3009${one}${one}${one}`],
    ['a byte after the integers', `3007${one}${one}00`],
    ['a negative r', `3006020181${one}`],
    ['a needless leading zero', `300702020001${one}`],
    ['an integer of no bytes', `30050200${one}`],
    ['r of zero', `3006020100${one}`],
    ['s of zero', `3006${one}020100`],
    ['r equal to n', `30${(3 + n.length / 2).toString(16)}${n}${one}`],
    ['s equal to n', `30${(3 + n.length / 2).toString(16)}${one}${n}`],
    ['r over n', `30${(3 + n.length / 2).toString(16)}${derInteger(N + 1n).toString('hex')}${one}`],
    ['an integer of 34 bytes', `3027022200${'7f'.repeat(33)}${one}`],
    ['over 72 bytes', `3047${'022100ff' + 'ff'.repeat(31)}${'022100ff' + 'ff'.repeat(31)}00`],
  ];
  const answers = drive(bad.map(([, d]) => ({ op: 'der', der: d })));
  bad.forEach(([name], i) => {
    assert.equal(answers[i].ok, false, `${name} converted to ${answers[i].raw}`);
    assert.equal(answers[i].rule, 'der', `${name}: ${answers[i].message}`);
  });
});

test('1 000 random S values come back low, and 1 000 software signatures in either form verify after', { skip }, (t) => {
  const values: bigint[] = [1n, HALF - 1n, HALF, HALF + 1n, N - 1n];
  while (values.length < 1000) {
    const v = big(crypto.randomBytes(32));
    if (v > 0n && v < N) values.push(v);
  }
  const r = big(crypto.randomBytes(31));
  const lows = drive(values.map((s) => ({ op: 'low', raw: hex32(r) + hex32(s) })));
  lows.forEach((a, i) => {
    const s = values[i];
    assert.equal(a.low, hex32(r) + hex32(s > HALF ? N - s : s), `S = ${s.toString(16)}`);
  });

  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const signed = Array.from({ length: 1000 }, (_, i) => {
    const message = crypto.randomBytes(69);
    const raw = crypto.sign('sha256', message, { key: privateKey, dsaEncoding: 'ieee-p1363' });
    const rr = big(raw.subarray(0, 32));
    const s = big(raw.subarray(32));
    const low = s > HALF ? N - s : s;
    return { message, rr, low, der: der(rr, i % 2 === 0 ? low : N - low) };
  });
  const answers = drive(signed.map((s) => ({ op: 'der', der: s.der.toString('hex') })));
  answers.forEach((a, i) => {
    const s = signed[i];
    assert.equal(a.low, hex32(s.rr) + hex32(s.low));
    assert.ok(verifies(publicKey, s.message, Buffer.from(String(a.low), 'hex')), `signature ${i}`);
  });
  t.diagnostic(`${values.length} S values normalized; ${signed.length} signatures, half sent high, all verify low`);
});

test('the webauthn wrapper is byte for byte the one the verifier accepted live', { skip }, () => {
  const payloads = [...ACCEPTED.map((c) => c.payload), payload({ deadline: new Date(NOW_MS + 90_000).toISOString(), nonce: nonceAt(NOW_MS + 90_000) })];
  const answers = drive(payloads.map((p) => ({ op: 'wrap', payload: p })));
  answers.forEach((a, i) => {
    const challenge = crypto.createHash('sha256').update(payloads[i]).digest('base64url');
    const clientData = `{"type":"webauthn.get","challenge":"${challenge}","origin":"https://phosphor.money"}`;
    assert.equal(a.clientDataJSON, clientData);
    assert.equal(a.authenticatorData, 'MHWRbLRuOkhWcUDwtTnTsw39STVjMPw6wraVMkTcPTEFAAAAAA');
    assert.equal(a.signed, AUTHENTICATOR_DATA + crypto.createHash('sha256').update(clientData).digest('hex'));
  });
  assert.equal(Buffer.from(String(answers[0].authenticatorData), 'base64url').toString('hex'), AUTHENTICATOR_DATA);
  // spike2's chip signed over this same authenticator data, live on 0.4.4, with each of its four keys.
  const keys = fixture.runs.flatMap((run) => run.keys);
  assert.equal(keys.length, 4);
  for (const k of keys) assert.ok(k.signatures.some((s) => s.message.startsWith(AUTHENTICATOR_DATA)), `key ${k.x963.slice(0, 16)} signed the wrapper`);
});

type LiveVector = { test: string; intents: string[]; x963: string; der: string; signed: Record<string, string> };
const live = (JSON.parse(fs.readFileSync(LIVE_FIXTURE, 'utf8')) as { vectors: LiveVector[] }).vectors;
const fromHex = (h: string): string => Buffer.from(h, 'hex').toString('utf8');

test("every chip-signed MultiPayload the live verifier accepted in spike2 is rebuilt byte for byte from its payload and the chip's DER", { skip }, () => {
  assert.equal(live.length, 7);
  const answers = drive(live.map((v) => ({ op: 'multipayload', payloadHex: v.signed.payload, publicKey: v.x963.slice(2), der: v.der })));
  live.forEach((v, i) => {
    const accepted = Object.fromEntries(Object.entries(v.signed).map(([field, h]) => [field, fromHex(h)]));
    assert.deepEqual(answers[i].signed, accepted, v.test);
  });
});

test("the grammar takes spike2's live rekey proofs, and refuses its chip-signed add_public_key and the chip switching predecessor auth back on", { skip }, () => {
  // spike2 signed its nonces to expire with their payloads; the grammar takes only the seven-day
  // life every nonce Phosphor builds carries (CONTRACTS.md, "Lead's call: nonce lifetime"). So each
  // live payload is read twice: as signed, refused for its nonce alone, and with the same nonce
  // parts re-dated, read for its intents.
  const read = (payload: string, signerId: string, deadline: string, v: LiveVector) => ({
    op: 'parse', payloadHex: Buffer.from(payload, 'utf8').toString('hex'), nowMs: Date.parse(deadline) - 60_000, chip: v.x963.slice(2), pins: { ...PINS, account: signerId },
  });
  const requests = live.flatMap((v) => {
    const text = fromHex(v.signed.payload);
    const signed = JSON.parse(text) as { signer_id: string; deadline: string; nonce: string };
    const parts = decodeNonce(signed.nonce);
    assert.ok(parts !== null && parts.deadlineMs === Date.parse(signed.deadline), `${v.test}: spike2's nonce expires with its payload`);
    const renonced = text.replace(signed.nonce, buildNonce({ ...parts, deadlineMs: Date.parse(signed.deadline) + NONCE_LIFE_AFTER_DEADLINE_MS }));
    return [read(text, signed.signer_id, signed.deadline, v), read(renonced, signed.signer_id, signed.deadline, v)];
  });
  const answers = drive(requests);
  live.forEach((v, i) => {
    const [asSigned, a] = [answers[2 * i], answers[2 * i + 1]];
    assert.equal(asSigned.rule, 'nonce', `${v.test} as signed: ${asSigned.message}`);
    if (v.intents.length === 0) {
      assert.equal(a.sentence, "confirm this Mac's Touch ID key for your vault", v.test);
    } else {
      assert.equal(a.rule, 'refused_kind', `${v.test}: ${a.message}`);
      assert.ok(a.message?.startsWith(v.intents[0]), `${v.test}: ${a.message}`);
    }
  });
  // T10p.chipOn: on 0.4.4 the chip key could switch predecessor auth back on. The grammar is what stops it.
  assert.ok(live.some((v) => v.test.includes('T10p.chipOn') && v.intents.includes('set_auth_by_predecessor_id')));
});

test('the service reads a payload string through JSONSerialization, which drops one leading byte order mark', { skip }, () => {
  // So what the grammar reads, and what the chip would sign, is the string after JSONSerialization,
  // and the payload the service hands back is that string: Node's byte-equal check on it (C7) is what
  // tells the two apart. Any other character JSONSerialization keeps, and the grammar refuses it.
  const topUp = ACCEPTED[1].payload;
  const [asString, asBytes, wrapped] = drive([
    { op: 'parse', payload: `﻿${topUp}`, nowMs: NOW_MS, chip: CHIP.toString('hex'), pins: PINS },
    parseRequest({ payload: `﻿${topUp}` }),
    { op: 'wrap', payload: `﻿${topUp}` },
  ]);
  assert.equal(asString.sentence, 'move 100.00 USDC from your vault to your allowance');
  assert.deepEqual(asString.parsed, JSON.parse(topUp));
  assert.equal(asBytes.rule, 'ascii');
  assert.ok(String(wrapped.clientDataJSON).includes(crypto.createHash('sha256').update(topUp).digest('base64url')));
});

test("base58 matches Bitcoin's published vectors and the app's own encoder", { skip }, () => {
  const vectors: [string, string][] = [
    ['61', '2g'],
    ['626262', 'a3gV'],
    ['636363', 'aPEr'],
    ['73696d706c792061206c6f6e6720737472696e67', '2cFupjhnEsSn59qHXstmK2ffpLv2'],
    ['00eb15231dfceb60925886b67d065299925915aeb172c06647', '1NS17iag9jJgTHD1VXjvLCEnZuQ3rJDE9L'],
    ['516b6fcd0f', 'ABnLTmg'],
    ['bf4f89001e670274dd', '3SEo3LWLoPntC'],
    ['572e4794', '3EFU7m'],
    ['ecac89cad93923c02321', 'EJDM8drfXA6uyA'],
    ['10c8511e', 'Rt5zm'],
    ['00000000000000000000', '1111111111'],
  ];
  const randoms = Array.from({ length: 500 }, (_, i) => {
    const b = crypto.randomBytes(1 + (i % 80));
    if (i % 7 === 0) b.fill(0, 0, Math.min(b.length, 1 + (i % 3)));
    return b;
  });
  const encoded = drive([...vectors.map(([h]) => ({ op: 'base58', hex: h })), ...randoms.map((b) => ({ op: 'base58', hex: b.toString('hex') }))]);
  vectors.forEach(([, text], i) => assert.equal(encoded[i].text, text));
  randoms.forEach((b, i) => assert.equal(encoded[vectors.length + i].text, base58Encode(b)));
  const decoded = drive([...randoms.map((b) => ({ op: 'unbase58', text: base58Encode(b) })), ...['0', 'O', 'I', 'l', '+', 'ab0c'].map((text) => ({ op: 'unbase58', text }))]);
  randoms.forEach((b, i) => assert.equal(decoded[i].hex, b.toString('hex')));
  decoded.slice(randoms.length).forEach((a) => assert.equal(a.ok, false));
  const chip = drive([{ op: 'p256', hex: CHIP.toString('hex') }]);
  assert.equal(chip[0].text, `p256:${base58Encode(CHIP)}`);
});

test("the compiled token table is the generator's, row for row", { skip }, () => {
  const [answer] = drive([{ op: 'tokens' }]);
  const rows = chipTokenRows(JSON.parse(fs.readFileSync(REGISTRY, 'utf8')) as Record<string, unknown>, NATIVE_ASSET);
  assert.deepEqual(answer.tokens, rows.map((r) => [r.assetId, r.symbol, r.decimals]));
});

test('the grammar type-checks inside the service beside main.swift, in its stdin and its XPC form', { skip }, () => {
  // Checked with the stand-in keychain (PHOSPHOR_TESTSEAM) and never built: nothing here can reach
  // the real keychain or raise a dialog, and one module proves no name in the grammar collides.
  for (const defines of [['-D', 'PHOSPHOR_STDIO'], []]) {
    const args = ['-typecheck', ...defines, '-D', 'PHOSPHOR_TESTSEAM', '-D', 'PHOSPHOR_CHIP', '-module-name', 'se_helper', '-module-cache-path', path.join(work, 'mc'), SERVICE, CHIP_OPS, SEAM, ...GRAMMAR];
    const run = spawnSync('swiftc', args, { encoding: 'utf8', env: { ...process.env, TMPDIR: work } });
    assert.equal(run.status, 0, `swiftc ${defines.join(' ')}: ${run.stderr}`);
  }
});
