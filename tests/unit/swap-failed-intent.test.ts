// A FAILED 1Click swap is not over while the transfer it signed can still run (the audit of
// 2026-09-23, its second finding). The rail read the spent balance either side and called an unchanged
// balance "nothing moved": the row closed failed, left the daily cap, offered Try again, and was
// never looked at again, while the signed transfer stayed valid for 72 hours. A same-coin credit
// landing in the watch hid a transfer that had run.
//
// Now the signature lives three minutes, the verifier's word on the intent's own nonce decides
// whether the input left, and the row stays open and counted until the deadline has passed.
// The first two tests are the audit's proof of concept, turned round.
//
// Run: node --test tests/unit/swap-failed-intent.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { INTENTS_NATIVE_COUNTERPARTY, INTENTS_VERIFIER, intentsNativeRail } from '../../src/rails/intents-native.ts';
import { parseStatus } from '../../src/intents.ts';
import type { OneClickQuote, OneClickStatus } from '../../src/intents.ts';
import { buildNonce } from '../../src/relay/payload.ts';
import { loadDemoLedger } from '../../src/ledger/demo.ts';
import type { Ledger } from '../../src/ledger/index.ts';
import type { IntentsActivity } from '../../src/chainscan/index.ts';
import type { Proposal, RailEvidence, SwapDraft } from '../../src/types.ts';
import type { RailRegistry } from '../../src/rails/index.ts';
import { reasonSentence } from '../../src/proposals/view.ts';
import { TEST_QUOTE_KEY, signQuote } from './helpers/signed-quote.ts';
import { SELF_EVM, landed, makeCtx, railThat } from './helpers/proposals.ts';

// ---------- the rail ----------

const OWNER = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A';
const HANDLE = 'q-9f2c41ae.1click.near';
const INTENT_HASH = '44XpLRAuZKoVGs9T4qbSNv33MDKMePPAibA52geVLWFw';
const ORIGIN = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
const DEST = 'nep141:arb-0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9.omft.near';
const NOW = Date.parse('2026-09-23T12:00:00.000Z');
const SALT = Uint8Array.from([0x25, 0x28, 0x12, 0xb3]);
// What live generate-intent returns: a deadline 72 hours out, and a nonce that outlives it.
const LONG = new Date(NOW + 72 * 3600_000).toISOString();
const SHORT = new Date(NOW + 3 * 60_000).toISOString();
const NONCE = buildNonce({ salt: SALT, deadlineMs: NOW + 72 * 3600_000, random: new Uint8Array(15).fill(9) });

