// The allowance (PHASE2-PLAN.md U9, C8, P2.6): the top-up from the vault, the sweep home, and the
// shortfall step a move bigger than the allowance takes first.
//
// The pure rules first (the sweep plan, what a move spends, the payloads), then the whole app on the
// chain double (tests/unit/helpers/allowance-world.ts): every top-up and sweep there is simulated,
// sent by the gas account and read back to the base unit. No dialog, nothing signed for real money.
//
// Run: node --test tests/unit/allowance.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluate } from '../../src/policy/engine.ts';
import type { EngineCtx } from '../../src/policy/engine.ts';
import { defaultPolicy } from '../../src/policy/file.ts';
import { NONCE_LIFE_AFTER_DEADLINE_MS } from '../../src/rails/intents-relay.ts';
import { decodeNonce } from '../../src/relay/payload.ts';
import type { Proposal, SwapDraft, VaultTopUpDraft, WriteDraft } from '../../src/types.ts';
import { MAX_SWEEP_COINS, moveSpend, shortfallOf, signAsAllowance, sweepPayload, sweepPlan, topUpPayload } from '../../src/vault/allowance.ts';
import { signerOf } from './helpers/rail-kinds.ts';
import type { HeldCoin } from '../../src/vault/allowance.ts';
import { readVaultPayload } from '../../src/vault/payload.ts';
import { SoftwareChipService } from './helpers/chip-fake.ts';
import { ODD, SINK, USDC, USDT, V, allowanceWorld } from './helpers/allowance-world.ts';
import type { AllowanceWorld } from './helpers/allowance-world.ts';
import { SALT } from './helpers/intents-double.ts';

const usdc = (n: number): bigint => BigInt(Math.round(n * 1e6));
const show = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x));

function coin(symbol: string, base: bigint, priceUsd: number | null, decimals = 6, asset = `nep141:${symbol.toLowerCase()}.near`): HeldCoin {
  return { asset, symbol, decimals, base, priceUsd };
}

// ---------- the sweep plan ----------

test('nothing goes home while the allowance is worth at most its size plus 10 %, exactly at the line included', () => {
  assert.deepEqual(sweepPlan([coin('USDC', usdc(110), 1)], 100).moves, []);
  assert.deepEqual(sweepPlan([coin('USDC', usdc(60), 1), coin('USDT', usdc(50), 1)], 100).moves, []);
  assert.deepEqual(sweepPlan([], 100).moves, []);
  // One base unit over the line: everything over the size goes, to the base unit.
  const over = sweepPlan([coin('USDC', usdc(110) + 1n, 1)], 100);
  assert.deepEqual(over.moves.map((m) => m.base), [usdc(10) + 1n]);
});

test('USDC first, then the rest by dollar value, down to the size and never under it', () => {
  const wnear = coin('wNEAR', 10n ** 24n * 5n, 2, 24, 'nep141:wrap.near'); // $10
  const usdt = coin('USDT', usdc(30), 1); // $30
  const plan = sweepPlan([wnear, usdt, coin('USDC', usdc(3), 1)], 1);
  // $43 held, $1 size: all 3 USDC, then all 30 USDT, then $9 of the $10 of wNEAR.
  assert.deepEqual(plan.moves.map((m) => m.symbol), ['USDC', 'USDT', 'wNEAR']);
  assert.equal(plan.moves[0]!.base, usdc(3));
  assert.equal(plan.moves[1]!.base, usdc(30));
  const kept = wnear.base - plan.moves[2]!.base;
  assert.equal(kept, 10n ** 24n / 2n, 'half a wNEAR stays: one dollar at two dollars a coin');
  assert.equal(plan.totalUsd, 43);
});

test('a coin taken whole is its whole balance, and a coin taken in part is cut down', () => {
  // 24 decimals, a price no double divides evenly: the part taken never rounds up past the balance.
  const odd = coin('ETH', 123_456_789_012_345_678_901n, 4520.17, 18);
  for (const size of [0, 1, 7.5, 100, 557.99]) {
    const plan = sweepPlan([odd], size);
    for (const m of plan.moves) assert.ok(m.base > 0n && m.base <= odd.base);
    if (size === 0) assert.equal(plan.moves[0]?.base, odd.base, 'a size of $0 sends every unit home');
  }
});

