// The anxiety score, criterion 6 of docs/superpowers/prompts/2026-09-20-ready-for-people.md:
// every situation in docs/superpowers/prompts/2026-09-20-ready-for-people.situations.md, as
// a person who has never bought crypto would see it.
//
// Leg a: a demo backend is booted per scene on a free port with a throwaway data directory,
// the window is opened in the automation Brave, the scripted agent (scripts/anxiety/agent.ts)
// sits in the window's own conversation, each situation is produced (scripts/anxiety/scenes.ts)
// and shot at an 860 px column, card rows once more at 400 px, three runs. A vision judge
// scores every screenshot plus the agent's reply against the rubric copied verbatim from the
// definitions file (scripts/anxiety/judge.ts), three votes, median. A row passes on the median
// of its votes: 3 or under (4 for a refusal or failure row) and no vote 6 or over.
//
// Leg b: Jev plays the person on the flow rows through jev-browse (scripts/anxiety/flows.ts).
//
// Run:  node scripts/anxiety-eval.ts                 the whole list, 3 runs, leg a and leg b
//       node scripts/anxiety-eval.ts --rows A06,B01  some rows
//       node scripts/anxiety-eval.ts --runs 1 --judge none --no-flows   pictures only, fast
//       node scripts/anxiety-eval.ts --width 1280  a narrower window (the column stays 860)
// Output: scripts/scratch/anxiety/<timestamp>/<row>.png, <row>.json, summary.md, summary.json,
// and the table on the terminal. Exit 0 when every judged row and every flow passes.
//
// It runs after every UI, card or role-text change. It touches nothing outside its run folder,
// its temp directories and its own browser windows; the installed app and ~/.phosphor are
// never read. Frozen rule 10: the rubric and the judge prompt are never edited to raise a
// score. A low score is fixed in the product.

import fs from 'node:fs';
import path from 'node:path';
import { STAGE_COPY, type ProposalStage } from '../src/proposals/view.ts';
import { bootApp, errText, makeWallet, ROOT, sleep, stageRepo, stopAll, type App } from './anxiety/app.ts';
import { browserDone, connectBrowser, VIEWPORT, type Browser, type Clip, type Page } from './anxiety/capture.ts';
import { jevAvailable, runJev, scoreFlow, writeFlowEvidence, type Flow } from './anxiety/flows.ts';
import { castVotes, probeJudge, rowVerdict, type Judge, type Vote } from './anxiety/judge.ts';
import { isCardRow, loadRows, type Row } from './anxiety/rows.ts';
import { claimedRows, SCENES, type Sample, type Scene, type SceneCtx } from './anxiety/scenes.ts';
import { consoleTable, counts, markdownTable, worstThree, type FlowResult, type RowResult } from './anxiety/table.ts';

const SITUATIONS = path.join(ROOT, 'docs', 'superpowers', 'prompts', '2026-09-20-ready-for-people.situations.md');
const OUT_ROOT = path.join(ROOT, 'scripts', 'scratch', 'anxiety');

// ---------- arguments ----------

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
}
const ONLY = new Set((flag('--rows') ?? '').split(',').map((s) => s.trim()).filter(Boolean));
const RUNS = Math.max(1, Math.min(5, Number(flag('--runs') ?? 3) || 3));
const VOTES = Math.max(1, Math.min(5, Number(flag('--votes') ?? 3) || 3));
const JUDGE = flag('--judge') ?? 'auto';
const FLOWS = !args.includes('--no-flows');
const VERBOSE = args.includes('--verbose');
const WIDTH = Math.max(900, Math.min(2560, Number(flag('--width') ?? VIEWPORT.width) || VIEWPORT.width));
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT = path.resolve(flag('--out') ?? path.join(OUT_ROOT, STAMP));

function log(line: string): void {
  console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);
}

// ---------- the rows ----------

