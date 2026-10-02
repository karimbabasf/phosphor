// The Secure Enclave helper is an XPC service. The only client it should answer is the Phosphor
// shell. scripts/xpc-attack.sh is the repo's standing probe: the old loose door (a bare se-helper),
// a plain process, a stranger living inside a copy of the real bundle, a foreign app hosting a
// byte-identical copy of the service, the same foreign app claiming Phosphor's identifier, and the
// shell itself. This case runs that probe against the built bundle and fails on any FAIL line.
//
// On an ad-hoc build a requirement can only pin the identifier, so attacker #4 (a foreign app under
// com.karimbabasf.phosphor) gets an answer; the script marks that "known", not a failure, because a
// Developer ID signature pins Apple's anchor and the team as well. The all-four-refused check is
// therefore SIGNED-ONLY: with --app it reruns against the Developer ID build and requires #4 to be
// refused too.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { ROOT } from '../harness.ts';
import type { AttackCase, AttackCtx, AttackResult } from '../types.ts';

function runProbe(app: string): { status: number; out: string } {
  const r = spawnSync('/bin/sh', [path.join(ROOT, 'scripts', 'xpc-attack.sh'), app], { cwd: ROOT, encoding: 'utf8', timeout: 90_000 });
  return { status: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

export const attack: AttackCase = {
  id: '12-xpc-vault',
  title: 'the enclave XPC service answers only the Phosphor shell: every other caller is refused',
  needsBuiltApp: true,
  timeoutMs: 180_000,
  async run(ctx: AttackCtx): Promise<AttackResult> {
    const app = ctx.builtApp ?? ctx.signedApp;
    if (!app) return { expected: '', observed: '', pass: true, evidence: '', skipped: 'no build' };

    const adhoc = runProbe(app);
    const failLines = adhoc.out.split('\n').filter(l => /\bFAIL\b/.test(l));
    const okCount = (adhoc.out.match(/\bok\b/g) ?? []).length;
    let pass = adhoc.status === 0 && failLines.length === 0;
    const parts = [`ad-hoc probe: exit ${adhoc.status}, ok lines ${okCount}, FAIL lines ${failLines.length}`];
    if (failLines.length > 0) parts.push(`FAIL: ${failLines.map(l => l.trim()).join('; ').slice(0, 160)}`);

    // SIGNED-ONLY: the all-four-refused form. Developer ID lets the service pin the team, so the
    // foreign app under Phosphor's identifier (#4) is refused too: no "known" line survives.
    if (ctx.signedApp) {
      const signed = runProbe(ctx.signedApp);
      const signedFails = signed.out.split('\n').filter(l => /\bFAIL\b/.test(l));
      const fourRefused = !/\bknown\b/.test(signed.out) && !/ANSWERED/.test(signed.out);
      parts.push(`signed probe: exit ${signed.status}, FAIL ${signedFails.length}, all four refused: ${fourRefused}`);
      pass &&= signed.status === 0 && signedFails.length === 0 && fourRefused;
    } else {
      parts.push('all-four-refused (SIGNED-ONLY): skipped, no --app; #4 is the known ad-hoc limit');
    }

    return {
      expected: 'no FAIL line from xpc-attack.sh (plain process, in-bundle stranger, foreign app refused; shell answers); with --app, #4 refused too',
      observed: parts.join(' | '),
      pass,
      evidence: `sh scripts/xpc-attack.sh -> exit ${adhoc.status}, ${failLines.length} FAIL lines`,
    };
  },
};

export default attack;
