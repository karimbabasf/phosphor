// The proof script (spec, "Proof", step 0) offline: a fake intents.near, relay and 1Click that check
// signatures, nonces and balances like the real ones. The live run is the lead's; this pins what
// it does and what it writes down. Throwaway keys and codes only, made at run time.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { containsInviteCode } from '../../src/invite/code.ts';
import { INVITE_ASSET_ID } from '../../src/invite/payload.ts';
import { takeLock } from '../../scripts/invite/file.ts';
import { proofMain } from '../../scripts/invite-proof.ts';
import type { ProofFile, ProofNet } from '../../scripts/invite-proof.ts';
import { balanceOf, freshChain, netOn, oneclickOn, setBalance } from './helpers/invite-chain.ts';
import type { Chain } from './helpers/invite-chain.ts';
import { TEST_QUOTE_KEY } from './helpers/signed-quote.ts';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const SINK = '0x9858effd232b4033e47d90003d41ec34ecaeda94';
const BASE_USDC = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';

type Run = { code: number; out: string[]; err: string[] };

type Bench = { dir: string; file: string; chain: Chain; net: ProofNet; run(argv: string[], env?: NodeJS.ProcessEnv, net?: ProofNet): Promise<Run>; proof(): ProofFile };

function bench(): Bench {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-invite-proof-'));
  const file = path.join(dir, 'proof', 'invite-proof.json');
  const chain = freshChain();
  const net: ProofNet = { ...netOn(chain), oneclick: oneclickOn(chain), quoteKey: TEST_QUOTE_KEY };
  return {
    dir,
    file,
    chain,
    net,
    async run(argv, env = {}, over) {
      const r: Run = { code: -1, out: [], err: [] };
      r.code = await proofMain(argv, { out: (l) => r.out.push(l), err: (l) => r.err.push(l), env, repoRoot: REPO, net: () => over ?? net });
      return r;
    },
    proof: () => JSON.parse(fs.readFileSync(file, 'utf8')) as ProofFile,
  };
}

type Body = { signer_id: string; intents: Array<{ receiver_id: string; tokens: Record<string, string> }> };

function assertNothingSpendable(text: string, proof: ProofFile): void {
  assert.equal(containsInviteCode(text), false, 'a code reached the output');
  for (const c of proof.book.codes) assert.ok(!text.includes(c.code));
  for (const key of [proof.book.treasury.key, proof.receiver.key]) assert.ok(!text.includes(key.slice(2)), 'a key reached the output');
}

test('init makes a 0600 proof file outside the repo, prints the two addresses and never a key, and never replaces one', async () => {
  const b = bench();
  const inside = await b.run(['init', '--file', path.join(REPO, 'proof.json')]);
  assert.equal(inside.code, 1);
  assert.match(inside.err.join('\n'), /outside the repo working copy/);
  assert.equal(fs.existsSync(path.join(REPO, 'proof.json')), false);

  const r = await b.run(['init', '--file', b.file]);
  assert.equal(r.code, 0, r.err.join('\n'));
  assert.equal(fs.statSync(b.file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(b.file)).mode & 0o777, 0o700);
  const proof = b.proof();
  assert.ok(r.out.includes(`Treasury T: ${proof.book.treasury.address}`));
  assert.ok(r.out.includes(`Throwaway receiver: ${proof.receiver.address}`));
  assertNothingSpendable(r.out.join('\n'), proof);

  const before = fs.readFileSync(b.file);
  const again = await b.run(['init', '--file', b.file]);
  assert.equal(again.code, 1);
  assert.deepEqual(fs.readFileSync(b.file), before);

  fs.chmodSync(b.file, 0o644);
  const loose = await b.run(['report', '--file', b.file]);
  assert.equal(loose.code, 1);
  assert.match(loose.err.join('\n'), /chmod 600/);
});

