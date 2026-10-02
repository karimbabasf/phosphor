// One corpus for every copy of the chat's invite code guard: the backend's looksLikeInviteCode
// (src/invite/code.ts, which also turns away a chat prompt that carries a code), the window's
// codeIn (ui/core/invite.js) and the log tail's cut. docs/security-model.md, "What signs, and with
// what", states the rule: one fold, then
// the prefixed shape or a bare run that reads as a valid code, found at any start, with two
// literal digits or more in the match. `code` is the verdict every copy must give.
// Every code here is made up: never issued, never funded.

import crypto from 'node:crypto';

import { formatCode } from '../../src/invite/code.ts';

// The shape of a code with a slip in it: its check symbol is wrong, so it does not parse.
export const CODE = 'PHOS-2X9QK-M7RTB-0HVFD-K3WPZ-A8GN4CJ';
const BARE = '2X9QKM7RTB0HVFDK3WPZA8GN4CJ';
const LETTERS = 'ABCDEFGHJKMNPQRSTVWXYZABCDE';

// A code that parses, from a fixed seed so every run reads the same one.
export const VALID = formatCode(Uint8Array.from(crypto.createHash('sha256').update('phosphor invite corpus 0').digest().subarray(0, 16)));
const VALID_DATA = VALID.slice('PHOS-'.length);
const VALID_BARE = VALID_DATA.replace(/-/g, '');

// The data groups of every code above, as a person would read them back out of a log.
export const CODE_GROUPS = [...CODE.slice(5).split('-'), ...VALID_DATA.split('-')];

// One character by its code point, for the dashes this file is about.
const ch = (code: number): string => String.fromCodePoint(code);
const EN_DASH = ch(0x2013);
const EM_DASH = ch(0x2014);

// 27 data characters in the code's groups of five, five, five, five and seven.
function grouped(data: string): string {
  return [data.slice(0, 5), data.slice(5, 10), data.slice(10, 15), data.slice(15, 20), data.slice(20)].join('-');
}

// A full-width letter or digit for each ASCII one, the way an East Asian keyboard types them.
function fullWidth(text: string): string {
  return text.replace(/[0-9A-Za-z-]/g, (c) => (c === '-' ? ch(0xff0d) : ch(c.charCodeAt(0) + 0xfee0)));
}

// Mathematical bold, the letters a styled-text site pastes: outside the BMP, two units each.
function bold(text: string): string {
  return text.replace(/[0-9A-Z]/g, (c) => ch(c <= '9' ? 0x1d7ce + Number(c) : 0x1d400 + c.charCodeAt(0) - 65));
}

