// The operator script, `npm run invite`, against a fake intents.near and relay that check
// signatures, nonces, deadlines and balances the way the contract does. Spec:
// docs/superpowers/specs/2026-10-01-invite-codes-design.md, "The money path" and "Tests"
// (Operator script). Throwaway keys and codes only, made at run time from a counter.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Hex } from 'viem';

import { containsInviteCode, parseCode } from '../../src/invite/code.ts';
import { INVITE_ASSET_ID, intentHashOf } from '../../src/invite/payload.ts';
import { keySigner } from '../../src/invite/signer.ts';
import type { KeySigner } from '../../src/invite/signer.ts';
import type { InviteBook } from '../../scripts/invite/book.ts';
import { openInviteFile, takeLock } from '../../scripts/invite/file.ts';
import type { MoneyNet } from '../../scripts/invite/money.ts';
import { readTerminalLine } from '../../scripts/invite/tty.ts';
import { NOT_A_TERMINAL, main } from '../../scripts/invite.ts';
import { freshChain, netOn, relayOn, verdict } from './helpers/invite-chain.ts';
import type { Chain } from './helpers/invite-chain.ts';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const PASS = 'a long passphrase for the invite file';

type Run = { code: number; out: string[]; err: string[]; tty: string[]; prompts: string[] };

type Bench = {
  home: string;
  file: string;
  chain: Chain;
  net: MoneyNet;
  signed: string[]; // every payload a treasury or code key signed, in order
  run(argv: string[], answers?: string[], over?: { tty?: boolean; net?: MoneyNet }): Promise<Run>;
  book(): InviteBook;
};

function bench(): Bench {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-invite-op-'));
  const file = path.join(home, '.phosphor-invites', 'invites.enc.json');
  const chain = freshChain();
  const signed: string[] = [];
  const signerOf = (key: Hex): KeySigner => {
    const inner = keySigner(key);
    return {
      address: inner.address,
      async sign(payload) {
        signed.push(payload);
        return inner.sign(payload);
      },
      drop: () => inner.drop(),
    };
  };
  const net = netOn(chain, { signerOf });
  const b: Bench = {
    home,
    file,
    chain,
    net,
    signed,
    async run(argv, answers = [], over = {}) {
      const r: Run = { code: -1, out: [], err: [], tty: [], prompts: [] };
      const queue = [...answers];
      r.code = await main(argv, {
        stdinIsTTY: over.tty ?? true,
        terminal: {
          async ask(prompt) {
            r.prompts.push(prompt);
            const next = queue.shift();
            return next === undefined ? null : Buffer.from(next, 'utf8');
          },
          write: (text) => r.tty.push(text),
        },
        out: (line) => r.out.push(line),
        err: (line) => r.err.push(line),
        env: {},
        home,
        repoRoot: REPO,
        net: () => over.net ?? net,
      });
      return r;
    },
    book() {
      const opened = openInviteFile(file, Buffer.from(PASS, 'utf8'));
      opened.close();
      return opened.book;
    },
  };
  return b;
}

// T made and funded with `dollars`.
async function funded(dollars: bigint): Promise<Bench> {
  const b = bench();
  const made = await b.run(['treasury'], [PASS, PASS]);
  assert.equal(made.code, 0, made.err.join('\n'));
  b.chain.balances.set(b.book().treasury.address, dollars * 1_000_000n);
  return b;
}

function allText(r: Run): string {
  return [...r.out, ...r.err, ...r.prompts].join('\n');
}

// Every spelling of a code a reader could search for: as printed, lowercase, bare, hyphen-free.
function assertNoCode(text: string, book: InviteBook): void {
  assert.equal(containsInviteCode(text), false, 'a code shape reached the output');
  for (const c of book.codes) {
    const bare = c.code.slice(5);
    for (const form of [c.code, c.code.toLowerCase(), bare, bare.replace(/-/g, ''), bare.replace(/-/g, '').toLowerCase()]) {
      assert.ok(!text.includes(form), 'a code reached the output');
    }
  }
  assert.ok(!text.includes(book.treasury.key.slice(2)), "T's key reached the output");
}

/* The signatures that can run: every signature but the rehearsals, which are the only payloads
   ever handed to the simulation (scripts/invite/money.ts, "Rehearsed, never simulated as itself"). */
function runnable(b: Bench): string[] {
  const rehearsed = new Set(b.chain.simulated.flat().map((s) => s.payload));
  return b.signed.filter((p) => !rehearsed.has(p));
}

test('every command refuses a stdin that is not a terminal, before it asks for anything', async () => {
  const b = bench();
  for (const argv of [['treasury'], ['issue', '--count', '1', '--amount', '5', '--label', 'x'], ['reclaim'], ['withdraw', '--to', '0x9858effd232b4033e47d90003d41ec34ecaeda94'], ['status']]) {
    const r = await b.run(argv, [PASS, PASS], { tty: false });
    assert.equal(r.code, 1);
    assert.deepEqual(r.err, [NOT_A_TERMINAL]);
    assert.deepEqual(r.prompts, [], 'nothing was asked');
  }
  assert.equal(fs.existsSync(b.file), false, 'no file was made');
});

