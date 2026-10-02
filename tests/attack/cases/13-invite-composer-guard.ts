// 13-invite-composer-guard: a code typed into the chat must never reach the agent. Two walls: the
// window's codeIn (ui/core/invite.js, loaded here in a vm exactly as the page runs it) and the
// server's looksLikeInviteCode on POST /api/driver action=prompt (src/http/mutation.ts). Both are
// held to every real form of 200 fresh throwaway codes, including a code placed right after prose
// that fills the shape, and the shaped prose with no digit must pass both. The server wall is
// driven over the real route, and its refusal must leave no code in the audit file.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import { ROOT } from '../harness.ts';
import { looksLikeInviteCode, parseCode } from '../../../src/invite/code.ts';
import { GUARD_TEXTS } from '../../fixtures/invite-code-texts.ts';
import { makeCode, needlesOf, scan, writeWorld, bootInvite, filesUnder } from '../invite-kit.ts';
import type { AttackCase, AttackCtx, AttackResult } from '../types.ts';

const PROSE = 'phosphorus is used in fertilizer and in matches';

function loadCodeIn(): (text: string) => string | null {
  const src = fs.readFileSync(path.join(ROOT, 'ui', 'core', 'invite.js'), 'utf8');
  const window: Record<string, any> = {};
  vm.runInNewContext(src, { window });
  const fn = window.PhosphorInviteApi?.codeIn;
  if (typeof fn !== 'function') throw new Error('ui/core/invite.js exposed no codeIn');
  return fn;
}

export const attack: AttackCase = {
  id: '13-invite-composer-guard',
  title: 'the composer guard and the server refuse every code form, a code right after prose included; shaped prose passes',
  timeoutMs: 120_000,
  async run(ctx: AttackCtx): Promise<AttackResult> {
    const codeIn = loadCodeIn();
    const misses: string[] = [];

    // 1. Library walls (server copy and window copy) over 200 fresh codes in every form.
    let checked = 0;
    for (let i = 0; i < 200; i += 1) {
      const c = makeCode();
      for (const [form, text] of Object.entries(c.forms)) {
        checked += 1;
        if (!parseCode(form.includes('prose') ? c.code : text).ok) misses.push(`parse rejects a real ${form}`);
        if (!looksLikeInviteCode(text)) misses.push(`server lib missed ${form}`);
        if (codeIn(text) === null) misses.push(`window codeIn missed ${form}`);
      }
    }
    // 2. The shared fixture corpus, both copies must give the corpus's verdict.
    for (const t of GUARD_TEXTS) {
      if (looksLikeInviteCode(t.text) !== t.code) misses.push(`server lib wrong on fixture "${t.name}"`);
      if ((codeIn(t.text) !== null) !== t.code) misses.push(`window codeIn wrong on fixture "${t.name}"`);
    }
    // 3. Shaped prose with no digit: not a code to either copy.
    const proseServer = looksLikeInviteCode(PROSE);
    const proseWindow = codeIn(PROSE) !== null;
    if (proseServer) misses.push('server lib treats the shaped prose as a code');
    if (proseWindow) misses.push('window codeIn treats the shaped prose as a code');

    // 4. Observation, not part of pass: a code whose only digits are 0 and 1, typed with O and L
    //    (Crockford reads both back), parses yet carries no literal digit. Counted over fresh codes.
    //    Built directly: an issuable secret (two digits, a letter check symbol) whose digits are 0 and 1.
    let olSlip = 'none built';
    const LET = 'ABCDEFGHJKMNPQRSTVWXYZ';
    for (let shift = 0; shift < 200 && olSlip === 'none built'; shift += 1) {
      const fill = Array.from({ length: 24 }, (_, i) => LET[(i + shift) % LET.length]).join('');
      const data = '1' + fill + '0';
      let value = 0n;
      for (const ch of data) value = (value << 5n) | BigInt('0123456789ABCDEFGHJKMNPQRSTVWXYZ'.indexOf(ch));
      const check = '0123456789ABCDEFGHJKMNPQRSTVWXYZ*~$=U'[Number(value % 37n)]!;
      if (!/[A-Z]/.test(check) || 'OIL'.includes(check)) continue;
      const real = 'PHOS-' + data + check;
      const typed = 'PHOS-' + data.replace(/0/g, 'O').replace(/1/g, 'L') + check;
      if (looksLikeInviteCode(real) && parseCode(typed).ok && !looksLikeInviteCode(typed) && codeIn(typed) === null) olSlip = 'an issuable code typed with O for 0 and L for 1 parses and passes both copies';
      else olSlip = 'O/L typing caught';
    }

    // 5. The server wall over the real route, and its audit trail.
    const c = makeCode();
    const app = await bootInvite(writeWorld(ctx.scratch, {}));
    const routeRows: string[] = [];
    let auditLeak: string[] = [];
    let proseRow = 'not sent';
    try {
      for (const [form, text] of Object.entries(c.forms)) {
        const r = await app.post('/api/driver', { token: app.token, action: 'prompt', text });
        routeRows.push(`${form}=${r.status}/${r.json?.reason ?? '-'}`);
        if (!(r.status === 400 && r.json?.reason === 'invite-code')) misses.push(`server route let ${form} through (${r.status} ${r.text.slice(0, 80)})`);
      }
      // Shaped prose: send only when no agent is running, so nothing is ever dispatched to a model.
      const driver = (await app.get('/api/driver')).json;
      // Off everywhere means send() throws before any dispatch (src/driver.ts), so the prose reaches no model.
      const allOff = driver?.state === 'off' && driver?.running === false && (driver?.chats ?? []).every((ch: any) => ch.state === 'off' && ch.running === false);
      if (allOff) {
        const r = await app.post('/api/driver', { token: app.token, action: 'prompt', text: PROSE });
        proseRow = `${r.status}/${r.json?.reason ?? (r.json?.error ?? '-')}`;
        if (r.json?.reason === 'invite-code') misses.push('server route refused the shaped prose as a code');
      }
      const audit = filesUnder(app.dataDir).map((f) => f.text).join('\n');
      auditLeak = scan(audit, needlesOf(c));
      if (auditLeak.length > 0) misses.push(`refused prompts left [${auditLeak.join(',')}] in the data dir`);
    } finally {
      await app.stop();
    }

    return {
      expected: 'every code form caught by codeIn, looksLikeInviteCode and POST /api/driver (400 invite-code); shaped prose with no digit passes; no code in the data dir',
      observed: `${checked} form checks x2 copies + ${GUARD_TEXTS.length} fixtures; prose: server=${proseServer} window=${proseWindow} route=${proseRow}; misses: ${misses.length === 0 ? 'none' : misses.slice(0, 6).join('; ')}; observation (not scored): ${olSlip}`,
      pass: misses.length === 0,
      evidence: `route: ${routeRows.join(' ')}; audit scan hits=${auditLeak.length}`,
    };
  },
};

export default attack;
