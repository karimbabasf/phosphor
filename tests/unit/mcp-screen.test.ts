// The screen on every tool result. Karim, 2026-09-14: "make sure the agent has a clear thing to
// see what exactly screen its on". src/mcp-content.ts folds the x-phosphor-screen header the
// door stamps into every answer the proxy hands the model.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { contentFor } from '../../src/mcp-content.ts';

type Block = { type: string; text?: string };

function textOf(out: { content: Block[] }): string {
  return out.content.map((c) => c.text ?? '').join('');
}

function blockText(out: { content: Block[] }, at: number): string {
  return String(out.content[at]?.text ?? '');
}

test('a JSON answer gets screen.view as its last key, and still parses', () => {
  const out = contentFor({ ok: true, totalUsd: 12 }, 'trade');
  assert.equal(out.content.length, 1);
  const parsed = JSON.parse(textOf(out)) as Record<string, unknown>;
  assert.deepEqual(parsed, { ok: true, totalUsd: 12, screen: { view: 'trade' } });
  assert.deepEqual(Object.keys(parsed).at(-1), 'screen');
});

test('an answer that already carries the screen record keeps it whole', () => {
  const record = { view: 'pro', since: '2026-09-14T20:00:00.000Z', by: 'human' };
  const out = contentFor({ headline: 'hi', screen: record }, 'pro');
  assert.deepEqual(JSON.parse(textOf(out)), { headline: 'hi', screen: record });
});

test('no header means no claim: the answer goes out untouched', () => {
  for (const screen of [null, undefined, '', 'kitchen']) {
    assert.deepEqual(JSON.parse(textOf(contentFor({ ok: true }, screen))), { ok: true }, `screen ${String(screen)}`);
  }
});

test('an array or a scalar answer goes out as it is', () => {
  assert.equal(textOf(contentFor([1, 2], 'basic')), '[1,2]');
  assert.equal(textOf(contentFor('done', 'basic')), '"done"');
  assert.equal(textOf(contentFor(null, 'basic')), 'null');
});

test('the digest beside a picture carries the screen as a line under it', () => {
  const jpeg = Buffer.from('\xff\xd8\xff\xe0 not really a picture but the head is right', 'binary').toString('base64');
  const out = contentFor({ image: jpeg, mimeType: 'image/jpeg', digest: 'chart 0: BTC 15m' }, 'trade');
  assert.equal(out.content[0]?.type, 'image');
  assert.equal(blockText(out, 1), 'chart 0: BTC 15m\nscreen: trade');
  const dropped = contentFor({ image: 'not base64!', digest: 'chart 0' }, 'trade');
  assert.match(blockText(dropped, 0), /\nscreen: trade$/);
});
