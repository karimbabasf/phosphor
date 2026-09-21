// The agent catalog: the six entries the picker offers, how each one is found on this Mac, how
// its login is checked without a network call, the one line that connects it, and the
// registration the app writes into the agent's own config.
//
// WHAT THIS FILE PROMISES. Every process it starts is a `--version` or a login status command
// with a hard timeout, run without a shell. The only file it reads for a login is the presence
// of the vendor's credential file, never its contents. Nothing here stores a vendor login,
// prints a token, or talks to a vendor over the network: a check is a fact about this Mac.
// Everything a check reports is one of four state words plus the sentence for that state, and
// the technical lines (a path, a version) sit apart so a screen can fold them behind Details.
//
// ONE BUILDER FOR THE CONNECTION LINE. src/http/mutation.ts used to build a Claude line for
// everyone and src-tauri/src/main.rs built a second, different one with the packaged app's
// environment. Both surfaces now read connectionLine below, which builds the line per agent and
// includes the environment the proxy needs in every mode, so a line copied from the window and a
// line copied from the menu are the same bytes.
//
// WHAT WAS MEASURED, AND WHERE. Every command, flag and file below was read off the binaries
// installed on this Mac on 2026-09-20 (Claude Code 2.1.278, codex-cli 0.154.0, Hermes Agent
// 0.21.3, grok 1.0.34), not off a memory of a release: `claude auth status` prints JSON with a
// `loggedIn` field, `codex login status` exits 1 with "Not logged in", `hermes config get model`
// prints the provider and default model Hermes will drive with, and grok has no offline status
// command at all. The Grok entry is the `grok` binary xAI ships as "Grok Build" (its README:
// installer `curl -fsSL https://x.ai/cli/install.sh | bash`, credentials in ~/.grok/auth.json,
// config in ~/.grok/config.toml, `grok mcp add` writes the config). docs.x.ai answered 404 for
// its Grok Build pages on the day this was written, so the shipped README is the source.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { atomicWriteJson } from './fsatomic.ts';

export type AgentId = 'claude' | 'codex' | 'hermes' | 'grok' | 'mcp' | 'desktop';

// The four answers a check can give, and no fifth. `unknown_client` is the honest answer for an
// agent the app cannot probe: another MCP client, or Claude Desktop, which cannot drive at all.
export type AgentState = 'installed_and_logged_in' | 'installed_not_logged_in' | 'not_installed' | 'unknown_client';

export type AgentEntry = {
  id: AgentId;
  // The word on the tile. Plain, no vendor jargon on the visible face.
  name: string;
  // Who ships it, one line, behind Details.
  vendor: string;
  kind: 'cli' | 'mcp' | 'desktop';
  // The command name on PATH, and where it lands when nobody set a PATH (a GUI process
  // launched from Finder inherits /usr/bin:/bin:/usr/sbin:/sbin and nothing else).
  binary: string | null;
  candidates: readonly string[];
  absolute: readonly string[];
  // The vendor's config-directory variable. Passed through to its probes when the app was
  // started with one, so the check reads the same login the person's terminal reads.
  homeEnv: string | null;
  // The default config directory under HOME, for the file-based probe and the Details line.
  homeDir: string | null;
  // Whether the app can start it in-app under a lockdown file it owns (src/driver.ts). Claude
  // Code is the one agent with a headless mode whose tool surface the app reads back and
  // refuses on a surprise; the others start in a terminal and appear in the roster.
  inApp: boolean;
  // Whether the app writes the MCP registration itself, through the vendor's own `mcp add`.
  registers: boolean;
  install: string | null;
  login: string | null;
  // The brand colour the tile borrows under the pointer, never on a number.
  colour: string;
  mark: string;
};

