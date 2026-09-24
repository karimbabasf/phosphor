// The button floor, held in the stylesheets (docs/superpowers/specs/2026-09-20-quality-definitions.md,
// term 9, B1 to B3 and the three hook classes).
//
// tsc never sees ui/, so every mechanism fixed in ui/design is pinned here as a source assertion
// over the CSS and index.html: the rule that beats the hidden attribute, the one grid cell both
// faces of a waiting button share, the heights every family holds, the shared check row and copy
// button, and the markup of the one button index.html builds. A rewrite that drops one of them
// turns a test red before it turns a window wrong.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const DESIGN = path.join(ROOT, 'ui', 'design');

function css(name: string): string {
  return fs.readFileSync(path.join(DESIGN, name), 'utf8');
}

/* Every rule in every sheet as { selector, body, atRule }, comments stripped, nested at-rules
   flattened to the innermost at-rule text. Enough to ask what one selector declares. */
type Rule = { selector: string; body: string; at: string; file: string };

function rules(): Rule[] {
  const out: Rule[] = [];
  for (const name of fs.readdirSync(DESIGN).sort()) {
    if (!name.endsWith('.css')) continue;
    const text = css(name).replace(/\/\*[\s\S]*?\*\//g, '');
    const stack: string[] = [];
    let buf = '';
    for (const ch of text) {
      if (ch === '{') {
        stack.push(buf.trim());
        buf = '';
      } else if (ch === '}') {
        const head = stack.pop() ?? '';
        if (!head.startsWith('@')) {
          const at = stack.filter((s) => s.startsWith('@')).join(' ');
          out.push({ selector: head, body: buf.trim(), at, file: name });
        }
        buf = '';
      } else buf += ch;
    }
  }
  return out;
}

function declared(body: string, prop: string): string | null {
  const m = body.match(new RegExp(`(?:^|;)\\s*${prop.replace(/-/g, '\\-')}\\s*:\\s*([^;]+)`));
  return m ? (m[1] ?? '').trim() : null;
}

function px(value: string | null): number | null {
  if (value === null) return null;
  const m = value.match(/^(\d+(?:\.\d+)?)px$/);
  return m ? Number(m[1]) : null;
}

test('the hidden attribute is display none with weight, and nothing with weight can beat it', () => {
  const reset = css('reset.css');
  assert.match(reset, /\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/, 'reset.css lost the [hidden] guard');
  for (const rule of rules()) {
    if (!/display\s*:[^;]*!important/.test(rule.body)) continue;
    const guard = /\[hidden\]/.test(rule.selector) || /@media\s+print/.test(rule.at);
    assert.ok(guard, `${rule.file}: "${rule.selector}" sets display with !important and is not a [hidden] guard`);
  }
});

test('both faces of a waiting button share one cell whether or not the verb was named', () => {
  const components = css('components.css');
  const stack = components.match(/button\[data-pending-label\],\s*button\[data-pending="true"\]\s*\{([^}]*)\}/);
  assert.ok(stack, 'the grid cell is keyed on data-pending-label alone: a button that waits without a verb shows the spinner beside its label');
  assert.match(stack?.[1] ?? '', /display:\s*grid/);
  assert.match(stack?.[1] ?? '', /grid-template-areas:\s*"swap"/);
  assert.match(components, /button\[data-pending-label\] > \*,\s*button\[data-pending="true"\] > \*,\s*button\[data-pending-label\]::before\s*\{\s*grid-area:\s*swap;/);
  const rest = components.match(/\[data-pending="true"\] > :not\(\.btn-pending\)\s*\{([^}]*)\}/);
  assert.ok(rest, 'the rest face is not hidden while the button waits');
  assert.match(rest?.[1] ?? '', /opacity:\s*0\b/);
  assert.match(components, /\.btn-pending\s*\{[^}]*opacity:\s*0;/);
  assert.match(components, /\[data-pending="true"\] \.btn-pending\s*\{\s*opacity:\s*1;/);
});

test('the send disc waits with the spinner alone', () => {
  assert.match(css('agent.css'), /\.composer-send \.btn-pending-label\s*\{\s*display:\s*none;\s*\}/);
});

test('every .btn rule holds its variant floor: 36, small 30, large 44', () => {
  const components = css('components.css');
  assert.match(components, /\.btn\s*\{[^}]*min-height:\s*36px;/);
  assert.match(components, /\.btn-sm\s*\{[^}]*min-height:\s*30px;/);
  assert.match(components, /\.btn-lg\s*\{[^}]*min-height:\s*44px;/);
  for (const rule of rules()) {
    if (!/\.btn(?![\w-])/.test(rule.selector) && !/\.btn-(primary|ghost|quiet|danger|sm|lg)(?![\w-])/.test(rule.selector)) continue;
    const floor = /btn-lg/.test(rule.selector) ? 44 : /btn-sm/.test(rule.selector) ? 30 : 36;
    for (const prop of ['height', 'min-height']) {
      const value = px(declared(rule.body, prop));
      if (value === null) continue;
      assert.ok(value >= floor, `${rule.file}: "${rule.selector}" sets ${prop} ${value}px under the ${floor} floor`);
    }
  }
});

/* The pressables that are not .btn, each held to the small variant's 30 px by the rule that
   sizes it. The list is the button inventory's (scripts/button-inventory.ts) minus the .btn
   families and the rows whose height is their content's. */
const SMALL_FLOOR: Array<[file: string, selector: string, prop: string]> = [
  ['layout.css', '.tab', 'height'],
  ['layout.css', '.layout', 'height'],
  ['components.css', '.dock-close', 'height'],
  ['layout.css', '.brake-btn', 'height'],
  ['notice.css', '.notice-act', 'min-height'],
  ['basic.css', '.bal-add', 'min-height'],
  ['basic.css', '.bal-more', 'min-height'],
  ['trade.css', '.pane-hide', 'height'],
  ['trade.css', '.pane-show', 'height'],
  ['trade.css', '.layers', 'height'],
  ['agent.css', '.steps-fold', 'min-height'],
  ['agent.css', '.composer-send', 'height'],
  ['agent.css', '.jump-latest', 'height'],
  ['agent.css', '.agent-waiting', 'min-height'],
  ['chatcard.css', '.mcard-details-toggle', 'min-height'],
  ['deposit.css', '.netpick-link', 'min-height'],
  ['vault.css', '.vault-seg-cell', 'min-height'],
  ['components.css', 'button.chip', 'min-height'],
  ['components.css', '.check-row', 'min-height'],
  ['checks.css', '.checks-toggle', 'min-height'],
  ['receipt.css', '.receipt-close', 'height'],
];

test('every pressable that is not a .btn holds the small variant', () => {
  const all = rules();
  for (const [file, selector, prop] of SMALL_FLOOR) {
    const rule = all.find((r) => r.file === file && r.selector === selector);
    assert.ok(rule, `${file}: no rule for "${selector}"`);
    const value = px(declared(rule?.body ?? '', prop));
    assert.ok(value !== null && value >= 30, `${file}: "${selector}" ${prop} is ${value ?? 'unset'}, under 30`);
  }
});

test('the check row is one component, and the trade sheet keeps no copy of it', () => {
  const components = css('components.css');
  assert.match(components, /\.check-row\s*\{[^}]*min-height:\s*30px;/);
  /* On is the box a step up with a tick in it, never a green fill: on the trading side green
     reads as a price going up (hunt B, 2026-09-23). */
  assert.match(components, /\.check-row\[aria-checked="true"\] \.check\s*\{[^}]*background:\s*var\(--bg-3\);/);
  assert.doesNotMatch(components.match(/\.check-row\[aria-checked="true"\] \.check\s*\{[^}]*\}/)?.[0] ?? '', /--ink/, 'the box fills green again');
  assert.match(components, /\.check\s*\{[^}]*border-radius:\s*6px;/, 'the box went round again and reads as a radio');
  assert.match(components, /\.check-row\[aria-checked="true"\] \.check > \.icon\s*\{[^}]*opacity:\s*1;/, 'no tick shows in a box that is on');
  const trade = css('trade.css');
  assert.doesNotMatch(trade, /\.layers-row\s*\{/, 'trade.css draws the check row a second time');
  assert.doesNotMatch(trade, /\.layers-check\s*\{/);
});

test('the deposit card\'s open button sits on the text column', () => {
  assert.match(css('cards.css'), /\.tcard-open\s*\{\s*margin-left:\s*calc\(20px \+ var\(--s-3\)\);\s*\}/);
});

/* The send card is gone (hunt B, 2026-09-23): a send is decided on its move card, and the
   window no longer loads the old card's sheet or script. */
test('the copy button is drawn once for the receipt, and the send card is gone', () => {
  const components = css('components.css');
  assert.match(components, /\.receipt-copy\s*\{\s*gap:\s*var\(--s-1\);/);
  assert.match(components, /\.receipt-copy > \.icon\s*\{[^}]*width:\s*14px;/);
  assert.doesNotMatch(css('receipt.css'), /\.receipt-copy > \.icon/);
  assert.doesNotMatch(components, /sendcard/);
  const html = fs.readFileSync(new URL('../../ui/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /sendcard/, 'the window still loads the send card');
  assert.ok(!fs.existsSync(new URL('../../ui/screens/sendcard.js', import.meta.url)), 'the send card script is still in the tree');
  assert.ok(!fs.existsSync(new URL('../../ui/design/sendcard.css', import.meta.url)), 'the send card sheet is still in the tree');
});

/* Soft depth (2026-09-23): a button is a raised layer with no outline, so hover lifts its fill a
   shade in the family's own colour rather than drawing an edge; the primary steps toward white. */
test('hover lifts the fill in the family\'s own colour, and a pressed chip is lit', () => {
  const components = css('components.css');
  assert.match(components, /\.btn\s*\{[^}]*--btn-bg-hover:\s*color-mix\(/);
  assert.match(components, /\.btn:hover:not\(:disabled\)\s*\{\s*border-color:\s*var\(--btn-edge-hover\);\s*background:\s*var\(--btn-bg-hover\);/);
  assert.match(components, /\.btn-primary\s*\{[^}]*--btn-edge-hover:\s*color-mix\(in srgb, var\(--ink\) 88%, #FFFFFF\);/);
  assert.match(components, /\.btn-danger\s*\{[^}]*--btn-bg-active:/);
  assert.match(components, /\.btn:active:not\(:disabled\)\s*\{[^}]*background:\s*var\(--btn-bg-active\);/);
  assert.match(components, /\.btn:active:not\(:disabled\)\s*\{[^}]*transform:\s*scale\(var\(--scale-press\)\);/);
  assert.match(components, /button\.chip\[aria-pressed="true"\]\s*\{[^}]*background:\s*var\(--ink-wash\);/);
});

test('a quiet button keeps the floor\'s 24 px around its word', () => {
  const quiet = css('components.css').match(/\.btn-quiet\s*\{([^}]*)\}/);
  assert.equal(declared(quiet?.[1] ?? '', 'padding'), '0 var(--s-3)', 'quiet buttons hug their label again');
});

/* Every pressable that is not a .btn takes one press state, listed in press.css: a wash of the
   text one shade past a hover, the compact ones giving 3 percent as well. The press has to WIN
   the cascade, not merely exist: with the pointer down both the family's hover rule and its
   press rule match, and the later or more specific one paints. Ten families pressed like a hover
   on 2026-09-20 because the press sat in components.css at the hover's specificity. So press.css
   loads last, and every press selector is at least as specific as every hover rule whose subject
   is that family, anywhere in ui/design. */
const PRESSED = ['dock-close', 'pane-hide', 'pane-show', 'receipt-close', 'lock-eye', 'netpick-back', 'netpick-link', 'netsel', 'trade-tab', 'steps-fold', 'checks-toggle', 'brake-btn', 'notice-act', 'bal-add', 'vault-seg-cell', 'net-row', 'jump-latest', 'check-row'];

// Selector specificity as (ids, classes plus attributes plus pseudo-classes, elements).
function specificity(selector: string): [number, number, number] {
  const sel = selector.replace(/::?[a-z-]+\([^)]*\)/g, ':x').trim();
  const ids = (sel.match(/#[\w-]+/g) ?? []).length;
  const classes = (sel.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) ?? []).length;
  const elements = (sel.match(/(^|[\s>+~(])[a-z][\w-]*/g) ?? []).length;
  return [ids, classes, elements];
}
function atLeast(a: [number, number, number], b: [number, number, number]): boolean {
  for (let i = 0; i < 3; i += 1) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return true;
}
// Every selector in a sheet, with the declaration block it opens, media wrappers ignored.
function rulesOf(text: string): Array<{ selector: string; block: string }> {
  const out: Array<{ selector: string; block: string }> = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const head = m[1].trim();
    if (head.startsWith('@')) continue;
    for (const selector of head.split(',')) out.push({ selector: selector.trim(), block: m[2] });
  }
  return out;
}

test('every pressable that is not a .btn has a press, on the shared wash, and the press wins the cascade', () => {
  const press = css('press.css');
  assert.match(css('tokens.css'), /--press:\s*color-mix\(in srgb, var\(--text\) 12%, transparent\);/);
  const compact = press.match(/\.dock-close:active,[^{]*\{([^}]*)\}/);
  assert.ok(compact, 'no shared press for the compact pressables');
  // The 3 percent is Soft depth's press token (--scale-press: 0.97 in tokens.css).
  assert.match(compact?.[1] ?? '', /transform:\s*scale\(var\(--scale-press\)\);/);
  assert.match(css('tokens.css'), /--scale-press:\s*0\.97;/);
  assert.match(compact?.[1] ?? '', /background-color:\s*var\(--press\);/);
  const rows = press.match(/\.checks-toggle:active,[^{]*\{([^}]*)\}/);
  assert.ok(rows, 'no shared press for the rows');
  assert.match(rows?.[1] ?? '', /background-color:\s*var\(--press\);/);
  assert.doesNotMatch(rows?.[1] ?? '', /transform/, 'a row that spans its column keeps its edges still');
  assert.doesNotMatch(press, /\.dock-next|\.dock-report-toggle|\.holding-head/, 'a press for a control nothing builds any more');
  assert.match(css('components.css'), /\.opens:active\s*\{[^}]*background-color:\s*color-mix\(in srgb, var\(--text\) 12%, var\(--opens-bg, transparent\)\);/);
  assert.doesNotMatch(css('components.css'), /\.dock-close:active|\.check-row:active\s*\{/, 'the press left components.css, where it lost the cascade');

  // Last in the window's load order: a hover rule in any other sheet paints before it.
  const html = fs.readFileSync(path.join(ROOT, 'ui', 'index.html'), 'utf8');
  const links = [...html.matchAll(/<link rel="stylesheet" href="\.\/design\/([\w.-]+\.css)">/g)].map((m) => m[1]);
  assert.equal(links.at(-1), 'press.css', `press.css is not the last sheet: ${links.join(', ')}`);

  // At least the specificity of every hover rule whose subject is the family, in every sheet.
  const sheets = fs.readdirSync(path.join(ROOT, 'ui', 'design')).filter((f) => f.endsWith('.css'));
  const hovers = sheets.flatMap((f) => rulesOf(css(f)).map((r) => ({ ...r, sheet: f })));
  const presses = rulesOf(press);
  for (const family of PRESSED) {
    const mine = presses.filter((r) => new RegExp(`\\.${family}:active(\\s|$)`).test(r.selector) && /background/.test(r.block));
    assert.ok(mine.length > 0, `${family} has no press`);
    const theirs = hovers.filter((r) => new RegExp(`\\.${family}:hover$`).test(r.selector) && /background/.test(r.block));
    for (const h of theirs) {
      const wins = mine.some((r) => atLeast(specificity(r.selector), specificity(h.selector)));
      assert.ok(wins, `${family}: the press (${mine.map((r) => r.selector).join(' | ')}) loses to ${h.sheet} "${h.selector}"`);
    }
  }
});

test('a pressable\'s label never sits on the third text tone', () => {
  assert.match(css('agent.css'), /\.steps-fold\s*\{[^}]*color:\s*var\(--text-2\);/);
  assert.match(css('vault.css'), /\.vault-seg-cell\s*\{[^}]*color:\s*var\(--text-2\);/);
  const quiet = css('components.css').match(/\.btn-quiet\s*\{([^}]*)\}/);
  assert.equal(declared(quiet?.[1] ?? '', '--btn-fg'), 'var(--text-2)');
});

test('the brake in index.html is one named glyph, and its confirm step is the small variant', () => {
  const html = fs.readFileSync(path.join(ROOT, 'ui', 'index.html'), 'utf8');
  const brake = html.match(/<button class="([^"]*)" id="btn-freeze"([^>]*)>/);
  assert.ok(brake, 'index.html has no #btn-freeze');
  assert.equal(brake?.[1], 'brake-btn');
  assert.match(brake?.[2] ?? '', /type="button"/);
  assert.match(brake?.[2] ?? '', /aria-label="Freeze everything"/);
  const go = html.match(/<button class="([^"]*)" type="button" data-role="brake-go">/);
  assert.equal(go?.[1], 'btn btn-sm', 'the confirm step is not the small variant');
  assert.doesNotMatch(css('layout.css'), /\.brake-actions \.btn\s*\{[^}]*height:/, 'layout.css sizes the confirm step by hand');
});
