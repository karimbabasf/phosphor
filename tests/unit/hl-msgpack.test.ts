import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packb } from '../../src/hl/msgpack.ts';

// Every expectation here is a byte array worked out by hand from the msgpack spec, not a
// recording of what this encoder happens to produce. A test that captured its own output would
// pass forever while the venue rejected every order.
const hex = (v: unknown): string => Buffer.from(packb(v)).toString('hex');
const bytes = (...b: number[]): string => Buffer.from(b).toString('hex');

test('nil, true and false are one byte each', () => {
  assert.deepEqual(packb(null), new Uint8Array([0xc0]));
  assert.deepEqual(packb(true), new Uint8Array([0xc3]));
  assert.deepEqual(packb(false), new Uint8Array([0xc2]));
});

test('positive integers take the narrowest form at every boundary', () => {
  assert.deepEqual(packb(0), new Uint8Array([0x00]));
  assert.deepEqual(packb(1), new Uint8Array([0x01]));
  assert.deepEqual(packb(127), new Uint8Array([0x7f])); // last positive fixint
  assert.deepEqual(packb(128), new Uint8Array([0xcc, 0x80])); // first uint8
  assert.deepEqual(packb(255), new Uint8Array([0xcc, 0xff]));
  assert.deepEqual(packb(256), new Uint8Array([0xcd, 0x01, 0x00])); // first uint16
  assert.deepEqual(packb(65535), new Uint8Array([0xcd, 0xff, 0xff]));
  assert.deepEqual(packb(65536), new Uint8Array([0xce, 0x00, 0x01, 0x00, 0x00])); // first uint32
  assert.deepEqual(packb(4294967295), new Uint8Array([0xce, 0xff, 0xff, 0xff, 0xff]));
  assert.deepEqual(
    packb(4294967296n),
    new Uint8Array([0xcf, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]), // first uint64
  );
});

test('negative integers take the narrowest form at every boundary', () => {
  assert.deepEqual(packb(-1), new Uint8Array([0xff])); // negative fixint
  assert.deepEqual(packb(-32), new Uint8Array([0xe0])); // last negative fixint
  assert.deepEqual(packb(-33), new Uint8Array([0xd0, 0xdf])); // first int8
  assert.deepEqual(packb(-128), new Uint8Array([0xd0, 0x80]));
  assert.deepEqual(packb(-129), new Uint8Array([0xd1, 0xff, 0x7f])); // first int16
  assert.deepEqual(packb(-32768), new Uint8Array([0xd1, 0x80, 0x00]));
  assert.deepEqual(packb(-32769), new Uint8Array([0xd2, 0xff, 0xff, 0x7f, 0xff])); // first int32
  assert.deepEqual(packb(-2147483648), new Uint8Array([0xd2, 0x80, 0x00, 0x00, 0x00]));
  assert.deepEqual(
    packb(-2147483649n),
    new Uint8Array([0xd3, 0xff, 0xff, 0xff, 0xff, 0x7f, 0xff, 0xff, 0xff]), // first int64
  );
});

