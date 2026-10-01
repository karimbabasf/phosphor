// security-model.md: the window token and this boot's seat secret are the two credentials that must
// never reach a local process, and the model says neither appears in /api/state, /api/log, an SSE
// frame, or any file this process writes (the log tail redacts them on the way out). If either
// leaked, a local reader could approve or post as a seat. This drives real activity, then scans
// every readable surface for both secrets. (security-model.md claim with no single system test of
// its own: the "item 14" addition.)

import fs from 'node:fs';
import path from 'node:path';
import { bootBackend } from '../harness.ts';
import type { AttackCase, AttackCtx, AttackResult } from '../types.ts';

function walk(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

async function readEvents(base: string, ms: number): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(`${base}/api/events`, { signal: ctrl.signal });
    const reader = res.body?.getReader();
    if (!reader) return '';
    let text = '';
    const dec = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
      if (text.length > 200_000) break;
    }
    return text;
  } catch {
    return '';
  } finally {
    clearTimeout(t);
  }
}

export const attack: AttackCase = {
  id: '14-secret-no-leak',
  title: 'the window token and the seat secret never reach /api/state, /api/log, the event stream, a file, or the console',
  async run(_ctx: AttackCtx): Promise<AttackResult> {
    const app = await bootBackend();
    const token = app.token;
    try {
      // The by-hand seat secret the app wrote for an outside proxy: the second credential.
      const agentSecretPath = path.join(app.dataDir, 'agent.secret');
      const agentSecret = fs.existsSync(agentSecretPath) ? fs.readFileSync(agentSecretPath, 'utf8').trim() : '';

      // Drive activity that writes to state, the log and the event stream: a switch, a policy change
      // proposed and approved (a human click, with the token), the kill switch on and off.
      const eventsP = readEvents(app.base, 1500);
      const { client, close } = await app.mcpOutside();
      try {
        await app.callTool(client, 'switch', { mode: 'pro' });
        const p = await app.callTool(client, 'propose_policy_change', { patch: { outbound: { humanClickAboveUsd: 123 } }, sentence: 'Ask me before anything above $123.' });
        if (p?.id) await app.post('/api/approve', { id: p.id, token });
      } finally {
        await close();
      }
      await app.post('/api/kill', { on: true, token });
      await app.post('/api/kill', { on: false, token });
      const events = await eventsP;

      const state = (await app.get('/api/state')).text;
      const log = (await app.get('/api/log?limit=500')).text;
      // Every file EXCEPT agent.secret itself, which is the designated 0600 holder of the seat
      // secret for a by-hand proxy: finding it there is the file working, not a leak. The window
      // token must appear in no file at all, agent.secret included.
      const fileList = walk(app.dataDir);
      const console_ = app.output();

      const hits: string[] = [];
      const scanBlob = (name: string, blob: string, checkSeat: boolean): void => {
        if (token.length >= 16 && blob.includes(token)) hits.push(`${name}:window-token`);
        if (checkSeat && agentSecret.length >= 16 && blob.includes(agentSecret)) hits.push(`${name}:seat-secret`);
      };
      scanBlob('/api/state', state, true);
      scanBlob('/api/log', log, true);
      scanBlob('/api/events', events, true);
      scanBlob('console', console_, true);
      for (const f of fileList) {
        let blob = '';
        try {
          blob = fs.readFileSync(f, 'utf8');
        } catch {
          continue;
        }
        scanBlob(`file:${path.basename(f)}`, blob, path.basename(f) !== 'agent.secret');
      }
      const files = fileList;

      // Control: the token must be a real, long secret, or "absent" would prove nothing.
      const sane = token.length >= 32 && agentSecret.length >= 32;
      const pass = sane && hits.length === 0;
      return {
        expected: 'neither the window token nor the seat secret appears on any surface after real activity',
        observed: `scanned state/log/events/${files.length} files/console (${state.length + log.length + events.length + console_.length} bytes + files); leaks: ${hits.length === 0 ? 'none' : hits.join(', ')}`,
        pass,
        evidence: `token len=${token.length}, seat len=${agentSecret.length}; hits=${hits.length}`,
      };
    } finally {
      await app.stop();
    }
  },
};

export default attack;
