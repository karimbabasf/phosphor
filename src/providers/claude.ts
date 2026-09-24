// Claude Code as a provider: everything src/driver.ts used to know about driving Claude, moved
// here, so the core spawns, reads and kills without knowing which vendor it holds.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { agentById, findAgentBin } from '../agents-catalog.ts';
import type { Provider, SpawnInput, SpawnSpec, ToolCall } from './types.ts';

// Phosphor's own MCP tools are matched by prefix; every other name is a built-in. Read, Grep and
// Glob are absent on purpose: the CLI operator profile keeps them so a developer can read the code
// being driven, and the person using the desktop app is not that developer.
export const MCP_PREFIX = 'mcp__phosphor__';

/* The two built-ins the chat holds besides Phosphor's own, on Karim's decision of 2026-09-23: the
   agent has to be able to research anything (he asked it about NEAR AI and its sources were
   crypto-only). WebSearch finds the page; WebFetch reads one page and answers a focused question
   about it with a small model, which is the cheap way to get one value. `--tools` names exactly
   these two, operator/driver.settings.json allows exactly these two, and the surface check reads
   back that nothing else came with them. */
export const WEB_TOOLS: Readonly<Record<string, 'web_search' | 'web_fetch'>> = { WebSearch: 'web_search', WebFetch: 'web_fetch' };

// Where `claude` lives when nobody set a PATH. A GUI process launched from Finder inherits
// /usr/bin:/bin:/usr/sbin:/sbin and nothing else, so the install location every developer takes
// for granted is exactly the one the packaged app cannot see. The places are the catalog's
// (src/agents-catalog.ts), so the picker's check and this spawn find the same binary. Config
// wins, then PATH, then the catalog's places.
export function resolveClaudeBin(override?: string): string {
  if (override) {
    if (!fs.existsSync(override)) throw new Error(`driver: claudeBin is set to ${override}, which does not exist`);
    return override;
  }
  const entry = agentById('claude');
  const found = entry === null ? null : findAgentBin(entry);
  if (found !== null) return found;
  throw new Error(
    'driver: the claude CLI was not found. Install Claude Code, or set driver.claudeBin in config.json to its full path.',
  );
}

/* NOTHING CALLER-AUTHORED GOES IN ARGV. `ps -axo args=` prints the argv of any process this user
   owns, and a worker's persona is built around a brief another agent wrote (src/crew.ts). So the
   persona is a 0600 file in the app's own directory and the argv carries its path, never its
   text. It is the real system prompt: Claude Code's own coding-agent prompt is replaced rather
   than appended to, which is what cut the first call from 34K tokens (R3, 2026-09-23).
   --no-session-persistence keeps money chats out of ~/.claude/projects, and
   --include-partial-messages is what lets the window print an answer as it is written.
   findOrphans in src/driver.ts is unaffected: it matches on the settings path and the stream
   flags. */
export function buildArgv(opts: {
  repo: string;
  nodeBin: string;
  settings: string;
  sessionId: string;
  model?: string;
  systemPromptFile?: string;
}): string[] {
  const mcp = JSON.stringify({
    mcpServers: { phosphor: { command: opts.nodeBin, args: [path.join(opts.repo, 'src', 'mcp.ts')] } },
  });
  const argv = [
    '--print',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--no-session-persistence',
    '--settings',
    opts.settings,
    // No user, project or local settings. This is what keeps the machine's own hooks, plugins and
    // CLAUDE.md files out of a session that drives a wallet.
    '--setting-sources=',
    '--mcp-config',
    mcp,
    '--strict-mcp-config',
    // Never `bypassPermissions`, never `acceptEdits`. dontAsk refuses anything outside the allow
    // list instead of blocking on a prompt that has no terminal to appear in.
    '--permission-mode',
    'dontAsk',
    // The built-in set, named in full: the two web tools and nothing else (see WEB_TOOLS).
    '--tools',
    Object.keys(WEB_TOOLS).join(','),
    '--session-id',
    opts.sessionId,
  ];
  if (opts.systemPromptFile) argv.push('--system-prompt-file', opts.systemPromptFile);
  if (opts.model) argv.push('--model', opts.model);
  return argv;
}

