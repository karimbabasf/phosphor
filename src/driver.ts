// The driver's seat: Phosphor spawns the agent instead of waiting for one to connect.
//
// Everything else in this app assumes the agent arrives from outside, over the MCP handshake in
// src/mcp.ts. That stays true and is not weakened here. This adds a second way in: the app starts
// the agent CLI the person picked (Claude Code or Grok, src/providers/), hands it the same MCP
// server, and streams the conversation into the window. The car gains a driver's seat; it does
// not gain a second engine.
//
// THE RULE THIS FILE EXISTS TO ENFORCE. Spawning the agent means the app now chooses that agent's
// tool surface, and a wrong choice here is worse than not shipping the feature at all. So the
// lockdown is not configurable, and it is not trusted either: the child announces its own tool list
// in the init event, the provider reads it back, and the session dies when that list holds anything
// the app did not expect. Every tool call on the stream is read the same way, and a built-in there
// ends the session too.
//
// THE WEB, SINCE 2026-09-23. The surface is Phosphor's tools plus the vendor's own web search and
// page reading, on Karim's decision: the agent has to be able to research anything, not only
// crypto. That was refused here for a reason that still holds, and it is stated rather than
// forgotten: an agent that reads balances and addresses and can fetch any URL can be talked by a
// hostile page into putting them in one. What it cannot do is move money to anyone: a send and a
// withdrawal wait for the person's click at any size (src/proposals/execute.ts land()), and no
// tool takes an address but propose_send. Nor can a page talk it into a move of the person's own
// money: after a web call, every move it proposes waits for the click until the person's next
// message (src/web-read.ts). The persona tells the agent a page is data and never to put their
// figures in a search or a URL; that is prose, and the three walls above are code.
//
// That check is the point. A deny list is a claim about a tool surface that changes with every
// release, so a deny list alone goes stale silently and the failure is invisible. Written on
// 2026-08-19, operator/settings.json had gone stale exactly that way: it was correct when written
// and by 2.1.237 it let WebFetch, WebSearch, SendMessage, RemoteTrigger and the Cron tools
// through. Reading the surface back and refusing to drive on a surprise is what makes the
// guarantee survive an upgrade nobody noticed.
//
// WHAT IS DELIBERATELY NOT HERE. No approval path. The child proposes through MCP exactly like an
// external agent does, and a human clicks in the window. Nothing in this file can approve, and
// nothing in this file should ever learn how.

import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { claude } from './providers/claude.ts';
import { userAuthFile } from './providers/grok.ts';
import type { Provider, SpawnSpec } from './providers/types.ts';
import { clearWebRead, markWebRead } from './web-read.ts';

export { assertSurface, buildArgv, resolveClaudeBin } from './providers/claude.ts';

// The largest single stdout line the parser will hold before giving up on the session. Generous
// against a real event, which is a few KB at worst, and bounded against a child that never
// writes a newline.
const MAX_LINE = 4 * 1024 * 1024;

// How long a stopped agent gets to leave on its own before SIGKILL. Claude Code flushes and
// exits well inside this; the session that needs the whole grace is one killed mid-request.
const TERM_GRACE_MS = 1500;
const POLL_MS = 50;

export type DriverEvent =
  /* `detail` is the technical line for the log. `reason` is the sentence the window shows a
     person when the state is failed or an unasked-for stopped: plain words, no "driver:" prefix,
     no path. The window never prints `detail` on its own. */
  | { kind: 'status'; state: DriverState; detail?: string; reason?: string }
  | { kind: 'said'; text: string }
  /* One whole block of the agent's reply. `block` names the stream it closes: the `delta` events
     with the same number were this text arriving, and this is the final copy of it. */
  | { kind: 'text'; text: string; block?: number }
  /* A piece of a block as the model writes it, for the window to print before the block is done.
     Never kept in the transcript: the `text` event with the same block number is the record. */
  | { kind: 'delta'; block: number; text: string }
  | { kind: 'tool'; name: string; input: unknown }
  | { kind: 'tool_result'; name: string; ok: boolean }
  /* The structured answer of one read, for the window to draw as a card rather than for the
     model to read back out in prose. Only the tools in TOOL_DATA_TOOLS below produce one, and
     the payload is scrubbed and capped before it leaves this process: see toolDataFor. */
  | { kind: 'tool_data'; name: string; input: unknown; data: unknown }
  | { kind: 'turn_end'; error: boolean; turns: number }
  | { kind: 'error'; message: string };

/* WHICH ANSWERS REACH THE WINDOW AS DATA, AND HOW MUCH OF THEM.

   The window used to see nothing of a tool's answer but its name and whether it failed, so a
   balance came back as a table the model typed out (Karim, 2026-09-15: "when I ask how much I
   won it just prints a boring white table"). These are the reads whose answers the window knows
   how to draw: holdings, positions, a proposal's status, a deposit address, and every propose.
   Everything else stays where it was. The list is an allow list on purpose: a tool absent from
   it sends nothing, so the vault and keystore surface cannot reach the window by accident, and
   a key-shaped field is dropped from the ones that are on it as a second line of defence.

   The cap is a size, not an editorial choice. A window that receives a 400 KB fill history in
   one SSE frame stalls for everyone, so arrays are cut from the longest one down, each cut
   leaving a `{ truncated: n }` marker in the array it shortened, until the answer fits. */
export const TOOL_DATA_TOOLS: ReadonlySet<string> = new Set([
  'wallet',
  'trade_read',
  'trade_batch',
  'deposit',
  'proposal_status',
  'swap_check',
  // An address lookup, so the window can draw what the agent just read about a receiver. Its
  // strings are already stripped and capped by src/chainscan before they get here.
  'chain_address',
]);
export const TOOL_DATA_CAP = 32 * 1024;
const TOOL_PREFIX = 'mcp__phosphor__';
const SECRET_KEY = /mnemonic|seed|private|secret|passphrase|keystore|password/i;

function bareName(name: string): string {
  return name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name;
}

export function isToolDataTool(name: string): boolean {
  const bare = bareName(name);
  return TOOL_DATA_TOOLS.has(bare) || bare.startsWith('propose_');
}

