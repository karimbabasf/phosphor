// Builder in grammar (PHASE2-PLAN U6, risk 3): every payload the app builds for the chip to sign is
// one the vault service's grammar (src-tauri/se-helper/IntentGrammar.swift) takes, reads exactly as
// Node's JSON.parse does, and turns into a verb-first sentence. Fifty payloads from buildVaultPayload:
// every token in the chip's table moved to the allowance and sent elsewhere, the rekey's empty
// proof, and the key removals a chip may sign. The grammar runs for real, compiled with its test
// driver (tests/swift/GrammarDriver.swift) into this file's temp folder.
//
// The nonce. The app builds every vault nonce to live exactly seven days past its payload (the lead's
// call, CONTRACTS.md), and the grammar takes only that life (rule `nonce`), so every payload here is
// taken as built.
//
// Run: node --test tests/unit/vault-chip-grammar.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { base58Encode } from '../../src/chain/near.ts';
import { NONCE_LIFE_AFTER_DEADLINE_MS } from '../../src/rails/intents-relay.ts';
import { buildNonce, decodeNonce } from '../../src/relay/payload.ts';
import { CHIP_PAYLOAD_LIFE_MS } from '../../src/vault/chip.ts';
import { buildVaultPayload } from '../../src/vault/payload.ts';
import type { VaultIntent } from '../../src/vault/payload.ts';
import { developerTools } from './helpers/no-dialog.ts';
import { SALT } from './helpers/intents-double.ts';
import { tempDir } from './helpers/tmp.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCES = ['src-tauri/se-helper/IntentGrammar.swift', 'src-tauri/se-helper/TokenTable.swift', 'tests/swift/GrammarDriver.swift'].map((f) => path.join(ROOT, f));
const work = tempDir('phosphor-chip-grammar-');
const swiftc = developerTools() && spawnSync('swiftc', ['--version'], { env: { ...process.env, TMPDIR: work } }).status === 0;
const skip = swiftc ? false : 'needs macOS with swiftc';

type Answer = { ok: boolean; rule?: string; message?: string; sentence?: string; parsed?: unknown };

function drive(requests: Record<string, unknown>[]): Answer[] {
  const out = path.join(work, 'grammar-driver');
  const build = spawnSync('swiftc', ['-Onone', '-parse-as-library', '-module-name', 'grammar_driver', '-module-cache-path', path.join(work, 'mc'), '-o', out, ...SOURCES], { encoding: 'utf8', env: { ...process.env, TMPDIR: work } });
  assert.equal(build.status, 0, `swiftc: ${build.stderr}`);
  const run = spawnSync(out, [], { input: requests.map((r) => JSON.stringify(r)).join('\n') + '\n', encoding: 'utf8', maxBuffer: 1 << 26, env: { PATH: '/usr/bin:/bin', TMPDIR: work } });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as Answer);
}

const NOW_MS = Date.UTC(2026, 9, 4, 21, 0, 0, 0);
const VAULT = `0x${'a1'.repeat(20)}`;
const ALLOWANCE = `0x${'b2'.repeat(20)}`;
const CHIP = Buffer.alloc(64, 0x2c);
const RECOVERY = `secp256k1:${base58Encode(Buffer.alloc(64, 0x5e))}`;
const PINS = { account: VAULT, allowance: ALLOWANCE, recovery: RECOVERY };

// The chip's table (src-tauri/se-helper/TokenTable.swift), asked of the driver itself.
function tableTokens(): { assetId: string; symbol: string; decimals: number }[] {
  const [answer] = drive([{ op: 'tokens' }]) as (Answer & { tokens: [string, string, number][] })[];
  return answer!.tokens.map(([assetId, symbol, decimals]) => ({ assetId, symbol, decimals }));
}

