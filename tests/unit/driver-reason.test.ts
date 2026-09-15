// What the window is told when the assistant cannot start or stops on its own.
//
// Every failure the driver reports carries two strings: `detail`, the technical line for the
// log, and `reason`, one plain sentence for the person. The window shows the reason beside a
// Retry and never prints the detail on its own (ui/screens/agent.js), so the reason has to be
// there on every path a start can fail on, and it has to be absent on the one exit the person
// asked for.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDriver, type DriverEvent } from '../../src/driver.ts';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const SETTINGS = path.join(ROOT, 'operator', 'driver.settings.json');

function statuses(events: DriverEvent[]): Array<{ state: string; detail?: string; reason?: string }> {
  return events.flatMap((e) => (e.kind === 'status' ? [{ state: e.state, detail: e.detail, reason: e.reason }] : []));
}

async function settle(check: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
}

test('a claudeBin that does not exist fails with a sentence, and the log line keeps the path', () => {
  const events: DriverEvent[] = [];
  const driver = createDriver({
    repo: ROOT,
    port: 4177,
    claudeBin: '/nowhere/at/all/claude',
    settingsPath: SETTINGS,
    onEvent: (event) => events.push(event),
  });
  driver.start();
  const failed = statuses(events).find((s) => s.state === 'failed');
  assert.ok(failed, 'the start did not fail');
  assert.equal(failed.reason, 'Claude Code is not at the path set in config.json.');
  assert.match(String(failed.detail), /\/nowhere\/at\/all\/claude/, 'the log line lost the path');
  assert.equal(/driver:|\//.test(String(failed.reason)), false, 'the reason carries a prefix or a path');
});

test('a missing lockdown file is a plain sentence too', () => {
  const events: DriverEvent[] = [];
  const driver = createDriver({
    repo: ROOT,
    port: 4177,
    claudeBin: path.join(ROOT, 'tests', 'fixtures', 'fake-claude-dies.sh'),
    settingsPath: path.join(ROOT, 'nowhere', 'driver.settings.json'),
    onEvent: (event) => events.push(event),
  });
  driver.start();
  const failed = statuses(events).find((s) => s.state === 'failed');
  assert.ok(failed);
  assert.equal(failed.reason, "The assistant's lockdown file is missing, so it will not start.");
});

test('a child that dies on its own says so in words, with the code', async () => {
  const events: DriverEvent[] = [];
  const driver = createDriver({
    repo: ROOT,
    port: 4177,
    claudeBin: path.join(ROOT, 'tests', 'fixtures', 'fake-claude-dies.sh'),
    settingsPath: SETTINGS,
    onEvent: (event) => events.push(event),
  });
  driver.start();
  await settle(() => driver.status().state === 'stopped');
  const stopped = statuses(events).find((s) => s.state === 'stopped');
  assert.ok(stopped, 'the exit never reached the window');
  assert.equal(stopped.reason, 'The assistant stopped: it exited with code 3.');
  assert.equal(stopped.detail, 'the agent exited with code 3');
});

test('a stop the person asked for carries no reason', async () => {
  const events: DriverEvent[] = [];
  const driver = createDriver({
    repo: ROOT,
    port: 4177,
    claudeBin: path.join(ROOT, 'tests', 'fixtures', 'fake-claude-waits.sh'),
    settingsPath: SETTINGS,
    onEvent: (event) => events.push(event),
  });
  driver.start();
  await settle(() => driver.status().state === 'ready');
  driver.stop();
  await settle(() => driver.status().running === false);
  /* The exit event that follows the kill lands after stop() has already said stopped. */
  await new Promise((r) => setTimeout(r, 200));
  const stopped = statuses(events).filter((s) => s.state === 'stopped');
  assert.equal(stopped.length, 1, 'the exit after a requested stop reported stopped a second time');
  assert.equal(stopped[0].reason, undefined);
  assert.equal(stopped[0].detail, undefined);
});
