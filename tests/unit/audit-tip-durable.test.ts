// The tip is written on a timer now, so the question is whether it is still there afterwards.
//
// audit.append() used to write the tip durably on every line: an atomicWriteJson with two fsyncs
// in it. Measured in situ, the whole call was 8.15 ms and the tip was 8.02 ms of that, so 99.7% of
// the cost of writing an audit line was the anchor beside it rather than the line. Every agent
// tool call appends at least one line, so twenty calls blocked the event loop for about 160 ms and
// the window stuttered whenever an agent was working.
//
// The line itself is unchanged: still appendFileSync, still synchronous, still carrying the hash of
// the line above it. Only the anchor is debounced, to about a second, and flushed on the way out.
//
// The anchor was always allowed to lag: a SIGKILL between the append and the tip write left it one
// line behind, which is why lines AFTER the anchor verify and lines missing BEFORE it do not. This
// widens that gap from one line to a second's worth of them and closes it everywhere the process
// gets to run code on the way out. What must not change is the asymmetry: appending is what this
// file is for, removing is not.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createAudit, hashLine, readTip, TIP_FILENAME } from '../../src/audit.ts';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const AUDIT_MODULE = path.join(ROOT, 'src', 'audit.ts');
const CRASH_MODULE = path.join(ROOT, 'src', 'crash.ts');

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-tip-durable-'));
}

function lines(dir: string): string[] {
  return fs
    .readFileSync(path.join(dir, 'audit.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.length > 0);
}

function runNode(source: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c: string) => (stderr += c));
    child.stdout.resume();
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stderr }));
  });
}

test('appending no longer writes the anchor, and flushing does', () => {
  const dir = tmpDir();
  const audit = createAudit(dir);
  for (let i = 0; i < 12; i += 1) audit.append('tool_call', `line ${i}`);

  assert.equal(readTip(dir), null, 'twelve appends and not one durable write for the anchor');

  audit.flushTip();
  const tip = readTip(dir);
  assert.deepEqual(tip, { count: 12, hash: hashLine(lines(dir)[11]) });
});

test('flushing twice writes once, and flushing an untouched log writes nothing', () => {
  const dir = tmpDir();
  const audit = createAudit(dir);
  audit.flushTip();
  assert.equal(readTip(dir), null, 'nothing was appended, so there is no anchor to move');

  audit.append('tool_call', 'one');
  audit.flushTip();
  const first = fs.statSync(path.join(dir, TIP_FILENAME)).mtimeMs;
  audit.flushTip();
  assert.equal(fs.statSync(path.join(dir, TIP_FILENAME)).mtimeMs, first, 'a clean tip is not rewritten');
});

test('the anchor a restart reads is the file, not a stale count it inherited', () => {
  const dir = tmpDir();
  const first = createAudit(dir);
  for (let i = 0; i < 6; i += 1) first.append('tool_call', `line ${i}`);
  first.flushTip();

  // The gap a SIGKILL leaves: three more lines on disk and an anchor that never caught up.
  for (let i = 6; i < 9; i += 1) first.append('tool_call', `line ${i}`);
  assert.deepEqual(readTip(dir), { count: 6, hash: hashLine(lines(dir)[5]) });

  const second = createAudit(dir);
  assert.equal(second.verify().ok, true, 'lines after the anchor are what appending looks like');
  second.append('tool_call', 'the next process carries on');
  second.flushTip();

  assert.deepEqual(readTip(dir), { count: 10, hash: hashLine(lines(dir)[9]) }, 'the anchor counts the file, not the tip it inherited');
  assert.equal(createAudit(dir).verify().ok, true);
});

test('a tip several lines behind still verifies, and a truncated file still does not', () => {
  const dir = tmpDir();
  const audit = createAudit(dir);
  for (let i = 0; i < 30; i += 1) audit.append('tool_call', `line ${i}`);
  audit.flushTip();

  // Rewind the anchor by nine lines, which is what a second of appends looks like on a busy agent.
  const rows = lines(dir);
  fs.writeFileSync(path.join(dir, TIP_FILENAME), JSON.stringify({ count: 21, hash: hashLine(rows[20]) }));
  assert.equal(audit.verify().ok, true, 'a lagging anchor is the documented cost of the debounce');

  // The same lagging anchor, and now the newest lines are gone.
  fs.writeFileSync(path.join(dir, 'audit.jsonl'), rows.slice(0, 15).map((r) => `${r}\n`).join(''));
  const out = audit.verify();
  assert.equal(out.ok, false, 'removing lines the anchor already counted is still caught');
  if (out.ok) return;
  assert.equal(out.break.reason, 'truncated');
});

