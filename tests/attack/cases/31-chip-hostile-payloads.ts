// A compromised backend asks the vault's chip key to sign. Node builds every vault payload, so a
// hostile Node writes whatever it likes and hands it to the service with the chip's keyRef: a key
// added to the vault (add_public_key), predecessor auth turned back on (set_auth_by_predecessor_id
// enabled true, the door the rekey closes), money out of the verifier, a swap, a transfer that hides
// a memo or a second receiver, a duplicate key the service and the chain would read two ways, an
// amount past u128, a sentence too long for the dialog, and a payload for another signer.
//
// Method: the vault service's own rules (ChipOps.swift, IntentGrammar.swift) compiled with the
// stand-in keychain (tests/unit/helpers/vault-double.ts), a chip key made and pinned the way a move
// pins it, then one signIntent per hostile payload. Each must come back refused with the right code
// and rule name, with no dialog and no touch: every check sits before the key. A valid 5.00 USDC
// top-up then signs with exactly one dialog, its sentence byte for byte, so the refusals are the
// grammar's and not a broken service. Then Node's own first line, src/vault/chip.ts chipSign, over
// the same set with a relay stub that counts the requests it hands on: which line held each payload.
//
// Why: the dialog is the only text the owner reads before a touch that can move the vault's money
// or give the vault to another key, and Node may be the attacker. No payload of this set may ever
// reach a dialog.

import path from 'node:path';

import { base58Encode } from '../../../src/chain/near.ts';
import { chipSign } from '../../../src/vault/chip.ts';
import type { VaultResult } from '../../../src/vault/relay.ts';
import { webauthnMultiPayload } from '../../../src/vault/webauthn.ts';
import { VaultDouble } from '../../unit/helpers/vault-double.ts';
import { U128_MAX, USDC, secpKey, swiftc, transfer, vaultPayload } from '../chip-kit.ts';
import type { AttackCase, AttackCtx, AttackResult } from '../types.ts';

const VAULT = `0x${'5a'.repeat(20)}`;
const ALLOWANCE = `0x${'6b'.repeat(20)}`;
const RECOVERY = secpKey(0x5e);
const P256_OTHER = `p256:${base58Encode(Buffer.alloc(64, 0x33))}`;
const LONG_NAME = `${'a'.repeat(59)}.near`;
const TOP_UP_SAID = 'move 5.00 USDC from your vault to your allowance';

type Hostile = { name: string; payload: string; code: string; rule?: string };

