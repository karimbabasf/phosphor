// The release workflow's job layout is a security boundary: which job holds which secret, and
// what code runs beside it. Secrets reach a job's runner when the job starts, and any process in
// that job can read them, so the line is drawn between jobs, not steps. These parse
// .github/workflows/release.yml and hold it to the layout it promises:
//
//   - a job that holds a signing secret (the keychain, an APPLE_* secret, the update key) runs
//     no npm install, no npx, no cargo and no build, and only the actions it needs;
//   - the jobs that publish hold no Apple secret, no update key and no keychain;
//   - the keychain is deleted by the step right after notarize-mac.sh, whatever happened;
//   - the sign job reads the signing secrets in the `release` environment and the site job the
//     Blob token alone in `release-site`, after the sign job, so a release asks for one approval;
//   - the signed service starts on each Apple silicon macOS GitHub hosts, in a job that holds
//     nothing, before anything is published;
//   - a dry run builds, signs and notarizes, and publishes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseWorkflow, type Yaml } from './helpers/workflow-yaml.ts';
import { tempDir } from './helpers/tmp.ts';

const root = new URL('../../', import.meta.url);
const workflow = parseWorkflow(fs.readFileSync(new URL('.github/workflows/release.yml', root), 'utf8'));

type Step = { name?: string; uses?: string; run?: string; if?: string; env?: Record<string, string>; with?: Record<string, Yaml>; 'working-directory'?: string; id?: string };
type Job = {
  steps: Step[];
  environment?: string;
  permissions?: Record<string, string>;
  needs?: string | string[];
  if?: string;
  outputs?: Record<string, string>;
  env?: Record<string, string>;
  'runs-on'?: string;
  strategy?: { 'fail-fast'?: boolean; matrix?: Record<string, Yaml> };
};

const jobs = workflow.jobs as unknown as Record<string, Job>;
const all = (job: Job) => JSON.stringify(job);
const secretsOf = (value: unknown) => new Set([...JSON.stringify(value).matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]));
const SIGNING_SECRET = /^(APPLE_|TAURI_SIGNING_)/;
const KEYCHAIN = /create-keychain|security import|unlock-keychain|SIGN_KEYCHAIN|signing\.keychain/;
const holdsSigning = (job: Job) => [...secretsOf(job)].some((name) => SIGNING_SECRET.test(name)) || KEYCHAIN.test(all(job));

// What installing or building looks like in a run block: a package manager or a compiler where a
// command starts (after a line break, ;, &&, ||, |, (, $(, then, do, else, env or assignments),
// or Tauri's build anywhere. Words inside an echoed sentence are not commands.
const TOOLS = 'npm|npx|yarn|pnpm|bun|cargo|rustc|swiftc|xcodebuild|make|cmake|gem|pip3?|brew';
const INSTALLS_OR_BUILDS = [
  new RegExp(String.raw`(?:^|[;&|(]|\$\(|\b(?:then|do|else)\b)\s*(?:\w+=\S*\s+)*(?:${TOOLS})\b`, 'm'),
  new RegExp(String.raw`\b(?:env|exec|xargs|sudo|time|nice)\b[^\n;&|]*\s(?:${TOOLS})\b`, 'm'),
  /\btauri\s+build\b/,
];
const runs = (job: Job) => job.steps.map((step) => step.run ?? '').join('\n');
// The only actions a signing job may run: they move files, set up Node, or attest.
const SIGNING_ACTIONS = /^actions\/(checkout|setup-node|download-artifact|upload-artifact|attest-build-provenance)@[0-9a-f]{40}$/;

test('the install and build detector sees commands and not sentences', () => {
  const seen = (run: string) => INSTALLS_OR_BUILDS.some((pattern) => pattern.test(run));
  for (const run of ['npm ci --ignore-scripts', 'echo hi\nnpx tauri signer sign x', 'FOO=1 npm run bundle', '(cd src-tauri && cargo test)', 'x=$(brew --prefix)', 'if true; then make; fi', 'env -u A npm install', 'npx --no-install tauri build']) {
    assert.ok(seen(run), run);
  }
  for (const run of ['echo "With the GitHub CLI (`brew install gh`):"', 'node scripts/updater-sign.ts x', 'tar -czf bundle.tar.gz -C dir macos/Phosphor.app']) {
    assert.ok(!seen(run), run);
  }
});

test('the workflow parses to the jobs it describes', () => {
  assert.deepEqual(Object.keys(jobs), ['build', 'sign', 'smoke', 'publish', 'site']);
  for (const job of Object.values(jobs)) assert.ok(Array.isArray(job.steps) && job.steps.length > 0);
});

