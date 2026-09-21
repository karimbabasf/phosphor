// The log tail a person pastes into a problem report carries no credential of this boot and no
// value filed under a secret's name, and it still carries the hashes that are its evidence.
//
// The write paths already keep the seat secret and the window token out of audit.jsonl
// (tests/unit/seat-secret-log.test.ts, tests/unit/log-fingerprint.test.ts). This is the wall on
// the way out: a line that somehow holds either is redacted by both readers, GET /api/log and
// the log_tail tool, and a transaction hash on the same line comes through untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type http from 'node:http';

import { bootChartServer } from '../fixtures/chart-server.ts';
import { REDACTED, redactEvent } from '../../src/http/log-tail.ts';
import { walletReads } from '../../src/http/read/wallet.ts';
import type { Ctx } from '../../src/http/context.ts';
import type { LogEvent } from '../../src/types.ts';

// 64 hex with every digit in it, so nothing short of the value itself matches it.
const TX_HASH = '0x' + Array.from({ length: 64 }, (_, i) => '0123456789abcdef'[(i * 5 + 1) % 16]).join('');

test('both tail readers redact the seat secret and the window token, and keep the hashes', async () => {
  const h = await bootChartServer();
  try {
    // A writer that slipped: the credentials of this boot on one line, beside real evidence.
    h.audit.append('tool_call', `swap settled ${TX_HASH} seat ${h.seat} token ${h.token}`, {
      txHash: TX_HASH,
      leaked: { seat: h.seat, window: h.token, nested: [h.seat] },
      mnemonic: 'abandon abandon about',
      privateKey: 'anything at all',
      tokenId: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
    });

    const route = await h.get('/api/log?limit=5');
    assert.equal(route.status, 200);
    const tool = await h.mcp({ op: 'read', tool: 'log_tail', args: { limit: 5 }, session: 'reader', client: 'phosphor-mcp' });
    assert.equal(tool.status, 200);

    for (const [name, lines] of [['GET /api/log', route.json], ['log_tail', tool.json]] as const) {
      const text = JSON.stringify(lines);
      assert.equal(text.includes(h.seat), false, `${name} hands out the seat secret`);
      assert.equal(text.includes(h.token), false, `${name} hands out the window token`);
      assert.equal(text.includes('abandon abandon about'), false, `${name} hands out a value filed as a mnemonic`);
      assert.equal(text.includes('anything at all'), false, `${name} hands out a value filed as a private key`);
      assert.ok(text.includes(TX_HASH), `${name} lost the transaction hash, which is the evidence`);
      assert.ok(text.includes('nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1'), `${name} redacted a token contract id`);
      const line = (lines as Array<LogEvent & { data?: Record<string, unknown> }>).find((e) => e.type === 'tool_call' && e.msg.includes('swap settled'));
      assert.ok(line, `${name} dropped the line instead of redacting it`);
      assert.equal(line.msg, `swap settled ${TX_HASH} seat ${REDACTED} token ${REDACTED}`);
      assert.deepEqual(line.data?.leaked, { seat: REDACTED, window: REDACTED, nested: [REDACTED] });
      assert.equal(line.data?.mnemonic, REDACTED);
      assert.equal(line.data?.privateKey, REDACTED);
    }
  } finally {
    await h.close();
  }
});

/* THE REVIEWER'S PLANT (2026-09-20): every credential shape on one line and under every kind of
   key. The rule under test: a shape that is never a transaction hash is cut wherever it sits,
   a hash is kept under a neutral key and cut under a key that says secret, and this boot's own
   two values are cut by value. The values below are assembled so that nothing here is a key. */
const B58 = '1'.repeat(3) + 'A'.repeat(20) + 'z'.repeat(20);
const PLANT = {
  hexAddr: '0x' + TX_HASH.slice(2),
  bareHex: TX_HASH.slice(2),
  secp: 'secp256k1:' + B58,
  ed: 'ed25519:' + B58,
  b58raw: 'x'.repeat(88).replace(/x/g, (_, i: number) => '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'[i % 58]),
  sk: 'sk-' + 'ant-api03-' + 'A'.repeat(40),
  jwt: 'eyJ' + 'a'.repeat(20) + '.' + 'eyJ' + 'b'.repeat(20) + '.' + 'c'.repeat(30),
  bearer: 'Bearer ' + 'd'.repeat(40),
};

