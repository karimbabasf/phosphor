// Every accept and every refusal of the vault's intent grammar (src-tauri/se-helper/IntentGrammar.swift):
// each case names the sentence the Touch ID dialog shows, byte for byte, or the rule the payload
// breaks. tests/unit/intent-grammar.test.ts runs them through the grammar's driver, and the accepted
// ones seed its mutated payloads. The accounts and keys are patterns, nobody's.

import { base58Encode } from '../../../src/chain/near.ts';
import { NONCE_LIFE_AFTER_DEADLINE_MS } from '../../../src/rails/intents-relay.ts';
import { buildNonce } from '../../../src/relay/payload.ts';

export const NOW_MS = Date.UTC(2026, 9, 4, 18, 30, 0, 0);
const DEADLINE_MS = NOW_MS + 60_000;
const LIFE_NS = BigInt(NONCE_LIFE_AFTER_DEADLINE_MS) * 1_000_000n;
const SALT = Uint8Array.from([0x25, 0x28, 0x12, 0xb3]); // the verifier's salt when spike2 ran
const RANDOM = new Uint8Array(15).fill(0x6b);

export const VAULT = `0x${'a1'.repeat(20)}`;
export const ALLOWANCE = `0x${'b2'.repeat(20)}`;
const STRANGER = `0x${'c3'.repeat(20)}`;
// The signing chip key's x || y. The grammar only compares it with the keys a payload removes.
export const CHIP = Buffer.alloc(64, 0x2c);
export const RECOVERY = `secp256k1:${base58Encode(Buffer.alloc(64, 0x5e))}`;
export const PINS = { account: VAULT, allowance: ALLOWANCE, recovery: RECOVERY };

const CHIP_KEY = `p256:${base58Encode(CHIP)}`;
const SECP = `secp256k1:${base58Encode(Buffer.alloc(64, 0x17))}`; // said secp256k1:TmysAU1B...H7MkuLjQ
const P256 = `p256:${base58Encode(Buffer.alloc(64, 0x33))}`; // said p256:22NZnfeB...K51dpyMt
const ED = `ed25519:${base58Encode(Buffer.alloc(32, 0x44))}`; // said ed25519:5bV6jUfh...xr3joew5

export const USDC = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const USDC_ETH = 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near';
const USDT = 'nep141:usdt.tether-token.near';
const WNEAR = 'nep141:wrap.near';
const ETH = 'nep141:eth.omft.near';
const SOL = 'nep141:sol.omft.near';
const DAI = 'nep141:eth-0x6b175474e89094c44da98b954eedeac495271d0f.omft.near';
const USDS = 'nep141:eth-0xdc035d45d973e3ec169d2276ddab16f1e407384f.omft.near'; // in the registry with no pinned id
export const U128_MAX = '340282366920938463463374607431768211455';
const SEND_TO = '0x12ab5678deadbeefdeadbeefdeadbeef90abcd34';
const LONG_NAME = `${'a'.repeat(59)}.near`;

export type Pins = typeof PINS;
export type Case = { name: string; payload: string; nowMs?: number; pins?: Pins; chip?: Buffer } & (
  | { sentence: string }
  | { rule: string; says?: string }
);

const iso = (ms: number): string => new Date(ms).toISOString();

/* The nonce Phosphor builds for a payload with this deadline: it expires exactly
   NONCE_LIFE_AFTER_DEADLINE_MS (seven days) later, the only expiry the grammar takes. */
export function nonceAt(deadlineMs: number): string {
  return buildNonce({ salt: SALT, deadlineMs: deadlineMs + NONCE_LIFE_AFTER_DEADLINE_MS, random: RANDOM });
}

/* A nonce that expires at `expiryMs` itself, whatever the payload's deadline. */
function nonceExpiring(expiryMs: number): string {
  return buildNonce({ salt: SALT, deadlineMs: expiryMs, random: RANDOM });
}

