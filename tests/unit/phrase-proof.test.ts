// The words a reveal leaves behind for "Prove it" (src/vault/phrase-proof.ts): checked on three
// different positions, bound to the wallet, worn out by misses and by time, and never an oracle.

import test from 'node:test';
import assert from 'node:assert/strict';

import { checkPhrase, forgetPhrase, PHRASE_PROOF_MISSES, PHRASE_PROOF_MS, rememberPhrase } from '../../src/vault/phrase-proof.ts';

const WORDS = 'abandon ability able about above absent absorb abstract absurd abuse access accident'.split(' ');
const WALLET = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const at = (index: number, word = WORDS[index]) => ({ index, word });

test.afterEach(() => forgetPhrase());

test('three right words at three positions prove it, typed any way a person types them', () => {
  rememberPhrase(WORDS, WALLET, 1000);
  assert.equal(checkPhrase([at(0, ' ABANDON '), at(5), at(11)], WALLET.toLowerCase(), 2000), 'match');
});

test('one position asked three times is a miss, so the check cannot confirm a single word', () => {
  rememberPhrase(WORDS, WALLET, 1000);
  assert.equal(checkPhrase([at(4), at(4), at(4)], WALLET, 2000), 'mismatch');
  assert.equal(checkPhrase([at(4), at(5)], WALLET, 2000), 'mismatch', 'and two positions are not enough');
});

test('five misses wear the proof out, and the words have to be shown again', () => {
  rememberPhrase(WORDS, WALLET, 1000);
  for (let i = 0; i < PHRASE_PROOF_MISSES; i += 1) assert.equal(checkPhrase([at(0, 'zoo'), at(1), at(2)], WALLET, 2000), 'mismatch');
  assert.equal(checkPhrase([at(0), at(1), at(2)], WALLET, 2000), 'none', 'right words after the wall still need a fresh reveal');
});

test('the proof belongs to the wallet it was revealed for, and to the half hour after', () => {
  rememberPhrase(WORDS, WALLET, 1000);
  assert.equal(checkPhrase([at(0), at(1), at(2)], '0x0000000000000000000000000000000000000001', 2000), 'none', 'a wallet made since cannot be proven with these words');
  rememberPhrase(WORDS, WALLET, 1000);
  assert.equal(checkPhrase([at(0), at(1), at(2)], WALLET, 1000 + PHRASE_PROOF_MS + 1), 'none');
  assert.equal(checkPhrase([at(0), at(1), at(2)], WALLET, 2000), 'none', 'and an expired proof is gone');
});