/* The text of a tool result block, whichever shape the stream carried it in: a string, or a
   list of content blocks of which the first text block is the answer. */
function resultText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (block !== null && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
      const text = (block as { text?: unknown }).text;
      if (typeof text === 'string') return text;
    }
  }
  return null;
}

function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY.test(key)) continue;
      out[key] = scrub(inner);
    }
    return out;
  }
  return value;
}

function cutArrays(value: unknown, keep: number): unknown {
  if (Array.isArray(value)) {
    if (value.length <= keep) return value.map((v) => cutArrays(v, keep));
    const head = value.slice(0, keep).map((v) => cutArrays(v, keep));
    head.push({ truncated: value.length - keep });
    return head;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) out[key] = cutArrays(inner, keep);
    return out;
  }
  return value;
}

function cutStrings(value: unknown, keep: number): unknown {
  if (typeof value === 'string') return value.length > keep ? `${value.slice(0, keep)} (cut)` : value;
  if (Array.isArray(value)) return value.map((v) => cutStrings(v, keep));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) out[key] = cutStrings(inner, keep);
    return out;
  }
  return value;
}

function size(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function capPayload(data: unknown, limit: number = TOOL_DATA_CAP): unknown {
  if (size(data) <= limit) return data;
  for (const keep of [64, 32, 16, 8, 4, 2, 1]) {
    const cut = cutArrays(data, keep);
    if (size(cut) <= limit) return cut;
  }
  const strings = cutStrings(cutArrays(data, 1), 512);
  if (size(strings) <= limit) return strings;
  return { truncated: true };
}

/* The tool_data event for one settled call, or null when the window gets nothing: a tool off
   the list, a failed call, or an answer that was not JSON (the proxy's "not running" sentence,
   a chart's picture). `name` is the full tool id as the child said it. */
export function toolDataFor(name: string, input: unknown, content: unknown, ok: boolean = true): DriverEvent | null {
  if (!ok || !isToolDataTool(name)) return null;
  const text = resultText(content);
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  return { kind: 'tool_data', name, input: scrub(input ?? {}), data: capPayload(scrub(parsed)) };
}

export type DriverState = 'off' | 'starting' | 'ready' | 'thinking' | 'stopped' | 'failed';

export type DriverOptions = {
  repo: string;
  port: number;
  nodeBin?: string;
  // Claude Code's binary, from config. Read only when the provider is Claude.
  claudeBin?: string;
  // The persona. It is the child's system prompt (see src/providers/), never a user message.
  systemPrompt?: string;
  // Which vendor's CLI this driver runs. Claude Code when unset, which is every caller that is
  // not the window's chat (src/crew.ts spawns Claude workers).
  provider?: Provider;
  // The app-owned directory the provider writes into: <dataDir>/agents/<vendor>. Unset in a test
  // or a worker, which get a directory under the system temp.
  home?: string;
  // 'chat' for the window's own conversations. It reaches src/mcp.ts as PHOSPHOR_SURFACE, which
  // leaves out the tools a money chat has no use for.
  surface?: 'chat';
  /* WHO THIS CHILD IS, on the roster and on its own tool surface.
     `analyst` is what src/crew.ts spawns. It reaches src/mcp.ts as PHOSPHOR_ROLE, and mcp.ts
     does not REGISTER the propose tools for an analyst at all: the capability is absent from
     that process rather than refused inside it, which is the same argument this file makes for
     the built-in lockdown and is stronger than a check. `parent` and `label` are the roster's,
     so a human looking at four agents can see which one spawned the other three. */
  role?: 'operator' | 'analyst';
  label?: string;
  parent?: string;
  /* The seat id this child announces to the app, chosen by whoever is starting it rather than
     minted here. A caller that has to know WHICH seat is this child's (the chat registry, so a
     card can be addressed to the conversation that asked for it) cannot read it back afterwards:
     `status().sessionId` is overwritten by the vendor's own id on the init event. Absent mints
     one, which is every caller that does not care. */
  session?: string;
  /* Which lockdown file Claude runs under. Left unset it is operator/driver.settings.json, and
     nothing in this app currently sets it: workers deliberately run under the SAME file. One
     lockdown, one test that checks it against the live Claude Code release
     (tests/lockdown.test.ts), and one string for the orphan sweep to match on. */
  settingsPath?: string;
  // Which model drives. Left unset, the vendor's own default. See the note in src/http/chats.ts.
  model?: string;
  onEvent: (event: DriverEvent) => void;
};

export type Driver = ReturnType<typeof createDriver>;

/* THE CHILD'S ENVIRONMENT IS A LIST OF NAMES THIS APP CHOSE, never the parent's minus a list.
   childEnv used to copy process.env and delete the twelve names in STRIPPED. Everything else in
   the shell that launched the app rode along into a process that `ps eww` shows to every other
   process this user runs: PHOSPHOR_1CLICK_API_KEY, which the list never named, and whatever
   AWS_SECRET_ACCESS_KEY, GITHUB_TOKEN or NPM_TOKEN a developer's shell carries. A denylist is
   a list of the names somebody thought of. This is the other kind of list: what a process needs
   to run at all (a path, a home, a locale, a temp dir, a terminal), plus the names each child's
   own code reads, added by name below. NODE_OPTIONS is deliberately not here: it is a way to
   load code into any Node process, and the runner child is one. */
export const INHERITED_ENV = ['PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM'] as const;

export function inheritedEnv(parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of INHERITED_ENV) if (parent[name] !== undefined) env[name] = parent[name];
  return env;
}

// Where Claude Code keeps its login when the person moved it off ~/.claude. Passed through when
// set and only then, because it is the one name outside INHERITED_ENV the child needs to be
// logged in: the credentials file lives under it, and a child that cannot find it answers
// "Not logged in" and the driver is dead (see the note above assertMemory).
const CLAUDE_CONFIG_DIR = 'CLAUDE_CONFIG_DIR';

