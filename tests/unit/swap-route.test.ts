// The swap route: the relay first, the 1Click rail when the relay offers no price for the pair.
//
// On the default config every swap was drafted for the solver relay, and the relay quotes only
// the pairs a solver on it serves: USDC to ETH, wNEAR or Base ETH were refused at any size while
// 1Click priced them (live, 2026-10-02). Now the same swap is drafted on the 1Click rail before the
// card is priced (src/proposals/swap-route.ts), and that rail's own checks hold it.
//
// Both rails here are the real ones, end to end through the proposal service: the relay rail over
// a fake relay, the 1Click rail over the real quote client and a fake 1Click on the wire that prices
// what it is asked, echoes the request with the live defaults and its one fee account, and signs
// with the test key. Nothing touches a network or a real key.
//
// Run: node --test tests/unit/swap-route.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatUnits } from 'viem';

import type { Proposal, SwapDraft, WriteDraft } from '../../src/types.ts';
import type { OneClickToken, TokensFile } from '../../src/intents.ts';
import { baseUnitsToDecimal, oneClickClient } from '../../src/intents.ts';
import type { IntentsActivity } from '../../src/chainscan/index.ts';
import type { RailRegistry } from '../../src/rails/index.ts';
import { INTENTS_NATIVE_COUNTERPARTY, INTENTS_NATIVE_VENUE, intentsNativeRail } from '../../src/rails/intents-native.ts';
import { INTENTS_RELAY_COUNTERPARTY, INTENTS_RELAY_VENUE, intentsRelayRail } from '../../src/rails/intents-relay.ts';
import type { RelayClient, RelayQuote } from '../../src/relay/client.ts';
import type { VerifierPort } from '../../src/relay/verifier.ts';
import { floorUnderQuote } from '../../src/rails/slippage.ts';
import { landed, makeCtx, railThat, SELF_EVM } from './helpers/proposals.ts';
import { TEST_QUOTE_KEY, signQuote } from './helpers/signed-quote.ts';

const USDC = 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near';
const USDT = 'nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near';
const ETH = 'nep141:eth.omft.near';
const ZZZ_BASE = 'nep141:base-0x00000000000000000000000000000000000000aa.omft.near';
const ZZZ_ARB = 'nep141:arb-0x00000000000000000000000000000000000000bb.omft.near';
const HANDLE = 'q-route.1click.near';
const FEE_ACCOUNT = '5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd';
const ACCOUNT = SELF_EVM.toLowerCase();