export const AGENTS: readonly AgentEntry[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    vendor: 'Anthropic',
    kind: 'cli',
    binary: 'claude',
    candidates: ['.local/bin/claude', '.claude/local/claude', '.bun/bin/claude', '.volta/bin/claude'],
    absolute: ['/opt/homebrew/bin/claude', '/usr/local/bin/claude', '/usr/bin/claude'],
    homeEnv: 'CLAUDE_CONFIG_DIR',
    homeDir: '.claude',
    inApp: true,
    registers: true,
    install: 'curl -fsSL https://claude.ai/install.sh | bash',
    login: 'claude auth login',
    colour: '#D97757',
    mark: 'CC',
  },
  {
    id: 'codex',
    name: 'Codex',
    vendor: 'OpenAI',
    kind: 'cli',
    binary: 'codex',
    candidates: ['.local/bin/codex', '.bun/bin/codex', '.volta/bin/codex', '.npm-global/bin/codex'],
    absolute: ['/opt/homebrew/bin/codex', '/usr/local/bin/codex'],
    homeEnv: 'CODEX_HOME',
    homeDir: '.codex',
    inApp: false,
    registers: true,
    install: 'npm install -g @openai/codex',
    login: 'codex login',
    colour: '#10A37F',
    mark: 'Cx',
  },
  {
    id: 'hermes',
    name: 'Hermes',
    vendor: 'Nous Research',
    kind: 'cli',
    binary: 'hermes',
    candidates: ['.local/bin/hermes', '.hermes/hermes-agent/venv/bin/hermes'],
    absolute: ['/opt/homebrew/bin/hermes', '/usr/local/bin/hermes'],
    homeEnv: 'HERMES_HOME',
    homeDir: '.hermes',
    inApp: false,
    registers: true,
    install: 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash',
    login: 'hermes model',
    colour: '#E8B23A',
    mark: 'He',
  },
  {
    id: 'grok',
    name: 'Grok',
    vendor: 'xAI, the grok command (Grok Build)',
    kind: 'cli',
    binary: 'grok',
    candidates: ['.grok/bin/grok', '.local/bin/grok'],
    absolute: ['/opt/homebrew/bin/grok', '/usr/local/bin/grok'],
    homeEnv: 'GROK_HOME',
    homeDir: '.grok',
    inApp: false,
    registers: true,
    install: 'curl -fsSL https://x.ai/cli/install.sh | bash',
    login: 'grok login',
    colour: '#8A8F98',
    mark: 'Gr',
  },
  {
    id: 'mcp',
    name: 'Another agent',
    vendor: 'Any agent that connects to MCP servers',
    kind: 'mcp',
    binary: null,
    candidates: [],
    absolute: [],
    homeEnv: null,
    homeDir: null,
    inApp: false,
    registers: false,
    install: null,
    login: null,
    colour: '#5B8DEF',
    mark: 'A',
  },
  {
    id: 'desktop',
    name: 'Claude Desktop or a chat app',
    vendor: 'A chat window, with no agent on this Mac',
    kind: 'desktop',
    binary: null,
    candidates: [],
    absolute: [],
    homeEnv: null,
    homeDir: null,
    inApp: false,
    registers: false,
    install: null,
    login: null,
    colour: '#D97757',
    mark: 'Ch',
  },
];

export function agentById(id: unknown): AgentEntry | null {
  if (typeof id !== 'string') return null;
  return AGENTS.find((a) => a.id === id) ?? null;
}

/* ---------- finding the binary ---------- */

function executable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/* The node versions nvm keeps, newest first, because an npm global install (codex, and claude
   for some people) lands under the version that was current when it was installed and the
   packaged app's PATH never names it. */
function nvmBins(home: string, name: string): string[] {
  const root = path.join(home, '.nvm', 'versions', 'node');
  let versions: string[];
  try {
    versions = fs.readdirSync(root);
  } catch {
    return [];
  }
  const byNumber = (v: string): number[] => v.replace(/^v/, '').split('.').map((n) => Number(n) || 0);
  versions.sort((a, b) => {
    const [x, y] = [byNumber(a), byNumber(b)];
    for (let i = 0; i < 3; i += 1) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
    return 0;
  });
  return versions.map((v) => path.join(root, v, 'bin', name));
}

