// The lock half of "the screen locked, lock the wallet": the backend's when-idle lock (/api/lock
// whenIdle:true), which is exactly what the shell's session_watch posts on a screen lock. It must
// lock an open wallet while leaving a move that is waiting for a click untouched, so a person who
// walked away comes back to a locked key and a decision still theirs to make. The shell wiring that
// fires this on a real screen lock is case 10-screen-lock-shell.

import { bootBackend } from '../harness.ts';
import type { AttackCase, AttackCtx, AttackResult } from '../types.ts';

export const attack: AttackCase = {
  id: '10-screen-lock-backend',
  title: 'the when-idle lock locks an open wallet and a pending move survives it',
  async run(_ctx: AttackCtx): Promise<AttackResult> {
    const app = await bootBackend();
    try {
      const made = await app.createSoftwareWallet();
      if (made?.ok !== true) throw new Error(`could not create a software wallet: ${JSON.stringify(made).slice(0, 120)}`);
      const unlocked = (await app.health()).locked === false;

      // A move waiting for a click: an outside agent files a policy change, which always needs a
      // click, so it parks pending. It is not executing, so the when-idle lock must not refuse.
      const { client, close } = await app.mcpOutside();
      let proposalId = '';
      try {
        const p = await app.callTool(client, 'propose_policy_change', {
          patch: { outbound: { humanClickAboveUsd: 90 } },
          sentence: 'Ask me before anything above $90.',
        });
        proposalId = p?.id ?? '';
      } finally {
        await close();
      }
      const pendingBefore = (await app.get('/api/state')).json?.proposals?.some((p: any) => p.id === proposalId && p.status === 'pending');

      // Exactly what session_watch posts: the when-idle lock, with the screen-lock reason.
      const locked = await app.post('/api/lock', { token: app.token, whenIdle: true, reason: 'the screen locked' });
      const afterLocked = (await app.health()).locked === true;
      const pendingAfter = (await app.get('/api/state')).json?.proposals?.some((p: any) => p.id === proposalId && p.status === 'pending');

      const pass = unlocked && locked.status === 200 && locked.json?.ok === true && afterLocked && pendingBefore === true && pendingAfter === true;
      return {
        expected: 'open wallet locks on the when-idle lock; the pending move is still pending afterward',
        observed: `unlocked_before=${unlocked} lock_http=${locked.status}/${locked.json?.ok} locked_after=${afterLocked} pending ${pendingBefore}->${pendingAfter}`,
        pass,
        evidence: `POST /api/lock {whenIdle:true} -> health.locked ${unlocked ? 'false' : '?'}->${afterLocked}, proposal ${proposalId.slice(0, 10)} stays pending`,
      };
    } finally {
      await app.stop();
    }
  },
};

export default attack;
