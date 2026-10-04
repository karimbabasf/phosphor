// The signing gate (scripts/signing-gate.ts) on what it can be held to without the Developer ID
// key: the committed vault profile, read for real; the entitlements made from it; each refusal
// the profile and team checks can give, and a profile it cannot read; and the smoke exec against
// real processes, one of them a binary AMFI really kills. The gate passing on a Developer ID build
// is proved by a signed run (scripts/sign-and-notarize-local.sh), which no test here can do.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  JIT,
  PROFILE,
  SERVICE,
  type Profile,
  type Signature,
  canonical,
  certificateTeam,
  entitlementsPlist,
  plistToJson,
  profileProblems,
  readPlist,
  readProfile,
  serviceEntitlements,
  serviceGroup,
  shellSetProblems,
  signingGate,
  smokeExec,
  smokeProblem,
  teamProblems,
} from '../../scripts/signing-gate.ts';
import { developerTools } from './helpers/no-dialog.ts';
import { tempDir } from './helpers/tmp.ts';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const GATE = path.join(ROOT, 'scripts', 'signing-gate.ts');
const TEAM = '35Z6P26CBD';
const GROUP = `${TEAM}.com.karimbabasf.phosphor.vault`;
const DAY = 24 * 60 * 60 * 1000;
const macos = process.platform === 'darwin' && spawnSync('security', ['-h']).status !== null;
const tooling = macos && developerTools() && spawnSync('cc', ['--version']).status === 0;

const profile = (): Profile => readProfile(path.join(ROOT, PROFILE));

/* `security cms -D` opens unsigned CMS as well: enough to put any plist where the gate reads a
   profile, with no key to sign it. */
function cms(content: Buffer): Buffer {
  const der = (tag: number, body: Buffer): Buffer => {
    const size: number[] = [];
    for (let rest = body.length; rest > 0; rest = Math.floor(rest / 256)) size.unshift(rest % 256);
    return Buffer.concat([Buffer.from([tag, ...(body.length < 0x80 ? [body.length] : [0x80 | size.length, ...size])]), body]);
  };
  // ContentInfo: id-data, then the content as an octet string.
  return der(0x30, Buffer.concat([Buffer.from('06092a864886f70d010701', 'hex'), der(0xa0, der(0x04, content))]));
}

// The committed profile's own plist, changed by PlistBuddy commands, in a profile of its own.
function profileWith(dir: string, name: string, ...commands: string[]): string {
  const plist = path.join(dir, `${name}.plist`);
  fs.writeFileSync(plist, execFileSync('security', ['cms', '-D', '-i', path.join(ROOT, PROFILE)]));
  for (const command of commands) execFileSync('/usr/libexec/PlistBuddy', ['-c', command, plist]);
  const file = path.join(dir, `${name}.provisionprofile`);
  fs.writeFileSync(file, cms(fs.readFileSync(plist)));
  return file;
}

test('the committed profile is the vault service\'s Developer ID profile, with years left', { skip: !macos && 'needs macOS security and plutil' }, () => {
  const p = profile();
  assert.equal(p.team, TEAM);
  assert.equal(p.appId, GROUP, 'the app id is the service\'s bundle id under the team');
  assert.deepEqual(p.entitlements['keychain-access-groups'], [`${TEAM}.*`], 'the profile allows every group of the team');
  assert.equal(p.allDevices, true, 'Developer ID: every Mac, no device list');
  assert.deepEqual(p.platforms, ['OSX']);
  assert.equal(p.certificates.length, 1);
  assert.equal(certificateTeam(p.certificates[0]), TEAM, 'its one certificate is the team\'s');
  assert.ok(p.expires.getTime() - Date.now() > 365 * DAY, `expires ${p.expires.toISOString()}`);
  assert.deepEqual(profileProblems(p), []);
});

/* GitHub's macOS 15 runner once read this profile's Entitlements as nothing, through plutil's
   JSON, and the reader made that an empty app id without a word. Every key comes back on every
   macOS, or the read fails, and the failure names the macOS and carries the tool's own words. */
