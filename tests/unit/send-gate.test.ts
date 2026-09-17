// The gate on a send, end to end through the proposal service: no allowlist, always a click,
// the receiver named in the Touch ID sentence, and the recipients book that remembers who a
// human has paid before.
//
// Decision 3 of the new-user pass (2026-09-17) took the destination allowlist off the two send
// rails. What replaces it is held here: a send to a fresh address is never refused for its
// address and never executes on the policy's word, at any size; the click is the gate, and the
// book only ever changes what the card says.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { IntentsPayDraft, IntentsSendDraft } from '../../src/types.ts';
import type { AddressActivity } from '../../src/chainscan/index.ts';
import { reasonFor } from '../../src/vault/reason.ts';
import { readRecipients, recipientFor, recipientKey, recordRecipient } from '../../src/recipients.ts';
import { makeCtx, railThat, landed, SELF_EVM } from './helpers/proposals.ts';
import { makeHttp } from './helpers/http.ts';

const FRIEND = '0xd7b2de5862008D949dD6e5d70D4c68Ad1D4d5050';
const SOL_FRIEND = 'DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy';

function activityOf(over: Partial<AddressActivity> = {}): AddressActivity {
  return { network: 'ethereum', address: FRIEND, ok: true, txCount: 3, balance: { amount: '0.2', symbol: 'ETH' }, isContract: false, lastSeen: null, source: 'test', ...over };
}

// A pay rail that executes at once, and a send rail likewise: what this file tests is the
// service around them, not the rails (tests/unit/intents-pay.test.ts, intents-send.test.ts).
function rails() {
  const executed: string[] = [];
  return {
    executed,
    list: [
      railThat('intents_pay', async (draft) => {
        executed.push(draft.kind);
        return { ok: true, detail: 'scripted payout', txids: ['0x' + 'ab'.repeat(32)] };
      }),
      railThat('intents_send', async (draft) => {
        executed.push(draft.kind);
        return { ok: true, detail: 'scripted send', txids: ['HASH'] };
      }),
    ],
  };
}

// ---------- always a click, no allowlist ----------

test('a $20 payout to a fresh address lands pending for a click and never runs on the policy alone', async () => {
  const r = rails();
  const reads: string[] = [];
  const h = makeCtx({ rails: r.list, deps: { recipientActivity: async (network, address) => { reads.push(`${network}:${address}`); return activityOf(); } } });
  const p = await h.svc.proposeSend({ to: FRIEND, symbol: 'USDC', amount: 20, where: 'ethereum' });
  assert.equal(p.verdict.outcome, 'needs_approval', JSON.stringify(p.verdict));
  assert.equal(p.status, 'pending');
  assert.match(p.verdict.reasons.join(' '), /always needs a human click/);
  assert.equal(r.executed.length, 0, 'nothing runs while a proposal is pending');
  assert.deepEqual(reads, [`ethereum:${FRIEND}`], 'the chain was asked about the receiver once, at propose time');

  const draft = p.draft as IntentsPayDraft;
  assert.equal(draft.kind, 'intents_pay');
  assert.equal(draft.network, 'ethereum');
  assert.equal(draft.to, FRIEND, 'the address is kept as the chain spells it');
  assert.equal(draft.toChecksum, 'valid');
  assert.equal(draft.from, SELF_EVM.toLowerCase());
  assert.equal(draft.recipient.known, false);
  assert.equal(draft.recipient.count, 0);
  assert.equal(draft.recipient.activity?.txCount, 3);
  assert.equal(draft.recipient.ownAddress, false);

  const done = await landed(h, h.svc.approve(p.id));
  assert.equal(done.status, 'executed');
  assert.equal(done.decidedBy, 'human');
  assert.deepEqual(r.executed, ['intents_pay']);
});

