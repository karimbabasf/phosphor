// Who can move a vault, read straight from NEAR: the public keys intents.near holds for the
// account, whether auth by predecessor id is on, and the block each answer came from. A vault that
// moved to this Mac's Touch ID key holds exactly two keys, one p256 (the Touch ID key) and one
// secp256k1 (the paper key), with predecessor auth off (docs/verify.md, Check your vault on NEAR).
//
// It asks two NEAR RPC providers run by different organizations, both at one final block, and
// prints an answer only when the two agree. When they disagree, or one gives no answer, it names
// both answers and exits non-zero: one provider alone could tell you anything.
//
// public_keys_of never lists a 0x account's own key (the key whose address the account is), so a
// list with no such key proves nothing about it. --key asks has_public_key for a key by name, that
// one included.
//
// Read-only: a block read and three views, no key, nothing signed or sent. It imports Node's own
// modules only, so it runs from a clone with no npm install.
//
// Run: node scripts/vault-check.ts <vault account> [--key <ed25519:|secp256k1:|p256:...>]...
// Exit 0 when both providers agree, 1 when they disagree, 2 when one gave no answer, 3 when the
// arguments are not an account and keys.

import { setTimeout as sleep } from 'node:timers/promises';

export const VERIFIER_ACCOUNT = 'intents.near';

export type Provider = { name: string; url: string };

// Two organizations, two node fleets: FastNEAR runs the RPC the app reads, dRPC its own. The
// release gate asks the same two (scripts/verifier-gate.ts), and a test holds them equal.
export const PROVIDERS: readonly Provider[] = [
  { name: 'FastNEAR', url: 'https://free.rpc.fastnear.com' },
  { name: 'dRPC', url: 'https://near.drpc.org' },
];

export type Block = { height: number; hash: string };
export type Answer = { provider: Provider; block: Block; keys: string[]; predecessorAuth: boolean; named: Record<string, boolean> };
export type NoAnswer = { provider: Provider; missing: string };
// Two final blocks at one height with different hashes: the chain itself is in dispute.
export type BlockOnly = { provider: Provider; block: Block };
export type VaultCheck =
  | { ok: true; account: string; block: Block; keys: string[]; predecessorAuth: boolean; named: Record<string, boolean>; answers: Answer[] }
  | { ok: false; why: 'disagree' | 'missing'; account: string; answers: (Answer | NoAnswer | BlockOnly)[] };

export type CheckOptions = { keys?: string[]; providers?: readonly Provider[]; fetchImpl?: typeof fetch; tries?: number; pauseMs?: number; timeoutMs?: number };

const ACCOUNT_ID = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const KEY_BYTES: Record<string, number> = { ed25519: 32, secp256k1: 64, p256: 64 };
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/* The account as NEAR names it: lower case (an EIP-55 address is the same account), or null. Text
   that starts with 0x must be a whole address: the verifier answers for any account id, so a
   mistyped vault would read as a vault that never moved. */
export function accountIdOf(text: string): string | null {
  const id = text.trim().toLowerCase();
  if (id.startsWith('0x')) return /^0x[0-9a-f]{40}$/.test(id) ? id : null;
  return id.length >= 2 && id.length <= 64 && ACCOUNT_ID.test(id) ? id : null;
}

function base58Bytes(text: string): number | null {
  let n = 0n;
  for (const c of text) {
    const digit = BASE58.indexOf(c);
    if (digit < 0) return null;
    n = n * 58n + BigInt(digit);
  }
  let bytes = 0;
  for (; n > 0n; n >>= 8n) bytes += 1;
  let ones = 0;
  while (ones < text.length && text[ones] === '1') ones += 1;
  return ones + bytes;
}

/* A key as intents.near writes one: a curve it knows, then the base58 of a key that long. */
export function isPublicKey(text: unknown): text is string {
  if (typeof text !== 'string') return false;
  const colon = text.indexOf(':');
  const length = KEY_BYTES[text.slice(0, colon)];
  return colon > 0 && length !== undefined && text.length - colon - 1 <= 2 * length && base58Bytes(text.slice(colon + 1)) === length;
}

type Rpc = { fetchImpl: typeof fetch; tries: number; pauseMs: number; timeoutMs: number };

/* One JSON-RPC result, or the reason there was none. A busy free tier answers HTTP 429 now and
   then, so a read with no answer is asked again, up to `tries` times. */
