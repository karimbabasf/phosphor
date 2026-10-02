// `npm run invite -- convert`: other USDC in the treasury T turned into NEAR USDC through 1Click,
// signed by T, against the fake intents.near and 1Click of tests/unit/helpers/invite-chain.ts. The
// rules are scripts/invite/convert.ts's header, one test each. The live convert is the lead's.
// Throwaway keys only, made at run time.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Hex } from 'viem';

import { INVITE_ASSET_ID } from '../../src/invite/payload.ts';
import { keySigner } from '../../src/invite/signer.ts';
import type { KeySigner } from '../../src/invite/signer.ts';
import { intentsApi } from '../../src/rails/intents-native.ts';
import { readBook } from '../../scripts/invite/book.ts';
import type { InviteBook, Move } from '../../scripts/invite/book.ts';
import { USDC_VARIANTS } from '../../scripts/invite/usdc.ts';
import { openInviteFile } from '../../scripts/invite/file.ts';
import { fundingFor } from '../../scripts/invite/money.ts';
import type { MoneyNet } from '../../scripts/invite/money.ts';
import { main } from '../../scripts/invite.ts';
import { buildNonce } from '../../src/relay/payload.ts';
import { CHAIN_SALT, balanceOf, freshChain, netOn, oneclickFetchOn, oneclickOn, setBalance, settle, verdict } from './helpers/invite-chain.ts';
import type { Chain } from './helpers/invite-chain.ts';
import { TEST_QUOTE_KEY } from './helpers/signed-quote.ts';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const PASS = 'a long passphrase for the invite file';
const BASE_USDC = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
const BSC_USDC = 'nep245:v2_1.omni.hot.tg:56_2w93GqMcEmQFDru84j3HZZWt557r';
const ATTACKER = 'attacker.near';

type Run = { code: number; out: string[]; err: string[]; prompts: string[]; signedAtConfirm: number | null; outAtConfirm: string[] };

type Bench = {
  chain: Chain;
  net: MoneyNet;
  signed: string[]; // every payload T's key signed, rehearsals included, in order
  t: string;
  run(argv: string[], answers?: string[], net?: MoneyNet): Promise<Run>;
  book(): InviteBook;
};

async function bench(): Promise<Bench> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-invite-convert-'));
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
  const net = netOn(chain, { signerOf, oneclick: oneclickOn(chain), quoteKey: TEST_QUOTE_KEY });
  const b: Bench = {
    chain,
    net,
    signed,
    t: '',
    async run(argv, answers = [], over) {
      const r: Run = { code: -1, out: [], err: [], prompts: [], signedAtConfirm: null, outAtConfirm: [] };
      const queue = [...answers];
      r.code = await main(argv, {
        stdinIsTTY: true,
        terminal: {
          async ask(prompt) {
            r.prompts.push(prompt);
            if (/Type yes/.test(prompt)) {
              r.signedAtConfirm = signed.length;
              r.outAtConfirm = [...r.out];
            }
            const next = queue.shift();
            return next === undefined ? null : Buffer.from(next, 'utf8');
          },
          write: () => {},
        },
        out: (line) => r.out.push(line),
        err: (line) => r.err.push(line),
        env: {},
        home,
        repoRoot: REPO,
        net: () => over ?? net,
      });
      return r;
    },
    book() {
      const opened = openInviteFile(file, Buffer.from(PASS, 'utf8'));
      opened.close();
      return opened.book;
    },
  };
  const made = await b.run(['treasury'], [PASS, PASS]);
  assert.equal(made.code, 0, made.err.join('\n'));
  b.t = b.book().treasury.address;
  return b;
}

function text(r: Run): string {
  return [...r.out, ...r.err].join('\n');
}

/* The signatures that can run: every one but the rehearsals, the only payloads ever simulated. */
function runnable(b: Bench): string[] {
  const rehearsed = new Set(b.chain.simulated.flat().map((s) => s.payload));
  return b.signed.filter((p) => !rehearsed.has(p));
}

function converts(b: Bench): Move[] {
  return b.book().moves.filter((m) => m.kind === 'convert');
}

type Body = { signer_id: string; deadline: string; nonce: string; intents: Array<{ intent: string; receiver_id: string; tokens: Record<string, string> }> };

// 1Click as the app reaches it, over the wire: the real client and its request check.
function wired(b: Bench, wire: Parameters<typeof oneclickFetchOn>[1] = {}): MoneyNet {
  return { ...b.net, oneclick: intentsApi({ apiKey: '', fetchImpl: oneclickFetchOn(b.chain, wire) }) };
}

