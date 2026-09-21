// The table: one line per row, pass or fail, and the counts. Printed to the terminal and
// written as markdown beside the run's JSON, so the same text is the evidence in the report.

export type RowStatus = 'pass' | 'fail' | 'unreachable';

export type RowResult = {
  id: string;
  failure: boolean;
  flow: boolean;
  status: RowStatus;
  // Why it failed, or why it could not be reached. Empty on a pass.
  reason: string;
  median: number | null;
  max: number | null;
  votes: number;
  samples: number;
  // The single worst screenshot this row produced, by its highest vote.
  worst: { file: string; total: number } | null;
  // Leg b, on the flow rows only.
  flowResult?: FlowResult;
};

export type FlowResult = {
  reached: boolean;
  steps: number;
  minimum: number;
  wrongClicks: number;
  blocked: boolean;
  pass: boolean;
  note: string;
};

export type Counts = { rows: number; pass: number; fail: number; unreachable: number; judged: number; maxMedian: number | null; meanMedian: number | null };

export function counts(rows: RowResult[]): Counts {
  const medians = rows.filter((r) => r.median !== null && Number.isFinite(r.median)).map((r) => r.median as number);
  return {
    rows: rows.length,
    pass: rows.filter((r) => r.status === 'pass').length,
    fail: rows.filter((r) => r.status === 'fail').length,
    unreachable: rows.filter((r) => r.status === 'unreachable').length,
    judged: medians.length,
    maxMedian: medians.length === 0 ? null : Math.max(...medians),
    meanMedian: medians.length === 0 ? null : Math.round((medians.reduce((a, b) => a + b, 0) / medians.length) * 100) / 100,
  };
}

function num(value: number | null): string {
  return value === null || !Number.isFinite(value) ? '' : String(value);
}

function flowCell(flow: FlowResult | undefined): string {
  if (flow === undefined) return '';
  const parts = [`${flow.reached ? 'reached' : 'not reached'}`, `${flow.steps}/${flow.minimum} steps`, `${flow.wrongClicks} wrong`];
  if (flow.blocked) parts.push('blocked');
  return `${flow.pass ? 'pass' : 'fail'}: ${parts.join(', ')}`;
}

/* The three worst screenshots across the run, by the highest single vote and then the median,
   for the report: the pictures a reader should open first. */
export function worstThree(rows: RowResult[]): Array<{ id: string; file: string; total: number }> {
  return rows
    .filter((r) => r.worst !== null)
    .map((r) => ({ id: r.id, file: (r.worst as { file: string }).file, total: (r.worst as { total: number }).total, median: r.median ?? 0 }))
    .sort((a, b) => b.total - a.total || b.median - a.median || a.id.localeCompare(b.id))
    .slice(0, 3)
    .map(({ id, file, total }) => ({ id, file, total }));
}

export function markdownTable(rows: RowResult[], meta: { judge: string; runs: number; folder: string }): string {
  const c = counts(rows);
  const lines: string[] = [];
  lines.push(`| row | result | median | max vote | votes | samples | leg b | note |`);
  lines.push(`|---|---|---|---|---|---|---|---|`);
  for (const r of rows) {
    const result = r.status === 'unreachable' ? 'not reachable' : r.status;
    const note = r.status === 'unreachable' ? r.reason : r.reason;
    lines.push(`| ${r.id}${r.failure ? ' (F)' : ''} | ${result} | ${num(r.median)} | ${num(r.max)} | ${r.votes} | ${r.samples} | ${flowCell(r.flowResult)} | ${note.replace(/\|/g, '\\|')} |`);
  }
  lines.push('');
  lines.push(
    `${c.rows} rows: ${c.pass} pass, ${c.fail} fail, ${c.unreachable} not reachable in demo. ` +
      `${c.judged} judged; max median ${num(c.maxMedian)}, mean median ${num(c.meanMedian)}. Judge: ${meta.judge}. Runs: ${meta.runs}. Folder: ${meta.folder}`,
  );
  const worst = worstThree(rows);
  if (worst.length > 0) lines.push(`Worst screenshots: ${worst.map((w) => `${w.id} (${w.total}) ${w.file}`).join('; ')}`);
  return lines.join('\n');
}

export function consoleTable(rows: RowResult[], meta: { judge: string; runs: number; folder: string }): string {
  const c = counts(rows);
  const lines: string[] = [];
  lines.push('='.repeat(100));
  lines.push(`${'row'.padEnd(9)}${'result'.padEnd(15)}${'median'.padEnd(8)}${'max'.padEnd(6)}${'votes'.padEnd(7)}${'leg b'.padEnd(34)}note`);
  lines.push('-'.repeat(100));
  for (const r of rows) {
    const result = r.status === 'unreachable' ? 'not reachable' : r.status;
    lines.push(
      `${`${r.id}${r.failure ? ' F' : ''}`.padEnd(9)}${result.padEnd(15)}${num(r.median).padEnd(8)}${num(r.max).padEnd(6)}${String(r.votes).padEnd(7)}${flowCell(r.flowResult).slice(0, 33).padEnd(34)}${r.reason.slice(0, 60)}`,
    );
  }
  lines.push('='.repeat(100));
  lines.push(`${c.rows} rows: ${c.pass} pass, ${c.fail} fail, ${c.unreachable} not reachable in demo; judge ${meta.judge}; ${meta.runs} run(s); ${meta.folder}`);
  return lines.join('\n');
}
