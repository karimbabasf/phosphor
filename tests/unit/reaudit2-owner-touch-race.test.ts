// reaudit2 RA2-01: a second withdrawal built on a forged wallet header never signs after the first
// owner touch decrypted the wallet. AU2-02's check reads "the address the move was built for" as
// keystore.addresses() at the moment ownerTouchVia.sign is called, not at the moment the rail
// built the move. Any owner touch on a forged header decrypts the payload (openWithDataKey sets
// openAddresses to the true address), so addresses() flips from the forger's X to VAULT for the
// rest of the process. A second hl_withdraw whose rail read its owner (X) and asked 1Click for a
// quote crediting X BEFORE that flip, and that reaches sign() AFTER it, would compare VAULT with
// VAULT and sign: Hyperliquid debits VAULT, 1Click credits X. The decrypt also marks the header
// tampered (addressReport), and an owner touch on a tampered header signs nothing.
//
// Same planted files as tests/unit/audit2-gate-header-skip.test.ts. The only difference: two rows,
// and the second row's 1Click quote answers after the first row's touch (network latency, played
// here by a gate on the fake 1Click).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { recoverTypedDataAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import type { OneClickClient, OneClickQuote, OneClickQuoteParams, OneClickStatus } from '../../src/intents.ts';
import { createKeystore, useKeystore } from '../../src/keystore/index.ts';
import { keystorePathFor } from '../../src/keystore/store.ts';
import { ownerTouchVia } from '../../src/proposals/lifecycle.ts';
import { buildSendAssetPayload, ownerTouchRequired, useOwnerTouch } from '../../src/rails/hl-user-signed.ts';
import type { HlSignature } from '../../src/rails/hl-user-signed.ts';
import { HYPERCORE_ORIGIN_ASSET_ID, HL_WITHDRAW_SLIPPAGE_BPS, INTENTS_USDC_ASSET_ID, hypercoreWithdrawRail } from '../../src/rails/hypercore-withdraw.ts';
import { ownerKeyGate } from '../../src/vault/chip.ts';
import { createVaultPrefs } from '../../src/vault/prefs.ts';
import { DERIVED_VECTORS } from '../fixtures/derived-keys.ts';
import { MINTED, chipVault, teardown } from './helpers/owner-touch.ts';
import { makeCtx } from './helpers/proposals.ts';
import { TEST_QUOTE_KEY, signQuote } from './helpers/signed-quote.ts';
import { tempDir } from './helpers/tmp.ts';

const [V] = DERIVED_VECTORS;
const ATTACKER = privateKeyToAccount(generatePrivateKey()).address;

test.afterEach(teardown);

// tests/unit/helpers/owner-touch.ts withdrawWorld, with the second quote held until `release()`.
function slowSecondQuoteWorld(keysPath: string) {
  const quotes: OneClickQuoteParams[] = [];
  const posts: Array<Record<string, any>> = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let secondAsked!: () => void;
  const asked = new Promise<void>((resolve) => (secondAsked = resolve));
  const quote: OneClickQuote = {
    depositAddress: MINTED, amountIn: '800000000', amountInFormatted: '8.0', amountInUsd: '8.0', minAmountIn: '800000000',
    amountOut: '7780248', amountOutFormatted: '7.780248', amountOutUsd: '7.780248', minAmountOut: '7772468', timeEstimate: 35,
    refundFee: '31530000', withdrawFee: '0',
  };
  const client: OneClickClient = {
    async tokens() {
      return [
        { assetId: HYPERCORE_ORIGIN_ASSET_ID, decimals: 8, blockchain: 'hypercore', symbol: 'USDC' },
        { assetId: INTENTS_USDC_ASSET_ID, decimals: 6, blockchain: 'near', symbol: 'USDC' },
      ];
    },
    async quote(params) {
      quotes.push(params);
      // Each propose asks a dry quote; the gate holds the second real one (R2's execution).
      if (params.dry === false && quotes.filter((q) => q.dry === false).length === 2) {
        secondAsked();
        await gate;
      }
      const echo = {
        dry: params.dry, swapType: 'EXACT_INPUT', slippageTolerance: HL_WITHDRAW_SLIPPAGE_BPS, originAsset: params.originAsset,
        destinationAsset: params.destinationAsset, amount: params.amount, depositType: params.depositType, refundTo: params.refundTo,
        refundType: params.refundType, recipient: params.recipient, recipientType: params.recipientType,
      };
      const raw = signQuote({ quote, quoteRequest: echo });
      return { quote: raw['quote'] as OneClickQuote, raw };
    },
    async submitDeposit() {
      return { ok: true, detail: '' };
    },
    async status() {
      return { found: true, status: 'SUCCESS', reported: 'SUCCESS', originTxHashes: [], destinationTxHashes: ['0xdest'], nearTxHashes: [] } as OneClickStatus;
    },
  };
  const fetchImpl: typeof fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, any>;
    const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
    if (String(url).endsWith('/exchange')) {
      posts.push(body);
      return json({ status: 'ok', response: { type: 'default' } });
    }
    if (body.type === 'userRole') return json({ role: 'missing' });
    if (body.type === 'userAbstraction') return json('unifiedAccount');
    if (body.type === 'userNonFundingLedgerUpdates') return json([]);
    if (body.type === 'clearinghouseState') return json({ marginSummary: { accountValue: '0', totalMarginUsed: '0' }, withdrawable: '0.0', assetPositions: [] });
    return json({ balances: [{ coin: 'USDC', token: 0, total: '20', hold: '0' }], tokenToAvailableAfterMaintenance: [[0, '20']] });
  };
  let reads = 0;
  const rail = hypercoreWithdrawRail({
    keysPath, client, hl: { keysPath, fetchImpl, now: () => 1786600000000 },
    intentsBalance: async () => {
      reads += 1;
      return reads <= 2 ? 0n : 7_780_248n;
    },
    fetchImpl, now: () => 1786600000000, sleep: async () => {}, pollIntervalMs: 1, pollTimeoutMs: 3, quoteKey: TEST_QUOTE_KEY,
    settleSchedule: { firstMs: 1, maxMs: 1, timeoutMs: 3 },
  });
  return { rail, quotes, posts, release, asked };
}

