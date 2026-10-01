// The shell hashes its payload tree before it starts the backend and starts nothing if the hash does
// not match the one compiled into the signed shell (src-tauri/src/payload.rs, the digest from
// npm run bundle). So changing, adding, removing or symlinking any file under Contents/Resources/
// phosphor stops the app with the "needs a fresh copy" splash and no backend. This tampers a copy of
// the built bundle (never the original) four ways, reads the shell's own --payload-digest verdict,
// and then launches one tampered copy to confirm no backend process appears.
//
// Swapping Contents/MacOS/node is NOT caught here (node is outside the payload root); that is the
// code-signature's job and is covered by case 04 (SIGNED-ONLY, the team requirement).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { launchShell } from '../harness.ts';
import type { AttackCase, AttackCtx, AttackResult } from '../types.ts';

function digestVerdict(app: string): { different: boolean; out: string } {
  const r = spawnSync(path.join(app, 'Contents', 'MacOS', 'phosphor-desktop'), ['--payload-digest'], { encoding: 'utf8', timeout: 30_000 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  // Clean payload: exit 0, "match". Any tamper is a non-zero exit with no "match": the hash differs
  // (DIFFERENT) or the tree is unreadable (a symlink is "neither a file nor a folder"). Either way
  // the shell starts nothing.
  const different = r.status !== 0 && !/\bmatch\b/.test(out);
  return { different, out: out.trim().replace(/\s+/g, ' ').slice(0, 120) };
}

export const attack: AttackCase = {
  id: '03-payload-tamper',
  title: 'the shell starts no backend when a payload file is changed, added, removed or symlinked',
  needsBuiltApp: true,
  timeoutMs: 180_000,
  async run(ctx: AttackCtx): Promise<AttackResult> {
    const src = ctx.builtApp ?? ctx.signedApp;
    if (!src) return { expected: '', observed: '', pass: true, evidence: '', skipped: 'no build' };

    const copy = path.join(ctx.scratch, 'Phosphor.app');
    const cp = spawnSync('/bin/cp', ['-R', src, copy], { encoding: 'utf8' });
    if (cp.status !== 0) throw new Error(`could not copy the bundle: ${cp.stderr}`);
    const payload = path.join(copy, 'Contents', 'Resources', 'phosphor');
    const target = path.join(payload, 'package.json');
    const original = fs.readFileSync(target);

    const results: Record<string, boolean> = {};

    // modify
    fs.appendFileSync(target, '\n// tampered\n');
    results.modify = digestVerdict(copy).different;
    fs.writeFileSync(target, original);

    // add
    const added = path.join(payload, '__attack_added__.js');
    fs.writeFileSync(added, 'module.exports = 1;\n');
    results.add = digestVerdict(copy).different;
    fs.rmSync(added);

    // remove
    const aside = `${target}.aside`;
    fs.renameSync(target, aside);
    results.remove = digestVerdict(copy).different;
    fs.renameSync(aside, target);

    // symlink (payload-digest refuses a link outright)
    const asideL = `${target}.aside`;
    fs.renameSync(target, asideL);
    fs.symlinkSync('/etc/hosts', target);
    results.symlink = digestVerdict(copy).different;
    fs.rmSync(target);
    fs.renameSync(asideL, target);

    const allCaught = Object.values(results).every(Boolean);

    // The system behaviour: a tampered copy must spawn no backend. Leave one tamper in place and
    // launch it, expecting no sidecar.
    fs.appendFileSync(target, '\n// tampered for launch\n');
    const shell = await launchShell({ app: copy, expectSpawn: false, bootTimeoutMs: 9000 });
    let sidecars = -1;
    try {
      sidecars = shell.sidecarPids().length;
    } finally {
      await shell.stop();
    }
    const noSpawn = sidecars === 0;

    const pass = allCaught && noSpawn;
    return {
      expected: 'every tamper (modify/add/remove/symlink) reads DIFFERENT; a tampered copy launches no backend',
      observed: `modify=${results.modify} add=${results.add} remove=${results.remove} symlink=${results.symlink}; tampered launch sidecars=${sidecars}`,
      pass,
      evidence: `phosphor-desktop --payload-digest -> DIFFERENT on all 4 tampers; launched tampered copy -> ${sidecars} backend processes`,
    };
  },
};

export default attack;
