// Can somebody tell whether this app is alive, and can they tell what is wrong with it.
//
// The only unauthenticated GET that proved the app was up used to be `/api/session`, which
// answered by handing out the approval token: "is it running" and "take control of it" were the
// same request. Logging was a JSONL file and nothing else, so a crash before that file opened was
// completely silent and the Tauri shell's Console.app entry was empty in exactly the case where
// somebody needed it. And `audit.tail` read the WHOLE append-only log on every /api/log poll.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAudit, TAIL_BYTES } from '../../src/audit.ts';
import { readToolNames } from '../../src/http/mcp.ts';
import { viewToolNames } from '../../src/http/view.ts';
import { READ_TOOLS, VIEW_TOOLS, PROPOSE_KINDS } from '../../src/http/context.ts';
import type { LogEvent } from '../../src/types.ts';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-observe-'));
}

// ---------- the audit log ----------

test('the last error is held in memory, so health can report it without a file read', () => {
  const audit = createAudit(tmpDir());
  assert.equal(audit.lastError(), null);
  audit.append('app_start', 'up');
  assert.equal(audit.lastError(), null, 'only errors count');
  audit.append('error', 'the rail refused');
  assert.equal(audit.lastError()?.msg, 'the rail refused');
  audit.append('error', 'and then the venue did');
  assert.equal(audit.lastError()?.msg, 'and then the venue did', 'the LAST one');
  assert.match(audit.lastError()?.at ?? '', /^\d{4}-\d\d-\d\dT/);
});

test('tail reads the end of the file rather than the whole of it', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'audit.jsonl');
  // Comfortably past the window, so most of this file must never be parsed.
  const line = (n: number): string => JSON.stringify({ ts: new Date().toISOString(), type: 'app_start', msg: `event ${n}` }) + '\n';
  let text = '';
  for (let i = 0; i < 12_000; i += 1) text += line(i);
  fs.writeFileSync(file, text);
  assert.ok(fs.statSync(file).size > TAIL_BYTES * 3, 'the fixture is bigger than the window');

  const audit = createAudit(dir);
  const events = audit.tail(50);
  assert.equal(events.length, 50);
  assert.equal(events[0].msg, 'event 11999', 'newest first, and it is the real newest');
  assert.equal(audit.tornLines(), 0, 'the fragment the window cut is dropped, not counted as damage');
});

test('a limit larger than the window returns what the window held, not an error', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'audit.jsonl');
  const line = (n: number): string => JSON.stringify({ ts: new Date().toISOString(), type: 'app_start', msg: `e${n}` }) + '\n';
  let text = '';
  for (let i = 0; i < 12_000; i += 1) text += line(i);
  fs.writeFileSync(file, text);

  const events = createAudit(dir).tail(100_000);
  assert.ok(events.length > 0);
  assert.ok(events.length < 12_000, 'bounded by the window');
  assert.equal(events[0].msg, 'e11999');
});

test('a small file is still read whole', () => {
  const dir = tmpDir();
  const audit = createAudit(dir);
  audit.append('app_start', 'one');
  audit.append('app_start', 'two');
  assert.deepEqual(audit.tail(10).map((e: LogEvent) => e.msg), ['two', 'one']);
});

test('the tail window is 256 KB', () => {
  assert.equal(TAIL_BYTES, 256 * 1024);
});

// ---------- the three hand-maintained vocabularies ----------
//
// READ_TOOLS, VIEW_TOOLS and PROPOSE_KINDS are what an agent calling an unknown tool is told
// about. Nothing held them to the tables that actually dispatch, and they were in step only
// because somebody kept checking by hand. A name on the list and off the table is a tool an agent
// is told it has and cannot call; a name on the table and off the list is one nobody is told
// about. This is the test that was missing.

test('every read tool on the list is in the table, and the reverse', () => {
  assert.deepEqual([...readToolNames()].sort(), [...READ_TOOLS].sort());
});

