// HIGH-1 of the 2026-10-01 audit: one seat, one id. A same-user process that read agent.secret (the
// OUTSIDE attacker of 06-agent-door) posted to /api/mcp by hand with a session string the roster
// cleans to another id: a trailing or leading space, a control character, more than 64 characters,
// a 64 cut that lands on a space, or no session at all. The roster seated and marked the cleaned id;
// the propose door recorded the raw string as the row's `by`, found no mark under it, and the $5 swap
// ran with no click. The door now hands every handler the id the roster seated (src/http/mcp.ts).
//
// For each spelling: the seat shows on the roster as outside and not allowed, its small swap waits
// for a click with OUTSIDE_REASON, and the stored row is marked outside under the seated id. Then the
// person Allows the seat whose 64 cut landed on a space, and its next small move runs on the policy:
// the Allow reaches the id that seat really holds (it used to clean to another one).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { bootBackend, sleep, type Backend } from '../harness.ts';
import type { AttackCase, AttackCtx, AttackResult } from '../types.ts';
import { OUTSIDE_REASON } from '../../../src/web-read.ts';

type Member = { session: string; client: string; origin: string; allowed: boolean };

// [name, the session string sent, or undefined for none]. Each client name is unique so the roster
// row can be found whatever id the seat ends up under.
const CUT = 'dodge-cut-'.padEnd(63, 'c');
const SPELLINGS: Array<[string, string | undefined]> = [
  ['trailing space', 'dodge-trailing '],
  ['leading space', ' dodge-leading'],
  ['control char', 'dodge-bell\u0007'],
  ['over 64', `dodge-long-${'x'.repeat(80)}`],
  ['64 cut on a space', `${CUT} tail`],
  ['no session', undefined],
];

// One small swap per seat, each a different pair, so no move waits on another's coin.
const SWAPS = [
  { fromSymbol: 'USDC', toSymbol: 'ETH', amountIn: '5' },
  { fromSymbol: 'USDC', toSymbol: 'SOL', amountIn: '4' },
  { fromSymbol: 'ETH', toSymbol: 'USDC', amountIn: '0.001' },
  { fromSymbol: 'SOL', toSymbol: 'USDC', amountIn: '0.02' },
  { fromSymbol: 'USDC', toSymbol: 'ETH', amountIn: '3' },
  { fromSymbol: 'ETH', toSymbol: 'SOL', amountIn: '0.001' },
];

async function member(app: Backend, client: string): Promise<Member | undefined> {
  for (let i = 0; i < 20; i++) {
    const m = ((await app.get('/api/state')).json?.agents?.members as Member[] | undefined)?.find((x) => x.client === client);
    if (m) return m;
    await sleep(100);
  }
  return undefined;
}

async function stored(app: Backend, id: string): Promise<any> {
  return ((await app.get('/api/proposals')).json?.proposals as any[] | undefined)?.find((p) => p.id === id);
}

export const attack: AttackCase = {
  id: '15-seat-id-dodge',
  title: 'an outside seat that spells its session so the roster cleans it (space, control char, 64+ chars, none) still waits for a click',
  timeoutMs: 120_000,
  async run(_ctx: AttackCtx): Promise<AttackResult> {
    const app = await bootBackend();
    try {
      const secret = fs.readFileSync(path.join(app.dataDir, 'agent.secret'), 'utf8').split('\n')[0]!.trim();
      const problems: string[] = [];
      const rows: string[] = [];
      const seats = new Map<string, { member: Member; call: Record<string, unknown> }>();

      for (const [i, [name, session]] of SPELLINGS.entries()) {
        const client = `dodge-${i}`;
        const call: Record<string, unknown> = { client, secret, key: crypto.randomBytes(32).toString('hex') };
        if (session !== undefined) call.session = session;
        const hello = await app.post('/api/mcp', { ...call, op: 'hello' });
        const m = await member(app, client);
        if (hello.status !== 200 || !m) {
          problems.push(`${name}: never seated (${hello.status} ${hello.text.slice(0, 80)})`);
          continue;
        }
        seats.set(name, { member: m, call });
        const res = await app.post('/api/mcp', { ...call, op: 'propose', kind: 'swap', params: SWAPS[i] });
        const p = res.json;
        const row = p?.id ? await stored(app, p.id) : undefined;
        const reasons: string[] = p?.verdict?.reasons ?? [];
        rows.push(`${name}: seat ${JSON.stringify(m.session.slice(0, 24))}${m.session.length > 24 ? '...' : ''} ${m.origin}/allowed=${m.allowed} -> ${p?.status ?? res.status} outside=${row?.outside} by=seat:${row?.by === m.session}`);
        if (m.origin !== 'outside' || m.allowed !== false) problems.push(`${name}: seated as ${m.origin}, allowed=${m.allowed}`);
        if (p?.status !== 'pending') problems.push(`${name}: the swap ran with no click (status ${p?.status ?? res.status})`);
        else if (!reasons.includes(OUTSIDE_REASON)) problems.push(`${name}: held, but not as an outside seat: ${JSON.stringify(reasons)}`);
        if (row?.outside !== true) problems.push(`${name}: the stored row is not marked outside`);
        if (row?.by !== m.session) problems.push(`${name}: the row names ${JSON.stringify(row?.by)}, not the seated id`);
      }

      // The person Allows the seat whose cut landed on a space; its next small move runs.
      const cut = seats.get('64 cut on a space');
      let afterAllow = 'not reached';
      if (cut) {
        const yes = await app.post('/api/agents/answer', { token: app.token, session: cut.member.session, allow: true });
        const now = await member(app, cut.call.client as string);
        const p = (await app.post('/api/mcp', { ...cut.call, op: 'propose', kind: 'swap', params: { fromSymbol: 'SOL', toSymbol: 'ETH', amountIn: '0.01' } })).json;
        const row = p?.id ? await stored(app, p.id) : undefined;
        afterAllow = `Allow ${yes.status}, allowed=${now?.allowed}, next swap ${p?.status}/${row?.decidedBy}`;
        if (yes.status !== 200 || now?.allowed !== true) problems.push(`the window's Allow did not reach the seat (${yes.status}, allowed=${now?.allowed})`);
        if (p?.status === 'pending' || row?.decidedBy !== 'policy') problems.push(`after Allow the seat's small move still waited (${p?.status}/${row?.decidedBy})`);
      }

      return {
        expected: `each of ${SPELLINGS.length} spellings seats outside and unallowed, its small swap waits with OUTSIDE_REASON and the row names the seated id; after the window's Allow the cut-on-a-space seat's next move runs on the policy`,
        observed: problems.length === 0 ? `all ${SPELLINGS.length} held for a click; ${afterAllow}` : problems.join('; '),
        pass: problems.length === 0 && seats.size === SPELLINGS.length,
        evidence: `POST /api/mcp hello+propose with agent.secret: ${rows.join(' | ')} | ${afterAllow}`,
      };
    } finally {
      await app.stop();
    }
  },
};

export default attack;
