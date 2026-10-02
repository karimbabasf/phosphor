// The release gate's check of an app bundle against the checkout it was built from. The sign job
// runs it on the unsigned build before anything is signed (--stage built), and again on the app in
// the DMG and the app in the update bundle once they are signed (--stage signed). See
// .github/workflows/release.yml and scripts/sign-and-notarize-local.sh.
//
// Why. The build job holds no secret, and that is the point of splitting it from the sign job:
// whatever runs during the build (a dependency's build script, a poisoned cache) never sees an
// Apple key. But the sign job signs whatever the build job hands it, and notarize-mac.sh keeps a
// nested binary's entitlements as it found them. So a build that changed a first-party file, or
// put an entitlement on the Secure Enclave service, would come out signed, notarized and attested
// as this workflow at this commit. Three things are checked, and all must hold:
//
//   1. every first-party file in the payload (PAYLOAD in scripts/payload-digest.ts) is the
//      checkout's, byte for byte, and the payload holds no first-party file the checkout lacks;
//   2. the shell carries the digest of the payload beside it (src-tauri/build.rs compiles it in),
//      read from the binary's bytes, never by running a binary this job did not build;
//   3. every Mach-O carries exactly the entitlements it should: the committed
//      src-tauri/entitlements.plist on the app's own executables in Contents/MacOS, and none
//      anywhere else (the Secure Enclave service is built with none, scripts/build-se-helper.sh).
//      Signed, every one also carries the hardened runtime and the shell's Team ID.
//
// What it cannot see: node_modules is installed by the build job from the lockfile and nothing
// here rebuilds it, so (2) says the shell and the payload agree, not that the build job was
// honest. That needs a reproducible build.
//
//   node scripts/release-check.ts --app <Phosphor.app> --checkout <repo root> --stage built|signed
//
// Node's own modules and macOS's codesign and plutil only: the sign job installs nothing.

import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { PAYLOAD, SKIPPED, isMachO, payloadDigest } from './payload-digest.ts';

export type Stage = 'built' | 'signed';
export type Entitlements = Record<string, unknown>;

// Every regular file under the given paths, by its path from the root, with the SHA-256 of its
// content. Links are named rather than followed: the digest refuses them too.
function filesUnder(root: string, rels: string[], skip: (rel: string) => boolean = () => false): Map<string, string> {
  const files = new Map<string, string>();
  const add = (rel: string): void => {
    if (skip(rel)) return;
    const full = path.join(root, ...rel.split('/'));
    const stat = fs.lstatSync(full, { throwIfNoEntry: false });
    if (stat === undefined) return;
    if (stat.isSymbolicLink()) files.set(rel, 'a link');
    else if (stat.isDirectory()) {
      for (const name of fs.readdirSync(full)) add(`${rel}/${name}`);
    } else if (stat.isFile()) {
      // Finder's own file is left out, as the digest leaves it out. A folder by that name is
      // read like any other: the digest counts what is in it and the shell loads it (re-audit R-L10).
      if (path.posix.basename(rel) === SKIPPED) return;
      files.set(rel, crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex'));
    }
  };
  for (const rel of rels) add(rel);
  return files;
}

/* What the payload's first-party files have that the checkout's do not, or lack, or hold
   differently, one sentence each. Everything in the payload but node_modules is first-party: a
   file beside the entries is as foreign as one inside them. */
export function payloadProblems(checkout: string, payloadRoot: string): string[] {
  const problems: string[] = [];
  const want = filesUnder(checkout, PAYLOAD);
  const top = fs.readdirSync(payloadRoot);
  const have = filesUnder(payloadRoot, top, (rel) => rel === 'node_modules');
  for (const [rel, hash] of want) {
    const got = have.get(rel);
    if (got === undefined) problems.push(`${rel} is in the checkout and missing from the payload`);
    else if (got !== hash) problems.push(`${rel} differs from the checkout`);
  }
  for (const rel of have.keys()) if (!want.has(rel)) problems.push(`${rel} is in the payload and not in the checkout`);
  return problems;
}

// The app's own executables get the committed entitlements; every other Mach-O gets none.
export function expectedEntitlements(rel: string, app: Entitlements): Entitlements {
  return /^Contents\/MacOS\/[^/]+$/.test(rel) ? app : {};
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function entitlementProblem(rel: string, found: Entitlements, expected: Entitlements): string | null {
  if (canonical(found) === canonical(expected)) return null;
  const extra = Object.keys(found).filter((k) => canonical(found[k]) !== canonical(expected[k]));
  const missing = Object.keys(expected).filter((k) => !(k in found));
  const named = [...new Set([...extra, ...missing])].sort().join(', ');
  return `${rel} carries entitlements other than the ones it should (${named})`;
}

// Whether the shell was compiled for this payload: the digest is a string constant in its bytes.
export function shellCarries(shell: Buffer, digest: string): boolean {
  return shell.includes(Buffer.from(digest, 'utf8'));
}

function plistToJson(xml: string): Entitlements {
  if (xml.trim() === '') return {};
  const json = execFileSync('plutil', ['-convert', 'json', '-o', '-', '-'], { input: xml }).toString();
  return JSON.parse(json) as Entitlements;
}

type Signature = { signed: boolean; entitlements: Entitlements; runtime: boolean; team: string | null };

function signatureOf(file: string): Signature {
  const shown = spawnSync('codesign', ['-d', '--verbose=2', '--entitlements', '-', '--xml', file], { encoding: 'utf8' });
  if (shown.status !== 0) return { signed: false, entitlements: {}, runtime: false, team: null };
  const team = /^TeamIdentifier=(.+)$/m.exec(shown.stderr)?.[1]?.trim() ?? null;
  return {
    signed: true,
    entitlements: plistToJson(shown.stdout),
    runtime: /^CodeDirectory .*flags=0x[0-9a-f]+\([^)]*\bruntime\b/m.test(shown.stderr),
    team: team === null || team === 'not set' ? null : team,
  };
}

function machOFiles(app: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const fd = fs.openSync(full, 'r');
        const head = Buffer.alloc(4);
        const read = fs.readSync(fd, head, 0, 4, 0);
        fs.closeSync(fd);
        if (isMachO(head.subarray(0, read))) found.push(full);
      }
    }
  };
  walk(path.join(app, 'Contents'));
  return found.sort();
}

