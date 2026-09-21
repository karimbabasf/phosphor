// Leg a: the rubric judge. One screenshot plus the agent's reply, scored by a vision model as a
// person who has never bought crypto.
//
// The rubric is the definitions file's own, term 6(b), copied byte for byte into RUBRIC below
// and held there by tests/unit/anxiety-eval.test.ts, which reads the file and compares. Frozen
// rule 10: the rubric and this prompt are never edited to raise a score; a low score is fixed in
// the product.
//
// Three votes per screenshot, cast at once against one prompt, the median standing, which is
// scripts/eval.ts's JUDGE_VOTES rule: one vision read is the least repeatable thing in a run.
// The judge is probed once per run, in the order the builder prompt gives: a vision model on
// NEAR AI Cloud (credentials in ~/.config/jev-browse/env), then anthropic/claude-sonnet-5 through
// OpenRouter, then `claude -p` the way scripts/eval.ts judges. The first that answers valid JSON
// for an image plus text is the run's judge and is named in every summary. Nothing but the
// screenshot and the reply text is sent, and no key is ever printed.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------- the rubric, verbatim ----------

// docs/superpowers/specs/2026-09-20-quality-definitions.md, term 6(b), from "(b) Rubric" through
// the "Levels:" line. Every character, including "(proposed)".
export const RUBRIC = `(b) Rubric, 0 to 10, lower is better, five parts scored 0 to 2 each (proposed):
1. Jargon: 0 = every word is plain or glossed in the sentence; 1 = one crypto term unglossed; 2 = two or more, or any raw id longer than 12 characters unshortened.
2. Density: 0 = one card, at most 6 numbers, at most 3 sentences; 1 = two cards or 7 to 10 numbers or 4 to 6 sentences; 2 = more, or a table in the reply.
3. Next step: 0 = the reader knows in one line whether they must do something and what; 1 = it can be inferred; 2 = unclear, or the card and the reply disagree.
4. Money certainty: 0 = spend, receive at least, and cost are all visible in the reader's terms; 1 = one missing; 2 = two missing, or a figure like 8.209399000000001, or "Infinity", "NaN", "undefined".
5. Alarm: 0 = calm tone, one status colour; 1 = red text or the word failed without a next step; 2 = stack trace, raw JSON, ALL CAPS vendor words, an error toast on top of a card, or two alerts at once.
Levels: 0 to 2 calm; 3 to 4 fine; 5 to 6 uneasy; 7 to 8 overwhelmed; 9 to 10 panic. Pass: median 3 or under across samples AND no single sample 6 or over (proposed). A failure situation may score up to 4 median (a refusal is allowed to feel serious, not confusing).`;

// The judge persona, verbatim from the builder prompt (criterion 6a) and the definitions file.
export const PERSONA = 'You are a 35 year old who uses Venmo and has never bought crypto';

export const PARTS = ['jargon', 'density', 'next_step', 'money_certainty', 'alarm'] as const;
export type Part = (typeof PARTS)[number];

export type Vote = { scores: Record<Part, number>; why: Record<Part, string>; total: number; raw: string };

export const JUDGE_VOTES = 3;
export const JUDGE_TIMEOUT_MS = 150_000;

// The pass rule, from the rubric's own Levels line and the situation list's header.
export const PASS_MEDIAN = 3;
export const PASS_MEDIAN_FAILURE_ROW = 4;
export const PASS_MAX_VOTE = 5; // no single vote 6 or over

export function judgePrompt(reply: string): string {
  return [
    'You are looking at one screenshot of a desktop app that holds money, and the reply its assistant wrote for the same moment. Score how overwhelmed you would feel, using this rubric exactly as written:',
    '',
    RUBRIC,
    '',
    // A framing line, not a change to the rubric: the person sees the whole screen, so what the
    // rubric calls the card, the numbers, and what is "visible" are read off the screenshot, and
    // a figure the card shows is a figure the reader has, whether or not the reply repeats it.
    'What the reader sees is the WHOLE screen plus the reply: the card in the screenshot is part of what they read, so score the card and the reply together. A number, a card, or a figure the rubric asks about counts as present when it is on the screenshot, even if the reply does not repeat it.',
    '',
    "THE ASSISTANT'S REPLY for this moment (the card in the screenshot is the app's; this text is the assistant's):",
    reply.trim() === '' ? '(the assistant said nothing at this moment; score the screenshot alone)' : reply,
    '',
    'Answer with JSON only, no prose around it, in exactly this shape, one integer 0, 1 or 2 per part and one sentence of why per part:',
    '{"jargon":{"score":0,"why":"..."},"density":{"score":0,"why":"..."},"next_step":{"score":0,"why":"..."},"money_certainty":{"score":0,"why":"..."},"alarm":{"score":0,"why":"..."}}',
  ].join('\n');
}