// The names STRIPPED used to delete, kept as the statement of what must never reach an agent and
// as the second wall the test holds the allowlist against. ANTHROPIC_API_KEY would silently move
// billing off the subscription this whole design is built on, and a stray OPENAI_API_KEY has no
// business in a process that talks to a wallet. None of them is on INHERITED_ENV, so none is
// passed; this list is what says that on purpose rather than by omission.
export const STRIPPED = [
  /* The approval token, if anything ever puts it here again. It travels down the backend's stdin
     now (src/http/auth.ts), so this process has none to pass on, and the line stays because the
     failure it guards is total: a child holding the token could approve its own proposals, which
     is the one thing this app claims cannot happen. The lockdown in
     operator/driver.settings.json is what stops the agent reading its own environment today, and
     defence in depth means not resting a claim like that on one file. */
  'PHOSPHOR_WINDOW_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_SAFE_MODE',
  // xAI, which is what Grok bills to when no login is stored. The child runs on the login.
  'XAI_API_KEY',
  // Where the signing key is. The child has no reader, so this is defence in depth rather than
  // a hole being closed, and it is worth the two lines anyway: operator/settings.json denies
  // Read(~/.phosphor/**) by literal path, which says nothing about a key moved elsewhere by
  // PHOSPHOR_KEYS. Not telling the agent where the key is costs nothing, because nothing it is
  // allowed to do involves knowing.
  'PHOSPHOR_KEYS',
];

/* AUTO-MEMORY, which is the one context source `--setting-sources=` does not cover.
   The flag keeps somebody's settings, hooks, plugins and CLAUDE.md out of a session that drives
   a wallet, and measured against 2.1.263 it does exactly that for all three. It does not touch
   auto-memory: Claude Code loads <config root>/projects/<cwd slug>/memory/ before the first turn
   whatever the setting sources are. The child's cwd is this repo, so the path is computable by
   anyone who can write in the user's home directory, and a file there is system-level context in
   every future driver session. It can file proposals, and the ones at or below the policy click
   threshold execute with no human click at all. Reproduced with a canary on 2.1.263: the child
   read it and named it.
   CLAUDE_CODE_DISABLE_AUTO_MEMORY is what closes it, and the init event then carries no
   memory_paths at all. Two other routes were measured and refused. `--bare` skips auto-memory and
   makes Anthropic auth strictly ANTHROPIC_API_KEY or apiKeyHelper, and STRIPPED above deletes the
   first on purpose, so it would move billing off the subscription. CLAUDE_CONFIG_DIR does move the
   memory path into a directory this app owns, and it moves .credentials.json with it: a child
   spawned that way answers "Not logged in - Please run /login" and the driver is dead.
   The variable is a claim, so it is not where the guarantee rests. assertMemory below reads the
   child's own answer back, exactly as the provider does for tools, which is what survives a
   release that renames it. */
const DISABLE_AUTO_MEMORY = 'CLAUDE_CODE_DISABLE_AUTO_MEMORY';

/* Every memory file the child says it loaded. Empty is the only acceptable answer.
   Absent and null are both empty, because a release that stops reporting the field is reporting
   nothing rather than reporting memory; the value being a surprise shape is not, and reads as one
   offender so the session still refuses. */
export function assertMemory(memoryPaths: unknown): string[] {
  if (memoryPaths === undefined || memoryPaths === null) return [];
  if (typeof memoryPaths !== 'object') return ['<the init event carried a memory_paths this app cannot read>'];
  const found: string[] = [];
  for (const [kind, value] of Object.entries(memoryPaths as Record<string, unknown>)) {
    if (typeof value === 'string' && value.length > 0) found.push(`${kind}: ${value}`);
  }
  return found;
}

/* THE ROSTER SEAT SECRET, written once at boot from src/main.ts and read by every child spawned
   after that. It is here rather than on DriverOptions because there is exactly one backend process
   and exactly one secret in it, and threading it through every caller that builds a driver would
   mean the app's two spawn sites (src/http/chats.ts and src/crew.ts) could each forget it.
   What it buys: src/agents.ts holds back seats for the agents this app starts, so six
   unauthenticated hellos can no longer fill the roster and lock the human's own agent out. What it
   is not: an authorisation for anything the agent does. Every tool the child holds it would hold
   without this, and nothing in the propose path reads it.
   It travels to the child in its environment, which `ps eww <pid>` prints for any process this
   user owns, so it is weaker than the window token and deliberately guards something smaller.
   The window token is stripped from that same environment for exactly that reason (see STRIPPED). */
let seatSecret = '';

export function useSeatSecret(value: string): void {
  seatSecret = value;
}

export function childEnv(
  repo: string,
  port: number,
  sessionId: string,
  identity?: { role?: string; label?: string; parent?: string; surface?: string },
  parent: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  // See INHERITED_ENV: the names a process needs, and nothing the parent's shell happened to hold.
  const env = inheritedEnv(parent);
  for (const key of STRIPPED) delete env[key];
  if (parent[CLAUDE_CONFIG_DIR] !== undefined) env[CLAUDE_CONFIG_DIR] = parent[CLAUDE_CONFIG_DIR];
  // See the note above assertMemory. This is what keeps ~/.claude/projects/<slug>/memory/ out of
  // a session that can move money; assertMemory is what checks that it worked.
  env[DISABLE_AUTO_MEMORY] = '1';
  // See useSeatSecret. src/mcp.ts sends it on every call so the roster can tell an agent this app
  // started from any other local process. Absent in a boot that never got one, which is a roster
  // that seats app-minted session ids and nothing else.
  if (seatSecret) env.PHOSPHOR_SEAT = seatSecret;
  // The MCP proxy the child spawns has to find the same app instance the window is talking to.
  env.ACC_PORT = String(port);
  env.PHOSPHOR_REPO = repo;
  // One seat for the whole conversation. A vendor may start the MCP server more than once for a
  // single session (Grok starts one per turn), and each copy would otherwise mint its own id, so
  // the app would see two agents, seat one, and refuse every call the other made. See the note on
  // SESSION in src/mcp.ts.
  env.PHOSPHOR_SESSION = sessionId;
  // The identity the child announces to the app, written by the APP and not by the child. A
  // role the agent could choose for itself would be a role it could raise.
  if (identity?.role) env.PHOSPHOR_ROLE = identity.role;
  if (identity?.label) env.PHOSPHOR_LABEL = identity.label;
  if (identity?.parent) env.PHOSPHOR_PARENT = identity.parent;
  if (identity?.surface) env.PHOSPHOR_SURFACE = identity.surface;
  return env;
}

