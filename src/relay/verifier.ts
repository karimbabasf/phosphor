// The verifier contract, read for the relay swap rail and the chip vault: the balance an intent
// would spend, the salt a nonce has to carry, whether a nonce has been spent, the keys an account
// signs with, whether it still answers to its predecessor id alone, which verifier is deployed, and
// the events a simulated bundle would emit. View calls and the chain's own clock, no signing,
// nothing here can move money.
//
// Why a nonce needs the salt: the verifier's nonce format is versioned (contracts/defuse/README.md
// in near/intents, "Nonces", read 2026-09-20). A legacy nonce of 32 random bytes still passes
// today and is announced as going away; the versioned V1 nonce carries the contract's current
// 4-byte salt and an expiry, and both `current_salt` and `is_nonce_used` answered live on
// 2026-09-20 (salt "252812b3", an unspent nonce false). Building V1 now is what stops the rail
// from dying the day the legacy shape is refused, and the same nonce is what reconciliation asks
// the contract by after a crash.
//
// Every read answers null when the contract or the RPC did not answer. Null is never zero, never
// false and never "unspent": each caller says what it does without the read.

import { base58Decode, base58Encode, isNearAccountId, nearChainSpec } from '../chain/near.ts';
import { oneLine } from '../intents.ts';
import { INTENTS_VERIFIER, fetchIntentsAssetBalance } from '../ledger/intents.ts';
import { readTimeout } from '../net.ts';

/* NEAR's newest final block: its hash, and its own timestamp in whole milliseconds, rounded down
   so it never reads later than the block is. That timestamp is the clock intents.near judges a
   signed intent's deadline by (src/relay/fate.ts), and the hash is what lets the reads after it
   be taken at that same block: `query` takes a `block_id` in place of `finality` (both answered
   live on 2026-09-25, the final block about 2.6 s behind this Mac's clock). */
export type FinalBlock = { hash: string; atMs: number };

export type VerifierPort = {
  /* What the account holds of one asset, in base units. Null when the read failed. `at` reads at
     that block hash, so the two sides of one move can be read at the same block. */
  balance(accountId: string, assetId: string, at?: string): Promise<bigint | null>;
  // The contract's current 4-byte salt. Null when the read failed or the answer was not 4 bytes.
  currentSalt(): Promise<Uint8Array | null>;
  /* Whether the verifier has committed this nonce for this account. Null when the read failed.
     `at` is a block hash to read at instead of the newest final block. */
  nonceUsed(accountId: string, nonce: string, at?: string): Promise<boolean | null>;
  /* Whether a salt is still one the verifier accepts. A nonce whose salt was rotated out is
     cleanable even when spent (contracts/defuse/src/contract/garbage_collector.rs), so past
     that point "unspent" says nothing about whether the swap executed. Null when the read
     failed. Optional the safe way round: a port without it reads as "no answer", and no failed
     verdict is written on an unspent nonce without one. The live port always has it. */
  isValidSalt?(salt: Uint8Array, at?: string): Promise<boolean | null>;
  // The newest final block and its time. Null when the read failed. Optional the same safe way:
  // without it the deadline is judged by this Mac's clock and the grace (src/relay/fate.ts).
  finalBlock?(): Promise<FinalBlock | null>;
  /* Whether an admin of the verifier has locked this account, which stops it signing anything
     out. Null when the read failed. Optional: the invite claim (src/invite/claim.ts) is the one
     reader, and it refuses a claim it cannot ask this about. */
  accountLocked?(accountId: string): Promise<boolean | null>;
  /* The verifier running signed intents as a view, free and with no account: what execute would
     do, or the contract's own refusal. Null when the call did not answer. Optional the same way.
     `at` runs it at that block hash rather than at the newest final block, the way a rehearsal
     whose deadline is one millisecond past a block must be asked (src/invite/claim.ts). */
  simulate?(signed: SignedIntent[], at?: string): Promise<Simulation | null>;
  /* Whether this key may sign for the account. Asked by name: a 0x account's own secp256k1 key
     reads true here until it is removed, and public_keys_of never lists it (read live on
     2026-10-04). Null when the read failed or the key is not spelled as the verifier spells one.
     The reads below are the chip vault's, and optional the same safe way: a port without them
     has no answer, and nothing that needs one goes ahead. */
  hasPublicKey?(accountId: string, publicKey: string, at?: string): Promise<boolean | null>;
  // The keys the verifier stores for the account. Never a 0x account's implicit key: ask
  // hasPublicKey for that one by name. Null when the read failed.
  publicKeysOf?(accountId: string, at?: string): Promise<string[] | null>;
  /* Whether the account can still act on the verifier by predecessor id alone, with no signed
     intent. On by default: true for an account the verifier has never stored (live, 2026-10-04).
     Null when the read failed. */
  isAuthByPredecessorIdEnabled?(accountId: string, at?: string): Promise<boolean | null>;
  // Which verifier is deployed: its version and source link, and the hash of its code. Null when
  // either read failed.
  sourceMetadata?(): Promise<VerifierSource | null>;
};

