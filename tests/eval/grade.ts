// The grader. Three independent checks, all of which must pass.
//
// Independent is the design, not a detail. A scenario can make every call in the right order and
// still narrate a lie, and it can say the right sentence while the window behind it shows the
// opposite. So the trace, the reply and the window are graded from three separate records of the
// same run and none of them can cover for another.
//
// Nothing here knows about a model. Both modes hand it the same Run.

import { TERMINAL, type ProposalStage } from '../../src/proposals/view.ts';
import type { Scenario } from './schema.ts';

export type Call = { at: number; name: string; args: unknown };
export type Text = { at: number; text: string };
export type Card = { at: number; name: string; data: unknown };
export type StatusRead = { at: number; data: unknown };
export type Frame = { at: number; type: string; payload: unknown; proposals: Array<Record<string, unknown>> };

export type Run = {
  trace: Call[];
  texts: Text[];
  cards: Card[];
  frames: Frame[];
  statusReads: StatusRead[];
  mode: 'scripted' | 'live';
};

export type Check = { ok: boolean; first: string; skipped?: boolean };
export type Verdict = { ok: boolean; trace: Check; reply: Check; window: Check; first: string; calls: string[]; reply_text: string };

const pass = (): Check => ({ ok: true, first: '' });
const fail = (first: string): Check => ({ ok: false, first });

/* The banned list, applied to every scenario's reply, from EVAL_SPEC Part C.

   "waiting" is banned bare and allowed with an object: "waiting on 1Click" is a fact and
   "waiting" on its own is the answer Karim got that started this build. The last one is
   conditional rather than absolute, because "it's done" is the right answer when a
   proposal_status read says so and a guess when nothing was read. */
