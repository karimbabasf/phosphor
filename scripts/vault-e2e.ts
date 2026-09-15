// The vault, end to end, with the real backend and the real Secure Enclave and no window.
//
// This script stands in for two things at once. For the Tauri shell: it mints the four-line
// handshake, pipes it to a fresh backend, and runs the relay loop exactly as
// src-tauri/src/enclave.rs does, with the built sidecar and a real Touch ID. For the window: it
// posts the vault verbs with the window token, the way the page does. Everything runs against a
// throwaway data directory on a free port; ~/.phosphor is never touched.
//
// Three Touch ID prompts: confirm the new wallet, open it, reveal the phrase. Run with the app
// closed, watching the screen.
//
//   npm run se:build && node scripts/vault-e2e.ts

import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TRIPLE = process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
const HELPER = path.join(ROOT, 'src-tauri', 'binaries', `se-helper-${TRIPLE}`);

type Json = Record<string, any>;
const checks: Array<{ label: string; ok: boolean }> = [];
function check(label: string, ok: boolean, detail = ''): boolean {
  checks.push({ label, ok });
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${label}${detail ? `   ${detail}` : ''}`);
  return ok;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function helper(req: Json): Json {
  return JSON.parse(execFileSync(HELPER, { input: JSON.stringify(req) + '\n' }).toString()) as Json;
}

async function main(): Promise<number> {
  if (!fs.existsSync(HELPER)) {
    console.error(`no sidecar at ${HELPER}; run npm run se:build first`);
    return 2;
  }
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-vault-e2e-'));
  fs.mkdirSync(path.join(dataDir, 'state'), { recursive: true });
  // A key file of its own, in the throwaway directory: never the one under ~/.phosphor.
  fs.writeFileSync(path.join(dataDir, 'config.local.json'), JSON.stringify({ port, mode: 'demo' }));
  const keysPath = path.join(dataDir, 'keys', 'keys.json');

  const token = crypto.randomBytes(32).toString('hex');
  const nonce = crypto.randomBytes(32).toString('hex');
  const seat = crypto.randomBytes(32).toString('hex');
  const transportHex = crypto.randomBytes(32).toString('hex');
  const transport = Buffer.from(transportHex, 'hex');

  const child = spawn(process.execPath, ['src/main.ts'], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      PHOSPHOR_DATA_DIR: path.join(dataDir, 'state'),
      PHOSPHOR_CONFIG_DIR: dataDir,
      PHOSPHOR_APP_DATA: '1',
      PHOSPHOR_KEYS: keysPath,
      PHOSPHOR_PORT: String(port),
      ACC_MODE: 'demo',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const output: string[] = [];
  child.stdout.on('data', (d: Buffer) => output.push(d.toString()));
  child.stderr.on('data', (d: Buffer) => output.push(d.toString()));
  child.stdin.write(`${token}\n${nonce}\n${seat}\n${transportHex}\n`);
  child.stdin.end();

  async function post(route: string, body: Json): Promise<Json> {
    const res = await fetch(`${base}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ token, ...body }),
    });
    if (!res.headers.get('x-phosphor')?.toLowerCase().includes(nonce.toLowerCase())) {
      throw new Error(`the answer on ${route} did not carry this boot's nonce`);
    }
    return (await res.json()) as Json;
  }
  async function get(route: string): Promise<Json> {
    const res = await fetch(`${base}${route}`);
    return (await res.json()) as Json;
  }

  // Wait for the port.
  const deadline = Date.now() + 30_000;
  let up = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) {
        up = true;
        break;
      }
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!check('the backend came up with a four-line handshake', up, output.join('').slice(-300))) {
    child.kill('SIGKILL');
    return 1;
  }

  // The relay, as the shell runs it: one request at a time, the sidecar answers, the transport
  // key is added and nothing else.
  let relaying = true;
  const relayed: string[] = [];
  const relay = (async () => {
    while (relaying) {
      let pending: Json;
      try {
        pending = await post('/api/vault/pending', { waitMs: 2000 });
      } catch {
        break;
      }
      const request = pending.request as Json | null;
      if (!request) continue;
      relayed.push(`${request.op}:${request.reason ?? ''}`);
      const answer = helper({ ...request, transportKey: transport.toString('base64') });
      await post('/api/vault/answer', { ...answer, id: request.id });
    }
  })();

  try {
    // The probe the backend sent at boot is answered by the relay above; wait for it.
    let status: Json = {};
    for (let i = 0; i < 50; i += 1) {
      status = await get('/api/vault');
      if (status.enclave?.ready === true) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    check('the backend sees the enclave through the relay', status.enclave?.ready === true, JSON.stringify(status.enclave));
    check('no wallet yet', status.custody === null);

    console.log('\n>> Touch ID 1 of 3: confirm the new wallet');
    const made = await post('/api/vault/create', {});
    check('create: one call, one touch, an enclave wallet', made.ok === true && made.custody === 'secure-enclave', JSON.stringify(made).slice(0, 200));
    check('create hands out no phrase', made.mnemonic === undefined);
    const file = JSON.parse(fs.readFileSync(path.join(path.dirname(keysPath), 'keys.enc.json'), 'utf8')) as Json;
    check('the file on disk is version 2 with no KDF and an enclave key', file.header?.version === 2 && file.header?.kdf === undefined && typeof file.header?.enclave?.keyBlob === 'string');
    check('the file carries no password wrap', file.wrap?.iv === undefined && typeof file.wrap?.ephemeralPublicKey === 'string');

    const locked = await post('/api/lock', { reason: 'e2e' });
    check('lock', locked.ok === true);
    check('locked, a password opens nothing', (await post('/api/unlock', { password: 'whatever' })).code === 'enclave_required');

    console.log('\n>> Touch ID 2 of 3: open the vault');
    const opened = await post('/api/vault/unlock', {});
    check('unlock with Touch ID', opened.ok === true, JSON.stringify(opened));
    const state = await get('/api/state');
    check('the state says unlocked, verified addresses, enclave custody', state.lock?.state === 'unlocked' && state.lock?.verified === true && state.vault?.custody === 'secure-enclave');
    check('the state payload names no key material', !/"(privateKey|secretKey|mnemonic|password)"/.test(JSON.stringify(state)));

    console.log('\n>> Touch ID 3 of 3: reveal the phrase');
    const revealed = await post('/api/vault/reveal', {});
    const words = (revealed.words ?? []) as string[];
    check('reveal takes its own touch and returns twelve words once', revealed.ok === true && words.length === 12);
    const proven = await post('/api/vault/backup-proven', { words: [{ index: 0, word: words[0] }, { index: 5, word: words[5] }, { index: 11, word: words[11] }] });
    check('three words typed back prove the backup', proven.ok === true, JSON.stringify(proven));
    check('the vault says backed up', (await get('/api/vault')).backedUp === true);

    const deposit = await post('/api/deposit/show', { chain: 'sol', symbol: 'SOL', address: null });
    check('the deposit card can be opened and watched', deposit.ok === true && deposit.deposit?.phase === 'watching');

    const log = (await get('/api/log?limit=100')) as Json;
    const logText = JSON.stringify(log);
    check('the audit log has the enclave lines and none of the words', /Secure Enclave|Touch ID/.test(logText) && !words.some((w) => logText.includes(`"${w}"`)));

    const dialogs = relayed.filter((r) => r.startsWith('unwrap:'));
    check('every dialog named itself', dialogs.length === 3 && dialogs.every((d) => d.split(':')[1].length > 10), dialogs.join(' | '));
  } catch (err) {
    check('no exception', false, err instanceof Error ? err.message : String(err));
  } finally {
    relaying = false;
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 1500));
    if (child.exitCode === null) child.kill('SIGKILL');
    await relay.catch(() => undefined);
  }

  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  if (failed > 0) console.log(output.join('').slice(-2000));
  return failed === 0 ? 0 : 1;
}

process.exit(await main());
