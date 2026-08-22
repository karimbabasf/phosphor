// Sub-agents: the app spawning a worker on an agent's behalf.
//
// THE SHAPE, AND WHY IT IS THIS ONE. The obvious way to give an agent sub-agents is to hand it
// the Agent tool and let Claude Code fan out. That was rejected, and the reason is the whole
// safety argument of src/driver.ts: the app reads back the child's announced tool list and
// refuses to drive when it contains anything that is not Phosphor's own. A sub-agent spawned
// INSIDE the child announces nothing to this app. Its tool surface would be whatever the model
// asked for, chosen by a model, inside a process holding a wallet's tools, and the one check
// that survives a Claude Code upgrade would be looking the other way.
//
// So the app spawns them. A worker is an ordinary driver child: same binary, same lockdown
// file, same assertSurface check on its init event, same process group and the same burial.
// Nothing about the guarantee changes because there are four of them.
//
// WHAT A WORKER MAY DO, and this is narrower than its parent on purpose. It runs with
// PHOSPHOR_ROLE=analyst, and src/mcp.ts does not REGISTER the propose tools for an analyst.
// The capability is absent from the process rather than refused inside it. A worker can read
// every market, measure every chart, draw on the chart and post to the team board; it cannot
// propose a swap, a deposit, a withdrawal, a policy change or a mandate, and there is no
// argument it can make, no prompt it can be given and no text it can read that changes that,
// because the tool does not exist in its process.
//
// WHAT A WORKER IS TOLD. One brief, once, and then it works until it answers. There is no
// conversation: a worker is a question with a deadline, not a session. Its answer is text,
// collected here, and handed back to whoever asked. It is DATA when it arrives: a worker is
// another agent, not the human, and its report cannot authorise anything. See src/board.ts.
//
// WHY THERE IS A DEADLINE AND A CAP. Every worker is a model on the other end of a
// subscription. A spawn loop with no cap is a bill; a worker that never answers is a process
// nobody is watching. Both are ended here rather than noticed later.

import { createDriver, type Driver, type DriverEvent, type DriverOptions } from './driver.ts';

export type CrewJobState = 'running' | 'done' | 'failed' | 'stopped' | 'timeout';

export type CrewJob = {
  id: string;
  label: string;
  brief: string;
  parent: string;
  state: CrewJobState;
  startedAt: string;
  finishedAt: string | null;
  // Everything the worker said, joined. Capped: a worker that decides to narrate is not
  // allowed to fill the parent's context window with it.
  report: string;
  // Tool calls it made, so the parent can tell a worker that measured from one that talked.
  calls: number;
  error: string | null;
};

export type CrewOptions = {
  repo: string;
  port: number;
  nodeBin?: string;
  claudeBin?: string;
  model?: string;
  // The role text a worker is given, built by the caller so this file holds no prose.
  workerPrompt(brief: string, label: string): string;
  maxWorkers?: number;
  defaultTimeoutMs?: number;
  onChange?(job: CrewJob): void;
  /* How a worker's process is made. The app never passes this and gets createDriver, which
     spawns a real Claude Code child; tests/unit/crew.test.ts passes a fake one, because the
     lifecycle below (a report accumulating, a deadline firing, a cap refusing, a stop landing
     mid-answer) is the part with the moving pieces, and none of it should cost a model session
     to check. It is a seam, not a configuration: nothing reads it from a file. */
  makeDriver?(opts: DriverOptions): Driver;
};

export type Crew = {
  spawn(params: { brief: unknown; label?: unknown; parent: string; timeoutMs?: unknown }):
    | { ok: true; job: CrewJob }
    | { ok: false; error: string };
  list(): CrewJob[];
  get(id: string): CrewJob | undefined;
  stop(id: string): boolean;
  stopAll(): number;
  running(): number;
};

// Three at once. Four agents on one chart is already a lot to read, and the roster cap in
// src/agents.ts (six) has to leave room for the humans' own sessions beside the workers.
const MAX_WORKERS = 3;

// How long a worker gets before it is taken out. Three minutes is a long analysis and a short
// hang; the ceiling stops a caller asking for an hour of billed silence.
const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_TIMEOUT_MS = 600_000;

// What a worker may hand back. A report is a paragraph, not a transcript: it lands in the
// parent's context window, and a worker that returns nine screens has cost more than it saved.
const MAX_REPORT = 4000;

const MAX_BRIEF = 2000;

