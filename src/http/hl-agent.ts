// "Allow trading on Hyperliquid": the trading key a vault on Touch ID derives from its owner key, and
// the one Touch ID that approves it on the venue (src/hl/agent-key.ts).
//
// Window only. The write carries the window token through guarded() like every custody route, and
// the read sits behind the read gate like every GET under /api/. No op on /api/mcp opens onto either,
// so no agent can start the dialog or mint itself a trading key: a check could be wrong, an absence
// cannot. The sentence in the dialog is the owner touch's, read off what is signed, never this file's.

import type http from 'node:http';

import { allowTrading, hlAgentView } from '../hl/agent-key.ts';
import { sendJson } from './respond.ts';
import type { JsonBody } from './respond.ts';
import { guarded, knownRefusal, refusal } from './wallet.ts';
import type { Ctx } from './context.ts';

const NOTHING_SIGNED = 'Touch ID did not finish, so nothing was signed. Try again.';

// A refusal in plain words, by code. The owner touch's own codes (a cancel, a timeout) are the vault
// table's (src/http/wallet.ts), said the way every other Touch ID refusal is.
const SAID: Record<string, string> = {
  not_moved: 'Allow trading is for a vault on Touch ID. This wallet keeps the trading key it already has. Nothing changed.',
  locked: 'Open your wallet first: the trading key is made when it opens. Nothing changed.',
  busy: 'A plan is trading with your current key, and the new key replaces it. Let the plan finish or cancel it, then try again. Nothing changed.',
  frozen: 'Phosphor is frozen, so it allows no new trading key. Unfreeze it first. Nothing was signed.',
  reopen: 'Lock your wallet and open it again first, so it can make the next trading key. Nothing changed.',
  asking: 'Phosphor is already asking for this Touch ID. Finish that one first.',
  refused: 'Hyperliquid did not approve the new trading key, so nothing changed.',
  unknown:
    'Hyperliquid did not answer, so Phosphor cannot tell yet whether it took the new trading key. Allow trading again in a minute: if it did, the same key is approved once more.',
  not_recorded:
    'Hyperliquid approved the new trading key, but Phosphor could not note it on this Mac. Check that the Mac has free space, then allow trading again.',
  // Only before src/vault/reason.ts reads a trading key's end: the dialog could not say it, so it was not shown.
  unnamed: 'Phosphor could not say this approval in the Touch ID dialog, so it asked nothing and signed nothing.',
  no_touch: NOTHING_SIGNED,
  no_enclave: 'This wallet has no Touch ID key to ask, so nothing was signed.',
  not_sent: NOTHING_SIGNED,
};

function said(code: string, venue?: string): JsonBody {
  if (Object.hasOwn(SAID, code)) return { ok: false, code, error: SAID[code], ...(venue === undefined ? {} : { venue }) };
  return knownRefusal(code) ? refusal(code) : { ok: false, code, error: NOTHING_SIGNED };
}

export function handleTradingKeyStatus(ctx: Ctx, res: http.ServerResponse): void {
  sendJson(res, 200, hlAgentView({ keystore: ctx.keystore, prefs: ctx.vaultPrefs }));
}

/* Answers 200 either way, as the vault routes do: `ok` is the answer, `error` the sentence, `code`
   for a branch. A refusal from the venue carries its words apart, in `venue`. */
export async function handleTradingKeyAllow(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await guarded(ctx, '/api/vault/trading-key/allow', req, res);
  if (body === null) return;
  ctx.session.touch();
  const out = await allowTrading({
    keysPath: ctx.cfg.keysPath,
    keystore: ctx.keystore,
    prefs: ctx.vaultPrefs,
    armed: () => ctx.session.armed().length,
    // Fail shut: a policy that will not load reads as frozen, as the runner reads it.
    frozen: () => ctx.getPolicy()?.killSwitch ?? true,
  });
  if (!out.ok) {
    ctx.audit.append('app_start', `no trading key was allowed on Hyperliquid: ${out.code} (${out.detail})`, { code: out.code });
    return sendJson(res, 200, said(out.code, out.code === 'refused' ? out.detail : undefined));
  }
  ctx.audit.append('app_start', `a trading key was allowed on Hyperliquid with Touch ID: ${out.address} for ${out.days} days`, {
    address: out.address,
    version: out.version,
    validUntil: out.validUntil,
  });
  ctx.sse.broadcastState();
  sendJson(res, 200, { ok: true, address: out.address, version: out.version, validUntil: out.validUntil, days: out.days });
}