test('a coin with no price never moves, and with no price at all nothing does', () => {
  const unpriced = coin('ODD', usdc(500), null);
  assert.deepEqual(sweepPlan([unpriced], 1).moves, [], 'no price, no sweep');
  assert.deepEqual(sweepPlan([unpriced], 1).unpriced, ['ODD']);
  assert.deepEqual(sweepPlan([coin('X', usdc(5), 0), coin('Y', usdc(5), Number.NaN)], 0).moves, [], 'a zero or broken price is no price');
  // The priced part still goes home past the line; the unpriced coin stays where it is.
  const mixed = sweepPlan([unpriced, coin('USDC', usdc(50), 1)], 10);
  assert.deepEqual(mixed.moves.map((m) => [m.symbol, m.base]), [['USDC', usdc(40)]]);
});

test('one sweep carries at most four coins, USDC among them first', () => {
  const many = ['A', 'B', 'C', 'D', 'E'].map((s, i) => coin(s, usdc(10 + i), 1));
  const plan = sweepPlan([...many, coin('USDC', usdc(1), 1)], 0);
  assert.equal(plan.moves.length, MAX_SWEEP_COINS);
  assert.equal(plan.moves[0]!.symbol, 'USDC');
});

// ---------- what a move spends ----------

test('what a move spends is what its rail signs: the pinned coin and the exact base units', () => {
  const pin = { origin: { assetId: USDC, decimals: 6 }, destination: { assetId: USDT, decimals: 6 } };
  const swap = { kind: 'swap', venue: 'intents-relay', chain: 'near', toChain: 'near', fromSymbol: 'USDC', toSymbol: 'USDT', amountIn: 2.5, amountInExact: '2.500001', amountUsd: 2.5, minAmountOut: 2.4, from: V.allowance, to: V.allowance, counterparty: 'intents.near', quote: null, assets: pin } as SwapDraft;
  assert.deepEqual(moveSpend(swap), { asset: USDC, symbol: 'USDC', decimals: 6, base: 2_500_001n });
  // No exact amount: the relay rail cuts the double, the 1Click rail rounds it (src/intents.ts).
  assert.equal(moveSpend({ ...swap, amountInExact: undefined, amountIn: 1.0000005 })?.base, 1_000_000n);
  assert.equal(moveSpend({ ...swap, venue: 'intents-native', amountInExact: undefined, amountIn: 1.0000005 })?.base, 1_000_001n);
  const send = { kind: 'intents_send', symbol: 'USDC', originAsset: USDC, amount: 3.78, amountUsd: 3.78, minReceived: 3.7, from: V.allowance, to: SINK, counterparty: 'intents.near', assets: pin } as WriteDraft;
  assert.deepEqual(moveSpend(send), { asset: USDC, symbol: 'USDC', decimals: 6, base: 3_780_000n });
  assert.equal(moveSpend({ ...swap, assets: undefined }), null, 'a draft from before the coins were pinned is its rail\'s alone');
  assert.equal(moveSpend({ kind: 'policy_change', patch: {}, sentence: 'x' }), null);
  assert.equal(shortfallOf(5n, 7n), 0n);
  assert.equal(shortfallOf(7n, 5n), 2n);
});

// ---------- the payloads ----------