function payloads(tokens: { assetId: string; decimals: number }[]): { why: string; payload: string }[] {
  const out: { why: string; payload: string }[] = [];
  let n = 0;
  const add = (why: string, intents: VaultIntent[]) => {
    n += 1;
    out.push({ why, payload: buildVaultPayload({ signerId: VAULT, intents, deadlineMs: NOW_MS + CHIP_PAYLOAD_LIFE_MS, salt: SALT, random: () => Uint8Array.from({ length: 15 }, (_, i) => (i * 7 + n) & 0xff) }) });
  };
  const elsewhere = [`0x${'c3'.repeat(20)}`, 'alice.near', 'f'.repeat(64)];
  tokens.forEach((t, i) => {
    add(`top-up of ${t.assetId}`, [{ intent: 'transfer', receiver_id: ALLOWANCE, tokens: { [t.assetId]: (10n ** BigInt(t.decimals) * BigInt(i + 1) + BigInt(i)).toString() } }]);
    add(`send of ${t.assetId}`, [{ intent: 'transfer', receiver_id: elsewhere[i % 3]!, tokens: { [t.assetId]: (BigInt(i) + 1n).toString() } }]);
  });
  add('the smallest top-up', [{ intent: 'transfer', receiver_id: ALLOWANCE, tokens: { [tokens[0]!.assetId]: '1' } }]);
  add('the largest amount', [{ intent: 'transfer', receiver_id: ALLOWANCE, tokens: { [tokens[0]!.assetId]: ((1n << 128n) - 1n).toString() } }]);
  add('two tokens to one receiver', [
    { intent: 'transfer', receiver_id: ALLOWANCE, tokens: { [tokens.find((t) => t.decimals === 18)!.assetId]: '1500000000000000000' } },
    { intent: 'transfer', receiver_id: ALLOWANCE, tokens: { [tokens.find((t) => t.decimals === 24)!.assetId]: '2500000000000000000000000' } },
  ]);
  add('the rekey proof', []);
  add('the restore proof', []);
  add('the paper key retired', [{ intent: 'remove_public_key', public_key: RECOVERY }]);
  add('another secp256k1 key retired', [{ intent: 'remove_public_key', public_key: `secp256k1:${base58Encode(Buffer.alloc(64, 0x17))}` }]);
  add('an ed25519 key retired', [{ intent: 'remove_public_key', public_key: `ed25519:${base58Encode(Buffer.alloc(32, 0x44))}` }]);
  add('another chip retired', [{ intent: 'remove_public_key', public_key: `p256:${base58Encode(Buffer.alloc(64, 0x33))}` }]);
  add('two keys retired', [
    { intent: 'remove_public_key', public_key: RECOVERY },
    { intent: 'remove_public_key', public_key: `p256:${base58Encode(Buffer.alloc(64, 0x33))}` },
  ]);
  add('an empty proof, again', []);
  add('a key retired, again', [{ intent: 'remove_public_key', public_key: `secp256k1:${base58Encode(Buffer.alloc(64, 0x18))}` }]);
  add('a cent of the first token', [{ intent: 'transfer', receiver_id: ALLOWANCE, tokens: { [tokens[0]!.assetId]: '10000' } }]);
  add('a payout to a named account', [{ intent: 'transfer', receiver_id: 'phosphor.near', tokens: { [tokens[0]!.assetId]: '2500000' } }]);
  add('a payout to an implicit account', [{ intent: 'transfer', receiver_id: 'e4d620800228e29d21a180cc305b9541c170631df3b5b513b795947a27520108', tokens: { [tokens[0]!.assetId]: '99' } }]);
  add('the first top-up at the default size', [{ intent: 'transfer', receiver_id: ALLOWANCE, tokens: { [tokens[0]!.assetId]: '100000000' } }]);
  add('the touch session top-up', [{ intent: 'transfer', receiver_id: ALLOWANCE, tokens: { [tokens[0]!.assetId]: '5000000' } }]);
  add('a shortfall to the base unit', [{ intent: 'transfer', receiver_id: ALLOWANCE, tokens: { [tokens[0]!.assetId]: '1234567' } }]);
  add('everything of a 24-decimal token sent out', [{ intent: 'transfer', receiver_id: 'alice.near', tokens: { [tokens.find((t) => t.decimals === 24)!.assetId]: '123456789012345678901234567' } }]);
  add('a third chip retired', [{ intent: 'remove_public_key', public_key: `p256:${base58Encode(Buffer.alloc(64, 0x34))}` }]);
  return out;
}

// The same payload with its nonce rebuilt to expire with the payload, the life the grammar refuses.
function shortLived(payload: string): string {
  const body = JSON.parse(payload) as { deadline: string; nonce: string };
  const nonce = decodeNonce(body.nonce)!;
  return JSON.stringify({ ...body, nonce: buildNonce({ salt: nonce.salt, deadlineMs: Date.parse(body.deadline), random: nonce.random }) });
}

const parse = (payload: string) => ({ op: 'parse', payloadHex: Buffer.from(payload, 'utf8').toString('hex'), nowMs: NOW_MS, chip: CHIP.toString('hex'), pins: PINS });

test('50 payloads the app builds for the chip all pass the vault service\'s grammar, read as Node reads them, each with its sentence', { skip }, (t) => {
  const tokens = tableTokens();
  assert.equal(tokens.length, 15);
  const built = payloads(tokens);
  assert.ok(built.length >= 50, `${built.length} payloads`);
  for (const { payload } of built) {
    const body = JSON.parse(payload) as { deadline: string; nonce: string };
    assert.equal(decodeNonce(body.nonce)!.deadlineMs, Date.parse(body.deadline) + NONCE_LIFE_AFTER_DEADLINE_MS);
  }
  // As built, and again with each nonce rebuilt to die with its payload: one compile for both.
  const answers = drive([...built.map((b) => parse(b.payload)), ...built.map((b) => parse(shortLived(b.payload)))]);
  const accepted = built.map((b, i) => ({ ...b, answer: answers[i]! }));
  built.forEach((b, i) => {
    const older = answers[built.length + i]!;
    assert.equal(older.ok, false, `${b.why}: a nonce that dies with its payload is taken`);
    assert.equal(older.rule, 'nonce', `${b.why}: ${older.rule}: ${older.message}`);
  });
  t.diagnostic(`the compiled grammar takes the seven-day nonce: ${built.length} of ${built.length} accepted as built, the same ${built.length} refused for the nonce alone when it dies with the payload`);
  for (const { why, payload, answer } of accepted) {
    assert.equal(answer.ok, true, `${why}: ${answer.rule}: ${answer.message}`);
    assert.deepEqual(answer.parsed, JSON.parse(payload), `${why}: read as JSON.parse reads it`);
    assert.ok(answer.sentence !== undefined && answer.sentence.length <= 120 && /^(confirm|move|send|remove) /.test(answer.sentence), `${why}: ${answer.sentence}`);
  }
  const said = new Map(accepted.map((a) => [a.why, a.answer.sentence]));
  assert.equal(said.get('the rekey proof'), "confirm this Mac's Touch ID key for your vault");
  assert.equal(said.get('the paper key retired'), 'remove your paper recovery key from your vault');
  assert.equal(said.get('a cent of the first token'), 'move 0.01 USDC from your vault to your allowance');
  t.diagnostic(`${accepted.length} payloads, ${new Set(accepted.map((a) => a.answer.sentence)).size} distinct sentences`);
});
