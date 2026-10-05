// audit2 AU2-06: the vault never pays more at the click than the card the person read said it would.
//
// The attack: the card's line ("Approve asks for two Touch IDs ... the second moves X from your
// vault") is written when the row lands; the shortfall step used to read the allowance again at
// execution and top it up by whatever was missing then. An agent that drains the allowance between
// the card and the click made the vault pay more than the card promised, or anything at all on a
// card that said nothing about the vault.
// The rule held here (src/proposals/execute.ts): the row keeps the card's shortfall when it lands
// (vaultShortfall), the vault adds at most that much for the row, and a move that needs more signs
// nothing and goes back to pending with a fresh line naming the new difference.
//
// Run: node scripts/run-tests.ts tests/unit/audit2-allowance-card-shortfall.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ASKED_AGAIN_SAID } from '../../src/proposals/execute.ts';
import { SoftwareChipService } from './helpers/chip-fake.ts';
import { USDC, allowanceWorld } from './helpers/allowance-world.ts';
import type { AllowanceWorld } from './helpers/allowance-world.ts';

const usdc = (n: number): bigint => BigInt(Math.round(n * 1_000_000));

// The agent drains the allowance with no-click $90 Hyperliquid deposits while the card waits.
async function drain(w: AllowanceWorld, times: number): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    const r = await w.svc.settled((await w.svc.proposeHlDeposit({ amount: 90, by: 'agent-1' } as never)).id, 20_000);
    assert.equal(r.status, 'executed', JSON.stringify(r.result));
  }
  w.ledger.reread();
}

test('AU2-06: a card that named no vault money pays none: the click finds the allowance drained, signs nothing and asks again with a fresh line', async () => {
  const service = new SoftwareChipService();
  const w = await allowanceWorld({ service, vaultUsdc: usdc(1000), allowanceUsdc: usdc(200), sizeUsd: 1000 });
  try {
    // 1. The agent's swap: over the click line, inside the allowance. The card names no vault money.
    const proposed = await w.svc.proposeSwap({ chain: 'near', toChain: 'near', fromSymbol: 'USDC', toSymbol: 'USDT', amountIn: '150', by: 'agent-1' } as never);
    assert.equal(proposed.status, 'pending', JSON.stringify(proposed.verdict));
    assert.equal(proposed.verdict.reasons.some((r) => r.startsWith('Your allowance holds ')), false, 'precondition: the card named no vault money');
    assert.equal(proposed.vaultShortfall, undefined);

    // 2. While the card waits, the agent drains the allowance to 20 USDC.
    await drain(w, 2);
    assert.equal(w.chain.balanceOf(w.account, USDC), usdc(20));

    // 3. The person approves the card they read: nothing is signed, and the row asks again.
    const vaultBefore = w.chain.balanceOf(w.vault, USDC);
    const again = await w.svc.settled((await w.svc.approve(proposed.id)).id, 20_000);
    console.log('after the click:', again.status, '|', (again.verdict as { why?: string[] }).why?.join(' | '));
    assert.equal(vaultBefore - w.chain.balanceOf(w.vault, USDC), 0n, 'the vault paid for a move whose card said nothing about the vault');
    assert.equal(service.signatures, 0, 'no vault Touch ID was asked');
    assert.equal(w.svc.list().filter((p) => p.draft.kind === 'vault_top_up').length, 0, 'no top-up row');
    assert.equal(again.status, 'pending');
    assert.equal(again.decidedBy, undefined);
    assert.deepEqual(again.vaultShortfall, { asset: USDC, base: usdc(130).toString() });
    const why = (again.verdict as { why?: string[] }).why ?? [];
    assert.equal(why[0], ASKED_AGAIN_SAID);
    assert.match(why[1] ?? '', /^Your allowance holds 20(\.00)? USDC, less than this move spends\. Approve asks for two Touch IDs: the first approves this move, the second moves 130(\.00)? USDC from your vault to your allowance\.$/);

    // 4. The person approves the fresh card: the vault adds exactly what it named, once.
    const done = await w.svc.settled((await w.svc.approve(proposed.id)).id, 20_000);
    assert.equal(done.status, 'executed', JSON.stringify(done.result));
    assert.equal(vaultBefore - w.chain.balanceOf(w.vault, USDC), usdc(130));
    assert.equal(service.signatures, 1, 'one vault Touch ID');
  } finally {
    await w.stop();
  }
});

