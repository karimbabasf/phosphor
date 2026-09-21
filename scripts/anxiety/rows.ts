// The situation list, read off docs/superpowers/prompts/2026-09-20-ready-for-people.situations.md.
//
// The file is the list: a row exists because the lead wrote it there, and the harness never
// keeps a second copy. What is parsed off each table row is its id, its group letter, the
// cells in the order the table gives them, and three marks: (F) for a refusal or failure row,
// FLOW for a row Jev also plays, and "not reachable in demo: <reason>", which is the one edit
// this harness makes to the file (never a deletion).

import fs from 'node:fs';

export type Group = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

export type Row = {
  id: string;
  group: Group;
  // The cells after the id, in table order: kind/stage/reach for A, situation/reach otherwise.
  cells: string[];
  // The last cell: how the state is reached, in the lead's words.
  reach: string;
  // A refusal or failure row: the median may reach 4.
  failure: boolean;
  // Leg b as well: Jev plays the person.
  flow: boolean;
  // Marked in the file as not producible against the demo rails, with the reason.
  unreachable: string | null;
};

export const UNREACHABLE_MARK = 'not reachable in demo:';

const ROW = /^\|\s*([A-F]\d{2})\s*\|(.*)\|\s*$/;

export function parseRows(markdown: string): Row[] {
  const rows: Row[] = [];
  let group: Group | null = null;
  for (const line of markdown.split('\n')) {
    const heading = /^##\s+([A-F])\.\s/.exec(line);
    if (heading !== null) group = heading[1] as Group;
    const m = ROW.exec(line);
    if (m === null) continue;
    const id = m[1];
    const cells = m[2].split('|').map((cell) => cell.trim());
    const reach = cells[cells.length - 1] ?? '';
    const text = cells.join(' ');
    const unreachableAt = reach.indexOf(UNREACHABLE_MARK);
    rows.push({
      id,
      group: (group ?? id[0]) as Group,
      cells,
      reach,
      // Every row of group B is a failure or refusal by the heading; elsewhere the (F) mark says so.
      failure: (group ?? id[0]) === 'B' || /\(F\)/.test(text),
      flow: /\bFLOW\b/.test(text),
      unreachable: unreachableAt === -1 ? null : reach.slice(unreachableAt + UNREACHABLE_MARK.length).trim().replace(/\s*\.?$/, '') || 'no reason given',
    });
  }
  return rows;
}

export function loadRows(file: string): Row[] {
  return parseRows(fs.readFileSync(file, 'utf8'));
}

// Card rows get the second shot at 400 px: the two groups whose screenshot is the chat column
// with a move card in it.
export function isCardRow(row: Row): boolean {
  return row.group === 'A' || row.group === 'B';
}

/* Marks a row in the file as not reachable, in place, keeping every other byte. Idempotent: a
   row already carrying the mark keeps its first reason. Returns the new text, or null when
   the row is not in the file. */
export function markUnreachable(markdown: string, id: string, reason: string): string | null {
  const lines = markdown.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const m = ROW.exec(lines[i]);
    if (m === null || m[1] !== id) continue;
    if (lines[i].includes(UNREACHABLE_MARK)) return markdown;
    const cells = m[2].split('|');
    const last = cells.length - 1;
    cells[last] = ` ${cells[last].trim()}; ${UNREACHABLE_MARK} ${reason.trim()} `;
    lines[i] = `| ${id} |${cells.join('|')}|`;
    return lines.join('\n');
  }
  return null;
}
