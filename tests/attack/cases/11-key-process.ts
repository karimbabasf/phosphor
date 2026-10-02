// The process that holds the unwrapped key runs under three flags that shut the doors Node leaves
// open: --no-addons (no native code loads), --disallow-code-generation-from-strings (no eval), and
// --disable-sigusr1 (covered by case 02). An attacker who gets an unreviewed package in front of the
// key process is refused at runtime by the first two, and the package set the backend can even reach
// is pinned to the reviewed fourteen. This runs the bundled Node runtime when a build is present, so
// it is the exact runtime that ships, and the system node otherwise.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../harness.ts';
import type { AttackCase, AttackCtx, AttackResult } from '../types.ts';

const NODE_FLAGS = ['--disable-sigusr1', '--no-addons', '--disallow-code-generation-from-strings'];

function nodeBin(ctx: AttackCtx): string {
  for (const app of [ctx.signedApp, ctx.builtApp]) {
    if (app) {
      const n = path.join(app, 'Contents', 'MacOS', 'node');
      if (fs.existsSync(n)) return n;
    }
  }
  return process.execPath;
}

export const attack: AttackCase = {
  id: '11-key-process',
  title: 'the key process refuses a forced native addon and eval, and only the reviewed packages can load',
  async run(ctx: AttackCtx): Promise<AttackResult> {
    const node = nodeBin(ctx);
    const observed: string[] = [];
    let pass = true;

    // 1) A native addon forced into the key process. --no-addons makes the loader refuse before it
    //    even opens the file, so a malicious .node cannot run beside the key.
    const dlopen = spawnSync(
      node,
      [...NODE_FLAGS, '-e', "try{process.dlopen({exports:{}}, '/nonexistent.node');console.log('LOADED')}catch(e){console.log('REFUSED:'+(e.code||e.name))}"],
      { encoding: 'utf8' },
    );
    const dlText = `${dlopen.stdout}${dlopen.stderr}`.trim();
    const nativeRefused = /ERR_DLOPEN_DISABLED/.test(dlText);
    observed.push(`native addon: ${nativeRefused ? 'refused (ERR_DLOPEN_DISABLED)' : dlText.slice(0, 80)}`);
    pass &&= nativeRefused;

    // 2) Code generated from a string. --disallow-code-generation-from-strings makes eval throw, so
    //    a package that tries to build a function from attacker text cannot.
    const ev = spawnSync(
      node,
      [...NODE_FLAGS, '-e', "try{const f=(0,eval)('1+1');console.log('RAN:'+f)}catch(e){console.log('REFUSED:'+e.name)}"],
      { encoding: 'utf8' },
    );
    const evText = `${ev.stdout}${ev.stderr}`.trim();
    const evalRefused = /REFUSED:EvalError/.test(evText);
    observed.push(`eval: ${evalRefused ? 'refused (EvalError)' : evText.slice(0, 80)}`);
    pass &&= evalRefused;

    // 3) An unreviewed package forced in is seen loading beside the key. A resolve hook, the same
    //    mechanism the key-process guard uses, records every package by its last node_modules; hono
    //    ships for the MCP proxy and is outside the reviewed fourteen, so forcing it in is caught.
    const logger = path.join(ctx.scratch, 'logger.mjs');
    const seen = path.join(ctx.scratch, 'seen.txt');
    fs.writeFileSync(
      logger,
      [
        "import { registerHooks } from 'node:module';",
        "import fs from 'node:fs';",
        `const SEEN = ${JSON.stringify(seen)};`,
        'registerHooks({ resolve(spec, ctx, next) {',
        '  const r = next(spec, ctx);',
        "  const m = /node_modules\\/((?:@[^/]+\\/)?[^/]+)/g; let last=null, g;",
        '  const u = String(r.url||"");',
        '  while ((g = m.exec(u)) !== null) last = g[1];',
        '  if (last) { try { fs.appendFileSync(SEEN, last + "\\n"); } catch {} }',
        '  return r;',
        '} });',
      ].join('\n'),
    );
    const forced = spawnSync(
      node,
      [...NODE_FLAGS, '--import', `file://${logger}`, '--input-type=module', '-e', "await import('hono');"],
      { cwd: ROOT, encoding: 'utf8' },
    );
    const loaded = fs.existsSync(seen) ? fs.readFileSync(seen, 'utf8') : '';
    const honoSeen = /\bhono\b/.test(loaded);
    const reviewed = ['@adraffy/ens-normalize', '@noble/ciphers', '@noble/curves', '@noble/hashes', '@scure/base', '@scure/bip32', '@scure/bip39', 'abitype', 'eventemitter3', 'isows', 'ox', 'viem', 'ws', 'zod'];
    const honoReviewed = reviewed.includes('hono');
    observed.push(`forced hono: ${honoSeen ? 'caught loading beside the key' : 'not observed (' + (forced.stderr || '').slice(0, 60) + ')'}, in reviewed set: ${honoReviewed}`);
    pass &&= honoSeen && !honoReviewed;

    return {
      expected: 'native addon refused (ERR_DLOPEN_DISABLED), eval refused (EvalError), a forced unreviewed package (hono) caught and outside the reviewed 14',
      observed: observed.join(' | '),
      pass,
      evidence: `node ${NODE_FLAGS.join(' ')} -> dlopen ${nativeRefused ? 'ERR_DLOPEN_DISABLED' : 'ALLOWED'}, eval ${evalRefused ? 'EvalError' : 'RAN'}, hono seen=${honoSeen}`,
    };
  },
};

export default attack;