test('no job that holds a signing secret installs, builds or runs code it did not write', () => {
  const signing = Object.entries(jobs).filter(([, job]) => holdsSigning(job));
  assert.deepEqual(signing.map(([name]) => name), ['sign'], 'only the sign job can sign');
  for (const [name, job] of signing) {
    for (const step of job.steps) {
      const label = `${name}: ${step.name ?? step.uses}`;
      for (const pattern of INSTALLS_OR_BUILDS) assert.doesNotMatch(step.run ?? '', pattern, label);
      if (step.uses) {
        assert.match(step.uses, SIGNING_ACTIONS, label);
        if (step.uses.startsWith('actions/setup-node@')) assert.equal(step.with?.cache, undefined, `${label}: no package cache`);
      }
    }
    // The scripts it runs import nothing but Node's own modules, directly or through a script
    // beside them that does the same.
    const scripts = new Set([...runs(job).matchAll(/(?:^|[\s;&|(])node (scripts\/[\w./-]+)/gm)].map((m) => m[1]));
    assert.ok(scripts.has('scripts/updater-sign.ts') && scripts.has('scripts/release-manifest.ts') && scripts.has('scripts/release-check.ts'));
    const read = new Set<string>();
    const walk = (script: string): void => {
      if (read.has(script)) return;
      read.add(script);
      const source = fs.readFileSync(new URL(script, root), 'utf8');
      const imports = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
      assert.ok(imports.length > 0, script);
      for (const name of imports) {
        if (/^\.\/[\w-]+\.ts$/.test(name)) walk(script.replace(/[^/]+$/, '') + name.slice(2));
        else assert.match(name, /^node:/, `${script} imports ${name}`);
      }
    };
    for (const script of scripts) walk(script);
    assert.ok(read.has('scripts/payload-digest.ts'), 'the release check reads the digest rule the bundler wrote');
    assert.ok(read.has('scripts/signing-gate.ts'), 'and runs the signing gate notarize-mac.sh runs, held to the same imports');
    assert.match(all(job), /bash scripts\/notarize-mac\.sh/);
    assert.doesNotMatch(fs.readFileSync(new URL('scripts/notarize-mac.sh', root), 'utf8'), /\bnpx\b|\bnpm\b|tauri signer|TAURI_SIGNING/);
  }
});

test('the build job holds no secret, no keychain and no write permission', () => {
  const build = jobs.build;
  assert.deepEqual([...secretsOf(build)], []);
  assert.doesNotMatch(all(build), KEYCHAIN);
  assert.equal(build.environment, undefined);
  assert.deepEqual(build.permissions, { contents: 'read' });
});

test('the jobs that publish hold no Apple secret, no update key and no keychain', () => {
  for (const name of ['publish', 'site']) {
    const job = jobs[name];
    assert.deepEqual([...secretsOf(job)].filter((secret) => SIGNING_SECRET.test(secret)), [], name);
    assert.doesNotMatch(all(job), KEYCHAIN, name);
  }
  assert.deepEqual([...secretsOf(jobs.publish)], []);
  assert.deepEqual([...secretsOf(jobs.site)], ['BLOB_READ_WRITE_TOKEN']);
  // The site job installs the uploader from its own lockfile, and the token is the only secret
  // any job that runs npm can reach.
  const install = jobs.site.steps.find((step) => /\bnpm ci\b/.test(step.run ?? ''));
  assert.equal(install?.['working-directory'], 'scripts/site-upload');
  assert.match(install?.run ?? '', /--ignore-scripts/);
  assert.ok(fs.existsSync(new URL('scripts/site-upload/package-lock.json', root)));
  for (const [name, job] of Object.entries(jobs)) {
    if (/\bnpm\s+(ci|install)\b/.test(all(job))) assert.ok([...secretsOf(job)].every((secret) => secret === 'BLOB_READ_WRITE_TOKEN'), name);
  }
});

test('the keychain is deleted by the step right after notarize-mac.sh, whatever happened', () => {
  const steps = jobs.sign.steps;
  const made = steps.findIndex((step) => /security create-keychain/.test(step.run ?? ''));
  const notarize = steps.findIndex((step) => /scripts\/notarize-mac\.sh/.test(step.run ?? ''));
  assert.ok(made >= 0 && notarize > made);
  assert.equal(steps[notarize].if, undefined, 'notarizing always runs');
  const gone = steps[notarize + 1];
  assert.equal(gone.if, 'always()');
  assert.match(gone.run ?? '', /security delete-keychain "\$SIGN_KEYCHAIN"/);
  assert.match(gone.run ?? '', /rm -f "\$RUNNER_TEMP\/AuthKey\.p8"/);
  // Nothing after it reaches the keychain or an Apple secret.
  for (const step of steps.slice(notarize + 2)) {
    assert.doesNotMatch(JSON.stringify(step), /SIGN_KEYCHAIN|secrets\.APPLE_/, step.name ?? '');
  }
});

test('the update key is read by one step, after the keychain is gone, and that step runs Node alone', () => {
  const readers = Object.entries(jobs).flatMap(([name, job]) =>
    job.steps.filter((step) => /TAURI_SIGNING_PRIVATE_KEY/.test(JSON.stringify(step))).map((step) => ({ name, step })),
  );
  assert.equal(readers.length, 1);
  const [{ name, step }] = readers;
  assert.equal(name, 'sign');
  const steps = jobs.sign.steps;
  assert.ok(steps.indexOf(step) > steps.findIndex((s) => /security delete-keychain/.test(s.run ?? '')));
  assert.match(step.run ?? '', /^node scripts\/updater-sign\.ts "[^"]+"$/);
  assert.equal(jobs.sign.env?.TAURI_SIGNING_PRIVATE_KEY, undefined, 'never at job level');
});

test('the signing secrets are read in `release` and the Blob token alone in `release-site`, after the sign job: one approval per release', () => {
  const named = Object.fromEntries(Object.entries(jobs).flatMap(([name, job]) => (job.environment === undefined ? [] : [[name, job.environment]])));
  assert.deepEqual(named, { sign: 'release', site: 'release-site' });
  for (const [name, job] of Object.entries(jobs)) {
    assert.equal(job.environment !== undefined, secretsOf(job).size > 0, `${name} reads a secret exactly when it names an environment`);
  }
  assert.ok([...secretsOf(jobs.sign)].every((secret) => SIGNING_SECRET.test(secret)), 'the sign job reads signing secrets only');
  assert.deepEqual([...secretsOf(jobs.site)], ['BLOB_READ_WRITE_TOKEN']);
  // `release-site` asks for no approval, so its job may start only after the approved sign job.
  const needs = [jobs.site.needs ?? []].flat();
  assert.ok(needs.includes('sign') && needs.includes('publish'), 'the site job needs the sign and publish jobs');
  assert.equal(workflow.env, undefined, 'no workflow-level env for a secret to hide in');
});

test('a dry run builds, signs and notarizes, and publishes nothing', () => {
  const on = workflow.on as Record<string, Record<string, Record<string, Record<string, Yaml>>>>;
  assert.deepEqual(on.push, { tags: ['v*'] });
  assert.deepEqual(on.workflow_dispatch.inputs.dry_run, { description: 'Build, sign and notarize, and publish nothing', type: 'boolean', default: true });
  const version = jobs.build.steps.find((step) => step.id === 'version');
  assert.equal(version?.env?.DRY_RUN, '${{ inputs.dry_run }}');
  // publish turns true only inside the tag branch, and only when this is not a dry run.
  assert.match(version?.run ?? '', /\npublish=false\nif \[ "\$GITHUB_REF_TYPE" = tag \]; then\n[\s\S]*\n {2}if \[ "\$DRY_RUN" != true \]; then publish=true; fi\nfi\n/);
  assert.equal(jobs.build.outputs?.publish, '${{ steps.version.outputs.publish }}');
  assert.equal(jobs.sign.if, undefined, 'a dry run signs and notarizes');
  assert.equal(jobs.smoke.if, undefined, 'and starts the service on every macOS');
  for (const name of ['publish', 'site']) assert.equal(jobs[name].if, "needs.build.outputs.publish == 'true'", name);
  const attest = jobs.sign.steps.find((step) => step.uses?.startsWith('actions/attest-build-provenance@'));
  assert.equal(attest?.if, "env.PUBLISH == 'true'");
  assert.equal(jobs.sign.env?.PUBLISH, '${{ needs.build.outputs.publish }}');
  for (const name of ['build', 'sign', 'smoke']) assert.doesNotMatch(all(jobs[name]), /gh release|site-upload|BLOB_/, name);
});

test('what the later jobs download is checked against the digests the sign job wrote', () => {
  const sums = jobs.sign.steps.find((step) => step.id === 'sums');
  assert.match(sums?.run ?? '', /shasum -a 256/);
  assert.equal(jobs.sign.outputs?.sums, '${{ steps.sums.outputs.sums }}');
  // macOS has shasum where Ubuntu has sha256sum; both read the sign job's lines.
  for (const name of ['smoke', 'publish', 'site']) {
    const steps = jobs[name].steps;
    const take = steps.findIndex((step) => step.uses?.startsWith('actions/download-artifact@'));
    const check = steps.findIndex((step) => /(?:sha256sum|shasum -a 256) --check --strict/.test(step.run ?? ''));
    assert.ok(take >= 0 && check === take + 1, `${name} checks right after it downloads`);
    assert.equal(steps[check].env?.SUMS, '${{ needs.sign.outputs.sums }}');
    assert.ok([jobs[name].needs].flat().includes('sign'));
  }
});

test('the signed service is started on each Apple silicon macOS GitHub hosts, by a job that holds nothing, before anything is published', () => {
  const smoke = jobs.smoke;
  assert.deepEqual([...secretsOf(smoke)], []);
  assert.equal(smoke.environment, undefined, 'no environment, so no approval to wait for');
  assert.deepEqual(smoke.permissions, {});
  assert.doesNotMatch(all(smoke), KEYCHAIN);
  for (const step of smoke.steps) {
    for (const pattern of INSTALLS_OR_BUILDS) assert.doesNotMatch(step.run ?? '', pattern, `smoke: ${step.name}`);
    if (step.uses) assert.match(step.uses, /^actions\/download-artifact@[0-9a-f]{40}$/, `smoke: ${step.name}`);
  }
  // The build is aarch64 alone and the -intel and -large labels are x64, so every leg is a plain
  // macos-<n> label: the one the sign job checked on and at least one older, each run to the end.
  assert.equal(jobs.build.env?.TARGET, 'aarch64-apple-darwin');
  assert.equal(smoke['runs-on'], '${{ matrix.os }}');
  const labels = smoke.strategy?.matrix?.os;
  assert.ok(Array.isArray(labels) && labels.length > 0, 'a list of runners');
  const major = (label: Yaml): number => {
    const found = /^macos-(\d+)$/.exec(String(label));
    assert.ok(found, `${label} is not an Apple silicon runner`);
    return Number(found[1]);
  };
  const signedOn = major(jobs.sign['runs-on'] ?? '');
  assert.ok(labels.map(major).includes(signedOn), 'the macOS the sign job checked on');
  assert.ok(labels.map(major).some((version) => version < signedOn), 'and an older one');
  assert.equal(smoke.strategy?.['fail-fast'], false, 'every leg reports');
  assert.ok([smoke.needs].flat().includes('sign'));
  assert.ok([jobs.publish.needs].flat().includes('smoke'), 'publishing waits for every leg');
  // Both apps that ship: the one in the DMG and the one in the update.
  const run = runs(smoke);
  assert.match(run, /^smoke "\$RUNNER_TEMP\/dmg\/Phosphor\.app" "the DMG" \|\| failed=1$/m);
  assert.match(run, /^smoke "\$RUNNER_TEMP\/update\/Phosphor\.app" "the update" \|\| failed=1$/m);
  assert.match(run, /^exit "\$failed"$/m);
});

/* The step's own function, run the way Actions runs a step, against stand-in services. The
   stand-ins exit with the code rather than die of the signal: bash reads both the same, and an
   abort leaves a crash report on every run (tests/unit/signing-gate.test.ts says why). */
test('the smoke step passes a service that reaches xpc_main and fails every other start', { skip: process.platform !== 'darwin' && 'needs macOS plutil' }, () => {
  const fn = /^smoke\(\) \{\n[\s\S]*?\n\}$/m.exec(runs(jobs.smoke))?.[0];
  assert.ok(fn, 'the step defines smoke()');
  const dir = tempDir('release-smoke-');
  let apps = 0;
  const start = (program: string) => {
    apps += 1;
    const app = path.join(dir, `app-${apps}`, 'Phosphor.app');
    const service = path.join(app, 'Contents', 'XPCServices', 'com.karimbabasf.phosphor.vault.xpc', 'Contents');
    fs.mkdirSync(path.join(service, 'MacOS'), { recursive: true });
    fs.writeFileSync(path.join(service, 'Info.plist'), '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleExecutable</key><string>se-helper</string></dict></plist>\n');
    fs.writeFileSync(path.join(service, 'MacOS', 'se-helper'), `#!/bin/sh\n${program}\n`, { mode: 0o755 });
    const script = `${fn}\nfailed=0\nsmoke "$1" "the stand-in" || failed=1\nexit "$failed"\n`;
    return spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script, 'smoke', app], { encoding: 'utf8', env: { ...process.env, RUNNER_TEMP: dir } });
  };
  const said = "echo 'An XPC Service cannot be run directly.' >&2";

  const started = start(`${said}\nexit 134`);
  assert.equal(started.status, 0, started.stderr);
  assert.match(started.stdout, /the stand-in: the vault service run by hand gave 134: An XPC Service cannot be run directly\./);

  const refused = [
    [`kill -KILL $$`, /AMFI refused the vault service on macOS [\d.]+: it was killed before main/],
    [`echo 'dyld[71]: Symbol not found: _swift_task_create' >&2\nexit 134`, /dyld could not start the vault service/],
    [`exit 134`, /did not reach xpc_main/],
    [`${said}\nexit 0`, /did not reach xpc_main/],
    [`exit 0`, /did not reach xpc_main/],
  ] as const;
  for (const [program, why] of refused) {
    const result = start(program);
    assert.equal(result.status, 1, program);
    assert.match(result.stderr, why, program);
  }
});

