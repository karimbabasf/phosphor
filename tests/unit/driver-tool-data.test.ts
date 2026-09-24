// What the window learns about a tool's answer, and how a settled call finds its own step row.
//
// Two things used to be true. The result of a tool call was reduced to a name and a yes or no
// before it left src/driver.ts, so the window could draw nothing from a balance but the table
// the model typed. And the name it was reduced to was read off a field the stream does not
// carry: a tool_result block names its call by `tool_use_id`, so every result came through as
// "tool" and no step row ever closed before the turn did. Both are asserted here over a real
// child process playing real-shaped frames (tests/fixtures/fake-claude-tools.sh).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDriver, toolDataFor, capPayload, isToolDataTool, TOOL_DATA_CAP, type DriverEvent } from '../../src/driver.ts';
import { lockdownCopy } from '../fixtures/lockdown-copy.ts';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
// A copy outside this checkout: see tests/fixtures/lockdown-copy.ts.
const SETTINGS = lockdownCopy();

async function settle(check: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
}

function wrapped(answer: unknown): unknown {
  return [{ type: 'text', text: JSON.stringify(answer) }];
}

test('a tool_result is matched to its tool_use by id, so the step it closes carries the tool name', async () => {
  const events: DriverEvent[] = [];
  const driver = createDriver({
    repo: ROOT,
    port: 4177,
    claudeBin: path.join(ROOT, 'tests', 'fixtures', 'fake-claude-tools.sh'),
    settingsPath: SETTINGS,
    onEvent: (event) => events.push(event),
  });
  driver.start();
  await settle(() => events.some((e) => e.kind === 'turn_end'));
  driver.stop();

  const results = events.filter((e): e is Extract<DriverEvent, { kind: 'tool_result' }> => e.kind === 'tool_result');
  assert.deepEqual(
    results.map((e) => [e.name, e.ok]),
    [['mcp__phosphor__wallet', true], ['mcp__phosphor__policy_show', true]],
    'the result was not named after the call that opened it',
  );
  const order = events.filter((e) => e.kind === 'tool' || e.kind === 'tool_result' || e.kind === 'tool_data').map((e) => e.kind);
  assert.deepEqual(order, ['tool', 'tool_result', 'tool_data', 'tool', 'tool_result'], 'the data does not follow its own result');
});

test('a whitelisted read reaches the window as data, and a tool off the list sends nothing', async () => {
  const events: DriverEvent[] = [];
  const driver = createDriver({
    repo: ROOT,
    port: 4177,
    claudeBin: path.join(ROOT, 'tests', 'fixtures', 'fake-claude-tools.sh'),
    settingsPath: SETTINGS,
    onEvent: (event) => events.push(event),
  });
  driver.start();
  await settle(() => events.some((e) => e.kind === 'turn_end'));
  driver.stop();

  const data = events.filter((e): e is Extract<DriverEvent, { kind: 'tool_data' }> => e.kind === 'tool_data');
  assert.equal(data.length, 1, 'policy_show is not on the list and must send nothing');
  assert.equal(data[0].name, 'mcp__phosphor__wallet');
  const answer = data[0].data as { totalUsd: number; holdings: Array<{ symbol: string }> };
  assert.equal(answer.totalUsd, 12.5);
  assert.equal(answer.holdings[0].symbol, 'USDC');
});

test('the list is an allow list: the vault, the keys and every unknown tool are off it', () => {
  for (const name of ['wallet', 'trade_read', 'trade_batch', 'deposit', 'proposal_status', 'swap_check', 'chain_address']) {
    assert.ok(isToolDataTool(`mcp__phosphor__${name}`), `${name} is on the list`);
  }
  assert.ok(isToolDataTool('mcp__phosphor__propose_swap'));
  assert.ok(isToolDataTool('mcp__phosphor__propose_trade'));
  for (const name of ['policy_show', 'log_tail', 'chart_read', 'chart_snapshot', 'vault_status', 'vault_export', 'keys', 'start', 'skill', 'research', 'chain_transactions', 'chain_transaction', 'intents_activity', 'receipts', 'swap_assets', 'swap_quote']) {
    assert.equal(isToolDataTool(`mcp__phosphor__${name}`), false, `${name} must not reach the window as data`);
  }
});

test('a key-shaped field never leaves the process, whatever tool carried it', () => {
  const event = toolDataFor(
    'mcp__phosphor__wallet',
    { chain: 'base', mnemonic: 'abandon abandon' },
    wrapped({ totalUsd: 1, rows: [{ symbol: 'ETH', privateKey: 'nope', seedPhrase: 'nope', nested: { secret: 'nope', fine: 2 } }], keystorePath: '/x' }),
  );
  assert.ok(event !== null && event.kind === 'tool_data');
  const text = JSON.stringify(event);
  assert.equal(text.includes('nope'), false, text);
  assert.equal(text.includes('abandon'), false, text);
  assert.equal(text.includes('/x'), false, text);
  assert.ok(text.includes('"fine":2'), 'a harmless nested field was dropped with the secret');
});

test('a failed call, a sentence and a picture all send nothing', () => {
  assert.equal(toolDataFor('mcp__phosphor__wallet', {}, wrapped({ totalUsd: 1 }), false), null, 'an error result');
  assert.equal(toolDataFor('mcp__phosphor__wallet', {}, 'Phosphor is not running.'), null, 'a sentence');
  assert.equal(toolDataFor('mcp__phosphor__wallet', {}, [{ type: 'image', data: 'AAAA', mimeType: 'image/jpeg' }]), null, 'a picture');
  assert.equal(toolDataFor('mcp__phosphor__wallet', {}, wrapped(42)), null, 'a bare number');
});

test('an answer over the cap is cut by its longest arrays, each cut marked, until it fits', () => {
  const fills = Array.from({ length: 5000 }, (_, i) => ({ tid: `t${i}`, coin: 'BTC', px: 60000 + i, sizeCoin: 0.01 }));
  const answer = { symbol: 'BTC', account: { equityUsd: 100 }, fills: { count: 5000, recent: fills }, positions: [{ coin: 'BTC' }] };
  const event = toolDataFor('mcp__phosphor__trade_read', {}, wrapped(answer));
  assert.ok(event !== null && event.kind === 'tool_data');
  const text = JSON.stringify(event.data);
  assert.ok(text.length <= TOOL_DATA_CAP, `the payload is ${text.length} bytes`);
  const data = event.data as { fills: { recent: Array<Record<string, unknown>> }; positions: unknown[]; account: { equityUsd: number } };
  const marker = data.fills.recent[data.fills.recent.length - 1];
  assert.equal(typeof marker.truncated, 'number', 'the shortened array carries no marker');
  assert.equal(data.fills.recent.length - 1 + (marker.truncated as number), 5000, 'the marker does not count what was dropped');
  assert.equal(data.account.equityUsd, 100, 'a scalar was lost to the cut');
  assert.equal(data.positions.length, 1, 'a short array was cut with the long one');
  assert.deepEqual(capPayload({ a: [1, 2, 3] }, 1024), { a: [1, 2, 3] }, 'an answer under the cap is not touched');
});
