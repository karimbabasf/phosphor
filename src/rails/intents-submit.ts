// POST /v0/submit-intent for a payload that is already signed, with the one retry that is
// safe after the signature is released: the same bytes again, once, and only when the first
// call got no reply at all.
//
// Both venues this app writes to dedupe on the nonce inside the signed bytes and on nothing
// else. Resending the same payload and signature therefore cannot move the balance twice: the
// verifier accepts it once or refuses the repeat. Asking generate-intent again, or signing
// again, mints a new nonce, and that is a second real move. So this module takes the signed
// bytes and never sees the signer, and the rails that call it hold the signer to exactly one
// use per move (tests count the calls).
//
// A reply that is an error (a 5xx, a 4xx, a body that could not be read) is not resent: the
// venue answered, and the answer may mean the intent was taken. That case, and a second
// no-reply, come back as `submitted: false` for the rail to report as unconfirmed with the
// handle, which is the one thing a later check needs.

import { isTimeout } from '../net.ts';
import type { IntentsApiPort, SubmittedIntent } from './intents-native.ts';

export type SubmitAttempt =
  | { submitted: true; intent: SubmittedIntent; attempts: number }
  | { submitted: false; error: string; attempts: number };

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const NO_REPLY_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT']);

// The request did not produce an answer: the deadline fired, the socket dropped, or the
// connection was never made. undici wraps these as a TypeError "fetch failed" with the real
// reason in `cause`, so the cause is read too. Anything else is an answer of some kind.
export function noReply(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  if (isTimeout(err)) return true;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && NO_REPLY_CODES.has(code)) return true;
  const message = (err as { message?: unknown }).message;
  if (typeof message === 'string' && /fetch failed|socket hang up|network error/i.test(message)) return true;
  const cause = (err as { cause?: unknown }).cause;
  return cause !== undefined && cause !== null ? noReply(cause) : false;
}

export async function submitSignedIntent(api: IntentsApiPort, signed: { payload: string; signature: string }): Promise<SubmitAttempt> {
  let attempts = 0;
  let lastError = '';
  while (attempts < 2) {
    attempts += 1;
    try {
      const intent = await api.submitIntent(signed);
      return { submitted: true, intent, attempts };
    } catch (err) {
      lastError = errText(err);
      if (!noReply(err)) break;
    }
  }
  return { submitted: false, error: lastError, attempts };
}
