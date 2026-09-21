// The relay swap rail, against a fixture relay, a fixture verifier and a throwaway key. Nothing
// here touches the network and nothing here publishes an intent for real: publish_intent moves
// money on mainnet. The list of properties is the spec's ("Tests" in
// docs/superpowers/specs/2026-09-20-swap-relay-design.md), in the spec's order, plus the rows
// the rail added (the balance read, the salt read, the relay's refusal, the poll's end).
//
// Run: node --test tests/unit/intents-relay.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Hex } from 'viem';
import { verifyMessage } from 'viem';
import { privateKeyToAccount, signMessage } from 'viem/accounts';

import type { RailHooks, SwapDraft } from '../../src/types.ts';
import type { OneClickClient, OneClickToken, TokensFile } from '../../src/intents.ts';
import type { RelayClient, RelayPublishResult, RelayQuote, RelayStatus } from '../../src/relay/client.ts';
import type { VerifierPort } from '../../src/relay/verifier.ts';
import { decodeNonce } from '../../src/relay/payload.ts';
import { erc191SignatureField } from '../../src/intents-sign.ts';
import type { IntentsSignerPort } from '../../src/intents-sign.ts';
import { INTENTS_NATIVE_COUNTERPARTY, intentsNativeRail } from '../../src/rails/intents-native.ts';
import {
  INTENTS_RELAY_COUNTERPARTY,
  INTENTS_RELAY_VENUE,
  NONCE_LIFE_AFTER_DEADLINE_MS,
  RELAY_SIMULATE_TIMEOUT_MS,
  RELAY_SIMULATE_WAIT_MS,
  RELAY_TERMINAL,
  intentsRelayRail,
  settleTolerance,
} from '../../src/rails/intents-relay.ts';
import { relayClient } from '../../src/relay/client.ts';
import { liveVerifier } from '../../src/relay/verifier.ts';
import type { IntentsRelayRailDeps } from '../../src/rails/intents-relay.ts';
import { KIND_STAGES, RELAY_STAGES, TERMINAL } from '../../src/proposals/view.ts';

// ---------- fixtures ----------

// A throwaway key, used only so the signature the rail releases is a real secp256k1 one. It
// holds nothing and is in no keys file.
const TEST_KEY = ('0x' + '22'.repeat(32)) as Hex;
const OWNER = privateKeyToAccount(TEST_KEY).address;
const ACCOUNT = OWNER.toLowerCase();

const USDC = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const USDT = 'nep141:usdt.tether-token.near';
const NOW = Date.parse('2026-09-20T12:00:00.000Z');
const SALT = Uint8Array.from([0x25, 0x28, 0x12, 0xb3]);
const INTENT_HASH = 'GoiKQ5gPe5Ne2kT8mtL7c4qHKMjbdpMJhJ8dv1S3CYbM';
const NEAR_TX = '8yFNEk7GmRcM3NMJihwCKXt8ZANLpL2koVFWWH1MEEj';

