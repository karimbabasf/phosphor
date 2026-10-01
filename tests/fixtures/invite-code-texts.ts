// One corpus for both copies of the chat's invite code guard: the backend's looksLikeInviteCode
// (src/invite/code.ts, which also turns away a chat prompt that carries a code) and the window's
// codeIn (ui/core/invite.js). CONTRACTS.md, "Code shape": the canonical shape, found at any start,
// with two literal digits or more in the match. `code` is the verdict both must give.
// Every code here is made up: never issued, never funded.

export const CODE = 'PHOS-2X9QK-M7RTB-0HVFD-K3WPZ-A8GN4CJ';
const BARE = '2X9QKM7RTB0HVFDK3WPZA8GN4CJ';
const LETTERS = 'ABCDEFGHJKMNPQRSTVWXYZABCDE';

// 27 data characters in the code's groups of five, five, five, five and seven.
function grouped(data: string): string {
  return [data.slice(0, 5), data.slice(5, 10), data.slice(10, 15), data.slice(15, 20), data.slice(20)].join('-');
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
  { name: 'one digit, never issued', text: 'PHOS-' + grouped('2' + LETTERS.slice(0, 26)), code: false },
  { name: 'O, I and L are letters here', text: 'PHOS-' + grouped('OIL' + LETTERS.slice(0, 23) + '7'), code: false },
  { name: 'one data character short', text: CODE.slice(0, -1), code: false },
  { name: 'another prefix', text: 'PHAS-' + BARE, code: false },
  { name: 'a data character after the 27th', text: CODE + 'X', code: false },
  { name: 'nothing', text: '', code: false },
];
