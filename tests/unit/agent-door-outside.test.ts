// The agent door (review gap 4 and gap 5, 2026-10-01).
//
// agent.secret sits in the data dir, readable by any process running as this user, and it was all
// /api/mcp checked: such a process seated itself as an operator, and a move under the click line
// ran on the policy alone. Since then the agents this app spawns carry a secret only they are
// given (PHOSPHOR_SEAT), and a seat taken with the file's secret is OUTSIDE: it starts marked, so
// every move it asks for waits for the person's click, until the person allows that agent with
// one click in the window. The flow for an agent the app spawned does not change.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { MAX_AGENTS, createAgents } from '../../src/agents.ts';
import type { Rail } from '../../src/types.ts';
import { OUTSIDE_REASON, WEB_READ_REASON, markWebRead, outsideBy, webReadBy, webReadStamp } from '../../src/web-read.ts';
import { bootChartServer } from '../fixtures/chart-server.ts';
import { landed, makeCtx } from './helpers/proposals.ts';

const OWN = 'o'.repeat(64);
const HAND = 'h'.repeat(64);
const KEY = 'k'.repeat(64);
const OTHER_KEY = 'q'.repeat(64);

let seq = 0;
function seat(name: string): string {
  seq += 1;
  return `seat-outside-${name}-${seq}`;
}

function roster(now: () => number = Date.now) {
  return createAgents(now, MAX_AGENTS, { secret: OWN, handSecret: HAND });
}

// ---------- the roster: who started a seat ----------

test('a seat taken with the file secret is outside and starts marked; one taken with the app\'s is neither', () => {
  const agents = roster();
  const out = seat('hand');
  const own = seat('app');
  const a = agents.claim({ session: out, client: 'claude-code', secret: HAND, key: KEY });
  const b = agents.claim({ session: own, client: 'phosphor-mcp', secret: OWN });
  assert.ok(a.ok && b.ok);
  assert.deepEqual([a.member.origin, a.member.allowed, a.member.askable, a.member.later], ['outside', false, true, false]);
  assert.deepEqual([b.member.origin, b.member.allowed, b.member.askable], ['app', true, false]);
  assert.equal(webReadBy(out), true, 'nothing this app can see says what an outside agent read');
  assert.equal(outsideBy(out), true);
  assert.equal(webReadBy(own), false);
  assert.deepEqual(webReadStamp('agent', out), { webRead: true }, 'a label it writes carries the stamp');
});

test('a call with the file secret cannot post as the app\'s own seat, before or after that seat arrives', () => {
  const agents = roster();
  const chat = seat('chat');
  const worker = seat('worker');
  agents.markOwn(chat);
  agents.markAnalyst(worker);
  // The ids are on /api/state, so a hand-started process could try to sit in them first.
  for (const s of [chat, worker]) {
    const r = agents.claim({ session: s, client: 'imposter', secret: HAND, key: KEY });
    assert.ok(!r.ok && r.foreign === true, s);
  }
  assert.ok(agents.claim({ session: chat, client: 'phosphor-mcp', secret: OWN }).ok);
  const after = agents.check({ session: chat, client: 'imposter', secret: HAND, key: KEY });
  assert.ok(!after.ok && after.foreign === true);
  assert.equal(agents.member(chat)?.origin, 'app');
});

test('an outside seat belongs to the proxy that took it: another key, or none, is refused', () => {
  const agents = roster();
  const s = seat('bound');
  assert.ok(agents.claim({ session: s, client: 'claude-code', secret: HAND, key: KEY }).ok);
  for (const key of [OTHER_KEY, undefined, '', 'short']) {
    const r = agents.check({ session: s, client: 'claude-code', secret: HAND, key });
    assert.ok(!r.ok && r.foreign === true, String(key));
  }
  assert.ok(agents.check({ session: s, client: 'claude-code', secret: HAND, key: KEY }).ok);
});

test('Allow lifts only the mark the seat started with; a read the app saw still marks it', () => {
  const agents = roster();
  const s = seat('allow');
  agents.claim({ session: s, client: 'claude-code', secret: HAND, key: KEY });
  const yes = agents.allow(s);
  assert.ok(yes.ok);
  assert.equal(yes.member.allowed, true);
  assert.equal(agents.member(s)?.allowed, true);
  assert.equal(webReadBy(s), false);
  markWebRead(s);
  assert.equal(webReadBy(s), true);
  assert.equal(outsideBy(s), false);
});

