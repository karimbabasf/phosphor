// The row a click decides is the row the window drew. The store re-reads proposals.json
// whenever the file moves, and any process running as this user can move it: before the seal, a
// pending send whose `to` was rewritten on disk after the card was drawn went to the rail as the
// attacker under a click given to the friend, and a refused row flipped to pending on disk could
// be clicked at all. Now every row this process writes or first reads is sealed, and a decision
// on a row that no longer matches its seal is refused before the engine, the dialog or the rail
// see it: on the click, on the finger, and on the unlock that releases a queue.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AppConfig, Policy, Proposal, RiskRow, WriteDraft } from '../../src/types.ts';
import { createAudit } from '../../src/audit.ts';
import { createStore } from '../../src/store.ts';
import { createLedger } from '../../src/ledger/index.ts';
import { defaultPolicy, loadPolicy, savePolicy } from '../../src/policy/file.ts';
import { renderSentences } from '../../src/policy/render.ts';
import { createProposalService } from '../../src/proposals.ts';
import { createKeystore, useKeystore } from '../../src/keystore/index.ts';
import { defaultParams } from '../../src/keystore/kdf.ts';
import { seUnwrapWithSoftwareKey } from '../../src/keystore/sewrap.ts';
import type { EnclaveRef } from '../../src/keystore/store.ts';
import { createVaultRelay } from '../../src/vault/relay.ts';
import { makeCtx, railThat } from './helpers/proposals.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const riskRows = (JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'risk-table.json'), 'utf8')) as { rows: RiskRow[] }).rows;

const FRIEND = '0xb583f41992Cd21b2F2345e194a36D33684BB5DB0';
const ATTACKER = '0x9999999999999999999999999999999999999999';

// The local hand: rewrite one row in proposals.json in place, the way something that is not
// this app would.
function rewriteOnDisk(dataDir: string, id: string, change: (row: Proposal) => void): void {
  const file = path.join(dataDir, 'proposals.json');
  const rows = JSON.parse(fs.readFileSync(file, 'utf8')) as Proposal[];
  const row = rows.find((r) => r.id === id);
  assert.ok(row !== undefined, `${id} is on disk`);
  change(row);
  fs.writeFileSync(file, JSON.stringify(rows, null, 2));
}

function sendHarness() {
  let runs = 0;
  const seen: string[] = [];
  const rail = railThat('intents_pay', async (draft) => {
    runs += 1;
    seen.push((draft as Extract<WriteDraft, { kind: 'intents_pay' }>).to);
    return { ok: true, detail: 'scripted payout', txids: ['0x' + 'ab'.repeat(32)] };
  });
  const h = makeCtx({ rails: [rail], intentsUsdc: 1000 });
  return { ...h, runs: () => runs, seen };
}

test('a pending send whose receiver was rewritten on disk is refused at the click, and the rail never runs', async () => {
  const h = sendHarness();
  const p = await h.svc.proposeSend({ to: FRIEND, symbol: 'USDC', amount: 1, where: 'ethereum' });
  assert.equal(p.status, 'pending');
  assert.equal(h.store.intact(p.id), true, 'a row this process wrote is intact');

  rewriteOnDisk(h.dataDir, p.id, (row) => {
    (row.draft as Extract<WriteDraft, { kind: 'intents_pay' }>).to = ATTACKER;
  });
  assert.equal(h.store.intact(p.id), false, 'the rewritten row no longer matches its seal');

  await assert.rejects(h.svc.approve(p.id), /changed on disk by something other than this app/);
  assert.equal(h.runs(), 0, 'nothing executed');
  const rejected = h.audit.tail(20).find((e) => e.type === 'approve_attempt_rejected');
  assert.ok(rejected !== undefined, 'the refusal is in the audit log');
  assert.equal((rejected.data as { changedOnDisk?: boolean }).changedOnDisk, true);

  // Refusing is a decision too, and it is not taken on a stranger's row either; the row is not
  // written back, so the stranger's bytes are never sealed as ours.
  await assert.rejects(h.svc.refuse(p.id), /changed on disk/);
  assert.equal(h.store.intact(p.id), false);
  assert.equal(h.store.get(p.id)?.status, 'pending');
  await assert.rejects(h.svc.approve(p.id), /changed on disk/);
  assert.equal(h.runs(), 0);
});

