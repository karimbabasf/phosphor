// The backend's side of the Secure Enclave relay: a queue the shell drains.
//
// THE SHAPE, and why it is a queue and not a call. This process cannot reach the enclave: the
// sidecar that can is run by the desktop shell, and the shell has no server for this process to
// call. What the shell does have is the window token and a thread that long-polls
// POST /api/vault/pending. So every enclave operation here is a request put on a queue and a
// promise that resolves when the shell posts the answer to POST /api/vault/answer. The page
// never sees this: it moves a proposal into the state that makes this process ask, and the
// shell answers. See src-tauri/src/enclave.rs for the other half.
//
// ONE AT A TIME. The sidecar shows one system dialog per request, and two dialogs stacked on a
// person is how one gets approved by reflex. So one request is handed out at a time, the next
// waits until the shell has answered the first or the first has timed out, and the order is the
// order of asking.
//
// WHO MAY ANSWER. The two routes take the relay secret (line 5 of the handshake), not the window
// token. The page holds the token, and a page that could answer a presence check would be a page
// that can pass a Touch ID gate with no finger; the page never sees this value.
//
// WHAT COMES BACK. A data key never crosses in the clear: the sidecar seals it under the
// per-boot transport key (line 4 of the shell's handshake) with the request id as AAD, and only
// this process holds the other copy. An answer that opens under the wrong id, or does not open,
// is a failure, never a partial key.

import crypto from 'node:crypto';

import type { EnclaveRef } from '../keystore/store.ts';

export type VaultOp = 'probe' | 'create' | 'unwrap' | 'presence';

export type VaultRequest = {
  id: string;
  op: VaultOp;
  /** The sentence the system dialog shows. Composed by this process, never by an agent. */
  reason?: string;
  keyBlob?: string;
  ephemeralPublicKey?: string;
  ciphertext?: string;
  aad?: string;
};

export type Capability = { secureEnclave: boolean; biometry: string; canAuthenticate: boolean };

export type VaultResult =
  | { ok: true; op: 'unwrap'; dek: Buffer }
  | { ok: true; op: 'create'; enclave: EnclaveRef }
  | { ok: true; op: 'probe'; capability: Capability }
  | { ok: true; op: 'presence' }
  | { ok: false; error: string; message: string };

/** What the window is told while a request waits on the person: enough to draw, nothing to sign. */
export type Waiting = { id: string; op: VaultOp; reason: string; since: number };

export type VaultRelay = {
  /** A shell has polled within RELAY_STALE_MS. Without one, every ask fails fast. */
  attached(): boolean;
  capability(): Capability | null;
  /** attached, and the shell reported an enclave the person can authenticate to. */
  enclaveReady(): boolean;
  ask(request: Omit<VaultRequest, 'id'> & { id?: string }): Promise<VaultResult>;
  waiting(): Waiting | null;
  /** The long poll. Resolves with the next request, or null after waitMs with nothing to hand out. */
  next(waitMs: number): Promise<VaultRequest | null>;
  answer(body: Record<string, unknown>): { ok: true } | { ok: false; error: string };
  /** The relay secret check for the two routes: constant time, and false with no secret. */
  authenticate(supplied: unknown): boolean;
  /** For the state payload and tests. */
  queued(): number;
  stop(): void;
};

/** A shell that has not polled for this long is not there. Its poll holds for 25 s, so 60 s is
 *  two missed polls, which is a dead shell and not a slow one. */
export const RELAY_STALE_MS = 60_000;
/** Touch ID gives up on its own well before this; it is the backstop for a relay that vanished
 *  with a request in hand, so the proposal behind it is put back rather than left waiting. */
export const ASK_TIMEOUT_MS = 150_000;
/** A poll may hold for at most this long, whatever it asked for. */
export const POLL_HOLD_MAX_MS = 30_000;
/** A request that has not been fetched by then never will be: the shell is gone. */
const NEVER_FETCHED_MS = 20_000;

