// How every situation is reached: one small function per row, grouped into scenes that share a
// boot (a walk is one proposal seen at several moments, so its rows share one scene).
//
// Stages are driven through KIND_STAGES and the demo rail's words (src/proposals/view.ts,
// src/rails/demo.ts), never a list kept here: a walk waits for the stage word the row names and
// shoots when the view says so. A state the demo rails cannot walk into (a relay word, a vendor
// FAILED, a stalled row past its deadline) is seeded as the row the app would hold at that
// moment and read back through the agent, which is what draws its card. A state the demo
// cannot hold at all (Touch ID, the signing tick) is marked not reachable in the situation
// file, with the reason, and appears in the table as such rather than as a silent skip.
//
// The reply the judge reads is what the assistant last said in the chat at the moment of the
// shot: the scripted decision line after a propose (the view's sentence and STAGE_COPY, at most
// three sentences), or the one ending sentence the agent writes when the app tells it a move
// ended. Nothing is narrated mid-walk, because the role text says the card moves live and the
// agent stays silent unless asked (criteria 5.5 and 8.4).

import fs from 'node:fs';
import path from 'node:path';
import { STAGE_COPY } from '../../src/proposals/view.ts';
import type { App, Seed } from './app.ts';
import type { Clip, Page } from './capture.ts';
import type { Turn } from './agent.ts';
import { ROOT } from './app.ts';

export type Sample = {
  row: string;
  run: number;
  // The stage the view held when the shot was taken, for the JSON beside the picture.
  stage: string | null;
  reply: string;
  shots: Array<{ file: string; width: number }>;
  note?: string;
};

export type SceneCtx = {
  app: App;
  page: Page;
  run: number;
  log(line: string): void;
  // Takes the shots for a row at this moment. `stage` names what the view must still say after
  // the shots; a stage that moved during them is a missed sample, recorded and not judged.
  capture(row: string, opts?: { stage?: string | string[]; id?: string; clip?: Clip; reply?: string; note?: string }): Promise<Sample | null>;
  unreachable(row: string, reason: string): void;
  // The chat's last assistant line, read off the transcript.
  lastReply(): Promise<string>;
  // How many turns the chat has completed, so an ending turn can be waited for by count rather
  // than by a text diff (the ending notice fires on the terminal write, which races the reply
  // that was already on screen).
  turnCount(): Promise<number>;
  // Waits until the chat has completed more than `sinceCount` turns, then returns the last
  // turn's text: the ending sentence the app's notice made the agent write.
  endingAfter(sinceCount: number, timeoutMs?: number): Promise<string>;
};

export type Scene = {
  id: string;
  rows: string[];
  seed: Seed;
  play(ctx: SceneCtx): Promise<void>;
};

// ---------- the words ----------

const DEMO_ACCOUNT = '0x1111111111111111111111111111111111111111';
const USDC_ETH = 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near';
const FRIEND_INTENTS = 'alice.near';
const FRIEND_BASE = '0x4E9ce36E442e55EcD9025B9a6E0D88485d628A67';

// The decision line: the view's own sentence, then the copy for the stage it landed on. Two
// sentences, the app's words, the figures the app returned.
function decisionSay(stage: keyof typeof STAGE_COPY, lead: string = 'Set up'): string {
  return `${lead}: {{0.view.sentence|the move}}. ${STAGE_COPY[stage]}`;
}

// A refusal carries what was asked and what the app said, in the app's rendered reason.
const REFUSED_SAY = `Refused: {{0.view.sentence|the move}}. {{0.view.error.message|A rule you set stopped it.}} Nothing moved; change the rule in the window if you want it to go.`;

// A read-back of a row the app already holds, for the seeded states.
function readBackTurn(id: string, say: string): Turn {
  return { steps: [{ tool: 'proposal_status', args: { id } }, { say }] };
}

function swapTurn(amountIn: number, minAmountOut: number, say: string, extra: Record<string, unknown> = {}): Turn {
  return {
    steps: [
      { tool: 'propose_swap', args: { chain: 'eth', toChain: 'near', fromSymbol: 'USDC', toSymbol: 'NEAR', amountIn, minAmountOut, ...extra } },
      { tool: 'proposal_status', args: { id: '{{0.id|none}}' } },
      { say },
    ],
  };
}

function ethToUsdcTurn(amountIn: number, say: string): Turn {
  return {
    steps: [
      { tool: 'propose_swap', args: { chain: 'eth', toChain: 'eth', fromSymbol: 'ETH', toSymbol: 'USDC', amountIn, minAmountOut: amountIn * 4400 } },
      { tool: 'proposal_status', args: { id: '{{0.id|none}}' } },
      { say },
    ],
  };
}

// ---------- the walks ----------

/* One proposal seen at every moment its kind's path allows in demo. `moments` maps a stage word
   (or a set of words that print the same label) to the row that wants it, in walk order. The
   propose lands the first row; the click moves the row on; the rest are caught as the demo
   rail walks. `ending` is the row for the agent's one sentence after the terminal stage. */
type Walk = {
  id: string;
  seed: Seed;
  prompt: string;
  turn: Turn;
  ask: string | null; // the row at waiting_for_you, null when the policy decides alone
  moments: Array<{ stages: string[]; row: string }>;
  terminal: { stages: string[]; row: string };
  ending?: string;
};

async function idOfLatest(app: App): Promise<string> {
  const rows = ((await app.state()).proposals as Array<{ id: string; createdAt: string }>) ?? [];
  const newest = [...rows].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  if (newest === undefined) throw new Error('no proposal was created');
  return newest.id;
}