test('the real script, run with a piped stdin, refuses and makes nothing', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-invite-pipe-'));
  const file = path.join(home, 'invites.enc.json');
  for (const command of ['treasury', 'status']) {
    const r = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'invite.ts'), command, '--file', file], {
      input: `${PASS}\n${PASS}\n`,
      env: { ...process.env, HOME: home },
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /Run this in your own Terminal/);
    assert.equal(r.stdout, '');
  }
  assert.deepEqual(fs.readdirSync(home), []);
});

test('treasury writes T to the file first and only then prints its address, never its key; a second run keeps T', async () => {
  const b = bench();
  let printedAfterFile = false;
  const r = await b.run(['treasury'], [PASS, PASS]);
  assert.equal(r.code, 0, r.err.join('\n'));
  const book = b.book();
  const line = r.out.find((l) => l.startsWith('T: '));
  assert.equal(line, `T: ${book.treasury.address}`);
  printedAfterFile = fs.existsSync(b.file);
  assert.ok(printedAfterFile);
  assert.equal(fs.statSync(b.file).mode & 0o777, 0o600);
  assert.deepEqual(r.prompts, ['New passphrase: ', 'The same passphrase again: ']);
  assertNoCode([...r.out, ...r.err, ...r.tty].join('\n'), book);

  const again = await b.run(['treasury'], [PASS]);
  assert.equal(again.code, 0);
  assert.ok(again.out.includes(`T: ${book.treasury.address}`));
  assert.equal(b.book().treasury.key, book.treasury.key, 'T is never replaced');
});

test('treasury refuses a passphrase under 20 characters and two that differ, and makes no file', async () => {
  const b = bench();
  const r = await b.run(['treasury'], ['too short', 'a long passphrase number one!', 'a long passphrase number two!', 'still short']);
  assert.equal(r.code, 1);
  assert.ok(r.out.some((l) => /shorter than 20 characters/.test(l)));
  assert.ok(r.out.some((l) => /did not match/.test(l)));
  assert.equal(fs.existsSync(b.file), false);
});

test('issue writes the codes to the invite file, pending, before it signs anything', async () => {
  const b = await funded(60n);
  let seenAtSigning: InviteBook | null = null;
  const signerOf = (key: Hex): KeySigner => {
    const inner = keySigner(key);
    return {
      address: inner.address,
      async sign(payload) {
        seenAtSigning ??= b.book();
        return inner.sign(payload);
      },
      drop: () => inner.drop(),
    };
  };
  const r = await b.run(['issue', '--count', '10', '--amount', '5', '--label', 'SF builders'], [PASS, 'yes'], { net: { ...b.net, signerOf } });
  assert.equal(r.code, 0, [...r.out, ...r.err].join('\n'));
  const atSigning = seenAtSigning as InviteBook | null;
  assert.ok(atSigning !== null, 'the batch was signed');
  assert.equal(atSigning.codes.length, 10, 'all ten codes were on disk when the key signed');
  assert.ok(atSigning.codes.every((c) => c.state === 'pending'));
  assert.equal(atSigning.moves.length, 1);
  assert.equal(atSigning.moves[0]!.state, 'pending');
  assert.equal(atSigning.moves[0]!.signed, undefined, 'and nothing signed yet');
  // What was signed pays exactly the codes on disk.
  const payload = JSON.parse(b.chain.published[0]!.payload) as { intents: Array<{ receiver_id: string }> };
  assert.deepEqual(payload.intents.map((i) => i.receiver_id), atSigning.codes.map((c) => c.address));
});

