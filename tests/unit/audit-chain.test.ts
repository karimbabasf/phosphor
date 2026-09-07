// The audit log's integrity. SECURITY.md puts forged, dropped and reordered entries in scope,
// and the product's whole proof that a human decided anything is a line in this file, so the
// file has to be able to say when it has been edited.
//
// Each test below is an edit somebody could make with a text editor, turned into an assertion
// that verify() names the line it happened on.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAudit, hashLine, verifyChain } from '../../src/audit.ts';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-audit-'));
}

function lines(dir: string): string[] {
  return fs.readFileSync(path.join(dir, 'audit.jsonl'), 'utf8').split('\n').filter((l) => l.length > 0);
}

function write(dir: string, list: string[]): void {
  fs.writeFileSync(path.join(dir, 'audit.jsonl'), list.join('\n') + '\n');
}

test('every line but the first names the hash of the line above it', () => {
  const dir = tempDir();
  const audit = createAudit(dir);
  audit.append('app_start', 'one');
  audit.append('tool_call', 'two');
  audit.append('executed', 'three');

  const written = lines(dir);
  assert.equal(written.length, 3);
  const parsed = written.map((l) => JSON.parse(l) as { prev: string | null; msg: string });
  assert.equal(parsed[0].prev, null, 'the first line has no ancestor');
  assert.equal(parsed[1].prev, hashLine(written[0]));
  assert.equal(parsed[2].prev, hashLine(written[1]));

  const result = audit.verify();
  assert.equal(result.ok, true);
  assert.equal(result.lines, 3);
});

test('an empty or absent log verifies: no lines is a chain nobody has broken', () => {
  const dir = tempDir();
  const audit = createAudit(dir);
  const before = audit.verify();
  assert.equal(before.ok, true);
  assert.equal(before.lines, 0);
});

test('editing a line in the middle is caught at the line after it', () => {
  const dir = tempDir();
  const audit = createAudit(dir);
  for (const msg of ['one', 'two', 'three', 'four']) audit.append('tool_call', msg);

  const written = lines(dir);
  const tampered = written.slice();
  // The classic edit: a refusal turned into an approval, with the link left untouched.
  tampered[1] = tampered[1].replace('"two"', '"two, but different"');
  write(dir, tampered);

  const result = createAudit(dir).verify();
  assert.equal(result.ok, false);
  assert.equal(result.break.line, 3, 'the break shows at the line whose prev no longer matches');
  assert.equal(result.break.reason, 'broken_link');
});

test('deleting a line is caught, because the next line still names the one that is gone', () => {
  const dir = tempDir();
  const audit = createAudit(dir);
  for (const msg of ['one', 'two', 'three']) audit.append('tool_call', msg);

  const written = lines(dir);
  write(dir, [written[0], written[2]]);

  const result = createAudit(dir).verify();
  assert.equal(result.ok, false);
  assert.equal(result.break.line, 2);
});

test('reordering two lines is caught', () => {
  const dir = tempDir();
  const audit = createAudit(dir);
  for (const msg of ['one', 'two', 'three']) audit.append('tool_call', msg);
  // The anchor is written on a timer now, so a data directory that has been used and stopped has
  // one and this seed has to put it down the same way the shutdown path does.
  audit.flushTip();

  const written = lines(dir);
  write(dir, [written[0], written[2], written[1]]);

  const result = createAudit(dir).verify();
  assert.equal(result.ok, false);
  /* The tip anchor now reaches this first: the line at the recorded count is not the one that was
     written there, which a reorder makes true as surely as a truncation does. The WALK still
     catches it on its own, which is what the second half asserts, so the older detection is not
     resting on the newer one. */
  assert.equal(result.ok === false && result.break.reason, 'truncated');
  const walked = verifyChain([written[0], written[2], written[1]]);
  assert.equal(walked.ok, false, 'and the chain walk catches it with no anchor at all');
  assert.equal(walked.ok === false && walked.break.line, 2);
});

test('a restart links onto what the last process wrote rather than starting a second chain', () => {
  const dir = tempDir();
  createAudit(dir).append('app_start', 'first boot');
  const second = createAudit(dir);
  second.append('app_start', 'second boot');

  const result = second.verify();
  assert.equal(result.ok, true);
  assert.equal(result.lines, 2);
  const parsed = lines(dir).map((l) => JSON.parse(l) as { prev: string | null });
  assert.equal(parsed[1].prev, hashLine(lines(dir)[0]));
});

test('lines written before the chain existed are not reported as damage', () => {
  // An existing install's audit.jsonl has no prev on any line. It is not evidence of tampering
  // and it must not read as though it were, or the first upgrade cries wolf about every line.
  const legacy = [
    JSON.stringify({ ts: '2026-08-01T00:00:00.000Z', type: 'app_start', msg: 'old' }),
    JSON.stringify({ ts: '2026-08-01T00:00:01.000Z', type: 'tool_call', msg: 'older still' }),
  ];
  const result = verifyChain(legacy);
  assert.equal(result.ok, true);
  assert.equal(result.lines, 2);
});

test('a chain that starts mid-file verifies from the first linked line', () => {
  const dir = tempDir();
  fs.writeFileSync(
    path.join(dir, 'audit.jsonl'),
    JSON.stringify({ ts: '2026-08-01T00:00:00.000Z', type: 'app_start', msg: 'before the chain' }) + '\n',
  );
  const audit = createAudit(dir);
  audit.append('tool_call', 'after the upgrade');
  audit.append('tool_call', 'and another');

  assert.equal(audit.verify().ok, true);

  const written = lines(dir);
  write(dir, [written[0], written[1].replace('after the upgrade', 'something else'), written[2]]);
  const broken = createAudit(dir).verify();
  assert.equal(broken.ok, false);
  assert.equal(broken.break.line, 3);
});

test('a line that is not JSON is named rather than thrown on', () => {
  const dir = tempDir();
  const audit = createAudit(dir);
  audit.append('tool_call', 'one');
  write(dir, [...lines(dir), '{ this is not json']);

  const result = createAudit(dir).verify();
  assert.equal(result.ok, false);
  assert.equal(result.break.reason, 'unparseable');
  assert.equal(result.break.line, 2);
});
