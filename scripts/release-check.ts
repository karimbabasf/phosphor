// The release gate's check of an app bundle against the checkout it was built from. The sign job
// runs it on the unsigned build before anything is signed (--stage built), and again on the app in
// the DMG and the app in the update bundle once they are signed (--stage signed). See
// .github/workflows/release.yml and scripts/sign-and-notarize-local.sh.
//
// Why. The build job holds no secret, and that is the point of splitting it from the sign job:
// whatever runs during the build (a dependency's build script, a poisoned cache) never sees an
// Apple key. But the sign job signs whatever the build job hands it. So a build that changed a
// first-party file would come out signed, notarized and attested as this workflow at this
// commit. Four things are checked, and all must hold:
//
//   1. every first-party file in the payload (PAYLOAD in scripts/payload-digest.ts) is the
//      checkout's, byte for byte, and the payload holds no first-party file the checkout lacks;
//   2. the shell carries the digest of the payload beside it (src-tauri/build.rs compiles it in),
//      read from the binary's bytes, never by running a binary this job did not build;
//   3. every Mach-O carries exactly the entitlements it should. Built: the file tauri.conf.json
//      names on the app's own executables in Contents/MacOS, because Tauri's ad-hoc pass signs the
//      shell and node with that one file, and none anywhere else (the Secure Enclave service is
//      built with none, scripts/build-se-helper.sh). Signed: each path its own set, the vault
//      profile, the service run by hand and one team, which is scripts/signing-gate.ts, run from
//      here; and every binary carries the hardened runtime and the shell's Team ID.
//      notarize-mac.sh signs every binary with the set its path is given and none it arrived
//      with, so the built check is the second line: it names a planted entitlement before any
//      key is in the job;
//   4. no Mach-O asks for a newer macOS than the oldest the app supports (minimumSystemVersion in
//      tauri.conf.json, which the app's Info.plist carries). A compiler targets the Mac it runs on
//      unless told otherwise, and nothing promises a binary starts on a macOS older than the one it
//      asks for: the vault service, built that way, asked for macOS 15.0 inside 0.10.13. No GitHub
//      runner has macOS 13, so this is what holds the floor; the release's smoke job starts the
//      service on the versions that do have one.
//
// What it cannot see: node_modules is installed by the build job from the lockfile and nothing
// here rebuilds it, so (2) says the shell and the payload agree, not that the build job was
// honest. That needs a reproducible build.
//
//   node scripts/release-check.ts --app <Phosphor.app> --checkout <repo root> --stage built|signed
//
// Node's own modules and macOS's codesign and plutil only: the sign job installs nothing.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { PAYLOAD, SKIPPED, payloadDigest } from './payload-digest.ts';
import { type Entitlements, entitlementProblem, machOFiles, readPlist, signatureOf, signingGate } from './signing-gate.ts';

export { entitlementProblem, type Entitlements };
export type Stage = 'built' | 'signed';

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

// Built, before any key: Tauri's ad-hoc pass signs the shell and every sidecar in Contents/MacOS
// with the one file tauri.conf.json names, and every other Mach-O carries none.
export function expectedEntitlements(rel: string, tauri: Entitlements): Entitlements {
  return /^Contents\/MacOS\/[^/]+$/.test(rel) ? tauri : {};
}

// The entitlements file Tauri's ad-hoc pass applied, as the checkout's tauri.conf.json names it.
export function tauriEntitlements(checkout: string): Entitlements {
  const conf = JSON.parse(fs.readFileSync(path.join(checkout, 'src-tauri', 'tauri.conf.json'), 'utf8')) as { bundle?: { macOS?: { entitlements?: string } } };
  const named = conf.bundle?.macOS?.entitlements;
  return named === undefined ? {} : readPlist(path.join(checkout, 'src-tauri', named));
}

// Whether the shell was compiled for this payload: the digest is a string constant in its bytes.
export function shellCarries(shell: Buffer, digest: string): boolean {
  return shell.includes(Buffer.from(digest, 'utf8'));
}

// The oldest macOS the app supports, as the checkout's tauri.conf.json says.
export function supportedMacOS(checkout: string): number[] {
  const conf = JSON.parse(fs.readFileSync(path.join(checkout, 'src-tauri', 'tauri.conf.json'), 'utf8')) as { bundle?: { macOS?: { minimumSystemVersion?: string } } };
  const named = conf.bundle?.macOS?.minimumSystemVersion;
  if (named === undefined || !/^\d+(\.\d+){0,2}$/.test(named)) throw new Error('tauri.conf.json names no minimumSystemVersion');
  return named.split('.').map(Number);
}

export function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function versionText(version: number[]): string {
  return (version[2] ?? 0) === 0 ? `${version[0]}.${version[1] ?? 0}` : version.join('.');
}

const MH_MAGIC = 0xfeedface;
const MH_MAGIC_64 = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;
const LC_VERSION_MIN_MACOSX = 0x24;
const LC_BUILD_VERSION = 0x32;
const PLATFORM_MACOS = 1;

function readAt(fd: number, position: number, length: number): Buffer {
  const out = Buffer.alloc(length);
  if (fs.readSync(fd, out, 0, length, position) !== length) throw new Error('it ends inside its own header');
  return out;
}

/* One slice's minimum, from its load commands: LC_BUILD_VERSION for macOS, or the older
   LC_VERSION_MIN_MACOSX. Both pack the version as xxxx.yy.zz in one word. */
