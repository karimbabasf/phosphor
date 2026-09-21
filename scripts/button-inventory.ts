// Every button in the window, listed and photographed.
//
// Two halves. The scan reads ui/screens/*.js, ui/*.js and ui/index.html for every place a
// button is built (dom.el('button', ...), the three button() helpers, document.createElement,
// the markup in index.html), groups the sites by class string into families, reads where each
// one's label comes from and whether it can wait (data-pending-label) or be disabled, and
// checks ui/design/*.css for a rule per state. The sheet then renders one sample per family
// (scripts/button-inventory/recipes.ts, built the way the screen builds it) in every state it
// can enter, at the two column widths the dock is verified against (860 and 400 px), in the
// shipped colourway, and measures what a picture cannot show: the box height against the
// floor (36, small 30, large 44), the room around the label, a label that wraps or clips, and
// a waiting button that shows both of its faces or changes width when it starts to wait.
//
// Fixture only: no backend, no wallet, a generated page over the stylesheets on disk. Run:
//   node scripts/button-inventory.ts            the table, the json and both sheets
//   node scripts/button-inventory.ts --list     the table alone, no browser
// INVENTORY_OUT names the directory (default docs/superpowers/prompts/ready-for-people/
// evidence-e/inventory). playwright-core is not a dependency of this repo; PLAYWRIGHT_CORE
// points at a copy, PROOF_BROWSER at a Chromium binary when playwright's own shell is absent.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RECIPES, type Recipe } from './button-inventory/recipes.ts';
import { families, scan, type Family } from './button-inventory/scan.ts';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PLAYWRIGHT_CORE =
  process.env.PLAYWRIGHT_CORE ?? path.join(os.homedir(), '.npm/_npx/705bc6b22212b352/node_modules/playwright-core');
const BROWSER = process.env.PROOF_BROWSER;
const OUT = process.env.INVENTORY_OUT ?? path.join(ROOT, 'docs/superpowers/prompts/ready-for-people/evidence-e/inventory');
const WIDTHS = [860, 400];

// The floor every button is held to (docs/superpowers/specs/2026-09-20-quality-definitions.md,
// term 9, B1). A control the bar keeps compact still has to reach the small variant.
const HEIGHT_FLOOR = 36;
const HEIGHT_SMALL = 30;
const HEIGHT_LARGE = 44;
const LABEL_ROOM = 24;

type Json = any;

// ---------- the sheet ----------

type Measure = {
  family: string;
  width: number;
  height: number;
  boxWidth: number;
  labelWidth: number;
  labelLines: number;
  clipped: boolean;
  minHeight: number;
  floor: number;
  pendingWidth: number | null;
  pendingBothFaces: boolean | null;
  pendingOutside: boolean | null;
  problems: string[];
};

function floorFor(family: string): number {
  if (/\bbtn-lg\b/.test(family)) return HEIGHT_LARGE;
  if (/\bbtn-sm\b/.test(family)) return HEIGHT_SMALL;
  if (/\bbtn\b/.test(family)) return HEIGHT_FLOOR;
  return HEIGHT_SMALL;
}

