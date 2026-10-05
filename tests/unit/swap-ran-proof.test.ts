// A swap NEAR shows has run is Done, whatever 1Click still says.
//
// 2026-10-05, 0.10.16, a key wallet: "divide my funds into 8 different coins" filed eight swaps of
// 1.0168 USDC, every one on the intents-native rail (the relay prices none of the eight pairs).
// LTC, SUI and DOGE said Done in 6 to 15 s. BTC, ETH, SOL, NEAR and XRP said "Sent. Waiting for a
// buyer to take it." and then "Taking longer · 50s" while the balance panel, which reads the
// verifier, already showed all eight coins. The rail ended its watch on 1Click's word alone, and
// 1Click was still saying PROCESSING over swaps NEAR had already run. The two reads that prove a
// swap ran were both in the rail: its own signed transfer's nonce, spent at the verifier, and the
// bought coin's balance against the read taken before the signature.
//
// Eight swaps share one rail and one clock here, as they share the rail in the app. NEAR runs each
// three seconds after its submit; 1Click says SUCCESS four seconds later for three of them and four
// minutes later for the other five.
//
// Run: node --test tests/unit/swap-ran-proof.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildNonce } from '../../src/relay/payload.ts';
import { INTENTS_NATIVE_COUNTERPARTY, INTENTS_VERIFIER, RAN_RECHECK_MS, intentsNativeRail } from '../../src/rails/intents-native.ts';
import { parseStatus } from '../../src/intents.ts';
import type { OneClickQuote } from '../../src/intents.ts';
import { proposalView } from '../../src/proposals/view.ts';
import { stateProposals } from '../../src/http/state.ts';
import type { Proposal, RailEvidence, RailResult, SwapDraft } from '../../src/types.ts';
import { TEST_QUOTE_KEY, signQuote } from './helpers/signed-quote.ts';
import { SELF_EVM, makeCtx, seededPolicy } from './helpers/proposals.ts';

const OWNER = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A';
const USDC = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
const START = Date.parse('2026-10-05T09:30:00.000Z');
const SPEND = 1_016_800n; // 1.0168 USDC
// When NEAR runs a swap, after its submit, and when a prompt 1Click says so.
const RUNS_AFTER_MS = 3_000;
const SAYS_AFTER_MS = 4_000;
const LAGS_BY_MS = 240_000;

type Coin = { symbol: string; out: bigint; lags: boolean; contract: string };
const COINS: Coin[] = [
  { symbol: 'LTC', out: 1_440_000n, lags: false },
  { symbol: 'BTC', out: 1_200n, lags: true },
  { symbol: 'ETH', out: 37_700n, lags: true },
  { symbol: 'SOL', out: 849_500n, lags: true },
  { symbol: 'wNEAR', out: 41_220_000n, lags: true },
  { symbol: 'SUI', out: 85_912_300n, lags: false },
  { symbol: 'XRP', out: 68_125_100n, lags: true },
  { symbol: 'DOGE', out: 1_074_530_000n, lags: false },
].map((c, i) => ({ ...c, contract: `0x${(i + 1).toString(16).padStart(40, '0')}` }));
const assetOf = (c: Coin): string => `nep141:arb-${c.contract}.omft.near`;
const handleOf = (c: Coin): string => `q-${c.symbol.toLowerCase()}.1click.near`;
const nonceOf = (i: number): string => buildNonce({ salt: Uint8Array.from([0x25, 0x28, 0x12, 0xb3]), deadlineMs: START + 72 * 3_600_000, random: new Uint8Array(15).fill(i + 1) });