/* Where the binary is, or null. An override from config wins and must exist; then PATH as the
   process has it; then the places installers put it; then nvm's versions. */
export function findAgentBin(entry: AgentEntry, opts: { env?: NodeJS.ProcessEnv; home?: string; override?: string } = {}): string | null {
  if (entry.binary === null) return null;
  if (opts.override) return executable(opts.override) ? opts.override : null;
  const env = opts.env ?? process.env;
  const home = opts.home ?? env.HOME ?? os.homedir();
  for (const dir of String(env.PATH ?? '').split(':')) {
    if (dir === '') continue;
    const full = path.join(dir, entry.binary);
    if (executable(full)) return full;
  }
  for (const rel of entry.candidates) {
    const full = path.join(home, rel);
    if (executable(full)) return full;
  }
  for (const full of entry.absolute) if (executable(full)) return full;
  for (const full of nvmBins(home, entry.binary)) if (executable(full)) return full;
  return null;
}

/* ---------- running a probe ---------- */

/* One vendor command, run without a shell, killed at its cap. `input` is what goes down its
   stdin before the pipe closes; absent, stdin is closed from the start, so a command that
   stops to ask a question (Hermes's first-run wizard, its "Enable all tools?" prompt) gets an
   end of file at once instead of waiting on a pipe nobody will write to until the cap kills it. */
export type Run = (bin: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number, input?: string) => Promise<RunResult>;
export type RunResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean };

// A probe is a version or a status question. Two and a half seconds is the cap for one, so a
// check that runs two side by side still answers inside the three seconds the picker promises.
export const PROBE_TIMEOUT_MS = 2_500;
// The names a probe child gets, and nothing else: what a process needs to run at all. The same
// allow list the driver uses (src/driver.ts INHERITED_ENV), restated here because this file
// must not import the driver to run a `--version`.
const PROBE_ENV = ['PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM'] as const;

const PROBE_OUTPUT_CAP = 256 * 1024;

export const runProbe: Run = (bin, args, env, timeoutMs, input) =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let done = false;
    let child: ReturnType<typeof spawn>;
    const finish = (code: number | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    };
    try {
      child = spawn(bin, args, { env, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: error instanceof Error ? error.message : String(error), timedOut: false });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      finish(null);
    }, timeoutMs);
    const take = (chunk: Buffer, which: 'out' | 'err'): void => {
      const text = chunk.toString('utf8');
      if (which === 'out') stdout = (stdout + text).slice(0, PROBE_OUTPUT_CAP);
      else stderr = (stderr + text).slice(0, PROBE_OUTPUT_CAP);
    };
    child.stdout?.on('data', (chunk: Buffer) => take(chunk, 'out'));
    child.stderr?.on('data', (chunk: Buffer) => take(chunk, 'err'));
    child.on('error', (error) => {
      stderr = `${stderr}${error.message}`;
      finish(null);
    });
    child.on('close', (code) => finish(code));
    if (input !== undefined && child.stdin) {
      child.stdin.on('error', () => { /* the command left before reading its answer */ });
      child.stdin.end(input);
    }
  });

/* The environment a probe runs in: the process's own allow list, the binary's own directory on
   PATH so a launcher script finds its siblings, and the vendor's config-directory variable when
   the app was started with one. */
export function probeEnv(entry: AgentEntry, bin: string, parent: NodeJS.ProcessEnv = process.env, home?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of PROBE_ENV) if (parent[name] !== undefined) env[name] = parent[name];
  if (home !== undefined) env.HOME = home;
  env.PATH = [path.dirname(bin), env.PATH ?? '/usr/bin:/bin'].join(':');
  if (entry.homeEnv !== null && parent[entry.homeEnv] !== undefined) env[entry.homeEnv] = parent[entry.homeEnv];
  return env;
}

/* One printable line of what a vendor binary printed, capped. Its output is data from another
   program, so it is flattened and cut before it can reach a log line or a Details fold. */
