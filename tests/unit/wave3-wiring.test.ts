// Wave 3 as merged (reports/p2-integ3.md): the move to the chip (U10), the allowance (U9) and the
// Hyperliquid trading key (U8b) on one Mac wired the way src/main.ts wires them, against the vault
// service's own rules (tests/unit/helpers/wave3-world.ts). Each test starts from a real move made
// through the window's routes, so what it proves is the join: the chip the move made is the one a
// top-up signs with, the allowance the move pinned is the one the sweep empties, the vault move
// submitter is one, and an agent waits while the vault moves.
//
// Run: node --test tests/unit/wave3-wiring.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { recoverTypedDataAddress } from 'viem';
import { english, mnemonicToAccount } from 'viem/accounts';

import { base58Encode } from '../../src/chain/near.ts';
import { STATE_CACHE_MAX_MS } from '../../src/http/state.ts';
import { accountsOf, deriveKeys } from '../../src/keystore/derived.ts';
import { AGENTS_WAIT_SAID, VAULT_ELSEWHERE_SAID } from '../../src/proposals/lifecycle.ts';
import { buildApproveAgentPayload } from '../../src/rails/hl-user-signed.ts';
import type { Proposal } from '../../src/types.ts';
import { buildVaultPayload } from '../../src/vault/payload.ts';
import { verifierKeyOf } from '../../src/vault/phrase24.ts';
import { MOVE_VAULT_REASON } from '../../src/vault/reason.ts';
import { RESUME_POLL_MS, VIEW_FRESH_MS, erc191Signed } from '../../src/vault/rekey.ts';
import { VAULT_SETTLE_FLOOR_MS, fileJournal, journalPathFor } from '../../src/vault/submit.ts';
import { USDC, USDT } from './helpers/allowance-world.ts';
import { wave3World } from './helpers/wave3-world.ts';
import type { Wave3World } from './helpers/wave3-world.ts';
import type { Hook, Request } from './helpers/vault-double.ts';
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
    assert.ok(pending.verdict.reasons.some((r) => r.includes('the first approves this move, the second moves 2.000001 USDC from your vault to your allowance')), JSON.stringify(pending.verdict));

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

test('a start asks the chip markers right behind the probe, as src/main.ts does: with vault.json\'s chip entry deleted, the first unlock keeps the owner key out', { skip, timeout: 120_000 }, async () => {
  const w = await wave3World({ papers: [PAPER] });
  let first: Wave3World | null = w;
  let again: Wave3World | null = null;
  try {
    const { vault } = await moved(w);
    await w.close();
    first = null;
    const file = path.join(w.dataDir, 'vault.json');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    delete doc.chip;
    fs.writeFileSync(file, JSON.stringify(doc, null, 2));

    // Nothing here asks the service for its markers: the start does, before any unlock is answered.
    again = await wave3World({ chain: w.chain, mac: w.mac, dataDir: w.dataDir });
    assert.ok(again.relay.chipMarkers(vault).length > 0, 'the start learned the marker naming this vault');
    assert.equal((await again.post('/api/vault/unlock')).json.ok, true);
    const owner = again;
    assert.throws(() => owner.keystore.evmPrivateKey(), /owner_touch_required|Touch ID/, 'the marker and the chain keep the owner key out');
  } finally {
    await first?.close();
    await again?.close();
  }
});

/* fix2a FA-1: after a move, vault.json's chip entry and chip-run.json deleted, and the start's chip
   status refused, no marker is known. That is not "no marker": the chain alone decides until the
   service answers, and the owner key stays out until it says the vault never moved. */