export const GUARD_TEXTS: ReadonlyArray<{ name: string; text: string; code: boolean }> = [
  // Every form the contract names, and the ones a person is most likely to send.
  { name: 'upper', text: CODE, code: true },
  { name: 'lower', text: CODE.toLowerCase(), code: true },
  { name: 'no hyphens', text: 'PHOS' + BARE, code: true },
  { name: 'spaces', text: CODE.replace(/-/g, ' '), code: true },
  { name: 'no-break spaces', text: CODE.replace(/-/g, ' '), code: true },
  { name: 'PH0S', text: CODE.replace('PHOS', 'PH0S'), code: true },
  { name: 'a whole link', text: 'https://phosphor.money/invite#' + CODE, code: true },
  { name: 'in a sentence', text: `hey, here is my invite: ${CODE.toLowerCase()} thanks!`, code: true },
  { name: 'in quotes', text: `"${CODE}"`, code: true },
  { name: 'over lines', text: 'PHOS-2X9QK-M7RTB\n0HVFD-K3WPZ-A8GN4CJ', code: true },
  { name: 'hyphens and spaces', text: 'phos - 2x9qk - m7rtb - 0hvfd - k3wpz - a8gn4cj', code: true },
  { name: 'the fewest digits a code is issued with', text: 'PHOS-' + grouped('2' + LETTERS.slice(0, 25) + '7'), code: true },
  { name: 'one digit and the zero of PH0S', text: 'PH0S-' + grouped('2' + LETTERS.slice(0, 26)), code: true },
  { name: 'a first character no code has, a slip', text: 'PHOS-' + grouped('9' + BARE.slice(1)), code: true },
  // What an editor, a chat app or a keyboard does to the hyphens and the letters (audit L4).
  { name: 'no-break hyphens', text: CODE.replace(/-/g, '‑'), code: true },
  { name: 'Unicode hyphens', text: CODE.replace(/-/g, '‐'), code: true },
  { name: 'en dashes', text: CODE.replace(/-/g, EN_DASH), code: true },
  { name: 'em dashes with spaces', text: CODE.replace(/-/g, ` ${EM_DASH} `), code: true },
  { name: 'minus signs', text: CODE.replace(/-/g, '−'), code: true },
  { name: 'zero-width spaces', text: CODE.replace(/-/g, '​'), code: true },
  { name: 'soft hyphens', text: CODE.replace(/-/g, '­'), code: true },
  { name: 'zero-width characters inside the prefix and a group', text: 'P​H‍OS-2X9QK-M7⁠RTB-0HVFD-K3WPZ-A8GN4CJ', code: true },
  { name: 'underscores', text: CODE.replace(/-/g, '_'), code: true },
  { name: 'dots', text: CODE.replace(/-/g, '.'), code: true },
  { name: 'slashes', text: CODE.replace(/-/g, '/'), code: true },
  { name: 'full-width', text: fullWidth(CODE), code: true },
  { name: 'mathematical bold', text: bold(CODE), code: true },
  { name: 'accents on its letters', text: CODE.replace('X', 'X́').replace('K', 'Ḱ').replace('W', 'Ŵ'), code: true },
  // A code with no prefix, or with its first group cut short: found because it reads as a code.
  { name: 'no prefix', text: VALID_DATA, code: true },
  { name: 'no prefix and no hyphens', text: VALID_BARE.toLowerCase(), code: true },
  { name: 'no prefix, in a sentence', text: `my invite is ${VALID_DATA.toLowerCase()}, does it work?`, code: true },
  { name: 'no prefix, with no-break hyphens', text: VALID_DATA.replace(/-/g, '‑'), code: true },
  { name: 'a link with no prefix', text: 'https://phosphor.money/invite#' + VALID_DATA, code: true },
  { name: 'a short first group', text: 'PHOS' + VALID_BARE.replace(/(.{4})(?=.)/g, '$1-'), code: true },
  { name: 'a short first group, lower case', text: 'phos' + VALID_BARE.slice(0, 3).toLowerCase() + ' ' + VALID_BARE.slice(3).toLowerCase(), code: true },
  // Prose that fills the shape must not hide a code behind it, whether the prose match ends
  // before the code, inside it, or right on its prefix.
  { name: 'after prose with the shape', text: 'phosphorus is used in fertilizer and in matches ' + CODE, code: true },
  { name: 'after prose that ends on the prefix', text: 'phosphorus is used in my codes ok ' + CODE, code: true },
  { name: 'after prose that ends in the first group', text: 'phosphorus is in my code ok ' + CODE, code: true },
  { name: 'after the word Phosphor twice', text: 'phosphor phosphor ' + CODE, code: true },
  // Prose with the shape and two digits: refused, by the contract's rule. A sentence given up so
  // that a code typed with a slip still stays out.
  { name: 'prose with the shape and two digits', text: 'phosphates cost 25 dollars per ton in 2026 so', code: true },

  // What must go through.
  { name: 'the word Phosphor', text: 'how does phosphor handle swaps between eth and near', code: false },
  { name: 'prose with the shape and no digit', text: 'phosphorus is used in fertilizer and in matches', code: false },
  { name: 'a send in words', text: 'Phosphor send 50 usdc to my wallet please', code: false },
  { name: 'the lock', text: 'Phosphor wallet locked after fifteen minutes with nobody at the window', code: false },
  { name: 'a local address', text: 'phosphor up on http://127.0.0.1:4177 (live mode)', code: false },
  { name: 'the invite page', text: 'see https://phosphor.money/invite for how invites work', code: false },
  { name: 'phosphate', text: 'phosphate levels in the ocean are rising every single year', code: false },
  { name: 'phosphorus with a number', text: 'phosphorus is a chemical element with the symbol P and number 15', code: false },
  { name: 'an intent hash', text: 'intent AdQAELwW1dnkyVePUZzWAugtLF3yLLumTKWrDVz9NifQ settled', code: false },
  { name: 'a send with an address, a date and a time', text: 'send 25 usdc to 0x9858effd232b4033e47d90003d41ec34ecaeda94 on 2026-10-01 at 20:00', code: false },
  { name: 'a NEAR account and an amount', text: 'move 12.5 USDC to a7d101a893efccc5e560badd89b55325c99a4da76f2ec584d6a355415e388058 please', code: false },
  { name: 'a claim id and an order id', text: 'claim e463fa8067432298 and order 550e8400-e29b-41d4-a716-446655440000 both said 5.00', code: false },
  { name: 'prices in a list', text: 'BTC 61,250.10 / ETH 2,410.55 / SOL 141.02 / NEAR 4.81 / HYPE 38.40', code: false },
  { name: 'accented prose with numbers', text: 'café résumé naïve façade: 2026 und 15 Grad im Oktober', code: false },
  { name: 'full-width prose', text: fullWidth('phosphor swaps 12 usdc'), code: false },
  { name: 'Phosphor and a dash', text: `Phosphor ${EM_DASH} 2 swaps today, 15 USDC each, 30 in all`, code: false },
  // Known gaps, pinned so a change to them is a choice: a code with no prefix and a slip in it
  // (only its check symbol tells a bare code from prose), a code with no prefix split by anything
  // but spaces or dashes or into groups under three long (the rules that keep words and numbers
  // from passing the check by chance), a code a character short, and a code with a letter glued to
  // its end. Each needs the person to change the code by hand first.
  { name: 'no prefix and a slip', text: grouped(BARE), code: false },
  { name: 'no prefix, with underscores', text: VALID_DATA.replace(/-/g, '_'), code: false },
  { name: 'no prefix, two characters at a time', text: VALID_BARE.replace(/(.{2})(?=.)/g, '$1 '), code: false },
  { name: 'one data character short', text: CODE.slice(0, -1), code: false },
  { name: 'another prefix', text: 'PHAS-' + BARE, code: false },
  { name: 'a data character after the 27th', text: CODE + 'X', code: false },
  { name: 'nothing', text: '', code: false },
];
