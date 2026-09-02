// How the shell recognises the backend it just started.
//
// The desktop shell spawns the control app, then polls 127.0.0.1 until something there identifies
// itself as Phosphor. Only then does it open the window. That handshake used to be a match on the
// page's <title>, which made a cosmetic edit a boot failure: retitling ui/index.html from
// "PHOSPHOR" to "Phosphor" left the shell polling a healthy server it could no longer recognise,
// and the app died on "the control app did not answer within 45s" with nothing wrong with it.
//
// So the marker is a response header now, which nothing about the look of the page can move, and
// this test holds the two halves together: what the server sends and what the shell looks for.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { IDENTITY_HEADER, IDENTITY_VALUE } from '../../src/http/respond.ts';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

test('the header the shell probes for is the one the control page answers with', () => {
  const shell = fs.readFileSync(path.join(ROOT, 'src-tauri/src/backend.rs'), 'utf8');

  assert.ok(
    shell.includes(`"${IDENTITY_HEADER}:"`),
    `the shell probes for ${IDENTITY_HEADER}, which is what serveStatic sends`,
  );
  assert.ok(
    !shell.includes('contains("<title>'),
    'the shell no longer keys the boot handshake on anything the page renders',
  );
});

test('the marker is not something a redesign can move', () => {
  const ui = fs.readFileSync(path.join(ROOT, 'ui/index.html'), 'utf8');
  assert.ok(!ui.includes(IDENTITY_HEADER), 'the marker lives in the response, not in the document');
  assert.match(IDENTITY_VALUE, /^[a-z]+$/, 'a fixed word, so no version bump can break a boot');
});
