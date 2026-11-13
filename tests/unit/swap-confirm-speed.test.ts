// A swap is Done within seconds of NEAR crediting it, and only on a credit that is its own.
//
// 2026-11-13, proposal 96c21a96, wNEAR to ETH inside the verifier. Read back afterwards from the
// audit, 1Click's /v0/status and NEAR (nearblocks): submit-intent answered at 21:09:44.587; NEAR ran
// the signed transfer at 21:09:45.913 (block 224417945); the solver filled at 21:09:59.669 and the
// ETH was credited at 21:10:02.837 (block 224417975); 1Click's status turned SUCCESS at 21:10:08
// (its updatedAt); the card said Done at 21:10:09.433. Of the 24 s after PROCESSING, 17.6 s were
// the venue's own and 6.6 s were the watch: 1Click was read every 5 s by then, and NEAR's proof
// was asked only at those reads and answered at the next one.
//
// Run: node --test tests/unit/swap-confirm-speed.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildNonce } from '../../src/relay/payload.ts';
import { INTENTS_NATIVE_COUNTERPARTY, INTENTS_VERIFIER, intentsNativeRail, otherMoneyOnCoin } from '../../src/rails/intents-native.ts';
import { parseStatus } from '../../src/intents.ts';
import type { OneClickQuote } from '../../src/intents.ts';
import type { Proposal, RailResult, SwapDraft } from '../../src/types.ts';
import { TEST_QUOTE_KEY, signQuote } from './helpers/signed-quote.ts';

