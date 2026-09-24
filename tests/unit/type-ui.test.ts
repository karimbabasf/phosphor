// The faces the window speaks in, and the tokens it no longer carries.
//
// Geist for words and Geist Mono for figures, both vendored and preloaded, and no Sora anywhere
// (2026-09-23: Geist and Geist Mono are the default pair for anything technical). A token that
// no rule reads is a promise nothing keeps, so the seven that went unread are gone.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const UI = new URL('../../ui/', import.meta.url);
const read = (file: string) => readFileSync(new URL(file, UI), 'utf8');
const HTML = read('index.html');

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full));
    else out.push(full);
  }
  return out;
}

test('the window speaks in Geist and Geist Mono, preloaded, and Sora is gone from it', () => {
  const uiDir = new URL('.', UI).pathname;
  for (const file of filesUnder(uiDir)) {
    if (!/\.(css|js|html)$/.test(file) || file.includes(`${path.sep}vendor${path.sep}`)) continue;
    const code = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
    assert.equal(code.includes('Sora'), false, `${path.relative(uiDir, file)} still sets Sora`);
  }
  assert.deepEqual(readdirSync(new URL('fonts/', UI)).sort(), ['Geist-Variable.woff2', 'GeistMono-Variable.woff2', 'OFL.txt']);
  assert.match(read('design/tokens.css'), /--font-ui: "Geist", /);
  assert.match(read('design/tokens.css'), /--font-mono: "Geist Mono", /);
  const type = read('design/type.css');
  assert.match(type, /font-family: "Geist";\s*src: url\("\.\.\/fonts\/Geist-Variable\.woff2"\)/);
  assert.match(type, /font-optical-sizing: auto;/);
  for (const font of ['Geist-Variable.woff2', 'GeistMono-Variable.woff2']) {
    assert.ok(HTML.includes(`<link rel="preload" href="./fonts/${font}" as="font" type="font/woff2" crossorigin>`), `${font} is not preloaded`);
  }
});

test('the splash and the update window speak in Geist, and Sora has left the frontend folder', () => {
  const frontend = new URL('../../src-tauri/frontend/', import.meta.url);
  assert.deepEqual(readdirSync(frontend).filter((f) => f.endsWith('.woff2')), ['Geist-Variable.woff2']);
  for (const page of ['index.html', 'update.html']) {
    const html = readFileSync(new URL(page, frontend), 'utf8');
    assert.equal(html.includes('Sora'), false, `${page} still names Sora`);
    assert.match(html, /font-family: "Geist";\s*src: url\("Geist-Variable\.woff2"\)/);
  }
});

test('the unused tokens are gone', () => {
  const tokens = read('design/tokens.css');
  for (const gone of ['--glow-ash', '--rail-w', '--gutter', '--live-glow', '--agent-wash', '--fs-56']) {
    assert.equal(tokens.includes(gone), false, `${gone} is still declared`);
  }
  assert.equal(read('theme.js').includes('--agent-wash'), false);
});
