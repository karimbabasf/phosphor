// The two vendors the window's chat can run, held to what was measured on 2026-09-23 (grok
// 1.0.40, claude 2.1.281): the flags that make the lockdown, the names on the stream that are
// Phosphor's own or the vendor's web tools, the read-back of what grok would load, and the
// sentence for a pick the chat cannot run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGrokArgv, foreignContext, grok, sessionDir } from '../../src/providers/grok.ts';
import { buildArgv, claude } from '../../src/providers/claude.ts';
import { providerById, unavailable, vendorFor } from '../../src/providers/index.ts';

test('grok runs headless with its built-ins cut to MCP and the web, and asks nobody', () => {
  const argv = buildGrokArgv({ promptFile: '/h/turn.txt', sessionId: 's-1', resume: false, systemPrompt: 'P' });
  const value = (flag: string) => argv[argv.indexOf(flag) + 1];
  const all = (flag: string) => argv.flatMap((a, i) => (a === flag ? [argv[i + 1]] : []));
  assert.equal(value('--output-format'), 'streaming-messages-json');
  assert.ok(argv.includes('--include-partial-messages'));
  // `--tools ''` left all nineteen built-ins on 1.0.40: the allowlist has to be named in full.
  assert.equal(value('--tools'), 'search_tool,use_tool,web_search,web_fetch');
  assert.equal(value('--permission-mode'), 'dontAsk');
  // Grok's rule names for its web tools; `--allow web_fetch` matched nothing (measured).
  assert.deepEqual(all('--allow'), ['MCPTool(phosphor__*)', 'WebSearch', 'WebFetch']);
  assert.equal(value('--disallowed-tools'), 'Agent');
  assert.ok(!argv.includes('--disable-web-search'), 'the agent researches with grok\'s own web search');
  for (const flag of ['--no-subagents', '--no-plan', '--no-auto-update', '--verbatim']) assert.ok(argv.includes(flag), flag);
  for (const loose of ['--always-approve', '--yolo', 'bypassPermissions', 'acceptEdits']) assert.ok(!argv.includes(loose), loose);
  assert.equal(value('--prompt-file'), '/h/turn.txt', 'the turn is a file: headless grok reads no stdin');
  assert.equal(value('--session-id'), 's-1');
  assert.equal(value('--system-prompt-override'), 'P');
});

test('grok resumes the session the app named, after the first turn', () => {
  const argv = buildGrokArgv({ promptFile: '/h/turn.txt', sessionId: 's-1', resume: true, systemPrompt: '' });
  assert.equal(argv[argv.indexOf('--resume') + 1], 's-1');
  assert.ok(!argv.includes('--session-id'));
  assert.ok(!argv.includes('--system-prompt-override'), 'no persona, no flag');
});

test('grok\'s surface: its two MCP built-ins, its two web tools and the phosphor server, and nothing else', () => {
  assert.deepEqual(grok.surface({ tools: ['search_tool', 'use_tool'], mcp_servers: [{ name: 'phosphor', status: 'pending' }] }), []);
  assert.deepEqual(grok.surface({ tools: ['search_tool', 'use_tool', 'web_search', 'web_fetch'], mcp_servers: [{ name: 'phosphor' }] }), []);
  assert.deepEqual(grok.surface({ tools: ['use_tool', 'web_fetch', 'x_search'], mcp_servers: [{ name: 'phosphor' }] }), ['x_search'], 'a new web tool is a new decision');
  // A server attached before the init line prints lists its own tools there (the live run).
  assert.deepEqual(grok.surface({ tools: ['search_tool', 'use_tool', 'phosphor__wallet', 'phosphor__propose_swap'], mcp_servers: [{ name: 'phosphor', status: 'connected' }] }), []);
  assert.deepEqual(grok.surface({ tools: ['use_tool', 'other__peek'], mcp_servers: [{ name: 'phosphor' }] }), ['other__peek']);
  assert.deepEqual(grok.surface({ tools: ['search_tool', 'use_tool', 'run_terminal_command'], mcp_servers: [{ name: 'phosphor' }] }), ['run_terminal_command']);
  assert.deepEqual(grok.surface({ tools: ['use_tool'], mcp_servers: [{ name: 'other' }, { name: 'phosphor' }] }), ['server other']);
  assert.deepEqual(grok.surface({ mcp_servers: [] }), ['<the init event carried no tool list>']);
});