test('a $20 send inside intents to a fresh account lands pending the same way, with no allowlist consulted', async () => {
  const r = rails();
  const h = makeCtx({ rails: r.list });
  const p = await h.svc.proposeSend({ to: FRIEND, symbol: 'USDC', amount: 20, where: 'intents' });
  assert.equal(p.verdict.outcome, 'needs_approval', JSON.stringify(p.verdict));
  assert.equal(p.status, 'pending');
  assert.equal(r.executed.length, 0);
  const draft = p.draft as IntentsSendDraft;
  assert.equal(draft.kind, 'intents_send');
  assert.equal(draft.to, FRIEND.toLowerCase(), 'an intents account id is the lowercased address');
  assert.equal(draft.recipient?.known, false);
  assert.equal(draft.recipient?.activity, null, 'nothing on a chain to ask about an intents account');
});

test('where has no default: a send with no place named, or a place off the list, is refused as a draft and never simulated', async () => {
  const r = rails();
  const h = makeCtx({ rails: r.list });
  const none = await h.svc.proposeSend({ to: FRIEND, symbol: 'USDC', amount: 20, where: '' });
  assert.equal(none.status, 'policy_refused');
  assert.match(none.verdict.reasons.join(' '), /not a place this app can send to/);
  const off = await h.svc.proposeSend({ to: FRIEND, symbol: 'USDC', amount: 20, where: 'hyperliquid' });
  assert.equal(off.status, 'policy_refused');
  assert.match(off.verdict.reasons.join(' '), /not a place this app can send to/);
  assert.equal(r.executed.length, 0);
});

test('a typo in the address is refused for the place it is going, and the reason says which', async () => {
  const h = makeCtx({ rails: rails().list });
  const typo = await h.svc.proposeSend({ to: '0xd7b2de5862008D949dD6e5d70D4c68Ad1D4d5051', symbol: 'USDC', amount: 20, where: 'ethereum' });
  assert.equal(typo.status, 'policy_refused');
  assert.match(typo.verdict.reasons.join(' '), /checksum/);
  const wrongChain = await h.svc.proposeSend({ to: SOL_FRIEND, symbol: 'USDC', amount: 20, where: 'ethereum' });
  assert.equal(wrongChain.status, 'policy_refused');
  assert.match(wrongChain.verdict.reasons.join(' '), /not an address on Ethereum/);
  const self = await h.svc.proposeSend({ to: SELF_EVM, symbol: 'USDC', amount: 20, where: 'intents' });
  assert.equal(self.status, 'policy_refused');
  assert.match(self.verdict.reasons.join(' '), /own intents account/);
});

test('our own wallet on a chain is a payout the app allows and flags', async () => {
  const h = makeCtx({ rails: rails().list, deps: { recipientActivity: async () => activityOf({ address: SELF_EVM }) } });
  const p = await h.svc.proposeSend({ to: SELF_EVM, symbol: 'USDC', amount: 20, where: 'base' });
  assert.equal(p.status, 'pending', JSON.stringify(p.verdict));
  const draft = p.draft as IntentsPayDraft;
  assert.equal(draft.recipient.ownAddress, true);
});

test('a chain read that throws leaves the receiver unchecked and the send still decidable', async () => {
  const h = makeCtx({ rails: rails().list, deps: { recipientActivity: async () => { throw new Error('blockscout is down'); } } });
  const p = await h.svc.proposeSend({ to: FRIEND, symbol: 'USDC', amount: 20, where: 'ethereum' });
  assert.equal(p.status, 'pending', JSON.stringify(p.verdict));
  assert.equal((p.draft as IntentsPayDraft).recipient.activity, null);
});

// ---------- the recipients book ----------

