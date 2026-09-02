// The window token arrives on stdin, and stdin is closed behind it.
//
// It used to arrive in PHOSPHOR_WINDOW_TOKEN. `ps eww <pid>` prints the environment of any process
// this user owns, which is the attacker this app is built against, so any same-user process read
// the token back and drove every route that decides anything: the kill switch, the idle beacon,
// the driver prompt, and approve on a real pending proposal, which the audit then recorded as
// decidedBy 'human'. That is the whole of the capability GET /api/session used to hand out,
// reopened through a second channel. The runner already fixed this exact channel for the
// Hyperliquid key (src/runner/host.ts) and said why; the token had not followed.
//
// A pipe has two ends and no third reader. The environment has as many readers as the machine has
// processes.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { readWindowToken, WINDOW_TOKEN_VAR } from '../../src/http/auth.ts';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

function line(token: string): PassThrough {
  const stream = new PassThrough();
  stream.end(`${token}\n`);
  return stream;
}

test('a token written as the first line of stdin is the token this boot answers to', async () => {
  const sent = crypto.randomBytes(32).toString('hex');
  const got = await readWindowToken({ stdin: line(sent), waitMs: 500 });
  assert.equal(got, sent);
});

test('trailing whitespace and a missing newline are both read the same way', async () => {
  const sent = crypto.randomBytes(32).toString('hex');
  const padded = new PassThrough();
  padded.end(`  ${sent}  \n`);
  assert.equal(await readWindowToken({ stdin: padded, waitMs: 500 }), sent);

  const bare = new PassThrough();
  bare.end(sent); // no newline, and the stream ends
  assert.equal(await readWindowToken({ stdin: bare, waitMs: 500 }), sent);
});

test('only the first line is read, so nothing after it is treated as a second token', async () => {
  const sent = crypto.randomBytes(32).toString('hex');
  const stream = new PassThrough();
  stream.end(`${sent}\nsomething else entirely\n`);
  assert.equal(await readWindowToken({ stdin: stream, waitMs: 500 }), sent);
});

test('a terminal mints one at once and says so on stderr, without waiting', async () => {
  const tty = new PassThrough() as PassThrough & { isTTY?: boolean };
  tty.isTTY = true;
  const said: string[] = [];

  const started = Date.now();
  const got = await readWindowToken({ stdin: tty, waitMs: 5_000, onMinted: (t) => said.push(t) });

  assert.equal(got.length, 64);
  assert.deepEqual(said, [got], 'a developer running this by hand is told the token once');
  assert.ok(Date.now() - started < 1_000, 'nobody is going to pipe a token into a terminal');
});

test('a pipe that closes with nothing in it mints one rather than hanging', async () => {
  const empty = new PassThrough();
  empty.end();
  const got = await readWindowToken({ stdin: empty, waitMs: 5_000 });
  assert.equal(got.length, 64);
});

test('a short line is a truncated write, not a shorter secret, so it is not accepted', async () => {
  const got = await readWindowToken({ stdin: line('too-short'), waitMs: 500 });
  assert.equal(got.length, 64, 'minted instead');
});

/* The shell injected a token into the webview before it started this process. Minting a different
   one would leave a window that cannot approve anything and no sentence saying why, so the shell
   path fails loudly instead. PHOSPHOR_APP_DATA=1 is how the shell says it is the shell. */
test('a shell child that receives no token refuses to boot rather than minting a private one', async () => {
  const empty = new PassThrough();
  empty.end();
  await assert.rejects(
    () => readWindowToken({ stdin: empty, waitMs: 100, fromShell: true }),
    /the window token never arrived/,
  );
});

test('the environment variable is not a way in any more', async () => {
  const stale = crypto.randomBytes(32).toString('hex');
  const empty = new PassThrough();
  empty.end();
  const got = await readWindowToken({ stdin: empty, waitMs: 200, env: { [WINDOW_TOKEN_VAR]: stale } });
  assert.notEqual(got, stale, 'a token in the environment is a token any process can read');
});

// The whole point, against a real backend: the token reaches it and `ps eww` cannot show it.
test('a real backend takes its token off stdin, and ps cannot read it back', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-tokenpipe-'));
  const token = crypto.randomBytes(32).toString('hex');
  const port = 4300 + Math.floor(Math.random() * 60);

  const child = spawn(process.execPath, ['src/main.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PHOSPHOR_MODE: 'demo',
      PHOSPHOR_PORT: String(port),
      PHOSPHOR_DATA_DIR: dataDir,
      PHOSPHOR_KEYS: path.join(dataDir, 'keys.enc.json'),
      PHOSPHOR_NO_PARENT_WATCH: '1',
      PHOSPHOR_WINDOW_TOKEN: '',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.write(`${token}\n`);
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
    assert.ok(up, 'the backend never came up');

    // The token works, which is what makes the rest of this test mean anything.
    const origin = `http://127.0.0.1:${port}`;
    const armed = await fetch(`${origin}/api/kill`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ on: false, token }),
    });
    assert.equal(armed.status, 200, 'the token that went down the pipe is the one it answers to');

    // And it is nowhere an unrelated process can read it.
    const env = execFileSync('ps', ['eww', '-p', String(child.pid)], { encoding: 'utf8' });
    assert.ok(!env.includes(token), 'the token is in the process environment, where any process can read it');
    assert.ok(!/PHOSPHOR_WINDOW_TOKEN=\w/.test(env), 'the variable is set at all');
  } finally {
    child.kill('SIGKILL');
  }
});