const LIST = [
  { assetId: USDC, decimals: 6, blockchain: 'eth', symbol: 'USDC', contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', price: 1 },
  { assetId: USDT, decimals: 6, blockchain: 'eth', symbol: 'USDT', contractAddress: '0xdac17f958d2ee523a2206206994597c13d831ec7', price: 1 },
  { assetId: ETH, decimals: 18, blockchain: 'eth', symbol: 'ETH', price: 2500 },
  // One coin on two networks and none on NEAR, so a swap into it by name asks what each would get.
  { assetId: ZZZ_BASE, decimals: 18, blockchain: 'base', symbol: 'ZZZ', contractAddress: '0x00000000000000000000000000000000000000aa', price: 2 },
  { assetId: ZZZ_ARB, decimals: 18, blockchain: 'arb', symbol: 'ZZZ', contractAddress: '0x00000000000000000000000000000000000000bb', price: 2 },
] as OneClickToken[];
const PRICE = new Map(LIST.map((t) => [t.assetId, { usd: t.price as number, decimals: t.decimals }]));
const NO_REGISTRY = { eth: {}, base: {}, arb: {}, sol: {}, near: {} } as TokensFile;

const pair = (a: string, b: string): string => `${a}>${b}`;

// What an amount of one coin buys of another at the list prices, less `lossBps`.
function fairOut(assetIn: string, assetOut: string, amountIn: bigint, lossBps = 0n): bigint {
  const from = PRICE.get(assetIn)!;
  const to = PRICE.get(assetOut)!;
  const micro = (usd: number): bigint => BigInt(Math.round(usd * 1e6));
  return (amountIn * micro(from.usd) * 10n ** BigInt(to.decimals) * (10_000n - lossBps)) / (micro(to.usd) * 10n ** BigInt(from.decimals) * 10_000n);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/* What the two venues do, changeable mid-test: the pairs a relay solver serves with what each
   answer gives up in basis points, the pairs 1Click has nobody for, and what 1Click's own answer
   gives up beyond its 1 bp (its own dollar figures say so). */
type Tune = {
  relay: Map<string, bigint>;
  oneClickNone: Set<string>;
  oneClickLoss: (assetOut: string) => bigint;
};

/* The two venues, the signers and the verifier, recorded. `credited` is what each swap left in the
   balance once its venue ran it, so the after-reads show the swap that was signed. */
function world(start: Partial<{ relay: Record<string, bigint>; oneClickNone: string[]; oneClickLoss: (assetOut: string) => bigint }> = {}) {
  const tune: Tune = {
    relay: new Map(Object.entries(start.relay ?? {})),
    oneClickNone: new Set(start.oneClickNone ?? []),
    oneClickLoss: start.oneClickLoss ?? (() => 0n),
  };
  const clock = { now: Date.now() };
  const asked = {
    relay: [] as Array<{ assetIn: string; assetOut: string }>,
    oneClick: [] as Array<Record<string, unknown>>, // every /v0/quote body, dry or live
    generated: 0,
    submitted: 0,
    published: 0,
  };
  const signatures: Array<{ rail: 'relay' | 'native'; payload: string }> = [];
  const credited = new Map<string, bigint>();
  let lastLive: { originAsset: string; amount: string; destinationAsset: string; out: bigint } | null = null;

  // 1Click on the wire: prices what it is asked, echoes it with the live defaults and its fee line, signs.
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/v0/tokens')) return json(LIST);
    if (u.endsWith('/v0/quote')) {
      const req = JSON.parse(String(init?.body)) as Record<string, any>;
      asked.oneClick.push(req);
      if (tune.oneClickNone.has(pair(req['originAsset'], req['destinationAsset']))) return json({ message: 'No liquidity available' }, 400);
      const amountIn = BigInt(req['amount']);
      const out = fairOut(req['originAsset'], req['destinationAsset'], amountIn, 1n + tune.oneClickLoss(req['destinationAsset']));
      const inMeta = PRICE.get(req['originAsset'])!;
      const outMeta = PRICE.get(req['destinationAsset'])!;
      const quote: Record<string, unknown> = {
        amountIn: req['amount'],
        amountInFormatted: String(Number(amountIn) / 10 ** inMeta.decimals),
        amountInUsd: String((Number(amountIn) / 10 ** inMeta.decimals) * inMeta.usd),
        minAmountIn: req['amount'],
        amountOut: out.toString(),
        amountOutFormatted: String(Number(out) / 10 ** outMeta.decimals),
        amountOutUsd: String((Number(out) / 10 ** outMeta.decimals) * outMeta.usd),
        minAmountOut: ((out * BigInt(10_000 - Number(req['slippageTolerance']))) / 10_000n).toString(),
        timeEstimate: 10,
      };
      if (req['dry'] === false) {
        Object.assign(quote, { depositAddress: HANDLE, deadline: req['deadline'], timeWhenInactive: req['deadline'] });
        lastLive = { originAsset: req['originAsset'], amount: req['amount'], destinationAsset: req['destinationAsset'], out };
      }
      const echo = { depositMode: 'SIMPLE', ...req, confidentiality: 'public', quoteWaitingTimeMs: 0, insured: false, appFees: [{ recipient: FEE_ACCOUNT, fee: 1 }] };
      return json(signQuote({ quoteRequest: echo, quote }));
    }
    if (u.endsWith('/v0/generate-intent')) {
      asked.generated += 1;
      const live = lastLive!;
      const payload = JSON.stringify({
        signer_id: ACCOUNT,
        verifying_contract: 'intents.near',
        deadline: new Date(Date.now() + 72 * 3600_000).toISOString(),
        nonce: 'cm91dGUtcm91dGUtcm91dGUtcm91dGUtcm91dGU=',
        intents: [{ intent: 'transfer', receiver_id: HANDLE, tokens: { [live.originAsset]: live.amount } }],
      });
      return json({ intent: { standard: 'erc191', payload } }, 201);
    }
    if (u.endsWith('/v0/submit-intent')) {
      asked.submitted += 1;
      const live = lastLive!;
      credited.set(live.destinationAsset, (credited.get(live.destinationAsset) ?? 0n) + live.out);
      return json({ intentHash: '44XpLRAuZKoVGs9T4qbSNv33MDKMePPAibA52geVLWFw' });
    }
    if (u.includes('/v0/status')) return json({ status: 'SUCCESS', swapDetails: {} });
    throw new Error(`unexpected request to ${u}`);
  }) as typeof fetch;

  const relay: RelayClient = {
    async quote(req) {
      asked.relay.push({ assetIn: req.assetIn, assetOut: req.assetOut });
      const loss = tune.relay.get(pair(req.assetIn, req.assetOut));
      if (loss === undefined) return [];
      const quote: RelayQuote = {
        quoteHash: `rq-${asked.relay.length}`,
        assetIn: req.assetIn,
        assetOut: req.assetOut,
        amountIn: req.exactAmountIn,
        amountOut: fairOut(req.assetIn, req.assetOut, BigInt(req.exactAmountIn), loss).toString(),
        expirationTime: new Date(clock.now + 60_000).toISOString(),
      };
      return [quote];
    },
    async publishIntent(req) {
      asked.published += 1;
      const diff = (JSON.parse(req.payload) as { intents: Array<{ diff: Record<string, string> }> }).intents[0]!.diff;
      for (const [asset, delta] of Object.entries(diff)) if (!delta.startsWith('-')) credited.set(asset, (credited.get(asset) ?? 0n) + BigInt(delta));
      return { status: 'OK', intentHash: 'relay-intent-1' };
    },
    async status(intentHash) {
      return { intentHash, status: 'SETTLED', statusDetails: null, nearTxHash: 'near-tx-1', filledAmounts: [] };
    },
  };

  // 1,000 USDC held, and what each swap credited once its venue ran it.
  const balanceOf = async (_account: string, asset: string): Promise<bigint> => (asset === USDC ? 1_000_000_000n : (credited.get(asset) ?? 0n));
  const signerFor = (rail: 'relay' | 'native') => ({
    address: () => SELF_EVM as `0x${string}`,
    async signErc191(_keysPath: string, payload: string): Promise<string> {
      signatures.push({ rail, payload });
      return 'secp256k1:test-signature';
    },
  });
  const verifier: VerifierPort = {
    balance: balanceOf,
    currentSalt: async () => Uint8Array.from([1, 2, 3, 4]),
    nonceUsed: async () => true,
    isValidSalt: async () => true,
  };

  const client = oneClickClient({ fetchImpl });
  const settleSchedule = { firstMs: 1, maxMs: 2, timeoutMs: 6 };
  const relayRail = intentsRelayRail({
    keysPath: '/nonexistent/keys.json',
    tokens: NO_REGISTRY,
    signer: signerFor('relay'),
    relay,
    client,
    quoteKey: TEST_QUOTE_KEY,
    verifier,
    now: () => clock.now,
    sleepImpl: async () => {},
    firstPollMs: 1,
    pollIntervalMs: 1,
    settleSchedule,
  });
  const nativeRail = intentsNativeRail({
    keysPath: '/nonexistent/keys.json',
    tokens: NO_REGISTRY,
    quoteKey: TEST_QUOTE_KEY,
    fetchImpl,
    client,
    signer: signerFor('native'),
    verifierBalance: balanceOf,
    nonceUsed: async () => true,
    finalBlock: async () => null,
    saltValid: async () => null,
    sleepImpl: async () => {},
    firstPollMs: 1,
    pollIntervalMs: 1,
    pollTimeoutMs: 50,
    settleSchedule,
  });

  // The live registry's dispatch (src/rails/index.ts): the draft's venue picks, a bare kind is the relay.
  const registry: RailRegistry = {
    for: (draft: WriteDraft) => (draft.kind !== 'swap' ? null : (draft as SwapDraft).venue === INTENTS_NATIVE_VENUE ? nativeRail : relayRail),
    kinds: () => ['swap'],
    swap: {
      tokens: async () => LIST,
      balance: balanceOf,
      activity: async () => ({ account: ACCOUNT, ok: true, rows: [], balances: null, partial: false, source: 'test', explorer: null, note: '' }) as unknown as IntentsActivity,
    },
  };
  const h = makeCtx({ deps: { rails: registry, held: { retryMs: 600_000, maxMs: 3_600_000 } } });
  return { h, tune, asked, signatures, clock };
}

