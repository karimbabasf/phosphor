// audit2 AU2-03: a top-up refused AFTER its chip-signed bundle left this Mac is a send, not a
// refusal. src/vault/submit.ts writes the bundle down and hands it to the RPC in simulate_intents
// (released: true), so an RPC that answers the simulate with a refusal can still run the signed
// bundle itself through an execute_intents of its own, until its deadline. The top-up rail
// (src/rails/vault-topup.ts) therefore waits on such a refusal through awaitSettled, as it does on a
// send with no final answer: the row reads what NEAR proves, executed when the bundle ran, and
// "nothing moved" only once NEAR shows it never ran and never can. It never says nothing was sent
// while the outcome is unknown, so the person is never led to approve the same top-up twice.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { MultiPayload } from '../../src/chain/near-tx.ts';
import { CHIP_PAYLOAD_LIFE_MS } from '../../src/vault/chip.ts';
import { VAULT_SETTLE_FLOOR_MS } from '../../src/vault/submit.ts';
import type { Proposal } from '../../src/types.ts';
import { USDC, allowanceWorld } from './helpers/allowance-world.ts';
import type { AllowanceWorld } from './helpers/allowance-world.ts';

const usdc = (n: number): bigint => BigInt(Math.round(n * 1_000_000));

async function settledRow(w: AllowanceWorld, reply: Promise<Proposal>): Promise<Proposal> {
  return w.svc.settled((await reply).id, 20_000);
}

// The audit lines that show the row was held as sent before the wait (src/proposals/execute.ts onEvidence).
function heldAsSent(w: AllowanceWorld, id: string): number {
  return w.audit.tail(500).filter((e) => e.type === 'submitted' && (e.data as { id?: string } | undefined)?.id === id).length;
}

test('AU2-03: a released top-up the RPC ran itself reads executed, never nothing moved', async () => {
  const w = await allowanceWorld({ vaultUsdc: usdc(1850) });
  try {
    // The hostile RPC: it sees the signed bundle in simulate_intents, runs it in a call of its own,
    // and answers the simulation with a refusal.
    const honest = w.chain.verifier.simulate;
    let hijacked = 0;
    w.chain.verifier.simulate = async (signed, at) => {
      if (hijacked === 0) {
        hijacked += 1;
        const ran = await w.chain.runAsStranger(signed as MultiPayload[]);
        assert.ok(ran.ok, JSON.stringify(ran));
        return { ok: false, refusal: 'insufficient balance or overflow' };
      }
      return honest(signed, at);
    };

    const filed = await w.svc.proposeVaultTopUp!({ usd: 5, why: 'manual' });
    assert.equal(filed.status, 'pending', JSON.stringify(filed.verdict));
    const first = await settledRow(w, w.svc.approve(filed.id));
    const afterFirst = w.chain.balanceOf(w.account, USDC);
    console.log(`first row: status=${first.status} result=${JSON.stringify(first.result)}; allowance holds ${afterFirst}`);

    assert.equal(afterFirst, usdc(5), 'precondition: the released bundle ran on chain');
    assert.equal(first.status, 'executed', `the first top-up moved ${afterFirst} base units but its row reads ${first.status}: ${JSON.stringify(first.result)}`);
    assert.match(first.result?.detail ?? '', /^moved 5 USDC from your vault/);
    assert.ok(heldAsSent(w, filed.id) >= 1, 'the row was held as sent before the wait');
  } finally {
    await w.stop();
  }
});

test('AU2-03: a released top-up nobody ran waits on NEAR, and reads nothing moved only once NEAR proves it never ran', async () => {
  const w = await allowanceWorld({ vaultUsdc: usdc(1850) });
  try {
    // The RPC refuses the simulation after it saw the bytes, and runs nothing.
    let simulated = 0;
    w.chain.verifier.simulate = async () => {
      simulated += 1;
      return { ok: false, refusal: 'insufficient balance or overflow' };
    };
    const startedAt = w.chain.now();
    const filed = await w.svc.proposeVaultTopUp!({ usd: 5, why: 'manual' });
    const row = await settledRow(w, w.svc.approve(filed.id));
    console.log(`row: status=${row.status} reason=${row.result?.reason} detail=${row.result?.detail}; ${w.chain.now() - startedAt} ms of NEAR time`);

    assert.equal(simulated, 1, 'one signature, one simulation: nothing was signed again');
    assert.equal(w.chain.balanceOf(w.account, USDC), 0n, 'nothing moved');
    assert.ok(heldAsSent(w, filed.id) >= 1, 'the row was held as sent before the wait');
    // The verdict came only after the bundle's deadline and the settle floor had passed on NEAR's clock.
    assert.ok(w.chain.now() - startedAt >= CHIP_PAYLOAD_LIFE_MS + VAULT_SETTLE_FLOOR_MS, `settled after ${w.chain.now() - startedAt} ms`);
    assert.equal(row.status, 'failed');
    assert.equal(row.result?.reason, 'venue_failed_nothing_moved');
    assert.match(row.result?.detail ?? '', /vault_dead/);
  } finally {
    await w.stop();
  }
});

test('AU2-03: a released top-up whose fate NEAR never tells stays waiting, and is never said to be unsigned', async () => {
  const w = await allowanceWorld({ vaultUsdc: usdc(1850) });
  try {
    // The RPC refuses the simulation after it saw the bytes, then answers no read at all.
    w.chain.verifier.simulate = async () => {
      w.chain.faults.reads = true;
      return { ok: false, refusal: 'insufficient balance or overflow' };
    };
    const filed = await w.svc.proposeVaultTopUp!({ usd: 5, why: 'manual' });
    const row = await settledRow(w, w.svc.approve(filed.id));
    console.log(`row: status=${row.status} reason=${row.result?.reason} detail=${row.result?.detail}`);
    assert.notEqual(row.status, 'failed', JSON.stringify(row.result));
    assert.doesNotMatch(row.result?.detail ?? '', /not signed|nothing was sent|did not go/);
    assert.match(row.result?.detail ?? '', /was sent and NEAR has not settled it yet/);
  } finally {
    w.chain.faults.reads = false;
    await w.stop();
  }
});
