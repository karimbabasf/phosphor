// A module may only ever be loaded from inside the digested payload.
//
// The shell checks every file in the payload against the digest it was built with (payload.rs) and
// starts nothing that does not match. But Node's own module resolution walks OUT of the payload for
// a bare specifier it cannot find inside: up through Contents/Resources/node_modules,
// Contents/node_modules, Phosphor.app/node_modules, /Applications/node_modules (admin-writable) and
// $HOME/.node_modules. Nothing the app ships loads from there today (audit 2026-10-01, L14 traced
// zero), but the shipped tree has optional requires of absent packages (debug's supports-color,
// ws's bufferutil and utf-8-validate, and more), and one dependency update or lazy path would pull
// a file the digest never covered, run as this app, with its keys.
//
// So a resolve hook refuses any module that RESOLVES to a file outside the payload root. It leaves a
// genuinely absent optional package to fail as it always did (nextResolve throws, and the caller's
// try/catch sees the usual not-found); it only turns away a module that was FOUND outside. Node
// built-ins (the node: scheme) and anything that is not a file are allowed through untouched.

import fs from 'node:fs';
import module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Node resolves module URLs through their real path (symlinks followed), so the root is compared in
// the same form: on macOS the payload under /var is really under /private/var, and a root left in
// the /var form would call every real resolution outside itself.
function realOf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

// Lets `path` resolve backwards whether the caller handed a url or a path.
function pathOf(url: string): string | null {
  if (url.startsWith('file://')) {
    try {
      return fileURLToPath(url);
    } catch {
      return null;
    }
  }
  // Older CommonJS resolutions can come back as a bare absolute path rather than a URL.
  if (path.isAbsolute(url)) return url;
  return null;
}

/// True when `url` (a resolved specifier) names a file outside the payload root. A non-file
/// resolution (a node: builtin, a data: url) is never outside: there is no file to escape with.
export function outsidePayload(root: string, url: string): boolean {
  const resolved = pathOf(url);
  if (resolved === null) return false;
  const real = realOf(root);
  const base = real.endsWith(path.sep) ? real : real + path.sep;
  return resolved !== real && !resolved.startsWith(base);
}

/// Registers the resolve hook for `root` and returns the handle that removes it again. Called once
/// at boot (src/boot-guard.ts) with the payload root; returns the handle so a test can undo it.
export function installResolveGuard(root: string): { deregister: () => void } {
  return module.registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context);
      if (outsidePayload(root, String(resolved.url))) {
        throw new Error(
          `Phosphor refused to load "${specifier}" from outside its files. A module that is not part of ` +
            'the installed app is never run. Reinstall from phosphor.money if this persists.',
        );
      }
      return resolved;
    },
  });
}