// Refuse to drive when the child holds a tool the app did not expect. Returns the offending
// names, empty when the surface is clean.
export function assertSurface(tools: unknown): string[] {
  if (!Array.isArray(tools)) return ['<the init event carried no tool list>'];
  // An entry that is not a name is a list this app cannot read, so it counts against the session.
  return tools
    .filter((t) => typeof t !== 'string' || !(t.startsWith(MCP_PREFIX) || Object.hasOwn(WEB_TOOLS, t)))
    .map((t) => (typeof t === 'string' ? t : JSON.stringify(t)));
}

/* The built-ins this Claude Code release has, as the driver profile names them: every one but the
   web tools is on its deny list, and tests/lockdown.test.ts holds that list to the installed
   binary. Read once. A profile that cannot be read makes every name a built-in, the strict answer;
   the driver does not start without the profile anyway. */
let builtins: ReadonlySet<string> | null | undefined;
function claudeBuiltins(): ReadonlySet<string> | null {
  if (builtins !== undefined) return builtins;
  try {
    const profile = JSON.parse(fs.readFileSync(new URL('../../operator/driver.settings.json', import.meta.url), 'utf8')) as { permissions?: { deny?: unknown } };
    const deny = profile.permissions?.deny;
    builtins = Array.isArray(deny) ? new Set([...deny.filter((t): t is string => typeof t === 'string'), ...Object.keys(WEB_TOOLS)]) : null;
  } catch {
    builtins = null;
  }
  return builtins;
}

// The persona file for one session: in the app's own directory, readable by this user alone.
export function personaFile(home: string, sessionId: string): string {
  return path.join(home, `persona-${sessionId}.txt`);
}

function writePersona(home: string, sessionId: string, text: string): string | undefined {
  if (text === '') return undefined;
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = personaFile(home, sessionId);
  fs.writeFileSync(file, text, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

export const claude: Provider = {
  id: 'claude',
  name: 'Claude Code',
  transport: 'stdin',
  evidence:
    '2026-09-23: claude 2.1.281 with the harmless probe server: the init event listed only mcp__phosphor__ tools and memory_paths null, --system-prompt-file replaced the prompt (the reply opened with the probe word), --no-session-persistence left nothing in ~/.claude/projects, and --include-partial-messages streamed text_delta events ahead of each assistant block.',
  resolveBin: resolveClaudeBin,
  spawn(input: SpawnInput): SpawnSpec {
    return {
      bin: resolveClaudeBin(input.bin),
      argv: buildArgv({
        repo: input.repo,
        nodeBin: input.nodeBin,
        settings: input.settings,
        sessionId: input.sessionId,
        model: input.model || undefined,
        systemPromptFile: writePersona(input.home, input.sessionId, input.systemPrompt),
      }),
      cwd: input.repo,
      env: input.env,
    };
  },
  surface(init) {
    return assertSurface(init.tools);
  },
  tool(name, input, server): ToolCall {
    // Claude's web tools run in the CLI; a tool the API ran inside the reply was never asked for.
    if (server === true) return { kind: 'builtin', name: `server ${name}` };
    if (name.startsWith(MCP_PREFIX)) return { kind: 'phosphor', name, input };
    // Own keys only: `in` would also pass "constructor" and "toString".
    if (Object.hasOwn(WEB_TOOLS, name)) return { kind: 'web', name: WEB_TOOLS[name] };
    // Another server's tool, or a built-in the profile keeps out: a real tool, so the session ends.
    const known = claudeBuiltins();
    if (name.startsWith('mcp__') || known === null || known.has(name)) return { kind: 'builtin', name };
    return { kind: 'unknown', name };
  },
  result(content) {
    return content;
  },
  encodeTurn(text) {
    return `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })}\n`;
  },
  encodeInterrupt() {
    return `${JSON.stringify({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } })}\n`;
  },
  cleanup({ home, sessionId }) {
    fs.rmSync(personaFile(home, sessionId), { force: true });
  },
};
