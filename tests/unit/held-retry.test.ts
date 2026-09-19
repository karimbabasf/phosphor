// A hold lasts minutes, and the world moves while it lasts. The retry runs on the row the
// human approved, and against the policy as it is now: a row rewritten on disk is refused
// without a signature, and a kill switch flipped during the hold closes the row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import type { Preflight, Proposal, RailResult, WriteDraft } from '../../src/types.ts';
import { loadPolicy, savePolicy } from '../../src/policy/file.ts';
import { makeCtx, railThat } from './helpers/proposals.ts';

const FRIEND = '0xb583f41992Cd21b2F2345e194a36D33684BB5DB0';
const ATTACKER = '0x9999999999999999999999999999999999999999';

function preflightOf(verdict: Preflight['verdict']): Preflight {
  return {
    at: new Date().toISOString(),
    checks: [{ id: 'gas', label: 'Arbitrum gas', state: verdict === 'ok' ? 'ok' : 'fail', value: 'x', detail: 'x' }],
    verdict,
    ...(verdict === 'hold' ? { holdReason: 'Waiting for Arbitrum gas to settle' } : {}),
  };
}

function held(): RailResult {
  const preflight = preflightOf('hold');
  return { ok: false, held: true, detail: `${preflight.holdReason}. Nothing was signed.`, preflight };
}

async function until(read: () => Proposal | undefined, done: (p: Proposal) => boolean, ms = 3000): Promise<Proposal> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const p = read();
    if (p !== undefined && done(p)) return p;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`did not settle in ${ms} ms: ${JSON.stringify(read()?.status)}`);
}

function rewriteOnDisk(dataDir: string, id: string, change: (row: Proposal) => void): void {
  const file = path.join(dataDir, 'proposals.json');
  const rows = JSON.parse(fs.readFileSync(file, 'utf8')) as Proposal[];
  const row = rows.find((r) => r.id === id)!;
  change(row);
  fs.writeFileSync(file, JSON.stringify(rows, null, 2));
}

test('a held send whose row is rewritten on disk during the hold is not retried, and the rail never sees the stranger', async () => {
  let runs = 0;
  const seen: string[] = [];
  const rail = railThat('intents_pay', async (draft, _id, hooks) => {
    runs += 1;
    seen.push((draft as Extract<WriteDraft, { kind: 'intents_pay' }>).to);
    if (runs === 1) {
      const r = held();
      hooks?.onPreflight?.(r.preflight!);
      return r;
    }
    return { ok: true, detail: 'scripted payout', txids: ['0x' + 'ab'.repeat(32)], preflight: preflightOf('ok') };
  });
  const h = makeCtx({ rails: [rail], intentsUsdc: 1000, deps: { held: { retryMs: 150, maxMs: 10_000 } } });
  const p = await h.svc.proposeSend({ to: FRIEND, symbol: 'USDC', amount: 1, where: 'ethereum' });
  assert.equal(p.status, 'pending');
  await h.svc.approve(p.id);
  const heldRow = await until(() => h.store.get(p.id), (r) => r.status === 'approved' && r.heldSince !== undefined);
  assert.equal(runs, 1);
  assert.equal(h.store.intact(heldRow.id), true);

  rewriteOnDisk(h.dataDir, p.id, (row) => {
    (row.draft as Extract<WriteDraft, { kind: 'intents_pay' }>).to = ATTACKER;
  });
  assert.equal(h.store.intact(p.id), false, 'the store knows the row was rewritten');

  await until(() => h.store.get(p.id), () => h.eventTypes().includes('approve_attempt_rejected'), 3000);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(runs, 1, 'the rail ran once, on the hold, and never again');
  assert.deepEqual(seen, [FRIEND]);
  assert.equal(h.store.get(p.id)?.status, 'approved', 'nothing is written back over the rewritten row');
  assert.ok(!h.eventTypes().includes('executed'));
});

test('a kill switch flipped during a hold closes the row and the rail never runs again', async () => {
  let runs = 0;
  const rail = railThat('intents_pay', async (_draft, _id, hooks) => {
    runs += 1;
    if (runs === 1) {
      const r = held();
      hooks?.onPreflight?.(r.preflight!);
      return r;
    }
    return { ok: true, detail: 'scripted payout', txids: ['0x' + 'cd'.repeat(32)], preflight: preflightOf('ok') };
  });
  const h = makeCtx({ rails: [rail], intentsUsdc: 1000, deps: { held: { retryMs: 150, maxMs: 10_000 } } });
  const p = await h.svc.proposeSend({ to: FRIEND, symbol: 'USDC', amount: 1, where: 'ethereum' });
  await h.svc.approve(p.id);
  await until(() => h.store.get(p.id), (r) => r.status === 'approved' && r.heldSince !== undefined);

  const policy = loadPolicy(h.dataDir)!;
  policy.killSwitch = true;
  savePolicy(h.dataDir, policy);

  const done = await until(() => h.store.get(p.id), (r) => r.status === 'policy_refused' || r.status === 'executed' || r.status === 'failed', 3000);
  assert.equal(done.status, 'policy_refused', 'a kill switch flipped during the hold stops the retry');
  assert.equal(done.verdict?.outcome === 'refuse' ? done.verdict.rule : undefined, 'kill_switch');
  assert.equal(done.heldSince, undefined);
  assert.equal(runs, 1, 'the rail must not run again after the kill switch');
  assert.ok(h.eventTypes().includes('policy_refused'));
});
