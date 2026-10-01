// The Freeze switch, as the window's Freeze and Unfreeze reach it (POST /api/kill).
//
// THE RUNNER IS TOLD BEFORE THE FILE IS READ. The switch used to be written to policy.json and
// only then passed to the runner, and a policy file that would not load returned before either:
// the route still answered ok, the audit log said KILL SWITCH ON, and an armed plan kept firing.
// A file that will not load already refuses every move (the engine reads it as
// policy_unreadable), so the runner is the part of a freeze that such a file cannot do, and it is
// never skipped. Unfreeze is the other way round: with no file to write the switch into, nothing
// is unfrozen and the runner keeps its brake.

import type { Audit } from './audit.ts';
import type { PlanRunner } from './runner/host.ts';
import { loadPolicy, savePolicy } from './policy/file.ts';

export type KillAnswer =
  | { ok: true; killSwitch: boolean }
  // killSwitch is what binds after the press: an unreadable file refuses every move, and a file
  // that would not take the write still says what it said before.
  | { ok: false; killSwitch: boolean; code: 'policy_unreadable' | 'policy_unsaved'; error: string };

export const FREEZE_UNREADABLE = 'Every plan is stopped, and every move stays refused while the policy file cannot be read; freeze again once it is fixed.';
export const FREEZE_UNSAVED = 'Every plan is stopped, but the switch could not be saved and new moves are not refused yet; freeze again.';
export const UNFREEZE_UNREADABLE = 'The policy file cannot be read, so everything stays frozen until it is fixed.';
export const UNFREEZE_UNSAVED = 'The switch could not be saved, so everything stays frozen; try again.';

export type KillDeps = {
  dataDir: string;
  audit: Pick<Audit, 'append' | 'flushTip'>;
  runner: Pick<PlanRunner, 'setKilled' | 'stopAll'>;
};

export function createKill(deps: KillDeps): (on: boolean) => KillAnswer {
  function write(on: boolean): KillAnswer {
    const policy = loadPolicy(deps.dataDir);
    if (policy === null) {
      deps.audit.append('error', on ? 'the kill switch was not saved: the policy file is unreadable, so every write is refused anyway' : 'unfreeze refused: the policy file is unreadable');
      return { ok: false, killSwitch: true, code: 'policy_unreadable', error: on ? FREEZE_UNREADABLE : UNFREEZE_UNREADABLE };
    }
    try {
      savePolicy(deps.dataDir, { ...policy, killSwitch: on });
    } catch (err) {
      deps.audit.append('error', `the kill switch was not saved: ${err instanceof Error ? err.message : String(err)}`);
      return { ok: false, killSwitch: policy.killSwitch, code: 'policy_unsaved', error: on ? FREEZE_UNSAVED : UNFREEZE_UNSAVED };
    }
    deps.audit.append('kill_switch', on ? 'kill switch ON: all writes refused' : 'kill switch off');
    return { ok: true, killSwitch: on };
  }

  return (on) => {
    if (!on) {
      const answer = write(false);
      // Released only once the file says so: a runner unfrozen over a file that still reads ON
      // (or reads nothing) would fire plans the engine refuses to arm.
      if (answer.ok) deps.runner.setKilled(false);
      deps.audit.flushTip();
      return answer;
    }
    /* Stop what is already running, not just what tries to start next. setKilled stops any fire
       from now on, before anything here can throw; stopAll cancels every resting order, closes
       every position it can reach and takes the child out. stopAll runs after the write because
       its last step reads the switch back from the file (an unreadable one reads as ON). */
    deps.runner.setKilled(true);
    try {
      return write(true);
    } finally {
      /* Anchored now rather than on the next tick of the timer. This is the line somebody goes
         looking for straight after pulling the switch, and what usually follows a kill switch is
         somebody stopping the app in a hurry. */
      deps.audit.flushTip();
      void deps.runner.stopAll('kill switch');
    }
  };
}