test('non integers are float64, and integers never are', () => {
  assert.deepEqual(packb(1.5), new Uint8Array([0xcb, 0x3f, 0xf8, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
  assert.deepEqual(packb(0.5), new Uint8Array([0xcb, 0x3f, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
  assert.deepEqual(packb(-1.5), new Uint8Array([0xcb, 0xbf, 0xf8, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
  // 3.0 is an integer in JS and packs as one, which is the documented divergence from Python.
  assert.deepEqual(packb(3.0), new Uint8Array([0x03]));
});

test('an integer past 2^53 throws rather than hashing a value the caller never had', () => {
  assert.throws(() => packb(2 ** 53 + 2), /beyond 2\^53/);
  assert.throws(() => packb(NaN), /cannot be signed/);
  assert.throws(() => packb(Infinity), /cannot be signed/);
});

test('strings are UTF-8 and cross fixstr to str8 at 32 bytes', () => {
  assert.deepEqual(packb(''), new Uint8Array([0xa0]));
  assert.equal(hex('a'), bytes(0xa1, 0x61));

  const s31 = 'a'.repeat(31);
  assert.equal(hex(s31), bytes(0xa0 | 31) + Buffer.from(s31).toString('hex')); // 0xbf, last fixstr

  const s32 = 'a'.repeat(32);
  assert.equal(hex(s32), bytes(0xd9, 32) + Buffer.from(s32).toString('hex')); // first str8

  const s255 = 'a'.repeat(255);
  assert.equal(hex(s255), bytes(0xd9, 0xff) + Buffer.from(s255).toString('hex'));

  const s256 = 'a'.repeat(256);
  assert.equal(hex(s256), bytes(0xda, 0x01, 0x00) + Buffer.from(s256).toString('hex')); // str16
});

test('string length counts UTF-8 bytes, not characters', () => {
  // Two characters, three bytes: a two byte e-acute and a one byte x.
  assert.equal(hex('éx'), bytes(0xa3, 0xc3, 0xa9, 0x78));
});

test('arrays cross fixarray to array16 at 16 entries', () => {
  assert.deepEqual(packb([]), new Uint8Array([0x90]));
  assert.equal(hex([1, 2, 3]), bytes(0x93, 0x01, 0x02, 0x03));

  const a15 = Array.from({ length: 15 }, () => 1);
  assert.equal(hex(a15), bytes(0x9f) + '01'.repeat(15)); // last fixarray

  const a16 = Array.from({ length: 16 }, () => 1);
  assert.equal(hex(a16), bytes(0xdc, 0x00, 0x10) + '01'.repeat(16)); // first array16
});

test('maps cross fixmap to map16 at 16 entries', () => {
  assert.deepEqual(packb({}), new Uint8Array([0x80]));
  assert.equal(hex({ a: 1, b: 2 }), bytes(0x82, 0xa1, 0x61, 0x01, 0xa1, 0x62, 0x02));

  const keys = Array.from({ length: 16 }, (_, i) => `k${i}`);
  const m15: Record<string, number> = {};
  for (const k of keys.slice(0, 15)) m15[k] = 0;
  assert.equal(hex(m15).slice(0, 2), '8f'); // last fixmap

  const m16: Record<string, number> = {};
  for (const k of keys) m16[k] = 0;
  assert.equal(hex(m16).slice(0, 6), 'de0010'); // first map16
});

test('map keys keep insertion order and are never sorted', () => {
  // Same pairs, opposite insertion order. Sorting keys would make these two identical, which is
  // exactly the bug: field order is part of the hash the venue checks.
  assert.equal(hex({ b: 1, a: 2 }), bytes(0x82, 0xa1, 0x62, 0x01, 0xa1, 0x61, 0x02));
  assert.equal(hex({ a: 2, b: 1 }), bytes(0x82, 0xa1, 0x61, 0x02, 0xa1, 0x62, 0x01));
  assert.notEqual(hex({ b: 1, a: 2 }), hex({ a: 2, b: 1 }));
});

test('a Map packs like an object and holds an order an object cannot', () => {
  const m = new Map<string, number>([
    ['b', 1],
    ['a', 2],
  ]);
  assert.equal(hex(m), hex({ b: 1, a: 2 }));

  // JS hoists integer-like keys on a plain object, so only a Map can put "2" after "1" here in
  // the order the caller wrote them.
  const numeric = new Map<string, number>([
    ['2', 0],
    ['1', 0],
  ]);
  assert.equal(hex(numeric), bytes(0x82, 0xa1, 0x32, 0x00, 0xa1, 0x31, 0x00));
});

test('an undefined map value is omitted, and the count drops with it', () => {
  // `f` on an order must be absent when false, never present as nil.
  assert.equal(hex({ a: 1, f: undefined }), bytes(0x81, 0xa1, 0x61, 0x01));
  assert.equal(hex({ a: 1, f: undefined, b: 2 }), bytes(0x82, 0xa1, 0x61, 0x01, 0xa1, 0x62, 0x02));
  // A hole in an array has no such reading, so it is an error rather than a silent nil.
  assert.throws(() => packb([1, undefined]), /undefined has no encoding/);
});

test('nested arrays of maps nest their headers', () => {
  assert.equal(
    hex([{ a: 1 }, { b: [true, null] }]),
    bytes(0x92) +
      bytes(0x81, 0xa1, 0x61, 0x01) +
      bytes(0x81, 0xa1, 0x62, 0x92, 0xc3, 0xc0),
  );
});

test('a Hyperliquid order matches its hand computed bytes', () => {
  const order = { a: 0, b: true, p: '1234.5', s: '0.001', r: false, t: { limit: { tif: 'Gtc' } } };
  const expected =
    bytes(0x86) + // fixmap, 6 entries
    bytes(0xa1, 0x61, 0x00) + // "a": 0, positive fixint
    bytes(0xa1, 0x62, 0xc3) + // "b": true
    bytes(0xa1, 0x70, 0xa6, 0x31, 0x32, 0x33, 0x34, 0x2e, 0x35) + // "p": "1234.5"
    bytes(0xa1, 0x73, 0xa5, 0x30, 0x2e, 0x30, 0x30, 0x31) + // "s": "0.001"
    bytes(0xa1, 0x72, 0xc2) + // "r": false
    bytes(0xa1, 0x74, 0x81) + // "t": fixmap, 1 entry
    bytes(0xa5, 0x6c, 0x69, 0x6d, 0x69, 0x74, 0x81) + // "limit": fixmap, 1 entry
    bytes(0xa3, 0x74, 0x69, 0x66, 0xa3, 0x47, 0x74, 0x63); // "tif": "Gtc"
  assert.equal(hex(order), expected);
});

test('a full order action wraps that order in the documented field order', () => {
  const action = { type: 'order', orders: [{ a: 1, b: false }], grouping: 'na' };
  const expected =
    bytes(0x83) + // fixmap, 3 entries
    bytes(0xa4, 0x74, 0x79, 0x70, 0x65, 0xa5, 0x6f, 0x72, 0x64, 0x65, 0x72) + // "type": "order"
    bytes(0xa6, 0x6f, 0x72, 0x64, 0x65, 0x72, 0x73) + // "orders"
    bytes(0x91, 0x82, 0xa1, 0x61, 0x01, 0xa1, 0x62, 0xc2) + // [ {a: 1, b: false} ]
    bytes(0xa8, 0x67, 0x72, 0x6f, 0x75, 0x70, 0x69, 0x6e, 0x67, 0xa2, 0x6e, 0x61); // "grouping": "na"
  assert.equal(hex(action), expected);
});

test('an unsupported type is refused rather than guessed at', () => {
  // A Uint8Array would otherwise pack as the map {"0": 1, "1": 2}, which is nobody's intent.
  assert.throws(() => packb(new Uint8Array([1, 2])), /cannot encode Uint8Array/);
  assert.throws(() => packb(() => 0), /cannot encode function/);
  assert.throws(() => packb(Symbol('x')), /cannot encode symbol/);
});
