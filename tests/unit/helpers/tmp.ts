// Every temp directory a test makes comes from here, and the test file's process removes them all
// when it exits, so a run leaves nothing behind in $TMPDIR (scripts/run-tests.ts checks).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const made: string[] = [];

process.on('exit', () => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

export function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}