/* ---------- the flush has to actually be wired ----------

   A debounce with nothing on the way out is a tip that is simply missing after every stop, and
   the whole point of the anchor is that it is there when somebody comes back to check. */

test('a real backend stopped with SIGTERM leaves the anchor on disk', async () => {
  const dir = tmpDir();
  const port = 4420 + Math.floor(Math.random() * 30);
  const child = spawn(process.execPath, ['src/main.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PHOSPHOR_MODE: 'demo',
      PHOSPHOR_PORT: String(port),
      PHOSPHOR_DATA_DIR: dir,
      PHOSPHOR_KEYS: path.join(dir, 'keys.enc.json'),
      PHOSPHOR_NO_PARENT_WATCH: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end();

  const up = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 25_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (!chunk.includes(`http://127.0.0.1:${port}`)) return;
      clearTimeout(timer);
      resolve(true);
    });
  });
  assert.ok(up, 'the demo instance never answered');

  child.kill('SIGTERM');
  await new Promise<void>((resolve) => child.on('exit', () => resolve()));

  const rows = lines(dir);
  const tip = readTip(dir);
  assert.notEqual(tip, null, 'the anchor was never written on the way out');
  assert.deepEqual(tip, { count: rows.length, hash: hashLine(rows[rows.length - 1]) });
  assert.equal(createAudit(dir).verify().ok, true);
});

test('a process taken down by the crash handler leaves the anchor on disk', async () => {
  const dir = tmpDir();
  const source = `
    const { createAudit } = await import(${JSON.stringify(AUDIT_MODULE)});
    const { installCrashHandlers } = await import(${JSON.stringify(CRASH_MODULE)});
    const audit = createAudit(${JSON.stringify(dir)});
    installCrashHandlers({ audit });
    process.on('exit', () => audit.flushTip());
    for (let i = 0; i < 7; i += 1) audit.append('tool_call', 'line ' + i);
    Promise.reject(new Error('a rail threw where nobody was catching'));
  `;
  const out = await runNode(source);
  assert.equal(out.code, 1, `the crash handler should exit nonzero; stderr was ${out.stderr}`);

  const rows = lines(dir);
  const tip = readTip(dir);
  assert.notEqual(tip, null, 'the anchor was lost on the fall');
  assert.deepEqual(tip, { count: rows.length, hash: hashLine(rows[rows.length - 1]) });
  assert.equal(createAudit(dir).verify().ok, true);
});

/* ---------- the anchor is not moved over a file that has lost lines ----------

   The chain walk used to run before this process appended anything. It runs after the port opens
   now, so by the time it looks, this process has written its own app_start lines and flushed its
   own anchor. An anchor recounted from a truncated file is a true statement about a forgery: the
   count matches, the walk passes, and the app has written over the only record that lines were
   removed. The first flush of a process therefore checks the anchor it inherited before it moves
   it. */
test('a boot on a truncated log leaves the anchor that proves it alone', () => {
  const dir = tmpDir();
  const first = createAudit(dir);
  for (let i = 0; i < 10; i += 1) first.append('tool_call', `line ${i}`);
  first.flushTip();
  const anchor = readTip(dir);

  // The newest five removed, which is the tamper the anchor exists to catch.
  const kept = lines(dir).slice(0, 5);
  fs.writeFileSync(path.join(dir, 'audit.jsonl'), kept.map((r) => `${r}\n`).join(''));

  // A boot on the damaged file, appending and flushing before anything walks the chain.
  const second = createAudit(dir);
  for (let i = 0; i < 8; i += 1) second.append('app_start', `phosphor up ${i}`);
  second.flushTip();

  assert.deepEqual(readTip(dir), anchor, 'the anchor is where the previous process left it');
  const out = second.verify();
  assert.equal(out.ok, false, 'and the truncation is still there to be found');
  if (out.ok) return;
  assert.equal(out.break.reason, 'truncated');
});

test('a log that matches its anchor still gets a new one, however far behind it was', () => {
  const dir = tmpDir();
  const first = createAudit(dir);
  for (let i = 0; i < 4; i += 1) first.append('tool_call', `line ${i}`);
  first.flushTip();
  for (let i = 4; i < 20; i += 1) first.append('tool_call', `line ${i}`);

  const second = createAudit(dir);
  second.append('app_start', 'phosphor up');
  second.flushTip();
  assert.deepEqual(readTip(dir), { count: 21, hash: hashLine(lines(dir)[20]) });
  assert.equal(second.verify().ok, true);
});
