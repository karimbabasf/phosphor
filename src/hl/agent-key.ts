// The Hyperliquid trading key of a vault on Touch ID, and the one Touch ID that lets it trade.
//
// WHY DERIVED. Once a vault moves to the chip its owner key is out of the session, and a key added to
// the wallet file is a payload rewrite the move refuses (audit1b AU1B-04), so scripts/hl-agent.ts,
// which wrote a fresh API wallet into the file, has no way in. The trading key is derived from the
// owner key instead: HKDF under "phosphor/hl-agent/v<n>" (src/keystore/derived.ts), made at every
// open beside ALLOWANCE and GAS and wiped by the same lock. Nothing is stored, nothing is rewrapped,
// and nothing is reached that the owner key did not reach already: it owns the Hyperliquid account
// (the lead's call on p2-owner's open item 3).
//
// THE COUNTER. n is vault.json's (src/vault/prefs.ts, hlAgent.version): the version the venue last
// approved, and an approval always names n + 1. The venue may prune the nonces of a key it retired or
// that expired, and a key approved again could then have its old signed orders replayed (docs, nonces
// and API wallets), so no approved address is approved twice. A version the venue never approved
// signed nothing, and the next try names it again.
//
// ONE TOUCH. approveAgent is the owner key's to sign, so on a vault on the chip it is the owner touch
// (src/rails/hl-user-signed.ts, OwnerTouch): one unwrap, one signature, the key zeroed, and a dialog
// read off the signed message that names the new key and how many days it trades. The key it approves
// was made at the open, so the touch signs and nothing else, and trading starts with no second touch.
// The approval keeps the name scripts/hl-agent.ts gave Phosphor's keys, so it replaces the key that
// held it: a plan still holding that key is let finish first.
//
// A wallet that holds its owner key (kind key) is left as it was: its trading key is still the one
// scripts/hl-agent.ts wrote, and this refuses, because there a signature would ask no touch at all.

import { isHlAgentVersion } from '../keystore/derived.ts';
import type { HlAgentPlan, Keystore } from '../keystore/store.ts';
import { HL_AGENT_LABEL, agentNameUntil, approveAgent, extraAgents, ownerTouchRequired } from '../rails/hl-user-signed.ts';
import type { HlApproveResult } from '../rails/hl-user-signed.ts';
import type { ReasonCode } from '../rails/reasons.ts';
import type { VaultPrefs, VaultPrefsData } from '../vault/prefs.ts';

/* How long one approval lets the key trade: a quarter, well inside the venue's 180 days so no clock
   between here and the venue can push it past, and short enough that a key that leaked stops on its
   own. Renewing is the same one Touch ID. */
export const HL_AGENT_DAYS = 90;
const DAY_MS = 86_400_000;

/* Which trading keys an open derives for `vault` (src/keystore/store.ts, planHlAgentsWith): the one
   the venue approved for it, when vault.json names one, and the next version. The counter is the
   file's, whichever wallet in this data folder last moved it, so it only goes up. */
export function hlAgentPlan(prefs: Pick<VaultPrefsData, 'hlAgent'>, vault: string): HlAgentPlan {
  const last = prefs.hlAgent;
  const next = (last?.version ?? 0) + 1;
  return {
    trade: last !== undefined && last.account === vault.toLowerCase() ? last.version : null,
    next: isHlAgentVersion(next) ? next : null,
  };
}

export type HlAgentView = {
  // The vault moved to Touch ID, so allowing trading is one Touch ID. False: the wallet holds its
  // owner key and its trading key is the one scripts/hl-agent.ts wrote, as before.
  moved: boolean;
  // The trading key the venue approved for this vault, made from the owner key; null before the first.
  key: { address: string; version: number; validUntil: number; approvedAt: string; expired: boolean } | null;
  // The key the next approval names, made at the open: null while the wallet is shut or not moved.
  next: string | null;
  // How many days a new approval lets it trade.
  days: number;
};

export function hlAgentView(deps: { keystore: Keystore; prefs: VaultPrefs; now?: () => number }): HlAgentView {
  const now = deps.now ?? Date.now;
  const vault = deps.keystore.addresses().evm;
  const prefs = deps.prefs.get();
  const moved = ownerTouchRequired();
  const last = prefs.hlAgent;
  const mine = vault !== null && last !== undefined && last.account === vault.toLowerCase() ? last : null;
  const plan = vault === null ? null : hlAgentPlan(prefs, vault);
  return {
    moved,
    key: mine === null ? null : { address: mine.address, version: mine.version, validUntil: mine.validUntil, approvedAt: mine.approvedAt, expired: mine.validUntil <= now() },
    next: moved && plan !== null && plan.next !== null ? (deps.keystore.hlAgentAccount(plan.next)?.toLowerCase() ?? null) : null,
    days: HL_AGENT_DAYS,
  };
}

