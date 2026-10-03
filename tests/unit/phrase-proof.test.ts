// What a reveal leaves behind for "Prove it" (src/vault/phrase-proof.ts): the three positions the
// window asks for and one slow hash of those words, bound to the wallet, worn out by tries and by
// time, and never an oracle.

import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultParams } from '../../src/keystore/kdf.ts';
import { checkPhrase, forgetPhrase, PHRASE_PROOF_MISSES, PHRASE_PROOF_MS, PHRASE_PROOF_WORDS, rememberPhrase } from '../../src/vault/phrase-proof.ts';

const WORDS = 'abandon ability able about above absent absorb abstract absurd abuse access accident'.split(' ');
const WALLET = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
// The keystore's scrypt at the cost the rest of the suite runs it at.
const FAST = () => ({ ...defaultParams(), N: 2 ** 14 });
const at = (index: number, word = WORDS[index]!) => ({ index, word });
const right = (positions: number[]) => positions.map((index) => at(index));
const elsewhere = (positions: number[]) => [0, 1, 2, 3].filter((i) => !positions.includes(i)).slice(0, 3);

test.afterEach(() => forgetPhrase());

test('a reveal names three different positions, and the right words there prove it, typed any way a person types them', async () => {
  const asked = rememberPhrase(WORDS, WALLET, FAST(), 1000);
  assert.equal(asked.length, PHRASE_PROOF_WORDS);
  assert.equal(new Set(asked).size, PHRASE_PROOF_WORDS, 'a position was asked twice');
  assert.ok(asked.every((p) => Number.isInteger(p) && p >= 0 && p < WORDS.length));
  assert.deepEqual(asked, [...asked].sort((a, b) => a - b));
  const typed = asked.map((index) => at(index, ` ${WORDS[index]!.toUpperCase()} `)).reverse();
  assert.equal(await checkPhrase(typed, WALLET.toLowerCase(), 2000), 'match');
});

/* What made the per-word HMAC an oracle for the whole phrase: any three positions were checked.
   Only the three asked are now, because only they are kept. */
test('the right words at positions the app did not ask for are a miss', async () => {
  const asked = rememberPhrase(WORDS, WALLET, FAST(), 1000);
  assert.equal(await checkPhrase(right(elsewhere(asked)), WALLET, 2000), 'mismatch');
  assert.equal(await checkPhrase([at(asked[0]!), at(asked[0]!), at(asked[0]!)], WALLET, 2000), 'mismatch', 'one position three times');
  assert.equal(await checkPhrase(right(asked.slice(0, 2)), WALLET, 2000), 'mismatch', 'and two positions are not enough');
  assert.equal(await checkPhrase([at(asked[0]!, 'zoo'), at(asked[1]!), at(asked[2]!)], WALLET, 2000), 'mismatch', 'one wrong word');
  assert.equal(await checkPhrase(right(asked), WALLET, 2000), 'match');
});

test('five tries wear the proof out, and the words have to be shown again', async () => {
  const asked = rememberPhrase(WORDS, WALLET, FAST(), 1000);
  const wrong = [at(asked[0]!, 'zoo'), at(asked[1]!), at(asked[2]!)];
  for (let i = 0; i < PHRASE_PROOF_MISSES; i += 1) assert.equal(await checkPhrase(wrong, WALLET, 2000), 'mismatch');
  assert.equal(await checkPhrase(right(asked), WALLET, 2000), 'none', 'right words after the wall still need a fresh reveal');
});

test('tries sent together are counted before their hash runs, so they cannot get past the wall', async () => {
  const asked = rememberPhrase(WORDS, WALLET, FAST(), 1000);
  const wrong = [at(asked[0]!, 'zoo'), at(asked[1]!), at(asked[2]!)];
  const answers = await Promise.all(Array.from({ length: PHRASE_PROOF_MISSES + 3 }, () => checkPhrase(wrong, WALLET, 2000)));
  assert.equal(answers.filter((a) => a === 'mismatch').length, PHRASE_PROOF_MISSES);
  assert.equal(answers.filter((a) => a === 'none').length, 3);
  assert.equal(await checkPhrase(right(asked), WALLET, 2000), 'none');
});

test('the proof belongs to the wallet it was revealed for, and to the half hour after', async () => {
  let asked = rememberPhrase(WORDS, WALLET, FAST(), 1000);
  assert.equal(await checkPhrase(right(asked), '0x0000000000000000000000000000000000000001', 2000), 'none', 'a wallet made since cannot be proven with these words');
  asked = rememberPhrase(WORDS, WALLET, FAST(), 1000);
  assert.equal(await checkPhrase(right(asked), WALLET, 1000 + PHRASE_PROOF_MS + 1), 'none');
  assert.equal(await checkPhrase(right(asked), WALLET, 2000), 'none', 'and an expired proof is gone');
});

/* The first run reads the words again when a check was let go, and sends the three it already
   asked for: a reveal made again for the same wallet has to ask the same three. */
test('a wallet keeps its three positions across reveals until they are proven', async () => {
  const first = rememberPhrase(WORDS, WALLET, FAST(), 1000);
  assert.deepEqual(rememberPhrase(WORDS, WALLET, FAST(), 1000), first);
  forgetPhrase();
  assert.deepEqual(rememberPhrase(WORDS, WALLET.toLowerCase(), FAST(), 1000), first, 'a forget is not a proof');
  assert.equal(await checkPhrase(right(first), WALLET, 2000), 'match');
});

test('a hash that could not be made is a check that asks for the words again, never a throw', async () => {
  const asked = rememberPhrase(WORDS, WALLET, { ...FAST(), N: 3 }, 1000);
  assert.equal(await checkPhrase(right(asked), WALLET, 2000), 'none');
});

/* The checks below pass a time inside the half hour, so only the timer can be what wiped it. */
test('the proof leaves memory when its half hour is up, with no check to notice, and a newer reveal keeps its own half hour', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let asked = rememberPhrase(WORDS, WALLET, FAST(), 1000);
  t.mock.timers.tick(PHRASE_PROOF_MS - 1);
  assert.equal(await checkPhrase(right(asked), WALLET, 2000), 'match', 'gone before its half hour');
  t.mock.timers.tick(1);
  assert.equal(await checkPhrase(right(asked), WALLET, 2000), 'none', 'still held after its half hour');

  rememberPhrase(WORDS, WALLET, FAST(), 1000);
  t.mock.timers.tick(20 * 60_000);
  asked = rememberPhrase(WORDS, WALLET, FAST(), 1000);
  t.mock.timers.tick(15 * 60_000);
  assert.equal(await checkPhrase(right(asked), WALLET, 2000), 'match', 'the first reveal\'s timer wiped the second');
  t.mock.timers.tick(15 * 60_000);
  assert.equal(await checkPhrase(right(asked), WALLET, 2000), 'none');
});
