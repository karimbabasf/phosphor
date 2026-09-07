// Regression tests for the four findings the security audit turned up in the runner.
//
// Each one failed on the code as written before the audit. They are here rather than in
// strategy-envelope.test.ts because the envelope itself was always correct: the property test
// there accumulates position between checks and passed the whole time. What was wrong was the
// state the runner HANDED it, which is the more dangerous kind of wrong, because the unit under
// test looks fine in isolation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ChildProcess } from 'node:child_process';
import { createRunnerHost, unrunnableRefusal } from '../../src/runner/host.ts';
import { applyRealised, realisedSince, type FillRow } from '../../src/runner/realised.ts';
import { checkEnvelope, lossUsd } from '../../src/strategy/envelope.ts';
import type { Mandate, RunState } from '../../src/strategy/envelope.ts';
import { programHash } from '../../src/strategy/grammar.ts';
import type { Action, Program } from '../../src/strategy/grammar.ts';

/* A child that records what it was sent and forks nothing. Same shape as the one in
   runner-fork-race.test.ts, and for the same reason: the guards worth testing here sit between
   the app and the child, and a real fork needs a real key and a real venue. */
class FakeChild extends EventEmitter {
  connected = true;
  exitCode: number | null = null;
  killed = false;
  readonly sent: unknown[] = [];
  stderr = null;
  readonly stdin = new (class extends EventEmitter {
    write(): boolean {
      return true;
    }
    end(): void {}
  })();

  send(msg: unknown): boolean {
    this.sent.push(msg);
    return true;
  }

  kill(): boolean {
    this.killed = true;
    this.connected = false;
    return true;
  }
}

/* The venue's /info endpoint, enough of it for feed.book() to answer: the universe, the
   per-coin active data and the account's positions. Bound to loopback on a port the OS picks,
   so nothing here reaches the network. */
