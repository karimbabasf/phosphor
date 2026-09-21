// The log tail a person pastes into a problem report carries no credential of this boot and no
// value filed under a secret's name, and it still carries the hashes that are its evidence.
//
// The write paths already keep the seat secret and the window token out of audit.jsonl
// (tests/unit/seat-secret-log.test.ts, tests/unit/log-fingerprint.test.ts). This is the wall on
// the way out: a line that somehow holds either is redacted by both readers, GET /api/log and
// the log_tail tool, and a transaction hash on the same line comes through untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bootChartServer } from '../fixtures/chart-server.ts';
import { REDACTED, redactEvent } from '../../src/http/log-tail.ts';
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

test('a PEM block is cut whole, and a hex run nobody recognises is left alone', () => {
  // Assembled at runtime so this file never holds the marker the sweep (rightly) refuses to see.
  const pem = ['-----BEGIN', 'EC PRIVATE', 'KEY-----\nMHQCAQEEIBc\n-----END', 'EC PRIVATE', 'KEY-----'].join(' ');
  const event = { ts: 't', type: 'tool_call', msg: `found ${pem} and ${TX_HASH}`, data: {} } as LogEvent;
  const out = redactEvent(event, () => false);
  assert.equal(out.msg, `found ${REDACTED} and ${TX_HASH}`);
  assert.notEqual(out, event, 'the event the audit holds is never rewritten in place');
});
