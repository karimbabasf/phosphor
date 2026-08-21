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
import type { Program } from '../strategy/grammar.ts';
import { createFeed } from './feed.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type RunnerEvent =
  | { type: 'armed'; id: string; symbol: string }
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
  isMainnet: boolean;
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
  // It became load bearing on 2026-08-20, when the runner stopped refusing mainnet outright.
  // A guard removed and replaced with nothing is how a testnet convenience becomes a mainnet
  // hole, so this is what replaced it.
  limits?: { maxArmedMandates: number; maxAggregateNotionalUsd: number };
};

// Testnet money is free, so the ceiling there only has to stop a runaway loop. Mainnet starts
// deliberately small: this is a first run against real collateral, and the number a human is
// most likely to regret is the one they never had to type.
export const TESTNET_TRADING_LIMITS = { maxArmedMandates: 3, maxAggregateNotionalUsd: 2500 };
export const MAINNET_TRADING_LIMITS = { maxArmedMandates: 3, maxAggregateNotionalUsd: 250 };

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

export function createRunnerHost(deps: HostDeps): MandateRunner & {
  stopAll(reason: string): Promise<void>;
  setKilled(on: boolean): void;
  events(): RunnerEvent[];
  manual(action: ManualAction): Promise<{ ok: boolean; detail: string }>;
  feedHealth(): ReturnType<ReturnType<typeof createFeed>['health']>;
  armedDetail(): { mandate: Mandate; program: Program | null; since: string }[];
} {
  let child: ChildProcess | null = null;
  // The program is held beside the mandate, not because this process runs it (the child does),
  // but because the trading window renders it in English. Reading it back off the child would
  // mean the screen showing a copy of the program rather than the program, and "the thing on
  // screen is the thing running" is the property the whole approval step depends on.
  const armed = new Map<string, { mandate: Mandate; program: Program | null; since: string }>();
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
    pump = setInterval(() => void pumpOnce(), deps.pollMs ?? 2000);
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

  async function ensureChild(): Promise<ChildProcess> {
    if (child !== null && child.connected) return child;

    const key = await deps.apiWalletKey();
    if (key === null) throw new Error('no API wallet key: run scripts/hl-agent.ts to approve one');

    const entry = path.join(__dirname, 'main.ts');
    // The key goes over the fork's env rather than argv, because argv is visible in ps output
    // to every process on the machine and this key can place orders.
    child = fork(entry, [], {
      env: {
        ...process.env,
        PHOSPHOR_HL_KEY: key,
        PHOSPHOR_HL_MAINNET: deps.isMainnet ? '1' : '0',
        PHOSPHOR_HL_URL: deps.baseUrl,
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    child.on('message', (m) => {
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
    child.on('exit', (code) => {
      // Anything armed when the child dies is no longer armed, whatever the exit code. Leaving
      // a mandate listed as live after its executor is gone would misreport the safety state,
      // which this repo already decided is worse than the safety being off.
      for (const [id] of armed) record({ type: 'disarmed', id, reason: `runner exited (${code})` });
      armed.clear();
      stopPump();
      child = null;
    });
    child.stderr?.on('data', (b) => record({ type: 'error', id: null, message: String(b).trim() }));

    return child;
  }

  return {
    async arm(mandate, program) {
      if (deps.killSwitch()) return { ok: false, detail: 'kill switch is on; nothing can arm' };

      const refusal = tradingLimitRefusal(
        [...armed.values()].map((a) => ({ id: a.mandate.id, maxNotionalUsd: a.mandate.maxNotionalUsd })),
        { id: mandate.id, maxNotionalUsd: mandate.maxNotionalUsd },
        deps.limits ?? TESTNET_TRADING_LIMITS,
      );
      if (refusal !== null) return { ok: false, detail: refusal };

      try {
        const c = await ensureChild();
        c.send({ cmd: 'arm', mandate, program });
        armed.set(mandate.id, { mandate, program: program as Program | null, since: new Date().toISOString() });
        // One book pushed before the child can act, so its first tick reasons about the real
        // market rather than the zeros it starts with.
        await pumpOnce();
        startPump();
        record({ type: 'armed', id: mandate.id, symbol: mandate.symbol });
        return { ok: true, detail: `armed ${mandate.id} on ${mandate.symbol}` };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        record({ type: 'error', id: mandate.id, message });
        return { ok: false, detail: message };
      }
    },

    async disarm(id, reason) {
      // Disarm never fails and never waits on approval. If the child is already gone the
      // mandate is already not running, which is the state the caller asked for.
      armed.delete(id);
      if (child !== null && child.connected) child.send({ cmd: 'disarm', id, reason });
      record({ type: 'disarmed', id, reason });
      if (armed.size === 0) {
        stopPump();
        if (child !== null) child.send({ cmd: 'shutdown' });
      }
      return { ok: true, detail: `disarmed ${id}: ${reason}` };
    },

    async stopAll(reason) {
      for (const [id] of armed) record({ type: 'disarmed', id, reason });
      armed.clear();
      stopPump();
      if (child !== null) {
        // Ask first so it can flatten, then take the process out regardless. A kill switch that
        // depends on the thing it is killing being healthy is not a kill switch.
        child.send({ cmd: 'flatten_and_exit', reason });
        const doomed = child;
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
      armed: [...armed.entries()].map(([id, v]) => ({ id, symbol: v.mandate.symbol, since: v.since })),
      running: child !== null && child.connected,
    }),

    // The same set as status(), with the bounds and the program itself. The trading window
    // needs both: the envelope to draw how much of it has been spent, and the program to show
    // the human the sentences they approved.
    armedDetail: () => [...armed.values()].map((v) => ({ mandate: v.mandate, program: v.program, since: v.since })),

    // Whether the venue is answering the app's own reads, and how slowly. The trading window
    // shows this: a screen that is behind the market must say so rather than looking current.
    feedHealth: () => feed.health(),

    events: () => [...recent],
  };
}