test('a top-up and a sweep are vault payloads with seven-day nonces, one coin per transfer', () => {
  const deadlineMs = Date.parse('2026-10-04T20:01:50.000Z');
  const up = readVaultPayload(topUpPayload({ vault: V.vault, allowance: V.allowance, coin: { asset: USDC, base: 5_000_000n }, deadlineMs, salt: SALT }));
  assert.equal(up.signer_id, V.vault.toLowerCase());
  assert.deepEqual(up.intents, [{ intent: 'transfer', receiver_id: V.allowance.toLowerCase(), tokens: { [USDC]: '5000000' } }]);
  assert.equal(decodeNonce(up.nonce)?.deadlineMs, deadlineMs + NONCE_LIFE_AFTER_DEADLINE_MS);
  const home = readVaultPayload(sweepPayload({ allowance: V.allowance, vault: V.vault, moves: [{ asset: USDC, base: 3n }, { asset: USDT, base: 4n }], deadlineMs, salt: SALT }));
  assert.equal(home.signer_id, V.allowance.toLowerCase());
  assert.deepEqual(home.intents.map((i) => (i.intent === 'transfer' ? [i.receiver_id, i.tokens] : null)), [
    [V.vault.toLowerCase(), { [USDC]: '3' }],
    [V.vault.toLowerCase(), { [USDT]: '4' }],
  ]);
  assert.throws(() => topUpPayload({ vault: V.vault, allowance: V.vault, coin: { asset: USDC, base: 1n }, deadlineMs, salt: SALT }), /moves nothing/);
});

// ---------- the engine ----------

function engineCtx(selfAddresses: string[], killSwitch = false): EngineCtx {
  const policy = defaultPolicy();
  policy.killSwitch = killSwitch;
  return { policy, composition: { rows: [], totalUsd: 0, byIssuer: {}, freezableShare: 0 } as unknown as EngineCtx['composition'], sessionSpentUsd: 0, selfAddresses };
}

function topUpDraft(over: Partial<VaultTopUpDraft> = {}): VaultTopUpDraft {
  return { kind: 'vault_top_up', why: 'manual', asset: USDC, symbol: 'USDC', decimals: 6, amount: '5', amountUsd: 5, from: V.vault.toLowerCase(), to: V.allowance.toLowerCase(), counterparty: 'intents.near', ...over };
}

test('the engine never lets a top-up run on its own: every one asks, at any size, and only between our own accounts', () => {
  const own = [V.vault.toLowerCase(), V.allowance.toLowerCase()];
  for (const usd of [0.01, 1, 99.99, 100, 5_000, 9_999_999]) {
    const verdict = evaluate(topUpDraft({ amountUsd: usd, amount: String(usd) }), engineCtx(own));
    assert.equal(verdict.outcome, 'needs_approval', `$${usd}`);
  }
  // Under a click threshold of a million dollars too: no threshold reaches it.
  const loose = engineCtx(own);
  loose.policy!.outbound.humanClickAboveUsd = 1_000_000;
  assert.equal(evaluate(topUpDraft(), loose).outcome, 'needs_approval');
  const refused = (d: VaultTopUpDraft, ctx = engineCtx(own)) => {
    const v = evaluate(d, ctx);
    assert.equal(v.outcome, 'refuse');
    return (v as { rule: string }).rule;
  };
  assert.equal(refused(topUpDraft({ amountUsd: Infinity })), 'invalid_amount');
  assert.equal(refused(topUpDraft({ amountUsd: 0 })), 'invalid_amount');
  assert.equal(refused(topUpDraft({ to: SINK })), 'destination_not_allowed', 'never to anyone else');
  assert.equal(refused(topUpDraft({ from: SINK })), 'destination_not_allowed');
  assert.equal(refused(topUpDraft({ to: V.vault.toLowerCase() })), 'invalid_amount');
  assert.equal(refused(topUpDraft(), engineCtx(own, true)), 'kill_switch');
});

// ---------- on the double: the app end to end ----------

function rowsOf(w: AllowanceWorld, kind: WriteDraft['kind']): Proposal[] {
  return w.rows.list().filter((p) => p.kind === kind);
}

async function settledRow(w: AllowanceWorld, reply: Promise<Proposal>): Promise<Proposal> {
  return w.svc.settled((await reply).id, 20_000);
}

