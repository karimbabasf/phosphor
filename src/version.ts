// One version, read from the one file that already declares it.
//
// Before this, package.json said 0.3.0 and src/mcp.ts said '0.3.0' in a string literal, so a
// release bumped one and forgot the other, and the number an agent was told did not have to
// match the number the app was. The greeting prints this on connect, which makes a stale
// literal something a human reads rather than something buried in a handshake.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function read(): string {
  try {
    const raw = readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : 'unknown';
  } catch {
    // A missing or unparseable package.json must not stop the app booting. The version is
    // presentation, and 'unknown' is an honest answer where a hardcoded guess is not.
    return 'unknown';
  }
}

export const VERSION = read();
