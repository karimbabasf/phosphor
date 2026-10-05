// The chip signer: this process's side of the vault's Touch ID key (PHASE2-PLAN C1 and C7).
//
// The chip key (CHIP) is a P-256 key in this Mac's Secure Enclave that signs for the vault, one
// Touch ID per signature. This process never holds it. It asks the vault service, through the relay
// (src/vault/relay.ts), to sign one payload; the service reads that payload with its own grammar
// (src-tauri/se-helper/IntentGrammar.swift), writes the sentence the Touch ID dialog shows from what
// it read, and signs only that. What comes back is held here to what was asked before it may join a
// bundle: the very payload, byte for byte, signed by the key vault.json pins, in the webauthn
// wrapper the verifier takes (src/vault/webauthn.ts).
//
// Every check this process can make is made before the touch, so a refusal raises no dialog: a
// payload the app would not build (readVaultPayload: the shape, the seven-day nonce), one that
// signs for another account, or one the service's grammar would refuse (src/vault/chip-grammar.ts)
// never reaches the service.
//
// The service's chip markers also close a door vault.json alone leaves open (ownerKeyGate): a
// marker naming this vault, once the chain shows the vault moved to it, keeps the owner key out of
// the session even after the chip entry in vault.json is deleted, since no op deletes a marker and
// no process but the service writes one.

import crypto from 'node:crypto';

import { base58Decode } from '../chain/near.ts';
import type { ChipPrefs } from './prefs.ts';
import type { ChipStatus } from './accounts.ts';
import { ownerKeyOut } from './accounts.ts';
import { chipBytesRefusal, chipPayloadRefusal } from './chip-grammar.ts';
import { readVaultPayload } from './payload.ts';
import type { VaultPayload } from './payload.ts';
import { isVerifierPublicKey } from '../relay/verifier.ts';
import type { VerifierPort } from '../relay/verifier.ts';
import { isChipKeyRef } from './relay.ts';
import type { ChipMarkerSeen, VaultRelay, VaultResult } from './relay.ts';
import { webauthnMultiPayload } from './webauthn.ts';
import type { WebauthnSigned } from './webauthn.ts';

/* The chip as vault.json pins it (src/vault/prefs.ts): which key, its public half, and the vault
   account it signs for. */
export type ChipPin = { keyRef: string; publicKey: string; account: string };

/* How long a payload the chip signs may live: the service's grammar takes a deadline in (now, now +
   120 s] by this Mac's clock (C2), and ten seconds of that are left for the request to reach it. */
export const CHIP_PAYLOAD_LIFE_MS = 110_000;

// `code` has a sentence in src/http/wallet.ts REFUSALS; `detail` is for the log line only.
export type ChipRefused = { ok: false; code: string; detail: string };

export type ChipSigned = { ok: true; sentence: string; signed: WebauthnSigned };

function refused(code: string, detail: string): ChipRefused {
  return { ok: false, code, detail };
}

/* The service's refusal as the caller gets it. Every chip request this module sends is checked here
   first, so `bad_input` can only mean the other side does not know the op: a service built without
   the chip ops (no -D PHOSPHOR_CHIP) or a shell that relays only the wallet key's ops. */
function serviceRefused(answer: Extract<VaultResult, { ok: false }>): ChipRefused {
  return answer.error === 'bad_input' ? refused('chip_unsupported', answer.message) : refused(answer.error, answer.message);
}

const LABEL = /^[a-z0-9-]{1,40}$/;

/* "p256:" and base58 of 64 bytes that make a point on P-256, the only key a chip answers with. */
export function isChipPublicKey(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith('p256:')) return false;
  let xy: Uint8Array;
  try {
    xy = base58Decode(value.slice(5));
  } catch {
    return false;
  }
  if (xy.length !== 64) return false;
  try {
    crypto.createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: Buffer.from(xy.subarray(0, 32)).toString('base64url'), y: Buffer.from(xy.subarray(32)).toString('base64url') },
      format: 'jwk',
    });
    return true;
  } catch {
    return false;
  }
}

/* What the caller knows beside the pin: this Mac's clock, the one that built the payload's deadline
   (the service reads the same Mac's), and the allowance and paper key the chip's marker pins, which
   make the length check of the Touch ID sentence exact (src/vault/chip-grammar.ts). */
export type ChipSignOptions = { now?: () => number; allowance?: string; recovery?: string };

/* C7's chipSign. One Touch ID, whose sentence the service writes. Before it, the vault service's
   grammar is asked here first (src/vault/chip-grammar.ts): a payload it would refuse, a key added or
   predecessor auth switched among them, never reaches the service. The answer must carry the payload
   asked for byte for byte (JSONSerialization drops a leading byte order mark from a string, so the
   service can sign a payload that is not this one, p2-grammar finding 1), the public key vault.json
   pins, and a webauthn signature that verifies over this app's wrapper with S low. */