test('top up $5, swap $2 with no click, then a $1 size: both balances end exact to the base unit, USDC first', async () => {
  const w = await allowanceWorld({ vaultUsdc: usdc(1850) });
  try {
    // The top-up: filed from the window, pending, one click, one chip signature.
    const filed = await w.svc.proposeVaultTopUp!({ usd: 5, why: 'manual' });
    assert.equal(filed.status, 'pending', JSON.stringify(filed.verdict));
    assert.equal(filed.draft.kind, 'vault_top_up');
    const up = await settledRow(w, w.svc.approve(filed.id));
    assert.equal(up.status, 'executed', JSON.stringify(up.result));
    assert.equal(w.chain.balanceOf(w.vault, USDC), usdc(1845));
    assert.equal(w.chain.balanceOf(w.account, USDC), usdc(5));

    // The swap: $2 under the $100 click line, so the policy runs it, signed by the allowance alone.
    const swapped = await settledRow(w, w.svc.proposeSwap({ chain: 'near', toChain: 'near', fromSymbol: 'USDC', toSymbol: 'USDT', amountIn: '2' }));
    assert.equal(swapped.status, 'executed', JSON.stringify(swapped.result ?? swapped.verdict));
    assert.equal(swapped.decidedBy, 'policy', 'no click');
    const out = (2_000_000n * 980_998n) / 1_000_000n;
    assert.equal(w.chain.balanceOf(w.account, USDC), usdc(3));
    assert.equal(w.chain.balanceOf(w.account, USDT), out);
    assert.deepEqual(w.publishes.map((p) => p.signer), [w.account], 'one swap, signed by the allowance');

    // A $1 size: $4.961996 held, so everything over a dollar goes home, USDC first.
    w.prefs.setAllowanceSize(1);
    w.ledger.reread();
    const swept = await w.svc.sweepAllowance!('size');
    assert.ok(swept !== null && swept.tried, show(swept));
    assert.equal(swept.result.state, 'done', show(swept.result));
    assert.deepEqual(swept.moves.map((m) => [m.symbol, m.base]), [['USDC', usdc(3)], ['USDT', out - usdc(1)]]);
    assert.equal(w.chain.balanceOf(w.account, USDC), 0n);
    assert.equal(w.chain.balanceOf(w.account, USDT), usdc(1), 'the allowance keeps exactly its size');
    assert.equal(w.chain.balanceOf(w.vault, USDC), usdc(1848), '1,850 - 5 + 3, to the base unit');
    assert.equal(w.chain.balanceOf(w.vault, USDT), out - usdc(1));
    const line = w.audit.tail(50).find((e) => e.type === 'allowance_swept');
    assert.ok(line !== undefined, 'an audit line names the sweep');
    assert.match(line.msg, /^3 USDC, 0\.961996 USDT went from your allowance to your vault/);
  } finally {
    await w.stop();
  }
});

test('a clicked swap bigger than the allowance takes exactly the shortfall from the vault first, behind one Touch ID', async () => {
  const service = new SoftwareChipService();
  const w = await allowanceWorld({ service, vaultUsdc: usdc(1850), allowanceUsdc: usdc(1) });
  try {
    const proposed = await w.svc.proposeSwap({ chain: 'near', toChain: 'near', fromSymbol: 'USDC', toSymbol: 'USDT', amountIn: '3.000001' });
    assert.equal(proposed.status, 'pending', 'a move bigger than the allowance waits for a click, whatever its size');
    assert.ok(
      proposed.verdict.reasons.includes('Your allowance holds 1 USDC, less than this move spends, so 2.000001 USDC moves from your vault first; you confirm that move with Touch ID.'),
      JSON.stringify(proposed.verdict),
    );
    assert.equal(service.signatures, 0);
    assert.equal(w.chain.balanceOf(w.vault, USDC), usdc(1850));

    const done = await settledRow(w, w.svc.approve(proposed.id));
    assert.equal(done.status, 'executed', JSON.stringify(done.result));
    const [topUp] = rowsOf(w, 'vault_top_up');
    assert.ok(topUp !== undefined && topUp.draft.kind === 'vault_top_up');
    assert.equal(topUp.status, 'executed', JSON.stringify(topUp.result));
    assert.deepEqual([topUp.draft.why, topUp.draft.amount, topUp.draft.forProposal, topUp.decidedBy], ['shortfall', '2.000001', proposed.id, 'human']);
    assert.equal(service.signatures, 1, 'one Touch ID: the vault chip key signed once');
    assert.equal(w.chain.balanceOf(w.vault, USDC), usdc(1850) - 2_000_001n, 'exactly the shortfall left the vault');
    assert.equal(w.chain.balanceOf(w.account, USDC), 0n, 'and the swap spent all of it with what was there');
    assert.equal(w.chain.balanceOf(w.account, USDT), (3_000_001n * 980_998n) / 1_000_000n);
    assert.deepEqual(w.publishes.map((p) => p.signer), [w.account]);
  } finally {
    await w.stop();
  }
});