const tokens = {
  eth: {},
  base: { USDC: { tokenId: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6 } },
  arb: { USDT: { tokenId: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', decimals: 6 } },
  sol: {},
  near: {},
};
const list = [
  { assetId: ORIGIN, decimals: 6, blockchain: 'base', symbol: 'USDC', contractAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' },
  { assetId: DEST, decimals: 6, blockchain: 'arb', symbol: 'USDT', contractAddress: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9' },
];
const quote = {
  amountIn: '100000000',
  amountInFormatted: '100.0',
  amountInUsd: '100.00',
  minAmountIn: '100000000',
  amountOut: '99850000',
  amountOutFormatted: '99.85',
  amountOutUsd: '99.84',
  minAmountOut: '99500000',
  timeEstimate: 12,
  depositAddress: HANDLE,
};

// The shape 1Click generates for an intents balance: one transfer of the input to the handle.
function payloadOf(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    signer_id: OWNER.toLowerCase(),
    verifying_contract: INTENTS_VERIFIER,
    deadline: LONG,
    nonce: NONCE,
    intents: [{ intent: 'transfer', receiver_id: HANDLE, tokens: { [ORIGIN]: '100000000' } }],
    ...over,
  });
}

// 1Click's FAILED with no transfer hash and nothing refunded: the 2026-09-23 wNEAR shape.
const FAILED = { status: 'FAILED', swapDetails: { refundedAmountFormatted: '0', refundReason: null } };

function rail(opts: { origin: bigint[]; spent: boolean | null; payload?: string }) {
  let reads = 0;
  const signed: string[] = [];
  const asked: string[][] = [];
  const told: RailEvidence[] = [];
  const api = {
    tokens: async () => list,
    quote: async (p: { dry: boolean }) => {
      const s = signQuote({
        quote,
        quoteRequest: { dry: p.dry, originAsset: ORIGIN, destinationAsset: DEST, amount: '100000000', depositType: 'INTENTS', recipientType: 'INTENTS', recipient: OWNER, refundType: 'INTENTS', refundTo: OWNER },
      });
      return { quote: s['quote'] as OneClickQuote, raw: s };
    },
    generateIntent: async () => ({ standard: 'erc191', payload: opts.payload ?? payloadOf(), correlationId: 'c' }),
    submitIntent: async () => ({ intentHash: INTENT_HASH, correlationId: 'c' }),
    status: async () => parseStatus(FAILED),
  };
  const r = intentsNativeRail({
    keysPath: '/nonexistent',
    quoteKey: TEST_QUOTE_KEY,
    tokens,
    api,
    signer: {
      address: () => OWNER,
      signErc191: async (_k: string, payload: string) => {
        signed.push(payload);
        return 'secp256k1:stub';
      },
    },
    verifierBalance: async (_a: string, asset: string) => (asset === ORIGIN ? (opts.origin[Math.min(reads++, opts.origin.length - 1)] ?? null) : 0n),
    nonceUsed: async (account: string, nonce: string) => {
      asked.push([account, nonce]);
      return opts.spent;
    },
    now: () => NOW,
    sleepImpl: async () => {},
    pollIntervalMs: 1,
    pollTimeoutMs: 5,
  });
  const hooks = { onEvidence: (e: RailEvidence) => void told.push(e) };
  return { run: () => r.execute(draft, 'p-1', hooks), signed, asked, told };
}

const draft: SwapDraft = {
  kind: 'swap',
  venue: 'intents-native',
  chain: 'base',
  toChain: 'arb',
  fromSymbol: 'USDC',
  toSymbol: 'USDT',
  amountIn: 100,
  amountInExact: '100',
  amountUsd: 100,
  minAmountOut: 99,
  from: OWNER,
  to: OWNER,
  counterparty: INTENTS_NATIVE_COUNTERPARTY,
  quote: null,
};

test('PoC case 1: FAILED with the balance unchanged is not "nothing moved" while the signed transfer can still run', async () => {
  const h = rail({ origin: [1_000_000_000n, 1_000_000_000n], spent: false });
  const r = await h.run();
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'venue_failed_watching', 'unspent inside its deadline: open and counted, never closed as nothing moved');
  assert.deepEqual(h.asked, [[OWNER.toLowerCase(), NONCE]], 'the verifier is asked about this intent, by its own nonce');
  assert.deepEqual(r.txids, [INTENT_HASH]);
  assert.match(r.detail, /has not run/);
  assert.match(r.detail, new RegExp(`until ${SHORT}`));
});

test('PoC case 2: FAILED with the input gone and a same-coin credit hiding it says the input left', async () => {
  // Before 1000; the transfer takes 100 (900); a credit of 110 lands (1010) before the after-read.
  const h = rail({ origin: [1_000_000_000n, 1_010_000_000n], spent: true });
  const r = await h.run();
  assert.equal(r.reason, 'venue_failed_refund_pending', 'the spent nonce is the transfer having run, whatever the balance says');
  assert.match(r.detail, /left the balance/);
});

test('a verifier that does not answer about the nonce leaves the swap unconfirmed', async () => {
  const r = await rail({ origin: [1_000_000_000n, 1_000_000_000n], spent: null }).run();
  assert.equal(r.reason, 'stuck_unknown');
});

test('the transfer is signed with a three-minute deadline, and nothing else in what 1Click generated changes', async () => {
  const h = rail({ origin: [1_000_000_000n], spent: false });
  await h.run();
  assert.equal(h.signed.length, 1);
  assert.equal(h.signed[0], payloadOf().replace(LONG, SHORT), 'the same bytes with the deadline cut to three minutes');
  assert.deepEqual(
    h.told.map((e) => ({ deadline: e.deadline, nonce: e.nonce })).slice(0, 2),
    [
      { deadline: SHORT, nonce: NONCE },
      { deadline: SHORT, nonce: NONCE },
    ],
    'the row learns the deadline it will be judged by and the nonce the verifier is asked by, before the wait',
  );
});

test('a payload whose deadline cannot be cut to three minutes is refused before the key is touched', async () => {
  // A second "deadline" inside the transfer: which one to cut is a guess, so nothing is cut.
  const two = payloadOf({ intents: [{ intent: 'transfer', receiver_id: HANDLE, tokens: { [ORIGIN]: '100000000' }, deadline: LONG }] });
  const h = rail({ origin: [1_000_000_000n], spent: false, payload: two });
  await assert.rejects(h.run(), /more than 3 minutes out/);
  assert.equal(h.signed.length, 0);
});

// ---------- the row ----------

const WATCHING_SWAP: SwapDraft = { ...draft, chain: 'near', toChain: 'eth', fromSymbol: 'wNEAR', toSymbol: 'WBTC', from: SELF_EVM, to: SELF_EVM };

test('the sentence: still being checked, nothing has moved so far, and the app keeps an eye on it', () => {
  assert.equal(reasonSentence('venue_failed_watching', WATCHING_SWAP), "Still checking this swap. Your NEAR hasn't moved so far; I'm keeping an eye on it for a few minutes.");
});

/* WORKING, NEVER "DIDN'T GO THROUGH" (audit, finding 9). Its transfer can still run, so a state word
   saying it is over is the one that gets a second swap asked for beside it. */
test('the row is still being checked: working and late, counted against the day, and no Try again', async () => {
  const evidence = { handle: 'dep-1', nonce: NONCE, deadline: new Date(Date.now() + 3 * 60_000).toISOString(), providerStage: 'FAILED' };
  const h = makeCtx({
    rails: [railThat('swap', async () => ({ ok: false, reason: 'venue_failed_watching', detail: '1click reported FAILED and the transfer has not run', txids: ['intent-h'], evidence }))],
  });
  const p = await landed(h, h.svc.proposeSwap({ chain: 'arb', fromSymbol: 'USDT', toSymbol: 'USDC', amountIn: 10, minAmountOut: 9.9 }));
  assert.equal(p.status, 'needs_reconciliation');
  assert.equal(h.svc.dailyLimit(25_000).spentUsd, 10, 'a transfer that can still run is money the day has spent');
  const v = h.svc.view(p);
  assert.equal(v.state, 'working');
  assert.notEqual(v.late, null, 'late from the start: 1Click already answered FAILED');
  assert.equal(v.reason?.code, 'venue_failed_watching');
  assert.equal(v.reason?.retry, false);
  assert.equal(v.stageCopy, "Still checking this swap. Your USDT hasn't moved so far; I'm keeping an eye on it for a few minutes.");
});

test('while a swap of a coin is being watched, a new swap of the same coin waits for a click; another coin does not', async () => {
  const evidence = { handle: 'dep-1', nonce: NONCE, deadline: new Date(Date.now() + 3 * 60_000).toISOString(), providerStage: 'FAILED' };
  const answers = [
    { ok: false, reason: 'venue_failed_watching', detail: '1click reported FAILED and the transfer has not run', txids: ['intent-h'], evidence },
    { ok: true, detail: 'swapped', txids: ['intent-2'] },
  ];
  const h = makeCtx({ rails: [railThat('swap', async () => answers.shift() ?? { ok: true, detail: 'swapped', txids: ['intent-3'] })] });
  const first = await landed(h, h.svc.proposeSwap({ chain: 'arb', fromSymbol: 'USDT', toSymbol: 'USDC', amountIn: 10, minAmountOut: 9.9 }));
  assert.equal(first.result?.reason, 'venue_failed_watching');

  const again = await landed(h, h.svc.proposeSwap({ chain: 'arb', fromSymbol: 'USDT', toSymbol: 'USDC', amountIn: 5, minAmountOut: 4.9 }));
  assert.equal(again.status, 'pending', 'the same coin, while the first may still go through');
  assert.equal(again.verdict.reasons.at(-1), 'An earlier swap of this coin may still go through, so this one waits for your OK.');

  const other = await landed(h, h.svc.proposeSwap({ chain: 'arb', fromSymbol: 'USDC', toSymbol: 'USDT', amountIn: 5, minAmountOut: 4.9 }));
  assert.equal(other.status, 'executed', 'another coin is not held back');
});

// ---------- reconcile ----------

const GRACE_AND_A_MINUTE = 6 * 60_000;

type Verifier = { spent: boolean | null; saltValid?: boolean | null };

function ledgerOf(rows: IntentsActivity['rows']): IntentsActivity {
  return { account: SELF_EVM, ok: true, rows, balances: null, partial: false, source: 'nearblocks', explorer: null, note: '' };
}
// One row from before the click: the page reaches back, and nothing went to the handle.
const QUIET = ledgerOf([{ cause: 'TRANSFER', token: 'wNEAR', tokenId: 'nep141:wrap.near', delta: '+1', counterparty: 'solver.near', hash: 'h0', time: new Date(Date.now() - 3_600_000).toISOString() }]);

function world(v: Verifier, opts: { ledger?: Ledger; status?: OneClickStatus } = {}) {
  const asked: string[] = [];
  const rails: RailRegistry = {
    for: () => null,
    kinds: () => [],
    relay: {
      status: async () => {
        throw new Error('a 1Click row is never asked of the relay');
      },
      nonceUsed: async (_account, nonce) => {
        asked.push(nonce);
        return v.spent;
      },
      saltValid: async () => v.saltValid ?? true,
    },
    swap: { tokens: async () => [], balance: async () => null, activity: async () => QUIET },
  };
  const status: OneClickStatus = opts.status ?? { found: true, status: 'FAILED', reported: 'FAILED', originTxHashes: [], destinationTxHashes: [], nearTxHashes: [], refundedAmount: '0' };
  const h = makeCtx({ deps: { rails, oneClickStatus: async () => status, ...(opts.ledger === undefined ? {} : { ledger: opts.ledger }) } });
  return { ...h, asked };
}

function seed(h: ReturnType<typeof world>, over: { status?: Proposal['status']; reason?: string; evidence: RailEvidence }): Proposal {
  const p: Proposal = {
    id: 'w-1',
    kind: 'swap',
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    decidedAt: new Date(Date.now() - 60_000).toISOString(),
    settledAt: new Date(Date.now() - 50_000).toISOString(),
    status: over.status ?? 'needs_reconciliation',
    draft: { ...WATCHING_SWAP, amountUsd: 12 },
    simulation: null,
    verdict: { outcome: 'allow', reasons: [] },
    decidedBy: 'human',
    result: { ok: false, detail: '1click reported FAILED', txids: ['intent-h'], reason: over.reason ?? 'venue_failed_watching', evidence: { handle: 'dep-1', providerStage: 'FAILED', ...over.evidence } },
  };
  h.store.put(p);
  return p;
}

const live = () => new Date(Date.now() + 2 * 60_000).toISOString();
const dead = () => new Date(Date.now() - GRACE_AND_A_MINUTE).toISOString();

test('reconcile keeps a row open while its signed transfer can still run, and counts it', async () => {
  const h = world({ spent: false });
  seed(h, { evidence: { nonce: NONCE, deadline: live() } });
  const out = await h.svc.reconcile('w-1');
  assert.equal(out.status, 'needs_reconciliation');
  assert.equal(out.result?.reason, 'venue_failed_watching');
  assert.deepEqual(h.asked, [NONCE]);
  assert.equal(h.svc.dailyLimit(25_000).spentUsd, 12);
});

test('reconcile closes it for real once the deadline has passed with the nonce unspent', async () => {
  const h = world({ spent: false });
  seed(h, { evidence: { nonce: NONCE, deadline: dead() } });
  const out = await h.svc.reconcile('w-1');
  assert.equal(out.status, 'failed');
  assert.equal(out.result?.reason, 'venue_failed_nothing_moved');
  assert.match(out.result?.detail ?? '', /deadline .* passed with the signed transfer never run/);
  assert.equal(h.svc.dailyLimit(25_000).spentUsd, 0);
  assert.equal(h.svc.view(out).reason?.retry, true);
});

test('a nonce the verifier shows spent is the input having left, before or after the deadline', async () => {
  const h = world({ spent: true });
  seed(h, { evidence: { nonce: NONCE, deadline: dead() } });
  const out = await h.svc.reconcile('w-1');
  assert.equal(out.status, 'needs_reconciliation');
  assert.equal(out.result?.reason, 'venue_failed_refund_pending');
});

test('past the deadline, an unspent nonce under a retired salt is no proof, and the ledger decides', async () => {
  const h = world({ spent: false, saltValid: false });
  seed(h, { evidence: { nonce: NONCE, deadline: dead() } });
  const out = await h.svc.reconcile('w-1');
  assert.equal(out.status, 'failed');
  assert.match(out.result?.detail ?? '', /intents ledger shows no transfer to handle dep-1/);
});

test('a transfer 1Click never ran ends once its deadline has passed, whatever 1Click is still waiting for', async () => {
  // The submit was refused or never answered: 1Click saw no deposit, and the row read unconfirmed.
  const pending: OneClickStatus = { found: true, status: 'PENDING_DEPOSIT', reported: 'PENDING_DEPOSIT', originTxHashes: [], destinationTxHashes: [], nearTxHashes: [] };
  const waiting = world({ spent: false }, { status: pending });
  seed(waiting, { reason: 'stuck_unknown', evidence: { nonce: NONCE, deadline: live(), providerStage: 'PENDING_DEPOSIT' } });
  assert.equal((await waiting.svc.reconcile('w-1')).status, 'needs_reconciliation', 'inside the deadline it can still run');

  const over = world({ spent: false }, { status: pending });
  seed(over, { reason: 'stuck_unknown', evidence: { nonce: NONCE, deadline: dead(), providerStage: 'PENDING_DEPOSIT' } });
  const out = await over.svc.reconcile('w-1');
  assert.equal(out.status, 'failed');
  assert.equal(out.result?.reason, 'venue_failed_nothing_moved');
  assert.match(out.result?.detail ?? '', /1click reports PENDING_DEPOSIT, and the deadline .* passed with the signed transfer never run/);
});

test('a row closed as nothing moved while its 72-hour signature was live is swept again and reopened', async () => {
  const h = world({ spent: false });
  seed(h, { status: 'failed', reason: 'venue_failed_nothing_moved', evidence: { deadline: new Date(Date.now() + 71 * 3600_000).toISOString() } });
  assert.equal(await h.svc.reconcileOpen(), 1);
  const row = h.store.get('w-1');
  assert.equal(row?.status, 'needs_reconciliation', 'the ledger shows nothing yet, and the transfer can still run');
  assert.equal(row?.result?.reason, 'stuck_unknown');
  assert.equal(h.svc.dailyLimit(25_000).spentUsd, 12);
});

test('the first ledger refresh after the deadline asks again, instead of waiting for the ten-minute sweep', async () => {
  const listeners: Array<() => void> = [];
  const snapshot = { ...loadDemoLedger(), mode: 'live' as const };
  const ledger: Ledger = {
    snapshot: () => snapshot,
    intents: () => undefined,
    hyperliquid: () => undefined,
    refresh: async () => snapshot,
    onRefresh: (fn) => {
      listeners.push(fn);
      return () => {};
    },
  };
  const h = world({ spent: false }, { ledger });
  seed(h, { evidence: { nonce: NONCE, deadline: dead() } });
  for (const fn of listeners) fn();
  const until = Date.now() + 2000;
  while (h.store.get('w-1')?.status !== 'failed' && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.store.get('w-1')?.status, 'failed');
  assert.equal(h.store.get('w-1')?.result?.reason, 'venue_failed_nothing_moved');
});
