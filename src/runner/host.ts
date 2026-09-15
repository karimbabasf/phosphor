// The app side of the runner: the plan registry, the watcher, and the child it can always kill.
//
// The runner is a separate process rather than a function call or a worker thread, and the
// reason is scheduling before it is isolation. An order must not queue behind whatever the HTTP
// server and the chart's SSE broadcast are doing; a wedged request in the app should not delay
// a fire. A worker thread fixes that much but shares a process, so a hard kill is not clean and
// a crash takes the window down with it. A child process costs sub-millisecond IPC and buys its
// own event loop, its own socket, and a kill that is absolute.
//
// What lives HERE and what lives in the child is the whole design. The child signs and knows
// only the plans it holds. This process decides when: it folds the live feed into the bars the
// watcher reads, fires a plan once when its conditions hold, watches fills so a resting entry
// is never a naked position, and keeps the registry on disk. After a fire the venue holds the
// exits, so nothing in this process has to stay alive for a position to be protected.
//
// The key handed to the child is the API wallet, never the master. The venue permits it to trade
// and forbids it from withdrawing, transferring, or approving another agent, so a compromised
// runner loses trading control and not the money. The master key never enters this process tree.

import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SIGNING_SESSION_DEFAULT_MS } from '../keystore/session.ts';
import type { Session } from '../keystore/session.ts';
import { aggregate } from '../market/aggregate.ts';
import { cloidFor } from '../hl/exchange.ts';
import { planHash, TIMEFRAME_SEC, validatePlanInput } from '../trade/plan.ts';
import type { Plan, PlanInput, Timeframe } from '../trade/plan.ts';
import { bookkeepingOf } from '../trade/plans.ts';
import type { EndReason, PlanRow, PlanStore } from '../trade/plans.ts';
import { DEFAULT_TAKER_FEE_BPS, planRisk } from '../trade/risk.ts';
import { evaluate } from '../trade/watch.ts';
import type { Bar, MarketView } from '../trade/watch.ts';
import { isFromChild } from './protocol.ts';
import type { AssetMeta, Command, FromChild, ToChild } from './protocol.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// `venueMs` is the child's word on how long the venue took to answer the command behind the
// event, carried through so the audit line can say it. A done that never asked the venue (a
// waiting plan cancelled, an expiry) has none.
export type RunnerEvent =
  | { type: 'armed'; id: string; symbol: string; signingExpiresAt: string }
  | { type: 'fired'; id: string; symbol: string }
  | { type: 'placed'; id: string; symbol: string; filledSz: number; venueMs: number }
  | { type: 'protected'; id: string; symbol: string; sz: number; venueMs: number }
  | { type: 'changed'; id: string; detail: string; venueMs: number }
  | { type: 'done'; id: string; symbol: string; reason: EndReason; venueMs?: number }
  | { type: 'locked'; id: string }
  | { type: 'error'; id: string | null; message: string };

// What the host reads off the trade feed, pushed by the service on every update. Positions and
// resting orders decide placed -> open -> done; fills say why a plan ended.
export type AccountView = {
  atMs: number;
  freeUsd: number | null;
  positions: { coin: string; szi: number; entryPx: number }[];
  orders: { coin: string; cloid: string | null }[];
  fills: { coin: string; px: number; sizeCoin: number; atMs: number; closedPnlUsd: number | null }[];
};

export type HostDeps = {
  apiWalletKey: () => Promise<`0x${string}` | null>;
  /* THE SIGNING SESSION, and it is the one exception to the auto-lock.
     A waiting plan has to survive a lock, or a plan armed at 6pm is useless at 2am, which is when
     perps run. So arming opens a session scoped to that plan, holding ONLY the Hyperliquid API
     wallet key. Optional so a test can build a host without one. */
  session?: Session;
  baseUrl: string;
  // The trading account. A function is asked when a child is forked and on every read the host
  // makes itself, so a wallet created after boot is the account from then on.
  user: string | (() => string);
  onEvent: (e: RunnerEvent) => void;
  killSwitch: () => boolean;
  store: PlanStore;
  meta: (coin: string) => AssetMeta | null;
  mark: (coin: string) => number | null;
  free: () => number | null;
  // Closed bars for one timeframe, oldest first, from the market store. Read once per plan
  // timeframe at arm to seed the watcher; live minute frames roll the series forward.
  bars?: (coin: string, tf: Timeframe, count: number) => Promise<Bar[]>;
  // Keep the live rail subscribed to a coin. Called on arm and every minute while plans wait.
  follow?: (coin: string) => void;
  // The proposal store's word on a waiting plan found on disk at boot. Absent means the check
  // is skipped, which only a test should do.
  approval?: (proposalId: string) => { hash: string; status: string } | null;
  // Whether the runner's API wallet is still approved on the venue. Asked once per signing
  // session, before the first fire.
  agentApproved?: () => Promise<boolean>;
  // Test seam, the same shape as fetchImpl on the rails: the guards around a dead child cannot
  // be exercised against a real fork without a real key and a real venue.
  forkImpl?: typeof fork;
  now?: () => number;
  replyMs?: number;
};

export type PlanRunner = ReturnType<typeof createRunnerHost>;

// How many done rows the payload keeps, so the rail can say why a plan stopped.
const DONE_KEPT = 20;
// Minute bars held per coin. Two days covers the forming bucket of every timeframe up to a day.
const MINUTES_KEPT = 2880;
// Closed bars kept per timeframe, seed and folded together.
const BARS_KEPT = 60;
const SEED_BARS = 40;
const SWEEP_MS = 5_000;
const FOLLOW_MS = 60_000;
const DEFAULT_REPLY_MS = 15_000;
const KILL_AFTER_MS = 3_000;

