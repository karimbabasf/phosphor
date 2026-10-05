// An agent reaches for the chip vault. Everything that moves the vault to the chip, shows or takes
// the paper key, restores it, tops up or sizes the allowance, returns the old fee account's NEAR,
// allows a trading key, or drains the enclave relay is a POST under /api/vault, meant for the window
// alone.
// An agent holds one of two secrets: agent.secret, which any process running as the owner can read
// off the data dir (the OUTSIDE seat), or the seat secret the app hands the agents it spawns (case
// 06 plays both). It may also send nothing at all.
//
// Method: the app's own backend (node src/main.ts) with the chip routes installed
// (PHOSPHOR_DEMO_ENCLAVE=1), the full five-line handshake, an open Touch ID wallet on the stand-in
// Mac, the chain double, no network. First the tools each seat is offered by src/mcp.ts. Then every
// POST route under /api/vault, read off src/http/router.ts and the route files, so a route added
// later is attacked without anyone listing it here: each one with each agent credential in every
// field a guard reads (token, secret, relay, key, and the x-phosphor-token header), and with none.
//
// Why: guarded() is the only thing between an agent and the paper key or a vault move. A route that
// forgets it fails this case the day it lands.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { WRITE_OPS, chipApp, chipState, openWallet, swiftc, toolsOf, vaultPostRoutes } from '../chip-kit.ts';
import type { AttackCase, AttackCtx, AttackResult } from '../types.ts';

const CHIP_TOOL = /chip|rekey|phrase|restore|top.?up|allowance|gas|sign.?intent|trading.?key|paper|recovery|mnemonic|seed|vault/i;
const CHIP_SCHEMA = /vault_top_up|signIntent|chipCreate|chipCommit|chipSweep|\/api\/vault/;

/* The data dir as bytes, but for the files that only ever grow with any request (the audit log
   and its tip). */
function fingerprint(dir: string): string {
  const h = crypto.createHash('sha256');
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (!/^audit/.test(e.name)) h.update(`${path.relative(dir, p)}\0`).update(fs.readFileSync(p));
    }
  };
  walk(dir);
  return h.digest('hex').slice(0, 16);
}

