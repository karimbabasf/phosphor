// 13-invite-tampered-header: the plaintext header of keys.enc.json is editable by any process
// running as the owner. An attacker who swaps its EVM address for their own must not become the
// receiver of an invite claim. The claim's receiver is the DECRYPTED, verified address
// (src/invite/claim.ts verifiedReceiver), never the header's.
//   A. wallet open, header edited on disk under it: the claim pays the decrypted address.
//   B. fresh boot on the edited file (locked, header unverified): the claim is refused; the right
//      password then reports "tampered" and the wallet serves no address, so the claim stays refused.
//   C. the attacker also deletes headerProof: unlock reads as a wrong password; still refused.
// Everything runs in demo mode against the in-memory invite world; the attacker key is throwaway.

import fs from 'node:fs';
import path from 'node:path';

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { makeCode, writeWorld, bootInvite, waitFor, inviteState, findKeystore, claimRecords, filesUnder } from '../invite-kit.ts';
import type { AttackCase, AttackCtx, AttackResult } from '../types.ts';

const PASSWORD = 'a long enough password for the tamper case';

function tamper(file: string, evm: string, dropProof = false): void {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.header.addresses.evm = evm;
  if (dropProof) delete raw.headerProof;
  fs.writeFileSync(file, JSON.stringify(raw));
}

export const attack: AttackCase = {
  id: '13-invite-tampered-header',
  title: 'an invite claim never pays the plaintext keystore header: an edited header address is refused or ignored',
  timeoutMs: 150_000,
  async run(ctx: AttackCtx): Promise<AttackResult> {
    const attacker = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
    const codeA = makeCode();
    const codeB = makeCode();
    // Both boots share these, in the case's scratch: the runner removes it on a pass, keeps it on a FAIL.
    const home = path.join(ctx.scratch, 'home');
    const dataDir = path.join(ctx.scratch, 'data');
    fs.mkdirSync(home);
    fs.mkdirSync(dataDir);
    const rows: string[] = [];
    const problems: string[] = [];

    // ---- A: open wallet, header edited under it.
    let real = '';
    let app = await bootInvite(writeWorld(ctx.scratch, { [codeA.address]: { usdc: '5.00', landMs: 200 } }), { home, dataDir });
    try {
      const created = await app.createSoftwareWallet(PASSWORD);
      if (created?.ok === false) throw new Error(`wallet create refused: ${JSON.stringify(created)}`);
      const ks = findKeystore(home, dataDir);
      if (ks === null) throw new Error('no keys.enc.json under the throwaway HOME or data dir');
      real = String(JSON.parse(fs.readFileSync(ks, 'utf8')).header.addresses.evm).toLowerCase();
      tamper(ks, attacker);
      const onDisk = String(JSON.parse(fs.readFileSync(ks, 'utf8')).header.addresses.evm).toLowerCase();
      if (onDisk !== attacker) throw new Error('the tamper did not stick');

      const r = await app.post('/api/invite/claim', { token: app.token, code: codeA.code });
      rows.push(`A claim=${r.status}/${r.json?.ok === true ? 'ok' : r.json?.reason}`);
      const end = await waitFor(async () => {
        const s = await inviteState(app);
        return s && s.status !== 'running' ? s : null;
      }, 20_000);
      const recs = claimRecords(dataDir);
      const receivers = recs.map((x) => String(x.receiver).toLowerCase());
      const auditPaid = filesUnder(dataDir)
        .flatMap((f) => f.text.split('\n'))
        .filter((l) => l.includes('invite_claimed'));
      rows.push(`A end=${end?.status ?? 'none'} receivers=[${receivers.map((x) => x.slice(0, 10)).join(',')}] real=${real.slice(0, 10)} attacker=${attacker.slice(0, 10)}`);
      if (receivers.includes(attacker) || auditPaid.some((l) => l.toLowerCase().includes(attacker))) problems.push('A: the claim named the attacker');
      if (r.status === 202 && !(receivers.length === 1 && receivers[0] === real)) problems.push('A: accepted claim did not name the decrypted address');
      if (r.status !== 202 && r.json?.reason !== 'wallet-locked') problems.push(`A: unexpected answer ${r.text.slice(0, 80)}`);
    } finally {
      await app.stop();
    }

    // ---- B and C: fresh boot on the edited file.
    app = await bootInvite(writeWorld(ctx.scratch, { [codeB.address]: { usdc: '7.00', landMs: 200 } }), { home, dataDir });
    try {
      const state0 = (await app.get('/api/state')).json;
      const lockInfo = JSON.stringify(state0).match(/"verified":(true|false)/)?.[1] ?? '?';
      const r1 = await app.post('/api/invite/claim', { token: app.token, code: codeB.code });
      rows.push(`B locked claim=${r1.status}/${r1.json?.reason ?? r1.json?.ok} (header verified=${lockInfo})`);
      if (r1.json?.ok === true) problems.push('B: a locked wallet with an edited header accepted a claim');

      const u = await app.post('/api/unlock', { token: app.token, password: PASSWORD });
      rows.push(`B unlock=${u.status}/${u.json?.ok === true ? 'ok' : u.json?.code ?? u.json?.error}`);
      if ((u.json?.code ?? u.json?.error) !== 'tampered') problems.push(`B: unlock with the right password said ${u.text.slice(0, 80)}, not tampered`);
      const r2 = await app.post('/api/invite/claim', { token: app.token, code: codeB.code });
      rows.push(`B claim after unlock=${r2.status}/${r2.json?.reason ?? r2.json?.ok}`);
      if (r2.json?.ok === true) problems.push('B: claim accepted after a tampered unlock');

      // C: the proof deleted as well, so the right password reads as wrong.
      const ks = findKeystore(home, dataDir)!;
      tamper(ks, attacker, true);
      const u2 = await app.post('/api/unlock', { token: app.token, password: PASSWORD });
      rows.push(`C unlock=${u2.status}/${u2.json?.ok === true ? 'ok' : u2.json?.code ?? u2.json?.error}`);
      if (u2.json?.ok === true) problems.push('C: an edited header without its proof unlocked');
      const r3 = await app.post('/api/invite/claim', { token: app.token, code: codeB.code });
      rows.push(`C claim=${r3.status}/${r3.json?.reason ?? r3.json?.ok}`);
      if (r3.json?.ok === true) problems.push('C: claim accepted');

      await new Promise((r) => setTimeout(r, 500));
      const recs = claimRecords(dataDir);
      if (recs.some((x) => String(x.receiver).toLowerCase() === attacker)) problems.push('B/C: a record names the attacker');
      if (recs.some((x) => x.codeAddress === codeB.address)) problems.push('B/C: code B was signed for');
      rows.push(`records=${recs.length} (code B records=${recs.filter((x) => x.codeAddress === codeB.address).length})`);
    } finally {
      await app.stop();
    }

    return {
      expected: 'A: claim pays the decrypted address, never the edited header; B/C: claim refused wallet-locked, unlock reports tampered (or wrong password without the proof), no record names the attacker',
      observed: problems.length === 0 ? 'receiver was the decrypted address in A; every B/C claim refused; attacker named nowhere' : problems.join('; '),
      pass: problems.length === 0,
      evidence: rows.join(' | '),
    };
  },
};

export default attack;
