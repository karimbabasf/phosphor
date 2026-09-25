// The agent's answer to "what's new": entries of the changelog the app ships with, never memory.

import fs from 'node:fs';
import path from 'node:path';

const MAX_CHARS = 6000; // a few versions; a person asked for news, not the history

function parts(version: string): number[] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])];
}

function newer(a: number[], b: number[]): boolean {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

// `since` is the version they had: every entry after it. Empty or unreadable: the newest entry.
export function whatsNew(root: string, since: string): string {
  let text: string;
  try {
    text = fs.readFileSync(path.join(root, 'docs', 'changelog.md'), 'utf8');
  } catch {
    return 'This copy of Phosphor carries no changelog, so there is nothing to read. The notes are at https://phosphor.money/docs/changelog/.';
  }
  const entries = text.split(/^## /m).slice(1).map((e) => ({ version: e.split('\n', 1)[0].trim(), body: `## ${e.trim()}` }));
  if (entries.length === 0) return 'The changelog has no entries.';
  const from = parts(since);
  const picked = from === null ? entries.slice(0, 1) : entries.filter((e) => {
    const v = parts(e.version);
    return v !== null && newer(v, from);
  });
  if (picked.length === 0) return `Nothing is newer than ${since.trim()}: ${entries[0].version} is the newest version.`;
  const out = picked.map((e) => e.body).join('\n\n');
  return out.length <= MAX_CHARS ? out : `${out.slice(0, MAX_CHARS).trimEnd()}\n\n(cut short; the rest is at https://phosphor.money/docs/changelog/)`;
}
