/* The audit chain against the two attacks the 2026-09-07 audit reproduced on it.

   Case B: edit a line, strip the prev field from it and every line after, re-anchor the tip.
   The walk used to restart at every stripped line and answer ok. Case C: truncate the log and
   delete the tip. The missing anchor used to fold into ok. Both are named now, and the log the
   app writes belongs to its owner alone. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAudit, hashLine, verifyChain, readTip, TIP_FILENAME } from '../../src/audit.ts';
import { atomicWriteJson } from '../../src/fsatomic.ts';

function seeded(count = 6): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-chain-hard-'));
  const audit = createAudit(dir);
  for (let i = 0; i < count; i += 1) audit.append('tool_call', `line ${i}`, { i });
  audit.flushTip();
  return { dir, file: path.join(dir, 'audit.jsonl') };
}

function lines(file: string): string[] {
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0);
}

test('an untouched log verifies, and says it was checked against an anchor', () => {
  const { dir, file } = seeded();
  const result = verifyChain(lines(file), readTip(dir));
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.anchored, true);
});

test('stripping prev from an edited line onward and re-anchoring the tip is named, not accepted', () => {
  const { dir, file } = seeded();
  const rows = lines(file);
  const edited = rows.map((line, i) => {
    if (i < 2) return line;
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (i === 2) parsed.msg = 'line 2, rewritten';
    delete parsed.prev;
    return JSON.stringify(parsed);
  });
  fs.writeFileSync(file, edited.map((l) => `${l}\n`).join(''));
  atomicWriteJson(path.join(dir, TIP_FILENAME), { count: edited.length, hash: hashLine(edited[edited.length - 1]) });
  const result = verifyChain(lines(file), readTip(dir));
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.break.reason, 'missing_link');
  assert.equal(!result.ok && result.break.line, 3);
});

test('a leading run of pre-chain lines is still a prefix, not a break', () => {
  const { dir, file } = seeded(4);
  const rows = lines(file);
  const withPrefix = [
    JSON.stringify({ ts: 'old', type: 'app_start', msg: 'before the chain existed' }),
    ...rows,
  ];
  // The first chained line names the hash of the pre-chain line as its prev.
  const first = JSON.parse(withPrefix[1]) as Record<string, unknown>;
  first.prev = hashLine(withPrefix[0]);
  withPrefix[1] = JSON.stringify(first);
  // Re-chain the rest onto the rewritten first line.
  for (let i = 2; i < withPrefix.length; i += 1) {
    const parsed = JSON.parse(withPrefix[i]) as Record<string, unknown>;
    parsed.prev = hashLine(withPrefix[i - 1]);
    withPrefix[i] = JSON.stringify(parsed);
  }
  fs.writeFileSync(file, withPrefix.map((l) => `${l}\n`).join(''));
  atomicWriteJson(path.join(dir, TIP_FILENAME), { count: withPrefix.length, hash: hashLine(withPrefix[withPrefix.length - 1]) });
  const result = verifyChain(lines(file), readTip(dir));
  assert.equal(result.ok, true, JSON.stringify(result));
});

test('a truncated log with its anchor deleted verifies as unanchored, never as plain ok', () => {
  const { dir, file } = seeded();
  const rows = lines(file);
  fs.writeFileSync(file, rows.slice(0, 4).map((l) => `${l}\n`).join(''));
  fs.rmSync(path.join(dir, TIP_FILENAME));
  const result = verifyChain(lines(file), readTip(dir));
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.anchored, false);
});

test('the log the app writes is readable by its owner and nobody else', () => {
  const { file } = seeded(2);
  const mode = fs.statSync(file).mode & 0o777;
  assert.equal(mode, 0o600, `audit.jsonl is mode ${mode.toString(8)}`);
});

test('an old 0644 log is pulled back to 0600 when the app opens it', () => {
  const { dir, file } = seeded(2);
  fs.chmodSync(file, 0o644);
  createAudit(dir);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