export function checkApp(app: string, checkout: string, stage: Stage): string[] {
  const problems: string[] = [];
  const payloadRoot = path.join(app, 'Contents', 'Resources', 'phosphor');
  if (!fs.existsSync(payloadRoot)) return [`${app} has no payload at Contents/Resources/phosphor`];
  problems.push(...payloadProblems(checkout, payloadRoot));

  const sealed = payloadDigest(payloadRoot);
  problems.push(...sealed.problems);
  const main = execFileSync('plutil', ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', path.join(app, 'Contents', 'Info.plist')]).toString().trim();
  const shell = path.join(app, 'Contents', 'MacOS', main);
  if (!shellCarries(fs.readFileSync(shell), sealed.digest)) problems.push(`the shell was not built for the payload beside it (digest ${sealed.digest})`);

  const committed = plistToJson(fs.readFileSync(path.join(checkout, 'src-tauri', 'entitlements.plist'), 'utf8'));
  const shellTeam = stage === 'signed' ? signatureOf(shell).team : null;
  if (stage === 'signed' && shellTeam === null) problems.push(`the shell is not signed by a team`);
  for (const file of machOFiles(app)) {
    const rel = path.relative(app, file).split(path.sep).join('/');
    const sig = signatureOf(file);
    const wrong = entitlementProblem(rel, sig.entitlements, expectedEntitlements(rel, committed));
    if (wrong !== null) problems.push(wrong);
    if (stage === 'signed') {
      if (!sig.signed) problems.push(`${rel} is not signed`);
      else {
        if (!sig.runtime) problems.push(`${rel} is signed without the hardened runtime`);
        if (shellTeam !== null && sig.team !== shellTeam) problems.push(`${rel} is signed by ${sig.team ?? 'no team'}, not ${shellTeam}`);
      }
    }
  }
  return problems;
}

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

if (import.meta.main) {
  const app = arg('--app');
  const checkout = arg('--checkout') ?? '.';
  const stage = arg('--stage');
  if (app === undefined || (stage !== 'built' && stage !== 'signed')) {
    console.error('usage: node scripts/release-check.ts --app <Phosphor.app> --checkout <repo root> --stage built|signed');
    process.exit(2);
  }
  const problems = checkApp(path.resolve(app), path.resolve(checkout), stage);
  if (problems.length > 0) {
    console.error(`release-check: ${app} (${stage}) FAILS:\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`release-check: ${app} (${stage}) is the checkout, carries the committed entitlements${stage === 'signed' ? ', the hardened runtime and one team' : ''}`);
}