function hostileSet(nowMs: number, chipKey: string): Hostile[] {
  const at = nowMs + 60_000;
  const p = (intents: unknown[], over: { signer?: string; deadlineMs?: number; nonceLifeMs?: number; verifying?: string } = {}) =>
    vaultPayload({ signer: over.signer ?? VAULT, deadlineMs: over.deadlineMs ?? at, intents, ...(over.nonceLifeMs !== undefined ? { nonceLifeMs: over.nonceLifeMs } : {}), ...(over.verifying !== undefined ? { verifying: over.verifying } : {}) });
  const one = (kind: string, fields: Record<string, unknown> = {}) => p([{ intent: kind, ...fields }]);
  const good = p([transfer(USDC, '5000000', ALLOWANCE)]);
  const refused = (name: string, payload: string, rule: string): Hostile => ({ name, payload, code: 'grammar', rule });
  return [
    refused('set_auth_by_predecessor_id enabled true', one('set_auth_by_predecessor_id', { enabled: true }), 'refused_kind'),
    refused('set_auth_by_predecessor_id enabled false', one('set_auth_by_predecessor_id', { enabled: false }), 'refused_kind'),
    refused('add_public_key', one('add_public_key', { public_key: P256_OTHER }), 'refused_kind'),
    refused('auth_call', one('auth_call', { contract_id: 'evil.near', msg: '', attached_deposit: '0' }), 'refused_kind'),
    refused('token_diff', one('token_diff', { diff: { [USDC]: '-5000000', 'nep141:wrap.near': '1' } }), 'refused_kind'),
    refused('ft_withdraw', one('ft_withdraw', { token: 'usdt.tether-token.near', receiver_id: 'evil.near', amount: '1' }), 'refused_kind'),
    refused('native_withdraw', one('native_withdraw', { receiver_id: 'evil.near', amount: '1' }), 'refused_kind'),
    refused('mt_withdraw', one('mt_withdraw', { token: 'mt.near', receiver_id: 'evil.near', token_ids: ['1'], amounts: ['1'] }), 'refused_kind'),
    refused('nft_withdraw', one('nft_withdraw', { token: 'nft.near', receiver_id: 'evil.near', token_id: '1' }), 'refused_kind'),
    refused('storage_deposit', one('storage_deposit', { contract_id: 'usdt.tether-token.near', deposit_for_account_id: 'evil.near', amount: '1' }), 'refused_kind'),
    refused('imt_mint', one('imt_mint', { receiver_id: 'evil.near', tokens: { '1': '1' }, memo: '' }), 'refused_kind'),
    refused('imt_burn', one('imt_burn', { minter_id: 'evil.near', tokens: { '1': '1' } }), 'refused_kind'),
    refused('an unknown kind', one('phosphor_probe'), 'unknown_kind'),
    // A parser that keeps the first "intents" reads the empty rekey proof; serde keeps the last, a transfer out.
    refused('a duplicate key whose second copy hides a transfer', p([]).replace(/}$/, `,"intents":[${JSON.stringify(transfer(USDC, '5000000', 'evil.near'))}]}`), 'duplicate_key'),
    refused('a transfer with a memo', p([{ ...transfer(USDC, '1', ALLOWANCE), memo: 'hi' }]), 'transfer_keys'),
    refused('a transfer with a msg', p([{ ...transfer(USDC, '1', ALLOWANCE), msg: '{}' }]), 'transfer_keys'),
    refused('a transfer with min_gas', p([{ ...transfer(USDC, '1', ALLOWANCE), min_gas: '30000000000000' }]), 'transfer_keys'),
    refused('two receivers', p([transfer(USDC, '1', ALLOWANCE), transfer('nep141:usdt.tether-token.near', '1', 'evil.near')]), 'one_receiver'),
    refused('two kinds', p([transfer(USDC, '1', ALLOWANCE), { intent: 'remove_public_key', public_key: P256_OTHER }]), 'one_kind'),
    refused('a token outside the table', p([transfer('nep141:evil.near', '1', ALLOWANCE)]), 'token'),
    refused('amount 0', p([transfer(USDC, '0', ALLOWANCE)]), 'amount'),
    refused('a leading zero', p([transfer(USDC, '05000000', ALLOWANCE)]), 'amount'),
    refused('u128 max + 1', p([transfer(USDC, '340282366920938463463374607431768211456', ALLOWANCE)]), 'amount'),
    refused('the chip removing itself', p([{ intent: 'remove_public_key', public_key: chipKey }]), 'signing_key'),
    { name: 'signer = the allowance', payload: p([transfer(USDC, '5000000', VAULT)], { signer: ALLOWANCE }), code: 'wrong_signer' },
    refused('a sentence over 120 characters', p([transfer(USDC, U128_MAX, LONG_NAME)]), 'sentence'),
    refused('over 4096 bytes', good + ' '.repeat(4096), 'size'),
    refused('non-ASCII (a Cyrillic a in signer_id)', p([], { signer: 'vаult.near' }), 'ascii'),
    refused('a backslash escape', good.replace('intents.near', 'intents\\u002enear'), 'escape'),
    refused('another verifying_contract', p([transfer(USDC, '5000000', ALLOWANCE)], { verifying: 'evil.near' }), 'verifying_contract'),
    refused('a past deadline', p([transfer(USDC, '5000000', ALLOWANCE)], { deadlineMs: nowMs - 1_000 }), 'deadline'),
    refused('a deadline past now + 120 s', p([transfer(USDC, '5000000', ALLOWANCE)], { deadlineMs: nowMs + 121_000 }), 'deadline'),
    refused('a nonce living seven days and 1 ms', p([transfer(USDC, '5000000', ALLOWANCE)], { nonceLifeMs: 7 * 86_400_000 + 1 }), 'nonce'),
    refused('a nonce dying with the payload', p([transfer(USDC, '5000000', ALLOWANCE)], { nonceLifeMs: 0 }), 'nonce'),
  ];
}