function live(row: PlanRow): boolean {
  return row.status === 'waiting' || row.status === 'placed' || row.status === 'open';
}

function nowIso(ms: number): string {
  return new Date(ms).toISOString();
}

export function createRunnerHost(deps: HostDeps) {
  const now = deps.now ?? (() => Date.now());
  const replyMs = deps.replyMs ?? DEFAULT_REPLY_MS;
  const user = (): string => (typeof deps.user === 'function' ? deps.user() : deps.user);

  let child: ChildProcess | null = null;
  /* THE FORK IN FLIGHT, and there is exactly one of it.
     ensureChild checked `child === null` and then AWAITED the API wallet key before forking,
     and nothing guarded that gap. Rails run outside the proposal serialiser (the reservation is
     released as soon as the row is written), so two arms could sit inside one key read
     together. The second fork overwrote this binding; the first process stayed alive, had
     already been sent its arm message through its own returned handle, and held the same
     Hyperliquid API key. stopAll, setKilled, the kill switch and the SIGKILL backstop all
     address `child`, so the orphan kept placing orders with nothing able to stop it short of a
     reboot. One promise, shared by every concurrent caller, is the whole fix. */
  let starting: Promise<ChildProcess> | null = null;
  /* Bumped by stopAll. A fork whose key read finishes after everything was stopped belongs to
     a generation nobody wants, so it never happens: a kill switch that leaves a process behind
     because the process had not started yet is not a kill switch. */
  let generation = 0;
  let killed = false;

  const rows = new Map<string, PlanRow>();
  for (const row of deps.store.list()) rows.set(row.id, row);
  const recent: RunnerEvent[] = [];

  // Replies from the child, keyed by the sequence the command carried.
  let seq = 0;
  const pending = new Map<number, { settle: (e: FromChild) => void; timer: NodeJS.Timeout }>();

  // The market, folded. Minute bars per coin, closed seed bars per coin and timeframe, and
  // when each coin last spoke.
  const minutes = new Map<string, Map<number, Bar>>();
  const seeds = new Map<string, Bar[]>();
  const lastFrameAt = new Map<string, number>();
  let lineAt: MarketView['lineAt'];
  let account: AccountView | null = null;
  // When the account feed last spoke. It carries the mark for every watched coin, so it counts
  // as freshness for a coin that has no minute frame of its own yet.
  let accountAt = 0;
  let accountWaiters: Array<() => void> = [];

  const firing = new Set<string>();
  const protecting = new Set<string>();
  // Which plans the child holds right now. Only these can fire, and a command for any other
  // live row re-arms it first: a child that died took its plans with it.
  const armedInChild = new Set<string>();
  // Whether the API wallet is still approved on the venue, asked once per child.
  let agentOk: boolean | null = null;

  let sweepTimer: NodeJS.Timeout | null = null;
  let followTimer: NodeJS.Timeout | null = null;

  function record(e: RunnerEvent): void {
    recent.push(e);
    if (recent.length > 200) recent.shift();
    deps.onEvent(e);
  }

  function persist(row: PlanRow): void {
    row.updatedAt = nowIso(now());
    rows.set(row.id, row);
    deps.store.put(row);
  }

  function finish(row: PlanRow, reason: EndReason, venueMs?: number): void {
    row.status = 'done';
    row.endReason = reason;
    delete row.blind;
    delete row.locked;
    delete row.holds;
    persist(row);
    armedInChild.delete(row.id);
    record({ type: 'done', id: row.id, symbol: row.symbol, reason, ...(venueMs !== undefined ? { venueMs } : {}) });
    deps.session?.disarm(row.id);
    if (child !== null && child.connected) {
      // Not awaited: a finished plan's leftover exit is the venue's own cancel most of the time,
      // and "already canceled" is success in the child.
      void request({ cmd: 'release', id: row.id }).catch(() => undefined);
    }
    maybeStopChild();
  }

  function liveRows(): PlanRow[] {
    return [...rows.values()].filter(live);
  }

  function childNeeded(): boolean {
    return liveRows().some((r) => (r.status === 'waiting' && r.locked !== true) || r.status === 'placed');
  }

  // ---------- the child ----------

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
    if (key === null) throw new Error('no API wallet key: unlock the wallet, or run scripts/hl-agent.ts to approve one');

    const entry = path.join(__dirname, 'main.ts');
    /* THE KEY GOES OVER STDIN, and stdin is closed behind it.
       It went over the environment before, which was chosen over argv on purpose (argv is
       world-readable in `ps`) and was still not private: `ps eww <pid>` prints the environment
       of any process this user owns, which is the attacker this app is built against. A pipe
       has two ends and no third reader. */
    const spawned = (deps.forkImpl ?? fork)(entry, [], {
      env: { ...process.env, PHOSPHOR_HL_URL: deps.baseUrl, PHOSPHOR_HL_USER: user() },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });
    child = spawned;
    agentOk = null;
    /* A child that dies before it reads raises EPIPE on this stream, and `child.on('error')`
       below does not cover a stream of the child rather than the child itself: with no listener
       here it reached the process-wide crash handler and ended the app instead of the plan. */
    spawned.stdin?.on('error', (err: Error) => {
      record({ type: 'error', id: null, message: `runner child never read its key: ${err.message}` });
    });
    spawned.stdin?.write(`${key}\n`);
    spawned.stdin?.end();

    spawned.on('message', (m) => {
      if (!isFromChild(m)) return;
      const waiting = pending.get(m.seq);
      if (waiting !== undefined) {
        pending.delete(m.seq);
        clearTimeout(waiting.timer);
        waiting.settle(m);
        return;
      }
      if (m.ev === 'error') record({ type: 'error', id: m.id, message: m.message });
    });
    spawned.on('exit', (code) => {
      // Nothing waiting for a reply gets one now. The venue may or may not have acted; the
      // caller is told so rather than left on a promise that never settles.
      for (const [s, waiting] of pending) {
        pending.delete(s);
        clearTimeout(waiting.timer);
        waiting.settle({ ev: 'error', seq: s, id: null, message: `the runner exited (${String(code)}) before it answered` });
      }
      firing.clear();
      protecting.clear();
      armedInChild.clear();
      if (child === spawned) child = null;
    });
    spawned.stderr?.on('data', (b) => record({ type: 'error', id: null, message: String(b).trim() }));
    /* A fork that cannot start, and a send on an IPC channel that has closed, both raise 'error'
       on the child rather than throwing at the call site. With no listener Node re-raises it as
       an uncaught exception from nextTick, which ends the app rather than the plan. */
    spawned.on('error', (err) => {
      if (child === spawned) child = null;
      record({ type: 'error', id: null, message: `runner child failed: ${err.message}` });
    });
    return spawned;
  }

  function request(cmd: Command): Promise<FromChild> {
    seq += 1;
    const mine = seq;
    return new Promise<FromChild>((resolve) => {
      if (child === null || !child.connected) {
        resolve({ ev: 'error', seq: mine, id: 'id' in cmd ? (cmd as { id: string }).id : null, message: 'the runner is not running' });
        return;
      }
      const timer = setTimeout(() => {
        if (pending.delete(mine)) {
          resolve({ ev: 'error', seq: mine, id: 'id' in cmd ? (cmd as { id: string }).id : null, message: `the runner did not answer within ${Math.round(replyMs / 1000)}s` });
        }
      }, replyMs);
      timer.unref?.();
      pending.set(mine, { settle: resolve, timer });
      try {
        child.send({ ...cmd, seq: mine } as ToChild);
      } catch (err) {
        pending.delete(mine);
        clearTimeout(timer);
        resolve({ ev: 'error', seq: mine, id: null, message: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  function killChild(doomed: ChildProcess, reason: string): void {
    // Ask first so it can let go cleanly, then take the process out regardless. A kill that
    // depends on the thing it is killing being healthy is not a kill.
    if (doomed.connected) {
      try {
        doomed.send({ cmd: 'kill', seq: 0, reason } as unknown as ToChild);
      } catch {
        // Already gone.
      }
    }
    setTimeout(() => {
      if (doomed.connected || doomed.exitCode === null) doomed.kill('SIGKILL');
    }, KILL_AFTER_MS).unref();
  }

  function maybeStopChild(): void {
    if (childNeeded()) return;
    if (child === null) return;
    const doomed = child;
    child = null;
    killChild(doomed, 'nothing left to run');
    stopTimers();
  }

  // ---------- the market ----------

  function minutesOf(coin: string): Map<number, Bar> {
    let m = minutes.get(coin);
    if (m === undefined) {
      m = new Map();
      minutes.set(coin, m);
    }
    return m;
  }

  function closedBars(coin: string, tf: Timeframe): Bar[] {
    const tfSec = TIMEFRAME_SEC[tf];
    const seed = seeds.get(`${coin}:${tf}`) ?? [];
    const lastSeed = seed[seed.length - 1];
    const from = lastSeed === undefined ? 0 : lastSeed.t + tfSec;
    const held = [...minutesOf(coin).values()].filter((b) => b.t >= from).sort((a, b) => a.t - b.t);
    const newest = held[held.length - 1];
    if (newest === undefined) return seed.slice(-BARS_KEPT);
    // A bucket is closed once a minute bar from a later bucket has been seen.
    const folded = aggregate(held, 60, tfSec).filter((b) => b.t + tfSec <= newest.t);
    return [...seed, ...folded].slice(-BARS_KEPT);
  }

  function marketView(plan: Plan): MarketView {
    const at = now();
    const seen = Math.max(lastFrameAt.get(plan.symbol) ?? 0, accountAt);
    const bars: MarketView['bars'] = {};
    for (const c of plan.when ?? []) {
      if (c.type === 'time') continue;
      if (bars[c.tf] === undefined) bars[c.tf] = closedBars(plan.symbol, c.tf);
    }
    const held = [...minutesOf(plan.symbol).values()].sort((a, b) => a.t - b.t);
    const newest = held[held.length - 1];
    return {
      nowMs: at,
      mark: deps.mark(plan.symbol) ?? (newest === undefined ? null : newest.c),
      freshMs: seen === 0 ? Number.POSITIVE_INFINITY : at - seen,
      bars,
      lineAt,
    };
  }

  function seed(plan: Plan): void {
    if (deps.bars === undefined) return;
    const tfs = new Set<Timeframe>();
    for (const c of plan.when ?? []) if (c.type !== 'time') tfs.add(c.tf);
    for (const tf of tfs) {
      const key = `${plan.symbol}:${tf}`;
      if (seeds.has(key)) continue;
      deps
        .bars(plan.symbol, tf, SEED_BARS)
        .then((bars) => {
          const tfSec = TIMEFRAME_SEC[tf];
          const nowSec = Math.floor(now() / 1000);
          // The newest bar is forming unless a whole timeframe has passed since it opened.
          seeds.set(key, bars.filter((b) => b.t + tfSec <= nowSec).slice(-BARS_KEPT));
          tick(plan.symbol);
        })
        .catch((err: unknown) => {
          record({ type: 'error', id: plan.id, message: `could not read ${tf} bars for ${plan.symbol}: ${err instanceof Error ? err.message : String(err)}` });
        });
    }
  }

  // ---------- firing ----------

  function tick(coin: string): void {
    for (const row of liveRows()) {
      if (row.status !== 'waiting' || row.symbol !== coin || row.locked === true || firing.has(row.id)) continue;
      if (killed || !armedInChild.has(row.id)) continue;
      const view = marketView(row);
      const out = evaluate(row, view);
      row.holds = out.per;
      const wasBlind = row.blind === true;
      row.blind = out.blind;
      if (wasBlind !== out.blind) persist(row);
      if (!out.holds || view.mark === null) continue;
      if (now() >= Date.parse(row.expiresAt ?? '')) continue;
      void fire(row, view.mark);
    }
  }

  async function fire(row: PlanRow, mark: number): Promise<void> {
    firing.add(row.id);
    try {
      if (deps.agentApproved !== undefined && agentOk === null) {
        agentOk = await deps.agentApproved();
      }
      if (agentOk === false) {
        finish(row, 'failed:the API wallet is no longer approved on the venue');
        return;
      }
      record({ type: 'fired', id: row.id, symbol: row.symbol });
      const reply = await request({ cmd: 'fire', id: row.id, mark });
      if (reply.ev === 'placed') {
        row.cloids = reply.cloids;
        row.gen = reply.gen;
        if (reply.avgPx !== null && Number.isFinite(reply.avgPx)) row.fillPx = reply.avgPx;
        row.exitSz = reply.filledSz > 0 ? reply.filledSz : 0;
        row.status = reply.filledSz > 0 ? 'open' : 'placed';
        delete row.holds;
        delete row.blind;
        persist(row);
        record({ type: 'placed', id: row.id, symbol: row.symbol, filledSz: reply.filledSz, venueMs: reply.venueMs });
        return;
      }
      if (reply.ev === 'refused') {
        finish(row, `failed:${reply.reason}`);
        return;
      }
      if (reply.ev === 'error' && /did not answer|exited/.test(reply.message)) {
        // Ambiguous: the venue may hold the entry. Treated as placed under the id the child
        // would have used, so the venue's own answer (a fill, a resting order, or nothing) is
        // what settles it rather than a second fire.
        row.gen += 1;
        row.cloids = { ...row.cloids, entry: cloidFor({ plan: row.id, leg: 'entry', gen: row.gen }) };
        row.status = 'placed';
        persist(row);
        record({ type: 'error', id: row.id, message: `${reply.message}; ${row.id} is treated as placed until the venue says otherwise` });
        return;
      }
      finish(row, `failed:${reply.ev === 'error' ? reply.message : 'the runner answered with something else'}`);
    } catch (err) {
      finish(row, `failed:${err instanceof Error ? err.message : String(err)}`);
    } finally {
      firing.delete(row.id);
    }
  }

  // ---------- the account ----------

  function positionOn(coin: string): { szi: number; entryPx: number } | null {
    if (account === null) return null;
    return account.positions.find((p) => p.coin === coin && p.szi !== 0) ?? null;
  }

  function endReasonFor(row: PlanRow): EndReason {
    if (account === null) return 'closed';
    const since = Date.parse(row.updatedAt);
    const reducing = account.fills
      .filter((f) => f.coin === row.symbol && f.closedPnlUsd !== null && f.atMs >= since - 1000)
      .sort((a, b) => b.atMs - a.atMs)[0];
    if (reducing === undefined) return 'closed';
    const toStop = Math.abs(reducing.px - row.stop);
    const toTarget = row.target === undefined ? Number.POSITIVE_INFINITY : Math.abs(reducing.px - row.target);
    return toStop <= toTarget ? 'stopped' : 'targeted';
  }

  async function protect(row: PlanRow): Promise<void> {
    if (protecting.has(row.id)) return;
    protecting.add(row.id);
    try {
      const armed = await ensureArmed(row);
      if (!armed.ok) {
        record({ type: 'error', id: row.id, message: `${row.symbol} has a position and the runner could not take ${row.id} to protect it: ${armed.reason}` });
        return;
      }
      const reply = await request({ cmd: 'protect', id: row.id });
      if (reply.ev === 'protected') {
        row.cloids = reply.cloids;
        row.gen = reply.gen;
        row.exitSz = reply.sz;
        if (row.status === 'placed') {
          row.status = 'open';
          const pos = positionOn(row.symbol);
          if (pos !== null && row.fillPx === undefined) row.fillPx = pos.entryPx;
        }
        persist(row);
        record({ type: 'protected', id: row.id, symbol: row.symbol, sz: reply.sz, venueMs: reply.venueMs });
        return;
      }
      record({ type: 'error', id: row.id, message: reply.ev === 'error' ? reply.message : reply.ev === 'refused' ? reply.reason : `unexpected ${reply.ev}` });
    } finally {
      protecting.delete(row.id);
    }
  }

  function onAccount(view: AccountView): void {
    account = view;
    accountAt = Math.max(accountAt, view.atMs);
    const waiters = accountWaiters;
    accountWaiters = [];
    for (const w of waiters) w();
    for (const row of liveRows()) {
      const pos = positionOn(row.symbol);
      if (row.status === 'placed') {
        // The first fill of a resting entry: the exits go on now, sized to the position, before
        // anything else happens. A resting entry is never a naked position.
        if (pos !== null && !firing.has(row.id)) void protect(row);
        continue;
      }
      if (row.status === 'open') {
        if (pos === null) {
          finish(row, endReasonFor(row));
          continue;
        }
        // The position grew past the exits (a partial entry kept filling): resize them.
        if (row.exitSz !== undefined && row.exitSz > 0 && Math.abs(pos.szi) > row.exitSz + 1e-12 && !firing.has(row.id)) {
          void protect(row);
        }
      }
    }
    for (const coin of new Set(liveRows().map((r) => r.symbol))) tick(coin);
  }

  function onMarket(coin: string, frame: Bar): void {
    const held = minutesOf(coin);
    held.set(frame.t, { t: frame.t, o: frame.o, h: frame.h, l: frame.l, c: frame.c, v: frame.v });
    if (held.size > MINUTES_KEPT) {
      const oldest = [...held.keys()].sort((a, b) => a - b).slice(0, held.size - MINUTES_KEPT);
      for (const t of oldest) held.delete(t);
    }
    lastFrameAt.set(coin, now());
    tick(coin);
  }

  // ---------- timers ----------

  function sweep(): void {
    const at = now();
    // An idea past its own expiry is not a plan anyone can arm (propose_trade refuses it by the
    // same clock), so it leaves the chart rather than sitting there as a stale suggestion.
    for (const row of rows.values()) {
      if (row.status !== 'idea') continue;
      const expiry = Date.parse(row.expiresAt ?? '');
      if (Number.isFinite(expiry) && at >= expiry) {
        rows.delete(row.id);
        deps.store.remove(row.id);
      }
    }
    for (const row of liveRows()) {
      const expiry = Date.parse(row.expiresAt ?? '');
      if (!Number.isFinite(expiry) || at < expiry) continue;
      if (row.status === 'waiting') {
        finish(row, 'expired');
        if (child !== null && child.connected) void request({ cmd: 'disarm', id: row.id }).catch(() => undefined);
      } else if (row.status === 'placed' && !firing.has(row.id) && !protecting.has(row.id)) {
        // A resting entry past its expiry comes off the book. Anything that filled first is a
        // position, and the child protects it before it answers.
        protecting.add(row.id);
        void request({ cmd: 'cancel', id: row.id })
          .then((reply) => {
            protecting.delete(row.id);
            if (reply.ev === 'cancelled' && reply.filledSz > 0) {
              row.status = 'open';
              row.exitSz = reply.filledSz;
              row.cloids = reply.cloids;
              row.gen = reply.gen;
              persist(row);
              return;
            }
            if (reply.ev === 'cancelled') {
              finish(row, 'expired', reply.venueMs);
              return;
            }
            record({ type: 'error', id: row.id, message: reply.ev === 'error' ? reply.message : reply.ev === 'refused' ? reply.reason : `unexpected ${reply.ev}` });
          })
          .catch(() => protecting.delete(row.id));
      }
    }
    for (const coin of new Set(liveRows().map((r) => r.symbol))) tick(coin);
    if (liveRows().length === 0) stopTimers();
  }

  function startTimers(): void {
    if (sweepTimer === null) {
      sweepTimer = setInterval(() => {
        try {
          api.sweepSigningSessions();
          sweep();
        } catch (err) {
          record({ type: 'error', id: null, message: `runner sweep: ${err instanceof Error ? err.message : String(err)}` });
        }
      }, SWEEP_MS);
      sweepTimer.unref();
    }
    if (followTimer === null && deps.follow !== undefined) {
      followTimer = setInterval(() => {
        for (const coin of new Set(liveRows().map((r) => r.symbol))) deps.follow?.(coin);
      }, FOLLOW_MS);
      followTimer.unref();
    }
  }

  function stopTimers(): void {
    if (sweepTimer !== null) clearInterval(sweepTimer);
    if (followTimer !== null) clearInterval(followTimer);
    sweepTimer = null;
    followTimer = null;
  }

  // ---------- arming ----------

  function metaFor(coin: string): AssetMeta | null {
    return deps.meta(coin);
  }

  async function armRow(row: PlanRow): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (deps.killSwitch()) return { ok: false, reason: 'kill switch is on; nothing can arm' };
    const meta = metaFor(row.symbol);
    if (meta === null) return { ok: false, reason: `no venue metadata for ${row.symbol} yet: the trading account has not answered` };
    try {
      await ensureChild();
      const reply = await request({ cmd: 'arm', plan: planOf(row), cloids: row.cloids, gen: row.gen, meta });
      if (reply.ev !== 'armed') {
        return { ok: false, reason: reply.ev === 'error' ? reply.message : reply.ev === 'refused' ? reply.reason : `unexpected ${reply.ev}` };
      }
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
    /* The signing session's length is the plan's own expiry, clamped: a day at most, whatever
       the plan says. The human already chose how long this plan should live when they wrote it. */
    const wanted = Date.parse(row.expiresAt ?? '') - now();
    const signing = deps.session?.arm(row.id, Number.isFinite(wanted) && wanted > 0 ? wanted : SIGNING_SESSION_DEFAULT_MS);
    const signingExpiresAt = nowIso(signing?.expiresAt ?? now() + SIGNING_SESSION_DEFAULT_MS);
    if (row.status === 'waiting') delete row.locked;
    armedInChild.add(row.id);
    persist(row);
    record({ type: 'armed', id: row.id, symbol: row.symbol, signingExpiresAt });
    seed(row);
    deps.follow?.(row.symbol);
    startTimers();
    tick(row.symbol);
    return { ok: true };
  }

  function planOf(row: PlanRow): Plan {
    return {
      id: row.id,
      symbol: row.symbol,
      side: row.side,
      sizeUsd: row.sizeUsd,
      leverage: row.leverage,
      entry: row.entry,
      stop: row.stop,
      ...(row.target !== undefined ? { target: row.target } : {}),
      ...(row.when !== undefined ? { when: row.when } : {}),
      expiresAt: row.expiresAt,
      ...(row.note !== undefined ? { note: row.note } : {}),
    };
  }

  function liveInputs(row: PlanRow) {
    const meta = metaFor(row.symbol);
    const same = liveRows().find((r) => r.id !== row.id && r.symbol === row.symbol && r.status !== 'waiting');
    return {
      mark: deps.mark(row.symbol) ?? Number.NaN,
      szDecimals: meta?.szDecimals ?? 0,
      maxLeverage: meta?.maxLeverage ?? 0,
      freeCollateralUsd: deps.free(),
      takerFeeBps: DEFAULT_TAKER_FEE_BPS,
      sameCoinLeverage: same === undefined ? null : same.leverage,
      ...(row.fillPx !== undefined ? { entryPx: row.fillPx } : {}),
    };
  }

  // A placed or open row the child does not hold (it died, or the app restarted) is re-armed
  // before any command about it goes through, so the command lands on a child that knows it.
  async function ensureArmed(row: PlanRow): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (armedInChild.has(row.id) && child !== null && child.connected) return { ok: true };
    return armRow(row);
  }

  function nextId(): string {
    const at = now();
    let n = 0;
    let id = `pl_${at.toString(36)}`;
    while (rows.has(id)) {
      n += 1;
      id = `pl_${at.toString(36)}${n.toString(36)}`;
    }
    return id;
  }

  const api = {
    // ---------- ideas: drawn, no authority ----------

    draw(input: PlanInput, by: string | null): PlanRow {
      const at = nowIso(now());
      const plan: Plan = { id: nextId(), ...input };
      const row: PlanRow = { ...plan, status: 'idea', hash: planHash(plan), cloids: {}, gen: 0, by, createdAt: at, updatedAt: at };
      persist(row);
      return row;
    },

    redraw(id: string, changes: Record<string, unknown>): { ok: true; row: PlanRow } | { ok: false; reason: string } {
      const row = rows.get(id);
      if (row === undefined) return { ok: false, reason: `no plan ${id}` };
      if (row.status !== 'idea') return { ok: false, reason: `${id} is ${row.status}: an armed plan changes through propose_trade_change` };
      const merged: Record<string, unknown> = { ...planOf(row) };
      delete merged.id;
      for (const [k, v] of Object.entries(changes)) {
        if (v === null) delete merged[k];
        else merged[k] = v;
      }
      const parsed = validatePlanInput(merged, now());
      if (!parsed.ok) return { ok: false, reason: parsed.errors.join('; ') };
      const plan: Plan = { id, ...parsed.plan };
      const next: PlanRow = { ...bookkeepingOf(row), ...plan, hash: planHash(plan) };
      persist(next);
      return { ok: true, row: next };
    },

    erase(id: string): { ok: boolean; reason: string } {
      const row = rows.get(id);
      if (row === undefined) return { ok: false, reason: `no plan ${id}` };
      if (row.status !== 'idea') return { ok: false, reason: `${id} is ${row.status} and stays on the record` };
      rows.delete(id);
      deps.store.remove(id);
      return { ok: true, reason: `removed ${id}` };
    },

    get: (id: string): PlanRow | null => rows.get(id) ?? null,

    // Ideas, waiting, placed, open, and the last twenty done, newest done last.
    plans(): PlanRow[] {
      const all = [...rows.values()];
      const done = all.filter((r) => r.status === 'done').sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).slice(-DONE_KEPT);
      return [...all.filter((r) => r.status !== 'done'), ...done];
    },

    // ---------- authority: arrives through the rail after the policy ----------

    async arm(row: PlanRow): Promise<{ ok: true } | { ok: false; reason: string }> {
      const known = rows.get(row.id);
      /* Two cards can be filed for one drawn plan while it is an idea, and a person can click
         both. The first arm made it live; a second would reset the row to waiting on top of a
         placed entry or an open position, fire again, and on the child's refusal finish the
         plan and release the exits that protect it. A live plan is armed once. */
      if (known !== undefined && live(known)) return { ok: false, reason: `${row.id} is already ${known.status}` };
      // The idea row keeps its bookkeeping and loses its plan: what the human clicked is what
      // runs, and an idea the agent kept editing while the card waited is not that.
      const next: PlanRow = { ...(known === undefined ? {} : bookkeepingOf(known)), ...row, status: 'waiting' };
      delete next.endReason;
      const out = await armRow(next);
      if (!out.ok) {
        // The plan was approved and the runner could not take it: a row that says so beats a
        // proposal that says executed and a plan that is nowhere.
        next.status = 'done';
        next.endReason = `failed:${out.reason}`;
        persist(next);
        record({ type: 'done', id: next.id, symbol: next.symbol, reason: next.endReason });
      }
      return out;
    },

    async change(id: string, c: { stop?: number; target?: number }): Promise<{ ok: boolean; detail: string }> {
      const row = rows.get(id);
      if (row === undefined || !live(row)) return { ok: false, detail: `no live plan ${id}` };
      if (row.status === 'waiting' && row.locked === true) return { ok: false, detail: `${id} is locked until the next unlock` };
      const mark = deps.mark(row.symbol);
      if (mark === null) return { ok: false, detail: `no mark price for ${row.symbol}` };
      const armed = await ensureArmed(row);
      if (!armed.ok) return { ok: false, detail: armed.reason };
      const reply = await request({ cmd: 'modify', id, stop: c.stop, target: c.target, cloids: row.cloids, gen: row.gen, mark });
      if (reply.ev !== 'modified') {
        return { ok: false, detail: reply.ev === 'error' ? reply.message : reply.ev === 'refused' ? reply.reason : `unexpected ${reply.ev}` };
      }
      row.stop = reply.stop;
      if (reply.target === null) delete row.target;
      else row.target = reply.target;
      row.cloids = reply.cloids;
      row.gen = reply.gen;
      row.hash = planHash(planOf(row));
      const risk = planRisk(planOf(row), liveInputs(row));
      if (risk.ok) row.risk = risk.risk;
      persist(row);
      const detail = `${id}: stop ${String(row.stop)}${row.target === undefined ? ', no target' : `, target ${String(row.target)}`}`;
      record({ type: 'changed', id, detail, venueMs: reply.venueMs });
      return { ok: true, detail };
    },

    async cancel(id: string): Promise<{ ok: boolean; detail: string }> {
      const row = rows.get(id);
      if (row === undefined || !live(row)) return { ok: false, detail: `no live plan ${id}` };
      if (row.status === 'open') return { ok: false, detail: `${id} is open: its exits are its protection. Close it, or change the stop` };
      if (row.status === 'waiting') {
        if (child !== null && child.connected) void request({ cmd: 'disarm', id }).catch(() => undefined);
        finish(row, 'cancelled');
        return { ok: true, detail: `${id} cancelled before it fired` };
      }
      const armed = await ensureArmed(row);
      if (!armed.ok) return { ok: false, detail: armed.reason };
      const reply = await request({ cmd: 'cancel', id });
      if (reply.ev !== 'cancelled') {
        return { ok: false, detail: reply.ev === 'error' ? reply.message : reply.ev === 'refused' ? reply.reason : `unexpected ${reply.ev}` };
      }
      if (reply.filledSz > 0) {
        row.status = 'open';
        row.exitSz = reply.filledSz;
        row.cloids = reply.cloids;
        row.gen = reply.gen;
        persist(row);
        return { ok: true, detail: `${id}: the entry is cancelled, and ${String(reply.filledSz)} had already filled, so the plan is open and protected` };
      }
      finish(row, 'cancelled', reply.venueMs);
      return { ok: true, detail: `${id} cancelled` };
    },

    async close(id: string, maxSlippageBps: number): Promise<{ ok: boolean; detail: string }> {
      const row = rows.get(id);
      if (row === undefined || !live(row)) return { ok: false, detail: `no live plan ${id}` };
      if (row.status !== 'open') return { ok: false, detail: `${id} is ${row.status}, so there is nothing to close; cancel it instead` };
      const mark = deps.mark(row.symbol);
      if (mark === null) return { ok: false, detail: `no mark price for ${row.symbol}` };
      const armed = await ensureArmed(row);
      if (!armed.ok) return { ok: false, detail: armed.reason };
      const reply = await request({ cmd: 'close', id, maxSlippageBps, mark });
      if (reply.ev !== 'closed') {
        return { ok: false, detail: reply.ev === 'error' ? reply.message : reply.ev === 'refused' ? reply.reason : `unexpected ${reply.ev}` };
      }
      finish(row, 'closed', reply.venueMs);
      return { ok: true, detail: `${id} closed` };
    },

    // The big red one: every position closed at a hundred basis points, every resting entry and
    // exit cancelled, every plan finished. Consults no kill switch: it only reduces.
    async flatten(): Promise<{ ok: boolean; detail: string }> {
      const coins = new Map<string, { coin: string; meta: AssetMeta; mark: number }>();
      const consider = (coin: string): void => {
        if (coins.has(coin)) return;
        const meta = metaFor(coin);
        const mark = deps.mark(coin);
        if (meta !== null && mark !== null) coins.set(coin, { coin, meta, mark });
      };
      for (const row of liveRows()) consider(row.symbol);
      for (const p of account?.positions ?? []) if (p.szi !== 0) consider(p.coin);
      const cancels: { assetId: number; cloid: string }[] = [];
      for (const row of liveRows()) {
        const meta = metaFor(row.symbol);
        if (meta === null) continue;
        for (const cloid of Object.values(row.cloids)) if (typeof cloid === 'string') cancels.push({ assetId: meta.assetId, cloid });
      }
      try {
        await ensureChild();
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : String(err) };
      }
      const reply = await request({ cmd: 'flatten', coins: [...coins.values()], cancels });
      if (reply.ev !== 'flat') {
        return { ok: false, detail: reply.ev === 'error' ? reply.message : `unexpected ${reply.ev}` };
      }
      for (const row of liveRows()) {
        if (row.status === 'open') finish(row, reply.stillOpen.includes(row.symbol) ? 'failed:the venue did not close it' : 'closed');
        else finish(row, 'cancelled');
      }
      if (reply.stillOpen.length > 0) {
        return {
          ok: false,
          detail: `${reply.stillOpen.join(', ')} did NOT close and ${reply.stillOpen.length === 1 ? 'is' : 'are'} STILL OPEN. Close by hand. ${reply.detail}`,
        };
      }
      return { ok: true, detail: reply.detail === '' ? 'nothing open, every plan finished' : reply.detail };
    },

    status(): { plans: PlanRow[]; child: 'off' | 'on'; watching: string[] } {
      return {
        plans: api.plans(),
        child: child !== null && child.connected ? 'on' : 'off',
        watching: [...new Set(liveRows().map((r) => r.symbol))],
      };
    },

    onMarket,
    onAccount,
    onLines(fn: (id: string, t: number) => number | null): void {
      lineAt = fn;
    },

    // ---------- boot ----------

    /* Everything on disk, checked against what the venue and the proposal store say now. A
       waiting plan re-arms only if its proposal executed with the same hash and it still passes
       the propose refusals; placed and open rows are read against the venue's orders and
       positions by cloid. Waits for the first account snapshot, bounded, so it is not deciding
       against an empty feed. */
    async reconcile(waitMs = 20_000): Promise<void> {
      if (account === null) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, waitMs);
          timer.unref?.();
          accountWaiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      // Every waiting row is judged before any is armed, because arming one ticks the coin
      // and a row not yet judged must not fire on it.
      const rearm: PlanRow[] = [];
      for (const row of liveRows()) {
        if (row.status !== 'waiting') continue;
        if (deps.approval !== undefined) {
          // Hashed again from the row's own fields rather than read off the row: a file edited
          // by hand keeps whatever hash it was given, and the question is what the plan says.
          const approval = row.proposalId === undefined ? null : deps.approval(row.proposalId);
          if (approval === null || approval.status !== 'executed' || approval.hash !== planHash(planOf(row))) {
            finish(row, 'failed:plan on disk does not match its approval');
            continue;
          }
        }
        const risk = planRisk(planOf(row), liveInputs(row));
        if (!risk.ok) {
          finish(row, `failed:${risk.refusal}`);
          continue;
        }
        row.risk = risk.risk;
        rearm.push(row);
      }
      for (const row of rearm) {
        const out = await armRow(row);
        if (!out.ok) {
          row.locked = true;
          persist(row);
          record({ type: 'locked', id: row.id });
        }
      }
      for (const row of liveRows()) {
        if (row.status === 'waiting') continue;
        if (account === null) continue;
        const pos = positionOn(row.symbol);
        const resting = new Set(account.orders.map((o) => o.cloid).filter((c): c is string => c !== null));
        if (row.status === 'placed') {
          if (row.cloids.entry !== undefined && resting.has(row.cloids.entry)) {
            const out = await armRow(row);
            if (!out.ok) record({ type: 'error', id: row.id, message: `could not re-take ${row.id}: ${out.reason}` });
            if (pos !== null) void protect(row);
            continue;
          }
          if (pos !== null) {
            const out = await armRow(row);
            if (out.ok) void protect(row);
            continue;
          }
          finish(row, now() >= Date.parse(row.expiresAt ?? '') ? 'expired' : 'cancelled');
          continue;
        }
        if (row.status === 'open') {
          if (pos === null) {
            finish(row, endReasonFor(row));
            continue;
          }
          const stopResting = row.cloids.stop !== undefined && resting.has(row.cloids.stop);
          if (!stopResting) {
            // The position is there and its stop is not. Re-take the plan and protect it.
            const out = await armRow(row);
            if (out.ok) {
              row.exitSz = 0;
              void protect(row);
            } else {
              record({ type: 'error', id: row.id, message: `${row.symbol} is open with no stop resting and the runner could not start: ${out.reason}` });
            }
          }
        }
      }
      maybeStopChild();
    },

    setKilled(on: boolean): void {
      killed = on;
    },

    /* The kill switch. Every resting order cancelled, every position closed, every plan
       finished, the child taken out whether or not it answered. */
    async stopAll(reason: string): Promise<void> {
      killed = true;
      generation += 1;
      starting = null;
      const doomed = child;
      if (doomed !== null && doomed.connected && liveRows().length > 0) {
        const out = await api.flatten();
        if (!out.ok) record({ type: 'error', id: null, message: `${reason}: ${out.detail}` });
      }
      for (const row of liveRows()) finish(row, `failed:${reason}`);
      for (const session of deps.session?.armed() ?? []) deps.session?.disarm(session.id);
      stopTimers();
      if (child !== null) {
        const c = child;
        child = null;
        killChild(c, reason);
      } else if (doomed !== null) {
        killChild(doomed, reason);
      }
      killed = deps.killSwitch();
    },

    /* The app is going down. Rows stay as they are: the venue holds every placed and open plan,
       and the boot reconcile re-arms what waits. Only the process holding the key goes. */
    async shutdown(): Promise<void> {
      generation += 1;
      starting = null;
      stopTimers();
      if (child !== null) {
        const c = child;
        child = null;
        killChild(c, 'phosphor is shutting down');
      }
    },

    /* Sessions whose expiry has passed. A waiting plan locks and re-arms on the next unlock. A
       placed plan renews: its entry rests on the venue and a fill needs the key to be protected,
       which is strictly safer than dropping the key. An open plan needs no key: the venue holds
       its exits. Returns the plan ids whose key was taken back. */
    sweepSigningSessions(): string[] {
      const done = deps.session?.expired() ?? [];
      const taken: string[] = [];
      for (const session of done) {
        const row = rows.get(session.id);
        if (row === undefined || !live(row)) continue;
        if (row.status === 'placed') {
          deps.session?.arm(row.id, SIGNING_SESSION_DEFAULT_MS);
          continue;
        }
        taken.push(row.id);
        if (row.status === 'waiting') {
          row.locked = true;
          persist(row);
          record({ type: 'locked', id: row.id });
          if (child !== null && child.connected) void request({ cmd: 'disarm', id: row.id }).catch(() => undefined);
        }
      }
      if (taken.length > 0) maybeStopChild();
      return taken;
    },

    sweep,
    events: () => [...recent],
    stop(): void {
      stopTimers();
    },
  };

  return api;
}
