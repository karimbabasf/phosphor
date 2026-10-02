// The shell's session_watch (src-tauri/src/session_watch.m / .rs) observes the system notification
// macOS posts when the screen locks (com.apple.screenIsLocked) and asks the backend for its when-idle
// lock. This proves the wiring end to end: another process posts a distributed notification (the
// same osascript route the runtime team used), and the running shell reacts and posts the lock to its
// backend, which it logs. The lock's effect on an open wallet and a pending move is case
// 10-screen-lock-backend; the user-switch arm fires on an in-process NSWorkspace notification that
// cannot be posted from outside and is covered by the Rust test session_watch carries.
//
// By default it posts the shell's own name for the signal, addressed to that one shell by its pid
// (screen_locked_here), so no other app on the Mac hears it. The system's name reaches every app in
// the login session (password managers lock, chat apps go away), so it is posted only with
// `-- --real-screen-lock`, followed by com.apple.screenIsUnlocked, and the row's title says which
// one ran. A shell built before it heard its own name is a skip that says how to run the real one.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { launchShell, sleep } from '../harness.ts';
import type { AttackCase, AttackCtx, AttackResult } from '../types.ts';

const REAL = process.argv.includes('--real-screen-lock');
const SYSTEM = 'com.apple.screenIsLocked';
const ADDRESSED = 'com.karimbabasf.phosphor.test.screenIsLocked.';

function post(name: string): boolean {
  const script = `ObjC.import('Foundation'); $.NSDistributedNotificationCenter.defaultCenter.postNotificationNameObjectUserInfoDeliverImmediately(${JSON.stringify(name)}, $(), $(), true);`;
  return spawnSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { encoding: 'utf8' }).status === 0;
}

export const attack: AttackCase = {
  id: '10-screen-lock-shell',
  title: REAL
    ? `the shell asks its backend to lock on ${SYSTEM}, posted to every app on this Mac (--real-screen-lock)`
    : 'the shell asks its backend to lock on a screen-lock notification addressed to it alone',
  needsBuiltApp: true,
  timeoutMs: 90_000,
  async run(ctx: AttackCtx): Promise<AttackResult> {
    const app = ctx.signedApp ?? ctx.builtApp;
    if (!app) return { expected: '', observed: '', pass: true, evidence: '', skipped: 'no build' };
    if (!REAL && !fs.readFileSync(path.join(app, 'Contents', 'MacOS', 'phosphor-desktop')).includes(ADDRESSED)) {
      return {
        expected: '',
        observed: '',
        pass: true,
        evidence: '',
        skipped: `this shell hears only ${SYSTEM}, which every app on this Mac would get too; -- --real-screen-lock posts it`,
      };
    }

    const shell = await launchShell({ app, bootTimeoutMs: 20_000 });
    const name = REAL ? SYSTEM : `${ADDRESSED}${shell.shellPid}`;
    try {
      // Let session_watch arm after the backend answers.
      await sleep(1500);
      const posted = post(name);
      // The shell logs "<reason>, so the wallet was asked to lock: <answer>" when it posts the lock.
      let sawLock = false;
      for (let i = 0; i < 20 && !sawLock; i++) {
        if (/the screen locked, so the wallet was asked to lock/.test(shell.output())) sawLock = true;
        else await sleep(300);
      }
      const pass = posted && sawLock;
      return {
        expected: 'the shell receives the screen-lock notification and asks the backend to lock',
        observed: `posted ${name}=${posted}; shell logged the lock=${sawLock}`,
        pass,
        evidence: sawLock ? `osascript posted ${name}; shell stderr: "...the screen locked, so the wallet was asked to lock..."` : `no lock line in shell output (posted ${name}=${posted})`,
      };
    } finally {
      if (REAL) post('com.apple.screenIsUnlocked');
      await shell.stop();
    }
  },
};

export default attack;
