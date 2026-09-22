// Adds the Open Anyway shortcut to the disk image Tauri built, before release-manifest.ts
// checksums it.
//
// The build is ad-hoc signed, not notarized, and since macOS 15 the first-open warning for such
// an app has no Open button at all: only Done and Move to Trash. The one way through is the Open
// Anyway button that appears in System Settings, Privacy & Security, after that warning, at the
// bottom of a long page most people never find. This file sits in the disk image window beside
// the app and opens Settings already scrolled to that button (verified 2026-09-22 on macOS 27:
// double-clicked inside a quarantined image, it lands on "was blocked to protect your Mac" with
// the button in view, and no warning of its own).
//
// Why an .inetloc: Finder refuses a .webloc whose URL is not http or https ("The document could
// not be opened") when it comes from a quarantined image, and opens the same URL from an
// .inetloc. A symlink to Security.prefPane also works, but lands at the top of the page, a
// scroll away from the button.
//
// Tauri's DMG settings have no way to add a file, so this reopens the image read-write, adds the
// shortcut with its icon (src-tauri/dmg/open-anyway.png) and its extension hidden, has Finder
// place it on the tile drawn in src-tauri/dmg/background.html, and compresses it back the way
// Tauri did. The pure parts are exported for tests/unit/dmg-open-anyway.test.ts. Run from CI as:
//   node scripts/dmg-open-anyway.ts src-tauri/target/<target>/release/bundle/dmg/Phosphor_<version>_aarch64.dmg

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SHORTCUT_NAME = 'Open Anyway.inetloc';
// Privacy & Security, scrolled to its Security section, where the Open Anyway row appears.
export const SETTINGS_URL = 'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Security';
// Finder places an icon by its centre, in points from the window's top left: under the app, on
// the tile in background.html.
export const SHORTCUT_POSITION = { x: 165, y: 406 };

const ICON = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri', 'dmg', 'open-anyway.png');

export function inetlocPlist(url: string): string {
  const escaped = url.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '\t<key>URL</key>',
    `\t<string>${escaped}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

function run(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// A custom icon lives in the file's resource fork and "hide extension" in its Finder info; both
// survive the image. NSWorkspace writes the icon at every size Finder asks for.
const DRESS = `
ObjC.import('AppKit');
function run(argv) {
  const image = $.NSImage.alloc.initWithContentsOfFile(argv[0]);
  if (image.isNil()) throw new Error('cannot read ' + argv[0]);
  if (!$.NSWorkspace.sharedWorkspace.setIconForFileOptions(image, argv[1], 0)) throw new Error('setIcon refused ' + argv[1]);
  const hidden = $.NSDictionary.dictionaryWithObjectForKey($.NSNumber.numberWithBool(true), $.NSFileExtensionHidden);
  if (!$.NSFileManager.defaultManager.setAttributesOfItemAtPathError(hidden, argv[1], null)) throw new Error('cannot hide the extension of ' + argv[1]);
}`;

// The same Finder session Tauri's own layout step runs; Finder writes the position into the
// image's .DS_Store when the window closes.
const PLACE = `
on run argv
  tell application "Finder"
    tell disk (item 1 of argv)
      open
      set position of item (item 2 of argv) of container window to {(item 3 of argv) as integer, (item 4 of argv) as integer}
      update without registering applications
      delay 1
      close
    end tell
  end tell
end run`;

function detach(device: string) {
  for (let attempt = 1; ; attempt++) {
    try {
      run('hdiutil', ['detach', device]);
      return;
    } catch (err) {
      if (attempt === 5) throw err;
      execFileSync('sleep', [String(attempt * 2)]);
    }
  }
}

function addShortcut(dmg: string) {
  // codesign reports on stderr either way, and exits 1 for an unsigned file.
  const signature = spawnSync('codesign', ['-dv', dmg], { encoding: 'utf8' }).stderr;
  if (!signature.includes('not signed at all')) {
    throw new Error(`${dmg} is signed; changing it would break the signature. A signed build is notarized and needs no shortcut: drop this step.`);
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-dmg-'));
  const rw = path.join(work, 'rw.dmg');
  run('hdiutil', ['convert', dmg, '-format', 'UDRW', '-ov', '-o', rw]);

  const attached = run('hdiutil', ['attach', rw, '-readwrite', '-noverify', '-noautoopen', '-nobrowse', '-mountrandom', '/Volumes']);
  const line = attached.split('\n').find((l) => l.includes('/Volumes/'));
  if (!line) throw new Error(`no mount point in:\n${attached}`);
  const device = line.split(/\s+/)[0];
  const mount = line.slice(line.indexOf('/Volumes/')).trim();
  try {
    const shortcut = path.join(mount, SHORTCUT_NAME);
    fs.writeFileSync(shortcut, inetlocPlist(SETTINGS_URL));
    run('osascript', ['-l', 'JavaScript', '-e', DRESS, ICON, shortcut]);

    const store = path.join(mount, '.DS_Store');
    const before = fs.statSync(store).mtimeMs;
    run('osascript', ['-e', PLACE, path.basename(mount), SHORTCUT_NAME, String(SHORTCUT_POSITION.x), String(SHORTCUT_POSITION.y)]);
    for (let waited = 0; fs.statSync(store).mtimeMs === before; waited++) {
      if (waited === 30) throw new Error('Finder never wrote the layout (.DS_Store unchanged after 30 s)');
      execFileSync('sleep', ['1']);
    }
    fs.rmSync(path.join(mount, '.fseventsd'), { recursive: true, force: true });
    run('sync', []);
  } finally {
    detach(device);
  }

  const out = path.join(work, 'out.dmg');
  run('hdiutil', ['convert', rw, '-format', 'UDZO', '-imagekey', 'zlib-level=9', '-ov', '-o', out]);
  fs.copyFileSync(out, dmg);
  fs.rmSync(work, { recursive: true, force: true });
}

// Reads the finished image back: the shortcut is there, points where it should, and wears its icon.
function check(dmg: string) {
  const attached = run('hdiutil', ['attach', dmg, '-readonly', '-noverify', '-noautoopen', '-nobrowse', '-mountrandom', '/tmp']);
  const line = attached.split('\n').find((l) => l.includes('/tmp/'));
  if (!line) throw new Error(`no mount point in:\n${attached}`);
  const device = line.split(/\s+/)[0];
  const mount = line.slice(line.indexOf('/tmp/')).trim();
  try {
    const shortcut = path.join(mount, SHORTCUT_NAME);
    const url = run('plutil', ['-extract', 'URL', 'raw', shortcut]).trim();
    if (url !== SETTINGS_URL) throw new Error(`shortcut points at ${url}`);
    if (!run('xattr', [shortcut]).includes('com.apple.ResourceFork')) throw new Error('shortcut has no icon');
  } finally {
    detach(device);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dmg = process.argv[2];
  if (!dmg || !fs.existsSync(dmg)) {
    console.error('usage: node scripts/dmg-open-anyway.ts <Phosphor_<version>_aarch64.dmg>');
    process.exit(2);
  }
  addShortcut(dmg);
  check(dmg);
  console.log(`dmg: ${SHORTCUT_NAME} added to ${path.basename(dmg)}, opening ${SETTINGS_URL}`);
}