function swapOf(p: Proposal): SwapDraft {
  assert.equal(p.draft.kind, 'swap');
  return p.draft as SwapDraft;
}

const live = (w: ReturnType<typeof world>) => w.asked.oneClick.filter((q) => q['dry'] === false);

const USDC_TO_ETH = { chain: 'eth', toChain: 'eth', fromSymbol: 'USDC', toSymbol: 'ETH', amountIn: '10' };
const USDC_TO_USDT = { chain: 'eth', toChain: 'eth', fromSymbol: 'USDC', toSymbol: 'USDT', amountIn: '10' };
const RELAY_SERVES_USDT = { relay: { [pair(USDC, USDT)]: 0n } };

// ---------- the route ----------

test('USDC to ETH on the default config: the relay has nobody, so the 1Click rail prices it, lands it and runs it, signed once', async () => {
  const w = world(RELAY_SERVES_USDT);
  const p = await landed(w.h, w.h.svc.proposeSwap(USDC_TO_ETH));
  assert.equal(p.status, 'executed', String(p.result?.detail ?? p.verdict.reasons.at(-1)));
  assert.equal(p.decidedBy, 'policy', 'a small swap still runs on the rules alone');

  const draft = swapOf(p);
  assert.equal(draft.venue, INTENTS_NATIVE_VENUE, 'the row names the route that ran');
  assert.equal(draft.counterparty, INTENTS_NATIVE_COUNTERPARTY);
  // The floor came off 1Click's answer, one percent under it, and the card's coins are pinned.
  assert.equal(draft.minAmountOut, floorUnderQuote(Number(formatUnits(fairOut(USDC, ETH, 10_000_000n, 1n), 18))));
  assert.deepEqual(draft.assets, { origin: { assetId: USDC, decimals: 6 }, destination: { assetId: ETH, decimals: 18 } });
  // The card is 1Click's: its figures and its time.
  assert.equal(p.simulation?.ok, true);
  assert.equal(p.simulation?.swap?.etaSeconds, 10);
  assert.match(p.simulation?.summary ?? '', /^About 0\.0039\d* ETH on Ethereum, at least [\d.]+\. Fee under a cent, about 10 seconds\.$/);

  // The relay was asked once, at propose; everything after it was the 1Click rail's.
  assert.deepEqual(w.asked.relay, [{ assetIn: USDC, assetOut: ETH }]);
  assert.equal(w.asked.published, 0);
  assert.equal(live(w).length, 1, 'one live quote at the click');
  assert.equal(w.asked.generated, 1);
  assert.equal(w.asked.submitted, 1);
  assert.deepEqual(w.signatures.map((s) => s.rail), ['native'], 'one signature, by the 1Click rail');
  const signed = JSON.parse(w.signatures[0]!.payload) as Record<string, any>;
  assert.equal(signed['intents'][0]['receiver_id'], HANDLE);
  assert.deepEqual(signed['intents'][0]['tokens'], { [USDC]: '10000000' });
  assert.ok(Date.parse(signed['deadline']) - Date.now() <= 3 * 60_000, 'the deadline was cut to three minutes before signing');
  assert.match(String(p.result?.detail), /read back from the verifier/);

  // The row is done: asking it to run again signs nothing more.
  await w.h.svc.approve(p.id).catch(() => null);
  assert.equal(w.signatures.length, 1);
});

