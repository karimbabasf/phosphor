// Grok as a provider: one headless `grok` process per turn, resumed by the session id the app
// chose, holding Phosphor's MCP tools and grok's own web search and page reading, and nothing else.
//
// WHAT WAS MEASURED, 2026-09-23, grok 1.0.40, against a harmless probe MCP server (two tools, no
// Phosphor money tools) and then against the person's own grok home:
// - `--output-format streaming-messages-json` is Claude Code's stream-json: a system/init line
//   naming the built-in tools and the MCP servers, assistant messages with tool_use blocks, user
//   messages with tool_result blocks, and a result line. `--include-partial-messages` adds the
//   stream_event deltas. So the core's one parser reads both vendors.
// - Grok reaches MCP tools through two built-ins: search_tool finds one, use_tool calls it as
//   { tool_name: "phosphor__wallet", tool_input }. `--tools` is an allowlist and is named in full:
//   `--tools ''` left all nineteen built-ins (shell, file edits, image tools). A server that has
//   attached by the time the init line prints lists its tools there too, as phosphor__wallet and
//   the rest, and the model may call one by that name directly, so both spellings are Phosphor's.
// - `--permission-mode dontAsk` approves only what an --allow rule names: a use_tool call to a
//   second server was refused ("User cancelled the execution") and never reached it. Grok's rule
//   names for its web tools are WebSearch and WebFetch; `--allow web_fetch` matched nothing.
// - web_fetch read near.ai and answered "what is NEAR AI" in two lines. web_search is listed on
//   the init line but was never offered to the model on this account (tool_definitions.json held
//   search_tool, use_tool and web_fetch; web_search_requests 0 over three asks), so it is allowed
//   and reading pages is what actually works. The person's `[ui] permission_mode = "always-approve"`
//   does not outrank the dontAsk flag: an unallowed web_fetch was refused under it.
// - `--system-prompt-override` replaced the whole prompt (the recorded system_prompt.txt was the
//   text verbatim). An agent definition file (`--agent`) kept grok's own 6.7K prompt in front, so
//   the persona rides on argv, the one vendor where it does: it is the app's own text, and a
//   same-user process that can read argv can read the data directory it came from.
// - `--session-id <uuid>` names a new session and `--resume <uuid>` continues it; headless grok
//   reads no stdin (14-headless-mode.md), so the turn goes in a 0600 file.
//
// WHERE THE CHILD LIVES. GROK_HOME is the person's own grok home, so it runs on their own login and
// the app never copies a credential. HOME is <dataDir>/agents/grok, an empty directory this app
// owns: a grok under the person's HOME loads their ~/.claude instructions, plugins, hooks and MCP
// servers (measured on the feat/agent-providers branch), and HOME moved is the switch that clears
// them. Grok has no flag that adds an MCP server for one session, so the Phosphor server is the one
// the Vault registers in that home's config.toml (`grok mcp add phosphor`), written again at boot
// when it names a path or a port that moved (src/http/mutation.ts refreshRegistration).
//
// THE READ-BACK. The init line shows the tools and servers a turn holds, never what it loaded as
// context. `grok inspect --json` lists every hook, rule, plugin and server the child would load, in
// under a tenth of a second (measured: a probe hook and a probe rule both showed), so every turn
// reads it first, under the child's own environment and cwd. A turn that would load any hook,
// rule, plugin or server but Phosphor's, or that finds no Phosphor server, does not run.
//
// SESSIONS. grok keeps each session under GROK_HOME/sessions, keyed by this app's cwd, and beside
// them a prompt_history.jsonl of every prompt typed there: the person's words and the app's notes,
// in plain text (measured). A chat's session and that file are removed when the chat stops, so
// money chats do not pile up in the person's grok history. A chat the app never stopped (a crash)
// stays there until the person clears it.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { agentById, findAgentBin } from '../agents-catalog.ts';
import { MCP_PREFIX } from './claude.ts';
import type { Provider, SpawnInput, SpawnSpec, ToolCall } from './types.ts';