test('Not now keeps the mark and stops the asking; Allow is refused for a seat that sent no key', () => {
  const agents = roster();
  const s = seat('later');
  agents.claim({ session: s, client: 'claude-code', secret: HAND, key: KEY });
  assert.equal(agents.later(s)?.later, true);
  assert.equal(webReadBy(s), true);
  const bare = seat('keyless');
  const c = agents.claim({ session: bare, client: 'curl', secret: HAND });
  assert.ok(c.ok);
  assert.equal(c.member.askable, false);
  const no = agents.allow(bare);
  assert.ok(!no.ok);
  assert.match(no.reason, /always wait for your OK/);
  assert.equal(webReadBy(bare), true);
  assert.equal(agents.allow('no-such-seat').ok, false);
});

test('an allowed proxy whose seat lapsed comes back allowed; another process in that seat does not', () => {
  let now = Date.now();
  const agents = roster(() => now);
  const s = seat('lapse');
  agents.claim({ session: s, client: 'claude-code', secret: HAND, key: KEY, intervalMs: 5000 });
  assert.ok(agents.allow(s).ok);
  now += 60_000;
  assert.equal(agents.member(s), null, 'the seat lapsed');
  const back = agents.claim({ session: s, client: 'claude-code', secret: HAND, key: KEY, intervalMs: 5000 });
  assert.ok(back.ok && back.member.allowed);
  assert.equal(webReadBy(s), false);

  now += 60_000;
  const taken = agents.claim({ session: s, client: 'imposter', secret: HAND, key: OTHER_KEY, intervalMs: 5000 });
  assert.ok(taken.ok);
  assert.equal(taken.member.allowed, false, 'an Allow is for the process it was given to');
  assert.equal(webReadBy(s), true);
});

test('a seat that says bye, or that the person ends, forgets its Allow', () => {
  const agents = roster();
  const s = seat('bye');
  agents.claim({ session: s, client: 'claude-code', secret: HAND, key: KEY });
  assert.ok(agents.allow(s).ok);
  assert.ok(agents.release({ session: s, secret: HAND, key: KEY }).ok);
  const again = agents.claim({ session: s, client: 'claude-code', secret: HAND, key: KEY });
  assert.ok(again.ok);
  assert.equal(again.member.allowed, false);
});

// ---------- where a move lands ----------

function swapRail(executed: string[]): Rail {
  return {
    kind: 'swap',
    valueUsd: () => 0,
    async simulate() {
      return { ok: true, summary: 'scripted rail: nothing was simulated' };
    },
    async execute(draft) {
      executed.push(draft.kind);
      return { ok: true, detail: 'scripted swap', txids: ['0xswap'] };
    },
  };
}

test('regression: an outside seat\'s small swap lands pending with its reason, and runs on the policy once allowed', async () => {
  const agents = roster();
  const s = seat('money');
  agents.claim({ session: s, client: 'claude-code', secret: HAND, key: KEY });
  const executed: string[] = [];
  const h = makeCtx({ rails: [swapRail(executed)], intentsUsdc: 1000 });
  const swap = (amountIn: number) => landed(h, h.svc.proposeSwap({ chain: 'eth', fromSymbol: 'USDC', toSymbol: 'USDT', amountIn, minAmountOut: amountIn * 0.99, by: s }));

  const before = await swap(20);
  assert.equal(before.status, 'pending', JSON.stringify(before.verdict));
  assert.equal(before.verdict.reasons.at(-1), OUTSIDE_REASON);
  assert.equal(before.outside, true);
  assert.deepEqual(executed, [], 'nothing ran on the policy alone');

  assert.ok(agents.allow(s).ok);
  const after = await swap(21);
  assert.equal(after.status, 'executed', JSON.stringify(after.verdict));
  assert.deepEqual(executed, ['swap']);

  // A stranger's text it reads through Phosphor marks it again, with the web-read reason.
  markWebRead(s);
  const read = await swap(22);
  assert.equal(read.status, 'pending');
  assert.equal(read.verdict.reasons.at(-1), WEB_READ_REASON);
});

test('the flow for an agent the app spawned does not change: its small swap runs on the policy', async () => {
  const agents = roster();
  const s = seat('spawned');
  agents.markOwn(s);
  assert.ok(agents.claim({ session: s, client: 'phosphor-mcp', secret: OWN }).ok);
  const executed: string[] = [];
  const h = makeCtx({ rails: [swapRail(executed)], intentsUsdc: 1000 });
  const p = await landed(h, h.svc.proposeSwap({ chain: 'eth', fromSymbol: 'USDC', toSymbol: 'USDT', amountIn: 20, minAmountOut: 19.8, by: s }));
  assert.equal(p.status, 'executed', JSON.stringify(p.verdict));
  assert.equal(p.outside, undefined);
  assert.deepEqual(executed, ['swap']);
});

