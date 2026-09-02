// The app side of the runner: spawns the child, tracks what is armed, and can always kill it.
//
// The runner is a separate process rather than a function call or a worker thread, and the
// reason is scheduling before it is isolation. An order must not queue behind whatever the HTTP
// server and the chart's SSE broadcast are doing; a wedged request in the app should not delay
// a stop. A worker thread fixes that much but shares a process, so a hard kill is not clean and
// a crash takes the window down with it. A child process costs sub-millisecond IPC and buys its
// own event loop, its own socket, and a kill that is absolute.
//
// One process hosts every armed mandate over one multiplexed websocket. Per-mandate processes
// were rejected as sprawl for no safety gain, since the envelope check is per action either way.
//
// The key handed to the child is the API wallet, never the master. The venue permits it to trade
// and forbids it from withdrawing, transferring, or approving another agent, so a compromised
// runner loses trading control and not the money. The master key never enters this process tree.

import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MandateRunner } from '../rails/mandate.ts';
import type { Mandate } from '../strategy/envelope.ts';
import type { Condition, Program, Ref } from '../strategy/grammar.ts';
import { SIGNING_SESSION_DEFAULT_MS } from '../keystore/session.ts';
import type { Session } from '../keystore/session.ts';
import { createFeed } from './feed.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type RunnerEvent =
  | { type: 'armed'; id: string; symbol: string; signingExpiresAt: string }
  | { type: 'disarmed'; id: string; reason: string }
  | { type: 'fill'; id: string; symbol: string; side: string; sizeUsd: number; price: number }
  | { type: 'position'; id: string; symbol: string; sizeUsd: number; side: string; entryPx: number; liqPx: number | null; unrealisedUsd: number }
  | { type: 'halted'; id: string; reason: string }
  // Which rule fired. The window shows it so a person can see WHY the bot acted, not only that
  // it did, which is the difference between watching a program and trusting one.
  | { type: 'rule'; id: string; ruleId: string; at: string }
  | { type: 'manual_result'; requestId: string; ok: boolean; detail: string }
  | { type: 'error'; id: string | null; message: string };

// A button on the trading window: cancel one order, cancel every order on a market, close a
// position, or stop everything and close everything. All four only reduce, which is why none of
// them consults an envelope and none of them waits on an approval.
export type ManualAction = {
  verb: 'cancel' | 'cancel_all' | 'close' | 'flatten';
  cancels?: { assetId: number; oid: number }[];
  coin?: string;
  // Which markets flatten has to look at. The child can only close a coin it holds a book for,
  // and the book pump only runs for ARMED symbols, so with nothing armed the child's book is
  // empty and flatten found nothing to do. It said so, cheerfully, while a position was open.
  // The caller names the coins because the caller is the one with the account feed.
  coins?: string[];
};

export type HostDeps = {
  apiWalletKey: () => Promise<`0x${string}` | null>;
  /* THE SIGNING SESSION, and it is the one exception to the auto-lock.
     An armed rule has to survive a lock, or the bot is useless overnight, which is when perps
     run, and the owner turns the lock off and loses the master key with it. So arming opens a
     session scoped to that mandate, holding ONLY the Hyperliquid API wallet key: by the venue's
     own signing split it can place orders and cannot withdraw, transfer or approve another
     agent. A bot that outlives a lock holds trading authority, not custody.
     Optional so a test can build a host without one, in which case an armed mandate has no
     expiry beyond its own. */
  session?: Session;
  baseUrl: string;
  onEvent: (e: RunnerEvent) => void;
  killSwitch: () => boolean;
  user: string; // the master account address; positions and collateral are read against it
  pollMs?: number;
  // The portfolio ceiling, and the reason it lives here rather than in the envelope.
  //
  // Every existing limit is PER MANDATE: notional, borrowed multiple, order rate, loss and
  // expiry are all checked by src/strategy/envelope.ts against one mandate's own bounds. That
  // leaves the number nobody was checking, which is the sum. Three separate $200 mandates are
  // $600 of standing authority, each one individually within every rule, and no screen ever
  // stated the total.
  //
  // It is enforced at arm() because this map IS the armed set: the policy engine sees one
  // draft at a time and the child sees one mandate at a time, so this is the only place the
  // question "how much is armed right now" has an answer. Same shape as the kill-switch check
  // directly below it, and for the same reason: a refusal here happens before a child exists.
  //
  // It became load bearing on 2026-08-20, when the runner stopped refusing to trade real
  // money outright. A guard removed and replaced with nothing is a hole, so this replaced it.
  limits?: { maxArmedMandates: number; maxAggregateNotionalUsd: number };
  // Test seam, the same shape as fetchImpl on the rails and FeedSocket on the trade feed. The
  // guards around a DEAD child (the kill switch is the one that matters) cannot be exercised
  // against a real fork without a real key and a real venue, and those guards are the ones that
  // used to take the whole app down.
  forkImpl?: typeof fork;
};

