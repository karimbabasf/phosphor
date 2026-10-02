// Vendor configs. On 2026-10-01 a throwaway boot with Grok picked ran `grok mcp add phosphor
// --scope user` and pointed the person's real ~/.grok/config.toml at a port and a folder that were
// gone an hour later (gate.md item 6). The rule since (gate.md item 9): only the app the Tauri shell
// started on its own data folder writes an agent registration; any other boot writes into no
// vendor's settings (src/agents-catalog.ts ownsAgentSettings, checked inside registerAgent).
//
// The attack: a throwaway HOME seeded with every vendor config the app knows how to write
// (Claude Code's ~/.claude.json and ~/.claude/settings.json, Codex, Grok, Hermes) with known bytes;
// each vendor on PATH as a fake that answers its catalog check as signed in and, like the real one,
// rewrites its own config on any `mcp` call. Grok is picked on the data dir before boot (the
// incident's setup), the app boots the way the shell starts it, and then all four are picked
// through the window's own route. Expected: every file byte-identical, no vendor asked to `mcp`.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { bootBackend, fakeHome, rmTemp, sleep, tmpDir } from '../harness.ts';
import type { AttackCase, AttackCtx, AttackResult } from '../types.ts';
import { writePick } from '../../../src/agents-catalog.ts';

const VENDORS: Record<string, { config: string; answers: string }> = {
  claude: {
    config: '.claude.json',
    answers: `  --version) echo "2.1.287 (Claude Code)" ;;\n  auth) printf '%s\\n' '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}' ;;`,
  },
  codex: { config: '.codex/config.toml', answers: '  --version) echo "codex-cli 0.154.0" ;;\n  login) echo "Logged in using ChatGPT" ;;' },
  grok: { config: '.grok/config.toml', answers: '  --version) echo "grok 1.0.40 (eb1a2256660d) [stable]" ;;\n  inspect) echo "{}" ;;' },
  hermes: {
    config: '.hermes/config.yaml',
    answers: "  --version) echo \"Hermes Agent v0.21.3 (2026.9.14)\" ;;\n  config) printf 'default: z-ai/glm-5.3\\nprovider: openrouter\\n' ;;",
  },
};
// Watched besides the four the fakes write: Claude Code's user settings file.
const EXTRA = ['.claude/settings.json'];

const sha = (file: string): string => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export const attack: AttackCase = {
  id: '09-vendor-configs',
  title: "a throwaway boot and a pick of every agent leave the user's vendor configs byte-identical",
  async run(_ctx: AttackCtx): Promise<AttackResult> {
    const home = fakeHome();
    const dataDir = tmpDir('data-vendor');
    const bin = path.join(home, 'bin');
    const calls = path.join(home, 'vendor-calls.txt');
    fs.mkdirSync(bin);
    const files: string[] = [];
    for (const [name, v] of Object.entries(VENDORS)) {
      const config = path.join(home, v.config);
      fs.mkdirSync(path.dirname(config), { recursive: true });
      fs.writeFileSync(config, `# ${name} settings the person wrote, marker ${crypto.randomBytes(8).toString('hex')}\n[mcp_servers.other]\ncommand = "other"\n`);
      files.push(v.config);
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
    for (const rel of EXTRA) {
      fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
      fs.writeFileSync(path.join(home, rel), '{"permissions":{"allow":["Read"]},"mcpServers":{}}\n');
      files.push(rel);
    }
    fs.writeFileSync(path.join(home, '.grok', 'auth.json'), '{"fake":true}');
    writePick(dataDir, 'grok');
    const before = Object.fromEntries(files.map(f => [f, sha(path.join(home, f))]));

    const app = await bootBackend({
      home,
      dataDir,
      env: { PATH: `${bin}:/usr/bin:/bin` },
      // Anything that would aim a vendor at a config dir outside the fake HOME, or claim to be the shell.
      stripEnv: ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GROK_HOME', 'HERMES_HOME', 'PHOSPHOR_APP_DATA', 'PHOSPHOR_DATA_DIR'],
    });
    try {
      const vendorCalls = (): string[] => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean) : []);
      for (let i = 0; i < 15 && !vendorCalls().some(l => / mcp( |$)/.test(l)); i++) await sleep(100);
      const afterBoot = Object.fromEntries(files.map(f => [f, sha(path.join(home, f))]));

      const picks: string[] = [];
      for (const agent of Object.keys(VENDORS)) {
        const r = await app.post('/api/driver', { action: 'agent-pick', agent, token: app.token });
        picks.push(`${agent}:${r.status}/registered=${r.json?.registered}/skipped=${r.json?.registrationSkipped}/check=${r.json?.check?.state}`);
      }
      await sleep(300);
      const after = Object.fromEntries(files.map(f => [f, sha(path.join(home, f))]));
      const asked = vendorCalls();
      const mcpCalls = asked.filter(l => / mcp( |$)/.test(l));
      const reached = asked.some(l => l.startsWith('grok --version'));
      assert.ok(reached, `the vendors were never checked, so the case never reached the write: ${JSON.stringify(asked)}`);

      const moved = files.filter(f => before[f] !== afterBoot[f] || before[f] !== after[f]);
      const pass = moved.length === 0 && mcpCalls.length === 0;
      const short = (h: string | undefined): string => (h ?? '').slice(0, 12);
      return {
        expected: `all ${files.length} vendor config files byte-identical after boot (Grok picked) and after a pick of all four; no vendor sees an mcp call`,
        observed: `${moved.length ? `CHANGED: ${moved.join(', ')}` : 'all identical'}; vendor mcp calls=${mcpCalls.length}${mcpCalls.length ? ` ${JSON.stringify(mcpCalls)}` : ''}; picks ${picks.join(' ')}`,
        pass,
        evidence: `sha256 before/after: ${files.map(f => `${f} ${short(before[f])}/${short(after[f])}`).join(', ')}`,
      };
    } finally {
      await app.stop();
      rmTemp(home);
      rmTemp(dataDir);
    }
  },
};

export default attack;