const tokens = {
  eth: {},
  base: { USDC: { tokenId: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6 } },
  arb: Object.fromEntries(COINS.map((c) => [c.symbol, { tokenId: c.contract, decimals: 8 }])),
  sol: {},
  near: {},
};
const list = [
  { assetId: USDC, decimals: 6, blockchain: 'base', symbol: 'USDC', contractAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' },
  ...COINS.map((c) => ({ assetId: assetOf(c), decimals: 8, blockchain: 'arb', symbol: c.symbol, contractAddress: c.contract })),
];

// The floor one percent under the quote, as the app sets it; 1Click's own minimum half a percent under.
const floorOf = (c: Coin): bigint => (c.out * 99n) / 100n;
const units = (base: bigint): number => Number(base) / 1e8;

function draftOf(c: Coin): SwapDraft {
  return {
    kind: 'swap',
    venue: 'intents-native',
    chain: 'base',
    toChain: 'arb',
    fromSymbol: 'USDC',
    toSymbol: c.symbol,
    amountIn: 1.0168,
    amountInExact: '1.0168',
    amountUsd: 1.0168,
    minAmountOut: units(floorOf(c)),
    from: OWNER,
    to: OWNER,
    counterparty: INTENTS_NATIVE_COUNTERPARTY,
    quote: null,
    assets: { origin: { assetId: USDC, decimals: 6 }, destination: { assetId: assetOf(c), decimals: 8 } },
  };
}

/* One clock for every swap. A sleep waits on it; once every swap is waiting, the clock jumps to the
   earliest sleeper. Nothing else here waits on time. */
function sharedClock(start: number) {
  let now = start;
  let sleepers: Array<{ at: number; wake: () => void }> = [];
  return {
    now: () => now,
    sleep: (ms: number) => new Promise<void>((wake) => void sleepers.push({ at: now + ms, wake })),
    async drive<T>(work: Promise<T>): Promise<T> {
      let over = false;
      const done = work.finally(() => {
        over = true;
      });
      for (let turn = 0; !over; turn += 1) {
        for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
        if (over) break;
        if (sleepers.length === 0) throw new Error('a swap is waiting on something that is not the clock');
        if (turn > 200_000) throw new Error('the clock ran away');
        now = Math.max(now, Math.min(...sleepers.map((s) => s.at)));
        const due = sleepers.filter((s) => s.at <= now);
        sleepers = sleepers.filter((s) => s.at > now);
        for (const s of due) s.wake();
      }
      return done;
    },
  };
}

type Outcome = { coin: Coin; result: RailResult; doneAt: number; ranAt: number; told: Array<{ at: number; stage: string }> };

/* 1Click and NEAR for the eight, on a clock the caller owns. NEAR runs a swap `runsAfterMs` after
   its submit, or never when `nearRuns` is false: its nonce spent and its coin arrived. 1Click says
   SUCCESS `saysAfterMs` after that for a prompt coin, and `lagsByMs` later still for a late one.
   `chain: 'hangs'` is an RPC that takes the watch's nonce question and never answers. */
type WorldOpts = { owner: string; now: () => number; runsAfterMs: number; saysAfterMs: number; lagsByMs: number; nearRuns?: boolean; chain?: 'answers' | 'hangs' };

function worldOf(o: WorldOpts) {
  const submittedAt = new Map<string, number>();
  const coinByHandle = new Map(COINS.map((c) => [handleOf(c), c]));
  const coinByAsset = new Map(COINS.map((c) => [assetOf(c), c]));
  const coinByNonce = new Map(COINS.map((c, i) => [nonceOf(i), c]));
  const ranAt = (c: Coin): number => (o.nearRuns === false ? Infinity : (submittedAt.get(handleOf(c)) ?? Infinity) + o.runsAfterMs);
  const api = {
    tokens: async () => list,
    quote: async (q: { dry: boolean; destinationAsset: string }) => {
      const c = coinByAsset.get(q.destinationAsset)!;
      const signed = signQuote({
        quote: {
          amountIn: SPEND.toString(),
          amountInFormatted: '1.0168',
          amountInUsd: '1.0168',
          minAmountIn: SPEND.toString(),
          amountOut: c.out.toString(),
          amountOutFormatted: String(units(c.out)),
          amountOutUsd: '1.0100',
          minAmountOut: ((c.out * 995n) / 1000n).toString(),
          timeEstimate: 12,
          depositAddress: handleOf(c),
        },
        quoteRequest: { dry: q.dry, originAsset: USDC, destinationAsset: assetOf(c), amount: SPEND.toString(), depositType: 'INTENTS', recipientType: 'INTENTS', recipient: o.owner, refundType: 'INTENTS', refundTo: o.owner },
      });
      return { quote: signed['quote'] as OneClickQuote, raw: signed };
    },
    generateIntent: async ({ depositAddress }: { depositAddress: string }) => {
      const i = COINS.indexOf(coinByHandle.get(depositAddress)!);
      const payload = JSON.stringify({
        signer_id: o.owner.toLowerCase(),
        verifying_contract: INTENTS_VERIFIER,
        deadline: new Date(o.now() + 72 * 3_600_000).toISOString(),
        nonce: nonceOf(i),
        intents: [{ intent: 'transfer', receiver_id: depositAddress, tokens: { [USDC]: SPEND.toString() } }],
      });
      return { standard: 'erc191', payload, correlationId: `c-${i}` };
    },
    submitIntent: async ({ payload }: { payload: string }) => {
      const handle = (JSON.parse(payload) as { intents: Array<{ receiver_id: string }> }).intents[0]!.receiver_id;
      submittedAt.set(handle, o.now());
      return { intentHash: `intent-${handle}`, correlationId: 'c' };
    },
    status: async (handle: string) => {
      const c = coinByHandle.get(handle)!;
      const says = ranAt(c) + o.saysAfterMs + (c.lags ? o.lagsByMs : 0);
      return parseStatus({ status: o.now() >= says ? 'SUCCESS' : 'PROCESSING' });
    },
  };
  const chain = {
    // Ten USDC to spend; each bought coin arrives the moment NEAR runs its swap.
    verifierBalance: async (_account: string, asset: string) => {
      if (asset === USDC) return 10_000_000n;
      const c = coinByAsset.get(asset);
      return c !== undefined && o.now() >= ranAt(c) ? c.out : 0n;
    },
    nonceUsed: (_account: string, nonce: string, at?: string) => {
      // The watch asks at NEAR's final state; the deadline proof's reads at a block are its own.
      if (o.chain === 'hangs' && at === undefined) return new Promise<boolean | null>(() => {});
      const c = coinByNonce.get(nonce);
      return Promise.resolve(c !== undefined && o.now() >= ranAt(c));
    },
    finalBlock: async () => ({ hash: `blk-${o.now()}`, atMs: o.now() - 2_600 }),
    saltValid: async () => true,
  };
  return { api, chain, ranAt };
}

async function eightAtOnce(opts: { chain?: 'answers' | 'hangs' } = {}): Promise<Outcome[]> {
  const clock = sharedClock(START);
  const world = worldOf({ owner: OWNER, now: clock.now, runsAfterMs: RUNS_AFTER_MS, saysAfterMs: SAYS_AFTER_MS, lagsByMs: LAGS_BY_MS, ...opts });
  const rail = intentsNativeRail({
    keysPath: '/nonexistent',
    quoteKey: TEST_QUOTE_KEY,
    tokens,
    api: world.api,
    signer: { address: () => OWNER, signErc191: async () => 'secp256k1:stub' },
    ...world.chain,
    now: clock.now,
    sleepImpl: clock.sleep,
  });

  const runs = COINS.map(async (coin): Promise<Outcome> => {
    const told: Outcome['told'] = [];
    const hooks = {
      decidedBy: 'policy' as const,
      onEvidence: (e: RailEvidence) => {
        if (e.providerStage !== undefined) told.push({ at: clock.now(), stage: e.providerStage });
      },
    };
    const result = await rail.execute(draftOf(coin), `p-${coin.symbol}`, hooks);
    return { coin, result, doneAt: clock.now(), ranAt: world.ranAt(coin), told };
  });
  return clock.drive(Promise.all(runs));
}

// The card for one of the eight at `at`, as the executor would have written its row by then.
function cardAt(o: Outcome, at: number) {
  const open = o.doneAt > at;
  const stage = [...o.told].reverse().find((t) => t.at <= at)?.stage;
  const row: Proposal = {
    id: `p-${o.coin.symbol}`,
    kind: 'swap',
    createdAt: new Date(START).toISOString(),
    decidedAt: new Date(START).toISOString(),
    status: open ? 'executing' : o.result.ok ? 'executed' : 'needs_reconciliation',
    draft: draftOf(o.coin),
    simulation: null,
    verdict: { outcome: 'allow', reasons: [] },
    result: open
      ? { ok: false, detail: 'submitted, waiting for the venue', txids: [], evidence: stage === undefined ? {} : { providerStage: stage } }
      : { ok: o.result.ok, detail: o.result.detail, txids: o.result.txids ?? [], ...(o.result.evidence === undefined ? {} : { evidence: o.result.evidence }) },
    ...(open || o.result.pocket === undefined ? {} : { pocket: o.result.pocket, settledAt: new Date(o.doneAt).toISOString() }),
  };
  return proposalView({ settle: (p) => p }, row, at);
}

test('eight swaps at once: each is Done within one chain check of NEAR running it, whatever 1Click still says', async () => {
  const outcomes = await eightAtOnce();
  for (const o of outcomes) {
    const name = `${o.coin.symbol} (1Click ${o.coin.lags ? 'four minutes late' : 'prompt'})`;
    // Ten seconds after NEAR ran it, the card says Done and never that it waits for a buyer.
    const card = cardAt(o, o.ranAt + 10_000);
    assert.equal(card.state, 'done', `${name}: ten seconds after NEAR ran it the card reads ${card.stageLabel}, "${card.stageCopy}"`);
    assert.doesNotMatch(card.stageCopy, /waiting for a buyer/i, name);
    assert.equal(o.result.ok, true, `${name}: ${o.result.detail}`);
    const after = o.doneAt - o.ranAt;
    assert.ok(after >= 0, `${name} was Done before NEAR ran it`);
    assert.ok(after <= RAN_RECHECK_MS + 5_000, `${name} was Done ${Math.round(after / 1000)} s after NEAR ran it`);
    // What arrived is the verifier's figure against the read taken before the signature.
    assert.deepEqual(o.result.pocket && { before: o.result.pocket.before, after: o.result.pocket.after, floor: o.result.pocket.floor }, { before: '0', after: o.coin.out.toString(), floor: floorOf(o.coin).toString() }, name);
  }
});

test('the five 1Click was late on say how they were proved: NEAR showed the swap\'s own transfer spent and the coin arrived', async () => {
  const outcomes = await eightAtOnce();
  for (const o of outcomes.filter((x) => x.coin.lags)) {
    assert.match(
      o.result.detail,
      new RegExp(`^swapped 1\\.0168 USDC for ${units(o.coin.out).toString().replace('.', '\\.')} ${o.coin.symbol} inside intents\\.near, read back from the verifier .*NEAR showed this swap's own signed transfer spent while 1click still reported PROCESSING`),
    );
    assert.deepEqual(o.result.txids, [`intent-${handleOf(o.coin)}`]);
    assert.equal(o.told.at(-1)?.stage, 'PROCESSING', 'the row keeps 1Click\'s own last word');
  }
});

test('the three 1Click answered promptly settle on its SUCCESS exactly as before', async () => {
  const outcomes = await eightAtOnce();
  for (const o of outcomes.filter((x) => !x.coin.lags)) {
    assert.match(o.result.detail, /^swapped 1\.0168 USDC for [\d.]+ \w+ inside intents\.near, read back from the verifier rather than taken from the quote; intent /, o.coin.symbol);
    assert.doesNotMatch(o.result.detail, /signed transfer spent/, o.coin.symbol);
    assert.equal(o.told.at(-1)?.stage, 'SUCCESS', o.coin.symbol);
  }
});

test('a chain read that never answers holds up nothing: 1Click\'s answers land when they did, and the late five wait for its word as before', async () => {
  const answered = new Map((await eightAtOnce()).map((o) => [o.coin.symbol, o.doneAt]));
  for (const o of await eightAtOnce({ chain: 'hangs' })) {
    assert.equal(o.result.ok, true, `${o.coin.symbol}: ${o.result.detail}`);
    assert.doesNotMatch(o.result.detail, /signed transfer spent/, o.coin.symbol);
    if (o.coin.lags) assert.ok(o.doneAt >= o.ranAt + SAYS_AFTER_MS + LAGS_BY_MS, `${o.coin.symbol} ended before 1Click's word`);
    else assert.equal(o.doneAt, answered.get(o.coin.symbol), `${o.coin.symbol} settled later than with a chain that answers`);
  }
});

// ---------- through the app, read the way the window reads it ----------

/* The eight through the real proposal service and executor, in real time with the rail's polls
   cut to tens of milliseconds, and read as the window reads them: /api/state's proposals
   (stateProposals) with each row's view beside it (src/http/state.ts). The window repaints a card
   only from a row that frame carries (ui/screens/agent.js onProposals): a row the frame leaves out
   is a card that keeps what it last showed while its own clock counts "Taking longer". On
   2026-10-05 the frame's 6 KB of decided rows held three swaps of the eight; the agent, reading
   the store, said all eight went through while five cards waited for a buyer. */
async function throughTheApp(nearRuns: boolean) {
  const world = worldOf({ owner: SELF_EVM, now: Date.now, runsAfterMs: 150, saysAfterMs: 150, lagsByMs: 60_000, nearRuns });
  const rail = intentsNativeRail({
    keysPath: '/nonexistent',
    quoteKey: TEST_QUOTE_KEY,
    tokens,
    api: world.api,
    signer: { address: () => SELF_EVM, signErc191: async () => 'secp256k1:stub' },
    ...world.chain,
    firstPollMs: 10,
    pollIntervalMs: 40,
    pollTimeoutMs: 3_000,
    ranRecheckMs: 40,
    settleSchedule: { firstMs: 10, maxMs: 40, timeoutMs: 1_000 },
  });
  const policy = seededPolicy();
  policy.outbound.humanClickAboveUsd = 1_000;
  const h = makeCtx({ policy, deps: { rails: { for: (d) => (d.kind === 'swap' && d.venue === 'intents-native' ? rail : null), kinds: () => ['swap'] } } });
  const rows = await Promise.all(COINS.map((c) => h.svc.proposeSwap({ chain: 'base', toChain: 'arb', fromSymbol: 'USDC', toSymbol: c.symbol, amountIn: '1.0168', by: 'agent:test' })));
  return {
    h,
    ids: rows.map((r) => r.id),
    // What the window's cards are drawn from, by id.
    frame: () => new Map(stateProposals(h.store.list()).map((p) => [p.id, h.svc.view(p)])),
  };
}

async function until(check: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
}

test('through the app: every card the window draws says Done once NEAR shows its swap ran, the five 1Click is late on included', async () => {
  const app = await throughTheApp(true);
  await until(() => app.ids.every((id) => app.h.store.get(id)?.status === 'executed'), 8_000);
  const frame = app.frame();
  app.ids.forEach((id, i) => {
    const c = COINS[i]!;
    const row = app.h.store.get(id)!;
    assert.equal(row.status, 'executed', `${c.symbol}: ${row.result?.detail}`);
    if (c.lags) assert.match(row.result!.detail, /signed transfer spent while 1click still reported PROCESSING/, c.symbol);
    const card = frame.get(id);
    assert.ok(card !== undefined, `${c.symbol}: the store says executed and the window's frame does not carry the row, so its card stays as it last was`);
    assert.equal(card.state, 'done', `${c.symbol}: the card reads ${card.stageLabel}, "${card.stageCopy}"`);
  });
  await app.h.svc.settle(5_000);
});

test('through the app: while NEAR has not run a swap, its card stays on "Sent. Waiting for a buyer to take it."', async () => {
  const app = await throughTheApp(false);
  await until(() => app.ids.every((id) => app.h.store.get(id)?.result?.evidence?.providerStage === 'PROCESSING'), 5_000);
  // A few chain checks' worth of the watch asking, and NEAR saying no each time.
  await new Promise((resolve) => setTimeout(resolve, 400));
  const frame = app.frame();
  app.ids.forEach((id, i) => {
    const c = COINS[i]!;
    const card = frame.get(id);
    assert.ok(card !== undefined, `${c.symbol}: a move still running is missing from the window's frame`);
    assert.equal(card.state, 'working', `${c.symbol}: ${card.stageLabel}`);
    assert.equal(card.stageCopy, 'Sent. Waiting for a buyer to take it.', c.symbol);
  });
  await app.h.svc.settle(8_000);
});