function plantedLine(seat: string, token: string): string {
  return [`seat ${seat}`, `token ${token}`, `hash ${PLANT.hexAddr}`, `bare ${PLANT.bareHex}`, PLANT.secp, PLANT.ed, PLANT.b58raw, PLANT.sk, PLANT.jwt, `authorization: ${PLANT.bearer}`].join(' ');
}

function assertPlantCut(text: string, seat: string, token: string, where: string): void {
  for (const [name, value] of Object.entries({ seat, token, secp: PLANT.secp, ed: PLANT.ed, b58raw: PLANT.b58raw, sk: PLANT.sk, jwt: PLANT.jwt, bearer: PLANT.bearer })) {
    assert.equal(text.includes(value), false, `${where}: ${name} came through`);
  }
}

test('the planted line: every credential shape is cut on both tail routes, and the hashes stay under a neutral key', async () => {
  const h = await bootChartServer();
  try {
    const line = plantedLine(h.seat, h.token);
    h.audit.append('tool_call', line, {
      neutral: { hash: PLANT.hexAddr, bare: PLANT.bareHex, note: line },
      privateKey: PLANT.hexAddr,
      secret: PLANT.bareHex,
      apiKey: PLANT.sk,
      authorization: PLANT.bearer,
      Authorization: PLANT.bearer,
      headers: { Authorization: PLANT.bearer, 'x-api-key': PLANT.sk },
    });
    const route = await h.get('/api/log?limit=3');
    const tool = await h.mcp({ op: 'read', tool: 'log_tail', args: { limit: 3 }, session: 'reader', client: 'phosphor-mcp' });
    for (const [name, lines] of [['GET /api/log', route.json], ['log_tail', tool.json]] as const) {
      const text = JSON.stringify(lines);
      assertPlantCut(text, h.seat, h.token, name);
      const row = (lines as Array<LogEvent & { data?: Record<string, unknown> }>).find((e) => e.type === 'tool_call' && e.msg.startsWith('seat '));
      assert.ok(row, `${name} dropped the planted line`);
      const data = row.data as Record<string, unknown>;
      assert.deepEqual((data.neutral as Record<string, unknown>).hash, PLANT.hexAddr, `${name} cut a hash under a neutral key`);
      assert.deepEqual((data.neutral as Record<string, unknown>).bare, PLANT.bareHex, `${name} cut a bare hash under a neutral key`);
      assert.ok(String((data.neutral as Record<string, unknown>).note).includes(PLANT.hexAddr), `${name} cut a hash inside a neutral sentence`);
      for (const key of ['privateKey', 'secret', 'apiKey', 'authorization', 'Authorization']) {
        assert.equal(data[key], REDACTED, `${name} kept ${key}`);
      }
      assert.deepEqual(data.headers, { Authorization: REDACTED, 'x-api-key': REDACTED }, `${name} kept a header credential`);
    }
  } finally {
    await h.close();
  }
});

/* THE STREAM. /api/events hands every audit event to any local GET with no token, live, and
   the reviewer's line arrived on it verbatim: the same wall now stands on the way out there. */
test('the planted line never reaches /api/events, and the hash does', async () => {
  const h = await bootChartServer();
  const stop = new AbortController();
  try {
    const stream = await fetch(`${h.url}/api/events`, { headers: { origin: h.url }, signal: stop.signal });
    assert.equal(stream.status, 200);
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const line = plantedLine(h.seat, h.token);
    h.audit.append('tool_call', line, { neutral: { hash: PLANT.hexAddr }, privateKey: PLANT.hexAddr, headers: { Authorization: PLANT.bearer } });
    const deadline = Date.now() + 5000;
    type Frame = { type: string; event?: LogEvent & { data?: Record<string, unknown> } };
    let arrived: Frame | undefined;
    while (arrived === undefined && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      for (const chunk of text.split('\n\n')) {
        const data = chunk.split('\n').find((l) => l.startsWith('data: '));
        if (data === undefined) continue;
        const parsed = JSON.parse(data.slice(6)) as Frame;
        if (parsed.type === 'log' && parsed.event?.msg.startsWith('seat ')) arrived = parsed;
      }
    }
    assert.ok(arrived?.event, 'the planted line never arrived on the stream, so nothing was tested');
    assertPlantCut(JSON.stringify(arrived), h.seat, h.token, '/api/events');
    const event = arrived.event;
    assert.deepEqual(event.data?.neutral, { hash: PLANT.hexAddr }, 'the stream cut a hash under a neutral key');
    assert.equal(event.data?.privateKey, REDACTED);
    assert.deepEqual(event.data?.headers, { Authorization: REDACTED });
  } finally {
    stop.abort();
    await h.close();
  }
});

