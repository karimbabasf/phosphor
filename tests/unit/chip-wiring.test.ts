// The chip vault's pieces joined the way src/main.ts joins them (PHASE2-PLAN.md, wave 2). Four
// units built them apart: the service's chip ops (U5), the chip signer and its owner key gate (U6),
// the rails switch (U7) and the Hyperliquid owner touch (U8). Here they meet. The owner key gate is
// one function that the keystore and the owner touch both read, so a vault the chain shows moved is
// one Touch ID per owner action whichever of the two asks first.
//
// Real parts wherever a key is involved: the keystore, the relay, the proposal service and the
// withdrawal rail are the app's own; a software P-256 key plays the enclave, the shell is played by
// hand, and every remote is faked. No dialog, nothing signed for real money.
//
// Run: node --test tests/unit/chip-wiring.test.ts

import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { base58Encode } from '../../src/chain/near.ts';
import { identityProof } from '../../src/http/respond.ts';
import type { OneClickClient, OneClickQuote, OneClickQuoteParams, OneClickToken, TokensFile } from '../../src/intents.ts';
import { liveIntentsSigner, railAccounts, useRailAccounts } from '../../src/intents-sign.ts';
import { OwnerTouchRequired, createKeystore, useKeystore } from '../../src/keystore/index.ts';
import { seUnwrapWithSoftwareKey } from '../../src/keystore/sewrap.ts';
import { ourIntentsAddress } from '../../src/proposals/draft.ts';
import { ownerTouchVia } from '../../src/proposals/lifecycle.ts';
import type { PCtx } from '../../src/proposals/lifecycle.ts';
import { ownerTouchRequired, useOwnerTouch } from '../../src/rails/hl-user-signed.ts';
import { INTENTS_RELAY_COUNTERPARTY, INTENTS_RELAY_VENUE, NONCE_LIFE_AFTER_DEADLINE_MS, intentsRelayRail } from '../../src/rails/intents-relay.ts';
import type { RelayClient, RelayPublishResult, RelayStatus } from '../../src/relay/client.ts';
import { decodeNonce } from '../../src/relay/payload.ts';
import type { VerifierPort } from '../../src/relay/verifier.ts';
import type { SwapDraft } from '../../src/types.ts';
import { createAccounts, ownerKeyOut } from '../../src/vault/accounts.ts';
import { CHIP_PAYLOAD_LIFE_MS, chipStatusReader, commitChip, createChip, ownerKeyGate, sweepChips } from '../../src/vault/chip.ts';
import { buildVaultPayload } from '../../src/vault/payload.ts';
import { createVaultPrefs } from '../../src/vault/prefs.ts';
import { createVaultRelay } from '../../src/vault/relay.ts';
import type { VaultRequest } from '../../src/vault/relay.ts';
import { DERIVED_VECTORS } from '../fixtures/derived-keys.ts';
import { SoftwareChipService, serve } from './helpers/chip-fake.ts';
import type { Answer } from './helpers/chip-fake.ts';
import { SALT, createIntentsDouble } from './helpers/intents-double.ts';
import { chipVault, teardown, withdrawWorld } from './helpers/owner-touch.ts';
import { makeCtx } from './helpers/proposals.ts';
import { signerOf } from './helpers/rail-kinds.ts';
import { TEST_QUOTE_KEY, signQuote } from './helpers/signed-quote.ts';
import { tempDir } from './helpers/tmp.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const [V] = DERIVED_VECTORS;
const KEY_REF = 'chip:com.karimbabasf.phosphor.chip.p2-test.0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0';
const PAPER = `secp256k1:${base58Encode(Buffer.alloc(64, 0x5e))}`;

const main = (): string => fs.readFileSync(path.join(ROOT, 'src', 'main.ts'), 'utf8');

function chipPublicKey(): string {
  const jwk = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  return `p256:${base58Encode(Buffer.concat([Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]))}`;
}

function secpKey(privateKey: `0x${string}`): string {
  return `secp256k1:${base58Encode(Buffer.from(privateKeyToAccount(privateKey).publicKey.slice(4), 'hex'))}`;
}

test.afterEach(() => {
  teardown();
  useRailAccounts(null);
});

type Service = { run(request: VaultRequest): Answer | Promise<Answer> };

/* One Mac, wired the way src/main.ts wires it: a keystore holding the vector's owner key in an
   enclave-wrapped file (a software P-256 key plays the enclave), vault.json, the relay with a
   service behind it, the chain double, the owner key gate on the keystore, and the accounts the
   rails read, asking the service through the relay. `marker` is the account the backend pins the
   new chip key to, or null for no chip at all; `moved` puts that chip key and its paper key on the
   vault on chain and names it in vault.json, as the end of a rekey leaves them; `onChain` puts only
   the named pinned keys on the vault, vault.json untouched; the gate's chain reads wait for
   `chainHeld` when it is given. Nothing here moves the vault. */
