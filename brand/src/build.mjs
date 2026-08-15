// Renders one of the mark pages to a PNG and prints the geometry it measured.
//   node build.mjs mark.html ../phosphor-wordmark.png
//   node build.mjs mark.html ../phosphor-wordmark-dark.png --fg '#33ff66' --bg '#0b0d0b'
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';

const [src, out, ...flags] = process.argv.slice(2);
if (!src || !out) {
  console.error('usage: node build.mjs <page.html> <out.png> [--fg <colour>] [--bg <colour>]');
  process.exit(1);
}

// The page reads its colours off the query string, so the same page draws the light mark and
// the dark one and the geometry cannot drift between them.
const query = new URLSearchParams();
for (let i = 0; i < flags.length; i += 2) {
  const key = flags[i].replace(/^--/, '');
  if (key !== 'fg' && key !== 'bg') { console.error(`unknown flag ${flags[i]}`); process.exit(1); }
  query.set(key, flags[i + 1]);
}

const BROWSER = process.env.BROWSER || '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const PW = process.env.PW || '/Users/karimbaba/.claude/tools/node_modules/playwright-core/index.mjs';

const { chromium } = await import(PW).catch(() => import('playwright-core'));

const browser = await chromium.launch({ executablePath: BROWSER, headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message));
const url = pathToFileURL(src);
url.search = query.toString();
await page.goto(url.href, { waitUntil: 'networkidle' });

const r = await page.evaluate(() => window.render);
writeFileSync(out, Buffer.from(r.dataURL.split(',')[1], 'base64'));
const { dataURL, boxes, ...rest } = r;
console.log(JSON.stringify(rest));
console.log('wrote', out);
await browser.close();