function sheetHtml(recipes: readonly Recipe[], width: number): string {
  const design = path.join(ROOT, 'ui/design');
  const order = fs.readFileSync(path.join(ROOT, 'ui/index.html'), 'utf8').match(/href="\.\/design\/([a-z]+\.css)"/g) ?? [];
  const links = order.map((m) => `<link rel="stylesheet" href="${pathToFileURL(path.join(design, m.replace(/^href="\.\/design\//, '').replace(/"$/, ''))).href}">`).join('\n');
  const scripts = ['icons.js', 'marks.js'].map((s) => `<script src="${pathToFileURL(path.join(design, s)).href}"></script>`).join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Button inventory</title>
${links}
<style>
  html, body { height: auto; overflow: visible; }
  body { padding: 24px; display: flex; justify-content: flex-start; }
  .sheet { width: ${width}px; flex: 0 0 auto; }
  .sheet-title { font-size: 12px; color: var(--text-3); margin: 0 0 12px; font-family: var(--font-mono); }
  .fam { border-top: 1px solid var(--line); padding: 10px 0 12px; }
  .fam-head { display: flex; gap: 12px; align-items: baseline; margin-bottom: 8px; font-family: var(--font-mono); font-size: 11px; color: var(--text-2); }
  .fam-head b { color: var(--text); font-weight: 500; }
  .cells { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: flex-start; }
  .cell { display: flex; flex-direction: column; gap: 6px; min-width: 0; max-width: 100%; }
  .cell[data-wide="true"] { flex: 1 0 100%; }
  .cell[data-wide="true"] .stage, .cell[data-wide="true"] .stage > * { width: 100%; }
  .cell[data-wide="true"] .stage { container-type: inline-size; }
  .cell-cap { font-family: var(--font-mono); font-size: 10px; color: var(--text-3); }
  .stage { display: flex; align-items: flex-start; max-width: 100%; }
</style></head>
<body data-view="basic">
<div class="sheet"><p class="sheet-title">column ${width} px, green on black</p><div id="rows"></div></div>
${scripts}
<script>
(function () {
  var RECIPES = ${JSON.stringify(recipes)};
  var STATES = ['rest', 'hover', 'active', 'focus', 'disabled', 'pending', 'on', 'live'];
  function build(child) {
    var node;
    if (child.icon) {
      node = window.PhosphorIcons.svg(child.icon, child.cls);
    } else if (child.glyph) {
      node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      node.setAttribute('class', 'tcard-glyph ' + (child.cls || ''));
      node.setAttribute('viewBox', '0 0 24 24');
      var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', 'M9.5 6l6 6-6 6');
      p.setAttribute('fill', 'none'); p.setAttribute('stroke', 'currentColor'); p.setAttribute('stroke-width', '1.5');
      p.setAttribute('stroke-linecap', 'round'); p.setAttribute('stroke-linejoin', 'round');
      node.appendChild(p);
    } else {
      node = document.createElement(child.tag);
      if (child.cls) node.className = child.cls;
      if (child.text) node.textContent = child.text;
    }
    if (child.attrs) Object.keys(child.attrs).forEach(function (k) { node.setAttribute(k, child.attrs[k]); });
    (child.children || []).forEach(function (c) { node.appendChild(build(c)); });
    return node;
  }
  function sample(recipe, state) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = recipe.family;
    if (recipe.attrs) Object.keys(recipe.attrs).forEach(function (k) { button.setAttribute(k, recipe.attrs[k]); });
    if (recipe.pending) button.setAttribute('data-pending-label', recipe.pending);
    recipe.children.forEach(function (c) { button.appendChild(build(c)); });
    if (state === 'disabled') button.disabled = true;
    if (state === 'on' && recipe.on) Object.keys(recipe.on).forEach(function (k) { button.setAttribute(k, recipe.on[k]); });
    if (state === 'live') button.setAttribute('data-live', 'true');
    if (state === 'pending') {
      /* ui/screens/shell.js setPending, verbatim in effect. */
      var slot = document.createElement('span');
      slot.className = 'btn-pending';
      var spin = document.createElement('span'); spin.className = 'spinner'; slot.appendChild(spin);
      var word = document.createElement('span'); word.className = 'btn-pending-label';
      word.textContent = button.getAttribute('data-pending-label') || 'Working';
      slot.appendChild(word);
      button.appendChild(slot);
      button.dataset.pending = 'true';
      button.setAttribute('aria-busy', 'true');
      button.disabled = true;
    }
    button.setAttribute('data-sample', recipe.family);
    button.setAttribute('data-state', state);
    var stage = document.createElement('div');
    stage.className = 'stage';
    var host = stage;
    if (recipe.wrap) {
      var wrap = document.createElement('div');
      wrap.className = recipe.wrap;
      if (recipe.wrapStyle) wrap.setAttribute('style', recipe.wrapStyle);
      if (recipe.wrapAttrs) Object.keys(recipe.wrapAttrs).forEach(function (k) { wrap.setAttribute(k, recipe.wrapAttrs[k]); });
      stage.appendChild(wrap);
      host = wrap;
    }
    host.appendChild(button);
    return stage;
  }
  var rows = document.getElementById('rows');
  RECIPES.forEach(function (recipe) {
    var fam = document.createElement('section');
    fam.className = 'fam';
    var head = document.createElement('div');
    head.className = 'fam-head';
    var name = document.createElement('b'); name.textContent = '.' + recipe.family.split(' ').join('.');
    head.appendChild(name);
    fam.appendChild(head);
    var cells = document.createElement('div');
    cells.className = 'cells';
    STATES.forEach(function (state) {
      if (state === 'pending' && !recipe.pending) return;
      if (state === 'on' && !recipe.on) return;
      if (state === 'live' && !recipe.live) return;
      if (state === 'disabled' && !recipe.disables && !/\\bbtn\\b/.test(recipe.family)) return;
      var cell = document.createElement('div');
      cell.className = 'cell';
      if (recipe.wide) cell.setAttribute('data-wide', 'true');
      cell.appendChild(sample(recipe, state));
      var cap = document.createElement('div');
      cap.className = 'cell-cap';
      cap.textContent = state;
      cell.appendChild(cap);
      cells.appendChild(cell);
    });
    fam.appendChild(cells);
    rows.appendChild(fam);
  });
})();
</script>
</body></html>`;
}

// What the picture cannot show, read off the rest and pending samples of every family.
const MEASURE = `(function (selector, floorPx) {
  var button = document.querySelector('[data-sample="' + selector + '"][data-state="rest"]');
  if (!button) return null;
  var labelSel = button.getAttribute('data-label-sel');
  var label = button.querySelector('.btn-label') || button.querySelector(labelSel || 'span');
  var box = button.getBoundingClientRect();
  var cs = getComputedStyle(button);
  var out = { height: box.height, boxWidth: box.width, minHeight: parseFloat(cs.minHeight) || 0, labelWidth: 0, labelLines: 1, clipped: false, pendingWidth: null, pendingBothFaces: null, pendingOutside: null };
  if (label) {
    var lb = label.getBoundingClientRect();
    out.labelWidth = lb.width;
    var lh = parseFloat(getComputedStyle(label).lineHeight) || parseFloat(getComputedStyle(label).fontSize) * 1.5;
    out.labelLines = Math.max(1, Math.round(lb.height / lh));
    out.clipped = label.scrollWidth > label.clientWidth + 1 || button.scrollWidth > button.clientWidth + 1;
  }
  var waiting = document.querySelector('[data-sample="' + selector + '"][data-state="pending"]');
  if (waiting) {
    var wb = waiting.getBoundingClientRect();
    out.pendingWidth = wb.width;
    var rest = waiting.querySelector('.btn-label') || waiting.querySelector(labelSel || 'span:not(.btn-pending):not(.btn-pending *)');
    var face = waiting.querySelector('.btn-pending');
    var restShown = rest ? parseFloat(getComputedStyle(rest).opacity) > 0.05 && getComputedStyle(rest).visibility !== 'hidden' : false;
    var fb = face ? face.getBoundingClientRect() : null;
    out.pendingBothFaces = restShown;
    out.pendingOutside = fb ? (fb.left < wb.left - 0.5 || fb.right > wb.right + 0.5 || fb.top < wb.top - 0.5 || fb.bottom > wb.bottom + 0.5) : null;
  }
  return out;
})`;

async function render(list: Family[]): Promise<Measure[]> {
  const require = createRequire(import.meta.url);
  // Untyped on purpose: playwright-core is not a dependency of this repo.
  const { chromium } = require(PLAYWRIGHT_CORE) as { chromium: Json };
  const browser = await chromium.launch({ headless: true, ...(BROWSER ? { executablePath: BROWSER } : {}) });
  const measures: Measure[] = [];
  const recipes = RECIPES.filter((r) => list.some((f) => f.family === r.family));
  try {
    for (const width of WIDTHS) {
      const file = path.join(OUT, `sheet-${width}.html`);
      fs.writeFileSync(file, sheetHtml(recipes, width));
      const page: Json = await browser.newPage({ viewport: { width: width + 48, height: 900 }, deviceScaleFactor: 2 });
      const noise: string[] = [];
      page.on('pageerror', (err: unknown) => noise.push(String(err)));
      await page.goto(pathToFileURL(file).href);
      await page.evaluate('document.fonts.ready');
      // The label selector rides on the sample so the measure can find the words.
      for (const r of recipes) {
        if (r.labelSelector) {
          await page.evaluate(`document.querySelectorAll('[data-sample="${r.family}"]').forEach(function (b) { b.setAttribute('data-label-sel', ${JSON.stringify(r.labelSelector)}); })`);
        }
      }
      // Hover, active and focus are forced through the inspector protocol, the one way to
      // photograph three pseudo states of forty buttons on one page.
      const cdp: Json = await page.context().newCDPSession(page);
      await cdp.send('DOM.enable');
      await cdp.send('CSS.enable');
      const doc = await cdp.send('DOM.getDocument', { depth: -1 });
      for (const [state, pseudo] of [['hover', 'hover'], ['active', 'active'], ['focus', 'focus-visible']]) {
        const nodes = await cdp.send('DOM.querySelectorAll', { nodeId: doc.root.nodeId, selector: `[data-state="${state}"]` });
        for (const nodeId of nodes.nodeIds) {
          await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: state === 'focus' ? [pseudo, 'focus'] : [pseudo] });
        }
      }
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(OUT, `sheet-${width}.png`), fullPage: true });
      for (const r of recipes) {
        const m = (await page.evaluate(`${MEASURE}(${JSON.stringify(r.family)})`)) as Json;
        if (!m) continue;
        const floor = floorFor(r.family);
        const problems: string[] = [];
        if (m.height + 0.5 < floor) problems.push(`height ${m.height.toFixed(1)} under the ${floor} floor`);
        // A quiet button has no edge, so the room around its word is the line's own; a row
        // whose title is a sentence wraps on a narrow column rather than cutting the sentence.
        if (!r.iconOnly && m.labelWidth > 0 && m.boxWidth + 0.5 < m.labelWidth + LABEL_ROOM && !/\bbtn-quiet\b/.test(r.family)) problems.push(`width ${m.boxWidth.toFixed(1)} leaves under 24 px around a ${m.labelWidth.toFixed(1)} px label`);
        if (!r.iconOnly && !r.sentence && m.labelLines > 1) problems.push(`label wraps to ${m.labelLines} lines`);
        if (!r.iconOnly && m.clipped) problems.push('label clips');
        if (m.pendingBothFaces === true) problems.push('pending shows both faces');
        if (m.pendingOutside === true) problems.push('pending face lands outside the box');
        if (m.pendingWidth !== null && Math.abs(m.pendingWidth - m.boxWidth) > 1) problems.push(`width moves from ${m.boxWidth.toFixed(1)} to ${m.pendingWidth.toFixed(1)} while waiting`);
        measures.push({ family: r.family, width, floor, ...m, problems });
      }
      if (noise.length) console.error(`page noise at ${width}:\n${noise.join('\n')}`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
  return measures;
}

// ---------- the table ----------

function table(list: Family[], measures: Measure[]): string {
  const head = ['Family', 'Sites', 'Label source', 'Waits', 'Disables', 'States drawn', 'Measured'];
  const rows = list.map((f) => {
    const sites = f.sites.map((s) => `${s.file.replace(/^ui\//, '')}:${s.line}`).join(', ');
    const labels = [...new Set(f.sites.map((s) => s.label))].join('; ');
    const waits = [...new Set(f.sites.map((s) => s.pending).filter((p): p is string => p !== null))].join(', ') || (f.pending ? 'yes' : 'no');
    const drawn = Object.entries(f.states).filter(([k, v]) => k !== 'rest' && v !== '').map(([k]) => k).join(', ');
    const m = measures.filter((x) => x.family === f.family);
    const measured = m.length === 0
      ? 'not rendered'
      : m.map((x) => `${x.width}: h ${x.height.toFixed(0)}${x.problems.length ? ' FAIL ' + x.problems.join('; ') : ' ok'}`).join('<br>');
    return [`\`${f.family}\``, sites, labels, waits, f.disables ? 'yes' : 'no', drawn, measured];
  });
  const line = (cells: string[]) => `| ${cells.map((c) => c.replace(/\|/g, '\\|')).join(' | ')} |`;
  return [line(head), line(head.map(() => '---')), ...rows.map(line)].join('\n');
}

