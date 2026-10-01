// The invite routes checked with real money, the spec's Proof step 0 as a script anyone can rerun
// with their own funds (docs/superpowers/specs/2026-10-01-invite-codes-design.md, "Proof"):
// fund a throwaway treasury, issue two $0.10 codes in one payload, claim the first through the
// solver relay with no quote and the second through Plan B, 1Click, to a throwaway receiver, and
// write down what NEAR Intents says about each: the intent hashes, is_nonce_used, every balance
// before and after, and get_status. Then sweep every leftover cent to an address of your choice.
// It can also issue one $5 code for the release proof and print it once.
//
//   node scripts/invite-proof.ts init --file <path>
//   node scripts/invite-proof.ts run --file <path> [--amount 0.10] [--wait-minutes 30]
//   node scripts/invite-proof.ts report --file <path>
//   node scripts/invite-proof.ts sweep --file <path> --to <address>
//   node scripts/invite-proof.ts release-code --file <path> [--amount 5] [--wait-minutes 30]
//
// THE PROOF FILE HOLDS KEYS IN THE CLEAR. It is a non-interactive script, so there is no
// passphrase: the throwaway treasury's key, the receiver's key and the codes sit in a 0600 file at
// the path you pass, which must be outside the working copy (the repo is public). Put in it only
// what you are ready to lose (the proof needs $1), sweep it when you are done, then delete it. It
// never opens the operator's invite file.
//
// The claims are the app's own: the same claim service the window calls (src/invite/claim.ts),
// handed a wallet that is the throwaway receiver. Plan B is reached the way an installed app
// reaches it: the relay turns the claim away for auth. Here the script itself turns the send away,
// before it leaves this machine, so the second claim takes the 1Click route on its own. 1Click
// gets the partner key in PHOSPHOR_1CLICK_API_KEY when one is set, as the app does; without one it
// runs on the public fee tier (src/rails/intents-native.ts, INTENTS_NO_API_KEY_REASON).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { getAddress } from 'viem';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { resolveReal } from '../src/config.ts';
import { atomicWrite } from '../src/fsatomic.ts';
import { decimalToBaseUnits } from '../src/intents.ts';
import { createInviteService } from '../src/invite/claim.ts';
import type { InviteService } from '../src/invite/claim.ts';
import { containsInviteCode, deriveKey, parseCode } from '../src/invite/code.ts';
import { INVITE_ASSET_DECIMALS, INVITE_ASSET_ID, formatUsdc } from '../src/invite/payload.ts';
import { keySigner } from '../src/invite/signer.ts';
import type { KeySigner } from '../src/invite/signer.ts';
import type { ClaimRecord, ClaimRoute, ClaimStore } from '../src/invite/store.ts';
import { INTENTS_API_KEY_ENV, intentsApi } from '../src/rails/intents-native.ts';
import type { IntentsApiPort } from '../src/rails/intents-native.ts';
import { intentsAccountProblem } from '../src/rails/intents-send.ts';
import { RELAY_URL, relayClient } from '../src/relay/client.ts';
import type { RelayClient } from '../src/relay/client.ts';
import { liveVerifier } from '../src/relay/verifier.ts';
import { newBook, pendingMoves, readBook, unfinishedBatch } from './invite/book.ts';
import { takeLock } from './invite/file.ts';
import type { FileLock } from './invite/file.ts';
import type { InviteBook } from './invite/book.ts';
import { issueBatch, liveSimulateAt, newTreasury, resumeBatch, runMove, shortAddress, sweepAccount } from './invite/money.ts';
import type { Io, Ledger, MoneyNet } from './invite/money.ts';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const PROOF_KIND = 'phosphor-invite-proof';
export const PROOF_LABEL = 'proof step 0';
export const RELEASE_LABEL = 'release proof';
const PROOF_CODE_DOLLARS = '0.10';
const PROOF_CODES = 2;
const FUNDING_POLL_MS = 10_000;
const DEFAULT_WAIT_MINUTES = 30;