test('AU2-06: a card that named a difference pays at most that difference; a bigger one asks again', async () => {
  const service = new SoftwareChipService();
  const w = await allowanceWorld({ service, vaultUsdc: usdc(1000), allowanceUsdc: usdc(200), sizeUsd: 1000 });
  try {
    // A $250 swap from a $200 allowance: the card says the vault adds 50.
    const proposed = await w.svc.proposeSwap({ chain: 'near', toChain: 'near', fromSymbol: 'USDC', toSymbol: 'USDT', amountIn: '250', by: 'agent-1' } as never);
    assert.equal(proposed.status, 'pending', JSON.stringify(proposed.verdict));
    assert.deepEqual(proposed.vaultShortfall, { asset: USDC, base: usdc(50).toString() });
    await drain(w, 1);
    const vaultBefore = w.chain.balanceOf(w.vault, USDC);
    const again = await w.svc.settled((await w.svc.approve(proposed.id)).id, 20_000);
    assert.equal(again.status, 'pending', 'the 140 now missing is more than the 50 the card named');
    assert.deepEqual(again.vaultShortfall, { asset: USDC, base: usdc(140).toString() });
    assert.equal(service.signatures, 0);
    assert.equal(w.chain.balanceOf(w.vault, USDC), vaultBefore);
  } finally {
    await w.stop();
  }
});

test('AU2-06: a move that is not a swap keeps its card\'s difference from the land too, and a click that finds more missing asks again', async () => {
  const service = new SoftwareChipService();
  const w = await allowanceWorld({ service, vaultUsdc: usdc(1000), allowanceUsdc: usdc(200), sizeUsd: 1000 });
  try {
    w.ledger.reread();
    // A $250 Hyperliquid deposit from a $200 allowance: land() writes the line and keeps the 50.
    const proposed = await w.svc.proposeHlDeposit({ amount: 250, by: 'agent-1' } as never);
    assert.equal(proposed.status, 'pending', JSON.stringify(proposed.verdict));
    assert.deepEqual(proposed.vaultShortfall, { asset: USDC, base: usdc(50).toString() });
    await drain(w, 1);
    const again = await w.svc.settled((await w.svc.approve(proposed.id)).id, 20_000);
    assert.equal(again.status, 'pending');
    assert.deepEqual(again.vaultShortfall, { asset: USDC, base: usdc(140).toString() });
    assert.equal(service.signatures, 0);
  } finally {
    await w.stop();
  }
});

test('AU2-06: what the vault already added for a row counts against its card, so a second pass never pays the card twice', async () => {
  const service = new SoftwareChipService();
  const w = await allowanceWorld({ service, vaultUsdc: usdc(1000), allowanceUsdc: usdc(200), sizeUsd: 1000 });
  try {
    const proposed = await w.svc.proposeSwap({ chain: 'near', toChain: 'near', fromSymbol: 'USDC', toSymbol: 'USDT', amountIn: '250', by: 'agent-1' } as never);
    assert.deepEqual(proposed.vaultShortfall, { asset: USDC, base: usdc(50).toString() });
    // A top-up of the card's 50 for this row already ran (a pass the rail then held), and the agent
    // spent the allowance down again meanwhile.
    const topUp = await w.svc.proposeVaultTopUp!({ usd: 50, why: 'manual' });
    w.rows.put({ ...topUp, status: 'executed', draft: { ...(topUp.draft as Record<string, unknown>), why: 'shortfall', forProposal: proposed.id } as never });
    await drain(w, 1);
    const again = await w.svc.settled((await w.svc.approve(proposed.id)).id, 20_000);
    assert.equal(again.status, 'pending', 'the card\'s 50 was paid once already: nothing more without a new click');
    assert.deepEqual(again.vaultShortfall, { asset: USDC, base: usdc(50 + 140).toString() }, 'what the vault added plus what is missing now');
    assert.equal(service.signatures, 0);
  } finally {
    await w.stop();
  }
});