const tokensFixture: TokensFile = {
  eth: {},
  base: {},
  arb: {},
  sol: {},
  near: {
    USDC: { tokenId: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', decimals: 6 },
    USDT: { tokenId: 'usdt.tether-token.near', decimals: 6 },
  },
};

const apiTokens: OneClickToken[] = [
  { assetId: USDC, decimals: 6, blockchain: 'near', symbol: 'USDC', contractAddress: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', price: 0.9997 },
  { assetId: USDT, decimals: 6, blockchain: 'near', symbol: 'USDT', contractAddress: 'usdt.tether-token.near', price: 1.0002 },
] as OneClickToken[];

function draftOf(over: Partial<SwapDraft> = {}): SwapDraft {
  return {
    kind: 'swap',
    venue: 'intents-relay',
    chain: 'near',
    toChain: 'near',
    fromSymbol: 'USDC',
    toSymbol: 'USDT',
    amountIn: 2,
    amountUsd: 2,
    minAmountOut: 1.95,
    from: OWNER,
    to: OWNER,
    counterparty: INTENTS_RELAY_COUNTERPARTY,
    quote: null,
    ...over,
  };
}

function quoteOf(over: Partial<RelayQuote> = {}): RelayQuote {
  return {
    quoteHash: 'Cw6dV7MV3NvKRNrXjLpymkWneBzuhTjrgEYuQLwnnCg6',
    assetIn: USDC,
    assetOut: USDT,
    amountIn: '2000000',
    amountOut: '1961996',
    expirationTime: new Date(NOW + 60_000).toISOString(),
    ...over,
  };
}

function statusOf(status: string, over: Partial<RelayStatus> = {}): RelayStatus {
  return { intentHash: INTENT_HASH, status, statusDetails: null, nearTxHash: null, filledAmounts: [], ...over };
}

type Harness = {
  rail: ReturnType<typeof intentsRelayRail>;
  quotes: Array<{ assetIn: string; assetOut: string; exactAmountIn: string }>;
  publishes: Array<{ quoteHashes: string[]; standard: string; payload: string; signature: string }>;
  statusCalls: string[];
  signed: string[]; // every payload the signer was handed
  keyReads: number;
  balanceReads: Array<{ account: string; asset: string }>;
  saltReads: number;
  evidence: Array<Record<string, unknown>>;
  hooks: RailHooks;
  slept: number[];
  clock: { now: number };
};

function harness(
  options: {
    quotes?: RelayQuote[] | (() => RelayQuote[]);
    quoteError?: string;
    publish?: RelayPublishResult;
    publishNoReply?: number; // how many publish calls get no reply (a TimeoutError) first
    publishError?: string; // an answered error: the relay wrote something and it is not resent
    statuses?: RelayStatus[]; // in order, the last repeating
    statusError?: string;
    balanceIn?: bigint | null; // the input asset, before signing
    balanceOut?: Array<bigint | null>; // the output asset: the before-read, then the after-reads in order, the last repeating
    salt?: Uint8Array | null;
    nonceUsed?: boolean | null; // what the verifier says once asked; default false, never asked on a measured settle
    random?: (n: number) => Uint8Array;
    deps?: Partial<IntentsRelayRailDeps>;
  } = {},
): Harness {
  const h = {
    quotes: [] as Harness['quotes'],
    publishes: [] as Harness['publishes'],
    statusCalls: [] as string[],
    signed: [] as string[],
    keyReads: 0,
    balanceReads: [] as Harness['balanceReads'],
    saltReads: 0,
    evidence: [] as Array<Record<string, unknown>>,
    slept: [] as number[],
    clock: { now: NOW },
  };
  let noReplies = options.publishNoReply ?? 0;
  const statuses = [...(options.statuses ?? [statusOf('SETTLED', { nearTxHash: NEAR_TX })])];
  const outReads = [...(options.balanceOut ?? [1_000_000n, 1_000_000n + 1_961_996n])];

  const relay: RelayClient = {
    async quote(req) {
      h.quotes.push(req);
      if (options.quoteError !== undefined) throw new Error(options.quoteError);
      const q = options.quotes ?? [quoteOf()];
      return typeof q === 'function' ? q() : q;
    },
    async publishIntent(req) {
      h.publishes.push(req);
      if (noReplies > 0) {
        noReplies -= 1;
        const err = new Error('The operation was aborted due to timeout');
        err.name = 'TimeoutError';
        throw err;
      }
      if (options.publishError !== undefined) throw new Error(options.publishError);
      return options.publish ?? { status: 'OK', intentHash: INTENT_HASH };
    },
    async status(hash) {
      h.statusCalls.push(hash);
      if (options.statusError !== undefined) throw new Error(options.statusError);
      return statuses.length > 1 ? (statuses.shift() as RelayStatus) : statuses[0];
    },
  };

  const signer: IntentsSignerPort = {
    address() {
      return OWNER;
    },
    async signErc191(_keysPath, payload) {
      h.keyReads += 1;
      h.signed.push(payload);
      return erc191SignatureField(await signMessage({ privateKey: TEST_KEY, message: payload }));
    },
  };

  const verifier: VerifierPort = {
    async balance(account, asset) {
      h.balanceReads.push({ account, asset });
      if (asset === USDC) return options.balanceIn === undefined ? 5_000_000n : options.balanceIn;
      return outReads.length > 1 ? (outReads.shift() as bigint | null) : outReads[0];
    },
    async currentSalt() {
      h.saltReads += 1;
      return options.salt === undefined ? SALT : options.salt;
    },
    async nonceUsed() {
      return options.nonceUsed === undefined ? false : options.nonceUsed;
    },
    async isValidSalt() {
      return true;
    },
  };

  const client = { tokens: async () => apiTokens } as unknown as OneClickClient;
  let seed = 0;
  const random = options.random ?? ((n: number) => Uint8Array.from({ length: n }, (_, i) => (seed * 31 + i + (seed += 1)) % 256));

  const rail = intentsRelayRail({
    keysPath: '/nonexistent/keys.json',
    tokens: tokensFixture,
    signer,
    relay,
    client,
    verifier,
    now: () => h.clock.now,
    sleepImpl: async (ms) => {
      h.slept.push(ms);
      h.clock.now += ms;
    },
    random,
    settleSchedule: { firstMs: 100, maxMs: 100, timeoutMs: 500 },
    ...options.deps,
  });

  const hooks: RailHooks = { onEvidence: (e) => h.evidence.push(e as Record<string, unknown>) };
  // The two counters are read through getters: a spread would copy the zero they start at.
  return {
    rail,
    hooks,
    ...h,
    get keyReads() {
      return h.keyReads;
    },
    get saltReads() {
      return h.saltReads;
    },
  };
}

function payloadSigned(h: Harness): Record<string, unknown> {
  assert.equal(h.signed.length, 1, 'signErc191 exactly once');
  return JSON.parse(h.signed[0]) as Record<string, unknown>;
}

function diffOf(payload: Record<string, unknown>): Record<string, string> {
  return (payload['intents'] as Array<{ diff: Record<string, string> }>)[0].diff;
}

// ---------- the spec's list ----------

test('picks the largest amount_out among quotes with the right amount_in, and ignores one expiring inside 15 s', async () => {
  const h = harness({
    quotes: [
      quoteOf({ quoteHash: 'small', amountOut: '1961996' }),
      quoteOf({ quoteHash: 'big-but-wrong-amount', amountIn: '2000001', amountOut: '2500000' }),
      quoteOf({ quoteHash: 'big-but-expiring', amountOut: '2400000', expirationTime: new Date(NOW + 14_000).toISOString() }),
      quoteOf({ quoteHash: 'best', amountOut: '1970000' }),
    ],
    balanceOut: [1_000_000n, 2_970_000n],
  });
  const sim = await h.rail.simulate(draftOf());
  assert.equal(sim.ok, true, sim.summary);
  assert.equal(sim.swap?.receives, '1.97');
  const result = await h.rail.execute(draftOf(), 'p1', h.hooks);
  assert.equal(result.ok, true, result.detail);
  assert.deepEqual(h.publishes[0].quoteHashes, ['best']);
  assert.equal(diffOf(payloadSigned(h))[USDT], '1970000');
});

test('refuses at simulate when no quote is at or above the floor, with both numbers in the sentence', async () => {
  const h = harness({ quotes: [quoteOf({ amountOut: '1900000' })] });
  const sim = await h.rail.simulate(draftOf({ minAmountOut: 1.95 }));
  assert.equal(sim.ok, false);
  assert.match(sim.error ?? '', /best price is 1\.9 USDT, your floor is 1\.95 USDT/);
  assert.equal(sim.swap?.receives, '1.9', 'the card still gets the numbers the rail checked');
  assert.equal(sim.swap?.receivesAtLeast, '1.95', 'the floor on the card is the draft floor, the contract');

  const none = harness({ quotes: [] });
  const empty = await none.rail.simulate(draftOf());
  assert.equal(empty.ok, false);
  assert.equal(empty.error, 'Nobody offered a price for this pair right now. Try again in a minute.');
});

test('the payload negative side is exactly amountIn, the positive side exactly the chosen quote, and the asset ids are the draft', async () => {
  const h = harness();
  const result = await h.rail.execute(draftOf(), 'p1', h.hooks);
  assert.equal(result.ok, true, result.detail);
  const payload = payloadSigned(h);
  assert.equal(payload['signer_id'], ACCOUNT, 'lowercased, as the verifier keys the account');
  assert.equal(payload['verifying_contract'], 'intents.near');
  const diff = diffOf(payload);
  assert.deepEqual(Object.keys(diff), [USDC, USDT]);
  assert.equal(diff[USDC], '-2000000');
  assert.equal(diff[USDT], '1961996');
});

test('the string signed is the string sent, byte for byte, under a real secp256k1 signature the verifier can recover', async () => {
  const h = harness();
  await h.rail.execute(draftOf(), 'p1', h.hooks);
  assert.equal(h.publishes.length, 1);
  assert.equal(h.publishes[0].payload, h.signed[0]);
  assert.equal(h.publishes[0].standard, 'erc191');
  assert.match(h.publishes[0].signature, /^secp256k1:[1-9A-HJ-NP-Za-km-z]+$/);
  // The signature recovers to the throwaway key over exactly those bytes.
  const sig = await signMessage({ privateKey: TEST_KEY, message: h.signed[0] });
  assert.equal(await verifyMessage({ address: OWNER, message: h.publishes[0].payload, signature: sig }), true);
});

test('the nonce is 32 bytes, carries the salt read from the verifier, is fresh per call, and never repeats inside a process', async () => {
  // One before-read and one after-read per execution, each swap landing on the last balance.
  const ladder = Array.from({ length: 5 }, (_, i) => [1_000_000n + BigInt(i) * 1_961_996n, 1_000_000n + BigInt(i + 1) * 1_961_996n]).flat();
  const h = harness({ statuses: [statusOf('SETTLED', { nearTxHash: NEAR_TX })], balanceOut: ladder });
  const seen = new Set<string>();
  for (let i = 0; i < 5; i += 1) {
    const result = await h.rail.execute(draftOf(), `p${i}`, h.hooks);
    assert.equal(result.ok, true, result.detail);
    const nonce = (JSON.parse(h.signed[i]) as { nonce: string }).nonce;
    const parts = decodeNonce(nonce);
    assert.ok(parts !== null, 'a 32-byte versioned nonce');
    assert.deepEqual([...parts.salt], [...SALT]);
    assert.ok(!seen.has(nonce), 'fresh per call');
    seen.add(nonce);
  }
  assert.equal(h.saltReads, 5, 'the salt is read before every signature');

  // The same random bytes twice is the same nonce twice: the second is refused before the key.
  const fixed = harness({ random: (n) => Uint8Array.from({ length: n }, () => 7) });
  assert.equal((await fixed.rail.execute(draftOf(), 'p1', fixed.hooks)).ok, true);
  await assert.rejects(() => fixed.rail.execute(draftOf(), 'p2', fixed.hooks), /reuses a nonce/);
  assert.equal(fixed.signed.length, 1, 'the second move was never signed');
  assert.equal(fixed.publishes.length, 1);
});

test('the deadline is at most 120 s out and never past the quote expiration, and the nonce outlives it', async () => {
  const late = harness({ quotes: [quoteOf({ expirationTime: new Date(NOW + 10 * 60_000).toISOString() })] });
  await late.rail.execute(draftOf(), 'p1', late.hooks);
  const capped = payloadSigned(late);
  assert.equal(capped['deadline'], new Date(NOW + 120_000).toISOString());
  const nonce = decodeNonce(capped['nonce'] as string);
  assert.equal(nonce?.deadlineMs, NOW + 120_000 + NONCE_LIFE_AFTER_DEADLINE_MS);

  const soon = harness({ quotes: [quoteOf({ expirationTime: new Date(NOW + 40_000).toISOString() })] });
  await soon.rail.execute(draftOf(), 'p1', soon.hooks);
  assert.equal(payloadSigned(soon)['deadline'], new Date(NOW + 40_000).toISOString(), 'never past the quote');
});

test('the executor hears nonce, deadline and quote hash before publish, and the hash after it, before any poll', async () => {
  const order: string[] = [];
  const h = harness();
  const hooks: RailHooks = { onEvidence: (e) => order.push(Object.keys(e).sort().join(',')) };
  const relay = { ...(h.rail as unknown as Record<string, unknown>) };
  void relay;
  const wrapped = harness({
    deps: {
      relay: {
        quote: async () => [quoteOf()],
        publishIntent: async () => {
          order.push('publish');
          return { status: 'OK', intentHash: INTENT_HASH };
        },
        status: async () => {
          order.push('poll');
          return statusOf('SETTLED', { nearTxHash: NEAR_TX });
        },
      },
    },
  });
  await wrapped.rail.execute(draftOf(), 'p1', hooks);
  assert.deepEqual(order.slice(0, 3), ['deadline,nonce,relayQuote', 'publish', 'deadline,handle,nonce,relayQuote,txids']);
  assert.equal(order[3], 'poll');
});

test('publish with no reply is re-posted once with identical bytes; the signer is called exactly once', async () => {
  const h = harness({ publishNoReply: 1 });
  const result = await h.rail.execute(draftOf(), 'p1', h.hooks);
  assert.equal(result.ok, true, result.detail);
  assert.equal(h.publishes.length, 2);
  assert.deepEqual(h.publishes[0], h.publishes[1], 'the same bytes, the same signature');
  assert.equal(h.signed.length, 1);

  // Two no-replies: unconfirmed, with the nonce and the deadline on the row, and no third post.
  const dead = harness({ publishNoReply: 2 });
  const out = await dead.rail.execute(draftOf(), 'p1', dead.hooks);
  assert.equal(out.ok, false);
  assert.equal(dead.publishes.length, 2);
  assert.equal(dead.signed.length, 1);
  assert.match(out.detail, /did not answer/);
  assert.match(out.detail, /THE INTENT IS SIGNED/);
  assert.equal(typeof out.evidence?.nonce, 'string');
  assert.equal(typeof out.evidence?.deadline, 'string');
  assert.equal(out.txids, undefined, 'no hash: the relay never said it took it');
});

test('publish answered FAILED is not re-posted; the signer is called exactly once; the row reads not valid with the reason', async () => {
  const h = harness({ publish: { status: 'FAILED', reason: 'error simulating intents: insufficient balance' } });
  const result = await h.rail.execute(draftOf(), 'p1', h.hooks);
  assert.equal(result.ok, false);
  assert.equal(h.publishes.length, 1);
  assert.equal(h.signed.length, 1);
  assert.equal(h.statusCalls.length, 0, 'nothing to poll: there is no hash');
  assert.match(result.detail, /the relay refused the intent: error simulating intents: insufficient balance/);
  assert.equal(result.evidence?.providerStage, 'NOT_FOUND_OR_NOT_VALID');
  assert.equal(typeof result.evidence?.nonce, 'string', 'the nonce stays so the sweep proves it dead');

  // An answered error (a 5xx, a body the relay wrote) is not resent either.
  const errored = harness({ publishError: 'relay publish_intent failed: 503' });
  const out = await errored.rail.execute(draftOf(), 'p1', errored.hooks);
  assert.equal(out.ok, false);
  assert.equal(errored.publishes.length, 1);
  assert.equal(errored.signed.length, 1);
});

test('an unknown status word is never terminal: the poll goes on and the row ends unconfirmed with hash and nonce', async () => {
  const h = harness({ statuses: [statusOf('PENDING'), statusOf('SOMETHING_NEW')], deps: { pollIntervalMs: 1_000, pollTimeoutMs: 5_000 } });
  const result = await h.rail.execute(draftOf(), 'p1', h.hooks);
  assert.equal(result.ok, false);
  assert.equal(result.settling, undefined);
  assert.ok(h.statusCalls.length >= 4, `kept polling past the unknown word: ${h.statusCalls.length} polls`);
  assert.match(result.detail, /had not settled it within 5s \(last status SOMETHING_NEW\)/);
  assert.match(result.detail, /THE INTENT IS SIGNED AND PUBLISHED/);
  assert.deepEqual(result.txids, [INTENT_HASH]);
  assert.equal(result.evidence?.handle, INTENT_HASH);
  assert.equal(typeof result.evidence?.nonce, 'string');
  assert.equal(result.evidence?.providerStage, 'SOMETHING_NEW', 'the relay word, as spelled, for the row');
  // Every poll told the executor the relay's word, as spelled.
  const words = h.evidence.map((e) => e['providerStage']).filter((w) => w !== undefined);
  assert.deepEqual(words.slice(0, 2), ['PENDING', 'SOMETHING_NEW']);
  assert.equal(h.signed.length, 1);
  for (const word of RELAY_TERMINAL) assert.ok(RELAY_STAGES.has(word), `${word} is not in the stage contract`);
});

test('SETTLED with a balance rise equal to the diff is ok, with the NEAR hash, its explorer link and the measured amount', async () => {
  const h = harness({ statuses: [statusOf('TX_BROADCASTED', { nearTxHash: NEAR_TX }), statusOf('SETTLED', { nearTxHash: NEAR_TX, filledAmounts: ['2000000', '1961996'] })] });
  const result = await h.rail.execute(draftOf(), 'p1', h.hooks);
  assert.equal(result.ok, true, result.detail);
  assert.deepEqual(result.txids, [INTENT_HASH, NEAR_TX]);
  assert.equal(result.evidence?.explorerUrl, `https://nearblocks.io/txns/${NEAR_TX}`);
  assert.equal(result.evidence?.providerStage, 'SETTLED');
  assert.equal(result.evidence?.settledAmountOut, '1.961996');
  assert.match(result.detail, /swapped 2 USDC for 1\.961996 USDT inside intents\.near, read back from the verifier and matching the signed diff of 1\.961996 USDT to the unit/);
  assert.equal(result.pocket?.before, '1000000');
  assert.equal(result.pocket?.after, '2961996');
  assert.equal(result.pocket?.floor, (1_961_996n - settleTolerance(1_961_996n)).toString(), 'the executor re-judges against the diff less a pip');
  // The NEAR hash reached the executor the moment the relay reported it, before the settled word.
  const withHash = h.evidence.find((e) => Array.isArray(e['txids']) && (e['txids'] as string[]).includes(NEAR_TX));
  assert.equal(withHash?.['providerStage'], 'TX_BROADCASTED');
  assert.equal(withHash?.['explorerUrl'], `https://nearblocks.io/txns/${NEAR_TX}`);
});

test('SETTLED short by one pip is still the swap; short by more is settling, never failed', async () => {
  const pip = settleTolerance(1_961_996n);
  assert.equal(pip, 196n, 'one pip of the diff, cut toward zero');
  const fee = harness({ balanceOut: [1_000_000n, 1_000_000n + 1_961_996n - pip] });
  const okShort = await fee.rail.execute(draftOf(), 'p1', fee.hooks);
  assert.equal(okShort.ok, true, okShort.detail);
  assert.match(okShort.detail, /less the protocol fee \(0\.000196 USDT\)/);
  assert.equal(okShort.evidence?.settledAmountOut, '1.9618');

  const short = harness({ balanceOut: [1_000_000n, 1_000_000n + 1_961_996n - pip - 1n] });
  const settling = await short.rail.execute(draftOf(), 'p1', short.hooks);
  assert.equal(settling.ok, false);
  assert.equal(settling.settling, true);
  assert.match(settling.detail, /rose by 1\.961799 against a signed 1\.961996/);
  assert.equal(settling.pocket?.after, (1_000_000n + 1_961_996n - pip - 1n).toString());
  assert.equal(short.signed.length, 1);

  const flat = harness({ balanceOut: [1_000_000n, 1_000_000n] });
  const unmoved = await flat.rail.execute(draftOf(), 'p1', flat.hooks);
  assert.equal(unmoved.settling, true);
  assert.ok(flat.slept.length > 0, 'the after-read was repeated inside the window');
});

test('a hold below the floor signs nothing and returns held with both numbers in the sentence', async () => {
  const h = harness({ quotes: [quoteOf({ amountOut: '1900000' })] });
  const result = await h.rail.execute(draftOf({ minAmountOut: 1.95 }), 'p1', h.hooks);
  assert.equal(result.ok, false);
  assert.equal(result.held, true);
  assert.match(result.detail, /best price is 1\.9 USDT, your floor is 1\.95 USDT/);
  assert.equal(h.signed.length, 0);
  assert.equal(h.publishes.length, 0);
  assert.equal(h.saltReads, 0);
  assert.deepEqual(h.evidence, []);

  const none = harness({ quotes: [] });
  const empty = await none.rail.execute(draftOf(), 'p1', none.hooks);
  assert.equal(empty.held, true);
  assert.match(empty.detail, /no solver offered a price/);
  assert.equal(none.signed.length, 0);
});

/* 2.2: propose_swap runs the dry quote inside simulate and has to answer inside 3 s. The relay
   waits for solvers as long as it is told (wait_ms; measured 2026-09-20: 500 ms of wait answers
   in 1.1 s, 1500 in 2.1 s, the default 3000 in 2.7 s with a solver and 3.8 s with none), so the
   propose-time quote asks for a shorter wait and carries its own client deadline. Execute keeps
   the default wait and the read timeout: a click has time, an answer line does not. */
test('the propose-time quote asks the relay for a short wait and gives up inside its own bound with one plain sentence', async () => {
  const sent: Array<Record<string, unknown>> = [];
  const aborted: string[] = [];
  const slow = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; params: Array<Record<string, unknown>> };
    sent.push(body.params[0]);
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: [] }), { status: 200 })), 5_000);
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        aborted.push(body.method);
        const err = new Error('The operation was aborted due to timeout');
        err.name = 'TimeoutError';
        reject(err);
      });
    });
  }) as typeof fetch;
  const h = harness({ deps: { relay: relayClient({ fetchImpl: slow, apiKey: '' }), simulateQuoteTimeoutMs: 150 } });
  const started = Date.now();
  const sim = await h.rail.simulate(draftOf());
  assert.ok(Date.now() - started < 1_000, 'simulate answered inside its bound, not the transport');
  assert.equal(sim.ok, false);
  assert.equal(sim.error, 'Nobody offered a price for this pair right now. Try again in a minute.');
  assert.match(sim.summary, /^REFUSED: Nobody offered a price for this pair right now\. Try again in a minute\.$/m);
  assert.deepEqual(aborted, ['quote']);
  assert.equal(sent[0]['wait_ms'], RELAY_SIMULATE_WAIT_MS, 'the propose-time quote names its wait');
  assert.equal(RELAY_SIMULATE_WAIT_MS, 1_500);
  assert.equal(RELAY_SIMULATE_TIMEOUT_MS, 2_500);
  assert.equal(h.signed.length, 0);

  // No solver inside the wait is the same sentence, and execute asks with the default wait.
  const none = harness({ quotes: [] });
  const empty = await none.rail.simulate(draftOf());
  assert.equal(empty.error, 'Nobody offered a price for this pair right now. Try again in a minute.');
  const wire: Array<Record<string, unknown>> = [];
  const quick = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { params: Array<Record<string, unknown>> };
    wire.push(body.params[0]);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: [] }), { status: 200 });
  }) as typeof fetch;
  const viaWire = harness({ deps: { relay: relayClient({ fetchImpl: quick, apiKey: '' }) } });
  await viaWire.rail.simulate(draftOf());
  await viaWire.rail.execute(draftOf(), 'p1', viaWire.hooks);
  assert.equal(wire[0]['wait_ms'], RELAY_SIMULATE_WAIT_MS);
  assert.equal(wire[1]['wait_ms'], undefined, 'execute leaves the relay its default wait');
});