function firstLine(text: string, max = 80): string | null {
  const line = text.split('\n').map((l) => l.replace(/[^\x20-\x7e]/g, '').trim()).find((l) => l !== '');
  if (line === undefined) return null;
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}

/* ---------- the login probes, per agent ---------- */

type Login = 'in' | 'out';

/* `claude auth status` prints JSON with a `loggedIn` field and no other line the app needs. It
   reads the credentials file and returns in about a tenth of a second; a network call would be
   `claude mcp list`, which this never runs. */
async function claudeLogin(bin: string, env: NodeJS.ProcessEnv, run: Run): Promise<Login> {
  const out = await run(bin, ['auth', 'status'], env, PROBE_TIMEOUT_MS);
  try {
    const parsed = JSON.parse(out.stdout) as { loggedIn?: unknown };
    return parsed.loggedIn === true ? 'in' : 'out';
  } catch {
    return /"loggedIn"\s*:\s*true/.test(out.stdout) ? 'in' : 'out';
  }
}

/* `codex login status` exits 0 when a login is stored and 1 with "Not logged in" when none is.
   Measured on codex-cli 0.154.0. */
async function codexLogin(bin: string, env: NodeJS.ProcessEnv, run: Run): Promise<Login> {
  const out = await run(bin, ['login', 'status'], env, PROBE_TIMEOUT_MS);
  if (out.timedOut) return 'out';
  if (/not logged in/i.test(`${out.stdout}\n${out.stderr}`)) return 'out';
  return out.code === 0 ? 'in' : 'out';
}

/* Hermes has no single login. What it needs to drive is a provider and a default model, and
   `hermes config get model` prints both (`default: <model>`, `provider: <name>`) off the config
   without touching the network. Both present is signed in; `hermes model` is the command that
   sets them, which is why it is the entry's login line. */
async function hermesLogin(bin: string, env: NodeJS.ProcessEnv, run: Run): Promise<Login> {
  const out = await run(bin, ['config', 'get', 'model'], env, PROBE_TIMEOUT_MS);
  if (out.timedOut || out.code !== 0) return 'out';
  const field = (name: string): string => {
    const m = new RegExp(`^\\s*${name}:\\s*(.*)$`, 'm').exec(out.stdout);
    return m === null ? '' : m[1].trim();
  };
  return field('provider') !== '' && field('default') !== '' ? 'in' : 'out';
}

/* grok has `login` and `logout` and no status command that stays off the network (`grok models`
   asks the API). Its README says credentials live in <GROK_HOME or ~/.grok>/auth.json, written
   by `grok login`, so the probe is whether that file exists and holds a JSON object with at
   least one entry. The object is parsed for its shape only: no value in it is read, kept or
   printed. */
function grokLogin(env: NodeJS.ProcessEnv, home: string): Login {
  const dir = env.GROK_HOME !== undefined && env.GROK_HOME !== '' ? env.GROK_HOME : path.join(home, '.grok');
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8'));
    return parsed !== null && typeof parsed === 'object' && Object.keys(parsed as object).length > 0 ? 'in' : 'out';
  } catch {
    return 'out';
  }
}

/* ---------- the check ---------- */

export type AgentCheck = {
  agent: AgentId;
  name: string;
  state: AgentState;
  // Whether a probe ran at all. False for the two entries the app cannot check.
  probed: boolean;
  // The one sentence for the state, in the words the picker and the panel show.
  sentence: string;
  // The lines a screen shows only behind Details: path, version, install and sign-in commands.
  details: string[];
  version: string | null;
  bin: string | null;
  inApp: boolean;
  registers: boolean;
  ms: number;
};

export type CheckOptions = {
  env?: NodeJS.ProcessEnv;
  home?: string;
  // A config override for the binary, validated by findAgentBin rather than trusted.
  bin?: string;
  run?: Run;
  // True when this agent is the one the person picked earlier: an agent that has since
  // disappeared reads "is no longer on this Mac" rather than "is not on this Mac yet".
  wasPicked?: boolean;
  now?: () => number;
};

