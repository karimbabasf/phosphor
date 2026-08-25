// Workers: what happens to a job between being asked for and being read.
//
// The process a worker runs in is a real Claude Code child, and none of that is exercised here:
// spawning one costs a model session and tells you nothing about the logic. What is exercised is
// everything around it, which is where the failures live. A report that accumulates in the wrong
// order, a deadline that never fires, a cap that lets a spawn loop through, a stop that lands
// while a worker is mid-sentence, a finished worker whose process is left running.
//
// The fake driver below is handed in through the seam in CrewOptions and lets each of those be
// driven exactly, including the ones that are hard to reach with a real child.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createCrew } from '../../src/crew.ts';
import type { Driver, DriverEvent, DriverOptions } from '../../src/driver.ts';

type Fake = {
  driver: Driver;
  emit(event: DriverEvent): void;
  sent: string[];
  stopped: number;
  role: string | undefined;
  label: string | undefined;
  parent: string | undefined;
  prompt: string | undefined;
};

function harness(): { crew: ReturnType<typeof createCrew>; made: Fake[] } {
  const made: Fake[] = [];
  const crew = createCrew({
    repo: '/repo',
    port: 4177,
    workerPrompt: (brief, label) => `BRIEF ${label}: ${brief}`,
    makeDriver(opts: DriverOptions): Driver {
      const fake: Fake = {
        sent: [],
        stopped: 0,
        role: opts.role,
        label: opts.label,
        parent: opts.parent,
        prompt: opts.systemPrompt,
        emit: (event) => opts.onEvent(event),
        driver: {
          start: () => {},
          send: (text: string) => {
            fake.sent.push(text);
          },
          interrupt: () => false,
          stop: () => {
            fake.stopped += 1;
          },
          status: () => ({ state: 'ready' as const, sessionId: 'fake', running: true }),
        },
      };
      made.push(fake);
      return fake.driver;
    },
  });
  return { crew, made };
}

test('a worker is spawned as an analyst, named, and told who its parent is', () => {
  const { crew, made } = harness();
  const out = crew.spawn({ brief: 'measure the 4h structure on SOL', label: 'four hour', parent: 'lead-session' });
  assert.equal(out.ok, true);
  assert.equal(made.length, 1);
  assert.equal(made[0]?.role, 'analyst', 'a worker that spawned as an operator could reach the money path');
  assert.equal(made[0]?.label, 'four hour');
  assert.equal(made[0]?.parent, 'lead-session');
  assert.match(made[0]?.prompt ?? '', /BRIEF four hour: measure the 4h structure on SOL/);
});

test('the brief is the whole session: it is sent as the one and only turn', () => {
  const { crew, made } = harness();
  crew.spawn({ brief: 'do the thing', parent: 'p' });
  assert.deepEqual(made[0]?.sent, ['do the thing']);
});

test('a spawn with no brief is refused, because a worker cannot be asked what you meant', () => {
  const { crew, made } = harness();
  const out = crew.spawn({ brief: '   ', parent: 'p' });
  assert.equal(out.ok, false);
  assert.match(out.ok === false ? out.error : '', /needs a brief/);
  assert.equal(made.length, 0, 'nothing was started');
});

test('what the worker says becomes its report, in order, and the job finishes on the turn end', () => {
  const { crew, made } = harness();
  const spawned = crew.spawn({ brief: 'b', parent: 'p' });
  assert.ok(spawned.ok);
  made[0]?.emit({ kind: 'text', text: 'first line' });
  made[0]?.emit({ kind: 'tool', name: 'chart_batch', input: {} });
  made[0]?.emit({ kind: 'text', text: 'second line' });
  made[0]?.emit({ kind: 'turn_end', error: false, turns: 1 });

  const job = crew.get(spawned.job.id);
  assert.equal(job?.state, 'done');
  assert.equal(job?.report, 'first line\nsecond line');
  assert.equal(job?.calls, 1);
  assert.ok(job?.finishedAt !== null);
});

test('a finished worker has its process stopped, not left heartbeating', () => {
  // A worker that stayed alive after answering would hold a place on the roster and keep
  // spending the subscription for a question nobody still has.
  const { crew, made } = harness();
  const spawned = crew.spawn({ brief: 'b', parent: 'p' });
  assert.ok(spawned.ok);
  made[0]?.emit({ kind: 'turn_end', error: false, turns: 1 });
  assert.equal(made[0]?.stopped, 1);
});

test('a turn that ended in an error is a failed job, not a done one with no words in it', () => {
  const { crew, made } = harness();
  const spawned = crew.spawn({ brief: 'b', parent: 'p' });
  assert.ok(spawned.ok);
  made[0]?.emit({ kind: 'error', message: 'the child could not reach the app' });
  made[0]?.emit({ kind: 'turn_end', error: true, turns: 0 });
  const job = crew.get(spawned.job.id);
  assert.equal(job?.state, 'failed');
  assert.match(job?.error ?? '', /could not reach/);
});