test('a hold names why every answer the relay gave was passed over, never a bare "no price"', async () => {
  const h = harness({
    quotes: [
      quoteOf({ quoteHash: 'expiring', amountOut: '1970000', expirationTime: new Date(NOW + 10_000).toISOString() }),
      quoteOf({ quoteHash: 'wrong-amount', amountIn: '1999999', amountOut: '1980000' }),
    ],
  });
  const result = await h.rail.execute(draftOf(), 'p1', h.hooks);
  assert.equal(result.held, true);
  assert.match(result.detail, /no solver offered a price for 2 USDC to USDT right now/);
  assert.match(result.detail, /quote expiring expires at .* inside 15 s/);
  assert.match(result.detail, /quote wrong-amount is for 1999999 base units in, not the 2000000 the draft spends/);
  assert.equal(h.signed.length, 0);
});

test('the key is never read in simulate, and simulate reads no balance and no salt', async () => {
  const h = harness();
  const sim = await h.rail.simulate(draftOf());
  assert.equal(sim.ok, true, sim.summary);
  assert.equal(h.keyReads, 0);
  assert.equal(h.signed.length, 0);
  assert.equal(h.publishes.length, 0);
  assert.equal(h.balanceReads.length, 0);
  assert.equal(h.saltReads, 0);
  assert.deepEqual(sim.swap, { receives: '1.961996', receivesAtLeast: '1.95', feeUsd: 0.0376, etaSeconds: null, priceGoodForSec: 60 });
  assert.match(sim.summary, /one atomic swap inside intents\.near/);
  assert.match(sim.summary, /price good for 60s and re-quoted at your click/);
});