test('a clicked send bigger than the allowance takes the shortfall first; a move nobody clicked never touches the vault', async () => {
  const service = new SoftwareChipService();
  const w = await allowanceWorld({ service, vaultUsdc: usdc(500), allowanceUsdc: usdc(4) });
  try {
    // A send always waits for a click, and its card says the vault adds the difference.
    const send = await w.svc.proposeSend({ to: SINK, symbol: 'USDC', amount: 10, where: 'intents' });
    assert.equal(send.status, 'pending', JSON.stringify(send.verdict));
    assert.ok(send.verdict.reasons.some((r) => r.startsWith('Your allowance holds 4 USDC, less than this move spends, so 6 USDC moves')), JSON.stringify(send.verdict));
    const sent = await settledRow(w, w.svc.approve(send.id));
    assert.equal(sent.status, 'executed', JSON.stringify(sent.result));
    assert.equal(w.chain.balanceOf(w.vault, USDC), usdc(494));
    assert.equal(w.chain.balanceOf(SINK, USDC), usdc(10));
    assert.equal(service.signatures, 1);

    // A Hyperliquid deposit under the click line: the policy alone would run it, but it is bigger
    // than the allowance, so it waits.
    w.chain.fund(w.account, USDC, usdc(5));
    w.ledger.reread();
    const deposit = await w.svc.proposeHlDeposit({ amount: 8 });
    assert.equal(deposit.status, 'pending', JSON.stringify(deposit.verdict));

    // The ledger a read behind (it still shows 5 USDC, the chain holds 1): the policy lets a 3 USDC
    // deposit run, and the shortfall step stops it with the vault untouched and nothing signed.
    w.chain.fund(w.account, USDC, -usdc(4));
    const auto = await settledRow(w, w.svc.proposeHlDeposit({ amount: 3 }));
    assert.equal(auto.decidedBy, 'policy');
    assert.equal(auto.status, 'failed', JSON.stringify(auto.result));
    assert.equal(auto.result?.reason, 'insufficient_balance');
    assert.match(auto.result?.detail ?? '', /money leaves your vault only on your click and your Touch ID; nothing was signed/);
    assert.equal(w.chain.balanceOf(w.vault, USDC), usdc(494), 'the vault did not move');
    assert.equal(service.signatures, 1, 'and no Touch ID was asked');
    assert.equal(rowsOf(w, 'vault_top_up').length, 1);
  } finally {
    await w.stop();
  }
});

test('a cancelled Touch ID on the shortfall stops the move: the vault and the allowance are untouched, nothing signed', async () => {
  const service = new SoftwareChipService();
  const w = await allowanceWorld({ service, allowanceUsdc: usdc(1) });
  try {
    const proposed = await w.svc.proposeSwap({ chain: 'near', toChain: 'near', fromSymbol: 'USDC', toSymbol: 'USDT', amountIn: '3' });
    service.touch = 'cancel';
    const row = await settledRow(w, w.svc.approve(proposed.id));
    assert.equal(row.status, 'failed', JSON.stringify(row.result));
    assert.equal(row.result?.reason, 'declined');
    assert.match(row.result?.detail ?? '', /nothing was signed for this move/);
    const [topUp] = rowsOf(w, 'vault_top_up');
    assert.equal(topUp?.status, 'failed');
    assert.equal(topUp?.result?.reason, 'declined');
    assert.equal(w.chain.balanceOf(w.vault, USDC), usdc(1850));
    assert.equal(w.chain.balanceOf(w.account, USDC), usdc(1));
    assert.deepEqual(w.publishes, [], 'the swap never signed');
    assert.deepEqual(w.submitter.pending(), [], 'nothing left this Mac');
  } finally {
    await w.stop();
  }
});

