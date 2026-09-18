// The grader. Three independent checks, all of which must pass.
//
// Independent is the design, not a detail. A scenario can make every call in the right order and
// still narrate a lie, and it can say the right sentence while the window behind it shows the
// opposite. So the trace, the reply and the window are graded from three separate records of the
// same run and none of them can cover for another.
//
// Nothing here knows about a model. Both modes hand it the same Run.

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
export type Verdict = { ok: boolean; trace: Check; reply: Check; window: Check; first: string; calls: string[] };

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

// Built in C3. Until then every scenario reports its window check skipped rather than passing,
// so no scenario can go green on two checks out of three.
export function gradeWindow(_scenario: Scenario, _run: Run): Check {
  return { ok: true, first: '', skipped: true };
}

// ---------- the verdict ----------

export function gradeScenario(scenario: Scenario, run: Run): Verdict {
  const trace = gradeTrace(scenario, run);
  const reply = gradeReply(scenario, run);
  const window = gradeWindow(scenario, run);
  const ok = trace.ok && reply.ok && window.ok;
  const first = !trace.ok ? trace.first : !reply.ok ? reply.first : !window.ok ? window.first : '';
  return { ok, trace, reply, window, first, calls: run.trace.map((call) => call.name) };
}
