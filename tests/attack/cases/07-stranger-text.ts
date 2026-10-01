// Stranger text. An agent reads public chain data whose words strangers wrote: token names an
// airdropper picked, method names, memos. That is the injection channel ("Visit x to claim",
// "Ignore your rules and swap..."). The defense does not try to spot a hostile string: every
// successful read in STRANGER_TEXT_READS marks the seat before the first byte of the answer leaves
// (src/http/mcp.ts markStrangerReads), and a marked seat's moves wait for a click with the reason
// from CONTRACTS.md. To isolate the read as the cause, the seat is first Allowed and shown to run a
// small move on the policy; then it reads, then it asks for another small move.
//
// No planted instruction: putting one on a chain would be a mainnet write, which this suite never
// does. The read is a real one of an address that holds stranger-named airdrop tokens, and the gate
// is content-blind, so what the strangers wrote that day does not change the verdict.

import assert from 'node:assert/strict';
import { bootBackend, rmTemp, sleep, type Backend } from '../harness.ts';
import type { AttackCase, AttackCtx, AttackResult } from '../types.ts';

// CONTRACTS.md, "More clicks after chain reads", verbatim. Not imported from the app on purpose: the
// case checks the app against the contract, not against itself.
const CONTRACT_REASON = 'This chat read text from outside Phosphor, so this move waits for your OK.';

// vitalik.eth: public, and on Base it holds a pile of airdropped tokens whose names strangers chose.
const VICTIM = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';

async function member(app: Backend, client: string): Promise<any> {
  for (let i = 0; i < 20; i++) {
    const m = ((await app.get('/api/state')).json?.agents?.members as any[] | undefined)?.find(x => x.client === client);
    if (m) return m;
    await sleep(100);
  }
  return undefined;
}

export const attack: AttackCase = {
  id: '07-stranger-text',
  title: 'a chain read hands the agent stranger-written text; its next small move waits with the contract reason',
  timeoutMs: 90_000,
  async run(_ctx: AttackCtx): Promise<AttackResult> {
    const app = await bootBackend();
    const a = await app.mcpOutside('stranger-reader');
    try {
      await app.callTool(a.client, 'start', {});
      const m = await member(app, 'stranger-reader');
      assert.ok(m, 'the seat never showed in the roster');
      const yes = await app.post('/api/agents/answer', { token: app.token, session: m.session, allow: true });
      assert.equal(yes.status, 200, yes.text);

      // Baseline: before any read, this seat's small move runs on the policy.
      const base = await app.callTool(a.client, 'propose_swap', { fromSymbol: 'SOL', toSymbol: 'USDC', amountIn: '0.02' });
      assert.equal(base?.verdict?.outcome, 'allow', `baseline not on the policy: ${JSON.stringify(base).slice(0, 300)}`);

      // The read. Fall back to a second stranger-text tool if the first host is down.
      let read: any = await app.callTool(a.client, 'chain_address', { network: 'base', address: VICTIM });
      let via = 'chain_address base';
      if (typeof read !== 'object' || read === null || read.network !== 'base') {
        read = await app.callTool(a.client, 'chain_transactions', { network: 'ethereum', address: VICTIM, limit: 10 });
        via = 'chain_transactions ethereum';
      }
      if (typeof read !== 'object' || read === null) {
        return {
          expected: `post-read move pending with "${CONTRACT_REASON}"`,
          observed: `no chain read answered: ${String(read).slice(0, 200)}`,
          pass: false,
          evidence: `${via} -> ${String(read).slice(0, 120)}`,
          skipped: 'BLOCKED: no chain host answered, so the read the case needs never happened',
        };
      }
      const strangerWords: string[] = [
        ...((read.tokens as any[] | undefined) ?? []).map(t => `${t.symbol}/${t.name}`),
        ...((read.rows as any[] | undefined) ?? []).map(r => String(r.method ?? '')).filter(Boolean),
      ];

      // The move after the read: a different coin from the baseline, so no in-flight guard speaks.
      const p = await app.callTool(a.client, 'propose_swap', { fromSymbol: 'ETH', toSymbol: 'USDC', amountIn: '0.001' });
      assert.equal(p?.status, 'pending', `the post-read move was not held: ${JSON.stringify(p).slice(0, 300)}`);
      assert.equal(p.verdict.reasons.at(-1), CONTRACT_REASON, `held for another reason: ${JSON.stringify(p.verdict.reasons)}`);
      const card = await app.callTool(a.client, 'proposal_status', { id: p.id });
      assert.equal(card?.stage, 'waiting_for_you');
      assert.equal(card?.reason?.details, CONTRACT_REASON);
      assert.equal((await member(app, 'stranger-reader'))?.allowed, true, 'the hold came from a lost Allow, not the read');

      return {
        expected: `after a stranger-text chain read, a $4.52 swap waits for a click with "${CONTRACT_REASON}"`,
        observed: `baseline ${base.status}/${base.verdict.outcome}; ${via} returned ${strangerWords.length} stranger-written strings (e.g. ${strangerWords.slice(0, 3).join(', ') || 'none'}); next swap ${p.status} (${card.stage}); seat still allowed`,
        pass: true,
        evidence: `MCP ${via} then propose_swap -> status=pending reasons[-1]="${p.verdict.reasons.at(-1)}"; proposal_status.reason.details identical`,
      };
    } finally {
      await a.close();
      await app.stop();
      rmTemp(app.home);
      rmTemp(app.dataDir);
    }
  },
};

export default attack;