test('a top-up asks no approval Touch ID, only the vault chip key at its signature; a shut wallet keeps it pending', async () => {
  const service = new SoftwareChipService();
  const w = await allowanceWorld({ service });
  try {
    const filed = await w.svc.proposeVaultTopUp!({ usd: 20, why: 'low' });
    assert.equal(filed.status, 'pending');
    assert.equal((filed.draft as VaultTopUpDraft).why, 'low');
    w.keys.lock();
    await assert.rejects(() => w.svc.approve(filed.id), /Open your wallet first: the gas account that sends a top-up opens with it/);
    assert.equal(w.rows.get(filed.id)?.status, 'pending', 'the click can be made again');
    assert.equal(service.signatures, 0);
    const ops = service.seen.map((r) => r.op);
    assert.ok(!ops.includes('unwrap'), 'no unwrap was ever asked');
  } finally {
    await w.stop();
  }
});

test('a top-up the window asks for: USDC only, never past the size plus 10 %, never from an empty vault', async () => {
  const w = await allowanceWorld({ vaultUsdc: usdc(30), allowanceUsdc: usdc(95), sizeUsd: 100 });
  try {
    await assert.rejects(() => w.svc.proposeVaultTopUp!({ usd: 15.01, why: 'manual' }), /can take at most \$15\.00 more right now/);
    await assert.rejects(() => w.svc.proposeVaultTopUp!({ usd: 0, why: 'manual' }), /an amount of dollars above zero/);
    w.prefs.setAllowanceSize(1000);
    await assert.rejects(() => w.svc.proposeVaultTopUp!({ usd: 40, why: 'manual' }), /Your vault holds 30 USDC, less than the 40\.00/);
    const ok = await w.svc.proposeVaultTopUp!({ usd: 12.345, why: 'manual' });
    assert.equal(ok.status, 'pending');
    assert.equal((ok.draft as VaultTopUpDraft).amount, '12.35', 'cents, exact');
    w.prefs.setAllowanceSize(0);
    await assert.rejects(() => w.svc.proposeVaultTopUp!({ usd: 1, why: 'manual' }), /size is \$0/);
  } finally {
    await w.stop();
  }
});

test('Freeze refuses a top-up at the click and stops every sweep', async () => {
  const service = new SoftwareChipService();
  const w = await allowanceWorld({ service, allowanceUsdc: usdc(500), sizeUsd: 100 });
  try {
    const filed = await w.svc.proposeVaultTopUp!({ usd: 5, why: 'manual' }).catch((err: Error) => err);
    assert.ok(filed instanceof Error, 'the allowance is already past its size, so no top-up');
    w.prefs.setAllowanceSize(1000);
    const pending = await w.svc.proposeVaultTopUp!({ usd: 5, why: 'manual' });
    w.policy((p) => {
      p.killSwitch = true;
    });
    const refused = await w.svc.approve(pending.id);
    assert.equal(refused.status, 'policy_refused');
    w.prefs.setAllowanceSize(1);
    const swept = await w.svc.sweepAllowance!('timer');
    assert.deepEqual(swept, { tried: false, why: 'everything is frozen' });
    assert.equal(w.chain.balanceOf(w.account, USDC), usdc(500));
    assert.equal(service.signatures, 0);
  } finally {
    await w.stop();
  }
});

test('no price, no sweep: a coin nothing prices stays in the allowance, and the priced part still goes home', async () => {
  const w = await allowanceWorld({ allowanceUsdc: 0n, sizeUsd: 10 });
  try {
    w.chain.fund(w.account, ODD, usdc(500));
    w.ledger.reread();
    const none = await w.svc.sweepAllowance!('timer');
    assert.equal(none?.tried, false, show(none));
    assert.equal(w.chain.balanceOf(w.account, ODD), usdc(500));

    w.chain.fund(w.account, USDC, usdc(50));
    w.ledger.reread();
    const part = await w.svc.sweepAllowance!('timer');
    assert.ok(part?.tried === true && part.result.state === 'done', show(part));
    assert.deepEqual(part.moves.map((m) => [m.symbol, m.base]), [['USDC', usdc(40)]]);
    assert.equal(w.chain.balanceOf(w.account, ODD), usdc(500), 'the coin with no price did not move');
    assert.equal(w.chain.balanceOf(w.account, USDC), usdc(10));
    assert.match(w.audit.tail(20).find((e) => e.type === 'allowance_swept')?.msg ?? '', /left in place with no price: ODD/);
  } finally {
    await w.stop();
  }
});