test('grok\'s calls read as Phosphor\'s own names, and a real tool outside them as a built-in', () => {
  assert.deepEqual(grok.tool('use_tool', { tool_name: 'phosphor__wallet', tool_input: {} }), { kind: 'phosphor', name: 'mcp__phosphor__wallet', input: {} });
  assert.deepEqual(grok.tool('use_tool', { tool_name: 'phosphor__propose_swap', tool_input: { amountIn: 'all' } }), {
    kind: 'phosphor',
    name: 'mcp__phosphor__propose_swap',
    input: { amountIn: 'all' },
  });
  assert.deepEqual(grok.tool('search_tool', { query: 'wallet' }), { kind: 'meta' });
  assert.deepEqual(grok.tool('phosphor__wallet', {}), { kind: 'phosphor', name: 'mcp__phosphor__wallet', input: {} }, 'called by its listed name');
  assert.equal(grok.tool('use_tool', { tool_name: 'other__peek' }).kind, 'builtin');
  assert.equal(grok.tool('read_file', { path: '/etc/passwd' }).kind, 'builtin');
});

test('grok\'s web tools read as web, and a tool the API ran is only ever its web search', () => {
  assert.deepEqual(grok.tool('web_fetch', { url: 'https://near.ai' }), { kind: 'web', name: 'web_fetch' });
  assert.deepEqual(grok.tool('web_search', { query: 'near ai' }), { kind: 'web', name: 'web_search' });
  assert.deepEqual(grok.tool('web_search', { query: 'near ai' }, true), { kind: 'web', name: 'web_search' });
  assert.equal(grok.tool('x_search', {}, true).kind, 'builtin');
  assert.equal(grok.tool('code_execution', {}, true).kind, 'builtin');
  // A server-run block never reaches Phosphor's tools, whatever it is named.
  assert.equal(grok.tool('phosphor__wallet', {}, true).kind, 'builtin');
});

/* The lead's call of 2026-09-23: a name that is not a real tool can run nothing, so it must not end
   the chat. Live, Claude once called a bare `switch` for mcp__phosphor__switch and the lockdown
   ended the conversation over a call the CLI would have turned away. */
test('a name no tool has passes to the CLI; a real tool outside the allowlist ends the session', () => {
  for (const name of ['switch', 'trade_focus', 'OpenChart']) {
    assert.equal(claude.tool(name, {}).kind, 'unknown', `claude ${name}`);
    assert.equal(grok.tool(name, {}).kind, 'unknown', `grok ${name}`);
  }
  for (const name of ['Bash', 'Write', 'Read', 'TodoWrite', 'Agent', 'mcp__other__peek', 'mcp__phosphor_evil__x']) {
    assert.equal(claude.tool(name, {}).kind, 'builtin', `claude ${name}`);
  }
  for (const name of ['run_terminal_command', 'run_terminal_cmd', 'write', 'read_file', 'search_replace', 'image_gen', 'Agent', 'other__peek']) {
    assert.equal(grok.tool(name, {}).kind, 'builtin', `grok ${name}`);
  }
  assert.equal(grok.tool('use_tool', { tool_name: 'switch' }).kind, 'unknown');
  assert.equal(grok.tool('use_tool', { tool_name: 'other__peek' }).kind, 'builtin');
});

/* THE CASE OF A NAME DOES NOT CHANGE WHAT IT IS (the pre-push audit's lockdown hardening). A CLI that
   took `bash` for Bash, or `webfetch` for WebFetch, would run that tool, so each reads as the tool it
   spells: a built-in still ends the session, and a web tool still marks the web read. */
test('a tool named in another case reads as the tool it spells', () => {
  for (const name of ['bash', 'BASH', 'read', 'todowrite', 'MCP__other__peek']) assert.equal(claude.tool(name, {}).kind, 'builtin', `claude ${name}`);
  assert.deepEqual(claude.tool('webfetch', {}), { kind: 'web', name: 'web_fetch' });
  assert.deepEqual(claude.tool('WEBSEARCH', {}), { kind: 'web', name: 'web_search' });
  assert.deepEqual(claude.tool('Mcp__phosphor__wallet', {}), { kind: 'phosphor', name: 'mcp__phosphor__wallet', input: {} });
  for (const name of ['Run_Terminal_Command', 'READ_FILE', 'agent']) assert.equal(grok.tool(name, {}).kind, 'builtin', `grok ${name}`);
  assert.deepEqual(grok.tool('Web_Fetch', {}), { kind: 'web', name: 'web_fetch' });
  assert.deepEqual(grok.tool('Search_Tool', {}), { kind: 'meta' });
  assert.deepEqual(grok.tool('Phosphor__wallet', {}), { kind: 'phosphor', name: 'mcp__phosphor__wallet', input: {} });
  assert.deepEqual(grok.tool('Use_Tool', { tool_name: 'PHOSPHOR__wallet', tool_input: {} }), { kind: 'phosphor', name: 'mcp__phosphor__wallet', input: {} });
});