test('the unsigned build is held to the checkout before any key is in the sign job, and both shipped apps again after', () => {
  const steps = jobs.sign.steps;
  const at = (name: string) => steps.findIndex((step) => step.name === name);
  const unpack = at('Unpack the unsigned build');
  const before = steps.findIndex((step) => /^node scripts\/release-check\.ts --app "src-tauri\/target\/\$TARGET\/release\/bundle\/macos\/Phosphor\.app" --checkout \. --stage built$/m.test(step.run ?? ''));
  const keychain = at('The signing keychain and the notarization credentials');
  const notarize = at('Sign, notarize and staple the app and the DMG');
  assert.ok(unpack >= 0 && before === unpack + 1, 'the check runs on the build as soon as it is unpacked');
  assert.ok(before < keychain && keychain < notarize, 'and before the keychain exists');
  assert.equal(secretsOf(steps[before]).size, 0, 'the check holds no secret');
  assert.equal(steps[before].if, undefined, 'the check always runs');

  const verify = steps.find((step) => step.name === "The app and the DMG pass Gatekeeper, and the update passes the installed app's check")?.run ?? '';
  const inDmg = verify.indexOf('node scripts/release-check.ts --app "$RUNNER_TEMP/dmg/Phosphor.app" --checkout . --stage signed || { hdiutil detach "$RUNNER_TEMP/dmg"; exit 1; }');
  const detach = verify.indexOf('hdiutil detach "$RUNNER_TEMP/dmg"\n');
  const unpacked = verify.indexOf('tar -xzf "$tarball" -C "$RUNNER_TEMP/update"');
  const inUpdate = verify.indexOf('node scripts/release-check.ts --app "$RUNNER_TEMP/update/Phosphor.app" --checkout . --stage signed');
  assert.ok(inDmg >= 0 && inDmg < detach, 'the app in the DMG is checked while the DMG is mounted');
  assert.ok(unpacked >= 0 && inUpdate > unpacked, 'the app in the update is checked once it is unpacked');
});