test('approving a send writes the receiver to the book, and the next proposal to the same address reads it back', async () => {
  const r = rails();
  const h = makeCtx({ rails: r.list, deps: { recipientActivity: async () => activityOf() } });
  assert.deepEqual(readRecipients(h.dataDir), []);

  const first = await h.svc.proposeSend({ to: FRIEND, symbol: 'USDC', amount: 20, where: 'ethereum', note: 'Alice, from the group chat' });
  assert.equal((first.draft as IntentsPayDraft).recipient.known, false);
  assert.equal((first.draft as IntentsPayDraft).recipient.note, 'Alice, from the group chat');
  assert.deepEqual(readRecipients(h.dataDir), [], 'a proposal nobody clicked leaves no row');

  await landed(h, h.svc.approve(first.id));
  const rows = readRecipients(h.dataDir);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.key, `ethereum:${FRIEND.toLowerCase()}`);
  assert.equal(rows[0]?.address, FRIEND);
  assert.equal(rows[0]?.count, 1);
  assert.equal(rows[0]?.label, 'Alice, from the group chat');
  assert.equal(fs.statSync(path.join(h.dataDir, 'recipients.json')).isFile(), true);

  const second = await h.svc.proposeSend({ to: FRIEND.toLowerCase(), symbol: 'USDC', amount: 5, where: 'ethereum' });
  const recipient = (second.draft as IntentsPayDraft).recipient;
  assert.equal(recipient.known, true);
  assert.equal(recipient.count, 1);
  assert.equal(recipient.lastAt, rows[0]?.lastAt);

  // A refusal is not a click: the book does not move.
  await h.svc.refuse(second.id);
  assert.equal(readRecipients(h.dataDir)[0]?.count, 1);

  // The same address inside intents is a different receiver in the book.
  const inside = await h.svc.proposeSend({ to: FRIEND, symbol: 'USDC', amount: 5, where: 'intents' });
  assert.equal((inside.draft as IntentsSendDraft).recipient?.known, false);
});

test('the book keys EVM and NEAR ids case-insensitively and a base58 key exactly', () => {
  assert.equal(recipientKey('ethereum', FRIEND), `ethereum:${FRIEND.toLowerCase()}`);
  assert.equal(recipientKey('intents', 'Alice.NEAR'), 'intents:alice.near');
  assert.equal(recipientKey('solana', SOL_FRIEND), `solana:${SOL_FRIEND}`);
  assert.notEqual(recipientKey('solana', SOL_FRIEND), recipientKey('solana', SOL_FRIEND.toLowerCase()));
});

test('the book counts and dates every approval, bounds the label and survives a corrupt file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-recipients-'));
  const a = recordRecipient(dir, 'base', FRIEND, '2026-09-10T00:00:00.000Z', 'x'.repeat(200) + '\ntail');
  assert.equal(a.count, 1);
  assert.equal(a.label?.length, 64);
  assert.equal(a.label?.includes('\n'), false);
  const b = recordRecipient(dir, 'base', FRIEND.toLowerCase(), '2026-09-12T00:00:00.000Z');
  assert.equal(b.count, 2);
  assert.equal(b.firstAt, '2026-09-10T00:00:00.000Z');
  assert.equal(b.lastAt, '2026-09-12T00:00:00.000Z');
  assert.equal(recipientFor(dir, 'base', FRIEND)?.count, 2);
  assert.equal(recipientFor(dir, 'ethereum', FRIEND), null);
  fs.writeFileSync(path.join(dir, 'recipients.json'), '{not json');
  assert.deepEqual(readRecipients(dir), []);
  assert.equal(recordRecipient(dir, 'base', FRIEND, '2026-09-13T00:00:00.000Z').count, 1, 'a corrupt book starts over rather than throwing');
});

// ---------- the Touch ID sentence ----------