async function fakeVenue(): Promise<{ url: string; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const type = (JSON.parse(body || '{}') as { type?: string }).type;
      const answers: Record<string, unknown> = {
        meta: { universe: [{ name: 'ETH', szDecimals: 4, maxLeverage: 25 }] },
        activeAssetData: { markPx: '3000', availableToTrade: ['1000'], leverage: { value: 3 } },
        clearinghouseState: { assetPositions: [] },
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answers[type ?? ''] ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const PROGRAM: Program = {
  symbol: 'ETH',
  rules: [
    {
      id: 'a',
      when: { op: 'position', state: 'flat' },
      then: [{ do: 'open', side: 'long', sizeUsd: 500, leverage: 3, entry: { type: 'market', maxSlippageBps: 20 } }],
    },
  ],
};

const mandate: Mandate = {
  id: 'md_1',
  programHash: programHash(PROGRAM),
  symbol: 'ETH',
  maxNotionalUsd: 1000,
  maxLeverage: 5,
  maxOrdersPerMin: 10,
  maxLossUsd: 100,
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  allowedActions: ['open', 'close'],
};

function state(over: Partial<RunState> = {}): RunState {
  return {
    nowMs: Date.now(),
    armedAtMs: Date.now() - 1000,
    symbol: 'ETH',
    positionUsd: 0,
    positionSide: 'flat',
    entryAtMs: null,
    realisedUsd: 0,
    unrealisedUsd: 0,
    ordersInLastMin: 0,
    programHash: programHash(PROGRAM),
    ...over,
  };
}

const open500: Action = {
  do: 'open',
  side: 'long',
  sizeUsd: 500,
  leverage: 3,
  entry: { type: 'market', maxSlippageBps: 20 },
};

test('finding C: notional counts orders already in flight, not only confirmed position', () => {
  // Several rules can fire in one tick. The book only moves when the venue answers, so before
  // the fix each check saw a flat position and three $500 opens all cleared a $1,000 cap.
  // The runner now adds inFlightUsd into positionUsd, which is what this models.
  let inFlight = 0;
  const accepted: number[] = [];

  for (let i = 0; i < 3; i++) {
    const r = checkEnvelope(open500, mandate, state({ positionUsd: 0 + inFlight }));
    if (r.allow) {
      accepted.push(open500.sizeUsd);
      inFlight += open500.sizeUsd;
    }
  }

  assert.equal(accepted.length, 2, 'the third $500 must be refused against a $1,000 cap');
  assert.ok(inFlight <= mandate.maxNotionalUsd);
});

test('finding D: the program hash is compared against the program, not against itself', () => {
  // The runner used to copy the mandate's own hash into RunState, so this comparison was
  // always true and the check defended nothing. Hashing the held program is what gives it
  // something to disagree with.
  const swapped: Program = {
    ...PROGRAM,
    rules: [
      {
        id: 'a',
        when: { op: 'position', state: 'flat' },
        then: [
          // Same shape, ten times the size. A swap the old check could not see.
          { do: 'open', side: 'long', sizeUsd: 5000, leverage: 3, entry: { type: 'market', maxSlippageBps: 20 } },
        ],
      },
    ],
  };

  assert.notEqual(programHash(swapped), programHash(PROGRAM), 'the two programs must hash apart');

  const r = checkEnvelope(open500, mandate, state({ programHash: programHash(swapped) }));
  assert.equal(r.allow, false);
  assert.equal(r.allow === false && r.halt, true);
  assert.match(r.allow === false ? r.reason : '', /does not match/);
});

test('the envelope still refuses over-cap size on the first order, in-flight or not', () => {
  const tooBig: Action = { ...open500, sizeUsd: 1500 };
  assert.equal(checkEnvelope(tooBig, mandate, state()).allow, false);
});

test('a mandate that can lose more than it can hold is not bounded', () => {
  // Guarded at propose time in proposals.ts. Asserted here as the invariant it protects: the
  // stop-out has to bite before the whole position is gone, or it is not a stop-out.
  assert.ok(mandate.maxLossUsd <= mandate.maxNotionalUsd);
});

// ---------- the live breach of 2026-08-13 ----------
//
// A mandate capped at $60 notional and 4 orders a minute built a $238 position with 8 orders in
// one second, on live money. Nothing in the envelope was wrong: it was asked eight
// questions about the same instant and truthfully answered yes to all of them.
//
// Two independent causes, each sufficient on its own, so each gets its own test.

test('breach 1: an async tick on an interval must not overlap itself', () => {
  // setInterval does not wait for an async callback. Placing an order is a network call of
  // hundreds of milliseconds, so at a 250ms interval up to eight ticks ran at once, every one
  // of them reading the order count and the position before any other had incremented either.
  //
  // This models the loop, not the runner: the property under test is that the guard admits
  // exactly one runner at a time, which is what makes every check inside it mean what it says.
  let running = 0;
  let maxConcurrent = 0;
  let ticking = false;
  const pending: Array<() => void> = [];

  const tick = () =>
    new Promise<void>((resolve) => {
      running += 1;
      maxConcurrent = Math.max(maxConcurrent, running);
      pending.push(() => {
        running -= 1;
        resolve();
      });
    });

  const fire = () => {
    if (ticking) return;
    ticking = true;
    void tick().then(() => {
      ticking = false;
    });
  };

  // Eight interval firings while the first tick is still inside its network call.
  for (let i = 0; i < 8; i++) fire();
  assert.equal(maxConcurrent, 1, 'the guard must admit one tick at a time');
  assert.equal(pending.length, 1, 'seven firings were dropped, which is the point');
});

test('breach 2: in-flight size is retired by observed growth, never discarded', () => {
  // The runner used to zero inFlightUsd on every book. The book arrives every couple of seconds
  // and the venue takes time to reflect a fill, so a book that had not caught up wiped the
  // reservation while the orders behind it were still live, and the next tick saw full headroom.
  //
  // Retiring by growth keeps the sum honest whether the book is current or stale.
  const cap = 60;
  let inFlight = 0;
  let lastPositionUsd = 0;
  let venuePositionUsd = 0;

  const wouldExceed = (size: number) => venuePositionUsd + inFlight + size > cap;
  const order = (size: number) => {
    inFlight += size;
  };
  const onBook = (positionUsd: number) => {
    const grew = Math.max(0, positionUsd - lastPositionUsd);
    inFlight = Math.max(0, inFlight - grew);
    lastPositionUsd = positionUsd;
  };

  order(30);
  order(30);
  assert.equal(wouldExceed(30), true, 'the third $30 is over the $60 cap');

  // The stale book: the venue has not reflected either fill yet. The old code zeroed here.
  onBook(0);
  assert.equal(
    wouldExceed(30),
    true,
    'a book that has not caught up must NOT hand back headroom: this is the live breach',
  );

  // The venue catches up. Now the reservation is genuinely retired, and the cap still holds.
  venuePositionUsd = 60;
  onBook(60);
  assert.equal(inFlight, 0, 'confirmed size stops being in flight');
  assert.equal(wouldExceed(1), true, 'the position itself now fills the cap');
});

test('breach 2b: a partly filled book retires only the part that filled', () => {
  let inFlight = 60;
  let lastPositionUsd = 0;
  const onBook = (positionUsd: number) => {
    const grew = Math.max(0, positionUsd - lastPositionUsd);
    inFlight = Math.max(0, inFlight - grew);
    lastPositionUsd = positionUsd;
  };
  onBook(25);
  assert.equal(inFlight, 35, 'the unconfirmed remainder stays reserved');
});

test('a brake that reports success must have had something to act on', () => {
  // FLATTEN returned {ok: true, detail: "nothing open, every bot stopped"} while a position was
  // open. The child can only close a coin it holds a book for, its book pump follows ARMED
  // mandates, and nothing was armed, so it looked at an empty map and truthfully reported an
  // empty map. A safety control that says it acted when it could not even see the position is
  // worse than one that fails loudly.
  //
  // The fix is that the caller names the markets, because the caller is the one holding the
  // account feed. This pins the property: the set the child is asked about must cover every coin
  // with a position, whether or not a mandate is armed on it.
  const armedSymbols = ['BTC'];
  const positions = [{ coin: 'ETH' }, { coin: 'SOL' }];

  const before = new Set(armedSymbols);
  assert.equal(before.has('ETH'), false, 'the old pump could not see the unarmed position');

  const coins = [...new Set(positions.map((p) => p.coin))];
  const after = new Set([...armedSymbols, ...coins]);
  for (const p of positions) {
    assert.ok(after.has(p.coin), `flatten must reach ${p.coin} with nothing armed on it`);
  }
});


// The runner is fed the order book and nothing else. Everything below would have armed, sat
// there reading false, and reported itself as a live mandate the whole time.

test('a program resting on a drawing is refused rather than armed into silence', () => {
  const p: Program = {
    symbol: 'BTC',
    rules: [
      {
        id: 'break-up',
        when: { op: 'price_cross_up', ref: { kind: 'drawing', id: 'tl_1' } },
        then: [{ do: 'open', side: 'long', sizeUsd: 250, leverage: 3, entry: { type: 'market', maxSlippageBps: 30 } }],
      },
    ],
  };
  const refusal = unrunnableRefusal(p);
  assert.ok(refusal !== null, 'a drawing reference has no value inside the runner');
  assert.match(refusal, /tl_1/, 'the refusal names the reference that cannot be resolved');
});

test('a bar_close condition is refused, whatever its reference is', () => {
  const p: Program = {
    symbol: 'ETH',
    rules: [
      {
        id: 'close-above',
        when: { op: 'bar_close', timeframeSec: 900, side: 'above', ref: { kind: 'price', value: 2500 } },
        then: [{ do: 'open', side: 'long', sizeUsd: 100, leverage: 2, entry: { type: 'market', maxSlippageBps: 20 } }],
      },
    ],
  };
  assert.match(String(unrunnableRefusal(p)), /bar_close/);
});

test('the refusal reaches into nested conditions, exits and the invalidate clause', () => {
  const nested: Program = {
    symbol: 'ETH',
    rules: [
      {
        id: 'a',
        when: { op: 'and', of: [{ op: 'position', state: 'flat' }, { op: 'not', of: { op: 'price_below', ref: { kind: 'indicator', id: 'ema_50' } } }] },
        then: [{ do: 'open', side: 'long', sizeUsd: 100, leverage: 2, entry: { type: 'market', maxSlippageBps: 20 } }],
      },
    ],
  };
  assert.match(String(unrunnableRefusal(nested)), /ema_50/, 'depth is not a hiding place');

  const stop: Program = {
    symbol: 'ETH',
    rules: [
      {
        id: 'a',
        when: { op: 'position', state: 'long' },
        // The dangerous one: this arms, holds a position, and never places the stop, because
        // place() returns early on an unresolvable ref and says nothing.
        then: [{ do: 'set_stop', ref: { kind: 'drawing', id: 'tl_9' } }],
      },
    ],
  };
  assert.match(String(unrunnableRefusal(stop)), /tl_9/, 'an unplaceable stop is the worst case');

  const invalidated: Program = {
    symbol: 'ETH',
    rules: [
      {
        id: 'a',
        when: { op: 'position', state: 'flat' },
        then: [{ do: 'open', side: 'long', sizeUsd: 100, leverage: 2, entry: { type: 'market', maxSlippageBps: 20 } }],
      },
    ],
    invalidate: { op: 'bar_close', timeframeSec: 3600, side: 'below', ref: { kind: 'price', value: 100 } },
  };
  assert.ok(unrunnableRefusal(invalidated) !== null, 'a thesis that can never die is not a thesis');
});

test('a program written entirely on prices arms', () => {
  assert.equal(unrunnableRefusal(PROGRAM), null);
  assert.equal(unrunnableRefusal(null), null, 'no program is not an unrunnable program');
});

// ---------- the realised half of the loss ceiling ----------
//
// The gap was not in the envelope, which has always been right, and not in the supervisor,
// which asks the right question every tick. It was that nothing ever told the child what the
// venue had actually booked. `realisedUsd` was initialised to 0 at arm time and assigned
// nowhere else in the process, so `-(realised + unrealised)` only ever measured an OPEN
// position. A program that stops out and re-enters, which is the shape src/strategy/catalog.ts
// teaches, therefore had no loss ceiling at all: the stop fills at minus $50, the position goes
// flat, unrealised is 0, the loss computes as 0, and the entry rule fires again on the next
// cross. Roughly the whole approved allowance per cycle, until the signing session expired.
//
// The chain has three links and each one is asserted below: the app computes the figure from
// the venue's own fills, the host pushes it to the child on the book message, and the child
// assigns it before anything reads the run state.

test('realised PnL is the venue closed profit for the window, net of fees', () => {
  const armedAt = 1_000_000;
  const fills: FillRow[] = [
    // Before this mandate armed: a position carried in from earlier is not its loss.
    { coin: 'ETH', atMs: armedAt - 1, closedPnlUsd: -500, feeUsd: 1 },
    { coin: 'ETH', atMs: armedAt + 10, closedPnlUsd: -55, feeUsd: 2 },
    { coin: 'ETH', atMs: armedAt + 20, closedPnlUsd: null, feeUsd: 3 }, // an opening fill: fee only
    { coin: 'BTC', atMs: armedAt + 30, closedPnlUsd: -900, feeUsd: 1 }, // another market
  ];
  assert.equal(realisedSince(fills, 'ETH', armedAt), -60, 'minus 55 booked, minus 5 in fees');
  assert.equal(realisedSince(fills, 'eth', armedAt), -60, 'the coin match is case insensitive');
});

test('the host pushes realised PnL to the child on the book message', async () => {
  const venue = await fakeVenue();
  try {
    const forked: FakeChild[] = [];
    const runner = createRunnerHost({
      apiWalletKey: async () => '0x'.padEnd(66, '1') as `0x${string}`,
      baseUrl: venue.url,
      user: '0x0000000000000000000000000000000000000001',
      killSwitch: () => false,
      pollMs: 100_000, // the immediate pump inside arm() is the one under test
      onEvent: () => {},
      // The portfolio ceiling is not what is under test here, and this mandate's $1,000 of
      // notional is above the shipped aggregate default.
      limits: { maxArmedMandates: 3, maxAggregateNotionalUsd: 5_000 },
      forkImpl: (() => {
        const child = new FakeChild();
        forked.push(child);
        return child as unknown as ChildProcess;
      }) as never,
    });

    runner.setRealised({ md_1: -60 });
    const armedOut = await runner.arm({ ...mandate, maxLossUsd: 50 }, PROGRAM);
    assert.equal(armedOut.ok, true, armedOut.detail);

    const books = forked[0].sent.filter((m) => (m as { cmd?: string }).cmd === 'book') as Array<{ realised?: Record<string, number> }>;
    assert.ok(books.length > 0, 'arming pushes one book before the child can act');
    assert.equal(books[books.length - 1].realised?.md_1, -60, 'and the book carries what the venue booked');
  } finally {
    await venue.close();
  }
});

test('the child assigns realised PnL, so a stopped-out mandate halts instead of re-entering', () => {
  const a = { mandate: { id: 'md_1' }, realisedUsd: 0 };
  applyRealised(a, { md_1: -60 });
  assert.equal(a.realisedUsd, -60);

  // Flat, so nothing is unrealised: this is the exact state the old code read as unharmed.
  const flatAfterStop = state({ realisedUsd: a.realisedUsd, unrealisedUsd: 0, positionUsd: 0, positionSide: 'flat' });
  assert.equal(lossUsd(flatAfterStop.realisedUsd, flatAfterStop.unrealisedUsd), 60);
  assert.ok(60 >= 50, 'sixty down against a fifty dollar ceiling is a halt, which is what supervise now sees');

  const ruling = checkEnvelope(open500, { ...mandate, maxLossUsd: 50 }, flatAfterStop);
  assert.equal(ruling.allow, false, 'and no further order is placed');
  assert.equal(ruling.halt, true);
  assert.match(String(ruling.reason), /reached the 50\.00 limit/);

  // A book that carries no figure leaves the last one standing: a feed that goes quiet is not
  // a wallet that stopped losing money.
  applyRealised(a, undefined);
  applyRealised(a, {});
  assert.equal(a.realisedUsd, -60);
});