/* A WEB READ UNDER EITHER VENDOR'S SPELLING IS A WEB READ (the audit's first dropped item). Grok's
   rule names for its web tools are Claude's names, so a vendor that took the other spelling would
   read a page, and the read has to set the web-read mark whatever it was called. */
test('a web tool spelled the other vendor\'s way reads as web', () => {
  for (const name of ['web_fetch', 'Web_Fetch']) assert.deepEqual(claude.tool(name, {}), { kind: 'web', name: 'web_fetch' }, `claude ${name}`);
  assert.deepEqual(claude.tool('web_search', {}), { kind: 'web', name: 'web_search' });
  for (const name of ['WebFetch', 'webFetch']) assert.deepEqual(grok.tool(name, {}), { kind: 'web', name: 'web_fetch' }, `grok ${name}`);
  for (const name of ['WebSearch', 'webSearch']) assert.deepEqual(grok.tool(name, {}), { kind: 'web', name: 'web_search' }, `grok ${name}`);
  assert.deepEqual(grok.tool('use_tool', { tool_name: 'WebFetch', tool_input: {} }), { kind: 'web', name: 'web_fetch' });
});

// Grok's use_tool reaches MCP tools, but a use_tool that ever reached a built-in would run it.
test('grok\'s use_tool naming one of its built-ins or web tools reads as that tool', () => {
  for (const name of ['run_terminal_command', 'read_file', 'write', 'Agent', 'Run_Terminal_Command']) {
    assert.deepEqual(grok.tool('use_tool', { tool_name: name, tool_input: {} }), { kind: 'builtin', name: `use_tool ${name}` }, name);
  }
  assert.deepEqual(grok.tool('use_tool', { tool_name: 'web_fetch', tool_input: { url: 'https://near.ai' } }), { kind: 'web', name: 'web_fetch' });
  assert.deepEqual(grok.tool('use_tool', { tool_name: 'WEB_SEARCH', tool_input: {} }), { kind: 'web', name: 'web_search' });
  // Still no tool: use_tool turns these away and the chat goes on.
  for (const name of ['switch', 'use_tool', 'search_tool']) assert.equal(grok.tool('use_tool', { tool_name: name }).kind, 'unknown', name);
});

test('a grok session of this app\'s is found where grok keeps it', () => {
  assert.equal(
    sessionDir('/u/.grok', '/Users/k/Library/Application Support/Phosphor/agents/grok', 's-1'),
    '/u/.grok/sessions/%2FUsers%2Fk%2FLibrary%2FApplication%20Support%2FPhosphor%2Fagents%2Fgrok/s-1',
  );
});

test('grok\'s MCP wrapper comes off a result, and an output that is not an answer is an error', () => {
  const ok = JSON.stringify({ type: 'MCP', tool_name: 'wallet', server_name: 'phosphor', output: { OkayOutput: '{"totalUsd":1}' } });
  assert.equal(grok.result(ok), '{"totalUsd":1}');
  assert.equal(grok.result([{ type: 'text', text: ok }]), '{"totalUsd":1}');
  assert.equal(grok.result(JSON.stringify({ type: 'MCP', output: { ErrorOutput: 'boom' } })), null);
  assert.equal(grok.result('plain words'), 'plain words');
});