export const attack: AttackCase = {
  id: '31-chip-hostile-payloads',
  title: 'every hostile vault payload, set_auth and add_public_key among them, is refused before the chip service raises its one dialog',
  timeoutMs: 300_000,
  async run(ctx: AttackCtx): Promise<AttackResult> {
    if (!swiftc) return { expected: '', observed: '', pass: true, evidence: '', skipped: 'needs macOS with the developer tools (swiftc)' };
    const mac = new VaultDouble(path.join(ctx.scratch, 'keychain.json'));
    const nowSec = Math.floor(Date.now() / 1000);
    mac.now = nowSec;
    const nowMs = nowSec * 1000;
    const made = mac.run({ op: 'chipCreate', label: 'attack31' });
    if (made.ok !== true) throw new Error(`chipCreate: ${JSON.stringify(made)}`);
    const keyRef = String(made.keyRef);
    const publicKey = String(made.publicKey);
    const pinned = mac.run({ op: 'chipCommit', keyRef, account: VAULT, allowance: ALLOWANCE, recovery: RECOVERY });
    if (pinned.ok !== true) throw new Error(`chipCommit: ${JSON.stringify(pinned)}`);

    const set = hostileSet(nowMs, publicKey);
    const wrong: string[] = [];
    const touchesBefore = mac.touches().length;
    const dialogsBefore = mac.dialogs().length;
    const direct = new Map<string, string>();
    for (const h of set) {
      const a = mac.run({ op: 'signIntent', keyRef, payload: h.payload });
      const rule = typeof a.message === 'string' ? a.message.split(':')[0] : '';
      direct.set(h.name, `${a.error}${h.rule !== undefined ? `/${rule}` : ''}`);
      if (a.ok !== false || a.error !== h.code || (h.rule !== undefined && rule !== h.rule) || a.signed !== undefined) {
        wrong.push(`${h.name}: wanted ${h.code}${h.rule ? `/${h.rule}` : ''}, got ${a.ok ? 'SIGNED' : `${a.error}/${rule}`}`);
      }
    }
    const dialogsAfterHostile = mac.dialogs().length - dialogsBefore;
    const touchesAfterHostile = mac.touches().length - touchesBefore;

    // The positive control: the one payload of its kind the owner means, signed behind one dialog.
    const topUp = vaultPayload({ signer: VAULT, deadlineMs: nowMs + 60_000, intents: [transfer(USDC, '5000000', ALLOWANCE)] });
    const ok = mac.run({ op: 'signIntent', keyRef, payload: topUp });
    const newDialogs = mac.dialogs().slice(dialogsBefore);
    let controlSigned = false;
    try {
      const signed = webauthnMultiPayload(ok.signed);
      controlSigned = ok.ok === true && ok.sentence === TOP_UP_SAID && signed.payload === topUp && signed.public_key === publicKey;
    } catch {
      controlSigned = false;
    }

    // Node's first line: chipSign, with a relay stub that hands each request to the same service.
    let asked = 0;
    const relay = {
      async ask(request: Record<string, unknown>): Promise<VaultResult> {
        asked += 1;
        const a = mac.run({ ...request, id: `n${asked}` });
        if (a.ok !== true) return { ok: false, error: String(a.error), message: String(a.message ?? '') };
        return { ok: true, op: 'signIntent', keyRef: String(a.keyRef), sentence: String(a.sentence), signed: a.signed as Record<string, unknown> };
      },
    };
    const lines: string[] = [];
    let nodeHeld = 0;
    let serviceHeld = 0;
    const dialogsBeforeNode = mac.dialogs().length;
    for (const h of set) {
      const before = asked;
      const r = await chipSign(relay, { keyRef, publicKey, account: VAULT }, h.payload);
      const calls = asked - before;
      if (r.ok) {
        wrong.push(`${h.name}: chipSign SIGNED it`);
        continue;
      }
      if (r.code === 'chip_payload' && calls === 0) {
        nodeHeld += 1;
        lines.push(`${h.name}=node`);
      } else if (calls === 1 && `${r.code}` === h.code) {
        serviceHeld += 1;
        lines.push(`${h.name}=service`);
      } else {
        wrong.push(`${h.name}: chipSign answered ${r.code} after ${calls} service calls`);
      }
    }
    const nodeDialogs = mac.dialogs().length - dialogsBeforeNode;

    const pass = wrong.length === 0 && dialogsAfterHostile === 0 && touchesAfterHostile === 0 && controlSigned && newDialogs.length === 1 && newDialogs[0] === TOP_UP_SAID && nodeDialogs === 0;
    const setAuthOn = direct.get('set_auth_by_predecessor_id enabled true');
    const addKey = direct.get('add_public_key');
    return {
      expected: `all ${set.length} hostile payloads refused with their code and rule, 0 dialogs and 0 touches; the 5.00 USDC top-up signs with exactly one dialog "${TOP_UP_SAID}"; chipSign over the same set signs nothing and raises no dialog`,
      observed: `service: ${set.length - wrong.filter((w) => !w.includes('chipSign')).length}/${set.length} refused right, dialogs +${dialogsAfterHostile}, touches +${touchesAfterHostile}; control signed=${controlSigned} dialogs=${JSON.stringify(newDialogs)}; chipSign: ${nodeHeld} held in Node (chip_payload, 0 service calls), ${serviceHeld} held by the service, dialogs +${nodeDialogs}${wrong.length ? `; WRONG: ${wrong.join('; ').slice(0, 600)}` : ''}; per payload: ${lines.join(', ')}`,
      pass,
      evidence: `signIntent(set_auth enabled true) -> ${setAuthOn}; signIntent(add_public_key) -> ${addKey}; ${set.length} hostile -> dialogs() +${dialogsAfterHostile}, touches() +${touchesAfterHostile}; top-up -> dialogs() ${JSON.stringify(newDialogs)}`,
    };
  },
};

export default attack;