async function mac(service: Service, opts: { marker?: string | null; moved?: boolean; makesKeys?: boolean; onChain?: ('chip' | 'paper')[]; chainHeld?: Promise<void> } = {}) {
  const dir = tempDir('phosphor-chip-wiring-');
  fs.mkdirSync(path.join(dir, 'state'));
  const keysPath = path.join(dir, 'keys.json');
  const prefs = createVaultPrefs(path.join(dir, 'state'));
  const relay = createVaultRelay({ transportKey: crypto.randomBytes(32), makesKeys: opts.makesKeys ?? true });
  const shell = serve(relay, service);
  const chain = createIntentsDouble();
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = pair.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const x963 = Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  const store = createKeystore({ keysPath, kdf: () => ({ name: 'scrypt', N: 2 ** 14, r: 8, p: 1, salt: crypto.randomBytes(16).toString('hex') }) });
  const held = opts.chainHeld;
  const chainForGate: Pick<VerifierPort, 'hasPublicKey'> =
    held === undefined ? chain.verifier : { hasPublicKey: async (account, key, at) => (await held, chain.verifier.hasPublicKey(account, key, at)) };
  const ownerKeyStaysOut = ownerKeyGate(() => prefs.get(), relay, chainForGate);
  store.keepOwnerKeyOutWhen(ownerKeyStaysOut);
  store.importWithEnclave({ keyBlob: crypto.randomBytes(427).toString('base64'), publicKey: x963.toString('base64'), createdAt: new Date().toISOString() }, { keys: { evm: `0x${V.old}` } });
  store.lock();
  const accounts = createAccounts({ keystore: store, prefs, chipStatus: chipStatusReader(relay) });
  useKeystore(store);
  useRailAccounts(accounts.accounts);

  const vault = V.vault.toLowerCase();
  const recovery = secpKey(generatePrivateKey());
  let chip: { keyRef: string; publicKey: string } | null = null;
  const marker = opts.marker === undefined ? vault : opts.marker;
  if (marker !== null) {
    const made = await createChip(relay);
    assert.ok(made.ok, JSON.stringify(made));
    const committed = await commitChip(relay, { keyRef: made.keyRef, account: marker, allowance: V.allowance.toLowerCase(), recovery });
    assert.ok(committed.ok, JSON.stringify(committed));
    chip = { keyRef: made.keyRef, publicKey: made.publicKey };
    if (opts.moved === true) {
      chain.addKey(vault, made.publicKey);
      chain.addKey(vault, recovery);
      prefs.setChip({ ...chip, account: vault });
    }
    if (opts.onChain?.includes('chip')) chain.addKey(vault, made.publicKey);
    if (opts.onChain?.includes('paper')) chain.addKey(vault, recovery);
  }
  return {
    keysPath,
    prefs,
    relay,
    chain,
    store,
    accounts,
    chip,
    recovery,
    ownerKeyStaysOut,
    // What src/main.ts does at start: the markers read right behind the probe, then the gate asks
    // the chain about this wallet's vault while the person reaches for the sensor.
    async boot() {
      await relay.ask({ op: 'chipStatus' });
      ownerKeyStaysOut(V.vault);
      await new Promise((resolve) => setImmediate(resolve));
    },
    // An unlock, through the enclave stand-in.
    open() {
      store.lock();
      const request = store.enclaveRequest();
      assert.ok(request !== null);
      assert.deepEqual(store.unlockWithDataKey(seUnwrapWithSoftwareKey({ ephemeralPublicKey: request.ephemeralPublicKey, ciphertext: request.ciphertext }, pair.privateKey, Buffer.from(request.aad, 'base64'))), { ok: true });
    },
    stop: async () => {
      await shell.stop();
      relay.stop();
    },
  };
}

