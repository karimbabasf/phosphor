// A second agent repeating a move is told which row it repeats, never where that row was paid.
//
// The duplicate guard's refusal used to carry the first row's whole result, and the quote on it
// holds the deposit address 1Click minted for that one move: an address a confused or hostile
// agent could hand the person as "send here to finish it". diagnose already fingerprinted it.
// The refusal now carries the view proposal_status hands back, and every agent read of a view
// (proposal_status, proposals, diagnose) fingerprints that address wherever a rail's sentence
// names it. The window's card keeps it whole. (Fix round 2, 2026-10-01.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type http from 'node:http';

import { makeCtx, railThat } from './helpers/proposals.ts';
import { makeHttp } from './helpers/http.ts';
import { fingerprint, walletReads } from '../../src/http/read/wallet.ts';
import type { Ctx } from '../../src/http/context.ts';
import type { RailResult } from '../../src/types.ts';

// An EVM deposit address (the hl_withdraw route's shape) and a NEAR implicit one (every route
// that pays from inside NEAR Intents), each the address of one quote.
const EVM_DEPOSIT = '0x9a3c51e0bb27d4f86c0d1e2f3a4b5c6d7e8f9012';
const NEAR_DEPOSIT = '5f2c'.repeat(16);
const SIGNATURE = 'ed25519:quote-signature-under-test';

function unconfirmed(deposit: string): () => Promise<RailResult> {
  return async () => ({
    ok: false,
    detail: `1click reported SUCCESS but the venue has not shown it; quote handle ${deposit}.`,
    txids: ['intent-h1'],
    evidence: { handle: deposit, quote: { correlationId: 'corr-under-test', timestamp: '2026-10-01T10:00:00.000Z', signature: SIGNATURE, depositAddress: deposit } },
  });
}

function captured(): { res: http.ServerResponse; json: () => Record<string, unknown> } {
  let text = '';
  const res = {
    setHeader() {},
    writeHead() {
      return res;
    },
    end(chunk?: unknown) {
      text = String(chunk ?? '');
    },
  } as unknown as http.ServerResponse;
  return { res, json: () => JSON.parse(text) as Record<string, unknown> };
}

async function read(ctx: Ctx, tool: 'proposal_status' | 'proposals' | 'diagnose', args: Record<string, unknown>): Promise<string> {
  const out = captured();
  await walletReads[tool](ctx, { session: 'agent-b' }, args, out.res);
  return JSON.stringify(out.json());
}

for (const deposit of [EVM_DEPOSIT, NEAR_DEPOSIT]) {
  test(`regression: the refusal a second agent gets names the first row and not its deposit address (${deposit.slice(0, 4)})`, async () => {
    const h = makeCtx({ rails: [railThat('hl_deposit', unconfirmed(deposit))] });
    const door = makeHttp({ proposals: h.svc, dataDir: h.dataDir });
    const first = await door.post('hl_deposit', { amount: 10 }, 'agent-a');
    assert.equal(first.status, 200, JSON.stringify(first.json));
    await h.svc.settle(5_000);
    assert.equal(h.store.get(String(first.json.id))?.status, 'needs_reconciliation');
    assert.equal(h.store.get(String(first.json.id))?.result?.evidence?.quote?.depositAddress, deposit, 'the row keeps it whole');

    const second = await door.post('hl_deposit', { amount: 10 }, 'agent-b');
    assert.equal(second.status, 409, JSON.stringify(second.json));
    assert.equal(second.json.duplicate, first.json.id);
    assert.equal(second.json.status, 'needs_reconciliation');
    const said = JSON.stringify(second.json);
    assert.equal(said.includes(deposit), false, `the deposit address reached the second agent: ${said}`);
    assert.equal(said.includes(SIGNATURE), false, "1Click's signature over the quote reached the second agent");
    assert.equal((second.json.view as { id?: unknown } | undefined)?.id, first.json.id, 'the refusal carries the row as proposal_status reads it');
    // Cut to its two ends, the fingerprint's or the card's 64-hex cut, still there to quote to support.
    assert.ok(said.includes(fingerprint(deposit)) || said.includes(`${deposit.slice(0, 8)}...${deposit.slice(-8)}`), said);
    assert.equal(h.store.list().length, 1, 'one row, not two');

    // The other doors to the same row, for the same second agent.
    const ctx = { ...door.ctx, ledger: { hyperliquid: () => undefined } } as unknown as Ctx;
    const id = String(first.json.id);
    for (const [tool, args] of [['proposal_status', { id }], ['proposals', {}], ['diagnose', { id }]] as const) {
      const text = await read(ctx, tool, args);
      assert.equal(text.includes(deposit), false, `${tool} handed over the deposit address: ${text}`);
      assert.equal(text.includes(SIGNATURE), false, `${tool} handed over the quote's signature`);
    }
  });
}

test('the intent hash a relay row names its handle by stays whole: it is evidence, not a destination', async () => {
  const hash = `0x${'c'.repeat(64)}`;
  const h = makeCtx({
    rails: [railThat('hl_deposit', async () => ({ ok: false, detail: `the relay has not settled intent ${hash} yet.`, txids: [hash], evidence: { handle: hash } }))],
  });
  const door = makeHttp({ proposals: h.svc, dataDir: h.dataDir });
  const first = await door.post('hl_deposit', { amount: 10 }, 'agent-a');
  await h.svc.settle(5_000);
  const text = await read(door.ctx as unknown as Ctx, 'proposal_status', { id: String(first.json.id) });
  assert.equal(text.includes(hash), true, text);
});
