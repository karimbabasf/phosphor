// Phosphor attack suite. Proves, against the built app as a system, that each 0.10.13 defense holds
// against a real local attack, and fails loudly on any that does not.
//
//   npm run attack                 the ad-hoc build this repo makes; SIGNED-ONLY cases skipped
//   npm run attack -- --app <.app> add a Developer ID build for the SIGNED-ONLY cases
//   npm run attack -- --only 06    run one case (prefix match on the id)
//   npm run attack -- --real-screen-lock
//                                  10-screen-lock-shell posts com.apple.screenIsLocked, which every
//                                  app on this Mac receives, instead of the shell's own name for it
//
// Each case boots a real app on a throwaway data dir and a throwaway HOME, plays the hostile local
// process, and reports expected vs observed with one evidence line. Exit 1 on any unexpected result.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtAppPath, cliApp, tmpDir, rmTemp } from '../tests/attack/harness.ts';
import type { AttackCase, AttackCtx, AttackResult } from '../tests/attack/types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CASES_DIR = path.join(__dirname, '..', 'tests', 'attack', 'cases');

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? (process.argv[i + 1] as string) : null;
}

async function loadCases(): Promise<AttackCase[]> {
  if (!fs.existsSync(CASES_DIR)) return [];
  const files = fs
    .readdirSync(CASES_DIR)
    .filter(f => f.endsWith('.ts') && !f.endsWith('.d.ts'))
    .sort();
  const cases: AttackCase[] = [];
  for (const f of files) {
    const mod = (await import(path.join(CASES_DIR, f))) as { attack?: AttackCase; default?: AttackCase };
    const c = mod.attack ?? mod.default;
    if (c && typeof c.run === 'function') cases.push(c);
    else console.error(`[warn] ${f} exports no attack case`);
  }
  return cases.sort((a, b) => a.id.localeCompare(b.id));
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms)),
  ]);
}

async function main(): Promise<void> {
  const signedApp = cliApp();
  const builtApp = builtAppPath();
  const only = argValue('--only');

  let cases = await loadCases();
  if (only) cases = cases.filter(c => c.id.startsWith(only));

  console.log('='.repeat(78));
  console.log('PHOSPHOR ATTACK SUITE');
  console.log(`built bundle: ${builtApp ?? 'none (run npm run app:build)'}`);
  console.log(`signed bundle (--app): ${signedApp ?? 'none; SIGNED-ONLY cases will skip'}`);
  console.log(`cases: ${cases.length}${only ? ` (filtered by --only ${only})` : ''}`);
  console.log('='.repeat(78));

  type Row = { id: string; title: string; status: 'PASS' | 'FAIL' | 'SKIP'; res: AttackResult };
  const rows: Row[] = [];

  for (const c of cases) {
    const scratch = tmpDir(c.id.replace(/[^a-z0-9]+/gi, '-'));
    let skip: string | null = null;
    if (c.signedOnly && !signedApp) skip = 'needs a Developer ID build (--app)';
    else if (c.needsBuiltApp && !builtApp && !signedApp) skip = 'needs a built bundle (npm run app:build)';

    if (skip) {
      const res: AttackResult = { expected: '', observed: '', pass: true, evidence: '', skipped: skip };
      rows.push({ id: c.id, title: c.title, status: 'SKIP', res });
      console.log(`\n[SKIP] ${c.id}  ${c.title}\n   ${skip}`);
      rmTemp(scratch);
      continue;
    }

    const ctx: AttackCtx = { builtApp, signedApp, scratch };
    console.log(`\n[RUN ] ${c.id}  ${c.title}`);
    let res: AttackResult;
    try {
      res = await withTimeout(c.run(ctx), c.timeoutMs ?? 120_000, c.id);
    } catch (err) {
      res = {
        expected: 'the case runs to a verdict',
        observed: `threw: ${err instanceof Error ? err.message : String(err)}`,
        pass: false,
        evidence: err instanceof Error ? (err.stack ?? err.message).split('\n').slice(0, 3).join(' | ') : String(err),
      };
    }
    const status: Row['status'] = res.skipped ? 'SKIP' : res.pass ? 'PASS' : 'FAIL';
    rows.push({ id: c.id, title: c.title, status, res });
    if (res.skipped) {
      console.log(`   SKIP  ${res.skipped}`);
    } else {
      console.log(`   expected: ${res.expected}`);
      console.log(`   observed: ${res.observed}`);
      console.log(`   evidence: ${res.evidence}`);
      console.log(`   ${status}`);
    }
    if (status !== 'FAIL') rmTemp(scratch);
    else console.log(`   scratch kept: ${scratch}`);
  }

  // The table.
  console.log(`\n${'='.repeat(78)}`);
  console.log('RESULTS');
  console.log('-'.repeat(78));
  const idW = Math.max(4, ...rows.map(r => r.id.length));
  for (const r of rows) {
    const mark = r.status === 'PASS' ? 'PASS' : r.status === 'SKIP' ? 'skip' : 'FAIL';
    console.log(`${mark.padEnd(5)} ${r.id.padEnd(idW)}  ${r.title}`);
  }
  console.log('-'.repeat(78));
  const passed = rows.filter(r => r.status === 'PASS').length;
  const skipped = rows.filter(r => r.status === 'SKIP').length;
  const failed = rows.filter(r => r.status === 'FAIL').length;
  console.log(`${rows.length} cases: ${passed} held, ${failed} unexpected, ${skipped} skipped`);
  console.log('='.repeat(78));

  if (failed > 0) {
    console.log('\nUNEXPECTED (a defense did not hold, or a case could not run):');
    for (const r of rows.filter(x => x.status === 'FAIL')) {
      console.log(`  ${r.id}: expected ${r.res.expected || '(see case)'}; observed ${r.res.observed}`);
    }
  }
  process.exit(failed > 0 ? 1 : 0);
}

await main();
