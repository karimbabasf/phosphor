// The operator's money moves, over an injected network: fund a batch of codes from the treasury
// T, reclaim open codes back to T, withdraw T to a typed address, and say where every code stands.
// Spec: docs/superpowers/specs/2026-10-01-invite-codes-design.md, "The money path". The terminal
// side is scripts/invite.ts; the proof script (scripts/invite-proof.ts) drives the same moves.
// Turning other USDC that reached T into NEAR USDC is scripts/invite/convert.ts, through 1Click.
//
// ONE SIGNATURE THAT CAN RUN. A move is one transfer payload out of one account
// (src/invite/payload.ts), rehearsed (below), signed only after everything it pays is on disk, and
// written down as the exact signed bytes before they go anywhere. From then on it is never signed
// again: an unanswered publish is resent as the same bytes, and a move found pending at the next
// run is checked on the chain first and resent as the same bytes only while it can still run.
//
// NO PLAN B. The app's claim falls back to 1Click when the relay turns it away; operator moves do
// not. A refusal stops the move and says so, and the move is watched until NEAR Intents proves it
// ran or proves it never can (src/relay/fate.ts): the deadline passed on the chain's clock with
// its nonce unspent. Only then does the book call it failed, so nothing is ever called "nothing
// moved" while the signed bytes can still run.
//
// PROOF IS THE NONCE. The verifier spends the nonce in the same call that runs the transfers, and
// the receivers are inside the signed bytes, so a spent nonce is the move done. A balance is read
// afterwards to show a code funded, never to prove a move.
//
// REHEARSED, NEVER SIMULATED AS ITSELF. The verifier's verdict comes from simulate_intents, a view
// served by the NEAR RPC, a third party. Real bytes handed to it before they are on disk could be
// published by whoever runs it while the book calls the move failed. So every move is rehearsed:
// built, checked and signed as it will be, but with a signature that dies one millisecond after a
// final block, and simulated AT that block. The verifier answers for that block, and every block
// that could ever execute the rehearsal is stamped later. That holds while the block's stamp is
// true, and the RPC is who says it: so a final block stamped less than REHEARSAL_AHEAD_MS behind
// this Mac's clock is refused, and with this clock right a rehearsal is dead before it is signed.
// A Mac clock running fast is what this check cannot see (audit L7): a lying RPC could then run a
// rehearsal inside that skew. Every payee of a rehearsal is therefore an account whose key is on
// disk first: T, a typed address, or codes in the file. --simulate-only writes its codes to the
// file, void, before the rehearsal is signed, so anything that ever reached them is reclaimable.

import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { nearChainSpec } from '../../src/chain/near.ts';
import { ERC191_STANDARD } from '../../src/intents-sign.ts';
import { oneLine } from '../../src/intents.ts';
import { INTENTS_VERIFIER } from '../../src/ledger/intents.ts';
import { readTimeout } from '../../src/net.ts';
import { MIN_CLAIM_BASE } from '../../src/invite/claim.ts';
import { codeAddress, deriveKey, formatCode, generateSecret, inviteLink, keyInRange, parseCode } from '../../src/invite/code.ts';
import {
  CLAIM_DEADLINE_MS,
  INVITE_ASSET_ID,
  MAX_TRANSFERS,
  REHEARSAL_LIFE_MS,
  buildTransfersPayload,
  checkTransfersPayload,
  claimNonce,
  formatUsdc,
  intentHashOf,
  publishWithoutQuote,
  signingDeadline,
  simulationVerdict,
} from '../../src/invite/payload.ts';
import { keySigner } from '../../src/invite/signer.ts';
import type { KeySigner } from '../../src/invite/signer.ts';
import type { IntentsApiPort } from '../../src/rails/intents-native.ts';
import { intentsAccountProblem } from '../../src/rails/intents-send.ts';
import type { RelayClient, RelayStatus } from '../../src/relay/client.ts';
import { FATE_AHEAD_MAX_MS, RELAY_DEADLINE_GRACE_MS, transferFate } from '../../src/relay/fate.ts';
import type { FateReads } from '../../src/relay/fate.ts';
import { simulationOf, simulationRefusal } from '../../src/relay/verifier.ts';
import type { FinalBlock, SignedIntent, Simulation, VerifierPort } from '../../src/relay/verifier.ts';
import { codesOf, pendingMoves, unfinishedBatch } from './book.ts';
import type { InviteBook, InviteCode, Move, SignedMove, Treasury } from './book.ts';
import { asInviteBase, heldList, otherUsdc } from './usdc.ts';

export type MoneyNet = {
  verifier: VerifierPort;
  relay: RelayClient;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  // crypto.randomBytes, always, outside a test: codes, nonces, ids and T's key come from it.
  random: (bytes: number) => Uint8Array;
  // The signer a key turns into. keySigner (src/invite/signer.ts) unless a test watches it.
  signerOf?: (key: Hex) => KeySigner;
  /* simulate_intents run at one block, by its hash, for a dry run. Null when it did not answer.
     Without it no dry run is signed at all. */
  simulateAt?: (signed: SignedIntent[], blockHash: string) => Promise<Simulation | null>;
  // 1Click, for convert alone (scripts/invite/convert.ts): the partner key when one is set. A test
  // hands in its own, with the key its quotes are signed by.
  oneclick?: IntentsApiPort;
  quoteKey?: string;
  firstPollMs?: number;
  pollMs?: number;
};

/* simulate_intents at a block hash rather than at "final" (the verifier's own call in
   src/relay/verifier.ts, with block_id in place of finality, the way src/relay/fate.ts reads a
   nonce at a block). */
export function liveSimulateAt(fetchImpl: typeof fetch = fetch): NonNullable<MoneyNet['simulateAt']> {
  return async (signed, blockHash) => {
    try {
      const res = await fetchImpl(nearChainSpec().rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'query',
          params: {
            request_type: 'call_function',
            block_id: blockHash,
            account_id: INTENTS_VERIFIER,
            method_name: 'simulate_intents',
            args_base64: Buffer.from(JSON.stringify({ signed })).toString('base64'),
          },
        }),
        signal: readTimeout(),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { result?: { result?: number[]; error?: unknown }; error?: unknown };
      if (body.result === undefined) return null;
      if (body.result.error !== undefined && body.result.error !== null) return { ok: false, refusal: simulationRefusal(body.result.error) };
      if (!Array.isArray(body.result.result)) return null;
      return simulationOf(JSON.parse(Buffer.from(Uint8Array.from(body.result.result)).toString('utf8')));
    } catch {
      return null;
    }
  };
}

