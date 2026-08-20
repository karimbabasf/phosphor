// The driver's seat: Phosphor spawns the agent instead of waiting for one to connect.
//
// Everything else in this app assumes the agent arrives from outside, over the MCP handshake in
// src/mcp.ts. That stays true and is not weakened here. This adds a second way in: the app starts
// a headless Claude Code process itself, hands it the same MCP server, and streams the
// conversation into the window. The car gains a driver's seat; it does not gain a second engine.
//
// THE RULE THIS FILE EXISTS TO ENFORCE. Spawning the agent means the app now chooses that agent's
// tool surface, and a wrong choice here is worse than not shipping the feature at all. An agent
// that reads balances and destination addresses and ALSO holds WebFetch is an exfiltration
// channel wearing a permission layer. So the lockdown is not configurable, and it is not trusted
// either: the child announces its own tool list in the init event, and assertSurface below kills
// the session when that list contains anything the app did not expect.
//
// That check is the point. A deny list is a claim about a tool surface that changes with every
// Claude Code release, so a deny list alone goes stale silently and the failure is invisible.
// Written on 2026-08-19, operator/settings.json had gone stale exactly that way: it was correct
// when written and by 2.1.237 it let WebFetch, WebSearch, SendMessage, RemoteTrigger and the Cron
// tools through. Reading the surface back and refusing to drive on a surprise is what makes the
// guarantee survive an upgrade nobody noticed.
//
// WHAT IS DELIBERATELY NOT HERE. No approval path. The child proposes through MCP exactly like a
// external agent does, and a human clicks in the window. Nothing in this file can approve, and
// nothing in this file should ever learn how.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// The only tools the driver's child is allowed to hold. Phosphor's own MCP tools are matched by
// prefix; every built-in is a surprise. Read, Grep and Glob are absent on purpose: the CLI
// operator profile keeps them so a developer can read the code being driven, and the person
// using the desktop app is not that developer.
const MCP_PREFIX = 'mcp__phosphor__';

// The largest single stdout line the parser will hold before giving up on the session. Generous
// against a real event, which is a few KB at worst, and bounded against a child that never
// writes a newline.
const MAX_LINE = 4 * 1024 * 1024;

export type DriverEvent =
  | { kind: 'status'; state: DriverState; detail?: string }
  | { kind: 'said'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; input: unknown }
  | { kind: 'tool_result'; name: string; ok: boolean }
  | { kind: 'turn_end'; error: boolean; turns: number }
  | { kind: 'error'; message: string };

export type DriverState = 'off' | 'starting' | 'ready' | 'thinking' | 'stopped' | 'failed';

export type DriverOptions = {
  repo: string;
  port: number;
  nodeBin?: string;
  claudeBin?: string;
  systemPrompt?: string;
  onEvent: (event: DriverEvent) => void;
};

export type Driver = ReturnType<typeof createDriver>;

// Where `claude` lives when nobody set a PATH. A GUI process launched from Finder inherits
// /usr/bin:/bin:/usr/sbin:/sbin and nothing else, so the install location every developer takes
// for granted is exactly the one the packaged app cannot see. Config wins, then these, then the
// login shell as a last resort.
const CLAUDE_CANDIDATES = [
  '.local/bin/claude',
  '.claude/local/claude',
  '.bun/bin/claude',
  '.volta/bin/claude',
];
const CLAUDE_ABSOLUTE = ['/opt/homebrew/bin/claude', '/usr/local/bin/claude', '/usr/bin/claude'];

export function resolveClaudeBin(override?: string): string {
  if (override) {
    if (!fs.existsSync(override)) throw new Error(`driver: claudeBin is set to ${override}, which does not exist`);
    return override;
  }
  const home = process.env.HOME ?? '';
  for (const rel of CLAUDE_CANDIDATES) {
    const full = path.join(home, rel);
    if (fs.existsSync(full)) return full;
  }
  for (const full of CLAUDE_ABSOLUTE) {
    if (fs.existsSync(full)) return full;
  }
  throw new Error(
    'driver: the claude CLI was not found. Install Claude Code, or set driver.claudeBin in config.json to its full path.',
  );
}

// The child inherits a scrubbed environment. ANTHROPIC_API_KEY would silently move billing off
// the subscription this whole design is built on, and a stray OPENAI_API_KEY has no business in
// a process that talks to a wallet. Removing them is not politeness, it is the business model.
const STRIPPED = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_SAFE_MODE',
  // Where the signing key is. The child has no reader, so this is defence in depth rather than
  // a hole being closed, and it is worth the two lines anyway: operator/settings.json denies
  // Read(~/.phosphor/**) by literal path, which says nothing about a key moved elsewhere by
  // PHOSPHOR_KEYS. Not telling the agent where the key is costs nothing, because nothing it is
  // allowed to do involves knowing.
  'PHOSPHOR_KEYS',
];