/* A nonce of any bytes: the head, the deadline in nanoseconds and the length are the caller's. */
function nonceBytes(ns: bigint, head: number[] = [0x56, 0x28, 0xf6, 0xc6, 0x00], length = 32): string {
  const out = Buffer.alloc(32);
  out.set(head, 0);
  out.set(SALT, 5);
  out.writeBigInt64LE(ns, 9);
  out.set(RANDOM, 17);
  return out.subarray(0, length).toString('base64');
}

type Fields = Record<string, unknown>;

/* The payload as JSON.stringify writes it, in the order the builder uses. A field set to undefined
   is left out. */
export function payload(over: Fields = {}): string {
  return JSON.stringify({ signer_id: VAULT, verifying_contract: 'intents.near', deadline: iso(DEADLINE_MS), nonce: nonceAt(DEADLINE_MS), intents: [], ...over });
}

const move = (asset: string, amount: unknown, receiver: unknown = ALLOWANCE) => ({ intent: 'transfer', receiver_id: receiver, tokens: { [asset]: amount } });
const remove = (key: unknown) => ({ intent: 'remove_public_key', public_key: key });
const with1 = (...intents: unknown[]) => payload({ intents });
const topUp = with1(move(USDC, '100000000'));

/* The canonical nonce with only its unused low bits changed: the same 32 bytes to a lenient
   decoder, and not the spelling base64 gives them. */
function sloppyNonce(): string {
  const good = nonceAt(DEADLINE_MS);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const last = alphabet.indexOf(good[42]);
  return good.slice(0, 42) + alphabet[last ^ 1] + good.slice(43);
}