export type SignedIntent = { standard: string; payload: string; signature: string };

/* What simulate_intents said. `refusal` is the contract's own words (its panic message, read live
   2026-10-01: "insufficient balance or overflow", "deadline has expired", an ECRecoverError on a
   bad signature), bounded to one line. `intentHashes` is what the verifier names each intent by:
   base58 of its EIP-191 message hash for an erc191 payload, the same handle the relay answers.
   `events` is every log line of the answer read as an event, in the order the verifier wrote
   them; absent when the answer carried no logs (a 0.4.4 answer always carries one). */
export type Simulation = { ok: true; intentHashes: string[]; events?: VerifierEvent[] } | { ok: false; refusal: string };

/* The events a call to the verifier emits, read from its `EVENT_JSON:` log lines (NEP-297,
   standard dip4). The version is not read: 0.4.2 sent 0.3.x and 0.4.4 sends 0.4.3 for these
   shapes. Each typed event carries the intent_hash of the payload that caused it, so a check can
   hold every event to its payload. Anything this reader cannot type (another standard, another
   event, a field it was not taught, an event with no intent_hash) comes back whole as `other`,
   which no expectation contains: an exact check refuses it rather than skips it. Shapes from
   near/intents at the deployed rev a2dd1408 (contracts/defuse/core/src/events/mod.rs, and
   src/contract/intents/simulate.rs, which writes intents_executed last) and from live answers
   read on 2026-10-04. */
export type KeyEventData = { intent_hash: string; account_id: string; public_key: string };
export type AuthEventData = { intent_hash: string; account_id: string; enabled: boolean };
export type TransferEntry = { intent_hash: string; account_id: string; receiver_id: string; tokens: Record<string, string>; memo?: string };
export type ExecutedEntry = { intent_hash: string; account_id: string; nonce: string };
export type VerifierEvent =
  | { event: 'public_key_added'; data: KeyEventData }
  | { event: 'public_key_removed'; data: KeyEventData }
  // Only when the flag actually changes: a second `enabled: false` emits nothing.
  | { event: 'set_auth_by_predecessor_id'; data: AuthEventData }
  // One event per transfer intent, its one entry inside a list.
  | { event: 'transfer'; data: TransferEntry[] }
  // Always the last line: one entry per payload the call ran, in payload order.
  | { event: 'intents_executed'; data: ExecutedEntry[] }
  | { event: 'other'; line: string };

// The message inside a NEAR view error: a contract panic or a host error with a msg, else the
// whole error, one bounded line either way.
export function simulationRefusal(raw: unknown): string {
  const text = typeof raw === 'string' ? raw : (JSON.stringify(raw) ?? String(raw));
  const said = /panic_msg:\s*"((?:[^"\\]|\\.)*)"/.exec(text) ?? /\bmsg:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
  const words = (said?.[1] ?? text).replace(/\\"/g, '"');
  return oneLine(words, 200);
}

/* A successful simulation's output, or a refusal when it reports what execute would refuse.
   `payloads` is how many signed payloads went in, when the caller knows: the verifier names every
   payload it ran in intents_executed, in order (read live on 2026-10-04), and its schema lets an
   entry go without its hash. An answer that names more or fewer than went in does not say what each of
   them would do, so it is a refusal, never a shorter list. */