test('the committed profile\'s entitlements are read whole, never empty, on whichever macOS runs this', { skip: !macos && 'needs macOS security and PlistBuddy' }, () => {
  const where = `macOS ${spawnSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).stdout.trim()}`;
  let p: Profile;
  try {
    p = profile();
  } catch (error) {
    assert.fail(`${where}: ${(error as Error).message}`);
  }
  assert.notEqual(p.appId, '', `${where}: an empty app id is a profile read wrong`);
  assert.deepEqual(p.entitlements, {
    'com.apple.application-identifier': GROUP,
    'com.apple.developer.team-identifier': TEAM,
    'keychain-access-groups': [`${TEAM}.*`],
  }, `${where}: every key of the Entitlements, and nothing else`);
  assert.notEqual(p.name, '');
  assert.match(p.uuid, /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
});

test('every key of a profile\'s Entitlements is read as it is: dotted names, escapes, numbers, flags, lists and dicts', { skip: !macos && 'needs macOS security and PlistBuddy' }, () => {
  const more = profileWith(tempDir('signing-gate-keys-'), 'more',
    'Add :Entitlements:com.apple.security.app-sandbox bool true',
    'Add :Entitlements:x.dotted&<key> string a&b<c>',
    'Add :Entitlements:__proto__ string not-a-prototype',
    'Add :Entitlements:n integer 7',
    'Add :Entitlements:list array',
    'Add :Entitlements:list:0 string p',
    'Add :Entitlements:nested dict',
    'Add :Entitlements:nested:empty string');
  const p = readProfile(more);
  assert.deepEqual(p.entitlements, {
    'com.apple.application-identifier': GROUP,
    'com.apple.developer.team-identifier': TEAM,
    'keychain-access-groups': [`${TEAM}.*`],
    'com.apple.security.app-sandbox': true,
    'x.dotted&<key>': 'a&b<c>',
    ['__proto__']: 'not-a-prototype',
    n: 7,
    list: ['p'],
    nested: { empty: '' },
  });
  assert.equal(Object.getPrototypeOf(p.entitlements), Object.prototype);
  assert.deepEqual(serviceEntitlements(p), serviceEntitlements(profile()), 'the service still claims the three it is made from');
});

/* What notarize-mac.sh signs the service with and what the gate holds a signed app to both come
   from this read. A profile whose Entitlements cannot be read stops both, saying why, and never
   becomes a service signed with an empty app id. */
test('a profile whose Entitlements cannot be read is a loud problem in the gate and at signing, never an empty set', { skip: !macos && 'needs macOS security and PlistBuddy' }, () => {
  const dir = tempDir('signing-gate-unread-');
  const missing = profileWith(dir, 'missing', 'Delete :Entitlements');
  const flat = profileWith(dir, 'flat', 'Delete :Entitlements', `Add :Entitlements string ${GROUP}`);
  const garbled = path.join(dir, 'garbled.provisionprofile');
  fs.writeFileSync(garbled, cms(Buffer.from('not a plist')));
  assert.throws(() => readProfile(missing), /missing\.provisionprofile could not be read: its Entitlements is missing$/);
  assert.throws(() => readProfile(flat), /flat\.provisionprofile could not be read: its Entitlements is not a dict$/);
  assert.throws(() => readProfile(garbled), /garbled\.provisionprofile could not be read: PlistBuddy exited 1, saying: \S/, 'PlistBuddy\'s own words');

  const checkout = tempDir('signing-gate-unread-checkout-');
  fs.mkdirSync(path.join(checkout, path.dirname(PROFILE)), { recursive: true });
  fs.copyFileSync(missing, path.join(checkout, PROFILE));
  const app = path.join(tempDir('signing-gate-unread-app-'), 'Phosphor.app');
  fs.mkdirSync(path.join(app, SERVICE, 'Contents'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), entitlementsPlist({ CFBundleExecutable: 'Phosphor' }));
  fs.writeFileSync(path.join(app, SERVICE, 'Contents', 'Info.plist'), entitlementsPlist({ CFBundleExecutable: 'vault' }));
  const gate = signingGate(app, checkout);
  assert.equal(gate.profile, null);
  assert.deepEqual(gate.problems, [`${path.join(checkout, PROFILE)} could not be read: its Entitlements is missing`]);

  const cli = spawnSync(process.execPath, [GATE, '--entitlements', missing], { encoding: 'utf8' });
  assert.equal(cli.status, 1, cli.stderr);
  assert.equal(cli.stdout, '', 'no entitlements come out, so nothing is signed with an empty app id');
  assert.match(cli.stderr, /FAILS:\n {2}.*could not be read: its Entitlements is missing/);
});

/* The profile allows <team>.*, every keychain group the team will ever make. The service claims
   exactly one, so a key another team app keeps is never in its reach, and no other binary of the
   team reaches the vault's without claiming this group by name. */
test('the service\'s entitlements are made from the profile, with one keychain group and never the wildcard', { skip: !macos && 'needs macOS security and plutil' }, () => {
  const set = serviceEntitlements(profile());
  assert.deepEqual(set, {
    'com.apple.application-identifier': GROUP,
    'com.apple.developer.team-identifier': TEAM,
    'keychain-access-groups': [GROUP],
  });
  assert.equal(serviceGroup(TEAM), GROUP);
  assert.ok(!JSON.stringify(set).includes('*'), 'no wildcard anywhere');
  assert.equal(canonical(plistToJson(entitlementsPlist(set))), canonical(set), 'the plist codesign reads says the same');

  const cli = spawnSync(process.execPath, [GATE, '--entitlements', path.join(ROOT, PROFILE)], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(canonical(plistToJson(cli.stdout)), canonical(set), 'notarize-mac.sh signs the service with exactly this');
});

test('a profile that is not this service\'s, not Developer ID, or near its end is refused by name', { skip: !macos && 'needs macOS security and plutil' }, () => {
  const good = profile();
  const named = (p: Profile, now?: Date) => profileProblems(p, now).join('\n');
  assert.match(named(good, new Date(good.expires.getTime() - 300 * DAY)), /less than a year from now/);
  assert.match(named({ ...good, appId: `${TEAM}.com.karimbabasf.phosphor` }), /not 35Z6P26CBD\.com\.karimbabasf\.phosphor\.vault/);
  assert.match(named({ ...good, allDevices: false }), /not a Developer ID profile/);
  assert.match(named({ ...good, platforms: ['iOS'] }), /not macOS/);
  assert.match(named({ ...good, certificates: [] }), /lists no certificate/);
  assert.match(named({ ...good, entitlements: { ...good.entitlements, 'keychain-access-groups': [`${TEAM}.com.karimbabasf.other`] } }), /does not allow the keychain group/);
  assert.match(named({ ...good, entitlements: { ...good.entitlements, 'com.apple.developer.team-identifier': 'ABCDE12345' } }), /team-identifier is not its team/);
  assert.match(named({ ...good, team: '' }), /names no team/);

  const scratch = tempDir('signing-gate-profile-');
  const garbage = path.join(scratch, 'not.provisionprofile');
  fs.writeFileSync(garbage, 'not a profile');
  const cli = spawnSync(process.execPath, [GATE, '--entitlements', garbage], { encoding: 'utf8' });
  assert.notEqual(cli.status, 0, 'no entitlements come out of a file that is not a profile');
  assert.equal(cli.stdout, '');
});

test('the shell\'s committed set grants no JIT, no debugger and nothing only a profile can grant', { skip: !macos && 'needs plutil' }, () => {
  const shell = readPlist(path.join(ROOT, 'src-tauri', 'entitlements.plist'));
  assert.deepEqual(shellSetProblems(shell), []);
  assert.deepEqual(readPlist(path.join(ROOT, 'src-tauri', 'entitlements-node.plist')), { [JIT]: true });
  assert.match(shellSetProblems({ ...shell, [JIT]: true }).join('\n'), /grants allow-jit, which only node needs/);
  assert.match(shellSetProblems({ ...shell, 'keychain-access-groups': [GROUP] }).join('\n'), /claims keychain-access-groups, which only a provisioning profile can grant/);
  assert.match(shellSetProblems({ ...shell, 'com.apple.security.get-task-allow': true }).join('\n'), /lets a debugger attach/);
});

test('the team guard names the one that moved: certificate, codesign\'s team, or APPLE_TEAM_ID', { skip: !macos && 'needs macOS security and plutil' }, () => {
  const p = profile();
  const signer: Signature = { signed: true, entitlements: {}, runtime: true, team: TEAM, leaf: p.certificates[0] };
  assert.deepEqual(teamProblems(p, signer), []);
  assert.deepEqual(teamProblems(p, signer, TEAM), []);
  assert.deepEqual(teamProblems(p, signer, ''), [], 'an unset secret arrives empty, and is not a team');
  assert.match(teamProblems(p, signer, 'ABCDE12345').join('\n'), /APPLE_TEAM_ID is ABCDE12345/);
  assert.match(teamProblems(p, { ...signer, team: 'ABCDE12345' }).join('\n'), /codesign names the vault service's team ABCDE12345/);
  assert.match(teamProblems(p, { ...signer, leaf: null, team: null }).join('\n'), /signed the vault service is no team's/);
});

/* A real process for each answer the smoke exec can get, except the abort itself: a process that
   aborts leaves a crash report in ~/Library/Logs/DiagnosticReports on every run, and xpc_main's
   abort, the one the gate wants, writes none. A signal death is read the same way for every signal,
   so SIGKILL holds the arithmetic, and the 134 answer is held as a value. */
function binary(dir: string, name: string, body: string): string {
  const source = path.join(dir, `${name}.c`);
  fs.writeFileSync(source, `#include <signal.h>\n#include <stdlib.h>\n#include <unistd.h>\nint main(void) { ${body} }\n`);
  const out = path.join(dir, name);
  execFileSync('cc', ['-O0', '-o', out, source]);
  return out;
}

test('the smoke exec reads 134 as started, 137 as refused, anything else as not an XPC service', { skip: !tooling && 'needs macOS and cc' }, () => {
  const dir = tempDir('signing-gate-smoke-');
  assert.equal(smokeProblem({ code: 134, stderr: 'An XPC Service cannot be run directly.' }), null);
  assert.equal(smokeExec(binary(dir, 'killed', 'kill(getpid(), SIGKILL); return 0;')).code, 137);
  assert.match(String(smokeProblem({ code: 137, stderr: '' })), /AMFI refused the vault service: run by hand it was killed before main, 137/);
  const plain = smokeExec(binary(dir, 'plain', 'return 0;'));
  assert.equal(plain.code, 0);
  assert.match(String(smokeProblem(plain)), /gave 0, not 134/);
});

/* AMFI itself, not a stand-in: an ad-hoc binary that claims a keychain group, which only a
   provisioning profile can grant, is killed before main. The group is not Phosphor's. */
test('a binary claiming a restricted entitlement with no profile is killed before main, and the smoke exec says so', { skip: !tooling && 'needs macOS, cc and codesign' }, () => {
  const dir = tempDir('signing-gate-amfi-');
  const exe = binary(dir, 'claims', 'return 0;');
  const plist = path.join(dir, 'claims.plist');
  fs.writeFileSync(plist, entitlementsPlist({ 'keychain-access-groups': ['ABCDE12345.example.not-phosphor'] }));
  execFileSync('codesign', ['-s', '-', '-f', '--options', 'runtime', '--entitlements', plist, exe], { stdio: 'pipe' });
  const smoke = smokeExec(exe);
  assert.equal(smoke.code, 137);
  assert.match(String(smokeProblem(smoke)), /AMFI refused/);
});

test('the gate refuses an app with no vault service, and a checkout with no profile, before it reads anything else', { skip: !macos && 'needs macOS' }, () => {
  const checkout = tempDir('signing-gate-checkout-');
  const app = path.join(tempDir('signing-gate-app-'), 'Phosphor.app');
  fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  assert.deepEqual(signingGate(app, checkout).problems, [`${PROFILE} is missing from the checkout`]);
  fs.mkdirSync(path.join(checkout, path.dirname(PROFILE)), { recursive: true });
  fs.copyFileSync(path.join(ROOT, PROFILE), path.join(checkout, PROFILE));
  assert.match(signingGate(app, checkout).problems.join('\n'), /has no vault service at Contents\/XPCServices\/com\.karimbabasf\.phosphor\.vault\.xpc/);
  const cli = spawnSync(process.execPath, [GATE, '--app', app, '--checkout', checkout], { encoding: 'utf8' });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /FAILS/);
});
