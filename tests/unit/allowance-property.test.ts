// No move without a click or a touch ever takes more than the allowance (PHASE2-PLAN.md U9, risk 8).
//
// A thousand agent proposals at random, on the whole app over the chain double
// (tests/unit/helpers/allowance-world.ts): swaps both ways between USDC and USDT, sends, payouts and
// Hyperliquid deposits, at amounts from a cent to twenty thousand dollars, under a click line that
// changes every twenty, with a person clicking a third of what waits. Every money signature is
// counted: the relay swap and the spend rail sign through the app's own intents signer, and the
// double moves coins only for a signature by the account they leave. In the first run every vault
// Touch ID is cancelled; in the second the person says yes to each one.
//
// Run: node --test tests/unit/allowance-property.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decimalToBaseUnits } from '../../src/intents.ts';
import type { Proposal } from '../../src/types.ts';
import { SoftwareChipService } from './helpers/chip-fake.ts';
import { SINK, USDC, USDT, allowanceWorld } from './helpers/allowance-world.ts';
import type { AllowanceWorld } from './helpers/allowance-world.ts';

// mulberry32: a fixed seed, so a failing run can be run again exactly.
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = 20261004;
const RUNS = 1000;
const THRESHOLDS = [0, 1, 5, 25, 100, 1000];

function amountOf(r: () => number): number {
  const band = r();
  const raw = band < 0.6 ? 0.01 + r() * 20 : band < 0.9 ? 20 + r() * 130 : 150 + r() * 19_850;
  return Math.round(raw * 100) / 100;
}

async function propose(w: AllowanceWorld, r: () => number, amount: number): Promise<Proposal> {
  const pick = r();
  if (pick < 0.4) {
    const usdcFirst = r() < 0.7;
    return w.svc.proposeSwap({ chain: 'near', toChain: 'near', fromSymbol: usdcFirst ? 'USDC' : 'USDT', toSymbol: usdcFirst ? 'USDT' : 'USDC', amountIn: String(amount), by: 'agent-seat' });
  }
  if (pick < 0.6) return w.svc.proposeSend({ to: SINK, symbol: 'USDC', amount, where: 'intents', by: 'agent-seat' });
  if (pick < 0.75) return w.svc.proposeSend({ to: SINK, symbol: 'USDC', amount, where: 'eth', by: 'agent-seat' });
  return w.svc.proposeHlDeposit({ amount, by: 'agent-seat' });
}

type Tally = { proposals: number; executed: number; overAllowance: number; clicked: number; topUps: number; sweeps: number };

type SweepLine = { state: string; moves: { asset: string; base: string }[] };