/* ---------- orphans from a run that is over ----------

   Everything above stops an agent this process started. Nothing above can stop one left by a
   process that was itself killed outright: the child is detached, so it is reparented to
   launchd and keeps running with no window, no seat and no way to be reached. Before the
   escalation below existed that happened on every quit, and one is already on the machine of
   anyone who has been running this app.

   THE MATCH IS THIS INSTALLATION'S OWN LOCKDOWN FILE, and the precision is the entire safety
   argument. Anyone running Phosphor is likely to have their own Claude Code sessions open, and
   a sweep that matched on the binary name would kill their work. The absolute path of
   operator/driver.settings.json appears in the child's argv because this app put it there; no
   other session on the machine is carrying it. A Grok child is one process per turn and leaves
   on its own when the turn ends, so there is nothing of it to sweep. */

export function findOrphans(settings: string, psOutput: string, selfPid: number): number[] {
  const found: number[] = [];
  for (const line of psOutput.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match === null) continue;
    const pid = Number(match[1]);
    const args = match[2];
    if (!Number.isInteger(pid) || pid <= 1 || pid === selfPid) continue;
    // Both, not either: the settings path alone would match a person reading the file, and
    // the stream flags alone would match any headless session on the machine.
    if (!args.includes(settings)) continue;
    if (!args.includes('--input-format') || !args.includes('stream-json')) continue;
    found.push(pid);
  }
  return found;
}

/* Called once at boot, from src/main.ts, before anything can start a driver of its own. Safe
   at exactly that moment and not at any other: the app has just taken the port, so a Phosphor
   agent alive anywhere on this machine belongs to a run that is over. Returns the pids it
   signalled so the caller can say so in the audit log. */
export function sweepOrphans(repo: string, now: () => number = Date.now): number[] {
  const settings = path.join(repo, 'operator', 'driver.settings.json');
  let listing = '';
  try {
    listing = execFileSync('/bin/ps', ['-axo', 'pid=,args='], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  } catch {
    // No ps, or a platform without one. An orphan left behind is worse than a sweep that did
    // not run, but neither is worth refusing to start the app over.
    return [];
  }
  const orphans = findOrphans(settings, listing, process.pid);
  for (const pid of orphans) {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        continue;
      }
    }
  }
  // One grace for the whole set, then whatever is left is taken out. Same escalation as a
  // live stop, and the same reason: asked first, made second.
  const deadline = now() + TERM_GRACE_MS;
  while (now() < deadline) {
    if (!orphans.some(stillThere)) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, POLL_MS);
  }
  for (const pid of orphans) {
    if (!stillThere(pid)) continue;
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* gone between the look and the signal */
    }
  }
  return orphans;
}

