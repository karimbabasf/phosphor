// The agent catalog: six entries, a four-state check per agent driven over fixture binaries, one
// sentence per state, the connection line per agent, and the registration the app writes.
//
// Every check here runs the real probe path (src/agents-catalog.ts spawning a process) over the
// fake-<agent>-<state>.sh scripts in tests/fixtures, so what is proven is the parsing of what
// each vendor's binary prints, not a table the test wrote. The hang fixture proves the three
// second promise: a binary that never answers still gets a state word inside it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AGENTS,
  agentById,
  checkAgent,
  connectionLine,
  findAgentBin,
  readPick,
  registerAgent,
  registrationArgs,
  scanAgents,
  shellQuote,
  stateSentence,
  writePick,
  type AgentId,
  type ConnectionSpec,
  type Run,
} from '../../src/agents-catalog.ts';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const FIXTURES = path.join(ROOT, 'tests', 'fixtures');
const fixture = (name: string): string => path.join(FIXTURES, name);

// A home with nothing in it and a PATH that names nothing, so only the override finds a binary.
function bareHome(): { home: string; env: NodeJS.ProcessEnv } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-agents-'));
  return { home, env: { HOME: home, PATH: '/nonexistent' } };
}

const SPEC: ConnectionSpec = {
  nodeBin: '/Applications/Phosphor.app/Contents/MacOS/node',
  serverPath: '/Applications/Phosphor.app/Contents/Resources/phosphor/src/mcp.ts',
  port: 4177,
  dataDir: '/Users/x/Library/Application Support/com.karimbabasf.phosphor/state',
};

/* ---------- the list ---------- */

test('the catalog holds the six entries the picker offers, in the order it shows them', () => {
  assert.deepEqual(
    AGENTS.map((a) => a.id),
    ['claude', 'codex', 'hermes', 'grok', 'mcp', 'desktop'],
  );
  assert.deepEqual(
    AGENTS.map((a) => a.name),
    ['Claude Code', 'Codex', 'Hermes', 'Grok', 'Another agent', 'Claude Desktop or a chat app'],
  );
  // The window's chat runs the agents whose tool surface the app reads back (src/providers/).
  assert.deepEqual(AGENTS.filter((a) => a.inApp).map((a) => a.id), ['claude', 'grok']);
  // The app writes the registration where the agent owns a config it can write through.
  assert.deepEqual(AGENTS.filter((a) => a.registers).map((a) => a.id), ['claude', 'codex', 'hermes', 'grok']);
  assert.equal(agentById('nope'), null);
  assert.equal(agentById(42), null);
});

/* ---------- the check, per agent and state ---------- */

const CASES: Array<[AgentId, string, string]> = [
  ['claude', 'fake-claude-logged-in.sh', 'installed_and_logged_in'],
  ['claude', 'fake-claude-logged-out.sh', 'installed_not_logged_in'],
  ['codex', 'fake-codex-logged-in.sh', 'installed_and_logged_in'],
  ['codex', 'fake-codex-logged-out.sh', 'installed_not_logged_in'],
  ['hermes', 'fake-hermes-logged-in.sh', 'installed_and_logged_in'],
  ['hermes', 'fake-hermes-logged-out.sh', 'installed_not_logged_in'],
];

for (const [agent, script, expected] of CASES) {
  test(`${agent} over ${script} is ${expected}, with the version behind Details and no path in the sentence`, async () => {
    const { home, env } = bareHome();
    const check = await checkAgent(agent, { env, home, bin: fixture(script) });
    assert.equal(check.state, expected);
    assert.equal(check.probed, true);
    assert.equal(check.bin, fixture(script));
    assert.ok(check.version !== null && check.version.length > 0, 'the version was not read');
    assert.ok(check.ms < 3_000, `the check took ${check.ms} ms`);
    assert.equal(check.sentence, stateSentence(agentById(agent)!, check.state as never));
    assert.ok(!check.sentence.includes('/'), `a path reached the sentence: ${check.sentence}`);
    assert.ok(check.details.some((line) => line.includes(check.version as string)), 'the version is not behind Details');
    assert.ok(check.details.some((line) => line.includes(fixture(script))), 'the path is not behind Details');
  });
}

