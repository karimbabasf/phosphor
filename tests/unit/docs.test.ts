// The user docs describe the version in package.json, and the website is rebuilt from them, so
// a stale page here is a stale page there. Three things go stale silently: the changelog's top
// entry falling behind a version bump, a page the index lists being renamed or removed, and a
// link between pages pointing at a file that is gone. Each is caught here, before a tag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOCS = path.join(ROOT, 'docs');

function read(name: string): string {
  return readFileSync(path.join(DOCS, name), 'utf8');
}

function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version: string };
  return pkg.version;
}

// The first `## ` heading of a markdown file, or null when it has none.
function firstSection(markdown: string): string | null {
  const match = /^## (.+)$/m.exec(markdown);
  return match === null ? null : match[1].trim();
}

// The link targets listed as `- [Title](file.md): ...` under one `## ` heading of the index.
function listedPages(markdown: string, heading: string): string[] {
  const section = new RegExp(`^## ${heading}\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm').exec(markdown);
  if (section === null) throw new assert.AssertionError({ message: `docs/README.md has no "## ${heading}" section` });
  const targets: string[] = [];
  for (const line of section[1].split('\n')) {
    const match = /^- \[[^\]]+\]\(([^)]+)\)/.exec(line);
    if (match !== null) targets.push(match[1]);
  }
  assert.ok(targets.length > 0, `"## ${heading}" lists no pages`);
  return targets;
}

// Every relative markdown link target in a page, with its anchor dropped. External links are
// left alone: a URL is not a file this test can check.
function relativeLinks(markdown: string): string[] {
  const out: string[] = [];
  for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = match[1];
    if (/^[a-z]+:/i.test(target) || target.startsWith('#')) continue;
    if (!/\.md(#|$)/.test(target)) continue;
    out.push(target.split('#')[0]);
  }
  return out;
}

/* THE INDEX NAMES A VERSION TOO, and nothing was reading it. docs/README.md said "version
   0.7.0, the version in package.json" while package.json said 0.9.0, and the site is built from
   these files, so the sentence was live and wrong on two releases. The changelog test below
   passed the whole time because it only reads the changelog. A number a person has to remember
   to change is a number that goes stale, so it is pinned here instead. */
test('the docs index names the version in package.json', () => {
  const index = read('README.md');
  const named = /version (\d+\.\d+\.\d+), the version in `package\.json`/.exec(index);
  assert.ok(named, 'docs/README.md no longer names a version the way this test reads it');
  assert.equal(named[1], packageVersion(), `docs/README.md says version ${named[1]} but package.json is ${packageVersion()}`);
});

test('the changelog opens on the version in package.json', () => {
  const top = firstSection(read('changelog.md'));
  assert.equal(top, packageVersion(), `docs/changelog.md starts with "## ${top}" but package.json is ${packageVersion()}`);
});

test('every page the docs index lists exists', () => {
  const index = read('README.md');
  const listed = [...listedPages(index, 'Pages'), ...listedPages(index, 'For developers')];
  for (const target of listed) {
    assert.ok(existsSync(path.join(DOCS, target)), `docs/README.md lists ${target}, which does not exist`);
  }
});

test('every relative link between the docs points at a file that exists', () => {
  const pages = readdirSync(DOCS).filter((name) => name.endsWith('.md'));
  assert.ok(pages.length > 0, 'docs/ holds no markdown pages');
  const broken: string[] = [];
  for (const page of pages) {
    for (const target of relativeLinks(read(page))) {
      if (!existsSync(path.join(DOCS, target))) broken.push(`${page} -> ${target}`);
    }
  }
  assert.deepEqual(broken, [], `broken links: ${broken.join(', ')}`);
});
