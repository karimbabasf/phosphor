// The vault service refuses a peer that fails its code signing requirement. Two ad-hoc bundles are
// built here, each carrying the service compiled from src-tauri/se-helper/main.swift exactly as the
// build script compiles it, and each running a host made from the shell's own XPC client
// (src-tauri/src/xpc_bridge.c): one bundle is named com.karimbabasf.phosphor and must be answered,
// the other is a foreign app and must be refused. A refusal only counts when the control in the
// same run was answered, so a Mac that cannot launch a bundled service at all skips, never passes.
// The Developer ID half (Apple's anchor, the Developer ID OIDs, the team) is held by
// scripts/xpc-attack.sh against a signed build, attacker 4.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { developerTools } from './helpers/no-dialog.ts';
import { tempDir } from './helpers/tmp.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const work = tempDir('phosphor-peer-check-');
const env = { ...process.env, TMPDIR: work };
// `which` finds the /usr/bin stubs even with no developer tools, and running one then offers to
// install them in a dialog: xcode-select is asked first. The service here is the real one, with no
// stand-in, so the host asks it for a probe and nothing else (tests/unit/no-dialog.test.ts).
const tools = developerTools() && ['swiftc', 'clang', 'codesign'].every((t) => spawnSync('/usr/bin/which', [t], { env }).status === 0);

function run(cmd: string, args: string[]): void {
  const r = spawnSync(cmd, args, { encoding: 'utf8', env });
  assert.equal(r.status, 0, `${cmd} ${args.join(' ')}: ${r.stderr}`);
}

/* An ad-hoc app named `identifier`, holding the service and a host that asks it for a probe. */
function app(identifier: string, service: string, host: string): string {
  const dir = path.join(work, `${identifier}.app`);
  const xpc = path.join(dir, 'Contents/XPCServices/com.karimbabasf.phosphor.vault.xpc');
  fs.mkdirSync(path.join(xpc, 'Contents/MacOS'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'Contents/MacOS'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'src-tauri/se-helper/XPCService-Info.plist'), path.join(xpc, 'Contents/Info.plist'));
  fs.copyFileSync(service, path.join(xpc, 'Contents/MacOS/se-helper'));
  fs.copyFileSync(host, path.join(dir, 'Contents/MacOS/host'));
  fs.chmodSync(path.join(xpc, 'Contents/MacOS/se-helper'), 0o755);
  fs.chmodSync(path.join(dir, 'Contents/MacOS/host'), 0o755);
  fs.writeFileSync(path.join(dir, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${identifier}</string>
<key>CFBundleExecutable</key><string>host</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`);
  run('codesign', ['-s', '-', '-f', '--options', 'runtime', xpc]);
  run('codesign', ['-s', '-', '-f', '--options', 'runtime', dir]);
  return path.join(dir, 'Contents/MacOS/host');
}

test('a peer that fails the service requirement is refused, and the Phosphor shell is answered', { skip: tools ? false : 'needs macOS with swiftc, clang and codesign' }, (t) => {
  const service = path.join(work, 'se-helper');
  run('swiftc', ['-O', '-module-name', 'se_helper', '-module-cache-path', path.join(work, 'mc'), '-o', service, path.join(ROOT, 'src-tauri/se-helper/main.swift')]);
  const source = path.join(work, 'host.c');
  fs.writeFileSync(source, `#include <stdio.h>
#include <stdlib.h>
char *phosphor_xpc_call(const char *service, const char *request, double timeout_secs, const char **error);
int main(void) {
    const char *error = NULL;
    char *answer = phosphor_xpc_call("com.karimbabasf.phosphor.vault", "{\\"op\\":\\"probe\\"}", 10, &error);
    if (answer) { printf("ANSWERED %s\\n", answer); free(answer); return 0; }
    printf("REFUSED %s\\n", error);
    return 1;
}
`);
  const host = path.join(work, 'host');
  run('clang', ['-fblocks', '-O2', '-o', host, source, path.join(ROOT, 'src-tauri/src/xpc_bridge.c'), path.join(ROOT, 'src-tauri/src/codesign.c'), '-framework', 'Security', '-framework', 'CoreFoundation']);

  const ask = (exe: string): string => {
    const r = spawnSync(exe, [], { encoding: 'utf8', env, timeout: 30_000 });
    return `${r.stdout ?? ''}`.trim() || `exit ${r.status} ${r.signal ?? ''}`;
  };
  const shell = ask(app('com.karimbabasf.phosphor', service, host));
  if (!shell.startsWith('ANSWERED')) {
    t.skip(`this Mac launched no bundled service for the control (${shell}), so a refusal would prove nothing`);
    return;
  }
  assert.match(shell, /^ANSWERED \{.*"ok":true/, 'the app named com.karimbabasf.phosphor is answered');
  const foreign = ask(app('com.example.foreign', service, host));
  assert.match(foreign, /^REFUSED helper_(unverified|unreachable)$/, `the foreign app is refused: ${foreign}`);
});