// ---------- through the door and the window ----------

test('through the door: the hello seats it outside, the window answers it, and the key is never logged', async () => {
  const executed: string[] = [];
  const m = makeCtx({ rails: [swapRail(executed)], intentsUsdc: 1000 });
  const h = await bootChartServer({ proposals: m.svc, handSeat: HAND });
  const s = seat('door');
  const as = (body: Record<string, unknown>) => h.post('/api/mcp', { session: s, client: 'claude-code', secret: HAND, key: KEY, ...body });
  const member = async () => ((await h.get('/api/state')).json.agents.members as Array<Record<string, unknown>>).find((x) => x.session === s);
  const swap = async (amountIn: string) => {
    const r = await as({ op: 'propose', kind: 'swap', params: { chain: 'eth', fromSymbol: 'USDC', toSymbol: 'USDT', amountIn, minAmountOut: 1 } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return m.svc.settled(String(r.json.id), 5000);
  };
  try {
    assert.equal((await as({ op: 'hello', intervalMs: 5000 })).status, 200);
    const seated = await member();
    assert.deepEqual([seated?.origin, seated?.allowed, seated?.askable, seated?.later], ['outside', false, true, false]);

    const first = await swap('20');
    assert.equal(first.status, 'pending');
    assert.equal(first.verdict.reasons.at(-1), OUTSIDE_REASON);
    assert.deepEqual(executed, []);

    // Only the window answers: the seat secret is not the token.
    assert.equal((await h.post('/api/agents/answer', { session: s, allow: true, secret: HAND })).status, 403);
    assert.equal((await h.post('/api/agents/answer', { token: h.token, session: s })).status, 400);
    const later = await h.post('/api/agents/answer', { token: h.token, session: s, allow: false });
    assert.equal(later.status, 200);
    assert.equal((await member())?.later, true);
    assert.equal((await swap('21')).status, 'pending', 'Not now keeps every move waiting');

    const yes = await h.post('/api/agents/answer', { token: h.token, session: s, allow: true });
    assert.equal(yes.status, 200);
    assert.deepEqual([(await member())?.allowed, (await member())?.later], [true, false]);
    const after = await swap('22');
    assert.equal(after.status, 'executed', JSON.stringify(after.verdict));
    assert.deepEqual(executed, ['swap']);

    // Another process that read the file posts as this seat: refused.
    const imposter = await h.post('/api/mcp', { op: 'propose', kind: 'swap', params: { chain: 'eth', fromSymbol: 'USDC', toSymbol: 'USDT', amountIn: '23', minAmountOut: 1 }, session: s, client: 'claude-code', secret: HAND, key: OTHER_KEY });
    assert.equal(imposter.status, 403);
    assert.equal(imposter.json.seat, 'foreign');

    const log = fs.readFileSync(path.join(h.dataDir, 'audit.jsonl'), 'utf8');
    assert.ok(!log.includes(KEY), 'the key reached the audit log');
    assert.ok(!log.includes(HAND), 'the secret reached the audit log');
    assert.match(log, /the person allowed claude-code/);
  } finally {
    await h.close();
  }
});

test('through the door: a call with the file secret posting as the app\'s seat is refused, and Allow needs a key', async () => {
  const h = await bootChartServer({ handSeat: HAND });
  try {
    const own = seat('door-own');
    h.agents.markOwn(own);
    assert.equal((await h.mcp({ op: 'hello', session: own, client: 'phosphor-mcp', intervalMs: 5000 })).status, 200);
    const sat = await h.post('/api/mcp', { op: 'hello', session: own, client: 'imposter', secret: HAND, key: KEY, intervalMs: 5000 });
    assert.equal(sat.status, 403);
    assert.equal(sat.json.seat, 'foreign');

    const bare = seat('door-keyless');
    assert.equal((await h.post('/api/mcp', { op: 'hello', session: bare, client: 'curl', secret: HAND, intervalMs: 5000 })).status, 200);
    const no = await h.post('/api/agents/answer', { token: h.token, session: bare, allow: true });
    assert.equal(no.status, 409);
    assert.match(String(no.json.error), /always wait for your OK/);
  } finally {
    await h.close();
  }
});
