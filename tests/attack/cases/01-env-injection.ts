// The process that holds the key is the node backend. The shell builds that process's environment
// from an allowlist (src-tauri/src/backend.rs BACKEND_ENV), not from its own, so a name that would
// run foreign code inside it (NODE_OPTIONS --require/--import/--inspect, the DYLD_ family, NODE_PATH,
// NODE_EXTRA_CA_CERTS, OPENSSL_CONF) never reaches the backend even when it is set in the shell's own
// environment, where launchctl setenv or a parent could plant it. This launches the shell with all of
// them set, plus a planted NODE_PATH module tree, and reads the real backend's environment back.

import fs from 'node:fs';
import path from 'node:path';
import { launchShell } from '../harness.ts';
import type { AttackCase, AttackCtx, AttackResult } from '../types.ts';

const HOSTILE_NAMES = ['NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'OPENSSL_CONF', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'DYLD_FRAMEWORK_PATH'];

export const attack: AttackCase = {
  id: '01-env-injection',
  title: 'the backend never inherits NODE_OPTIONS, NODE_PATH, NODE_EXTRA_CA_CERTS, OPENSSL_CONF or DYLD_* from the shell',
  needsBuiltApp: true,
  timeoutMs: 90_000,
  async run(ctx: AttackCtx): Promise<AttackResult> {
    const app = ctx.signedApp ?? ctx.builtApp;
    if (!app) return { expected: '', observed: '', pass: true, evidence: '', skipped: 'no build' };

    // A planted module tree the attacker hopes NODE_PATH will add to the backend's resolution.
    const planted = path.join(ctx.scratch, 'evil_modules');
    fs.mkdirSync(path.join(planted, 'evil'), { recursive: true });
    fs.writeFileSync(path.join(planted, 'evil', 'index.js'), 'process.exit(99);\n');
    fs.writeFileSync(path.join(planted, 'evil', 'package.json'), '{"name":"evil","main":"index.js"}\n');

    const hostileEnv: Record<string, string> = {
      NODE_OPTIONS: `--require ${path.join(ctx.scratch, 'evil.js')}`,
      NODE_PATH: planted,
      NODE_EXTRA_CA_CERTS: path.join(ctx.scratch, 'evil.pem'),
      OPENSSL_CONF: path.join(ctx.scratch, 'evil.cnf'),
      DYLD_INSERT_LIBRARIES: path.join(ctx.scratch, 'evil.dylib'),
      DYLD_LIBRARY_PATH: planted,
      DYLD_FRAMEWORK_PATH: planted,
    };

    const shell = await launchShell({ app, env: hostileEnv, bootTimeoutMs: 20_000 });
    try {
      const pids = shell.sidecarPids();
      if (pids.length === 0) throw new Error('no backend spawned to inspect');
      const pid = pids[0] as number;
      const raw = shell.sidecarEnvRaw(pid);
      const leaked = HOSTILE_NAMES.filter(name => new RegExp(`(^|\\s)${name}=`).test(raw));
      // Belt: no DYLD_ name of any kind.
      const anyDyld = /(^|\s)DYLD_[A-Z_]+=/.test(raw);
      const alive = shell.sidecarCmdline(pid).includes('--disable-sigusr1');
      const pass = leaked.length === 0 && !anyDyld && alive;
      return {
        expected: 'the backend process carries none of the hostile env names; it is the real sidecar (alive, flagged)',
        observed: `leaked into backend: ${leaked.length === 0 && !anyDyld ? 'none' : [...leaked, anyDyld ? 'DYLD_*' : ''].filter(Boolean).join(', ')}; backend alive=${alive}`,
        pass,
        evidence: `ps eww on backend pid ${pid}: ${HOSTILE_NAMES.join(',')} all absent=${leaked.length === 0 && !anyDyld}`,
      };
    } finally {
      await shell.stop();
    }
  },
};

export default attack;