export const ACCEPTED: Case[] = [
  { name: 'the rekey proof carries no intents', payload: payload(), sentence: "confirm this Mac's Touch ID key for your vault" },
  { name: 'a top-up moves 100 USDC to the allowance', payload: topUp, sentence: 'move 100.00 USDC from your vault to your allowance' },
  { name: 'a send names its receiver by both ends', payload: with1(move(USDC, '2500000', SEND_TO)), sentence: 'send 2.50 USDC from your vault to 0x12ab5678...90abcd34' },
  { name: 'retiring the pinned paper key names it in words', payload: with1(remove(RECOVERY)), sentence: 'remove your paper recovery key from your vault' },
  { name: 'another secp256k1 key is said by both ends', payload: with1(remove(SECP)), sentence: 'remove key secp256k1:TmysAU1B...H7MkuLjQ from your vault' },
  { name: 'a p256 key that is not the signing chip can go', payload: with1(remove(P256)), sentence: 'remove key p256:22NZnfeB...K51dpyMt from your vault' },
  { name: 'an ed25519 key can go', payload: with1(remove(ED)), sentence: 'remove key ed25519:5bV6jUfh...xr3joew5 from your vault' },
  { name: 'two removals in one touch', payload: with1(remove(RECOVERY), remove(SECP)), sentence: 'remove your paper recovery key and key secp256k1:TmysAU1B...H7MkuLjQ from your vault' },
  { name: 'one base unit of USDC is said exactly', payload: with1(move(USDC, '1')), sentence: 'move 0.000001 USDC from your vault to your allowance' },
  { name: 'one yoctoNEAR is said exactly', payload: with1(move(WNEAR, '1')), sentence: 'move 0.000000000000000000000001 wNEAR from your vault to your allowance' },
  { name: 'thousands are grouped and trailing zeros trimmed', payload: with1(move(USDC, '1234567891000')), sentence: 'move 1,234,567.891 USDC from your vault to your allowance' },
  { name: 'the u128 maximum is an amount', payload: with1(move(USDC, U128_MAX)), sentence: 'move 340,282,366,920,938,463,463,374,607,431,768.211455 USDC from your vault to your allowance' },
  {
    name: 'four tokens in one top-up',
    payload: with1(move(USDC, '1000000'), move(USDT, '2000000'), move(WNEAR, '3000000000000000000000000'), move(ETH, '4000000000000000000')),
    sentence: 'move 1.00 USDC, 2.00 USDT, 3.00 wNEAR and 4.00 ETH from your vault to your allowance',
  },
  { name: 'SOL and DAI place the point by their own decimals', payload: with1(move(SOL, '1500000000'), move(DAI, '250000000000000000')), sentence: 'move 1.50 SOL and 0.25 DAI from your vault to your allowance' },
  { name: 'a 64-hex implicit receiver is said by both ends', payload: with1(move(USDC, '1000000', 'ab'.repeat(32))), sentence: 'send 1.00 USDC from your vault to abababab...abababab' },
  { name: 'a NEAR name is said whole', payload: with1(move(USDC, '1000000', 'alice.near')), sentence: 'send 1.00 USDC from your vault to alice.near' },
  { name: 'a NEAR name is said whole at 64 characters', payload: with1(move(USDC, '1000000', LONG_NAME)), sentence: `send 1.00 USDC from your vault to ${LONG_NAME}` },
  {
    name: 'a deadline exactly 120 seconds out is inside the window',
    payload: payload({ deadline: iso(NOW_MS + 120_000), nonce: nonceAt(NOW_MS + 120_000) }),
    sentence: "confirm this Mac's Touch ID key for your vault",
  },
  { name: 'a deadline one millisecond out is inside the window', payload: payload({ deadline: iso(NOW_MS + 1), nonce: nonceAt(NOW_MS + 1) }), sentence: "confirm this Mac's Touch ID key for your vault" },
  {
    name: 'a deadline with no fraction',
    payload: payload({ deadline: '2026-10-04T18:31:00Z', nonce: nonceAt(Date.UTC(2026, 9, 4, 18, 31, 0)) }),
    sentence: "confirm this Mac's Touch ID key for your vault",
  },
  {
    name: 'a deadline with nine fraction digits, to the nanosecond in the nonce',
    payload: payload({ deadline: '2026-10-04T18:30:59.123456789Z', nonce: nonceBytes(BigInt(Date.UTC(2026, 9, 4, 18, 30, 59)) * 1_000_000n + 123_456_789n + LIFE_NS) }),
    sentence: "confirm this Mac's Touch ID key for your vault",
  },
  {
    name: 'a nonce that expires exactly seven days after the deadline',
    payload: payload({ nonce: nonceExpiring(DEADLINE_MS + 7 * 24 * 60 * 60 * 1000) }),
    sentence: "confirm this Mac's Touch ID key for your vault",
  },
  {
    name: 'whitespace between tokens reads the same',
    payload: JSON.stringify(JSON.parse(topUp), null, 2),
    sentence: 'move 100.00 USDC from your vault to your allowance',
  },
  {
    name: 'keys in another order read the same',
    payload: JSON.stringify((({ signer_id, verifying_contract, deadline, nonce, intents }) => ({ intents, nonce, deadline, verifying_contract, signer_id }))(JSON.parse(topUp))),
    sentence: 'move 100.00 USDC from your vault to your allowance',
  },
  { name: 'a signer the pins do not name is said by both ends', payload: payload({ signer_id: STRANGER }), sentence: "confirm this Mac's Touch ID key for 0xc3c3c3c3...c3c3c3c3" },
  { name: 'a move into the pinned vault is a move', payload: payload({ signer_id: STRANGER, intents: [move(USDC, '1000000', VAULT)] }), sentence: 'move 1.00 USDC from 0xc3c3c3c3...c3c3c3c3 to your vault' },
];

const refuse = (name: string, raw: string, rule: string, says?: string): Case => ({ name, payload: raw, rule, ...(says === undefined ? {} : { says }) });

