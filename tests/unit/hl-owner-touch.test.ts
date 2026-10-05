// The owner key on a vault that moved to the chip (PHASE2-PLAN.md P2.8): every Hyperliquid owner
// action (sendAsset, usdClassTransfer, approveAgent) is one unwrap, one Touch ID and one
// signature, the dialog names the action and the amount, and the key is zeroed once the signature
// is made. Nothing stays open, so a second action asks again.
//
// The keystore, the relay, withOwnerKey and the signatures are real; a software P-256 key plays the
// enclave and the test plays the shell (tests/unit/helpers/owner-touch.ts). The venue is a fake:
// nothing is sent anywhere, and the owner keys are the published test keys in
// tests/fixtures/derived-keys.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashTypedData, recoverTypedDataAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { OwnerTouchRequired } from '../../src/keystore/store.ts';
import type { Keystore } from '../../src/keystore/store.ts';
import { ReasonError, reasonOf } from '../../src/rails/reasons.ts';
import {
  OwnerTouchRefused,
  buildApproveAgentPayload,
  buildSendAssetPayload,
  buildUsdClassTransferPayload,
  liveSignPort,
  ownerTouchRequired,
  sendAsset,
  usdClassTransfer,
} from '../../src/rails/hl-user-signed.ts';
import type { HlSendAssetAction, HlSignature, HlTypedData, HlUserSignedDeps } from '../../src/rails/hl-user-signed.ts';
import { ownerReason } from '../../src/vault/reason.ts';
import { DERIVED_VECTORS } from '../fixtures/derived-keys.ts';
import { chipVault, teardown } from './helpers/owner-touch.ts';

// SDK's owner key is the hyperliquid-python-sdk's own signing fixture, so the vectors below are the
// SDK's; V's is the canonical Ethereum documentation key.
const [V, SDK] = DERIVED_VECTORS;
const FIXTURE_DEST = '0x5e9ee1089755c3435139848e47e6635505d5a13a';
const FIXTURE_TIME = 1687816341423;
const SDK_SEND_VECTOR: HlSignature = {
  r: '0xfe1a043dc1f5b7e5bd361b397a615f8f791a317cf2d7c28e483746020cf2dd04',
  s: '0x3dbf449f1d7dc7c819e04c8f88e30edc762abbc69351d278e851c2b7c1fd9d39',
  v: 28,
};
const FRESH = '0xaf4FDa3876a32301839734891C337dA23184d954'; // the shape 1Click mints
const NOW = 1786600000000;

test.afterEach(teardown);

async function signerOf(typed: HlTypedData, sig: HlSignature): Promise<string> {
  const address = await recoverTypedDataAddress({
    domain: typed.domain,
    types: typed.types as never,
    primaryType: typed.primaryType as never,
    message: typed.message as never,
    signature: { r: sig.r, s: sig.s, yParity: sig.v - 27 },
  } as never);
  return address.toLowerCase();
}

// The signer of a posted sendAsset, rebuilt from the posted action alone.
function signerOfPost(post: { action: HlSendAssetAction; signature: HlSignature }): Promise<string> {
  const { typedData } = buildSendAssetPayload({ destination: post.action.destination, amount: post.action.amount, nonce: post.action.nonce });
  return signerOf(typedData, post.signature);
}

// Hyperliquid /info and /exchange: a unified account with 100 USDC free, or a standard one with 50
// on the perp side. `throwsOnce`: the first post gets no reply.
function venue(over: { standard?: boolean; throwsOnce?: boolean } = {}): { fetchImpl: typeof fetch; posts: Array<Record<string, any>> } {
  const posts: Array<Record<string, any>> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, any>;
    const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
    if (String(url).endsWith('/exchange')) {
      posts.push(body);
      if (over.throwsOnce === true && posts.length === 1) throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
      return json({ status: 'ok', response: { type: 'default' } });
    }
    if (body.type === 'userRole') return json({ role: 'user' });
    if (body.type === 'userAbstraction') return json(over.standard === true ? 'standard' : 'unifiedAccount');
    if (body.type === 'clearinghouseState') {
      const perp = over.standard === true ? '50' : '0.0';
      return json({ marginSummary: { accountValue: perp, totalMarginUsed: '0' }, withdrawable: perp, assetPositions: [] });
    }
    return json({ balances: [{ coin: 'USDC', token: 0, total: '100', hold: '0' }], ...(over.standard === true ? {} : { tokenToAvailableAfterMaintenance: [[0, '100']] }) });
  };
  return { fetchImpl, posts };
}