/* THE REPORT COPY. Help, then Copy Log for a Report lands on a public issue, so that copy
   shortens every address to its two ends the way diagnose prints them; the person's own read
   of GET /api/log keeps them whole. Amounts stay in both: a report about money says how much. */
test('the report copy fingerprints addresses and the plain tail keeps them', async () => {
  const h = await bootChartServer();
  try {
    const address = '0xa1b2c3d4e5f60718293a4b5c6d7e8f9011225050';
    h.audit.append('executed', `sent 12.5 USDC to ${address}, hash ${PLANT.hexAddr}`, { to: address, amountUsd: 12.5, txids: [PLANT.hexAddr] });
    const plain = await h.get('/api/log?limit=3');
    const report = await h.get('/api/log?limit=3&for=report');
    const plainText = JSON.stringify(plain.json);
    const reportText = JSON.stringify(report.json);
    assert.ok(plainText.includes(address), 'the plain tail lost the address the person may need to read');
    assert.equal(reportText.includes(address), false, 'the report copy carries a whole address');
    assert.ok(reportText.includes('0xa1b2...5050'), 'the report copy does not fingerprint the way diagnose does');
    assert.ok(reportText.includes(PLANT.hexAddr), 'the report copy lost the hash');
    assert.ok(reportText.includes('12.5'), 'the report copy lost the amount');
    const row = (report.json as Array<{ data?: { to?: string; amountUsd?: number } }>).find((e) => e.data?.amountUsd === 12.5);
    assert.equal(row?.data?.to, '0xa1b2...5050');
  } finally {
    await h.close();
  }
});

test('diagnose formats a row\'s own lines through the same wall', async () => {
  const seat = 's'.repeat(64);
  const token = 't'.repeat(64);
  const line = plantedLine(seat, token);
  const ctx = {
    proposals: {
      get: (id: string) => (id === 'p1' ? { id: 'p1', kind: 'swap', status: 'executed', draft: { kind: 'swap' }, result: null } : undefined),
      view: () => ({ id: 'p1' }),
    },
    audit: { tail: () => [{ ts: 't', type: 'executed', msg: line, data: { id: 'p1' } }] },
    ledger: { hyperliquid: () => undefined },
    agents: { recognises: (v: unknown) => v === seat },
    token,
  } as unknown as Ctx;
  let body = '';
  const res = { writeHead: () => res, end: (chunk?: unknown) => { body = String(chunk ?? ''); } } as unknown as http.ServerResponse;
  await walletReads.diagnose(ctx, {}, { id: 'p1' }, res);
  const answer = JSON.parse(body) as { log: string[] };
  assert.equal(answer.log.length, 1);
  assertPlantCut(answer.log[0], seat, token, 'diagnose');
  assert.ok(answer.log[0].includes(PLANT.bareHex), 'diagnose cut the hash, which is the evidence');
});

test('a PEM block is cut whole, and a hex run nobody recognises is left alone', () => {
  // Assembled at runtime so this file never holds the marker the sweep (rightly) refuses to see.
  const pem = ['-----BEGIN', 'EC PRIVATE', 'KEY-----\nMHQCAQEEIBc\n-----END', 'EC PRIVATE', 'KEY-----'].join(' ');
  const event = { ts: 't', type: 'tool_call', msg: `found ${pem} and ${TX_HASH}`, data: {} } as LogEvent;
  const out = redactEvent(event, () => false);
  assert.equal(out.msg, `found ${REDACTED} and ${TX_HASH}`);
  assert.notEqual(out, event, 'the event the audit holds is never rewritten in place');
});