export const REFUSED: Case[] = [
  refuse('over 4096 bytes, even as valid JSON', payload() + ' '.repeat(4096), 'size'),
  refuse('a Cyrillic letter in signer_id', payload({ signer_id: 'vаult.near' }), 'ascii'),
  refuse('a byte order mark first', `﻿${payload()}`, 'ascii'),
  refuse('a NUL inside a key', payload().replace('"intents"', '"intents\u0000"'), 'ascii'),
  refuse('a DEL inside a string', payload().replace('intents.near', 'intents\u007f.near'), 'ascii'),
  refuse('a payload that never closes', payload().slice(0, -1), 'json'),
  refuse('a trailing comma', payload().replace('"intents":[]', '"intents":[],'), 'json'),
  refuse('something after the payload', `${payload()}{}`, 'json'),
  refuse('single quotes', payload().replaceAll('"', "'"), 'json'),
  refuse('a comment first', `/* a */${payload()}`, 'json'),
  refuse('a raw tab inside a string', payload().replace('intents.near', 'intents\t.near'), 'json'),
  refuse('a value that is not JSON', payload().replace('"intents":[]', '"intents":NaN'), 'json'),
  refuse('an escape in a value', payload().replace('intents.near', 'intents\\u002enear'), 'escape'),
  refuse('an escape that spells a second signer_id', payload().replace('"verifying_contract"', '"signer\\u005fid":"evil.near","verifying_contract"'), 'escape'),
  refuse('nesting deeper than six', payload({ intents: [[[[[[]]]]]] }), 'depth'),
  refuse('signer_id twice, the stranger first', payload().replace('{', '{"signer_id":"evil.near",'), 'duplicate_key', 'signer_id'),
  refuse('signer_id twice, the vault first', payload().replace('"verifying_contract"', '"signer_id":"evil.near","verifying_contract"'), 'duplicate_key', 'signer_id'),
  refuse('intent twice: a transfer that also says set_auth_by_predecessor_id', topUp.replace('"intent":"transfer",', '"intent":"transfer","intent":"set_auth_by_predecessor_id",'), 'duplicate_key', 'intent'),
  refuse('one asset twice inside tokens', topUp.replace(`"${USDC}":"100000000"`, `"${USDC}":"100000000","${USDC}":"999000000000"`), 'duplicate_key'),
  refuse('no nonce', payload({ nonce: undefined }), 'payload_keys', 'lacks nonce'),
  refuse('an extra key', payload({ standard: 'webauthn' }), 'payload_keys', 'carries standard'),
  refuse('a list at the top', `[${payload()}]`, 'payload_keys'),
  refuse('capitals in signer_id', payload({ signer_id: VAULT.toUpperCase().replace('0X', '0x') }), 'signer_id'),
  refuse('a 65-character signer_id', payload({ signer_id: `${'a'.repeat(60)}.near` }), 'signer_id'),
  refuse('two separators in a row', payload({ signer_id: 'vault..near' }), 'signer_id'),
  refuse('a number for signer_id', payload({ signer_id: 5 }), 'signer_id'),
  refuse('another verifying contract', payload({ verifying_contract: 'evil.near' }), 'verifying_contract'),
  refuse('a capital in the verifying contract', payload({ verifying_contract: 'Intents.near' }), 'verifying_contract'),
  refuse('a deadline equal to now', payload({ deadline: iso(NOW_MS), nonce: nonceAt(NOW_MS) }), 'deadline'),
  refuse('a deadline in the past', payload({ deadline: iso(NOW_MS - 1000), nonce: nonceAt(NOW_MS - 1000) }), 'deadline'),
  refuse('a deadline one millisecond past the window', payload({ deadline: iso(NOW_MS + 120_001), nonce: nonceAt(NOW_MS + 120_001) }), 'deadline'),
  refuse('an offset instead of Z', payload({ deadline: '2026-10-04T18:31:00.000+00:00' }), 'deadline'),
  refuse('a lowercase z', payload({ deadline: iso(DEADLINE_MS).replace('Z', 'z') }), 'deadline'),
  refuse('a 30th of February', payload({ deadline: '2026-02-30T18:31:00.000Z' }), 'deadline'),
  refuse('ten fraction digits', payload({ deadline: '2026-10-04T18:30:59.1234567891Z' }), 'deadline'),
  refuse('a number for the deadline', payload({ deadline: DEADLINE_MS }), 'deadline'),
  refuse('a legacy random nonce', payload({ nonce: Buffer.alloc(32, 0x6b).toString('base64') }), 'nonce', 'V1'),
  refuse('a nonce of 31 bytes', payload({ nonce: nonceBytes(BigInt(DEADLINE_MS) * 1_000_000n + LIFE_NS, undefined, 31) }), 'nonce'),
  refuse('a nonce base64 does not write that way', payload({ nonce: sloppyNonce() }), 'nonce'),
  refuse('a nonce that expires a millisecond past seven days', payload({ nonce: nonceAt(DEADLINE_MS + 1) }), 'nonce', 'seven days'),
  refuse('a nonce that expires a millisecond short of seven days', payload({ nonce: nonceAt(DEADLINE_MS - 1) }), 'nonce', 'seven days'),
  refuse('a nonce that expires a nanosecond past seven days', payload({ nonce: nonceBytes(BigInt(DEADLINE_MS) * 1_000_000n + LIFE_NS + 1n) }), 'nonce', 'seven days'),
  refuse('a nonce that expires with the payload, as spike2 signed them', payload({ nonce: nonceExpiring(DEADLINE_MS) }), 'nonce', 'seven days'),
  refuse('a nonce that expires a day after the payload', payload({ nonce: nonceExpiring(DEADLINE_MS + 24 * 60 * 60 * 1000) }), 'nonce', 'seven days'),
  refuse('a nonce that expires a year after the payload', payload({ nonce: nonceExpiring(DEADLINE_MS + 365 * 24 * 60 * 60 * 1000) }), 'nonce', 'seven days'),
  refuse('a nonce that expires before the payload', payload({ nonce: nonceExpiring(DEADLINE_MS - 1) }), 'nonce', 'seven days'),
  refuse('a nonce that expires before 1970', payload({ nonce: nonceBytes(-1n) }), 'nonce', 'seven days'),
  refuse('a nonce of version 1', payload({ nonce: nonceBytes(BigInt(DEADLINE_MS) * 1_000_000n + LIFE_NS, [0x56, 0x28, 0xf6, 0xc6, 0x01]) }), 'nonce', 'V1'),
  refuse('a nonce that is not base64', payload({ nonce: '!!!!' }), 'nonce'),
  refuse('a number for the nonce', payload({ nonce: 5 }), 'nonce'),
  refuse('five intents', with1(...['1', '2', '3', '4', '5'].map((a) => move(USDC, a))), 'intents'),
  refuse('intents as an object', payload({ intents: {} }), 'intents'),
  refuse('an intent that is a string', payload({ intents: ['transfer'] }), 'intent'),
  refuse('an intent with no kind', payload({ intents: [{ receiver_id: ALLOWANCE, tokens: { [USDC]: '1' } }] }), 'intent'),
  refuse('a kind that is not a string', payload({ intents: [{ intent: 5 }] }), 'intent'),
  refuse('add_public_key', with1({ intent: 'add_public_key', public_key: P256 }), 'refused_kind', 'add_public_key'),
  refuse('set_auth_by_predecessor_id turning it off', with1({ intent: 'set_auth_by_predecessor_id', enabled: false }), 'refused_kind', 'set_auth_by_predecessor_id'),
  refuse('set_auth_by_predecessor_id turning it on', with1({ intent: 'set_auth_by_predecessor_id', enabled: true }), 'refused_kind', 'set_auth_by_predecessor_id'),
  refuse('auth_call', with1({ intent: 'auth_call', contract_id: 'evil.near', msg: '', attached_deposit: '0' }), 'refused_kind', 'auth_call'),
  refuse('token_diff', with1({ intent: 'token_diff', diff: { [USDC]: '-1000000', [WNEAR]: '1' } }), 'refused_kind', 'token_diff'),
  refuse('ft_withdraw', with1({ intent: 'ft_withdraw', token: 'usdt.tether-token.near', receiver_id: 'evil.near', amount: '1' }), 'refused_kind', 'ft_withdraw'),
  refuse('native_withdraw', with1({ intent: 'native_withdraw', receiver_id: 'evil.near', amount: '1' }), 'refused_kind', 'native_withdraw'),
  refuse('mt_withdraw', with1({ intent: 'mt_withdraw', token: 'mt.near', receiver_id: 'evil.near', token_ids: ['1'], amounts: ['1'] }), 'refused_kind', 'mt_withdraw'),
  refuse('nft_withdraw', with1({ intent: 'nft_withdraw', token: 'nft.near', receiver_id: 'evil.near', token_id: '1' }), 'refused_kind', 'nft_withdraw'),
  refuse('storage_deposit', with1({ intent: 'storage_deposit', contract_id: 'usdt.tether-token.near', deposit_for_account_id: 'evil.near', amount: '1' }), 'refused_kind', 'storage_deposit'),
  refuse('imt_mint', with1({ intent: 'imt_mint', receiver_id: 'evil.near', tokens: { '1': '1' }, memo: '' }), 'refused_kind', 'imt_mint'),
  refuse('imt_burn', with1({ intent: 'imt_burn', minter_id: 'evil.near', tokens: { '1': '1' } }), 'refused_kind', 'imt_burn'),
  refuse('add_public_key behind a valid transfer', with1(move(USDC, '1'), { intent: 'add_public_key', public_key: P256 }), 'refused_kind', 'add_public_key'),
  refuse('set_auth_by_predecessor_id behind a valid transfer', with1(move(USDC, '1'), { intent: 'set_auth_by_predecessor_id', enabled: true }), 'refused_kind', 'set_auth_by_predecessor_id'),
  refuse('a kind the verifier does not have', with1({ intent: 'phosphor_probe' }), 'unknown_kind'),
  refuse('Transfer with a capital', with1({ ...move(USDC, '1'), intent: 'Transfer' }), 'unknown_kind'),
  refuse('transfer with a trailing space', with1({ ...move(USDC, '1'), intent: 'transfer ' }), 'unknown_kind'),
  refuse('a transfer and a removal together', with1(move(USDC, '1'), remove(SECP)), 'one_kind'),
  refuse('a transfer with a memo', with1({ ...move(USDC, '1'), memo: 'hi' }), 'transfer_keys', 'memo'),
  refuse('a transfer with a msg', with1({ ...move(USDC, '1'), msg: '{}' }), 'transfer_keys', 'msg'),
  refuse('a transfer with min_gas', with1({ ...move(USDC, '1'), min_gas: 30000000000000 }), 'transfer_keys', 'min_gas'),
  refuse('a transfer with a notification', with1({ ...move(USDC, '1'), notification: { msg: '' } }), 'transfer_keys', 'notification'),
  refuse('a transfer with no tokens', with1({ intent: 'transfer', receiver_id: ALLOWANCE }), 'transfer_keys', 'lacks tokens'),
  refuse('capitals in receiver_id', with1(move(USDC, '1', ALLOWANCE.toUpperCase())), 'receiver'),
  refuse('a receiver_id that ends in a dot', with1(move(USDC, '1', 'alice.')), 'receiver'),
  refuse('a transfer to its own signer', with1(move(USDC, '1', VAULT)), 'receiver'),
  refuse('a number for receiver_id', with1(move(USDC, '1', 5)), 'receiver'),
  refuse('two receivers', with1(move(USDC, '1'), move(USDT, '1', 'alice.near')), 'one_receiver'),
  refuse('no asset in tokens', with1({ intent: 'transfer', receiver_id: ALLOWANCE, tokens: {} }), 'tokens'),
  refuse('two assets in one transfer', with1({ intent: 'transfer', receiver_id: ALLOWANCE, tokens: { [USDC]: '1', [USDT]: '1' } }), 'tokens'),
  refuse('tokens as a string', with1({ intent: 'transfer', receiver_id: ALLOWANCE, tokens: USDC }), 'tokens'),
  refuse('an asset outside the table', with1(move('nep141:evil.near', '1')), 'token'),
  refuse('a capital in the asset id', with1(move('NEP141:wrap.near', '1')), 'token'),
  refuse('a nep245 asset', with1(move('nep245:mt.near:1', '1')), 'token'),
  refuse('a registry coin with no pinned id', with1(move(USDS, '1')), 'token'),
  refuse('native NEAR by name', with1(move('near', '1')), 'token'),
  refuse('an amount of zero', with1(move(USDC, '0')), 'amount'),
  refuse('a leading zero', with1(move(USDC, '007')), 'amount'),
  refuse('a plus sign', with1(move(USDC, '+5')), 'amount'),
  refuse('a minus sign', with1(move(USDC, '-5')), 'amount'),
  refuse('a decimal point', with1(move(USDC, '1.5')), 'amount'),
  refuse('an exponent', with1(move(USDC, '1e6')), 'amount'),
  refuse('a space before the digits', with1(move(USDC, ' 5')), 'amount'),
  refuse('an empty amount', with1(move(USDC, '')), 'amount'),
  refuse('one over the u128 maximum', with1(move(USDC, '340282366920938463463374607431768211456')), 'amount'),
  refuse('forty digits', with1(move(USDC, `1${'0'.repeat(39)}`)), 'amount'),
  refuse('a number for the amount', with1(move(USDC, 5)), 'amount'),
  refuse('one asset in two transfers', with1(move(USDC, '1'), move(USDC, '2')), 'token_repeat'),
  refuse('USDC on NEAR and USDC on Ethereum in one payload', with1(move(USDC, '1'), move(USDC_ETH, '1')), 'token_repeat', 'USDC'),
  refuse('a removal with a memo', with1({ ...remove(SECP), memo: 'x' }), 'remove_keys', 'memo'),
  refuse('a removal with no key', with1({ intent: 'remove_public_key' }), 'remove_keys', 'lacks public_key'),
  refuse('a key with no curve', with1(remove(SECP.slice('secp256k1:'.length))), 'public_key'),
  refuse('a capital curve', with1(remove(P256.replace('p256', 'P256'))), 'public_key'),
  refuse('a secp256k1 key of 63 bytes', with1(remove(`secp256k1:${base58Encode(Buffer.alloc(63, 0x17))}`)), 'public_key'),
  refuse('a 0 in the base58', with1(remove(`${SECP.slice(0, -1)}0`)), 'public_key'),
  refuse('a leading 1 that adds a zero byte', with1(remove(SECP.replace('secp256k1:', 'secp256k1:1'))), 'public_key'),
  refuse('an ed25519 key 64 bytes long', with1(remove(`ed25519:${base58Encode(Buffer.alloc(64, 0x44))}`)), 'public_key'),
  refuse('a curve with nothing after it', with1(remove('p256:')), 'public_key'),
  refuse('a number for the key', with1(remove(5)), 'public_key'),
  refuse('the signing chip key removing itself', with1(remove(CHIP_KEY)), 'signing_key'),
  refuse('one key removed twice', with1(remove(SECP), remove(SECP)), 'key_repeat'),
  refuse('a sentence over 120 characters', with1(move(USDC, U128_MAX, LONG_NAME)), 'sentence'),
];

export const CASES: Case[] = [...ACCEPTED, ...REFUSED];

/* The rules IntentGrammar.swift's header lists, so the corpus can show it holds a case for each. */
export const RULES = [
  'size', 'ascii', 'json', 'escape', 'depth', 'duplicate_key', 'payload_keys', 'signer_id', 'verifying_contract', 'deadline', 'nonce',
  'intents', 'intent', 'refused_kind', 'unknown_kind', 'one_kind', 'transfer_keys', 'receiver', 'one_receiver', 'tokens', 'token', 'amount',
  'token_repeat', 'remove_keys', 'public_key', 'signing_key', 'key_repeat', 'sentence',
];