test('a draft for the 1Click venue never reaches this rail, and the reverse', async () => {
  const h = harness();
  const native = draftOf({ venue: 'intents-native', counterparty: INTENTS_NATIVE_COUNTERPARTY });
  const sim = await h.rail.simulate(native);
  assert.equal(sim.ok, false);
  assert.match(sim.summary, /received a intents-native draft/);
  await assert.rejects(() => h.rail.execute(native, 'p1', h.hooks), /received a intents-native draft/);
  assert.equal(h.quotes.length, 0);

  const oneClick = intentsNativeRail({ keysPath: '/nonexistent/keys.json', tokens: tokensFixture, api: { tokens: async () => apiTokens } as never });
  const back = await oneClick.simulate(draftOf());
  assert.equal(back.ok, false);
  assert.match(back.summary, /received a intents-relay draft/);
  assert.equal(INTENTS_RELAY_VENUE, 'intents-relay');
});

// ---------- the rows the rail added ----------

test('a balance below amountIn refuses before signing, and a balance the app could not read refuses too', async () => {
  const short = harness({ balanceIn: 1_999_999n });
  await assert.rejects(() => short.rail.execute(draftOf(), 'p1', short.hooks), /holds 1\.999999 USDC, less than the 2 USDC this swap spends; nothing was signed/);
  assert.equal(short.signed.length, 0);
  assert.equal(short.publishes.length, 0);

  // Fail closed: an unread balance is not a balance, and nothing is signed against one.
  const unread = harness({ balanceIn: null });
  await assert.rejects(() => unread.rail.execute(draftOf(), 'p1', unread.hooks), /Could not read your balance, so nothing was signed\. Try again\./);
  assert.equal(unread.signed.length, 0);
  assert.equal(unread.publishes.length, 0);

  // The same through the live verifier port over a transport that throws on the balance read.
  const rpc = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { params: { method_name: string } };
    if (body.params.method_name === 'mt_batch_balance_of') throw new Error('rpc exploded');
    // current_salt answers as the contract does: a JSON string of 8 hex characters, as bytes.
    const bytes = [...Buffer.from(JSON.stringify('252812b3'))];
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { result: bytes } }), { status: 200 });
  }) as typeof fetch;
  const live = harness({ deps: { verifier: liveVerifier(rpc) } });
  await assert.rejects(() => live.rail.execute(draftOf(), 'p1', live.hooks), /Could not read your balance, so nothing was signed\. Try again\./);
  assert.equal(live.signed.length, 0);
  assert.equal(live.publishes.length, 0);
});

