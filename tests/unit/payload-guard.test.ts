// The payload resolve guard: a module may only load from inside the digested payload (audit
// 2026-10-01, L14). The pure predicate is checked here, and the live hook is checked by registering
// it against a throwaway root and importing a module from inside it and a module from outside it.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { installResolveGuard, outsidePayload } from '../../src/payload-guard.ts';

const ROOT = '/Applications/Phosphor.app/Contents/Resources/phosphor';

test('the predicate turns away a file outside the payload and keeps every one inside', () => {
  // Inside, at the root and under it.
  assert.equal(outsidePayload(ROOT, pathToFileURL(`${ROOT}/node_modules/viem/index.js`).href), false);
  assert.equal(outsidePayload(ROOT, pathToFileURL(`${ROOT}/src/main.ts`).href), false);
  assert.equal(outsidePayload(ROOT, pathToFileURL(ROOT).href), false);
  // The outside folders Node walks to for a bare specifier it cannot find inside.
  assert.equal(outsidePayload(ROOT, pathToFileURL('/Applications/Phosphor.app/Contents/Resources/node_modules/x/i.js').href), true);
  assert.equal(outsidePayload(ROOT, pathToFileURL('/Applications/node_modules/x/i.js').href), true);
  assert.equal(outsidePayload(ROOT, pathToFileURL(`${os.homedir()}/.node_modules/x/i.js`).href), true);
  // A sibling whose path starts with the root's string but is a different directory.
  assert.equal(outsidePayload(ROOT, pathToFileURL(`${ROOT}-evil/i.js`).href), true);
  // Node built-ins and non-file schemes are never a file to escape with.
  assert.equal(outsidePayload(ROOT, 'node:fs'), false);
  assert.equal(outsidePayload(ROOT, 'data:text/javascript,0'), false);
});

test('the live hook refuses an outside module and lets an inside one load', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-guard-'));
  const root = path.join(base, 'payload');
  const inside = path.join(root, 'pkg');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(inside, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(inside, 'in.mjs'), 'export const where = "inside";\n');
  fs.writeFileSync(path.join(outside, 'out.mjs'), 'export const where = "outside";\n');

  const guard = installResolveGuard(root);
  try {
    const good = await import(pathToFileURL(path.join(inside, 'in.mjs')).href);
    assert.equal(good.where, 'inside', 'a module inside the payload still loads');
    // A node: builtin is untouched.
    const builtin = await import('node:path');
    assert.ok(typeof builtin.join === 'function', 'built-ins are not files to escape with');
    await assert.rejects(
      () => import(pathToFileURL(path.join(outside, 'out.mjs')).href),
      /refused to load .* from outside its files/,
      'a module outside the payload is refused',
    );
  } finally {
    guard.deregister();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('main.ts installs the guard before any other module of the app', () => {
  const main = fs.readFileSync(path.join(path.dirname(path.dirname(path.dirname(new URL(import.meta.url).pathname))), 'src', 'main.ts'), 'utf8');
  const guard = main.indexOf("import './boot-guard.ts';");
  const firstOther = main.indexOf("import fs from 'node:fs';");
  assert.ok(guard > 0 && firstOther > guard, 'the guard import comes before the first other import');
});