test('issue: one payload from T, simulated, published once with no quote, proven by the nonce; the links go to the terminal once', async () => {
  const b = await funded(60n);
  const r = await b.run(['issue', '--count', '10', '--amount', '5', '--label', 'SF builders'], [PASS, 'yes']);
  assert.equal(r.code, 0, [...r.out, ...r.err].join('\n'));
  const book = b.book();
  const t = book.treasury.address;

  assert.equal(runnable(b).length, 1, 'one signature that can run, for the whole batch');
  assert.equal(b.chain.simulated.length, 1, 'rehearsed once before it was signed');
  assert.equal(b.chain.published.length, 1);
  const sent = b.chain.published[0]!;
  assert.deepEqual(sent.quoteHashes, []);
  assert.equal(sent.payload, runnable(b)[0]);
  // The RPC saw only the rehearsal, whose signature died a millisecond after the block it was
  // simulated at; the bytes that can run went to the relay alone, after they were on disk.
  const rehearsal = b.chain.simulated[0]![0]!;
  assert.notEqual(rehearsal.payload, sent.payload);
  const rehearsed = JSON.parse(rehearsal.payload) as { deadline: string; intents: unknown[] };
  assert.deepEqual(rehearsed.intents, (JSON.parse(sent.payload) as { intents: unknown[] }).intents, 'the rehearsal pays exactly what the batch pays');
  assert.ok(Date.parse(rehearsed.deadline) < Date.parse((JSON.parse(sent.payload) as { deadline: string }).deadline) - 100_000);
  const body = JSON.parse(sent.payload) as { signer_id: string; intents: Array<{ intent: string; receiver_id: string; tokens: Record<string, string> }> };
  assert.equal(body.signer_id, t);
  assert.equal(body.intents.length, 10);
  for (const [i, intent] of body.intents.entries()) {
    assert.deepEqual(intent, { intent: 'transfer', receiver_id: book.codes[i]!.address, tokens: { [INVITE_ASSET_ID]: '5000000' } });
  }

  assert.ok(book.codes.every((c) => c.state === 'open'));
  assert.equal(book.moves[0]!.state, 'done');
  assert.ok(book.moves[0]!.printedAt !== undefined);
  for (const c of book.codes) assert.equal(b.chain.balances.get(c.address), 5_000_000n);
  assert.equal(b.chain.balances.get(t), 10_000_000n);

  // The links: on the terminal, each once, and nowhere else.
  const shown = r.tty.join('');
  for (const c of book.codes) {
    assert.equal(shown.split(`https://phosphor.money/invite#${c.code}`).length - 1, 1, 'each link shown exactly once');
  }
  assertNoCode(allText(r), book);
  assert.deepEqual(r.prompts, ['Invite file passphrase: ', 'Issue 10 codes of $5.00 for "SF builders", $50.00 in all, from T (holds $60.00)? Type yes to go on: ']);

  const later = await b.run(['issue', '--resume'], [PASS]);
  assert.equal(later.code, 0);
  assert.deepEqual(later.tty, [], 'never shown again');
});

test('a second issue is refused while one is pending, and --resume finishes the first without signing again', async () => {
  const b = await funded(20n);
  // The publish lands, and then NEAR stops answering: the batch is signed, sent and unproven.
  const relay = b.net.relay;
  const net: MoneyNet = {
    ...b.net,
    relay: {
      ...relay,
      async publishIntent(req) {
        const answer = await relay.publishIntent(req);
        b.chain.offline = true;
        return answer;
      },
    },
  };
  const first = await b.run(['issue', '--count', '2', '--amount', '5', '--label', 'first'], [PASS, 'yes'], { net });
  assert.equal(first.code, 1);
  assert.ok(first.out.some((l) => /issue --resume/.test(l)));
  assert.equal(b.book().moves[0]!.state, 'pending');
  b.chain.offline = false;

  const second = await b.run(['issue', '--count', '1', '--amount', '5', '--label', 'second'], [PASS, 'yes']);
  assert.equal(second.code, 1);
  assert.ok(second.out.some((l) => /A batch is still pending: "first", 2 codes/.test(l)));
  assert.equal(b.book().codes.length, 2, 'no code was added');
  assert.equal(runnable(b).length, 1, 'nothing was signed');
  assert.deepEqual(second.prompts, ['Invite file passphrase: '], 'it never got as far as asking');

  const resumed = await b.run(['issue', '--resume'], [PASS]);
  assert.equal(resumed.code, 0, resumed.out.join('\n'));
  assert.equal(runnable(b).length, 1, 'the batch was never signed again');
  assert.equal(b.chain.published.length, 1, 'it had run already, so nothing was resent');
  const book = b.book();
  assert.ok(book.codes.every((c) => c.state === 'open'));
  assert.equal(resumed.tty.join('').split('https://phosphor.money/invite#').length - 1, 2);
});

test('a batch cut off after its publish is resent as the same bytes, never signed twice', async () => {
  const b = await funded(20n);
  b.chain.relayMode = 'down';
  // The Mac dies while it waits: the signed bytes are on disk, the relay never saw them.
  const crash: MoneyNet = {
    ...b.net,
    sleep: async () => {
      throw new Error('the Mac lost power');
    },
  };
  const first = await b.run(['issue', '--count', '2', '--amount', '5', '--label', 'cut off'], [PASS, 'yes'], { net: crash });
  assert.equal(first.code, 1);
  assert.ok(first.err.some((l) => /lost power/.test(l)));
  assert.equal(fs.existsSync(`${b.file}.lock`), false, 'the lock was released');
  const pending = b.book().moves[0]!;
  assert.equal(pending.state, 'pending');
  assert.ok(pending.signed !== undefined, 'the signed bytes were written before the publish');
  assert.equal(pending.sends, 2, 'one send and the one resend, both unanswered');
  assert.equal(b.chain.published.length, 0);

  b.chain.relayMode = 'ok';
  const resumed = await b.run(['issue', '--resume'], [PASS]);
  assert.equal(resumed.code, 0, resumed.out.join('\n'));
  assert.equal(runnable(b).length, 1, 'signed once, ever');
  assert.equal(b.chain.published.length, 1);
  assert.equal(b.chain.published[0]!.payload, pending.signed!.payload);
  assert.equal(b.chain.published[0]!.signature, pending.signed!.signature);
  assert.ok(b.book().codes.every((c) => c.state === 'open'));
});