test('a salt the verifier did not answer with refuses before signing', async () => {
  const h = harness({ salt: null });
  await assert.rejects(() => h.rail.execute(draftOf(), 'p1', h.hooks), /did not answer with its current salt/);
  assert.equal(h.signed.length, 0);
  assert.equal(h.publishes.length, 0);
});

test('the relay reporting NOT_FOUND_OR_NOT_VALID after a publish ends the row unconfirmed with hash and nonce, nothing signed again', async () => {
  const h = harness({ statuses: [statusOf('PENDING'), statusOf('NOT_FOUND_OR_NOT_VALID', { statusDetails: 'expired' })], deps: { pollIntervalMs: 1_000 } });
  const result = await h.rail.execute(draftOf(), 'p1', h.hooks);
  assert.equal(result.ok, false);
  assert.match(result.detail, /not found or not valid \(expired\)/);
  assert.equal(result.evidence?.providerStage, 'NOT_FOUND_OR_NOT_VALID');
  assert.deepEqual(result.txids, [INTENT_HASH]);
  assert.equal(typeof result.evidence?.nonce, 'string');
  assert.equal(h.signed.length, 1);
  assert.equal(h.publishes.length, 1);
});

test('a status call that throws does not end the watch, and SETTLED with no balance read is a success that says so', async () => {
  const flaky = harness({ statusError: 'relay get_status failed: 503', deps: { pollIntervalMs: 1_000, pollTimeoutMs: 3_000 } });
  const out = await flaky.rail.execute(draftOf(), 'p1', flaky.hooks);
  assert.equal(out.ok, false);
  assert.match(out.detail, /last status not polled/);
  assert.equal(flaky.signed.length, 1);

  const blind = harness({ balanceOut: [null, null], nonceUsed: true });
  const result = await blind.rail.execute(draftOf(), 'p1', blind.hooks);
  assert.equal(result.ok, true, result.detail);
  assert.match(result.detail, /could not be read back, so the amount out is the signed diff/);
  assert.match(result.detail, /the verifier shows the nonce spent/);
  assert.equal(result.pocket, undefined);

  // The relay's word alone never makes a success: with no balance read and the verifier not
  // showing the nonce spent, the row is unconfirmed, with the hash and the nonce for the sweep.
  const unproven = harness({ balanceOut: [null, null], nonceUsed: null });
  const held = await unproven.rail.execute(draftOf(), 'p1', unproven.hooks);
  assert.equal(held.ok, false);
  assert.equal(held.settling, true);
  assert.match(held.detail, /the verifier has not shown the nonce spent/);
  assert.equal(held.evidence?.handle, INTENT_HASH);
  assert.equal(typeof held.evidence?.nonce, 'string');
  assert.equal(unproven.signed.length, 1);
});

