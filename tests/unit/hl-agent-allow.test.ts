// "Allow trading on Hyperliquid" on a vault that moved to Touch ID (src/hl/agent-key.ts): one Touch ID
// approves the trading key the vault derived from its owner key at the open, the dialog names that
// key and how many days it trades, and from then on the session trades with it, with no second touch.
// A wallet that still holds its owner key is refused before anything is asked.
//
// The keystore, the relay, withOwnerKey, the owner touch and the signatures are real; a software P-256
// key plays the enclave and the test plays the shell (tests/unit/helpers/owner-touch.ts). Hyperliquid
// is a fake: nothing is sent anywhere, and the owner keys are published test keys.
//
// WAITING: the dialog's sentence is src/vault/reason.ts's, which the wave 3 integrator teaches to say
// a trading key's days (reports/p2-hlagent.md). Until then the owner touch cannot name the approval,
// so it asks nothing and signs nothing, and the tests that need the dialog skip. DIALOG_SAYS_DAYS is
// read when the file loads, so they run, strict, the moment the line lands; then the integrator
// deletes the switch and the one waiting test below.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { recoverTypedDataAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { createAudit } from '../../src/audit.ts';
import { HL_AGENT_DAYS, allowTrading, hlAgentView } from '../../src/hl/agent-key.ts';
import type { AllowTradingDeps } from '../../src/hl/agent-key.ts';
import { OwnerTouchRequired } from '../../src/keystore/store.ts';
import type { Keystore } from '../../src/keystore/store.ts';
import { handle } from '../../src/http/router.ts';
import { TOKEN_HEADER } from '../../src/http/auth.ts';
import type { Ctx } from '../../src/http/context.ts';
import {
  HL_AGENT_LABEL,
  agentNameUntil,
  agentValidityDays,
  approveAgent,
  buildApproveAgentPayload,
  signTypedWith,
  useOwnerTouch,
} from '../../src/rails/hl-user-signed.ts';
import type { HlApproveAgentAction, HlSignature } from '../../src/rails/hl-user-signed.ts';
import { readApiWallet } from '../../src/runner/keys.ts';
import { ownerTouchVia } from '../../src/proposals/lifecycle.ts';
import { base58Encode } from '../../src/chain/near.ts';
import { ownerKeyGate } from '../../src/vault/chip.ts';
import { ownerReason } from '../../src/vault/reason.ts';
import { DERIVED_VECTORS } from '../fixtures/derived-keys.ts';
import { HL_AGENT_VECTORS } from '../fixtures/hl-agent-keys.ts';
import { agentVault } from './helpers/hl-agent.ts';
import type { AgentVault } from './helpers/hl-agent.ts';
import { teardown } from './helpers/owner-touch.ts';
import { tempDir } from './helpers/tmp.ts';

const [V] = DERIVED_VECTORS;
const vector = (version: number) => HL_AGENT_VECTORS.find((x) => x.old === V.old && x.version === version)!;
const V1 = vector(1);
const V2 = vector(2);
const NOW = 1786600000000;
const DAY = 86_400_000;
const UNTIL = NOW + HL_AGENT_DAYS * DAY;
const STORED = generatePrivateKey();
// The approval of V1 for 90 days at NOW, signed by V's owner key: viem here, and foundry's
// `cast wallet sign --data` over the same typed data gave the same 65 bytes when this was written.
const SIGNED_V1: HlSignature = {
  r: '0xc69b4759bde4d0e04b326f5db34d1cbb4e4753f7e11c9108290b51d1e9d1c88e',
  s: '0x31c689da930e4f5180e8baa6856b930b0d14f950e6632edd80f92a9706eb462a',
  v: 28,
};

const DIALOG_SAYS_DAYS =
  ownerReason(buildApproveAgentPayload({ agentAddress: V1.address, agentName: agentNameUntil(HL_AGENT_LABEL, UNTIL), nonce: NOW }).typedData) !== null;
const WAITING = DIALOG_SAYS_DAYS ? false : "waits for src/vault/reason.ts to say a trading key's days (reports/p2-hlagent.md, the wave 3 integrator's line)";

test.afterEach(teardown);