test('grok is signed in when its auth.json exists in GROK_HOME and signed out when it does not', async () => {
  const { home, env } = bareHome();
  const out = await checkAgent('grok', { env, home, bin: fixture('fake-grok-logged-out.sh') });
  assert.equal(out.state, 'installed_not_logged_in');
  assert.equal(out.version, 'grok 1.0.34 (3736acbc8658) [stable]');

  const grokHome = path.join(home, 'grok-home');
  fs.mkdirSync(grokHome, { recursive: true });
  fs.writeFileSync(path.join(grokHome, 'auth.json'), JSON.stringify({ 'https://auth.x.ai::abc': { key: 'never-read' } }));
  const on = await checkAgent('grok', { env: { ...env, GROK_HOME: grokHome }, home, bin: fixture('fake-grok-logged-in.sh') });
  assert.equal(on.state, 'installed_and_logged_in');
  assert.ok(!JSON.stringify(on).includes('never-read'), 'a value from auth.json reached the check');

  // Without GROK_HOME the default is ~/.grok under the home the check was given.
  fs.mkdirSync(path.join(home, '.grok'), { recursive: true });
  fs.writeFileSync(path.join(home, '.grok', 'auth.json'), '{}');
  const empty = await checkAgent('grok', { env, home, bin: fixture('fake-grok-logged-in.sh') });
  assert.equal(empty.state, 'installed_not_logged_in', 'an empty auth.json is not a login');
});

test('an agent that is not on this Mac is not_installed, and the picked one that vanished says so', async () => {
  const { home, env } = bareHome();
  for (const agent of ['claude', 'codex', 'hermes', 'grok'] as const) {
    const check = await checkAgent(agent, { env, home });
    assert.equal(check.state, 'not_installed', agent);
    assert.equal(check.bin, null);
    assert.equal(check.sentence, `${check.name} is not on this Mac yet. Install it, then come back to this screen.`);
    assert.ok(check.details.some((line) => line.startsWith('Install: ')), 'no install line behind Details');
  }
  const gone = await checkAgent('codex', { env, home, wasPicked: true });
  assert.equal(gone.state, 'not_installed');
  assert.equal(gone.sentence, 'Codex is no longer on this Mac.');
});

test('the two entries that cannot be probed answer unknown_client without running anything', async () => {
  const { home, env } = bareHome();
  const other = await checkAgent('mcp', { env, home, run: () => { throw new Error('a probe ran'); } });
  assert.equal(other.state, 'unknown_client');
  assert.equal(other.probed, false);
  assert.equal(other.sentence, 'Phosphor cannot check this agent, so paste the line below into it and it will appear here.');
  const desktop = await checkAgent('desktop', { env, home, run: () => { throw new Error('a probe ran'); } });
  assert.equal(desktop.state, 'unknown_client');
  assert.equal(desktop.probed, false);
  assert.equal(
    desktop.sentence,
    'Phosphor needs an agent that runs on your Mac. Claude Desktop cannot drive it yet. Install Claude Code or Codex, then pick it here.',
  );
  // Neither has a maker, so their Details line is the plain description, never "Made by A chat window".
  assert.deepEqual(other.details, ['Any agent that connects to MCP servers.']);
  assert.deepEqual(desktop.details, ['A chat window, with no agent on this Mac.']);
  for (const agent of ['claude', 'codex', 'hermes', 'grok'] as const) {
    const check = await checkAgent(agent, { env, home });
    assert.match(check.details[0] ?? '', /^Made by \S/, `${agent}: ${check.details[0]}`);
  }
});

