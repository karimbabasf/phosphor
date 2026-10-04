// A software stand-in for the vault service's chip ops (PHASE2-PLAN C1), in Node, and the shell's
// side of the relay that carries them. A node:crypto P-256 key stands in for each Secure Enclave
// key, and every answer has the shape and the webauthn wrapper the real service answers with. It
// checks what C1 orders before a key is touched (the tag, the marker, the grammar, the signer) with
// the app's own payload reader standing in for the Swift grammar, so a refused request is never a
// signature. `signatures` counts the payloads it signed: one per Touch ID in the app.
//
// The real service's rules are tested against src-tauri/se-helper (tests/unit/chip-service.test.ts,
// U5); this file only has to answer the way it does, so the Node side can be run end to end.

import crypto from 'node:crypto';

import { base58Encode, isNearAccountId } from '../../../src/chain/near.ts';
import { isVerifierPublicKey } from '../../../src/relay/verifier.ts';
import { readVaultPayload } from '../../../src/vault/payload.ts';
import type { VaultRelay, VaultRequest } from '../../../src/vault/relay.ts';
import { webauthnMessage, webauthnSigned } from '../../../src/vault/webauthn.ts';

export type Answer = Record<string, unknown> & { ok: boolean };

type Chip = { tag: string; key: crypto.KeyObject; xy: Uint8Array; created: number; marker: { account: string; allowance: string; recovery: string; at: string } | null };