const rows = loadRows(SITUATIONS);
if (rows.length === 0) {
  console.log(`no rows found in ${SITUATIONS}`);
  process.exit(1);
}
const wanted = rows.filter((row) => ONLY.size === 0 || ONLY.has(row.id));
if (wanted.length === 0) {
  console.log(`no row matches --rows ${[...ONLY].join(',')}`);
  process.exit(1);
}
const byId = new Map(rows.map((row) => [row.id, row]));
fs.mkdirSync(OUT, { recursive: true });

// ---------- leg a: the captures ----------

type Miss = { row: string; run: number; reason: string };

const samples: Sample[] = [];
const misses: Miss[] = [];
const unreachable = new Map<string, string>();
for (const row of rows) if (row.unreachable !== null) unreachable.set(row.id, `marked in the situation file: ${row.unreachable}`);

function shotName(row: string, run: number, width: number): string {
  const suffix = width === 400 ? '.400' : run === 1 ? '' : `.run${run}`;
  return path.join(OUT, `${row}${suffix}.png`);
}

/* The text of the LAST turn only, which is what a person reads as the agent's most recent reply.
   A turn's text is every text block between the turn_end that closed the turn before it and the
   turn_end that closed it (agent.js merges those blocks into one reply). Merging across turns
   would join the decision line to the ending sentence, and the ending rows want the ending
   alone. The reply of an in-progress turn (no closing turn_end yet) is its text so far. */
async function lastReplyOf(app: App): Promise<string> {
  const payload = await app.get('/api/driver');
  const transcript = (payload?.chats?.[0]?.transcript as Array<{ kind: string; text?: string }>) ?? [];
  const texts: string[] = [];
  let seenText = false;
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    const event = transcript[i];
    if (event.kind === 'text' && typeof event.text === 'string') {
      texts.unshift(event.text);
      seenText = true;
    } else if (event.kind === 'turn_end') {
      // The turn_end that opens the last turn's text run; once we have that run, stop.
      if (seenText) break;
    }
  }
  return texts.join('\n').trim();
}

/* The synthesized reply for a proposal shot: the view's own sentence, then the one line of copy
   the view gives for the stage the card is on. Both are the app's words from
   src/proposals/view.ts, so the reply cannot describe a stage the card does not, and it is
   exactly the two facts the brief says to build it from. The view's copy, not the stage's stock
   line: a move that did not go through carries its real cause there, and the stock "A rule you
   set stopped it" over a swap nobody priced was the misattribution the card was fixed for.
   Three sentences at most, which the pair never exceeds. */
async function synthReply(app: App, id: string): Promise<string> {
  const view = await app.view(id);
  if (view === null) return '';
  const sentence = typeof view.sentence === 'string' ? view.sentence : '';
  const copy = typeof view.stageCopy === 'string' && view.stageCopy !== '' ? view.stageCopy : (STAGE_COPY[view.stage as ProposalStage] ?? '');
  return [sentence, copy].filter((part) => part !== '').join('. ').replace(/\.\./g, '.');
}

async function turnCountOf(app: App): Promise<number> {
  const payload = await app.get('/api/driver');
  const transcript = (payload?.chats?.[0]?.transcript as Array<{ kind: string }>) ?? [];
  return transcript.filter((event) => event.kind === 'turn_end').length;
}