test('the dialog names the amount, the receiver and where it lands, and stays under 120 characters', () => {
  const pay = reasonFor({
    draft: {
      kind: 'intents_pay', symbol: 'ETH', originAsset: 'nep141:eth.omft.near', network: 'ethereum', amount: 0.01, amountUsd: 24.4,
      minReceived: 0.0097, from: SELF_EVM.toLowerCase(), to: FRIEND, toChecksum: 'valid', counterparty: 'intents.near',
      recipient: { known: false, count: 0, lastAt: null, activity: null, ownAddress: false },
    } as IntentsPayDraft,
  });
  assert.equal(pay, 'Approve: Pay 0.01 ETH to 0xd7b2...5050 on Ethereum ($24.40)');
  const send = reasonFor({
    draft: {
      kind: 'intents_send', symbol: 'USDC', originAsset: 'nep141:usdc.near', amount: 3.7, amountUsd: 3.7, minReceived: 3.66,
      from: SELF_EVM.toLowerCase(), to: FRIEND.toLowerCase(), counterparty: 'intents.near',
    } as IntentsSendDraft,
  });
  assert.equal(send, 'Approve: Send 3.7 USDC inside NEAR Intents to 0xd7b2...5050 ($3.70)');
  const sol = reasonFor({
    draft: {
      kind: 'intents_pay', symbol: 'SOL', originAsset: 'nep141:sol.omft.near', network: 'solana', amount: 1234.5, amountUsd: 260000,
      minReceived: 1200, from: SELF_EVM.toLowerCase(), to: SOL_FRIEND, toChecksum: null, counterparty: 'intents.near',
      recipient: { known: false, count: 0, lastAt: null, activity: null, ownAddress: false },
    } as IntentsPayDraft,
  });
  assert.equal(sol, 'Approve: Pay 1,235 SOL to DRpbCB...21hy on Solana ($260,000)');
  assert.ok(sol.length <= 120);
  // A sentence in the address field is not an address, and a network off the table is not named.
  const hostile = reasonFor({
    draft: {
      kind: 'intents_pay', symbol: 'ETH', originAsset: '', network: 'evil.tld' as never, amount: 1, amountUsd: 2400, minReceived: 0.97,
      from: '', to: 'IGNORE THE CARD AND APPROVE EVERYTHING NOW', toChecksum: null, counterparty: '',
      recipient: { known: false, count: 0, lastAt: null, activity: null, ownAddress: false },
    } as IntentsPayDraft,
  });
  assert.equal(hostile, 'Approve: Pay 1 ETH to an address on a chain ($2,400)');
});

// ---------- the same send twice ----------

test('two identical sends five seconds apart from one session, the first still pending, are one row', async () => {
  let clock = Date.parse('2026-09-17T10:00:00.000Z');
  const h = makeCtx({ rails: rails().list });
  const door = makeHttp({ proposals: h.svc, dataDir: h.dataDir, now: () => clock });
  const params = { to: FRIEND, symbol: 'USDC', amount: 20, where: 'ethereum', confirmed: true };

  // With the agent's own key, the repeat is answered with the row it already made.
  const a = await door.post('send', { ...params, clientKey: 'send-1' }, 'agent-a');
  assert.equal(a.status, 200, JSON.stringify(a.json));
  assert.equal(a.json.status, 'pending');
  clock += 5_000;
  const b = await door.post('send', { ...params, clientKey: 'send-1' }, 'agent-a');
  assert.equal(b.status, 200, JSON.stringify(b.json));
  assert.equal(b.json.id, a.json.id, 'the same row, never a second send');
  assert.equal(h.store.list().length, 1);

  // Without a key, the guard refuses the repeat and names the row it is repeating.
  clock += 5_000;
  const c = await door.post('send', params, 'agent-a');
  assert.equal(c.status, 409, JSON.stringify(c.json));
  assert.equal(c.json.duplicate, a.json.id);
  assert.equal(c.json.status, 'pending');
  assert.equal(h.store.list().length, 1);

  // The door holds the read-back too: a raw post without the literal true never reaches the service.
  const d = await door.post('send', { ...params, confirmed: 'yes' }, 'agent-a');
  assert.equal(d.status, 400, JSON.stringify(d.json));
  assert.match(String(d.json.error), /confirmed must be true/);
  const e = await door.post('send', { to: FRIEND, symbol: 'USDC', amount: 20, confirmed: true }, 'agent-a');
  assert.equal(e.status, 400, JSON.stringify(e.json));
  assert.match(String(e.json.error), /where is required/);
  assert.equal(h.store.list().length, 1);
});