async function ask(rpc: Rpc, provider: Provider, method: string, params: unknown): Promise<Record<string, unknown> | string> {
  let why = 'no answer';
  for (let attempt = 0; attempt < rpc.tries; attempt += 1) {
    if (attempt > 0) await sleep(rpc.pauseMs);
    try {
      const res = await rpc.fetchImpl(provider.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'vault-check', method, params }),
        signal: AbortSignal.timeout(rpc.timeoutMs),
      });
      if (!res.ok) {
        why = `HTTP ${res.status}`;
        continue;
      }
      const body = (await res.json()) as { result?: unknown; error?: unknown };
      if (body.result !== null && typeof body.result === 'object' && !Array.isArray(body.result)) return body.result as Record<string, unknown>;
      why = `error ${JSON.stringify(body.error ?? null).slice(0, 160)}`;
    } catch (err) {
      why = String(err instanceof Error ? err.message : err).slice(0, 160);
    }
  }
  return why;
}

async function finalBlock(rpc: Rpc, provider: Provider): Promise<Block | string> {
  const result = await ask(rpc, provider, 'block', { finality: 'final' });
  if (typeof result === 'string') return `block: ${result}`;
  const header = result.header as { height?: unknown; hash?: unknown } | undefined;
  return typeof header?.height === 'number' && typeof header.hash === 'string' ? { height: header.height, hash: header.hash } : 'block: no header in the answer';
}

/* A view of intents.near at exactly `block`. A view that ran and failed answers HTTP 200 with a
   flat `error` inside the result, which is no answer, never a value. */
async function view(rpc: Rpc, provider: Provider, block: Block, method: string, args: Record<string, string>): Promise<{ value: unknown } | string> {
  const result = await ask(rpc, provider, 'query', {
    request_type: 'call_function',
    block_id: block.hash,
    account_id: VERIFIER_ACCOUNT,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
  });
  if (typeof result === 'string') return `${method}: ${result}`;
  if (result.error !== undefined) return `${method}: ${String(result.error).slice(0, 160)}`;
  if (result.block_hash !== block.hash || result.block_height !== block.height) return `${method}: answered for another block than ${block.height}`;
  if (!Array.isArray(result.result) || !result.result.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) return `${method}: not a view answer`;
  try {
    return { value: JSON.parse(Buffer.from(result.result as number[]).toString('utf8')) };
  } catch {
    return `${method}: not JSON`;
  }
}

async function answerOf(rpc: Rpc, provider: Provider, block: Block, account: string, keys: string[]): Promise<Answer | NoAnswer> {
  const listed = await view(rpc, provider, block, 'public_keys_of', { account_id: account });
  if (typeof listed === 'string') return { provider, missing: listed };
  if (!Array.isArray(listed.value) || !listed.value.every(isPublicKey)) return { provider, missing: 'public_keys_of: not a list of keys' };
  const auth = await view(rpc, provider, block, 'is_auth_by_predecessor_id_enabled', { account_id: account });
  if (typeof auth === 'string') return { provider, missing: auth };
  if (typeof auth.value !== 'boolean') return { provider, missing: 'is_auth_by_predecessor_id_enabled: not true or false' };
  const named: Record<string, boolean> = {};
  for (const key of keys) {
    const has = await view(rpc, provider, block, 'has_public_key', { account_id: account, public_key: key });
    if (typeof has === 'string') return { provider, missing: has };
    if (typeof has.value !== 'boolean') return { provider, missing: 'has_public_key: not true or false' };
    named[key] = has.value;
  }
  return { provider, block, keys: [...(listed.value as string[])].sort(), predecessorAuth: auth.value, named };
}

const same = (a: Answer, b: Answer) =>
  a.block.hash === b.block.hash && a.predecessorAuth === b.predecessorAuth && JSON.stringify(a.keys) === JSON.stringify(b.keys) && JSON.stringify(a.named) === JSON.stringify(b.named);

/* Both providers at one final block: the lower of their two, so each has it. When one gives no
   final block, the other is still read at its own, so the report names both answers. Throws on an
   account or key it would not send. */
