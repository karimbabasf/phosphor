// A program running as the owner rewrites state/vault.json on a vault that moved to the chip. The
// file is plain JSON any such process can edit, and it names the chip key the vault signs with. The
// attack points it at another chip key of this Mac (one pinned to another account, or one never
// pinned), deletes the chip entry to bring the owner key back into the session, or fills it with
// garbage, then waits for the app to start again on the same data dir.
//
// Method: one Mac wired as src/main.ts wires it (tests/unit/helpers/wave3-world.ts: the vault
// service's own rules on the stand-in keychain, the chain double, the real server), a vault moved by
// the window's own routes and one clicked 1.00 USDC top-up as the control. Then per rewrite: stop,
// edit vault.json, start again on the same data dir, Mac and chain, ask the chip markers the way
// src/main.ts queues them right behind the probe (checked against main.ts's text), open the wallet,
// and play the attacker: read the owner key, file and click a top-up, and ask the service through
// the relay to sign for the vault with the swapped keyRef.
//
// Why: vault.json is not a control. What an edit to it changes is which key the app reaches for, and
// none of those reaches may end in a signature, a dialog, or the owner key back in memory.

import fs from 'node:fs';
import path from 'node:path';
import { english, generateMnemonic } from 'viem/accounts';

import { savePolicy } from '../../../src/policy/file.ts';
import { USDC } from '../../unit/helpers/allowance-world.ts';
import { seededPolicy } from '../../unit/helpers/proposals.ts';
import { VaultDouble } from '../../unit/helpers/vault-double.ts';
import { wave3World } from '../../unit/helpers/wave3-world.ts';
import type { Wave3World } from '../../unit/helpers/wave3-world.ts';
import { ROOT } from '../harness.ts';
import { secpKey, swiftc, transfer, vaultPayload } from '../chip-kit.ts';
import type { AttackCase, AttackCtx, AttackResult } from '../types.ts';

const OTHER_VAULT = `0x${'7c'.repeat(20)}`;
const OTHER_ALLOWANCE = `0x${'8d'.repeat(20)}`;

async function untilRow(w: Wave3World, id: string): Promise<string> {
  for (let i = 0; i < 3000; i += 1) {
    const p = w.svc.get(id);
    if (p !== undefined && !['pending', 'approved', 'awaiting_touch', 'executing'].includes(p.status)) return `${p.status}${p.result?.reason ? ` ${p.result.reason}` : ''}`;
    await new Promise((r) => setTimeout(r, 10));
  }
  return `stuck ${w.svc.get(id)?.status}`;
}

/* A top-up as the window asks for one and a person clicks it. What it came to. */
async function topUp(w: Wave3World): Promise<string> {
  w.ledger.reread();
  const asked = await w.post('/api/vault/allowance/top-up', { usd: 1 });
  if (asked.json?.ok !== true) return `refused at the route (${asked.status}): ${String(asked.json?.error ?? '').slice(0, 90)}`;
  const id = String(asked.json.proposal.id);
  if (asked.json.proposal.status !== 'pending') return `filed ${asked.json.proposal.status}`;
  const clicked = await w.post('/api/approve', { id });
  if (clicked.status !== 200) return `click refused (${clicked.status}): ${String(clicked.json?.error ?? '').slice(0, 90)}`;
  return `clicked, ended ${await untilRow(w, id)}`;
}

function ownerKey(w: Wave3World): string {
  try {
    w.keystore.evmPrivateKey();
    return 'IN THE SESSION';
  } catch (err) {
    return (err as { code?: string }).code ?? (err instanceof Error ? err.message.slice(0, 60) : String(err));
  }
}