test('a batch whose signed bytes expire unspent is closed on proof: codes void, T untouched, the next batch free', async () => {
  const b = await funded(20n);
  b.chain.relayMode = 'refuse';
  const r = await b.run(['issue', '--count', '2', '--amount', '5', '--label', 'refused'], [PASS, 'yes']);
  assert.equal(r.code, 1);
  assert.ok(r.out.some((l) => /turned it away: unauthorized.*no Plan B/.test(l)));
  assert.equal(runnable(b).length, 1, 'never signed again');
  assert.equal(b.chain.published.length, 1, 'never sent again');
  assert.equal(b.chain.oneclick.quotes, 0, 'and never anywhere else');
  const book = b.book();
  assert.equal(book.moves[0]!.state, 'failed');
  assert.ok(book.codes.every((c) => c.state === 'void'));
  assert.equal(b.chain.balances.get(book.treasury.address), 20_000_000n);
  // The deadline passed on the chain's clock before the batch was called failed.
  const deadline = Date.parse(JSON.parse(b.chain.published[0]!.payload).deadline as string);
  assert.ok(b.chain.chain > deadline + 30_000);

  b.chain.relayMode = 'ok';
  const next = await b.run(['issue', '--count', '1', '--amount', '5', '--label', 'next'], [PASS, 'yes']);
  assert.equal(next.code, 0, next.out.join('\n'));
});

test('no reply: the identical bytes go out once more, and the batch is proven by its nonce', async () => {
  const b = await funded(10n);
  b.chain.relayMode = 'noreply';
  const r = await b.run(['issue', '--count', '2', '--amount', '5', '--label', 'quiet relay'], [PASS, 'yes']);
  assert.equal(r.code, 0, r.out.join('\n'));
  assert.equal(b.chain.published.length, 2);
  assert.deepEqual(b.chain.published[1], b.chain.published[0]);
  assert.equal(runnable(b).length, 1);
  assert.ok(b.book().codes.every((c) => c.state === 'open'));
});