const META_TOOLS = ['search_tool', 'use_tool'] as const;
// Grok's own web search and page reading, by the names its stream and --tools use.
const WEB_TOOLS = ['web_search', 'web_fetch'] as const;
const SERVER = 'phosphor';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function resolveGrokBin(override?: string): string {
  const entry = agentById('grok');
  const found = entry === null ? null : findAgentBin(entry, { override });
  if (found !== null) return found;
  throw new Error(
    override
      ? `driver: the grok binary is set to ${override}, which does not exist`
      : 'driver: the grok CLI was not found. Install Grok, then pick it again.',
  );
}

// The person's own grok home: $GROK_HOME when the app was started with one, else ~/.grok, where
// `grok login` writes the login and `grok mcp add` the config.
export function userGrokHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.GROK_HOME || path.join(os.homedir(), '.grok');
}

export function userAuthFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(userGrokHome(env), 'auth.json');
}

export function turnFile(home: string, sessionId: string): string {
  return path.join(home, `turn-${sessionId}.txt`);
}

// Where grok keeps one session of this app's: sessions/<the cwd, URL-encoded>/<session id>.
export function sessionDir(grokHome: string, cwd: string, sessionId: string): string {
  return path.join(grokHome, 'sessions', encodeURIComponent(cwd), sessionId);
}

// Every harness-compatibility cell off (05-configuration.md), memory and sub-agents off, the update
// check off, each a documented variable. Page reading on (off by default in this release).
const QUIET: Record<string, string> = {
  GROK_CLAUDE_SKILLS_ENABLED: '0',
  GROK_CLAUDE_RULES_ENABLED: '0',
  GROK_CLAUDE_AGENTS_ENABLED: '0',
  GROK_CLAUDE_MCPS_ENABLED: '0',
  GROK_CLAUDE_HOOKS_ENABLED: '0',
  GROK_CLAUDE_SESSIONS_ENABLED: '0',
  GROK_CURSOR_SKILLS_ENABLED: '0',
  GROK_CURSOR_RULES_ENABLED: '0',
  GROK_CURSOR_AGENTS_ENABLED: '0',
  GROK_CURSOR_MCPS_ENABLED: '0',
  GROK_CURSOR_HOOKS_ENABLED: '0',
  GROK_CURSOR_SESSIONS_ENABLED: '0',
  GROK_CODEX_SESSIONS_ENABLED: '0',
  GROK_MEMORY: '0',
  GROK_SUBAGENTS: '0',
  GROK_WEB_FETCH: '1',
  GROK_DISABLE_AUTOUPDATER: '1',
  /* A recap, a turn summary and an early title refresh are each a second model call over the
     chat after the answer, which kept every turn's process up about four seconds past its result
     line (measured) and sent the money chat to the model a second time. Remote campaign patches
     and session search have no place in a locked-down seat either. */
  GROK_SESSION_RECAP: '0',
  GROK_TURN_SUMMARY: '0',
  GROK_TITLE_REFRESH: '0',
  GROK_CAMPAIGNS: '0',
  GROK_SESSION_SEARCH: '0',
  GROK_AUTO_WAKE: '0',
  GROK_FEEDBACK_ENABLED: '0',
  /* Session trace upload follows a remote setting that was on for this account (off only because
     it is a zero-retention team, the log said): a trace of a money chat carries its balances and
     addresses. Product analytics go with it. */
  GROK_TELEMETRY_TRACE_UPLOAD: '0',
  GROK_TELEMETRY_ENABLED: '0',
};

