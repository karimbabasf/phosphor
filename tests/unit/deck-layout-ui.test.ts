// Four contracts that live in more than one file, which is the only reason they are tested
// here rather than left to a reader:
//
//   - a drag handle is markup in one file and a row in a table in another, and ui/split.js
//     silently ignores a handle it has no entry for. A renamed class would take a splitter out
//     of the deck without anything failing, which is exactly the kind of quiet loss a test is
//     for;
//   - the policy panel ships shut, and its markup has to agree with the default or the first
//     paint states the wrong thing to a screen reader;
//   - a propose_* tool ASKS. Its phrase in the transcript may never read like the money moved,
//     because the thing it produced is a proposal sitting in the gate waiting for a human.
//
// Source text rather than a running page: ui/app.js boots itself on load and needs a whole
// browser to do it, and none of the four is about behaviour at runtime.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

type Any = Record<string, any>;

function read(name: string): string {
  return readFileSync(new URL('../../ui/' + name, import.meta.url), 'utf8');
}

/** ui/split.js declares and does nothing until splitBoot(), so a context is enough to get at
 *  the table. Same harness as tests/unit/split-ui.test.ts. */
function splitTable(): Any {
  const sandbox: Any = { document: { querySelector: () => null }, console };
  sandbox.window = sandbox;
  createContext(sandbox);
  runInContext(read('split.js'), sandbox, { filename: 'ui/split.js' });
  return sandbox.SPLIT_PAGES;
}

const PAGES: Array<[string, string]> = [
  ['pro', 'index.html'],
  ['trade', 'trade.html'],
];

test('every handle in the markup has a geometry, and every geometry has a handle', () => {
  const table = splitTable();
  for (const [page, file] of PAGES) {
    const html = read(file);
    assert.ok(html.includes('data-split="' + page + '"'), file + ' names its page for ui/split.js');

    const inMarkup = [...html.matchAll(/data-split-handle="([^"]+)"/g)].map((m) => m[1]).sort();
    const inTable = Object.keys(table[page]).sort();
    assert.deepEqual(inMarkup, inTable, file + ' and SPLIT_PAGES.' + page + ' name the same handles');
  }
});

test('every pane a handle sizes is a pane that exists on that page', () => {
  const table = splitTable();
  for (const [page, file] of PAGES) {
    const html = read(file);
    for (const id of Object.keys(table[page])) {
      const conf = table[page][id];
      for (const key of ['pane', 'host', 'give']) {
        const selector: string | undefined = conf[key];
        if (!selector || selector === '.deck') continue;
        // The bare name, because the markup writes it in a class list or an id, not as a
        // selector. A rename that misses one of the two files fails here.
        assert.ok(
          html.includes(selector.slice(1)),
          page + '.' + id + ' points at ' + selector + ', which is not in ' + file,
        );
      }
    }
  }
});

test('a handle is reachable without a pointer', () => {
  for (const [, file] of PAGES) {
    const html = read(file);
    const handles = [...html.matchAll(/<div class="split[^>]*>/g)].map((m) => m[0]);
    // Two on the custody deck (the agent's width, the wallet's height) and three on trading,
    // which keeps its rail. A count rather than a list: which handles exist is a layout
    // decision that moves, and that one handle is unreachable by keyboard is a bug forever.
    assert.ok(handles.length >= 2, file + ' has its handles');
    for (const tag of handles) {
      assert.match(tag, /role="separator"/, 'a splitter says what it is');
      assert.match(tag, /aria-orientation="(vertical|horizontal)"/, 'and which way it runs');
      assert.match(tag, /tabindex="0"/, 'and the keyboard can reach it');
      assert.match(tag, /aria-label="[^"]+"/, 'and it is named');
    }
  }
});

/* The gate replaced the policy panel as the thing this file has to hold still.
   Karim asked for the rail gone on 2026-08-20 and the gate went with it, which is the one
   removal in that change that could have cost something real. It did not, because the gate
   became a strip that appears when a decision is actually waiting. These four assertions are
   what stop it quietly becoming a panel again, or worse, a panel that can be shut. */
test('the approval gate has no control that hides it, and hides itself when empty', () => {
  const html = read('index.html');

  const strip = html.match(/<section class="gatestrip"[^>]*>/);
  assert.ok(strip, 'the gate is a strip above the deck');
  assert.match(strip[0], /\bhidden\b/, 'and it is not on screen before there is anything to decide');

  // No collapse control anywhere inside it. data-collapse is what makes a frame a button.
  const block = html.slice(html.indexOf('<section class="gatestrip"'), html.indexOf('<div class="deck"'));
  assert.ok(!block.includes('data-collapse'), 'a safety surface that can be hidden is a safety bug');

  // And the only thing that may set that attribute is the pending count.
  const app = read('app.js');
  assert.match(app, /strip\.hidden = pending === 0;/, 'the pending count is what shows it');
});

test('a tool that only asks never reads as a tool that did it', () => {
  const chat = read('driver-chat.js');
  const phrases = [...chat.matchAll(/^\s{4}(propose_[a-z_]+): '([^']+)',$/gm)];
  assert.ok(phrases.length >= 5, 'every propose_* tool has a phrase');
  for (const [, id, phrase] of phrases) {
    assert.match(phrase, /^asking to /, id + ' has to read as a request, not as a movement');
  }
});
