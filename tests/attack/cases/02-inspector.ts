// Node opens its inspector on 127.0.0.1:9229 when it gets SIGUSR1: no password, and the inspector
// evaluates code inside the process that holds the key. The shell starts the backend with
// --disable-sigusr1 (src-tauri/src/backend.rs NODE_FLAGS), so the signal opens nothing. There is no
// other route in: --inspect would come through NODE_OPTIONS, which case 01 proves the backend never
// inherits. This launches the real shell, sends SIGUSR1 to the backend, and checks no debug port
// opens and the process carries on.

import { spawnSync } from 'node:child_process';
import { launchShell, sleep } from '../harness.ts';
import type { AttackCase, AttackCtx, AttackResult } from '../types.ts';

function listensOn9229(pid: number): boolean {
  const r = spawnSync('/usr/sbin/lsof', ['-nP', '-iTCP:9229', '-sTCP:LISTEN', '-a', '-p', String(pid)], { encoding: 'utf8' });
  return (r.stdout ?? '').trim().length > 0;
}

export const attack: AttackCase = {
  id: '02-inspector',
  title: 'SIGUSR1 to the backend opens no inspector port, and there is no other route to --inspect',
  needsBuiltApp: true,
  timeoutMs: 90_000,
  async run(ctx: AttackCtx): Promise<AttackResult> {
    const app = ctx.signedApp ?? ctx.builtApp;
    if (!app) return { expected: '', observed: '', pass: true, evidence: '', skipped: 'no build' };

    const shell = await launchShell({ app, bootTimeoutMs: 20_000 });
    try {
      const pids = shell.sidecarPids();
      if (pids.length === 0) throw new Error('no backend spawned to inspect');
      const pid = pids[0] as number;
      const cmdline = shell.sidecarCmdline(pid);
      const flagged = /--disable-sigusr1/.test(cmdline);

      const before = listensOn9229(pid);
      // The attack: any local process can send this signal.
      process.kill(pid, 'SIGUSR1');
      await sleep(1500);
      const after = listensOn9229(pid);

      // The process must carry on (SIGUSR1 did not crash it).
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }

      const pass = flagged && !before && !after && alive;
      return {
        expected: '--disable-sigusr1 on the backend; SIGUSR1 opens no listener on 127.0.0.1:9229; the process stays up',
        observed: `flag present=${flagged}; :9229 before=${before} after SIGUSR1=${after}; backend alive=${alive}`,
        pass,
        evidence: `kill -USR1 ${pid} -> lsof :9229 (pid ${pid}) listening=${after}; cmdline has --disable-sigusr1=${flagged}`,
      };
    } finally {
      await shell.stop();
    }
  },
};

export default attack;