test('a binary that never answers still gets a state inside three seconds', async () => {
  const { home, env } = bareHome();
  const started = Date.now();
  const check = await checkAgent('codex', { env, home, bin: fixture('fake-agent-hangs.sh') });
  const took = Date.now() - started;
  assert.ok(took < 3_000, `the check waited ${took} ms on a hung binary`);
  assert.equal(check.state, 'installed_not_logged_in');
  assert.equal(check.version, null);
});

test('the scan checks every agent the app can probe, side by side, inside three seconds', async () => {
  const { home, env } = bareHome();
  const started = Date.now();
  const scan = await scanAgents({ env, home });
  assert.ok(Date.now() - started < 3_000);
  assert.deepEqual(scan.map((c) => c.agent), ['claude', 'codex', 'hermes', 'grok']);
  assert.ok(scan.every((c) => c.state === 'not_installed'));
});

test('the sentence for every state and entry names no path, no vendor word the person did not pick, and reads as one message', () => {
  for (const entry of AGENTS) {
    for (const state of ['installed_and_logged_in', 'installed_not_logged_in', 'not_installed', 'unknown_client'] as const) {
      const sentence = stateSentence(entry, state);
      assert.ok(sentence.length > 0);
      assert.ok(!/\//.test(sentence), `${entry.id} ${state}: a path in the sentence`);
      assert.ok(!/\bMCP\b|stdio|JSON|token/.test(sentence), `${entry.id} ${state}: jargon in the sentence: ${sentence}`);
    }
  }
  // The three sentences the definitions file fixes, word for word.
  assert.equal(stateSentence(agentById('codex')!, 'not_installed'), 'Codex is not on this Mac yet. Install it, then come back to this screen.');
  assert.equal(stateSentence(agentById('codex')!, 'installed_not_logged_in'), 'Codex is installed but not signed in. Sign in in your terminal, then press Check again.');
  assert.equal(stateSentence(agentById('codex')!, 'not_installed', true), 'Codex is no longer on this Mac.');
});

/* ---------- finding the binary ---------- */

test('a binary is found on PATH first, then in the installers\' places under HOME, then under nvm', () => {
  const { home } = bareHome();
  const codex = agentById('codex')!;
  assert.equal(findAgentBin(codex, { env: { PATH: '/nonexistent' }, home }), null);

  const onPath = path.join(home, 'bin');
  fs.mkdirSync(onPath, { recursive: true });
  fs.copyFileSync(fixture('fake-codex-logged-in.sh'), path.join(onPath, 'codex'));
  fs.chmodSync(path.join(onPath, 'codex'), 0o755);
  assert.equal(findAgentBin(codex, { env: { PATH: `/nonexistent:${onPath}` }, home }), path.join(onPath, 'codex'));

  const nvm = path.join(home, '.nvm', 'versions', 'node', 'v24.16.0', 'bin');
  fs.mkdirSync(nvm, { recursive: true });
  fs.copyFileSync(fixture('fake-codex-logged-in.sh'), path.join(nvm, 'codex'));
  fs.chmodSync(path.join(nvm, 'codex'), 0o755);
  assert.equal(findAgentBin(codex, { env: { PATH: '/nonexistent' }, home }), path.join(nvm, 'codex'));

  const local = path.join(home, '.local', 'bin');
  fs.mkdirSync(local, { recursive: true });
  fs.copyFileSync(fixture('fake-codex-logged-in.sh'), path.join(local, 'codex'));
  fs.chmodSync(path.join(local, 'codex'), 0o755);
  assert.equal(findAgentBin(codex, { env: { PATH: '/nonexistent' }, home }), path.join(local, 'codex'), 'the installer place beats nvm');

  // An override that does not exist is null, never a fallback to something else.
  assert.equal(findAgentBin(codex, { env: { PATH: `/nonexistent:${onPath}` }, home, override: '/nowhere/codex' }), null);
});

/* ---------- the connection line, per agent ---------- */

test('the connection line is built per agent in each vendor\'s own grammar, with the environment the proxy needs', () => {
  const lines = Object.fromEntries(AGENTS.map((a) => [a.id, connectionLine(a.id, SPEC)]));
  // The data directory has a space in it, so the argument that carries it is quoted whole.
  const dir = "'PHOSPHOR_DATA_DIR=/Users/x/Library/Application Support/com.karimbabasf.phosphor/state'";
  assert.equal(
    lines.claude,
    `claude mcp add phosphor --scope user --env PHOSPHOR_PORT=4177 --env ${dir} -- ${SPEC.nodeBin} ${SPEC.serverPath}`,
  );
  assert.equal(lines.codex, `codex mcp add phosphor --env PHOSPHOR_PORT=4177 --env ${dir} -- ${SPEC.nodeBin} ${SPEC.serverPath}`);
  assert.equal(lines.hermes, `hermes mcp add phosphor --command ${SPEC.nodeBin} --env PHOSPHOR_PORT=4177 ${dir} --args ${SPEC.serverPath}`);
  assert.equal(lines.grok, `grok mcp add phosphor ${SPEC.nodeBin} --scope user --env PHOSPHOR_PORT=4177 --env ${dir} -- ${SPEC.serverPath}`);
  // Another MCP client gets the stdio command itself, environment first, the value quoted.
  assert.equal(
    lines.mcp,
    `PHOSPHOR_PORT=4177 PHOSPHOR_DATA_DIR='/Users/x/Library/Application Support/com.karimbabasf.phosphor/state' ${SPEC.nodeBin} ${SPEC.serverPath}`,
  );
  // Claude Desktop has nothing to connect.
  assert.equal(lines.desktop, null);
  // No line is the Claude line for someone else.
  const distinct = new Set(Object.values(lines).filter((l) => l !== null));
  assert.equal(distinct.size, 5);
});

test('a checkout line names node on PATH and the repo, and quoting touches only what needs it', () => {
  const dev: ConnectionSpec = { nodeBin: 'node', serverPath: '/Users/x/phosphor/src/mcp.ts', port: 4203, dataDir: '/Users/x/phosphor/state' };
  assert.equal(
    connectionLine('claude', dev),
    'claude mcp add phosphor --scope user --env PHOSPHOR_PORT=4203 --env PHOSPHOR_DATA_DIR=/Users/x/phosphor/state -- node /Users/x/phosphor/src/mcp.ts',
  );
  assert.equal(shellQuote('plain/path.ts'), 'plain/path.ts');
  assert.equal(shellQuote('has space'), "'has space'");
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
  assert.equal(shellQuote(''), "''");
});

/* ---------- the registration ---------- */

function recorder(answers: Array<{ code: number; stdout?: string; stderr?: string }> = [{ code: 0 }]): { run: Run; calls: string[][] } {
  const calls: string[][] = [];
  let at = 0;
  const run: Run = async (bin, args) => {
    calls.push([bin, ...args]);
    const answer = answers[Math.min(at, answers.length - 1)];
    at += 1;
    return { code: answer.code, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '', timedOut: false };
  };
  return { run, calls };
}

test('the registration runs the vendor\'s own mcp add with the same arguments the line shows, without a shell', async () => {
  const { home, env } = bareHome();
  for (const agent of ['claude', 'codex', 'grok'] as const) {
    const { run, calls } = recorder();
    const bin = fixture(`fake-${agent}-logged-in.sh`);
    const done = await registerAgent(agent, SPEC, { env, home, bin, run });
    assert.equal(done.ok, true, agent);
    assert.equal(done.wrote, true, agent);
    assert.equal(calls.length, 1, agent);
    assert.equal(calls[0][0], bin);
    assert.deepEqual(calls[0].slice(1), registrationArgs(agent, SPEC));
    // The arguments carry the raw path, unquoted: quoting is for the line a person pastes.
    assert.ok(calls[0].includes(`PHOSPHOR_DATA_DIR=${SPEC.dataDir}`), agent);
  }
});

test('Hermes is removed before it is written, and its "Enable all tools?" question is answered down stdin', async () => {
  const { home, env } = bareHome();
  const calls: Array<{ args: string[]; input?: string }> = [];
  const run: Run = async (_bin, args, _env, _timeout, input) => {
    calls.push({ args, input });
    return { code: 0, stdout: '', stderr: '', timedOut: false };
  };
  const done = await registerAgent('hermes', SPEC, { env, home, bin: fixture('fake-hermes-logged-in.sh'), run });
  assert.equal(done.ok, true);
  assert.equal(done.wrote, true);
  assert.deepEqual(calls.map((c) => c.args.slice(0, 2)), [['mcp', 'remove'], ['mcp', 'add']]);
  assert.equal(calls[0].input, undefined);
  assert.equal(calls[1].input, 'Y\n');
  assert.deepEqual(calls[1].args, registrationArgs('hermes', SPEC));
});

test('a probe gets no stdin: a command that stops to ask a question is not waited on', async () => {
  const { home, env } = bareHome();
  const started = Date.now();
  // The fixture reads a line from stdin before it answers; a closed stdin answers it at once.
  const check = await checkAgent('codex', { env, home, bin: fixture('fake-agent-asks.sh') });
  assert.ok(Date.now() - started < 1_500, 'the check waited on a question');
  assert.equal(check.state, 'installed_and_logged_in');
});

test('an entry that already exists is removed and written again, so it names this installation', async () => {
  const { home, env } = bareHome();
  const { run, calls } = recorder([{ code: 1, stderr: 'MCP server phosphor already exists in user config' }, { code: 0 }, { code: 0 }]);
  const done = await registerAgent('claude', SPEC, { env, home, bin: fixture('fake-claude-logged-in.sh'), run });
  assert.equal(done.ok, true);
  assert.deepEqual(calls.map((c) => c.slice(1, 3)), [['mcp', 'add'], ['mcp', 'remove'], ['mcp', 'add']]);
});

test('a registration that fails says so in a detail line and never claims a write', async () => {
  const { home, env } = bareHome();
  const { run } = recorder([{ code: 2, stderr: 'permission denied: /Users/x/.codex/config.toml' }]);
  const done = await registerAgent('codex', SPEC, { env, home, bin: fixture('fake-codex-logged-in.sh'), run });
  assert.equal(done.ok, false);
  assert.equal(done.wrote, false);
  assert.match(String(done.detail), /permission denied/);
  // Entries without a config to write, and an agent that is not installed, are not written.
  assert.deepEqual(await registerAgent('mcp', SPEC, { env, home, run }), { ok: true, wrote: false, detail: null });
  assert.deepEqual(await registerAgent('desktop', SPEC, { env, home, run }), { ok: true, wrote: false, detail: null });
  const missing = await registerAgent('grok', SPEC, { env, home, run });
  assert.equal(missing.ok, false);
  assert.equal(missing.wrote, false);
});

/* ---------- the pick ---------- */

test('the pick lands in agent.json and comes back; a broken file is no pick rather than an error', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-pick-'));
  assert.equal(readPick(dataDir), null);
  const pick = writePick(dataDir, 'codex', () => Date.parse('2026-09-20T12:00:00Z'));
  assert.deepEqual(pick, { agent: 'codex', pickedAt: '2026-09-20T12:00:00.000Z' });
  assert.deepEqual(readPick(dataDir), pick);
  fs.writeFileSync(path.join(dataDir, 'agent.json'), '{"agent":"nope"}');
  assert.equal(readPick(dataDir), null);
  fs.writeFileSync(path.join(dataDir, 'agent.json'), 'not json');
  assert.equal(readPick(dataDir), null);
});
