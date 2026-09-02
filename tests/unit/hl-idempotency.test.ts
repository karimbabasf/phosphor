// Retrying a Hyperliquid write must not do it twice.
//
// Two separate holes, both of them the same shape: a safety mechanism that existed in the
// comments and not in the code.
//
//   The cloid. newCloid() promises "after an ambiguous network failure the same cloid cannot
//   produce a second fill". Every one of the six call sites in the runner generated a FRESH
//   one, so the id the venue dedupes on was new on every attempt and the documented safety did
//   not exist at all.
//
//   The withdrawal nonce. `nonce = action.time` is the only identity a withdraw3 has. The post
//   was not wrapped, so a lost response after the venue accepted surfaced as a thrown error, and
//   a retry above it called buildWithdrawPayload({ time: Date.now() }): a new nonce, a new
//   signature, and a venue perfectly happy to pay out a second time.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Address } from 'viem';

import { cloidFor, newCloid, CLOID_WINDOW_MS } from '../../src/hl/exchange.ts';
import { withdraw3, usdClassTransfer } from '../../src/rails/hyperliquid-withdraw.ts';
import type { HlWithdrawDeps } from '../../src/rails/hyperliquid-withdraw.ts';

const OWNER = '0x1111111111111111111111111111111111111111' as Address;

// ---------- the client order id ----------

test('the same order in the same window produces the same id', () => {
  const now = 1_800_000_000_000;
  const a = cloidFor({ mandate: 'm1', leg: 'open-ETH-long', now });
  const b = cloidFor({ mandate: 'm1', leg: 'open-ETH-long', now: now + 5_000 });
  assert.equal(a, b, 'a retry five seconds later is the same order');
});

test('a different leg, mandate or window produces a different id', () => {
  const now = 1_800_000_000_000;
  const base = cloidFor({ mandate: 'm1', leg: 'open-ETH-long', now });
  assert.notEqual(base, cloidFor({ mandate: 'm2', leg: 'open-ETH-long', now }));
  assert.notEqual(base, cloidFor({ mandate: 'm1', leg: 'reduce-ETH-0.5000', now }));
  assert.notEqual(base, cloidFor({ mandate: 'm1', leg: 'open-ETH-long', now: now + CLOID_WINDOW_MS * 2 }));
});

test('the id is a 128 bit hex string, the shape the venue takes', () => {
  const id = cloidFor({ mandate: 'm1', leg: 'open-ETH-long' });
  assert.match(id, /^0x[0-9a-f]{32}$/);
  assert.match(newCloid(), /^0x[0-9a-f]{32}$/);
});

test('the retry window is wider than a venue write timeout', () => {
  // A withdrawal or an order gets 30 s before its own deadline fires. A retry window shorter
  // than that would hand the retry a different id, which is the bug this closes.
  assert.ok(CLOID_WINDOW_MS >= 30_000, 'a window under the write budget cannot cover a timed-out attempt');
});

test('random ids, the old behaviour, collide with nothing and therefore dedupe nothing', () => {
  assert.notEqual(newCloid(), newCloid());
});

// ---------- the withdrawal nonce ----------

