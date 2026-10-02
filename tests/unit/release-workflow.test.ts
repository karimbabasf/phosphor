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
//   - a dry run builds, signs and notarizes, and publishes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseWorkflow, type Yaml } from './helpers/workflow-yaml.ts';

const root = new URL('../../', import.meta.url);
const workflow = parseWorkflow(fs.readFileSync(new URL('.github/workflows/release.yml', root), 'utf8'));

type Step = { name?: string; uses?: string; run?: string; if?: string; env?: Record<string, string>; with?: Record<string, Yaml>; 'working-directory'?: string; id?: string };
type Job = { steps: Step[]; environment?: string; permissions?: Record<string, string>; needs?: string | string[]; if?: string; outputs?: Record<string, string>; env?: Record<string, string> };

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
  assert.deepEqual(Object.keys(jobs), ['build', 'sign', 'publish', 'site']);
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
  for (const name of ['publish', 'site']) assert.equal(jobs[name].if, "needs.build.outputs.publish == 'true'", name);
  const attest = jobs.sign.steps.find((step) => step.uses?.startsWith('actions/attest-build-provenance@'));
  assert.equal(attest?.if, "env.PUBLISH == 'true'");
  assert.equal(jobs.sign.env?.PUBLISH, '${{ needs.build.outputs.publish }}');
  for (const name of ['build', 'sign']) assert.doesNotMatch(all(jobs[name]), /gh release|site-upload|BLOB_/, name);
});

test('what the later jobs download is checked against the digests the sign job wrote', () => {
  const sums = jobs.sign.steps.find((step) => step.id === 'sums');
  assert.match(sums?.run ?? '', /shasum -a 256/);
  assert.equal(jobs.sign.outputs?.sums, '${{ steps.sums.outputs.sums }}');
  for (const name of ['publish', 'site']) {
    const steps = jobs[name].steps;
    const take = steps.findIndex((step) => step.uses?.startsWith('actions/download-artifact@'));
    const check = steps.findIndex((step) => /sha256sum --check --strict/.test(step.run ?? ''));
    assert.ok(take >= 0 && check === take + 1, `${name} checks right after it downloads`);
    assert.equal(steps[check].env?.SUMS, '${{ needs.sign.outputs.sums }}');
    assert.ok([jobs[name].needs].flat().includes('sign'));
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
