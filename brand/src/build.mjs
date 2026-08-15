// Renders one of the mark pages to a PNG and prints the geometry it measured.
//   node build.mjs mark.html ../phosphor-wordmark.png
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';

const [src, out] = process.argv.slice(2);
if (!src || !out) {
  console.error('usage: node build.mjs <page.html> <out.png>');
  process.exit(1);
}

const BROWSER = process.env.BROWSER || '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const PW = process.env.PW || '/Users/karimbaba/.claude/tools/node_modules/playwright-core/index.mjs';

const { chromium } = await import(PW).catch(() => import('playwright-core'));

const browser = await chromium.launch({ executablePath: BROWSER, headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message));
await page.goto(pathToFileURL(src).href, { waitUntil: 'networkidle' });

const r = await page.evaluate(() => window.render);
writeFileSync(out, Buffer.from(r.dataURL.split(',')[1], 'base64'));
const { dataURL, boxes, ...rest } = r;
console.log(JSON.stringify(rest));
console.log('wrote', out);
await browser.close();