test('a driver that fails outright ends the job rather than leaving it running forever', () => {
  const { crew, made } = harness();
  const spawned = crew.spawn({ brief: 'b', parent: 'p' });
  assert.ok(spawned.ok);
  made[0]?.emit({ kind: 'status', state: 'failed', detail: 'refusing to drive' });
  assert.equal(crew.get(spawned.job.id)?.state, 'failed');
  assert.equal(crew.running(), 0);
});

test('nothing that arrives after a job is finished can reopen it', () => {
  const { crew, made } = harness();
  const spawned = crew.spawn({ brief: 'b', parent: 'p' });
  assert.ok(spawned.ok);
  made[0]?.emit({ kind: 'turn_end', error: false, turns: 1 });
  made[0]?.emit({ kind: 'status', state: 'failed', detail: 'late' });
  const job = crew.get(spawned.job.id);
  assert.equal(job?.state, 'done', 'a late event rewrote a finished answer');
  assert.equal(made[0]?.stopped, 1, 'and it was not stopped twice');
});

test('the concurrency cap refuses the next one and names what is already running', () => {
  const { crew } = harness();
  const a = crew.spawn({ brief: 'one', label: 'alpha', parent: 'p' });
  const b = crew.spawn({ brief: 'two', label: 'beta', parent: 'p' });
  const c = crew.spawn({ brief: 'three', label: 'gamma', parent: 'p' });
  const d = crew.spawn({ brief: 'four', parent: 'p' });
  assert.ok(a.ok && b.ok && c.ok);
  assert.equal(d.ok, false);
  assert.match(d.ok === false ? d.error : '', /alpha, beta, gamma/);
  assert.match(d.ok === false ? d.error : '', /maximum/);
});

test('a worker that finishes makes room for the next one', () => {
  const { crew, made } = harness();
  crew.spawn({ brief: 'one', parent: 'p' });
  crew.spawn({ brief: 'two', parent: 'p' });
  const third = crew.spawn({ brief: 'three', parent: 'p' });
  assert.ok(third.ok);
  made[0]?.emit({ kind: 'turn_end', error: false, turns: 1 });
  assert.equal(crew.spawn({ brief: 'four', parent: 'p' }).ok, true);
});

test('stopping a worker ends it, and stopping a finished one is not a second stop', () => {
  const { crew, made } = harness();
  const spawned = crew.spawn({ brief: 'b', parent: 'p' });
  assert.ok(spawned.ok);
  assert.equal(crew.stop(spawned.job.id), true);
  assert.equal(crew.get(spawned.job.id)?.state, 'stopped');
  assert.equal(made[0]?.stopped, 1);
  assert.equal(crew.stop(spawned.job.id), false, 'a finished job cannot be stopped again');
  assert.equal(crew.stop('nothing-by-that-name'), false);
});

test('stopAll ends every running worker and reports how many it took', () => {
  const { crew, made } = harness();
  crew.spawn({ brief: 'one', parent: 'p' });
  crew.spawn({ brief: 'two', parent: 'p' });
  made[0]?.emit({ kind: 'turn_end', error: false, turns: 1 });
  assert.equal(crew.stopAll(), 1, 'only the one still running');
  assert.equal(crew.running(), 0);
});

test('a report is capped, so a worker that narrates cannot fill its parent context window', () => {
  const { crew, made } = harness();
  const spawned = crew.spawn({ brief: 'b', parent: 'p' });
  assert.ok(spawned.ok);
  for (let i = 0; i < 50; i++) made[0]?.emit({ kind: 'text', text: 'x'.repeat(500) });
  made[0]?.emit({ kind: 'turn_end', error: false, turns: 1 });
  assert.ok((crew.get(spawned.job.id)?.report.length ?? 0) <= 4000);
});

test('a brief is capped and stripped of control characters before it becomes a prompt', () => {
  const { crew } = harness();
  const spawned = crew.spawn({ brief: 'y'.repeat(5000) + '\nline two', parent: 'p' });
  assert.ok(spawned.ok);
  assert.equal(spawned.job.brief.length, 2000);
  assert.equal(/[\u0000-\u001f]/.test(spawned.job.brief), false);
});

test('a worker with no label still gets one, because the roster has to name it', () => {
  const { crew } = harness();
  const spawned = crew.spawn({ brief: 'b', parent: 'p' });
  assert.ok(spawned.ok);
  assert.match(spawned.job.label, /worker \d+/);
});

test('every change is announced, so the window and the parent hear about it without polling', () => {
  const seen: string[] = [];
  const made: { emit(e: DriverEvent): void }[] = [];
  const crew = createCrew({
    repo: '/repo',
    port: 4177,
    workerPrompt: () => 'p',
    onChange: (job) => seen.push(`${job.id}:${job.state}`),
    makeDriver(opts) {
      made.push({ emit: opts.onEvent });
      return {
        start: () => {},
        send: () => {},
        interrupt: () => false,
        stop: () => {},
        status: () => ({ state: 'ready' as const, sessionId: 'f', running: true }),
      };
    },
  });
  const spawned = crew.spawn({ brief: 'b', parent: 'p' });
  assert.ok(spawned.ok);
  made[0]?.emit({ kind: 'turn_end', error: false, turns: 1 });
  assert.deepEqual(seen, ['w1:running', 'w1:done']);
});