// What the dialog says for a key: the address shortened the way every owner action says one.
function sentence(address: string, days = HL_AGENT_DAYS): string {
  const body = address.toLowerCase().slice(2);
  return `Let 0x${body.slice(0, 8)}...${body.slice(-8)} trade on your Hyperliquid account for ${days} days`;
}

type Post = { action: HlApproveAgentAction; nonce: number; signature: HlSignature };

/* Hyperliquid /exchange and /info. `refuse`: the venue answers err with these words. `silent`: the
   post goes out and no reply comes back. `listed`: what extraAgents answers, given the posts so far. */
function venue(over: { refuse?: string; silent?: boolean; listed?: (posts: Post[]) => unknown[] } = {}) {
  const posts: Post[] = [];
  const infos: Array<Record<string, unknown>> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
    if (String(url).endsWith('/exchange')) {
      posts.push(body as unknown as Post);
      if (over.silent === true) throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
      if (over.refuse !== undefined) return json({ status: 'err', response: over.refuse });
      return json({ status: 'ok', response: { type: 'default' } });
    }
    infos.push(body);
    if (body.type === 'extraAgents') return json(over.listed?.(posts) ?? []);
    return json(null);
  };
  return { fetchImpl, posts, infos };
}

function deps(v: AgentVault, net: ReturnType<typeof venue>, over: Partial<AllowTradingDeps> = {}): AllowTradingDeps {
  return { keysPath: v.keysPath, keystore: v.store, prefs: v.prefs, armed: () => 0, frozen: () => false, fetchImpl: net.fetchImpl, now: () => NOW, ...over };
}

async function signerOf(post: Post): Promise<string> {
  const { typedData } = buildApproveAgentPayload({ agentAddress: post.action.agentAddress, agentName: post.action.agentName, nonce: post.action.nonce });
  const address = await recoverTypedDataAddress({
    domain: typedData.domain,
    types: typedData.types as never,
    primaryType: typedData.primaryType as never,
    message: typedData.message as never,
    signature: { r: post.signature.r, s: post.signature.s, yParity: post.signature.v - 27 },
  } as never);
  return address.toLowerCase();
}

// Nothing reached the shell: no dialog, no signature, and nothing waits on the relay either.
function nothingAsked(v: AgentVault): void {
  assert.equal(v.shell.asked.length, 0, 'no Touch ID was asked for');
  assert.equal(v.relay.queued(), 0, 'and none is waiting');
}

// ---------- what the dialog may say ----------

test("an approveAgent's days are read off the signed name and nonce alone, and anything else is not said", () => {
  const n = BigInt(NOW);
  assert.equal(agentValidityDays('phosphor-runner', n), null, "a plain label: a key with no end, as scripts/hl-agent.ts signs");
  assert.equal(agentValidityDays(agentNameUntil(HL_AGENT_LABEL, UNTIL), n), 90);
  assert.equal(agentValidityDays(agentNameUntil(HL_AGENT_LABEL, NOW + DAY), n), 1);
  assert.equal(agentValidityDays(agentNameUntil(HL_AGENT_LABEL, NOW + 180 * DAY), n), 180);
  for (const [name, why] of [
    [agentNameUntil(HL_AGENT_LABEL, NOW + 181 * DAY), 'past the venue\'s 180 days'],
    [agentNameUntil(HL_AGENT_LABEL, NOW + 90 * DAY + 1), 'not a whole number of days'],
    [agentNameUntil(HL_AGENT_LABEL, NOW), 'no time at all'],
    [agentNameUntil(HL_AGENT_LABEL, NOW - DAY), 'an end already past'],
    [agentNameUntil('a-label-of-17-chr', UNTIL), 'a label longer than the venue takes'],
    [`phosphor-runner valid_until 0${UNTIL}`, 'a leading zero'],
    [`phosphor-runner  valid_until ${UNTIL}`, 'two spaces'],
    [`phosphor-runner valid_until ${UNTIL} `, 'a trailing space'],
    [`phosphor runner valid_until ${UNTIL}`, 'a space in the label'],
    ['', 'empty'],
  ] as const) {
    assert.equal(agentValidityDays(name, n), undefined, why);
  }
  assert.equal(agentValidityDays(agentNameUntil(HL_AGENT_LABEL, UNTIL), NOW), undefined, 'a nonce that is not the uint64 the builder writes');
  assert.equal(agentValidityDays(7, n), undefined);
});