export async function chipSign(relay: Pick<VaultRelay, 'ask'>, pin: ChipPin, payload: string, opts: ChipSignOptions = {}): Promise<ChipSigned | ChipRefused> {
  if (!isChipPublicKey(pin.publicKey) || !isChipKeyRef(pin.keyRef) || !/^0x[0-9a-fA-F]{40}$/.test(pin.account)) {
    return refused('chip_missing', 'vault.json pins no chip this process can ask for');
  }
  const bytes = chipBytesRefusal(payload);
  if (bytes !== null) return refused('chip_payload', `${bytes.rule}: ${bytes.message}`);
  let read: VaultPayload;
  try {
    read = readVaultPayload(payload);
  } catch (err) {
    return refused('chip_payload', err instanceof Error ? err.message : String(err));
  }
  const account = pin.account.toLowerCase();
  if (read.signer_id !== account) return refused('chip_payload', 'the payload signs for another account than the vault the chip holds');
  const pins = { account, ...(opts.allowance === undefined ? {} : { allowance: opts.allowance.toLowerCase() }), ...(opts.recovery === undefined ? {} : { recovery: opts.recovery }) };
  const grammar = chipPayloadRefusal(read, pin.publicKey, (opts.now ?? Date.now)(), pins);
  if (grammar !== null) return refused('chip_payload', `${grammar.rule}: ${grammar.message}`);

  const answer = await relay.ask({ op: 'signIntent', keyRef: pin.keyRef, payload });
  if (!answer.ok) return serviceRefused(answer);
  if (answer.op !== 'signIntent') return refused('garbled', `the relay answered a signature request with ${answer.op}`);
  const { signed } = answer;
  if (signed.payload !== payload) return refused('chip_answer', 'the signed payload is not the one asked for, byte for byte');
  if (signed.public_key !== pin.publicKey) return refused('chip_answer', 'the signature is not by the chip vault.json pins');
  let checked: WebauthnSigned;
  try {
    checked = webauthnMultiPayload(signed);
  } catch (err) {
    return refused('chip_answer', err instanceof Error ? err.message : String(err));
  }
  return { ok: true, sentence: answer.sentence, signed: checked };
}

// A chip read that gave no status; `code` has a sentence in REFUSALS.
export class ChipStatusRefused extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ChipStatusRefused';
    this.code = code;
  }
}

/* chipStatus for src/vault/accounts.ts (createAccounts): resolves only with what a service with a
   keychain home read, and rejects (ChipStatusRefused) on a refusal, a garbled answer or a dead
   transport, so the last answer stands there. A build with no chip ops rejects `chip_unsupported`. */
export function chipStatusReader(relay: Pick<VaultRelay, 'ask'>): (keyRef: string) => Promise<ChipStatus> {
  return async (keyRef) => {
    if (!isChipKeyRef(keyRef)) throw new ChipStatusRefused('chip_missing', 'not a chip key ref');
    const answer = await relay.ask({ op: 'chipStatus', keyRef });
    if (!answer.ok) {
      const why = serviceRefused(answer);
      throw new ChipStatusRefused(why.code, `chip status refused: ${answer.error}`);
    }
    if (answer.op !== 'chipStatus') throw new ChipStatusRefused('garbled', `the relay answered a chip status with ${answer.op}`);
    if (!answer.status.keychainHome) throw new ChipStatusRefused('keychain_unavailable', 'the service read no keychain home');
    return answer.status;
  };
}

/* A new chip key for a rekey. The public key must be a P-256 point before anything pins it. */
export async function createChip(relay: Pick<VaultRelay, 'ask'>, label?: string): Promise<{ ok: true; keyRef: string; publicKey: string } | ChipRefused> {
  if (label !== undefined && !LABEL.test(label)) return refused('invalid_request', 'a chip label is 1 to 40 of a-z, 0-9 and -');
  const answer = await relay.ask({ op: 'chipCreate', ...(label === undefined ? {} : { label }) });
  if (!answer.ok) return serviceRefused(answer);
  if (answer.op !== 'chipCreate') return refused('garbled', `the relay answered a chip create with ${answer.op}`);
  if (!isChipPublicKey(answer.publicKey)) return refused('garbled', 'the new chip key is not a point on P-256');
  return { ok: true, keyRef: answer.keyRef, publicKey: answer.publicKey };
}

/* Pins the vault, its allowance and its paper key in the chip's marker, once per key and inside its
   first ten minutes. The pins are checked here as the service checks them: two different 0x
   accounts and a secp256k1 paper key. */
