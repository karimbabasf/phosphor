// npm test never opens a dialog on the Mac that runs it. The two things in the suite that could,
// and the guard for each (tests/unit/no-dialog.test.ts holds both, and lists what else was checked):
//
// - THE VAULT SERVICE'S presence. Built with PHOSPHOR_TESTSEAM the service reaches the keychain and
//   the enclave only through the stand-in (tests/swift/VaultTestPlatform.swift, which links no
//   LocalAuthentication): create, unwrap (every reveal and every approval is one), commit, sweep and
//   status ask nobody, and probe only asks LocalAuthentication whether it could evaluate, which shows
//   nothing. presence calls evaluatePolicy itself, outside the seam, so it puts a real Touch ID dialog
//   in front of whoever runs the tests. Every runner of the service refuses it, loudly; a test that
//   needs it answers it in its relay hook (tests/unit/helpers/vault-double.ts).
// - A COMPILER STUB. On a Mac with no developer tools (or a developer folder a macOS update removed),
//   cc, clang and swiftc in /usr/bin offer to install the tools in a system dialog the moment they
//   run, even for --version. So a test asks xcode-select first, which only prints a path or an error.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

/* The service ops that open a dialog when they run. */
export const DIALOG_OPS: ReadonlySet<string> = new Set(['presence']);

export function refuseDialog(request: Record<string, unknown>): void {
  if (typeof request.op === 'string' && DIALOG_OPS.has(request.op)) {
    throw new Error(`${request.op} would open a real Touch ID dialog on this Mac: a test answers it itself, in its relay hook`);
  }
}

/* Whether a compiler can run here without offering to install one. */
export function developerTools(): boolean {
  if (process.platform !== 'darwin') return false;
  const asked = spawnSync('/usr/bin/xcode-select', ['-p'], { encoding: 'utf8' });
  const dir = typeof asked.stdout === 'string' ? asked.stdout.trim() : '';
  return asked.status === 0 && dir !== '' && fs.existsSync(dir);
}