test('claude\'s calls: an mcp__phosphor__ name is the app\'s, its two web tools are web, a real tool outside them ends the session', () => {
  assert.equal(claude.tool('mcp__phosphor__wallet', {}).kind, 'phosphor');
  assert.deepEqual(claude.tool('WebSearch', { query: 'near ai' }), { kind: 'web', name: 'web_search' });
  assert.deepEqual(claude.tool('WebFetch', { url: 'https://near.ai', prompt: 'what is it' }), { kind: 'web', name: 'web_fetch' });
  assert.equal(claude.tool('Bash', { command: 'ls' }).kind, 'builtin');
  // Claude's web tools run in the CLI; a tool the API ran inside the reply was never granted.
  assert.equal(claude.tool('web_search', {}, true).kind, 'builtin');
  // Not web tools: names no tool has, which the CLI turns away.
  for (const inherited of ['constructor', 'toString', '__proto__']) assert.equal(claude.tool(inherited, {}).kind, 'unknown', inherited);
  assert.deepEqual(claude.surface({ tools: ['mcp__phosphor__wallet', 'WebFetch', 'WebSearch'] }), []);
  assert.deepEqual(claude.surface({ tools: ['mcp__phosphor__wallet', 'WebFetch', 'Bash', 'constructor'] }), ['Bash', 'constructor']);
  const argv = buildArgv({ repo: '/repo', nodeBin: '/n', settings: '/s.json', sessionId: 'x' });
  assert.equal(argv[argv.indexOf('--tools') + 1], 'WebSearch,WebFetch', 'the built-in set is named in full');
  // A list whose entries are not names is a list this app cannot read (a release that changed shape).
  assert.deepEqual(claude.surface({ tools: [{ name: 'Bash' }, 'mcp__phosphor__wallet'] }), ['{"name":"Bash"}']);
});

test('grok runs only when its home loads nothing Phosphor did not put there, and the Phosphor server', () => {
  const clean = { hooks: [], projectInstructions: [], plugins: [], lspServers: [], mcpServers: [{ name: 'phosphor' }] };
  assert.deepEqual(foreignContext(JSON.stringify(clean)), []);
  assert.deepEqual(foreignContext(JSON.stringify({ ...clean, hooks: [{ event: 'pre_tool_use' }] })), ['1 hooks']);
  assert.deepEqual(foreignContext(JSON.stringify({ ...clean, projectInstructions: [{ path: 'rules/x.md' }] })), ['1 projectInstructions']);
  assert.deepEqual(foreignContext(JSON.stringify({ ...clean, plugins: [{ name: 'p' }] })), ['1 plugins']);
  assert.deepEqual(foreignContext(JSON.stringify({ ...clean, mcpServers: [{ name: 'phosphor' }, { name: 'other' }] })), ['server other']);
  assert.deepEqual(foreignContext(JSON.stringify({ ...clean, mcpServers: [{ name: 'phosphor' }, { name: 'off', disabled: true }] })), []);
  assert.deepEqual(foreignContext(JSON.stringify({ ...clean, mcpServers: [] })), ['no phosphor server']);
  assert.deepEqual(foreignContext(JSON.stringify({ ...clean, mcpServers: [{ name: 'phosphor', disabled: true }] })), ['no phosphor server']);
  assert.deepEqual(foreignContext(JSON.stringify({ mcpServers: [{ name: 'phosphor' }] })), ['no hooks list', 'no projectInstructions list', 'no plugins list'], 'a list it cannot see counts against the turn');
  assert.deepEqual(foreignContext('not json'), ['an inspect answer this app cannot read']);
});

test('the chat runs the pick when it can, and says where a pick it cannot run belongs', () => {
  assert.deepEqual(vendorFor(null), { id: 'claude', name: 'Claude Code', inApp: true, reason: null });
  assert.deepEqual(vendorFor('grok'), { id: 'grok', name: 'Grok', inApp: true, reason: null });
  const codex = vendorFor('codex');
  assert.equal(codex.inApp, false);
  assert.equal(codex.reason, 'Codex runs in your terminal, not in this chat. Start it there and it joins this window.');
  assert.match(vendorFor('hermes').reason ?? '', /^Hermes runs in your terminal/);
  assert.match(vendorFor('desktop').reason ?? '', /Claude Desktop cannot drive Phosphor/);
  assert.match(vendorFor('mcp').reason ?? '', /connects from outside this window/);
  assert.equal(providerById('codex'), null);
});

test('a pick the chat cannot run refuses to start with its own sentence, and never spawns', () => {
  const provider = unavailable(vendorFor('codex'));
  assert.throws(() => provider.resolveBin(), (error: Error & { reason?: string }) => error.reason === vendorFor('codex').reason);
  assert.throws(() => provider.spawn({} as never));
});
