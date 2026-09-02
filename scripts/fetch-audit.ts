// Every network call this app makes, and whether it carries a deadline.
//
// The gate behind the reliability work: the count of fetch sites in src/ equals the count
// passing a signal. Run it as `node scripts/fetch-audit.ts`; it exits nonzero when they differ,
// so a new fetch without a timeout is a failure rather than a thing someone notices later.
//
// It is a text scan, deliberately. A type-aware pass would need the compiler API and would still
// have to decide what counts as "the fetch used here"; a scan that can be read in one sitting is
// easier to trust for a rule this blunt.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = path.join(ROOT, 'src');

// A call to fetch, to a caller-supplied fetchImpl, or to the `?? fetch` default the rails use.
const CALL = /(?:^|[^A-Za-z0-9_.])(?:fetchImpl|fetch|\(\s*deps\.fetchImpl\s*\?\?\s*fetch\s*\)|doFetch)\s*\(/;

export type Site = { file: string; line: number; text: string; hasSignal: boolean };

function files(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...files(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out.sort();
}

// A signal belongs to the call it is inside. The init object is always within a dozen lines of
// the opening paren in this codebase, and the scan stops at the first line that closes it.
function signalWithin(lines: string[], start: number): boolean {
  let depth = 0;
  for (let i = start; i < Math.min(lines.length, start + 20); i += 1) {
    const line = lines[i];
    if (/\bsignal\s*:/.test(line)) return true;
    for (const ch of line) {
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
    }
    if (i > start && depth <= 0) return false;
  }
  return false;
}

export function auditFetchSites(): Site[] {
  const sites: Site[] = [];
  for (const file of files(SRC)) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const code = line.replace(/^\s*\/\/.*$/, '').replace(/^\s*\*.*$/, '');
      if (!CALL.test(code)) continue;
      // Definitions and types, not calls.
      if (/\bfunction\s+fetch/.test(code)) continue;
      if (/typeof\s+fetch\b/.test(code)) continue;
      sites.push({
        file: path.relative(ROOT, file),
        line: i + 1,
        text: line.trim(),
        hasSignal: signalWithin(lines, i),
      });
    }
  }
  return sites;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const sites = auditFetchSites();
  const withSignal = sites.filter((s) => s.hasSignal);
  for (const s of sites) {
    if (!s.hasSignal) console.log(`NO SIGNAL  ${s.file}:${s.line}  ${s.text.slice(0, 90)}`);
  }
  console.log(`fetch sites: ${sites.length}`);
  console.log(`with a signal: ${withSignal.length}`);
  process.exit(sites.length === withSignal.length ? 0 : 1);
}
