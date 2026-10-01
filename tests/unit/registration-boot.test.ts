// A throwaway boot leaves every agent's settings byte for byte as they were.
//
// On 2026-10-01 a check run of the app on a throwaway data folder, its pick Grok, ran
// `grok mcp add phosphor --scope user` at boot and pointed the real ~/.grok/config.toml at a port
// and a folder that were gone an hour later. Only the app on its own data folder writes a
// registration now (src/agents-catalog.ts ownsAgentSettings). This boots the real src/main.ts the
// way that run did, on a scratch folder under a fake HOME whose four vendors are on PATH, signed
// in, and write their own config on `mcp add` or `mcp remove` as the real ones do; then picks each
// of them through the window's own route. Every config file must come out identical, and no vendor
// may have been asked to change anything.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { writePick } from '../../src/agents-catalog.ts';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

// Each fake answers its catalog check as a signed-in install and, like the real command, writes
// its own config file on any `mcp` call. Every call is logged beside it.
const VENDORS: Record<string, { config: string; answers: string }> = {
  claude: {
    config: '.claude.json',
    answers: `  --version) echo "2.1.287 (Claude Code)" ;;\n  auth) printf '%s\\n' '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}' ;;`,
  },
  codex: {
    config: '.codex/config.toml',
    answers: '  --version) echo "codex-cli 0.154.0" ;;\n  login) echo "Logged in using ChatGPT" ;;',
  },
  grok: {
    config: '.grok/config.toml',
    answers: '  --version) echo "grok 1.0.40 (eb1a2256660d) [stable]" ;;\n  inspect) echo "{}" ;;',
  },
  hermes: {
    config: '.hermes/config.yaml',
    answers: "  --version) echo \"Hermes Agent v0.21.3 (2026.9.14)\" ;;\n  config) printf 'default: z-ai/glm-5.3\\nprovider: openrouter\\n' ;;",
  },
};

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => (port > 0 && port !== 4177 ? resolve(port) : reject(new Error('no free port'))));
    });
    probe.on('error', reject);
  });
}

function digests(home: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, v] of Object.entries(VENDORS)) {
    out[name] = crypto.createHash('sha256').update(fs.readFileSync(path.join(home, v.config))).digest('hex');
  }
  return out;
}

test('a boot on a throwaway folder, and a pick of every vendor in it, leaves a fake HOME\'s vendor configs byte-identical', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-fake-home-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-throwaway-boot-'));
  const bin = path.join(home, 'bin');
  const calls = path.join(home, 'vendor-calls.txt');
  fs.mkdirSync(bin);
  for (const [name, v] of Object.entries(VENDORS)) {
    const config = path.join(home, v.config);
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, `# ${name} settings the person wrote\n[mcp_servers.other]\ncommand = "other"\n`);
    fs.writeFileSync(
      path.join(bin, name),
      [
        '#!/bin/sh',
        `printf '%s\\n' "${name} $*" >> ${JSON.stringify(calls)}`,
        'case "$1" in',
        v.answers,
        `  mcp) printf '%s\\n' "[mcp_servers.phosphor] $*" >> ${JSON.stringify(config)} ;;`,
        'esac',
        'exit 0',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
  }
  // Grok's catalog check reads whether a login is stored: a JSON object with one entry (src/agents-catalog.ts grokLogin).
  fs.writeFileSync(path.join(home, '.grok', 'auth.json'), '{"fake":true}');
  // The incident's own setup: Grok picked on the scratch folder before the boot.
  writePick(dataDir, 'grok');
  const before = digests(home);

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const token = crypto.randomBytes(32).toString('hex');
  const env: NodeJS.ProcessEnv = { HOME: home, PATH: `${bin}:/usr/bin:/bin`, ACC_PORT: String(port), ACC_MODE: 'demo', ACC_DATA_DIR: dataDir };
  const app = spawn(process.execPath, ['src/main.ts'], { cwd: ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const output: string[] = [];
  app.stdout.on('data', (d: Buffer) => output.push(String(d)));
  app.stderr.on('data', (d: Buffer) => output.push(String(d)));
  app.stdin.write(`${token}\n`);
  app.stdin.end();
  try {
    let up = false;
    for (let i = 0; i < 200 && !up; i++) {
      try {
        up = (await fetch(`${base}/api/state`)).ok;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    assert.ok(up, `the app did not boot: ${output.join('').slice(-400)}`);

    /* The boot's own refresh (src/main.ts refreshRegistration) starts before the port opens. A
       write would show in the calls log within a few milliseconds; a second and a half is the
       wait for one that never comes. */
    const vendorCalls = (): string[] => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : []);
    for (let i = 0; i < 15 && !vendorCalls().some((line) => / mcp( |$)/.test(line)); i++) await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(digests(home), before, 'the boot changed a vendor config');

    for (const agent of Object.keys(VENDORS)) {
      const res = await fetch(`${base}/api/driver`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify({ action: 'agent-pick', agent, token }),
      });
      const json = (await res.json()) as Record<string, unknown>;
      assert.equal(res.status, 200, agent);
      assert.equal((json.check as Record<string, unknown>).state, 'installed_and_logged_in', `${agent}: ${JSON.stringify(json.check)}`);
      assert.equal(json.registered, false, agent);
      assert.equal(json.registrationSkipped, true, agent);
    }
    assert.deepEqual(digests(home), before, 'a pick changed a vendor config');
    const asked = vendorCalls();
    assert.deepEqual(asked.filter((line) => / mcp( |$)/.test(line)), [], 'a vendor was asked to change its settings');
    assert.ok(asked.some((line) => line.startsWith('grok --version')), 'the vendors were found and checked, so the test reached the write');
  } finally {
    app.kill('SIGKILL');
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