export type ProofNet = MoneyNet & {
  oneclick?: IntentsApiPort; // a test's 1Click; live, one is built with the partner key
  quoteKey?: string; // a test's 1Click quote key; live, the app's own
};

type Amount = string | null; // base units, or null when the read did not answer

export type ClaimProof = {
  route: ClaimRoute; // the route this step proves
  codeAddress: string;
  amountBase: string;
  startedAt: string;
  before: { code: Amount; receiver: Amount };
  claim?: string;
  record?: ClaimRecord; // the app's own record: every attempt's nonce, deadline and intent hash
  after?: { code: Amount; receiver: Amount };
  nonces?: Array<{ route: ClaimRoute; nonce: string; intentHash: string; isNonceUsed: boolean | null }>;
  relayStatus?: Array<{ intentHash: string; answer: unknown }>; // get_status, per attempt
  oneclickStatus?: unknown; // Plan B: 1Click's status by its deposit address
  audit?: Array<{ type: string; msg: string; data: unknown }>;
  frames?: unknown[];
  pass?: boolean;
  why?: string;
};

export type ProofResults = {
  funding?: { treasuryBefore: string; seenAt: string };
  issue?: {
    treasuryBefore: Amount;
    startedAt: string;
    relaySaid?: string; // the relay's answer to the batch, its own words
    move?: string;
    intentHash?: string;
    nonce?: string;
    sends?: number;
    isNonceUsed?: boolean | null;
    treasuryAfter?: Amount;
    codes?: Array<{ address: string; amountBase: string; after: Amount }>;
    relayStatus?: unknown;
    pass?: boolean;
    why?: string;
  };
  relayClaim?: ClaimProof;
  planBClaim?: ClaimProof;
  sweep?: Array<{ from: string; to: string; amountBase: Amount; outcome: string; intentHash: string | null; at: string }>;
  releaseCode?: { address: string; amountBase: string; issuedAt: string };
};

export type ProofFile = {
  kind: typeof PROOF_KIND;
  version: 1;
  createdAt: string;
  book: InviteBook;
  receiver: { address: string; key: Hex };
  claims: ClaimRecord[];
  results: ProofResults;
};

export type ProofDeps = {
  out: (line: string) => void;
  err: (line: string) => void;
  env: NodeJS.ProcessEnv;
  repoRoot?: string;
  net: () => ProofNet;
};

export const USAGE = [
  'Usage:',
  '  node scripts/invite-proof.ts init --file <path outside the repo>',
  '  node scripts/invite-proof.ts run --file <path> [--amount 0.10] [--wait-minutes 30]',
  '  node scripts/invite-proof.ts report --file <path>',
  '  node scripts/invite-proof.ts sweep --file <path> --to <address>',
  '  node scripts/invite-proof.ts release-code --file <path> [--amount 5] [--wait-minutes 30]',
].join('\n');

function proofPath(flag: unknown, repoRoot: string): string {
  if (typeof flag !== 'string' || flag.trim() === '') throw new Error('Name the proof file with --file <path>, outside the repo.');
  const file = path.resolve(flag);
  const rel = path.relative(resolveReal(repoRoot), resolveReal(file));
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    throw new Error(`The proof file holds keys in the clear, so it must sit outside the repo working copy (got ${file}).`);
  }
  return file;
}

