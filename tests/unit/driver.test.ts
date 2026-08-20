// The driver's lockdown, asserted rather than trusted.
//
// Two of these are the only tests in the repo that would have caught the failure that prompted
// the feature. operator/settings.json was written against the tool surface of one Claude Code
// release and was silently wrong by the next: it still denied Bash and Write, and it had never
// heard of WebFetch, WebSearch, SendMessage or the Cron tools, so it let all of them through. A
// deny list cannot test itself. assertSurface can, because it reads the surface the child
// actually announces and refuses anything outside Phosphor's own tools.
//
// The argv tests are here for the same reason and not for coverage. Every flag they assert is
// load-bearing: drop --strict-mcp-config and the machine's other MCP servers join a session that
// signs transactions; drop --setting-sources= and the user's hooks, plugins and CLAUDE.md load
// into it; change --permission-mode to anything permissive and the whole design is a comment.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assertSurface, buildArgv, resolveClaudeBin } from '../../src/driver.ts';

test('assertSurface accepts phosphor tools and nothing else', () => {
  assert.deepEqual(assertSurface(['mcp__phosphor__balance', 'mcp__phosphor__propose_swap']), []);
  assert.deepEqual(assertSurface([]), []);
});

test('assertSurface names every built-in the lockdown missed', () => {
  // The real 2.1.237 surface that operator/settings.json was letting through on 2026-08-19.
  const leaked = [
    'CronCreate',
    'DesignSync',
    'Glob',
    'Grep',
    'Read',
    'RemoteTrigger',
    'SendMessage',
    'WebFetch',
    'WebSearch',
  ];
  assert.deepEqual(assertSurface([...leaked, 'mcp__phosphor__balance']), leaked);
});

test('assertSurface refuses a session that announced no tool list at all', () => {
  // Absent is not empty. An init event without a tools array means the app cannot see what it
  // just spawned, and "cannot see" has to fail the same way "saw something bad" does.
  assert.equal(assertSurface(undefined).length, 1);
  assert.equal(assertSurface(null).length, 1);
  assert.equal(assertSurface('mcp__phosphor__balance').length, 1);
});

test('assertSurface is not fooled by a name that merely contains the prefix', () => {
  assert.deepEqual(assertSurface(['evil__mcp__phosphor__balance']), ['evil__mcp__phosphor__balance']);
});

test('buildArgv carries every flag the lockdown depends on', () => {
  const argv = buildArgv({
    repo: '/repo',
    nodeBin: '/usr/bin/node',
    settings: '/repo/operator/driver.settings.json',
    sessionId: '11111111-2222-3333-4444-555555555555',
  });

  assert.ok(argv.includes('--strict-mcp-config'), 'no other MCP server may join this session');
  assert.ok(argv.includes('--setting-sources='), 'user hooks, plugins and CLAUDE.md must not load');
  assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(argv[argv.indexOf('--settings') + 1], '/repo/operator/driver.settings.json');
  assert.equal(argv[argv.indexOf('--session-id') + 1], '11111111-2222-3333-4444-555555555555');
  assert.equal(argv[argv.indexOf('--input-format') + 1], 'stream-json');
  assert.equal(argv[argv.indexOf('--output-format') + 1], 'stream-json');
  assert.ok(argv.includes('--print'), 'stream-json input and output both require --print');
});

test('buildArgv never asks for a permissive mode', () => {
  const argv = buildArgv({ repo: '/repo', nodeBin: '/usr/bin/node', settings: '/s.json', sessionId: 'x' });
  for (const forbidden of ['--dangerously-skip-permissions', '--bare', '--add-dir']) {
    assert.ok(!argv.includes(forbidden), `${forbidden} must never appear in a driver spawn`);
  }
  // --bare deserves its own sentence: it would drop hooks and CLAUDE.md, which sounds like
  // exactly what this wants, and it also refuses OAuth and demands an API key. That would move
  // billing off the user's own subscription, which is the one economic claim the product makes.
  assert.ok(!argv.includes('--bare'));
});

test('buildArgv points the child at this repo copy of the MCP server', () => {
  const argv = buildArgv({ repo: '/repo', nodeBin: '/usr/bin/node', settings: '/s.json', sessionId: 'x' });
  const config = JSON.parse(argv[argv.indexOf('--mcp-config') + 1]);
  assert.deepEqual(Object.keys(config.mcpServers), ['phosphor']);
  assert.equal(config.mcpServers.phosphor.command, '/usr/bin/node');
  assert.deepEqual(config.mcpServers.phosphor.args, ['/repo/src/mcp.ts']);
});

test('buildArgv appends a system prompt only when one was given', () => {
  const bare = buildArgv({ repo: '/repo', nodeBin: '/n', settings: '/s.json', sessionId: 'x' });
  assert.ok(!bare.includes('--append-system-prompt'));
  const withPrompt = buildArgv({
    repo: '/repo',
    nodeBin: '/n',
    settings: '/s.json',
    sessionId: 'x',
    systemPrompt: 'you drive a wallet',
  });
  assert.equal(withPrompt[withPrompt.indexOf('--append-system-prompt') + 1], 'you drive a wallet');
});

test('resolveClaudeBin refuses a configured path that does not exist', () => {
  // Silently falling back to a discovered binary would mean the app spawns something other than
  // the thing the config named, which is the wrong answer to a typo in a file that chooses which
  // program gets to drive a wallet.
  assert.throws(() => resolveClaudeBin('/nowhere/claude'), /does not exist/);
});

test('buildArgv names a model only when one was chosen', () => {
  // Unset, Claude Code inherits the machine's own default, which is a decision nobody in this
  // app made and on most installs is the slowest model available. The flag is how the app takes
  // that decision back, so the absence of the flag has to stay a deliberate, visible state.
  const bare = buildArgv({ repo: '/repo', nodeBin: '/n', settings: '/s.json', sessionId: 'x' });
  assert.ok(!bare.includes('--model'));

  const chosen = buildArgv({ repo: '/repo', nodeBin: '/n', settings: '/s.json', sessionId: 'x', model: 'sonnet' });
  assert.equal(chosen[chosen.indexOf('--model') + 1], 'sonnet');
});

test('buildArgv keeps the lockdown flags when a model and a prompt are both set', () => {
  // The regression this guards: a flag appended after the lockdown flags is easy to write in a
  // way that lands before --strict-mcp-config or replaces --permission-mode. Both would be
  // silent, and both would end the isolation.
  const argv = buildArgv({
    repo: '/repo',
    nodeBin: '/n',
    settings: '/s.json',
    sessionId: 'x',
    model: 'sonnet',
    systemPrompt: 'you are phosphor',
  });
  assert.ok(argv.includes('--strict-mcp-config'));
  assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.ok(argv.includes('--setting-sources='));
  assert.equal(argv[argv.indexOf('--append-system-prompt') + 1], 'you are phosphor');
});