test('the approval of a derived key signs to the vector foundry checked, and the posted action is the one signed', async () => {
  const { typedData, action, nonce } = buildApproveAgentPayload({ agentAddress: V1.address, agentName: agentNameUntil(HL_AGENT_LABEL, UNTIL), nonce: NOW });
  assert.deepEqual(await signTypedWith(`0x${V.old}`, typedData), SIGNED_V1);
  assert.deepEqual(action, {
    type: 'approveAgent',
    hyperliquidChain: 'Mainnet',
    signatureChainId: '0x66eee',
    agentAddress: V1.address.toLowerCase(),
    agentName: `phosphor-runner valid_until ${UNTIL}`,
    nonce: NOW,
  });
  assert.equal(nonce, NOW);
});

test('an approveAgent the dialog cannot say is never asked about: nothing is signed or posted', async () => {
  const v = agentVault(V.old);
  v.open();
  const net = venue();
  for (const agentName of [agentNameUntil(HL_AGENT_LABEL, NOW + 200 * DAY), agentNameUntil(HL_AGENT_LABEL, NOW + DAY / 2), 'not a label']) {
    const out = await approveAgent({ keysPath: v.keysPath, fetchImpl: net.fetchImpl }, { agentAddress: V1.address, agentName, nonce: NOW });
    assert.equal(out.ok, false);
    assert.equal(out.touch, 'unnamed', agentName);
    assert.equal(out.reason, 'not_sent');
  }
  nothingAsked(v);
  assert.equal(net.posts.length, 0);
});

// ---------- refused before anything is asked ----------

test('kind key: allowing trading is refused before anything is asked, and nothing signs from the session', async () => {
  const v = agentVault(V.old, { moved: false, stored: STORED });
  v.open();
  const net = venue();
  const out = await allowTrading(deps(v, net));
  assert.equal(out.ok, false);
  assert.equal(!out.ok && out.code, 'not_moved');
  nothingAsked(v);
  assert.equal(net.posts.length, 0, 'nothing posted: the owner key in the session signed nothing');
  assert.equal(v.prefs.get().hlAgent, undefined);
  assert.equal(v.store.evmPrivateKey(), `0x${V.old}`, 'and the wallet holds its owner key as before');
  assert.deepEqual(v.store.apiWallet(), { key: STORED, address: privateKeyToAccount(STORED).address }, 'its trading key is the one it had');
  assert.equal(hlAgentView({ keystore: v.store, prefs: v.prefs }).moved, false);
});

test('shut, a plan holding the trading key, or frozen: refused before any Touch ID, with nothing written', async () => {
  const v = agentVault(V.old);
  const net = venue();
  const shut = await allowTrading(deps(v, net));
  assert.equal(!shut.ok && shut.code, 'locked', 'the next key is made at the open');
  v.open();
  const busy = await allowTrading(deps(v, net, { armed: () => 1 }));
  assert.equal(!busy.ok && busy.code, 'busy', 'the approval replaces the key a plan holds');
  const frozen = await allowTrading(deps(v, net, { frozen: () => true }));
  assert.equal(!frozen.ok && frozen.code, 'frozen');
  nothingAsked(v);
  assert.equal(net.posts.length, 0);
  assert.equal(v.prefs.get().hlAgent, undefined);
});