async function run(w: AllowanceWorld, service: SoftwareChipService, touch: 'cancel' | 'yes', seed: number): Promise<Tally> {
  const r = random(seed);
  const tally: Tally = { proposals: 0, executed: 0, overAllowance: 0, clicked: 0, topUps: 0, sweeps: 0 };
  // Every sweep home, as its audit line names it: the one way the vault takes money in here.
  const swept: SweepLine[] = [];
  const unsubscribe = w.audit.subscribe((e) => {
    if (e.type === 'allowance_swept') swept.push(e.data as SweepLine);
  });
  const home = (lines: SweepLine[], asset: string): bigint =>
    lines.filter((l) => l.state === 'done').reduce((sum, l) => sum + l.moves.filter((m) => m.asset === asset).reduce((n, m) => n + BigInt(m.base), 0n), 0n);
  try {
    for (let i = 0; i < RUNS; i += 1) {
      // A new click line every twenty proposals: the policy file is written, and fsynced, each time.
      if (i % 20 === 0) {
        const threshold = THRESHOLDS[Math.floor(r() * THRESHOLDS.length)]!;
        w.policy((p) => {
          p.outbound.humanClickAboveUsd = threshold;
          p.outbound.autoApproveDailyUsd = 1e9;
          p.outbound.maxPerSessionUsd = 1e9;
          p.outbound.maxPerTransactionUsd = 1e6;
        });
      }
      const amount = amountOf(r);
      const vaultBefore = [w.chain.balanceOf(w.vault, USDC), w.chain.balanceOf(w.vault, USDT)];
      const sweptBefore = swept.length;
      const heldBefore = w.chain.balanceOf(w.account, USDC) + w.chain.balanceOf(w.account, USDT);
      const signaturesBefore = service.signatures;
      let row = await w.svc.settled((await propose(w, r, amount)).id, 20_000);
      tally.proposals += 1;
      if (Math.round(amount * 1e6) > Number(heldBefore)) tally.overAllowance += 1;

      // The agent alone: whatever ran, ran with no Touch ID and spent only the allowance.
      assert.equal(service.signatures, signaturesBefore, `run ${i}: no vault Touch ID without a click`);
      if (row.status === 'executed') {
        assert.equal(row.decidedBy, 'policy');
        assert.equal((row.draft as { from?: string }).from?.toLowerCase(), w.account, `run ${i}: a move with no click spends the allowance`);
      }

      // A person clicks a third of what waits for them.
      let topUps: Proposal[] = [];
      if (row.status === 'pending' && r() < 0.34) {
        tally.clicked += 1;
        if (touch === 'cancel') service.touch = 'cancel';
        row = await w.svc.settled((await w.svc.approve(row.id)).id, 20_000);
        service.touch = undefined;
        topUps = w.rows.list().filter((p) => p.draft.kind === 'vault_top_up' && p.draft.forProposal === row.id);
        assert.ok(topUps.length <= 1);
        // One Touch ID per top-up asked; a cancelled one is still the one.
        assert.equal(service.signatures - signaturesBefore, touch === 'yes' ? topUps.filter((p) => p.status !== 'policy_refused').length : 0, `run ${i}: one Touch ID per top-up`);
      }
      if (row.status === 'executed') tally.executed += 1;
      // Whatever sweep the settled move woke has finished before the books are read.
      await w.svc.sweepAllowance!('timer');

      // THE VAULT'S BOOKS, to the base unit: out only what a top-up behind a yes moved, exactly its
      // own amount; in only what a sweep sent home.
      const ran = topUps.filter((p) => p.status === 'executed');
      // A top-up moves the coin its move spends, USDT for a swap out of USDT.
      const out = (asset: string): bigint =>
        ran.reduce((sum, p) => sum + (p.draft.kind === 'vault_top_up' && p.draft.asset === asset ? decimalToBaseUnits(p.draft.amount, p.draft.decimals) : 0n), 0n);
      if (touch === 'cancel') assert.deepEqual([out(USDC), out(USDT)], [0n, 0n]);
      const lines = swept.slice(sweptBefore);
      tally.topUps += ran.length;
      tally.sweeps += lines.filter((l) => l.state === 'done').length;
      assert.deepEqual(
        [w.chain.balanceOf(w.vault, USDC), w.chain.balanceOf(w.vault, USDT)],
        [vaultBefore[0]! - out(USDC) + home(lines, USDC), vaultBefore[1]! - out(USDT) + home(lines, USDT)],
        `run ${i}: the vault moved other than by a touched top-up or a sweep home: ${JSON.stringify({ kind: row.kind, status: row.status, from: (row.draft as { from?: string }).from, result: row.result, topUps: topUps.map((p) => [p.status, p.draft.kind === 'vault_top_up' ? p.draft.amount : '', p.result?.detail]), lines, publishes: w.publishes.slice(-2) })}`,
      );
      // The allowance never paid out more than it held: the double holds every balance at zero or more.
      assert.ok(w.chain.balanceOf(w.account, USDC) >= 0n && w.chain.balanceOf(w.account, USDT) >= 0n);
      // Now and then a hundred dollars arrives from outside: a deposit someone sends, not a top-up.
      if (i % 50 === 49) {
        w.chain.fund(w.account, USDC, 100_000_000n);
        w.ledger.reread();
      }
    }
  } finally {
    unsubscribe();
  }
  // Every coin a money rail moved was signed by the allowance.
  assert.ok([...w.publishes.map((p) => p.signer), ...w.spends].every((s) => s === w.account), 'only the allowance key signed a move');
  return tally;
}

test(`${RUNS} random agent proposals, the vault Touch ID always cancelled: the vault never moves, only the allowance pays`, { timeout: 600_000 }, async () => {
  const service = new SoftwareChipService();
  const w = await allowanceWorld({ service, vaultUsdc: 10_000_000_000n, allowanceUsdc: 100_000_000n, sizeUsd: 100, memory: true });
  try {
    const tally = await run(w, service, 'cancel', SEED);
    assert.equal(service.signatures, 0, 'no vault signature at all');
    assert.ok(tally.overAllowance > 100 && tally.executed > 100 && tally.clicked > 50, JSON.stringify(tally));
    console.log(`cancelled touches: ${JSON.stringify(tally)}, vault USDC ${w.chain.balanceOf(w.vault, USDC)}`);
  } finally {
    await w.stop();
  }
});

test(`${RUNS} random agent proposals with every vault Touch ID said yes to: the vault gives exactly each shortfall, one touch each`, { timeout: 600_000 }, async () => {
  const service = new SoftwareChipService();
  const w = await allowanceWorld({ service, vaultUsdc: 10_000_000_000n, allowanceUsdc: 100_000_000n, sizeUsd: 100, memory: true });
  try {
    const tally = await run(w, service, 'yes', SEED + 1);
    assert.ok(tally.topUps > 10, JSON.stringify(tally));
    console.log(`touches said yes: ${JSON.stringify(tally)}, vault signatures ${service.signatures}`);
  } finally {
    await w.stop();
  }
});