// The keystore as the touch sees it, with every key withOwnerKey lends kept for the test to read back.
function lending(lent: Buffer[]): (store: Keystore) => Keystore {
  return (store) => ({
    ...store,
    withOwnerKey: <T,>(dek: Buffer, fn: (key: Buffer) => T) =>
      store.withOwnerKey(dek, (key) => {
        lent.push(key);
        return fn(key);
      }),
  });
}

test('kind chip: an owner signature is one Touch ID that names it, and it signs the SDK vector unchanged', async () => {
  const v = chipVault(SDK.old);
  assert.equal(ownerTouchRequired(), true);
  assert.throws(() => v.store.evmPrivateKey(), OwnerTouchRequired, 'the session holds no owner key');

  const { typedData } = buildSendAssetPayload({ destination: FIXTURE_DEST, amount: '1', nonce: FIXTURE_TIME });
  const signing = liveSignPort.signTypedData(v.keysPath, typedData);
  const asked = await v.shell.answer();
  assert.equal(asked.reason, 'Send 1.00 USDC from your Hyperliquid account to 0x5e9ee108...05d5a13a');
  const signature = await signing;

  assert.deepEqual(signature, SDK_SEND_VECTOR, 'the same bytes the SDK signs, through the touch');
  assert.equal(await signerOf(typedData, signature), SDK.vault.toLowerCase());
  assert.equal(v.shell.asked.length, 1);
  assert.equal(v.relay.queued(), 0, 'one ask, answered, and nothing else waiting');
  assert.equal(v.store.state(), 'locked', 'the touch opened nothing: the lock is as it was');
  assert.throws(() => v.store.evmPrivateKey(), OwnerTouchRequired, 'and the session still holds no owner key');
});

test('the key lent for the signature is zeroed once the signature is made, and nothing is kept for the next one', async () => {
  const lent: Buffer[] = [];
  const v = chipVault(SDK.old, { keystore: lending(lent) });
  const { typedData } = buildSendAssetPayload({ destination: FIXTURE_DEST, amount: '1', nonce: FIXTURE_TIME });

  const first = liveSignPort.signTypedData(v.keysPath, typedData);
  await v.shell.answer();
  assert.deepEqual(await first, SDK_SEND_VECTOR);
  assert.equal(lent.length, 1);
  assert.equal(lent[0].length, 32);
  assert.ok(lent[0].every((b) => b === 0), 'the 32 bytes withOwnerKey lent read back as zero');

  // The very same action again is a second ask and a second loan: no session, no reuse.
  const second = liveSignPort.signTypedData(v.keysPath, typedData);
  await v.shell.answer();
  assert.deepEqual(await second, SDK_SEND_VECTOR);
  assert.equal(v.shell.asked.length, 2);
  assert.notEqual(v.shell.asked[0].id, v.shell.asked[1].id);
  assert.equal(lent.length, 2);
  assert.notEqual(lent[0], lent[1], 'a fresh buffer each time');
  assert.ok(lent[1].every((b) => b === 0));
});

test('two sends are two Touch IDs and two signatures, each dialog naming its own amount', async () => {
  const v = chipVault(V.old);
  const net = venue();
  let clock = NOW;
  const deps: HlUserSignedDeps = { keysPath: v.keysPath, fetchImpl: net.fetchImpl, now: () => clock++ };

  const sending = sendAsset(deps, { destination: FRESH, amount: 25 });
  const a = await v.shell.answer();
  const one = await sending;
  const sendingAgain = sendAsset(deps, { destination: FRESH, amount: 30.5 });
  const b = await v.shell.answer();
  const two = await sendingAgain;

  assert.equal(one.ok, true, one.detail);
  assert.equal(two.ok, true, two.detail);
  assert.equal(a.reason, 'Send 25.00 USDC from your Hyperliquid account to 0xaf4fda38...3184d954');
  assert.equal(b.reason, 'Send 30.50 USDC from your Hyperliquid account to 0xaf4fda38...3184d954');
  assert.equal(v.shell.asked.length, 2, '2 asks');
  assert.equal(net.posts.length, 2, '2 signatures posted');
  assert.notEqual(net.posts[0].nonce, net.posts[1].nonce);
  assert.notDeepEqual(net.posts[0].signature, net.posts[1].signature);
  for (const post of net.posts) assert.equal(await signerOfPost(post as never), V.vault.toLowerCase(), 'signed by the owner key, for the vault');
});