test('--simulate-only builds and simulates the funding payload, publishes nothing and writes nothing', async () => {
  const b = await funded(0n);
  const before = fs.readFileSync(b.file);
  const r = await b.run(['issue', '--count', '10', '--amount', '5', '--label', 'dry run', '--simulate-only'], [PASS]);
  assert.equal(r.code, 1, 'an empty T: the verifier would refuse it');
  assert.equal(b.chain.simulated.length, 1);
  const body = JSON.parse(b.chain.simulated[0]![0]!.payload) as { signer_id: string; intents: unknown[] };
  assert.equal(body.signer_id, b.book().treasury.address);
  assert.equal(body.intents.length, 10);
  assert.equal(b.chain.published.length, 0, 'nothing published');
  assert.deepEqual(fs.readFileSync(b.file), before, 'nothing written');
  assert.ok(r.out.some((l) => /would refuse it: .*insufficient balance or overflow/.test(l)));
  assert.ok(r.out.some((l) => /^Nothing was published and nothing was written\. The signature expired at \S+, one millisecond after a final block stamped no later than this Mac's clock, so no block can ever run it\.$/.test(l)));
  assert.deepEqual(r.prompts, ['Invite file passphrase: '], 'no confirmation for a dry run');

  const t = b.book().treasury.address;
  b.chain.balances.set(t, 50_000_000n);
  const ok = await b.run(['issue', '--count', '10', '--amount', '5', '--label', 'dry run', '--simulate-only'], [PASS]);
  assert.equal(ok.code, 0);
  assert.ok(ok.out.some((l) => /The verifier would run it/.test(l)));
  assert.equal(b.chain.published.length, 0);
  assert.deepEqual(fs.readFileSync(b.file), before);
  assert.equal(b.book().codes.length, 0);

  // The dry run's bytes went to a third party, the RPC. Published by anyone, they still never run:
  // they died a millisecond after the block they were simulated at, and every later block is later.
  const dry = b.chain.simulated.at(-1)![0]!;
  assert.equal(Date.parse((JSON.parse(dry.payload) as { deadline: string }).deadline), b.chain.chain + 1);
  b.chain.chain += 600;
  await relayOn(b.chain).publishIntent({ quoteHashes: [], standard: 'erc191', payload: dry.payload, signature: dry.signature });
  b.chain.mac += 5_000;
  assert.equal(await verdict(b.chain, dry.payload, dry.signature, false), 'deadline has expired');
  assert.equal(await b.net.verifier.balance(t, INVITE_ASSET_ID), 50_000_000n, 'T kept every cent');
  assert.deepEqual(b.chain.executed.filter((h) => h === intentHashOf(dry.payload)), []);
});

test('a network that cannot simulate at a fixed block gets no dry run signed at all', async () => {
  const b = await funded(50n);
  const { simulateAt: _unused, ...plain } = b.net;
  const r = await b.run(['issue', '--count', '2', '--amount', '5', '--label', 'dry run', '--simulate-only'], [PASS], { net: plain });
  assert.equal(r.code, 1);
  assert.ok(r.out.some((l) => /cannot simulate at a fixed block, so nothing was signed/.test(l)));
  assert.equal(b.signed.length, 0);
  assert.equal(b.chain.simulated.length, 0);
});

test('issue refuses before writing anything when T holds too little, and says what to send', async () => {
  const b = await funded(10n);
  const before = fs.readFileSync(b.file);
  const r = await b.run(['issue', '--count', '10', '--amount', '5', '--label', 'too big'], [PASS, 'yes']);
  assert.equal(r.code, 1);
  assert.ok(r.out.some((l) => /T holds \$10\.00 and this batch needs \$50\.00/.test(l)));
  assert.ok(r.out.some((l) => /Send at least \$40\.12 to T/.test(l)), r.out.join('\n'));
  assert.deepEqual(fs.readFileSync(b.file), before);
  assert.equal(b.signed.length, 0);
});

test('status never prints a code, and tells open, claimed, reclaimed and void apart', async () => {
  const b = await funded(30n);
  assert.equal((await b.run(['issue', '--count', '3', '--amount', '5', '--label', 'SF builders'], [PASS, 'yes'])).code, 0);
  let book = b.book();
  // One holder claims: the code's balance moves to their wallet.
  b.chain.balances.set(book.codes[0]!.address, 0n);
  // One code is reclaimed.
  assert.equal((await b.run(['reclaim', '--address', book.codes[1]!.address], [PASS, 'yes'])).code, 0);
  // One batch never runs.
  b.chain.relayMode = 'refuse';
  assert.equal((await b.run(['issue', '--count', '1', '--amount', '5', '--label', 'never'], [PASS, 'yes'])).code, 1);
  b.chain.relayMode = 'ok';

  const r = await b.run(['status'], [PASS]);
  assert.equal(r.code, 0);
  book = b.book();
  const text = r.out.join('\n');
  assertNoCode(allText(r), book);
  assert.deepEqual(r.tty, []);
  assert.ok(text.includes(`Treasury T  ${book.treasury.address}  $20.00`));
  assert.ok(text.includes(`${book.codes[0]!.address}  $5.00  claimed`));
  assert.ok(text.includes(`${book.codes[1]!.address}  $5.00  reclaimed`));
  assert.ok(text.includes(`${book.codes[2]!.address}  $5.00  open`));
  assert.ok(text.includes(`${book.codes[3]!.address}  $5.00  void`));
  assert.ok(text.includes('"never"  1 code, issued 2026-10-01, never funded'));
});

test('status reads beside a running command; a writing command waits for the lock', async () => {
  const b = await funded(10n);
  const lock = takeLock(b.file);
  try {
    const blocked = await b.run(['issue', '--count', '1', '--amount', '5', '--label', 'x'], [PASS, 'yes']);
    assert.equal(blocked.code, 1);
    assert.ok(blocked.err.some((l) => /holds the lock/.test(l)));
    assert.deepEqual(blocked.prompts, [], 'refused before the passphrase');
    const status = await b.run(['status'], [PASS]);
    assert.equal(status.code, 0);
  } finally {
    lock.release();
  }
});

test('a wrong passphrase stops every command before anything is read or signed', async () => {
  const b = await funded(10n);
  const before = fs.readFileSync(b.file);
  const reads = b.chain.reads;
  for (const argv of [['issue', '--count', '1', '--amount', '5', '--label', 'x'], ['reclaim'], ['withdraw', '--to', '0x9858effd232b4033e47d90003d41ec34ecaeda94'], ['status']]) {
    const r = await b.run(argv, ['the wrong passphrase, but long enough', 'yes', 'eda94', 'yes']);
    assert.equal(r.code, 1);
    assert.ok(r.err.some((l) => /passphrase is wrong/.test(l)));
  }
  assert.equal(b.chain.reads, reads, 'nothing was read from the network');
  assert.equal(b.signed.length, 0);
  assert.deepEqual(fs.readFileSync(b.file), before);
});

test("reclaim pays each open code's whole balance back to T with the code's own key, and marks it", async () => {
  const b = await funded(20n);
  assert.equal((await b.run(['issue', '--count', '3', '--amount', '5', '--label', 'SF builders'], [PASS, 'yes'])).code, 0);
  let book = b.book();
  const t = book.treasury.address;
  const [claimed, dusty, plain] = book.codes;
  b.chain.balances.set(claimed!.address, 0n); // its holder claimed it
  b.chain.balances.set(dusty!.address, 5_000_001n); // someone sent it dust
  const signedBefore = runnable(b).length;

  const r = await b.run(['reclaim'], [PASS, 'yes']);
  assert.equal(r.code, 0, r.out.join('\n'));
  book = b.book();
  assert.equal(book.codes[0]!.state, 'claimed');
  assert.equal(book.codes[1]!.state, 'reclaimed');
  assert.equal(book.codes[2]!.state, 'reclaimed');
  const reclaims = runnable(b).slice(signedBefore).map((p) => JSON.parse(p) as { signer_id: string; intents: Array<{ receiver_id: string; tokens: Record<string, string> }> });
  assert.deepEqual(
    reclaims.map((p) => [p.signer_id, p.intents.length, p.intents[0]!.receiver_id, p.intents[0]!.tokens[INVITE_ASSET_ID]]),
    [
      [dusty!.address, 1, t, '5000001'],
      [plain!.address, 1, t, '5000000'],
    ],
    "each code signs its own whole balance to T, and nothing else",
  );
  assert.equal(b.chain.balances.get(dusty!.address), 0n);
  assert.equal(b.chain.balances.get(plain!.address), 0n);
  assert.equal(b.chain.balances.get(t), 5_000_000n + 10_000_001n);
  assertNoCode(allText(r), book);

  // A reclaimed code reads as used to anyone who tries it.
  assert.equal(parseCode(book.codes[1]!.code).ok, true);
  assert.equal(b.chain.balances.get(book.codes[1]!.address), 0n);
});

test('reclaim --address and --label pick codes; --simulate-only signs and simulates each and moves nothing', async () => {
  const b = await funded(20n);
  assert.equal((await b.run(['issue', '--count', '2', '--amount', '5', '--label', 'one'], [PASS, 'yes'])).code, 0);
  assert.equal((await b.run(['issue', '--count', '1', '--amount', '5', '--label', 'two'], [PASS, 'yes'])).code, 0);
  const book = b.book();
  const before = fs.readFileSync(b.file);
  const published = b.chain.published.length;

  const dry = await b.run(['reclaim', '--label', 'one', '--simulate-only'], [PASS]);
  assert.equal(dry.code, 0, dry.out.join('\n'));
  assert.equal(b.chain.published.length, published);
  assert.deepEqual(fs.readFileSync(b.file), before);
  assert.equal(dry.out.filter((l) => /The verifier would run it/.test(l)).length, 2);

  const one = await b.run(['reclaim', '--address', book.codes[2]!.address.toUpperCase().replace('0X', '0x')], [PASS, 'yes']);
  assert.equal(one.code, 0);
  const after = b.book();
  assert.deepEqual(after.codes.map((c) => c.state), ['open', 'open', 'reclaimed']);
});

test('withdraw pays T to the typed address only after its last six are typed back, never the keystore header', async () => {
  const b = await funded(7n);
  // A keystore header in this HOME names another address: withdraw must never read it.
  const other = '0x1111111111111111111111111111111111111111';
  fs.mkdirSync(path.join(b.home, '.phosphor'), { recursive: true });
  fs.writeFileSync(path.join(b.home, '.phosphor', 'keys.enc.json'), JSON.stringify({ addresses: { evm: other } }));
  const to = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';

  const wrong = await b.run(['withdraw', '--to', to], [PASS, 'aeda95', 'yes']);
  assert.equal(wrong.code, 1);
  assert.ok(wrong.out.some((l) => /Those six do not match/.test(l)));
  assert.equal(b.signed.length, 0);
  assert.equal(b.chain.simulated.length, 0);

  const r = await b.run(['withdraw', '--to', to], [PASS, 'AEDA94', 'yes']);
  assert.equal(r.code, 0, r.out.join('\n'));
  assert.deepEqual(r.prompts, ['Invite file passphrase: ', "Type the last six characters of the address on Phosphor's Receive screen: ", `Send $7.00 from T to ${to.toLowerCase()}? Type yes to go on: `]);
  assert.equal(runnable(b).length, 1);
  const body = JSON.parse(runnable(b)[0]!) as { signer_id: string; intents: Array<{ receiver_id: string; tokens: Record<string, string> }> };
  assert.equal(body.signer_id, b.book().treasury.address);
  assert.deepEqual(body.intents, [{ intent: 'transfer', receiver_id: to.toLowerCase(), tokens: { [INVITE_ASSET_ID]: '7000000' } }]);
  assert.equal(b.chain.balances.get(to.toLowerCase()), 7_000_000n);
  assert.equal(b.chain.balances.get(other) ?? 0n, 0n);
  assert.equal(b.chain.balances.get(b.book().treasury.address), 0n);
});

test('withdraw refuses an invite account as the receiver, and waits while a batch is pending', async () => {
  const b = await funded(10n);
  const t = b.book().treasury.address;
  const self = await b.run(['withdraw', '--to', t], [PASS, t.slice(-6), 'yes']);
  assert.equal(self.code, 2);
  assert.ok(self.out.some((l) => /That is an invite account/.test(l)));
  assert.equal(b.signed.length, 0);

  // A batch signed and sent, then NEAR stops answering: T's money is spoken for.
  const relay = b.net.relay;
  const net: MoneyNet = {
    ...b.net,
    relay: {
      ...relay,
      async publishIntent(req) {
        const answer = await relay.publishIntent(req);
        b.chain.offline = true;
        return answer;
      },
    },
  };
  assert.equal((await b.run(['issue', '--count', '1', '--amount', '5', '--label', 'x'], [PASS, 'yes'], { net })).code, 1);
  b.chain.offline = false;
  const to = '0x9858effd232b4033e47d90003d41ec34ecaeda94';
  const waiting = await b.run(['withdraw', '--to', to], [PASS, 'eda94', 'yes']);
  assert.equal(waiting.code, 1);
  assert.ok(waiting.out.some((l) => /A batch is still pending/.test(l)));
  assert.equal(runnable(b).length, 1, 'only the batch was ever signed');
});

test('no operator file reads the keystore, and the CLI never takes a secret on its command line', () => {
  const files = [path.join(REPO, 'scripts', 'invite.ts'), path.join(REPO, 'scripts', 'invite-proof.ts'), ...fs.readdirSync(path.join(REPO, 'scripts', 'invite')).map((f) => path.join(REPO, 'scripts', 'invite', f))];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    assert.ok(!/from '[^']*keystore[^']*'/.test(text), `${path.basename(f)} imports the keystore`);
    assert.ok(!/\.phosphor\/|keys\.enc\.json|keysPath/.test(text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')), `${path.basename(f)} names the wallet's key file`);
  }
  const cli = fs.readFileSync(path.join(REPO, 'scripts', 'invite.ts'), 'utf8');
  assert.ok(!/passphrase: \{ type/.test(cli) && !/'--passphrase'/.test(cli), 'no passphrase flag');
});

// A terminal for readTerminalLine: raw mode switches and output, in the order they happen.
class FakeTty extends EventEmitter {
  isRaw = false;
  log: string[] = [];
  setRawMode(on: boolean): this {
    this.isRaw = on;
    this.log.push(`raw:${on}`);
    return this;
  }
  resume(): this {
    return this;
  }
  pause(): this {
    return this;
  }
}

test('the passphrase prompt turns echo off before it shows, echoes nothing, and puts the terminal back', async () => {
  const tty = new FakeTty();
  const line = readTerminalLine(tty as unknown as NodeJS.ReadStream, (text) => tty.log.push(`out:${text}`), 'Invite file passphrase: ', true);
  tty.emit('data', Buffer.from('h\u00e9llo w\u00f6rld', 'utf8'));
  tty.emit('data', Buffer.from([0x7f])); // Backspace takes the d
  tty.emit('data', Buffer.from('\u001b[D')); // an arrow key is skipped
  tty.emit('data', Buffer.from('\u00f6', 'utf8'));
  tty.emit('data', Buffer.from([0x7f])); // and a two-byte letter goes whole
  tty.emit('data', Buffer.from('D\r'));
  const got = await line;
  assert.equal(got?.toString('utf8'), 'h\u00e9llo w\u00f6rlD');
  assert.deepEqual(tty.log, ['raw:true', 'out:Invite file passphrase: ', 'raw:false', 'out:\n']);

  const cancelled = new FakeTty();
  const stopped = readTerminalLine(cancelled as unknown as NodeJS.ReadStream, (text) => cancelled.log.push(`out:${text}`), 'P: ', true);
  cancelled.emit('data', Buffer.from('secret\u0003', 'utf8'));
  assert.equal(await stopped, null, 'Ctrl-C cancels');
  assert.equal(cancelled.isRaw, false);
  assert.ok(!cancelled.log.some((l) => l.includes('secret')));
});

test('a rehearsal nobody answers, or one the verifier refuses, leaves nothing that can run', async () => {
  for (const mode of ['silent', 'refused'] as const) {
    const b = await funded(20n);
    const t = b.book().treasury.address;
    const simulateAt: MoneyNet['simulateAt'] = async (signed) => {
      b.chain.simulated.push(signed);
      return mode === 'silent' ? null : { ok: false, refusal: `account '${t}' is locked` };
    };
    const r = await b.run(['issue', '--count', '2', '--amount', '5', '--label', mode], [PASS, 'yes'], { net: { ...b.net, simulateAt } });
    assert.equal(r.code, 1);
    assert.ok(r.out.some((l) => /^Nothing that can run was sent: /.test(l)), r.out.join('\n'));
    assert.equal(runnable(b).length, 0, 'only rehearsals were signed');
    assert.equal(b.chain.published.length, 0);
    const book = b.book();
    assert.equal(book.moves[0]!.state, 'failed');
    assert.ok(book.codes.every((c) => c.state === 'void'));
    // Whoever saw the rehearsals publishes them: not one can run, at any later block.
    b.chain.chain += 600;
    for (const s of b.chain.simulated.flat()) {
      assert.equal(await verdict(b.chain, s.payload, s.signature, false), 'deadline has expired');
    }
    assert.equal(await b.net.verifier.balance(t, INVITE_ASSET_ID), 20_000_000n);
  }
});

test("a final block stamped ahead of this Mac's clock is refused before anything is signed", async () => {
  const b = await funded(20n);
  // The RPC says the chain is five seconds ahead of the real time.
  b.chain.chain = b.chain.mac + 5_000;
  const dry = await b.run(['issue', '--count', '2', '--amount', '5', '--label', 'x', '--simulate-only'], [PASS]);
  assert.equal(dry.code, 1);
  assert.ok(dry.out.some((l) => /stamped 5\.0 s ahead of this Mac's clock.*so nothing was signed/.test(l)), dry.out.join('\n'));
  const real = await b.run(['issue', '--count', '2', '--amount', '5', '--label', 'x'], [PASS, 'yes']);
  assert.equal(real.code, 1);
  assert.equal(b.signed.length, 0, 'not a rehearsal, not a batch');
  assert.ok(b.book().codes.every((c) => c.state === 'void'));
});

test('an older copy of the invite file put back cannot make a batch sign twice: its money is reclaimed instead', async () => {
  const b = await funded(20n);
  let copy: Buffer | null = null;
  const signerOf = (key: Hex): KeySigner => {
    const inner = keySigner(key);
    return {
      address: inner.address,
      async sign(payload) {
        copy ??= fs.readFileSync(b.file); // the file as it stood before the batch was signed
        b.signed.push(payload);
        return inner.sign(payload);
      },
      drop: () => inner.drop(),
    };
  };
  const net = { ...b.net, signerOf };
  assert.equal((await b.run(['issue', '--count', '2', '--amount', '5', '--label', 'rolled back'], [PASS, 'yes'], { net })).code, 0);
  const t = b.book().treasury.address;
  assert.equal(b.chain.balances.get(t), 10_000_000n);
  fs.writeFileSync(b.file, copy!);
  const signedBefore = runnable(b).length;

  const resumed = await b.run(['issue', '--resume'], [PASS], { net });
  assert.equal(resumed.code, 1);
  assert.ok(resumed.out.some((l) => /2 codes of this batch already hold money.*Nothing was signed/.test(l)), resumed.out.join('\n'));
  assert.equal(runnable(b).length, signedBefore, 'never signed a second time');
  assert.deepEqual(resumed.tty, [], 'and no link shown again');
  assert.equal(b.chain.balances.get(t), 10_000_000n);

  assert.equal((await b.run(['reclaim', '--label', 'rolled back'], [PASS, 'yes'], { net })).code, 0);
  assert.equal(b.chain.balances.get(t), 20_000_000n);
  const closed = await b.run(['issue', '--resume'], [PASS], { net });
  assert.equal(closed.code, 1);
  assert.equal(b.book().moves[0]!.state, 'failed');
  assert.equal((await b.run(['issue', '--count', '1', '--amount', '5', '--label', 'next'], [PASS, 'yes'], { net })).code, 0);
});

test('a code a lagging node still shows empty is read again, and its link is never held back for good', async () => {
  const b = await funded(20n);
  let lagging = 7; // reads of the first code that still see the old state
  let first: string | null = null;
  const verifier = {
    ...b.net.verifier,
    async balance(account: string, asset: string) {
      const value = await b.net.verifier.balance(account, asset);
      if (account === first && lagging > 0 && value !== null && value > 0n) {
        lagging -= 1;
        return 0n;
      }
      return value;
    },
  };
  const relay = b.net.relay;
  const net: MoneyNet = {
    ...b.net,
    verifier,
    relay: {
      ...relay,
      async publishIntent(req) {
        first = (JSON.parse(req.payload) as { intents: Array<{ receiver_id: string }> }).intents[0]!.receiver_id;
        return relay.publishIntent(req);
      },
    },
  };
  const r = await b.run(['issue', '--count', '2', '--amount', '5', '--label', 'lag'], [PASS, 'yes'], { net });
  assert.equal(r.code, 1, 'four reads in a row saw it empty: the batch waits');
  assert.ok(r.out.some((l) => /1 code does not read funded yet/.test(l)));
  assert.deepEqual(r.tty, [], 'no link shown while one is missing');
  const resumed = await b.run(['issue', '--resume'], [PASS], { net });
  assert.equal(resumed.code, 0, resumed.out.join('\n'));
  assert.equal(resumed.tty.join('').split('https://phosphor.money/invite#').length - 1, 2, 'both links, once');
  assert.ok(b.book().codes.every((c) => c.state === 'open'));
});

test('money that reaches a void code is shown by status and taken back by reclaim', async () => {
  const b = await funded(20n);
  b.chain.relayMode = 'refuse';
  assert.equal((await b.run(['issue', '--count', '1', '--amount', '5', '--label', 'refused'], [PASS, 'yes'])).code, 1);
  b.chain.relayMode = 'ok';
  const code = b.book().codes[0]!;
  assert.equal(code.state, 'void');
  b.chain.balances.set(code.address, 3_000_000n); // from anywhere: a replay, a stranger
  const status = await b.run(['status'], [PASS]);
  assert.ok(status.out.some((l) => l.includes(`${code.address}  $5.00  void, holds $3.00: reclaim takes it back`)), status.out.join('\n'));
  assert.equal((await b.run(['reclaim'], [PASS, 'yes'])).code, 0);
  assert.equal(b.chain.balances.get(code.address), 0n);
  assert.equal(b.chain.balances.get(b.book().treasury.address), 23_000_000n);
  assert.equal(b.book().codes[0]!.state, 'reclaimed');
});