test('with no marker known (the notes deleted, the start\'s status refused), the unlock keeps the owner key out of a moved vault, and a vault that never moved gets it back once NEAR says so', { skip, timeout: 120_000 }, async () => {
  const refuseStatus = (state: { refuse: boolean }) => (r: Request): Hook | undefined =>
    r.op === 'chipStatus' && state.refuse ? { kind: 'answer', answer: { ok: false, error: 'keychain_unavailable', message: 'the keychain did not answer' } } : undefined;

  // A moved vault.
  const w = await wave3World({ papers: [PAPER] });
  let first: Wave3World | null = w;
  let again: Wave3World | null = null;
  try {
    const { vault } = await moved(w);
    await w.close();
    first = null;
    const file = path.join(w.dataDir, 'vault.json');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    delete doc.chip;
    fs.writeFileSync(file, JSON.stringify(doc, null, 2));
    fs.rmSync(path.join(w.dataDir, 'chip-run.json'));
    const service = { refuse: true };
    again = await wave3World({ chain: w.chain, mac: w.mac, dataDir: w.dataDir, hook: refuseStatus(service) });
    assert.equal(again.relay.chipMarkersKnown(), false, 'the start\'s status was refused: no marker is known');
    assert.deepEqual(again.relay.chipMarkers(vault), []);
    assert.equal((await again.post('/api/vault/unlock')).json.ok, true);
    const moved1 = again;
    assert.throws(() => moved1.keystore.evmPrivateKey(), /owner_touch_required|Touch ID/, 'the chain alone keeps the owner key out');
    // NEAR's answer (keys listed, the owner key off) keeps it out, and the service answering later changes nothing.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(moved1.gate(vault), true);
    service.refuse = false;
    assert.ok((await moved1.relay.ask({ op: 'chipStatus' })).ok);
    assert.equal(moved1.relay.chipMarkersKnown(), true);
    assert.ok(moved1.relay.chipMarkers(vault).length > 0);
    assert.equal(moved1.gate(vault), true);
  } finally {
    await first?.close();
    await again?.close();
  }

  // A vault that never moved: the same refused start; the first unlock asks NEAR with the owner key
  // it opened, and the next unlock, once NEAR said no key listed and the owner key on, holds it.
  const n = await wave3World();
  let before: Wave3World | null = n;
  let after: Wave3World | null = null;
  try {
    const { vault } = await n.wallet();
    await n.close();
    before = null;
    after = await wave3World({ chain: n.chain, mac: n.mac, dataDir: n.dataDir, hook: refuseStatus({ refuse: true }) });
    const open = after;
    assert.equal(open.relay.chipMarkersKnown(), false);
    assert.equal((await open.post('/api/vault/unlock')).json.ok, true);
    assert.throws(() => open.keystore.evmPrivateKey(), /owner_touch_required|Touch ID/, 'out until NEAR has answered');
    for (let i = 0; i < 100 && open.gate(vault); i += 1) await new Promise((r) => setTimeout(r, 10));
    assert.equal(open.gate(vault), false, 'NEAR: no key listed, the owner key on');
    open.keystore.lock();
    assert.equal((await open.post('/api/vault/unlock')).json.ok, true);
    assert.match(open.keystore.evmPrivateKey(), /^0x[0-9a-f]{64}$/, 'the owner key is back in the session');
  } finally {
    await before?.close();
    await after?.close();
  }
});

/* A vault moved here, then vault.json's chip entry deleted (and `alsoRecord`: the move's run record
   too) and the app started again, its first chipStatus answered by `firstStatus` when given. What the
   Vault tab said from the first read until it read moved, and vault.json's chip then. `late`: the
   tab is read once and left to settle, then something else asks the service for its markers, and
   the states are counted from there. */