// Deliberately small. Every run is against real collateral, and the number a human is most
// likely to regret is the one they never had to type, so this is also the fallback when a
// host passes no limits of its own.
export const TRADING_LIMITS = { maxArmedMandates: 3, maxAggregateNotionalUsd: 250 };

export type TradingLimits = { maxArmedMandates: number; maxAggregateNotionalUsd: number };

// The ceiling as a pure function of what is armed and what wants to arm, so it can be checked
// without a child process, a key or a venue. Returns the refusal sentence, or null to allow.
//
// Pure on purpose: the host can only populate its armed map after a child has spawned, which
// would have made the only test of this rule a test of process spawning.
export function tradingLimitRefusal(
  armedMandates: readonly { id: string; maxNotionalUsd: number }[],
  incoming: { id: string; maxNotionalUsd: number },
  limits: TradingLimits,
): string | null {
  // Re-arming an id that is already armed replaces it rather than adding to the total, so it
  // must not be counted twice against either ceiling.
  const others = armedMandates.filter((a) => a.id !== incoming.id);

  if (others.length + 1 > limits.maxArmedMandates) {
    return (
      `${others.length} mandates are already armed and the ceiling is ${limits.maxArmedMandates}. ` +
      `Disarm one before arming another: the limit is on standing authority, not on how much you can trade.`
    );
  }

  const armedNotional = others.reduce((sum, a) => sum + a.maxNotionalUsd, 0);
  const wouldBe = armedNotional + incoming.maxNotionalUsd;
  if (wouldBe > limits.maxAggregateNotionalUsd) {
    return (
      `arming this would put $${wouldBe.toFixed(2)} of standing authority on the account, above the ` +
      `$${limits.maxAggregateNotionalUsd.toFixed(2)} ceiling ($${armedNotional.toFixed(2)} is already armed). ` +
      `Every bound in a mandate is per mandate; this is the one on the sum of them.`
    );
  }

  return null;
}

