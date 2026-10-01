// The shell's session_watch (src-tauri/src/session_watch.m / .rs) observes the system notification
// macOS posts when the screen locks (com.apple.screenIsLocked) and asks the backend for its when-idle
// lock. This proves the wiring end to end: another process posts that distributed notification (the
// same osascript route the runtime team used), and the running shell reacts and posts the lock to its
// backend, which it logs. The lock's effect on an open wallet and a pending move is case
// 10-screen-lock-backend; the user-switch arm fires on an in-process NSWorkspace notification that
// cannot be posted from outside and is covered by the Rust test session_watch carries.

import { spawnSync } from 'node:child_process';
import { launchShell, sleep } from '../harness.ts';
import type { AttackCase, AttackCtx, AttackResult } from '../types.ts';

const POST_SCREEN_LOCK = [
  "ObjC.import('Foundation');",
  "$.NSDistributedNotificationCenter.defaultCenter.postNotificationNameObjectUserInfoDeliverImmediately('com.apple.screenIsLocked', $(), $(), true);",
].join('\n');

export const attack: AttackCase = {
  id: '10-screen-lock-shell',
  title: 'the shell reacts to a com.apple.screenIsLocked notification by asking its backend to lock',
  needsBuiltApp: true,
  timeoutMs: 90_000,
  async run(ctx: AttackCtx): Promise<AttackResult> {
    const app = ctx.signedApp ?? ctx.builtApp;
    if (!app) return { expected: '', observed: '', pass: true, evidence: '', skipped: 'no build' };

    const shell = await launchShell({ app, bootTimeoutMs: 20_000 });
    try {
      // Let session_watch arm after the backend answers.
      await sleep(1500);
      const r = spawnSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', POST_SCREEN_LOCK], { encoding: 'utf8' });
      const posted = r.status === 0;
      // The shell logs "<reason>, so the wallet was asked to lock: <answer>" when it posts the lock.
      let sawLock = false;
      for (let i = 0; i < 20 && !sawLock; i++) {
        if (/the screen locked, so the wallet was asked to lock/.test(shell.output())) sawLock = true;
        else await sleep(300);
      }
      const pass = posted && sawLock;
      return {
        expected: 'the shell receives the screen-lock notification and asks the backend to lock',
        observed: `osascript posted=${posted}; shell logged the lock=${sawLock}`,
        pass,
        evidence: sawLock ? `shell stderr: "...the screen locked, so the wallet was asked to lock..."` : `no lock line in shell output (posted=${posted})`,
      };
    } finally {
      await shell.stop();
    }
  },
};

export default attack;
