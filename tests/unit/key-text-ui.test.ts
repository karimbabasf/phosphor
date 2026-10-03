// The window's one reading of a typed private key and of a refusal's sentence (ui/core/custody.js),
// run as the page runs it. Every screen that takes a key back (the first run, the lock card, the
// Vault's restore and Check your copy) reads it here, so an o typed for a 0 is named by its group
// on all of them, and what it sends is what the backend reads (src/keystore/derive.ts keyProblem).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

import { generatePrivateKey } from 'viem/accounts';
import { keyProblem } from '../../src/keystore/derive.ts';
import { refusal, refusalCodes } from '../../src/http/wallet.ts';
import { SERVICE_MESSAGE } from '../fixtures/vault-refusal-codes.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

function custody(): Any {
  const sandbox: Any = {};
  sandbox.window = sandbox;
  createContext(sandbox);
  runInContext(readFileSync(new URL('../../ui/core/custody.js', import.meta.url), 'utf8'), sandbox, { filename: 'ui/core/custody.js' });
  return sandbox.PhosphorCustody;
}

const C = custody();
// Made fresh per run: no key-shaped literal sits in the tree.
const KEY = generatePrivateKey().slice(2);
const GROUPS = KEY.match(/.{4}/g) as string[];

test('a key reads back however a person copies it, and is what the backend reads', () => {
  const forms = [
    KEY,
    `0x${KEY}`,
    `0X${KEY.toUpperCase()}`,
    GROUPS.join(' '),
    GROUPS.join('-'),
    `${GROUPS.slice(0, 8).join(' ')}\n${GROUPS.slice(8).join(' ')}`,
    GROUPS.map((g, i) => `${i + 1}. ${g}`).join('\n'),
    GROUPS.map((g, i) => `${i + 1} ${g}`).join(' '),
    GROUPS.map((g, i) => `${i + 1}) ${g}`).join('  '),
    // Full-width digits and letters, as some keyboards type them.
    GROUPS.join(' ').replace(/[0-9a-f]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)),
  ];
  for (const form of forms) {
    const read = C.readKey(form);
    assert.equal(read.problem, null, `${JSON.stringify(form.slice(0, 12))}: ${read.problem}`);
    assert.equal(read.hex, KEY);
    assert.equal(keyProblem(`0x${read.hex}`), null, 'the window sent what the backend refuses');
    assert.equal(C.isKey(form), true);
  }
});

test('a character a key never uses is named by its group, and nothing typed is quoted back', () => {
  const o = GROUPS.map((g, i) => (i === 5 ? `${g.slice(0, 3)}o` : g)).join(' ');
  assert.equal(C.readKey(o).problem, 'Group 6 has a character a private key never uses. A key has only 0 to 9 and a to f.');
  const flat = KEY.slice(0, 41) + 'g' + KEY.slice(42);
  assert.equal(C.readKey(flat).problem, 'Group 11 has a character a private key never uses. A key has only 0 to 9 and a to f.');
  assert.equal(C.readKey('x' + KEY).problem, 'That has a character a private key never uses. A key has only 0 to 9 and a to f.');
  const numberedSlip = GROUPS.map((g, i) => `${i + 1}. ${i === 15 ? 'zz' + g.slice(2) : g}`).join('\n');
  assert.equal(C.readKey(numberedSlip).problem, 'Group 16 has a character a private key never uses. A key has only 0 to 9 and a to f.');
  for (const form of [o, flat, numberedSlip]) {
    const said = String(C.readKey(form).problem);
    for (const g of GROUPS) assert.ok(!said.includes(g), 'the line quotes the key');
  }
});

test('a key of the wrong length says how many characters it has', () => {
  assert.equal(C.readKey(KEY.slice(1)).problem, 'That is 63 characters. A private key is 64.');
  assert.equal(C.readKey(KEY + 'a').problem, 'That is 65 characters. A private key is 64.');
  assert.equal(C.readKey('a').problem, 'That is 1 character. A private key is 64.');
  // Fifteen numbered groups are not sixteen: the numbers are not taken for the sheet's.
  const fifteen = GROUPS.slice(0, 15).map((g, i) => `${i + 1}. ${g}`).join(' ');
  assert.notEqual(C.readKey(fifteen).problem, null);
});

test('recovery words are never read as a key, and a key always is', () => {
  assert.equal(C.isKey('abandon ability able about above absent absorb abstract absurd abuse access accident'), false);
  assert.equal(C.isKey('e2ao 9b17'), true);
});

test('a refusal is put on screen only as a sentence: never a code, a status, or an OS phrase', () => {
  for (const code of refusalCodes()) {
    const answer = refusal(code);
    assert.equal(C.sentence(answer, 'FALLBACK'), answer.error, `${code}: the backend's own sentence was dropped`);
  }
  for (const raw of [...SERVICE_MESSAGE.split('; '), 'interaction_required', 'keychain key -25300', 'the enclave answered the wrong thing', 'Error -25300.', '', undefined]) {
    assert.equal(C.sentence({ ok: false, error: raw, code: 'x' }, 'FALLBACK'), 'FALLBACK', String(raw));
  }
  assert.equal(C.sentence(null, 'FALLBACK'), 'FALLBACK');
  assert.equal(C.CANCELLED, 'Touch ID was cancelled. Nothing changed.');
  assert.equal(C.CANCELLED, refusal('user_cancel').error, 'the window and the backend say a cancel two ways');
});
