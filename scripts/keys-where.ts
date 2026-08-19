// Answers "where is my private key?" without printing a byte of it. Loads config the same way
// the app does, then reports the resolved path, whether it exists, its permissions, and whether
// it is the per-project location or the legacy global one. Run with: npm run keys:where

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';

const cfg = loadConfig(process.cwd());
const p = cfg.keysPath;
const home = os.homedir();

let exists = false;
let mode = '';
try {
  const st = fs.statSync(p);
  exists = true;
  mode = '0' + (st.mode & 0o777).toString(8);
} catch {
  exists = false;
}

const legacy = `${home}/.phosphor/keys.json`;
const kind = p === legacy ? 'legacy global (~/.phosphor/keys.json)' : 'project-local';

process.stdout.write(
  [
    `key path:   ${p}`,
    `exists:     ${exists}${exists ? `  (mode ${mode}${mode === '0600' ? '' : ', expected 0600'})` : '  (no key file here yet; keygen would create it here)'}`,
    `location:   ${kind}`,
    `override:   set PHOSPHOR_KEYS or keysPath in config.local.json to move it`,
    exists && kind.startsWith('legacy')
      ? `\nto make it project-local: create ~/.phosphor/${path.basename(process.cwd())}/, copy keys.json there (chmod 700 the dir, 600 the file), verify byte-equal, then remove the global copy.`
      : '',
  ]
    .filter(Boolean)
    .join('\n') + '\n',
);
