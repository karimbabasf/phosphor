// audit2 AU2-01. A NEAR name is said whole, so a receiver Node picks could carry the very words the
// sentence keeps for the pinned accounts: a compromised Node asks the chip to sign a transfer to a
// name it registered, and the Touch ID dialog reads like a top-up. The app never asks the chip for a
// transfer to anything but the pinned allowance (chipSign's callers: the top-up in
// src/vault/allowance.ts, the rekey's empty proof in src/vault/rekey.ts), so the grammar refuses
// every other receiver (rule receiver) and Node refuses it first, before the service is asked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { base58Encode } from '../../src/chain/near.ts';
import { chipPayloadRefusal } from '../../src/vault/chip-grammar.ts';
import { readVaultPayload } from '../../src/vault/payload.ts';
import { CHIP, NOW_MS, PINS, USDC, payload } from '../fixtures/intent-grammar/corpus.ts';
import { developerTools } from './helpers/no-dialog.ts';
import { tempDir } from './helpers/tmp.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const work = tempDir('phosphor-audit2-grammar-');
const swiftc = developerTools() && spawnSync('swiftc', ['--version'], { env: { ...process.env, TMPDIR: work } }).status === 0;

function driver(): string {
  const out = path.join(work, 'grammar-driver');
  const files = ['src-tauri/se-helper/IntentGrammar.swift', 'src-tauri/se-helper/TokenTable.swift', 'tests/swift/GrammarDriver.swift'].map((f) => path.join(ROOT, f));
  const run = spawnSync('swiftc', ['-Onone', '-parse-as-library', '-module-name', 'grammar_driver', '-module-cache-path', path.join(work, 'mc'), '-o', out, ...files], { encoding: 'utf8', env: { ...process.env, TMPDIR: work } });
  assert.equal(run.status, 0, `swiftc: ${run.stderr}`);
  return out;
}

const transferTo = (receiver: string) =>
  payload({ intents: [{ intent: 'transfer', receiver_id: receiver, tokens: { [USDC]: '100000000' } }] });

const LOOKALIKES = ['your-allowance.near', 'your-vault.near', 'your-allowance', '0x12ab5678.90abcd34', `0x${'c3'.repeat(20)}`, 'ab'.repeat(32)];

test('AU2-01: a receiver the marker does not pin never gets a Touch ID sentence, and Node refuses it first', { skip: swiftc ? false : 'needs swiftc' }, () => {
  const bin = driver();
  const ask = (receiver: string) => ({ op: 'parse', payloadHex: Buffer.from(transferTo(receiver), 'utf8').toString('hex'), nowMs: NOW_MS, chip: CHIP.toString('hex'), pins: PINS });
  const run = spawnSync(bin, [], { input: [PINS.allowance, ...LOOKALIKES].map((r) => JSON.stringify(ask(r))).join('\n') + '\n', encoding: 'utf8', env: { PATH: '/usr/bin:/bin', TMPDIR: work } });
  assert.equal(run.status, 0, run.stderr);
  const answers = run.stdout.trim().split('\n').map((line) => JSON.parse(line) as { ok: boolean; sentence?: string; rule?: string; message?: string });
  assert.equal(answers[0]!.sentence, 'move 100.00 USDC from your vault to your allowance');
  console.log(`honest top-up: ${answers[0]!.sentence}`);
  LOOKALIKES.forEach((receiver, i) => {
    const a = answers[i + 1]!;
    console.log(`${receiver}: ${a.ok ? `signed behind "${a.sentence}"` : `refused ${a.rule}: ${a.message}`}`);
    assert.equal(a.ok, false, `the chip would sign, behind the dialog "${a.sentence}"`);
    assert.equal(a.rule, 'receiver', `${receiver}: ${a.message}`);
  });

  // Node's first reading (chipSign): readVaultPayload's shape, then the grammar's rules.
  const chip = `p256:${base58Encode(CHIP)}`;
  const node = (receiver: string, pins: { account: string; allowance?: string; recovery?: string }) => {
    let read: ReturnType<typeof readVaultPayload>;
    try {
      read = readVaultPayload(transferTo(receiver));
    } catch {
      return 'shape';
    }
    return chipPayloadRefusal(read, chip, NOW_MS, pins)?.rule ?? null;
  };
  assert.equal(node(PINS.allowance, PINS), null, 'the honest top-up is handed on');
  for (const receiver of LOOKALIKES) assert.ok(['receiver', 'shape'].includes(node(receiver, PINS) ?? ''), `Node hands ${receiver} on`);
  assert.equal(node('your-allowance.near', PINS), 'receiver');
  // No allowance named by the caller: no transfer is handed on at all.
  assert.equal(node(PINS.allowance, { account: PINS.account }), 'receiver');
});