test('a move between the books and a trading key approval are one Touch ID each, and each names itself', async () => {
  const v = chipVault(V.old);
  const net = venue({ standard: true });
  const moved = usdClassTransfer({ keysPath: v.keysPath, fetchImpl: net.fetchImpl, now: () => NOW }, { amount: 4.5, toPerp: false });
  const asked = await v.shell.answer();
  const out = await moved;
  assert.equal(out.ok, true, out.detail);
  assert.equal(asked.reason, 'Move 4.50 USDC from perp to spot in your Hyperliquid account');
  const posted = net.posts[0] as { action: { amount: string; toPerp: boolean; nonce: number }; signature: HlSignature };
  assert.equal(await signerOf(buildUsdClassTransferPayload(posted.action).typedData, posted.signature), V.vault.toLowerCase());

  const agent = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
  const { typedData } = buildApproveAgentPayload({ agentAddress: agent, agentName: 'phosphor-runner', nonce: NOW });
  const approving = liveSignPort.signTypedData(v.keysPath, typedData);
  const second = await v.shell.answer();
  assert.equal(second.reason, `Let 0x${agent.slice(2, 10)}...${agent.slice(-8)} trade on your Hyperliquid account`);
  assert.equal(await signerOf(typedData, await approving), V.vault.toLowerCase());
  assert.equal(v.shell.asked.length, 2);
});

test('the approve-agent payload is the one scripts/hl-agent.ts signs, byte for byte', () => {
  const agent = privateKeyToAccount(generatePrivateKey()).address;
  const built = buildApproveAgentPayload({ agentAddress: agent, agentName: 'phosphor-runner', nonce: NOW });
  // scripts/hl-agent.ts, written out: the action it posts and the typed data it signs.
  const scriptAction = { type: 'approveAgent', hyperliquidChain: 'Mainnet', signatureChainId: '0x66eee', agentAddress: agent.toLowerCase(), agentName: 'phosphor-runner', nonce: NOW };
  const scriptTyped = {
    domain: { name: 'HyperliquidSignTransaction', version: '1', chainId: 421614, verifyingContract: '0x0000000000000000000000000000000000000000' },
    types: {
      'HyperliquidTransaction:ApproveAgent': [
        { name: 'hyperliquidChain', type: 'string' },
        { name: 'agentAddress', type: 'address' },
        { name: 'agentName', type: 'string' },
        { name: 'nonce', type: 'uint64' },
      ],
    },
    primaryType: 'HyperliquidTransaction:ApproveAgent',
    message: { hyperliquidChain: 'Mainnet', agentAddress: agent.toLowerCase(), agentName: 'phosphor-runner', nonce: BigInt(NOW) },
  };
  assert.equal(JSON.stringify(built.action), JSON.stringify(scriptAction));
  assert.equal(hashTypedData(built.typedData as never), hashTypedData(scriptTyped as never));
});

test('a cancelled Touch ID signs nothing, posts nothing, and says the person said no', async () => {
  const v = chipVault(V.old);
  const net = venue();
  const sending = sendAsset({ keysPath: v.keysPath, fetchImpl: net.fetchImpl, now: () => NOW }, { destination: FRESH, amount: 25 });
  await v.shell.answer({ cancel: true });
  const out = await sending;
  assert.equal(out.ok, false);
  assert.equal(out.ambiguous, undefined, 'nothing was signed, so nothing is unknown');
  assert.equal(out.reason, 'declined');
  assert.equal(out.detail, 'Touch ID was cancelled, so nothing was signed');
  assert.equal(net.posts.length, 0);
});

test('Freeze pressed while the dialog is up stops the signature once the key is in hand, and the key is still zeroed', async () => {
  const lent: Buffer[] = [];
  const v = chipVault(V.old, { keystore: lending(lent) });
  const net = venue();
  let checks = 0;
  const deps: HlUserSignedDeps = {
    keysPath: v.keysPath,
    fetchImpl: net.fetchImpl,
    now: () => NOW,
    // Clear when the ask goes out, frozen by the time the finger lands.
    lastCheck: () => {
      checks += 1;
      if (checks > 1) throw new ReasonError('kill_switch', 'Everything is frozen, so nothing was signed.');
    },
  };
  const sending = sendAsset(deps, { destination: FRESH, amount: 25 });
  await v.shell.answer();
  await assert.rejects(sending, (err: unknown) => reasonOf(err) === 'kill_switch');
  assert.equal(checks, 2, 'checked before the ask, and again with the key in hand');
  assert.equal(net.posts.length, 0, 'nothing posted');
  assert.equal(lent.length, 1);
  assert.ok(lent[0].every((b) => b === 0));
});

