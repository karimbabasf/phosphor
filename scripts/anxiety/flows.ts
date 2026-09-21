// Leg b: Jev plays the person on the flow rows, through `jev-browse` (typesafe/jev-1.13 on
// OpenRouter, the jev-browse skill), against the same demo backend served in the automation
// Brave. Each flow is one narrow goal list with an end state the page must show, and the score
// is the four numbers the definitions file names: reached (must be yes), steps over the minimum
// (at most 1.5x), wrong clicks (at most 2), blocked or timeout (zero). Every goal stops before
// an approve click: the decision routes need the window token, and the flows here never reach
// one.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import type { FlowResult } from './table.ts';

export type Flow = {
  row: string;
  // Whether this build can offer the flow at all; a false answer is a runtime "not reachable".
  available: () => Promise<{ ok: true } | { ok: false; reason: string }>;
  // The URL Jev starts on. The wallet rows start on Basic; onboarding starts on a fresh app.
  start: (base: string, token: string) => string;
  goals: string[];
  expect: string[];
  // The fewest actions a person needs, counted by hand from the screens.
  minimum: number;
  // What a click on the path looks like; a click on anything else is a wrong click.
  onPath: RegExp[];
  maxSteps?: number;
  timeoutSec?: number;
};

export const MAX_STEPS = 25;
export const STEP_RATIO = 1.5;
export const MAX_WRONG_CLICKS = 2;

export type JevResult = {
  status: string;
  message?: string;
  steps?: number;
  actions?: Array<{ step?: number; operation?: string; target?: string; text?: string | null }>;
  verified?: boolean | null;
  expect_missing?: string[];
  screenshot?: string | null;
  run_dir?: string;
  elapsed_ms?: number;
  cost_usd?: number;
};

// The four numbers, from Jev's own result. Pure, so the test can feed it results by hand.
export function scoreFlow(flow: Pick<Flow, 'minimum' | 'onPath'>, result: JevResult): FlowResult {
  const actions = result.actions ?? [];
  const steps = typeof result.steps === 'number' ? result.steps : actions.length;
  const clicks = actions.filter((a) => /click|tap|press/i.test(String(a.operation ?? '')));
  const wrongClicks = clicks.filter((a) => {
    const label = `${a.target ?? ''} ${a.text ?? ''}`;
    return !flow.onPath.some((re) => re.test(label));
  }).length;
  const blocked = result.status === 'blocked' || result.status === 'budget' || result.status === 'timeout' || result.status === 'error';
  const reached = result.status === 'done' && result.verified === true;
  const overBudget = steps > flow.minimum * STEP_RATIO;
  const reasons: string[] = [];
  if (!reached) reasons.push(result.status === 'done' ? `done but the end page missed ${(result.expect_missing ?? []).join(', ') || 'the expected text'}` : `${result.status}${result.message ? `: ${result.message}` : ''}`);
  if (overBudget) reasons.push(`${steps} steps over ${flow.minimum} x ${STEP_RATIO}`);
  if (wrongClicks > MAX_WRONG_CLICKS) reasons.push(`${wrongClicks} wrong clicks`);
  return {
    reached,
    steps,
    minimum: flow.minimum,
    wrongClicks,
    blocked,
    pass: reached && !overBudget && !blocked && wrongClicks <= MAX_WRONG_CLICKS,
    note: reasons.join('; '),
  };
}

export function runJev(flow: Flow, url: string, log: (line: string) => void): { result: JevResult | null; raw: string } {
  const args = ['--url', url, '--json', '--max-steps', String(flow.maxSteps ?? MAX_STEPS), '--timeout', String(flow.timeoutSec ?? 120), '--close-tab'];
  for (const goal of flow.goals) args.push('--goal', goal);
  for (const expect of flow.expect) args.push('--expect', expect);
  log(`jev-browse ${flow.row}: ${flow.goals.length} goal(s), expecting "${flow.expect.join('", "')}"`);
  const out = spawnSync('jev-browse', args, { encoding: 'utf8', timeout: ((flow.timeoutSec ?? 120) + 60) * 1000 });
  const raw = `${out.stdout ?? ''}${out.stderr ?? ''}`;
  if (out.error !== undefined) return { result: { status: 'error', message: `jev-browse did not start: ${out.error.message}` }, raw };
  const start = (out.stdout ?? '').indexOf('{');
  if (start === -1) return { result: { status: 'error', message: `no JSON from jev-browse (exit ${out.status})` }, raw };
  try {
    return { result: JSON.parse((out.stdout ?? '').slice(start)) as JevResult, raw };
  } catch {
    return { result: { status: 'error', message: `unreadable JSON from jev-browse (exit ${out.status})` }, raw };
  }
}

// Whether `jev-browse` is on this machine at all. Without it leg b is reported as not run.
export function jevAvailable(): boolean {
  const out = spawnSync('sh', ['-c', 'command -v jev-browse'], { encoding: 'utf8' });
  return out.status === 0 && (out.stdout ?? '').trim() !== '';
}

export function writeFlowEvidence(dir: string, row: string, result: JevResult | null, raw: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${dir}/${row}.flow.json`, `${JSON.stringify({ result, raw: raw.slice(0, 20_000) }, null, 2)}\n`);
  if (result?.screenshot && fs.existsSync(result.screenshot)) fs.copyFileSync(result.screenshot, `${dir}/${row}.flow.jpg`);
}