export const attack: AttackCase = {
  id: '35-vault-json-keyref-swap',
  title: 'rewriting vault.json cannot point the vault at another chip key or bring the owner key back',
  timeoutMs: 300_000,
  async run(ctx: AttackCtx): Promise<AttackResult> {
    if (!swiftc) return { expected: '', observed: '', pass: true, evidence: '', skipped: 'needs macOS with the developer tools (swiftc)' };
    // What this case plays for src/main.ts: the chip markers asked right behind the probe, so the
    // owner key gate has them before any unlock is answered. If main.ts stops doing that, this fails.
    const main = fs.readFileSync(path.join(ROOT, 'src', 'main.ts'), 'utf8');
    const probeAt = main.indexOf("vault.ask({ op: 'probe' })");
    const markersAt = main.indexOf("vault.ask({ op: 'chipStatus' })");
    const bootReadsMarkers = probeAt >= 0 && markersAt > probeAt;

    const dataDir = path.join(ctx.scratch, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    savePolicy(dataDir, seededPolicy());
    const mac = new VaultDouble(path.join(ctx.scratch, 'keychain.json'));
    const paper = generateMnemonic(english, 256);
    let w = await wave3World({ papers: [paper], dataDir, mac });
    let closed = false;
    const chain = w.chain;
    const lines: string[] = [];
    const short: string[] = [];
    let pass = bootReadsMarkers;
    try {
      const { vault, allowance } = await w.wallet();
      chain.fund(vault, USDC, 50_000_000n);
      const moved = await w.settled(await w.startMove(paper));
      if (moved !== 'done') throw new Error(`the move ended ${moved}`);
      const control = await topUp(w);
      const controlSaid = mac.dialogs().at(-1);
      const controlOk = control === 'clicked, ended executed' && controlSaid === 'move 1.00 USDC from your vault to your allowance';
      pass &&= controlOk;
      lines.push(`control top-up: ${control}, dialog "${controlSaid}"`);
      const prefsFile = path.join(dataDir, 'vault.json');
      const original = fs.readFileSync(prefsFile, 'utf8');

      // Two more chip keys on this Mac: one pinned to another account, one never pinned.
      mac.now = Math.floor(chain.now() / 1000);
      const other = mac.run({ op: 'chipCreate', label: 'attack35' });
      const otherPin = mac.run({ op: 'chipCommit', keyRef: other.keyRef, account: OTHER_VAULT, allowance: OTHER_ALLOWANCE, recovery: secpKey(0x41) });
      const loose = mac.run({ op: 'chipCreate', label: 'attack35' });
      if (other.ok !== true || otherPin.ok !== true || loose.ok !== true) throw new Error(`could not make the other chip keys: ${JSON.stringify([other, otherPin, loose]).slice(0, 300)}`);
      await w.close();
      closed = true;

      type Variant = { name: string; edit: (doc: Record<string, unknown>) => Record<string, unknown> | string; keyRef?: string; wantSign?: string; broken: boolean };
      const variants: Variant[] = [
        { name: '(i) another chip pinned to another account', edit: (d) => ({ ...d, chip: { ...(d.chip as object), keyRef: other.keyRef, publicKey: other.publicKey } }), keyRef: String(other.keyRef), wantSign: 'wrong_signer', broken: true },
        { name: '(ii) an unpinned chip', edit: (d) => ({ ...d, chip: { ...(d.chip as object), keyRef: loose.keyRef, publicKey: loose.publicKey } }), keyRef: String(loose.keyRef), wantSign: 'not_committed', broken: true },
        { name: '(iii) the chip entry removed', edit: (d) => Object.fromEntries(Object.entries(d).filter(([k]) => k !== 'chip')), broken: false },
        { name: '(iv) garbage in the chip entry', edit: (d) => ({ ...d, chip: 'garbage' }), broken: true },
        { name: '(v) the whole file garbage', edit: () => '{"chip": nope', broken: false },
      ];

      for (const v of variants) {
        const edited = v.edit(JSON.parse(original) as Record<string, unknown>);
        fs.writeFileSync(prefsFile, typeof edited === 'string' ? edited : JSON.stringify(edited, null, 2));
        w = await wave3World({ chain, mac, dataDir });
        closed = false;
        const markers = await w.relay.ask({ op: 'chipStatus' });
        const opened = await w.post('/api/vault/unlock');
        const kind = (await w.accounts.refresh()).kind;
        const owner = ownerKey(w);
        const before = { dialogs: mac.dialogs().length, touches: mac.touches().length, signs: w.seen.filter((r) => r.op === 'signIntent').length, runs: chain.executions(), vault: chain.balanceOf(vault, USDC), allowance: chain.balanceOf(allowance, USDC) };
        const top = v.broken ? await topUp(w) : 'not asked';
        let signed = 'not asked';
        if (v.keyRef !== undefined) {
          mac.now = Math.floor(chain.now() / 1000);
          const payload = vaultPayload({ signer: vault, deadlineMs: mac.now * 1000 + 60_000, intents: [transfer(USDC, '1000000', allowance)] });
          const a = await w.relay.ask({ op: 'signIntent', keyRef: v.keyRef, payload });
          signed = a.ok ? 'SIGNED' : a.error;
        }
        const state = (await w.get('/api/state')).json?.vault?.chip?.state;
        const after = { dialogs: mac.dialogs().length, touches: mac.touches().length, signs: w.seen.filter((r) => r.op === 'signIntent').length, runs: chain.executions(), vault: chain.balanceOf(vault, USDC), allowance: chain.balanceOf(allowance, USDC) };
        const nothingMoved = after.runs === before.runs && after.vault === before.vault && after.allowance === before.allowance;
        // The one signIntent the attacker sent itself is the only one: the app asked for none.
        const noDialog = after.dialogs === before.dialogs && after.touches === before.touches && after.signs - before.signs === (v.keyRef === undefined ? 0 : 1);
        const held =
          markers.ok === true &&
          opened.json?.ok === true &&
          owner === 'owner_touch_required' &&
          nothingMoved &&
          noDialog &&
          (!v.broken || (kind === 'broken' && !top.includes('executed'))) &&
          (v.wantSign === undefined || signed === v.wantSign);
        pass &&= held;
        short.push(`${v.name.split(' ')[0]} kind=${kind} owner=${owner}${v.broken ? ` top-up=${top.startsWith('refused') ? 'refused' : top}` : ''}${v.keyRef !== undefined ? ` signIntent=${signed}` : ''}`);
        lines.push(`${v.name}: kind ${kind}, owner key ${owner}, top-up ${top}, signIntent(swapped keyRef, signer vault) ${signed}, state then ${state}, dialogs +${after.dialogs - before.dialogs}, chain runs +${after.runs - before.runs}${held ? '' : ' <- DID NOT HOLD'}`);
        await w.close();
        closed = true;
      }
    } finally {
      if (!closed) await w.close().catch(() => undefined);
    }
    return {
      expected:
        'control top-up signs once; (i) (ii) (iv) read broken, a clicked top-up is refused before any dialog, and the service refuses the swapped keyRef (wrong_signer, not_committed); (iii) and a garbage file keep the owner key out (owner_touch_required) through the marker and the chain; nothing moves on the chain double',
      observed: `${bootReadsMarkers ? 'src/main.ts asks chipStatus behind the probe' : 'src/main.ts NO LONGER asks chipStatus behind the probe'}; ${lines.join(' | ')}`,
      pass,
      evidence: `restart after each vault.json rewrite -> ${short.join('; ')}; chain.executions() and USDC balances unchanged, mac.dialogs() +0 in every one`,
    };
  },
};

export default attack;
