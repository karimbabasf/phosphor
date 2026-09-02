// What happens when something throws where nothing was catching.
//
// Two layers. The unit tests drive the fault reporter with injected exit and stderr seams so
// the test runner survives them. The process test boots a real backend on a throwaway data dir,
// makes an unhandled rejection happen inside it, and reads the audit file and the exit code
// back: one audited line and a nonzero exit, not a raw stack on stdio nobody is reading.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { createFaultReporter, describeFault } from '../../src/crash.ts';
import type { LogEvent } from '../../src/types.ts';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-crash-'));
}

type Recorder = {
  audit: { append: (type: LogEvent['type'], msg: string, data?: unknown) => LogEvent };
  lines: string[];
  errs: string[];
  codes: number[];
};

function recorder(over: { throwOnAppend?: boolean } = {}): Recorder {
  const errs: string[] = [];
  const lines: string[] = [];
  const codes: number[] = [];
  return {
    lines,
    errs,
    codes,
    audit: {
      append(type, msg): LogEvent {
        if (over.throwOnAppend === true) throw new Error('ENOSPC: no space left on device');
        errs.push(`${type}: ${msg}`);
        return { ts: new Date().toISOString(), type, msg };
      },
    },
  };
}

test('an uncaught exception is audited, mirrored to stderr and exits nonzero', () => {
  const r = recorder();
  const report = createFaultReporter({
    audit: r.audit,
    exit: (code) => r.codes.push(code),
    stderr: (line) => r.lines.push(line),
  });
  report('uncaughtException', new Error('the rail blew up'));

  assert.equal(r.codes.length, 1);
  assert.notEqual(r.codes[0], 0);
  assert.equal(r.errs.length, 1);
  assert.match(r.errs[0], /^error: uncaughtException: the rail blew up$/);
  assert.match(r.lines[0], /uncaughtException: the rail blew up/);
  assert.ok(r.lines.some(l => l.includes('crash-handlers.test.ts')), 'the stack is mirrored too');
});

test('an unhandled rejection takes the same path', () => {
  const r = recorder();
  const report = createFaultReporter({
    audit: r.audit,
    exit: (code) => r.codes.push(code),
    stderr: (line) => r.lines.push(line),
  });
  report('unhandledRejection', new Error('quote never resolved'));
  assert.deepEqual(r.codes, [1]);
  assert.match(r.errs[0], /unhandledRejection: quote never resolved/);
});

test('a crash the audit file cannot record still exits, and says the log failed', () => {
  const r = recorder({ throwOnAppend: true });
  const report = createFaultReporter({
    audit: r.audit,
    exit: (code) => r.codes.push(code),
    stderr: (line) => r.lines.push(line),
  });
  report('uncaughtException', new Error('first fault'));
  assert.deepEqual(r.codes, [1]);
  assert.ok(r.lines.some(l => l.includes('could not be written to the audit log')));
  assert.ok(r.lines.some(l => l.includes('ENOSPC')));
});

test('a second fault while reporting the first does not recurse', () => {
  const r = recorder();
  const report = createFaultReporter({
    audit: r.audit,
    exit: () => r.codes.push(1),
    stderr: (line) => r.lines.push(line),
    onFatal: () => {
      throw new Error('the flush failed too');
    },
  });
  report('uncaughtException', new Error('first'));
  report('uncaughtException', new Error('second'));
  assert.deepEqual(r.codes, [1, 1]);
  assert.equal(r.errs.length, 1, 'only the first fault is audited');
  assert.ok(r.lines.some(l => l.includes('a second fault while reporting the first: second')));
});

test('describeFault names a thrown non-Error', () => {
  assert.equal(describeFault('just a string'), 'just a string');
  assert.equal(describeFault({ code: 7 }), '{"code":7}');
  assert.equal(describeFault(new Error('boom')), 'boom');
});

// The process-level proof. A `node -e` harness boots the same handlers the app boots, throws
// inside an async handler with nothing catching it, and the parent reads the exit code and the
// audit file. Before this the whole output was a raw V8 stack and an empty log.
test('a rejection inside a real process produces one audited line and a nonzero exit', () => {
  const dir = tmpDir();
  const script = `
    import { createAudit } from ${JSON.stringify(path.join(ROOT, 'src/audit.ts'))};
    import { installCrashHandlers } from ${JSON.stringify(path.join(ROOT, 'src/crash.ts'))};
    const audit = createAudit(${JSON.stringify(dir)});
    installCrashHandlers({ audit });
    // Exactly the shape of the eight sites the audit found: a floating async call.
    void (async () => { throw new Error('a handler threw with nobody catching'); })();
    setTimeout(() => process.exit(0), 2000);
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 20_000,
  });

  assert.notEqual(run.status, 0, `expected a nonzero exit, got ${String(run.status)}`);
  assert.match(run.stderr, /unhandledRejection: a handler threw with nobody catching/);

  const raw = fs.readFileSync(path.join(dir, 'audit.jsonl'), 'utf8').trim().split('\n');
  const events = raw.map(l => JSON.parse(l) as LogEvent);
  const faults = events.filter(e => e.type === 'error' && e.msg.includes('unhandledRejection'));
  assert.equal(faults.length, 1, 'exactly one audited line for one fault');
  assert.match(faults[0].msg, /a handler threw with nobody catching/);
});