function sliceMinimum(fd: number, at: number): number[] | null {
  const head = readAt(fd, at, 28);
  const magic = head.readUInt32LE(0);
  if (magic !== MH_MAGIC && magic !== MH_MAGIC_64) throw new Error(`the slice at ${at} is not a little-endian Mach-O`);
  const count = head.readUInt32LE(16);
  const commands = readAt(fd, at + (magic === MH_MAGIC_64 ? 32 : 28), head.readUInt32LE(20));
  const unpack = (word: number): number[] => [word >>> 16, (word >>> 8) & 0xff, word & 0xff];
  for (let i = 0, cursor = 0; i < count; i += 1) {
    if (cursor + 8 > commands.length) throw new Error('its load commands run past their size');
    const cmd = commands.readUInt32LE(cursor);
    const size = commands.readUInt32LE(cursor + 4);
    if (size < 8 || cursor + size > commands.length) throw new Error('a load command does not fit its size');
    if (cmd === LC_BUILD_VERSION && size >= 16 && commands.readUInt32LE(cursor + 8) === PLATFORM_MACOS) return unpack(commands.readUInt32LE(cursor + 12));
    if (cmd === LC_VERSION_MIN_MACOSX && size >= 12) return unpack(commands.readUInt32LE(cursor + 8));
    cursor += size;
  }
  return null;
}

/* The newest macOS any slice of a Mach-O or universal binary asks for, or null when none says. */
export function minimumMacOS(file: string): number[] | null {
  const fd = fs.openSync(file, 'r');
  try {
    const magic = readAt(fd, 0, 4).readUInt32BE(0);
    if (magic !== FAT_MAGIC && magic !== FAT_MAGIC_64) return sliceMinimum(fd, 0);
    const wide = magic === FAT_MAGIC_64;
    const slices = readAt(fd, 4, 4).readUInt32BE(0);
    if (slices === 0 || slices > 32) throw new Error(`it says it holds ${slices} slices`);
    let newest: number[] | null = null;
    for (let i = 0; i < slices; i += 1) {
      const entry = readAt(fd, 8 + i * (wide ? 32 : 20), wide ? 32 : 20);
      const found = sliceMinimum(fd, wide ? Number(entry.readBigUInt64BE(8)) : entry.readUInt32BE(8));
      if (found !== null && (newest === null || compareVersions(found, newest) > 0)) newest = found;
    }
    return newest;
  } finally {
    fs.closeSync(fd);
  }
}

/* Every Mach-O that asks for a newer macOS than the app supports, or whose header cannot be read. */
export function minimumProblems(app: string, checkout: string): string[] {
  const floor = supportedMacOS(checkout);
  const problems: string[] = [];
  for (const file of machOFiles(app)) {
    const rel = path.relative(app, file).split(path.sep).join('/');
    try {
      const asks = minimumMacOS(file);
      if (asks !== null && compareVersions(asks, floor) > 0) problems.push(`${rel} asks for macOS ${versionText(asks)}, and the app supports ${versionText(floor)}`);
    } catch (error) {
      problems.push(`${rel} has a Mach-O header this cannot read: ${(error as Error).message}`);
    }
  }
  return problems;
}

export type CheckOptions = { team?: string };

export function checkApp(app: string, checkout: string, stage: Stage, options: CheckOptions = {}): string[] {
  const problems: string[] = [];
  const payloadRoot = path.join(app, 'Contents', 'Resources', 'phosphor');
  if (!fs.existsSync(payloadRoot)) return [`${app} has no payload at Contents/Resources/phosphor`];
  problems.push(...payloadProblems(checkout, payloadRoot));

  const sealed = payloadDigest(payloadRoot);
  problems.push(...sealed.problems);
  const main = execFileSync('plutil', ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', path.join(app, 'Contents', 'Info.plist')]).toString().trim();
  const shell = path.join(app, 'Contents', 'MacOS', main);
  if (!shellCarries(fs.readFileSync(shell), sealed.digest)) problems.push(`the shell was not built for the payload beside it (digest ${sealed.digest})`);
  problems.push(...minimumProblems(app, checkout));

  if (stage === 'built') {
    const tauri = tauriEntitlements(checkout);
    for (const file of machOFiles(app)) {
      const rel = path.relative(app, file).split(path.sep).join('/');
      const wrong = entitlementProblem(rel, signatureOf(file).entitlements, expectedEntitlements(rel, tauri));
      if (wrong !== null) problems.push(wrong);
    }
    return problems;
  }

  // Signed: the signing gate holds every path's entitlements, the vault profile, the service run
  // by hand and the team; this holds every binary to the hardened runtime and the shell's team.
  problems.push(...signingGate(app, checkout, { team: options.team }).problems);
  const shellTeam = signatureOf(shell).team;
  if (shellTeam === null) problems.push(`the shell is not signed by a team`);
  for (const file of machOFiles(app)) {
    const rel = path.relative(app, file).split(path.sep).join('/');
    const sig = signatureOf(file);
    if (!sig.signed) problems.push(`${rel} is not signed`);
    else {
      if (!sig.runtime) problems.push(`${rel} is signed without the hardened runtime`);
      if (shellTeam !== null && sig.team !== shellTeam) problems.push(`${rel} is signed by ${sig.team ?? 'no team'}, not ${shellTeam}`);
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
  const problems = checkApp(path.resolve(app), path.resolve(checkout), stage, { team: process.env.APPLE_TEAM_ID });
  if (problems.length > 0) {
    console.error(`release-check: ${app} (${stage}) FAILS:\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  const floor = versionText(supportedMacOS(path.resolve(checkout)));
  console.log(
    stage === 'signed'
      ? `release-check: ${app} (signed) is the checkout, each binary carries its own entitlements, the vault service passes the signing gate, the hardened runtime and one team, and every binary runs on macOS ${floor}`
      : `release-check: ${app} (built) is the checkout, carries the committed entitlements, and every binary runs on macOS ${floor}`,
  );
}
