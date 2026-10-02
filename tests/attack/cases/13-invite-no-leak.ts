// 13-invite-no-leak: an invite code is a bearer key to money, so after a full check and claim
// through the real routes it must be on no surface the app writes or serves: /api/state, the audit
// tail (/api/log), the event stream, the audit file, the pending file (invites.json), any other
// file in the data dir or HOME, the process's console output, and every read MCP tool an outside
// agent can call. The code is a fresh throwaway from src/invite/code.ts, funded only in the demo
// invite world (in memory, no network). Every surface is grepped for the code in five spellings,
// its secret, its derived key, and the canonical shape.

import { makeCode, needlesOf, scan, writeWorld, bootInvite, openStream, waitFor, inviteState, filesUnder, claimRecords } from '../invite-kit.ts';
import type { AttackCase, AttackCtx, AttackResult } from '../types.ts';

// Read tools an outside agent may call with no arguments. Intersected with what the server lists.
const READ_TOOLS = ['start', 'wallet', 'log_tail', 'diagnose', 'policy_show', 'proposals', 'intents_activity', 'composition', 'whats_new', 'deposit', 'profile_learned', 'agent_board', 'agent_jobs', 'agent_roster'];

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | string> {
  return Promise.race([p, new Promise<string>((r) => setTimeout(() => r(`(timed out after ${ms} ms)`), ms))]);
}

export const attack: AttackCase = {
  id: '13-invite-no-leak',
  title: 'an invite code driven through check and claim appears on no surface: state, log, stream, files, console, MCP',
  timeoutMs: 120_000,
  async run(ctx: AttackCtx): Promise<AttackResult> {
    const c = makeCode();
    const world = writeWorld(ctx.scratch, { [c.address]: { usdc: '5.00', landMs: 200 } });
    const app = await bootInvite(world);
    const stream = openStream(app);
    try {
      const created = await app.createSoftwareWallet();
      if (created?.ok === false) throw new Error(`wallet create refused: ${JSON.stringify(created)}`);

      // Drive every path the code can travel, in several spellings, plus the refusals.
      const steps: string[] = [];
      const say = (label: string, r: { status: number; json: any }) => steps.push(`${label}=${r.status}:${r.json?.reason ?? (r.json?.ok === true ? 'ok' : JSON.stringify(r.json))}`);
      say('check(upper)', await app.post('/api/invite/check', { token: app.token, code: c.forms.upper }));
      say('check(link)', await app.post('/api/invite/check', { token: app.token, code: c.forms.link.toLowerCase() }));
      say('check(typo)', await app.post('/api/invite/check', { token: app.token, code: c.code.slice(0, -2) + 'ZZ' }));
      say('claim(no token)', await app.post('/api/invite/claim', { code: c.code }));
      say('claim(bad token)', await app.post('/api/invite/claim', { token: 'f'.repeat(64), code: c.code }));
      say('prompt(code)', await app.post('/api/driver', { token: app.token, action: 'prompt', text: `my invite ${c.forms.spaces}` }));
      const claim = await app.post('/api/invite/claim', { token: app.token, code: c.forms['no hyphens'] });
      say('claim', claim);
      const landed = await waitFor(async () => {
        const s = await inviteState(app);
        return s && s.status !== 'running' ? s : null;
      }, 20_000);
      say('claim again', await app.post('/api/invite/claim', { token: app.token, code: c.code }));
      await new Promise((r) => setTimeout(r, 400));

      // Gather every surface.
      const surfaces: Record<string, string> = {};
      // Read as the window reads them; a refused read would scan an error page, so each must be a 200.
      const refused: string[] = [];
      for (const route of ['/api/state', '/api/log?limit=2000', '/api/driver']) {
        const r = await app.get(route);
        if (r.status !== 200) refused.push(`${route} ${r.status}`);
        surfaces[route.replace(/\?.*$/, '')] = r.text;
      }
      surfaces['event stream'] = stream.text();
      for (const f of filesUnder(app.dataDir)) surfaces[`data:${f.file.slice(app.dataDir.length)}`] = f.text;
      for (const f of filesUnder(app.home)) surfaces[`home:${f.file.slice(app.home.length)}`] = f.text;

      const { client, close } = await app.mcpOutside();
      const toolsCalled: string[] = [];
      try {
        const listed = new Set((await client.listTools()).tools.map((t) => t.name));
        for (const name of READ_TOOLS.filter((t) => listed.has(t))) {
          const out = await withTimeout(app.callTool(client, name, {}).catch((e: unknown) => `(error ${String(e)})`), 10_000);
          surfaces[`mcp:${name}`] = typeof out === 'string' ? out : JSON.stringify(out);
          toolsCalled.push(name);
        }
      } finally {
        await close();
      }
      surfaces['console'] = app.output();

      const needles = needlesOf(c);
      // Positive control: the scanner must see every form, or a clean scan proves nothing.
      const blind = Object.entries(c.forms).filter(([, text]) => scan(`x ${text} y`, needles).length === 0);
      if (blind.length > 0) throw new Error(`scanner blind to: ${blind.map(([n]) => n).join(', ')}`);
      const leaks: string[] = [];
      for (const [name, text] of Object.entries(surfaces)) {
        const hits = scan(text, needles);
        if (hits.length > 0) leaks.push(`${name} [${hits.join(',')}]`);
      }

      const records = claimRecords(app.dataDir);
      const frames = stream.frames().filter((f) => f.type === 'invite');
      const ranEnd = landed?.status ?? 'none';
      const bytes = Object.values(surfaces).reduce((n, t) => n + t.length, 0);
      const drove = ranEnd === 'landed' && records.length === 1 && frames.length >= 2 && refused.length === 0;

      return {
        expected: 'the code (5 spellings), its secret and key, and the code shape absent from every surface',
        observed: `claim ended ${ranEnd}; ${records.length} record(s); ${frames.length} invite frames; ${Object.keys(surfaces).length} surfaces, ${bytes} bytes; MCP tools read: ${toolsCalled.length} (${toolsCalled.filter((t) => /^\(error|timed out/.test(surfaces[`mcp:${t}`] ?? '')).length} errored); scanner control saw all ${Object.keys(c.forms).length} forms; leaks: ${leaks.length === 0 ? 'none' : leaks.join('; ')}`,
        pass: drove && leaks.length === 0,
        evidence: `${steps.join(' ')} | grep of ${Object.keys(surfaces).length} surfaces -> ${leaks.length} hits${refused.length > 0 ? ` (READS REFUSED: ${refused.join(', ')})` : ''}${drove ? '' : ' (FLOW DID NOT COMPLETE: the scan proves less)'}`,
      };
    } finally {
      stream.close();
      await app.stop();
    }
  },
};

export default attack;