test('a gate that closes on a session still holding the owner key, then opens again before the signature: nothing is ever signed from memory, and the check at the signature finds the vault never moved', async () => {
  // Opened as kind key, so the session holds the owner key; then a marker counts as moved while its
  // chain read is out (src/vault/chip.ts ownerKeyGate), and the chain answers "not moved" right after
  // the last check before the ask has read it as moved (the W6 window).
  const v = agentVault(V.old, { moved: false });
  let moved = false;
  v.store.keepOwnerKeyOutWhen(() => moved);
  useOwnerTouch(ownerTouchVia({ vault: v.relay, keystore: v.store, ownerOut: () => moved }));
  v.open();
  assert.equal(v.store.evmPrivateKey(), `0x${V.old}`);
  moved = true;
  let asks = 0;
  const net = venue();
  const allowing = allowTrading(
    deps(v, net, {
      armed: () => {
        asks += 1;
        if (asks === 2) moved = false; // read in the last check before the ask, after it asked the gate
        return 0;
      },
    }),
  );
  if (DIALOG_SAYS_DAYS) await v.shell.answer();
  const out = await allowing;
  if (DIALOG_SAYS_DAYS) {
    assert.equal(!out.ok && out.code, 'not_moved', 'the touch was asked, and the check at the signature found the vault never moved');
    assert.equal(v.shell.asked.length, 1);
  } else {
    assert.equal(!out.ok && out.code, 'unnamed', 'refused at the touch, not signed from the session');
    nothingAsked(v);
  }
  assert.equal(net.posts.length, 0, 'nothing signed, so nothing posted');
  assert.equal(v.prefs.get().hlAgent, undefined);
  assert.throws(() => v.store.evmPrivateKey(), OwnerTouchRequired, 'the owner key left the session before the signature, whatever the gate says now');
});

// ---------- the gate src/main.ts wires (src/vault/chip.ts ownerKeyGate) ----------

const KEY_REF = 'chip:com.karimbabasf.phosphor.chip.p2-test.0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0';
const PAPER = `secp256k1:${base58Encode(Buffer.alloc(64, 0x5e))}`;

/* A wallet whose vault.json names no chip, with the app's own gate: the service's status names a
   marker for the vault, and the chain's answer about its keys is the test's to give. `opened`: the
   wallet was open before the marker was known, so the session still holds the owner key. */