function makeCtx(app: App, page: Page, run: number, scene: Scene): SceneCtx {
  const wantRow = (row: string): boolean => ONLY.size === 0 || ONLY.has(row);
  return {
    app,
    page,
    run,
    log: (line) => log(`  ${scene.id}: ${line}`),
    lastReply: () => lastReplyOf(app),
    turnCount: () => turnCountOf(app),
    endingAfter: async (sinceCount, timeoutMs = 20_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if ((await turnCountOf(app)) > sinceCount) return lastReplyOf(app);
        await sleep(200);
      }
      throw new Error('no ending turn');
    },
    unreachable: (row, reason) => {
      if (!wantRow(row)) return;
      if (!unreachable.has(row)) unreachable.set(row, reason);
      log(`  ${row}: not reachable, ${reason}`);
    },
    capture: async (row, opts = {}) => {
      if (!wantRow(row)) return null;
      const stages = opts.stage === undefined ? null : Array.isArray(opts.stage) ? opts.stage : [opts.stage];
      const stageOf = async (): Promise<string | null> => (opts.id === undefined ? null : ((await app.view(opts.id))?.stage as string | undefined) ?? null);
      const before = await stageOf();
      if (stages !== null && before !== null && !stages.includes(before)) {
        misses.push({ row, run, reason: `the row was at ${before}, not ${stages.join(' or ')}, when the shot was due` });
        log(`  ${row}: missed, at ${before}`);
        return null;
      }
      // The stage line fades over 200 to 300 ms (criterion 5.3); the shot waits for it.
      await sleep(400);
      /* THE REPLY SCORED WITH THE SHOT, and what it is. An explicit reply (the agent's live
         ending sentence, the greeting, an empty string for a screen row) is used as given.
         Otherwise the reply is SYNTHESIZED from the view at this moment: the move's sentence
         and the one line of copy for the stage the card is on (src/proposals/view.ts), capped
         at the persona's three sentences, as the brief says to build it. The agent is silent
         during the walk, so the reply that matches the card is the copy for the card's stage,
         not the stale decision line the propose turn left in the transcript. */
      const reply = opts.reply ?? (opts.id === undefined ? await lastReplyOf(app) : await synthReply(app, opts.id));
      const clip: Clip = opts.clip ?? 'conversation';
      const shots: Sample['shots'] = [];
      const card = isCardRow(byId.get(row) as Row);
      const file860 = shotName(row, run, 860);
      await page.shot(file860, clip);
      shots.push({ file: file860, width: 860 });
      if (card && run === 1 && clip === 'conversation') {
        await page.column(400);
        await sleep(350);
        const file400 = shotName(row, run, 400);
        await page.shot(file400, clip);
        shots.push({ file: file400, width: 400 });
        await page.column(860);
      }
      const after = await stageOf();
      if (stages !== null && after !== null && !stages.includes(after)) {
        for (const shot of shots) fs.rmSync(shot.file, { force: true });
        misses.push({ row, run, reason: `the row moved from ${before} to ${after} while the shot was taken` });
        log(`  ${row}: missed, moved to ${after} during the shot`);
        return null;
      }
      const sample: Sample = { row, run, stage: after ?? before, reply, shots, ...(opts.note === undefined ? {} : { note: opts.note }) };
      samples.push(sample);
      log(`  ${row}: shot${after === null ? '' : ` at ${after}`}${VERBOSE ? ` "${reply.slice(0, 70)}"` : ''}`);
      return sample;
    },
  };
}

async function playScene(browser: Browser, stage: string, scene: Scene, run: number): Promise<void> {
  const app = await bootApp(stage, scene.seed);
  let page: Page | null = null;
  try {
    if (scene.seed.wallet !== false) await makeWallet(app);
    page = await browser.open(`${app.base}/?token=${app.token}`);
    if (WIDTH !== VIEWPORT.width) await page.viewport(WIDTH, VIEWPORT.height);
    await page.waitFor('!!document.querySelector(".conversation")', 15_000, 'the window');
    await page.column(860);
    await sleep(600);
    await scene.play(makeCtx(app, page, run, scene));
  } finally {
    if (page !== null) await page.close().catch(() => undefined);
    await app.stop();
  }
}

// ---------- leg b: the flows ----------