export function simulationOf(output: unknown, payloads?: number): Simulation {
  if (output === null || typeof output !== 'object') return { ok: false, refusal: 'the verifier answered the simulation with no output' };
  const o = output as { intents_executed?: unknown; invariant_violated?: unknown; logs?: unknown };
  if (o.invariant_violated !== undefined && o.invariant_violated !== null) {
    return { ok: false, refusal: `the intents would not balance: ${oneLine(o.invariant_violated, 160)}` };
  }
  const executed = Array.isArray(o.intents_executed) ? o.intents_executed : [];
  const intentHashes = executed
    .map((e) => (e !== null && typeof e === 'object' ? (e as { intent_hash?: unknown }).intent_hash : null))
    .filter((h): h is string => typeof h === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(h));
  if (payloads !== undefined && executed.length !== payloads) {
    return { ok: false, refusal: `the simulation reported ${executed.length} executed payloads for ${payloads} signed` };
  }
  if (payloads !== undefined && intentHashes.length !== payloads) {
    return { ok: false, refusal: `the simulation left ${payloads - intentHashes.length} of ${payloads} executed payloads without an intent hash` };
  }
  const logs = Array.isArray(o.logs) ? o.logs : [];
  return logs.length === 0 ? { ok: true, intentHashes } : { ok: true, intentHashes, events: logs.map(verifierEventOf) };
}

// ---------- events ----------

const EVENT_PREFIX = 'EVENT_JSON:';

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

// Exactly these keys, the optional ones allowed to be absent. A field this reader does not know
// is a shape it has not been taught, and an exact check must not wave it through.
function hasKeys(o: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every((k) => Object.hasOwn(o, k)) && Object.keys(o).every((k) => required.includes(k) || optional.includes(k));
}

// Base58 that decodes to exactly this many bytes and encodes back to itself, so one value has one
// spelling.
function isBase58Of(value: unknown, bytes: number): value is string {
  if (typeof value !== 'string' || value === '') return false;
  try {
    const decoded = base58Decode(value);
    return decoded.length === bytes && base58Encode(decoded) === value;
  } catch {
    return false;
  }
}

const KEY_BYTES = new Map<string, number>([
  ['ed25519', 32],
  ['secp256k1', 64],
  ['p256', 64],
]);

// A public key the way the verifier spells one: the curve, a colon, and base58 of exactly the
// bytes that curve's key has (x || y for the two ECDSA curves).
export function isVerifierPublicKey(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const colon = value.indexOf(':');
  const bytes = colon > 0 ? KEY_BYTES.get(value.slice(0, colon)) : undefined;
  return bytes !== undefined && isBase58Of(value.slice(colon + 1), bytes);
}

// A V1 or legacy nonce as the verifier prints it: base64 of 32 bytes, in the one spelling that
// decodes back to itself.
function isNonce(value: unknown): value is string {
  if (typeof value !== 'string' || value === '') return false;
  const bytes = Buffer.from(value, 'base64');
  return bytes.length === 32 && bytes.toString('base64') === value;
}

const AMOUNT = /^(0|[1-9]\d*)$/;

function keyData(data: unknown): KeyEventData | null {
  const o = record(data);
  if (o === null || !hasKeys(o, ['intent_hash', 'account_id', 'public_key'])) return null;
  const { intent_hash, account_id, public_key } = o;
  if (!isBase58Of(intent_hash, 32) || !isNearAccountId(account_id) || !isVerifierPublicKey(public_key)) return null;
  return { intent_hash, account_id, public_key };
}

function authData(data: unknown): AuthEventData | null {
  const o = record(data);
  if (o === null || !hasKeys(o, ['intent_hash', 'account_id', 'enabled'])) return null;
  const { intent_hash, account_id, enabled } = o;
  if (!isBase58Of(intent_hash, 32) || !isNearAccountId(account_id) || typeof enabled !== 'boolean') return null;
  return { intent_hash, account_id, enabled };
}

function tokensOf(value: unknown): Record<string, string> | null {
  const o = record(value);
  if (o === null) return null;
  const entries = Object.entries(o);
  if (entries.length === 0) return null;
  const tokens: Record<string, string> = {};
  for (const [asset, amount] of entries) {
    if (asset === '' || typeof amount !== 'string' || !AMOUNT.test(amount)) return null;
    tokens[asset] = amount;
  }
  return tokens;
}