// What grok would load that Phosphor did not put there: every hook, rule, plugin and language
// server, and every enabled MCP server but phosphor, and no phosphor server at all. Empty is the
// only answer a turn runs on, and a list this app cannot read counts against it.
export function foreignContext(inspectJson: string): string[] {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(inspectJson) as Record<string, unknown>;
  } catch {
    return ['an inspect answer this app cannot read'];
  }
  if (parsed === null || typeof parsed !== 'object') return ['an inspect answer this app cannot read'];
  const found: string[] = [];
  for (const key of ['hooks', 'projectInstructions', 'plugins', 'lspServers']) {
    const list = parsed[key];
    if (list === undefined && key === 'lspServers') continue;
    if (!Array.isArray(list)) found.push(`no ${key} list`);
    else if (list.length > 0) found.push(`${list.length} ${key}`);
  }
  const servers = parsed.mcpServers;
  if (!Array.isArray(servers)) found.push('no mcpServers list');
  else {
    const rows = servers as Array<Record<string, unknown>>;
    for (const row of rows) if (row?.disabled !== true && row?.name !== SERVER) found.push(`server ${String(row?.name)}`);
    if (!rows.some((row) => row?.name === SERVER && row?.disabled !== true)) found.push('no phosphor server');
  }
  return found;
}

