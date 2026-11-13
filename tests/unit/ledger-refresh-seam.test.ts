// The one refresh seam (src/ledger/refresh-seam.ts) and the unlock that asks it to read again.
//
// Once the vault has moved to the chip, the allowance is named only by an open wallet, so a pass
// before Touch ID reads the vault alone. The allowance usually holds most of the balance (Karim's:
// $1.62 of $1.99, 2026-11-13), and nothing read the ledger at the unlock: the window un-frosted on
// the vault's share and the rest waited for the 15 s poll, 12.3 s on the measured run.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { refreshSeam } from '../../src/ledger/refresh-seam.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

test('a caller arriving mid-pass joins the pass in flight instead of starting a second', async () => {
  let reads = 0;
  const gate = deferred();
  const seam = refreshSeam(async () => {
    reads += 1;
    await gate.promise;
  }, () => {});
  const first = seam.now();
  const second = seam.now();
  assert.equal(first, second);
  assert.equal(seam.busy(), true);
  gate.resolve();
  await first;
  assert.equal(reads, 1);
  assert.equal(seam.busy(), false);
});

test('again() waits out a pass that started before the change, then reads once more', async () => {
  // What the read can see: the allowance is named only after the unlock.
  let unlocked = false;
  const seen: boolean[] = [];
  const gates = [deferred(), deferred()];
  let landed = 0;
  const seam = refreshSeam(async () => {
    const at = seen.length;
    seen.push(unlocked);
    await gates[at]!.promise;
  }, () => {
    landed += 1;
  });
  const before = seam.now();
  unlocked = true;
  const after = seam.again();
  assert.notEqual(after, before);
  gates[0]!.resolve();
  await before;
  // The second pass starts only once the first has landed, never beside it.
  await new Promise(r => setImmediate(r));
  assert.deepEqual(seen, [false, true]);
  gates[1]!.resolve();
  await after;
  assert.equal(landed, 2);
});

test('again() with nothing in flight reads now', async () => {
  let reads = 0;
  const seam = refreshSeam(async () => {
    reads += 1;
  }, () => {});
  await seam.again();
  assert.equal(reads, 1);
});

test('a failed read still frees the seam and is not thrown at the caller', async () => {
  let reads = 0;
  const seam = refreshSeam(async () => {
    reads += 1;
    throw new Error('verifier down');
  }, () => {});
  await seam.now();
  await seam.again();
  assert.equal(reads, 2);
  assert.equal(seam.busy(), false);
});

test('src/main.ts reads the ledger again at every unlock, through the seam', () => {
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main.ts'), 'utf8');
  assert.match(main, /refreshSeam\(/);
  assert.match(main, /keystore\.onChange\(\s*\(?state\)?\s*=>\s*\{\s*if \(state === 'unlocked'\) void ledgerReads\.again\(\);/);
});