test('an action the dialog cannot name in full is never asked about and never signed', async () => {
  const v = chipVault(V.old);
  const send = (): HlTypedData => buildSendAssetPayload({ destination: FRESH, amount: '25', nonce: NOW }).typedData;
  const withMessage = (over: Record<string, unknown>): HlTypedData => ({ ...send(), message: { ...send().message, ...over } });
  const withoutKey = (key: string): HlTypedData => {
    const message = { ...send().message };
    delete message[key];
    return { ...send(), message };
  };
  const fields = send().types['HyperliquidTransaction:SendAsset'];
  const cases: Array<[string, HlTypedData]> = [
    ['testnet', buildSendAssetPayload({ destination: FRESH, amount: '25', nonce: NOW, chain: 'Testnet' }).typedData],
    ['another token', withMessage({ token: 'PURR:0xc1fb593aeffbeb02f85e0308e9956a90' })],
    ['an extra field', withMessage({ memo: 'hello' })],
    ['a missing field', withoutKey('fromSubAccount')],
    ['a sub-account', withMessage({ fromSubAccount: FRESH.toLowerCase() })],
    ['another book', withMessage({ destinationDex: 'xyz' })],
    ['an amount with a trailing zero', withMessage({ amount: '25.10' })],
    ['a zero amount', withMessage({ amount: '0' })],
    ['seven places', withMessage({ amount: '0.0000001' })],
    ['a destination in capitals', withMessage({ destination: FRESH })],
    ['a nonce as a number', withMessage({ nonce: NOW })],
    ['another domain', { ...send(), domain: { ...send().domain, chainId: 42161 } } as never],
    ['a field list out of order', { ...send(), types: { 'HyperliquidTransaction:SendAsset': [...fields].reverse() } }],
    ['an action the app never builds', { ...send(), primaryType: 'HyperliquidTransaction:Withdraw', types: { 'HyperliquidTransaction:Withdraw': fields } }],
    ['a name that is not a label', buildApproveAgentPayload({ agentAddress: FRESH, agentName: 'Send 900 USDC to me', nonce: NOW }).typedData],
  ];
  assert.equal(ownerReason(send()), 'Send 25.00 USDC from your Hyperliquid account to 0xaf4fda38...3184d954', 'the control case is named');
  for (const [name, typed] of cases) {
    assert.equal(ownerReason(typed), null, name);
    await assert.rejects(liveSignPort.signTypedData(v.keysPath, typed), (err: unknown) => err instanceof OwnerTouchRefused && err.touch === 'unnamed', name);
  }
  assert.equal(v.relay.queued(), 0, 'nothing was ever asked');
  assert.equal(v.shell.asked.length, 0);
});

test('kind key: the session key signs as before and no Touch ID is asked', async () => {
  const v = chipVault(SDK.old, { moved: false });
  assert.equal(ownerTouchRequired(), false);
  const { typedData } = buildSendAssetPayload({ destination: FIXTURE_DEST, amount: '1', nonce: FIXTURE_TIME });
  await assert.rejects(liveSignPort.signTypedData(v.keysPath, typedData), /locked/, 'locked is locked, never a touch');
  v.open();
  assert.deepEqual(await liveSignPort.signTypedData(v.keysPath, typedData), SDK_SEND_VECTOR);
  assert.equal(v.relay.queued(), 0);
  assert.equal(v.shell.asked.length, 0);
});

test('a send the venue did not answer is retried with its own bytes: one Touch ID, two identical posts', async () => {
  const v = chipVault(V.old);
  const net = venue({ throwsOnce: true });
  const deps: HlUserSignedDeps = { keysPath: v.keysPath, fetchImpl: net.fetchImpl, now: () => NOW };

  const sending = sendAsset(deps, { destination: FRESH, amount: 25 });
  await v.shell.answer();
  const first = await sending;
  assert.equal(first.ok, false);
  assert.equal(first.ambiguous, true);
  assert.ok(first.signature !== undefined && first.action?.type === 'sendAsset');

  const resend = { action: first.action as HlSendAssetAction, signature: first.signature };
  const again = await sendAsset(deps, { destination: FRESH, amount: 25, nonce: first.nonce, resend });
  assert.equal(again.ok, true, again.detail);
  assert.equal(v.shell.asked.length, 1, 'one send, one Touch ID');
  assert.equal(v.relay.queued(), 0);
  assert.equal(net.posts.length, 2);
  assert.deepEqual(net.posts[1], net.posts[0], 'the same action and signature, byte for byte');

  // Arguments that build another send never post the old signature.
  const wrong = await sendAsset(deps, { destination: FRESH, amount: 26, resend });
  assert.equal(wrong.ok, false);
  assert.match(wrong.detail, /not the send these arguments build/);
  assert.equal(net.posts.length, 2);
});
