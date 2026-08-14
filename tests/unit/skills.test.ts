// The skills loader: which files exist, which are live, and the two ways a name can be a lie.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { enabledSkills, listSkills, readSkill, skillsInstruction } from '../../src/skills.ts';

function fixture(config: unknown, files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-skills-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
  fs.mkdirSync(path.join(root, 'skills'), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, 'skills', name), body);
  }
  return root;
}

const ANALYSIS = '# Phosphor analysis\n\nLevels first, indicators last.\n';

test('an installed skill that is not listed is off, and its body is refused', () => {
  const root = fixture({ skills: [] }, { 'phosphor-analysis.md': ANALYSIS });
  assert.deepEqual(enabledSkills(root), []);
  assert.deepEqual(listSkills(root), [
    { name: 'phosphor-analysis', title: 'Phosphor analysis', enabled: false },
  ]);
  // Installed is not enabled. Reading the body of a skill the operator turned off would make
  // the config a suggestion rather than a switch.
  assert.equal(readSkill(root, 'phosphor-analysis'), null);
});

test('a listed skill is live and its body comes back whole', () => {
  const root = fixture({ skills: ['phosphor-analysis'] }, { 'phosphor-analysis.md': ANALYSIS });
  const found = readSkill(root, 'phosphor-analysis');
  assert.equal(found?.title, 'Phosphor analysis');
  assert.equal(found?.body, ANALYSIS);
});

test('the title comes from the first heading, and falls back to the file name', () => {
  const root = fixture({ skills: ['a', 'b'] }, { 'a.md': 'no heading here\n', 'b.md': '# Real Title\n' });
  const byName = Object.fromEntries(listSkills(root).map((s) => [s.name, s.title]));
  assert.equal(byName.a, 'a');
  assert.equal(byName.b, 'Real Title');
});

test('README.md is documentation, not a skill', () => {
  const root = fixture({ skills: [] }, { 'README.md': '# How to\n', 'real.md': '# Real\n' });
  assert.deepEqual(listSkills(root).map((s) => s.name), ['real']);
});

test('a name that could escape the skills directory is refused, never sanitised', () => {
  const root = fixture({ skills: ['../../etc/passwd', 'ok'] }, { 'ok.md': '# Ok\n' });
  // The traversal name is dropped at the config boundary, so it never reaches a path join.
  assert.deepEqual(enabledSkills(root), ['ok']);
  assert.equal(readSkill(root, '../../etc/passwd'), null);
  assert.equal(readSkill(root, 'ok/../../../etc/passwd'), null);
});

test('config.local.json wins over the committed template', () => {
  const root = fixture({ skills: ['phosphor-analysis'] }, { 'phosphor-analysis.md': ANALYSIS });
  fs.writeFileSync(path.join(root, 'config.local.json'), JSON.stringify({ skills: [] }));
  assert.deepEqual(enabledSkills(root), []);
});

test('a non-array skills value is no skills, not a crash', () => {
  for (const value of ['phosphor-analysis', 42, null, { a: 1 }]) {
    const root = fixture({ skills: value }, { 'phosphor-analysis.md': ANALYSIS });
    assert.deepEqual(enabledSkills(root), []);
  }
});

test('an unparseable config leaves the other file deciding', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-skills-'));
  fs.writeFileSync(path.join(root, 'config.json'), '{ not json');
  fs.writeFileSync(path.join(root, 'config.local.json'), JSON.stringify({ skills: ['ok'] }));
  fs.mkdirSync(path.join(root, 'skills'));
  fs.writeFileSync(path.join(root, 'skills', 'ok.md'), '# Ok\n');
  assert.deepEqual(enabledSkills(root), ['ok']);
});

test('no skills directory at all is an empty list, not a throw', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-skills-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ skills: ['ghost'] }));
  assert.deepEqual(listSkills(root), []);
  assert.equal(readSkill(root, 'ghost'), null);
});

test('nothing enabled adds nothing to the handshake, because that text is paid every session', () => {
  const root = fixture({ skills: [] }, { 'phosphor-analysis.md': ANALYSIS });
  assert.equal(skillsInstruction(root), '');
});

test('the handshake line names what is on and where to get it, and stays one line', () => {
  const root = fixture({ skills: ['phosphor-analysis'] }, { 'phosphor-analysis.md': ANALYSIS });
  const text = skillsInstruction(root);
  assert.match(text, /SKILLS ENABLED/);
  assert.match(text, /phosphor-analysis/);
  assert.match(text, /Phosphor analysis/);
  assert.match(text, /`skill` tool/);
  // The body must not ride along: it is loaded on demand, not charged to every session.
  assert.ok(!text.includes('Levels first'), 'the handshake must not carry the skill body');
  assert.ok(text.split('\n').filter((l) => l.trim()).length === 1, 'one line of text');
});