test('the sweep waits for every move under way, a shut wallet, and a vault that has not moved', async () => {
  const w = await allowanceWorld({ allowanceUsdc: usdc(300), sizeUsd: 100 });
  try {
    const filed = await w.svc.proposeVaultTopUp!({ usd: 1, why: 'manual' }).catch(() => null);
    assert.equal(filed, null, 'over its size: no top-up');
    w.prefs.setAllowanceSize(1000);
    const pending = await w.svc.proposeVaultTopUp!({ usd: 1, why: 'manual' });
    w.rows.put({ ...pending, status: 'approved' });
    w.prefs.setAllowanceSize(100);
    const busy = await w.svc.sweepAllowance!('timer');
    assert.deepEqual(busy, { tried: false, why: 'a move is under way and may need what the allowance holds' });
    w.rows.put({ ...pending, status: 'refused' });
    w.keys.lock();
    assert.deepEqual(await w.svc.sweepAllowance!('timer'), { tried: false, why: 'the wallet is shut, so the allowance key is not here' });
    assert.equal(w.chain.balanceOf(w.account, USDC), usdc(300));
  } finally {
    await w.stop();
  }
});

test('after a settled move the sweep looks at the next read that shows it, and sends the excess home', async () => {
  const w = await allowanceWorld({ allowanceUsdc: usdc(250), sizeUsd: 100 });
  try {
    const swapped = await settledRow(w, w.svc.proposeSwap({ chain: 'near', toChain: 'near', fromSymbol: 'USDC', toSymbol: 'USDT', amountIn: '2' }));
    assert.equal(swapped.status, 'executed', JSON.stringify(swapped.result));
    // The executed line re-read the ledger, which woke the sweep: it runs on its own.
    for (let i = 0; i < 200 && w.audit.tail(50).every((e) => e.type !== 'allowance_swept'); i += 1) await new Promise((r) => setTimeout(r, 10));
    const line = w.audit.tail(50).find((e) => e.type === 'allowance_swept');
    assert.ok(line !== undefined, 'the sweep ran after the move settled');
    // $248 USDC and $1.961996 USDT after the swap: USDC goes first, down to the $100 size.
    assert.equal(w.chain.balanceOf(w.account, USDT), (2_000_000n * 980_998n) / 1_000_000n, 'USDT stays: the USDC alone covers the excess');
    assert.equal(w.chain.balanceOf(w.account, USDC) + w.chain.balanceOf(w.account, USDT), usdc(100), 'the allowance is back at exactly its size');
    assert.equal(w.chain.balanceOf(w.vault, USDC), usdc(1850) + usdc(248) - (usdc(100) - (2_000_000n * 980_998n) / 1_000_000n));
  } finally {
    await w.stop();
  }
});

test('a top-up whose send times out and lands is confirmed by NEAR, with one signature and one Touch ID', async () => {
  const service = new SoftwareChipService();
  const w = await allowanceWorld({ service });
  try {
    const filed = await w.svc.proposeVaultTopUp!({ usd: 7, why: 'manual' });
    w.chain.sends.push({ kind: 'timeout', land: true });
    const row = await settledRow(w, w.svc.approve(filed.id));
    assert.equal(row.status, 'executed', JSON.stringify(row.result));
    assert.equal(service.signatures, 1);
    assert.equal(w.chain.executions(), 1);
    assert.equal(w.chain.balanceOf(w.account, USDC), usdc(7));
    assert.deepEqual(w.submitter.pending(), [], 'confirmed by the views, let go');
  } finally {
    await w.stop();
  }
});

