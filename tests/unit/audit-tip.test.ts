// Truncation, which is the tamper the hash chain did not catch.
//
// verifyChain walked the file comparing each line's `prev` to the hash of the line above it, and
// nothing anchored either END. So dropping a prefix or a suffix left a chain that is perfectly
// self-consistent and verified `ok`. An attacker with write access to audit.jsonl removes the
// newest and most incriminating lines and the record still passes its own check, which is exactly
// the tamper SECURITY.md puts in scope. Compounding it, verify() had no caller outside the tests:
// nothing on boot, no route, not health, so the chain was never checked in production at all.
//
// The tip record is the anchor: {count, hash} beside the log, written durably on every append.
// It can legitimately lag the file by a line, because a SIGKILL between the append and the tip
// write leaves exactly that, so lines AFTER the anchor are fine and lines MISSING before it are
// not. That asymmetry is the whole design: appending is what this file is for; removing is not.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAudit, hashLine, readTip, verifyChain, TIP_FILENAME } from '../../src/audit.ts';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-audit-tip-'));
}

function seeded(lines = 8): { dir: string; file: string; audit: ReturnType<typeof createAudit> } {
  const dir = tmpDir();
  const audit = createAudit(dir);
  for (let i = 0; i < lines; i += 1) audit.append('tool_call', `line ${i}`);
  /* The anchor is debounced now (src/audit.ts, TIP_FLUSH_MS) and put down on the way out, so a
     data directory that has been used and stopped carries one. This seed stands in for that prior
     run, and flushing here is what that run's exit handler does. */
  audit.flushTip();
  return { dir, file: path.join(dir, 'audit.jsonl'), audit };
}

function lines(file: string): string[] {
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0);
}

function write(file: string, rows: string[]): void {
  fs.writeFileSync(file, rows.map((r) => `${r}\n`).join(''));
}

test('an untouched log verifies, and the tip names where it ends', () => {
  const h = seeded();
  const out = h.audit.verify();
  assert.equal(out.ok, true);
  assert.equal(out.lines, 8);

  const tip = readTip(h.dir);
  assert.deepEqual(tip, { count: 8, hash: hashLine(lines(h.file)[7]) });
});

test('dropping the last lines fails, naming truncation', () => {
  const h = seeded();
  const kept = lines(h.file).slice(0, 4);
  write(h.file, kept);

  const out = h.audit.verify();
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.break.reason, 'truncated');
  assert.match(out.break.detail, /8 lines/);
});

test('appending after truncation still fails, because the anchor is a count as well as a hash', () => {
  const h = seeded();
  const kept = lines(h.file).slice(0, 4);
  write(h.file, kept);
  // The attacker puts the file back to its old length with lines of their own, correctly chained.
  const forged = createAudit(tmpDir());
  void forged;
  let prev: string | null = hashLine(kept[3]);
  const filler: string[] = [];
  for (let i = 0; i < 4; i += 1) {
    const row = JSON.stringify({ ts: new Date().toISOString(), type: 'tool_call', msg: `forged ${i}`, prev });
    filler.push(row);
    prev = hashLine(row);
  }
  write(h.file, [...kept, ...filler]);

  const out = h.audit.verify();
  assert.equal(out.ok, false, 'the chain is self-consistent, and the anchor still says it was rewritten');
  if (out.ok) return;
  assert.equal(out.break.reason, 'truncated');
});

test('dropping the first lines fails too, because everything shifts under the anchor', () => {
  const h = seeded();
  write(h.file, lines(h.file).slice(4));

  const out = h.audit.verify();
  assert.equal(out.ok, false);
});

test('a tip one line behind the file is fine, because a crash mid-append leaves exactly that', () => {
  const h = seeded();
  const rows = lines(h.file);
  // Rewind the tip to line 7 as though the process died between the append and the tip write.
  fs.writeFileSync(path.join(h.dir, TIP_FILENAME), JSON.stringify({ count: 7, hash: hashLine(rows[6]) }));

  const out = h.audit.verify();
  assert.equal(out.ok, true, 'lines after the anchor are what appending looks like');
});