function stillThere(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// A provider that refuses to run says why in its own sentence (src/providers/), and that sentence
// is the one the window shows.
function reasonOf(error: unknown, fallback: string): string {
  const own = (error as { reason?: unknown } | null)?.reason;
  return typeof own === 'string' ? own : fallback;
}

export function createDriver(opts: DriverOptions) {
  const provider = opts.provider ?? claude;
  const settings = opts.settingsPath ?? path.join(opts.repo, 'operator', 'driver.settings.json');
  const home = opts.home ?? path.join(os.tmpdir(), 'phosphor-agents', provider.id);
  let child: ChildProcessWithoutNullStreams | null = null;
  let state: DriverState = 'off';
  let sessionId = '';
  // The seat this child announces to the app as PHOSPHOR_SESSION: the chat's own, so a card finds
  // the conversation that asked for it.
  let seat = '';
  // The session id the vendor was asked to create, which is the one a turn process resumes. The
  // same as the seat for Claude, whose sessions are never kept; a fresh one for each Grok session,
  // because grok refuses --session-id for an id it already holds (a restarted chat would reuse it).
  let session = '';
  // turn transport: whether the vendor holds the session yet, so a first turn that failed
  // before it existed is not followed by a resume of nothing.
  let resumable = false;
  let interrupted = false;
  // turn transport: the result line arrived, so the exit that follows reports no second turn_end.
  let answered = false;
  let buffer = '';

  /* ONE TURN AT A TIME, even across a stop (S3, S5 of the 2026-09-23 review).
     stdin transport: `owed` counts the result lines the child still owes, one per message
     written. Claude answers in order and a stopped answer still prints its result, measured on
     2.1.281 to land after a message written right behind the interrupt, so the chat is ready
     only when nothing is owed. Otherwise that late result read as the end of the next answer.
     turn transport: `turn` is the process whose exit ends the turn, `draining` the process group
     of the last one until it is seen gone, and `held` a message sent before then. It goes once
     the group is gone, so one session never has two grok processes, and the old turn's MCP proxy
     has said its bye before the next one says hello on the same seat. */
  let owed = 0;
  let turn: ChildProcessWithoutNullStreams | null = null;
  let draining: number | null = null;
  let held: string | null = null;

  /* Whether the last turn to end was cut short (a stop, a failure, a stop of the whole chat). A
     proposal that turn made may still be landing, so the web-read mark (src/web-read.ts) is kept
     through the next turn. Not reset by start(): a chat restarted after a stop is the same case. */
  let stoppedLast = false;

  // A message of the person's starts its turn: the web-read mark ends here, unless the turn
  // before it was cut short.
  function freshTurn(): void {
    if (!stoppedLast) clearWebRead(seat);
  }

  /* App-authored context waiting for the person's next message (src/http/ended.ts: a move that
     ended since the last answer). It never starts a turn of its own: waking the agent for a card
     the person can already see cost a paragraph each time (R3, five in eight minutes). */
  let notes: string[] = [];

  /* Set by stop(), so the exit that follows a requested stop carries no reason: the person
     asked for it, and a sentence explaining it would read as something having gone wrong. */
  let stopping = false;

  /* The calls in flight, by the id the model gave them. A tool_result block carries
     `tool_use_id` and nothing else that names the tool, so the name is read back off the
     tool_use that opened it. Cleared at every turn end, so an id from a turn that was
     interrupted cannot name a later call. `meta` is a vendor's own lookup (Grok's search_tool):
     allowed, and never drawn. */
  const calls = new Map<string, { name: string; input: unknown; meta: boolean }>();

  /* The text blocks streaming now. A text block opens with content_block_start and gets the next
     number; its deltas carry that number; the whole block, when the assistant event carries it,
     closes the oldest open one. Claude sends that event per block and Grok once per message, and
     the queue reads both the same way. */
  let blockSeq = 0;
  let streaming: number[] = [];
  let current: number | null = null;

  function set(next: DriverState, detail?: string, reason?: string): void {
    state = next;
    const event: DriverEvent = { kind: 'status', state: next, detail };
    if (reason !== undefined) event.reason = reason;
    opts.onEvent(event);
  }

  /* Every failure names itself twice: `message` is the log line, exact and technical, and
     `reason` is the one plain sentence the window shows beside its Retry. */
  function fail(message: string, reason: string): void {
    letGo();
    set('failed', message, reason);
    opts.onEvent({ kind: 'error', message });
    kill();
    forget();
    bury();
  }

  // A stop or a failure: the turn in flight ends nothing when its process exits, and a message
  // waiting for it goes nowhere.
  function letGo(): void {
    if (state === 'thinking') stoppedLast = true;
    turn = null;
    held = null;
  }

  // The files this session wrote for its child (Claude's persona, Grok's turn), once read.
  function forget(): void {
    if (session !== '') provider.cleanup?.({ home, sessionId: session });
  }

  // What the vendor kept of a session that is over (Grok's history of it).
  function bury(): void {
    if (session === '') return;
    try {
      provider.endSession?.({ home, sessionId: session });
    } catch {
      /* a history file that will not go is not worth failing a stop over */
    }
  }

  function onInit(event: Record<string, unknown>): void {
    const unexpected = provider.surface(event);
    if (unexpected.length > 0) {
      fail(
        `refusing to drive: the agent was given ${unexpected.length} tool(s) or server(s) outside Phosphor's own surface (${unexpected.join(', ')}). This is a lockdown failure, not a configuration preference.`,
        'The assistant stopped: it was given tools this app does not allow.',
      );
      return;
    }
    /* The same check for context that the line above makes for tools. A memory file the app
       never wrote is somebody else's instructions arriving as the system prompt of a session
       that proposes with the user's money, and childEnv setting a variable is a claim about
       somebody else's release. This is the answer the child gave. */
    const memories = assertMemory(event.memory_paths);
    if (memories.length > 0) {
      fail(
        `refusing to drive: the agent loaded ${memories.length} memory file(s) this app did not write (${memories.join(', ')}). ` +
          `${DISABLE_AUTO_MEMORY} did not take, and auto-memory is a file anyone on this machine can write into a session that moves money.`,
        'The assistant stopped: it loaded memory this app did not write.',
      );
      return;
    }
    /* A session whose MCP server did not attach is not a degraded session, it is a useless
       one: the agent holds no tools at all, so it answers from memory about a wallet it
       cannot read, and silence there looks exactly like a thoughtful agent.
       The statuses are split rather than compared against 'connected', because both vendors
       also report 'pending' and 'connecting', and a server that is merely still attaching is
       not a dead one. Killing on those would refuse sessions that were about to work. Nothing
       is being risked by waiting: the surface check above has already established that
       whatever does attach cannot bring a built-in tool with it. */
    const servers = Array.isArray(event.mcp_servers) ? (event.mcp_servers as Array<Record<string, unknown>>) : [];
    const phosphor = servers.find((s) => s.name === 'phosphor');
    const status = phosphor === undefined ? 'absent' : String(phosphor.status);
    if (status === 'absent' || status === 'failed' || status === 'needs-auth' || status === 'disconnected') {
      fail(
        `driver: the agent started but cannot reach Phosphor's own tools (${status === 'absent' ? 'the server did not load' : status}). It could talk and read nothing, so the session is stopped.`,
        "The assistant stopped: it could not reach Phosphor's tools.",
      );
      return;
    }
    // Grok's server attaches while its first model call is in flight on every turn, so only a
    // long-lived child says it is still starting.
    if (status !== 'connected' && provider.transport === 'stdin') set('starting', `waiting for Phosphor's tools to attach (${status})`);
    resumable = true;
    sessionId = typeof event.session_id === 'string' ? event.session_id : sessionId;
    // The child printed init, so it has read its persona and its turn: neither stays on disk.
    forget();
  }

  function onStream(event: Record<string, unknown>): void {
    const inner = event.event as { type?: unknown; content_block?: { type?: unknown }; delta?: { type?: unknown; text?: unknown } } | undefined;
    if (inner === undefined || inner === null) return;
    if (inner.type === 'content_block_start') {
      if (inner.content_block?.type === 'text') {
        blockSeq += 1;
        streaming.push(blockSeq);
        current = blockSeq;
      } else {
        current = null;
      }
      return;
    }
    if (inner.type === 'content_block_delta' && current !== null && inner.delta?.type === 'text_delta' && typeof inner.delta.text === 'string') {
      opts.onEvent({ kind: 'delta', block: current, text: inner.delta.text });
      return;
    }
    if (inner.type === 'content_block_stop') current = null;
  }

  function onAssistant(event: Record<string, unknown>): void {
    const message = event.message as { content?: Array<Record<string, unknown>> } | undefined;
    for (const block of message?.content ?? []) {
      if (block.type === 'text' && typeof block.text === 'string') {
        const number = streaming.shift() ?? ++blockSeq;
        opts.onEvent({ kind: 'text', text: block.text, block: number });
      }
      /* A tool block of any kind is read by the provider: tool_use is a call the child runs, and
         server_tool_use (any other *_tool_use) is one the API ran for the model inside its reply.
         The provider names Phosphor's own, the web tools allowed on 2026-09-23, and anything else,
         which ends the session. */
      const server = typeof block.type === 'string' && block.type !== 'tool_use' && block.type.endsWith('tool_use');
      if ((block.type === 'tool_use' || server) && typeof block.name === 'string') {
        const call = provider.tool(block.name, block.input, server);
        if (call.kind === 'builtin') {
          fail(
            `refusing to drive: the agent called ${call.name}, a tool outside Phosphor's own surface. This is a lockdown failure, not a configuration preference.`,
            'The assistant stopped: it reached for a tool this app does not allow.',
          );
          return;
        }
        const id = typeof block.id === 'string' ? block.id : '';
        if (call.kind === 'meta') {
          if (id !== '') calls.set(id, { name: block.name, input: block.input, meta: true });
          continue;
        }
        if (call.kind === 'web') markWebRead(seat);
        const input = call.kind === 'web' ? block.input : call.input;
        if (id !== '') calls.set(id, { name: call.name, input, meta: false });
        opts.onEvent({ kind: 'tool', name: call.name, input });
      }
      // The result of a tool the API ran rides in the same reply (web_search_tool_result).
      if (typeof block.type === 'string' && block.type !== 'tool_result' && block.type.endsWith('_tool_result')) {
        const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
        const call = calls.get(id);
        if (call !== undefined) {
          calls.delete(id);
          const inner = block.content as { type?: unknown } | null;
          const failed = inner !== null && typeof inner === 'object' && typeof inner.type === 'string' && inner.type.endsWith('_error');
          opts.onEvent({ kind: 'tool_result', name: call.name, ok: !failed });
        }
      }
      if (server && typeof block.name !== 'string') {
        fail(
          `refusing to drive: the agent's reply carried a ${String(block.type)} block with no name, a tool this app cannot read. This is a lockdown failure, not a configuration preference.`,
          'The assistant stopped: it reached for a tool this app does not allow.',
        );
        return;
      }
    }
  }

  function onUser(event: Record<string, unknown>): void {
    const message = event.message as { content?: Array<Record<string, unknown>> } | undefined;
    for (const block of message?.content ?? []) {
      if (block.type !== 'tool_result') continue;
      const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
      const call = calls.get(id);
      if (call !== undefined) calls.delete(id);
      if (call?.meta === true) continue;
      const name = call?.name ?? (typeof block.name === 'string' ? block.name : 'tool');
      const content = provider.result(block.content);
      const ok = block.is_error !== true && content !== null;
      opts.onEvent({ kind: 'tool_result', name, ok });
      const data = toolDataFor(name, call?.input, content, ok);
      if (data !== null) opts.onEvent(data);
    }
  }

  function endTurn(): void {
    calls.clear();
    streaming = [];
    current = null;
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
    if (event.type === 'system' && event.subtype === 'init') return onInit(event);
    if (event.type === 'stream_event') return onStream(event);
    if (event.type === 'assistant') return onAssistant(event);
    if (event.type === 'user') return onUser(event);
    if (event.type === 'result') {
      endTurn();
      const turns = typeof event.num_turns === 'number' ? event.num_turns : 0;
      /* A turn process is still alive after its result line, and a message sent to a chat that
         said ready then would be refused as still answering. Its exit says ready (turnExited). */
      if (provider.transport === 'turn') {
        opts.onEvent({ kind: 'turn_end', error: event.is_error === true, turns });
        answered = true;
        return;
      }
      // A stopped answer ends in error_during_execution, and a stop the person asked for is not
      // an error. The next result after an interrupt is the stopped answer's: Claude answers in order.
      const stopped = interrupted;
      interrupted = false;
      stoppedLast = stopped;
      opts.onEvent({ kind: 'turn_end', error: event.is_error === true && !stopped, turns });
      owed = Math.max(0, owed - 1);
      if (state === 'failed' || state === 'stopped') return;
      // The next message the person sent starts its turn now.
      if (owed > 0) return freshTurn();
      set('ready', stopped ? 'the human stopped this answer' : undefined);
    }
  }

  function spawnSpec(extra: { prompt?: string } = {}): SpawnSpec {
    return provider.spawn({
      repo: opts.repo,
      nodeBin: opts.nodeBin ?? process.execPath,
      home,
      bin: provider.id === 'claude' ? opts.claudeBin : undefined,
      sessionId: session,
      model: opts.model,
      env: childEnv(opts.repo, opts.port, seat, {
        role: opts.role,
        label: opts.label,
        parent: opts.parent,
        surface: opts.surface,
      }),
      systemPrompt: opts.systemPrompt ?? '',
      settings,
      prompt: extra.prompt,
      resume: resumable,
    });
  }

  function spawnChild(spec: SpawnSpec): void {
    /* detached, so the child leads its own process group and kill() below can take the group
       rather than one pid. It matters because the child immediately spawns a third process of
       its own, the MCP proxy in src/mcp.ts, and killing only the agent would leave that proxy
       running against a window that has gone. Detached does NOT mean it outlives the app: the
       exit handlers registered below are what guarantee it does not.
       Held in `proc` as well as in `child`, because kill() nulls `child` the moment a stop or an
       interrupt is asked for, and the process is still there for up to TERM_GRACE_MS after that.
       The handlers below belong to the process that registered them, not to whichever one is
       current. */
    const proc = spawn(spec.bin, spec.argv, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    }) as ChildProcessWithoutNullStreams;
    child = proc;
    buffer = '';
    if (provider.transport === 'turn') {
      turn = proc;
      draining = proc.pid ?? null;
    }
    armExitGuard();
    // A pipe that closes under a write, because the child left before reading it, is a story the
    // child's exit code and stderr already tell; without a listener it would throw instead.
    proc.stdin.on('error', () => {});
    // A turn process takes its whole input at spawn (the prompt is a file), so its stdin closes.
    if (provider.transport === 'turn') proc.stdin.end();

    // setEncoding('utf8') rather than decoding chunks by hand, because a multi-byte character
    // split across a chunk boundary is otherwise corrupted, and the agent writes token names.
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      // A process that has been asked to go is no longer the conversation: its last lines would
      // land in the next one's buffer, or flip a stopped session back to ready on a late result.
      if (child !== proc) return;
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      // A line is a JSON event and events are not this big. Without a cap, a child that emits
      // an unterminated line grows this string until the app it is a feature of runs out of
      // memory, and the app dies holding the keys. Refusing the session is the smaller failure.
      if (buffer.length > MAX_LINE) {
        buffer = '';
        fail(
          `driver: the agent emitted a single line over ${Math.round(MAX_LINE / 1024)}KB, which is not an event this app knows how to read.`,
          'The assistant stopped: it sent something this app could not read.',
        );
        return;
      }
      // Per line, not per chunk: a refusal on one line nulls `child`, and the lines behind it
      // belong to a turn that has been refused.
      for (const line of lines) {
        if (child !== proc) return;
        if (line.trim()) onLine(line);
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => {
      // A child that has been asked to go is not this chat's to speak for any more.
      if (child !== proc) return;
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
    proc.on('spawn', () => {
      if (state === 'starting') set('ready');
    });
    proc.on('error', (error) => fail(`driver: could not start ${spec.bin}: ${error.message}`, `${provider.name} could not start.`));
    proc.on('exit', (code, signal) => {
      if (provider.transport === 'turn') {
        if (child === proc) child = null;
        // The turn it ran ends here, unless a stop or a failure already let go of it.
        if (turn === proc) {
          turn = null;
          buffer = '';
          turnExited(code);
        }
        const pid = proc.pid;
        if (pid !== undefined) whenGone(pid, () => drained(pid));
        return;
      }
      // The exit of a process that has already been replaced says nothing about the session.
      if (child !== null && child !== proc) return;
      child = null;
      buffer = '';
      forget();
      calls.clear();
      const asked = stopping;
      stopping = false;
      if (state === 'failed' || state === 'stopped') return;
      /* A clean exit, or one the person asked for, is the state word and nothing more. Any
         other exit is the child leaving on its own, which is the one thing the window has to
         say out loud. */
      if (asked || code === 0) {
        set('stopped');
        return;
      }
      const how = code === null ? `it was killed by ${signal ?? 'a signal'}` : `it exited with code ${code}`;
      set('stopped', `the agent exited with code ${code}`, `The assistant stopped: ${how}.`);
    });
  }

  /* One process per turn: its exit ends the turn, never the chat. A turn that ended without its
     result line (the person stopped it, or the vendor gave up) is reported here, so the window's
     clock stops either way. */
  function turnExited(code: number | null): void {
    const live = state === 'thinking' || state === 'starting';
    forget();
    endTurn();
    const said = answered;
    answered = false;
    if (!live) return;
    const stopped = interrupted;
    interrupted = false;
    stoppedLast = stopped;
    if (!said) opts.onEvent({ kind: 'turn_end', error: !stopped && code !== 0, turns: 0 });
    // A message sent while this turn was ending goes the moment its process group is gone.
    if (held !== null) return;
    if (stopped) set('ready', 'the human stopped this answer');
    else set('ready', code === 0 || code === null ? undefined : `the agent exited with code ${code}`);
  }

  /* Calls back once a process group this driver started is gone. kill() already escalates a group
     it asked to go; one that went on its own (a turn's grok, then its MCP proxy after its bye) is
     watched for twice that grace, and whatever is left of it then is killed before the wait ends,
     so the next turn never starts beside it. */
  function whenGone(pid: number, then: () => void): void {
    const deadline = Date.now() + TERM_GRACE_MS * 2;
    const check = (): void => {
      if (!groupAlive(pid)) return then();
      if (Date.now() >= deadline) {
        signalGroup(pid, 'SIGKILL');
        return then();
      }
      setTimeout(check, POLL_MS).unref();
    };
    check();
  }

  // turn transport: the last turn's group is gone, so the message waiting for it goes now.
  function drained(pid: number): void {
    if (draining !== pid) return;
    draining = null;
    if (held === null) return;
    const body = held;
    held = null;
    dispatch(body);
  }

  // turn transport: one message, one process.
  function dispatch(body: string): void {
    freshTurn();
    interrupted = false;
    // No session the vendor holds yet (a fresh start, or a turn that never reached init): a
    // new id, never one grok may already have.
    if (!resumable) session = randomUUID();
    let spec: SpawnSpec;
    try {
      spec = spawnSpec({ prompt: body });
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error), reasonOf(error, `${provider.name} could not start.`));
      return;
    }
    set('thinking');
    spawnChild(spec);
  }

  function start(): void {
    if (child) return;
    if (provider.transport === 'turn' && (state === 'ready' || state === 'thinking')) return;
    stopping = false;
    interrupted = false;
    notes = [];
    set('starting');
    try {
      provider.resolveBin(provider.id === 'claude' ? opts.claudeBin : undefined);
    } catch (error) {
      const missing =
        provider.id === 'claude'
          ? opts.claudeBin
            ? 'Claude Code is not at the path set in config.json.'
            : 'Claude Code is not installed on this Mac.'
          : `${provider.name} is not installed on this Mac.`;
      fail(error instanceof Error ? error.message : String(error), reasonOf(error, missing));
      return;
    }
    if (provider.id === 'claude' && !fs.existsSync(settings)) {
      fail(
        `driver: ${settings} is missing, and the app will not spawn an agent without its lockdown file.`,
        "The assistant's lockdown file is missing, so it will not start.",
      );
      return;
    }
    if (provider.id === 'grok' && !fs.existsSync(userAuthFile())) {
      fail('driver: no Grok login was found (auth.json is missing).', 'Grok is not signed in. Run grok login in a terminal, then start it again.');
      return;
    }

    sessionId = opts.session ?? randomUUID();
    seat = sessionId;
    session = seat;
    resumable = false;
    answered = false;
    owed = 0;
    held = null;
    if (provider.transport === 'turn') {
      // Nothing to spawn until there is a turn. Ready means "will answer", which is true.
      set('ready');
      return;
    }
    let spec: SpawnSpec;
    try {
      spec = spawnSpec();
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error), reasonOf(error, `${provider.name} could not start.`));
      return;
    }
    spawnChild(spec);
  }

  // App context for the next turn the person sends. See `notes`.
  function note(text: string): void {
    if (state === 'off' || state === 'stopped' || state === 'failed') return;
    notes.push(text);
  }

  function send(text: string): void {
    if (state === 'failed' || state === 'off' || state === 'stopped') throw new Error('driver: no agent is running');
    const body = notes.length === 0 ? text : `${notes.join('\n\n')}\n\n${text}`;
    if (provider.transport === 'turn') {
      if (child || held !== null) throw new Error('driver: the agent is still answering');
      notes = [];
      if (draining !== null) {
        held = body;
        set('thinking');
        return;
      }
      dispatch(body);
      return;
    }
    if (!child) throw new Error('driver: no agent is running');
    // Behind a turn still running, this message starts when that one's result is out.
    if (owed === 0) freshTurn();
    child.stdin.write(provider.encodeTurn!(body));
    owed += 1;
    notes = [];
    set('thinking');
  }

  /* Stop THIS answer without stopping the agent.
     Before this existed there was one way out of a turn that had gone wrong, which was killing
     the session, and killing the session throws away the conversation with it. So a human who
     asked the wrong question, or watched the agent set off down a nine-call analysis they did
     not want, paid for it with everything said so far plus a cold start.
     Claude takes a control request with subtype `interrupt` on the same stdin the turns go
     down, then emits the ordinary `result` event for the aborted turn, which is what says ready.
     A Grok turn IS its process, so it is ended and the next turn resumes the session once the
     process group is gone; the exit handler reports it.
     Guarded on `thinking` because an interrupt sent to an idle child is a request with no turn
     to cancel, and the answer to it is an error the human did not cause. */
  function interrupt(): boolean {
    if (!child || state !== 'thinking') return false;
    if (provider.transport === 'turn') {
      interrupted = true;
      kill();
      return true;
    }
    try {
      child.stdin.write(provider.encodeInterrupt!());
    } catch {
      // The pipe closes when the child dies first, and a dead child needs no interrupting.
      return false;
    }
    interrupted = true;
    return true;
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

  /* Groups this driver started and has not yet watched die. Almost always empty or one; it
     holds two only in the window between a stop and the group actually going. */
  const groups = new Set<number>();

  function groupAlive(pid: number): boolean {
    try {
      process.kill(-pid, 0);
      return true;
    } catch (error) {
      // EPERM is a group that exists and is not ours to signal, which still counts as there.
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  }

  function sleepSync(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  }

  /* ASKED TO GO, THEN MADE TO GO.
     The old version of this sent SIGTERM and scheduled a SIGKILL two seconds later on an
     unref'd timer, which is a backstop that cannot fire in the one case it exists for: on the
     app's own way out the loop is already finished, so the timer is dropped and SIGTERM is the
     only signal the agent ever gets. A Claude Code process that was mid-request when it
     arrived then outlived the app that spawned it, detached, holding half a gigabyte, with no
     window and nothing left to collect it. That is Karim's "they blat up the pc": every quit
     leaked one, and they accumulate until the machine is rebooted.
     So the escalation is real now. SIGTERM, then the group is watched, then SIGKILL, and
     killSync below does the same thing without a timer for the callers that have no loop
     left. */
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
    groups.add(pid);
    signalGroup(pid, 'SIGTERM');
    /* Polled rather than one late SIGKILL, so a child that leaves at once is off the books at
       once and a child that hangs is taken out the moment its grace is spent. Unref'd because
       a pending burial must never be the reason the app stays up; killSync owns the exit. */
    let waited = 0;
    const watch = setInterval(() => {
      waited += POLL_MS;
      if (!groupAlive(pid)) {
        groups.delete(pid);
        clearInterval(watch);
        return;
      }
      if (waited < TERM_GRACE_MS) return;
      clearInterval(watch);
      signalGroup(pid, 'SIGKILL');
      groups.delete(pid);
    }, POLL_MS);
    watch.unref();
  }

  /* The same burial, synchronously, for the two callers where a timer is worthless: process
     'exit', and a signal handler whose next line is process.exit(). Blocking the loop is the
     point rather than a cost. The app is leaving, and the one thing that has to be true before
     it does is that the process it spawned is gone. */
  function killSync(): void {
    kill();
    const deadline = Date.now() + TERM_GRACE_MS;
    for (const pid of groups) {
      while (groupAlive(pid) && Date.now() < deadline) sleepSync(POLL_MS);
      if (groupAlive(pid)) signalGroup(pid, 'SIGKILL');
      groups.delete(pid);
    }
  }

  // A driver that outlives the window would keep the seat, keep spending the user's
  // subscription, and keep proposing into a state directory nobody is watching. These cover
  // every exit the parent can observe; a SIGKILL of the app itself is the one case no process
  // can handle, and the seat TTL in src/agents.ts is what closes that one.
  let guarded = false;
  function armExitGuard(): void {
    if (guarded) return;
    guarded = true;
    process.once('exit', () => killSync());
    // Signals are NOT registered here any more. src/shutdown.ts owns SIGINT, SIGTERM and SIGHUP
    // unconditionally at boot, and its handler ends in process.exit, which runs the 'exit'
    // listener above. Two owners meant the first one to answer decided, and this one answered by
    // calling process.exit(0) immediately: the drain never got its two seconds.
  }

  function stop(): void {
    stopping = child !== null;
    letGo();
    kill();
    notes = [];
    forget();
    bury();
    if (state !== 'failed') set('stopped');
  }

  return {
    start,
    send,
    note,
    interrupt,
    stop,
    status: () => ({
      state,
      sessionId,
      // The turn transport is running whenever it will answer, whether or not a process is alive
      // at this instant; the stdin transport is running exactly when its process is.
      running: child !== null || (provider.transport === 'turn' && (state === 'ready' || state === 'thinking' || state === 'starting')),
    }),
  };
}