type Inflight = {
  request: VaultRequest;
  resolve: (r: VaultResult) => void;
  timer: NodeJS.Timeout;
  handedOut: boolean;
  since: number;
};

export function createVaultRelay(opts: { transportKey: Buffer | null; secret?: string | null; now?: () => number; askTimeoutMs?: number }): VaultRelay {
  const now = opts.now ?? Date.now;
  const askTimeout = opts.askTimeoutMs ?? ASK_TIMEOUT_MS;
  const transport = opts.transportKey;
  const secret = opts.secret ?? null;
  const secretDigest = secret === null ? null : crypto.createHash('sha256').update(secret).digest();
  const queue: Inflight[] = [];
  let waiter: { resolve: (r: VaultRequest | null) => void; timer: NodeJS.Timeout } | null = null;
  let lastPoll = 0;
  let capability: Capability | null = null;
  let stopped = false;

  function attached(): boolean {
    return transport !== null && now() - lastPoll < RELAY_STALE_MS;
  }

  function head(): Inflight | null {
    return queue[0] ?? null;
  }

  function settle(entry: Inflight, result: VaultResult): void {
    clearTimeout(entry.timer);
    const at = queue.indexOf(entry);
    if (at !== -1) queue.splice(at, 1);
    entry.resolve(result);
    // The next request, if any, is now the head; a poll parked on an empty queue is woken.
    handOut();
  }

  /* Hands the head to a parked poll, once. A request is handed out exactly once: a second poll
     arriving while the first is unanswered gets nothing, because the sidecar is already
     showing that request's dialog. */
  function handOut(): void {
    const entry = head();
    if (entry === null || entry.handedOut || waiter === null) return;
    entry.handedOut = true;
    const { resolve, timer } = waiter;
    waiter = null;
    clearTimeout(timer);
    resolve(entry.request);
  }

  function ask(request: Omit<VaultRequest, 'id'> & { id?: string }): Promise<VaultResult> {
    if (stopped) return Promise.resolve({ ok: false, error: 'stopped', message: 'the relay is shut' });
    if (transport === null) {
      return Promise.resolve({ ok: false, error: 'no_relay', message: 'this backend was not started by the desktop shell, so it has no enclave' });
    }
    const id = request.id ?? crypto.randomBytes(12).toString('hex');
    return new Promise<VaultResult>((resolve) => {
      const entry: Inflight = {
        request: { ...request, id },
        resolve,
        handedOut: false,
        since: now(),
        timer: setTimeout(() => settle(entry, { ok: false, error: 'timeout', message: 'nobody answered the request' }), askTimeout),
      };
      entry.timer.unref?.();
      queue.push(entry);
      /* A request nobody fetches is a shell that is not there. It fails on its own clock rather
         than the person's, so a proposal does not hang for two and a half minutes on a relay
         that was never going to come. */
      const fetchCheck = setTimeout(() => {
        if (!entry.handedOut && queue.includes(entry)) {
          settle(entry, { ok: false, error: 'no_relay', message: 'the desktop shell is not relaying enclave requests' });
        }
      }, NEVER_FETCHED_MS);
      fetchCheck.unref?.();
      handOut();
    });
  }

  function next(waitMs: number): Promise<VaultRequest | null> {
    lastPoll = now();
    // A newer poll replaces an older one: the shell runs one relay thread, so an older poll still
    // parked is a connection it already gave up on.
    if (waiter !== null) {
      clearTimeout(waiter.timer);
      waiter.resolve(null);
      waiter = null;
    }
    const hold = Math.max(0, Math.min(waitMs, POLL_HOLD_MAX_MS));
    return new Promise<VaultRequest | null>((resolve) => {
      const timer = setTimeout(() => {
        if (waiter !== null && waiter.resolve === resolve) waiter = null;
        resolve(null);
      }, hold);
      timer.unref?.();
      waiter = { resolve, timer };
      handOut();
    });
  }

  function openDek(entry: Inflight, sealedB64: unknown): Buffer | null {
    if (transport === null || typeof sealedB64 !== 'string') return null;
    const combined = Buffer.from(sealedB64, 'base64');
    // nonce || 32 bytes || tag, and nothing else: a longer or shorter blob is not an answer.
    if (combined.length !== 12 + 32 + 16) return null;
    const nonce = combined.subarray(0, 12);
    const tag = combined.subarray(combined.length - 16);
    const ct = combined.subarray(12, combined.length - 16);
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', transport, nonce, { authTagLength: 16 });
      decipher.setAAD(Buffer.from(entry.request.id, 'utf8'));
      decipher.setAuthTag(tag);
      const dek = Buffer.concat([decipher.update(ct), decipher.final()]);
      return dek.length === 32 ? dek : null;
    } catch {
      return null;
    }
  }

  function answer(body: Record<string, unknown>): { ok: true } | { ok: false; error: string } {
    const entry = head();
    if (entry === null || !entry.handedOut) return { ok: false, error: 'nothing is waiting for an answer' };
    if (body.id !== entry.request.id) return { ok: false, error: 'the answer names a request that is not the one handed out' };
    if (body.ok !== true) {
      const error = typeof body.error === 'string' ? body.error : 'failed';
      const message = typeof body.message === 'string' ? body.message : 'the enclave did not answer';
      settle(entry, { ok: false, error, message });
      return { ok: true };
    }
    switch (entry.request.op) {
      case 'probe': {
        capability = {
          secureEnclave: body.secureEnclave === true,
          biometry: typeof body.biometry === 'string' ? body.biometry : 'none',
          canAuthenticate: body.canAuthenticate === true,
        };
        settle(entry, { ok: true, op: 'probe', capability });
        return { ok: true };
      }
      case 'create': {
        if (typeof body.keyBlob !== 'string' || typeof body.publicKey !== 'string' || body.keyBlob === '' || body.publicKey === '') {
          settle(entry, { ok: false, error: 'garbled', message: 'the enclave answered a create with no key' });
          return { ok: true };
        }
        settle(entry, { ok: true, op: 'create', enclave: { keyBlob: body.keyBlob, publicKey: body.publicKey, createdAt: new Date(now()).toISOString() } });
        return { ok: true };
      }
      case 'unwrap': {
        const dek = openDek(entry, body.dekSealed);
        if (dek === null) {
          settle(entry, { ok: false, error: 'transport', message: 'the sealed data key did not open under this boot\'s transport key' });
          return { ok: true };
        }
        settle(entry, { ok: true, op: 'unwrap', dek });
        return { ok: true };
      }
      case 'presence':
        settle(entry, { ok: true, op: 'presence' });
        return { ok: true };
    }
  }

  function waiting(): Waiting | null {
    const entry = head();
    if (entry === null) return null;
    return { id: entry.request.id, op: entry.request.op, reason: entry.request.reason ?? '', since: entry.since };
  }

  function authenticate(supplied: unknown): boolean {
    if (secretDigest === null || typeof supplied !== 'string' || supplied.length === 0) return false;
    return crypto.timingSafeEqual(crypto.createHash('sha256').update(supplied).digest(), secretDigest);
  }

  return {
    attached,
    authenticate,
    capability: () => capability,
    enclaveReady: () => attached() && capability !== null && capability.secureEnclave && capability.canAuthenticate,
    ask,
    waiting,
    next,
    answer,
    queued: () => queue.length,
    stop() {
      stopped = true;
      for (const entry of [...queue]) settle(entry, { ok: false, error: 'stopped', message: 'the relay is shut' });
      if (waiter !== null) {
        clearTimeout(waiter.timer);
        waiter.resolve(null);
        waiter = null;
      }
    },
  };
}
