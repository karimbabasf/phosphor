// The signing gate (scripts/signing-gate.ts) on what it can be held to without the Developer ID
// key: the committed vault profile, read for real; the entitlements made from it; each refusal
// the profile and team checks can give; and the smoke exec against real processes, one of them a
// binary AMFI really kills. The gate passing on a Developer ID build is proved by a signed run
// (scripts/sign-and-notarize-local.sh), which no test here can do.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  JIT,
  PROFILE,
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
import { tempDir } from './helpers/tmp.ts';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const GATE = path.join(ROOT, 'scripts', 'signing-gate.ts');
const TEAM = '35Z6P26CBD';
const GROUP = `${TEAM}.com.karimbabasf.phosphor.vault`;
const DAY = 24 * 60 * 60 * 1000;
const macos = process.platform === 'darwin' && spawnSync('security', ['-h']).status !== null;
const tooling = macos && spawnSync('cc', ['--version']).status === 0;

const profile = (): Profile => readProfile(path.join(ROOT, PROFILE));

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

// A real process for each answer the smoke exec can get.
function binary(dir: string, name: string, body: string): string {
  const source = path.join(dir, `${name}.c`);
  fs.writeFileSync(source, `#include <signal.h>\n#include <stdlib.h>\n#include <unistd.h>\nint main(void) { ${body} }\n`);
  const out = path.join(dir, name);
  execFileSync('cc', ['-O0', '-o', out, source]);
  return out;
}

test('the smoke exec reads 134 as started, 137 as refused, anything else as not an XPC service', { skip: !tooling && 'needs macOS and cc' }, () => {
  const dir = tempDir('signing-gate-smoke-');
  assert.deepEqual(smokeExec(binary(dir, 'aborts', 'abort();')).code, 134);
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