async function onMarker(chainSays: (key: string, chip: string) => Promise<boolean>, opts: { opened?: boolean } = {}) {
  const v = agentVault(V.old, { moved: false });
  if (opts.opened === true) {
    v.open();
    assert.equal(v.store.evmPrivateKey(), `0x${V.old}`, 'opened before the marker was known: the session holds the owner key');
  }
  const jwk = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const chip = `p256:${base58Encode(Buffer.concat([Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]))}`;
  const read = v.relay.ask({ op: 'chipStatus' });
  const request = await v.relay.next(1_000);
  assert.ok(request !== null && request.op === 'chipStatus');
  const marker = { account: V.vault.toLowerCase(), allowance: V.allowance.toLowerCase(), recovery: PAPER, at: '2026-10-04T12:00:00.000Z' };
  v.relay.answer({ id: request.id, ok: true, keychainHome: true, chips: [{ keyRef: KEY_REF, publicKey: chip, fresh: false, marker }] });
  assert.ok((await read).ok);
  const gate = ownerKeyGate(() => v.prefs.get(), v.relay, { hasPublicKey: async (_account, key) => chainSays(key, chip) });
  v.store.keepOwnerKeyOutWhen(gate);
  useOwnerTouch(ownerTouchVia({ vault: v.relay, keystore: v.store, ownerOut: gate }));
  return { v, gate };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('the app\'s gate: a marker the chain shows on the vault keeps the owner key out of the open, and allowing trading goes to its own Touch ID', async () => {
  const { v, gate } = await onMarker(async (key, chip) => key === chip);
  assert.equal(gate(v.vault), true, 'out while the chain is asked');
  await settle();
  assert.equal(gate(v.vault), true, 'the chain shows the chip key on the vault: out for good');
  v.open();
  assert.throws(() => v.store.evmPrivateKey(), OwnerTouchRequired, 'the open holds no owner key');
  assert.equal(v.store.hlAgentAccount(1), V1.address, 'and made the next trading key all the same');
  const net = venue();
  const allowing = allowTrading(deps(v, net));
  if (DIALOG_SAYS_DAYS) assert.equal((await v.shell.answer()).reason, sentence(V1.address));
  const out = await allowing;
  if (DIALOG_SAYS_DAYS) {
    assert.equal(out.ok, true);
    assert.equal(net.posts.length, 1);
    assert.deepEqual(v.store.apiWallet(), { key: `0x${V1.key}`, address: V1.address });
  } else {
    assert.equal(!out.ok && out.code, 'unnamed');
    nothingAsked(v);
  }
});

test('the app\'s gate: a marker the chain does not show counts as moved only until the chain answers, and then nothing is signed', async () => {
  const answers: Array<(on: boolean) => void> = [];
  const { v, gate } = await onMarker(() => new Promise<boolean>((resolve) => answers.push(resolve)), { opened: true });
  assert.equal(gate(v.vault), true, 'a marker whose chain read is out keeps the key out');
  const net = venue();
  const allowing = allowTrading(deps(v, net));
  // The chain answers while the dialog is up: neither the chip key nor the paper key is on the vault.
  for (const answer of answers.splice(0)) answer(false);
  await settle();
  assert.equal(gate(v.vault), false, 'the chain says the vault never moved');
  if (DIALOG_SAYS_DAYS) await v.shell.answer();
  const out = await allowing;
  assert.equal(!out.ok && out.code, DIALOG_SAYS_DAYS ? 'not_moved' : 'unnamed', 'the check at the signature asks the gate again');
  assert.equal(net.posts.length, 0, 'nothing signed, nothing posted');
  assert.equal(v.prefs.get().hlAgent, undefined);
  assert.throws(() => v.store.evmPrivateKey(), OwnerTouchRequired, 'the owner key left the session before the touch, as approve() lets it go');

  const again = await allowTrading(deps(v, net));
  assert.equal(!again.ok && again.code, 'not_moved', 'from now on this wallet is the one that never moved');
  assert.equal(v.shell.asked.length, DIALOG_SAYS_DAYS ? 1 : 0);
});

test('until src/vault/reason.ts says a trading key\'s days, allowing trading asks nothing and signs nothing', { skip: DIALOG_SAYS_DAYS }, async () => {
  const v = agentVault(V.old);
  v.open();
  const net = venue();
  const out = await allowTrading(deps(v, net));
  assert.equal(!out.ok && out.code, 'unnamed');
  nothingAsked(v);
  assert.equal(net.posts.length, 0);
  assert.equal(v.prefs.get().hlAgent, undefined);
});

// ---------- one Touch ID ----------

test('kind chip: allowing trading is one Touch ID that names the new key and its days, and the session trades with it at once', { skip: WAITING }, async () => {
  const v = agentVault(V.old, { stored: STORED });
  v.open();
  assert.deepEqual(v.store.apiWallet(), { key: STORED, address: privateKeyToAccount(STORED).address }, 'before: the key the file holds');
  const view = hlAgentView({ keystore: v.store, prefs: v.prefs, now: () => NOW });
  assert.deepEqual(view, { moved: true, key: null, next: V1.address.toLowerCase(), days: 90 });

  const net = venue();
  const allowing = allowTrading(deps(v, net));
  const asked = await v.shell.answer();
  assert.equal(asked.reason, sentence(V1.address), 'the dialog names the key and how long it trades');
  const out = await allowing;
  assert.deepEqual(out, { ok: true, address: V1.address.toLowerCase(), version: 1, validUntil: UNTIL, days: 90 });

  assert.equal(v.shell.asked.length, 1, 'one Touch ID');
  assert.equal(v.relay.queued(), 0);
  assert.equal(net.posts.length, 1);
  const post = net.posts[0];
  assert.deepEqual(post.action, buildApproveAgentPayload({ agentAddress: V1.address, agentName: agentNameUntil(HL_AGENT_LABEL, UNTIL), nonce: NOW }).action);
  assert.equal(post.nonce, NOW);
  assert.deepEqual(post.signature, SIGNED_V1, 'the owner key signed it, through the touch');
  assert.equal(await signerOf(post), V.vault.toLowerCase());

  assert.deepEqual(v.prefs.get().hlAgent, { account: V.vault.toLowerCase(), version: 1, address: V1.address.toLowerCase(), validUntil: UNTIL, approvedAt: new Date(NOW).toISOString() });
  assert.deepEqual(v.store.apiWallet(), { key: `0x${V1.key}`, address: V1.address }, 'the session trades with the new key, no second touch');
  assert.deepEqual(readApiWallet(v.keysPath), { key: `0x${V1.key}`, source: 'present', address: V1.address });
  assert.equal(v.store.state(), 'unlocked', 'the touch changed no lock');
  assert.throws(() => v.store.evmPrivateKey(), OwnerTouchRequired, 'and left no owner key behind');
  assert.deepEqual(hlAgentView({ keystore: v.store, prefs: v.prefs, now: () => NOW }).key, {
    address: V1.address.toLowerCase(),
    version: 1,
    validUntil: UNTIL,
    approvedAt: new Date(NOW).toISOString(),
    expired: false,
  });
});

test('the owner key lent for the approval is zeroed once it signed, and it is the owner key, not the trading key', { skip: WAITING }, async () => {
  const lent: Array<{ buffer: Buffer; was: string }> = [];
  const lending = (store: Keystore): Keystore => ({
    ...store,
    withOwnerKey: <T,>(dek: Buffer, fn: (key: Buffer) => T) =>
      store.withOwnerKey(dek, (key) => {
        lent.push({ buffer: key, was: key.toString('hex') });
        return fn(key);
      }),
  });
  const v = agentVault(V.old, { keystore: lending });
  v.open();
  const allowing = allowTrading(deps(v, venue()));
  await v.shell.answer();
  assert.equal((await allowing).ok, true);
  assert.equal(lent.length, 1, 'one loan of the owner key');
  assert.equal(lent[0].was, V.old, 'the owner key signed: the trading key never crossed the touch');
  assert.ok(lent[0].buffer.every((b) => b === 0), 'and its 32 bytes read back as zero');
});

test('a cancel signs nothing, posts nothing and writes nothing, and the next try names the same key', { skip: WAITING }, async () => {
  const v = agentVault(V.old, { stored: STORED });
  v.open();
  const net = venue();
  const allowing = allowTrading(deps(v, net));
  await v.shell.answer({ cancel: true });
  const out = await allowing;
  assert.deepEqual(out.ok ? null : [out.code, out.reason], ['user_cancel', 'declined']);
  assert.equal(net.posts.length, 0);
  assert.equal(v.prefs.get().hlAgent, undefined);
  assert.deepEqual(v.store.apiWallet(), { key: STORED, address: privateKeyToAccount(STORED).address }, 'the old key still trades');

  const again = allowTrading(deps(v, net));
  assert.equal((await v.shell.answer()).reason, sentence(V1.address), 'the same key: it was never approved');
  assert.equal((await again).ok, true);
});

test("Hyperliquid's refusal writes nothing, and the next approval names the same key again", { skip: WAITING }, async () => {
  const v = agentVault(V.old);
  v.open();
  const refusing = venue({ refuse: 'Must deposit before performing actions.' });
  const allowing = allowTrading(deps(v, refusing));
  await v.shell.answer();
  const out = await allowing;
  assert.equal(!out.ok && out.code, 'refused');
  assert.match(!out.ok ? out.detail : '', /Must deposit before performing actions/, "the venue's words are kept for the window");
  assert.equal(refusing.posts.length, 1);
  assert.equal(v.prefs.get().hlAgent, undefined);
  assert.equal(v.store.apiWallet(), null, 'no trading key: the file held none and none was approved');

  const ok = venue();
  const second = allowTrading(deps(v, ok));
  assert.equal((await v.shell.answer()).reason, sentence(V1.address));
  assert.equal((await second).ok, true);
  assert.equal(ok.posts[0].action.agentAddress, refusing.posts[0].action.agentAddress, 'a key the venue never took is named again');
});

test('no answer from Hyperliquid: its list of keys says whether the approval went in, and nothing is signed twice', { skip: WAITING }, async () => {
  const v = agentVault(V.old);
  v.open();
  const took = venue({ silent: true, listed: (posts) => posts.map((p) => ({ address: p.action.agentAddress, name: 'phosphor-runner', validUntil: UNTIL })) });
  const allowing = allowTrading(deps(v, took));
  await v.shell.answer();
  assert.deepEqual(await allowing, { ok: true, address: V1.address.toLowerCase(), version: 1, validUntil: UNTIL, days: 90 });
  assert.equal(took.posts.length, 1, 'one post, never a resend');
  assert.equal(v.shell.asked.length, 1, 'one Touch ID');
  assert.deepEqual(took.infos.map((i) => [i.type, i.user]), [['extraAgents', V.vault.toLowerCase()]]);
  assert.equal(v.prefs.get().hlAgent?.version, 1);

  const w = agentVault(V.old);
  w.open();
  const lost = venue({ silent: true, listed: () => [] });
  const unknown = allowTrading(deps(w, lost));
  await w.shell.answer();
  const out = await unknown;
  assert.equal(!out.ok && out.code, 'unknown');
  assert.equal(w.prefs.get().hlAgent, undefined, 'nothing written while the venue cannot say');
});

test('Freeze pressed while the dialog is up stops the signature, and nothing is posted', { skip: WAITING }, async () => {
  const v = agentVault(V.old);
  v.open();
  let frozen = false;
  const net = venue();
  const allowing = allowTrading(deps(v, net, { frozen: () => frozen }));
  frozen = true;
  await v.shell.answer();
  const out = await allowing;
  assert.equal(!out.ok && out.code, 'frozen');
  assert.equal(net.posts.length, 0);
  assert.equal(v.prefs.get().hlAgent, undefined);
});

test('a plan armed while the dialog is up keeps its key: the approval that would replace it is not signed', { skip: WAITING }, async () => {
  const v = agentVault(V.old, { stored: STORED });
  v.open();
  let armed = 0;
  const net = venue();
  const allowing = allowTrading(deps(v, net, { armed: () => armed }));
  armed = 1;
  await v.shell.answer();
  const out = await allowing;
  assert.equal(!out.ok && out.code, 'busy');
  assert.equal(net.posts.length, 0, 'nothing signed, nothing posted');
  assert.deepEqual(v.store.apiWallet(), { key: STORED, address: privateKeyToAccount(STORED).address }, 'the plan trades on with the key it took');
});

test('a second approval names a new key, never an address the venue approved before, and waits for the next open to make it', { skip: WAITING }, async () => {
  const v = agentVault(V.old);
  v.open();
  const net = venue();
  const first = allowTrading(deps(v, net));
  assert.equal((await v.shell.answer()).reason, sentence(V1.address));
  assert.equal((await first).ok, true);

  const early = await allowTrading(deps(v, net));
  assert.equal(!early.ok && early.code, 'reopen', 'version 2 is made at the next open');
  assert.equal(v.shell.asked.length, 1, 'and nothing was asked for it');

  v.store.lock();
  v.open();
  assert.deepEqual(v.store.apiWallet(), { key: `0x${V1.key}`, address: V1.address }, 'the open made the approved key again');
  const second = allowTrading(deps(v, net, { now: () => NOW + DAY }));
  assert.equal((await v.shell.answer()).reason, sentence(V2.address));
  assert.deepEqual(await second, { ok: true, address: V2.address.toLowerCase(), version: 2, validUntil: NOW + DAY + 90 * DAY, days: 90 });
  assert.deepEqual(net.posts.map((p) => p.action.agentAddress), [V1.address.toLowerCase(), V2.address.toLowerCase()]);
  assert.deepEqual(v.store.apiWallet(), { key: `0x${V2.key}`, address: V2.address });
  assert.equal(v.prefs.get().hlAgent?.version, 2);
});

test('a second click while the first dialog is up is refused at once, not queued as a second dialog', { skip: WAITING }, async () => {
  const v = agentVault(V.old);
  v.open();
  const net = venue();
  const first = allowTrading(deps(v, net));
  const second = await allowTrading(deps(v, net));
  assert.equal(!second.ok && second.code, 'asking');
  await v.shell.answer();
  assert.equal((await first).ok, true);
  assert.equal(v.shell.asked.length, 1);
});

// ---------- the window's route ----------

/* The app's own router over a context holding what the route reads. The policy, the plans and the
   window token are this test's; nothing listens beyond 127.0.0.1. */
async function serve(v: AgentVault, net: ReturnType<typeof venue>) {
  const dir = tempDir('phosphor-hl-agent-route-');
  const audit = createAudit(dir);
  let broadcasts = 0;
  const token = 'a'.repeat(64);
  const ctx = {
    token,
    audit,
    keystore: v.store,
    vaultPrefs: v.prefs,
    cfg: { keysPath: v.keysPath, dataDir: dir },
    session: { touch: () => {}, armed: () => [] },
    getPolicy: () => ({ killSwitch: false }),
    sse: { broadcastState: () => (broadcasts += 1) },
  } as unknown as Ctx;
  const realFetch = globalThis.fetch;
  // The route builds its deps from the context: Hyperliquid is reached through the global fetch.
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) =>
    String(url).startsWith('https://api.hyperliquid.xyz') ? net.fetchImpl(url, init) : realFetch(url, init)) as typeof fetch;
  const server = http.createServer((req, res) => void handle(ctx, req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (body: Record<string, unknown>, origin = base) => {
    const res = await realFetch(`${base}/api/vault/trading-key/allow`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  const get = async (withToken = true) => {
    const res = await realFetch(`${base}/api/vault/trading-key`, { headers: withToken ? { [TOKEN_HEADER]: token } : {} });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  const close = async () => {
    globalThis.fetch = realFetch;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { token, audit, post, get, close, broadcasts: () => broadcasts };
}

test('the route is the window\'s: no token or another origin is refused before anything is asked', async () => {
  const v = agentVault(V.old);
  v.open();
  const net = venue();
  const s = await serve(v, net);
  try {
    const none = await s.post({});
    assert.equal(none.status, 403);
    const forged = await s.post({ token: s.token }, 'https://phosphor.money');
    assert.equal(forged.status, 403);
    const read = await s.get(false);
    assert.equal(read.status, 401, 'the status is a read behind the read gate');
    nothingAsked(v);
    assert.equal(net.posts.length, 0);
    const knocks = s.audit.tail(10).filter((e) => e.type === 'approve_attempt_rejected');
    assert.equal(knocks.length, 2, 'each refused write knocked on the custody surface, and was written down');
  } finally {
    await s.close();
  }
});

test('the route on a wallet that holds its owner key answers its refusal in plain words, and the read says not moved', async () => {
  const v = agentVault(V.old, { moved: false });
  v.open();
  const s = await serve(v, venue());
  try {
    const out = await s.post({ token: s.token });
    assert.equal(out.status, 200);
    assert.equal(out.json.ok, false);
    assert.equal(out.json.code, 'not_moved');
    assert.match(String(out.json.error), /^Allow trading is for a vault on Touch ID\./);
    const read = await s.get();
    assert.equal(read.status, 200);
    assert.deepEqual(read.json, { moved: false, key: null, next: null, days: 90 });
    nothingAsked(v);
  } finally {
    await s.close();
  }
});

test('the route: one Touch ID through the app\'s own router, the window told, and the audit line names the key, never as an executed move', { skip: WAITING }, async () => {
  const v = agentVault(V.old);
  v.open();
  const net = venue();
  const s = await serve(v, net);
  try {
    const answering = v.shell.answer();
    const out = await s.post({ token: s.token });
    assert.equal((await answering).reason, sentence(V1.address));
    assert.equal(out.status, 200);
    assert.equal(out.json.ok, true);
    assert.equal(out.json.address, V1.address.toLowerCase());
    assert.equal(out.json.days, 90);
    assert.equal(s.broadcasts(), 1);
    const lines = s.audit.tail(10);
    assert.ok(lines.some((e) => e.type === 'app_start' && e.msg.includes(V1.address.toLowerCase()) && e.msg.includes('90 days')));
    assert.ok(!lines.some((e) => e.type === 'executed'), 'an approval of a key is not a move: no executed line');
    const read = await s.get();
    assert.equal((read.json.key as { version: number }).version, 1);
  } finally {
    await s.close();
  }
});

test('no agent door reaches the approval: nothing the MCP surface loads names it', () => {
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  for (const file of ['src/http/mcp.ts', 'src/mcp.ts']) {
    const body = fs.readFileSync(path.join(root, file), 'utf8');
    for (const name of ['hl-agent', 'agent-key', 'allowTrading', 'approveAgent', 'trading-key']) {
      assert.equal(body.includes(name), false, `${file} names ${name}`);
    }
  }
  // The rails an agent's proposal reaches never call it either.
  const rails = fs.readdirSync(path.join(root, 'src/rails')).filter((f) => f.endsWith('.ts') && f !== 'hl-user-signed.ts');
  for (const file of rails) {
    const body = fs.readFileSync(path.join(root, 'src/rails', file), 'utf8');
    assert.equal(/\bapproveAgent\(|allowTrading\(/.test(body), false, `src/rails/${file} calls the approval`);
  }
});