async function afterChipEntryDeleted(opts: { alsoRecord?: boolean; firstStatus?: Hook; late?: boolean } = {}): Promise<{ states: string[]; named: string | undefined; keyRef: string }> {
  const w = await wave3World({ papers: [PAPER] });
  let first: Wave3World | null = w;
  let again: Wave3World | null = null;
  try {
    await moved(w);
    const keyRef = w.prefs.get().chip?.keyRef ?? '';
    await w.close();
    first = null;
    const file = path.join(w.dataDir, 'vault.json');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    delete doc.chip;
    fs.writeFileSync(file, JSON.stringify(doc, null, 2));
    if (opts.alsoRecord === true) fs.rmSync(path.join(w.dataDir, 'chip-run.json'));
    let asked = false;
    again = await wave3World({
      chain: w.chain,
      mac: w.mac,
      dataDir: w.dataDir,
      hook: (r) => {
        if (r.op !== 'chipStatus' || asked || opts.firstStatus === undefined) return undefined;
        asked = true;
        return opts.firstStatus;
      },
    });
    if (opts.late === true) {
      await again.get('/api/state');
      await new Promise((r) => setTimeout(r, 300));
      assert.equal((await again.relay.ask({ op: 'chipStatus' })).ok, true);
      // A state built before the markers were learned is served for at most this long.
      await new Promise((r) => setTimeout(r, STATE_CACHE_MAX_MS + 50));
    }
    const states: string[] = [];
    if (opts.alsoRecord === true) {
      /* Both notes gone, and nothing this process read names the owner key's public half: NEAR's
         word that the chip and the paper are on the vault is two reads, not the move (audit2
         AU2-04), so the tab says checking and nothing is written until an unlock reads that half
         and the owner key's view joins them. */
      for (let i = 0; i < 25; i += 1) {
        const state = String((await again.get('/api/state')).json.vault.chip.state);
        if (states.at(-1) !== state) states.push(state);
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.deepEqual(states, ['checking'], 'checking before the unlock, never none');
      assert.equal(again.prefs.get().chip, null, 'nothing written on two reads');
      assert.equal((await again.post('/api/vault/unlock')).json.ok, true);
    }
    for (let i = 0; i < 300; i += 1) {
      const state = String((await again.get('/api/state')).json.vault.chip.state);
      if (states.at(-1) !== state) states.push(state);
      if (state === 'done') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    return { states, named: again.prefs.get().chip?.keyRef, keyRef };
  } finally {
    await first?.close();
    await again?.close();
  }
}

test('a vault moved here whose vault.json lost its chip entry reads checking, never none, until NEAR says the chip is on it; then vault.json names it again', { skip, timeout: 120_000 }, async () => {
  const kept = await afterChipEntryDeleted();
  assert.deepEqual(kept.states, ['checking', 'done']);
  assert.equal(kept.named, kept.keyRef, 'vault.json names the chip again');
  // The move's run record deleted too: the marker the start learned, and the owner key's public half
  // an unlock reads, are the evidence.
  const bare = await afterChipEntryDeleted({ alsoRecord: true });
  assert.deepEqual(bare.states, ['checking', 'done']);
  assert.equal(bare.named, bare.keyRef);
  // The start's chipStatus answered nothing: the record alone makes the tab ask the service itself.
  const unanswered = await afterChipEntryDeleted({ firstStatus: { kind: 'answer', answer: { ok: false, error: 'keychain_unavailable', message: 'the keychain did not answer' } } });
  assert.deepEqual(unanswered.states, ['checking', 'done']);
  assert.equal(unanswered.named, unanswered.keyRef);
  // Neither note on disk and no marker known at first: a marker learned later is asked about at once,
  // not a minute later.
  const late = await afterChipEntryDeleted({ alsoRecord: true, late: true, firstStatus: { kind: 'answer', answer: { ok: false, error: 'keychain_unavailable', message: 'the keychain did not answer' } } });
  assert.deepEqual(late.states, ['checking', 'done']);
  assert.equal(late.named, late.keyRef);
});

test('after the move the reveal still returns the wallet\'s words behind its Touch ID: they derive the allowance and the gas account, and open the vault no more', { skip, timeout: 120_000 }, async () => {
  const w = await wave3World({ papers: [PAPER] });
  try {
    const { vault } = await moved(w);
    const shown = await w.post('/api/vault/reveal');
    assert.equal(shown.json.ok, true, JSON.stringify(shown.json));
    const account = mnemonicToAccount((shown.json.words as string[]).join(' '));
    assert.equal(account.address.toLowerCase(), vault, 'the words are the wallet\'s own');
    const old = Buffer.from(account.getHdKey().privateKey!);
    const derived = accountsOf(deriveKeys(old));
    old.fill(0);
    const chip = (await w.get('/api/state')).json.vault.chip;
    assert.deepEqual([derived.allowance.toLowerCase(), derived.gas], [chip.allowance.account, chip.gas.account], 'they derive the allowance and the gas account the Vault tab shows');
    assert.equal(chip.oldOnChain, false, 'and NEAR reads their key off the vault');
  } finally {
    await w.close();
  }
});

/* Another Mac moved this vault: the wallet's own key signed the move there, adding keys this Mac
   never holds and taking itself off, and NEAR ran it. Then the Vault tab reads NEAR until it says
   the vault is on another Mac's keys. */
async function movedElsewhere(w: Wave3World, vault: string): Promise<void> {
  const key = Buffer.from(w.keystore.evmPrivateKey().slice(2), 'hex');
  const salt = await w.chain.verifier.currentSalt();
  assert.ok(salt !== null);
  const payload = buildVaultPayload({
    signerId: vault,
    intents: [
      { intent: 'add_public_key', public_key: `p256:${base58Encode(Buffer.alloc(64, 0x33))}` },
      { intent: 'add_public_key', public_key: verifierKeyOf(Buffer.alloc(32, 0x44)) },
      { intent: 'remove_public_key', public_key: verifierKeyOf(key) },
      { intent: 'set_auth_by_predecessor_id', enabled: false },
    ],
    deadlineMs: w.chain.now() + 60_000,
    salt,
  });
  const ran = await w.chain.runAsStranger([await erc191Signed(key, payload)]);
  key.fill(0);
  assert.equal(ran.ok, true, ran.panic ?? 'ran');
  // Past the slice's own freshness, so the next read asks NEAR again.
  w.chain.advance(VIEW_FRESH_MS + 1_000);
  for (let i = 0; i < 300; i += 1) {
    if ((await w.get('/api/state')).json.vault.chip.elsewhere === true) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('the Vault tab never read the vault on another Mac\'s keys');
}

test('on a Mac whose vault moved to another Mac\'s keys, a spend from the vault and Add NEAR refuse in words before anything is signed, and Add NEAR names the gas account', { skip, timeout: 120_000 }, async () => {
  const w = await wave3World();
  try {
    const { vault, gas } = await w.wallet();
    w.chain.fund(vault, USDC, usdc(1850));
    w.ledger.reread();
    const swap = (amountIn: string) => ({ op: 'propose', kind: 'swap', params: { chain: 'near', toChain: 'near', fromSymbol: 'USDC', toSymbol: 'USDT', amountIn } });
    // Filed before NEAR showed the move: over the $100 click line, so it waits for the person.
    const big = await w.mcp(swap('150'));
    assert.equal(w.svc.get(String(big.json.id))?.status, 'pending');
    // On its way when NEAR shows the move: under the click line, it waits at its last read before the key.
    const read = w.holdSwapRead();
    const small = await w.mcp(swap('2'));
    assert.equal(w.svc.get(String(small.json.id))?.status, 'executing');
    await read.reached;

    await movedElsewhere(w, vault);
    const chip = (await w.get('/api/state')).json.vault.chip;
    assert.deepEqual([chip.state, chip.oldOnChain, chip.elsewhere], ['broken', false, true], 'the Vault tab offers the restore');

    // The move on its way stops at its last check before the key, in words.
    read.release();
    const stopped = await w.svc.settled(String(small.json.id), 30_000);
    assert.equal(stopped.status, 'failed', JSON.stringify(stopped.result));
    assert.equal(stopped.result?.reason, 'vault_elsewhere');
    assert.equal(w.svc.view(stopped).reason?.sentence, VAULT_ELSEWHERE_SAID);

    // A new one is refused when it is filed.
    const again = await w.mcp(swap('2'));
    const refused = w.svc.get(String(again.json.id))!;
    assert.equal(refused.status, 'policy_refused');
    assert.equal(refused.verdict.outcome === 'refuse' && refused.verdict.rule, 'vault_elsewhere');
    assert.equal(w.svc.view(refused).reason?.code, 'vault_elsewhere');

    // A click on the earlier one: refused in words, and no Touch ID is asked for it.
    const from = w.seen.length;
    await w.post('/api/approve', { id: String(big.json.id) });
    const clicked = w.svc.get(String(big.json.id))!;
    assert.equal(clicked.status, 'policy_refused');
    assert.equal(w.svc.view(clicked).reason?.sentence, VAULT_ELSEWHERE_SAID);
    assert.deepEqual(w.seen.slice(from).map((r) => r.op), [], 'no Touch ID was asked');

    // Add NEAR: refused at the route, with the gas account's id to send NEAR to straight; nothing filed.
    const rows = w.svc.list().length;
    const fund = await w.post('/api/vault/gas/fund', { near: 0.5 });
    assert.deepEqual([fund.json.ok, fund.json.code, fund.json.gas], [false, 'fund_elsewhere', gas]);
    assert.match(String(fund.json.error), /another Mac's Touch ID key now, so this Mac cannot pay NEAR from it/);
    assert.equal(w.svc.list().length, rows, 'no payout was filed');
    assert.equal(w.publishes.length, 0, 'nothing was signed');
  } finally {
    await w.close();
  }
});

/* The owner key's Touch ID for the move, held until the test lets it go: the move is under way and
   waits at touch_old. */
function heldMoveTouch(): { hook: (r: Request) => Hook | undefined; reached: Promise<void>; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reachedNow!: () => void;
  const reached = new Promise<void>((resolve) => {
    reachedNow = resolve;
  });
  const hook = (r: Request): Hook | undefined =>
    r.op === 'unwrap' && r.reason === MOVE_VAULT_REASON
      ? {
          kind: 'after',
          edit: async (answer) => {
            reachedNow();
            await gate;
            return answer;
          },
        }
      : undefined;
  return { hook, reached, release };
}

test('while the vault moves, an agent proposes nothing and a click on its earlier move waits; asked again after the move, it runs', { skip, timeout: 120_000 }, async () => {
  const held = heldMoveTouch();
  const w = await wave3World({ papers: [PAPER], hook: held.hook });
  try {
    const { vault, allowance } = await w.wallet();
    w.chain.fund(vault, USDC, usdc(1850));
    w.ledger.reread();
    // Filed before the move: over the $100 click line, so it waits for the person.
    const big = await w.mcp({ op: 'propose', kind: 'swap', params: { chain: 'near', toChain: 'near', fromSymbol: 'USDC', toSymbol: 'USDT', amountIn: '150' } });
    assert.equal(big.status, 200, JSON.stringify(big.json));
    assert.equal(w.svc.get(String(big.json.id))?.status, 'pending');

    const run = await w.startMove(PAPER);
    await held.reached;
    const chip = (await w.get('/api/state')).json.vault.chip;
    assert.equal(chip.run.status, 'touch_old', 'the move is under way');
    assert.equal(chip.moving, true, 'and the agent\'s line says so');

    const rows = w.svc.list().length;
    const asked = await w.mcp({ op: 'propose', kind: 'swap', params: { chain: 'near', toChain: 'near', fromSymbol: 'USDC', toSymbol: 'USDT', amountIn: '2' } });
    assert.equal(asked.status, 409);
    assert.deepEqual(asked.json, { error: AGENTS_WAIT_SAID, paused: 'vault_moving' });
    assert.equal(w.svc.list().length, rows, 'nothing was drafted or written');
    assert.ok(w.audit.tail(20).some((e) => e.type === 'agent_rejected' && /the vault is moving/.test(e.msg)));

    const click = await w.post('/api/approve', { id: String(big.json.id) });
    assert.equal(click.status, 400);
    assert.equal(click.json.error, "Your vault is moving to this Mac's Touch ID key right now. Approve this once the move is done. Nothing changed.");
    assert.equal(w.svc.get(String(big.json.id))?.status, 'pending', 'the click can be made again');
    assert.equal(w.publishes.length, 0, 'nothing was signed for an agent');

    held.release();
    assert.equal(await w.settled(run), 'done');
    w.chain.fund(allowance, USDC, usdc(10));
    w.ledger.reread();
    const again = await w.mcp({ op: 'propose', kind: 'swap', params: { chain: 'near', toChain: 'near', fromSymbol: 'USDC', toSymbol: 'USDT', amountIn: '2' } });
    assert.equal(again.status, 200, JSON.stringify(again.json));
    const ran = await w.svc.settled(String(again.json.id), 30_000);
    assert.equal(ran.status, 'executed', JSON.stringify(ran.result));
    assert.deepEqual(w.publishes.map((p) => p.signer), [allowance], 'after the move it runs, from the allowance');
  } finally {
    held.release();
    await w.close();
  }
});

test('an agent move already on its way when the vault starts moving reaches its signature and signs nothing', { skip, timeout: 120_000 }, async () => {
  const held = heldMoveTouch();
  const w = await wave3World({ papers: [PAPER], hook: held.hook });
  try {
    const { vault } = await w.wallet();
    w.chain.fund(vault, USDC, usdc(1850));
    w.ledger.reread();
    const read = w.holdSwapRead();
    const asked = await w.mcp({ op: 'propose', kind: 'swap', params: { chain: 'near', toChain: 'near', fromSymbol: 'USDC', toSymbol: 'USDT', amountIn: '2' } });
    assert.equal(asked.status, 200, JSON.stringify(asked.json));
    const id = String(asked.json.id);
    assert.equal(w.svc.get(id)?.status, 'executing', 'under the click line: the rail runs, and waits on its last read');

    const run = await w.startMove(PAPER);
    await held.reached;
    await read.reached;
    read.release();
    const row = await w.svc.settled(id, 30_000);
    assert.equal(row.status, 'failed', JSON.stringify(row.result));
    assert.equal(row.result?.reason, 'vault_moving');
    assert.equal(w.svc.view(row).reason?.sentence, "Your vault is moving to this Mac's Touch ID key right now, so nothing moved. Ask again once the move is done.");
    assert.equal(w.publishes.length, 0, 'nothing was signed');
    assert.equal(w.chain.balanceOf(vault, USDC), usdc(1850));

    held.release();
    assert.equal(await w.settled(run), 'done');
  } finally {
    held.release();
    await w.close();
  }
});

test('a swap still being proposed when the vault starts moving lands refused, with nothing signed', { skip, timeout: 120_000 }, async () => {
  const held = heldMoveTouch();
  const w = await wave3World({ papers: [PAPER], hook: held.hook });
  try {
    const { vault } = await w.wallet();
    w.chain.fund(vault, USDC, usdc(1850));
    w.ledger.reread();
    const quote = w.holdQuote();
    const asking = w.mcp({ op: 'propose', kind: 'swap', params: { chain: 'near', toChain: 'near', fromSymbol: 'USDC', toSymbol: 'USDT', amountIn: '2' } });
    await quote.reached;

    const run = await w.startMove(PAPER);
    await held.reached;
    quote.release();
    const asked = await asking;
    assert.equal(asked.status, 200, JSON.stringify(asked.json));
    const row = w.svc.get(String(asked.json.id))!;
    assert.equal(row.status, 'policy_refused');
    assert.equal(row.verdict.outcome === 'refuse' && row.verdict.rule, 'vault_moving');
    assert.equal(row.verdict.reasons.at(-1), AGENTS_WAIT_SAID);
    assert.equal(w.svc.view(row).reason?.code, 'vault_moving');
    assert.equal(w.publishes.length, 0, 'nothing was signed');

    held.release();
    assert.equal(await w.settled(run), 'done');
  } finally {
    held.release();
    await w.close();
  }
});

test('after a restart, a move to the chip written down and still able to run keeps agents waiting until NEAR can no longer run it; a top-up written down does not', { skip, timeout: 120_000 }, async () => {
  const w = await wave3World();
  try {
    const { vault, gas } = await w.wallet();
    w.chain.fund(vault, USDC, usdc(1850));
    w.ledger.reread();
    const swap = { op: 'propose', kind: 'swap', params: { chain: 'near', toChain: 'near', fromSymbol: 'USDC', toSymbol: 'USDT', amountIn: '2' } };
    // What a crash leaves: no run in this process, and the journal holding a bundle that went out.
    const deadline = w.chain.now() + 60_000;
    const entry = (id: string) => ({ id, account: vault, gas, signed: [{ standard: 'erc191', payload: JSON.stringify({ deadline: new Date(deadline).toISOString() }), signature: 'secp256k1:x' }], txHashes: ['tx'], state: 'sent' as const, at: w.chain.now() });
    const journal = fileJournal(journalPathFor(w.dataDir));

    // The agent's line reads the state's `moving`, the same fact that holds the agents.
    const line = async (): Promise<unknown> => (await w.get('/api/state')).json.vault.chip.moving;

    journal.put(entry('vault_top_up:p-1'));
    const topUp = await w.mcp(swap);
    assert.equal(topUp.status, 200, 'a top-up written down changes no key: agents go on');
    assert.equal((await w.svc.settled(String(topUp.json.id), 30_000)).status, 'executed');
    assert.equal(await line(), false);

    journal.put(entry('rekey:chip:p2-test'));
    const waiting = await w.mcp(swap);
    assert.equal(waiting.status, 409);
    assert.equal(waiting.json.paused, 'vault_moving');
    const state = (await w.get('/api/state')).json.vault.chip;
    assert.equal(state.run, null, 'no run in this process after the restart');
    assert.equal(state.moving, true, 'the line says the vault is moving while the hold stands');

    // Past its deadline and the two minutes the submitter waits beyond it, NEAR can no longer run it.
    w.chain.advance(60_000 + VAULT_SETTLE_FLOOR_MS + RESUME_POLL_MS + 1_000);
    const again = await w.mcp(swap);
    assert.equal(again.status, 200, JSON.stringify(again.json));
    assert.equal((await w.svc.settled(String(again.json.id), 30_000)).status, 'executed');
    assert.equal(await line(), false, 'and stops saying it when the hold ends');
  } finally {
    await w.close();
  }
});