function clean(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

export function createCrew(opts: CrewOptions): Crew {
  const maxWorkers = opts.maxWorkers ?? MAX_WORKERS;
  const jobs = new Map<string, CrewJob>();
  const drivers = new Map<string, Driver>();
  const timers = new Map<string, NodeJS.Timeout>();
  let seq = 0;

  function announce(job: CrewJob): void {
    opts.onChange?.(job);
  }

  function finish(id: string, state: CrewJobState, error?: string): void {
    const job = jobs.get(id);
    if (job === undefined || job.state !== 'running') return;
    job.state = state;
    job.finishedAt = new Date().toISOString();
    if (error !== undefined) job.error = error;
    const timer = timers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.delete(id);
    }
    // The child is stopped as soon as it has answered. A worker that stayed alive after its
    // report would hold a roster place and keep heartbeating for a question nobody has.
    drivers.get(id)?.stop();
    drivers.delete(id);
    announce(job);
  }

  function onEvent(id: string, event: DriverEvent): void {
    const job = jobs.get(id);
    if (job === undefined) return;
    if (event.kind === 'text' || event.kind === 'said') {
      const next = job.report.length === 0 ? event.text : `${job.report}\n${event.text}`;
      job.report = next.slice(0, MAX_REPORT);
      return;
    }
    if (event.kind === 'tool') {
      job.calls += 1;
      return;
    }
    if (event.kind === 'error') {
      // stderr from the child is not on its own a failed job: Claude Code writes warnings
      // there. It is kept as the error to report IF the job then fails.
      job.error = clean(event.message, 300);
      return;
    }
    if (event.kind === 'turn_end') {
      finish(id, event.error ? 'failed' : 'done');
      return;
    }
    if (event.kind === 'status' && (event.state === 'failed' || event.state === 'stopped')) {
      // A worker that stopped after answering is already done; finish() ignores it.
      finish(id, event.state === 'failed' ? 'failed' : 'stopped', event.detail);
    }
  }

  return {
    spawn(params) {
      const brief = clean(params.brief, MAX_BRIEF);
      if (brief.length === 0) {
        return { ok: false, error: 'a worker needs a brief: one paragraph saying what to measure and what to report back.' };
      }
      const live = [...jobs.values()].filter((j) => j.state === 'running');
      if (live.length >= maxWorkers) {
        return {
          ok: false,
          error:
            `${maxWorkers} workers are already running (${live.map((j) => j.label).join(', ')}), which is the maximum. ` +
            'Wait for one to report, or stop one with agent_stop.',
        };
      }
      seq += 1;
      const id = `w${seq}`;
      const label = clean(params.label, 32) || `worker ${seq}`;
      const asked = typeof params.timeoutMs === 'number' && Number.isFinite(params.timeoutMs)
        ? params.timeoutMs
        : DEFAULT_TIMEOUT_MS;
      const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(15_000, Math.round(asked)));

      const job: CrewJob = {
        id,
        label,
        brief,
        parent: params.parent,
        state: 'running',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        report: '',
        calls: 0,
        error: null,
      };
      jobs.set(id, job);

      const make = opts.makeDriver ?? createDriver;
      const driver = make({
        repo: opts.repo,
        port: opts.port,
        nodeBin: opts.nodeBin,
        claudeBin: opts.claudeBin,
        model: opts.model,
        role: 'analyst',
        label,
        parent: params.parent,
        systemPrompt: opts.workerPrompt(brief, label),
        onEvent: (event) => onEvent(id, event),
      });
      drivers.set(id, driver);

      try {
        driver.start();
        // The brief is the whole conversation. Claude Code does not emit its init event until a
        // turn arrives, so the send is what starts the session as well as what asks the
        // question; see the note on `spawn` in src/driver.ts.
        driver.send(brief);
      } catch (error) {
        jobs.delete(id);
        drivers.delete(id);
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }

      const timer = setTimeout(() => finish(id, 'timeout', `the worker did not report within ${Math.round(timeoutMs / 1000)}s`), timeoutMs);
      // Unref'd: a worker's deadline must never be the reason the app stays up. The exit guard
      // in src/driver.ts is what makes sure the child dies with the app.
      timer.unref();
      timers.set(id, timer);
      announce(job);
      return { ok: true, job };
    },

    list: () => [...jobs.values()],
    get: (id) => jobs.get(id),

    stop(id) {
      const job = jobs.get(id);
      if (job === undefined || job.state !== 'running') return false;
      finish(id, 'stopped', 'stopped before it reported');
      return true;
    },

    stopAll() {
      let n = 0;
      for (const job of [...jobs.values()]) {
        if (job.state !== 'running') continue;
        finish(job.id, 'stopped', 'the app stopped every worker');
        n += 1;
      }
      return n;
    },

    running: () => [...jobs.values()].filter((j) => j.state === 'running').length,
  };
}