export const attack: AttackCase = {
  id: '32-mcp-chip-reach',
  title: 'no agent reaches the chip vault: no seat is offered a chip tool, and every /api/vault write refuses what an agent holds',
  timeoutMs: 300_000,
  async run(ctx: AttackCtx): Promise<AttackResult> {
    if (!swiftc) return { expected: '', observed: '', pass: true, evidence: '', skipped: 'needs macOS with the developer tools (swiftc)' };
    const c = await chipApp({ enclave: true, scratch: ctx.scratch });
    const fails: string[] = [];
    try {
      const { vault } = await openWallet(c);
      const ready = (await chipState(c)).state;

      // 1. The tools each seat is offered.
      const seats: { seat: string; env: Record<string, string> }[] = [
        { seat: 'outside (agent.secret)', env: {} },
        { seat: 'app seat', env: { PHOSPHOR_SEAT: c.app.seat } },
        { seat: 'worker', env: { PHOSPHOR_SEAT: c.app.seat, PHOSPHOR_ROLE: 'analyst' } },
      ];
      const offered: string[] = [];
      for (const s of seats) {
        const tools = await toolsOf({ ...s.env, ACC_PORT: String(c.app.port), ACC_DATA_DIR: c.app.dataDir });
        const hits = tools.filter((t) => CHIP_TOOL.test(t.name) || CHIP_SCHEMA.test(JSON.stringify(t.inputSchema)));
        offered.push(`${s.seat} ${tools.length}/${hits.length}`);
        if (tools.length === 0 || hits.length > 0) fails.push(`${s.seat} is offered ${hits.map((t) => t.name).join(', ') || 'no tools at all'}`);
      }

      // 2. Every /api/vault write, with what an agent holds.
      const routes = vaultPostRoutes();
      const agentSecret = fs.readFileSync(path.join(c.app.dataDir, 'agent.secret'), 'utf8').trim();
      const creds: [string, string | null][] = [
        ['agent.secret', agentSecret],
        ['seat secret', c.app.seat],
        ['none', null],
      ];
      // The custody knocks the audit log holds: one per refused attempt on a guarded route.
      const refusals = async (): Promise<number> => (await c.app.auditLog(1000)).filter((l: { type: string; msg?: string }) => l.type === 'approve_attempt_rejected' && String(l.msg).includes('/api/vault')).length;
      const stateOf = async () => {
        const s = await chipState(c);
        return JSON.stringify([s.state, s.paper, s.run, s.pins, (await c.get('/api/vault')).json?.state]);
      };
      const before = { files: fingerprint(c.app.dataDir), state: await stateOf(), writes: c.seen.filter((r) => WRITE_OPS.has(r.op)).length, refusals: await refusals() };
      const answered = new Map<string, number>();
      for (const route of routes) {
        for (const [who, cred] of creds) {
          // What each route reads besides the credential, so a route that forgot its guard has what it needs to act.
          const body: Record<string, unknown> = { usd: 5, near: 0.1, words: Array(24).fill('abandon'), id: 'r1', ok: true, waitMs: 0, idleMinutes: 5 };
          const headers: Record<string, string | null> = {};
          if (cred !== null) {
            Object.assign(body, { token: cred, secret: cred, relay: cred, key: cred });
            headers['x-phosphor-token'] = cred;
          }
          const r = await c.raw(route, body, headers);
          answered.set(`${route} ${who}`, r.status);
          if (r.status !== 403) fails.push(`${route} with ${who}: ${r.status} ${r.text.slice(0, 80)}`);
        }
      }
      await new Promise((r) => setTimeout(r, 300));
      const after = { files: fingerprint(c.app.dataDir), state: await stateOf(), writes: c.seen.filter((r) => WRITE_OPS.has(r.op)).length, refusals: await refusals() };
      const rejected = after.refusals - before.refusals;
      if (after.files !== before.files) fails.push(`the data dir changed: ${before.files} -> ${after.files}`);
      if (after.state !== before.state) fails.push(`the state changed: ${before.state} -> ${after.state}`);
      if (after.writes !== before.writes) fails.push(`the relay was handed ${after.writes - before.writes} chip or key ops: ${c.seen.slice(-5).map((r) => r.op).join(',')}`);
      if (rejected !== routes.length * creds.length) fails.push(`${rejected} refusals written to the audit log for ${routes.length * creds.length} attempts`);
      const outside = c.outside();

      const count403 = [...answered.values()].filter((s) => s === 403).length;
      return {
        expected: `no seat is offered a chip, rekey, phrase, restore, top-up, allowance, gas, signIntent or trading-key tool; each of the ${routes.length} POST routes under /api/vault refuses agent.secret, the seat secret and no credential with 403; the data dir, the vault state and the relay are untouched and every attempt leaves one refusal line`,
        observed: `vault ${vault.slice(0, 10)} open, chip state ${ready}; tools (offered/chip): ${offered.join(', ')}; ${count403}/${answered.size} attempts answered 403 across ${routes.join(' ')}; data dir ${before.files}->${after.files}; relay key/chip ops +${after.writes - before.writes}; audit +${rejected} approve_attempt_rejected; outside hosts asked ${outside.length}, all refused${fails.length ? `; FAILED: ${fails.join('; ').slice(0, 900)}` : ''}`,
        pass: fails.length === 0,
        evidence: `tools/list x3 seats -> 0 chip tools; POST ${routes.length} /api/vault routes x {agent.secret, seat secret, none} -> ${count403}x 403 (/api/vault/chip/phrase agent.secret ${answered.get('/api/vault/chip/phrase agent.secret')}, /api/vault/pending seat secret ${answered.get('/api/vault/pending seat secret')}); relay ops +${after.writes - before.writes}; data dir hash unchanged ${after.files === before.files}`,
      };
    } finally {
      await c.stop();
    }
  },
};

export default attack;