test('convert turns the USDC on Base in T into NEAR USDC: listed with its NEAR USDC before anything is signed, one signature that can run, credited to T', async () => {
  const b = await bench();
  setBalance(b.chain, b.t, BASE_USDC, 1_000_000n);
  const blocks: number[] = [];
  const simulate = b.net.simulateAt!;
  const net: MoneyNet = { ...b.net, simulateAt: (signed, block) => (blocks.push(Number(block.slice('block'.length))), simulate(signed, block)) };

  const r = await b.run(['convert'], [PASS, 'yes'], net);
  assert.equal(r.code, 0, text(r));

  // The list and what it should bring, then the question, with nothing signed yet.
  assert.equal(r.signedAtConfirm, 0, 'nothing is signed before the yes');
  assert.ok(r.outAtConfirm.includes('T holds $1.00 USDC on Base inside NEAR Intents. A code holds NEAR USDC only, so 1Click converts each:'), r.outAtConfirm.join('\n'));
  assert.ok(r.outAtConfirm.includes('  $1.00 USDC on Base to about $0.9998 of NEAR USDC, at least $0.99'), r.outAtConfirm.join('\n'));
  assert.match(r.prompts.at(-1)!, /^Convert it into about \$0\.9998 of NEAR USDC for T, with one signature from T for each\? Type yes to go on: $/);

  // Exact in, T's whole balance, credited to T and refunded to T.
  const order = [...b.chain.oneclick.orders.values()].at(-1)!;
  assert.deepEqual([order.origin, order.destination, order.amount, order.recipient, order.refundTo], [BASE_USDC, INVITE_ASSET_ID, 1_000_000n, b.t, b.t]);

  // One signature that can run, the one 1Click got; the rehearsal shares its nonce and died 1 ms past its block.
  const real = runnable(b);
  assert.equal(real.length, 1, 'one signature that can run');
  assert.deepEqual(b.chain.oneclick.submitted.map((s) => s.payload), real);
  const rehearsals = b.chain.simulated.flat().map((s) => JSON.parse(s.payload) as Body);
  const signed = JSON.parse(real[0]!) as Body;
  assert.equal(rehearsals.length, 1);
  assert.equal(rehearsals[0]!.nonce, signed.nonce, 'the rehearsal and the convert share one nonce');
  assert.equal(Date.parse(rehearsals[0]!.deadline), blocks[0]! + 1, 'the rehearsal dies a millisecond past the block it was simulated at');
  assert.ok(!b.chain.simulated.flat().some((s) => s.payload === real[0]), 'the real bytes are never simulated');
  const handle = [...b.chain.oneclick.orders.keys()].at(-1)!;
  assert.deepEqual(signed.intents, [{ intent: 'transfer', receiver_id: handle, tokens: { [BASE_USDC]: '1000000' } }]);
  assert.deepEqual(rehearsals[0]!.intents, signed.intents, 'the same transfer');
  assert.ok(Date.parse(signed.deadline) - b.chain.mac <= 3 * 60_000, 'signed for three minutes at most');

  // T now holds NEAR USDC and no USDC on Base; the book holds the convert, done.
  assert.equal(balanceOf(b.chain, b.t, BASE_USDC), 0n);
  assert.equal(balanceOf(b.chain, b.t, INVITE_ASSET_ID), 999_800n);
  const [move] = converts(b);
  assert.equal(move?.state, 'done');
  assert.equal(move?.creditedOut, '999800');
  assert.equal(move?.signed?.payload, real[0]);
  assert.ok(r.out.some((l) => /^\$1\.00 USDC on Base: converted\. 1Click says SUCCESS, \$0\.9998 of NEAR USDC credited to T \(intent \w+\)\.$/.test(l)), text(r));
  assert.ok(r.out.includes('T holds $0.9998 of NEAR USDC now, the USDC a batch pays codes with.'), text(r));
});

test('the move and its nonce are on disk before the rehearsal is signed, and the signed bytes before 1Click sees them', async () => {
  const b = await bench();
  setBalance(b.chain, b.t, BASE_USDC, 2_000_000n);
  const seen: string[] = [];
  const inner = oneclickOn(b.chain);
  const simulate = b.net.simulateAt!;
  const net: MoneyNet = {
    ...b.net,
    simulateAt: async (signed, block) => {
      const move = converts(b).at(-1);
      assert.equal(move?.state, 'pending');
      assert.equal(move?.signed, undefined, 'no real signature yet');
      assert.equal(move?.nonce, (JSON.parse(signed[0]!.payload) as Body).nonce, 'the rehearsal nonce is written down first');
      assert.equal(move?.rehearsalDeadline, (JSON.parse(signed[0]!.payload) as Body).deadline);
      seen.push('rehearsal');
      return simulate(signed, block);
    },
    oneclick: {
      ...inner,
      async submitIntent(signed) {
        assert.equal(converts(b).at(-1)?.signed?.payload, signed.payload, 'the bytes 1Click gets are the bytes in the file');
        assert.equal(converts(b).at(-1)?.signed?.signature, signed.signature);
        seen.push('submit');
        return inner.submitIntent(signed);
      },
    },
  };
  const r = await b.run(['convert'], [PASS, 'yes'], net);
  assert.equal(r.code, 0, text(r));
  assert.deepEqual(seen, ['rehearsal', 'submit']);
});

test('a run that dies with the signed bytes on disk is finished by the next run with the same bytes, never a second signature', async () => {
  const b = await bench();
  setBalance(b.chain, b.t, BASE_USDC, 1_000_000n);
  const inner = oneclickOn(b.chain);
  const dying: MoneyNet = {
    ...b.net,
    oneclick: {
      ...inner,
      submitIntent: async () => {
        throw new Error('the Mac went to sleep');
      },
    },
    sleep: async () => {
      throw new Error('killed');
    },
  };
  const first = await b.run(['convert'], [PASS, 'yes'], dying);
  assert.equal(first.code, 1);
  const pending = converts(b)[0]!;
  assert.equal(pending.state, 'pending');
  assert.ok(pending.signed !== undefined, 'the signed bytes are in the file');
  assert.equal(b.chain.oneclick.submitted.length, 0, 'and never reached 1Click');

  const second = await b.run(['convert'], [PASS]);
  assert.equal(second.code, 0, text(second));
  assert.ok(second.out.includes('Signed in an earlier run and not proven either way yet: sending the same bytes to 1Click again. It is never signed twice.'));
  assert.deepEqual(b.chain.oneclick.submitted.map((s) => s.payload), [pending.signed.payload], 'the same bytes, once');
  assert.equal(runnable(b).length, 1, 'never a second signature');
  assert.equal(converts(b)[0]!.state, 'done');
  assert.equal(balanceOf(b.chain, b.t, INVITE_ASSET_ID), 999_800n);
  assert.ok(second.out.includes('T holds no USDC but NEAR USDC. Nothing to convert.'), 'and the next read of T finds nothing left');
  assert.ok(!second.prompts.some((p) => /Type yes/.test(p)));
});

