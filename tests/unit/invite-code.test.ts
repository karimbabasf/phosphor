// The invite code: entropy, key derivation, format, parser, link, and the matcher the log tail
// and the composer guard share. Spec: docs/superpowers/specs/2026-10-01-invite-codes-design.md,
// "The code". Throwaway secrets are repeated bytes; the vectors pin the code and the address only,
// never a derived key (a 64 hex run the secret sweep would rightly flag).

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CROCKFORD,
  INVITE_CODE_SOURCE,
  SECP256K1_N,
  codeAddress,
  containsInviteCode,
  deriveKey,
  formatCode,
  generateSecret,
  inviteCodePattern,
  inviteLink,
  keyInRange,
  parseCode,
} from '../../src/invite/code.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function filled(byte: number): Uint8Array {
  return new Uint8Array(16).fill(byte);
}

function sameSecret(code: string, secret: Uint8Array): void {
  const parsed = parseCode(code);
  assert.equal(parsed.ok, true, `${code} did not parse`);
  if (parsed.ok) assert.deepEqual([...parsed.secret], [...secret]);
}

// The 27 data characters of a formatted code, separators dropped.
function dataOf(code: string): string {
  return code.slice(4).replace(/-/g, '');
}

function withData(data: string): string {
  return `PHOS-${data.slice(0, 5)}-${data.slice(5, 10)}-${data.slice(10, 15)}-${data.slice(15, 20)}-${data.slice(20)}`;
}

test('known vectors: the code, the check symbol and the address of fixed secrets', () => {
  assert.equal(formatCode(filled(0x01)), 'PHOS-01040-G2081-040G2-08104-0G2081X');
  assert.equal(codeAddress(filled(0x01)), '0xbb90cf2a04bcdfe8c2893bd107bba26ef6553157');
  assert.equal(formatCode(filled(0x42)), 'PHOS-22891-44GJ2-89144-GJ289-144GJ2V');
  assert.equal(codeAddress(filled(0x42)), '0x16f79c2a1ce245904440c764347da46eb61c28fe');
  const ramp = Uint8Array.from({ length: 16 }, (_, i) => i);
  assert.equal(formatCode(ramp), 'PHOS-00041-06105-0R3GG-28A1C-60T3GF6');
  assert.equal(codeAddress(Uint8Array.from({ length: 16 }, (_, i) => i)), '0xf3b963805379ad52a1e6c15612b67f2887c7a24a');
  // The check symbol is the 128-bit value mod 37, worked out here without the module: X is 29.
  assert.equal(BigInt('0x' + '01'.repeat(16)) % 37n, 29n);
  assert.equal(CROCKFORD.indexOf('X'), 29);
  // The link carries the code after the #, which a browser never sends to a server.
  assert.equal(inviteLink('PHOS-01040-G2081-040G2-08104-0G2081X'), 'https://phosphor.money/invite#PHOS-01040-G2081-040G2-08104-0G2081X');
});

test('generate, format and parse round-trip, and the code is PHOS plus five groups', () => {
  for (let i = 0; i < 300; i += 1) {
    const secret = generateSecret();
    const code = formatCode(secret);
    assert.match(code, /^PHOS-[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}-[0-9A-HJKMNP-TV-Z]{7}$/);
    sameSecret(code, secret);
    assert.notEqual(deriveKey(secret), null);
  }
});

test('the parser accepts every form a person pastes, and strips the prefix before mapping', () => {
  const secret = filled(0x42);
  const code = formatCode(secret);
  const data = dataOf(code);
  sameSecret(code, secret);
  sameSecret(code.toLowerCase(), secret);
  sameSecret(`PHOS${data}`, secret);
  sameSecret(code.replace(/-/g, ' '), secret);
  sameSecret(`  ${code}\n`, secret);
  sameSecret(code.replace('PHOS', 'PH0S'), secret);
  sameSecret(code.replace('PHOS', 'ph0s'), secret);
  sameSecret(inviteLink(code), secret);
  sameSecret(inviteLink(code.toLowerCase()), secret);
  // Crockford's reading: O is 0 and I or L is 1, in the data, never in the prefix.
  const withZeros = filled(0x01);
  const zeros = formatCode(withZeros);
  sameSecret(`PHOS-${dataOf(zeros).replace(/0/g, 'O')}`, withZeros);
  sameSecret(`PHOS-${dataOf(zeros).replace(/1/g, 'l')}`, withZeros);
  sameSecret(`PHOS-${dataOf(zeros).replace(/1/g, 'I')}`, withZeros);
});

