// The signing gate: what a Developer ID signed Phosphor.app must be before it ships. One script
// holds every check, and every place that signs or ships the app runs it: scripts/notarize-mac.sh
// right after it signs the app and before Apple sees anything, and scripts/release-check.ts
// --stage signed on the app in the DMG and the app in the update (.github/workflows/release.yml
// and scripts/sign-and-notarize-local.sh both run that). So a local signed build runs the code
// the release runs.
//
// Why. The Secure Enclave service reaches its keychain group, <team>.com.karimbabasf.phosphor.vault,
// only through a Developer ID provisioning profile embedded in it (src-tauri/signing/
// vault.provisionprofile) and entitlements that match that profile. Signed wrong, nothing fails at
// signing time: AMFI kills the service at launch, before main, and every vault in the app is out
// of reach. And the service is not the only thing whose entitlements matter: allow-jit belongs to
// node alone, which runs V8, and the shell never needed it. Four things are checked, all must hold:
//
//   1. the profile: the committed one, embedded in the service byte for byte; this service's team
//      and app id; a Developer ID profile (every device, macOS) with more than a year left; and
//      the certificate that signed the service and the shell is one it lists;
//   2. the entitlements, per path: the shell exactly src-tauri/entitlements.plist, which grants no
//      JIT and nothing only a profile can grant; node exactly src-tauri/entitlements-node.plist,
//      allow-jit and nothing else; the service exactly the three made from the profile, with the one
//      keychain group and never the profile's wildcard; every other Mach-O none;
//   3. the smoke exec: the service run by hand reaches xpc_main and aborts, 134 ("An XPC Service
//      cannot be run directly"). That is AMFI letting it start. 137 is AMFI killing it before main;
//   4. the team guard: the profile's team is the signing certificate's team, and both are
//      APPLE_TEAM_ID when that is set.
//
//   node scripts/signing-gate.ts --app <Phosphor.app> --checkout <repo root>
//   node scripts/signing-gate.ts --entitlements <profile>   the service's entitlements, as a plist
//
// Node's own modules and macOS's codesign, security, plutil and PlistBuddy only: the sign job
// installs nothing.

import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isMachO } from './payload-digest.ts';

export type Entitlements = Record<string, unknown>;

export const SERVICE = 'Contents/XPCServices/com.karimbabasf.phosphor.vault.xpc';
export const SERVICE_ID = 'com.karimbabasf.phosphor.vault';
export const PROFILE = 'src-tauri/signing/vault.provisionprofile';
export const SHELL_ENTITLEMENTS = 'src-tauri/entitlements.plist';
export const NODE_ENTITLEMENTS = 'src-tauri/entitlements-node.plist';
export const JIT = 'com.apple.security.cs.allow-jit';
// A profile renewed with less than this left would let a release ship that stops opening its
// vault within the year: AMFI refuses the service once its profile has expired.
const MIN_LIFE_MS = 365 * 24 * 60 * 60 * 1000;

/* Restricted entitlements are the ones only a provisioning profile can grant, and AMFI kills a
   binary that claims one its profile does not allow. The hardened runtime's own exceptions all
   live under com.apple.security., and nothing outside it is one. */
export function isRestricted(key: string): boolean {
  return !key.startsWith('com.apple.security.');
}

export function serviceGroup(team: string): string {
  return `${team}.${SERVICE_ID}`;
}