/* One sentence per state, in one place. The picker, the vault panel and the docs all say
   exactly this; a screen never composes its own. */
export function stateSentence(entry: AgentEntry, state: AgentState, wasPicked = false): string {
  if (entry.kind === 'desktop') {
    return 'Phosphor needs an agent that runs on your Mac. Claude Desktop cannot drive it yet. Install Claude Code or Codex, then pick it here.';
  }
  if (entry.kind === 'mcp') {
    return 'Phosphor cannot check this agent, so paste the line below into it and it will appear here.';
  }
  switch (state) {
    case 'not_installed':
      return wasPicked ? `${entry.name} is no longer on this Mac.` : `${entry.name} is not on this Mac yet. Install it, then come back to this screen.`;
    case 'installed_not_logged_in':
      return `${entry.name} is installed but not signed in. Sign in in your terminal, then press Check again.`;
    case 'installed_and_logged_in':
      return entry.inApp
        ? `${entry.name} is signed in and ready to start.`
        : `${entry.name} is signed in: start it in your terminal and it will appear here.`;
    default:
      return `Phosphor cannot check ${entry.name} on this Mac.`;
  }
}

/* The technical lines behind Details, so the sentence above never has to carry a path. */
function detailLines(entry: AgentEntry, bin: string | null, version: string | null, home: string): string[] {
  const lines: string[] = [];
  lines.push(`Made by ${entry.vendor}.`);
  if (bin !== null) lines.push(`Found at ${bin}${version === null ? '' : `, ${version}`}.`);
  else if (entry.binary !== null) lines.push(`Looked for \`${entry.binary}\` on PATH and in ${entry.candidates.map((c) => `~/${c}`).join(', ')}.`);
  if (entry.homeDir !== null) lines.push(`Its settings live in ${path.join(home, entry.homeDir).replace(home, '~')}.`);
  if (entry.install !== null) lines.push(`Install: ${entry.install}`);
  if (entry.login !== null) lines.push(`Sign in: ${entry.login}`);
  return lines;
}

export async function checkAgent(id: AgentId, opts: CheckOptions = {}): Promise<AgentCheck> {
  const now = opts.now ?? Date.now;
  const started = now();
  const entry = agentById(id);
  if (entry === null) throw new Error(`no agent named ${String(id)} in the catalog`);
  const env = opts.env ?? process.env;
  const home = opts.home ?? env.HOME ?? os.homedir();
  const run = opts.run ?? runProbe;
  const finish = (state: AgentState, probed: boolean, bin: string | null, version: string | null): AgentCheck => ({
    agent: entry.id,
    name: entry.name,
    state,
    probed,
    sentence: stateSentence(entry, state, opts.wasPicked === true),
    details: detailLines(entry, bin, version, home),
    version,
    bin,
    inApp: entry.inApp,
    registers: entry.registers,
    ms: Math.max(0, now() - started),
  });

  if (entry.kind !== 'cli') return finish('unknown_client', false, null, null);

  const bin = findAgentBin(entry, { env, home, override: opts.bin });
  if (bin === null) return finish('not_installed', true, null, null);

  const probe = probeEnv(entry, bin, env, home);
  // The version call and the login probe run side by side, each under its own cap, so the whole
  // check stays inside the picker's three seconds however slow one of them is.
  const [versionOut, login] = await Promise.all([
    run(bin, ['--version'], probe, PROBE_TIMEOUT_MS),
    entry.id === 'claude'
      ? claudeLogin(bin, probe, run)
      : entry.id === 'codex'
        ? codexLogin(bin, probe, run)
        : entry.id === 'hermes'
          ? hermesLogin(bin, probe, run)
          : Promise.resolve(grokLogin(env, home)),
  ]);
  const version = versionOut.code === 0 ? firstLine(versionOut.stdout) : null;
  // A binary that is there but cannot say its version is still installed: the sentence for a
  // login it does not have is more useful than "not installed" for a file that plainly exists.
  return finish(login === 'in' ? 'installed_and_logged_in' : 'installed_not_logged_in', true, bin, version);
}