function saveProof(file: string, proof: ProofFile): void {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  atomicWrite(file, `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 });
}

function loadProof(file: string): ProofFile {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new Error(`There is no proof file at ${file}. Run init first.`);
  }
  if ((stat.mode & 0o077) !== 0) throw new Error(`${file} can be read by others (mode ${(stat.mode & 0o777).toString(8)}). It holds keys: chmod 600 it, then run this again.`);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  if (raw['kind'] !== PROOF_KIND || raw['version'] !== 1) throw new Error(`${file} is not a proof file this script wrote.`);
  const receiver = raw['receiver'] as { address?: unknown; key?: unknown } | undefined;
  if (typeof receiver?.key !== 'string' || !/^0x[0-9a-f]{64}$/.test(receiver.key) || privateKeyToAccount(receiver.key as Hex).address.toLowerCase() !== receiver.address) {
    throw new Error("the proof file's receiver key is not its receiver's");
  }
  if (!Array.isArray(raw['claims']) || raw['results'] === null || typeof raw['results'] !== 'object') throw new Error('the proof file is missing its claims or results');
  return {
    kind: PROOF_KIND,
    version: 1,
    createdAt: String(raw['createdAt']),
    book: readBook(raw['book']),
    receiver: { address: receiver.address as string, key: receiver.key as Hex },
    claims: raw['claims'] as ClaimRecord[],
    results: raw['results'] as ProofResults,
  };
}

function amountOf(value: bigint | null): Amount {
  return value === null ? null : value.toString();
}

async function balanceOf(net: ProofNet, account: string): Promise<Amount> {
  return amountOf(await net.verifier.balance(account, INVITE_ASSET_ID).catch(() => null));
}

function quietIo(deps: ProofDeps, reveal: (text: string) => void = () => {}): Io {
  return { say: deps.out, confirm: async () => true, ask: async () => null, reveal };
}

/* The report, with nothing that spends anything: no key and no code. Refused rather than printed
   if either got in. */
function reportOf(proof: ProofFile): string {
  const text = JSON.stringify(
    { network: { verifier: 'intents.near', relay: RELAY_URL, asset: INVITE_ASSET_ID }, treasury: proof.book.treasury.address, receiver: proof.receiver.address, results: proof.results },
    null,
    2,
  );
  const keys = [proof.book.treasury.key, proof.receiver.key].map((k) => k.slice(2));
  if (containsInviteCode(text) || keys.some((k) => text.includes(k)) || proof.book.codes.some((c) => text.includes(c.code))) {
    throw new Error('the report would carry a key or a code, so it is not printed');
  }
  return text;
}

async function waitForTreasury(net: ProofNet, address: string, needed: bigint, waitMs: number, deps: ProofDeps): Promise<bigint | null> {
  const started = net.now();
  let said = false;
  for (;;) {
    const held = await net.verifier.balance(address, INVITE_ASSET_ID).catch(() => null);
    if (held !== null && held >= needed) return held;
    if (!said) {
      deps.out(`Waiting for T, ${address}, to hold at least $${formatUsdc(needed)}. It holds ${held === null ? 'an amount this run could not read' : `$${formatUsdc(held)}`} now.`);
      said = true;
    }
    if (net.now() - started >= waitMs) return null;
    await net.sleep(FUNDING_POLL_MS);
  }
}

/* The relay as an installed app sees it on the day it starts enforcing its JWT: a 401 on the first
   send. Nothing is sent; the claim service falls back to 1Click on its own (relayRefusalFallsBack). */
export function refusingRelay(relay: RelayClient): RelayClient {
  return {
    ...relay,
    async publishIntent() {
      throw new Error('relay publish_intent failed: 401 unauthorized. The proof script turned this send away before it left this machine, so the claim takes Plan B.');
    },
  };
}

type Sink = { audit: Array<{ type: string; msg: string; data: unknown }>; frames: unknown[] };

function claimService(proof: ProofFile, file: string, net: ProofNet, api: IntentsApiPort, sink: Sink, forcePlanB: boolean): InviteService {
  const store: ClaimStore = {
    all: () => proof.claims.map((r) => structuredClone(r)),
    get: (claim) => proof.claims.find((r) => r.claim === claim),
    put(record) {
      proof.claims = [...proof.claims.filter((r) => r.claim !== record.claim), structuredClone(record)];
      saveProof(file, proof);
    },
  };
  const wallet = getAddress(proof.receiver.address);
  return createInviteService({
    dataDir: path.dirname(file),
    movesMoney: true,
    audit: {
      append(type, msg, data) {
        sink.audit.push({ type, msg, data });
        return { ts: new Date(net.now()).toISOString(), type, msg, data };
      },
    },
    keystore: {
      state: () => 'unlocked',
      addressReport: () => ({ addresses: { evm: wallet, solana: null, near: null, nearPublicKey: null }, verified: true, tampered: false }),
    },
    broadcast: (frame) => sink.frames.push(frame),
    broadcastState: () => {},
    refreshLedger: async () => {},
    verifier: net.verifier,
    relay: forcePlanB ? refusingRelay(net.relay) : net.relay,
    oneclick: api,
    ...(net.quoteKey === undefined ? {} : { quoteKey: net.quoteKey }),
    now: net.now,
    sleep: net.sleep,
    random: net.random,
    ...(net.firstPollMs === undefined ? {} : { firstPollMs: net.firstPollMs }),
    ...(net.pollMs === undefined ? {} : { pollMs: net.pollMs }),
    store,
  });
}

function judgeClaim(entry: ClaimProof, route: ClaimRoute): { pass: boolean; why: string } {
  const record = entry.record;
  if (record === undefined) return { pass: false, why: 'the claim left no record' };
  if (record.status !== 'done') return { pass: false, why: `the claim ended ${record.status}${record.reason === undefined ? '' : ` (${record.reason})`}` };
  if (record.route !== route) return { pass: false, why: `it landed through ${record.route ?? 'no route'}, not ${route}` };
  const own = entry.nonces?.filter((n) => n.route === route).at(-1);
  if (own?.isNonceUsed !== true) return { pass: false, why: `is_nonce_used for the ${route} attempt read ${String(own?.isNonceUsed)}` };
  const amount = BigInt(entry.amountBase);
  const { before, after } = entry;
  if (after === undefined || before.code === null || after.code === null || before.receiver === null || after.receiver === null) {
    return { pass: false, why: 'a balance before or after did not read' };
  }
  if (BigInt(before.code) - BigInt(after.code) !== amount) return { pass: false, why: `the code fell by ${BigInt(before.code) - BigInt(after.code)}, not ${amount}` };
  const rose = BigInt(after.receiver) - BigInt(before.receiver);
  if (route === 'relay' && rose !== amount) return { pass: false, why: `the receiver rose by ${rose}, not exactly ${amount}` };
  if (route === 'oneclick') {
    const status = (entry.oneclickStatus as { status?: unknown } | undefined)?.status;
    if (status !== 'SUCCESS') return { pass: false, why: `1Click says ${String(status)}` };
    if (rose <= 0n || rose > amount || String(rose) !== record.creditedBase) return { pass: false, why: `the receiver rose by ${rose}, the record says ${record.creditedBase ?? 'nothing'}` };
  }
  return { pass: true, why: route === 'relay' ? 'nonce spent, the code fell and the receiver rose by exactly the amount' : 'nonce spent, 1Click SUCCESS, the receiver rose by what the record credits' };
}

async function claimStep(proof: ProofFile, file: string, net: ProofNet, api: IntentsApiPort, deps: ProofDeps, step: 'relayClaim' | 'planBClaim'): Promise<boolean> {
  const route: ClaimRoute = step === 'relayClaim' ? 'relay' : 'oneclick';
  const done = proof.results[step];
  if (done?.pass !== undefined) return done.pass;
  const batch = proof.book.moves.find((m) => m.kind === 'batch' && m.label === PROOF_LABEL && m.state === 'done');
  const code = proof.book.codes.filter((c) => c.batch === batch?.id)[step === 'relayClaim' ? 0 : 1];
  if (code === undefined) throw new Error('the proof batch holds no code for this step');

  let entry = done;
  if (entry === undefined) {
    entry = {
      route,
      codeAddress: code.address,
      amountBase: code.amountBase,
      startedAt: new Date(net.now()).toISOString(),
      before: { code: await balanceOf(net, code.address), receiver: await balanceOf(net, proof.receiver.address) },
    };
    proof.results[step] = entry;
    saveProof(file, proof);
  }
  deps.out(`Claiming ${shortAddress(code.address)} through ${route === 'relay' ? 'the solver relay, with no quote' : 'Plan B, 1Click'}.`);

  const sink: Sink = { audit: [], frames: [] };
  const service = claimService(proof, file, net, api, sink, route === 'oneclick');
  const earlier = proof.claims.filter((r) => r.codeAddress === code.address);
  if (earlier.some((r) => r.status === 'pending')) {
    service.reconcile();
  } else if (earlier.length === 0) {
    const answer = await service.claim(code.code);
    if (!answer.ok) {
      entry.pass = false;
      entry.why = `the claim service refused it before it started: ${answer.reason}`;
      saveProof(file, proof);
      return false;
    }
    entry.claim = answer.claim;
  }
  await service.idle();

  const record = proof.claims.filter((r) => r.codeAddress === code.address).at(-1);
  if (record !== undefined) entry.record = structuredClone(record);
  entry.after = { code: await balanceOf(net, code.address), receiver: await balanceOf(net, proof.receiver.address) };
  entry.nonces = [];
  entry.relayStatus = [];
  for (const attempt of record?.attempts ?? []) {
    entry.nonces.push({ route: attempt.route, nonce: attempt.nonce, intentHash: attempt.intentHash, isNonceUsed: await net.verifier.nonceUsed(code.address, attempt.nonce).catch(() => null) });
    let answer: unknown;
    try {
      answer = await net.relay.status(attempt.intentHash);
    } catch (err) {
      answer = { error: err instanceof Error ? err.message : String(err) };
    }
    entry.relayStatus.push({ intentHash: attempt.intentHash, answer });
    if (attempt.depositAddress !== undefined) entry.oneclickStatus = await api.status(attempt.depositAddress).catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }));
  }
  entry.audit = [...(entry.audit ?? []), ...sink.audit];
  entry.frames = [...(entry.frames ?? []), ...sink.frames];
  const verdict = judgeClaim(entry, route);
  entry.pass = verdict.pass;
  entry.why = verdict.why;
  saveProof(file, proof);
  deps.out(`${route === 'relay' ? 'Relay' : 'Plan B'} claim: ${verdict.pass ? 'PASS' : 'FAIL'}, ${verdict.why}.`);
  return verdict.pass;
}

// 1Click as the app reaches it: the partner key when one is set, the public fee tier when not.
function oneclickFor(net: ProofNet, deps: ProofDeps): IntentsApiPort {
  return net.oneclick ?? intentsApi({ apiKey: deps.env[INTENTS_API_KEY_ENV] ?? '' });
}

function dollarsBase(text: unknown, fallback: string, max: number): bigint | null {
  const value = typeof text === 'string' ? text.trim() : fallback;
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(value) || Number(value) < 0.01 || Number(value) > max) return null;
  return decimalToBaseUnits(value, INVITE_ASSET_DECIMALS);
}

async function run(file: string, net: ProofNet, deps: ProofDeps, waitMs: number, amountText: unknown): Promise<number> {
  const proof = loadProof(file);
  const ledger: Ledger = { book: proof.book, save: () => saveProof(file, proof) };
  const t = proof.book.treasury.address;
  const api = oneclickFor(net, deps);
  const codeBase = dollarsBase(amountText, PROOF_CODE_DOLLARS, 50);
  if (codeBase === null) {
    deps.err('--amount is what each of the two codes holds, in dollars: 0.01 to 50, like 0.10.');
    return 2;
  }

  if ((unfinishedBatch(proof.book)?.label ?? PROOF_LABEL) !== PROOF_LABEL) {
    deps.err('The release code batch in this proof file is still pending. Run release-code again to finish it, then run this.');
    return 1;
  }
  const needed = codeBase * BigInt(PROOF_CODES);
  if (proof.results.funding === undefined) {
    const held = await waitForTreasury(net, t, needed, waitMs, deps);
    if (held === null) {
      deps.err(`T still holds less than $${formatUsdc(needed)}. Send $1 (or enough for two codes) to ${t} with the app's Send, then run this again.`);
      return 1;
    }
    proof.results.funding = { treasuryBefore: held.toString(), seenAt: new Date(net.now()).toISOString() };
    saveProof(file, proof);
    deps.out(`T holds $${formatUsdc(held)}.`);
  }

  if (proof.results.issue?.pass === undefined) {
    const waiting = unfinishedBatch(proof.book);
    proof.results.issue ??= { treasuryBefore: await balanceOf(net, t), startedAt: new Date(net.now()).toISOString() };
    saveProof(file, proof);
    const io = quietIo(deps);
    const code = waiting !== undefined ? await resumeBatch(ledger, net, io) : await issueBatch(ledger, net, { count: PROOF_CODES, amountBase: codeBase, label: PROOF_LABEL, simulateOnly: false }, io);
    const move = proof.book.moves.filter((m) => m.kind === 'batch' && m.label === PROOF_LABEL).at(-1);
    const issue = proof.results.issue;
    if (move?.relaySaid !== undefined) issue.relaySaid = move.relaySaid;
    if (code !== 0 || move?.signed === undefined || move.state !== 'done') {
      if (move?.state === 'failed') {
        issue.pass = false;
        issue.why = move.detail ?? 'the batch failed';
        saveProof(file, proof);
        deps.err(`The batch failed, so there are no codes to claim: ${issue.why} The relay said: ${issue.relaySaid ?? 'nothing'}. Sweep T and start a new proof file.`);
        return 1;
      }
      saveProof(file, proof);
      deps.err('The batch did not finish. Run this again to pick it up where it stopped.');
      return 1;
    }
    issue.move = move.id;
    issue.intentHash = move.signed.intentHash;
    issue.nonce = move.signed.nonce;
    issue.sends = move.sends ?? 0;
    issue.isNonceUsed = await net.verifier.nonceUsed(t, move.signed.nonce).catch(() => null);
    issue.treasuryAfter = await balanceOf(net, t);
    issue.codes = [];
    for (const c of proof.book.codes.filter((x) => x.batch === move.id)) issue.codes.push({ address: c.address, amountBase: c.amountBase, after: await balanceOf(net, c.address) });
    try {
      issue.relayStatus = await net.relay.status(move.signed.intentHash);
    } catch (err) {
      issue.relayStatus = { error: err instanceof Error ? err.message : String(err) };
    }
    issue.pass = issue.isNonceUsed === true && move.legs.length === PROOF_CODES && issue.codes.every((c) => c.after !== null && BigInt(c.after) >= BigInt(c.amountBase));
    issue.why = issue.pass ? 'one payload, both codes funded, the nonce spent' : 'the nonce or a code balance did not read as funded';
    saveProof(file, proof);
    deps.out(`Batch: ${issue.pass ? 'PASS' : 'FAIL'}, ${issue.why}.`);
    if (!issue.pass) return 1;
  }

  const relayPass = await claimStep(proof, file, net, api, deps, 'relayClaim');
  const planBPass = await claimStep(proof, file, net, api, deps, 'planBClaim');
  deps.out(reportOf(proof));
  deps.out(`Relay route: ${relayPass ? 'PASS' : 'FAIL'}. Plan B: ${planBPass ? 'PASS' : 'FAIL'}. When you are done: node scripts/invite-proof.ts sweep --file ${file} --to <your address>`);
  return relayPass && planBPass ? 0 : 1;
}

