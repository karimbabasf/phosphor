// An agent wants vault money. Once the vault moved to the chip, the rails spend the allowance, and
// the only way more comes out of the vault is a top-up the chip key signs behind one Touch ID. So an
// agent that wants more tries every door to a top-up: a top-up tool, a vault_top_up draft through
// the propose door, the window's top-up route with what an agent holds, a swap bigger than the
// allowance that would pull the difference from the vault, a click on its own move, and a small move
// the policy runs on its own while the allowance is short.
//
// Method: one Mac wired as src/main.ts wires it (tests/unit/helpers/wave3-world.ts: the vault
// service's rules on the stand-in keychain, the chain double, the real server and its agent door
// with the app's seat secret), a vault moved through the window's routes. The agent's tools come
// from src/mcp.ts as each seat is offered them. Every chip signIntent the shell relays is counted.
//
// Why: an agent may spend the allowance and nothing more. The vault moves only on a person's click
// and the chip's Touch ID, and that click must be the person's, never the agent's.

import path from 'node:path';
import fs from 'node:fs';
import { english, generateMnemonic } from 'viem/accounts';

import { savePolicy } from '../../../src/policy/file.ts';
import { USDC } from '../../unit/helpers/allowance-world.ts';
import { seededPolicy } from '../../unit/helpers/proposals.ts';
import { VaultDouble } from '../../unit/helpers/vault-double.ts';
import { SEAT, wave3World } from '../../unit/helpers/wave3-world.ts';
import type { Wave3World } from '../../unit/helpers/wave3-world.ts';
import { swiftc, toolsOf } from '../chip-kit.ts';
import type { AttackCase, AttackCtx, AttackResult } from '../types.ts';

const TOP_UP_TOOL = /top.?up|allowance|vault|chip|sign.?intent|gas/i;
const usdc = (n: number): bigint => BigInt(Math.round(n * 1e6));

async function ended(w: Wave3World, id: string): Promise<{ status: string; reason: string | undefined; decidedBy: string | undefined }> {
  for (let i = 0; i < 3000; i += 1) {
    const p = w.svc.get(id);
    if (p !== undefined && !['approved', 'awaiting_touch', 'executing'].includes(p.status)) return { status: p.status, reason: p.result?.reason, decidedBy: p.decidedBy };
    await new Promise((r) => setTimeout(r, 10));
  }
  return { status: `stuck ${w.svc.get(id)?.status}`, reason: undefined, decidedBy: undefined };
}