test('nothing throws after the signature: a verifier that throws on the after-read still returns a row with the hash and the nonce', async () => {
  const h = harness();
  let signed = false;
  const throwing: VerifierPort = {
    async balance(_account, asset) {
      if (signed) throw new Error('rpc exploded');
      return asset === USDC ? 5_000_000n : 1_000_000n;
    },
    async currentSalt() {
      return SALT;
    },
    async nonceUsed() {
      throw new Error('rpc exploded');
    },
    async isValidSalt() {
      throw new Error('rpc exploded');
    },
  };
  const rail = intentsRelayRail({
    keysPath: '/nonexistent/keys.json',
    tokens: tokensFixture,
    signer: {
      address: () => OWNER,
      async signErc191(_k, payload) {
        signed = true;
        return erc191SignatureField(await signMessage({ privateKey: TEST_KEY, message: payload }));
      },
    },
    relay: {
      quote: async () => [quoteOf()],
      publishIntent: async () => ({ status: 'OK', intentHash: INTENT_HASH }),
      status: async () => statusOf('SETTLED', { nearTxHash: NEAR_TX }),
    },
    client: { tokens: async () => apiTokens } as unknown as OneClickClient,
    verifier: throwing,
    now: () => h.clock.now,
    sleepImpl: async (ms) => {
      h.clock.now += ms;
    },
    settleSchedule: { firstMs: 100, maxMs: 100, timeoutMs: 300 },
  });
  const result = await rail.execute(draftOf(), 'p1', h.hooks);
  assert.equal(result.ok, false);
  assert.equal(result.settling, true, 'unconfirmed, never a throw that reads as nothing happened');
  assert.equal(result.evidence?.handle, INTENT_HASH);
  assert.equal(typeof result.evidence?.nonce, 'string');
});

