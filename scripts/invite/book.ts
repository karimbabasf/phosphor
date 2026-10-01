// What the invite file holds once it is open: the treasury's key, every code with its label and
// state, and every move the operator signed, with the exact bytes it signed. Spec:
// docs/superpowers/specs/2026-10-01-invite-codes-design.md, "The money path".
//
// A move is one signed payload out of one account inside intents.near: a batch (the treasury `T`
// funding up to ten codes), a reclaim (one code paying its balance back to T), a withdraw (T
// paying a typed address), or a sweep (the proof script emptying its throwaway accounts). The
// signed bytes are written down before they are published and are the only bytes ever sent for
// that move: a move that got no answer is resent as the same bytes, never signed again.
//
// The book is checked whole every time it is read. The file is authenticated (AES-256-GCM in
// scripts/invite/file.ts), so a book that does not hold together is a bug rather than an edit,
// and it stops everything all the same: nothing is signed out of a book this module cannot read.

import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';

import { codeAddress, parseCode } from '../../src/invite/code.ts';

export const BOOK_VERSION = 1;

/* pending: written before the batch was signed, not yet proven funded. open: funded and read back,
   its link shown once. claimed: found holding under a cent while the book said open. reclaimed:
   paid back to T. void: its batch was proven never to run, so it never held anything. */
export type CodeState = 'pending' | 'open' | 'claimed' | 'reclaimed' | 'void';

export type InviteCode = {
  code: string; // the bearer secret, PHOS-...; never printed after the batch that made it
  address: string; // its account inside intents.near, lowercase
  label: string;
  amountBase: string; // what the batch paid it, USDC base units
  batch: string; // the id of the move that funded it
  state: CodeState;
  createdAt: string;
  openedAt?: string;
  closedAt?: string;
};

export type MoveKind = 'batch' | 'reclaim' | 'withdraw' | 'sweep';

export type SignedMove = {
  payload: string; // the exact string that was signed and is the only one ever sent
  signature: string; // secp256k1:<base58>, the verifier's encoding
  nonce: string;
  deadline: string;
  intentHash: string;
};

export type Leg = { receiverId: string; amountBase: string };

export type Move = {
  id: string;
  kind: MoveKind;
  signer: string; // the paying account
  legs: Leg[];
  state: 'pending' | 'done' | 'failed';
  createdAt: string;
  signed?: SignedMove;
  sends?: number; // how many times the identical bytes went to the relay
  relaySaid?: string; // the relay's last answer, its own words, bounded
  settledAt?: string;
  detail?: string; // why it failed, in a sentence
  label?: string; // a batch's label
  printedAt?: string; // a batch's links, shown once, at this time
};

export type Treasury = { address: string; key: Hex; createdAt: string };

export type InviteBook = {
  version: typeof BOOK_VERSION;
  treasury: Treasury;
  codes: InviteCode[];
  moves: Move[];
};

export function newBook(treasury: Treasury): InviteBook {
  return { version: BOOK_VERSION, treasury, codes: [], moves: [] };
}

const CODE_STATES: readonly string[] = ['pending', 'open', 'claimed', 'reclaimed', 'void'];
const MOVE_KINDS: readonly string[] = ['batch', 'reclaim', 'withdraw', 'sweep'];
const MOVE_STATES: readonly string[] = ['pending', 'done', 'failed'];

function bad(what: string): never {
  throw new Error(`the invite file does not hold together: ${what}`);
}

function str(value: unknown): value is string {
  return typeof value === 'string';
}

