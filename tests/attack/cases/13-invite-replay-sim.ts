// 13-invite-replay-sim: the verifier-side half of replay. A signed claim, built exactly as the app
// builds it (src/invite/payload.ts) and signed by a THROWAWAY code key, is replayed against the
// real intents.near verifier through simulate_intents, a free read-only view. Nothing is ever
// published or submitted. The original must clear signature, nonce, salt and deadline and stop
// only at the balance (a throwaway code holds nothing). Every replay of that signature with one
// field changed (receiver to an attacker, amount, deadline, signer, nonce) must be refused on the
// signature, never reach the balance check. Skipped when the NEAR RPC does not answer in 3 tries.

import crypto from 'node:crypto';

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { ERC191_STANDARD } from '../../../src/intents-sign.ts';
import { liveVerifier } from '../../../src/relay/verifier.ts';
import { deriveKey, generateSecret } from '../../../src/invite/code.ts';
import { INVITE_ASSET_ID, buildTransfersPayload, claimNonce, signingDeadline } from '../../../src/invite/payload.ts';
import { keySigner } from '../../../src/invite/signer.ts';
import type { AttackCase, AttackCtx, AttackResult } from '../types.ts';

async function tries<T>(fn: () => Promise<T | null>, n = 3): Promise<T | null> {
  for (let i = 0; i < n; i += 1) {
    const v = await fn().catch(() => null);
    if (v !== null && v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 800));
  }
  return null;
}

const BALANCE = /insufficient balance|overflow/i;

export const attack: AttackCase = {
  id: '13-invite-replay-sim',
  title: 'a signed claim replayed with any field changed is refused by simulate_intents (read-only, throwaway keys)',
  timeoutMs: 90_000,
  async run(_ctx: AttackCtx): Promise<AttackResult> {
    const verifier = liveVerifier();
    const salt = await tries(() => verifier.currentSalt());
    const block = verifier.finalBlock ? await tries(() => verifier.finalBlock!()) : null;
    if (salt === null || block === null || verifier.simulate === undefined) {
      return { expected: 'live simulate_intents reachable', observed: 'NEAR RPC did not answer salt and final block in 3 tries', pass: true, evidence: 'liveVerifier().currentSalt/finalBlock -> null x3', skipped: 'BLOCKED: NEAR RPC unreachable (3 tries)' };
    }

    const secret = generateSecret();
    const signer = keySigner(deriveKey(secret)!);
    secret.fill(0);
    const wallet = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
    const attacker = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
    const other = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
    const deadline = signingDeadline(block.atMs);
    const nonce = claimNonce(salt, deadline, (n) => crypto.randomBytes(n));
    const payload = buildTransfersPayload({ signerId: signer.address, assetId: INVITE_ASSET_ID, deadline, nonce, transfers: [{ receiverId: wallet, amountBase: 5_000_000n }] });
    const signature = await signer.sign(payload);
    signer.drop();

    const edit = (f: (p: any) => void): string => {
      const p = JSON.parse(payload);
      f(p);
      return JSON.stringify(p);
    };
    const variants: Record<string, string> = {
      original: payload,
      'receiver to attacker': edit((p) => (p.intents[0].receiver_id = attacker)),
      'amount doubled': edit((p) => (p.intents[0].tokens[INVITE_ASSET_ID] = '10000000')),
      'deadline extended': edit((p) => (p.deadline = new Date(Date.parse(deadline) + 60_000).toISOString())),
      'signer swapped': edit((p) => (p.signer_id = other)),
      'nonce swapped': edit((p) => (p.nonce = claimNonce(salt, deadline, (n) => crypto.randomBytes(n)))),
    };

    const rows: string[] = [];
    const problems: string[] = [];
    for (const [name, body] of Object.entries(variants)) {
      const sim = await tries(() => verifier.simulate!([{ standard: ERC191_STANDARD, payload: body, signature }]));
      if (sim === null) {
        return { expected: 'live simulate_intents reachable', observed: `simulate did not answer for "${name}" in 3 tries`, pass: true, evidence: rows.join(' | '), skipped: 'BLOCKED: simulate_intents unreachable (3 tries)' };
      }
      const said = sim.ok ? 'OK' : sim.refusal;
      rows.push(`${name}: ${said.slice(0, 70)}`);
      if (name === 'original') {
        if (sim.ok || !BALANCE.test(said)) problems.push(`original did not stop at the balance: ${said.slice(0, 80)}`);
      } else if (sim.ok || BALANCE.test(said)) {
        problems.push(`replay "${name}" got past the signature: ${said.slice(0, 80)}`);
      }
    }

    return {
      expected: 'original: refused only for balance (signature valid); every edited replay: refused on the signature, never at the balance',
      observed: problems.length === 0 ? `all ${Object.keys(variants).length - 1} edited replays refused before the balance check` : problems.join('; '),
      pass: problems.length === 0,
      evidence: rows.join(' | '),
    };
  },
};

export default attack;
