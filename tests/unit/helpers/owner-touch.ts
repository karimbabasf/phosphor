// A vault that moved to the chip, for the owner touch tests (PHASE2-PLAN.md P2.8).
//
// Real parts wherever a key is involved: the keystore holds a published test key as its owner key
// in an enclave-wrapped file, its gate keeps that key out of the session, the relay is the app's
// own with the shell played by hand, and the touch is installed the way src/main.ts installs it. A
// software P-256 key plays the enclave, as in keystore-enclave.test.ts: no dialog, no Secure
// Enclave, nothing signed for real money. Temp directories throughout.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';

import type { OneClickClient, OneClickQuote, OneClickQuoteParams, OneClickStatus } from '../../../src/intents.ts';
import { createKeystore, useKeystore } from '../../../src/keystore/index.ts';
import { seUnwrapWithSoftwareKey } from '../../../src/keystore/sewrap.ts';
import type { EnclaveRef, Keystore } from '../../../src/keystore/store.ts';
import { ownerTouchVia } from '../../../src/proposals/lifecycle.ts';
import { useOwnerTouch } from '../../../src/rails/hl-user-signed.ts';
import { HYPERCORE_ORIGIN_ASSET_ID, HL_WITHDRAW_SLIPPAGE_BPS, INTENTS_USDC_ASSET_ID, hypercoreWithdrawRail } from '../../../src/rails/hypercore-withdraw.ts';
import type { HypercoreWithdrawRail } from '../../../src/rails/hypercore-withdraw.ts';
import { createVaultRelay } from '../../../src/vault/relay.ts';
import type { VaultRelay, VaultRequest } from '../../../src/vault/relay.ts';
import { TEST_QUOTE_KEY, signQuote } from './signed-quote.ts';
import { tempDir } from './tmp.ts';

const FAST_KDF = () => ({ name: 'scrypt' as const, N: 2 ** 14, r: 8, p: 1, salt: crypto.randomBytes(16).toString('hex') });

export type Shell = {
  // The next request off the relay, answered the way the sidecar answers it, or as a person
  // pressing Cancel.
  answer(opts?: { cancel?: boolean }): Promise<VaultRequest>;
  // Every request this shell took, in order.
  asked: VaultRequest[];
};

export type ChipVault = {
  store: Keystore;
  keysPath: string;
  relay: VaultRelay;
  shell: Shell;
  // The wallet's own 0x address, as the header names it: VAULT, and the Hyperliquid account.
  vault: string;
  // The relay counts as attached once the shell has polled: what enclaveGated reads.
  attach(): Promise<void>;
  // Opens the wallet the way an unlock does, through the enclave stand-in.
  open(): void;
};

/* `moved: false` is a kind key wallet in the same file. `keystore` hands the touch a wrapped
   keystore, so a test can watch what withOwnerKey lends. */
