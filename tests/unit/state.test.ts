import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig } from '../../src/config.ts';
import { createAudit } from '../../src/audit.ts';
import { createStore } from '../../src/store.ts';
import { loadPolicy, savePolicy, defaultPolicy } from '../../src/policy/file.ts';
import { renderSentences } from '../../src/policy/render.ts';
import type { Proposal } from '../../src/types.ts';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'acc-'));
}

// ---------- audit.ts ----------

test('audit appends and tails in order, newest first', () => {
  const dir = tmpDir();
  const audit = createAudit(dir);
  audit.append('app_start', 'first');
  audit.append('app_start', 'second');
  audit.append('app_start', 'third');

  const tailed = audit.tail(2);
  assert.equal(tailed.length, 2);
  assert.equal(tailed[0].msg, 'third');
  assert.equal(tailed[1].msg, 'second');
});

test('audit append returns the event it wrote, including data', () => {
  const dir = tmpDir();
  const audit = createAudit(dir);
  const event = audit.append('tool_call', 'called balances', { tool: 'balances' });
  assert.equal(event.type, 'tool_call');
  assert.equal(event.msg, 'called balances');
  assert.deepEqual(event.data, { tool: 'balances' });
  assert.ok(event.ts.length > 0);
});

test('audit persists to disk; a fresh instance tails the same events', () => {
  const dir = tmpDir();
  const first = createAudit(dir);
  first.append('app_start', 'one');
  first.append('app_start', 'two');

  const second = createAudit(dir);
  const tailed = second.tail(10);
  assert.equal(tailed.length, 2);
  assert.equal(tailed[0].msg, 'two');
  assert.equal(tailed[1].msg, 'one');
});

test('audit subscribe notifies on append; the returned unsubscribe stops it', () => {
  const dir = tmpDir();
  const audit = createAudit(dir);
  const seen: string[] = [];
  const unsubscribe = audit.subscribe((e) => seen.push(e.msg));

  audit.append('app_start', 'a');
  unsubscribe();
  audit.append('app_start', 'b');

  assert.deepEqual(seen, ['a']);
});

// ---------- store.ts ----------

function makeProposal(id: string): Proposal {
  return {
    id,
    kind: 'consolidate',
    createdAt: new Date().toISOString(),
    status: 'pending',
    draft: { kind: 'consolidate', legs: [], totalUsd: 0, toChain: 'eth', symbol: 'USDC' },
    simulation: null,
    verdict: { outcome: 'needs_approval', reasons: [] },
  };
}

test('store put/get round-trips', () => {
  const dir = tmpDir();
  const store = createStore(dir);
  const p = makeProposal('p1');
  store.put(p);

  assert.deepEqual(store.get('p1'), p);
  assert.equal(store.list().length, 1);
});

test('store survives re-create from disk', () => {
  const dir = tmpDir();
  const store = createStore(dir);
  store.put(makeProposal('p1'));
  store.put(makeProposal('p2'));

  const reopened = createStore(dir);
  assert.equal(reopened.list().length, 2);
  assert.ok(reopened.get('p1'));
  assert.ok(reopened.get('p2'));
});

test('store put upserts by id rather than duplicating', () => {
  const dir = tmpDir();
  const store = createStore(dir);
  store.put(makeProposal('p1'));
  store.put({ ...makeProposal('p1'), status: 'executed' });

  assert.equal(store.list().length, 1);
  assert.equal(store.get('p1')?.status, 'executed');
});

test('store subscribe notifies on put; unsubscribe stops it', () => {
  const dir = tmpDir();
  const store = createStore(dir);
  let calls = 0;
  const unsubscribe = store.subscribe(() => { calls++; });

  store.put(makeProposal('p1'));
  unsubscribe();
  store.put(makeProposal('p2'));

  assert.equal(calls, 1);
});

// ---------- policy/file.ts ----------

test('loadPolicy returns null for corrupt JSON', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'policy.json'), 'not { valid json ][');
  assert.equal(loadPolicy(dir), null);
});

test('loadPolicy returns null when no file exists (fail closed)', () => {
  const dir = tmpDir();
  assert.equal(loadPolicy(dir), null);
});

test('loadPolicy returns null for schema-invalid JSON', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'policy.json'), JSON.stringify({ hello: 'world' }));
  assert.equal(loadPolicy(dir), null);
});

test('savePolicy then loadPolicy round-trips a valid default policy', () => {
  const dir = tmpDir();
  savePolicy(dir, defaultPolicy());
  const loaded = loadPolicy(dir);

  assert.ok(loaded);
  assert.deepEqual(loaded, defaultPolicy());
});

// ---------- policy/render.ts ----------

test('renderSentences(defaultPolicy()) includes the $10,000 and $100 sentences verbatim', () => {
  const sentences = renderSentences(defaultPolicy());
  assert.ok(sentences.includes('Refuse any single transaction above $10,000.'));
  assert.ok(sentences.includes('Ask me before anything above $100.'));
});

test('renderSentences puts the kill switch line last when on', () => {
  const p = defaultPolicy();
  p.killSwitch = true;
  const sentences = renderSentences(p);
  assert.equal(sentences[sentences.length - 1], 'KILL SWITCH ON: all writes refused.');
});

test('renderSentences omits the kill switch line when off', () => {
  const sentences = renderSentences(defaultPolicy());
  assert.ok(!sentences.some((s) => s.includes('KILL SWITCH')));
});

// ---------- config.ts ----------

test('loadConfig reads config.json, applies no overrides, and creates dataDir', () => {
  const dir = tmpDir();
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({
      mode: 'demo',
      port: 4177,
      addresses: { evm: [], solana: [], near: [] },
      economicTransferUsd: 10,
      candleProducts: ['BTC-USD'],
      dataDir: 'state',
    }),
  );

  const cfg = loadConfig(dir);
  assert.equal(cfg.mode, 'demo');
  assert.equal(cfg.port, 4177);
  assert.equal(cfg.dataDir, path.join(dir, 'state'));
  assert.ok(fs.existsSync(cfg.dataDir));
});

test('loadConfig applies ACC_PORT, ACC_MODE, ACC_DATA_DIR env overrides', () => {
  const dir = tmpDir();
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({
      mode: 'demo',
      port: 4177,
      addresses: { evm: [], solana: [], near: [] },
      economicTransferUsd: 10,
      candleProducts: [],
      dataDir: 'state',
    }),
  );

  const overrideDataDir = path.join(dir, 'custom-data');
  process.env.ACC_PORT = '5555';
  process.env.ACC_MODE = 'live';
  process.env.ACC_DATA_DIR = overrideDataDir;
  try {
    const cfg = loadConfig(dir);
    assert.equal(cfg.port, 5555);
    assert.equal(cfg.mode, 'live');
    assert.equal(cfg.dataDir, overrideDataDir);
    assert.ok(fs.existsSync(overrideDataDir));
  } finally {
    delete process.env.ACC_PORT;
    delete process.env.ACC_MODE;
    delete process.env.ACC_DATA_DIR;
  }
});
