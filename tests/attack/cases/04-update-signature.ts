// The updater (src-tauri/src/update.rs check_signature) will not install an update whose code
// signature does not satisfy a fixed requirement: this app's identifier, Apple's anchor, a Developer
// ID certificate, and the Phosphor team (OU 35Z6P26CBD). An attacker's build is ad-hoc signed, or
// signed by another team; either fails that requirement, so the update is refused before anything is
// replaced.
//
// The full install path (minisign over the artifact, then check_signature, then swap) needs a dev
// build pointed at a local update server, which this suite does not wire. The deepest seam that runs
// against the built app is the requirement itself: check_signature parses exactly this string into a
// SecRequirement and evaluates it with the Security framework, which is what `codesign -R` does. So
// this asserts the built ad-hoc bundle is refused by that requirement (an attacker's would be too),
// and, with --app, that a real Developer ID build passes it.

import { spawnSync } from 'node:child_process';
import type { AttackCase, AttackCtx, AttackResult } from '../types.ts';

// Verbatim from update.rs requirement(TEAMS) (asserted in its own tests).
const REQUIREMENT =
  'identifier "com.karimbabasf.phosphor" and anchor apple generic ' +
  'and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ ' +
  'and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ ' +
  'and (certificate leaf[subject.OU] = "35Z6P26CBD")';

function meets(app: string): { ok: boolean; out: string } {
  const r = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', `-R=${REQUIREMENT}`, app], { encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}`.trim() };
}

export const attack: AttackCase = {
  id: '04-update-signature',
  title: 'the updater requirement refuses an ad-hoc or other-team bundle, and only a Phosphor-team Developer ID build passes',
  needsBuiltApp: true,
  async run(ctx: AttackCtx): Promise<AttackResult> {
    const adhoc = ctx.builtApp;
    if (!adhoc) {
      return { expected: '', observed: '', pass: true, evidence: '', skipped: 'no ad-hoc build' };
    }
    // The attacker's bundle: ad-hoc (or another team). It must NOT satisfy the requirement.
    const attacker = meets(adhoc);
    let pass = attacker.ok === false;
    const parts = [`ad-hoc build: ${attacker.ok ? 'ACCEPTED (hole)' : 'refused'} (${attacker.out.slice(0, 60)})`];

    // Sanity: the ad-hoc bundle IS validly signed, so "refused" is about the team, not a broken seal.
    const sealed = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', adhoc], { encoding: 'utf8' });
    parts.push(`ad-hoc seal intact: ${sealed.status === 0}`);
    pass &&= sealed.status === 0;

    // SIGNED-ONLY: a real Developer ID build of the same team must satisfy it.
    if (ctx.signedApp) {
      const good = meets(ctx.signedApp);
      parts.push(`Developer ID build: ${good.ok ? 'passes' : 'FAILS (' + good.out.slice(0, 60) + ')'}`);
      pass &&= good.ok;
    } else {
      parts.push('Developer ID positive case: skipped (no --app)');
    }

    return {
      expected: 'ad-hoc/other-team bundle fails the updater requirement; a Phosphor Developer ID build passes it',
      observed: parts.join(' | '),
      pass,
      evidence: `codesign --verify -R "<update requirement>" ad-hoc -> ${attacker.ok ? 'exit 0' : 'non-zero (refused)'}${ctx.signedApp ? '; signed -> ' + (meets(ctx.signedApp).ok ? 'exit 0 (passes)' : 'refused') : ''}`,
    };
  },
};

export default attack;
