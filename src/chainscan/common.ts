// The result shapes and the parsing every chain reader shares: src/chainscan/index.ts for the
// first six networks, src/chainscan/families.ts for the rest. Every string off the wire goes
// through dataText() before it can reach an answer, and every amount through big() or
// decimalUnits() so it stays a decimal string scaled by the asset's decimals, never a float.

import { formatUnits, parseUnits } from 'viem';
import type { PublicClient } from 'viem';

import { chainFetch, CALL_BUDGET_MS, DEFAULT_CAP } from './fetch.ts';
import type { ChainFetchDeps } from './fetch.ts';
import { NETWORKS } from './networks.ts';
import type { ChainNetwork } from './networks.ts';
import { venueReason } from '../venue-words.ts';

// ---------- results ----------

export type AddressActivity = {
  network: ChainNetwork;
  address: string;
  ok: boolean;
  txCount: number | null;
  balance: { amount: string; symbol: string } | null;
  isContract: boolean | null;
  lastSeen: string | null;
  source: string;
  error?: string;
};

export type TokenBalance = {
  symbol: string; // data, capped at 32 characters
  name: string; // data, capped at 32 characters
  amount: string;
  contract: string | null; // the token's own address or mint
  usd: number | null;
};

export type TxStatus = 'success' | 'failed' | 'pending' | 'unknown';

export type ChainTransaction = {
  hash: string;
  time: string | null;
  from: string | null;
  to: string | null;
  value: string | null; // native units, decimal string
  symbol: string;
  status: TxStatus;
  method: string | null; // data, capped at 32 characters
};

export type ChainTransactionDetail = ChainTransaction & {
  fee: string | null;
  block: number | null;
  confirmations: number | null;
};

export type Found = { tx: ChainTransactionDetail; source: string; error?: string };

// The subset of a viem PublicClient the EVM fallback reads. Injected by tests as a fake.
export type EvmReader = Pick<PublicClient, 'getTransactionCount' | 'getBalance' | 'getCode' | 'getTransaction' | 'getTransactionReceipt' | 'getBlockNumber'>;

export type ChainDeps = ChainFetchDeps & {
  reader?: (chain: NonNullable<(typeof NETWORKS)[ChainNetwork]['evm']>) => EvmReader;
};

// ---------- data hygiene ----------

const MAX_TEXT = 32;

function charClass(ranges: ReadonlyArray<readonly [number, number]>): RegExp {
  const body = ranges.map(([lo, hi]) => `${String.fromCodePoint(lo)}-${String.fromCodePoint(hi)}`).join('');
  return new RegExp(`[${body}]`, 'g');
}
const CONTROL_CHARS = charClass([[0x00, 0x1f], [0x7f, 0x9f]]);
const INVISIBLE_CHARS = charClass([[0x200b, 0x200f], [0x202a, 0x202e], [0x2066, 0x2069], [0xfeff, 0xfeff]]);

// A string off the wire, reduced to something with no structure left and a length a reader
// can take in. Not a string at all comes back empty rather than as "[object Object]".
export function dataText(raw: unknown, max = MAX_TEXT): string {
  if (typeof raw !== 'string') return '';
  const s = raw.replace(CONTROL_CHARS, ' ').replace(INVISIBLE_CHARS, '').replace(/[<>`]/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : `${s.slice(0, max - 3).trimEnd()}...`;
}

export function rec(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  return null;
}

export function big(v: unknown): bigint | null {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return BigInt(v.trim());
  if (typeof v === 'string' && /^0x[0-9a-fA-F]+$/.test(v.trim())) return BigInt(v.trim());
  return null;
}

export function units(v: unknown, decimals: number): string | null {
  const b = big(v);
  return b === null ? null : formatUnits(b, decimals);
}

/* An amount a source already writes in whole coins ("223963.5153079" XLM, "0.00001" DASH),
   re-read through base units so it comes out in the same form as every other amount here. A
   number is taken at its fixed-point spelling to the asset's decimals, which is exact for any
   amount a float can carry with that many places. */
export function decimalUnits(v: unknown, decimals: number): string | null {
  const text = typeof v === 'number' && Number.isFinite(v) ? v.toFixed(decimals) : typeof v === 'string' ? v.trim() : '';
  if (!/^-?\d+(\.\d+)?$/.test(text) || (text.split('.')[1] ?? '').length > decimals) return null;
  return formatUnits(parseUnits(text, decimals), decimals);
}

// A decimal string at its own precision, for a source that lists coins with differing decimals
// in one answer (HyperCore's spot balances): validated and tidied, never rounded.
export function decimalText(v: unknown): string | null {
  const text = typeof v === 'string' ? v.trim() : '';
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const places = (text.split('.')[1] ?? '').length;
  return formatUnits(parseUnits(text, places), places);
}

export function isoFromSeconds(v: unknown): string | null {
  const n = num(v);
  return n === null || n <= 0 ? null : new Date(n * 1000).toISOString();
}

export function isoFromMillis(v: unknown): string | null {
  const n = num(v);
  return n === null || n <= 0 ? null : new Date(n).toISOString();
}

export function isoFromNanos(v: unknown): string | null {
  const b = big(v);
  return b === null || b <= 0n ? null : new Date(Number(b / 1_000_000n)).toISOString();
}

export function isoFromText(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const at = Date.parse(v);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

// An address or hash echoed back from a source, kept only when it has the shape it claims.
export function idText(v: unknown): string | null {
  return typeof v === 'string' && /^[0-9a-zA-Z._:-]{1,90}$/.test(v) ? v : null;
}

export function failure(err: unknown): string {
  return dataText(err instanceof Error ? err.message : String(err), 160) || 'failed';
}

export function withDeadline(deps: ChainDeps): ChainDeps {
  return { ...deps, deadline: deps.deadline ?? Date.now() + CALL_BUDGET_MS };
}

// ---------- the sources ----------

export function api(network: ChainNetwork, path: string): string {
  return `https://${NETWORKS[network].api}${path}`;
}

export async function rpc(url: string, method: string, params: unknown, deps: ChainDeps, cap = DEFAULT_CAP, ttl?: number): Promise<unknown> {
  const answer = rec(await chainFetch(url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), cap, ttl }, deps));
  if (answer.error !== undefined) {
    const error = rec(answer.error);
    // The node's own word, or its sentence quoted: a send's check repeats it to the agent.
    const name = dataText(rec(error.cause).name, 40) || dataText(error.message, 80);
    throw new Error(`rpc ${name === '' ? 'error' : venueReason('The node', name, 80)}`);
  }
  return answer.result;
}

// One POST carrying several JSON-RPC calls, answered by id whatever order they come back in.
export async function rpcBatch(url: string, calls: Array<{ method: string; params: unknown }>, deps: ChainDeps, cap = DEFAULT_CAP): Promise<Array<{ result?: unknown; error?: string }>> {
  const body = calls.map((c, i) => ({ jsonrpc: '2.0', id: i + 1, method: c.method, params: c.params }));
  const answers = list(await chainFetch(url, { method: 'POST', body: JSON.stringify(body), cap }, deps)).map(rec);
  return calls.map((_c, i) => {
    const answer = answers.find((a) => a.id === i + 1);
    if (answer === undefined) return { error: 'no answer' };
    if (answer.error !== undefined) {
      const said = dataText(rec(answer.error).message, 80);
      return { error: said === '' ? 'error' : venueReason('The node', said, 80) };
    }
    return { result: answer.result };
  });
}