export type AllowTradingDeps = {
  keysPath: string;
  keystore: Keystore;
  prefs: VaultPrefs;
  // How many plans hold today's trading key (src/keystore/session.ts armed()): the approval replaces it.
  armed: () => number;
  // The kill switch, read before the touch and again once the key is in hand.
  frozen: () => boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

/* What an approval came to. A refusal's `code` is this module's (not_moved, locked, busy, frozen,
   reopen, asking, refused, unknown, not_recorded) or the owner touch's own (user_cancel, timeout,
   unnamed and the rest); `detail` is for the log, and the route says it to a person. */
export type AllowTradingResult =
  | { ok: true; address: string; version: number; validUntil: number; days: number }
  | { ok: false; code: string; detail: string; reason?: ReasonCode };

function no(code: string, detail: string, reason?: ReasonCode): AllowTradingResult {
  return { ok: false, code, detail, ...(reason === undefined ? {} : { reason }) };
}

// What the last check throws: before the ask, and again inside the touch before the owner key signs.
class Stopped extends Error {
  readonly code: 'not_moved' | 'frozen' | 'busy';
  constructor(code: 'not_moved' | 'frozen' | 'busy', message: string) {
    super(message);
    this.code = code;
  }
}

let asking = false;

/* "Allow trading on Hyperliquid": one Touch ID approves the next trading key, and from then on the
   session trades with it. One at a time: a second click while the first dialog is up is refused, not
   queued behind it as a second dialog. */
export async function allowTrading(deps: AllowTradingDeps): Promise<AllowTradingResult> {
  if (asking) return no('asking', 'an approval is already waiting for its Touch ID');
  asking = true;
  try {
    return await allow(deps);
  } finally {
    asking = false;
  }
}

async function allow(deps: AllowTradingDeps): Promise<AllowTradingResult> {
  const now = deps.now ?? Date.now;
  if (deps.frozen()) return no('frozen', 'the kill switch is on');
  if (!ownerTouchRequired()) return no('not_moved', 'the wallet holds its owner key, so its trading key comes from scripts/hl-agent.ts');
  if (!deps.keystore.isUnlocked()) return no('locked', 'the trading key is made at the open, and the wallet is shut');
  const armed = deps.armed();
  if (armed > 0) return no('busy', `${armed} armed ${armed === 1 ? 'plan holds' : 'plans hold'} the trading key this approval replaces`);
  const vault = deps.keystore.addresses().evm;
  if (vault === null) return no('locked', 'no wallet address to approve a trading key for');
  const plan = hlAgentPlan(deps.prefs.get(), vault);
  const address = plan.next === null ? null : deps.keystore.hlAgentAccount(plan.next);
  if (plan.next === null || address === null) return no('reopen', `trading key ${String(plan.next)} was not made at this open`);
  const version = plan.next;

  const nonce = now();
  const validUntil = nonce + HL_AGENT_DAYS * DAY_MS;
  /* A session the gate closed on while it still held the owner key (a marker whose chain read is not
     back) lets go of it here, as approve() does before a withdrawal: this signature is the owner
     touch's or nothing, never one made from memory. A session on the chip holds none: no change. */
  deps.keystore.dropOwnerKey();
  /* Asked again at the signature: the gate (a marker read as moved until the chain answers) saying
     the vault never moved after all, Freeze, or a plan armed while the dialog was up (it took the key
     this approval replaces) each stops it with nothing signed. */
  const lastCheck = (): void => {
    if (!ownerTouchRequired()) throw new Stopped('not_moved', 'the chain says the vault never moved, so nothing was signed');
    if (deps.frozen()) throw new Stopped('frozen', 'Phosphor was frozen while Touch ID was up, so nothing was signed');
    if (deps.armed() > 0) throw new Stopped('busy', 'a plan took the trading key while Touch ID was up, so nothing was signed');
  };
  let out: HlApproveResult;
  try {
    out = await approveAgent(
      { keysPath: deps.keysPath, fetchImpl: deps.fetchImpl, now, lastCheck },
      { agentAddress: address, agentName: agentNameUntil(HL_AGENT_LABEL, validUntil), nonce },
    );
  } catch (err) {
    // Thrown before anything was signed: approveAgent signs last and posts after, and never throws there.
    if (err instanceof Stopped) return no(err.code, err.message);
    return no('not_sent', err instanceof Error ? err.message : String(err), 'not_sent');
  }
  if (!out.ok && out.touch !== undefined) return no(out.touch, out.detail, out.reason);

  let until = validUntil;
  if (!out.ok) {
    if (out.ambiguous !== true) return no('refused', out.detail);
    // No answer: the venue's own list says whether the key went in, and nothing is signed again.
    const listed = await extraAgents({ keysPath: deps.keysPath, fetchImpl: deps.fetchImpl }, vault).catch(() => null);
    const found = listed?.find((a) => a.address === address.toLowerCase());
    if (found === undefined) return no('unknown', `${out.detail}; the venue's list ${listed === null ? 'did not answer either' : 'does not show the key'}`);
    until = found.validUntil ?? validUntil;
  }
  try {
    deps.prefs.setHlAgent({ account: vault, version, address, validUntil: until }, now);
  } catch (err) {
    return no('not_recorded', `the venue approved trading key ${address} and vault.json did not take it: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { ok: true, address: address.toLowerCase(), version, validUntil: until, days: HL_AGENT_DAYS };
}
