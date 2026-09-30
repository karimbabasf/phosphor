// Renders the pictures the disk image carries: background.html into the two-scale TIFFs the
// window uses as its background (background.tiff for an ad-hoc build, background-notarized.tiff,
// without the Open Anyway tile, for a notarized one), and open-anyway.html into the Open Anyway
// shortcut's icon.
//
// Finder draws the background at one pixel per point on a plain display and reads the @2x
// representation on a Retina one, so the picture is captured twice, at device scale 1 and 2,
// and joined with tiffutil, which checks that the second is exactly double the first. The icon
// is one 1024 px PNG with a transparent canvas; macOS scales it for every size Finder asks for.
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
const HEIGHT = 564;
const ICON = 1024;

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

const icon = path.join(HERE, 'open-anyway.png');
const backgrounds = [
  { page: 'background.html', tiff: path.join(HERE, 'background.tiff') },
  { page: 'background.html?notarized', tiff: path.join(HERE, 'background-notarized.tiff') },
];
const shots = [path.join(HERE, 'background.png'), path.join(HERE, 'background@2x.png')];
try {
  for (const { page, tiff } of backgrounds) {
    await capture(page, shots[0], WIDTH, HEIGHT, 1, false);
    await capture(page, shots[1], WIDTH, HEIGHT, 2, false);
    execFileSync('tiffutil', ['-cathidpicheck', shots[0], shots[1], '-out', tiff], { stdio: 'inherit' });
    for (const shot of shots) fs.unlinkSync(shot);
    console.log(`dmg: ${path.relative(process.cwd(), tiff)} (${(fs.statSync(tiff).size / 1024).toFixed(0)} KB, ${WIDTH}x${HEIGHT} at 1x and 2x)`);
  }
  await capture('open-anyway.html', icon, ICON, ICON, 1, true);
} finally {
  // Disconnects; the browser was not ours to close.
  await browser.close();
}

console.log(`dmg: ${path.relative(process.cwd(), icon)} (${(fs.statSync(icon).size / 1024).toFixed(0)} KB, ${ICON}x${ICON})`);