function transferEntries(data: unknown): TransferEntry[] | null {
  if (!Array.isArray(data) || data.length === 0) return null;
  const out: TransferEntry[] = [];
  for (const raw of data) {
    const o = record(raw);
    if (o === null || !hasKeys(o, ['intent_hash', 'account_id', 'receiver_id', 'tokens'], ['memo'])) return null;
    const { intent_hash, account_id, receiver_id, memo } = o;
    const tokens = tokensOf(o.tokens);
    if (!isBase58Of(intent_hash, 32) || !isNearAccountId(account_id) || !isNearAccountId(receiver_id) || tokens === null) return null;
    if (memo !== undefined && typeof memo !== 'string') return null;
    out.push(memo === undefined ? { intent_hash, account_id, receiver_id, tokens } : { intent_hash, account_id, receiver_id, tokens, memo });
  }
  return out;
}

function executedEntries(data: unknown): ExecutedEntry[] | null {
  if (!Array.isArray(data)) return null;
  const out: ExecutedEntry[] = [];
  for (const raw of data) {
    const o = record(raw);
    if (o === null || !hasKeys(o, ['intent_hash', 'account_id', 'nonce'])) return null;
    const { intent_hash, account_id, nonce } = o;
    if (!isBase58Of(intent_hash, 32) || !isNearAccountId(account_id) || !isNonce(nonce)) return null;
    out.push({ intent_hash, account_id, nonce });
  }
  return out;
}

// One log line as an event. Never throws: a line it cannot type is `other`, kept whole.
export function verifierEventOf(line: unknown): VerifierEvent {
  if (typeof line !== 'string' || !line.startsWith(EVENT_PREFIX)) return { event: 'other', line: typeof line === 'string' ? line : (JSON.stringify(line) ?? String(line)) };
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.slice(EVENT_PREFIX.length));
  } catch {
    return { event: 'other', line };
  }
  return typedEvent(parsed, line);
}

/* The same for an event already parsed out of its line ({standard, version, event, data}), the way
   a transaction's receipts hand them over. */
export function verifierEventOfJson(event: unknown): VerifierEvent {
  return typedEvent(event, `${EVENT_PREFIX}${JSON.stringify(event) ?? String(event)}`);
}

function typedEvent(parsed: unknown, line: string): VerifierEvent {
  const other: VerifierEvent = { event: 'other', line };
  const o = record(parsed);
  if (o === null || !hasKeys(o, ['standard', 'version', 'event', 'data']) || o.standard !== 'dip4' || typeof o.version !== 'string') return other;
  switch (o.event) {
    case 'public_key_added': {
      const data = keyData(o.data);
      return data === null ? other : { event: 'public_key_added', data };
    }
    case 'public_key_removed': {
      const data = keyData(o.data);
      return data === null ? other : { event: 'public_key_removed', data };
    }
    case 'set_auth_by_predecessor_id': {
      const data = authData(o.data);
      return data === null ? other : { event: 'set_auth_by_predecessor_id', data };
    }
    case 'transfer': {
      const data = transferEntries(o.data);
      return data === null ? other : { event: 'transfer', data };
    }
    case 'intents_executed': {
      const data = executedEntries(o.data);
      return data === null ? other : { event: 'intents_executed', data };
    }
    default:
      return other;
  }
}

// ---------- the deployed verifier ----------

/* Which verifier is deployed: `version` and `link` from its contract_source_metadata (NEP-330),
   `codeHash` from view_account. The hash is what pins the build: a version string is whatever
   the build says it is. */
export type VerifierSource = { version: string; link: string | null; codeHash: string };

/* The verifier the chip vault was spiked against: every payload shape it signs, the events it
   expects and the views it reads were run live on 0.4.4 (rev a2dd140892b68140bf7e70814604d3ba074d656c)
   on 2026-10-04, before any of it was written. 0.4.5 (rev 16d04f6ec4401263f8914638710260da50bb46b0) replaced it on mainnet
   by 2026-10-07; its diff touches only deposit notifications and key derivation, and both of
   scripts/verifier-check.ts --simulate's chip bundles passed on it exactly that day. Another version
   or code hash is a verifier nobody here has tested yet. */
export const SPIKED_VERIFIER = { version: '0.4.5', codeHash: 'BtA1BEFNS619KkvXFsgcpQ21Tb5yMm32aaUkn7xNothk' } as const;

export function isSpikedVerifier(source: VerifierSource): boolean {
  return source.version === SPIKED_VERIFIER.version && source.codeHash === SPIKED_VERIFIER.codeHash;
}