function signerFor(proof: ProofFile, account: string): KeySigner | null {
  if (account === proof.book.treasury.address) return keySigner(proof.book.treasury.key);
  if (account === proof.receiver.address) return keySigner(proof.receiver.key);
  const code = proof.book.codes.find((c) => c.address === account);
  if (code === undefined) return null;
  const parsed = parseCode(code.code);
  if (!parsed.ok) return null;
  const key = deriveKey(parsed.secret);
  parsed.secret.fill(0);
  return key === null ? null : keySigner(key);
}

async function sweep(file: string, net: ProofNet, deps: ProofDeps, rawTo: unknown): Promise<number> {
  const proof = loadProof(file);
  const ledger: Ledger = { book: proof.book, save: () => saveProof(file, proof) };
  const checked = intentsAccountProblem(typeof rawTo === 'string' ? rawTo : '');
  if (!checked.ok) {
    deps.err(`--to: ${checked.problem}`);
    return 2;
  }
  const to = checked.id;
  const ours = [...proof.book.codes.map((c) => c.address), proof.receiver.address, proof.book.treasury.address];
  if (ours.includes(to)) {
    deps.err('--to is one of the proof\'s own accounts. Name the address the money should end up at.');
    return 2;
  }
  const io = quietIo(deps);
  proof.results.sweep ??= [];
  let failures = 0;
  const note = (from: string, paid: string, amountBase: Amount, outcome: string, intentHash: string | null): void => {
    proof.results.sweep!.push({ from, to: paid, amountBase, outcome, intentHash, at: new Date(net.now()).toISOString() });
    saveProof(file, proof);
  };

  // A sweep a crash left signed goes first, as the same bytes, to where it was signed to pay. An
  // account whose earlier sweep is still unproven is not signed out of again.
  const unproven = new Set<string>();
  for (const move of pendingMoves(proof.book, 'sweep')) {
    const signer = signerFor(proof, move.signer);
    if (signer === null) continue;
    try {
      const result = await runMove(ledger, move, signer, net, io.say);
      note(move.signer, move.legs[0]?.receiverId ?? to, move.legs[0]?.amountBase ?? null, result.kind, move.signed?.intentHash ?? null);
      if (result.kind === 'unconfirmed') unproven.add(move.signer);
      if (result.kind !== 'landed') failures += 1;
    } finally {
      signer.drop();
    }
  }
  // Codes first, then the receiver, then T.
  for (const account of ours) {
    if (unproven.has(account)) continue;
    const signer = signerFor(proof, account);
    if (signer === null) continue;
    try {
      const { result, amountBase, intentHash } = await sweepAccount(ledger, net, signer, to, io);
      if (result === null) {
        if (amountBase === null) failures += 1;
        continue;
      }
      note(account, to, amountOf(amountBase), result.kind, intentHash);
      deps.out(`${shortAddress(account)}: $${formatUsdc(amountBase ?? 0n)} ${result.kind === 'landed' ? 'sent' : `not sent (${result.kind})`}.`);
      if (result.kind !== 'landed') failures += 1;
    } finally {
      signer.drop();
    }
  }
  deps.out(failures === 0 ? `Swept. Every proof account is empty; ${to} holds the rest. Delete ${file} when you no longer need its report.` : 'Some accounts were not swept. Run sweep again.');
  return failures === 0 ? 0 : 1;
}