function optionalStr(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function baseUnits(value: unknown): value is string {
  return typeof value === 'string' && /^\d{1,30}$/.test(value);
}

function readSigned(raw: unknown, at: string): SignedMove {
  if (raw === null || typeof raw !== 'object') bad(`${at} has no signed bytes`);
  const s = raw as Record<string, unknown>;
  for (const field of ['payload', 'signature', 'nonce', 'deadline', 'intentHash']) {
    if (!str(s[field]) || s[field] === '') bad(`${at} carries no ${field}`);
  }
  return {
    payload: s['payload'] as string,
    signature: s['signature'] as string,
    nonce: s['nonce'] as string,
    deadline: s['deadline'] as string,
    intentHash: s['intentHash'] as string,
  };
}

/* The book out of decrypted JSON, every field checked, or a throw. The treasury's key must turn
   into the treasury's address, and every code must parse and turn into its own address: a book
   where either disagrees would sign out of one account while believing it was another. Errors
   name a position, never a code. */
export function readBook(value: unknown): InviteBook {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) bad('it is not an object');
  const raw = value as Record<string, unknown>;
  if (raw['version'] !== BOOK_VERSION) bad(`version ${String(raw['version'])} is not ${BOOK_VERSION}`);

  const t = raw['treasury'] as Record<string, unknown> | null;
  if (t === null || typeof t !== 'object') bad('there is no treasury');
  if (!str(t['key']) || !/^0x[0-9a-f]{64}$/.test(t['key'])) bad("the treasury's key is not a key");
  if (!str(t['address']) || !str(t['createdAt'])) bad("the treasury's address or date is missing");
  if (privateKeyToAccount(t['key'] as Hex).address.toLowerCase() !== t['address']) bad("the treasury's key is not the treasury's address");
  const treasury: Treasury = { address: t['address'], key: t['key'] as Hex, createdAt: t['createdAt'] };

  if (!Array.isArray(raw['codes'])) bad('there is no list of codes');
  const seen = new Set<string>([treasury.address]);
  const codes = (raw['codes'] as unknown[]).map((entry, i): InviteCode => {
    const at = `code ${i + 1}`;
    if (entry === null || typeof entry !== 'object') bad(`${at} is not an object`);
    const c = entry as Record<string, unknown>;
    if (!str(c['code']) || !str(c['address']) || !str(c['label']) || !str(c['batch']) || !str(c['createdAt'])) bad(`${at} is missing a field`);
    if (!baseUnits(c['amountBase'])) bad(`${at} has no amount`);
    if (!str(c['state']) || !CODE_STATES.includes(c['state'])) bad(`${at} has no state`);
    if (!optionalStr(c['openedAt']) || !optionalStr(c['closedAt'])) bad(`${at} has a date that is not a date`);
    const parsed = parseCode(c['code']);
    if (!parsed.ok) bad(`${at} does not parse as a code`);
    const address = codeAddress(parsed.secret);
    parsed.secret.fill(0);
    if (address === null || address !== c['address']) bad(`${at} is not the code for its address`);
    if (seen.has(address)) bad(`${at} repeats an account`);
    seen.add(address);
    return {
      code: c['code'],
      address,
      label: c['label'],
      amountBase: c['amountBase'],
      batch: c['batch'],
      state: c['state'] as CodeState,
      createdAt: c['createdAt'],
      ...(c['openedAt'] === undefined ? {} : { openedAt: c['openedAt'] as string }),
      ...(c['closedAt'] === undefined ? {} : { closedAt: c['closedAt'] as string }),
    };
  });

  if (!Array.isArray(raw['moves'])) bad('there is no list of moves');
  const ids = new Set<string>();
  const moves = (raw['moves'] as unknown[]).map((entry, i): Move => {
    const at = `move ${i + 1}`;
    if (entry === null || typeof entry !== 'object') bad(`${at} is not an object`);
    const m = entry as Record<string, unknown>;
    if (!str(m['id']) || ids.has(m['id'])) bad(`${at} has no id of its own`);
    ids.add(m['id']);
    if (!str(m['kind']) || !MOVE_KINDS.includes(m['kind'])) bad(`${at} has no kind`);
    if (!str(m['state']) || !MOVE_STATES.includes(m['state'])) bad(`${at} has no state`);
    if (!str(m['signer']) || !str(m['createdAt'])) bad(`${at} is missing its signer or date`);
    if (!Array.isArray(m['legs']) || m['legs'].length === 0) bad(`${at} pays nobody`);
    const legs = (m['legs'] as unknown[]).map((leg): Leg => {
      const l = leg as Record<string, unknown> | null;
      if (l === null || typeof l !== 'object' || !str(l['receiverId']) || !baseUnits(l['amountBase'])) bad(`${at} has a leg that is not a leg`);
      return { receiverId: l['receiverId'], amountBase: l['amountBase'] };
    });
    for (const field of ['relaySaid', 'settledAt', 'detail', 'label', 'printedAt']) {
      if (!optionalStr(m[field])) bad(`${at} has a ${field} that is not text`);
    }
    if (m['sends'] !== undefined && !(typeof m['sends'] === 'number' && Number.isInteger(m['sends']) && m['sends'] >= 0)) bad(`${at} has a count of sends that is not a count`);
    const move: Move = {
      id: m['id'],
      kind: m['kind'] as MoveKind,
      signer: m['signer'],
      legs,
      state: m['state'] as Move['state'],
      createdAt: m['createdAt'],
    };
    if (m['signed'] !== undefined) move.signed = readSigned(m['signed'], at);
    for (const field of ['relaySaid', 'settledAt', 'detail', 'label', 'printedAt'] as const) {
      if (typeof m[field] === 'string') move[field] = m[field] as string;
    }
    if (typeof m['sends'] === 'number') move.sends = m['sends'];
    return move;
  });

  for (const code of codes) {
    if (!moves.some((m) => m.id === code.batch && m.kind === 'batch')) bad('a code names a batch the book does not hold');
  }
  return { version: BOOK_VERSION, treasury, codes, moves };
}

/* The batch that blocks the next one: signed or not, sent or not, proven or not, until every one
   of its codes is open (and its links shown) or void. */
export function unfinishedBatch(book: InviteBook): Move | undefined {
  return book.moves.find(
    (m) =>
      m.kind === 'batch' &&
      (m.state === 'pending' || book.codes.some((c) => c.batch === m.id && c.state === 'pending') || (m.state === 'done' && m.printedAt === undefined)),
  );
}

export function pendingMoves(book: InviteBook, kind: MoveKind): Move[] {
  return book.moves.filter((m) => m.kind === kind && m.state === 'pending');
}

export function codesOf(book: InviteBook, batch: string): InviteCode[] {
  return book.codes.filter((c) => c.batch === batch);
}
