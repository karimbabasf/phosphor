// What a refused Touch ID request says, end to end. Every code the vault service and the two relays
// can answer (read off their sources, tests/fixtures/vault-refusal-codes.ts) has one sentence, in
// one place (src/http/wallet.ts REFUSALS), in the words a person knows; the service's own message
// never becomes that sentence, whatever the code. The windows that show a refusal are held to the
// same thing on their side in tests/unit/refusal-window.test.ts.

import test from 'node:test';
import assert from 'node:assert/strict';

import { knownRefusal, refusal, refusalCodes } from '../../src/http/wallet.ts';
import { enclaveRefusal } from '../../src/http/custody.ts';
import { RAW, SERVICE_MESSAGE, VAULT_REFUSAL_CODES } from '../fixtures/vault-refusal-codes.ts';

const calm = (said: string): boolean => /^[A-Z]/.test(said) && /\.$/.test(said) && !RAW.test(said);

test('the sources still answer the codes this file was written against, so a new one cannot slip by unread', () => {
  for (const code of ['auth_failed', 'blob_refused', 'crypto_failed', 'foreign_key', 'interaction_required', 'keychain_unavailable', 'not_committed', 'pin_mismatch', 'se_unavailable', 'user_cancel', 'helper_unreachable', 'timeout', 'garbled']) {
    assert.ok(VAULT_REFUSAL_CODES.includes(code), `${code} is no longer read off the sources`);
  }
});

test('every code the service or a relay can answer has a sentence of its own, said in plain words', () => {
  for (const code of VAULT_REFUSAL_CODES) {
    assert.ok(knownRefusal(code), `${code} has no sentence in REFUSALS`);
    const said = String(refusal(code).error);
    assert.ok(calm(said), `${code}: ${said}`);
  }
});

test('every sentence the custody routes can say is a calm one, with none of the parts underneath', () => {
  for (const code of refusalCodes()) {
    const said = String(refusal(code).error);
    assert.ok(calm(said), `${code}: ${said}`);
    assert.ok(!/\b(bind|binding|bound)\b/i.test(said), `${code} names the bind: ${said}`);
  }
});

test('the service message never becomes the sentence, for a code with a sentence or one nobody named', () => {
  for (const code of [...VAULT_REFUSAL_CODES, 'a_code_from_a_newer_service', 'failed']) {
    const out = enclaveRefusal({ ok: false, error: code, message: SERVICE_MESSAGE });
    const said = String(out.error);
    assert.ok(calm(said), `${code}: ${said}`);
    for (const part of SERVICE_MESSAGE.split('; ')) assert.ok(!said.includes(part), `${code}: ${said}`);
  }
  const unknown = enclaveRefusal({ ok: false, error: 'a_code_from_a_newer_service', message: 'no user present' });
  assert.equal(unknown.code, 'a_code_from_a_newer_service', 'the code still travels beside the sentence, for a screen to branch on');
  assert.equal(unknown.error, 'That did not finish, so nothing changed. Try again.');
});

test('the review\'s three, and the cancel, read the way it asked', () => {
  assert.equal(refusal('interaction_required').error, 'Touch ID could not ask you just now, so nothing changed. Unlock your Mac and try again.');
  assert.equal(refusal('crypto_failed').error, 'Phosphor could not use its key on this Mac just now, so nothing changed. Try again.');
  assert.equal(refusal('user_cancel').error, 'Touch ID was cancelled. Nothing changed.');
  assert.equal(refusal('damaged').error, 'The wallet file on this Mac cannot be read, and nothing moved. Your backup brings the wallet back.');
  assert.equal(refusal('write_failed').error, 'Phosphor could not save the wallet file on this Mac, so nothing changed. Check that the Mac has free space, then try again.');
  assert.equal(refusal('install_pending').error, 'Your wallet is saved, and nothing moved. Phosphor finishes setting it up the next time you open it.');
});