test('while a convert signed earlier can still run, nothing new is signed; once it ends, what arrived since converts with a signature of its own', async () => {
  const b = await bench();
  setBalance(b.chain, b.t, BASE_USDC, 1_000_000n);
  const inner = oneclickOn(b.chain);
  const dying: MoneyNet = {
    ...b.net,
    oneclick: { ...inner, submitIntent: async () => Promise.reject(new Error('the Mac went to sleep')) },
    sleep: async () => Promise.reject(new Error('killed')),
  };
  assert.equal((await b.run(['convert'], [PASS, 'yes'], dying)).code, 1);

  // NEAR answers that the nonce is unspent, its clock stuck short of the deadline, and 1Click turns
  // the same bytes away again: the first convert can still run, so nothing new is signed.
  b.chain.oneclick.submitAnswer = 'error';
  setBalance(b.chain, b.t, BASE_USDC, balanceOf(b.chain, b.t, BASE_USDC) + 500_000n);
  const stuck: MoneyNet = { ...b.net, sleep: async (ms) => void (b.chain.mac += ms) };
  const blind = await b.run(['convert'], [PASS, 'yes'], stuck);
  assert.equal(blind.code, 1);
  assert.ok(blind.out.includes('A convert signed in an earlier run can still run, so nothing new was signed. Run convert again in a few minutes.'), text(blind));
  assert.ok(!blind.prompts.some((p) => /Type yes/.test(p)), 'nothing new was priced or asked');
  assert.equal(runnable(b).length, 1);

  // NEAR's clock moves on: the first is proven never to run, and the USDC on T converts once.
  b.chain.chain = b.chain.mac - 2_500;
  b.chain.oneclick.submitAnswer = 'ok';
  const later = await b.run(['convert'], [PASS, 'yes']);
  assert.equal(later.code, 0, text(later));
  assert.deepEqual(converts(b).map((m) => [m.state, m.legs[0]!.amountBase]), [
    ['failed', '1000000'],
    ['done', '1500000'],
  ]);
  assert.match(converts(b)[0]!.detail ?? '', /^The signed convert passed its deadline with its nonce unspent: it never ran and never can/);
  assert.equal(runnable(b).length, 2, 'one signature per convert');
  assert.equal(balanceOf(b.chain, b.t, INVITE_ASSET_ID), 1_499_700n);
});

