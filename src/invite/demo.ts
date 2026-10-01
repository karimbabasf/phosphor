// PHOSPHOR_DEMO_INVITE: a JSON file that stands in for NEAR Intents, the solver relay and 1Click
// for invite codes in demo mode, so a proof can show every state an invite has through the app's
// own routes, claim and frames (scripts/invite-window-proof.ts) on a machine with no funded
// code. Never read in live mode. Demo mode without the file refuses a claim before any read, as it
// always did.
//
// Shape: { "accounts": { "<code account>": { "usdc": "5.00", "locked": true, "offline": true,
//   "slowMs": 4000, "refusal": "insufficient balance or overflow", "landMs": 1500 } } }
// Keyed by the code's account (src/invite/code.ts codeAddress), never by the code. An account the
// file does not name holds nothing. `refusal` is what simulate_intents says for a claim out of it;
// `landMs` is how long a published claim takes to run. Nothing here reaches the network: the claim
// is signed as always, then run in memory, and the money that lands is pretend.

import fs from 'node:fs';

import type { IntentsApiPort } from '../rails/intents-native.ts';
import type { RelayClient } from '../relay/client.ts';
import type { VerifierPort } from '../relay/verifier.ts';
import type { InviteNet } from './claim.ts';
import { INVITE_ASSET_ID, intentHashOf } from './payload.ts';

export const DEMO_INVITE_ENV = 'PHOSPHOR_DEMO_INVITE';

type Account = { base: bigint; locked: boolean; offline: boolean; slowMs: number; refusal: string | null; landMs: number };
type Transfer = { from: string; to: string; amount: bigint; nonce: string };

const SALT = Uint8Array.from([0x25, 0x28, 0x12, 0xb3]);

function usdcBase(value: unknown): bigint {
  if (typeof value !== 'string' || !/^\d+(\.\d{1,6})?$/.test(value)) return 0n;
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
}

function accountsOf(raw: unknown): Map<string, Account> {
  const out = new Map<string, Account>();
  const book = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  for (const [address, value] of Object.entries(book)) {
    const row = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    const ms = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(v, 60_000) : fallback);
    out.set(address.toLowerCase(), {
      base: usdcBase(row.usdc),
      locked: row.locked === true,
      offline: row.offline === true,
      slowMs: ms(row.slowMs, 0),
      refusal: typeof row.refusal === 'string' && row.refusal !== '' ? row.refusal : null,
      landMs: ms(row.landMs, 1_500),
    });
  }
  return out;
}

function transferOf(payload: string): Transfer | null {
  try {
    const body = JSON.parse(payload) as { signer_id: string; nonce: string; intents: Array<{ receiver_id: string; tokens: Record<string, string> }> };
    const leg = body.intents[0]!;
    return { from: body.signer_id.toLowerCase(), to: leg.receiver_id.toLowerCase(), amount: BigInt(leg.tokens[INVITE_ASSET_ID]!), nonce: body.nonce };
  } catch {
    return null;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/* The invite network for this boot: the file's pretend world in demo mode with the file named,
   and null otherwise, which leaves the live network (live mode) or the refusal (demo mode). */
export function demoInviteNet(mode: string, env: NodeJS.ProcessEnv = process.env): InviteNet | null {
  if (mode !== 'demo') return null;
  const file = env[DEMO_INVITE_ENV];
  if (file === undefined || file === '') return null;
  let accounts: Map<string, Account>;
  try {
    accounts = accountsOf((JSON.parse(fs.readFileSync(file, 'utf8')) as { accounts?: unknown }).accounts);
  } catch (err) {
    console.error(`phosphor: ${DEMO_INVITE_ENV} could not be read: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  const balances = new Map<string, bigint>([...accounts].map(([address, a]) => [address, a.base]));
  const spent = new Set<string>();
  const queued: Array<{ at: number; t: Transfer }> = [];

  // The verifier runs a transfer and spends its nonce in one step, or does neither.
  function settle(): void {
    for (const item of [...queued]) {
      if (item.at > Date.now()) continue;
      queued.splice(queued.indexOf(item), 1);
      const key = `${item.t.from}|${item.t.nonce}`;
      const held = balances.get(item.t.from) ?? 0n;
      if (spent.has(key) || held < item.t.amount) continue;
      spent.add(key);
      balances.set(item.t.from, held - item.t.amount);
      balances.set(item.t.to, (balances.get(item.t.to) ?? 0n) + item.t.amount);
    }
  }

  async function read<T>(account: string, value: () => T): Promise<T | null> {
    const row = accounts.get(account.toLowerCase());
    if (row !== undefined && row.slowMs > 0) await sleep(row.slowMs);
    settle();
    return row?.offline === true ? null : value();
  }

  const verifier: VerifierPort = {
    balance: (account, assetId) => read(account, () => (assetId === INVITE_ASSET_ID ? balances.get(account.toLowerCase()) ?? 0n : 0n)),
    currentSalt: async () => SALT,
    nonceUsed: (account, nonce) => read(account, () => spent.has(`${account.toLowerCase()}|${nonce}`)),
    isValidSalt: async () => true,
    finalBlock: async () => ({ hash: 'demo', atMs: Date.now() - 1_000 }),
    accountLocked: (account) => read(account, () => accounts.get(account.toLowerCase())?.locked === true),
    simulate: async (signed) => {
      for (const s of signed) {
        const t = transferOf(s.payload);
        const refusal = t === null ? 'the demo could not read the payload' : accounts.get(t.from)?.refusal ?? null;
        if (refusal !== null) return { ok: false, refusal };
      }
      return { ok: true, intentHashes: signed.map((s) => intentHashOf(s.payload)) };
    },
  };

  const relay: RelayClient = {
    quote: async () => [],
    async publishIntent(req) {
      const t = transferOf(req.payload);
      if (t === null) return { status: 'FAILED', reason: 'the demo could not read the payload' };
      queued.push({ at: Date.now() + (accounts.get(t.from)?.landMs ?? 1_500), t });
      return { status: 'OK', intentHash: intentHashOf(req.payload) };
    },
    async status(intentHash) {
      return { intentHash, status: 'SETTLED', statusDetails: null, nearTxHash: null, filledAmounts: [] };
    },
  };

  // The demo relay never turns a claim away, so the fallback is never asked; if it were, it
  // answers like a 1Click that cannot be reached, and nothing is built that could reach one.
  const away = (): Promise<never> => Promise.reject(new Error('1Click is not part of the demo'));
  const oneclick: IntentsApiPort = { tokens: away, quote: away, generateIntent: away, submitIntent: away, status: away };

  return { verifier, relay, oneclick };
}
