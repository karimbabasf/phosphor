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
//     link, a path or a tag has no business in the name of a price, and a label that held one
//     would be a way to plant it in front of whoever reads the chart next.

import type { Source } from './chart.ts';

export const LABEL_MAX = 48;
export const AGENT_TAG = '[agent] ';

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

// What a pointer looks like, in the order they are taken out. Anything matched becomes a space.
const POINTERS: readonly RegExp[] = [
  /[a-z][a-z0-9+.-]*:\/\/\S*/gi,
  /\b(?:javascript|vbscript|data|file|blob|about)\s*:\S*/gi,
  /\bwww\.\S*/gi,
  /\S*@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}\b\S*/gi,
  /\b[\w-]+(?:\.[\w-]+)*\.(?:com|net|org|io|ai|app|dev|xyz|co|me|gg|sh|so|to|ly|cc|ru|cn|info|biz|link|site|online|top|finance|exchange|money|trade|tv|us|uk|de|fr|jp|onion)\b\S*/gi,
  // Any other name with a path after it (evil.zip/x), and an address with or without a port.
  /\b[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}\/\S*/gi,
  /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\S*/g,
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
  text = text.normalize('NFKC').replace(INVISIBLE, ' ').replace(FULL_STOPS, '.');
  for (;;) {
    const bare = text.trimStart();
    if (!bare.toLowerCase().startsWith('[agent]')) break;
    text = bare.slice('[agent]'.length);
  }
  for (const pattern of POINTERS) text = text.replace(pattern, ' ');
  text = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(text);
  return chars.length > LABEL_MAX ? chars.slice(0, LABEL_MAX).join('').trimEnd() : text;
}

/* A label as it is stored: plain, cut, and tagged when the agent wrote it. */
export function markingLabel(raw: unknown, source: Source, fallback: string): string {
  const text = plainLabel(raw) || plainLabel(fallback) || 'mark';
  return source === 'agent' ? `${AGENT_TAG}${text}` : text;
}