export function chipVault(old: string, opts: { moved?: boolean; keystore?: (store: Keystore) => Keystore } = {}): ChipVault {
  const keysPath = path.join(tempDir('phosphor-owner-touch-'), 'keys.json');
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = pair.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const x963 = Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  const ref: EnclaveRef = { keyBlob: crypto.randomBytes(64).toString('base64'), publicKey: x963.toString('base64'), createdAt: new Date().toISOString() };

  const store = createKeystore({ keysPath, kdf: FAST_KDF });
  store.importWithEnclave(ref, { keys: { evm: `0x${old}` } });
  store.lock();
  const vault = store.addresses().evm;
  assert.ok(vault !== null);
  const moved = opts.moved ?? true;
  const ownerOut = (v: string): boolean => moved && v.toLowerCase() === vault.toLowerCase();
  store.keepOwnerKeyOutWhen(ownerOut);
  useKeystore(store);

  const transport = crypto.randomBytes(32);
  const relay = createVaultRelay({ transportKey: transport });
  useOwnerTouch(ownerTouchVia({ vault: relay, keystore: opts.keystore?.(store) ?? store, ownerOut }));

  const unwrap = (request: { ephemeralPublicKey?: string; ciphertext?: string; aad?: string }): Buffer =>
    seUnwrapWithSoftwareKey({ ephemeralPublicKey: request.ephemeralPublicKey!, ciphertext: request.ciphertext! }, pair.privateKey, Buffer.from(request.aad!, 'base64'));

  const asked: VaultRequest[] = [];
  const shell: Shell = {
    asked,
    async answer(o = {}) {
      const request = await relay.next(5_000);
      assert.ok(request !== null, 'a Touch ID was asked for');
      asked.push(request);
      assert.equal(request.op, 'unwrap');
      if (o.cancel === true) {
        relay.answer({ id: request.id, ok: false, error: 'user_cancel', message: 'cancelled' });
        return request;
      }
      // Sealed under the transport key with the request id as AAD, as the sidecar seals it.
      const dek = unwrap(request);
      const nonce = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', transport, nonce);
      cipher.setAAD(Buffer.from(request.id, 'utf8'));
      const sealed = Buffer.concat([nonce, cipher.update(dek), cipher.final(), cipher.getAuthTag()]).toString('base64');
      dek.fill(0);
      relay.answer({ id: request.id, ok: true, dekSealed: sealed });
      return request;
    },
  };

  return {
    store,
    keysPath,
    relay,
    shell,
    vault,
    async attach() {
      assert.equal(await relay.next(0), null);
      assert.equal(relay.attached(), true);
    },
    open() {
      const request = store.enclaveRequest();
      assert.ok(request !== null);
      assert.deepEqual(store.unlockWithDataKey(unwrap(request)), { ok: true });
    },
  };
}

export function teardown(): void {
  useOwnerTouch(null);
  useKeystore(null);
}

// What 1Click mints for a withdrawal: fresh and checksummed.
export const MINTED = '0xaf4FDa3876a32301839734891C337dA23184d954';

export type WithdrawWorld = {
  rail: HypercoreWithdrawRail;
  // Every quote asked for, and every account whose intents balance was read.
  quotes: OneClickQuoteParams[];
  intentsReads: string[];
  // Every body posted to the venue's /exchange.
  posts: Array<Record<string, any>>;
};

/* The Hyperliquid exit with every remote faked and the live HL signer, so the send goes through the
   owner touch: 1Click signs its quotes with the test key and echoes back what was asked, then says
   SUCCESS; the venue is a unified account with 20 USDC free that has never seen the minted address;
   the verifier's balance rises past the floor after the send. 8 USDC in, 7.780248 out, as measured
   live on 2026-09-11. */
export function withdrawWorld(keysPath: string): WithdrawWorld {
  const quotes: OneClickQuoteParams[] = [];
  const intentsReads: string[] = [];
  const posts: Array<Record<string, any>> = [];
  const quote: OneClickQuote = {
    depositAddress: MINTED,
    amountIn: '800000000',
    amountInFormatted: '8.0',
    amountInUsd: '8.0',
    minAmountIn: '800000000',
    amountOut: '7780248',
    amountOutFormatted: '7.780248',
    amountOutUsd: '7.780248',
    minAmountOut: '7772468',
    timeEstimate: 35,
    refundFee: '31530000',
    withdrawFee: '0',
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
      // The echo is what was asked, as 1Click returns it; the rail compares it with the draft.
      const echo = {
        dry: params.dry,
        swapType: 'EXACT_INPUT',
        slippageTolerance: HL_WITHDRAW_SLIPPAGE_BPS,
        originAsset: params.originAsset,
        destinationAsset: params.destinationAsset,
        amount: params.amount,
        depositType: params.depositType,
        refundTo: params.refundTo,
        refundType: params.refundType,
        recipient: params.recipient,
        recipientType: params.recipientType,
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
    keysPath,
    client,
    hl: { keysPath, fetchImpl, now: () => 1786600000000 },
    intentsBalance: async (accountId) => {
      intentsReads.push(accountId);
      reads += 1;
      return reads === 1 ? 0n : 7_780_248n;
    },
    fetchImpl,
    now: () => 1786600000000,
    sleep: async () => {},
    pollIntervalMs: 1,
    pollTimeoutMs: 3,
    quoteKey: TEST_QUOTE_KEY,
    settleSchedule: { firstMs: 1, maxMs: 1, timeoutMs: 3 },
  });
  return { rail, quotes, intentsReads, posts };
}
