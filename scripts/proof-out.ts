// Where a proof script puts its pictures. By default a folder under scripts/scratch/, which git
// ignores, so a run never adds files to the public repo. `--docs` writes into docs/screenshots/
// instead, for a picture that is meant to ship with the docs. PROOF_OUT (or PROOF_OUT_DIR, the
// older name) names any other folder and wins over both.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function proofOut(name: string, docsSub: string = name, argv: readonly string[] = process.argv, env: NodeJS.ProcessEnv = process.env): string {
  const named = env.PROOF_OUT ?? env.PROOF_OUT_DIR ?? '';
  if (named !== '') return path.resolve(named);
  if (argv.includes('--docs')) return path.join(ROOT, 'docs', 'screenshots', docsSub);
  return path.join(ROOT, 'scripts', 'scratch', name);
}