test('run waits for the deposit, issues two $0.10 codes in one payload, claims one by the relay and one by Plan B, and records it all', async () => {
  const b = bench();
  assert.equal((await b.run(['init', '--file', b.file])).code, 0);
  const t = b.proof().book.treasury.address;
  const receiver = b.proof().receiver.address;
  // Karim's $1 arrives while the script waits.
  let polls = 0;
  const net: ProofNet = {
    ...b.net,
    sleep: async (ms) => {
      b.chain.mac += ms;
      b.chain.chain += ms;
      polls += 1;
      if (polls === 3) b.chain.balances.set(t, 1_000_000n);
    },
  };

  const r = await b.run(['run', '--file', b.file, '--wait-minutes', '5'], {}, net);
  assert.equal(r.code, 0, [...r.out, ...r.err].join('\n'));
  const proof = b.proof();
  const [first, second] = proof.book.codes;
  assert.ok(first !== undefined && second !== undefined);

  // The batch: one payload from T to both codes.
  const batch = JSON.parse(b.chain.published[0]!.payload) as Body;
  assert.equal(batch.signer_id, t);
  assert.deepEqual(batch.intents.map((i) => [i.receiver_id, i.tokens[INVITE_ASSET_ID]]), [
    [first.address, '100000'],
    [second.address, '100000'],
  ]);
  // The relay claim: the first code, to the receiver, with no quote.
  assert.equal(b.chain.published.length, 2, 'the batch and the relay claim, and nothing for Plan B');
  const claim = JSON.parse(b.chain.published[1]!.payload) as Body;
  assert.deepEqual(b.chain.published[1]!.quoteHashes, []);
  assert.equal(claim.signer_id, first.address);
  assert.deepEqual(claim.intents.map((i) => [i.receiver_id, i.tokens[INVITE_ASSET_ID]]), [[receiver, '100000']]);
  // Plan B: the second code signs a transfer to 1Click's handle, through 1Click.
  assert.equal(b.chain.oneclick.submitted.length, 1);
  assert.equal((JSON.parse(b.chain.oneclick.submitted[0]!.payload) as Body).signer_id, second.address);

  const res = proof.results;
  assert.equal(res.funding?.treasuryBefore, '1000000');
  assert.equal(res.issue?.pass, true);
  assert.equal(res.issue?.isNonceUsed, true);
  assert.equal(res.issue?.treasuryBefore, '1000000');
  assert.equal(res.issue?.treasuryAfter, '800000');
  assert.deepEqual(res.issue?.codes?.map((c) => c.after), ['100000', '100000']);

  const relay = res.relayClaim!;
  assert.equal(relay.pass, true, relay.why ?? '');
  assert.equal(relay.record?.route, 'relay');
  assert.deepEqual(relay.before, { code: '100000', receiver: '0' });
  assert.deepEqual(relay.after, { code: '0', receiver: '100000' });
  // The rehearsal went to the simulation only and never ran; the claim itself did.
  assert.deepEqual(relay.nonces?.map((n) => [n.rehearsal === true, n.isNonceUsed]), [[true, false], [false, true]]);
  assert.equal(relay.nonces?.[1]?.intentHash, relay.record?.intentHash);
  assert.equal(relay.relayStatus?.length, 1, 'only the claim itself was asked of the relay');
  assert.equal((relay.relayStatus?.[0]?.answer as { status: string }).status, 'SETTLED');
  assert.ok(relay.audit?.some((a) => a.type === 'invite_claimed'));

  const planB = res.planBClaim!;
  assert.equal(planB.pass, true, planB.why ?? '');
  assert.equal(planB.record?.route, 'oneclick');
  assert.deepEqual(planB.record?.attempts.map((a) => [a.route, a.rehearsal === true]), [['relay', true], ['relay', false], ['oneclick', false]], 'rehearsed, the relay asked first and turning it away, then 1Click');
  assert.deepEqual(planB.before, { code: '100000', receiver: '100000' });
  assert.deepEqual(planB.after, { code: '0', receiver: '199750' });
  assert.equal(planB.record?.creditedBase, '99750');
  assert.equal((planB.oneclickStatus as { status: string }).status, 'SUCCESS');
  assert.equal(planB.nonces?.find((n) => n.route === 'oneclick')?.isNonceUsed, true);
  assert.deepEqual(planB.nonces?.filter((n) => n.route === 'relay').map((n) => n.isNonceUsed), [false, false], 'neither the rehearsal nor the refused relay attempt ran');

  assertNothingSpendable([...r.out, ...r.err].join('\n'), proof);
  const report = await b.run(['report', '--file', b.file]);
  assert.equal(report.code, 0);
  assertNothingSpendable(report.out.join('\n'), proof);
  assert.deepEqual((JSON.parse(report.out.join('\n')) as { results: unknown }).results, proof.results);

  // A second run has nothing left to do and moves nothing.
  const published = b.chain.published.length;
  const again = await b.run(['run', '--file', b.file]);
  assert.equal(again.code, 0);
  assert.equal(b.chain.published.length, published);
});