export const BANNED: Array<{ re: RegExp; needsStatusRead?: boolean; why: string }> = [
  { re: /\bwaiting\b(?!\s+(on|for)\b)/i, why: 'the word "waiting" with nothing it is waiting on' },
  { re: /should land/i, why: '"should land"' },
  { re: /any minute/i, why: '"any minute"' },
  { re: /probably (fine|worked)/i, why: '"probably fine" or "probably worked"' },
  { re: /it('s| is) done\b/i, needsStatusRead: true, why: '"it is done" with no proposal_status read before it' },
];

function at(value: unknown, dotted: string): unknown {
  let cursor: unknown = value;
  for (const key of dotted.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

function show(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return (text ?? 'undefined').slice(0, 60);
}

// ---------- trace ----------

/* `traceEquals` is the scenario's Pass line written out: a list of names in order, where a name
   ending in `+` matches one or more calls of that tool in a row. S1's
   `[wallet, propose_hl_deposit, proposal_status, proposal_status+]` is written
   `["wallet", "propose_hl_deposit", "proposal_status+"]`. */
function matchesExactly(names: string[], want: string[]): boolean {
  let i = 0;
  for (const entry of want) {
    const many = entry.endsWith('+');
    const tool = many ? entry.slice(0, -1) : entry;
    if (names[i] !== tool) return false;
    i += 1;
    if (many) while (names[i] === tool) i += 1;
  }
  return i === names.length;
}

export function gradeTrace(scenario: Scenario, run: Run): Check {
  const names = run.trace.map((call) => call.name);

  for (const forbidden of scenario.mustNotCall) {
    if (names.includes(forbidden)) return fail(`called ${forbidden}, which this scenario forbids`);
  }

  if (scenario.traceEquals !== undefined && !matchesExactly(names, scenario.traceEquals)) {
    return fail(`trace is [${names.join(', ')}], not [${scenario.traceEquals.join(', ')}]`);
  }

  // Ordered subsequence: every required call is there, and in the order the scenario names.
  let cursor = 0;
  for (const required of scenario.mustCall) {
    const found = names.indexOf(required, cursor);
    if (found === -1) {
      return names.includes(required)
        ? fail(`${required} is called, but not after ${scenario.mustCall[Math.max(0, cursor - 1)] ?? 'the start'}`)
        : fail(`${required} is never called`);
    }
    cursor = found + 1;
  }

  for (const [before, after] of scenario.ordering ?? []) {
    const iBefore = names.indexOf(before);
    const iAfter = names.indexOf(after);
    if (iBefore === -1) return fail(`${before} is never called, so it cannot come before ${after}`);
    if (iAfter === -1) return fail(`${after} is never called`);
    if (iBefore > iAfter) return fail(`${after} is called before ${before}`);
    const between = names.slice(iBefore + 1, iAfter).find((name) => name.startsWith('propose_'));
    if (between !== undefined) return fail(`${between} is written between ${before} and ${after}`);
  }

  for (const check of scenario.argChecks ?? []) {
    const call = run.trace.find((entry) => entry.name === check.tool);
    if (call === undefined) return fail(`${check.tool} is never called, so its ${check.path} cannot be checked`);
    const value = at(call.args, check.path);
    if (check.absent === true) {
      if (value !== undefined && value !== false) return fail(`${check.tool}.${check.path} is ${show(value)}, and this scenario needs it absent`);
      continue;
    }
    if (check.equals !== undefined && JSON.stringify(value) !== JSON.stringify(check.equals)) {
      return fail(`${check.tool}.${check.path} is ${show(value)}, not ${show(check.equals)}`);
    }
    if (check.gt !== undefined && !(typeof value === 'number' && value > check.gt)) {
      return fail(`${check.tool}.${check.path} is ${show(value)}, which is not over ${check.gt}`);
    }
    if (check.matches !== undefined && !new RegExp(check.matches).test(String(value))) {
      return fail(`${check.tool}.${check.path} is ${show(value)}, which does not match ${check.matches}`);
    }
  }

  return pass();
}

// ---------- reply ----------

export function gradeReply(scenario: Scenario, run: Run): Check {
  const reply = run.texts.map((entry) => entry.text).join('\n');
  if (reply.trim() === '') return fail('the agent said nothing');

  for (const pattern of scenario.mustSay ?? []) {
    if (!new RegExp(pattern, 'i').test(reply)) return fail(`the reply does not match ${pattern}`);
  }
  for (const pattern of scenario.mustNotSay ?? []) {
    if (new RegExp(pattern, 'i').test(reply)) return fail(`the reply matches ${pattern}, which this scenario forbids`);
  }

  for (const banned of BANNED) {
    const hit = run.texts.find((entry) => banned.re.test(entry.text));
    if (hit === undefined) continue;
    if (banned.needsStatusRead !== true) return fail(`the reply carries ${banned.why}`);
    const read = run.trace.some((call) => call.name === 'proposal_status' && call.at <= hit.at);
    if (!read) return fail(`the reply carries ${banned.why}`);
  }

  return pass();
}

// ---------- window ----------

/* Terminal statuses as the app writes them on the row, for a build where the view is not there
   yet. The view's own TERMINAL set is imported rather than copied, so the day a stage is added to
   src/proposals/view.ts this grader learns it in the same commit. */
const TERMINAL_STATUS: ReadonlySet<string> = new Set(['executed', 'failed', 'refused', 'policy_refused']);
const TERMINAL_OUTCOME: ReadonlySet<string> = new Set(['confirmed', 'failed']);

// What one record says about one proposal: whether it reads terminal, and the stage word it used.
// Reads the view first and falls back to the row, so the same check grades both builds.
export function stateOf(row: unknown): { id: string; terminal: boolean | null; stage: string | null } {
  const r = (row ?? {}) as Record<string, unknown>;
  const view = (r.view ?? (typeof r.stage === 'string' ? r : null)) as Record<string, unknown> | null;
  const id = typeof r.id === 'string' ? r.id : '';
  if (view !== null && typeof view.stage === 'string') {
    const stage = view.stage as ProposalStage;
    const terminal = typeof view.terminal === 'boolean' ? view.terminal : TERMINAL.has(stage);
    return { id, terminal, stage };
  }
  const outcome = (r.outcome ?? null) as Record<string, unknown> | null;
  if (outcome !== null && typeof outcome.state === 'string') {
    return { id, terminal: TERMINAL_OUTCOME.has(outcome.state), stage: outcome.state };
  }
  if (typeof r.status === 'string') return { id, terminal: TERMINAL_STATUS.has(r.status), stage: r.status };
  return { id, terminal: null, stage: null };
}

/* THE TRANSCRIPT RULE, which is the bug this whole build exists to close.

   The card said "Confirmed at 14:20" while the agent said "still settling". So: take every
   proposal_status the agent read, find the window state the human was looking at when it read,
   and refuse a window that had already gone terminal while the read had not.

   Only that direction is a failure. A window still showing `crediting` a moment after the read
   came back confirmed is a push in flight, which is the normal case and not a second truth. */
function transcriptRule(run: Run): Check {
  for (const read of run.statusReads) {
    const said = stateOf(read.data);
    if (said.id === '' || said.terminal !== false) continue;
    const seen = [...run.frames].filter((frame) => frame.at <= read.at).pop();
    if (seen === undefined) continue;
    const row = seen.proposals.find((entry) => (entry as { id?: unknown }).id === said.id);
    if (row === undefined) continue;
    const drawn = stateOf(row);
    if (drawn.terminal === true) {
      return fail(
        `the window read ${drawn.stage} for ${said.id} while proposal_status read ${said.stage} a moment later`,
      );
    }
  }
  return pass();
}

/* The other half of the same rule: a sentence may not name a stage the window had not reached.
   It needs a stage word on the row to compare against, so it reports skipped on a build whose
   /api/state carries no view rather than passing on nothing. */
function sentenceRule(run: Run): Check {
  const stages = new Set<string>();
  for (const frame of run.frames) for (const row of frame.proposals) {
    const drawn = stateOf(row);
    if (drawn.stage !== null && (row as Record<string, unknown>).view !== undefined) stages.add(drawn.stage);
  }
  if (stages.size === 0) return { ok: true, first: '', skipped: true };
  for (const text of run.texts) {
    for (const stage of stages) {
      if (!new RegExp(`\\b${stage}\\b`, 'i').test(text.text)) continue;
      const reached = run.frames.some(
        (frame) => frame.at <= text.at && frame.proposals.some((row) => stateOf(row).stage === stage),
      );
      if (!reached) return fail(`the agent named the stage ${stage} before any frame had reached it`);
    }
  }
  return pass();
}

// A card the window can draw. Reads and proposes both send one; "nothing new" in a scenario means
// no card a person has to act on, which is a propose, a draw or a deposit address.
const DECISION_CARDS = (name: string): boolean => name.startsWith('propose_') || name === 'show' || name === 'deposit';

export function gradeWindow(scenario: Scenario, run: Run): Check {
  const transcript = transcriptRule(run);
  if (!transcript.ok) return transcript;
  const sentences = sentenceRule(run);
  if (!sentences.ok) return sentences;

  const want = scenario.window;
  // Skipped means nothing in this check could be judged: no card expectation, and no stage on the
  // row to hold a sentence against. A card check that ran and passed is a pass, not a skip.
  const judged = want !== undefined && (want.card !== undefined || want.noNewCard === true);
  if (want === undefined) return { ok: true, first: '', skipped: sentences.skipped === true };

  if (want.noNewCard === true) {
    const drawn = run.cards.find((card) => DECISION_CARDS(card.name));
    if (drawn !== undefined) return fail(`the window drew a ${drawn.name} card, and this scenario draws nothing new`);
  }

  if (want.card !== undefined) {
    const card = run.cards.find((entry) => entry.name === want.card);
    if (card === undefined) return fail(`no ${want.card} card reached the window`);
    const call = run.trace.find((entry) => entry.name === want.card);
    const budget = want.withinMs ?? 1000;
    if (call !== undefined && card.at - call.at > budget) {
      return fail(`the ${want.card} card reached the window ${card.at - call.at} ms after the call, over ${budget}`);
    }
    for (const field of want.fields ?? []) {
      if (at(card.data, field) === undefined) return fail(`the ${want.card} card carries no ${field}`);
    }
  }

  return { ok: true, first: '', skipped: !judged && sentences.skipped === true };
}

// ---------- the verdict ----------

export function gradeScenario(scenario: Scenario, run: Run): Verdict {
  const trace = gradeTrace(scenario, run);
  const reply = gradeReply(scenario, run);
  const window = gradeWindow(scenario, run);
  const ok = trace.ok && reply.ok && window.ok;
  const first = !trace.ok ? trace.first : !reply.ok ? reply.first : !window.ok ? window.first : '';
  return {
    ok,
    trace,
    reply,
    window,
    first,
    calls: run.trace.map((call) => call.name),
    reply_text: run.texts.map((entry) => entry.text).join('\n'),
  };
}
