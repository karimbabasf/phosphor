// Wave 3 as merged (reports/p2-integ3.md): the move to the chip (U10), the allowance (U9) and the
// Hyperliquid trading key (U8b) on one Mac wired the way src/main.ts wires them, against the vault
// service's own rules (tests/unit/helpers/wave3-world.ts). Each test starts from a real move made
// through the window's routes, so what it proves is the join: the chip the move made is the one a
// top-up signs with, the allowance the move pinned is the one the sweep empties, and the vault move
// submitter is one.
//
// Run: node --test tests/unit/wave3-wiring.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { recoverTypedDataAddress } from 'viem';
import { english } from 'viem/accounts';

import { buildApproveAgentPayload } from '../../src/rails/hl-user-signed.ts';
import type { Proposal } from '../../src/types.ts';
import { USDC, USDT } from './helpers/allowance-world.ts';
import { wave3World } from './helpers/wave3-world.ts';
import type { Wave3World } from './helpers/wave3-world.ts';
import { swiftc } from './helpers/vault-double.ts';

const skip = swiftc ? false : 'needs macOS with swiftc';

// A paper key made of words no sentence of this app writes, picked by their place in the BIP39 list.
const PAPER = [2047, 1022, 1343, 1392, 574, 1389, 2044, 766, 1026, 296, 1152, 804, 1522, 1266, 1046, 1233, 315, 250, 1824, 784, 1816, 1533, 953, 270].map((i) => english[i]).join(' ');
const usdc = (n: number): bigint => BigInt(Math.round(n * 1e6));

async function rowSettled(w: Wave3World, id: string): Promise<Proposal> {
  return w.svc.settled(id, 30_000);
}

async function untilRow(w: Wave3World, id: string, done: (p: Proposal) => boolean): Promise<Proposal> {
  for (let i = 0; i < 3000; i += 1) {
    const p = w.svc.get(id);
    if (p !== undefined && done(p)) return p;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`proposal ${id} never got there: ${JSON.stringify(w.svc.get(id)?.status)}`);
}

// The vault moved by the window's own routes, then the state the rest of each test starts from.
async function moved(w: Wave3World): Promise<{ vault: string; allowance: string }> {
  const { vault, allowance } = await w.wallet();
  w.chain.fund(vault, USDC, usdc(1850));
  const run = await w.startMove(PAPER);
  assert.equal(await w.settled(run), 'done');
  assert.equal(w.accounts.accounts().kind, 'chip', 'the move asked the accounts again: the rails spend the allowance');
  w.ledger.reread();
  return { vault, allowance };
}

test('after the move, a top-up, a swap with no click and a sweep: both accounts end exact to the base unit, through the window and the agent door', { skip, timeout: 120_000 }, async () => {
  const w = await wave3World({ papers: [PAPER] });
  try {
    const { vault, allowance } = await moved(w);

    // The Vault tab reads the allowance's account, size and balance (U9's allowanceState in U10's slice).
    const before = (await w.get('/api/state')).json.vault.chip;
    assert.deepEqual(before.allowance, { account: allowance, sizeUsd: w.prefs.get().allowance.sizeUsd, balanceUsd: 0 });

    // Top up $5: the window asks, a click approves, and the vault's chip key signs behind one Touch ID.
    const asked = await w.post('/api/vault/allowance/top-up', { usd: 5 });
    assert.equal(asked.json.ok, true, JSON.stringify(asked.json));
    const id = String(asked.json.proposal.id);
    const clicked = await w.post('/api/approve', { id });
    assert.equal(clicked.status, 200, JSON.stringify(clicked.json));
    const topUp = await untilRow(w, id, (p) => p.status !== 'approved' && p.status !== 'executing');
    assert.equal(topUp.status, 'executed', JSON.stringify(topUp.result));
    assert.deepEqual(w.mac.dialogs().slice(-1), ['move 5.00 USDC from your vault to your allowance']);
    assert.equal(w.chain.balanceOf(vault, USDC), usdc(1845));
    assert.equal(w.chain.balanceOf(allowance, USDC), usdc(5));
    w.ledger.reread();
    assert.equal((await w.get('/api/state')).json.vault.chip.allowance.balanceUsd, 5, 'the Vault tab reads the allowance after the top-up');

    // Swap $2 with no click, asked for by an agent through its door: the allowance key signs it.
    const swap = await w.mcp({ op: 'propose', kind: 'swap', params: { chain: 'near', toChain: 'near', fromSymbol: 'USDC', toSymbol: 'USDT', amountIn: '2' } });
    assert.equal(swap.status, 200, JSON.stringify(swap.json));
    const swapped = await rowSettled(w, String(swap.json.id));
    assert.equal(swapped.status, 'executed', JSON.stringify(swapped.result));
    assert.equal(swapped.decidedBy, 'policy');
    assert.deepEqual(w.publishes.map((p) => p.signer), [allowance]);
    assert.equal(w.chain.balanceOf(allowance, USDC), usdc(3));
    assert.equal(w.chain.balanceOf(allowance, USDT), 1_961_996n);

    // A size of $1: what is over it goes home, USDC first, signed by the allowance key with no touch.
    const touches = w.mac.touches().length;
    w.ledger.reread();
    const sized = await w.post('/api/vault/allowance/size', { usd: 1 });
    assert.equal(sized.json.ok, true, JSON.stringify(sized.json));
    for (let i = 0; i < 500 && w.chain.balanceOf(allowance, USDC) !== 0n; i += 1) await new Promise((r) => setTimeout(r, 10));
    const line = w.audit.tail(50).find((e) => e.type === 'allowance_swept');
    assert.ok(line !== undefined, 'the sweep left its line in the log');
    assert.deepEqual((line.data as { moves: unknown }).moves, [
      { asset: USDC, base: '3000000' },
      { asset: USDT, base: '961996' },
    ]);
    assert.equal(w.chain.balanceOf(allowance, USDC), 0n);
    assert.equal(w.chain.balanceOf(allowance, USDT), 1_000_000n, 'exactly the $1 size stays');
    assert.equal(w.chain.balanceOf(vault, USDC), usdc(1848));
    assert.equal(w.chain.balanceOf(vault, USDT), 961_996n);
    assert.equal(w.mac.touches().length, touches, 'the sweep asked no Touch ID');
  } finally {
    await w.close();
  }
});