test('sweep sends every leftover cent, codes, receiver and T, to the address passed', async () => {
  const b = bench();
  assert.equal((await b.run(['init', '--file', b.file])).code, 0);
  const proof0 = b.proof();
  b.chain.balances.set(proof0.book.treasury.address, 1_000_000n);
  assert.equal((await b.run(['run', '--file', b.file])).code, 0);
  // Dust on a used code goes back too.
  b.chain.balances.set(b.proof().book.codes[0]!.address, 7n);

  const own = await b.run(['sweep', '--file', b.file, '--to', proof0.receiver.address]);
  assert.equal(own.code, 2, 'never to one of its own accounts');

  const r = await b.run(['sweep', '--file', b.file, '--to', SINK]);
  assert.equal(r.code, 0, [...r.out, ...r.err].join('\n'));
  const proof = b.proof();
  for (const account of [proof.book.treasury.address, proof.receiver.address, ...proof.book.codes.map((c) => c.address)]) {
    assert.equal(b.chain.balances.get(account) ?? 0n, 0n, `${account} still holds money`);
  }
  assert.equal(b.chain.balances.get(SINK), 800_000n + 199_750n + 7n);
  assert.deepEqual(proof.results.sweep?.map((s) => [s.from, s.amountBase, s.outcome]), [
    [proof.book.codes[0]!.address, '7', 'landed'],
    [proof.receiver.address, '199750', 'landed'],
    [proof.book.treasury.address, '800000', 'landed'],
  ]);
});

test('release-code issues one $5 code and prints it once; the report never carries it; sweep takes it back unclaimed', async () => {
  const b = bench();
  assert.equal((await b.run(['init', '--file', b.file])).code, 0);
  const t = b.proof().book.treasury.address;
  b.chain.balances.set(t, 5_000_000n);
  const r = await b.run(['release-code', '--file', b.file]);
  assert.equal(r.code, 0, [...r.out, ...r.err].join('\n'));
  const proof = b.proof();
  const code = proof.book.codes.find((c) => c.label === 'release proof')!;
  assert.equal(r.out.join('\n').split(`https://phosphor.money/invite#${code.code}`).length - 1, 1, 'printed exactly once');
  assert.equal(b.chain.balances.get(code.address), 5_000_000n);
  assert.deepEqual(proof.results.releaseCode, { address: code.address, amountBase: '5000000', issuedAt: proof.results.releaseCode!.issuedAt });

  const report = await b.run(['report', '--file', b.file]);
  assertNothingSpendable(report.out.join('\n'), proof);

  assert.equal((await b.run(['sweep', '--file', b.file, '--to', SINK])).code, 0);
  assert.equal(b.chain.balances.get(code.address), 0n);
  assert.equal(b.chain.balances.get(SINK), 5_000_000n);
});

test('run takes another code amount when $0.10 is too small for a route, and refuses a nonsense one', async () => {
  const b = bench();
  assert.equal((await b.run(['init', '--file', b.file])).code, 0);
  b.chain.balances.set(b.proof().book.treasury.address, 1_000_000n);
  const bad = await b.run(['run', '--file', b.file, '--amount', '0.001']);
  assert.equal(bad.code, 2);
  assert.equal(b.chain.published.length, 0);
  const r = await b.run(['run', '--file', b.file, '--amount', '0.40']);
  assert.equal(r.code, 0, [...r.out, ...r.err].join('\n'));
  const batch = JSON.parse(b.chain.published[0]!.payload) as Body;
  assert.deepEqual(batch.intents.map((i) => i.tokens[INVITE_ASSET_ID]), ['400000', '400000']);
  assert.equal(b.proof().results.planBClaim?.pass, true);
});