test('every single wrong character is caught before any network call', () => {
  for (const secret of [filled(0x01), filled(0x42), generateSecret(), generateSecret()]) {
    const data = dataOf(formatCode(secret));
    for (let i = 0; i < data.length; i += 1) {
      for (const ch of CROCKFORD) {
        if (ch === data[i]) continue;
        const wrong = data.slice(0, i) + ch + data.slice(i + 1);
        assert.equal(parseCode(withData(wrong)).ok, false, `position ${i} as ${ch} slipped through`);
      }
    }
  }
});

test('every swap of two neighbours is caught, the check symbol included', () => {
  for (let n = 0; n < 40; n += 1) {
    const data = dataOf(formatCode(generateSecret()));
    for (let i = 0; i + 1 < data.length; i += 1) {
      if (data[i] === data[i + 1]) continue;
      const swapped = data.slice(0, i) + data[i + 1] + data[i] + data.slice(i + 2);
      assert.equal(parseCode(withData(swapped)).ok, false, `swap at ${i} slipped through`);
    }
  }
});

test('the two spare bits must be zero, even under a check symbol that agrees', () => {
  // 130 bits with the top two set: a value no secret has. Its own mod 37 symbol makes the check
  // pass, so only the spare-bit rule can refuse it.
  const valueOf = (data: string): bigint => {
    let value = 0n;
    for (const ch of data) value = (value << 5n) | BigInt(CROCKFORD.indexOf(ch));
    return value;
  };
  let tested = 0;
  for (const first of CROCKFORD.slice(8)) {
    for (const last of CROCKFORD) {
      const data26 = first + '0'.repeat(24) + last;
      const value = valueOf(data26);
      assert.ok(value >> 128n !== 0n);
      const symbol = Number(value % 37n);
      if (symbol >= 32) continue;
      assert.equal(parseCode(withData(data26 + CROCKFORD[symbol])).ok, false, `${data26} passed with its spare bits set`);
      tested += 1;
    }
  }
  assert.ok(tested > 500, `only ${tested} spare-bit values were tried`);
  // The same shape one bit lower is a real secret and parses.
  let parsed = 0;
  for (const last of CROCKFORD) {
    const ok26 = '7' + 'Z'.repeat(24) + last;
    const okSymbol = Number(valueOf(ok26) % 37n);
    if (okSymbol >= 32) continue;
    assert.equal(parseCode(withData(ok26 + CROCKFORD[okSymbol])).ok, true, `${ok26} is a real secret and did not parse`);
    parsed += 1;
  }
  assert.ok(parsed > 20);
});

test('only ASCII reads as a code character: no Unicode spelling slips past the matcher', () => {
  // Sixteen 0x14 bytes: a code with a 1 in its data and S as its check symbol.
  const code = formatCode(filled(0x14));
  assert.equal(code, 'PHOS-0M2GA-1850M-2GA18-50M2G-A1850MS');
  sameSecret(code, filled(0x14));
  const one = code.indexOf('1', 5);
  const last = code.length - 1;
  for (const variant of [
    code.slice(0, one) + '\u0131' + code.slice(one + 1), // dotless i, which upper-cases to I
    code.slice(0, last) + '\u017f', // long s, which upper-cases to S
    code.slice(0, last) + '\ufb06', // the st ligature, which upper-cases to ST
    code.slice(0, 5) + '\uff10' + code.slice(6), // a full-width zero
  ]) {
    assert.equal(parseCode(variant).ok, false, `a Unicode spelling parsed: ${JSON.stringify(variant)}`);
    assert.equal(containsInviteCode(variant), false);
  }
  // A no-break space between groups is a space to both the parser and the matcher.
  const nbsp = code.replace(/-/g, '\u00a0');
  sameSecret(nbsp, filled(0x14));
  assert.equal(containsInviteCode(`code: ${nbsp}`), true);
});

test('anything else is refused, and the answer never says why', () => {
  const code = formatCode(filled(0x42));
  for (const bad of [
    undefined,
    null,
    42,
    '',
    'PHOS',
    dataOf(code), // no prefix
    code.replace('PHOS', 'PHO5'),
    code.replace('PHOS', 'PH-OS'),
    code.slice(0, -1), // short
    `${code}0`, // long
    code.slice(0, -1) + 'U', // U is never a code character
    code.slice(0, -1) + '*', // a symbol check character is never issued
    'x'.repeat(600),
  ]) {
    const parsed = parseCode(bad);
    assert.equal(parsed.ok, false, `${String(bad)} parsed`);
    assert.deepEqual(Object.keys(parsed), ['ok'], 'a refusal carries nothing but ok');
  }
});

