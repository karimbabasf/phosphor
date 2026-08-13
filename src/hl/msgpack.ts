// msgpack, hand-rolled, byte-identical to Python's `msgpack.packb` for the shapes a
// Hyperliquid action uses.
//
// These bytes are hashed and the hash is signed. A single wrong byte recovers a different
// address, and the venue never says so: it answers "User or API Wallet 0x... does not exist",
// which reads like a setup problem and is really an encoder problem. So every rule below is
// about matching Python exactly, not about being a defensible encoder in the abstract:
//
//   1. Compact form only. Python emits the shortest encoding a value fits in, so 127 is one
//      byte and 128 is two. Emitting a wider form is legal msgpack and a wrong hash.
//   2. Map keys keep insertion order. Sorting keys is the tempting bug: it looks like
//      canonicalisation, and it silently changes the hash, because the venue builds its dicts
//      in a documented field order and hashes them in that order.
//   3. Strings 32..255 bytes long use str8 (0xd9). msgpack-python has defaulted to
//      `use_bin_type=True` since 1.0, which is what turns str8 on; older encoders skip it.
//   4. A string's length is its UTF-8 byte count, not its character count.
//   5. Python's type decides int versus float. JS has one number type, so `Number.isInteger`
//      decides instead. That is safe here because every real quantity in a Hyperliquid action
//      travels as a string ("0.001"), and the only bare numbers are integers: asset index,
//      order id, leverage, tick counts.
//
// Deliberately absent: the bin family (0xc4..0xc6) and ext. No Hyperliquid action carries raw
// bytes, and an untested encoding sitting in the signing path is a liability, so an unsupported
// type throws instead of guessing.

const utf8 = new TextEncoder();

// One scratch view, reused, to reach the IEEE-754 bytes of a double. Single threaded and never
// re-entered, so a module-level buffer is safe and keeps float packing allocation free.
const scratch = new DataView(new ArrayBuffer(8));

type Sink = { buf: Uint8Array; len: number };

export function packb(value: unknown): Uint8Array {
  const sink: Sink = { buf: new Uint8Array(256), len: 0 };
  encode(sink, value);
  return sink.buf.slice(0, sink.len);
}

function encode(s: Sink, v: unknown): void {
  if (v === null) {
    byte(s, 0xc0);
    return;
  }
  if (v === undefined) {
    // Python has no undefined, so there is no byte sequence to match. A missing optional field
    // is spelled by leaving the key out (see encodeMap), never by holding a hole.
    throw new Error('msgpack: undefined has no encoding; omit the key instead');
  }
  if (typeof v === 'boolean') {
    byte(s, v ? 0xc3 : 0xc2);
    return;
  }
  if (typeof v === 'number') {
    encodeNumber(s, v);
    return;
  }
  if (typeof v === 'bigint') {
    encodeInt(s, v);
    return;
  }
  if (typeof v === 'string') {
    encodeString(s, v);
    return;
  }
  if (Array.isArray(v)) {
    writeHeader(s, v.length, 0x90, 0xdc, 0xdd, 'array');
    for (const item of v) encode(s, item);
    return;
  }
  if (v instanceof Map) {
    encodeMap(s, [...v.entries()]);
    return;
  }
  if (isPlainObject(v)) {
    // Object.entries yields own enumerable string keys in insertion order, which is the order a
    // Python dict literal would hash in. One exception to know about: JS puts integer-like keys
    // ("0", "1") first in numeric order regardless of when they were added. No Hyperliquid field
    // is named that way, but a caller who needs such a key must pass a Map to keep the order.
    encodeMap(s, Object.entries(v as Record<string, unknown>));
    return;
  }
  if (typeof v === 'object') {
    // A Date, a Uint8Array or a class instance would all pass an `Object.entries` check and pack
    // as some map nobody meant. Refusing them keeps the encoder's output tied to what the caller
    // literally wrote.
    throw new Error(`msgpack: cannot encode ${v.constructor?.name ?? 'object'}; pass a plain object or a Map`);
  }
  throw new Error(`msgpack: cannot encode ${typeof v}`);
}