test('run stops cleanly when the deposit never comes, and picks up from there on the next run', async () => {
  const b = bench();
  assert.equal((await b.run(['init', '--file', b.file])).code, 0);
  const r = await b.run(['run', '--file', b.file, '--wait-minutes', '1']);
  assert.equal(r.code, 1);
  assert.match(r.err.join('\n'), /Send \$1 \(or enough for two codes\) to 0x/);
  assert.equal(b.chain.published.length, 0);
  b.chain.balances.set(b.proof().book.treasury.address, 1_000_000n);
  const next = await b.run(['run', '--file', b.file, '--wait-minutes', '1']);
  assert.equal(next.code, 0, [...next.out, ...next.err].join('\n'));
});

// The publish lands, then NEAR stops answering: whatever was sent is signed, sent and unproven.
function goesQuietAfterPublish(b: Bench): ProofNet {
  const relay = b.net.relay;
  return {
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
}

test('a release code cut off part way is finished by release-code itself, its link shown once, and run waits for it', async () => {
  const b = bench();
  assert.equal((await b.run(['init', '--file', b.file])).code, 0);
  b.chain.balances.set(b.proof().book.treasury.address, 5_000_000n);
  const first = await b.run(['release-code', '--file', b.file], {}, goesQuietAfterPublish(b));
  assert.equal(first.code, 1);
  assert.ok(!first.out.join('\n').includes('https://phosphor.money/invite#'));
  b.chain.offline = false;

  const run = await b.run(['run', '--file', b.file]);
  assert.equal(run.code, 1);
  assert.match(run.err.join('\n'), /release code batch .* still pending/);

  const second = await b.run(['release-code', '--file', b.file]);
  assert.equal(second.code, 0, [...second.out, ...second.err].join('\n'));
  const code = b.proof().book.codes.find((c) => c.label === 'release proof')!;
  assert.equal(second.out.join('\n').split(`https://phosphor.money/invite#${code.code}`).length - 1, 1);
  assert.equal(b.chain.published.length, 1, 'the release code was signed and sent once');
});

test('one command at a time per proof file; report still reads beside one', async () => {
  const b = bench();
  assert.equal((await b.run(['init', '--file', b.file])).code, 0);
  const lock = takeLock(b.file);
  try {
    for (const argv of [['run', '--file', b.file], ['sweep', '--file', b.file, '--to', SINK], ['release-code', '--file', b.file]]) {
      const r = await b.run(argv);
      assert.equal(r.code, 1);
      assert.match(r.err.join('\n'), /holds the lock/);
    }
    assert.equal((await b.run(['report', '--file', b.file])).code, 0);
  } finally {
    lock.release();
  }
});

test('a sweep left unproven is resent as the same bytes to where it was signed to pay, never signed again', async () => {
  const b = bench();
  assert.equal((await b.run(['init', '--file', b.file])).code, 0);
  const t = b.proof().book.treasury.address;
  b.chain.balances.set(t, 1_000_000n);
  const first = await b.run(['sweep', '--file', b.file, '--to', SINK], {}, goesQuietAfterPublish(b));
  assert.equal(first.code, 1);
  b.chain.offline = false;
  const other = '0x2222222222222222222222222222222222222222';
  const second = await b.run(['sweep', '--file', b.file, '--to', other]);
  assert.equal(second.code, 0, [...second.out, ...second.err].join('\n'));
  assert.equal(b.chain.balances.get(SINK), 1_000_000n, 'the first sweep landed where it was signed to');
  assert.equal(b.chain.balances.get(other) ?? 0n, 0n);
  const sweeps = b.proof().results.sweep!;
  assert.deepEqual(sweeps.map((s) => [s.from, s.to, s.outcome]), [
    [t, SINK, 'unconfirmed'],
    [t, SINK, 'landed'],
  ]);
  const fromT = b.chain.published.filter((p) => (JSON.parse(p.payload) as Body).signer_id === t);
  assert.equal(new Set(fromT.map((p) => p.signature)).size, 1, 'one signature out of T');
});

test('convert turns USDC on Base in the proof treasury into NEAR USDC and writes it into the report, with no key and no code', async () => {
  const b = bench();
  assert.equal((await b.run(['init', '--file', b.file])).code, 0);
  const t = b.proof().book.treasury.address;
  setBalance(b.chain, t, BASE_USDC, 1_000_000n);

  const r = await b.run(['convert', '--file', b.file]);
  assert.equal(r.code, 0, [...r.out, ...r.err].join('\n'));
  assert.ok(r.out.includes('  $1.00 USDC on Base to about $0.9998 of NEAR USDC, at least $0.99'), r.out.join('\n'));
  assert.ok(r.out.includes(`Next: node scripts/invite-proof.ts run --file ${b.file}`));
  assert.equal(balanceOf(b.chain, t, BASE_USDC), 0n);
  assert.equal(balanceOf(b.chain, t, INVITE_ASSET_ID), 999_800n);
  assert.equal(b.chain.oneclick.submitted.length, 1);

  const [convert] = b.proof().results.convert ?? [];
  assert.equal(convert?.['state'], 'done');
  assert.equal(convert?.['asset'], BASE_USDC);
  assert.equal(convert?.['amountBase'], '1000000');
  assert.equal(convert?.['creditedOut'], '999800');
  assert.equal(convert?.['oneclick'], 'SUCCESS');
  const report = await b.run(['report', '--file', b.file]);
  assert.match(report.out.join('\n'), /"convert": \[/);
  assertNothingSpendable([...r.out, ...report.out].join('\n'), b.proof());
});

test('run with the $1 landed as USDC on Base converts it first and says so, then issues and claims as always', async () => {
  const b = bench();
  assert.equal((await b.run(['init', '--file', b.file])).code, 0);
  const t = b.proof().book.treasury.address;
  let polls = 0;
  const net: ProofNet = {
    ...b.net,
    sleep: async (ms) => {
      b.chain.mac += ms;
      b.chain.chain += ms;
      polls += 1;
      if (polls === 3) setBalance(b.chain, t, BASE_USDC, 1_000_000n);
    },
  };
  const r = await b.run(['run', '--file', b.file, '--wait-minutes', '5'], {}, net);
  assert.equal(r.code, 0, [...r.out, ...r.err].join('\n'));
  assert.ok(
    r.out.includes(
      `T holds $1.00 USDC on Base inside NEAR Intents and not enough NEAR USDC, the USDC a code holds, so this run converts it through 1Click first, as \`node scripts/invite-proof.ts convert --file ${b.file}\` does.`,
    ),
    r.out.join('\n'),
  );
  const proof = b.proof();
  assert.equal(proof.results.convert?.[0]?.['state'], 'done');
  assert.equal(proof.results.funding?.treasuryBefore, '999800');
  assert.equal(proof.results.issue?.pass, true);
  assert.equal(proof.results.relayClaim?.pass, true);
  assert.equal(proof.results.planBClaim?.pass, true);
  assert.equal(balanceOf(b.chain, t, BASE_USDC), 0n);
});

test('release-code with the money landed as another USDC says what arrived and to run convert, without waiting or converting', async () => {
  const b = bench();
  assert.equal((await b.run(['init', '--file', b.file])).code, 0);
  const t = b.proof().book.treasury.address;
  setBalance(b.chain, t, BASE_USDC, 5_030_000n);
  const r = await b.run(['release-code', '--file', b.file]);
  assert.equal(r.code, 1);
  assert.deepEqual(r.err, [
    `T holds $5.03 USDC on Base inside NEAR Intents and less than $5.00 of NEAR USDC, the USDC a code holds. Run \`node scripts/invite-proof.ts convert --file ${b.file}\` to turn it into NEAR USDC, then run this again.`,
  ]);
  assert.equal(b.chain.oneclick.quotes, 0);
  assert.equal(b.proof().book.moves.length, 0);
});

test('sweep says what other USDC it leaves on T, and does not call that swept', async () => {
  const b = bench();
  assert.equal((await b.run(['init', '--file', b.file])).code, 0);
  const t = b.proof().book.treasury.address;
  setBalance(b.chain, t, BASE_USDC, 250_000n);
  const r = await b.run(['sweep', '--file', b.file, '--to', SINK]);
  assert.equal(r.code, 1);
  assert.ok(r.out.includes(`T still holds $0.25 USDC on Base inside NEAR Intents, which sweep does not move. Run \`node scripts/invite-proof.ts convert --file ${b.file}\`, then sweep again.`), r.out.join('\n'));
  assert.equal(r.out.at(-1), 'Some accounts were not swept. Run sweep again.');
});
