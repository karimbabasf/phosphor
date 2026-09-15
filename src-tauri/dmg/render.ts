// Renders background.html into the two-scale TIFF the disk image uses as its background.
//
// Finder draws the background at one pixel per point on a plain display and reads the @2x
// representation on a Retina one, so the picture is captured twice, at device scale 1 and 2,
// and joined with tiffutil, which checks that the second is exactly double the first. It draws
// in a Chromium that is already running with remote debugging on, through playwright-core over
// CDP: CDP_URL (default http://127.0.0.1:9333, the headless automation Brave) and
// PLAYWRIGHT_CORE (a copy of the package; it is not a dependency of this repo). Run:
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
const HEIGHT = 400;

type Json = any;

const require = createRequire(import.meta.url);
const { chromium } = require(PLAYWRIGHT_CORE) as { chromium: Json };
const browser = await chromium.connectOverCDP(CDP_URL);
const shots: string[] = [];
try {
  for (const scale of [1, 2]) {
    // A context of its own per scale: the device scale factor is a context property, and the
    // browser's existing context belongs to whatever else is using it.
    const context: Json = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: scale });
    const page: Json = await context.newPage();
    await page.goto(`file://${path.join(HERE, 'background.html')}`);
    await page.evaluate(() => (document as any).fonts.ready);
    const file = path.join(HERE, scale === 1 ? 'background.png' : 'background@2x.png');
    await page.screenshot({ path: file, type: 'png', clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } });
    await context.close();
    shots.push(file);
  }
} finally {
  // Disconnects; the browser was not ours to close.
  await browser.close();
}

const tiff = path.join(HERE, 'background.tiff');
execFileSync('tiffutil', ['-cathidpicheck', shots[0], shots[1], '-out', tiff], { stdio: 'inherit' });
for (const shot of shots) fs.unlinkSync(shot);
console.log(`dmg: ${path.relative(process.cwd(), tiff)} (${(fs.statSync(tiff).size / 1024).toFixed(0)} KB, ${WIDTH}x${HEIGHT} at 1x and 2x)`);