async function releaseCode(file: string, net: ProofNet, deps: ProofDeps, amountText: unknown, waitMs: number): Promise<number> {
  const proof = loadProof(file);
  const ledger: Ledger = { book: proof.book, save: () => saveProof(file, proof) };
  const amountBase = dollarsBase(amountText, '5', 1000);
  if (amountBase === null) {
    deps.err('--amount is dollars, 0.01 to 1000, like 5.');
    return 2;
  }
  const waiting = unfinishedBatch(proof.book);
  if (waiting !== undefined && waiting.label !== RELEASE_LABEL) {
    deps.err('The proof batch in this file is still pending. Run `run` again to finish it first.');
    return 1;
  }
  let shown = false;
  const io = quietIo(deps, (block) => {
    shown = true;
    deps.out(block);
  });
  let code: number;
  if (waiting !== undefined) {
    // An earlier release code that stopped part way: finished, and its link shown, here.
    code = await resumeBatch(ledger, net, io);
  } else {
    const held = await waitForTreasury(net, proof.book.treasury.address, amountBase, waitMs, deps);
    if (held === null) {
      deps.err(`T holds less than $${formatUsdc(amountBase)}. Send it to ${proof.book.treasury.address} with the app's Send, then run this again.`);
      return 1;
    }
    code = await issueBatch(ledger, net, { count: 1, amountBase, label: RELEASE_LABEL, simulateOnly: false }, io);
  }
  const issued = proof.book.codes.filter((c) => c.label === RELEASE_LABEL && c.state === 'open').at(-1);
  if (code !== 0 || issued === undefined || !shown) {
    deps.err('The release code was not issued. Run this again: a batch left pending is finished first.');
    return 1;
  }
  proof.results.releaseCode = { address: issued.address, amountBase: issued.amountBase, issuedAt: new Date(net.now()).toISOString() };
  saveProof(file, proof);
  deps.out(`That code is shown this once. Its account is ${issued.address}. An unclaimed code goes back with sweep.`);
  return 0;
}

