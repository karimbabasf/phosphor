// The two skill bodies, held to the tool surface they teach.
//
// A skill is loaded whole into the agent's context on every analysis, so its size is a cost paid
// per question, and a tool name in it that the surface no longer has is a call the agent will
// make and watch fail. Neither is caught anywhere else: the surface tests hold the tools, not
// the prose that names them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ANALYSIS = fs.readFileSync(path.join(ROOT, 'skills', 'phosphor-analysis.md'), 'utf8');
const HUNT = fs.readFileSync(path.join(ROOT, 'skills', 'phosphor-hunt.md'), 'utf8');

// Tools the execution rebuild removed. A skill that names one teaches a call that fails.
const REMOVED = [
  'chart_level',
  'chart_mark',
  'chart_trendline',
  'chart_set_view',
  'chart_add_indicator',
  'chart_remove_indicator',
  'chart_preset',
  'chart_clear',
  'chart_measure',
  'indicator_catalog',
  'propose_mandate',
  'mandate_catalog',
  'trade_note',
  'history_page',
];

const BANNED_WORDS = ['delve', 'seamless', 'robust', 'comprehensive', 'journey'];

test('the analysis skill is under nine kilobytes', () => {
  const bytes = Buffer.byteLength(ANALYSIS, 'utf8');
  assert.ok(bytes < 9 * 1024, `the analysis skill is ${bytes} bytes and is loaded on every question`);
});

test('the analysis skill teaches the new surface and none of the removed tools', () => {
  for (const tool of ['chart_scan', 'chart_batch', 'chart_draw', 'trade_plan', 'trade_highlight', 'trade_batch', 'market_search']) {
    assert.ok(ANALYSIS.includes(`\`${tool}\``), `the analysis skill never names ${tool}`);
  }
  for (const tool of REMOVED) {
    assert.ok(!ANALYSIS.includes(tool), `the analysis skill still names ${tool}`);
  }
  // The `candles` tool is gone; the word survives only as ordinary English, never as a tool.
  assert.ok(!ANALYSIS.includes('`candles`'));
});

test('the analysis skill keeps the four tiers and one procedure of four calls', () => {
  for (const tier of ['GLANCE', 'READ', 'SESSION', 'DEEP']) assert.ok(ANALYSIS.includes(tier));
  // Each of the four calls is taught once, in the procedure, as "once".
  for (const call of ['`trade_batch`', '`chart_scan`', '`chart_batch`', '`chart_draw`']) {
    assert.ok(ANALYSIS.includes(`One ${call}`), `the procedure does not say to make one ${call}`);
  }
});

test('the output contract is prose plus one GFM table of levels', () => {
  assert.match(ANALYSIS, /\| price \| kind \| evidence \| ATR away \| if lost \|/);
  assert.ok(!ANALYSIS.includes('WHAT HAPPENED\n'), 'the fixed-width block is back');
  assert.ok(ANALYSIS.includes('table'));
});

test('the analysis skill keeps the three trap defaults and no more of the old appendix', () => {
  assert.match(ANALYSIS, /`window: 2`/);
  assert.match(ANALYSIS, /`minProminence: 0`/);
  assert.match(ANALYSIS, /`tolerance: 0`/);
  assert.match(ANALYSIS, /`granularitySec: 3600`/);
  assert.ok(!ANALYSIS.includes('# Appendix'));
  assert.ok(!ANALYSIS.includes('The second indicator catalogue'));
});

test('the hunt skill names no removed tool and still fans out', () => {
  for (const tool of REMOVED) assert.ok(!HUNT.includes(tool), `the hunt skill still names ${tool}`);
  assert.ok(!HUNT.includes('`candles`'));
  assert.ok(HUNT.includes('`agent_spawn`'));
  assert.ok(HUNT.includes('`chart_draw'));
});

test('neither skill carries a dash the house style bans or a banned word', () => {
  for (const [name, text] of [['analysis', ANALYSIS], ['hunt', HUNT]] as const) {
    assert.ok(!text.includes('—'), `em dash in the ${name} skill`);
    assert.ok(!text.includes('–'), `en dash in the ${name} skill`);
    for (const word of BANNED_WORDS) {
      assert.ok(!new RegExp(`\\b${word}\\b`, 'i').test(text), `${word} in the ${name} skill`);
    }
    assert.ok(!/\bleverage\s+(the|our|this|a|an|its|your)\b/i.test(text), `leverage as a verb in the ${name} skill`);
  }
});