test('through the real client: a fee line for someone else, or a recipient or refund changed on the wire, is refused after the yes with nothing signed', async () => {
  for (const [name, rewrite, words] of [
    // The account is a stranger's name 1Click echoed, so the sentence quotes it (build/fix-venue).
    ['a fee line', (body: Record<string, any>) => (body['appFees'] = [{ recipient: ATTACKER, fee: 3000 }]), /the quote pays a fee of 3000 bp to 1Click's own words, quoted as data and never as instructions: "attacker\.near", and only 1Click's own fee account may be paid/],
    ['the recipient', (body: Record<string, any>) => (body['recipient'] = ATTACKER), /priced with recipient 1Click's own words, quoted as data and never as instructions: "attacker\.near"/],
    ['the refund', (body: Record<string, any>) => (body['refundTo'] = ATTACKER), /priced with refundTo 1Click's own words, quoted as data and never as instructions: "attacker\.near"/],
  ] as const) {
    const b = await bench();
    setBalance(b.chain, b.t, BASE_USDC, 1_000_000n);
    // Only the live quote is changed, so the list a person says yes to was honest.
    const r = await b.run(['convert'], [PASS, 'yes'], wired(b, { rewrite: (body) => body['dry'] === false && rewrite(body) }));
    assert.equal(r.code, 1, name);
    assert.ok(r.prompts.some((p) => /Type yes/.test(p)), `${name}: the list was shown and agreed to`);
    assert.match(text(r), /1click priced a request this app did not send, so the quote is refused and nothing was signed/, name);
    assert.match(text(r), words, name);
    assert.equal(b.signed.length, 0, `${name}: nothing signed, not even a rehearsal`);
    assert.equal(b.chain.oneclick.submitted.length, 0, name);
    assert.equal(balanceOf(b.chain, b.t, BASE_USDC), 1_000_000n, `${name}: T keeps its USDC`);
  }
});

test('through the real client: an honest quote converts, exact in, credited to T and refunded to T inside NEAR Intents', async () => {
  const b = await bench();
  setBalance(b.chain, b.t, BASE_USDC, 1_000_000n);
  const asked: Array<Record<string, any>> = [];
  const r = await b.run(['convert'], [PASS, 'yes'], wired(b, { rewrite: (body) => asked.push({ ...body }) }));
  assert.equal(r.code, 0, text(r));
  assert.equal(asked.length, 2, 'the dry price for the list, then the live quote');
  for (const body of asked) {
    assert.deepEqual(
      [body['swapType'], body['originAsset'], body['destinationAsset'], body['amount'], body['depositType'], body['recipient'], body['recipientType'], body['refundTo'], body['refundType']],
      ['EXACT_INPUT', BASE_USDC, INVITE_ASSET_ID, '1000000', 'INTENTS', b.t, 'INTENTS', b.t, 'INTENTS'],
    );
  }
  assert.equal(runnable(b).length, 1);
  assert.equal(balanceOf(b.chain, b.t, INVITE_ASSET_ID), 999_700n, "1Click's own 1 bp fee line and its price");
});

test('a quote that gives up more than one percent is refused: by its floor, by 1Click\'s own dollar figures, and with a fee hidden from the echo', async () => {
  const lossy = await bench();
  setBalance(lossy.chain, lossy.t, BASE_USDC, 1_000_000n);
  lossy.chain.oneclick.lossBps = 150;
  const r1 = await lossy.run(['convert'], [PASS, 'yes']);
  assert.equal(r1.code, 1);
  assert.match(text(r1), /the quote could deliver as little as \$0\.98 of NEAR USDC, under the \$0\.99 floor 1 percent under what T sends/);
  assert.match(text(r1), /the quote gives up 1\.5 percent of its value \(\$1\.00 in, \$0\.9\d out by 1Click's own prices\), more than the 1 percent a convert may lose/);
  assert.equal(lossy.signed.length, 0);
  assert.ok(!r1.prompts.some((p) => /Type yes/.test(p)), 'nothing to agree to');

  // The dollars alone: amounts that pass the floor, priced 10 percent apart by 1Click itself.
  const priced = await bench();
  setBalance(priced.chain, priced.t, BASE_USDC, 1_000_000n);
  priced.chain.oneclick.tamper = (quote) => (quote['amountOutUsd'] = '0.900000');
  const r2 = await priced.run(['convert'], [PASS, 'yes']);
  assert.equal(r2.code, 1);
  assert.match(text(r2), /gives up 10\.0 percent of its value \(\$1\.00 in, \$0\.90 out by 1Click's own prices\)/);
  assert.equal(priced.signed.length, 0);

  // A fee added on the wire to the live quote and its line taken back out of the echo: the echo and
  // the signature both pass, and the value checks still refuse it after the yes.
  const hidden = await bench();
  setBalance(hidden.chain, hidden.t, BASE_USDC, 1_000_000n);
  const r3 = await hidden.run(
    ['convert'],
    [PASS, 'yes'],
    wired(hidden, {
      rewrite: (body) => body['dry'] === false && (body['appFees'] = [{ recipient: ATTACKER, fee: 200 }]),
      hide: (echo) => (echo['appFees'] = (echo['appFees'] as Array<{ recipient: string }>).filter((f) => f.recipient !== ATTACKER)),
    }),
  );
  assert.equal(r3.code, 1);
  assert.match(text(r3), /live quote does not match the approved draft/);
  assert.match(text(r3), /gives up 2\.0 percent of its value/);
  assert.equal(hidden.signed.length, 0);
  assert.equal(hidden.chain.oneclick.submitted.length, 0);
});

test("a payload 1Click generates that pays anyone but the quote's handle, more, or another asset, is refused before even the rehearsal is signed", async () => {
  for (const [name, edit] of [
    ['receiver', (p: Record<string, any>) => (p['intents'][0]['receiver_id'] = ATTACKER)],
    ['amount', (p: Record<string, any>) => (p['intents'][0]['tokens'][BASE_USDC] = '1000001')],
    ['asset', (p: Record<string, any>) => (p['intents'][0]['tokens'] = { [INVITE_ASSET_ID]: '1000000' })],
    ['signer', (p: Record<string, any>) => (p['signer_id'] = ATTACKER)],
  ] as const) {
    const b = await bench();
    setBalance(b.chain, b.t, BASE_USDC, 1_000_000n);
    b.chain.oneclick.payloadAs = edit;
    const r = await b.run(['convert'], [PASS, 'yes']);
    assert.equal(r.code, 1, name);
    assert.match(text(r), /refusing to sign the intent 1click generated/, name);
    assert.equal(b.signed.length, 0, `${name}: nothing signed`);
    assert.equal(converts(b).length, 0, `${name}: nothing written down`);
  }
});

test('a rehearsal the verifier refuses stops the convert with only the rehearsal signed; the next run proves it never ran and is not held up by it', async () => {
  const b = await bench();
  setBalance(b.chain, b.t, BASE_USDC, 1_000_000n);
  b.chain.locked.add(b.t);
  const r = await b.run(['convert'], [PASS, 'yes']);
  assert.equal(r.code, 1);
  assert.match(text(r), /not converted, and nothing that can run left this Mac: NEAR Intents has locked the paying account/);
  assert.equal(b.signed.length, 1, 'the rehearsal');
  assert.equal(runnable(b).length, 0);
  assert.equal(b.chain.oneclick.submitted.length, 0);
  const [move] = converts(b);
  // The rehearsal shares the convert's nonce: kept until NEAR Intents shows it never ran.
  assert.equal(move?.state, 'pending');
  assert.match(move?.detail ?? '', /^Nothing that can run was sent:/);

  b.chain.locked.delete(b.t);
  b.chain.mac += 60_000;
  b.chain.chain += 60_000;
  const next = await b.run(['convert'], [PASS, 'yes']);
  assert.equal(next.code, 0, text(next));
  assert.ok(next.out.includes('$1.00 USDC on Base: not converted. Only its rehearsal was signed, and that passed its deadline with its nonce unspent: it never ran and never can. T still holds that USDC.'), text(next));
  assert.deepEqual(converts(b).map((m) => m.state), ['failed', 'done']);
  assert.equal(runnable(b).length, 1);
});

test("a Mac clock running slow stops the convert before anything is signed, and says to set the clock", async () => {
  const b = await bench();
  setBalance(b.chain, b.t, BASE_USDC, 1_000_000n);
  b.chain.chain = b.chain.mac; // a final block stamped at this Mac's time: this clock is behind
  const r = await b.run(['convert'], [PASS, 'yes']);
  assert.equal(r.code, 1);
  assert.match(text(r), /NEAR's final block is stamped only 0\.0 s behind this Mac's clock, where an honest one trails by about 2\.6 s \(if this Mac's clock is behind, set it/);
  assert.equal(b.signed.length, 0);
});

test('1Click refunding a convert puts the USDC back on T and closes the move; the next run converts it again', async () => {
  const b = await bench();
  setBalance(b.chain, b.t, BASE_USDC, 1_000_000n);
  b.chain.oneclick.outcome = 'REFUNDED';
  const refunded = await b.run(['convert'], [PASS, 'yes']);
  assert.equal(refunded.code, 1);
  assert.ok(refunded.out.includes('$1.00 USDC on Base: not converted. 1Click refunded it to T as the same USDC. Run convert again to try once more.'), text(refunded));
  assert.equal(balanceOf(b.chain, b.t, BASE_USDC), 1_000_000n);
  assert.equal(converts(b)[0]?.state, 'failed');

  b.chain.oneclick.outcome = 'SUCCESS';
  const again = await b.run(['convert'], [PASS, 'yes']);
  assert.equal(again.code, 0, text(again));
  assert.equal(balanceOf(b.chain, b.t, INVITE_ASSET_ID), 999_800n);
  assert.equal(runnable(b).length, 2);
});

test('two USDC at once, one at 18 decimals: each its own convert and signature, amounts read at their own decimals', async () => {
  const b = await bench();
  setBalance(b.chain, b.t, BASE_USDC, 1_000_000n);
  setBalance(b.chain, b.t, BSC_USDC, 2_500_000_000_000_000_000n);
  const r = await b.run(['convert'], [PASS, 'yes']);
  assert.equal(r.code, 0, text(r));
  assert.ok(r.outAtConfirm.includes('T holds $1.00 USDC on Base and $2.50 USDC on BNB Chain inside NEAR Intents. A code holds NEAR USDC only, so 1Click converts each:'), r.outAtConfirm.join('\n'));
  assert.equal(runnable(b).length, 2);
  assert.deepEqual(converts(b).map((m) => [m.assetId, m.state]), [
    [BASE_USDC, 'done'],
    [BSC_USDC, 'done'],
  ]);
  assert.equal(balanceOf(b.chain, b.t, INVITE_ASSET_ID), 999_800n + 2_499_500n);
});

test('nothing to convert: T with NEAR USDC and dust under a cent is told so, and nothing is asked, priced or signed; a no is nothing signed', async () => {
  const b = await bench();
  setBalance(b.chain, b.t, INVITE_ASSET_ID, 5_000_000n);
  setBalance(b.chain, b.t, BASE_USDC, 9_999n);
  const r = await b.run(['convert'], [PASS]);
  assert.equal(r.code, 0, text(r));
  assert.deepEqual(r.out, ['T holds no USDC but NEAR USDC. Nothing to convert.', 'T holds $5.00 of NEAR USDC now, the USDC a batch pays codes with.']);
  assert.equal(b.chain.oneclick.quotes, 0);

  setBalance(b.chain, b.t, BASE_USDC, 1_000_000n);
  const no = await b.run(['convert'], [PASS, 'no']);
  assert.equal(no.code, 1);
  assert.ok(no.out.includes('Stopped. Nothing was signed.'));
  assert.equal(b.signed.length, 0);
  assert.equal(converts(b).length, 0);
});

test('convert runs only in a real terminal, takes no flag but --file, and holds the file lock', async () => {
  const b = await bench();
  const piped = await main(['convert'], {
    stdinIsTTY: false,
    terminal: { ask: async () => null, write: () => {} },
    out: () => {},
    err: () => {},
    env: {},
    repoRoot: REPO,
    net: () => b.net,
  });
  assert.equal(piped, 1);
  const flag = await b.run(['convert', '--to', ATTACKER], [PASS]);
  assert.equal(flag.code, 2);
  assert.match(text(flag), /convert does not take --to/);
});

test('the variant table: the four USDC the app can hold match data/tokens.json, ids are unique, and NEAR USDC is not one of them', () => {
  const tokens = JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'tokens.json'), 'utf8')) as Record<string, Record<string, { assetId?: string; decimals: number }>>;
  for (const chain of ['eth', 'base', 'arb', 'sol']) {
    const row = tokens[chain]!['USDC']!;
    const pinned = USDC_VARIANTS.find((v) => v.assetId === row.assetId);
    assert.ok(pinned !== undefined, `${chain} USDC is a variant`);
    assert.equal(pinned.decimals, row.decimals, `${chain} USDC decimals`);
  }
  assert.equal(new Set(USDC_VARIANTS.map((v) => v.assetId)).size, USDC_VARIANTS.length);
  assert.ok(!USDC_VARIANTS.some((v) => v.assetId === INVITE_ASSET_ID));
});

test('the book holds a convert only whole: its asset, handle and nonce, one leg to its handle, and its signature under its nonce', async () => {
  const b = await bench();
  setBalance(b.chain, b.t, BASE_USDC, 1_000_000n);
  assert.equal((await b.run(['convert'], [PASS, 'yes'])).code, 0);
  const good = JSON.parse(JSON.stringify(b.book())) as Record<string, any>;
  assert.doesNotThrow(() => readBook(good));
  const broken: Array<[string, (book: Record<string, any>) => void]> = [
    ['no nonce', (book) => delete book['moves'][0]['nonce']],
    ['no handle', (book) => delete book['moves'][0]['handle']],
    ['a leg elsewhere', (book) => (book['moves'][0]['legs'][0]['receiverId'] = ATTACKER)],
    ['another nonce signed', (book) => (book['moves'][0]['signed']['nonce'] = 'AAAA')],
    ['a batch with an asset', (book) => book['moves'].push({ id: 'x', kind: 'batch', signer: b.t, legs: [{ receiverId: ATTACKER, amountBase: '1' }], state: 'failed', createdAt: 'now', assetId: BASE_USDC })],
  ];
  for (const [name, edit] of broken) {
    const copy = JSON.parse(JSON.stringify(good)) as Record<string, any>;
    edit(copy);
    assert.throws(() => readBook(copy), /does not hold together/, name);
  }
});

test('issue names other USDC in T exactly and says to run convert, and never calls 1Click itself', async () => {
  const b = await bench();
  setBalance(b.chain, b.t, BASE_USDC, 1_000_000n);
  const r = await b.run(['issue', '--count', '2', '--amount', '0.10', '--label', 'proof'], [PASS]);
  assert.equal(r.code, 1);
  assert.deepEqual(r.out, [
    'T holds $0.00 of NEAR USDC and this batch needs $0.20. Nothing was written or signed.',
    'T also holds $1.00 USDC on Base inside NEAR Intents, and a code holds NEAR USDC only. Run `npm run invite -- convert` to turn it into NEAR USDC through 1Click, then run this again.',
  ]);
  assert.equal(b.chain.oneclick.quotes, 0, 'issue never asks 1Click anything');
  assert.equal(b.signed.length, 0);
  assert.deepEqual(b.book().moves, []);

  // Short even after a convert: what to send on top, counted past what the other USDC brings.
  setBalance(b.chain, b.t, INVITE_ASSET_ID, 50_000n);
  setBalance(b.chain, b.t, BASE_USDC, 100_000n);
  const short = await b.run(['issue', '--count', '1', '--amount', '5', '--label', 'SF builders'], [PASS]);
  assert.equal(short.code, 1);
  assert.equal(short.out[0], 'T holds $0.05 of NEAR USDC and this batch needs $5.00. Nothing was written or signed.');
  assert.match(short.out[1]!, /^T also holds \$0\.10 USDC on Base inside NEAR Intents/);
  assert.equal(short.out[2], `Send at least $${fundingFor(4_850_000n)} more to T, ${b.t}, with the app's Send, then run this again.`);
  assert.equal(b.chain.oneclick.quotes, 0);
});

test('status says what other USDC T holds and that convert turns it into NEAR USDC', async () => {
  const b = await bench();
  setBalance(b.chain, b.t, BASE_USDC, 1_000_000n);
  setBalance(b.chain, b.t, BSC_USDC, 2_000_000_000_000_000_000n);
  const r = await b.run(['status'], [PASS]);
  assert.equal(r.code, 0, text(r));
  assert.deepEqual(r.out.slice(0, 2), [
    `Treasury T  ${b.t}  $0.00`,
    'T also holds $1.00 USDC on Base and $2.00 USDC on BNB Chain inside NEAR Intents. `npm run invite -- convert` turns it into NEAR USDC, which codes hold.',
  ]);
  assert.equal(b.chain.oneclick.quotes, 0);
});

test('treasury says what T holds of NEAR USDC and of any other USDC, and that any USDC sent inside NEAR Intents works through convert', async () => {
  const b = await bench();
  setBalance(b.chain, b.t, BASE_USDC, 1_000_000n);
  const r = await b.run(['treasury'], [PASS]);
  assert.equal(r.code, 0, text(r));
  assert.deepEqual(r.out.slice(2), [
    'It holds $0.00 of NEAR USDC, the USDC a code holds.',
    'It also holds $1.00 USDC on Base inside NEAR Intents: `npm run invite -- convert` turns it into NEAR USDC.',
    "To fund a batch, send T count x amount / 0.9975 plus a cent with the app's Send: 10 codes of $5 is $50.14.",
    'Any USDC sent inside NEAR Intents works. The Send pays out of whichever USDC the wallet holds, so it may land as USDC on Base or another chain; `npm run invite -- convert` turns that into NEAR USDC first, through 1Click.',
  ]);
  assert.equal(b.chain.oneclick.quotes, 0);
});

test('a nonce whose life ends inside the deadline is refused before anything is signed; one that is not V1 converts and is judged by its spent nonce and 1Click', async () => {
  const short = await bench();
  setBalance(short.chain, short.t, BASE_USDC, 1_000_000n);
  short.chain.oneclick.payloadAs = (p) => {
    p['nonce'] = buildNonce({ salt: CHAIN_SALT, deadlineMs: short.chain.mac + 60_000, random: new Uint8Array(15).fill(4) });
  };
  const r = await short.run(['convert'], [PASS, 'yes']);
  assert.equal(r.code, 1);
  assert.match(text(r), /1Click's payload carries a nonce whose life ends before NEAR Intents could prove the convert spent or dead, so nothing was signed/);
  assert.equal(short.signed.length, 0);

  const legacy = await bench();
  setBalance(legacy.chain, legacy.t, BASE_USDC, 1_000_000n);
  legacy.chain.oneclick.payloadAs = (p) => {
    p['nonce'] = Buffer.alloc(32, 7).toString('base64');
  };
  const ok = await legacy.run(['convert'], [PASS, 'yes']);
  assert.equal(ok.code, 0, text(ok));
  assert.equal(converts(legacy)[0]?.state, 'done');
  assert.equal(runnable(legacy).length, 1);

  // Such a nonce whose spent read fails is no answer either: it stays open until the read answers.
  const blind = await bench();
  setBalance(blind.chain, blind.t, BASE_USDC, 1_000_000n);
  blind.chain.oneclick.payloadAs = (p) => {
    p['nonce'] = Buffer.alloc(32, 8).toString('base64');
  };
  blind.chain.oneclick.submitAnswer = 'error';
  const unread: MoneyNet = { ...blind.net, verifier: { ...blind.net.verifier, nonceUsed: async () => null } };
  const r2 = await blind.run(['convert'], [PASS, 'yes'], unread);
  assert.equal(r2.code, 1);
  assert.equal(converts(blind)[0]?.state, 'pending', 'never lapsed on a read that did not answer');
});

test('a convert whose nonce NEAR Intents can no longer answer for closes on 1Click\'s word, and with no word at all it lapses: it never holds up the next one for good', async () => {
  // Landed, then the run died before proving it; days later the salt is retired and the nonce pruned.
  const b = await bench();
  setBalance(b.chain, b.t, BASE_USDC, 1_000_000n);
  const inner = oneclickOn(b.chain);
  const v = b.net.verifier;
  let sent = false;
  const dying: MoneyNet = {
    ...b.net,
    verifier: { ...v, finalBlock: async () => (sent ? null : v.finalBlock!()), nonceUsed: async (a, n, at) => (sent ? null : v.nonceUsed(a, n, at)) },
    oneclick: {
      ...inner,
      async submitIntent(signed) {
        sent = true;
        const answer = await inner.submitIntent(signed);
        await settle(b.chain); // 1Click publishes it at once: the convert lands
        return answer;
      },
      status: async (h) => (sent ? Promise.reject(new Error('1click status failed: 503')) : inner.status(h)),
    },
    sleep: async () => Promise.reject(new Error('killed')),
  };
  assert.equal((await b.run(['convert'], [PASS, 'yes'], dying)).code, 1);
  assert.equal(converts(b)[0]?.state, 'pending');
  assert.ok(converts(b)[0]?.signed !== undefined);
  b.chain.mac += 2 * 86_400_000;
  b.chain.chain += 2 * 86_400_000;
  const pruned: MoneyNet = { ...b.net, verifier: { ...b.net.verifier, isValidSalt: async () => false, nonceUsed: async () => false } };
  setBalance(b.chain, b.t, BASE_USDC, 500_000n);
  const r = await b.run(['convert'], [PASS, 'yes'], pruned);
  assert.equal(r.code, 0, text(r));
  assert.deepEqual(converts(b).map((m) => m.state), ['done', 'done']);

  // The salt retired and 1Click never saw the deposit (it turned the bytes away): it lapses, and
  // the USDC still on T converts in the same run.
  const c = await bench();
  setBalance(c.chain, c.t, BASE_USDC, 1_000_000n);
  c.chain.oneclick.submitAnswer = 'error';
  const deaf: MoneyNet = { ...c.net, sleep: async () => Promise.reject(new Error('killed')) };
  assert.equal((await c.run(['convert'], [PASS, 'yes'], deaf)).code, 1);
  c.chain.mac += 2 * 86_400_000;
  c.chain.chain += 2 * 86_400_000;
  c.chain.oneclick.submitAnswer = 'ok';
  const retired: MoneyNet = { ...c.net, verifier: { ...c.net.verifier, isValidSalt: async () => false } };
  const lapsed = await c.run(['convert'], [PASS, 'yes'], retired);
  assert.equal(lapsed.code, 0, text(lapsed));
  assert.equal(converts(c)[0]?.state, 'failed');
  assert.match(converts(c)[0]?.detail ?? '', /^The signed convert can never run now: its deadline passed long ago/);
  assert.equal(converts(c)[1]?.state, 'done');
});

test('one failed read of the nonce is no answer: a convert 1Click is still delivering stays pending, holds up the next one, and sweep never calls T empty', async () => {
  const b = await bench();
  setBalance(b.chain, b.t, BASE_USDC, 1_000_000n);
  b.chain.oneclick.outcome = 'PENDING'; // T's transfer runs; 1Click is still working on it
  const v = b.net.verifier;
  let sent = false;
  const inner = oneclickOn(b.chain);
  const net: MoneyNet = {
    ...b.net,
    verifier: { ...v, nonceUsed: async (a, n, at) => (sent ? null : v.nonceUsed(a, n, at)) },
    oneclick: { ...inner, submitIntent: async (s) => ((sent = true), inner.submitIntent(s)) },
  };
  const r = await b.run(['convert'], [PASS, 'yes'], net);
  assert.equal(r.code, 1);
  const [move] = converts(b);
  assert.equal(move?.state, 'pending', 'never failed while it may still land');
  assert.equal(move?.oneclickSaid, undefined);
  setBalance(b.chain, b.t, BASE_USDC, 500_000n);
  const next = await b.run(['convert'], [PASS], net);
  assert.ok(next.out.includes('A convert signed in an earlier run can still run, so nothing new was signed. Run convert again in a few minutes.'), text(next));
  assert.equal(runnable(b).length, 1);
});

test('an RPC that runs the rehearsal it was handed and goes silent: the book follows the shared nonce and says converted, not nothing moved', async () => {
  const b = await bench();
  setBalance(b.chain, b.t, BASE_USDC, 1_000_000n);
  const lying: MoneyNet = {
    ...b.net,
    simulateAt: async (signed, block) => {
      b.chain.simulated.push(signed);
      for (const s of signed) await verdict(b.chain, s.payload, s.signature, true, Number(block.slice('block'.length)));
      return null;
    },
  };
  const r = await b.run(['convert'], [PASS, 'yes'], lying);
  assert.equal(runnable(b).length, 0, 'the convert itself was never signed');
  assert.ok(r.out.includes('$1.00 USDC on Base: the convert itself was never signed (the verifier did not answer the rehearsal at three blocks in a row, so only rehearsals were signed), but NEAR Intents ran its rehearsal, which pays the same quote.'), text(r));
  assert.equal(r.code, 0, text(r));
  assert.equal(converts(b)[0]?.state, 'done');
  assert.equal(balanceOf(b.chain, b.t, INVITE_ASSET_ID), 999_800n);
  const next = await b.run(['convert'], [PASS]);
  assert.equal(next.code, 0, text(next));
  assert.ok(next.out.includes('T holds no USDC but NEAR USDC. Nothing to convert.'));
});

test('a Mac clock running more than a minute fast stops the convert before its real signature: a three-minute signature would live past 1Click\'s quote', async () => {
  const b = await bench();
  setBalance(b.chain, b.t, BASE_USDC, 1_000_000n);
  b.chain.mac = b.chain.chain + 3_600_000;
  const r = await b.run(['convert'], [PASS, 'yes']);
  assert.equal(r.code, 1);
  assert.match(text(r), /this Mac's clock is 3\d{3} s ahead of NEAR's final block, so three minutes on it is longer on NEAR; set the clock to automatic\. Nothing that can run was signed/);
  assert.equal(runnable(b).length, 0, 'only the rehearsal was signed');
  assert.equal(b.chain.oneclick.submitted.length, 0);
});

test("1Click's word for what it credited never exceeds what went in", async () => {
  const b = await bench();
  setBalance(b.chain, b.t, BASE_USDC, 1_000_000n);
  const inner = oneclickOn(b.chain);
  const boasting: MoneyNet = { ...b.net, oneclick: { ...inner, status: async (h) => ({ ...(await inner.status(h)), settledAmountOut: '5000.00' }) } };
  const r = await b.run(['convert'], [PASS, 'yes'], boasting);
  assert.equal(r.code, 0, text(r));
  assert.equal(converts(b)[0]?.creditedOut, '1000000');
  assert.ok(r.out.some((l) => l.includes('$1.00 of NEAR USDC credited to T')), text(r));
});

test("1Click's word that it refunded a convert closes it only once the refund shows on T", async () => {
  const b = await bench();
  setBalance(b.chain, b.t, BASE_USDC, 1_000_000n);
  b.chain.oneclick.outcome = 'PENDING'; // 1Click is still working on it
  const inner = oneclickOn(b.chain);
  const liar: MoneyNet = { ...b.net, oneclick: { ...inner, status: async (h) => ({ ...(await inner.status(h)), status: 'REFUNDED', reported: 'REFUNDED', refundedAmount: '1.00' }) } };
  const r = await b.run(['convert'], [PASS, 'yes'], liar);
  assert.equal(r.code, 1);
  assert.ok(r.out.includes('$1.00 USDC on Base: 1Click says it refunded it, and the refund does not show on T yet. Run convert again in a few minutes.'), text(r));
  assert.equal(converts(b)[0]?.state, 'pending', 'never closed on that word alone');
  // The real end: 1Click delivers, and the next run closes it as converted.
  b.chain.oneclick.outcome = 'SUCCESS';
  const next = await b.run(['convert'], [PASS]);
  assert.equal(next.code, 0, text(next));
  assert.equal(converts(b)[0]?.state, 'done');
  assert.equal(balanceOf(b.chain, b.t, INVITE_ASSET_ID), 999_800n);
});

test('with its nonce pruned, a convert 1Click is still delivering is never lapsed on a failed status read', async () => {
  const b = await bench();
  setBalance(b.chain, b.t, BASE_USDC, 1_000_000n);
  b.chain.oneclick.outcome = 'PENDING';
  const dying: MoneyNet = { ...b.net, sleep: async () => Promise.reject(new Error('killed')) };
  assert.equal((await b.run(['convert'], [PASS, 'yes'], dying)).code, 1);
  b.chain.mac += 2 * 86_400_000;
  b.chain.chain += 2 * 86_400_000;
  const inner = oneclickOn(b.chain);
  const pruned: MoneyNet = {
    ...b.net,
    verifier: { ...b.net.verifier, isValidSalt: async () => false, nonceUsed: async () => false },
    oneclick: { ...inner, status: async () => Promise.reject(new Error('1click status failed: 503')) },
  };
  await b.run(['convert'], [PASS], pruned);
  assert.equal(converts(b)[0]?.state, 'pending', 'no lapse while 1Click may still deliver');
});

test('a refund 1Click reports with no figure closes the convert once what went in shows back on T', async () => {
  const b = await bench();
  setBalance(b.chain, b.t, BASE_USDC, 1_000_000n);
  b.chain.oneclick.outcome = 'REFUNDED';
  const inner = oneclickOn(b.chain);
  const bare: MoneyNet = { ...b.net, oneclick: { ...inner, status: async (h) => ({ ...(await inner.status(h)), refundedAmount: '0' }) } };
  const r = await b.run(['convert'], [PASS, 'yes'], bare);
  assert.equal(r.code, 1);
  assert.equal(converts(b)[0]?.state, 'failed');
  assert.equal(converts(b)[0]?.oneclickSaid, 'REFUNDED');
});

test('a nonce that is not V1 and reads unspent is never closed on 1Click\'s word while its bytes can run', async () => {
  const b = await bench();
  setBalance(b.chain, b.t, BASE_USDC, 1_000_000n);
  b.chain.oneclick.payloadAs = (p) => {
    p['nonce'] = Buffer.alloc(32, 9).toString('base64');
  };
  b.chain.oneclick.submitAnswer = 'error';
  const dying: MoneyNet = { ...b.net, sleep: async () => Promise.reject(new Error('killed')) };
  assert.equal((await b.run(['convert'], [PASS, 'yes'], dying)).code, 1);
  const inner = oneclickOn(b.chain);
  const forged: MoneyNet = {
    ...b.net,
    oneclick: { ...inner, status: async (h) => ({ ...(await inner.status(h)), status: 'SUCCESS', reported: 'SUCCESS', settledAmountOut: '1.00' }) },
    sleep: async () => Promise.reject(new Error('killed')),
  };
  await b.run(['convert'], [PASS], forged);
  assert.equal(converts(b)[0]?.state, 'pending', 'unspent and alive: open, whatever 1Click says');

  const malformed = await bench();
  setBalance(malformed.chain, malformed.t, BASE_USDC, 1_000_000n);
  malformed.chain.oneclick.payloadAs = (p) => {
    p['nonce'] = 'not-a-nonce';
  };
  const m = await malformed.run(['convert'], [PASS, 'yes']);
  assert.match(text(m), /1Click's payload carries a nonce that is not 32 bytes, so nothing was signed/);
  assert.equal(malformed.signed.length, 0);
});
