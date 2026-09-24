// What the agent reads and a person sees, in plain words (2026-09-23, seen live).
//
// An unconfirmed row said "Don't send it again": the balance check and the cap already stop a
// double spend, so the words only frightened. A row watching a transfer 1Click signed for 72 hours
// said "a few minutes". And the propose reply the agent reads out carried "solver floor 3806395
// base units ... signs one intent with the EVM key": the engineer's lines now ride on a field the
// reply leaves out, and the summary says what arrives, the least, the fee and the time.
//
// Run: node --test tests/unit/swap-plain-words.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Proposal, Rail, WriteDraft } from '../../src/types.ts';
import { REASON_CODES } from '../../src/rails/reasons.ts';
import { swapSummary } from '../../src/rails/asset-words.ts';
import { proposalView, reasonSentence, watchWords } from '../../src/proposals/view.ts';
import { makeCtx, railThat } from './helpers/proposals.ts';
import { makeHttp } from './helpers/http.ts';

const SELF = '0x1111111111111111111111111111111111111111';
const NEAR_SWAP: WriteDraft = {
  kind: 'swap',
  venue: 'intents-native',
  chain: 'near',
  toChain: 'near',
  fromSymbol: 'wNEAR',
  toSymbol: 'USDC',
  amountIn: 0.8946970287783748,
  amountInExact: '0.894697028778374732410224',
  amountUsd: 3.9,
  minAmountOut: 3.78726,
  from: SELF,
  to: SELF,
  counterparty: 'intents.near',
  quote: null,
};

// ---------- no "send it again" ----------

test('no sentence tells a person not to send it again, and an unconfirmed row says it is still checking', () => {
  for (const code of REASON_CODES) assert.doesNotMatch(reasonSentence(code, NEAR_SWAP), /send it again|don't send/i, code);
  assert.equal(reasonSentence('stuck_unknown', NEAR_SWAP), "Still checking whether this went through. I'll update it here.");
});

// ---------- how long a row watches ----------

test('a watching row says a few minutes only when it is minutes, and how long in words when it is not', () => {
  const now = Date.parse('2026-09-23T20:00:00.000Z');
  const at = (ms: number) => new Date(now + ms).toISOString();
  assert.equal(watchWords(at(3 * 60_000), now), 'for a few minutes');
  assert.equal(watchWords(at(40 * 60_000), now), 'until it can no longer run, in about 40 minutes');
  assert.equal(watchWords(at(5 * 3_600_000), now), 'until it can no longer run, in about 5 hours');
  assert.equal(watchWords(at(72 * 3_600_000), now), 'until it can no longer run, in about 3 days');
  assert.equal(watchWords(undefined, now), 'until it can no longer run');

  const row: Proposal = {
    id: 'w-1',
    kind: 'swap',
    createdAt: at(-60_000),
    status: 'needs_reconciliation',
    draft: NEAR_SWAP,
    simulation: null,
    verdict: { outcome: 'allow', reasons: [] },
    result: { ok: false, detail: '1click reported FAILED', txids: ['h'], reason: 'venue_failed_watching', evidence: { handle: 'dep-1', providerStage: 'FAILED', deadline: at(72 * 3_600_000) } },
  };
  const v = proposalView({ settle: (p) => p }, row, now);
  assert.equal(v.reason?.sentence, "The swap didn't go through. Your NEAR hasn't moved; I'm keeping an eye on it until it can no longer run, in about 3 days.");
});

// ---------- the summary the agent reads ----------

test('a swap summary is what arrives, the least, the fee and the time, in five figures', () => {
  assert.equal(
    swapSummary({ receives: '3.825523', receivesAtLeast: '3.806395', feeUsd: 0.0132, etaSeconds: 12 }, 'USDC'),
    'About 3.8255 USDC, at least 3.8064. Fee about $0.01, about 12 seconds.',
  );
  assert.equal(swapSummary({ receives: '0.894697', receivesAtLeast: '0.89', feeUsd: null, etaSeconds: null }, 'wNEAR'), 'About 0.8947 NEAR, at least 0.89.');
  assert.equal(swapSummary({ receives: '1', receivesAtLeast: '0.99', feeUsd: 0.001, etaSeconds: 150 }, 'USDC'), 'About 1 USDC, at least 0.99. Fee under a cent, about 3 minutes.');
});

test('the propose reply carries the plain summary and leaves the engineer\'s lines on the row', async () => {
  const plain = 'About 3.8255 USDC, at least 3.8064. Fee about $0.01, about 12 seconds.';
  const engineer = 'fee $0.0132, eta ~12s, solver floor 3806395 base units, draft floor 3.78726 USDC';
  const rail: Rail = {
    ...railThat('swap', async () => ({ ok: true, detail: 'swapped', txids: ['h'] })),
    simulate: async () => ({ ok: true, summary: plain, developer: engineer }),
  };
  const h = makeCtx({ rails: [rail] });
  const door = makeHttp({ proposals: h.svc, dataDir: h.dataDir });
  const reply = await door.post('swap', { chain: 'arb', fromSymbol: 'USDT', toSymbol: 'USDC', amountIn: '10', minAmountOut: 9.9 });
  assert.equal(reply.status, 200, JSON.stringify(reply.json));
  const sim = reply.json.simulation as Record<string, unknown>;
  assert.equal(sim.summary, plain);
  assert.equal('developer' in sim, false, 'the agent never reads the engineer\'s lines');
  assert.equal(h.store.get(String(reply.json.id))?.simulation?.developer, engineer, 'the row keeps them for the log');
});