function childEnv(repo: string, port: number, sessionId: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of STRIPPED) delete env[key];
  // The MCP proxy the child spawns has to find the same app instance the window is talking to.
  env.ACC_PORT = String(port);
  env.PHOSPHOR_REPO = repo;
  // One seat for the whole conversation. Claude Code may start the MCP server more than once
  // for a single session, and each copy would otherwise mint its own id, so the app would see
  // two agents, seat one, and refuse every call the other made. See the note on SESSION in
  // src/mcp.ts.
  env.PHOSPHOR_SESSION = sessionId;
  return env;
}

export function buildArgv(opts: {
  repo: string;
  nodeBin: string;
  settings: string;
  sessionId: string;
  systemPrompt?: string;
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
    '--settings',
    opts.settings,
    // No user, project or local settings. This is what keeps the machine's own hooks, plugins and
    // CLAUDE.md files out of a session that drives a wallet: they are somebody's development
    // config, and the child is not developing anything.
    '--setting-sources=',
    '--mcp-config',
    mcp,
    '--strict-mcp-config',
    // Never `bypassPermissions`, never `acceptEdits`. dontAsk refuses anything outside the allow
    // list instead of blocking on a prompt that has no terminal to appear in.
    '--permission-mode',
    'dontAsk',
    '--session-id',
    opts.sessionId,
  ];
  if (opts.systemPrompt) argv.push('--append-system-prompt', opts.systemPrompt);
  return argv;
}

// Refuse to drive when the child holds a tool the app did not expect. Returns the offending
// names, empty when the surface is clean.
export function assertSurface(tools: unknown): string[] {
  if (!Array.isArray(tools)) return ['<the init event carried no tool list>'];
  return tools.filter((t): t is string => typeof t === 'string').filter((t) => !t.startsWith(MCP_PREFIX));
}

