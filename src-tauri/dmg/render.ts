// Renders background.html into background.tiff, the two-scale TIFF the disk image window uses as
// its background.
//
// Finder draws the background at one pixel per point on a plain display and reads the @2x
// representation on a Retina one, so the picture is captured twice, at device scale 1 and 2,
// and joined with tiffutil, which checks that the second is exactly double the first.
// It draws in a Chromium that is already running with remote debugging on, through
// playwright-core over CDP: CDP_URL (default http://127.0.0.1:9333, the headless automation
// Brave) and PLAYWRIGHT_CORE (a copy of the package; it is not a dependency of this repo). Run:
//   node src-tauri/dmg/render.ts

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLAYWRIGHT_CORE =
  process.env.PLAYWRIGHT_CORE ?? path.join(os.homedir(), '.npm/_npx/9833c18b2d85bc59/node_modules/playwright-core');
const CDP_URL = process.env.CDP_URL ?? 'http://127.0.0.1:9333';
const WIDTH = 660;
const HEIGHT = 372;

type Json = any;

const require = createRequire(import.meta.url);
const { chromium } = require(PLAYWRIGHT_CORE) as { chromium: Json };
const browser = await chromium.connectOverCDP(CDP_URL);

// A context of its own per capture: the device scale factor is a context property, and the
// browser's existing context belongs to whatever else is using it.
async function capture(page: string, out: string, width: number, height: number, scale: number, transparent: boolean) {
  const context: Json = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale });
  const tab: Json = await context.newPage();
  await tab.goto(`file://${path.join(HERE, page)}`);
  await tab.evaluate(() => (document as any).fonts.ready);
  await tab.screenshot({ path: out, type: 'png', omitBackground: transparent, clip: { x: 0, y: 0, width, height } });
  await context.close();
}

const tiff = path.join(HERE, 'background.tiff');
const shots = [path.join(HERE, 'background.png'), path.join(HERE, 'background@2x.png')];
try {
  await capture('background.html', shots[0], WIDTH, HEIGHT, 1, false);
  await capture('background.html', shots[1], WIDTH, HEIGHT, 2, false);
} finally {
  // Disconnects; the browser was not ours to close.
  await browser.close();
}

execFileSync('tiffutil', ['-cathidpicheck', shots[0], shots[1], '-out', tiff], { stdio: 'inherit' });
for (const shot of shots) fs.unlinkSync(shot);
console.log(`dmg: ${path.relative(process.cwd(), tiff)} (${(fs.statSync(tiff).size / 1024).toFixed(0)} KB, ${WIDTH}x${HEIGHT} at 1x and 2x)`);