export { REHEARSAL_LIFE_MS };
/* How far ahead of this Mac's clock NEAR's final block may be stamped. An honest final block trails
   real time by about 2.6 s (src/relay/verifier.ts), so it is behind this clock, never ahead. A
   rehearsal wants it a second behind at least: its signature lives until 1 ms past the block, a
   block stamped later than real time is a signature that lives that much longer, and the second
   is the margin (audit L7; a Mac clock more than about 1.6 s slow is refused for it, and says so).
   A real move allows what src/relay/fate.ts allows before it stops believing a block at all. */
export const REHEARSAL_AHEAD_MS = -1_000;
const MOVE_AHEAD_MS = FATE_AHEAD_MAX_MS;

// The book in hand and the one way to put it on disk. save() throws when the write fails.
export type Ledger = { book: InviteBook; save(): void };

export type Io = {
  say(line: string): void;
  confirm(question: string): Promise<boolean>;
  ask(question: string): Promise<string | null>;
  // A secret for the terminal, shown once and never on stdout.
  reveal(text: string): void;
};

export type MoveResult =
  | { kind: 'landed'; status: RelayStatus | null }
  | { kind: 'held'; detail: string } // nothing that can run was signed; the move stays pending, to try again
  | { kind: 'refused'; detail: string } // the verifier said no; nothing that can run left this Mac
  | { kind: 'dead'; detail: string } // signed, perhaps sent, proven never to run
  | { kind: 'unconfirmed'; detail: string }; // sent, no proof either way yet: the move stays pending

const FIRST_POLL_MS = 1_000;
const POLL_MS = 3_000;
// How long one watch may run on this Mac's clock: the signed deadline, the grace src/relay/fate.ts
// gives this clock when the chain's does not answer, and a minute.
export const MOVE_WATCH_CAP_MS = CLAIM_DEADLINE_MS + RELAY_DEADLINE_GRACE_MS + 60_000;

export function shortAddress(address: string): string {
  return address.length > 14 ? `${address.slice(0, 6)}...${address.slice(-4)}` : address;
}

export function nowIso(net: MoneyNet): string {
  return new Date(net.now()).toISOString();
}