// The two answers as one source, or null when either is not what those views answer.
export function verifierSourceOf(metadata: unknown, account: unknown): VerifierSource | null {
  const m = record(metadata);
  const a = record(account);
  if (m === null || a === null) return null;
  const { version, link } = m;
  const codeHash = a.code_hash;
  if (typeof version !== 'string' || !/^[0-9A-Za-z.+-]{1,40}$/.test(version) || !isBase58Of(codeHash, 32)) return null;
  return { version, link: typeof link === 'string' ? oneLine(link, 200) : null, codeHash };
}

// ---------- the calls ----------

type ViewBody = { result?: { result?: unknown; error?: unknown }; error?: { cause?: { name?: string } } };

// The same call the ledger makes (src/ledger/intents.ts view), for the methods it does not
// expose. Throws on any answer that is not a view result; the port below turns that into null.
// `at` reads at that block hash rather than at the newest final block.
async function view(methodName: string, args: Record<string, unknown>, fetchImpl: typeof fetch, at?: string): Promise<unknown> {
  const res = await fetchImpl(nearChainSpec().rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'query',
      params: {
        request_type: 'call_function',
        ...(at === undefined ? { finality: 'final' } : { block_id: at }),
        account_id: INTENTS_VERIFIER,
        method_name: methodName,
        args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
      },
    }),
    signal: readTimeout(),
  });
  if (!res.ok) throw new Error(`intents ${methodName} http ${res.status}`);
  const body = (await res.json()) as ViewBody;
  if (body.error !== undefined || body.result === undefined) {
    throw new Error(`intents ${methodName} failed: ${body.error?.cause?.name ?? 'no result'}`);
  }
  /* A view that ran and failed answers flat, inside `result` with HTTP 200: a contract panic
     ("wasm execution failed with error: ..."), an unknown method, or for an account that does not
     exist "... does not exist while viewing" (all read live on 2026-10-04). That is no answer,
     never a value. */
  if (body.result.error !== undefined && body.result.error !== null) {
    throw new Error(`intents ${methodName} refused: ${simulationRefusal(body.result.error)}`);
  }
  if (!Array.isArray(body.result.result)) throw new Error(`intents ${methodName} answered no result`);
  // NEAR returns view output as a byte array of UTF-8 JSON.
  return JSON.parse(Buffer.from(Uint8Array.from(body.result.result)).toString('utf8'));
}

// The verifier's own account (view_account), for the hash of the code it runs.
async function verifierAccount(fetchImpl: typeof fetch): Promise<unknown> {
  const res = await fetchImpl(nearChainSpec().rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'view_account', finality: 'final', account_id: INTENTS_VERIFIER } }),
    signal: readTimeout(),
  });
  if (!res.ok) throw new Error(`intents view_account http ${res.status}`);
  const body = (await res.json()) as { result?: unknown; error?: unknown };
  if (body.error !== undefined || body.result === undefined) throw new Error('intents view_account failed');
  return body.result;
}

// The salt comes back as a JSON string of 8 hex characters ("252812b3"), which is the 4 bytes
// in order. Anything else is not a salt and is refused as null rather than padded or cut.
export function saltBytes(raw: unknown): Uint8Array | null {
  if (typeof raw !== 'string' || !/^[0-9a-fA-F]{8}$/.test(raw)) return null;
  return Uint8Array.from(Buffer.from(raw, 'hex'));
}

/* A block header's hash and time, or null for anything else. The time is `timestamp_nanosec`, the
   exact nanoseconds as a string (read live 2026-09-25 off the RPC below, beside `timestamp`, the
   same figure as a JSON number that has lost its last digits and is not read), cut down to the
   millisecond so a block a fraction of a millisecond past a deadline reads as not past it yet. */
export function finalBlockOf(header: unknown): FinalBlock | null {
  if (header === null || typeof header !== 'object') return null;
  const h = header as { hash?: unknown; timestamp_nanosec?: unknown };
  if (typeof h.hash !== 'string' || h.hash === '') return null;
  if (typeof h.timestamp_nanosec !== 'string' || !/^\d{1,30}$/.test(h.timestamp_nanosec)) return null;
  const atMs = Number(BigInt(h.timestamp_nanosec) / 1_000_000n);
  return Number.isSafeInteger(atMs) && atMs > 0 ? { hash: h.hash, atMs } : null;
}