test('a log with no tip beside it verifies as it always did, so an older data dir still reads', () => {
  const h = seeded();
  fs.unlinkSync(path.join(h.dir, TIP_FILENAME));
  assert.equal(h.audit.verify().ok, true);
  assert.equal(readTip(h.dir), null);
});

test('the edits the chain already caught are still caught', () => {
  const h = seeded();
  const rows = lines(h.file);
  const edited = [...rows];
  edited[3] = JSON.stringify({ ...(JSON.parse(rows[3]) as object), msg: 'something else' });
  write(h.file, edited);
  assert.equal(h.audit.verify().ok, false, 'an edited line');

  const h2 = seeded();
  const rows2 = lines(h2.file);
  write(h2.file, [...rows2.slice(0, 3), ...rows2.slice(4)]);
  assert.equal(h2.audit.verify().ok, false, 'a deleted middle line');
});

test('verifyChain without a tip is unchanged, so the walk is still the walk', () => {
  const h = seeded();
  assert.equal(verifyChain(lines(h.file)).ok, true);
  assert.equal(verifyChain(lines(h.file).slice(0, 4)).ok, true, 'no anchor, no truncation check');
});


/* The chain walk runs AFTER the port opens now (src/main.ts), so health answers `checking` until
   it lands. These tests wait for the answer rather than reading the placeholder: what they are
   about is what the walk found, not when. */
async function chainAnswer(port: number, deadlineMs = 20_000): Promise<{ auditChain: string; lastError: string | null }> {
  const until = Date.now() + deadlineMs;
  for (;;) {
    const health = (await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()) as {
      auditChain: string;
      lastError: string | null;
    };
    if (health.auditChain !== 'checking' || Date.now() > until) return health;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/* ---------- the chain is actually checked now ----------

   verify() had no caller outside the tests: nothing on boot, no route, not health. A chain that
   is never walked in production detects nothing, however good the walk is. */
test('a real boot on a truncated log says so through health rather than starting quietly', async () => {
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

  const dir = tmpDir();
  const seed = createAudit(dir);
  for (let i = 0; i < 10; i += 1) seed.append('tool_call', `line ${i}`);
  seed.flushTip();
  const file = path.join(dir, 'audit.jsonl');
  write(file, lines(file).slice(0, 5)); // the newest five removed

  const port = 4360 + Math.floor(Math.random() * 30);
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

  try {
    const up = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 25_000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (!chunk.includes(`http://127.0.0.1:${port}`)) return;
        clearTimeout(timer);
        resolve(true);
      });
    });
    assert.ok(up, 'the app still starts: taking away the window they would read this in helps nobody');

    const health = await chainAnswer(port);
    assert.match(health.auditChain, /^broken: truncated/, `health said ${health.auditChain}`);
    assert.match(String(health.lastError), /the audit log is damaged/);
  } finally {
    child.kill('SIGKILL');
  }
});

test('an intact log boots reporting ok', async () => {
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

  const dir = tmpDir();
  const seed = createAudit(dir);
  for (let i = 0; i < 5; i += 1) seed.append('tool_call', `line ${i}`);
  seed.flushTip();

  const port = 4390 + Math.floor(Math.random() * 30);
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

  try {
    const up = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 25_000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (chunk.includes(`http://127.0.0.1:${port}`)) {
          clearTimeout(timer);
          resolve(true);
        }
      });
    });
    assert.ok(up);
    // Read once before the walk can have finished: the port is open and the answer is not in yet,
    // which is the whole point of moving the walk behind listen.
    const early = (await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()) as { auditChain: string };
    assert.equal(early.auditChain, 'checking', 'the port answered before the chain had been walked');

    assert.equal((await chainAnswer(port)).auditChain, 'ok');
  } finally {
    child.kill('SIGKILL');
  }
});