test('the counterparty is the verifier and the proceeds land on our own account, or the draft is refused', async () => {
  const h = harness();
  await assert.rejects(() => h.rail.execute(draftOf({ counterparty: 'somebody.near' }), 'p1', h.hooks), /must name intents\.near as the counterparty/);
  await assert.rejects(() => h.rail.execute(draftOf({ to: '0x1111111111111111111111111111111111111111' }), 'p1', h.hooks), /credits the proceeds to our own account/);
  await assert.rejects(() => h.rail.execute(draftOf({ from: '0x1111111111111111111111111111111111111111', to: '0x1111111111111111111111111111111111111111' }), 'p1', h.hooks), /configured key is/);
  await assert.rejects(() => h.rail.execute(draftOf({ minAmountOut: 0 }), 'p1', h.hooks), /minAmountOut is 0/);
  assert.equal(h.signed.length, 0);
  assert.equal(INTENTS_RELAY_COUNTERPARTY, INTENTS_NATIVE_COUNTERPARTY, 'one verifier, one allowlist entry');
});

test('the amount signed and the floor held are cut toward zero, never rounded up past what was approved', async () => {
  // 1.0000005 USDC rounds half-up to 1000001 base units; the relay asks for, and signs, 1000000.
  const h = harness({ quotes: [quoteOf({ amountIn: '1000000', amountOut: '980000' })], balanceOut: [1_000_000n, 1_980_000n] });
  const result = await h.rail.execute(draftOf({ amountIn: 1.0000005, minAmountOut: 0.9599999 }), 'p1', h.hooks);
  assert.equal(result.ok, true, result.detail);
  assert.equal(h.quotes[0].exactAmountIn, '1000000', 'the quote asks for the cut amount');
  assert.equal(diffOf(payloadSigned(h))[USDC], '-1000000', 'the payload spends the cut amount');
  // The floor 0.9599999 is 959999 base units cut, 960000 rounded: a quote of 959999 is at the
  // floor the person approved and is not refused.
  const edge = harness({ quotes: [quoteOf({ amountOut: '1959999' })] });
  const sim = await edge.rail.simulate(draftOf({ minAmountOut: 1.9599999 }));
  assert.equal(sim.ok, true, sim.summary);
  assert.equal(sim.swap?.receivesAtLeast, '1.959999');
});