function flowsFor(): Flow[] {
  return [
    {
      row: 'C09',
      available: async () => ({ ok: true }),
      start: (base, token) => `${base}/?token=${token}`,
      goals: ['Open the "Money in" section and pick the Base network, then USDC, and confirm you understand the notice so the deposit address for USDC on Base is shown. Do not approve or send anything.'],
      expect: ['Send on Base only'],
      minimum: 5,
      onPath: [/money in/i, /where to send/i, /base/i, /usdc/i, /understand/i, /show|address|continue|next|go/i],
    },
    {
      row: 'C10',
      available: async () => ({ ok: false, reason: "this build's connect step has no agent picker; leg b for C10 waits on node C" }),
      start: (base, token) => `${base}/?token=${token}`,
      goals: ['Go through the setup until the assistant step, choose Claude Code and continue.'],
      expect: ['Set the ask threshold'],
      minimum: 12,
      onPath: [/accept/i, /get started/i, /continue/i, /claude code/i, /do this later/i],
    },
    {
      row: 'C15',
      available: async () => ({ ok: true }),
      start: (base, token) => `${base}/?token=${token}`,
      goals: [
        'Accept the terms of use and press Get started.',
        'Choose "Make a new wallet" and continue.',
        'Set the password Anxiety-eval-2026 in both fields and continue.',
        'Read the twelve recovery words shown, remember them in order, and continue.',
        'Type the three words it asks for, from the list you just read, and continue.',
        'Continue past the addresses screen, choose "Do this later" on the money screen and on the assistant screen, keep the ask threshold at 100 and continue, until the Done screen shows.',
      ],
      expect: ['Open Phosphor'],
      minimum: 15,
      onPath: [/accept/i, /get started/i, /make a new wallet/i, /continue/i, /password/i, /word/i, /do this later/i, /threshold|100/i, /done|open phosphor/i],
      maxSteps: 25,
      timeoutSec: 180,
    },
    {
      row: 'D05',
      available: async () => ({ ok: false, reason: "this build's vault Agent panel has no Change control; leg b for D05 waits on node C" }),
      start: (base, token) => `${base}/?token=${token}`,
      goals: ['Open the Vault tab, find the Agent panel, press Change and pick another installed agent.'],
      expect: ['Agent'],
      minimum: 4,
      onPath: [/vault/i, /change/i, /agent/i, /codex|hermes|grok|claude/i],
    },
  ];
}

const flowResults = new Map<string, FlowResult>();
const flowNotes = new Map<string, string>();

async function playFlows(stage: string): Promise<void> {
  const flows = flowsFor().filter((flow) => ONLY.size === 0 || ONLY.has(flow.row));
  if (flows.length === 0) return;
  if (!jevAvailable()) {
    for (const flow of flows) flowNotes.set(flow.row, 'leg b not run: jev-browse is not on this machine');
    return;
  }
  for (const flow of flows) {
    const row = byId.get(flow.row);
    if (row === undefined || !row.flow) continue;
    const avail = await flow.available();
    if (!avail.ok) {
      flowNotes.set(flow.row, `leg b not run: ${avail.reason}`);
      continue;
    }
    const app = await bootApp(stage, { wallet: flow.row !== 'C15' && flow.row !== 'C10' });
    try {
      if (flow.row !== 'C15' && flow.row !== 'C10') await makeWallet(app);
      const { result, raw } = runJev(flow, flow.start(app.base, app.token), log);
      writeFlowEvidence(OUT, flow.row, result, raw);
      const score = scoreFlow(flow, result ?? { status: 'error', message: 'no result' });
      flowResults.set(flow.row, score);
      log(`  ${flow.row}: leg b ${score.pass ? 'pass' : 'fail'} (${score.reached ? 'reached' : 'not reached'}, ${score.steps}/${score.minimum} steps, ${score.wrongClicks} wrong clicks${score.note ? `; ${score.note}` : ''})`);
    } finally {
      await app.stop();
    }
  }
}

// ---------- the judging ----------

type Judged = { sample: Sample; shot: { file: string; width: number }; votes: Vote[]; errors: string[] };