test('a top-up whose send never lands is waited out, never signed again, and closes as nothing moved', async () => {
  const service = new SoftwareChipService();
  const w = await allowanceWorld({ service });
  try {
    const filed = await w.svc.proposeVaultTopUp!({ usd: 7, why: 'manual' });
    w.chain.sends.push({ kind: 'lost', land: false });
    const row = await settledRow(w, w.svc.approve(filed.id));
    assert.equal(row.status, 'failed', JSON.stringify(row.result));
    assert.equal(row.result?.reason, 'venue_failed_nothing_moved', 'NEAR proved it never ran: over, and nothing moved');
    assert.match(row.result?.detail ?? '', /never ran and never can/);
    assert.equal(service.signatures, 1, 'one Touch ID, and the move was never signed again');
    assert.equal(w.chain.executions(), 0);
    assert.equal(w.chain.balanceOf(w.vault, USDC), usdc(1850));
    assert.equal(w.chain.balanceOf(w.account, USDC), 0n);
  } finally {
    await w.stop();
  }
});

test('a gas account that cannot pay stops a top-up before the Touch ID', async () => {
  const service = new SoftwareChipService();
  const w = await allowanceWorld({ service });
  try {
    w.chain.fundGas(V.gas, 10n ** 21n);
    const filed = await w.svc.proposeVaultTopUp!({ usd: 7, why: 'manual' });
    const row = await settledRow(w, w.svc.approve(filed.id));
    assert.equal(row.status, 'failed');
    assert.match(row.result?.detail ?? '', /\(gas_low\)/);
    assert.equal(service.signatures, 0, 'no Touch ID for a move the gas account cannot send');
  } finally {
    await w.stop();
  }
});

/* U5's stand-in: main.swift, ChipOps.swift and the grammar compiled with the test seam, its chip
   key a software P-256 key. The service reads the payload itself and writes the sentence. */
test('on the vault service\'s own stand-in, the one Touch ID a top-up asks shows the amount: "move 5.00 USDC from your vault to your allowance"', async (t) => {
  const { VaultDouble, swiftc } = await import('./helpers/vault-double.ts');
  if (!swiftc) {
    t.skip('needs macOS with swiftc');
    return;
  }
  const double = new VaultDouble();
  const start = Date.now();
  double.now = Math.floor(start / 1000);
  const w = await allowanceWorld({ service: { run: (request) => double.run(request as unknown as Record<string, unknown>) as never }, start });
  try {
    const filed = await w.svc.proposeVaultTopUp!({ usd: 5, why: 'manual' });
    const row = await settledRow(w, w.svc.approve(filed.id));
    assert.equal(row.status, 'executed', JSON.stringify(row.result));
    assert.deepEqual(double.dialogs(), ['move 5.00 USDC from your vault to your allowance']);
    assert.equal(double.touches().filter((c) => c.startsWith('sign ')).length, 1);
    assert.equal(w.chain.balanceOf(w.account, USDC), usdc(5));
  } finally {
    await w.stop();
  }
});

test('the sweep signs only with the allowance key, and only a payload that names the allowance as its signer', async () => {
  const w = await allowanceWorld();
  try {
    const home = sweepPayload({ allowance: w.account, vault: w.vault, moves: [{ asset: USDC, base: 1n }], deadlineMs: w.chain.now() + 60_000, salt: SALT });
    assert.equal((await signerOf(home, await signAsAllowance(home))).toLowerCase(), w.account);
    // A payload naming the vault, or anyone else, is never signed by the key that signs with no touch.
    const theirs = topUpPayload({ vault: w.vault, allowance: w.account, coin: { asset: USDC, base: 1n }, deadlineMs: w.chain.now() + 60_000, salt: SALT });
    await assert.rejects(() => signAsAllowance(theirs), /refusing to sign: the payload is for 0x2c7536e3/);
    await assert.rejects(() => signAsAllowance(`${home} `.replace(w.account, SINK)), /refusing to sign/);
    await assert.rejects(() => signAsAllowance('not json'), /no single signer/);
    w.keys.lock();
    await assert.rejects(() => signAsAllowance(home), /locked/);
  } finally {
    await w.stop();
  }
});