// WHAT THE RUNNER CAN ACTUALLY EVALUATE, checked before anything arms.
//
// The child builds its MarketState from ONE input: the book pumpOnce sends below. Two kinds of
// reference have no source in that process at all:
//
//   - bar closes. The child hard-codes `lastClose: () => null` for every timeframe, so a
//     `bar_close` condition is false for the entire life of the mandate.
//   - drawings and indicators. The child holds a refCache keyed on `drawing:tl_1` and fills it
//     from a `refs` message. Nothing in this repo sends that message. resolveRef therefore
//     answers null for every drawing and every indicator, forever.
//
// Both failures are SILENT, and silent in the two worst ways. An entry rule that is permanently
// false is a bot that sits there while the human believes it is watching. An exit rule that is
// permanently false is a position with no stop: place() begins `if (ref === null) return` for
// set_stop, and a limit entry falls through to `resolveRef(ref) ?? b.markPx` and quietly becomes
// an order at the mark instead of at the line.
//
// This is not a hypothetical program shape. Worked example 2 in src/strategy/catalog.ts is built
// on a trend line and a 15m bar close, so it is the shape the app's own documentation teaches an
// agent to write.
//
// The right end state is to SEND those values, not to refuse programs that need them, and the
// hooks for it exist on both sides already. Until the pump carries them, arming one of these is
// arming a program that does not do what the human read and approved, so it is refused at the
// door where a person can see the refusal.
export function unrunnableRefusal(program: Program | null): string | null {
  if (program === null) return null;
  const gaps = new Set<string>();

  function ref(r: Ref): void {
    if (r.kind === 'drawing') gaps.add(`a drawing reference (${r.id})`);
    if (r.kind === 'indicator') gaps.add(`an indicator reference (${r.id})`);
  }

  function walk(c: Condition): void {
    switch (c.op) {
      case 'price_above':
      case 'price_below':
      case 'price_cross_up':
      case 'price_cross_down':
        ref(c.ref);
        return;
      case 'bar_close':
        gaps.add('a bar_close condition');
        ref(c.ref);
        return;
      case 'and':
      case 'or':
        for (const inner of c.of) walk(inner);
        return;
      case 'not':
        walk(c.of);
        return;
      default:
        return;
    }
  }

  for (const rule of program.rules) {
    walk(rule.when);
    for (const action of rule.then) {
      if (action.do === 'set_stop' || action.do === 'set_target') ref(action.ref);
      if ((action.do === 'open' || action.do === 'add') && action.entry.type === 'limit') ref(action.entry.ref);
      if ((action.do === 'reduce' || action.do === 'close') && action.exit.type === 'limit') ref(action.exit.ref);
    }
  }
  if (program.invalidate !== undefined) walk(program.invalidate);

  if (gaps.size === 0) return null;
  return (
    `this program rests on ${[...gaps].sort().join(' and ')}, and the runner is fed the order book ` +
    'and nothing else, so it has no value for that at any point. The condition would read false for ' +
    'the whole life of the mandate: an entry would never fire and a stop would never be placed. ' +
    'Rewrite those levels as fixed prices, { "kind": "price", "value": N }, and rewrite a bar close ' +
    'as a price condition, then arm it again.'
  );
}

