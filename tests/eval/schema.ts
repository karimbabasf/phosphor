// What one eval scenario is, on disk and in the harness.
//
// One JSON file per scenario under tests/eval/, ids S1 to S28, matching EVAL_SPEC Part B. The
// file carries three things that cannot be derived: the state the app has to be in before the
// turn (`pre`), the canned turn the scripted mode replays (`script`), and the assertions the
// grader applies to both modes (`mustCall` and everything below it).
//
// The same file drives both modes. Live mode ignores `script` and lets the real agent choose
// its own calls; everything else is graded identically, which is the point: a scenario that
// passes scripted proves the app accepts the calls, and the same scenario passing live proves
// the agent makes them.

import fs from 'node:fs';
import path from 'node:path';

export type EvalMode = 'scripted' | 'live';

// A fixture holding, written into data/demo-state.json of the staged repo before boot.
export type DemoHolding = {
  symbol: string;
  originChain: string;
  assetId: string;
  amount: number;
  decimals: number;
};

export type DemoState = {
  prices?: Record<string, number>;
  account?: string;
  intents?: DemoHolding[];
  hyperliquid?: { collateralUsdc: number; availableUsdc: number };
};

// A line seeded into audit.jsonl before boot. `prev` is computed by the harness so the chain
// holds: a seeded log the app reports as broken is a fixture bug wearing a product bug's face.
export type SeedAuditLine = {
  type: string;
  msg: string;
  data?: unknown;
  // Seconds before the run started. Absent means now.
  agoSec?: number;
};

export type Precondition = {
  demo?: DemoState;
  // Merged over the policy file the app writes on first boot.
  policy?: Record<string, unknown>;
  // Rows written straight into proposals.json. Timestamps carrying `agoSec` are resolved to
  // real ISO stamps at run time, so a scenario that says "40 s elapsed" stays true whenever it
  // runs.
  proposals?: Array<Record<string, unknown>>;
  audit?: SeedAuditLine[];
  /* Lines another agent left on the team board, posted through the app's own door before the
     turn runs. The board lives in memory (src/board.ts), so there is no file to seed and no
     other way to put S27's "the human approved it" line where the agent will read it.
     `label` is the colleague's name; the harness posts under a session of its own. */
  board?: Array<{ text: string; kind?: 'claim' | 'finding' | 'note'; label?: string }>;
  // The finger that clicks approve. The harness plays it once, on the first proposal a propose
  // call creates, and only when the scenario says the user said yes.
  humanClicks?: boolean;
};

export type Step = {
  // Assistant text emitted with this step. The reply the grader reads is every `say` joined.
  say?: string;
  // Bare tool name, without the mcp__phosphor__ prefix.
  tool?: string;
  args?: Record<string, unknown>;
  // Replace the real tool result. Two uses only, both from the spec: a hostile string standing
  // in for a provider's answer (S19, S27), and a proxy error the app cannot be asked to produce
  // on purpose (S23). Anything else is graded against the real server.
  inject?: { error?: string; result?: unknown };
  // Sleep before the step. What lets a click land before the status read that follows it.
  waitMs?: number;
};

export type ArgCheck = {
  tool: string;
  // Dotted path into the call's arguments.
  path: string;
  equals?: unknown;
  gt?: number;
  matches?: string;
  // The argument is absent, or it holds this value. S8's `confirmed` before the yes.
  absent?: boolean;
};

export type WindowExpect = {
  // The tool whose answer the window draws as a card, bare name. `propose_hl_deposit` for the
  // deposit card, `show` once that tool exists.
  card?: string;
  withinMs?: number;
  // Dotted paths the card payload must carry.
  fields?: string[];
  // The scenario's "Window must show: nothing new".
  noNewCard?: boolean;
};