test('a floor more than 20 percent under the quote is refused at simulate and at execute, nothing signed', async () => {
  const h = harness({ quotes: [quoteOf({ amountOut: '2000000' })] });
  const sim = await h.rail.simulate(draftOf({ minAmountOut: 1.5 }));
  assert.equal(sim.ok, false);
  assert.match(sim.error ?? '', /more than 20% below/);
  await assert.rejects(() => h.rail.execute(draftOf({ minAmountOut: 1.5 }), 'p1', h.hooks), /more than 20% below/);
  assert.equal(h.signed.length, 0);
});

test('the swap path in the stage contract is the relay words this rail stamps', () => {
  assert.deepEqual(KIND_STAGES.swap.path.slice(-4), ['submitting', 'PENDING', 'TX_BROADCASTED', 'SETTLED', 'confirmed'].slice(1));
  // A FAILED publish is not the end: the signed bytes live until the deadline, so the word is a
  // wait ("Not accepted, checking nothing moved") and the sweep writes `failed` after it.
  assert.equal(KIND_STAGES.swap.terminal.includes('NOT_FOUND_OR_NOT_VALID'), false);
  assert.equal(TERMINAL.has('NOT_FOUND_OR_NOT_VALID'), false);
  assert.ok(KIND_STAGES.swap.terminal.includes('failed'));
});