// A venue that behaves like Hyperliquid: it remembers the nonces it has seen and refuses a
// repeat, which is the whole of its deduplication.
function fakeVenue(options: { dropReplyOnAttempt?: number } = {}): {
  deps: HlWithdrawDeps;
  seen: number[];
  paid: number[];
  attempts: number;
} {
  const seen: number[] = [];
  const paid: number[] = [];
  const state = { attempts: 0 };

  const fetchImpl: typeof fetch = (async (url: unknown, init?: RequestInit) => {
    const target = String(url);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;

    if (target.endsWith('/info')) {
      const type = String(body.type);
      if (type === 'clearinghouseState') {
        return json({ withdrawable: '5000.0', marginSummary: { accountValue: '5000.0' } });
      }
      if (type === 'spotClearinghouseState') return json({ balances: [{ coin: 'USDC', total: '5000.0' }] });
      return json({});
    }

    // The exchange endpoint.
    state.attempts += 1;
    const nonce = Number(body.nonce);
    if (seen.includes(nonce)) {
      // Exactly what Hyperliquid answers for a nonce it has already used.
      return json({ status: 'err', response: 'Nonce already used or too old' });
    }
    seen.push(nonce);
    paid.push(nonce);
    if (options.dropReplyOnAttempt === state.attempts) {
      // Accepted at the venue, and the caller never hears about it.
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      throw err;
    }
    return json({ status: 'ok', response: { type: 'default' } });
  }) as typeof fetch;

  return {
    seen,
    paid,
    get attempts() {
      return state.attempts;
    },
    deps: {
      keysPath: '/nonexistent/keys.json',
      fetchImpl,
      sign: {
        address: () => OWNER,
        signTypedData: async () => ({ r: '0x1', s: '0x2', v: 27 }),
      } as never,
      now: () => 1_800_000_000_000,
    },
  };
}

function json(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

test('a withdrawal whose reply is lost is ambiguous, never failed', async () => {
  const venue = fakeVenue({ dropReplyOnAttempt: 1 });
  const out = await withdraw3(venue.deps, { amount: 100 });

  assert.equal(out.ok, false);
  assert.equal(out.ambiguous, true, 'the venue may have accepted it');
  assert.match(out.detail, /IT MAY HAVE BEEN ACCEPTED/);
  assert.equal(typeof out.nonce, 'number', 'the nonce comes back so a retry can be a retry');
  assert.deepEqual(venue.paid.length, 1, 'the venue took it');
});

test('a retry with the returned nonce is refused as a duplicate', async () => {
  const venue = fakeVenue({ dropReplyOnAttempt: 1 });
  const first = await withdraw3(venue.deps, { amount: 100 });
  assert.equal(first.ambiguous, true);

  const retry = await withdraw3(venue.deps, { amount: 100, nonce: first.nonce });

  assert.equal(retry.ok, false);
  assert.match(retry.detail, /Nonce already used/);
  assert.equal(venue.paid.length, 1, 'ONE withdrawal reached the venue, not two');
});

test('a retry that mints a fresh nonce would pay out twice, which is why the nonce is returned', async () => {
  const venue = fakeVenue({ dropReplyOnAttempt: 1 });
  const first = await withdraw3(venue.deps, { amount: 100 });
  assert.equal(first.ambiguous, true);

  // The old behaviour: retry without carrying the nonce forward. `now` is fixed in this
  // harness, so make the clock move the way a real retry a second later would.
  const later: HlWithdrawDeps = { ...venue.deps, now: () => 1_800_000_001_000 };
  const wrong = await withdraw3(later, { amount: 100 });

  assert.equal(wrong.ok, true, 'the venue is perfectly happy to do it again');
  assert.equal(venue.paid.length, 2, 'this is the second real withdrawal the nonce reuse prevents');
});

test('an ordinary withdrawal still works and reports its nonce', async () => {
  const venue = fakeVenue();
  const out = await withdraw3(venue.deps, { amount: 100 });
  assert.equal(out.ok, true, out.detail);
  assert.equal(venue.paid.length, 1);
});

test('the same nonce discipline covers the spot to perp transfer', async () => {
  const venue = fakeVenue({ dropReplyOnAttempt: 1 });
  const first = await usdClassTransfer(venue.deps, { amount: 10, toPerp: true });
  assert.equal(first.ambiguous, true);
  assert.equal(typeof first.nonce, 'number');

  const retry = await usdClassTransfer(venue.deps, { amount: 10, toPerp: true, nonce: first.nonce });
  assert.equal(retry.ok, false);
  assert.match(retry.detail, /Nonce already used/);
  assert.equal(venue.paid.length, 1);
});