export function canonical(value: unknown): string {
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

export function plistToJson(xml: string | Buffer): Entitlements {
  if (xml.toString().trim() === '') return {};
  const json = execFileSync('plutil', ['-convert', 'json', '-o', '-', '-'], { input: xml }).toString();
  return JSON.parse(json) as Entitlements;
}

export function readPlist(file: string): Entitlements {
  return plistToJson(fs.readFileSync(file));
}

export function bundleExecutable(bundle: string): string | null {
  try {
    const name = execFileSync('plutil', ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', path.join(bundle, 'Contents', 'Info.plist')], { stdio: ['ignore', 'pipe', 'ignore'] });
    return name.toString().trim() || null;
  } catch {
    return null;
  }
}

export type Profile = {
  name: string;
  uuid: string;
  team: string;
  appId: string;
  entitlements: Entitlements;
  expires: Date;
  allDevices: boolean;
  platforms: string[];
  certificates: Buffer[];
};

/* Runs one of macOS's tools and gives what it printed, or throws with every word it said, stderr
   and stdout both: PlistBuddy splits its errors across the two. */
function tool(command: string, args: string[]): Buffer {
  const run = spawnSync(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  if (run.status === 0) return run.stdout;
  const said = [run.stderr, run.stdout].map((out) => out?.toString().trim()).filter(Boolean).join(' / ');
  throw new Error(`${path.basename(command)} ${run.error?.message ?? `exited ${run.status ?? run.signal}`}, saying: ${said || 'nothing'}`);
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/* The XML plist PlistBuddy prints, read into values: a dict is an object, an array an array, a
   date a Date, data a Buffer, and strings, numbers, true and false what they say. Anything else
   fails, rather than reading as nothing. */
export function parsePlist(xml: string): unknown {
  const tokens = xml.replace(/<\?xml[^>]*\?>|<!DOCTYPE[^>]*>/g, '').match(/<[^>]*>|[^<]+/g) ?? [];
  let at = 0;
  const wrong = (why: string): never => {
    throw new Error(`not an XML plist: ${why}`);
  };
  const tag = (): string => {
    while (at < tokens.length && tokens[at].trim() === '') at++;
    return tokens[at++] ?? wrong('it ends early');
  };
  const text = (name: string): string => {
    let body = '';
    while (at < tokens.length && !tokens[at].startsWith('<')) body += tokens[at++];
    if (tokens[at++] !== `</${name}>`) wrong(`<${name}> is not closed`);
    return body.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, entity: string) =>
      entity.startsWith('#') ? String.fromCodePoint(Number(entity.replace('#', '0'))) : (ENTITIES[entity] ?? whole));
  };
  const value = (open: string): unknown => {
    switch (open) {
      case '<dict>': {
        const dict: Record<string, unknown> = {};
        for (let next = tag(); next !== '</dict>'; next = tag()) {
          if (next !== '<key>') wrong(`${next} where a key belongs`);
          // defineProperty, so a key named __proto__ is a key like any other.
          Object.defineProperty(dict, text('key'), { value: value(tag()), enumerable: true, writable: true, configurable: true });
        }
        return dict;
      }
      case '<array>': {
        const array: unknown[] = [];
        for (let next = tag(); next !== '</array>'; next = tag()) array.push(value(next));
        return array;
      }
      case '<dict/>': return {};
      case '<array/>': return [];
      case '<string>': return text('string');
      case '<string/>': return '';
      case '<integer>': return Number(text('integer'));
      case '<real>': return Number(text('real'));
      case '<true/>': return true;
      case '<false/>': return false;
      case '<date>': return new Date(text('date'));
      case '<data>': return Buffer.from(text('data').replace(/\s/g, ''), 'base64');
      case '<data/>': return Buffer.alloc(0);
      default: return wrong(`${open} is not a value`);
    }
  };
  if (!/^<plist( [^>]*)?>$/.test(tag())) wrong('no <plist>');
  const root = value(tag());
  if (tag() !== '</plist>') wrong('more than one value');
  return root;
}

const isString = (value: unknown): value is string => typeof value === 'string';
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString);
const isDate = (value: unknown): value is Date => value instanceof Date;
const isBuffers = (value: unknown): value is Buffer[] => Array.isArray(value) && value.every((item) => Buffer.isBuffer(item));
const isDict = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && !isDate(value) && !Buffer.isBuffer(value);

/* A profile is a CMS envelope around a plist. `security cms -D` opens it; PlistBuddy prints the
   plist back as XML from a private copy, and parsePlist reads every key of it here. Not plutil's
   JSON: `plutil -extract Entitlements json` gave no app id on GitHub's macOS 15 runner for the file
   that reads whole on macOS 27, and the old reader took that for an empty set without a word. A
   key that cannot be read throws, naming it and what the tool said, and the gate reports that as
   its problem. Only ProvisionsAllDevices may be missing: a development profile lists devices. */
export function readProfile(file: string): Profile {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signing-gate-profile-'));
  let doc: Record<string, unknown>;
  try {
    const copy = path.join(dir, 'profile.plist');
    fs.writeFileSync(copy, tool('security', ['cms', '-D', '-i', file]), { mode: 0o600 });
    const plist = parsePlist(tool('/usr/libexec/PlistBuddy', ['-x', '-c', 'Print', copy]).toString());
    if (!isDict(plist)) throw new Error('its plist is not a dict');
    doc = plist;
  } catch (error) {
    throw new Error(`${file} could not be read: ${(error as Error).message}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const need = <T>(key: string, kind: string, ok: (value: unknown) => value is T): T => {
    const value = doc[key];
    if (ok(value)) return value;
    throw new Error(`${file} could not be read: its ${key} is ${value === undefined ? 'missing' : `not ${kind}`}`);
  };
  const entitlements = need('Entitlements', 'a dict', isDict);
  return {
    name: need('Name', 'a string', isString),
    uuid: need('UUID', 'a string', isString),
    team: need('TeamIdentifier', 'a list of teams', isStrings)[0] ?? '',
    appId: String(entitlements['com.apple.application-identifier'] ?? ''),
    entitlements,
    expires: need('ExpirationDate', 'a date', isDate),
    allDevices: doc.ProvisionsAllDevices === true,
    platforms: need('Platform', 'a list of platforms', isStrings),
    certificates: need('DeveloperCertificates', 'a list of certificates', isBuffers),
  };
}

/* Everything about the profile that holds whatever signed the app: whose it is, what it allows,
   what kind it is, how long it has. */
export function profileProblems(profile: Profile, now: Date = new Date()): string[] {
  const problems: string[] = [];
  const team = profile.team;
  if (!/^[A-Z0-9]{10}$/.test(team)) problems.push(`the profile names no team (${JSON.stringify(team)})`);
  if (profile.appId !== serviceGroup(team)) problems.push(`the profile is for ${profile.appId || 'no app id'}, not ${serviceGroup(team)}`);
  if (profile.entitlements['com.apple.developer.team-identifier'] !== team) problems.push(`the profile's team-identifier is not its team ${team}`);
  const groups = profile.entitlements['keychain-access-groups'];
  const allowed = Array.isArray(groups) ? groups.map(String) : [];
  if (!allowed.includes(serviceGroup(team)) && !allowed.includes(`${team}.*`)) problems.push(`the profile does not allow the keychain group ${serviceGroup(team)}`);
  if (!profile.allDevices) problems.push('the profile names devices rather than provisioning all of them, so it is not a Developer ID profile');
  if (!profile.platforms.includes('OSX')) problems.push(`the profile is for ${profile.platforms.join(', ') || 'no platform'}, not macOS`);
  if (Number.isNaN(profile.expires.getTime()) || profile.expires.getTime() - now.getTime() <= MIN_LIFE_MS) {
    problems.push(`the profile expires ${Number.isNaN(profile.expires.getTime()) ? 'at no date it states' : profile.expires.toISOString()}, less than a year from now: renew it (Julia's checklist) before signing`);
  }
  if (profile.certificates.length === 0) problems.push('the profile lists no certificate');
  return problems;
}

/* The service's entitlements, made from the profile: its app id and team, and the one keychain
   group the vault lives in. The profile allows <team>.*, every group of the team; the service
   claims one, so no other group's items are ever in its reach. */
export function serviceEntitlements(profile: Profile): Entitlements {
  return {
    'com.apple.application-identifier': profile.appId,
    'com.apple.developer.team-identifier': profile.team,
    'keychain-access-groups': [serviceGroup(profile.team)],
  };
}

export function entitlementsPlist(entitlements: Entitlements): string {
  return execFileSync('plutil', ['-convert', 'xml1', '-o', '-', '-'], { input: JSON.stringify(entitlements) }).toString();
}

/* What the shell's committed set may hold: the hardened runtime's exceptions only, and neither
   JIT nor a debugger. */
export function shellSetProblems(set: Entitlements): string[] {
  const problems: string[] = [];
  if (set[JIT] === true) problems.push(`${SHELL_ENTITLEMENTS} grants allow-jit, which only node needs`);
  for (const key of Object.keys(set)) {
    if (isRestricted(key)) problems.push(`${SHELL_ENTITLEMENTS} claims ${key}, which only a provisioning profile can grant`);
    if (/get-task-allow/.test(key)) problems.push(`${SHELL_ENTITLEMENTS} claims ${key}, which lets a debugger attach`);
  }
  return problems;
}

export type Signature = { signed: boolean; entitlements: Entitlements; runtime: boolean; team: string | null; leaf: Buffer | null };

// What codesign says about a binary or a bundle: its entitlements, its flags, its team, and the
// certificate that signed it, read off the signature without running anything.
export function signatureOf(file: string): Signature {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signing-gate-'));
  try {
    const shown = spawnSync('codesign', ['-d', '--verbose=2', '--entitlements', '-', '--xml', `--extract-certificates=${path.join(dir, 'cert')}`, file], { encoding: 'utf8' });
    if (shown.status !== 0) return { signed: false, entitlements: {}, runtime: false, team: null, leaf: null };
    const team = /^TeamIdentifier=(.+)$/m.exec(shown.stderr)?.[1]?.trim() ?? null;
    const leaf = path.join(dir, 'cert0');
    return {
      signed: true,
      entitlements: plistToJson(shown.stdout),
      runtime: /^CodeDirectory .*flags=0x[0-9a-f]+\([^)]*\bruntime\b/m.test(shown.stderr),
      team: team === null || team === 'not set' ? null : team,
      leaf: fs.existsSync(leaf) ? fs.readFileSync(leaf) : null,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// The team a Developer ID certificate was issued to: its subject's organizational unit.
export function certificateTeam(der: Buffer): string | null {
  return /^OU=(.+)$/m.exec(new crypto.X509Certificate(der).subject)?.[1] ?? null;
}

export function machOFiles(app: string): string[] {
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

export type Smoke = { code: number | null; stderr: string };

/* Runs a binary by hand and gives its exit the way a shell reports it, 128 plus the signal for a
   process that died of one. An XPC service run this way aborts in xpc_main, 134. A binary AMFI
   refuses is killed before its first instruction, 137. */
export function smokeExec(binary: string): Smoke {
  const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] });
  const signal = run.signal === null ? undefined : os.constants.signals[run.signal];
  return { code: run.status ?? (signal === undefined ? null : 128 + signal), stderr: (run.stderr ?? '').trim() };
}

export function smokeProblem(smoke: Smoke): string | null {
  if (smoke.code === 134) return null;
  const said = smoke.stderr === '' ? '' : ` (${smoke.stderr.split('\n')[0]})`;
  if (smoke.code === 137) return `AMFI refused the vault service: run by hand it was killed before main, 137${said}. Its profile, its entitlements and its signing certificate do not agree`;
  return `the vault service run by hand gave ${smoke.code ?? 'no exit'}${said}, not 134, so it is not an XPC service AMFI lets start`;
}

/* The team guard: the profile, the certificate that signed, and the team the release secrets
   name are one team. A profile and a certificate of different teams cannot both be right, and
   AMFI would refuse the service; the guard names which one moved. */
export function teamProblems(profile: Profile, signer: Signature, team?: string): string[] {
  const problems: string[] = [];
  const leafTeam = signer.leaf === null ? null : certificateTeam(signer.leaf);
  if (leafTeam !== profile.team) problems.push(`the certificate that signed the vault service is ${leafTeam ?? 'no team'}'s, the profile is ${profile.team}'s`);
  if (signer.team !== profile.team) problems.push(`codesign names the vault service's team ${signer.team ?? 'not set'}, the profile ${profile.team}`);
  if (team !== undefined && team !== '' && team !== profile.team) problems.push(`APPLE_TEAM_ID is ${team}, the profile and the certificate are ${profile.team}`);
  return problems;
}

export type GateOptions = { team?: string; now?: Date };
export type GateResult = { problems: string[]; profile: Profile | null; smoke: Smoke | null };

export function signingGate(app: string, checkout: string, options: GateOptions = {}): GateResult {
  const problems: string[] = [];
  const committed = path.join(checkout, PROFILE);
  if (!fs.existsSync(committed)) return { problems: [`${PROFILE} is missing from the checkout`], profile: null, smoke: null };
  const service = path.join(app, SERVICE);
  if (!fs.existsSync(service)) return { problems: [`${app} has no vault service at ${SERVICE}`], profile: null, smoke: null };
  const main = bundleExecutable(app);
  const serviceExecutable = bundleExecutable(service);
  if (main === null || serviceExecutable === null) {
    return { problems: [`${main === null ? 'the app' : 'the vault service'} has no Info.plist naming its executable`], profile: null, smoke: null };
  }

  // 1. The profile, as committed and as embedded.
  let profile: Profile;
  try {
    profile = readProfile(committed);
  } catch (error) {
    return { problems: [(error as Error).message], profile: null, smoke: null };
  }
  problems.push(...profileProblems(profile, options.now));
  const embedded = path.join(service, 'Contents', 'embedded.provisionprofile');
  if (!fs.existsSync(embedded)) problems.push(`the vault service carries no Contents/embedded.provisionprofile`);
  else if (!fs.readFileSync(embedded).equals(fs.readFileSync(committed))) problems.push(`the vault service's embedded.provisionprofile is not ${PROFILE}`);
  const serviceSig = signatureOf(service);
  const shell = path.join(app, 'Contents', 'MacOS', main);
  const shellSig = signatureOf(shell);
  const listed = (leaf: Buffer | null) => leaf !== null && profile.certificates.some((cert) => cert.equals(leaf));
  if (!listed(serviceSig.leaf)) problems.push(`the certificate that signed the vault service is not in the profile`);
  if (shellSig.leaf === null || serviceSig.leaf === null || !shellSig.leaf.equals(serviceSig.leaf)) problems.push(`the shell and the vault service were not signed by one certificate`);

  // 2. The entitlements, per path.
  const committedSet = (rel: string): Entitlements => {
    if (fs.existsSync(path.join(checkout, rel))) return readPlist(path.join(checkout, rel));
    problems.push(`${rel} is missing from the checkout`);
    return {};
  };
  const shellSet = committedSet(SHELL_ENTITLEMENTS);
  problems.push(...shellSetProblems(shellSet));
  const nodeSet = committedSet(NODE_ENTITLEMENTS);
  if (canonical(nodeSet) !== canonical({ [JIT]: true })) problems.push(`${NODE_ENTITLEMENTS} must grant allow-jit and nothing else`);
  const serviceMain = `${SERVICE}/Contents/MacOS/${serviceExecutable}`;
  const expected = (rel: string): Entitlements => {
    if (rel === `Contents/MacOS/${main}`) return shellSet;
    if (rel === 'Contents/MacOS/node') return nodeSet;
    if (rel === serviceMain) return serviceEntitlements(profile);
    return {};
  };
  for (const file of machOFiles(app)) {
    const rel = path.relative(app, file).split(path.sep).join('/');
    const wrong = entitlementProblem(rel, signatureOf(file).entitlements, expected(rel));
    if (wrong !== null) problems.push(wrong);
  }

  // 3. The smoke exec.
  const smoke = smokeExec(path.join(app, serviceMain));
  const refused = smokeProblem(smoke);
  if (refused !== null) problems.push(refused);

  // 4. The team guard.
  problems.push(...teamProblems(profile, serviceSig, options.team));
  return { problems, profile, smoke };
}

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

if (import.meta.main) {
  const profileFile = arg('--entitlements');
  const app = arg('--app');
  if (profileFile !== undefined) {
    // Made only from a profile this service can use: a wrong one fails here, before anything is signed.
    let profile: Profile;
    try {
      profile = readProfile(profileFile);
    } catch (error) {
      console.error(`signing-gate: ${profileFile} FAILS:\n  ${(error as Error).message}`);
      process.exit(1);
    }
    const problems = profileProblems(profile);
    if (problems.length > 0) {
      console.error(`signing-gate: ${profileFile} FAILS:\n  ${problems.join('\n  ')}`);
      process.exit(1);
    }
    process.stdout.write(entitlementsPlist(serviceEntitlements(profile)));
  } else if (app !== undefined) {
    const team = process.env.APPLE_TEAM_ID;
    const { problems, profile, smoke } = signingGate(path.resolve(app), path.resolve(arg('--checkout') ?? '.'), { team });
    if (problems.length > 0) {
      console.error(`signing-gate: ${app} FAILS:\n  ${problems.join('\n  ')}`);
      process.exit(1);
    }
    console.log(
      `signing-gate: ${app} passes: profile "${profile?.name}" ${profile?.uuid} (team ${profile?.team}, expires ${profile?.expires.toISOString().slice(0, 10)}) ` +
        `embedded and listing the signing certificate; the shell, node and the vault service carry exactly their own entitlements; ` +
        `the service run by hand gave ${smoke?.code}; one team ${profile?.team}${team ? ', APPLE_TEAM_ID agrees' : ', APPLE_TEAM_ID not set'}`,
    );
  } else {
    console.error('usage: node scripts/signing-gate.ts --app <Phosphor.app> --checkout <repo root>\n       node scripts/signing-gate.ts --entitlements <profile>');
    process.exit(2);
  }
}