test('a refused row flipped to pending on disk cannot be approved', async () => {
  const h = sendHarness();
  const p = await h.svc.proposeSend({ to: FRIEND, symbol: 'USDC', amount: 1, where: 'nowhere' });
  assert.equal(p.status, 'policy_refused');

  rewriteOnDisk(h.dataDir, p.id, (row) => {
    row.status = 'pending';
    row.verdict = { outcome: 'needs_approval', reasons: ['forged'] };
  });
  assert.equal(h.store.get(p.id)?.status, 'pending', 'the store reads the flipped status back');
  await assert.rejects(h.svc.approve(p.id), /changed on disk/);
  assert.equal(h.runs(), 0);
});

test('a row this process wrote still approves, and a file that predates the process is trusted as first read', async () => {
  const h = sendHarness();
  const p = await h.svc.proposeSend({ to: FRIEND, symbol: 'USDC', amount: 1, where: 'ethereum' });
  const clicked = await h.svc.approve(p.id);
  await h.svc.settled(clicked.id, 5000);
  assert.equal(h.store.get(p.id)?.status, 'executed');
  assert.equal(h.runs(), 1);
  assert.deepEqual(h.seen, [FRIEND]);

  // A second process over the same directory: what it first reads is what its window draws,
  // so that read is the seal, and a row from before its time can be decided.
  const q = await h.svc.proposeSend({ to: FRIEND, symbol: 'USDC', amount: 2, where: 'ethereum' });
  assert.equal(q.status, 'pending');
  const later = createStore(h.dataDir);
  assert.equal(later.intact(q.id), true, 'first sight seals');
  assert.equal(later.intact('never-written'), false, 'a row that is not there is not intact');
  rewriteOnDisk(h.dataDir, q.id, (row) => {
    (row.draft as Extract<WriteDraft, { kind: 'intents_pay' }>).to = ATTACKER;
  });
  assert.equal(later.intact(q.id), false, 'and a change after first sight is caught');
});

test('the seal survives the round trip through disk: a row read back after a write is intact', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-seal-'));
  const store = createStore(dir);
  const row = {
    id: 'p1',
    kind: 'intents_pay',
    status: 'pending',
    createdAt: '2026-09-17T00:00:00.000Z',
    draft: { kind: 'intents_pay', to: FRIEND, amount: 0.1, amountUsd: 1e21, note: undefined, nested: { b: 2, a: [1, null, 'x'] } },
    verdict: { outcome: 'needs_approval', reasons: [] },
    simulation: null,
  } as unknown as Proposal;
  store.put(row);
  assert.equal(store.intact('p1'), true);
  // Force the parse path: a fresh store has no cache and reads the bytes back.
  assert.equal(createStore(dir).intact('p1'), true, 'a fresh read of our own bytes seals to the same value');
  const again = createStore(dir);
  again.list();
  rewriteOnDisk(dir, 'p1', (r) => {
    (r.draft as { amount: number }).amount = 100;
  });
  assert.equal(again.intact('p1'), false);
  assert.equal(store.intact('p1'), false, 'the writer sees the change too');
});