/* Every CLI entry checked at once, for the tags on the tiles. The two entries with nothing to
   probe are not in the answer. */
export async function scanAgents(opts: CheckOptions = {}): Promise<AgentCheck[]> {
  return Promise.all(AGENTS.filter((a) => a.kind === 'cli').map((a) => checkAgent(a.id, opts)));
}

/* ---------- the connection line and the registration ---------- */

export type ConnectionSpec = {
  // The node that runs the proxy: the bundled runtime's absolute path in the packaged app,
  // the `node` on PATH in a checkout.
  nodeBin: string;
  // <repo>/src/mcp.ts, absolute.
  serverPath: string;
  port: number;
  // The app's data directory, where the proxy reads this boot's seat secret from agent.secret.
  dataDir: string;
};

export const SERVER_NAME = 'phosphor';

/* POSIX shell quoting for the line a person pastes. Only what needs it is quoted, so the common
   line stays readable; a path with a space (Application Support) is wrapped in single quotes,
   and a single quote inside is closed, escaped and reopened. */
export function shellQuote(value: string): string {
  if (value === '') return "''";
  if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function envPairs(spec: ConnectionSpec): [string, string][] {
  return [
    ['PHOSPHOR_PORT', String(spec.port)],
    ['PHOSPHOR_DATA_DIR', spec.dataDir],
  ];
}

/* The arguments after the vendor's binary that register the proxy, in each vendor's own
   grammar, measured on the releases named at the top. Null for the two entries that own no
   config the app can write. */
export function registrationArgs(id: AgentId, spec: ConnectionSpec): string[] | null {
  const env = envPairs(spec);
  switch (id) {
    case 'claude':
      // The name goes before the options: `--env` is variadic in this CLI and would swallow a
      // name placed after it. User scope, so the server is there in every directory the person
      // opens Claude Code in, not only the one they happened to run the line from.
      return ['mcp', 'add', SERVER_NAME, '--scope', 'user', ...env.flatMap(([k, v]) => ['--env', `${k}=${v}`]), '--', spec.nodeBin, spec.serverPath];
    case 'codex':
      return ['mcp', 'add', SERVER_NAME, ...env.flatMap(([k, v]) => ['--env', `${k}=${v}`]), '--', spec.nodeBin, spec.serverPath];
    case 'hermes':
      // `--args` must be the last option (its own help says so); `--env` takes every KEY=VALUE
      // after it in one go.
      return ['mcp', 'add', SERVER_NAME, '--command', spec.nodeBin, '--env', ...env.map(([k, v]) => `${k}=${v}`), '--args', spec.serverPath];
    case 'grok':
      return ['mcp', 'add', SERVER_NAME, spec.nodeBin, '--scope', 'user', ...env.flatMap(([k, v]) => ['--env', `${k}=${v}`]), '--', spec.serverPath];
    default:
      return null;
  }
}

/* The one line a person pastes into a terminal, per agent. For an agent with its own `mcp add`
   it is that command; for another MCP client it is the stdio command the client is given, with
   the environment in front of it. Nothing for Claude Desktop: there is no agent to connect. */
export function connectionLine(id: AgentId, spec: ConnectionSpec): string | null {
  const entry = agentById(id);
  if (entry === null) return null;
  if (entry.kind === 'desktop') return null;
  if (entry.kind === 'mcp') {
    return [...envPairs(spec).map(([k, v]) => `${k}=${shellQuote(v)}`), shellQuote(spec.nodeBin), shellQuote(spec.serverPath)].join(' ');
  }
  const args = registrationArgs(id, spec);
  if (args === null || entry.binary === null) return null;
  return [entry.binary, ...args.map(shellQuote)].join(' ');
}

/* The commands that take a stale entry of ours out before it is written again. An update moves
   the payload, and a registration that still names the old path is a proxy that never starts. */
function removalArgs(id: AgentId): string[] | null {
  switch (id) {
    case 'claude':
      return ['mcp', 'remove', '--scope', 'user', SERVER_NAME];
    case 'codex':
      return ['mcp', 'remove', SERVER_NAME];
    case 'hermes':
      return ['mcp', 'remove', SERVER_NAME];
    default:
      return null;
  }
}

export type Registration = { ok: boolean; wrote: boolean; detail: string | null };

// A registration is a write to the vendor's config and, for one vendor, a discovery run against
// the proxy; it gets longer than a probe and is never on the picker's critical path.
export const REGISTER_TIMEOUT_MS = 20_000;

/* Writes the proxy into the agent's own config through the vendor's own command. `detail` is
   the vendor's first line for the log; the window never prints it. An entry that already
   exists is removed and written again, so the registration always names this installation's
   paths. */
export async function registerAgent(
  id: AgentId,
  spec: ConnectionSpec,
  opts: { env?: NodeJS.ProcessEnv; home?: string; bin?: string; run?: Run } = {},
): Promise<Registration> {
  const entry = agentById(id);
  if (entry === null || !entry.registers) return { ok: true, wrote: false, detail: null };
  const args = registrationArgs(id, spec);
  if (args === null) return { ok: true, wrote: false, detail: null };
  const env = opts.env ?? process.env;
  const home = opts.home ?? env.HOME ?? os.homedir();
  const bin = findAgentBin(entry, { env, home, override: opts.bin });
  if (bin === null) return { ok: false, wrote: false, detail: `${entry.binary} is not installed` };
  const run = opts.run ?? runProbe;
  const probe = probeEnv(entry, bin, env, home);
  /* Hermes asks "Enable all N tools? [Y/n/select]" after it has connected and read the tool
     list, and answers end of file with Cancelled; the app wants every tool it serves enabled,
     so the answer goes down stdin. An entry that is already there gets a second question first
     and the one answer lands on the wrong one, so the old entry is removed before the write. */
  const input = id === 'hermes' ? 'Y\n' : undefined;
  if (id === 'hermes') await run(bin, removalArgs(id) ?? [], probe, REGISTER_TIMEOUT_MS);
  let out = await run(bin, args, probe, REGISTER_TIMEOUT_MS, input);
  if (out.code !== 0 && /already exists|already configured|already registered/i.test(`${out.stdout}\n${out.stderr}`)) {
    const removal = removalArgs(id);
    if (removal !== null) {
      await run(bin, removal, probe, REGISTER_TIMEOUT_MS);
      out = await run(bin, args, probe, REGISTER_TIMEOUT_MS, input);
    }
  }
  if (out.timedOut) return { ok: false, wrote: false, detail: `${entry.binary} mcp add did not finish in ${REGISTER_TIMEOUT_MS / 1000} s` };
  if (out.code !== 0) return { ok: false, wrote: false, detail: firstLine(out.stderr) ?? firstLine(out.stdout) ?? `${entry.binary} mcp add exited ${String(out.code)}` };
  return { ok: true, wrote: true, detail: firstLine(out.stdout) };
}

/* ---------- the pick ---------- */

export type AgentPick = { agent: AgentId; pickedAt: string };

function pickPath(dataDir: string): string {
  return path.join(dataDir, 'agent.json');
}

/* The agent the person picked, or null when nobody has. An unreadable file is no pick rather
   than a boot error: the panel then shows the picker, and nothing else depends on it. */
export function readPick(dataDir: string): AgentPick | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(pickPath(dataDir), 'utf8')) as { agent?: unknown; pickedAt?: unknown };
    const entry = agentById(parsed.agent);
    if (entry === null) return null;
    return { agent: entry.id, pickedAt: typeof parsed.pickedAt === 'string' ? parsed.pickedAt : '' };
  } catch {
    return null;
  }
}

export function writePick(dataDir: string, agent: AgentId, now: () => number = Date.now): AgentPick {
  const pick: AgentPick = { agent, pickedAt: new Date(now()).toISOString() };
  fs.mkdirSync(dataDir, { recursive: true });
  atomicWriteJson(pickPath(dataDir), pick);
  return pick;
}