export type Scenario = {
  id: string;
  title: string;
  /* What the human types. A list where the scenario needs a second turn, which is every read-back:
     S1's "yes" after the fee, S8's "yes" after the address. Live mode feeds them one at a time and
     waits for each turn to end. Scripted mode sends only the first, because the canned script
     already carries what the whole exchange came to. */
  userSays: string | string[];
  pre: Precondition;
  // Tools this scenario cannot run without. Absent from the live surface means expected-fail,
  // never fail: the scenario is waiting on a build, not reporting a regression.
  needsTools?: string[];
  /* A build step this scenario waits on that no probe can see: a policy rule still in force, a
     fixture the demo ledger cannot hold. It reads as expected-fail with this line beside it, and
     the commit that lands the step deletes the line. Declared rather than detected, so it is
     deliberately narrow: never put one on a scenario that should pass today. */
  xfailUntil?: string;
  /* The same for the ProposalView. A scenario asserting a stage word, what is being waited on or
     an elapsed figure cannot pass until proposal_status returns the view, so a run before that
     lands reports it expected-fail against `stage` rather than as a regression. */
  needsView?: boolean;
  script: Step[];
  mustCall: string[];
  mustNotCall: string[];
  // The whole trace, in order, when the scenario's Pass line pins it.
  traceEquals?: string[];
  /* A ceiling per tool, for a Pass line that counts rather than orders: S15's "exactly one
     propose_policy_change", S17's rule against splitting a loosening across calls. A scenario
     whose whole trace is pinned does not need one. */
  maxCalls?: Record<string, number>;
  // [before, after] pairs: "reads X before proposing Y".
  ordering?: Array<[string, string]>;
  argChecks?: ArgCheck[];
  // Regex sources applied to the joined assistant text.
  mustSay?: string[];
  mustNotSay?: string[];
  window?: WindowExpect;
  // Scored 0 to 2 by a judge in live mode, skipped in scripted mode.
  rubric?: string;
  // The spec's own Pass line, printed beside a failure so the reader sees the bar.
  pass: string;
};

const REQUIRED = ['id', 'title', 'userSays', 'pre', 'script', 'mustCall', 'mustNotCall', 'pass'] as const;

export function turnsOf(scenario: Scenario): string[] {
  return Array.isArray(scenario.userSays) ? scenario.userSays : [scenario.userSays];
}

export function validate(raw: unknown, source: string): Scenario {
  if (raw === null || typeof raw !== 'object') throw new Error(`${source}: not an object`);
  const s = raw as Record<string, unknown>;
  for (const key of REQUIRED) {
    if (s[key] === undefined) throw new Error(`${source}: missing ${key}`);
  }
  if (!Array.isArray(s.script)) throw new Error(`${source}: script is not a list`);
  if (!Array.isArray(s.mustCall) || !Array.isArray(s.mustNotCall)) {
    throw new Error(`${source}: mustCall and mustNotCall are lists`);
  }
  for (const source_ of ['mustSay', 'mustNotSay'] as const) {
    for (const pattern of (s[source_] as string[] | undefined) ?? []) {
      try {
        new RegExp(pattern, 'i');
      } catch (error) {
        throw new Error(`${source}: ${source_} carries an unreadable regex ${pattern}: ${String(error)}`);
      }
    }
  }
  return raw as Scenario;
}

// Newest-first ids sort as text (S10 before S2), so the number is what orders them.
export function scenarioOrder(id: string): number {
  const match = /^S(\d+)$/.exec(id);
  return match === null ? Number.MAX_SAFE_INTEGER : Number(match[1]);
}

export function loadScenarios(dir: string, only: string[] = []): Scenario[] {
  const files = fs
    .readdirSync(dir)
    .filter((name) => /^S\d+\.json$/.test(name))
    .map((name) => path.join(dir, name));
  const loaded = files.map((file) => {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    const scenario = validate(parsed, path.basename(file));
    if (scenario.id !== path.basename(file, '.json')) {
      throw new Error(`${path.basename(file)}: id is ${scenario.id}, which is not the file's name`);
    }
    return scenario;
  });
  loaded.sort((a, b) => scenarioOrder(a.id) - scenarioOrder(b.id));
  return only.length === 0 ? loaded : loaded.filter((s) => only.includes(s.id));
}