export function createRunnerHost(deps: HostDeps): MandateRunner & {
  stopAll(reason: string): Promise<void>;
  setKilled(on: boolean): void;
  events(): RunnerEvent[];
  manual(action: ManualAction): Promise<{ ok: boolean; detail: string }>;
  feedHealth(): ReturnType<ReturnType<typeof createFeed>['health']>;
  armedDetail(): { mandate: Mandate; program: Program | null; since: string; signingExpiresAt: string }[];
  // Expired signing sessions, disarmed. Returns the ids it took the trading key back from.
  sweepSigningSessions(): string[];
} {
  let child: ChildProcess | null = null;
  /* THE FORK IN FLIGHT, and there is exactly one of it.
     ensureChild checked `child === null` and then AWAITED the API wallet key before forking,
     and nothing guarded that gap. Mandate rails run outside the proposal serialiser (the
     reservation is released as soon as the row is written), so two arms could sit inside one
     key read together. The second fork overwrote this binding; the first process stayed alive,
     had already been sent its arm message through its own returned handle, and held the same
     Hyperliquid API key. stopAll, setKilled, the kill switch and the SIGKILL backstop all
     address `child`, so the orphan kept placing orders with nothing able to stop it short of a
     reboot. One promise, shared by every concurrent caller, is the whole fix. */
  let starting: Promise<ChildProcess> | null = null;
  /* Bumped by stopAll. A fork whose key read finishes after everything was stopped belongs to
     a generation nobody wants, so it never happens: a kill switch that leaves a process behind
     because the process had not started yet is not a kill switch. */
  let generation = 0;
  // The program is held beside the mandate, not because this process runs it (the child does),
  // but because the trading window renders it in English. Reading it back off the child would
  // mean the screen showing a copy of the program rather than the program, and "the thing on
  // screen is the thing running" is the property the whole approval step depends on.
  const armed = new Map<string, { mandate: Mandate; program: Program | null; since: string; signingExpiresAt: string }>();
  const recent: RunnerEvent[] = [];
  const feed = createFeed({ baseUrl: deps.baseUrl, user: deps.user });
  let pump: NodeJS.Timeout | null = null;
  // Human actions in flight, keyed by the id sent to the child. Held here so an HTTP request
  // can await the venue's answer rather than returning "sent" and leaving the person to guess.
  const pending = new Map<string, (r: { ok: boolean; detail: string }) => void>();
  let manualSeq = 0;

  // Pushes market and account state to the child for every armed symbol.
  //
  // The app owns the read side so there is ONE view of the market across the process tree.
  // Two independent readers would be two answers to "what is the position", and the one that
  // signs would be the one that mattered while the one on screen disagreed.
  async function pumpOnce(extra: string[] = []): Promise<void> {
    const symbols = new Set([...[...armed.values()].map((a) => a.mandate.symbol), ...extra]);
    for (const symbol of symbols) {
      try {
        const b = await feed.book(symbol);
        if (b !== null && child !== null && child.connected) {
          child.send({ cmd: 'book', symbol, book: b });
        }
      } catch (err) {
        record({ type: 'error', id: null, message: `feed ${symbol}: ${err instanceof Error ? err.message : err}` });
      }
    }
  }

  function startPump(): void {
    if (pump !== null) return;
    /* Two jobs on one timer, and both of them wrapped.
       The expiry sweep rides the pump because the pump runs exactly while something is armed,
       which is exactly when a signing session can exist. A second timer for it would be a timer
       that ticks all night on an app with nothing running.

       `.catch` rather than `void` on the pump: pumpOnce awaits the feed and then calls record,
       which reaches the caller's onEvent and the audit file, and a rejection anywhere in that
       chain used to leave the process because a bare `void` consumes the value and not the
       rejection. The sweep gets a try for the same reason: it takes a trading key back, and a
       throw there must not stop the timer that would try again. */
    pump = setInterval(() => {
      try {
        api.sweepSigningSessions();
      } catch (err) {
        record({ type: 'error', id: null, message: `signing session sweep: ${err instanceof Error ? err.message : String(err)}` });
      }
      pumpOnce().catch((err: unknown) => {
        record({ type: 'error', id: null, message: `feed pump: ${err instanceof Error ? err.message : String(err)}` });
      });
    }, deps.pollMs ?? 2000);
    pump.unref();
  }

  function stopPump(): void {
    if (pump !== null) clearInterval(pump);
    pump = null;
  }

  function record(e: RunnerEvent): void {
    recent.push(e);
    if (recent.length > 200) recent.shift();
    deps.onEvent(e);
  }

  // Every caller that wants the child comes through here, and concurrent callers get the same
  // promise rather than each starting a fork of their own.
  function ensureChild(): Promise<ChildProcess> {
    if (child !== null && child.connected) return Promise.resolve(child);
    if (starting !== null) return starting;

    const job = forkChild();
    starting = job;
    /* Cleared however it ends, so a fork that failed does not wedge every later arm on a
       rejected promise it would keep handing out. The rejection still reaches this caller. */
    const clear = (): void => {
      if (starting === job) starting = null;
    };
    void job.then(clear, clear);
    return job;
  }

  async function forkChild(): Promise<ChildProcess> {
    const mine = generation;
    const key = await deps.apiWalletKey();
    if (mine !== generation) {
      throw new Error('everything was stopped while this runner was starting, so nothing was armed');
    }
    if (key === null) throw new Error('no API wallet key: run scripts/hl-agent.ts to approve one');

    const entry = path.join(__dirname, 'main.ts');
    /* THE KEY GOES OVER STDIN, and stdin is closed behind it.
       It went over the environment before, which was chosen over argv on purpose (argv is
       world-readable in `ps`) and was still not private: `ps eww <pid>` prints the environment
       of any process this user owns, which is the attacker this app is built against. A pipe
       has two ends and no third reader.

       `forkImpl` is a test seam, the same shape as fetchImpl on the rails. The guards below
       (child.on('error'), and the `connected` check on every send) are what a test needs to
       drive, and they cannot be reached against a real fork without a real key and a real venue. */
    const spawned = (deps.forkImpl ?? fork)(entry, [], {
      env: { ...process.env, PHOSPHOR_HL_URL: deps.baseUrl },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });
    child = spawned;
    /* A child that dies before it reads raises EPIPE on this stream, and `child.on('error')`
       below does not cover a stream of the child rather than the child itself: with no listener
       here it reached the process-wide crash handler and ended the app instead of the mandate. */
    spawned.stdin?.on('error', (err: Error) => {
      record({ type: 'error', id: null, message: `runner child never read its key: ${err.message}` });
    });
    spawned.stdin?.write(`${key}\n`);
    spawned.stdin?.end();

    spawned.on('message', (m) => {
      const e = m as RunnerEvent;
      // A manual result answers one waiting HTTP request rather than going to the log as an
      // event nobody asked for. It is still recorded, because a human closing a position is
      // exactly the kind of thing the audit trail exists for.
      if (e.type === 'manual_result') {
        const settle = pending.get(e.requestId);
        if (settle !== undefined) {
          pending.delete(e.requestId);
          settle({ ok: e.ok, detail: e.detail });
        }
      }
      // The child can stop a mandate on its own: a halt, or a flatten the human pressed. When
      // it does, this map has to follow, or the window keeps listing a bot as armed after the
      // process running it has let it go. Observed live: FLATTEN closed the position and the
      // screen still showed two armed mandates. Misreporting the safety state is the one thing
      // this repo has already decided is worse than the safety being off.
      if (e.type === 'halted' || e.type === 'disarmed') armed.delete(e.id);
      record(e);
    });
    spawned.on('exit', (code) => {
      // Anything armed when the child dies is no longer armed, whatever the exit code. Leaving
      // a mandate listed as live after its executor is gone would misreport the safety state,
      // which this repo already decided is worse than the safety being off.
      for (const [id] of armed) record({ type: 'disarmed', id, reason: `runner exited (${code})` });
      armed.clear();
      stopPump();
      // Only if this is still the current one. A process taken out by stopAll has already been
      // let go of, and clearing the binding here would clear one somebody else is holding.
      if (child === spawned) child = null;
    });
    spawned.stderr?.on('data', (b) => record({ type: 'error', id: null, message: String(b).trim() }));

    /* A fork that cannot start, and a send on an IPC channel that has closed, both raise 'error'
       on the child rather than throwing at the call site. With no listener Node re-raises it as
       an uncaught exception from nextTick, which ends the app rather than the mandate. Every
       other child in this repo has this listener (see driver.ts); this one did not. */
    spawned.on('error', (err) => {
      for (const [id] of armed) record({ type: 'disarmed', id, reason: `runner child failed: ${err.message}` });
      armed.clear();
      stopPump();
      if (child === spawned) child = null;
      record({ type: 'error', id: null, message: `runner child failed: ${err.message}` });
    });

    return spawned;
  }

  const api = {
    async arm(mandate: Mandate, program: unknown) {
      if (deps.killSwitch()) return { ok: false, detail: 'kill switch is on; nothing can arm' };

      const refusal = tradingLimitRefusal(
        [...armed.values()].map((a) => ({ id: a.mandate.id, maxNotionalUsd: a.mandate.maxNotionalUsd })),
        { id: mandate.id, maxNotionalUsd: mandate.maxNotionalUsd },
        deps.limits ?? TRADING_LIMITS,
      );
      if (refusal !== null) return { ok: false, detail: refusal };

      const unrunnable = unrunnableRefusal(program as Program | null);
      if (unrunnable !== null) return { ok: false, detail: unrunnable };

      try {
        const c = await ensureChild();
        c.send({ cmd: 'arm', mandate, program });
        /* The signing session's length is the mandate's own expiry, clamped. The human already
           chose how long this bot should live when they wrote the mandate, so asking them a
           second question about how long it may hold a key would be two numbers for one
           decision. The clamp is the app's own statement: eight hours by default, a day at
           most, whatever the mandate says. */
        const wanted = Date.parse(mandate.expiresAt) - Date.now();
        const signing = deps.session?.arm(mandate.id, Number.isFinite(wanted) && wanted > 0 ? wanted : SIGNING_SESSION_DEFAULT_MS);
        const signingExpiresAt = new Date(signing?.expiresAt ?? Date.now() + SIGNING_SESSION_DEFAULT_MS).toISOString();
        armed.set(mandate.id, { mandate, program: program as Program | null, since: new Date().toISOString(), signingExpiresAt });
        // One book pushed before the child can act, so its first tick reasons about the real
        // market rather than the zeros it starts with.
        await pumpOnce();
        startPump();
        record({ type: 'armed', id: mandate.id, symbol: mandate.symbol, signingExpiresAt });
        return {
          ok: true,
          detail: `armed ${mandate.id} on ${mandate.symbol}; it holds the trading key until ${signingExpiresAt}`,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        record({ type: 'error', id: mandate.id, message });
        return { ok: false, detail: message };
      }
    },

    async disarm(id: string, reason: string) {
      // Disarm never fails and never waits on approval. If the child is already gone the
      // mandate is already not running, which is the state the caller asked for.
      armed.delete(id);
      // The signing session goes with it. A session outliving the mandate it was opened for
      // would be a key held for a bot that no longer exists.
      deps.session?.disarm(id);
      if (child !== null && child.connected) child.send({ cmd: 'disarm', id, reason });
      record({ type: 'disarmed', id, reason });
      if (armed.size === 0) {
        stopPump();
        if (child !== null && child.connected) child.send({ cmd: 'shutdown' });
      }
      return { ok: true, detail: `disarmed ${id}: ${reason}` };
    },

    async stopAll(reason: string) {
      /* First, before anything else: a fork whose key read is still in flight belongs to the
         world this call is ending, so it never becomes a process. Without this the kill switch
         could return having killed nothing, and a child would appear a moment later with the
         trading key and no handle on it anywhere. */
      generation += 1;
      starting = null;
      for (const [id] of armed) record({ type: 'disarmed', id, reason });
      armed.clear();
      /* Every signing session goes, not only the ones this map knows about. Freeze everything
         must mean no key is held anywhere, and a kill switch that depends on its own
         bookkeeping being in step is not a kill switch. Same argument as the SIGKILL below. */
      for (const session of deps.session?.armed() ?? []) deps.session?.disarm(session.id);
      stopPump();
      if (child !== null) {
        // Ask first so it can flatten, then take the process out regardless. A kill switch that
        // depends on the thing it is killing being healthy is not a kill switch.
        //
        // The `connected` guard is the whole of it. This was the one send path in the file
        // without one, so flipping the kill switch onto a child that had already died threw
        // ERR_IPC_CHANNEL_CLOSED into `void runner.stopAll(...)` in main.ts, uncaught: the kill
        // switch killed the app. The SIGKILL below still runs, so the outcome is unchanged.
        if (child.connected) child.send({ cmd: 'flatten_and_exit', reason });
        const doomed = child;
        /* Let go of it here rather than waiting for its exit. It has been told to close
           everything and go, so it is not the child a later arm should be handed: reusing a
           process that is on its way out would arm a mandate onto something about to be
           SIGKILLed. The timer below still holds it, so nothing escapes. */
        child = null;
        setTimeout(() => {
          if (doomed.connected || doomed.exitCode === null) doomed.kill('SIGKILL');
        }, 3000).unref();
      }
    },

    // Pushed to the child so its supervisor sees the switch every tick. stopAll is still the
    // one that guarantees the outcome, because it does not depend on the child being healthy;
    // this makes the child stop cleanly and flat when it IS healthy, which is the better exit.
    setKilled(on: boolean): void {
      if (child !== null && child.connected) child.send({ cmd: 'kill', on });
    },

    // A button on the trading window. Runs in the child because the child is the only process
    // in the tree holding a key that can place an order, and signing a human's close in the app
    // would put a second copy of that key in a second process for no gain.
    //
    // The kill switch is NOT consulted. Every verb here only reduces, and a kill switch that
    // stopped a person closing their own position would be a trap rather than a brake.
    async manual(action: ManualAction): Promise<{ ok: boolean; detail: string }> {
      // Close and flatten need the market data the pump pushes, so a child that has just
      // started has to be fed once before it can act on anything.
      let c: ChildProcess;
      try {
        c = await ensureChild();
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : String(err) };
      }
      // Feed the child a book for every market it is about to be asked to close, including the
      // ones no mandate is armed on. Without this, a flatten with nothing armed reaches a child
      // whose book is empty, finds no position, and reports success having closed nothing.
      if (action.verb === 'close' || action.verb === 'flatten') {
        const wanted = action.verb === 'close' && action.coin !== undefined ? [action.coin] : (action.coins ?? []);
        await pumpOnce(wanted);
      }

      manualSeq += 1;
      const requestId = `mn_${manualSeq}`;
      return await new Promise((resolve) => {
        // A child that dies mid-action would otherwise leave the browser's button disabled
        // forever waiting on a reply that is never coming.
        const timer = setTimeout(() => {
          if (pending.delete(requestId)) {
            resolve({ ok: false, detail: 'the runner did not answer within 15s' });
          }
        }, 15_000);
        if (typeof timer.unref === 'function') timer.unref();
        pending.set(requestId, (r) => {
          clearTimeout(timer);
          resolve(r);
        });
        c.send({ cmd: 'manual', action: { ...action, requestId } });
      });
    },

    status: () => ({
      armed: [...armed.entries()].map(([id, v]) => ({
        id,
        symbol: v.mandate.symbol,
        since: v.since,
        // Shown on the armed row: how long this bot may keep signing, which is a different
        // number from the mandate's own expiry and the one a person locking the app wants.
        signingExpiresAt: v.signingExpiresAt,
      })),
      running: child !== null && child.connected,
    }),

    // The same set as status(), with the bounds and the program itself. The trading window
    // needs both: the envelope to draw how much of it has been spent, and the program to show
    // the human the sentences they approved.
    armedDetail: () =>
      [...armed.values()].map((v) => ({ mandate: v.mandate, program: v.program, since: v.since, signingExpiresAt: v.signingExpiresAt })),

    /* Sessions whose expiry has passed. Called on the pump, which runs only while something is
       armed, which is exactly when a session can exist. Disarming each one kills the child
       once the last mandate goes, and a dead process is the only reliable way to be rid of a
       key that lives in an immutable string. */
    sweepSigningSessions(): string[] {
      const done = deps.session?.expired() ?? [];
      for (const session of done) {
        // `.catch`, not `void`. disarm() sends over IPC and records an event, both of which can
        // throw, and this runs on a timer with nothing above it to catch a rejection.
        api.disarm(session.id, 'the signing session expired, so the trading key was taken back').catch((err: unknown) => {
          record({ type: 'error', id: session.id, message: `taking the trading key back failed: ${err instanceof Error ? err.message : String(err)}` });
        });
      }
      return done.map((s) => s.id);
    },

    // Whether the venue is answering the app's own reads, and how slowly. The trading window
    // shows this: a screen that is behind the market must say so rather than looking current.
    feedHealth: () => feed.health(),

    events: () => [...recent],
  };

  return api;
}
