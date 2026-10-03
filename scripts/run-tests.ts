// npm test: node --test over the files named on the command line, inside a temp folder of the
// run's own. TMPDIR points there for every test file and every process a test starts, so the
// check after the run sees exactly what the run made: anything left in the folder fails the run
// by name. The folder is removed either way, so a run never adds to $TMPDIR.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Node's own module compile cache, which it keeps in the temp folder on purpose.
const NOT_FROM_TESTS = new Set(['node-compile-cache']);

const run = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-run-'));
// Ctrl-C reaches node --test as well; this process waits for it, then cleans up.
process.on('SIGINT', () => undefined);
process.on('SIGTERM', () => undefined);
const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, TMPDIR: run } });
const left = fs.readdirSync(run).filter((name) => !NOT_FROM_TESTS.has(name)).sort();
fs.rmSync(run, { recursive: true, force: true });

if (left.length > 0) {
  console.error(`temp check: FAIL, the run left ${left.length} in its temp folder (each test removes what it makes, tests/unit/helpers/tmp.ts):`);
  for (const name of left) console.error(`  ${name}`);
  process.exit(1);
}
console.log('temp check: pass, the run left nothing in its temp folder');
process.exit(result.status ?? 1);
