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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type RunnerEvent =
  | { type: 'armed'; id: string; symbol: string }
  | { type: 'disarmed'; id: string; reason: string }
  | { type: 'fill'; id: string; symbol: string; side: string; sizeUsd: number; price: number }
  | { type: 'position'; id: string; symbol: string; sizeUsd: number; side: string; entryPx: number; liqPx: number | null; unrealisedUsd: number }
  | { type: 'halted'; id: string; reason: string }
  | { type: 'error'; id: string | null; message: string };

export type HostDeps = {
  apiWalletKey: () => Promise<`0x${string}` | null>;
  isMainnet: boolean;
  baseUrl: string;
  onEvent: (e: RunnerEvent) => void;
  killSwitch: () => boolean;
};

export function createRunnerHost(deps: HostDeps): MandateRunner & {
  stopAll(reason: string): Promise<void>;
  events(): RunnerEvent[];
} {
  let child: ChildProcess | null = null;
  const armed = new Map<string, { mandate: Mandate; since: string }>();
  const recent: RunnerEvent[] = [];

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

    child.on('message', (m) => record(m as RunnerEvent));
    child.on('exit', (code) => {
      // Anything armed when the child dies is no longer armed, whatever the exit code. Leaving
      // a mandate listed as live after its executor is gone would misreport the safety state,
      // which this repo already decided is worse than the safety being off.
      for (const [id] of armed) record({ type: 'disarmed', id, reason: `runner exited (${code})` });
      armed.clear();
      child = null;
    });
    child.stderr?.on('data', (b) => record({ type: 'error', id: null, message: String(b).trim() }));

    return child;
  }

  return {
    async arm(mandate, program) {
      if (deps.killSwitch()) return { ok: false, detail: 'kill switch is on; nothing can arm' };

      try {
        const c = await ensureChild();
        c.send({ cmd: 'arm', mandate, program });
        armed.set(mandate.id, { mandate, since: new Date().toISOString() });
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
      if (armed.size === 0 && child !== null) {
        child.send({ cmd: 'shutdown' });
      }
      return { ok: true, detail: `disarmed ${id}: ${reason}` };
    },

    async stopAll(reason) {
      for (const [id] of armed) record({ type: 'disarmed', id, reason });
      armed.clear();
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

    status: () => ({
      armed: [...armed.entries()].map(([id, v]) => ({ id, symbol: v.mandate.symbol, since: v.since })),
      running: child !== null && child.connected,
    }),

    events: () => [...recent],
  };
}
