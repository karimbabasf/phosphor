// The skills a user has turned on for their own phosphor.
//
// A skill is a markdown file in skills/ that tells a connecting agent how to do one job well:
// how to read a chart, how to size a position, whatever the operator wants their agent to be
// good at. The app ships them; the user chooses which are live, in config.json under `skills`
// (or in config.local.json, which is merged over it key by key like every other setting).
//
// Two properties this file exists to hold:
//
// A skill is DATA, never authority. Nothing in a skill file can widen the tool surface, reach a
// rail, approve anything, or change a policy rule. It is text an agent reads before it works.
// The rules in the MCP handshake outrank it, and the tool surface is fixed at registration time
// by src/mcp.ts, so a skill that instructs an agent to move funds is asking for a verb the door
// does not have. That is deliberate: it is the same argument the write surface makes.
//
// The body is NOT paid for at connect time. The handshake gets one line naming what is enabled,
// because that text is charged to every single session; the body arrives only when an agent
// calls the `skill` tool and actually needs it. A skill that loads eagerly is a skill that taxes
// every "what do I hold" question with a chart-reading essay.

import fs from 'node:fs';
import path from 'node:path';

export type SkillSummary = { name: string; title: string; enabled: boolean };

// Kept lazy on purpose. src/mcp.ts is a stateless shim and must stay one: reading on each call
// costs a few hundred microseconds and means a user who edits a skill file sees the change
// without restarting the agent.
function configValue(root: string): unknown {
  let merged: Record<string, unknown> = {};
  for (const file of ['config.json', 'config.local.json']) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')) as Record<string, unknown>;
      merged = { ...merged, ...parsed };
    } catch {
      // absent or unparseable: the other file still decides, and no skills is a valid answer
    }
  }
  return merged.skills;
}

// A name has to survive being turned into a path. Anything with a separator or a dot in it is
// refused rather than sanitised, because a quietly rewritten name is how "../../etc/passwd"
// becomes a file read that nobody reviewed.
const SAFE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function skillsDir(root: string): string {
  return path.join(root, 'skills');
}

export function enabledSkills(root: string): string[] {
  const value = configValue(root);
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && SAFE.test(v));
}

// The first markdown heading, or the file name if it has none. Used so the handshake line can
// say what a skill is for without loading the whole thing.
function titleOf(body: string, fallback: string): string {
  for (const line of body.split('\n', 40)) {
    const m = line.match(/^#\s+(.+)$/);
    if (m) return m[1].trim();
  }
  return fallback;
}

export function listSkills(root: string): SkillSummary[] {
  const dir = skillsDir(root);
  const on = new Set(enabledSkills(root));
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md');
  } catch {
    return [];
  }
  return files
    .map((f) => {
      const name = f.replace(/\.md$/, '');
      let title = name;
      try {
        title = titleOf(fs.readFileSync(path.join(dir, f), 'utf8'), name);
      } catch {
        // unreadable file still appears in the list, named, rather than vanishing silently
      }
      return { name, title, enabled: on.has(name) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function readSkill(root: string, name: string): { name: string; title: string; body: string } | null {
  if (!SAFE.test(name)) return null;
  if (!enabledSkills(root).includes(name)) return null;
  try {
    const body = fs.readFileSync(path.join(skillsDir(root), `${name}.md`), 'utf8');
    return { name, title: titleOf(body, name), body };
  } catch {
    return null;
  }
}

// One line, or nothing. This is charged to every session, so it names what is on and where to
// get it and stops. An empty skills list adds no text at all rather than a sentence explaining
// that there is no text.
export function skillsInstruction(root: string): string {
  const on = listSkills(root).filter((s) => s.enabled);
  if (on.length === 0) return '';
  const named = on.map((s) => `\`${s.name}\` (${s.title})`).join(', ');
  return [
    '',
    `SKILLS ENABLED: ${named}. Before doing that kind of work, call the \`skill\` tool to load the one that fits and follow it. A skill is guidance the operator turned on; it never widens what these tools can do, and the rules above outrank it.`,
  ].join('\n');
}