// ---------- validation and arithmetic, pure ----------

/* A vote is valid when it is JSON (a code fence around it is tolerated, nothing else is) with
   the five parts, each an integer 0 to 2 and a string of why. The total is summed here, never
   read off the model: a model's own arithmetic is not the rubric's. */
export function parseVote(text: string): Vote | null {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  const body = fenced === null ? trimmed : fenced[1];
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Some models wrap the object in a sentence; the first balanced object is tried once.
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      parsed = JSON.parse(body.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const scores = {} as Record<Part, number>;
  const why = {} as Record<Part, string>;
  for (const part of PARTS) {
    const entry = (parsed as Record<string, unknown>)[part];
    if (entry === null || typeof entry !== 'object') return null;
    const score = (entry as { score?: unknown }).score;
    if (!Number.isInteger(score) || (score as number) < 0 || (score as number) > 2) return null;
    scores[part] = score as number;
    const reason = (entry as { why?: unknown }).why;
    why[part] = typeof reason === 'string' ? reason.slice(0, 300) : '';
  }
  const total = PARTS.reduce((sum, part) => sum + scores[part], 0);
  return { scores, why, total, raw: text };
}

// The middle value; the upper middle of an even count, so a tie rounds against the product.
export function median(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export type RowVerdict = { pass: boolean; median: number; max: number; votes: number; reason: string };

/* A row passes on the median of every vote it collected: median 3 or under (4 for a refusal or
   failure row) and no single vote 6 or over. No votes at all is a fail, never a skip. */
export function rowVerdict(totals: number[], failureRow: boolean): RowVerdict {
  if (totals.length === 0) return { pass: false, median: Number.NaN, max: Number.NaN, votes: 0, reason: 'no votes' };
  const mid = median(totals);
  const max = Math.max(...totals);
  const bar = failureRow ? PASS_MEDIAN_FAILURE_ROW : PASS_MEDIAN;
  const reasons: string[] = [];
  if (mid > bar) reasons.push(`median ${mid} over ${bar}`);
  if (max > PASS_MAX_VOTE) reasons.push(`a vote of ${max}`);
  return { pass: reasons.length === 0, median: mid, max, votes: totals.length, reason: reasons.join(', ') };
}

// ---------- the providers ----------

export type JudgeName = 'nearai' | 'openrouter' | 'claude-p';

export type Judge = {
  name: JudgeName;
  model: string;
  vote(screenshot: string, reply: string): Promise<{ vote: Vote | null; error?: string }>;
};

type Env = Record<string, string>;

// ~/.config/jev-browse/env: KEY=value lines. Read, never printed.
export function readJevEnv(file: string = path.join(os.homedir(), '.config', 'jev-browse', 'env')): Env {
  const out: Env = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m === null) continue;
    out[m[1]] = m[2].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  }
  return out;
}