test('USDC to USDT stays on the relay: 1Click is asked only for the signed price beside it, and the relay signs once', async () => {
  const w = world(RELAY_SERVES_USDT);
  const p = await landed(w.h, w.h.svc.proposeSwap(USDC_TO_USDT));
  assert.equal(p.status, 'executed', String(p.result?.detail ?? p.verdict.reasons.at(-1)));
  const draft = swapOf(p);
  assert.equal(draft.venue, INTENTS_RELAY_VENUE);
  assert.equal(draft.counterparty, INTENTS_RELAY_COUNTERPARTY);
  assert.match(p.simulation?.developer ?? '', /checked against 1Click's signed dry quote/);
  assert.deepEqual(live(w), [], 'no live 1Click quote');
  assert.equal(w.asked.generated, 0);
  assert.equal(w.asked.submitted, 0);
  assert.equal(w.asked.published, 1);
  assert.deepEqual(w.signatures.map((s) => s.rail), ['relay'], 'one signature, by the relay rail');
});

test('a pair neither rail quotes is refused calmly as no price, and nothing is signed', async () => {
  const w = world({ oneClickNone: [pair(USDC, ETH)] });
  const p = await landed(w.h, w.h.svc.proposeSwap(USDC_TO_ETH));
  assert.equal(p.status, 'policy_refused');
  assert.deepEqual(p.verdict.reasonCodes, ['no_price']);
  assert.equal(p.verdict.reasons.at(-1), 'Nobody offered a price for USDC to ETH right now, so no floor could be set. Try again in a minute.');
  const view = w.h.svc.view(p);
  assert.equal(view.reason?.sentence, 'Nobody is offering a price for USDC to ETH right now, so nothing moved. Try again in a minute.');
  assert.equal(view.reason?.retry, true);
  assert.equal(w.asked.relay.length, 1);
  assert.equal(w.asked.oneClick.length, 2, "the relay's signed price, then the 1Click rail's own ask");
  assert.deepEqual(w.signatures, []);
});

test('a floor the agent names asks for no price first: the relay simulation finds nobody, and the 1Click rail simulates and runs it', async () => {
  const w = world();
  const floor = Math.floor((Number(fairOut(USDC, ETH, 10_000_000n)) / 1e18) * 0.99 * 1e9) / 1e9;
  const p = await landed(w.h, w.h.svc.proposeSwap({ ...USDC_TO_ETH, minAmountOut: floor }));
  assert.equal(p.status, 'executed', String(p.result?.detail ?? p.verdict.reasons.at(-1)));
  const draft = swapOf(p);
  assert.equal(draft.venue, INTENTS_NATIVE_VENUE);
  assert.equal(draft.minAmountOut, floor, "the agent's floor is the one held");
  assert.deepEqual(w.signatures.map((s) => s.rail), ['native']);
});

test('one rail for both venues (demo mode, a hand-built registry) has no other route: nobody is nobody, asked once', async () => {
  let asked = 0;
  const only = { ...railThat('swap', async () => ({ ok: true, detail: 'swapped' })), quote: async () => ((asked += 1), null) };
  const h = makeCtx({ rails: [only] });
  const p = await h.svc.proposeSwap(USDC_TO_ETH);
  assert.deepEqual(p.verdict.reasonCodes, ['no_price']);
  assert.equal(swapOf(p).venue, INTENTS_RELAY_VENUE);
  assert.equal(asked, 1);
});

// ---------- the 3 percent cap, on either route ----------

test('the 3 percent cap refuses a relay price past it, and a bad relay price is never routed around', async () => {
  const w = world({ relay: { [pair(USDC, USDT)]: 500n } });
  const p = await landed(w.h, w.h.svc.proposeSwap(USDC_TO_USDT));
  assert.equal(p.status, 'policy_refused');
  assert.match(p.verdict.reasons.at(-1) ?? '', /gives up 5\.0 percent of its value .* more than the 3 percent/);
  assert.equal(swapOf(p).venue, INTENTS_RELAY_VENUE, 'the refusal is the relay route, not a quiet move to 1Click');
  assert.deepEqual(live(w), []);
  assert.deepEqual(w.signatures, []);
});

test('the 3 percent cap refuses a 1Click price past it once the swap has moved there, at the propose and at the click', async () => {
  const w = world({ oneClickLoss: (out) => (out === ETH ? 500n : 0n) });
  const p = await landed(w.h, w.h.svc.proposeSwap(USDC_TO_ETH));
  assert.equal(p.status, 'policy_refused');
  assert.match(p.verdict.reasons.at(-1) ?? '', /No floor could be set for USDC to ETH: this swap gives up 5\.0 percent of its value .* by 1Click's own prices/);
  assert.equal(swapOf(p).venue, INTENTS_NATIVE_VENUE);
  assert.deepEqual(live(w), []);
  assert.deepEqual(w.signatures, []);

  // Over the click line the card waits; the price turns before the click, and the key is never used.
  const late = world();
  const pending = await landed(late.h, late.h.svc.proposeSwap({ ...USDC_TO_ETH, amountIn: '150' }));
  assert.equal(pending.status, 'pending');
  assert.equal(swapOf(pending).venue, INTENTS_NATIVE_VENUE);
  late.tune.oneClickLoss = (out) => (out === ETH ? 500n : 0n);
  const clicked = await landed(late.h, late.h.svc.approve(pending.id));
  assert.equal(clicked.status, 'failed');
  assert.match(String(clicked.result?.detail), /gives up 5\.0 percent of its value/);
  assert.equal(live(late).length, 1);
  assert.equal(late.asked.generated, 0);
  assert.deepEqual(late.signatures, []);
});

// ---------- one route per move, decided at propose ----------

test('a row on the relay stays on the relay: with nobody there at the click it holds, and 1Click is never asked to run it', async () => {
  const w = world(RELAY_SERVES_USDT);
  const p = await landed(w.h, w.h.svc.proposeSwap({ ...USDC_TO_USDT, amountIn: '150' }));
  assert.equal(p.status, 'pending', 'over the click line');
  assert.equal(swapOf(p).venue, INTENTS_RELAY_VENUE);

  // The relay loses its solver, and the quote the card showed runs out before the click.
  w.tune.relay.clear();
  w.clock.now += 61_000;
  const relayAsks = w.asked.relay.length;
  const held = await landed(w.h, w.h.svc.approve(p.id));
  assert.equal(held.status, 'approved', 'held, to be asked again in a while');
  assert.ok(held.heldSince !== undefined);
  assert.equal(w.asked.relay.length, relayAsks + 1, 'the relay was asked again at the click');
  assert.deepEqual(live(w), [], '1Click was never asked to run it');
  assert.equal(w.asked.generated, 0);
  assert.deepEqual(w.signatures, []);
});

test('a row on 1Click stays on 1Click: refused at the click, it is not handed to the relay, and nothing is signed', async () => {
  const w = world(RELAY_SERVES_USDT);
  const p = await landed(w.h, w.h.svc.proposeSwap({ ...USDC_TO_ETH, amountIn: '150' }));
  assert.equal(p.status, 'pending');
  assert.equal(swapOf(p).venue, INTENTS_NATIVE_VENUE);

  // A solver joins the relay for the pair and 1Click loses its own before the click.
  w.tune.relay.set(pair(USDC, ETH), 0n);
  w.tune.oneClickNone.add(pair(USDC, ETH));
  const relayAsks = w.asked.relay.length;
  const clicked = await landed(w.h, w.h.svc.approve(p.id));
  assert.notEqual(clicked.status, 'executed');
  assert.equal(w.asked.relay.length, relayAsks, 'the relay was never asked to run a 1Click row');
  assert.equal(w.asked.published, 0);
  assert.deepEqual(w.signatures, []);
});

// ---------- the reads ----------

test('swap_quote prices the route a swap would take: 1Click when the relay has nobody, the relay when it does', async () => {
  const w = world(RELAY_SERVES_USDT);
  const eth = await w.h.svc.swapQuote!(USDC_TO_ETH);
  assert.equal(eth.ok, true, String(eth.sentence));
  assert.equal(eth.reason, null);
  assert.equal(eth.etaSeconds, 10, "1Click's time");
  assert.equal(eth.expectedOut, baseUnitsToDecimal(fairOut(USDC, ETH, 10_000_000n, 1n), 18));

  const usdt = await w.h.svc.swapQuote!(USDC_TO_USDT);
  assert.equal(usdt.ok, true, String(usdt.sentence));
  assert.equal(usdt.etaSeconds, null, 'the relay names no time');

  const neither = world({ oneClickNone: [pair(USDC, ETH)] });
  const none = await neither.h.svc.swapQuote!(USDC_TO_ETH);
  assert.equal(none.ok, false);
  assert.equal(none.reason, 'no_price');
  assert.equal(none.sentence, 'Nobody is offering a price for USDC to ETH right now, so nothing moved. Try again in a minute.');
  assert.deepEqual([...w.signatures, ...neither.signatures], []);
});

test('a coin named without its network, on two networks the relay prices neither of, is picked by what 1Click would give', async () => {
  // The Arbitrum one gives up two percent more, so the Base one is worth more.
  const w = world({ oneClickLoss: (out) => (out === ZZZ_ARB ? 200n : 0n) });
  const reply = await w.h.svc.swapQuote!({ fromSymbol: 'USDC', toSymbol: 'ZZZ', amountIn: '10' });
  assert.equal(reply.ok, true, String(reply.sentence));
  assert.equal(reply.to?.assetId, ZZZ_BASE);
  assert.deepEqual(new Set(w.asked.relay.map((r) => r.assetOut)), new Set([ZZZ_BASE, ZZZ_ARB]), 'the relay was asked first, for both');

  const p = await landed(w.h, w.h.svc.proposeSwap({ fromSymbol: 'USDC', toSymbol: 'ZZZ', amountIn: '10' }));
  assert.equal(p.status, 'executed', String(p.result?.detail ?? p.verdict.reasons.at(-1)));
  assert.equal(swapOf(p).venue, INTENTS_NATIVE_VENUE);
  assert.equal(swapOf(p).assets?.destination.assetId, ZZZ_BASE);
  assert.deepEqual(w.signatures.map((s) => s.rail), ['native']);
});