export const attack: AttackCase = {
  id: '34-agent-top-up',
  title: 'an agent cannot make or approve a vault top-up: the chip key moves vault money only after a person clicks',
  timeoutMs: 300_000,
  async run(ctx: AttackCtx): Promise<AttackResult> {
    if (!swiftc) return { expected: '', observed: '', pass: true, evidence: '', skipped: 'needs macOS with the developer tools (swiftc)' };
    const dataDir = path.join(ctx.scratch, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    savePolicy(dataDir, seededPolicy());
    const mac = new VaultDouble(path.join(ctx.scratch, 'keychain.json'));
    const paper = generateMnemonic(english, 256);
    const w = await wave3World({ papers: [paper], dataDir, mac });
    const fails: string[] = [];
    const check = (ok: boolean, what: string): void => {
      if (!ok) fails.push(what);
    };
    const signs = (): number => w.seen.filter((r) => r.op === 'signIntent').length;
    const topUps = (): number => w.svc.list().filter((p) => p.draft.kind === 'vault_top_up').length;
    try {
      const { vault, allowance } = await w.wallet();
      w.chain.fund(vault, USDC, usdc(50));
      const moved = await w.settled(await w.startMove(paper));
      if (moved !== 'done') throw new Error(`the move ended ${moved}`);
      w.ledger.reread();
      const signs0 = signs();
      const vault0 = w.chain.balanceOf(vault, USDC);

      // 1. No tool: neither the app's own seat nor the by-hand proxy (nor a worker) is offered one.
      const seats: { seat: string; env: Record<string, string> }[] = [
        { seat: 'app seat', env: { PHOSPHOR_SEAT: SEAT } },
        { seat: 'outside', env: {} },
        { seat: 'worker', env: { PHOSPHOR_SEAT: SEAT, PHOSPHOR_ROLE: 'analyst' } },
      ];
      const offered: string[] = [];
      for (const s of seats) {
        const tools = await toolsOf({ ...s.env, ACC_DATA_DIR: dataDir });
        const hits = tools.filter((t) => TOP_UP_TOOL.test(t.name) || /vault_top_up/.test(JSON.stringify(t.inputSchema)));
        offered.push(`${s.seat} ${tools.length} tools, ${hits.length} for a top-up`);
        check(tools.length > 0 && hits.length === 0, `${s.seat} is offered ${hits.map((t) => t.name).join(', ')}`);
      }

      // 2. A vault_top_up draft through the agent's propose door, and the op itself.
      const door: string[] = [];
      for (const body of [
        { op: 'propose', kind: 'vault_top_up', params: { asset: USDC, amount: '5', why: 'manual' } },
        { op: 'propose', kind: 'vault_top_up', params: { usd: 5 } },
        { op: 'propose', kind: 'top_up', params: { usd: 5 } },
        { op: 'vault_top_up', params: { usd: 5 } },
      ]) {
        const r = await w.mcp(body);
        door.push(`${body.op}/${'kind' in body ? body.kind : '-'} ${r.status}`);
        check(r.status >= 400, `the door took ${JSON.stringify(body)}: ${r.status}`);
      }
      check(topUps() === 0, 'a vault_top_up row was drafted from the door');

      // 3. The window's top-up route with what an agent holds: the seat secret, or nothing.
      const route: string[] = [];
      for (const [who, cred] of [
        ['seat secret as token', { token: SEAT }],
        ['seat secret as secret', { token: undefined, secret: SEAT }],
        ['no credential', { token: undefined }],
      ] as const) {
        const r = await w.post('/api/vault/allowance/top-up', { ...cred, usd: 5 });
        route.push(`${who} ${r.status}`);
        check(r.status === 403, `top-up route with ${who}: ${r.status}`);
      }
      check(topUps() === 0, 'a vault_top_up row was filed by the route under an agent credential');

      // 4. A move the policy runs on its own, its spend read while the allowance held enough, the
      //    allowance drained on chain while its price was being asked: the shortfall step stops it,
      //    and the vault is not touched.
      w.chain.fund(allowance, USDC, usdc(5));
      w.ledger.reread();
      const quote = w.holdQuote();
      const asking = w.mcp({ op: 'propose', kind: 'swap', params: { chain: 'near', toChain: 'near', fromSymbol: 'USDC', toSymbol: 'USDT', amountIn: '3' } });
      await quote.reached;
      w.chain.fund(allowance, USDC, -usdc(4));
      quote.release();
      const shortAsk = await asking;
      const short = shortAsk.status === 200 ? await ended(w, String(shortAsk.json.id)) : { status: `door ${shortAsk.status}`, reason: undefined, decidedBy: undefined };
      check(short.status === 'failed' && short.reason === 'insufficient_balance' && short.decidedBy === 'policy', `the policy's short move ended ${JSON.stringify(short)}`);
      check(w.chain.balanceOf(vault, USDC) === vault0 && topUps() === 0 && signs() === signs0, 'the short policy move touched the vault');

      // 5. A swap bigger than the allowance: it waits for a click, and nothing pulls the difference
      //    until a person gives it. The agent cannot give it.
      w.ledger.reread();
      const bigAsk = await w.mcp({ op: 'propose', kind: 'swap', params: { chain: 'near', toChain: 'near', fromSymbol: 'USDC', toSymbol: 'USDT', amountIn: '3.000001' } });
      check(bigAsk.status === 200, `the big swap was not filed: ${bigAsk.status}`);
      const bigId = String(bigAsk.json?.id);
      const pending = w.svc.get(bigId)?.status;
      check(pending === 'pending', `the big swap did not wait for a click: ${pending}`);
      const selfClicks: string[] = [];
      for (const [who, cred] of [
        ['seat secret', { token: SEAT }],
        ['no credential', { token: undefined }],
      ] as const) {
        const r = await w.post('/api/approve', { ...cred, id: bigId });
        selfClicks.push(`${who} ${r.status}`);
        check(r.status === 403, `/api/approve with ${who}: ${r.status}`);
      }
      const doorClick = await w.mcp({ op: 'approve', id: bigId });
      selfClicks.push(`door approve ${doorClick.status}`);
      check(doorClick.status >= 400, `the door approved: ${doorClick.status}`);
      await new Promise((r) => setTimeout(r, 400));
      const stillPending = w.svc.get(bigId)?.status;
      const signsBeforeClick = signs();
      const topUpsBeforeClick = topUps();
      check(stillPending === 'pending' && topUps() === 0 && signsBeforeClick === signs0 && w.chain.balanceOf(vault, USDC) === vault0, `before a person clicked: ${stillPending}, top-ups ${topUps()}, signIntent asks ${signsBeforeClick - signs0}`);

      // The person clicks: then, and only then, the chip key signs the difference.
      const clicked = await w.post('/api/approve', { id: bigId });
      const done = await ended(w, bigId);
      const child = w.svc.list().find((p) => p.draft.kind === 'vault_top_up');
      const said = mac.dialogs().at(-1);
      check(clicked.status === 200 && done.status === 'executed', `the person's click: ${clicked.status}, ended ${JSON.stringify(done)}`);
      check(child !== undefined && child.decidedBy === 'human' && child.status === 'executed', `the child top-up: ${JSON.stringify(child && [child.status, child.decidedBy])}`);
      check(signs() === signs0 + 1 && said === 'move 2.000001 USDC from your vault to your allowance', `after the click: ${signs() - signs0} signIntent, dialog "${said}"`);

      const pass = fails.length === 0;
      return {
        expected:
          'no seat is offered a top-up tool; a vault_top_up through the door and the top-up route under an agent credential are refused with nothing drafted; a policy-run move short of the allowance ends insufficient_balance with the vault untouched; a bigger swap waits, the agent cannot click it, and chip signIntent asks stay 0 until the person clicks, then exactly 1',
        observed: `tools: ${offered.join('; ')}; door: ${door.join(', ')}; top-up route: ${route.join(', ')}; short policy move: ${short.status} ${short.reason ?? ''} by ${short.decidedBy}; big swap: ${pending}, agent clicks ${selfClicks.join(', ')}, after 400 ms ${stillPending} with ${topUpsBeforeClick} top-ups before the click; person's click -> ${done.status}, child ${child?.status}/${child?.decidedBy}, signIntent asks ${signsBeforeClick - signs0} before and ${signs() - signs0} after, dialog "${said}"${fails.length ? `; FAILED: ${fails.join('; ')}` : ''}`,
        pass,
        evidence: `mcp propose vault_top_up -> ${door[0]}; POST /api/vault/allowance/top-up {token: seat} -> ${route[0]!.split(' ').at(-1)}; swap 3 USDC on policy, allowance short -> ${short.status} ${short.reason}; swap 3.000001 USDC -> ${pending}, signIntent asks ${signsBeforeClick - signs0} until /api/approve with the window token, then ${signs() - signs0} ("${said}")`,
      };
    } finally {
      await w.close();
    }
  },
};

export default attack;