test('after the move, a clicked swap bigger than the allowance moves exactly the shortfall from the vault first: the approval Touch ID, then the vault\'s', { skip, timeout: 120_000 }, async () => {
  const w = await wave3World({ papers: [PAPER] });
  try {
    const { vault, allowance } = await moved(w);
    w.chain.fund(allowance, USDC, usdc(1));
    w.ledger.reread();

    const asked = await w.mcp({ op: 'propose', kind: 'swap', params: { chain: 'near', toChain: 'near', fromSymbol: 'USDC', toSymbol: 'USDT', amountIn: '3.000001' } });
    assert.equal(asked.status, 200, JSON.stringify(asked.json));
    const id = String(asked.json.id);
    const pending = w.svc.get(id)!;
    assert.equal(pending.status, 'pending', 'bigger than the allowance: it waits for a click, whatever its size');
    assert.ok(pending.verdict.reasons.some((r) => r.includes('2.000001 USDC moves from your vault first')), JSON.stringify(pending.verdict));

    const from = w.seen.length;
    const clicked = await w.post('/api/approve', { id });
    assert.equal(clicked.status, 200, JSON.stringify(clicked.json));
    const done = await untilRow(w, id, (p) => !['approved', 'awaiting_touch', 'executing'].includes(p.status));
    assert.equal(done.status, 'executed', JSON.stringify(done.result));

    const child = w.svc.list().find((p) => p.draft.kind === 'vault_top_up');
    assert.ok(child !== undefined && child.draft.kind === 'vault_top_up');
    assert.deepEqual([child.status, child.draft.why, child.draft.amount, child.draft.forProposal, child.decidedBy], ['executed', 'shortfall', '2.000001', id, 'human']);
    // The two Touch IDs, in order: the approval's unwrap, then the vault chip key's signature.
    const asks = w.seen.slice(from).filter((r) => r.op === 'unwrap' || r.op === 'signIntent').map((r) => r.op);
    assert.deepEqual(asks, ['unwrap', 'signIntent']);
    assert.deepEqual(w.mac.dialogs().slice(-1), ['move 2.000001 USDC from your vault to your allowance']);
    assert.equal(w.chain.balanceOf(vault, USDC), usdc(1850) - 2_000_001n, 'exactly the shortfall left the vault');
    assert.equal(w.chain.balanceOf(allowance, USDC), 0n);
    assert.equal(w.chain.balanceOf(allowance, USDT), (3_000_001n * 980_998n) / 1_000_000n);
    assert.deepEqual(w.publishes.map((p) => p.signer), [allowance], 'the swap was signed by the allowance key');
  } finally {
    await w.close();
  }
});

test('after the move, Allow trading on Hyperliquid is one Touch ID whose sentence names the derived key and its 90 days', { skip, timeout: 120_000 }, async () => {
  const w = await wave3World({ papers: [PAPER] });
  try {
    const { vault } = await moved(w);
    const key = w.keystore.hlAgentAccount(1);
    assert.ok(key !== null, 'the open made the next trading key beside the allowance and the gas account');
    const body = key.toLowerCase().slice(2);

    const from = w.seen.length;
    const touches = w.mac.touches().length;
    const allowed = await w.post('/api/vault/trading-key/allow');
    assert.equal(allowed.json.ok, true, JSON.stringify(allowed.json));
    assert.deepEqual([allowed.json.address.toLowerCase(), allowed.json.version, allowed.json.days], [key.toLowerCase(), 1, 90]);

    const unwraps = w.seen.slice(from).filter((r) => r.op === 'unwrap');
    assert.deepEqual(unwraps.map((r) => r.reason), [`Let 0x${body.slice(0, 8)}...${body.slice(-8)} trade on your Hyperliquid account for 90 days`]);
    assert.equal(w.mac.touches().length, touches + 1, 'one Touch ID');
    assert.equal(w.hlPosts.length, 1);
    const [sent] = w.hlPosts;
    const action = sent!.action as { type: string; agentAddress: string; agentName: string; nonce: number };
    assert.equal(action.type, 'approveAgent');
    assert.equal(action.agentAddress, key.toLowerCase());
    assert.match(action.agentName, /^phosphor-runner valid_until \d+$/);
    const { typedData } = buildApproveAgentPayload({ agentAddress: action.agentAddress, agentName: action.agentName, nonce: action.nonce });
    const signature = sent!.signature as { r: `0x${string}`; s: `0x${string}`; v: number };
    const signer = await recoverTypedDataAddress({ domain: typedData.domain, types: typedData.types as never, primaryType: typedData.primaryType as never, message: typedData.message as never, signature: { r: signature.r, s: signature.s, yParity: signature.v - 27 } } as never);
    assert.equal(signer.toLowerCase(), vault, 'the owner key signed it, behind that one Touch ID');
    assert.equal(w.prefs.get().hlAgent?.version, 1);
    assert.equal(w.keystore.apiWallet()?.address?.toLowerCase(), key.toLowerCase(), 'plans trade with the new key at once');
    assert.throws(() => w.keystore.evmPrivateKey(), /owner_touch_required|Touch ID/, 'and the owner key stays out of the session');
  } finally {
    await w.close();
  }
});