async function main(): Promise<void> {
  const listOnly = process.argv.includes('--list');
  fs.mkdirSync(OUT, { recursive: true });
  const sites = scan();
  const list = families(sites);
  const missing = list.filter((f) => !RECIPES.some((r) => r.family === f.family) && /^[a-z][\w -]*$/.test(f.family));
  const dynamic = list.filter((f) => !/^[a-z][\w -]*$/.test(f.family));
  let measures: Measure[] = [];
  if (!listOnly) {
    if (missing.length) {
      throw new Error(`no recipe for: ${missing.map((f) => f.family).join(', ')} (scripts/button-inventory/recipes.ts)`);
    }
    measures = await render(list);
  }
  const md = [
    `# Button inventory`,
    ``,
    `${sites.length} sites, ${list.length} families, scanned from ui/screens/*.js, ui/*.js and ui/index.html on ${new Date().toISOString().slice(0, 10)}.`,
    dynamic.length ? `Class strings built at the call site, read as their own rows: ${dynamic.map((f) => `\`${f.family}\``).join(', ')}.` : '',
    ``,
    table(list, measures),
    ``,
  ].join('\n');
  fs.writeFileSync(path.join(OUT, 'inventory.md'), md);
  fs.writeFileSync(path.join(OUT, 'inventory.json'), JSON.stringify({ sites, families: list, measures }, null, 2));
  console.log(md);
  const failed = measures.filter((m) => m.problems.length > 0);
  if (!listOnly) {
    console.log(`${measures.length} measurements, ${failed.length} with a problem${failed.length ? ':' : '.'}`);
    for (const f of failed) console.log(`  ${f.family} @${f.width}: ${f.problems.join('; ')}`);
    console.log(`sheets: ${WIDTHS.map((w) => path.join(OUT, `sheet-${w}.png`)).join(' ')}`);
  }
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