export async function checkVault(accountText: string, opts: CheckOptions = {}): Promise<VaultCheck> {
  const account = accountIdOf(accountText);
  if (account === null) throw new Error(`${accountText} is not a vault address (0x and 40 hex characters) or a NEAR account id`);
  const keys = [...new Set(opts.keys ?? [])];
  const bad = keys.find((key) => !isPublicKey(key));
  if (bad !== undefined) throw new Error(`${bad} is not a public key (ed25519:, secp256k1: or p256:, then base58)`);
  const providers = opts.providers ?? PROVIDERS;
  const rpc: Rpc = { fetchImpl: opts.fetchImpl ?? fetch, tries: opts.tries ?? 3, pauseMs: opts.pauseMs ?? 1_500, timeoutMs: opts.timeoutMs ?? 10_000 };

  const finals = await Promise.all(providers.map((provider) => finalBlock(rpc, provider)));
  if (finals.some((block) => typeof block === 'string')) {
    const answers = await Promise.all(
      finals.map((block, i) => (typeof block === 'string' ? { provider: providers[i]!, missing: block } : answerOf(rpc, providers[i]!, block, account, keys))),
    );
    return { ok: false, why: 'missing', account, answers };
  }
  const blocks = finals as Block[];
  const low = blocks.reduce((a, b) => (b.height < a.height ? b : a));
  if (blocks.some((b) => b.height === low.height && b.hash !== low.hash)) {
    return { ok: false, why: 'disagree', account, answers: blocks.map((block, i) => ({ provider: providers[i]!, block })) };
  }
  const answers = await Promise.all(providers.map((provider) => answerOf(rpc, provider, low, account, keys)));
  if (answers.some((a) => 'missing' in a)) return { ok: false, why: 'missing', account, answers };
  const full = answers as Answer[];
  if (!full.every((a) => same(a, full[0]!))) return { ok: false, why: 'disagree', account, answers };
  const first = full[0]!;
  return { ok: true, account, block: low, keys: first.keys, predecessorAuth: first.predecessorAuth, named: first.named, answers: full };
}

const KIND: Record<string, string> = { p256: 'a P-256 key, the kind a Touch ID key is', secp256k1: 'a secp256k1 key, the kind an EVM key such as a paper key is', ed25519: 'an ed25519 key' };
const onOff = (on: boolean) => (on ? 'on' : 'off');

function answerLine(a: Answer | NoAnswer | BlockOnly): string {
  if ('missing' in a) return `  ${a.provider.name} ${a.provider.url}: no answer (${a.missing})`;
  if (!('keys' in a)) return `  ${a.provider.name} ${a.provider.url}: final block ${a.block.height} ${a.block.hash}`;
  const named = Object.entries(a.named).map(([key, has]) => `, has ${key}: ${has ? 'yes' : 'no'}`).join('');
  return `  ${a.provider.name} ${a.provider.url}: block ${a.block.height} ${a.block.hash}, keys ${a.keys.length ? a.keys.join(' ') : 'none'}, predecessor auth ${onOff(a.predecessorAuth)}${named}`;
}

/* What the person reads: the agreed answer first, then each provider's, block included. */
export function report(check: VaultCheck): string[] {
  if (!check.ok) {
    const head = check.why === 'disagree' ? 'the two providers disagree, so neither answer can be trusted' : 'a provider gave no answer, and one provider alone is not enough';
    return [`vault ${check.account} on ${VERIFIER_ACCOUNT}: ${head}`, ...check.answers.map(answerLine)];
  }
  const lines = [`vault ${check.account} on ${VERIFIER_ACCOUNT}, block ${check.block.height}`, `keys it holds: ${check.keys.length || 'none'}`];
  for (const key of check.keys) lines.push(`  ${key}  ${KIND[key.slice(0, key.indexOf(':'))] ?? 'a key'}`);
  for (const [key, has] of Object.entries(check.named)) lines.push(`has ${key}: ${has ? 'yes, it can sign for the vault' : 'no'}`);
  lines.push(`predecessor auth: ${onOff(check.predecessorAuth)}${check.predecessorAuth ? ' (the account itself can also act through NEAR)' : ''}`);
  if (check.account.startsWith('0x')) lines.push('the vault\'s own 0x key is never in that list: ask for it with --key');
  lines.push('both providers agree:', ...check.answers.map(answerLine));
  return lines;
}

export function exitCodeOf(check: VaultCheck): number {
  return check.ok ? 0 : check.why === 'disagree' ? 1 : 2;
}

export function argsOf(argv: string[]): { account: string; keys: string[] } | null {
  const keys: string[] = [];
  let account: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--key' && argv[i + 1] !== undefined) keys.push(argv[(i += 1)]!);
    else if (!arg.startsWith('-') && account === null) account = arg;
    else return null;
  }
  return account === null ? null : { account, keys };
}

if (import.meta.main) {
  const args = argsOf(process.argv.slice(2));
  if (args === null) {
    console.log('usage: node scripts/vault-check.ts <vault account> [--key <public key>]...');
    process.exit(3);
  }
  try {
    const check = await checkVault(args.account, { keys: args.keys });
    for (const line of report(check)) console.log(line);
    process.exit(exitCodeOf(check));
  } catch (err) {
    console.log(err instanceof Error ? err.message : String(err));
    process.exit(3);
  }
}
