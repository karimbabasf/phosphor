// The router must not name a page the window does not ship.
//
// `GET /trade` served `/trade.html` as a second surface. The UI rewrite deleted `ui/trade.html`
// and moved the trading screen inside the one window, so the branch answered 404 for every
// request it ever took, while reading like a supported entry point: a person given the URL got
// "not found" from a route the code says exists.
//
// This is checked against the source rather than over a socket because both answers are the same
// 404. What is wrong with a dead branch is not its response, it is that it is there.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

test('every page the router serves by name exists in ui/', () => {
  const router = fs.readFileSync(path.join(ROOT, 'src', 'http', 'router.ts'), 'utf8');
  const named = [...router.matchAll(/serveStatic\('(\/[^']+)'/g)].map((m) => m[1]);

  for (const page of named) {
    assert.ok(
      fs.existsSync(path.join(ROOT, 'ui', page.replace(/^\//, ''))),
      `the router serves ${page}, which is not in ui/`,
    );
  }
});

test('there is no second page surface: /trade is not a route', () => {
  const router = fs.readFileSync(path.join(ROOT, 'src', 'http', 'router.ts'), 'utf8');
  assert.doesNotMatch(router, /route === '\/trade'/, 'the trading screen lives inside the one window');
  assert.ok(!fs.existsSync(path.join(ROOT, 'ui', 'trade.html')));
});