test('npm run bundle runs before the shell compiles, so a digest it writes is compiled in', () => {
  const steps = jobs.build.steps;
  const bundle = steps.findIndex((step) => /^npm run bundle$/m.test(step.run ?? ''));
  const cargo = steps.findIndex((step) => /cargo test/.test(step.run ?? ''));
  const tauri = steps.findIndex((step) => /npx tauri build/.test(step.run ?? ''));
  assert.ok(bundle >= 0 && bundle < cargo && cargo < tauri);
});

test('permissions are per job: only the sign job mints an OIDC token, only publish writes', () => {
  assert.deepEqual(workflow.permissions, {});
  const holding = (scope: string, level: string) => Object.entries(jobs).filter(([, job]) => job.permissions?.[scope] === level).map(([name]) => name);
  assert.deepEqual(holding('id-token', 'write'), ['sign']);
  assert.deepEqual(holding('contents', 'write'), ['publish']);
  for (const [name, job] of Object.entries(jobs)) assert.ok(job.permissions, `${name} states its permissions`);
});

test('every action is pinned to a commit', () => {
  for (const [name, job] of Object.entries(jobs)) {
    for (const step of job.steps) if (step.uses) assert.match(step.uses, /@[0-9a-f]{40}$/, `${name}: ${step.uses}`);
  }
});