test('src/main.ts hands the Hyperliquid owner touch the keystore\'s own gate, and asks no second one', () => {
  const source = main();
  const gate = source.indexOf('keystore.keepOwnerKeyOutWhen(ownerKeyStaysOut);');
  const touch = source.indexOf('useOwnerTouch(ownerTouchVia({ vault, keystore, ownerOut: ownerKeyStaysOut }));');
  assert.ok(gate > 0 && touch > gate, 'the touch reads the gate the keystore was given');
  assert.equal(source.match(/ownerKeyGate\(/g)?.length, 1, 'one gate');
  assert.ok(!source.includes('ownerKeyOut('), 'vault.json\'s word alone decides nothing in src/main.ts');
});

/* The case the one gate is for: the chain shows the vault moved to its chip, the service's marker
   names the vault, and vault.json's chip entry is gone. The keystore keeps the owner key out on the
   marker, so the owner touch must say the same, or a withdrawal asks for a Touch ID that opens
   nothing before the one that signs. `ownerOut` is what the touch is handed: the gate src/main.ts
   passes, or vault.json's word alone, the predicate it passed before the units met. */
async function withdrawalOnMarker(ownerOut: 'gate' | 'vault.json') {
  const v = chipVault(V.old, { moved: false });
  await v.attach();
  const dir = tempDir('phosphor-chip-wiring-');
  fs.mkdirSync(path.join(dir, 'state'));
  const prefs = createVaultPrefs(path.join(dir, 'state'));
  assert.equal(prefs.get().chip, null, 'vault.json names no chip');

  const chip = chipPublicKey();
  const vault = v.vault.toLowerCase();
  const read = v.relay.ask({ op: 'chipStatus' });
  const request = await v.relay.next(1_000);
  assert.ok(request !== null && request.op === 'chipStatus');
  const marker = { account: vault, allowance: V.allowance.toLowerCase(), recovery: PAPER, at: '2026-10-04T12:00:00.000Z' };
  v.relay.answer({ id: request.id, ok: true, keychainHome: true, chips: [{ keyRef: KEY_REF, publicKey: chip, fresh: false, marker }] });
  assert.ok((await read).ok);

  const chainAsked: string[] = [];
  const gate = ownerKeyGate(() => prefs.get(), v.relay, { hasPublicKey: async (account, key) => (chainAsked.push(key), account === vault && key === chip) });
  v.store.keepOwnerKeyOutWhen(gate);
  useOwnerTouch(ownerTouchVia({ vault: v.relay, keystore: v.store, ownerOut: ownerOut === 'gate' ? gate : (evm) => ownerKeyOut(prefs.get(), evm) }));
  assert.equal(gate(v.vault), true, 'out while the chain is asked');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(chainAsked, [chip, PAPER]);
  assert.equal(gate(v.vault), true, 'the chain shows the chip on the vault: out for good');

  const world = withdrawWorld(v.keysPath);
  const h = makeCtx({ rails: [world.rail], deps: { vault: v.relay, keystore: v.store } });
  const proposed = await h.svc.proposeHlWithdraw({ amount: 8 });
  assert.equal(proposed.status, 'pending');
  return { v, world, h, proposed };
}

test('a vault the chain shows moved, with vault.json\'s chip entry gone: a withdrawal asks one Touch ID, the send\'s', async () => {
  const { v, world, h, proposed } = await withdrawalOnMarker('gate');
  assert.equal(ownerTouchRequired(), true, 'the touch reads what the keystore reads');
  const clicked = await h.svc.approve(proposed.id);
  assert.notEqual(clicked.status, 'awaiting_touch', 'the click is the approval');
  const asked = await v.shell.answer();
  assert.equal(asked.reason, 'Send 8.00 USDC from your Hyperliquid account to 0xaf4fda38...3184d954');
  const done = await h.svc.settled(proposed.id, 5_000);
  assert.equal(done.status, 'executed', done.result?.detail ?? '');
  assert.equal(v.shell.asked.length, 1, 'one dialog for the whole withdrawal');
  assert.equal(world.posts.length, 1);
  assert.equal(v.store.state(), 'locked', 'and no session was opened');
});

test('the same withdrawal with vault.json\'s word alone handed to the touch asks a Touch ID that opens nothing first', async () => {
  const { v, world, h, proposed } = await withdrawalOnMarker('vault.json');
  assert.equal(ownerTouchRequired(), false, 'vault.json names no chip, so this touch thinks the key is in');
  const clicked = await h.svc.approve(proposed.id);
  assert.equal(clicked.status, 'awaiting_touch');
  const approval = await v.shell.answer();
  assert.ok(approval.id.startsWith('approve:'), 'an approval touch first');
  const send = await v.shell.answer();
  assert.equal(send.reason, 'Send 8.00 USDC from your Hyperliquid account to 0xaf4fda38...3184d954', 'and the key still signs only behind its own');
  const done = await h.svc.settled(proposed.id, 5_000);
  assert.equal(done.status, 'executed', done.result?.detail ?? '');
  assert.equal(v.shell.asked.length, 2, 'two dialogs where one does: the mismatch src/main.ts no longer has');
  assert.equal(world.posts.length, 1);
});

test('src/main.ts gives the accounts the service\'s chip status through the relay, and asks it once at start behind the markers', () => {
  const source = main();
  const markers = source.indexOf("    void vault.ask({ op: 'chipStatus' }).then((answer) => {");
  const made = source.indexOf('const accounts = createAccounts({ keystore, prefs: vaultPrefs, chipStatus: chipStatusReader(vault) });');
  const used = source.indexOf("useRailAccounts(cfg.mode === 'demo' ? () => demoAccounts(intentsAccountId(cfg)) : accounts.accounts);");
  const asked = source.indexOf('void accounts.refresh();');
  assert.ok(markers > 0 && made > markers, 'the markers are queued first, so the gate hears of them before anything else');
  assert.ok(used > made && asked > used, 'installed for the rails, then asked');
  assert.ok(asked < source.indexOf('const server = createServer('), 'before any route can ask which account to spend');
});

test('the accounts read the service\'s answer through the relay: a moved vault reads chip, and the rails sign for its allowance', async () => {
  const service = new SoftwareChipService();
  const m = await mac(service, { moved: true });
  try {
    m.open();
    assert.throws(() => m.store.keys(), OwnerTouchRequired, 'the owner key is out of the session');
    const before = m.accounts.accounts();
    assert.equal(before.kind, 'broken', 'until the service has said so');
    assert.equal(before.checked, false);
    const seen = service.seen.length;
    const now = await m.accounts.refresh();
    assert.deepEqual(service.seen.slice(seen).map((r) => [r.op, r.keyRef]), [['chipStatus', m.chip!.keyRef]], 'one status read, for the key vault.json names');
    assert.equal(now.kind, 'chip');
    assert.equal(now.checked, true);
    assert.deepEqual(now.chip, m.chip);
    assert.equal(now.vault, V.vault);
    assert.equal(now.spend, V.allowance);
    assert.deepEqual(railAccounts(m.keysPath), now, 'what the rails read is what the accounts say');
    assert.equal(liveIntentsSigner.address(m.keysPath), V.allowance);
  } finally {
    await m.stop();
  }
});

test('with no service to ask, a moved vault stays broken and unchecked, never chip; with no chip in vault.json nothing is asked', async () => {
  const service = new SoftwareChipService();
  const m = await mac(service, { moved: true });
  try {
    m.open();
  } finally {
    await m.stop();
  }
  const asleep = await m.accounts.refresh();
  assert.equal(asleep.kind, 'broken', 'a relay nobody answers is no answer');
  assert.equal(asleep.checked, false);
  assert.equal(asleep.spend, V.allowance, 'and the rails still spend the allowance, never the vault');

  const fresh = new SoftwareChipService();
  const never = await mac(fresh, { marker: null });
  try {
    never.open();
    const seen = fresh.seen.length;
    const now = await never.accounts.refresh();
    assert.equal(fresh.seen.length, seen, 'nothing asked of the service');
    assert.equal(now.kind, 'key');
    assert.equal(now.spend, V.vault);
    assert.equal(liveIntentsSigner.address(never.keysPath), V.vault);
  } finally {
    await never.stop();
  }
});

// ---------- end to end, on the vault service's own stand-in ----------
// U5's stand-in (tests/unit/helpers/vault-double.ts) is main.swift, ChipOps.swift and the grammar
// compiled with the test seam: the service's real chip ops over a keychain kept in a file, its chip
// key a software P-256 key, so nothing asks for a touch. The chain is the intents double.

const USDC = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const USDT = 'nep141:usdt.tether-token.near';
const INTENT_HASH = 'GoiKQ5gPe5Ne2kT8mtL7c4qHKMjbdpMJhJ8dv1S3CYbM';
const NEAR_TX = '8yFNEk7GmRcM3NMJihwCKXt8ZANLpL2koVFWWH1MEEj';

async function standIn(t: TestContext) {
  const { VaultDouble, relayTo, swiftc } = await import('./helpers/vault-double.ts');
  if (!swiftc) {
    t.skip('needs macOS with swiftc');
    return null;
  }
  const double = new VaultDouble();
  const ops: string[] = [];
  const service: Service = {
    run(request) {
      ops.push(request.op);
      return double.run(request as unknown as Record<string, unknown>) as Answer;
    },
  };
  return { double, service, ops, relayTo };
}

const TOKENS: TokensFile = {
  eth: {},
  base: {},
  arb: {},
  sol: {},
  near: {
    USDC: { tokenId: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', decimals: 6 },
    USDT: { tokenId: 'usdt.tether-token.near', decimals: 6 },
  },
};
const LIST = [
  { assetId: USDC, decimals: 6, blockchain: 'near', symbol: 'USDC', contractAddress: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', price: 1 },
  { assetId: USDT, decimals: 6, blockchain: 'near', symbol: 'USDT', contractAddress: 'usdt.tether-token.near', price: 1 },
] as OneClickToken[];

/* 1Click's signed dry price, a dollar a coin and one out for one in: the price the relay rail
   checks the relay's quote by. */
function signedPrice(): OneClickClient {
  const units = (base: string): string => (Number(base) / 1e6).toFixed(6);
  return {
    tokens: async () => LIST,
    async quote(params: OneClickQuoteParams) {
      const quoteRequest = {
        dry: params.dry,
        swapType: 'EXACT_INPUT',
        slippageTolerance: params.slippageToleranceBps,
        originAsset: params.originAsset,
        depositType: params.depositType,
        destinationAsset: params.destinationAsset,
        amount: params.amount,
        refundTo: params.refundTo,
        refundType: params.refundType,
        recipient: params.recipient,
        recipientType: params.recipientType,
        deadline: new Date(Date.now() + 600_000).toISOString(),
        referral: 'phosphor',
      };
      const quote = { amountIn: params.amount, amountInFormatted: units(params.amount), amountInUsd: units(params.amount), minAmountIn: params.amount, amountOut: params.amount, amountOutFormatted: units(params.amount), amountOutUsd: units(params.amount), minAmountOut: params.amount, timeEstimate: 10 };
      const raw = signQuote({ quoteRequest, quote });
      return { quote: raw['quote'] as OneClickQuote, quoteRequest: raw['quoteRequest'], raw };
    },
  } as unknown as OneClickClient;
}

/* The relay swap rail, the app's own, signing with the live intents signer: the relay is faked, the
   verifier is the chain double, and a publish lands the signed diff's credit there. */
function relaySwap(keysPath: string, chain: ReturnType<typeof createIntentsDouble>) {
  const publishes: Array<{ payload: string; signature: string }> = [];
  const reads: string[] = [];
  const relay: RelayClient = {
    async quote(req) {
      const amountOut = (BigInt(req.exactAmountIn) * 980_998n) / 1_000_000n;
      return [{ quoteHash: 'Cw6dV7MV3NvKRNrXjLpymkWneBzuhTjrgEYuQLwnnCg6', assetIn: req.assetIn, assetOut: req.assetOut, amountIn: req.exactAmountIn, amountOut: amountOut.toString(), expirationTime: new Date(Date.now() + 60_000).toISOString() }];
    },
    async publishIntent(req): Promise<RelayPublishResult> {
      publishes.push(req);
      const body = JSON.parse(req.payload) as { signer_id: string; intents: { diff: Record<string, string> }[] };
      for (const [asset, amount] of Object.entries(body.intents[0]!.diff)) if (!amount.startsWith('-')) chain.fund(body.signer_id, asset, BigInt(amount));
      return { status: 'OK', intentHash: INTENT_HASH };
    },
    async status(): Promise<RelayStatus> {
      return { intentHash: INTENT_HASH, status: 'SETTLED', statusDetails: null, nearTxHash: NEAR_TX, filledAmounts: [] };
    },
  };
  const verifier: VerifierPort = {
    ...chain.verifier,
    async balance(account, asset, at) {
      reads.push(account.toLowerCase());
      return chain.verifier.balance(account, asset, at);
    },
  };
  const rail = intentsRelayRail({ keysPath, tokens: TOKENS, relay, client: signedPrice(), quoteKey: TEST_QUOTE_KEY, verifier, sleepImpl: async () => {}, settleSchedule: { firstMs: 1, maxMs: 1, timeoutMs: 50 } });
  return { rail, publishes, reads };
}

function swapDraft(from: string, amountIn: number): SwapDraft {
  return {
    kind: 'swap',
    venue: INTENTS_RELAY_VENUE,
    chain: 'near',
    toChain: 'near',
    fromSymbol: 'USDC',
    toSymbol: 'USDT',
    amountIn,
    amountInExact: String(amountIn),
    amountUsd: amountIn,
    minAmountOut: amountIn * 0.975,
    from,
    to: from,
    counterparty: INTENTS_RELAY_COUNTERPARTY,
    quote: null,
    assets: { origin: { assetId: USDC, decimals: 6 }, destination: { assetId: USDT, decimals: 6 } },
  };
}

test('end to end on the service\'s stand-in: a chip-kind swap spends from the allowance through the rails, and one over the allowance is refused before anything signs', async (t) => {
  const s = await standIn(t);
  if (s === null) return;
  const m = await mac(s.service, { moved: true });
  try {
    m.open();
    const now = await m.accounts.refresh();
    assert.equal(now.kind, 'chip', 'the service\'s own status answer says the vault moved');
    assert.equal(now.spend, V.allowance);
    m.chain.fund(V.allowance, USDC, 100_000_000n);
    m.chain.fund(V.vault, USDC, 1_850_000_000n);

    const ctx = { cfg: { keysPath: m.keysPath, mode: 'live', addresses: {} } } as unknown as PCtx;
    const problems: string[] = [];
    const from = ourIntentsAddress(ctx, problems);
    assert.deepEqual(problems, []);
    assert.equal(from, V.allowance, 'the app drafts the swap from the allowance');

    const r = relaySwap(m.keysPath, m.chain);
    const done = await r.rail.execute(swapDraft(from, 2), 'p1', {});
    assert.equal(done.ok, true, done.detail);
    assert.equal(r.publishes.length, 1);
    const { payload, signature } = r.publishes[0]!;
    const body = JSON.parse(payload) as { signer_id: string; deadline: string; nonce: string };
    assert.equal(body.signer_id, V.allowance.toLowerCase(), 'the payload spends the allowance');
    assert.equal(await signerOf(payload, signature), V.allowance, 'signed by the allowance key');
    assert.equal(decodeNonce(body.nonce)?.deadlineMs, Date.parse(body.deadline) + NONCE_LIFE_AFTER_DEADLINE_MS);
    assert.ok(r.reads.length > 0 && r.reads.every((a) => a === V.allowance.toLowerCase()), `every balance read is the allowance's: ${[...new Set(r.reads)].join(', ')}`);
    assert.throws(() => m.store.keys(), OwnerTouchRequired, 'and the owner key stayed out of it');

    // 150 USDC: the allowance holds 100, the vault 1,850. The vault is never spent around a Touch ID.
    await assert.rejects(() => r.rail.execute(swapDraft(from, 150), 'p2', {}), /holds 100 USDC, less than the 150 USDC this swap spends; nothing was signed/);
    assert.equal(r.publishes.length, 1, 'nothing more was signed or sent');
    const h = makeCtx({ rails: [r.rail] });
    const proposed = await h.svc.proposeSwap({ chain: 'near', toChain: 'near', fromSymbol: 'USDC', toSymbol: 'USDT', amountIn: '150' });
    assert.equal(proposed.status, 'policy_refused', JSON.stringify(proposed.verdict));
    assert.equal((proposed.draft as SwapDraft).from, V.allowance);
    assert.ok(proposed.verdict.reasonCodes?.includes('insufficient_balance'), JSON.stringify(proposed.verdict));
    assert.match(proposed.verdict.reasons.join(' '), /holds 100 USDC, less than the 150 this swap asks for/);
    assert.equal(r.publishes.length, 1);

    assert.deepEqual(s.double.touches(), [], 'no Touch ID anywhere: the allowance spends without one, and the vault was never asked');
    assert.ok(!s.ops.includes('signIntent'), 'the chip signed nothing');
  } finally {
    await m.stop();
  }
});

/* The owner key gate's rule (U6, accepted by the lead): a chip marker naming the vault counts only
   when the chain shows the marker's chip key OR the paper key it pins on the vault, and until the
   chain has answered the owner key stays out. Each case is a backend that ran chipCreate then
   chipCommit naming this wallet's vault through the service's own ops (no dialog), with vault.json
   left empty, and the boot src/main.ts runs; the owner touch reads the same gate. */
test('end to end on the service\'s stand-in: a marker counts only when the chain shows its chip key or its paper key on the vault, and the owner key stays out until the chain answers', async (t) => {
  const vault = V.vault.toLowerCase();

  // Planted on a vault that never moved, the chain's answer held back at first.
  const first = await standIn(t);
  if (first === null) return;
  let answer: () => void = () => {};
  const chainHeld = new Promise<void>((resolve) => (answer = resolve));
  const m = await mac(first.service, { marker: vault, chainHeld });
  try {
    useOwnerTouch(ownerTouchVia({ vault: m.relay, keystore: m.store, ownerOut: m.ownerKeyStaysOut }));
    assert.equal(m.prefs.get().chip, null, 'vault.json names no chip');
    await m.boot();
    assert.equal(m.relay.chipMarkers(V.vault).length, 1, 'the planted marker is real and the gate has read it');
    m.open();
    assert.throws(() => m.store.evmPrivateKey(), OwnerTouchRequired, 'no chain answer yet: the owner key stays out');
    assert.equal(ownerTouchRequired(), true, 'and the owner touch reads the same');
    answer();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(m.ownerKeyStaysOut(V.vault), false, 'the chain shows neither pinned key on the vault: the marker does not count');
    m.open();
    assert.equal(m.store.evmPrivateKey(), `0x${V.old}`, 'the next open holds the owner key');
    assert.equal(ownerTouchRequired(), false);
    const now = await m.accounts.refresh();
    assert.equal(now.kind, 'key', 'the vault kind does not flip');
    assert.equal(now.spend, V.vault);
    assert.equal(liveIntentsSigner.address(m.keysPath), V.vault, 'the rails sign for the vault with its own key, as before');
    assert.deepEqual(first.double.touches(), [], 'the plant took no Touch ID, which is why the chain decides');
  } finally {
    await m.stop();
  }

  // The chain shows the marker's chip key on the vault, or only the paper key it pins: either counts.
  for (const onChain of [['chip'], ['paper']] as const) {
    const s = await standIn(t);
    if (s === null) return;
    const moved = await mac(s.service, { marker: vault, onChain: [...onChain] });
    try {
      useOwnerTouch(ownerTouchVia({ vault: moved.relay, keystore: moved.store, ownerOut: moved.ownerKeyStaysOut }));
      await moved.boot();
      assert.equal(moved.ownerKeyStaysOut(V.vault), true, `the ${onChain[0]} key is on the vault: the marker counts`);
      moved.open();
      assert.throws(() => moved.store.evmPrivateKey(), OwnerTouchRequired, `${onChain[0]} on chain: the owner key stays out`);
      assert.equal(ownerTouchRequired(), true);
      moved.chain.faults.reads = true;
      assert.equal(moved.ownerKeyStaysOut(V.vault), true, 'and once the chain said moved, that is for good');
    } finally {
      await moved.stop();
    }
  }
});

test('end to end on the service\'s stand-in: the relay a demo backend builds answers every chip write itself, and the service never hears of one', async (t) => {
  const s = await standIn(t);
  if (s === null) return;
  // src/main.ts makes keys only for a live backend, or for a harness that says PHOSPHOR_DEMO_ENCLAVE=1.
  assert.ok(main().includes("makesKeys: cfg.mode === 'live' || process.env.PHOSPHOR_DEMO_ENCLAVE === '1',"));
  const demo = createVaultRelay({ transportKey: crypto.randomBytes(32), makesKeys: false });
  const shell = serve(demo, s.service);
  const vault = V.vault.toLowerCase();
  const recovery = secpKey(generatePrivateKey());
  try {
    const writes = [
      await createChip(demo),
      await commitChip(demo, { keyRef: KEY_REF, account: vault, allowance: V.allowance.toLowerCase(), recovery }),
      await sweepChips(demo),
    ];
    assert.deepEqual(writes.map((w) => (w.ok ? 'ok' : w.code)), ['no_keychain_home', 'no_keychain_home', 'no_keychain_home']);
    assert.deepEqual(s.ops, [], 'not one of them reached the service');

    // Reads and the Touch ID pass on, as a demo passes unwrap: the service answers them by its own rules.
    const status = await demo.ask({ op: 'chipStatus' });
    assert.ok(status.ok && status.op === 'chipStatus' && status.status.chips.length === 0, JSON.stringify(status));
    const payload = buildVaultPayload({ signerId: vault, intents: [], deadlineMs: Date.now() + CHIP_PAYLOAD_LIFE_MS, salt: SALT });
    const signed = await demo.ask({ op: 'signIntent', keyRef: KEY_REF, payload });
    assert.ok(!signed.ok && signed.error === 'not_committed', JSON.stringify(signed));
    assert.deepEqual(s.ops, ['chipStatus', 'signIntent']);
    assert.deepEqual(s.double.touches(), []);
  } finally {
    await shell.stop();
    demo.stop();
  }

  // The same create through a live relay reaches the same service and makes a key: the refusal
  // above is the demo relay's, not the service's.
  const live = createVaultRelay({ transportKey: crypto.randomBytes(32), makesKeys: true });
  const liveShell = serve(live, s.service);
  try {
    const made = await createChip(live);
    assert.ok(made.ok, JSON.stringify(made));
    assert.deepEqual(s.ops.slice(-1), ['chipCreate']);
  } finally {
    await liveShell.stop();
    live.stop();
  }
});

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

/* The real backend (src/main.ts) in its own process, in demo mode as an installed app runs it
   (PHOSPHOR_DEMO_ENCLAVE unset, so it makes no keys), on a scratch data dir and a fake home, with
   the handshake the shell gives it. vault.json names a chip the service holds, as a finished rekey
   leaves them. The first three things the backend asks the shell, in this order, are the probe,
   every chip marker (for the owner key gate) and the status of the chip vault.json names (for the
   accounts); everything it asks at start is a read, and it asks for no chip write. */
test('end to end, the real backend in demo mode: at start it asks the service only to read, the probe, the markers, then the chip vault.json names', { timeout: 60_000 }, async (t) => {
  const s = await standIn(t);
  if (s === null) return;
  const dir = tempDir('phosphor-chip-boot-');
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  const vault = V.vault.toLowerCase();
  const made = s.double.run({ id: 'plant-create', op: 'chipCreate' }) as Answer & { keyRef: string; publicKey: string };
  assert.ok(made.ok, JSON.stringify(made));
  assert.ok(s.double.run({ id: 'plant-commit', op: 'chipCommit', keyRef: made.keyRef, account: vault, allowance: V.allowance.toLowerCase(), recovery: secpKey(generatePrivateKey()) }).ok);
  createVaultPrefs(path.join(dir, 'state')).setChip({ keyRef: made.keyRef, publicKey: made.publicKey, account: V.vault });

  const port = await freePort();
  assert.notEqual(port, 4177);
  const base = `http://127.0.0.1:${port}`;
  fs.writeFileSync(path.join(dir, 'config.local.json'), JSON.stringify({ port, mode: 'demo' }));
  const [token, nonce, seat, transport, relaySecret] = Array.from({ length: 5 }, () => crypto.randomBytes(32).toString('hex'));
  const child = spawn(process.execPath, ['src/main.ts'], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      CFFIXED_USER_HOME: home,
      TMPDIR: process.env.TMPDIR ?? '',
      PHOSPHOR_DATA_DIR: path.join(dir, 'state'),
      PHOSPHOR_CONFIG_DIR: dir,
      PHOSPHOR_APP_DATA: '1',
      PHOSPHOR_KEYS: path.join(dir, 'keys', 'keys.json'),
      PHOSPHOR_PORT: String(port),
      ACC_MODE: 'demo',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const output: string[] = [];
  child.stdout!.on('data', (d: Buffer) => output.push(d.toString()));
  child.stderr!.on('data', (d: Buffer) => output.push(d.toString()));
  child.stdin!.write(`${token}\n${nonce}\n${seat}\n${transport}\n${relaySecret}\n`);
  child.stdin!.end();
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const send = async (route: string, body: Record<string, unknown>) => {
    const challenge = crypto.randomBytes(32).toString('hex');
    const res = await fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, 'x-phosphor-challenge': challenge }, body: JSON.stringify(body) });
    assert.equal(res.headers.get('x-phosphor')?.toLowerCase(), identityProof(nonce, challenge), 'this boot answered');
    return { status: res.status, json: (await res.json().catch(() => null)) as any };
  };
  let shell: { seen: Array<{ op: string; keyRef?: unknown }>; stop(): Promise<void> } | null = null;
  try {
    const up = Date.now() + 30_000;
    for (;;) {
      try {
        if ((await fetch(`${base}/api/health`)).ok) break;
      } catch {
        // not yet
      }
      assert.ok(Date.now() < up, `the backend did not come up: ${output.join('').slice(-600)}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    shell = s.relayTo((route, body) => send(route, { relay: relaySecret, ...body }), s.double, Buffer.from(transport, 'hex'));
    const asked = Date.now() + 10_000;
    while (shell.seen.length < 3 && Date.now() < asked) await new Promise((resolve) => setTimeout(resolve, 50));
    // A moment more, for anything else it would ask on its own.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    assert.deepEqual(
      shell.seen.slice(0, 3).map((r) => [r.op, r.keyRef ?? null]),
      [['probe', null], ['chipStatus', null], ['chipStatus', made.keyRef]],
      output.join('').slice(-600),
    );
    // Whatever else start-up asks (1b's settle reads the wallet's status after the probe) is a read too.
    const ops = shell.seen.map((r) => r.op);
    assert.deepEqual(ops.filter((op) => !['probe', 'chipStatus', 'status'].includes(op)), [], ops.join(', '));
    assert.equal((await fetch(`${base}/api/health`)).status, 200, 'and it serves');
    const after = s.double.run({ id: 'census', op: 'chipStatus' }) as Answer & { chips: unknown[] };
    assert.equal(after.chips.length, 1, 'the service holds the one chip it held, and nothing more');
  } finally {
    child.kill('SIGTERM');
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 4_000))]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    await shell?.stop();
  }
});

/* The one gate has a state vault.json's word never had: a marker whose chain read is not back yet
   counts as moved. A session opened before the marker was known still holds the owner key, and the
   keystore lets go of it only at its next ask. A withdrawal approved in that moment skips its
   approval touch; if the chain then answers that the vault never moved, the key the session held
   would sign the send with no Touch ID at all. So the click that skips the touch also takes the
   key out of the session (src/proposals/lifecycle.ts approve), and the send asks its own. */
test('a gate that closes on a session still holding the owner key: the approved withdrawal still signs behind its own Touch ID once the chain says the vault never moved', async () => {
  const v = chipVault(V.old, { moved: false });
  await v.attach();
  const dir = tempDir('phosphor-chip-wiring-');
  fs.mkdirSync(path.join(dir, 'state'));
  const prefs = createVaultPrefs(path.join(dir, 'state'));
  let answerChain: (moved: boolean) => void = () => {};
  const chainRead = new Promise<boolean>((resolve) => (answerChain = resolve));
  const gate = ownerKeyGate(() => prefs.get(), v.relay, { hasPublicKey: () => chainRead });
  v.store.keepOwnerKeyOutWhen(gate);
  useOwnerTouch(ownerTouchVia({ vault: v.relay, keystore: v.store, ownerOut: gate }));
  v.open();
  assert.equal(v.store.evmPrivateKey(), `0x${V.old}`, 'a kind key wallet, open, its owner key in the session');

  // While it is open the service's status names a chip marker for this vault: a rekey that stopped
  // after its commit, say. The chain has not answered yet.
  const read = v.relay.ask({ op: 'chipStatus' });
  const request = await v.relay.next(1_000);
  assert.ok(request !== null);
  const marker = { account: v.vault.toLowerCase(), allowance: V.allowance.toLowerCase(), recovery: PAPER, at: '2026-10-04T12:00:00.000Z' };
  v.relay.answer({ id: request.id, ok: true, keychainHome: true, chips: [{ keyRef: KEY_REF, publicKey: chipPublicKey(), fresh: false, marker }] });
  assert.ok((await read).ok);
  assert.equal(ownerTouchRequired(), true, 'out while the chain is asked');

  // The rail waits until the chain has answered, so the order is fixed.
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  const world = withdrawWorld(v.keysPath);
  const rail = { ...world.rail, execute: async (...args: Parameters<typeof world.rail.execute>) => (await held, world.rail.execute(...args)) };
  const h = makeCtx({ rails: [rail], deps: { vault: v.relay, keystore: v.store } });
  const proposed = await h.svc.proposeHlWithdraw({ amount: 8 });
  assert.equal(proposed.status, 'pending');
  const clicked = await h.svc.approve(proposed.id);
  assert.notEqual(clicked.status, 'awaiting_touch', 'the click skipped the approval touch');

  answerChain(false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gate(v.vault), false, 'the chain says the vault never moved');
  assert.throws(() => v.store.evmPrivateKey(), OwnerTouchRequired, 'and the key the session held is gone all the same');

  release();
  const asked = await v.shell.answer();
  assert.equal(asked.reason, 'Send 8.00 USDC from your Hyperliquid account to 0xaf4fda38...3184d954');
  const done = await h.svc.settled(proposed.id, 5_000);
  assert.equal(done.status, 'executed', done.result?.detail ?? '');
  assert.equal(v.shell.asked.length, 1, 'one Touch ID, the send\'s, never none');
  assert.equal(world.posts.length, 1);
});
