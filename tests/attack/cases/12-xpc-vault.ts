// The Secure Enclave helper is an XPC service. The only client it should answer is the Phosphor
// shell. scripts/xpc-attack.sh is the repo's standing probe: the old loose door (a bare se-helper),
// a plain process, a stranger beside the shell (plus the shipped runtime held to the service's
// requirement), a foreign app hosting a byte-identical copy of the service, the same foreign app
// claiming Phosphor's identifier, and the shell itself. This case runs that probe against each
// build it has and fails on any FAIL line.
//
// The probe never changes the bundle it is given and never runs code from a changed copy of it, so
// a notarized build raises no "damaged" alert, and every caller runs under a time limit, so nothing
// on screen can hold it. Each refusal names who refused: the service, launchd, or macOS killing a
// caller whose code codesign rejects.
//
// On an ad-hoc build a requirement can only pin the identifier, so attacker #4 (a foreign app under
// com.karimbabasf.phosphor) gets an answer; the probe marks that "known", not a failure. On a
// Developer ID build the probe itself requires #4 refused. The all-four-refused form is therefore
// SIGNED-ONLY: with --app it runs against the Developer ID build too.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { ROOT, teamOf } from '../harness.ts';
import type { AttackCase, AttackCtx, AttackResult } from '../types.ts';

function runProbe(app: string): { status: number; out: string } {
  const r = spawnSync('/bin/sh', [path.join(ROOT, 'scripts', 'xpc-attack.sh'), app], { cwd: ROOT, encoding: 'utf8', timeout: 170_000 });
  return { status: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function verdict(label: string, probe: { status: number; out: string }, signed: boolean): { pass: boolean; line: string; short: string } {
  const lines = probe.out.split('\n');
  const fails = lines.filter(l => /^\s*FAIL\b/.test(l)).map(l => l.trim());
  const refused = lines.filter(l => /^\s*ok\b.*\bREFUSED\b/.test(l));
  const by = (re: RegExp): number => refused.filter(l => re.test(l)).length;
  const known = lines.some(l => /^\s*known\b/.test(l));
  const shell = lines.some(l => /^\s*ok\s+\{.*"ok":true/.test(l));
  // Plain process, the stranger beside the shell, the foreign app, and on Developer ID the foreign
  // app under Phosphor's identifier.
  const wanted = signed ? 4 : 3;
  const pass = probe.status === 0 && fails.length === 0 && refused.length >= wanted && shell && !(signed && known);
  const who = `${by(/by the service/)} by the service, ${by(/no service started/)} with no service started, ${by(/by macOS/)} by macOS`;
  let line = `${label} probe: exit ${probe.status}, ${refused.length} refused (${who}), shell answered ${shell}${known ? ', #4 known (ad-hoc limit)' : ''}, FAIL ${fails.length}`;
  if (fails.length > 0) line += ` [${fails.join('; ').slice(0, 200)}]`;
  return { pass, line, short: `${label} exit ${probe.status}, ${refused.length} REFUSED, ${fails.length} FAIL` };
}

export const attack: AttackCase = {
  id: '12-xpc-vault',
  title: 'the enclave XPC service answers only the Phosphor shell: every other caller is refused',
  needsBuiltApp: true,
  timeoutMs: 360_000,
  async run(ctx: AttackCtx): Promise<AttackResult> {
    const apps = [...new Set([ctx.builtApp, ctx.signedApp].filter((a): a is string => a !== null))];
    if (apps.length === 0) return { expected: '', observed: '', pass: true, evidence: '', skipped: 'no build' };

    let pass = true;
    let developerId = false;
    const parts: string[] = [];
    const shorts: string[] = [];
    for (const app of apps) {
      const team = teamOf(app);
      developerId ||= team !== null;
      const v = verdict(team ? `Developer ID (${team})` : 'ad-hoc', runProbe(app), team !== null);
      pass &&= v.pass;
      parts.push(v.line);
      shorts.push(v.short);
    }
    // SIGNED-ONLY: the all-four-refused form needs a Developer ID build, where the service pins
    // Apple's anchor and the team, so the foreign app under Phosphor's identifier (#4) is refused.
    if (!developerId) parts.push('all-four-refused (SIGNED-ONLY): skipped, no Developer ID build; #4 is the known ad-hoc limit');

    return {
      expected: 'no FAIL line from xpc-attack.sh: plain process, stranger beside the shell and foreign app refused, the shipped runtime fails the service requirement, the shell answers; on a Developer ID build #4 is refused too',
      observed: parts.join(' | '),
      pass,
      evidence: `sh scripts/xpc-attack.sh <app> -> ${shorts.join('; ')}`,
    };
  },
};

export default attack;