export function idOf(net: MoneyNet): string {
  return Buffer.from(net.random(8)).toString('hex');
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Dollars rounded up to the cent, for "send at least": never a figure that falls short.
function usdUp(base: bigint): string {
  const cents = (base + 9_999n) / 10_000n;
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
}

/* What to send T with the app's Send so it ends up holding `base`: that send pays 1Click about
   0.25 percent (src/rails/intents-send.ts), so base / 0.9975, plus a cent (spec, "Fund"). */
export function fundingFor(base: bigint): string {
  return usdUp((base * 10_000n + 9_974n) / 9_975n + 10_000n);
}

/* T: 32 bytes from the CSPRNG, redrawn until they are a valid secp256k1 scalar. */
export function newTreasury(net: Pick<MoneyNet, 'random' | 'now'>): Treasury {
  for (;;) {
    const bytes = Uint8Array.from(net.random(32));
    if (bytes.length !== 32) throw new Error('the random source did not give 32 bytes');
    const hex = Buffer.from(bytes).toString('hex');
    bytes.fill(0);
    if (!keyInRange(BigInt(`0x${hex}`))) continue;
    const key = `0x${hex}` as Hex;
    return { address: privateKeyToAccount(key).address.toLowerCase(), key, createdAt: new Date(net.now()).toISOString() };
  }
}

export function treasurySigner(book: InviteBook, net: MoneyNet): KeySigner {
  const signer = (net.signerOf ?? keySigner)(book.treasury.key);
  if (signer.address !== book.treasury.address) {
    signer.drop();
    throw new Error("the treasury's key does not sign as the treasury");
  }
  return signer;
}

// A code's own signer, from the code the book holds. The parsed bytes are wiped once the key is out.
function signerForCode(code: InviteCode, net: MoneyNet): KeySigner {
  const parsed = parseCode(code.code);
  let key: Hex | null = null;
  if (parsed.ok) {
    key = deriveKey(parsed.secret);
    parsed.secret.fill(0);
  }
  const signer = key === null ? null : (net.signerOf ?? keySigner)(key);
  if (signer === null || signer.address !== code.address) {
    signer?.drop();
    throw new Error(`the book's code for ${shortAddress(code.address)} does not sign as that account`);
  }
  return signer;
}

export function fateReads(net: MoneyNet): FateReads {
  const v = net.verifier;
  return {
    nonceUsed: (account, nonce, at) => v.nonceUsed(account, nonce, at),
    ...(v.finalBlock === undefined ? {} : { finalBlock: () => v.finalBlock!() }),
    ...(v.isValidSalt === undefined ? {} : { saltValid: (salt: Uint8Array, at?: string) => v.isValidSalt!(salt, at) }),
  };
}

export const REFUSALS: Record<ReturnType<typeof simulationVerdict>, string> = {
  empty: 'The paying account holds less than the move pays.',
  locked: 'NEAR Intents has locked the paying account, so nothing can be signed out of it.',
  expired: 'The signed move would reach the verifier after its deadline.',
  refused: 'The verifier refused the signed move.',
};

type Built = { ok: true; signed: SignedMove; block: FinalBlock } | { ok: false; detail: string };

export async function chainClock(net: MoneyNet, aheadMs: number): Promise<{ salt: Uint8Array; block: FinalBlock } | string> {
  const [salt, block] = await Promise.all([
    net.verifier.currentSalt().catch(() => null),
    net.verifier.finalBlock === undefined ? Promise.resolve(null) : net.verifier.finalBlock().catch(() => null),
  ]);
  if (salt === null || block === null) return 'the verifier did not answer with its salt and its clock';
  const ahead = block.atMs - net.now();
  if (ahead > aheadMs) {
    const where = ahead > 0 ? `${(ahead / 1000).toFixed(1)} s ahead of this Mac's clock` : `only ${(-ahead / 1000).toFixed(1)} s behind this Mac's clock, where an honest one trails by about 2.6 s`;
    return `NEAR's final block is stamped ${where} (if this Mac's clock is behind, set it; if it is not, the RPC is not telling the time)`;
  }
  return { salt, block };
}

/* The payload, read back as a stranger would, then signed. The deadline and the nonce come off
   the chain's final block and current salt, never this Mac's clock, which only bounds them. */
async function signMove(move: Move, signer: KeySigner, net: MoneyNet, lifeMs: number, aheadMs: number): Promise<Built> {
  if (signer.address !== move.signer) return { ok: false, detail: "the key in hand is not the paying account's" };
  const clock = await chainClock(net, aheadMs);
  if (typeof clock === 'string') return { ok: false, detail: clock };
  const { salt, block } = clock;
  const legs = move.legs.map((l) => ({ receiverId: l.receiverId, amountBase: BigInt(l.amountBase) }));
  const deadline = signingDeadline(block.atMs, lifeMs);
  const nonce = claimNonce(salt, deadline, net.random);
  const payload = buildTransfersPayload({ signerId: move.signer, assetId: INVITE_ASSET_ID, deadline, nonce, transfers: legs });
  const problems = checkTransfersPayload(payload, { signerId: move.signer, assetId: INVITE_ASSET_ID, transfers: legs, salt, now: block.atMs, maxDeadlineMs: CLAIM_DEADLINE_MS });
  if (problems.length > 0) return { ok: false, detail: `the payload this script built failed its own check: ${problems[0]}` };
  const signature = await signer.sign(payload);
  return { ok: true, signed: { payload, signature, nonce, deadline, intentHash: intentHashOf(payload) }, block };
}

function intentOf(signed: SignedMove): SignedIntent {
  return { standard: ERC191_STANDARD, payload: signed.payload, signature: signed.signature };
}

/* unsigned: nothing was signed. silent: the verifier never answered. refused: it said no. */
type Rehearsal =
  | { ok: true; signed: SignedMove; verifierHash: string | null }
  | { ok: false; why: 'unsigned' | 'silent' | 'refused'; detail: string; signed: SignedMove | null };

/* The move rehearsed (see the header). A node a block behind cannot answer for a block it has not
   seen, so up to three blocks are tried, each rehearsal with a signature of its own; none of them
   can run. */
async function rehearse(move: Move, signer: KeySigner, net: MoneyNet): Promise<Rehearsal> {
  const simulateAt = net.simulateAt;
  if (simulateAt === undefined) return { ok: false, why: 'unsigned', detail: 'this network cannot simulate at a fixed block', signed: null };
  let last: Rehearsal = { ok: false, why: 'unsigned', detail: 'nothing was built', signed: null };
  for (let tries = 0; tries < 3; tries += 1) {
    if (tries > 0) await net.sleep(1_000);
    const built = await signMove(move, signer, net, REHEARSAL_LIFE_MS, REHEARSAL_AHEAD_MS);
    if (!built.ok) return { ok: false, why: 'unsigned', detail: built.detail, signed: null };
    const sim = await simulateAt([intentOf(built.signed)], built.block.hash).catch(() => null);
    if (sim === null) {
      last = { ok: false, why: 'silent', detail: 'the verifier did not answer the simulation', signed: built.signed };
      continue;
    }
    if (!sim.ok) return { ok: false, why: 'refused', detail: `${REFUSALS[simulationVerdict(sim.refusal)]} The verifier said: ${sim.refusal}`, signed: built.signed };
    return { ok: true, signed: built.signed, verifierHash: sim.intentHashes[0] ?? null };
  }
  return last;
}

async function fateOf(move: Move, net: MoneyNet): Promise<'ran' | 'dead' | 'open'> {
  const signed = move.signed!;
  const fate = await transferFate(fateReads(net), { account: move.signer, nonce: signed.nonce, deadline: signed.deadline }, net.now()).catch(() => null);
  if (fate?.ran === true) return 'ran';
  if (fate?.ran === false && fate.dead !== null) return 'dead';
  return 'open';
}

async function watchMove(move: Move, net: MoneyNet): Promise<'ran' | 'dead' | 'unconfirmed'> {
  const started = net.now();
  let delay = net.firstPollMs ?? FIRST_POLL_MS;
  for (;;) {
    const fate = await fateOf(move, net);
    if (fate !== 'open') return fate;
    if (net.now() - started >= MOVE_WATCH_CAP_MS) return 'unconfirmed';
    await net.sleep(delay);
    delay = Math.min(delay * 2, net.pollMs ?? POLL_MS);
  }
}

function trySave(ledger: Ledger): void {
  try {
    ledger.save();
  } catch {
    // The bytes are out already; the next run reads the chain, not this write.
  }
}

/* One move to its end. Unsigned: rehearse, sign, write the signed bytes, publish. The verifier
   saying no ends the move; a rehearsal nobody could sign or answer (no clock, a clock ahead of
   this Mac, a silent RPC) leaves it pending, unsigned, to be tried again, because nothing that
   can run exists. Signed already (a run that stopped): ask the chain first, and resend the same
   bytes only while they can still run. Then watch until the nonce is spent or the move is proven
   dead. The move is in the book and saved at every step the next run would need. */
export async function runMove(ledger: Ledger, move: Move, signer: KeySigner, net: MoneyNet, say: (line: string) => void): Promise<MoveResult> {
  if (move.signed === undefined) {
    const rehearsal = await rehearse(move, signer, net);
    if (!rehearsal.ok && rehearsal.why === 'refused') {
      move.state = 'failed';
      move.settledAt = nowIso(net);
      move.detail = `Nothing that can run was sent: ${rehearsal.detail}.`;
      ledger.save();
      return { kind: 'refused', detail: move.detail };
    }
    const built = rehearsal.ok ? await signMove(move, signer, net, CLAIM_DEADLINE_MS, MOVE_AHEAD_MS) : null;
    if (built === null || !built.ok) {
      ledger.save();
      return { kind: 'held', detail: `Nothing that can run was signed: ${!rehearsal.ok ? rehearsal.detail : built?.ok === false ? built.detail : 'it was not signed'}.` };
    }
    move.signed = built.signed;
    try {
      ledger.save();
    } catch (err) {
      delete move.signed;
      throw new Error(`the invite file could not be written (${errText(err)}), so the signed move was never sent`);
    }
  } else {
    const fate = await fateOf(move, net);
    if (fate !== 'open') return close(ledger, move, fate, net, say);
    say('Signed in an earlier run, and not proven either way yet: sending the same bytes again. It is never signed twice.');
  }

  const signed = move.signed!;
  const sent = await publishWithoutQuote(net.relay, { payload: signed.payload, signature: signed.signature });
  move.sends = (move.sends ?? 0) + sent.attempts;
  const words = sent.answered ? (sent.result.status === 'OK' ? 'OK' : sent.result.reason) : sent.error;
  move.relaySaid = oneLine(words, 200);
  trySave(ledger);
  if (sent.answered && sent.result.status === 'OK') {
    say('The relay took it. Waiting for NEAR Intents to run it.');
  } else if (sent.answered || sent.attempts === 1) {
    say(`The relay turned it away: ${oneLine(words, 160)}. Operator commands have no Plan B, so nothing is signed again.`);
    say('Waiting until the signed move expires on the chain, about two minutes, so the book can say for certain that nothing moved.');
  } else {
    say('The relay did not answer, twice, to the same bytes. They may still run, so this waits for NEAR Intents to say.');
  }
  const verdict = await watchMove(move, net);
  return close(ledger, move, verdict, net, say);
}

async function close(ledger: Ledger, move: Move, verdict: 'ran' | 'dead' | 'unconfirmed', net: MoneyNet, say: (line: string) => void): Promise<MoveResult> {
  if (verdict === 'ran') {
    move.state = 'done';
    move.settledAt = nowIso(net);
    const status = await net.relay.status(move.signed!.intentHash).catch(() => null);
    trySave(ledger);
    say(`NEAR Intents ran it: the nonce is spent (intent ${move.signed!.intentHash}).`);
    return { kind: 'landed', status };
  }
  if (verdict === 'dead') {
    move.state = 'failed';
    move.settledAt = nowIso(net);
    move.detail = 'The signed move passed its deadline with its nonce unspent, on the chain clock: it never ran and never can. Nothing moved.';
    trySave(ledger);
    return { kind: 'dead', detail: move.detail };
  }
  trySave(ledger);
  return { kind: 'unconfirmed', detail: 'NEAR Intents has not answered either way yet. The signed move may still run.' };
}

/* A dry run: the rehearsal alone (see the header). Nothing is published; an issue's codes are
   already in the file, void, so whatever the rehearsal pays has its key on disk. */
async function simulateOnly(move: Move, signer: KeySigner, net: MoneyNet, io: Io, what: string): Promise<number> {
  const rehearsal = await rehearse(move, signer, net);
  if (rehearsal.signed === null) {
    io.say(`Simulate only: ${rehearsal.ok ? '' : rehearsal.detail}, so nothing was signed.`);
    return 1;
  }
  const local = rehearsal.signed.intentHash;
  const legs = move.legs.length;
  const total = move.legs.reduce((sum, l) => sum + BigInt(l.amountBase), 0n);
  io.say(`Simulate only: ${what}, ${legs} transfer${legs === 1 ? '' : 's'} from ${move.signer}, $${formatUsdc(total)} in all, signed with the right key.`);
  if (rehearsal.ok) {
    const named = rehearsal.verifierHash;
    io.say(`The verifier would run it. Intent ${local}${named === null ? '' : named === local ? ', the same hash the verifier gives' : `, but the verifier names it ${named}`}.`);
  } else if (rehearsal.why === 'silent') {
    io.say('The verifier did not answer, at three blocks in a row.');
  } else {
    io.say(`The verifier would refuse it: ${rehearsal.detail}.`);
  }
  io.say(
    `Nothing was published. The signature expired at ${rehearsal.signed.deadline}, one millisecond after a final block stamped at least a second behind this Mac's clock, so while this clock is right no block can run it.`,
  );
  if (move.dryRun === true) {
    io.say(`Its ${legs} code${legs === 1 ? ' is' : 's are'} in the invite file as void, never handed out, so a reclaim would take back anything that ever reached ${legs === 1 ? 'it' : 'them'}.`);
  }
  return rehearsal.ok ? 0 : 1;
}

// ---------------------------------------------------------------------------------------------
// Issue

export type IssueRequest = { count: number; amountBase: bigint; label: string; simulateOnly: boolean };

function mintCodes(book: InviteBook, count: number, amountBase: bigint, label: string, batch: string, net: MoneyNet): InviteCode[] {
  const taken = new Set([book.treasury.address, ...book.codes.map((c) => c.address)]);
  const out: InviteCode[] = [];
  const createdAt = nowIso(net);
  while (out.length < count) {
    const secret = generateSecret(net.random);
    const code = formatCode(secret);
    const address = codeAddress(secret);
    secret.fill(0);
    if (address === null || taken.has(address)) continue;
    taken.add(address);
    out.push({ code, address, label, amountBase: amountBase.toString(), batch, state: 'pending', createdAt });
  }
  return out;
}

export async function issueBatch(ledger: Ledger, net: MoneyNet, req: IssueRequest, io: Io): Promise<number> {
  const book = ledger.book;
  if (!Number.isInteger(req.count) || req.count < 1 || req.count > MAX_TRANSFERS) {
    io.say(`A batch is 1 to ${MAX_TRANSFERS} codes: one signed payload carries at most ${MAX_TRANSFERS} transfers.`);
    return 2;
  }
  if (req.amountBase < MIN_CLAIM_BASE) {
    io.say('A code holds at least $0.01: the app reads anything less as empty.');
    return 2;
  }
  const label = req.label.trim();
  if (label === '' || label.length > 60 || /[\u0000-\u001f\u007f]/.test(label)) {
    io.say('Give the batch a label of 1 to 60 plain characters, like --label "SF builders".');
    return 2;
  }
  const waiting = unfinishedBatch(book);
  if (waiting !== undefined) {
    io.say(`A batch is still pending: "${waiting.label ?? ''}", ${codesOf(book, waiting.id).length} codes, started ${waiting.createdAt}.`);
    io.say('A new batch cannot start until it ends. Run `npm run invite -- issue --resume` to finish it. Nothing was written or signed.');
    return 1;
  }

  const total = req.amountBase * BigInt(req.count);
  const plural = req.count === 1 ? '' : 's';
  if (!req.simulateOnly) {
    const held = await net.verifier.balance(book.treasury.address, INVITE_ASSET_ID).catch(() => null);
    if (held === null) {
      io.say("Couldn't read T's balance, so nothing was written or signed. Check the connection and run it again.");
      return 1;
    }
    if (held < total) {
      /* Money that came as another USDC is said exactly, and where it goes from here. Never
         converted here: issue does not talk to 1Click, `convert` does, after its own yes. */
      const other = (await otherUsdc(net, book.treasury.address)).held;
      const otherBase = other.reduce((sum, h) => sum + asInviteBase(h.base, h.variant.decimals), 0n);
      io.say(`T holds $${formatUsdc(held)}${other.length > 0 ? ' of NEAR USDC' : ''} and this batch needs $${formatUsdc(total)}. Nothing was written or signed.`);
      if (other.length > 0) {
        io.say(`T also holds ${heldList(other)} inside NEAR Intents, and a code holds NEAR USDC only. Run \`npm run invite -- convert\` to turn it into NEAR USDC through 1Click, then run this again.`);
      }
      if (held + otherBase < total) {
        io.say(`Send at least $${fundingFor(total - held - otherBase)}${other.length > 0 ? ' more' : ''} to T, ${book.treasury.address}, with the app's Send, then run this again.`);
      }
      return 1;
    }
    const ok = await io.confirm(`Issue ${req.count} code${plural} of $${formatUsdc(req.amountBase)} for "${label}", $${formatUsdc(total)} in all, from T (holds $${formatUsdc(held)})?`);
    if (!ok) {
      io.say('Stopped. Nothing was written or signed.');
      return 1;
    }
  }

  const id = idOf(net);
  const codes = mintCodes(book, req.count, req.amountBase, label, id, net);
  const move: Move = {
    id,
    kind: 'batch',
    signer: book.treasury.address,
    legs: codes.map((c) => ({ receiverId: c.address, amountBase: c.amountBase })),
    state: 'pending',
    createdAt: nowIso(net),
    label,
  };
  if (req.simulateOnly) {
    /* The rehearsal pays these codes, so they go to the file first, void and marked a dry run: if
       an RPC ever ran the rehearsal anyway (see the header), the money sits on codes whose keys are
       on disk, and reclaim takes it back. Nothing that can run is signed until they are. */
    const at = nowIso(net);
    for (const c of codes) {
      c.state = 'void';
      c.closedAt = at;
    }
    Object.assign(move, { state: 'failed', settledAt: at, dryRun: true, detail: 'A dry run (--simulate-only): rehearsed and never published.' });
    book.codes.push(...codes);
    book.moves.push(move);
    try {
      ledger.save();
    } catch (err) {
      book.codes.splice(book.codes.length - codes.length, codes.length);
      book.moves.pop();
      io.say(`Couldn't write the invite file (${errText(err)}), so nothing was signed.`);
      return 1;
    }
    const signer = treasurySigner(book, net);
    try {
      return await simulateOnly(move, signer, net, io, `a batch of ${req.count} code${plural} at $${formatUsdc(req.amountBase)}`);
    } finally {
      signer.drop();
    }
  }

  // The codes go to disk, pending, before anything is signed: a crash from here on loses nothing.
  book.codes.push(...codes);
  book.moves.push(move);
  try {
    ledger.save();
  } catch (err) {
    book.codes.splice(book.codes.length - codes.length, codes.length);
    book.moves.pop();
    io.say(`Couldn't write the invite file (${errText(err)}), so nothing was signed.`);
    return 1;
  }
  io.say(`${req.count} code${plural} written to the invite file, pending. Signing one payload from T.`);
  return finishBatch(ledger, move, net, io);
}

/* A batch from wherever it stopped: unsigned (sign it now, for the first time), signed and not
   proven (the same bytes again), proven (read the codes back and show the links once). */
export async function resumeBatch(ledger: Ledger, net: MoneyNet, io: Io): Promise<number> {
  const move = unfinishedBatch(ledger.book);
  if (move === undefined) {
    io.say('No batch is pending.');
    return 0;
  }
  io.say(`Finishing the batch "${move.label ?? ''}" from ${move.createdAt}, ${codesOf(ledger.book, move.id).length} codes.`);
  if (move.state === 'pending' && move.signed === undefined) io.say('It was never signed, so nothing left this Mac. Signing it now.');
  return finishBatch(ledger, move, net, io);
}

// Reading a funded code back: NEAR Intents is behind a load-balanced RPC, and a node a block
// behind the one that ran the batch still shows the code empty.
const READBACK_TRIES = 4;
const READBACK_GAP_MS = 1_500;

function voidPending(ledger: Ledger, move: Move, net: MoneyNet): number {
  const codes = codesOf(ledger.book, move.id);
  for (const c of codes) {
    if (c.state === 'pending') {
      c.state = 'void';
      c.closedAt = nowIso(net);
    }
  }
  ledger.save();
  return codes.length;
}

/* Before a batch's one signature: its codes are new, so they hold nothing. Money on one means the
   batch already ran, from another copy of the invite file (an older one put back), and signing
   again would pay every code twice. */
async function freshCodesProblem(ledger: Ledger, move: Move, net: MoneyNet): Promise<string | null> {
  const codes = codesOf(ledger.book, move.id);
  if (codes.some((c) => c.state !== 'pending')) return 'handled';
  const reclaiming = new Set(pendingMoves(ledger.book, 'reclaim').map((m) => m.signer));
  if (codes.some((c) => reclaiming.has(c.address))) {
    return 'A reclaim of one of these codes is still waiting for proof, so nothing was signed. Run `npm run invite -- reclaim` to finish it, then `issue --resume`.';
  }
  const held = await Promise.all(codes.map((c) => net.verifier.balance(c.address, INVITE_ASSET_ID).catch(() => null)));
  if (held.some((h) => h === null)) return "Couldn't read the new codes' balances, so nothing was signed. Check the connection and run it again.";
  const funded = held.filter((h) => h !== null && h > 0n).length;
  if (funded === 0) return null;
  return (
    `${funded} code${funded === 1 ? '' : 's'} of this batch already hold${funded === 1 ? 's' : ''} money, so it may have run from another copy of the invite file. ` +
    `Nothing was signed. \`npm run invite -- reclaim --label "${move.label ?? ''}"\` takes that money back to T; then \`issue --resume\` closes the batch.`
  );
}

async function finishBatch(ledger: Ledger, move: Move, net: MoneyNet, io: Io): Promise<number> {
  const book = ledger.book;
  if (move.state === 'pending' && move.signed === undefined) {
    const problem = await freshCodesProblem(ledger, move, net);
    if (problem === 'handled') {
      // A reclaim already took back money that reached these codes from elsewhere; this batch is over.
      move.state = 'failed';
      move.settledAt = nowIso(net);
      move.detail = 'Never signed: its codes were reclaimed after money reached them from another copy of the invite file.';
    } else if (problem !== null) {
      io.say(problem);
      return 1;
    }
  }
  if (move.state === 'pending') {
    const signer = treasurySigner(book, net);
    let result: MoveResult;
    try {
      result = await runMove(ledger, move, signer, net, io.say);
    } finally {
      signer.drop();
    }
    if (result.kind === 'unconfirmed') {
      io.say(`${result.detail} Run \`npm run invite -- issue --resume\` in a few minutes to finish it. A new batch waits until then.`);
      return 1;
    }
    if (result.kind === 'held') {
      io.say(`${result.detail} The batch stays pending: run \`npm run invite -- issue --resume\` once that is fixed. A new batch waits until then.`);
      return 1;
    }
    if (result.kind !== 'landed') io.say(result.detail);
  }
  if (move.state === 'failed') {
    const count = voidPending(ledger, move, net);
    io.say(`T still holds the money. The ${count} codes of this batch were never funded and are void: there is nothing to hand out.`);
    return 1;
  }
  return openCodes(ledger, move, net, io);
}

/* The batch ran (its nonce is spent), so every code was paid in the same call. Each is read back
   until it shows at least what it was paid, a few times, because a node a block behind still shows
   it empty; only then are the links shown, all at once and once. A code that will not read funded
   keeps the batch open, so `issue --resume` reads again, and its link is never held back for good. */
async function openCodes(ledger: Ledger, move: Move, net: MoneyNet, io: Io): Promise<number> {
  const book = ledger.book;
  const codes = codesOf(book, move.id);
  let waiting = codes.filter((c) => c.state === 'pending');
  for (let tries = 0; tries < READBACK_TRIES && waiting.length > 0; tries += 1) {
    if (tries > 0) await net.sleep(READBACK_GAP_MS);
    const still: InviteCode[] = [];
    for (const c of waiting) {
      const held = await net.verifier.balance(c.address, INVITE_ASSET_ID).catch(() => null);
      if (held !== null && held >= BigInt(c.amountBase)) {
        c.state = 'open';
        c.openedAt = nowIso(net);
      } else {
        still.push(c);
      }
    }
    waiting = still;
  }
  ledger.save();
  if (waiting.length > 0) {
    io.say(`NEAR Intents ran the batch, but ${waiting.length} code${waiting.length === 1 ? ' does' : 's do'} not read funded yet, so the links wait until every code does.`);
    io.say('Run `npm run invite -- issue --resume` in a minute to read them again.');
    return 1;
  }
  if (move.printedAt === undefined) {
    const shown = codes.filter((c) => c.state === 'open');
    const lines = shown.map((c, i) => `${String(i + 1).padStart(3)}  ${shortAddress(c.address)}  ${inviteLink(c.code)}`);
    io.reveal(
      [
        '',
        `"${move.label ?? ''}": ${shown.length} invite link${shown.length === 1 ? '' : 's'} of $${formatUsdc(BigInt(codes[0]?.amountBase ?? '0'))}. They are shown this once; copy them now.`,
        ...lines,
        'One link to one person. Never post them. The invite file keeps them, encrypted.',
        '',
      ].join('\n'),
    );
    move.printedAt = nowIso(net);
    ledger.save();
  }
  io.say(`Done. ${codes.length} code${codes.length === 1 ? ' is' : 's are'} open. \`npm run invite -- status\` shows them, never the codes.`);
  return 0;
}

// ---------------------------------------------------------------------------------------------
// Reclaim

export type ReclaimRequest = { label?: string; address?: string; simulateOnly: boolean };

async function closeCode(ledger: Ledger, code: InviteCode, result: MoveResult, net: MoneyNet, io: Io): Promise<boolean> {
  if (result.kind === 'landed') {
    // The reclaim emptied the code; money on it now came after, and stays reclaimable.
    const after = await net.verifier.balance(code.address, INVITE_ASSET_ID).catch(() => null);
    if (after !== null && after >= MIN_CLAIM_BASE) {
      io.say(`${shortAddress(code.address)}: its reclaim ran, and it holds $${formatUsdc(after)} again since. Left as ${code.state}; run reclaim again to take that back.`);
      return false;
    }
    code.state = 'reclaimed';
    code.closedAt = nowIso(net);
    ledger.save();
    io.say(`${shortAddress(code.address)}: reclaimed to T. Its link now says it was already used.`);
    return true;
  }
  if (result.kind === 'unconfirmed' || result.kind === 'held') {
    io.say(`${shortAddress(code.address)}: ${result.detail} Run reclaim again ${result.kind === 'held' ? 'once that is fixed' : 'in a few minutes'} to finish it.`);
    return false;
  }
  // Nothing moved. The holder may have claimed it in the same minute.
  const held = await net.verifier.balance(code.address, INVITE_ASSET_ID).catch(() => null);
  if (code.state === 'open' && held !== null && held < MIN_CLAIM_BASE) {
    code.state = 'claimed';
    code.closedAt = nowIso(net);
    ledger.save();
    io.say(`${shortAddress(code.address)}: claimed by its holder first. Nothing to reclaim.`);
    return true;
  }
  io.say(`${shortAddress(code.address)}: not reclaimed. ${result.detail}`);
  return false;
}

export async function reclaimCodes(ledger: Ledger, net: MoneyNet, req: ReclaimRequest, io: Io): Promise<number> {
  const book = ledger.book;
  let failures = 0;

  if (!req.simulateOnly) {
    for (const move of pendingMoves(book, 'reclaim')) {
      const code = book.codes.find((c) => c.address === move.signer);
      if (code === undefined) continue;
      io.say(`Finishing the reclaim of ${shortAddress(code.address)} from an earlier run.`);
      const signer = signerForCode(code, net);
      try {
        if (!(await closeCode(ledger, code, await runMove(ledger, move, signer, net, io.say), net, io))) failures += 1;
      } finally {
        signer.drop();
      }
    }
  }

  /* Open codes, and any code money reached although no signature of this book can still fund it:
     a void code, or a pending code of a batch never signed (both hold nothing unless something
     outside this book paid them). A code with a reclaim still waiting for proof is left to it. */
  const busy = new Set(pendingMoves(book, 'reclaim').map((m) => m.signer));
  const unsigned = new Set(book.moves.filter((m) => m.kind === 'batch' && m.state === 'pending' && m.signed === undefined).map((m) => m.id));
  let chosen = book.codes.filter((c) => !busy.has(c.address) && (c.state === 'open' || c.state === 'void' || (c.state === 'pending' && unsigned.has(c.batch))));
  if (req.label !== undefined) chosen = chosen.filter((c) => c.label === req.label);
  if (req.address !== undefined) {
    const wanted = req.address.trim().toLowerCase();
    chosen = chosen.filter((c) => c.address === wanted);
  }
  if (chosen.length === 0) {
    io.say(req.label === undefined && req.address === undefined ? 'No code is open. Nothing to reclaim.' : 'No open code matches. Nothing to reclaim.');
    return failures > 0 ? 1 : 0;
  }

  const plan: Array<{ code: InviteCode; held: bigint }> = [];
  for (const code of chosen) {
    const [held, locked] = await Promise.all([
      net.verifier.balance(code.address, INVITE_ASSET_ID).catch(() => null),
      net.verifier.accountLocked === undefined ? Promise.resolve(null) : net.verifier.accountLocked(code.address).catch(() => null),
    ]);
    if (held === null) {
      io.say(`${shortAddress(code.address)}: couldn't read its balance. Left as it is.`);
      failures += 1;
    } else if (held < MIN_CLAIM_BASE) {
      if (code.state !== 'open') continue;
      if (!req.simulateOnly) {
        code.state = 'claimed';
        code.closedAt = nowIso(net);
      }
      io.say(`${shortAddress(code.address)}: claimed (it holds under a cent).`);
    } else if (locked === true) {
      io.say(`${shortAddress(code.address)}: NEAR Intents has locked this account, so it cannot pay out.`);
      failures += 1;
    } else {
      plan.push({ code, held });
    }
  }
  if (!req.simulateOnly) ledger.save();
  if (plan.length === 0) {
    if (failures === 0 && chosen.every((c) => c.state !== 'open' && c.state !== 'claimed')) io.say('No code holds money to reclaim.');
    return failures > 0 ? 1 : 0;
  }

  const total = plan.reduce((sum, p) => sum + p.held, 0n);
  if (!req.simulateOnly) {
    const ok = await io.confirm(`Reclaim ${plan.length} code${plan.length === 1 ? '' : 's'}, $${formatUsdc(total)} in all, back to T? Their links stop working.`);
    if (!ok) {
      io.say('Stopped. Nothing was signed.');
      return 1;
    }
  }

  for (const { code, held } of plan) {
    const move: Move = {
      id: idOf(net),
      kind: 'reclaim',
      signer: code.address,
      legs: [{ receiverId: book.treasury.address, amountBase: held.toString() }],
      state: 'pending',
      createdAt: nowIso(net),
      label: code.label,
    };
    const signer = signerForCode(code, net);
    try {
      if (req.simulateOnly) {
        if ((await simulateOnly(move, signer, net, io, `a reclaim of ${shortAddress(code.address)}`)) !== 0) failures += 1;
        continue;
      }
      book.moves.push(move);
      if (!(await closeCode(ledger, code, await runMove(ledger, move, signer, net, io.say), net, io))) failures += 1;
    } finally {
      signer.drop();
    }
  }
  return failures > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------
// Withdraw

export type WithdrawRequest = { to: string; simulateOnly: boolean };

// The first six and the last six hex characters of a hex address (after any 0x), or null for a
// NEAR name, which is typed whole.
function addressEnds(to: string): string | null {
  const body = to.startsWith('0x') ? to.slice(2) : to;
  return /^[0-9a-f]{13,}$/.test(body) ? body.slice(0, 6) + body.slice(-6) : null;
}

/* T to a typed address. Never the keystore header: that header is plaintext and any process running
   as Karim can edit it (src/keystore/store.ts). The address is copied from the app's Receive
   screen, which serves only a decrypted, untampered address, and its first six and last six
   characters are typed back here, read off that screen, before anything is signed: 48 bits where
   the last six alone were 24, which a program swapping the clipboard can match with a look-alike
   it grinds in seconds (audit L8). */
export async function withdrawTreasury(ledger: Ledger, net: MoneyNet, req: WithdrawRequest, io: Io): Promise<number> {
  const book = ledger.book;
  if (!req.simulateOnly) {
    const left = pendingMoves(book, 'withdraw');
    for (const move of left) {
      io.say(`Finishing a withdraw to ${move.legs[0]?.receiverId ?? ''} from an earlier run.`);
      const signer = treasurySigner(book, net);
      try {
        const result = await runMove(ledger, move, signer, net, io.say);
        if (result.kind !== 'landed') {
          io.say(result.kind === 'unconfirmed' || result.kind === 'held' ? `${result.detail} Run withdraw again in a few minutes.` : result.detail);
          return 1;
        }
      } finally {
        signer.drop();
      }
    }
    if (left.length > 0) {
      io.say('That withdraw is done. Run withdraw again for anything T holds now.');
      return 0;
    }
  }
  if (unfinishedBatch(book) !== undefined) {
    io.say('A batch is still pending, and a withdraw now would take the money it is about to pay. Run `npm run invite -- issue --resume` first.');
    return 1;
  }
  const checked = intentsAccountProblem(req.to);
  if (!checked.ok) {
    io.say(`That address can't be used: ${checked.problem}. Nothing was signed.`);
    return 2;
  }
  const to = checked.id;
  if (to === book.treasury.address || book.codes.some((c) => c.address === to)) {
    io.say('That is an invite account, not your wallet. Copy the address from Receive in the app. Nothing was signed.');
    return 2;
  }
  const ends = addressEnds(to);
  const typed = await io.ask(
    ends === null
      ? "Type the whole address shown on Phosphor's Receive screen: "
      : `Type the first six and the last six characters of the address on Phosphor's Receive screen${to.startsWith('0x') ? ', after the 0x' : ''}: `,
  );
  if (typed === null) {
    io.say('Stopped. Nothing was signed.');
    return 1;
  }
  const said = typed.trim().toLowerCase();
  if (ends === null ? said !== to : said.replace(/^0x/, '').replace(/[^0-9a-f]/g, '') !== ends) {
    io.say(`Those characters do not match ${to}. Nothing was signed. Copy the address from Receive in the app again.`);
    return 1;
  }
  const held = await net.verifier.balance(book.treasury.address, INVITE_ASSET_ID).catch(() => null);
  if (held === null) {
    io.say("Couldn't read T's balance, so nothing was signed. Check the connection and run it again.");
    return 1;
  }
  if (held === 0n) {
    io.say('T holds nothing. Nothing to withdraw.');
    return 0;
  }
  if (!req.simulateOnly && !(await io.confirm(`Send $${formatUsdc(held)} from T to ${to}?`))) {
    io.say('Stopped. Nothing was signed.');
    return 1;
  }
  const move: Move = {
    id: idOf(net),
    kind: 'withdraw',
    signer: book.treasury.address,
    legs: [{ receiverId: to, amountBase: held.toString() }],
    state: 'pending',
    createdAt: nowIso(net),
  };
  const signer = treasurySigner(book, net);
  try {
    if (req.simulateOnly) return await simulateOnly(move, signer, net, io, `a withdraw of $${formatUsdc(held)} to ${to}`);
    book.moves.push(move);
    const result = await runMove(ledger, move, signer, net, io.say);
    if (result.kind === 'landed') {
      io.say(`Done. $${formatUsdc(held)} went from T to ${to}.`);
      return 0;
    }
    io.say(result.kind === 'unconfirmed' || result.kind === 'held' ? `${result.detail} Run withdraw again in a few minutes to finish it.` : result.detail);
    return 1;
  } finally {
    signer.drop();
  }
}

// ---------------------------------------------------------------------------------------------
// Sweep (the proof script's throwaway accounts)

/* Everything one account holds, to one address, with that account's own key. */
export async function sweepAccount(ledger: Ledger, net: MoneyNet, signer: KeySigner, to: string, io: Io): Promise<{ result: MoveResult | null; amountBase: bigint | null; intentHash: string | null }> {
  const held = await net.verifier.balance(signer.address, INVITE_ASSET_ID).catch(() => null);
  if (held === null) {
    io.say(`${shortAddress(signer.address)}: couldn't read its balance. Left as it is.`);
    return { result: null, amountBase: null, intentHash: null };
  }
  if (held === 0n) return { result: null, amountBase: 0n, intentHash: null };
  const move: Move = {
    id: idOf(net),
    kind: 'sweep',
    signer: signer.address,
    legs: [{ receiverId: to, amountBase: held.toString() }],
    state: 'pending',
    createdAt: nowIso(net),
  };
  ledger.book.moves.push(move);
  const result = await runMove(ledger, move, signer, net, io.say);
  return { result, amountBase: held, intentHash: move.signed?.intentHash ?? null };
}

// ---------------------------------------------------------------------------------------------
// Status

/* Labels, code addresses, amounts and states, and T's balance. Never a code. An open code that
   reads under a cent is shown claimed: a claimed code and a reclaimed one both read 0 on-chain,
   and only the book knows which one it reclaimed. */
export async function statusLines(book: InviteBook, net: MoneyNet): Promise<string[]> {
  const out: string[] = [];
  const held = await net.verifier.balance(book.treasury.address, INVITE_ASSET_ID).catch(() => null);
  out.push(`Treasury T  ${book.treasury.address}  ${held === null ? 'balance unread' : `$${formatUsdc(held)}`}`);
  const other = (await otherUsdc(net, book.treasury.address)).held;
  if (other.length > 0) out.push(`T also holds ${heldList(other)} inside NEAR Intents. \`npm run invite -- convert\` turns it into NEAR USDC, which codes hold.`);
  const batches = book.moves.filter((m) => m.kind === 'batch');
  if (batches.length === 0) out.push('No codes issued yet.');
  for (const batch of batches) {
    const codes = codesOf(book, batch.id);
    out.push('');
    const when = batch.dryRun === true ? `a dry run on ${batch.createdAt.slice(0, 10)}, never published` : `issued ${batch.createdAt.slice(0, 10)}${batch.state === 'failed' ? ', never funded' : ''}`;
    out.push(`"${batch.label ?? ''}"  ${codes.length} code${codes.length === 1 ? '' : 's'}, ${when}`);
    for (const code of codes) {
      let state: string = code.state;
      if (code.state === 'open') {
        const left = await net.verifier.balance(code.address, INVITE_ASSET_ID).catch(() => null);
        state = left === null ? 'open (balance unread)' : left < MIN_CLAIM_BASE ? 'claimed' : 'open';
      } else if (code.state === 'void' || code.state === 'pending') {
        // These hold nothing unless money reached them from outside this book: say so, and how.
        const left = await net.verifier.balance(code.address, INVITE_ASSET_ID).catch(() => null);
        if (left !== null && left >= MIN_CLAIM_BASE) state = `${state}, holds $${formatUsdc(left)}${code.state === 'void' ? ': reclaim takes it back' : ''}`;
      }
      if (pendingMoves(book, 'reclaim').some((m) => m.signer === code.address)) state = `${state}, reclaim pending`;
      out.push(`  ${code.address}  $${formatUsdc(BigInt(code.amountBase))}  ${state}`);
    }
  }
  const waiting = book.moves.filter((m) => m.state === 'pending' && m.kind !== 'batch');
  for (const move of waiting) out.push(`A ${move.kind} from ${shortAddress(move.signer)} waits for proof: run ${move.kind} again to finish it.`);
  const batch = unfinishedBatch(book);
  if (batch !== undefined) out.push(`The batch "${batch.label ?? ''}" is pending: run \`npm run invite -- issue --resume\` to finish it.`);
  return out;
}