export function createDriver(opts: DriverOptions) {
  const settings = path.join(opts.repo, 'operator', 'driver.settings.json');
  let child: ChildProcessWithoutNullStreams | null = null;
  let state: DriverState = 'off';
  let sessionId = '';
  let buffer = '';

  function set(next: DriverState, detail?: string): void {
    state = next;
    opts.onEvent({ kind: 'status', state: next, detail });
  }

  function fail(message: string): void {
    set('failed', message);
    opts.onEvent({ kind: 'error', message });
    kill();
  }

  function onLine(line: string): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line);
    } catch {
      // A partial line is normal at a chunk boundary and is handled by the buffer below. A line
      // that parsed as nothing at all is not, but it is also not worth killing a session over.
      return;
    }

    if (event.type === 'system' && event.subtype === 'init') {
      const unexpected = assertSurface(event.tools);
      if (unexpected.length > 0) {
        fail(
          `refusing to drive: the agent was given ${unexpected.length} tool(s) outside Phosphor's own surface (${unexpected.join(', ')}). This is a lockdown failure, not a configuration preference.`,
        );
        return;
      }
      /* A session whose MCP server did not attach is not a degraded session, it is a useless
         one: the agent holds no tools at all, so it answers from memory about a wallet it
         cannot read, and silence there looks exactly like a thoughtful agent.
         The statuses are split rather than compared against 'connected', because this release
         also reports 'pending' and 'connecting', and a server that is merely still attaching is
         not a dead one. Killing on those would refuse sessions that were about to work. Nothing
         is being risked by waiting: assertSurface above has already established that whatever
         does attach cannot bring a built-in tool with it. */
      const servers = Array.isArray(event.mcp_servers) ? (event.mcp_servers as Array<Record<string, unknown>>) : [];
      const phosphor = servers.find((s) => s.name === 'phosphor');
      const status = phosphor === undefined ? 'absent' : String(phosphor.status);
      if (status === 'absent' || status === 'failed' || status === 'needs-auth' || status === 'disconnected') {
        fail(
          `driver: the agent started but cannot reach Phosphor's own tools (${status === 'absent' ? 'the server did not load' : status}). It could talk and read nothing, so the session is stopped.`,
        );
        return;
      }
      if (status !== 'connected') set('starting', `waiting for Phosphor's tools to attach (${status})`);
      sessionId = typeof event.session_id === 'string' ? event.session_id : sessionId;
      return;
    }

    if (event.type === 'assistant') {
      const message = event.message as { content?: Array<Record<string, unknown>> } | undefined;
      for (const block of message?.content ?? []) {
        if (block.type === 'text' && typeof block.text === 'string') {
          opts.onEvent({ kind: 'text', text: block.text });
        }
        if (block.type === 'tool_use' && typeof block.name === 'string') {
          opts.onEvent({ kind: 'tool', name: block.name, input: block.input });
        }
      }
      return;
    }

    if (event.type === 'user') {
      const message = event.message as { content?: Array<Record<string, unknown>> } | undefined;
      for (const block of message?.content ?? []) {
        if (block.type === 'tool_result') {
          opts.onEvent({ kind: 'tool_result', name: String(block.name ?? 'tool'), ok: block.is_error !== true });
        }
      }
      return;
    }

    if (event.type === 'result') {
      opts.onEvent({
        kind: 'turn_end',
        error: event.is_error === true,
        turns: typeof event.num_turns === 'number' ? event.num_turns : 0,
      });
      if (state !== 'failed') set('ready');
    }
  }

  function start(): void {
    if (child) return;
    set('starting');
    let bin: string;
    try {
      bin = resolveClaudeBin(opts.claudeBin);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
      return;
    }
    if (!fs.existsSync(settings)) {
      fail(`driver: ${settings} is missing, and the app will not spawn an agent without its lockdown file.`);
      return;
    }

    sessionId = randomUUID();
    const argv = buildArgv({
      repo: opts.repo,
      nodeBin: opts.nodeBin ?? process.execPath,
      settings,
      sessionId,
      systemPrompt: opts.systemPrompt,
    });

    /* detached, so the child leads its own process group and kill() below can take the group
       rather than one pid. It matters because the child immediately spawns a third process of
       its own, the MCP proxy in src/mcp.ts, and killing only the agent would leave that proxy
       running against a window that has gone. Detached does NOT mean it outlives the app: the
       exit handlers registered below are what guarantee it does not. */
    child = spawn(bin, argv, {
      cwd: opts.repo,
      env: childEnv(opts.repo, opts.port, sessionId),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    }) as ChildProcessWithoutNullStreams;
    armExitGuard();

    // setEncoding('utf8') rather than decoding chunks by hand, because a multi-byte character
    // split across a chunk boundary is otherwise corrupted, and the agent writes token names.
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      // A line is a JSON event and events are not this big. Without a cap, a child that emits
      // an unterminated line grows this string until the app it is a feature of runs out of
      // memory, and the app dies holding the keys. Refusing the session is the smaller failure.
      if (buffer.length > MAX_LINE) {
        buffer = '';
        fail(`driver: the agent emitted a single line over ${Math.round(MAX_LINE / 1024)}KB, which is not an event this app knows how to read.`);
        return;
      }
      for (const line of lines) if (line.trim()) onLine(line);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      const text = chunk.trim();
      if (text) opts.onEvent({ kind: 'error', message: text.slice(0, 500) });
    });
    /* Ready as soon as the process exists, not when it announces itself.
       Claude Code does not emit its init event until the first turn arrives on stdin, so waiting
       for init before showing the input box is a deadlock: the event needs a message, and the
       message needs the box. This is safe, and the reason is worth stating precisely. The init
       event still arrives BEFORE the model's first tool call, and onLine still kills the session
       there when the tool surface is not Phosphor's own. So the worst case is that one sentence
       of the human's text reached a session that is then killed before it can act on it. The
       thing being guarded is what the agent can DO, and nothing it can do happens first. */
    child.on('spawn', () => {
      if (state === 'starting') set('ready');
    });
    child.on('error', (error) => fail(`driver: could not start ${bin}: ${error.message}`));
    child.on('exit', (code) => {
      child = null;
      buffer = '';
      if (state !== 'failed') set('stopped', code === 0 ? undefined : `the agent exited with code ${code}`);
    });
  }

  function send(text: string): void {
    if (!child || state === 'failed') throw new Error('driver: no agent is running');
    const turn = { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } };
    child.stdin.write(`${JSON.stringify(turn)}\n`);
    set('thinking');
  }

  // Signals go to the group, negated pid, so the agent and the MCP proxy it spawned both stop.
  // A group that has already gone produces ESRCH, which is the outcome asked for and not an
  // error worth surfacing.
  function signalGroup(pid: number, signal: NodeJS.Signals): void {
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        /* already gone */
      }
    }
  }

  function kill(): void {
    if (!child) return;
    const dying = child;
    const pid = dying.pid;
    child = null;
    try {
      dying.stdin.end();
    } catch {
      /* the pipe can already be closed when the child died first */
    }
    if (pid === undefined) return;
    signalGroup(pid, 'SIGTERM');
    setTimeout(() => signalGroup(pid, 'SIGKILL'), 2000).unref();
  }

  // A driver that outlives the window would keep the seat, keep spending the user's
  // subscription, and keep proposing into a state directory nobody is watching. These cover
  // every exit the parent can observe; a SIGKILL of the app itself is the one case no process
  // can handle, and the seat TTL in src/agents.ts is what closes that one.
  let guarded = false;
  function armExitGuard(): void {
    if (guarded) return;
    guarded = true;
    process.once('exit', () => kill());
    // Registering a signal listener replaces node's default action for that signal, so each one
    // has to exit explicitly or the app stops responding to the signal that was supposed to end
    // it. src/mcp.ts carries the same note for the same reason.
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
      process.once(signal, () => {
        kill();
        process.exit(0);
      });
    }
  }

  function stop(): void {
    kill();
    if (state !== 'failed') set('stopped');
  }

  return {
    start,
    send,
    stop,
    status: () => ({ state, sessionId, running: child !== null }),
  };
}
