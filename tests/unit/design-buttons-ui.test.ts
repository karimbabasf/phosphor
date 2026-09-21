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
  ['layout.css', 'button.bar-state', 'min-height'],
  ['layout.css', '.dock-close', 'height'],
  ['layout.css', '.dock-next', 'min-height'],
  ['layout.css', '.dock-report-toggle', 'min-height'],
  ['trade.css', '.pane-hide', 'height'],
  ['trade.css', '.pane-show', 'height'],
  ['trade.css', '.layers', 'height'],
  ['agent.css', '.steps-fold', 'min-height'],
  ['agent.css', '.composer-send', 'height'],
  ['deposit.css', '.netpick-link', 'min-height'],
  ['pro.css', 'button.rule-group-title', 'min-height'],
  ['pro.css', '.activity-link', 'min-height'],
  ['components.css', 'button.chip', 'min-height'],
  ['components.css', '.check-row', 'min-height'],
  ['checks.css', '.checks-toggle', 'min-height'],
  ['sendcard.css', '.sendcard-info', 'height'],
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
  assert.match(components, /\.check-row\[aria-checked="true"\] \.check\s*\{[^}]*background:\s*var\(--ink\);/);
  assert.match(components, /\.check\s*\{[^}]*border-radius:\s*3px;/, 'the box went round again and reads as a radio');
  const trade = css('trade.css');
  assert.doesNotMatch(trade, /\.layers-row\s*\{/, 'trade.css draws the check row a second time');
  assert.doesNotMatch(trade, /\.layers-check\s*\{/);
});

test('the copy button is drawn once for the receipt and the send card', () => {
  const components = css('components.css');
  assert.match(components, /\.receipt-copy,\s*\.sendcard-copy\s*\{\s*gap:\s*var\(--s-1\);/);
  assert.match(components, /\.receipt-copy > \.icon,\s*\.sendcard-copy > \.icon\s*\{[^}]*width:\s*14px;/);
  assert.doesNotMatch(css('receipt.css'), /\.receipt-copy > \.icon/);
  assert.doesNotMatch(css('sendcard.css'), /\.sendcard-address-actions \.icon/);
});

test('hover lifts the edge in the family\'s own colour, and a pressed chip is lit', () => {
  const components = css('components.css');
  assert.match(components, /\.btn\s*\{[^}]*--btn-edge-hover:\s*var\(--text-3\);/);
  assert.match(components, /\.btn:hover:not\(:disabled\)\s*\{\s*border-color:\s*var\(--btn-edge-hover\);/);
  assert.match(components, /\.btn-primary\s*\{[^}]*--btn-edge-hover:\s*color-mix\(in srgb, var\(--ink\) 88%, #FFFFFF\);/);
  assert.match(components, /\.btn-danger\s*\{[^}]*--btn-edge-hover:/);
  assert.match(components, /\.btn:active:not\(:disabled\)\s*\{[^}]*background:\s*var\(--btn-bg-active\);/);
  assert.match(components, /button\.chip\[aria-pressed="true"\]\s*\{[^}]*background:\s*var\(--ink-wash\);/);
  assert.doesNotMatch(css('pro.css'), /\.chip-filter\[aria-pressed="true"\]/, 'pro.css keeps its own pressed chip');
});

test('the send card\'s info disc is 16 px to read and 30 px to press', () => {
  const sendcard = css('sendcard.css');
  const button = sendcard.match(/\.sendcard-info\s*\{([^}]*)\}/);
  const disc = sendcard.match(/\.sendcard-info > span\s*\{([^}]*)\}/);
  assert.equal(px(declared(button?.[1] ?? '', 'width')), 30);
  assert.equal(px(declared(button?.[1] ?? '', 'height')), 30);
  assert.equal(px(declared(disc?.[1] ?? '', 'width')), 16);
  assert.match(disc?.[1] ?? '', /border:\s*1px solid var\(--line-strong\)/);
});

test('a pressable\'s label never sits on the third text tone', () => {
  assert.match(css('agent.css'), /\.steps-fold\s*\{[^}]*color:\s*var\(--text-2\);/);
  assert.match(css('pro.css'), /button\.rule-group-title\s*\{[^}]*color:\s*var\(--text-2\);/);
  const quiet = css('components.css').match(/\.btn-quiet\s*\{([^}]*)\}/);
  assert.equal(declared(quiet?.[1] ?? '', '--btn-fg'), 'var(--text-2)');
});

test('the freeze button in index.html names its verb and its size', () => {
  const html = fs.readFileSync(path.join(ROOT, 'ui', 'index.html'), 'utf8');
  const freeze = html.match(/<button class="([^"]*)" id="btn-freeze"([^>]*)>/);
  assert.ok(freeze, 'index.html has no #btn-freeze');
  assert.ok(/\bbtn\b/.test(freeze?.[1] ?? '') && /\bbtn-sm\b/.test(freeze?.[1] ?? ''), 'freeze is not the small variant');
  assert.match(freeze?.[2] ?? '', /type="button"/);
  assert.match(freeze?.[2] ?? '', /data-pending-label="Freezing"/);
  assert.doesNotMatch(css('layout.css'), /\.btn\.freeze\s*\{[^}]*height:/, 'layout.css sizes the freeze button by hand again');
});