const PREFIX = 'com.karimbabasf.phosphor.chip.';
const TAG = /^com\.karimbabasf\.phosphor\.chip\.(?:([a-z0-9-]{1,40})\.)?[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;
const FRESH_MS = 10 * 60_000;

const fail = (error: string, message: string): Answer => ({ ok: false, error, message });

export class SoftwareChipService {
  readonly chips = new Map<string, Chip>();
  readonly seen: VaultRequest[] = [];
  signatures = 0;
  // A test sets these: the next Touch ID is cancelled, or the service has no keychain home.
  touch: 'cancel' | undefined;
  keychainHome = true;
  readonly now: () => number;
  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  publicKeyOf(keyRef: string): string {
    return `p256:${base58Encode(this.chips.get(keyRef.slice('chip:'.length))!.xy)}`;
  }

  // The chip's own signature over any payload, outside every check: what a test hands the chain
  // double to stand for a signature someone else holds.
  signRaw(keyRef: string, payload: string) {
    const chip = this.chips.get(keyRef.slice('chip:'.length))!;
    return webauthnSigned(payload, chip.xy, crypto.sign('sha256', webauthnMessage(payload), { key: chip.key, dsaEncoding: 'ieee-p1363' }));
  }

  run(request: VaultRequest): Answer {
    this.seen.push(request);
    const chipOp = request.op.startsWith('chip') || request.op === 'signIntent';
    if (chipOp && !this.keychainHome) return fail('keychain_unavailable', 'this build has no keychain home');
    switch (request.op) {
      case 'chipCreate': {
        const label = request.label === undefined ? '' : `${request.label}.`;
        const tag = `${PREFIX}${label}${crypto.randomUUID().toUpperCase()}`;
        const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
        const jwk = publicKey.export({ format: 'jwk' });
        const xy = Uint8Array.from(Buffer.concat([Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')]));
        this.chips.set(tag, { tag, key: privateKey, xy, created: this.now(), marker: null });
        return { ok: true, keyRef: `chip:${tag}`, publicKey: `p256:${base58Encode(xy)}` };
      }
      case 'chipCommit': {
        // As the service checks the pins (CONTRACTS.md, "Chip service (Phase 2, U5)").
        const { account, allowance, recovery } = request;
        if (!isNearAccountId(account) || !isNearAccountId(allowance) || account === allowance || typeof recovery !== 'string' || !recovery.startsWith('secp256k1:') || !isVerifierPublicKey(recovery)) {
          return fail('bad_input', 'account and allowance are two account ids, recovery a secp256k1 key');
        }
        const chip = this.chipOf(request.keyRef);
        if (chip === null) return fail('no_key', 'no chip key with that tag');
        const marker = { account, allowance, recovery };
        if (chip.marker !== null) {
          const same = chip.marker.account === marker.account && chip.marker.allowance === marker.allowance && chip.marker.recovery === marker.recovery;
          return same ? { ok: true, keyRef: request.keyRef, at: chip.marker.at } : fail('marker_exists', 'a marker with other pins exists');
        }
        if (this.now() - chip.created >= FRESH_MS) return fail('stale_key', 'the chip key is not fresh');
        chip.marker = { ...marker, at: new Date(this.now()).toISOString() };
        return { ok: true, keyRef: request.keyRef, at: chip.marker.at };
      }
      case 'chipStatus': {
        const chips = [...this.chips.values()]
          .filter((c) => request.keyRef === undefined || `chip:${c.tag}` === request.keyRef)
          .map((c) => ({ keyRef: `chip:${c.tag}`, publicKey: `p256:${base58Encode(c.xy)}`, fresh: this.now() - c.created < FRESH_MS, marker: c.marker }));
        return { ok: true, keychainHome: true, chips };
      }
      case 'chipSweep': {
        let deleted = 0;
        for (const [tag, c] of this.chips) {
          const inScope = request.label === undefined || tag.startsWith(`${PREFIX}${request.label}.`);
          if (inScope && c.marker === null && this.now() - c.created >= FRESH_MS) {
            this.chips.delete(tag);
            deleted += 1;
          }
        }
        return { ok: true, deleted, kept: this.chips.size };
      }
      case 'signIntent':
        return this.signIntent(request);
      default:
        return fail('bad_input', `this stand-in answers chip ops only, not ${request.op}`);
    }
  }

  private chipOf(keyRef: unknown): Chip | null {
    if (typeof keyRef !== 'string' || !keyRef.startsWith('chip:') || !TAG.test(keyRef.slice(5))) return null;
    return this.chips.get(keyRef.slice(5)) ?? null;
  }

  // C1's order: tag form, marker, grammar, signer, sentence; then the touch and the key.
  private signIntent(request: VaultRequest): Answer {
    if (typeof request.keyRef !== 'string' || !TAG.test(request.keyRef.slice(5)) || typeof request.payload !== 'string') return fail('bad_input', 'a signIntent names a chip and a payload');
    const chip = this.chipOf(request.keyRef);
    if (chip === null || chip.marker === null) return fail('not_committed', 'no marker names this chip key');
    let body;
    try {
      body = readVaultPayload(request.payload);
    } catch (err) {
      return fail('grammar', `payload: ${err instanceof Error ? err.message : String(err)}`);
    }
    const own = `p256:${base58Encode(chip.xy)}`;
    for (const intent of body.intents) {
      if (intent.intent === 'add_public_key' || intent.intent === 'set_auth_by_predecessor_id') return fail('grammar', `refused_kind: the chip never signs ${intent.intent}`);
      if (intent.intent === 'remove_public_key' && intent.public_key === own) return fail('grammar', 'signing_key: the chip never removes itself');
    }
    if (body.signer_id !== chip.marker.account.toLowerCase()) return fail('wrong_signer', 'the payload signs for another account than the marker pins');
    if (this.touch === 'cancel') {
      this.touch = undefined;
      return fail('user_cancel', 'the person cancelled');
    }
    const sentence = body.intents.length === 0 ? "confirm this Mac's Touch ID key for your vault" : `${body.intents.map((i) => i.intent).join(' and ')} from your vault`;
    const signature = crypto.sign('sha256', webauthnMessage(request.payload), { key: chip.key, dsaEncoding: 'ieee-p1363' });
    this.signatures += 1;
    return { ok: true, keyRef: request.keyRef, sentence, signed: webauthnSigned(request.payload, chip.xy, signature) };
  }
}

/* The shell's loop over a relay built in the test: take the next request, hand it to the service,
   post its answer. `edit` may replace an answer before it is posted, the way a hostile shell could. */
export function serve(relay: VaultRelay, service: { run(request: VaultRequest): Answer | Promise<Answer> }, edit?: (request: VaultRequest, answer: Answer) => Answer): { stop(): Promise<void> } {
  let running = true;
  const loop = (async () => {
    while (running) {
      const request = await relay.next(20);
      if (request === null) continue;
      const answer = await service.run(request);
      relay.answer({ ...(edit === undefined ? answer : edit(request, answer)), id: request.id });
    }
  })();
  return {
    stop: async () => {
      running = false;
      await loop;
    },
  };
}