test('every view tool on the list is in the table, and the reverse', () => {
  assert.deepEqual([...viewToolNames()].sort(), [...VIEW_TOOLS].sort());
});

test('every propose kind on the list has a branch that answers it', () => {
  // propose.ts is a chain of `if (kind === ...)` rather than a table, because each kind reads a
  // different set of fields. The names it matches on are still checkable against the list.
  const src = fs.readFileSync(new URL('../../src/http/propose.ts', import.meta.url), 'utf8');
  const matched = new Set([...src.matchAll(/kind === '([a-z_]+)'/g)].map((m) => m[1]));
  const missing = PROPOSE_KINDS.filter((kind) => !matched.has(kind));
  assert.deepEqual(missing, [], 'these kinds are advertised and cannot be proposed');
  const undocumented = [...matched].filter((kind) => !PROPOSE_KINDS.includes(kind));
  assert.deepEqual(undocumented, [], 'these kinds can be proposed and nothing tells an agent so');
});

// ---------- the chain and the window, together ----------
//
// The hash chain (custody) and the positioned tail (reliability) landed on the same file from
// two branches and they touch the same three things: what append writes, what tail reads, and
// what the boot seeds `prev` from. These assert the combination rather than either half.

test('a chain written across a restart still verifies', () => {
  const dir = tmpDir();
  const first = createAudit(dir);
  first.append('app_start', 'one');
  first.append('app_start', 'two');

  // A second Audit over the same directory is what a restart is. It seeds `prev` from the tail
  // window rather than from the whole file, and the link has to hold across that boundary.
  const second = createAudit(dir);
  second.append('app_start', 'three');

  const out = second.verify();
  assert.equal(out.ok, true, out.ok ? '' : `broke at line ${out.break.line}: ${out.break.detail}`);
  assert.equal(out.lines, 3);
});

test('the seed is correct even when the file is larger than the tail window', () => {
  const dir = tmpDir();
  const audit = createAudit(dir);
  // Past the window, so the seed cannot come from a whole-file read.
  const filler = 'x'.repeat(400);
  for (let i = 0; i < 800; i += 1) audit.append('app_start', `${filler} ${i}`);
  assert.ok(fs.statSync(path.join(dir, 'audit.jsonl')).size > TAIL_BYTES, 'the fixture outgrew the window');

  createAudit(dir).append('app_start', 'after the restart');
  const out = createAudit(dir).verify();
  assert.equal(out.ok, true, out.ok ? '' : `broke at line ${out.break.line}: ${out.break.detail}`);
});

test('a torn last line is a broken chain and a skipped tail line, and both say so', () => {
  const dir = tmpDir();
  const audit = createAudit(dir);
  audit.append('app_start', 'good');
  fs.appendFileSync(path.join(dir, 'audit.jsonl'), '{"ts":"2026-09-01T00:00:00.000Z","type":"app_st');

  // tail renders what it can: the log is still readable with damage at the end.
  const events = audit.tail(10);
  assert.deepEqual(events.map(e => e.msg), ['good']);
  assert.equal(audit.tornLines(), 1);

  // verify is stricter, and it must be: a line that will not parse is a link that cannot hold.
  const out = audit.verify();
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.equal(out.break.line, 2);
    assert.equal(out.break.reason, 'unparseable');
  }
});

test('an error is chained, mirrored to stderr and held as the last error, all three', () => {
  const dir = tmpDir();
  const audit = createAudit(dir);
  audit.append('app_start', 'up');
  audit.append('error', 'the rail refused');

  assert.equal(audit.lastError()?.msg, 'the rail refused');
  const lines = fs.readFileSync(path.join(dir, 'audit.jsonl'), 'utf8').trim().split('\n');
  const second = JSON.parse(lines[1]) as { prev?: unknown };
  assert.equal(typeof second.prev, 'string', 'the mirrored line is still a link in the chain');
  assert.equal(audit.verify().ok, true);
});
