// 13-invite-replay: a replayed claim and a second claim on the same code are refused, through the
// real routes in demo mode (the invite world is in memory; nothing is published anywhere real).
//   1. the same claim request sent again while the first runs: busy, and a check is busy too;
//   2. after the first lands, the identical request again: empty (the code holds nothing);
//   3. exactly one record and one signed claim exist: no second signature that could land was ever
//      made (a rehearsal, src/invite/claim.ts step 5, is on the record too, flagged, and dead a
//      millisecond past the block it was simulated at);
//   4. a restart on the same data dir re-signs nothing: the done record is left as it was.
// The verifier-side half (a signed claim replayed with any field changed) is 13-invite-replay-sim.

import fs from 'node:fs';
import path from 'node:path';
import { makeCode, writeWorld, bootInvite, waitFor, inviteState, claimRecords, filesUnder } from '../invite-kit.ts';
import type { AttackCase, AttackCtx, AttackResult } from '../types.ts';

export const attack: AttackCase = {
  id: '13-invite-replay',
  title: 'a replayed claim and a second claim on the same code are refused; one code signs once',
  timeoutMs: 150_000,
  async run(ctx: AttackCtx): Promise<AttackResult> {
    const c = makeCode();
    // Both boots share these, in the case's scratch: the runner removes it on a pass, keeps it on a FAIL.
    const home = path.join(ctx.scratch, 'home');
    const dataDir = path.join(ctx.scratch, 'data');
    fs.mkdirSync(home);
    fs.mkdirSync(dataDir);
    const rows: string[] = [];
    const problems: string[] = [];
    const body = (app: { token: string }) => ({ token: app.token, code: c.code });

    let app = await bootInvite(writeWorld(ctx.scratch, { [c.address]: { usdc: '5.00', landMs: 2500 } }), { home, dataDir });
    let attemptsBefore = '';
    try {
      const created = await app.createSoftwareWallet();
      if (created?.ok === false) throw new Error(`wallet create refused: ${JSON.stringify(created)}`);

      // 1. first claim, then the same request replayed at once, three ways.
      const first = await app.post('/api/invite/claim', body(app));
      const [again, againLower, check] = await Promise.all([
        app.post('/api/invite/claim', body(app)),
        app.post('/api/invite/claim', { token: app.token, code: c.forms.lower }),
        app.post('/api/invite/check', body(app)),
      ]);
      rows.push(`first=${first.status}/${first.json?.ok ? 'ok' : first.json?.reason} replay=${again.status}/${again.json?.reason ?? 'ok'} replay(lower)=${againLower.status}/${againLower.json?.reason ?? 'ok'} check=${check.json?.reason ?? 'ok'}`);
      if (first.status !== 202) problems.push(`first claim not accepted: ${first.text.slice(0, 80)}`);
      if (again.json?.ok === true || againLower.json?.ok === true) problems.push('a replay during the run was accepted');

      const end = await waitFor(async () => {
        const s = await inviteState(app);
        return s && s.status !== 'running' ? s : null;
      }, 25_000);
      rows.push(`end=${end?.status ?? 'none'}`);
      if (end?.status !== 'landed') problems.push(`first claim did not land (${end?.status ?? 'no end'})`);

      // 2. the identical request after it landed, and a check.
      const late = await app.post('/api/invite/claim', body(app));
      const lateCheck = await app.post('/api/invite/check', body(app));
      rows.push(`after-land replay=${late.status}/${late.json?.reason ?? 'ok'} check=${lateCheck.json?.reason ?? 'ok'}`);
      if (late.json?.ok === true) problems.push('a second claim on a spent code was accepted');
      if (late.json?.reason !== 'empty') problems.push(`after-land replay said ${late.json?.reason}, not empty`);

      await new Promise((r) => setTimeout(r, 500));
      // 3. one record, one claim that could land, plus its rehearsals.
      const recs = claimRecords(dataDir).filter((x) => x.codeAddress === c.address);
      const all = recs.flatMap((x) => (x.attempts ?? []) as Array<{ rehearsal?: true }>);
      const attempts = all.filter((a) => a.rehearsal !== true).length;
      const rehearsals = all.length - attempts;
      const paidLines = filesUnder(dataDir).flatMap((f) => f.text.split('\n')).filter((l) => l.includes('"invite_claimed"') || l.includes('invite_claimed')).length;
      attemptsBefore = JSON.stringify(recs.map((x) => [x.status, x.attempts?.map((a: any) => a.nonce)]));
      rows.push(`records=${recs.length} attempts=${attempts} rehearsals=${rehearsals} paid-lines=${paidLines}`);
      if (recs.length !== 1 || attempts !== 1) problems.push(`expected 1 record and 1 signed claim, saw ${recs.length} and ${attempts}`);
    } finally {
      await app.stop();
    }

    // 4. restart on the same data dir: the done record is not signed again.
    app = await bootInvite(writeWorld(ctx.scratch, { [c.address]: { usdc: '5.00', landMs: 200 } }), { home, dataDir });
    try {
      await new Promise((r) => setTimeout(r, 2500));
      const recs = claimRecords(dataDir).filter((x) => x.codeAddress === c.address);
      const after = JSON.stringify(recs.map((x) => [x.status, x.attempts?.map((a: any) => a.nonce)]));
      const st = await inviteState(app);
      rows.push(`restart: record unchanged=${after === attemptsBefore} state.invite=${st === null ? 'null' : st.status}`);
      if (after !== attemptsBefore) problems.push('a restart changed the claim record (re-signed or re-ran)');
    } finally {
      await app.stop();
    }

    return {
      expected: 'replay during the run: busy; replay after landing: empty; 1 record, 1 signed claim (rehearsals flagged apart); restart re-signs nothing',
      observed: problems.length === 0 ? 'every replay refused; the code signed exactly once' : problems.join('; '),
      pass: problems.length === 0,
      evidence: rows.join(' | '),
    };
  },
};

export default attack;