export function liveVerifier(fetchImpl: typeof fetch = fetch): VerifierPort {
  // A yes or no view, or null for any other answer.
  async function flag(methodName: string, args: Record<string, unknown>, at?: string): Promise<boolean | null> {
    try {
      const answer = await view(methodName, args, fetchImpl, at);
      return typeof answer === 'boolean' ? answer : null;
    } catch {
      return null;
    }
  }
  return {
    async balance(accountId, assetId, at) {
      if (at === undefined) return fetchIntentsAssetBalance({ accountId, assetId, rpcUrl: nearChainSpec().rpcUrl, fetchImpl });
      // The ledger's read (mt_batch_balance_of over one asset), taken at that block.
      try {
        const amounts = await view('mt_batch_balance_of', { account_id: accountId.toLowerCase(), token_ids: [assetId] }, fetchImpl, at);
        if (!Array.isArray(amounts) || amounts.length !== 1) return null;
        const raw: unknown = amounts[0];
        return typeof raw === 'string' && /^\d+$/.test(raw) ? BigInt(raw) : null;
      } catch {
        return null;
      }
    },
    async currentSalt() {
      try {
        return saltBytes(await view('current_salt', {}, fetchImpl));
      } catch {
        return null;
      }
    },
    nonceUsed: (accountId, nonce, at) => flag('is_nonce_used', { account_id: accountId.toLowerCase(), nonce }, at),
    async isValidSalt(salt, at) {
      if (salt.length !== 4) return null;
      // The contract reads a salt as its 8 hex characters, the way current_salt prints it.
      return flag('is_valid_salt', { salt: Buffer.from(salt).toString('hex') }, at);
    },
    async finalBlock() {
      try {
        const res = await fetchImpl(nearChainSpec().rpcUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'block', params: { finality: 'final' } }),
          signal: readTimeout(),
        });
        if (!res.ok) return null;
        const body = (await res.json()) as { result?: { header?: unknown } };
        return finalBlockOf(body.result?.header);
      } catch {
        return null;
      }
    },
    accountLocked: (accountId) => flag('is_account_locked', { account_id: accountId.toLowerCase() }),
    async simulate(signed, at) {
      try {
        const res = await fetchImpl(nearChainSpec().rpcUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'query',
            params: {
              request_type: 'call_function',
              ...(at === undefined ? { finality: 'final' } : { block_id: at }),
              account_id: INTENTS_VERIFIER,
              method_name: 'simulate_intents',
              args_base64: Buffer.from(JSON.stringify({ signed })).toString('base64'),
            },
          }),
          signal: readTimeout(),
        });
        if (!res.ok) return null;
        /* A contract that panics in a view answers inside `result`, as `result.error` beside the
           block it ran at (read live 2026-10-01); an RPC that could not run the call at all answers
           a top-level `error`, which is no answer about the intents. */
        const body = (await res.json()) as { result?: { result?: number[]; error?: unknown }; error?: unknown };
        if (body.result === undefined) return null;
        if (body.result.error !== undefined && body.result.error !== null) return { ok: false, refusal: simulationRefusal(body.result.error) };
        if (!Array.isArray(body.result.result)) return null;
        return simulationOf(JSON.parse(Buffer.from(Uint8Array.from(body.result.result)).toString('utf8')), signed.length);
      } catch {
        return null;
      }
    },
    async hasPublicKey(accountId, publicKey, at) {
      if (!isVerifierPublicKey(publicKey)) return null;
      return flag('has_public_key', { account_id: accountId.toLowerCase(), public_key: publicKey }, at);
    },
    async publicKeysOf(accountId, at) {
      try {
        const answer = await view('public_keys_of', { account_id: accountId.toLowerCase() }, fetchImpl, at);
        return Array.isArray(answer) && answer.every(isVerifierPublicKey) ? [...answer] : null;
      } catch {
        return null;
      }
    },
    isAuthByPredecessorIdEnabled: (accountId, at) => flag('is_auth_by_predecessor_id_enabled', { account_id: accountId.toLowerCase() }, at),
    async sourceMetadata() {
      try {
        const [metadata, account] = await Promise.all([view('contract_source_metadata', {}, fetchImpl), verifierAccount(fetchImpl)]);
        return verifierSourceOf(metadata, account);
      } catch {
        return null;
      }
    },
  };
}