export async function commitChip(
  relay: Pick<VaultRelay, 'ask'>,
  pins: { keyRef: string; account: string; allowance: string; recovery: string },
): Promise<{ ok: true; keyRef: string; at: string | null } | ChipRefused> {
  const account = /^0x[0-9a-fA-F]{40}$/;
  if (!isChipKeyRef(pins.keyRef) || !account.test(pins.account) || !account.test(pins.allowance) || pins.account.toLowerCase() === pins.allowance.toLowerCase()) {
    return refused('invalid_request', 'a chip pins a chip key, the vault and a different allowance account');
  }
  if (!pins.recovery.startsWith('secp256k1:') || !isVerifierPublicKey(pins.recovery)) return refused('invalid_request', 'the paper key is a secp256k1 key');
  const answer = await relay.ask({ op: 'chipCommit', keyRef: pins.keyRef, account: pins.account.toLowerCase(), allowance: pins.allowance.toLowerCase(), recovery: pins.recovery });
  if (!answer.ok) return serviceRefused(answer);
  if (answer.op !== 'chipCommit') return refused('garbled', `the relay answered a chip commit with ${answer.op}`);
  return { ok: true, keyRef: answer.keyRef, at: answer.at };
}

/* Deletes chip keys no marker names that are past their first ten minutes: a rekey that stopped
   between create and commit leaves one. */
export async function sweepChips(relay: Pick<VaultRelay, 'ask'>, label?: string): Promise<{ ok: true; deleted: number; kept: number } | ChipRefused> {
  if (label !== undefined && !LABEL.test(label)) return refused('invalid_request', 'a chip label is 1 to 40 of a-z, 0-9 and -');
  const answer = await relay.ask({ op: 'chipSweep', ...(label === undefined ? {} : { label }) });
  if (!answer.ok) return serviceRefused(answer);
  if (answer.op !== 'chipSweep') return refused('garbled', `the relay answered a chip sweep with ${answer.op}`);
  return { ok: true, deleted: answer.deleted, kept: answer.kept };
}

/* How long a chain answer that the vault did not move is trusted before it is asked again. Asked
   again in the background: the answer in hand stands meanwhile, so a wallet that never moved is not
   locked out of its own key while a read is under way. */
export const MARKER_RECHECK_MS = 60_000;

/* The keystore's gate (src/main.ts wires it): the owner key stays out of the session while
   vault.json says the vault moved (ownerKeyOut), OR while a chip marker names the vault AND the
   chain says the vault moved to it. vault.json is a file any process running as the owner can edit;
   a marker is written only by the service and never deleted, so deleting the chip entry alone
   cannot bring the owner key back (p2-keys open risk 1).
   A marker alone is not enough (p2-service security review): a backend can make a chip key and pin
   it to any account with no dialog, and a migration stopped after its commit leaves a marker on a
   vault that never moved. So a marker counts only when the chain shows its chip key, or the paper
   key it pins, on the vault: no one can put either there without a key the vault already answers
   to. Until the chain has answered (a read in flight, or one that failed) a marker keeps the key
   out; once it says moved, that is for good. */
export function ownerKeyGate(
  prefs: () => { chip: ChipPrefs | null },
  relay: Pick<VaultRelay, 'chipMarkers'>,
  chain: Pick<VerifierPort, 'hasPublicKey'>,
  opts: { now?: () => number } = {},
): (vault: string) => boolean {
  const now = opts.now ?? Date.now;
  const verdicts = new Map<string, { markers: string; moved: boolean | null; at: number; asking: boolean }>();

  function ask(vault: string, markers: ChipMarkerSeen[], key: string): void {
    const verdict = { markers: key, moved: verdicts.get(vault)?.markers === key ? (verdicts.get(vault)?.moved ?? null) : null, at: now(), asking: true };
    verdicts.set(vault, verdict);
    const reads = markers.flatMap((m) => [...(m.publicKey === null ? [] : [m.publicKey]), m.recovery]).map((k) => (chain.hasPublicKey === undefined ? Promise.resolve(null) : chain.hasPublicKey(vault, k).catch(() => null)));
    void Promise.all(reads).then((seen) => {
      if (verdicts.get(vault) !== verdict) return;
      verdict.moved = seen.some((s) => s === true) ? true : seen.every((s) => s === false) ? false : null;
      verdict.at = now();
      verdict.asking = false;
    });
  }

  return (vault) => {
    if (ownerKeyOut(prefs(), vault)) return true;
    const markers = relay.chipMarkers(vault);
    if (markers.length === 0) return false;
    const account = vault.toLowerCase();
    const key = JSON.stringify(markers);
    const verdict = verdicts.get(account);
    if (verdict?.moved === true && verdict.markers === key) return true;
    if (verdict === undefined || verdict.markers !== key) {
      ask(account, markers, key);
      return true;
    }
    if (!verdict.asking && (verdict.moved === null || now() - verdict.at > MARKER_RECHECK_MS)) ask(account, markers, key);
    return verdict.moved !== false;
  };
}