function readBack(bin: string, cwd: string, env: NodeJS.ProcessEnv): string[] {
  try {
    const out = execFileSync(bin, ['inspect', '--json'], { cwd, env, timeout: 4000, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    return foreignContext(out);
  } catch {
    return ['an inspect that did not answer'];
  }
}

// The sentence for a read-back that refused the turn, by what it found.
function refusal(found: string[]): string {
  if (found.includes('no phosphor server')) {
    return "Grok isn't connected to this copy of Phosphor yet. Pick Grok again in the Vault, then start it.";
  }
  return 'Your Grok setup loads hooks, rules, plugins or other tool servers Phosphor did not put there, so Grok will not start here.';
}

export function buildGrokArgv(opts: { promptFile: string; sessionId: string; resume: boolean; systemPrompt: string; model?: string }): string[] {
  const argv = [
    '--prompt-file', opts.promptFile,
    '--output-format', 'streaming-messages-json',
    '--include-partial-messages',
    '--tools', [...META_TOOLS, ...WEB_TOOLS].join(','),
    '--permission-mode', 'dontAsk',
    '--allow', `MCPTool(${SERVER}__*)`,
    '--allow', 'WebSearch',
    '--allow', 'WebFetch',
    '--disallowed-tools', 'Agent',
    '--no-subagents',
    '--no-plan',
    '--no-auto-update',
    '--verbatim',
    '--max-turns', '24',
    opts.resume ? '--resume' : '--session-id', opts.sessionId,
  ];
  if (opts.systemPrompt !== '') argv.push('--system-prompt-override', opts.systemPrompt);
  if (opts.model) argv.push('-m', opts.model);
  return argv;
}

function text(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (block !== null && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
      const t = (block as { text?: unknown }).text;
      if (typeof t === 'string') return t;
    }
  }
  return null;
}

export const grok: Provider = {
  id: 'grok',
  name: 'Grok',
  transport: 'turn',
  evidence:
    '2026-09-23: grok 1.0.40 with a harmless probe server: init listed ["search_tool","use_tool"] under --tools search_tool,use_tool and the one configured server; use_tool reached phosphor__ping; a use_tool call to a second server was refused under dontAsk and never arrived; --system-prompt-override was the recorded system prompt verbatim; --session-id then --resume kept the thread; text_delta stream_events arrived ahead of each assistant message. With the person\'s own GROK_HOME and --allow WebFetch, web_fetch read near.ai and answered in two lines.',
  resolveBin: resolveGrokBin,
  spawn(input: SpawnInput): SpawnSpec {
    const bin = resolveGrokBin(input.bin);
    fs.mkdirSync(input.home, { recursive: true, mode: 0o700 });
    const env: NodeJS.ProcessEnv = { ...input.env, ...QUIET, HOME: input.home, GROK_HOME: userGrokHome() };
    delete env.CLAUDE_CONFIG_DIR;
    delete env.CLAUDE_CODE_DISABLE_AUTO_MEMORY;
    const foreign = readBack(bin, input.home, env);
    if (foreign.length > 0) {
      throw Object.assign(new Error(`driver: grok would load what Phosphor did not put there (${foreign.join(', ')})`), { reason: refusal(foreign) });
    }
    // One file per chat: up to four chats share this home, and a shared file would hand one chat's
    // turn to another's process if two sent at once.
    const promptFile = turnFile(input.home, input.sessionId);
    fs.writeFileSync(promptFile, input.prompt ?? '', { mode: 0o600 });
    fs.chmodSync(promptFile, 0o600);
    return {
      bin,
      argv: buildGrokArgv({ promptFile, sessionId: input.sessionId, resume: input.resume === true, systemPrompt: input.systemPrompt, model: input.model }),
      cwd: input.home,
      env,
    };
  },
  surface(init) {
    const found: string[] = [];
    const allowed: readonly string[] = [...META_TOOLS, ...WEB_TOOLS];
    const tools = Array.isArray(init.tools) ? init.tools : null;
    if (tools === null) found.push('<the init event carried no tool list>');
    else for (const t of tools) if (typeof t !== 'string' || !(allowed.includes(t) || t.startsWith(`${SERVER}__`))) found.push(String(t));
    const servers = Array.isArray(init.mcp_servers) ? (init.mcp_servers as Array<Record<string, unknown>>) : [];
    for (const s of servers) if (s.name !== SERVER) found.push(`server ${String(s.name)}`);
    return found;
  },
  tool(name, input, server): ToolCall {
    // A server-run block is grok's backend web search, inline in the reply, and nothing else.
    if (server === true) return name === 'web_search' ? { kind: 'web', name: 'web_search' } : { kind: 'builtin', name: `server ${name}` };
    if (name === 'search_tool') return { kind: 'meta' };
    if ((WEB_TOOLS as readonly string[]).includes(name)) return { kind: 'web', name: name as 'web_search' | 'web_fetch' };
    if (name.startsWith(`${SERVER}__`)) return { kind: 'phosphor', name: `${MCP_PREFIX}${name.slice(SERVER.length + 2)}`, input };
    if (name === 'use_tool' && input !== null && typeof input === 'object') {
      const call = input as { tool_name?: unknown; tool_input?: unknown };
      if (typeof call.tool_name === 'string' && call.tool_name.startsWith(`${SERVER}__`)) {
        return { kind: 'phosphor', name: `${MCP_PREFIX}${call.tool_name.slice(SERVER.length + 2)}`, input: call.tool_input ?? {} };
      }
      return { kind: 'builtin', name: `use_tool ${String(call.tool_name)}` };
    }
    return { kind: 'builtin', name };
  },
  /* use_tool answers { type: "MCP", tool_name, server_name, output: { OkayOutput: "<the tool's
     own text>" } } (measured). The tool's text is what the card is drawn from; any other output
     is an error grok is reporting, not an answer. */
  result(content) {
    const raw = text(content);
    if (raw === null) return content;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return content;
    }
    const wrap = parsed as { type?: unknown; output?: Record<string, unknown> };
    if (wrap === null || typeof wrap !== 'object' || wrap.type !== 'MCP') return content;
    const ok = wrap.output?.OkayOutput;
    return typeof ok === 'string' ? ok : null;
  },
  cleanup({ home, sessionId }) {
    fs.rmSync(turnFile(home, sessionId), { force: true });
  },
  // The chat's session, out of the person's grok history. Only an id this app minted is removed,
  // under the home as the app named it and as grok's getcwd resolved it.
  endSession({ home, sessionId }) {
    if (!UUID.test(sessionId)) return;
    let real = home;
    try {
      real = fs.realpathSync(home);
    } catch {
      /* no home, so no session in it either */
    }
    for (const cwd of new Set([home, real])) {
      const dir = sessionDir(userGrokHome(), cwd, sessionId);
      fs.rmSync(dir, { recursive: true, force: true });
      // Every line in it is a Phosphor chat's: the folder is the app's own cwd.
      fs.rmSync(path.join(path.dirname(dir), 'prompt_history.jsonl'), { force: true });
      try {
        fs.rmdirSync(path.dirname(dir)); // the app's folder in grok's history, once it is empty
      } catch {
        /* another chat's session is still in it, or it was never there */
      }
    }
  },
};