const OWNER = '0xDc89478470f029DC4Da46114a59AE60aDA952Be8';
const USDC = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
const ETH = 'nep141:arb-0x0000000000000000000000000000000000000001.omft.near';
const START = Date.parse('2026-11-13T21:09:44.587Z');
const SPEND = 370_000n; // 0.37 USDC
const OUT = 19_019_857n; // the quote's amountOut, 8 decimals
const FLOOR = (OUT * 99n) / 100n;
const tokens = {
  eth: {},
  base: { USDC: { tokenId: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6 } },
  arb: { ETH: { tokenId: '0x0000000000000000000000000000000000000001', decimals: 8 } },
  sol: {},
  near: {},
};
const list = [
  { assetId: USDC, decimals: 6, blockchain: 'base', symbol: 'USDC', contractAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' },
  { assetId: ETH, decimals: 8, blockchain: 'arb', symbol: 'ETH', contractAddress: '0x0000000000000000000000000000000000000001' },
];

const draft: SwapDraft = {
  kind: 'swap',
  venue: 'intents-native',
  chain: 'base',
  toChain: 'arb',
  fromSymbol: 'USDC',
  toSymbol: 'ETH',
  amountIn: 0.37,
  amountInExact: '0.37',
  amountUsd: 0.37,
  minAmountOut: Number(FLOOR) / 1e8,
  from: OWNER,
  to: OWNER,
  counterparty: INTENTS_NATIVE_COUNTERPARTY,
  quote: null,
  assets: { origin: { assetId: USDC, decimals: 6 }, destination: { assetId: ETH, decimals: 8 } },
};

/* One clock for every swap: a sleep waits on it, and once every swap is waiting it jumps to the
   earliest sleeper (as tests/unit/swap-ran-proof.test.ts). */
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

/* One swap's venue and chain, by its handle, on times measured from its submit. `paysAt` is when
   NEAR credits the bought coin (Infinity: never), `paid` how much; `says` is 1Click's word at a
   moment; `finalMs` is how far NEAR's final state trails the head; every read takes `readMs`. */
type Leg = { handle: string; paysAt: number; paid: bigint; runsAt: number; says: (t: number) => string };
type WorldOpts = { now: () => number; sleep: (ms: number) => Promise<void>; legs: Leg[]; finalMs: number; readMs: number; extraCredit?: { at: number; amount: bigint } };

function worldOf(o: WorldOpts) {
  const submitted = new Map<string, number>();
  const nonceOf = (i: number): string => buildNonce({ salt: Uint8Array.from([0x25, 0x28, 0x12, 0xb3]), deadlineMs: START + 72 * 3_600_000, random: new Uint8Array(15).fill(i + 1) });
  let quotes = 0;
  const since = (leg: Leg): number => o.now() - (submitted.get(leg.handle) ?? Infinity);
  const final = (leg: Leg, at: number): boolean => since(leg) >= at + o.finalMs;
  const api = {
    tokens: async () => list,
    quote: async (q: { dry: boolean }) => {
      const leg = o.legs[Math.min(quotes, o.legs.length - 1)]!;
      if (!q.dry) quotes += 1;
      const signed = signQuote({
        quote: {
          amountIn: SPEND.toString(),
          amountInFormatted: '0.37',
          amountInUsd: '0.37',
          minAmountIn: SPEND.toString(),
          amountOut: OUT.toString(),
          amountOutFormatted: String(Number(OUT) / 1e8),
          amountOutUsd: '0.3688',
          minAmountOut: ((OUT * 995n) / 1000n).toString(),
          timeEstimate: 12,
          depositAddress: leg.handle,
        },
        quoteRequest: { dry: q.dry, originAsset: USDC, destinationAsset: ETH, amount: SPEND.toString(), depositType: 'INTENTS', recipientType: 'INTENTS', recipient: OWNER, refundType: 'INTENTS', refundTo: OWNER },
      });
      return { quote: signed['quote'] as OneClickQuote, raw: signed };
    },
    generateIntent: async ({ depositAddress }: { depositAddress: string }) => {
      const i = o.legs.findIndex((l) => l.handle === depositAddress);
      const payload = JSON.stringify({
        signer_id: OWNER.toLowerCase(),
        verifying_contract: INTENTS_VERIFIER,
        deadline: new Date(o.now() + 72 * 3_600_000).toISOString(),
        nonce: nonceOf(i),
        intents: [{ intent: 'transfer', receiver_id: depositAddress, tokens: { [USDC]: SPEND.toString() } }],
      });
      return { standard: 'erc191', payload, correlationId: `c-${i}` };
    },
    submitIntent: async ({ payload }: { payload: string }) => {
      const handle = (JSON.parse(payload) as { intents: Array<{ receiver_id: string }> }).intents[0]!.receiver_id;
      submitted.set(handle, o.now());
      return { intentHash: `intent-${handle}`, correlationId: 'c' };
    },
    status: async (handle: string) => {
      await o.sleep(o.readMs);
      const leg = o.legs.find((l) => l.handle === handle)!;
      return parseStatus({ status: leg.says(since(leg)) });
    },
  };
  const chain = {
    verifierBalance: async (_account: string, asset: string) => {
      await o.sleep(o.readMs);
      if (asset === USDC) return 10_000_000n;
      let held = 0n;
      for (const leg of o.legs) if (final(leg, leg.paysAt)) held += leg.paid;
      if (o.extraCredit !== undefined && o.now() - START >= o.extraCredit.at + o.finalMs) held += o.extraCredit.amount;
      return held;
    },
    nonceUsed: async (_account: string, nonce: string) => {
      await o.sleep(o.readMs);
      const i = o.legs.findIndex((_l, k) => nonceOf(k) === nonce);
      return i >= 0 && final(o.legs[i]!, o.legs[i]!.runsAt);
    },
    finalBlock: async () => ({ hash: `blk-${o.now()}`, atMs: o.now() - o.finalMs }),
    saltValid: async () => true,
  };
  return { api, chain, submittedAt: (handle: string) => submitted.get(handle) ?? NaN };
}

function railOn(clock: ReturnType<typeof sharedClock>, world: ReturnType<typeof worldOf>, proposals?: () => readonly Proposal[]) {
  return intentsNativeRail({
    keysPath: '/nonexistent',
    quoteKey: TEST_QUOTE_KEY,
    tokens,
    api: world.api,
    signer: { address: () => OWNER, signErc191: async () => 'secp256k1:stub' },
    ...world.chain,
    now: clock.now,
    sleepImpl: clock.sleep,
    ...(proposals === undefined ? {} : { proposals }),
  });
}

// 1Click's words for the live swap, by time since the submit: SUCCESS at 21:10:08.000.
const LIVE_SUCCESS_AT = 23_413;
const LIVE_SAYS = (t: number): string => (t < 400 ? 'PENDING_DEPOSIT' : t < LIVE_SUCCESS_AT ? 'PROCESSING' : 'SUCCESS');
const LIVE_RUNS_AT = 1_326; // NEAR ran the signed transfer (block 224417945)
const LIVE_PAYS_AT = 18_250; // and credited the ETH (block 224417975)
const FINAL_MS = 1_400; // NEAR's final state about two blocks behind the head
const READ_MS = 225; // a 1Click or RPC read, as the live poll's spacing shows

test('the live swap of 2026-11-13 replayed: Done within seconds of NEAR crediting it, never before NEAR\'s final state shows it', async () => {
  const clock = sharedClock(START);
  const leg: Leg = { handle: '82e2827f0edc7cf2cb6df1ebb9f2b3014c236c10e6b5f01a371393e6f2661947', paysAt: LIVE_PAYS_AT, paid: 18_997_253n, runsAt: LIVE_RUNS_AT, says: LIVE_SAYS };
  const world = worldOf({ now: clock.now, sleep: clock.sleep, legs: [leg], finalMs: FINAL_MS, readMs: READ_MS });
  const rail = railOn(clock, world);
  const result = await clock.drive(rail.execute(draft, 'p-live', { decidedBy: 'human' }));
  const submitAt = world.submittedAt(leg.handle);
  const credited = submitAt + LIVE_PAYS_AT;
  const visible = credited + FINAL_MS;
  const after = clock.now() - credited;
  // The replay's figure beside the live one (6596 ms): the rail before this change replays it as 6750 ms.
  console.log(`replay: Done ${after} ms after NEAR credited the coin; 1Click said SUCCESS ${LIVE_SUCCESS_AT - LIVE_PAYS_AT} ms after it`);
  assert.equal(result.ok, true, result.detail);
  assert.ok(clock.now() >= visible, `Done ${visible - clock.now()} ms before NEAR's final state showed the credit`);
  assert.ok(after <= 4_000, `Done ${after} ms after NEAR credited the coin`);
  assert.match(result.detail, /NEAR showed this swap's own signed transfer spent while 1click still reported PROCESSING/);
  assert.deepEqual(result.pocket && { before: result.pocket.before, after: result.pocket.after }, { before: '0', after: '18997253' }, 'the amount is the verifier\'s');
});

/* Two swaps buying the same coin at once. The first is paid; 1Click refunds the second, which NEAR
   never pays. Both signed transfers ran, so the second one's balance rose by the first one's coin
   and its nonce is spent: on NEAR's word alone it would be Done with coin that is not its own. A
   crowded swap waits for 1Click instead, so the first settles on SUCCESS and the second on REFUNDED. */
test('two swaps buying the same coin at once: neither is Done on NEAR\'s word, and the refunded one never says Done', async () => {
  const clock = sharedClock(START);
  const paid: Leg = { handle: 'q-paid.1click.near', paysAt: 6_000, paid: 18_997_253n, runsAt: 1_000, says: (t) => (t < 30_000 ? 'PROCESSING' : 'SUCCESS') };
  const refunded: Leg = { handle: 'q-refunded.1click.near', paysAt: Infinity, paid: 0n, runsAt: 1_000, says: (t) => (t < 40_000 ? 'PROCESSING' : 'REFUNDED') };
  const world = worldOf({ now: clock.now, sleep: clock.sleep, legs: [paid, refunded], finalMs: FINAL_MS, readMs: READ_MS });
  const rail = railOn(clock, world);
  const [first, second] = await clock.drive(Promise.all([rail.execute(draft, 'p-paid', { decidedBy: 'human' }), rail.execute(draft, 'p-refunded', { decidedBy: 'human' })]));
  assert.equal(first!.ok, true, first!.detail);
  assert.doesNotMatch(first!.detail, /signed transfer spent/, 'the paid one settled on NEAR\'s word while another swap could credit its coin');
  assert.equal(second!.ok, false, `the refunded swap said Done: ${second!.detail}`);
  assert.doesNotMatch(second!.detail, /^swapped/);
});

/* The proposal store sees what the rail's memory cannot: a swap from before a restart, or one on
   the relay, still on its way to the same coin. While one is open the swap waits for 1Click. */
test('another open move to the same coin in the store holds the swap to 1Click\'s word; one to another coin does not', async () => {
  const row = (over: Partial<Proposal>): Proposal => ({
    id: 'p-other',
    kind: 'swap',
    createdAt: new Date(START - 60_000).toISOString(),
    decidedAt: new Date(START - 60_000).toISOString(),
    status: 'needs_reconciliation',
    draft: { ...draft, venue: 'intents-relay' },
    simulation: null,
    verdict: { outcome: 'allow', reasons: [] },
    result: { ok: false, detail: 'settling', txids: ['h'], evidence: { handle: 'q-relay' } },
    ...over,
  });
  const run = async (rows: Proposal[]): Promise<RailResult> => {
    const clock = sharedClock(START);
    const leg: Leg = { handle: 'q-one.1click.near', paysAt: 6_000, paid: 18_997_253n, runsAt: 1_000, says: (t) => (t < 30_000 ? 'PROCESSING' : 'SUCCESS') };
    const world = worldOf({ now: clock.now, sleep: clock.sleep, legs: [leg], finalMs: FINAL_MS, readMs: READ_MS });
    return clock.drive(railOn(clock, world, () => rows).execute(draft, 'p-self', { decidedBy: 'human' }));
  };
  assert.doesNotMatch((await run([row({})])).detail, /signed transfer spent/, 'a relay swap still settling on the coin');
  assert.match((await run([row({ draft: { ...draft, assets: { origin: draft.assets!.origin, destination: { assetId: 'nep141:other.near', decimals: 8 } } } })])).detail, /signed transfer spent/);
  assert.match((await run([row({ id: 'p-self', status: 'executing' })])).detail, /signed transfer spent/, 'its own row is not other money');

  // The rules on their own.
  const now = START;
  assert.equal(otherMoneyOnCoin([row({})], ETH, 'p-self', now, now), true);
  assert.equal(otherMoneyOnCoin([row({ status: 'failed', result: { ok: false, detail: 'refunded', txids: ['h'], evidence: { handle: 'q', providerStage: 'REFUNDED' } } })], ETH, 'p-self', now, now), false, 'refunded is over');
  assert.equal(otherMoneyOnCoin([row({ status: 'failed', result: { ok: false, detail: 'failed', txids: ['h'], evidence: { handle: 'q' } } })], ETH, 'p-self', now, now), true, 'signed and failed may still land');
  assert.equal(otherMoneyOnCoin([row({ status: 'executed', settledAt: new Date(now - 1).toISOString() })], ETH, 'p-self', now, now), false, 'settled before the watch began: in the read before');
  assert.equal(otherMoneyOnCoin([row({ status: 'executed', settledAt: new Date(now + 1).toISOString() })], ETH, 'p-self', now, now + 2), true, 'settled inside the watch: maybe in the rise');
  assert.equal(otherMoneyOnCoin([row({ decidedAt: new Date(now - 25 * 3_600_000).toISOString() })], ETH, 'p-self', now, now), false, 'older than a day');
});

/* A rise far over what the signed quote said arrives is not this swap's alone (another credit of the
   coin landed with it): the swap waits for 1Click, whose SUCCESS then settles it as before. */
test('a rise over the signed quote\'s amount out is not taken as the swap\'s own', async () => {
  const clock = sharedClock(START);
  const leg: Leg = { handle: 'q-cap.1click.near', paysAt: 6_000, paid: 18_997_253n, runsAt: 1_000, says: (t) => (t < 30_000 ? 'PROCESSING' : 'SUCCESS') };
  const world = worldOf({ now: clock.now, sleep: clock.sleep, legs: [leg], finalMs: FINAL_MS, readMs: READ_MS, extraCredit: { at: 5_000, amount: 50_000_000n } });
  const result = await clock.drive(railOn(clock, world).execute(draft, 'p-cap', { decidedBy: 'human' }));
  assert.equal(result.ok, true, result.detail);
  assert.doesNotMatch(result.detail, /signed transfer spent/);
  assert.ok(clock.now() - world.submittedAt(leg.handle) >= 30_000, 'it did not wait for 1Click');
});
