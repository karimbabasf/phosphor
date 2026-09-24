// This checkout's lockdown file, copied outside it, for tests that spawn a stand-in agent.
//
// The app tests/injection.test.ts boots sweeps every process whose argv names THIS checkout's
// operator/driver.settings.json beside the stream flags (src/driver.ts sweepOrphans, run from
// src/main.ts at boot), because on a real machine such a process is an agent a previous run left
// behind. A stand-in a driver test spawned at that moment carries the same argv and was killed as
// one, so the test waited for an answer that never came. A copy elsewhere is the same lockdown
// under a path no sweep of this checkout matches.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

export function lockdownCopy(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-lockdown-'));
  const copy = path.join(dir, 'driver.settings.json');
  fs.copyFileSync(path.join(ROOT, 'operator', 'driver.settings.json'), copy);
  return copy;
}
