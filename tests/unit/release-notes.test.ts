// The release page tells a person how to check what they downloaded: a command, then the line it
// must print. This runs the workflow's own notes step on two stand-in files, then follows the notes
// the way a person would, with a HOME whose Downloads holds those files: every command has to print
// exactly the line the notes promise under it, and every line of SHA256SUMS has its own command.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { checksumLines } from '../../scripts/release-manifest.ts';
import { parseWorkflow } from './helpers/workflow-yaml.ts';
import { tempDir } from './helpers/tmp.ts';

const root = new URL('../../', import.meta.url);
const workflow = parseWorkflow(fs.readFileSync(new URL('.github/workflows/release.yml', root), 'utf8'));
const sign = (workflow.jobs as unknown as Record<string, { steps: { name?: string; run?: string }[] }>).sign;

test('every command in the release notes prints exactly the line the notes promise under it', () => {
  const run = sign.steps.find((step) => step.name === 'Write the release notes')?.run;
  assert.ok(run, 'the sign job writes the release notes');
  const home = tempDir('phosphor-notes-');
  try {
    const version = '9.9.9';
    const downloads = path.join(home, 'Downloads');
    const release = path.join(home, 'release');
    fs.mkdirSync(downloads);
    fs.mkdirSync(release);
    const files = ['Phosphor-macOS-arm64.dmg', `Phosphor_${version}_aarch64.app.tar.gz`].map((name) => {
      const bytes = crypto.randomBytes(4096);
      fs.writeFileSync(path.join(downloads, name), bytes);
      return { name, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
    });
    const sums = checksumLines(files);
    fs.writeFileSync(path.join(release, 'SHA256SUMS'), sums);
    // The shell GitHub runs a step's `run` in.
    execFileSync('/bin/bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', run], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', VERSION: version, RELEASE_DIR: release, RUNNER_TEMP: home },
    });
    const notes = fs.readFileSync(path.join(release, 'notes.md'), 'utf8');

    const pairs = [...notes.matchAll(/```\n(.*shasum -a 256.*)\n```\n\nIt must print exactly:\n\n```\n([\s\S]*?)```/g)].map((m) => ({ command: m[1], promised: m[2] }));
    assert.equal(pairs.length, files.length, 'one command for each file in SHA256SUMS');
    for (const { command, promised } of pairs) {
      const printed = execFileSync('/bin/bash', ['-c', command], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home }, encoding: 'utf8' });
      assert.equal(printed, promised, `${command} prints what the notes promise`);
    }
    assert.deepEqual(pairs.map((pair) => pair.promised).sort(), sums.split(/(?<=\n)/).filter(Boolean).sort(), 'each SHA256SUMS line is promised once');
    // With --repo alone the provenance check passes for a file any workflow in the repository
    // attested, on any branch, so the notes pin the release workflow and this version's tag.
    assert.ok(
      notes.includes(
        'gh attestation verify ~/Downloads/Phosphor-macOS-arm64.dmg --repo karimbabasf/phosphor \\\n' +
          '  --signer-workflow karimbabasf/phosphor/.github/workflows/release.yml \\\n' +
          `  --source-ref refs/tags/v${version}\n`,
      ),
      'the attestation command pins the workflow and the tag',
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