test('RA2-01: a second withdrawal built on the forged header before the first touch decrypted must not sign after it', async () => {
  const v = chipVault(V.old);
  await v.attach();
  const VAULT = v.vault;

  const file = keystorePathFor(v.keysPath);
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  stored.header.addresses.evm = ATTACKER;
  fs.writeFileSync(file, JSON.stringify(stored));
  const dataDir = tempDir('phosphor-reaudit2-race-');
  fs.writeFileSync(path.join(dataDir, 'vault.json'), JSON.stringify({ backedUp: true, chip: {} }));
  const prefs = createVaultPrefs(dataDir);

  const store = createKeystore({ keysPath: v.keysPath });
  const gate = ownerKeyGate(() => prefs.get(), v.relay, { hasPublicKey: async () => false });
  store.keepOwnerKeyOutWhen(gate);
  useKeystore(store);
  useOwnerTouch(ownerTouchVia({ vault: v.relay, keystore: store, ownerOut: gate }));
  assert.equal(store.addresses().evm, ATTACKER, 'precondition: the unverified header names the forger');
  assert.equal(ownerTouchRequired(), true, 'precondition: the gate reads "out"');

  const world = slowSecondQuoteWorld(v.keysPath);
  const h = makeCtx({ rails: [world.rail], deps: { vault: v.relay, keystore: store } });
  const r1 = await h.svc.proposeHlWithdraw({ amount: 8 });
  const r2 = await h.svc.proposeHlWithdraw({ amount: 8 });
  assert.equal(r1.status, 'pending');
  assert.equal(r2.status, 'pending');
  await h.svc.approve(r1.id);
  await h.svc.approve(r2.id);
  await world.asked; // R2 has read its owner (X) and asked 1Click for a quote crediting X.

  const first = await v.shell.answer(); // the person touches R1's dialog
  const one = await h.svc.settled(r1.id, 5_000);
  console.log(`R1: ${one.status} "${(one as { result?: { detail?: string } }).result?.detail ?? ''}" dialog "${first.reason ?? ''}"`);
  console.log(`after R1's touch the keystore serves ${store.addresses().evm?.toLowerCase()} (vault ${VAULT.toLowerCase()})`);

  world.release(); // R2's quote answers now
  let second = '';
  try {
    second = (await v.shell.answer()).reason ?? ''; // the person touches R2's dialog
  } catch {
    // no second touch asked: the secure outcome
  }
  const two = await h.svc.settled(r2.id, 5_000);

  let signer = '';
  if (world.posts.length > 0) {
    const post = world.posts[0] as { action: { destination: string; amount: string; nonce: number }; signature: HlSignature };
    const { typedData } = buildSendAssetPayload(post.action);
    signer = (
      await recoverTypedDataAddress({
        domain: typedData.domain, types: typedData.types as never, primaryType: typedData.primaryType as never,
        message: typedData.message as never, signature: { r: post.signature.r, s: post.signature.s, yParity: post.signature.v - 27 },
      } as never)
    ).toLowerCase();
  }
  console.log(JSON.stringify({ r2: two.status, dialog2: second, quoteRecipients: world.quotes.filter((q) => q.dry === false).map((q) => q.recipient), attacker: ATTACKER.toLowerCase(), venueDebits: signer, posts: world.posts.length }));
  assert.equal(world.posts.length, 0, `owner key signed a sendAsset debiting ${signer} for a quote crediting ${world.quotes.filter((q) => q.dry === false)[1]?.recipient}`);
});