test('0 < k < n is the rule, and the generator redraws a symbol check character', () => {
  // The published order, in two halves so this file carries no 64 hex run for the sweep.
  assert.equal(SECP256K1_N.toString(16), 'fffffffffffffffffffffffffffffffe' + 'baaedce6af48a03bbfd25e8cd0364141');
  assert.equal(keyInRange(0n), false);
  assert.equal(keyInRange(SECP256K1_N), false);
  assert.equal(keyInRange(SECP256K1_N + 1n), false);
  assert.equal(keyInRange(1n), true);
  assert.equal(keyInRange(SECP256K1_N - 1n), true);
  // Sixteen 0x05 bytes have a check index of 34, the `$` symbol: never issued.
  assert.equal(BigInt('0x' + '05'.repeat(16)) % 37n, 34n);
  const draws = [filled(0x05), filled(0x42)];
  const drawn: number[] = [];
  const secret = generateSecret((n) => {
    drawn.push(n);
    return Uint8Array.from(draws.shift()!);
  });
  assert.deepEqual(drawn, [16, 16], 'the symbol draw was thrown away and a second taken');
  assert.deepEqual([...secret], [...filled(0x42)]);
  for (let i = 0; i < 2000; i += 1) assert.match(formatCode(generateSecret()), /[0-9A-HJKMNP-TV-Z]$/);
});

test('the generator takes the OS CSPRNG and never Math.random', () => {
  const original = Math.random;
  Math.random = () => {
    throw new Error('Math.random was called');
  };
  try {
    for (let i = 0; i < 50; i += 1) generateSecret();
  } finally {
    Math.random = original;
  }
  for (const file of fs.readdirSync(path.join(ROOT, 'src', 'invite'))) {
    const source = fs.readFileSync(path.join(ROOT, 'src', 'invite', file), 'utf8');
    assert.ok(!/Math\.random\s*\(/.test(source), `${file} calls Math.random`);
  }
  // 128 bits: two draws never agree.
  assert.notDeepEqual([...generateSecret()], [...generateSecret()]);
  const source = fs.readFileSync(path.join(ROOT, 'src', 'invite', 'code.ts'), 'utf8');
  assert.match(source, /crypto\.randomBytes\(n\)/);
  assert.equal(crypto.randomBytes(16).length, 16);
});

test('the matcher finds a code in every form the parser accepts, inside any text', () => {
  const code = formatCode(filled(0x42));
  const forms = [
    code,
    code.toLowerCase(),
    `PHOS${dataOf(code)}`,
    code.replace(/-/g, ' '),
    code.replace('PHOS', 'PH0S'),
    inviteLink(code),
    `PHOS ${dataOf(code)}`,
  ];
  for (const form of forms) {
    for (const text of [form, `here is my code: ${form}, thanks`, `"${form}"`, `${form}.`]) {
      assert.equal(containsInviteCode(text), true, `missed ${text}`);
      const redacted = text.replace(inviteCodePattern(), '[x]');
      assert.equal(parseCode(redacted).ok, false, `a parseable code survived in ${redacted}`);
      for (const group of dataOf(code).match(/.{5}/g)!) assert.ok(!redacted.toUpperCase().includes(group), `${group} survived in ${redacted}`);
    }
  }
});

test('the matcher leaves prose alone, the app name included', () => {
  for (const prose of [
    'how does phosphor handle swaps between eth and near',
    'Phosphor wallet locked after fifteen minutes with nobody at the window',
    'phosphor up on http://127.0.0.1:4177 (live mode)',
    'see https://phosphor.money/invite for how invites work',
    'phosphate levels in the ocean are rising every single year',
    'phosphorus is a chemical element with the symbol P and number 15',
    'intent AdQAELwW1dnkyVePUZzWAugtLF3yLLumTKWrDVz9NifQ settled',
  ]) {
    assert.equal(containsInviteCode(prose), false, `took prose for a code: ${prose}`);
  }
  // One source of truth for the shape: what CONTRACTS.md quotes and the composer mirrors.
  assert.equal(inviteCodePattern().source, INVITE_CODE_SOURCE);
  assert.equal(inviteCodePattern().flags, 'gi');
});
