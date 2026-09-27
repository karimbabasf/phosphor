// Address lookalikes for the display tests, made the way an address poisoner makes one.
//
// A poisoner wants a second address that a person cannot tell from theirs at a glance: the same
// first characters and the same last ones. The last ones of a bech32 or CashAddr string are its
// checksum, and a checksum is linear over the bits it covers, so any characters the attacker is
// free to choose (the stake half of a Cardano address, say) can be solved for to put the checksum
// back exactly. That takes a few hundred polymod runs here, where grinding keys takes minutes on a
// laptop: the test only needs the pair, the review (H1, 2026-09-27) timed the attack.

const CHARS = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function bech32Polymod(values: number[]): bigint {
  const gen = [0x3b6a57b2n, 0x26508e6dn, 0x1ea119fan, 0x3d4233ddn, 0x2a1462b3n];
  let chk = 1n;
  for (const v of values) {
    const top = chk >> 25n;
    chk = ((chk & 0x1ffffffn) << 5n) ^ BigInt(v);
    for (let i = 0; i < 5; i++) if ((top >> BigInt(i)) & 1n) chk ^= gen[i];
  }
  return chk;
}

function cashPolymod(values: number[]): bigint {
  const gen = [0x98f2bc8e61n, 0x79b76d99e2n, 0xf33e5fb3c4n, 0xae2eabe2a8n, 0x1e4f43e470n];
  let c = 1n;
  for (const d of values) {
    const top = c >> 35n;
    c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(d);
    for (let i = 0; i < 5; i++) if ((top >> BigInt(i)) & 1n) c ^= gen[i];
  }
  return c ^ 1n;
}

type Code = {
  data: number[]; // the words the checksum covers, after the prefix
  checkLen: number;
  residue: (data: number[]) => bigint; // the checksum as bits, linear in `data`
  spell: (data: number[], check: number[]) => string;
};

function wordsOf(text: string): number[] {
  return [...text].map((c) => {
    const v = CHARS.indexOf(c);
    if (v < 0) throw new Error(`not a bech32 character: ${c}`);
    return v;
  });
}

function checkWords(residue: bigint, len: number): number[] {
  return Array.from({ length: len }, (_, i) => Number((residue >> BigInt(5 * (len - 1 - i))) & 31n));
}

function bech32Code(address: string): Code {
  const sep = address.lastIndexOf('1');
  const hrp = address.slice(0, sep);
  const all = wordsOf(address.slice(sep + 1));
  const codes = [...hrp].map((c) => c.charCodeAt(0));
  const expanded = [...codes.map((c) => c >> 5), 0, ...codes.map((c) => c & 31)];
  return {
    data: all.slice(0, -6),
    checkLen: 6,
    residue: (data) => bech32Polymod([...expanded, ...data, 0, 0, 0, 0, 0, 0]) ^ 1n,
    spell: (data, check) => `${hrp}1${[...data, ...check].map((w) => CHARS[w]).join('')}`,
  };
}

function cashCode(address: string): Code {
  const [prefix, body] = address.split(':');
  const all = wordsOf(body);
  const expanded = [...[...prefix].map((c) => c.charCodeAt(0) & 31), 0];
  return {
    data: all.slice(0, -8),
    checkLen: 8,
    residue: (data) => cashPolymod([...expanded, ...data, 0, 0, 0, 0, 0, 0, 0, 0]),
    spell: (data, check) => `${prefix}:${[...data, ...check].map((w) => CHARS[w]).join('')}`,
  };
}

/* A second address sharing every word of the first except the ones in `change`, with the words
   in `free` solved so the checksum, and so the last characters, come out the same. */
function lookalike(code: Code, change: number[], free: number[]): string {
  const base = code.residue(code.data);
  const next = [...code.data];
  for (const i of change) next[i] ^= 1 + (i % 31);
  let target = code.residue(next) ^ base;
  // Each bit of each free word moves the checksum by a fixed vector: solve for the set that
  // cancels what the changed words moved, by elimination over GF(2). `mix` says which columns
  // a reduced vector is the sum of, one bit per column.
  const columns: Array<[number, number]> = [];
  const rows: Array<{ vec: bigint; mix: bigint }> = [];
  for (const i of free) {
    for (let b = 0; b < 5; b++) {
      const one = [...next];
      one[i] ^= 1 << b;
      rows.push({ vec: code.residue(one) ^ code.residue(next), mix: 1n << BigInt(columns.length) });
      columns.push([i, 1 << b]);
    }
  }
  const topOf = (v: bigint): bigint => 1n << BigInt(v.toString(2).length - 1);
  const pivots: Array<{ vec: bigint; mix: bigint }> = [];
  for (const row of rows) {
    let c = row;
    for (const p of pivots) if (c.vec & topOf(p.vec)) c = { vec: c.vec ^ p.vec, mix: c.mix ^ p.mix };
    if (c.vec !== 0n) {
      pivots.push(c);
      pivots.sort((a, b) => (b.vec > a.vec ? 1 : b.vec < a.vec ? -1 : 0));
    }
  }
  let mix = 0n;
  for (const p of pivots) {
    if (target & topOf(p.vec)) {
      target ^= p.vec;
      mix ^= p.mix;
    }
  }
  if (target !== 0n) throw new Error('the free words cannot put the checksum back');
  columns.forEach(([i, bit], k) => {
    if ((mix >> BigInt(k)) & 1n) next[i] ^= bit;
  });
  const check = checkWords(code.residue(next), code.checkLen);
  return code.spell(next, check);
}

export function bech32Lookalike(address: string, change: number[], free: number[]): string {
  return lookalike(bech32Code(address), change, free);
}

export function cashAddrLookalike(address: string, change: number[], free: number[]): string {
  return lookalike(cashCode(address), change, free);
}

export function range(from: number, to: number): number[] {
  return Array.from({ length: to - from }, (_, i) => from + i);
}