function isPlainObject(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function encodeMap(s: Sink, entries: [unknown, unknown][]): void {
  // Dropping undefined values matches how the venue's own client builds an action: an optional
  // field is absent, not null. This matters most for `f` on an order and `a` on a modify, which
  // the venue rejects outright when present and false.
  const live = entries.filter((e) => e[1] !== undefined);
  writeHeader(s, live.length, 0x80, 0xde, 0xdf, 'map');
  for (const [k, val] of live) {
    encode(s, k);
    encode(s, val);
  }
}

function encodeNumber(s: Sink, n: number): void {
  if (Number.isInteger(n)) {
    if (!Number.isSafeInteger(n)) {
      // Past 2^53 a double has already lost the exact value, so packing it would hash a number
      // the caller never had. BigInt is the only way to mean an exact 64 bit integer.
      throw new Error(`msgpack: integer ${n} is beyond 2^53 and inexact; pass a bigint`);
    }
    encodeInt(s, BigInt(n));
    return;
  }
  if (!Number.isFinite(n)) throw new Error(`msgpack: ${n} cannot be signed`);
  byte(s, 0xcb);
  scratch.setFloat64(0, n, false);
  need(s, 8);
  for (let i = 0; i < 8; i++) s.buf[s.len + i] = scratch.getUint8(i);
  s.len += 8;
}

function encodeInt(s: Sink, n: bigint): void {
  if (n >= 0n) {
    if (n < 0x80n) return byte(s, Number(n)); // positive fixint
    if (n <= 0xffn) {
      byte(s, 0xcc);
      return byte(s, Number(n));
    }
    if (n <= 0xffffn) {
      byte(s, 0xcd);
      return u16(s, Number(n));
    }
    if (n <= 0xffffffffn) {
      byte(s, 0xce);
      return u32(s, Number(n));
    }
    if (n <= 0xffffffffffffffffn) {
      byte(s, 0xcf);
      return u64(s, n);
    }
    throw new Error(`msgpack: ${n} does not fit in 64 bits`);
  }
  if (n >= -0x20n) return byte(s, 0xe0 | (Number(n) & 0x1f)); // negative fixint
  if (n >= -0x80n) {
    byte(s, 0xd0);
    return byte(s, Number(n) & 0xff);
  }
  if (n >= -0x8000n) {
    byte(s, 0xd1);
    return u16(s, Number(n) & 0xffff);
  }
  if (n >= -0x80000000n) {
    byte(s, 0xd2);
    return u32(s, Number(n) >>> 0);
  }
  if (n >= -0x8000000000000000n) {
    byte(s, 0xd3);
    // Masking a negative BigInt against a 64 bit mask is its two's complement, which is the
    // representation msgpack wants for int64.
    return u64(s, n & 0xffffffffffffffffn);
  }
  throw new Error(`msgpack: ${n} does not fit in 64 bits`);
}

function encodeString(s: Sink, str: string): void {
  const bytes = utf8.encode(str);
  const len = bytes.length;
  if (len < 32) byte(s, 0xa0 | len);
  else if (len <= 0xff) {
    byte(s, 0xd9);
    byte(s, len);
  } else if (len <= 0xffff) {
    byte(s, 0xda);
    u16(s, len);
  } else if (len <= 0xffffffff) {
    byte(s, 0xdb);
    u32(s, len);
  } else throw new Error('msgpack: string longer than 2^32 bytes');
  need(s, len);
  s.buf.set(bytes, s.len);
  s.len += len;
}

// Arrays and maps share one header shape: a fixed form under 16 entries, then a 16 bit count,
// then a 32 bit count. Only the tag bytes differ.
function writeHeader(
  s: Sink,
  count: number,
  fixTag: number,
  tag16: number,
  tag32: number,
  what: string,
): void {
  if (count < 16) byte(s, fixTag | count);
  else if (count <= 0xffff) {
    byte(s, tag16);
    u16(s, count);
  } else if (count <= 0xffffffff) {
    byte(s, tag32);
    u32(s, count);
  } else throw new Error(`msgpack: ${what} longer than 2^32 entries`);
}

function need(s: Sink, n: number): void {
  if (s.len + n <= s.buf.length) return;
  let size = s.buf.length * 2;
  while (size < s.len + n) size *= 2;
  const next = new Uint8Array(size);
  next.set(s.buf.subarray(0, s.len));
  s.buf = next;
}

function byte(s: Sink, b: number): void {
  need(s, 1);
  s.buf[s.len++] = b;
}

function u16(s: Sink, n: number): void {
  need(s, 2);
  s.buf[s.len] = (n >>> 8) & 0xff;
  s.buf[s.len + 1] = n & 0xff;
  s.len += 2;
}

function u32(s: Sink, n: number): void {
  need(s, 4);
  s.buf[s.len] = (n >>> 24) & 0xff;
  s.buf[s.len + 1] = (n >>> 16) & 0xff;
  s.buf[s.len + 2] = (n >>> 8) & 0xff;
  s.buf[s.len + 3] = n & 0xff;
  s.len += 4;
}

function u64(s: Sink, n: bigint): void {
  need(s, 8);
  let rest = n;
  for (let i = 7; i >= 0; i--) {
    s.buf[s.len + i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  s.len += 8;
}
