// The Open Anyway shortcut is the one thing in the disk image that gets a person past macOS's
// first-open block, and three files have to agree for it to land: the script that adds it, the
// tile drawn for it in background.html, and the window size in tauri.conf.json. Its format is
// asserted too, because the obvious choice fails: Finder refuses a double-clicked .webloc whose
// URL is not http or https when it comes from a downloaded image (seen 2026-09-22, macOS 27).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SHORTCUT_NAME, SETTINGS_URL, SHORTCUT_POSITION, inetlocPlist } from '../../scripts/dmg-open-anyway.ts';

const root = new URL('../../', import.meta.url);
const background = fs.readFileSync(new URL('src-tauri/dmg/background.html', root), 'utf8');
const dmg = JSON.parse(fs.readFileSync(new URL('src-tauri/tauri.conf.json', root), 'utf8')).bundle.macOS.dmg;

function box(selector: string) {
  const rule = background.match(new RegExp(`\\${selector} \\{([^}]*)\\}`))?.[1] ?? '';
  const px = (prop: string) => Number(rule.match(new RegExp(`(?:^|[\\s;])${prop}: (\\d+)px`))?.[1]);
  return { left: px('left'), top: px('top'), width: px('width'), height: px('height') };
}

test('the shortcut is an internet location that opens Privacy & Security at its Security section', () => {
  assert.ok(SHORTCUT_NAME.endsWith('.inetloc'), 'a .webloc with this URL is refused from a quarantined image');
  assert.equal(SETTINGS_URL, 'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Security');
  const plist = inetlocPlist(SETTINGS_URL);
  assert.match(plist, /<key>URL<\/key>\n\t<string>x-apple\.systempreferences:com\.apple\.settings\.PrivacySecurity\.extension\?Security<\/string>/);
  assert.match(inetlocPlist('a&b<c>'), /<string>a&amp;b&lt;c&gt;<\/string>/);
});

test('the shortcut sits on its tile, under the app, inside the part of the window that shows', () => {
  const tile = box('.tile');
  const slab = box('.slab');
  assert.equal(SHORTCUT_POSITION.x, dmg.appPosition.x, 'same column as the app');
  assert.equal(SHORTCUT_POSITION.x, tile.left + tile.width / 2, 'centred on the tile');
  assert.equal(SHORTCUT_POSITION.y - tile.top, dmg.appPosition.y - slab.top, 'placed on its tile the way the app sits on the slab');
  assert.equal(tile.height, 172);
  // The window height includes the title bar, which hides the bottom 28 points of the picture.
  assert.ok(tile.top + tile.height <= dmg.windowSize.height - 28, 'the whole tile is visible');
  assert.match(background, new RegExp(`height: ${dmg.windowSize.height}px`), 'the picture is the window size');
});