async function judgeAll(judge: Judge, list: Array<{ sample: Sample; shot: { file: string; width: number } }>, concurrency: number): Promise<Judged[]> {
  const out: Judged[] = [];
  let next = 0;
  let done = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const at = next;
      next += 1;
      if (at >= list.length) return;
      const item = list[at];
      const cast = await castVotes(judge, item.shot.file, item.sample.reply, VOTES);
      out.push({ ...item, votes: cast.votes, errors: cast.errors });
      done += 1;
      if (done % 10 === 0 || done === list.length) log(`judged ${done}/${list.length}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
  return out;
}

// ---------- main ----------

async function main(): Promise<number> {
  log(`anxiety eval: ${wanted.length} of ${rows.length} rows, ${RUNS} run(s), ${VOTES} vote(s), judge ${JUDGE}, window ${WIDTH} px, out ${OUT}`);
  const claimed = claimedRows();
  const browser = await connectBrowser();
  const stage = stageRepo();
  const sceneErrors: Array<{ scene: string; run: number; error: string }> = [];
  try {
    for (let run = 1; run <= RUNS; run += 1) {
      for (const scene of SCENES) {
        const rowsWanted = scene.rows.filter((row) => (ONLY.size === 0 || ONLY.has(row)) && !unreachable.has(row));
        if (rowsWanted.length === 0) continue;
        log(`run ${run}: ${scene.id} (${rowsWanted.join(', ')})`);
        try {
          await playScene(browser, stage, scene, run);
        } catch (error) {
          const message = errText(error);
          sceneErrors.push({ scene: scene.id, run, error: message });
          log(`  ${scene.id} failed: ${message.slice(0, 300)}`);
        }
      }
    }
    if (FLOWS) {
      try {
        await playFlows(stage);
      } catch (error) {
        log(`leg b failed: ${errText(error).slice(0, 300)}`);
      }
    }
  } finally {
    await browser.close().catch(() => undefined);
    fs.rmSync(stage, { recursive: true, force: true });
    log(`browser: ${browserDone()}`);
  }

  // ----- judge -----
  let judgeName = 'none (--judge none)';
  let probeNotes: string[] = [];
  const judged: Judged[] = [];
  if (JUDGE !== 'none' && samples.length > 0) {
    const first = samples[0].shots[0].file;
    const probe = await probeJudge(first, undefined, log);
    probeNotes = probe.tried.map((t) => `${t.name}${t.model ? ` (${t.model})` : ''}: ${t.ok ? 'ok' : 'no'}, ${t.note}`);
    if (probe.judge === null) {
      judgeName = 'none (no judge answered the probe)';
      log(`no judge answered: ${probeNotes.join(' | ')}`);
    } else {
      judgeName = `${probe.judge.name} (${probe.judge.model})`;
      log(`judge: ${judgeName}`);
      const list = samples.flatMap((sample) => sample.shots.map((shot) => ({ sample, shot })));
      judged.push(...(await judgeAll(probe.judge, list, 4)));
    }
  }

  // ----- per row -----
  const results: RowResult[] = [];
  for (const row of wanted) {
    const own = judged.filter((j) => j.sample.row === row.id);
    const rowSamples = samples.filter((s) => s.row === row.id);
    const totals = own.flatMap((j) => j.votes.map((v) => v.total));
    const worst = own
      .flatMap((j) => j.votes.map((v) => ({ file: j.shot.file, total: v.total })))
      .sort((a, b) => b.total - a.total)[0] ?? null;
    const flow = flowResults.get(row.id);
    const flowNote = flowNotes.get(row.id);
    let status: RowResult['status'];
    let reason = '';
    if (unreachable.has(row.id) && rowSamples.length === 0) {
      status = 'unreachable';
      reason = unreachable.get(row.id) as string;
    } else if (rowSamples.length === 0) {
      const missed = misses.filter((m) => m.row === row.id);
      const sceneError = sceneErrors.find((e) => SCENES.find((s) => s.id === e.scene)?.rows.includes(row.id));
      status = 'fail';
      reason = missed.length > 0 ? `no screenshot: ${missed[0].reason}` : sceneError !== undefined ? `no screenshot: ${sceneError.error.slice(0, 160)}` : claimed.has(row.id) ? 'no screenshot' : 'no scene reaches this row';
    } else if (JUDGE === 'none') {
      status = 'fail';
      reason = `${rowSamples.length} screenshot(s), not judged (--judge none)`;
    } else if (totals.length === 0) {
      status = 'fail';
      reason = `${rowSamples.length} screenshot(s), no valid vote: ${own.flatMap((j) => j.errors)[0] ?? 'the judge did not answer'}`;
    } else {
      const verdict = rowVerdict(totals, row.failure);
      status = verdict.pass ? 'pass' : 'fail';
      reason = verdict.reason;
      if (flow !== undefined && !flow.pass) {
        status = 'fail';
        reason = `${reason ? `${reason}; ` : ''}leg b: ${flow.note}`;
      }
    }
    if (flowNote !== undefined) reason = `${reason ? `${reason}; ` : ''}${flowNote}`;
    const medianOf = totals.length === 0 ? null : rowVerdict(totals, row.failure).median;
    results.push({
      id: row.id,
      failure: row.failure,
      flow: row.flow,
      status,
      reason,
      median: medianOf,
      max: totals.length === 0 ? null : Math.max(...totals),
      votes: totals.length,
      samples: rowSamples.length,
      worst,
      ...(flow === undefined ? {} : { flowResult: flow }),
    });
    // The row's JSON: every sample, every vote with its reasons, the verdict.
    fs.writeFileSync(
      path.join(OUT, `${row.id}.json`),
      `${JSON.stringify(
        {
          row: row.id,
          cells: row.cells,
          failure: row.failure,
          flow: row.flow,
          status,
          reason,
          median: medianOf,
          samples: rowSamples.map((s) => ({
            run: s.run,
            stage: s.stage,
            reply: s.reply,
            note: s.note ?? null,
            shots: s.shots.map((shot) => ({
              file: path.relative(OUT, shot.file),
              width: shot.width,
              votes: own.filter((j) => j.shot.file === shot.file).flatMap((j) => j.votes.map((v) => ({ total: v.total, scores: v.scores, why: v.why }))),
              errors: own.filter((j) => j.shot.file === shot.file).flatMap((j) => j.errors),
            })),
          })),
          misses: misses.filter((m) => m.row === row.id),
          legB: flow ?? null,
          legBNote: flowNote ?? null,
        },
        null,
        2,
      )}\n`,
    );
  }

  const meta = { judge: judgeName, runs: RUNS, folder: OUT };
  const table = consoleTable(results, meta);
  console.log('');
  console.log(table);
  const summary = {
    at: new Date().toISOString(),
    folder: OUT,
    runs: RUNS,
    votes: VOTES,
    judge: judgeName,
    judgeProbe: probeNotes,
    counts: counts(results),
    worst: worstThree(results),
    sceneErrors,
    misses,
    rows: results,
  };
  fs.writeFileSync(path.join(OUT, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  fs.writeFileSync(
    path.join(OUT, 'summary.md'),
    `# Anxiety score, ${summary.at}\n\n${markdownTable(results, meta)}\n\n${probeNotes.length === 0 ? '' : `Judge probe: ${probeNotes.join('; ')}\n\n`}${
      sceneErrors.length === 0 ? '' : `Scene errors: ${sceneErrors.map((e) => `${e.scene} (run ${e.run}): ${e.error.slice(0, 200)}`).join('; ')}\n`
    }`,
  );
  log(`summary: ${path.join(OUT, 'summary.md')}`);
  const c = counts(results);
  return c.fail === 0 ? 0 : 1;
}

// An interrupted run still puts the machine back: every backend stopped, every window closed.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void (async () => {
      await stopAll();
      log(`browser: ${browserDone()}`);
      process.exit(130);
    })();
  });
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  });
