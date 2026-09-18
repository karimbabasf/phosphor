// The list behind proposal_status: ordering, the cap, and the kind filter.
//
// It exists because nothing enumerated. An agent asked "show me my last deposit" had to find an
// id in the audit log or ask the person for a uuid about their own money, and asking somebody
// that is the app failing to know its own state.

import test from 'node:test';
import assert from 'node:assert/strict';
import type http from 'node:http';

import { walletReads } from '../../src/http/read/wallet.ts';
import { PROPOSALS_MAX } from '../../src/http/read/wallet.ts';
import type { Ctx } from '../../src/http/context.ts';
import type { Proposal } from '../../src/types.ts';
import { proposalView } from '../../src/proposals/view.ts';
import type { ProposalView } from '../../src/proposals/view.ts';

function captured(): { res: http.ServerResponse; body: () => unknown } {
  let text = '';
  const res = {
    writeHead() {
      return res;
    },
    end(chunk?: unknown) {
      text = String(chunk ?? '');
    },
  } as unknown as http.ServerResponse;
  return { res, body: () => JSON.parse(text) };
}

function row(id: string, kind: Proposal['kind'], minutesAgo: number): Proposal {
  const at = new Date(Date.parse('2026-09-18T12:00:00.000Z') - minutesAgo * 60_000).toISOString();
  return {
    id,
    kind,
    createdAt: at,
    status: 'executed',
    draft:
      kind === 'hl_deposit'
        ? { kind: 'hl_deposit', symbol: 'USDC', originAsset: 'a', amount: 5, amountUsd: 5, minCredited: 5, from: '0x1', hlAccount: '0x1', counterparty: 'hypercore' }
        : { kind: 'policy_change', patch: {}, sentence: 'Ask me above $100.' },
    simulation: null,
    verdict: { outcome: 'allow', reasons: [] },
  };
}

function ctxWith(rows: Proposal[]): Ctx {
  return {
    proposals: {
      list: () => rows,
      view: (p: Proposal, now?: number) => proposalView({ settle: (r) => r }, p, now),
    },
  } as unknown as Ctx;
}

async function list(rows: Proposal[], args: Record<string, unknown>): Promise<ProposalView[]> {
  const a = captured();
  await walletReads.proposals(ctxWith(rows), {}, args, a.res);
  return (a.body() as { proposals: ProposalView[] }).proposals;
}

test('newest first, whatever order the store holds them in', async () => {
  const rows = [row('old', 'hl_deposit', 30), row('new', 'hl_deposit', 1), row('middle', 'hl_deposit', 10)];
  assert.deepEqual((await list(rows, {})).map((v) => v.id), ['new', 'middle', 'old']);
});

test('the limit defaults to ten and is clamped to fifty', async () => {
  const rows = Array.from({ length: 80 }, (_, i) => row(`p${i}`, 'hl_deposit', i));
  assert.equal((await list(rows, {})).length, 10);
  assert.equal((await list(rows, { limit: 3 })).length, 3);
  assert.equal((await list(rows, { limit: 500 })).length, PROPOSALS_MAX);
  // Nonsense falls back to the default rather than answering with nothing.
  assert.equal((await list(rows, { limit: -4 })).length, 10);
});

test('kind filters to one rail and an unknown kind is an empty list, never everything', async () => {
  const rows = [row('d', 'hl_deposit', 1), row('p', 'policy_change', 2)];
  assert.deepEqual((await list(rows, { kind: 'hl_deposit' })).map((v) => v.id), ['d']);
  assert.deepEqual((await list(rows, { kind: 'policy_change' })).map((v) => v.id), ['p']);
  assert.deepEqual(await list(rows, { kind: 'lp_add' }), []);
});

test('every row is the same object proposal_status hands back', async () => {
  const [view] = await list([row('d', 'hl_deposit', 1)], {});
  assert.equal(view.stage, 'confirmed');
  assert.equal(view.stageLabel, 'Confirmed');
  assert.equal(view.terminal, true);
  assert.equal(view.money.fromPocket, 'NEAR Intents');
});

test('the whole page shares one clock, so two rows cannot disagree about now', async () => {
  const views = await list([row('a', 'hl_deposit', 1), row('b', 'hl_deposit', 1)], {});
  assert.equal(views[0].elapsedSec, views[1].elapsedSec);
});