function walkScene(walk: Walk): Scene {
  const rows = [...(walk.ask === null ? [] : [walk.ask]), ...walk.moments.map((m) => m.row), walk.terminal.row, ...(walk.ending === undefined ? [] : [walk.ending])];
  return {
    id: walk.id,
    rows,
    seed: walk.seed,
    play: async (ctx) => {
      const { app } = ctx;
      // The turn count before the propose, so the ending notice (a new turn after the decision
      // turn) can be waited for by count rather than by a text diff the terminal write races.
      const sinceTurns = await ctx.turnCount();
      await app.chat(walk.prompt, walk.turn);
      const id = await idOfLatest(app);
      const first = await app.view(id);
      if (first === null) throw new Error(`${walk.id}: the proposal has no view`);
      if (first.stage === 'waiting_for_you') {
        if (walk.ask !== null) await ctx.capture(walk.ask, { stage: 'waiting_for_you', id });
        const clicked = await app.approve(id);
        if (clicked.status !== 200) throw new Error(`${walk.id}: approve answered ${clicked.status} ${JSON.stringify(clicked.json)}`);
      } else if (walk.ask !== null) {
        ctx.unreachable(walk.ask, `the policy decided this one alone (stage ${String(first.stage)}), so there was no ask to shoot`);
      }
      const terminal = new Set(walk.terminal.stages);
      for (const moment of walk.moments) {
        // A stage the rail skipped is a miss for its row, not a stop for the walk.
        let view: unknown = null;
        try {
          view = await app.waitStage(id, [...moment.stages, ...terminal], 120_000);
        } catch (error) {
          ctx.log(`${moment.row}: ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
        const stage = String((view as { stage: string }).stage);
        if (terminal.has(stage) && !moment.stages.includes(stage)) {
          ctx.unreachable(moment.row, `the demo rail went from the last stage to ${stage} without passing ${moment.stages.join(' or ')}`);
          continue;
        }
        await ctx.capture(moment.row, { stage: moment.stages, id });
      }
      await app.waitStage(id, walk.terminal.stages, 120_000);
      // The ending sentence: the notice fires on the terminal write and is a fresh turn after
      // the decision turn (sinceTurns + 1 was the decision, + 2 is the ending).
      const said = walk.ending === undefined ? '' : await ctx.endingAfter(sinceTurns + 1, 20_000).catch(() => '');
      await ctx.capture(walk.terminal.row, { stage: walk.terminal.stages, id });
      if (walk.ending !== undefined) {
        if (said === '') ctx.unreachable(walk.ending, 'the app sent no ending notice, or the agent did not answer it inside 20 s');
        else await ctx.capture(walk.ending, { stage: walk.terminal.stages, id, reply: said });
      }
    },
  };
}

const WALK_ENV = { PHOSPHOR_DEMO_STAGE_SCALE: '2' };

const swapUnder: Walk = {
  id: 'swap-under-threshold',
  seed: { env: WALK_ENV },
  prompt: 'Swap 2 USDC to NEAR.',
  turn: swapTurn(2, 0.6, decisionSay('waiting_for_you')),
  // The policy may decide a 2 USDC swap alone; the ask row then has nothing to shoot and says so.
  ask: null,
  moments: [{ stages: ['submitting'], row: 'A03' }],
  terminal: { stages: ['confirmed'], row: 'A05' },
};

const swapOver: Walk = {
  id: 'swap-over-threshold',
  seed: { env: WALK_ENV },
  prompt: 'Swap 500 USDC to NEAR.',
  turn: swapTurn(500, 156, decisionSay('waiting_for_you')),
  ask: 'A06',
  moments: [{ stages: ['submitting'], row: 'A08' }],
  terminal: { stages: ['confirmed'], row: 'A10' },
  ending: 'E01',
};

const HL_DEPOSIT_TURN: Turn = {
  steps: [
    { tool: 'propose_hl_deposit', args: { symbol: 'USDC', amount: 150 } },
    { tool: 'proposal_status', args: { id: '{{0.id|none}}' } },
    { say: decisionSay('waiting_for_you') },
  ],
};

const hlDeposit: Walk = {
  id: 'hl-deposit',
  seed: { env: WALK_ENV },
  prompt: 'Move 150 USDC to Hyperliquid.',
  turn: HL_DEPOSIT_TURN,
  ask: 'A11',
  moments: [
    { stages: ['submitting'], row: 'A13' },
    { stages: ['KNOWN_DEPOSIT_TX'], row: 'A14' },
    { stages: ['PROCESSING'], row: 'A15' },
    { stages: ['SUCCESS', 'crediting'], row: 'A16' },
  ],
  terminal: { stages: ['confirmed'], row: 'A17' },
};

const hlWithdraw: Walk = {
  id: 'hl-withdraw',
  seed: { env: WALK_ENV },
  prompt: 'Bring 20 USDC back from Hyperliquid.',
  turn: {
    steps: [
      { tool: 'propose_hl_withdraw', args: { amount: 20 } },
      { tool: 'proposal_status', args: { id: '{{0.id|none}}' } },
      { say: decisionSay('waiting_for_you') },
    ],
  },
  ask: 'A18',
  moments: [
    { stages: ['submitting'], row: 'A20' },
    { stages: ['KNOWN_DEPOSIT_TX'], row: 'A21' },
    { stages: ['PROCESSING'], row: 'A22' },
    { stages: ['SUCCESS', 'crediting'], row: 'A23' },
  ],
  terminal: { stages: ['confirmed'], row: 'A24' },
};

const sendIntents: Walk = {
  id: 'send-inside-intents',
  seed: { env: WALK_ENV },
  prompt: `Send 5 USDC to ${FRIEND_INTENTS} inside NEAR Intents. Yes, that is the right account.`,
  turn: {
    steps: [
      { tool: 'propose_send', args: { symbol: 'USDC', amount: 5, to: FRIEND_INTENTS, where: 'intents', confirmed: true } },
      { tool: 'proposal_status', args: { id: '{{0.id|none}}' } },
      { say: decisionSay('waiting_for_you') },
    ],
  },
  ask: 'A25',
  moments: [
    { stages: ['submitting'], row: 'A27' },
    { stages: ['PROCESSING'], row: 'A28' },
  ],
  terminal: { stages: ['confirmed'], row: 'A29' },
};

const payBase: Walk = {
  id: 'pay-out-on-base',
  seed: { env: WALK_ENV },
  prompt: `Send 5 USDC to ${FRIEND_BASE} on Base. Yes, that is the exact address and the network.`,
  turn: {
    steps: [
      { tool: 'propose_send', args: { symbol: 'USDC', amount: 5, to: FRIEND_BASE, where: 'base', confirmed: true } },
      { tool: 'proposal_status', args: { id: '{{0.id|none}}' } },
      { say: decisionSay('waiting_for_you') },
    ],
  },
  ask: 'A30',
  moments: [
    { stages: ['submitting'], row: 'A32' },
    { stages: ['PROCESSING'], row: 'A33' },
  ],
  terminal: { stages: ['confirmed'], row: 'A34' },
};

// ---------- seeded rows ----------

// The row the app holds for a swap the relay is settling, as reconcile leaves it after a boot.
function relaySwapRow(id: string, providerStage: string, ago: number): Record<string, unknown> {
  return {
    id,
    kind: 'swap',
    createdAt: { agoSec: ago + 20 },
    status: 'needs_reconciliation',
    draft: { kind: 'swap', venue: 'intents-relay', chain: 'eth', toChain: 'near', fromSymbol: 'USDC', toSymbol: 'wNEAR', amountIn: 500, amountUsd: 500, minAmountOut: 156, to: DEMO_ACCOUNT, counterparty: 'intents.near' },
    simulation: { ok: true, notes: [], swap: { receives: '161.129', receivesAtLeast: '156', feeUsd: 0.5, etaSeconds: 45 } },
    verdict: { outcome: 'needs_approval', reasons: ['swap of $500.00 to intents.near.', '$500.00 is above the $100.00 click threshold.'] },
    decidedBy: 'human',
    decidedAt: { agoSec: ago },
    lastChangeAt: { agoSec: Math.max(0, ago - 12) },
    result: {
      ok: false,
      detail: 'the relay holds the swap and NEAR Intents has not shown it yet',
      txids: ['0x9c2b7e4f1a6d3c8b5e0f2a7d4c1b8e6f3a0d9c2b7e4f1a6d3c8b5e0f2a7d4c1b'],
      evidence: { providerStage, handle: `relay-${id}`, quote: { correlationId: `corr-${id}`, timestamp: '2026-09-20T00:00:00.000Z', signature: 'sig', depositAddress: DEMO_ACCOUNT } },
    },
    balances: { beforeUsd: 4012, afterUsd: null },
  };
}

function hlDepositRow(id: string, patch: Record<string, unknown>, ago: number): Record<string, unknown> {
  return {
    id,
    kind: 'hl_deposit',
    createdAt: { agoSec: ago + 30 },
    status: 'needs_reconciliation',
    draft: { kind: 'hl_deposit', symbol: 'USDC', originAsset: USDC_ETH, amount: 150, amountUsd: 150, minCredited: 149.3, from: DEMO_ACCOUNT, hlAccount: DEMO_ACCOUNT, counterparty: 'intents.near' },
    simulation: { ok: true, notes: ['quote held'] },
    verdict: { outcome: 'needs_approval', reasons: ['hl_deposit of $150.00 to intents.near.', '$150.00 is above the $100.00 click threshold.'] },
    decidedBy: 'human',
    decidedAt: { agoSec: ago },
    lastChangeAt: { agoSec: Math.max(0, ago - 20) },
    result: {
      ok: false,
      detail: 'the transfer took the deposit and Hyperliquid has not credited it yet',
      txids: ['0x5b1d9e3a7c2f8d6b4a0e1c9f3d7b5a2e8c6f4d1b9a3e7c5f2d8b6a4e0c1f9d3b'],
      evidence: { handle: `1click-${id}`, quote: { correlationId: `corr-${id}`, timestamp: '2026-09-20T00:00:00.000Z', signature: 'sig', depositAddress: '0x2222222222222222222222222222222222222222' } },
    },
    balances: { beforeUsd: 150, afterUsd: null },
    ...patch,
  };
}

function seededScene(id: string, row: string, seed: Seed, proposalId: string, prompt: string, say: string, clipStage: string | string[]): Scene {
  return {
    id,
    rows: [row],
    seed,
    play: async (ctx) => {
      await ctx.app.chat(prompt, readBackTurn(proposalId, say));
      await ctx.capture(row, { stage: clipStage, id: proposalId });
    },
  };
}

const STATUS_SAY = (stage: keyof typeof STAGE_COPY): string => `{{0.sentence|The move}}: {{0.stageLabel|${stage}}}. ${STAGE_COPY[stage]}`;

const relayPending = seededScene(
  'swap-relay-pending',
  'A04',
  { proposals: [relaySwapRow('anx-a04', 'PENDING', 30)] },
  'anx-a04',
  'How is my swap going?',
  STATUS_SAY('PENDING'),
  'PENDING',
);

const relayBroadcast = seededScene(
  'swap-relay-broadcast',
  'A09',
  { proposals: [relaySwapRow('anx-a09', 'TX_BROADCASTED', 40)] },
  'anx-a09',
  'Is the swap done yet?',
  STATUS_SAY('TX_BROADCASTED'),
  'TX_BROADCASTED',
);

// A move stuck in crediting while the demo venue read times out: the row sits needs_reconciliation
// in crediting, which survives the boot sweep, and the card reads "Waiting for the venue to
// credit it". The reply names the timed-out read and that the app keeps checking.
const venueOutage = seededScene(
  'venue-outage-crediting',
  'B21',
  { proposals: [hlDepositRow('anx-b21', {}, 60)] },
  'anx-b21',
  'Is my deposit in yet?',
  `{{0.sentence|The deposit}}: {{0.stageLabel|Waiting for the venue to credit it}}. ${STAGE_COPY.crediting} The last read timed out, so the app keeps checking.`,
  'crediting',
);

const relayExpired = seededScene(
  'swap-relay-expired',
  'B26',
  { proposals: [relaySwapRow('anx-b26', 'NOT_FOUND_OR_NOT_VALID', 300)] },
  'anx-b26',
  'What happened to my swap?',
  STATUS_SAY('NOT_FOUND_OR_NOT_VALID'),
  'NOT_FOUND_OR_NOT_VALID',
);

const providerFailed = seededScene(
  'hl-deposit-provider-failed',
  'B16',
  { proposals: [hlDepositRow('anx-b16', { result: { ok: false, detail: 'the transfer could not finish', txids: ['0x5b1d9e3a7c2f8d6b4a0e1c9f3d7b5a2e8c6f4d1b9a3e7c5f2d8b6a4e0c1f9d3b'], evidence: { providerStage: 'FAILED', handle: '1click-anx-b16' } } }, 240)] },
  'anx-b16',
  'What happened to my deposit?',
  STATUS_SAY('FAILED'),
  'FAILED',
);

const providerRefunded = seededScene(
  'hl-deposit-provider-refunded',
  'B17',
  { proposals: [hlDepositRow('anx-b17', { result: { ok: false, detail: 'the transfer could not finish and sent the money back', txids: ['0x5b1d9e3a7c2f8d6b4a0e1c9f3d7b5a2e8c6f4d1b9a3e7c5f2d8b6a4e0c1f9d3b'], evidence: { providerStage: 'REFUNDED', handle: '1click-anx-b17' } } }, 300)] },
  'anx-b17',
  'Did my deposit go through?',
  STATUS_SAY('REFUNDED'),
  'REFUNDED',
);

/* A failed move, read back: the agent's sentence about it (E03) is the same reply as the card
   (B15), because a seeded failure is reported by the read-back turn, not by a fresh notice. */
const railFailed: Scene = {
  id: 'hl-deposit-rail-failed',
  rows: ['B15', 'E03'],
  seed: {
    proposals: [
      hlDepositRow('anx-b15', { status: 'failed', result: { ok: false, detail: 'the transfer refused the deposit after it was signed: the quote had expired' } }, 200),
    ],
  },
  play: async (ctx) => {
    await ctx.app.chat('Did my deposit go through?', readBackTurn('anx-b15', STATUS_SAY('failed')));
    await ctx.capture('B15', { stage: 'failed', id: 'anx-b15' });
    await ctx.capture('E03', { stage: 'failed', id: 'anx-b15', reply: await ctx.lastReply() });
  },
};

// A row the preflight held when the app last stopped: the boot sweep closes it with the reason.
const holdExpired = seededScene(
  'hl-deposit-hold-expired',
  'B14',
  { proposals: [hlDepositRow('anx-b14', { status: 'approved', heldSince: { agoSec: 1000 }, result: undefined }, 1010)] },
  'anx-b14',
  'What happened to my deposit?',
  STATUS_SAY('failed'),
  'failed',
);

const tradePlan = {
  id: 'pl_anx',
  symbol: 'BTC',
  side: 'long',
  sizeUsd: 4000,
  leverage: 20,
  entry: { type: 'market', maxSlippageBps: 30 },
  stop: 63000,
  target: 66000,
  expiresAt: '2026-09-22T10:00:00.000Z',
};
const tradeRisk = { marginUsd: 200, maxLossUsd: 66.1, stopSlipUsd: 400, entryRef: 64000, liquidationPx: 61570.12, notionalUsd: 3999, amountUsd: 200 };

function tradeRow(id: string, status: 'pending' | 'executed', ago: number): Record<string, unknown> {
  const base = {
    id,
    kind: 'trade',
    createdAt: { agoSec: ago },
    status,
    draft: { kind: 'trade', op: 'open', plan: tradePlan, hash: 'anx-plan-hash', risk: tradeRisk, amountUsd: 200, counterparty: 'hyperliquid-perps' },
    simulation: { ok: true, notes: [] },
    verdict: { outcome: 'needs_approval', reasons: ['trade of $200.00 to hyperliquid-perps.', '$200.00 is above the $100.00 click threshold.'] },
  };
  if (status === 'pending') return base;
  return {
    ...base,
    decidedBy: 'human',
    decidedAt: { agoSec: ago - 5 },
    settledAt: { agoSec: ago - 15 },
    lastChangeAt: { agoSec: ago - 15 },
    result: { ok: true, detail: 'filled at 64,010 on Hyperliquid, stop and target resting', txids: ['0x7a3c9e1f5b2d8a6c4e0f9b3d7a1c5e8f2b6d0a4c9e3f7b1d5a8c2e6f0b4d9a3c'] },
  };
}

const tradePending = seededScene(
  'trade-waiting',
  'A35',
  { proposals: [tradeRow('anx-a35', 'pending', 20)] },
  'anx-a35',
  'Is anything waiting on me?',
  STATUS_SAY('waiting_for_you'),
  'waiting_for_you',
);

const tradeConfirmed = seededScene(
  'trade-confirmed',
  'A39',
  { proposals: [tradeRow('anx-a39', 'executed', 120)] },
  'anx-a39',
  'Did the trade go through?',
  STATUS_SAY('confirmed'),
  'confirmed',
);

// ---------- policy changes ----------

function policyTurn(patch: Record<string, unknown>, sentence: string, say: string): Turn {
  return {
    steps: [
      { tool: 'propose_policy_change', args: { patch, sentence } },
      { tool: 'proposal_status', args: { id: '{{0.id|none}}' } },
      { say },
    ],
  };
}

const policyRaise: Scene = {
  id: 'policy-raise-threshold',
  rows: ['A40', 'A41'],
  seed: {},
  play: async (ctx) => {
    const sinceTurns = await ctx.turnCount();
    await ctx.app.chat('Ask me above $200 instead of $100.', policyTurn({ outbound: { humanClickAboveUsd: 200 } }, 'Ask me above $200', decisionSay('waiting_for_you', 'Rule change set up')));
    const id = await idOfLatest(ctx.app);
    await ctx.capture('A40', { stage: 'waiting_for_you', id });
    await ctx.app.approve(id);
    await ctx.app.waitStage(id, ['confirmed'], 10_000);
    const said = await ctx.endingAfter(sinceTurns + 1, 15_000).catch(() => '');
    await ctx.capture('A41', { stage: 'confirmed', id, ...(said === '' ? {} : { reply: said }) });
  },
};

const policyDecline: Scene = {
  id: 'policy-declined',
  rows: ['A42'],
  seed: {},
  play: async (ctx) => {
    const sinceTurns = await ctx.turnCount();
    await ctx.app.chat('Ask me above $200 instead of $100.', policyTurn({ outbound: { humanClickAboveUsd: 200 } }, 'Ask me above $200', decisionSay('waiting_for_you', 'Rule change set up')));
    const id = await idOfLatest(ctx.app);
    await ctx.app.refuse(id);
    await ctx.app.waitStage(id, ['declined'], 10_000);
    const said = await ctx.endingAfter(sinceTurns + 1, 15_000).catch(() => '');
    await ctx.capture('A42', { stage: 'declined', id, ...(said === '' ? {} : { reply: said }) });
  },
};

const policyInvalid: Scene = {
  id: 'policy-invalid-patch',
  rows: ['A43', 'B03'],
  seed: {},
  play: async (ctx) => {
    await ctx.app.chat('Set the ask threshold to "lots".', policyTurn({ outbound: { humanClickAboveUsd: 'lots' } }, 'Ask me above lots', REFUSED_SAY));
    const id = await idOfLatest(ctx.app);
    await ctx.capture('A43', { stage: 'refused', id });
    await ctx.capture('B03', { stage: 'refused', id });
  },
};

const policyLower: Scene = {
  id: 'policy-lower-cap',
  rows: ['A44'],
  seed: {},
  play: async (ctx) => {
    await ctx.app.chat('Refuse anything above $5,000 at once.', policyTurn({ outbound: { maxPerTransactionUsd: 5000 } }, 'Refuse anything above $5,000 at once', decisionSay('waiting_for_you', 'Rule change set up')));
    const id = await idOfLatest(ctx.app);
    await ctx.capture('A44', { stage: 'waiting_for_you', id });
  },
};

// ---------- refusals ----------

/* A refusal is synchronous: the propose refuses in the same turn, so the agent's one sentence
   about it is the reply it wrote in that turn, not a separate ending notice (the app drops the
   notice when the agent already read the terminal stage, which the refusal turn does). So an
   `ending` row here is the SAME reply as the card, shot as the ending-notice row. */
function refusalScene(id: string, rows: string[], seed: Seed, prompt: string, turn: Turn, before?: (ctx: SceneCtx) => Promise<void>, ending?: string): Scene {
  return {
    id,
    rows: [...rows, ...(ending === undefined ? [] : [ending])],
    seed,
    play: async (ctx) => {
      if (before !== undefined) await before(ctx);
      await ctx.app.chat(prompt, turn);
      let proposalId: string | null = null;
      try {
        proposalId = await idOfLatest(ctx.app);
      } catch {
        proposalId = null;
      }
      const said = await ctx.lastReply();
      for (const row of rows) await ctx.capture(row, { ...(proposalId === null ? {} : { id: proposalId }), note: proposalId === null ? 'the app answered without a row' : undefined });
      if (ending !== undefined) await ctx.capture(ending, { ...(proposalId === null ? {} : { id: proposalId }), reply: said });
    },
  };
}

const RICH = { intents: [{ symbol: 'USDC', originChain: 'eth', assetId: USDC_ETH, amount: 30000, decimals: 6 }], hyperliquid: { collateralUsdc: 50, availableUsdc: 50 } };

function executedSwapRow(id: string, amountUsd: number, ago: number): Record<string, unknown> {
  return {
    id,
    kind: 'swap',
    createdAt: { agoSec: ago + 60 },
    status: 'executed',
    draft: { kind: 'swap', venue: 'intents-native', chain: 'eth', toChain: 'near', fromSymbol: 'USDC', toSymbol: 'wNEAR', amountIn: amountUsd, amountUsd, minAmountOut: amountUsd / 3.2, to: DEMO_ACCOUNT, counterparty: 'intents.near' },
    simulation: { ok: true, notes: [] },
    verdict: { outcome: 'needs_approval', reasons: [`swap of $${amountUsd}.00 to intents.near.`] },
    decidedBy: 'human',
    decidedAt: { agoSec: ago },
    settledAt: { agoSec: ago - 40 },
    lastChangeAt: { agoSec: ago - 40 },
    result: { ok: true, detail: 'settled', txids: ['0x1f4b8d2c6e0a9f3b7d5c1e8a2f6b0d4c9e3a7f1b5d8c2e6a0f4b9d3c7e1a5f8b'] },
  };
}

const refusals: Scene[] = [
  refusalScene(
    'refused-kill-switch',
    ['B01'],
    {},
    'Swap 50 USDC to NEAR.',
    swapTurn(50, 15.6, REFUSED_SAY),
    async (ctx) => {
      const out = await ctx.app.post('/api/kill', { token: ctx.app.token, on: true });
      if (out.status !== 200) throw new Error(`kill switch refused: ${out.status}`);
    },
    'E02',
  ),
  refusalScene('refused-kill-switch-not-patchable', ['B02'], {}, 'Turn the freeze off.', policyTurn({ killSwitch: false }, 'Turn the freeze off', REFUSED_SAY)),
  refusalScene('refused-invalid-amount', ['B04'], {}, 'Swap 0 USDC to NEAR.', swapTurn(0, 0, REFUSED_SAY)),
  refusalScene(
    'refused-destination-not-allowed',
    ['B05'],
    { policy: { outbound: { destinationAllowlist: [] } } },
    'Move 150 USDC to Hyperliquid.',
    { steps: [{ tool: 'propose_hl_deposit', args: { symbol: 'USDC', amount: 150 } }, { tool: 'proposal_status', args: { id: '{{0.id|none}}' } }, { say: REFUSED_SAY }] },
  ),
  refusalScene('refused-max-per-transaction', ['B06'], { demo: RICH }, 'Swap 20,000 USDC to NEAR.', swapTurn(20000, 6000, REFUSED_SAY)),
  refusalScene(
    'refused-max-per-session',
    ['B07'],
    { demo: RICH, proposals: [executedSwapRow('anx-b07-1', 9000, 600), executedSwapRow('anx-b07-2', 9000, 300)] },
    'Swap another 9,000 USDC to NEAR.',
    swapTurn(9000, 2800, REFUSED_SAY),
  ),
  refusalScene('refused-forbidden-issuer', ['B08'], { policy: { composition: { forbiddenIssuers: ['Circle'] } } }, 'Swap 0.1 ETH to USDC.', ethToUsdcTurn(0.1, REFUSED_SAY)),
  refusalScene('refused-max-issuer-share', ['B09'], { policy: { composition: { maxIssuerShare: { default: 1, Circle: 0.3 } } } }, 'Swap 0.1 ETH to USDC.', ethToUsdcTurn(0.1, REFUSED_SAY)),
  refusalScene('refused-max-freezable-share', ['B10'], { policy: { composition: { maxFreezableShare: 0.3 } } }, 'Swap 0.1 ETH to USDC.', ethToUsdcTurn(0.1, REFUSED_SAY)),
  // The demo simulate refuses a floor above its own quote, which is the simulation seam demo has.
  refusalScene('refused-simulation', ['B11'], {}, 'Swap 50 USDC to NEAR, and I want at least 1,000 NEAR for it.', swapTurn(50, 1000, REFUSED_SAY)),
  refusalScene(
    'refused-policy-unreadable',
    ['B12'],
    {},
    'Swap 50 USDC to NEAR.',
    swapTurn(50, 15.6, REFUSED_SAY),
    async (ctx) => {
      fs.writeFileSync(path.join(ctx.app.dataDir, 'policy.json'), '{ this is not json');
    },
  ),
  refusalScene(
    'refused-empty-wallet',
    ['B22'],
    { demo: { intents: [{ symbol: 'USDC', originChain: 'eth', assetId: USDC_ETH, amount: 0, decimals: 6 }], hyperliquid: { collateralUsdc: 0, availableUsdc: 0 } } },
    'Swap 50 USDC to NEAR.',
    swapTurn(50, 15.6, REFUSED_SAY),
  ),
  refusalScene('refused-unpriced-coin', ['B23'], {}, 'Swap 50 USDC to XYZ.', swapTurn(50, 1, REFUSED_SAY, { toSymbol: 'XYZ', toChain: 'eth' })),
  refusalScene(
    'refused-below-hl-floor',
    ['B24'],
    {},
    'Move 2 USDC to Hyperliquid.',
    { steps: [{ tool: 'propose_hl_deposit', args: { symbol: 'USDC', amount: 2 } }, { tool: 'proposal_status', args: { id: '{{0.id|none}}' } }, { say: REFUSED_SAY }] },
  ),
];

// The human's No: the row reads Declined and the agent says its sentence.
const declined: Scene = {
  id: 'declined-by-the-human',
  rows: ['B19'],
  seed: {},
  play: async (ctx) => {
    const sinceTurns = await ctx.turnCount();
    await ctx.app.chat('Swap 500 USDC to NEAR.', swapTurn(500, 156, decisionSay('waiting_for_you')));
    const id = await idOfLatest(ctx.app);
    await ctx.app.refuse(id);
    await ctx.app.waitStage(id, ['declined'], 10_000);
    const said = await ctx.endingAfter(sinceTurns + 1, 15_000).catch(() => '');
    await ctx.capture('B19', { stage: 'declined', id, ...(said === '' ? {} : { reply: said }) });
  },
};

// The stall: the demo rail stops at PROCESSING and the deadline sweep calls the row late.
const stalled: Scene = {
  id: 'stalled-deposit',
  rows: ['B18'],
  seed: { env: { PHOSPHOR_DEMO_STAGE_SCALE: '1', PHOSPHOR_DEMO_STALL: '1', PHOSPHOR_DEMO_DEADLINE_SEC: '6' } },
  play: async (ctx) => {
    const sinceTurns = await ctx.turnCount();
    await ctx.app.chat('Move 150 USDC to Hyperliquid.', HL_DEPOSIT_TURN);
    const id = await idOfLatest(ctx.app);
    await ctx.app.approve(id);
    await ctx.app.waitStage(id, ['stalled'], 90_000);
    const said = await ctx.endingAfter(sinceTurns + 1, 15_000).catch(() => '');
    await ctx.capture('B18', { stage: 'stalled', id, ...(said === '' ? {} : { reply: said }) });
  },
};

// ---------- onboarding ----------

const SCREEN = '#screen-firstrun';

async function stepIs(page: Page, title: string, timeoutMs: number = 10_000): Promise<void> {
  await page.waitFor(`(function(){var h=document.querySelector('${SCREEN} h1'); return !!h && h.textContent.trim()===${JSON.stringify(title)};})()`, timeoutMs, `the "${title}" screen`);
  await new Promise((resolve) => setTimeout(resolve, 700));
}

const onboarding: Scene = {
  id: 'onboarding',
  rows: ['C01', 'C03', 'C04', 'C05', 'C06', 'C07', 'C08', 'C09', 'C10', 'C11', 'C12', 'C13', 'C14', 'C15'],
  seed: { wallet: false },
  play: async (ctx) => {
    const { page } = ctx;
    await page.viewport(860, 900);
    await page.waitFor('document.body.getAttribute("data-terms") === "true"', 10_000, 'the terms card');
    await new Promise((resolve) => setTimeout(resolve, 900));
    await ctx.capture('C01', { clip: 'page' });
    await page.clickText('Accept and continue', '#screen-terms');
    await page.waitFor(`!!document.querySelector('${SCREEN} .firstrun-welcome')`, 15_000, 'the welcome');
    await new Promise((resolve) => setTimeout(resolve, 1400));
    await ctx.capture('C03', { clip: 'page' });
    await page.clickText('Get started', SCREEN);
    await stepIs(page, 'Create or bring a wallet');
    await ctx.capture('C04', { clip: 'page' });
    await page.clickText('Continue', SCREEN);
    await stepIs(page, 'Set a password');
    await ctx.capture('C05', { clip: 'page' });
    const inputs = await page.eval<number>(`document.querySelectorAll('${SCREEN} input').length`);
    if (inputs < 2) throw new Error('the password screen has fewer than two inputs');
    await page.eval(
      `(function(){var i=document.querySelectorAll('${SCREEN} input'); for (var k=0;k<2;k+=1){i[k].value='anxiety-eval-password-1'; i[k].dispatchEvent(new Event('input',{bubbles:true}));} return 1;})()`,
    );
    await page.clickText('Continue', SCREEN);
    await stepIs(page, 'Save your recovery words', 20_000);
    await ctx.capture('C06', { clip: 'page' });
    const words = await page.eval<string[]>(`Array.from(document.querySelectorAll('${SCREEN} .word .body')).map(function(n){return n.textContent.trim();})`);
    if (words.length < 12) throw new Error(`the words screen showed ${words.length} words, not twelve`);
    // Continue stays inert until the "I have saved these" box is ticked; check it like a person.
    await page.eval(
      `(function(){var b=document.querySelector('${SCREEN} input[type="checkbox"]'); if(b && !b.checked){b.checked=true; b.dispatchEvent(new Event('change',{bubbles:true}));} return !!b;})()`,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    await page.clickText('Continue', SCREEN);
    await stepIs(page, 'Prove it', 15_000);
    await ctx.capture('C07', { clip: 'page' });
    // The prove screen asks for words 3, 7 and 11 (picks [2, 6, 10] in firstrun.js).
    const picks = [2, 6, 10];
    await page.eval(
      `(function(){var inputs=document.querySelectorAll('${SCREEN} input'); var words=${JSON.stringify(words)}; var picks=${JSON.stringify(picks)};
        for (var i=0;i<inputs.length && i<picks.length;i+=1){inputs[i].value=words[picks[i]]||''; inputs[i].dispatchEvent(new Event('input',{bubbles:true}));} return inputs.length;})()`,
    );
    await page.clickText('Continue', SCREEN);
    await stepIs(page, 'Your addresses', 15_000);
    await ctx.capture('C08', { clip: 'page' });
    // USDC on a named network: the Base tile, then the coin if the picker asks for one.
    await page.click(`${SCREEN} .net-tile[data-network="base"]`).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 600));
    await page.clickText('USDC', SCREEN).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 600));
    await page.clickText('Continue', SCREEN);
    await stepIs(page, 'Add money');
    await ctx.capture('C09', { clip: 'page' });
    await page.clickText('Do this later', SCREEN);
    await new Promise((resolve) => setTimeout(resolve, 900));
    const connectTitle = await page.text(`${SCREEN} h1`);
    const pickerEntries = await page.eval<string[]>(
      `Array.from(document.querySelectorAll('${SCREEN} button, ${SCREEN} .choice')).map(function(n){return (n.innerText||'').trim();}).filter(Boolean)`,
    );
    const hasPicker = pickerEntries.some((entry) => /claude code/i.test(entry));
    if (hasPicker) {
      await ctx.capture('C10', { clip: 'page' });
    } else {
      for (const row of ['C10', 'C11', 'C12', 'C13']) {
        ctx.unreachable(row, `this build's connect step ("${connectTitle.trim()}") has no agent picker entry; node C's picker is not on this branch. Re-point in scripts/anxiety/scenes.ts when it lands`);
      }
    }
    await page.clickText('Do this later', SCREEN).catch(() => page.clickText('Continue', SCREEN));
    await stepIs(page, 'Set the ask threshold');
    await ctx.capture('C14', { clip: 'page' });
    await page.clickText('Continue', SCREEN);
    await stepIs(page, 'Done');
    await ctx.capture('C15', { clip: 'page' });
  },
};

/* The Gatekeeper page as the person reads it: docs/getting-started.md rendered with the app's
   own type, in the browser, at the same width. A plain renderer for the handful of shapes the
   file uses (headings, paragraphs, lists, code, links, emphasis); nothing else is in that file. */
export function renderMarkdown(markdown: string): string {
  const escape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s: string): string =>
    escape(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  const out: string[] = [];
  const lines = markdown.split('\n');
  let list: 'ul' | 'ol' | null = null;
  let code = false;
  let paragraph: string[] = [];
  const flush = (): void => {
    if (paragraph.length > 0) out.push(`<p>${inline(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const endList = (): void => {
    if (list !== null) out.push(`</${list}>`);
    list = null;
  };
  for (const line of lines) {
    if (line.startsWith('```')) {
      flush();
      endList();
      out.push(code ? '</pre>' : '<pre>');
      code = !code;
      continue;
    }
    if (code) {
      out.push(escape(line));
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading !== null) {
      flush();
      endList();
      out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (bullet !== null || numbered !== null) {
      flush();
      const kind = bullet !== null ? 'ul' : 'ol';
      if (list !== kind) {
        endList();
        out.push(`<${kind}>`);
        list = kind;
      }
      out.push(`<li>${inline((bullet ?? numbered)![1])}</li>`);
      continue;
    }
    if (line.trim() === '') {
      flush();
      endList();
      continue;
    }
    paragraph.push(line.trim());
  }
  flush();
  endList();
  if (code) out.push('</pre>');
  return out.join('\n');
}

const gatekeeperDoc: Scene = {
  id: 'docs-gatekeeper',
  rows: ['C02'],
  seed: {},
  play: async (ctx) => {
    const file = path.join(ROOT, 'docs', 'getting-started.md');
    if (!fs.existsSync(file)) {
      ctx.unreachable('C02', 'docs/getting-started.md is not in this tree');
      return;
    }
    const body = renderMarkdown(fs.readFileSync(file, 'utf8'));
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Getting started</title>
      <link rel="stylesheet" href="${ctx.app.base}/design/tokens.css"><link rel="stylesheet" href="${ctx.app.base}/design/type.css">
      <style>body{margin:0;padding:32px 40px;background:var(--bg-0,#0e0f13);color:var(--text,#e6e6e6);font-family:Sora,system-ui,sans-serif;max-width:780px;line-height:1.55}
      h1,h2,h3{font-weight:600;line-height:1.2}h1{font-size:28px}h2{font-size:20px;margin-top:32px}code,pre{font-family:"Geist Mono",ui-monospace,monospace;font-size:13px}
      pre{background:var(--bg-1,#16171c);padding:12px 14px;border-radius:8px;overflow:auto;white-space:pre-wrap}code{background:var(--bg-1,#16171c);padding:1px 5px;border-radius:4px}
      a{color:var(--accent,#39ff6a)}li{margin:4px 0}</style></head><body>${body}</body></html>`;
    await ctx.page.viewport(860, 1400);
    await ctx.page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    await new Promise((resolve) => setTimeout(resolve, 800));
    await ctx.capture('C02', { clip: 'page', reply: '' });
  },
};

// ---------- the vault ----------

const vault: Scene = {
  id: 'vault',
  rows: ['D01', 'D02', 'D03', 'D04', 'D05', 'D06', 'D07', 'D08'],
  seed: {},
  play: async (ctx) => {
    const { page } = ctx;
    await page.column(360);
    await page.click('.tab[data-tab="vault"]');
    await page.waitFor('!!document.querySelector("#view-vault section.panel[data-surface=\\"custody\\"]")', 10_000, 'the vault panels');
    await new Promise((resolve) => setTimeout(resolve, 900));
    const panels: Array<[string, string]> = [
      ['D01', 'custody'],
      ['D02', 'recovery'],
      ['D03', 'addresses'],
      ['D04', 'agent'],
      ['D07', 'window'],
      ['D08', 'danger'],
    ];
    for (const [row, surface] of panels) {
      const rect = await page.eval<{ x: number; y: number; width: number; height: number } | null>(
        `(function(){var el=document.querySelector('#view-vault section.panel[data-surface="${surface}"]'); if(!el) return null; el.scrollIntoView({block:'nearest'}); var r=el.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height};})()`,
      );
      if (rect === null) {
        ctx.unreachable(row, `no panel with data-surface="${surface}" on this build's vault`);
        continue;
      }
      await ctx.capture(row, { clip: rect, reply: '' });
    }
    const hasChange = await page.eval<boolean>(
      `Array.from(document.querySelectorAll('#view-vault section.panel[data-surface="agent"] button')).some(function(b){return /change/i.test(b.innerText||'');})`,
    );
    if (!hasChange) {
      ctx.unreachable('D05', "the vault Agent panel on this build has no Change control; node C's switcher is not on this branch");
      ctx.unreachable('D06', "the vault Agent panel on this build has no Change control; node C's switcher is not on this branch");
    }
  },
};

// ---------- session start ----------

const greeting: Scene = {
  id: 'greeting',
  rows: ['F01'],
  seed: {},
  play: async (ctx) => {
    await ctx.app.chat('Hi', {
      steps: [{ say: 'Hi. I can move money between your two pockets, swap one coin for another and change your rules, and every move waits for your Yes in the window. What would you like to do?' }],
    });
    await ctx.capture('F01');
  },
};

const holdings: Scene = {
  id: 'what-do-i-hold',
  rows: ['F02'],
  seed: {},
  play: async (ctx) => {
    await ctx.app.chat('What do I hold?', {
      steps: [{ tool: 'wallet', args: {} }, { say: 'You hold ${{0.totalUsd|?}} in all, in the two pockets on the card. Nothing is waiting on you.' }],
    });
    await ctx.capture('F02');
  },
};

// ---------- the list ----------

export const SCENES: Scene[] = [
  walkScene(swapUnder),
  walkScene(swapOver),
  relayPending,
  relayBroadcast,
  walkScene(hlDeposit),
  walkScene(hlWithdraw),
  walkScene(sendIntents),
  walkScene(payBase),
  tradePending,
  tradeConfirmed,
  policyRaise,
  policyDecline,
  policyInvalid,
  policyLower,
  ...refusals,
  holdExpired,
  railFailed,
  providerFailed,
  providerRefunded,
  stalled,
  declined,
  venueOutage,
  relayExpired,
  onboarding,
  gatekeeperDoc,
  vault,
  greeting,
  holdings,
];

// Every row a scene claims, for the coverage check in the runner.
export function claimedRows(): Set<string> {
  const out = new Set<string>();
  for (const scene of SCENES) for (const row of scene.rows) out.add(row);
  return out;
}