test('a queue released by an unlock skips a row that was rewritten on disk while it waited', async () => {
  const h = sendHarness();
  const p = await h.svc.proposeSend({ to: FRIEND, symbol: 'USDC', amount: 1, where: 'ethereum' });
  rewriteOnDisk(h.dataDir, p.id, (row) => {
    row.status = 'pending_unlock';
  });
  // The flip itself broke the seal, which is the point: nothing this process did not write is
  // re-decided. The row is left as it is, not rewritten to pending.
  assert.equal(await h.svc.releaseQueued(), 0);
  assert.equal(h.store.get(p.id)?.status, 'pending_unlock');
  assert.ok(h.audit.tail(10).some((e) => e.type === 'approve_attempt_rejected' && (e.data as { action?: string }).action === 'release'));
  assert.equal(h.runs(), 0);
});

// ---------- the finger ----------

function happyPolicy(): Policy {
  const p = defaultPolicy();
  p.sentences = renderSentences(p);
  return p;
}

function fakeEnclave(): { ref: EnclaveRef; priv: crypto.KeyObject } {
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = pair.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const x963 = Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  return {
    ref: { keyBlob: crypto.randomBytes(64).toString('base64'), publicKey: x963.toString('base64'), createdAt: new Date().toISOString() },
    priv: pair.privateKey,
  };
}

function sealLikeTheSidecar(dek: Buffer, id: string, transport: Buffer): string {
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', transport, nonce);
  c.setAAD(Buffer.from(id, 'utf8'));
  const ct = Buffer.concat([c.update(dek), c.final()]);
  return Buffer.concat([nonce, ct, c.getAuthTag()]).toString('base64');
}

test.afterEach(() => {
  useKeystore(null);
});

test('a finger on a row that was rewritten on disk while the dialog was up signs nothing and opens nothing', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-seal-touch-'));
  const keysPath = path.join(dataDir, 'keys', 'keys.json');
  const cfg: AppConfig = { mode: 'demo', keysPath, port: 4177, addresses: {}, candleProducts: [], dataDir };
  const audit = createAudit(dataDir);
  const store = createStore(dataDir);
  const ledger = createLedger(cfg);
  savePolicy(dataDir, happyPolicy());
  const keystore = createKeystore({ keysPath, kdf: () => ({ ...defaultParams(), N: 2 ** 14 }) });
  useKeystore(keystore);
  const transport = crypto.randomBytes(32);
  const vault = createVaultRelay({ transportKey: transport });
  const enclave = fakeEnclave();
  keystore.createWithEnclave(enclave.ref);
  keystore.lock();
  const svc = createProposalService({ cfg, audit, store, ledger, riskRows, dataDir, vault, keystore });
  assert.equal(await vault.next(0), null);
  assert.equal(vault.attached(), true);

  const p = await svc.proposePolicyChange({ patch: { outbound: { humanClickAboveUsd: 50 } }, sentence: 'ask me above fifty dollars' });
  const clicked = await svc.approve(p.id);
  assert.equal(clicked.status, 'awaiting_touch');
  const before = loadPolicy(dataDir);

  // The dialog is up. The local hand rewrites what the finger is about to approve.
  rewriteOnDisk(dataDir, p.id, (row) => {
    (row.draft as Extract<WriteDraft, { kind: 'policy_change' }>).patch = { outbound: { maxPerTransactionUsd: 1_000_000 } };
  });

  const request = await vault.next(1000);
  assert.ok(request !== null && request.op === 'unwrap');
  const dek = seUnwrapWithSoftwareKey({ ephemeralPublicKey: request.ephemeralPublicKey!, ciphertext: request.ciphertext! }, enclave.priv, Buffer.from(request.aad!, 'base64'));
  vault.answer({ id: request.id, ok: true, dekSealed: sealLikeTheSidecar(dek, request.id, transport) });
  await svc.settle(5000);

  assert.equal(store.get(p.id)?.status, 'awaiting_touch', 'the row is left as it is, not written back');
  assert.deepEqual(loadPolicy(dataDir), before, 'the policy did not change');
  assert.equal(keystore.state(), 'locked', 'the data key was dropped, not used');
  assert.ok(audit.tail(20).some((e) => e.type === 'approve_attempt_rejected' && (e.data as { action?: string }).action === 'touch'));
});