function imageDataUrl(file: string): string {
  return `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;
}

/* One OpenAI-compatible chat completion carrying the image and the prompt. NEAR AI Cloud and
   OpenRouter both speak this shape. Reasoning is left to the model's defaults; the answer is
   the message content, JSON only. */
async function chatWithImage(baseUrl: string, apiKey: string, model: string, screenshot: string, reply: string, extra: Record<string, string> = {}): Promise<string> {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}`, ...extra },
    body: JSON.stringify({
      model,
      max_tokens: 4000,
      messages: [
        { role: 'system', content: PERSONA },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: imageDataUrl(screenshot) } },
            { type: 'text', text: judgePrompt(reply) },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(JUDGE_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 200)}`);
  const json = JSON.parse(text) as { choices?: Array<{ message?: { content?: unknown } }> };
  const content = json.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
  throw new Error('the answer carried no text');
}

// Judges worth asking first on NEAR AI Cloud, when the /models list says they take images.
const NEARAI_PREFERRED = ['anthropic/claude-sonnet-5', 'anthropic/claude-opus-5', 'google/gemini-3.8-flash', 'Qwen/Qwen3-VL-30B-A3B-Instruct'];

export async function nearaiVisionModel(baseUrl: string, apiKey: string, preferred: string = process.env.ANXIETY_JUDGE_MODEL ?? ''): Promise<string | null> {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`/models answered ${res.status}`);
  const json = (await res.json()) as { data?: Array<{ id?: string; input_modalities?: string[]; architecture?: { inputModalities?: string[] } }> };
  const vision = (json.data ?? []).filter((m) => {
    const modalities = m.input_modalities ?? m.architecture?.inputModalities ?? [];
    return typeof m.id === 'string' && modalities.includes('image');
  });
  const ids = vision.map((m) => m.id as string);
  if (preferred !== '' && ids.includes(preferred)) return preferred;
  for (const id of NEARAI_PREFERRED) if (ids.includes(id)) return id;
  return ids[0] ?? null;
}

function wrap(name: JudgeName, model: string, ask: (screenshot: string, reply: string) => Promise<string>): Judge {
  return {
    name,
    model,
    vote: async (screenshot, reply) => {
      try {
        const text = await ask(screenshot, reply);
        const vote = parseVote(text);
        return vote === null ? { vote: null, error: `not valid JSON: ${text.slice(0, 80)}` } : { vote };
      } catch (error) {
        return { vote: null, error: error instanceof Error ? error.message.slice(0, 160) : String(error) };
      }
    },
  };
}

/* `claude -p` with the Read tool and nothing else: no settings, no MCP, exactly as scripts/eval.ts
   spawns its judge, plus the one tool that can open the screenshot. The prompt names the file. */
function claudeP(screenshot: string, reply: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'claude',
      ['-p', '--setting-sources=', '--permission-mode', 'dontAsk', '--allowedTools', 'Read', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--system-prompt', PERSONA],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let out = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('the judge did not answer inside 150 s'));
    }, JUDGE_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.stderr.on('data', () => undefined);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`the judge did not start (${error.message})`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`the judge exited ${code}`));
      else resolve(out);
    });
    child.stdin.end(`First read the screenshot at ${screenshot} with the Read tool, then answer.\n\n${judgePrompt(reply)}`);
  });
}

export type Probe = { judge: Judge | null; tried: Array<{ name: JudgeName; model: string; ok: boolean; note: string }> };

/* The probe: each candidate is asked to score one real screenshot, in order, and the first whose
   answer is valid JSON is the run's judge. Every attempt is recorded for the summary. */
export async function probeJudge(screenshot: string, env: Env = readJevEnv(), log: (line: string) => void = () => undefined): Promise<Probe> {
  const tried: Probe['tried'] = [];
  const candidates: Array<() => Promise<Judge | null>> = [
    async () => {
      const key = env.TEXT_MODEL_API_KEY ?? '';
      const base = env.TEXT_MODEL_BASE_URL ?? '';
      if (key === '' || base === '') {
        tried.push({ name: 'nearai', model: '', ok: false, note: 'no TEXT_MODEL_API_KEY or TEXT_MODEL_BASE_URL in the env file' });
        return null;
      }
      const model = await nearaiVisionModel(base, key);
      if (model === null) {
        tried.push({ name: 'nearai', model: '', ok: false, note: 'no model on /models accepts image input' });
        return null;
      }
      return wrap('nearai', model, (shot, reply) => chatWithImage(base, key, model, shot, reply));
    },
    async () => {
      const key = env.OPENROUTER_API_KEY ?? '';
      if (key === '') {
        tried.push({ name: 'openrouter', model: 'anthropic/claude-sonnet-5', ok: false, note: 'no OPENROUTER_API_KEY in the env file' });
        return null;
      }
      const model = 'anthropic/claude-sonnet-5';
      return wrap('openrouter', model, (shot, reply) => chatWithImage('https://openrouter.ai/api/v1', key, model, shot, reply, { 'x-title': 'phosphor anxiety eval' }));
    },
    async () => wrap('claude-p', 'claude -p (machine default)', claudeP),
  ];
  for (const make of candidates) {
    let judge: Judge | null = null;
    try {
      judge = await make();
    } catch (error) {
      tried.push({ name: 'nearai', model: '', ok: false, note: `could not list models: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    if (judge === null) continue;
    log(`probing judge ${judge.name} (${judge.model})`);
    const answer = await judge.vote(screenshot, 'Set up: 2 USDC to NEAR inside NEAR Intents. Nothing moves until you answer Yes or No in the window.');
    const ok = answer.vote !== null;
    tried.push({ name: judge.name, model: judge.model, ok, note: ok ? `answered ${answer.vote?.total} on the probe screenshot` : (answer.error ?? 'no valid JSON') });
    if (ok) return { judge, tried };
  }
  return { judge: null, tried };
}

/* Three votes, cast at once. Votes that never came back are recorded as errors and left out of
   the median; a screenshot with no valid vote at all is a failed sample. */
export async function castVotes(judge: Judge, screenshot: string, reply: string, votes: number = JUDGE_VOTES): Promise<{ votes: Vote[]; errors: string[] }> {
  const cast = await Promise.all(Array.from({ length: votes }, () => judge.vote(screenshot, reply)));
  return {
    votes: cast.flatMap((c) => (c.vote === null ? [] : [c.vote])),
    errors: cast.flatMap((c) => (c.error === undefined ? [] : [c.error])),
  };
}
