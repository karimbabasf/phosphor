// The one door every label on the chart passes through, whichever tool wrote it.
//
// A label is the only free text an agent can leave on the screen, and since the chart is kept
// across a restart (src/markings.ts) it is also free text an agent leaves for the NEXT agent to
// read. So it is held to three rules here rather than at each writer, because the writers drift:
// chart_batch op draw stored its labels untagged and at whatever length the door let through.
//
//   Short: 48 characters, which names a level and carries no paragraph of instructions.
//   Owned: an agent's label carries the [agent] tag, added here, after the text it supplied, so
//     no text can write its way out of it. A tag already on the text is taken off first, which is
//     also what keeps a label read back and written again from growing a second one.
//   Plain: no control, direction or invisible characters, and nothing that points somewhere. A
//     link, a path, an address, an account or a tag has no business in the name of a price, and a
//     label that held one would be a way to plant it in front of whoever reads the chart next.
//     What is taken out leaves REMOVED in its place, so the label says so rather than closing up
//     into a different sentence.
//
// The words that are left can still be a page's: an agent that read one can write them. That
// half is src/web-read.ts, which stamps the label and marks whoever reads it back.

import type { Source } from './chart.ts';

export const LABEL_MAX = 48;
export const AGENT_TAG = '[agent] ';
export const REMOVED = '(removed)';
// What the patterns below read of a label, cut before they run: they take quadratic time over a
// long run with no space in it, and 32,000 characters of one held the process for two seconds.
const RAW_MAX = LABEL_MAX * 10;

// C0 and C1 controls, the soft hyphen, and every character that is invisible or reorders the
// text around it (bidi overrides and isolates, zero-width joiners, the BOM). The reordering ones
// are the dangerous half: they make a label read differently from the bytes it holds.
// Built from code points rather than written as a class of escapes, so the source holds no
// invisible character of its own.
// The tag characters and the supplementary variation selectors are the ones that carry a hidden
// message a person cannot see and a model reads anyway.
const INVISIBLE_RANGES: readonly [number, number][] = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x00ad, 0x00ad],
  [0x061c, 0x061c],
  [0x115f, 0x1160],
  [0x180b, 0x180e],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x206f],
  [0x2800, 0x2800],
  [0x3164, 0x3164],
  // A surrogate standing alone, which no text a person typed contains.
  [0xd800, 0xdfff],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xfff9, 0xfffb],
  [0xe0000, 0xe007f],
  [0xe0100, 0xe01ef],
];
const hex = (n: number): string => `\\u{${n.toString(16)}}`;
const INVISIBLE = new RegExp(`[${INVISIBLE_RANGES.map(([a, b]) => (a === b ? hex(a) : `${hex(a)}-${hex(b)}`)).join('')}]`, 'gu');
// The ideographic and halfwidth full stops read as a dot in a link, and NFKC keeps the first.
const FULL_STOPS = new RegExp(`[${hex(0x3002)}${hex(0xff61)}]`, 'gu');
// A dot written so a filter misses it: defanged ([.], (dot)) anywhere, and a middle dot, a bullet
// or another script's full stop between two letters or digits (evil·com). Read as a dot. A spaced
// separator ("BTC · 4h") is left alone.
const DEFANGED = /\[\.\]|\(\.\)|\{\.\}|[[({]dot[\])}]/giu;
const DOT_LIKE = new RegExp(
  `(?<=[\\p{L}\\p{N}])[${[0x00b7, 0x2022, 0x2219, 0x22c5, 0x30fb, 0x2027, 0x2e31, 0xa78f, 0x0589, 0x06d4, 0x1362, 0x1803].map(hex).join('')}](?=[\\p{L}\\p{N}])`,
  'gu',
);

// What a pointer looks like, in the order they are taken out. Anything matched becomes REMOVED.
const POINTERS: readonly RegExp[] = [
  /[a-z][a-z0-9+.-]*:\/\/\S*/gi,
  /\b(?:javascript|vbscript|data|file|blob|about)\s*:\S*/gi,
  /\bwww\.\S*/gi,
  /\S*@[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)*\.\p{L}{2,}\S*/giu,
  // An IPv6 literal, bracketed as a link writes it ([::1]:4177/api), or bare: with its "::", or
  // written out in six groups or more. A time has two colons at most.
  /\[[^\]\s]*:[^\]\s]*\]\S*/gu,
  /(?<![\p{L}\p{N}_:])(?:(?=[0-9a-f:]*::)[0-9a-f:]{2,}|(?:[0-9a-f]{1,4}:){5,}[0-9a-f]{1,4})\S*/giu,
  /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\S*/g,
  // A name on any top-level domain, with whatever path or port follows it: a site on a new TLD
  // (phosphor-help.support), a punycode look-alike (xn--...), a NEAR account (refund.near, x.tg)
  // and an ENS name (vault.eth) among them.
  /(?<![\p{L}\p{N}_-])[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)*\.(?:xn--[a-z0-9-]+|\p{L}{2,})\S*/giu,
  // This machine by name, and an address with a port written as one number (2130706433:4177) or
  // in two or three parts (127.1:4177). A time (09:30) and a ratio (1.5:1) stay.
  /(?<![\p{L}\p{N}_-])localhost(?![\p{L}\p{N}_-])\S*/giu,
  /(?<![\p{L}\p{N}_.])(?:\d{8,}|\d+(?:\.\d+){1,2}):\d{2,5}(?!\d)\S*/gu,
  // An address or a hash: an EVM address with or without its 0x, a NEAR implicit account (64
  // hex), a transaction hash. No word a price is named with is forty hex digits long.
  /(?:0x)?[0-9a-f]{40,}\S*/giu,
  /(?:^|(?<=\s))(?:~|\.{1,2})?\/[\w.@%+-]+(?:\/\S*)*/g,
  /\b[a-z]:\\\S*/gi,
  /\\\\\S+/g,
  // A tag, not a comparison: "RSI < 30" is a label, "<script" is not.
  /<\/?[a-z!][^>]*>?/gi,
  /\]\([^)]*\)?/g,
];

/* The text of a label with the rules above applied and no tag: what a label says. Empty when
   nothing was left, which the caller answers with its own fallback word. */
export function plainLabel(raw: unknown): string {
  let text = typeof raw === 'string' ? raw : raw === undefined || raw === null ? '' : String(raw);
  // Full-width and other compatibility forms fold to their plain letters first, so a link spelled
  // in full-width letters is still a link to the patterns below.
  text = text.slice(0, RAW_MAX).normalize('NFKC').slice(0, RAW_MAX);
  text = text.replace(INVISIBLE, ' ').replace(FULL_STOPS, '.').replace(DEFANGED, '.').replace(DOT_LIKE, '.');
  for (;;) {
    const bare = text.trimStart();
    if (!bare.toLowerCase().startsWith('[agent]')) break;
    text = bare.slice('[agent]'.length);
  }
  for (const pattern of POINTERS) text = text.replace(pattern, ` ${REMOVED} `);
  text = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(text);
  return chars.length > LABEL_MAX ? chars.slice(0, LABEL_MAX).join('').trimEnd() : text;
}

/* A label as it is stored: plain, cut, and tagged when the agent wrote it. */
export function markingLabel(raw: unknown, source: Source, fallback: string): string {
  const text = plainLabel(raw) || plainLabel(fallback) || 'mark';
  return source === 'agent' ? `${AGENT_TAG}${text}` : text;
}
