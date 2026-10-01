// The demo invite world (src/invite/demo.ts): what lets scripts/invite-window-proof.ts photograph
// every state an invite has through the app's own routes, claim and frames. It is read in demo
// mode with the file named and nowhere else, and it never reaches the network: the claim runs in
// memory.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createInviteService } from '../../src/invite/claim.ts';
import { codeAddress, formatCode } from '../../src/invite/code.ts';
import { DEMO_INVITE_ENV, demoInviteNet } from '../../src/invite/demo.ts';

const WALLET = '0x9858effd232b4033e47d90003d41ec34ecaeda94';
const secret = (byte: number): Uint8Array => new Uint8Array(16).fill(byte);
const CODES = { good: 0x42, used: 0x43, locked: 0x44, offline: 0x45, refused: 0x47 } as const;
const code = (name: keyof typeof CODES): string => formatCode(secret(CODES[name]));
const account = (name: keyof typeof CODES): string => codeAddress(secret(CODES[name]))!;

function fixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-invite-demo-'));
  const file = path.join(dir, 'invite.json');
  fs.writeFileSync(file, JSON.stringify({
    accounts: {
      [account('good')]: { usdc: '5.00', landMs: 20 },
      [account('locked')]: { usdc: '5.00', locked: true },
      [account('offline')]: { usdc: '5.00', offline: true },
      [account('refused')]: { usdc: '5.00', refusal: 'insufficient balance or overflow' },
    },
  }));
  return file;
}

test('the demo world is read in demo mode with the file named, and never in live mode', () => {
  const file = fixture();
  assert.equal(demoInviteNet('live', { [DEMO_INVITE_ENV]: file }), null, 'live mode read the demo world');
  assert.equal(demoInviteNet('demo', {}), null);
  assert.equal(demoInviteNet('demo', { [DEMO_INVITE_ENV]: '' }), null);
  assert.equal(demoInviteNet('demo', { [DEMO_INVITE_ENV]: path.join(path.dirname(file), 'missing.json') }), null);
  assert.ok(demoInviteNet('demo', { [DEMO_INVITE_ENV]: file }));
});

test('every check answer and both claim ends come out of the demo world, and nothing reaches the network', async () => {
  const net = demoInviteNet('demo', { [DEMO_INVITE_ENV]: fixture() })!;
  const frames: Array<Record<string, unknown>> = [];
  const real = globalThis.fetch;
  globalThis.fetch = (() => Promise.reject(new Error('the demo world reached the network'))) as typeof fetch;
  try {
    const service = createInviteService({
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-invite-demo-')),
      movesMoney: true,
      audit: { append: (type, msg, data) => ({ ts: '', type, msg, data }) },
      keystore: {
        state: () => 'unlocked',
        addressReport: () => ({ addresses: { evm: WALLET, solana: null, near: null, nearPublicKey: null }, verified: true, tampered: false }),
      },
      broadcast: (frame) => frames.push(frame as Record<string, unknown>),
      broadcastState: () => {},
      refreshLedger: async () => {},
      ...net,
      firstPollMs: 10,
      pollMs: 10,
    });

    assert.deepEqual(await service.check(code('good')), { ok: true, amount: '5.00', asset: 'USDC', route: 'relay', net: '5.00' });
    assert.deepEqual(await service.check(code('used')), { ok: false, reason: 'empty' });
    assert.deepEqual(await service.check(code('locked')), { ok: false, reason: 'locked' });
    assert.deepEqual(await service.check(code('offline')), { ok: false, reason: 'offline' });
    assert.deepEqual(await service.check(code('good').slice(0, -1) + (code('good').endsWith('0') ? '1' : '0')), { ok: false, reason: 'typo' });

    const landed = await service.claim(code('good'));
    assert.equal(landed.ok, true);
    await service.idle();
    assert.deepEqual(await service.check(code('good')), { ok: false, reason: 'empty' }, 'a landed code still holds money');

    const refused = await service.claim(code('refused'));
    assert.equal(refused.ok, true);
    await service.idle();

    const ends = frames.filter((f) => f.status !== 'running').map((f) => [f.type, f.status, f.amount]);
    assert.deepEqual(ends, [['invite', 'landed', '5.00'], ['invite', 'failed', '5.00']]);
  } finally {
    globalThis.fetch = real;
  }
});