async function init(file: string, net: ProofNet, deps: ProofDeps): Promise<number> {
  if (fs.existsSync(file)) {
    deps.err(`${file} exists already. It may hold funded keys, so it is never replaced.`);
    return 1;
  }
  const treasury = newTreasury(net);
  const receiver = newTreasury(net);
  const proof: ProofFile = {
    kind: PROOF_KIND,
    version: 1,
    createdAt: new Date(net.now()).toISOString(),
    book: newBook(treasury),
    receiver: { address: receiver.address, key: receiver.key },
    claims: [],
    results: {},
  };
  saveProof(file, proof);
  const back = loadProof(file);
  deps.out(`Proof file: ${file}, mode 0600. It holds two throwaway keys and, later, the codes, in the clear. Keep it out of the repo; sweep it and delete it when done.`);
  deps.out(`Treasury T: ${back.book.treasury.address}`);
  deps.out(`Throwaway receiver: ${back.receiver.address}`);
  deps.out(`Next: send $1 to T with the app's Send. Then: node scripts/invite-proof.ts run --file ${file}`);
  return 0;
}

export async function proofMain(argv: string[], deps: ProofDeps): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === '--help' || command === 'help') {
    deps.out(USAGE);
    return command === undefined ? 2 : 0;
  }
  let values: Record<string, string | boolean | undefined>;
  try {
    values = parseArgs({
      args: rest,
      options: { file: { type: 'string' }, to: { type: 'string' }, amount: { type: 'string' }, 'wait-minutes': { type: 'string' } },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (err) {
    deps.err(err instanceof Error ? err.message : String(err));
    deps.out(USAGE);
    return 2;
  }
  const waitText = values['wait-minutes'];
  const waitMinutes = typeof waitText === 'string' ? Number(waitText) : DEFAULT_WAIT_MINUTES;
  if (!Number.isFinite(waitMinutes) || waitMinutes < 0 || waitMinutes > 24 * 60) {
    deps.err('--wait-minutes is 0 to 1440.');
    return 2;
  }
  let lock: FileLock | null = null;
  try {
    const file = proofPath(values['file'], deps.repoRoot ?? ROOT);
    const net = deps.net();
    // One run at a time on one proof file: two would each sign out of the same accounts.
    if (command !== 'report') lock = takeLock(file);
    switch (command) {
      case 'init':
        return await init(file, net, deps);
      case 'run':
        return await run(file, net, deps, waitMinutes * 60_000, values['amount']);
      case 'report':
        deps.out(reportOf(loadProof(file)));
        return 0;
      case 'sweep':
        return await sweep(file, net, deps, values['to']);
      case 'release-code':
        return await releaseCode(file, net, deps, values['amount'], waitMinutes * 60_000);
      default:
        deps.err(`There is no command "${command}".`);
        deps.out(USAGE);
        return 2;
    }
  } catch (err) {
    deps.err(err instanceof Error ? err.message : String(err));
    return 1;
  } finally {
    lock?.release();
  }
}

function liveNet(): ProofNet {
  return {
    verifier: liveVerifier(),
    relay: relayClient(),
    simulateAt: liveSimulateAt(),
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    random: (n) => crypto.randomBytes(n),
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  proofMain(process.argv.slice(2), {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    env: process.env,
    net: liveNet,
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    },
  );
}
