// A payout carries no memo, so propose_send takes no memo: not as an argument the tool lists, and
// not as a key an agent adds anyway.
//
// 1Click's quote request has no memo, destination tag or comment field (its OpenAPI, 2026-09-26),
// so a memo an agent passes could only ever be dropped. Dropped silently, it is the worst kind of
// loss: the agent believes the exchange deposit it was asked to make carries its tag. So the MCP
// schema is strict and names the reason when it refuses an extra key, and the door refuses a
// memo-shaped key on a raw post with the same sentence. Nothing here reaches a draft.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import type { Proposal } from '../../src/types.ts';
import { makeHttp, serviceThatAnswers } from './helpers/http.ts';
import { tempDir } from './helpers/tmp.ts';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const XRP_TO = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';

function row(): Proposal {
  return {
    id: 'p-1',
    kind: 'intents_pay',
    status: 'pending',
    createdAt: new Date().toISOString(),
    draft: { kind: 'intents_pay', symbol: 'XRP', originAsset: 'nep141:xrp.omft.near', network: 'xrp', amount: 10, amountUsd: 15, minReceived: 9.7, from: '0x1', to: XRP_TO, toChecksum: 'valid', counterparty: 'intents.near', recipient: { known: false, count: 0, lastAt: null, activity: null, ownAddress: false } },
    verdict: { outcome: 'needs_approval', reasons: [] },
    simulation: null,
  } as unknown as Proposal;
}

test('the door refuses a memo, tag or comment on a send, with the reason, and a note still passes', async () => {
  const h = makeHttp({ proposals: serviceThatAnswers(row()) });
  for (const key of ['memo', 'tag', 'destinationTag', 'destination_tag', 'comment', 'memoId']) {
    const r = await h.post('send', { to: XRP_TO, symbol: 'XRP', amount: 10, where: 'xrp', confirmed: true, [key]: '12345' });
    assert.equal(r.status, 400, `${key}: ${JSON.stringify(r.json)}`);
    assert.match(String(r.json.error), /no memo, tag or comment/, key);
    assert.match(String(r.json.error), /never ask/, key);
  }
  const fine = await h.post('send', { to: XRP_TO, symbol: 'XRP', amount: 10, where: 'xrp', confirmed: true, note: 'my own wallet' });
  assert.equal(fine.status, 200, JSON.stringify(fine.json));
});

test('the propose_send schema refuses an extra key with the memo sentence before the app hears of it', async () => {
  const data = tempDir('phosphor-send-memo-');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'src', 'mcp.ts')],
    // Port 9 answers nothing: a call the schema let through would fail to connect instead.
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', PHOSPHOR_DATA_DIR: data, PHOSPHOR_PORT: '9', PHOSPHOR_SEAT: 'memo-test', PHOSPHOR_SESSION: 'memo-test' },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'memo-test', version: '0' });
  await client.connect(transport);
  try {
    const listedTools = (await client.listTools()).tools;
    const send = listedTools.find((t) => t.name === 'propose_send');
    assert.ok(send !== undefined);
    assert.equal((send.inputSchema as { additionalProperties?: unknown }).additionalProperties, false, 'the schema is not closed');
    let said = '';
    try {
      const r = await client.callTool({ name: 'propose_send', arguments: { to: XRP_TO, symbol: 'XRP', amount: 10, where: 'xrp', confirmed: true, memo: '12345' } });
      said = JSON.stringify(r.content);
    } catch (err) {
      said = err instanceof Error ? err.message : String(err);
    }
    assert.match(said, /no memo, tag or comment/, said.slice(0, 300));
  } finally {
    await client.close();
    fs.rmSync(data, { recursive: true, force: true });
  }
});
