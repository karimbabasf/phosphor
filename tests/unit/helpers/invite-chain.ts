// A fake intents.near, solver relay and 1Click for the operator script and the proof script, for
// any number of accounts. Like the contract, it recovers the signer from the erc191 signature and
// refuses a payload the signer_id did not sign, a spent nonce, a passed deadline, a locked account
// or a balance short of what the transfers pay; it runs every transfer of a payload and spends the
// nonce in one step, or does nothing. A sleep moves this Mac's clock and the chain's together.

import crypto from 'node:crypto';

import { bytesToHex, recoverMessageAddress } from 'viem';

import { base58Decode } from '../../../src/chain/near.ts';
import type { OneClickQuote } from '../../../src/intents.ts';
import { INVITE_ASSET_ID, intentHashOf } from '../../../src/invite/payload.ts';
import type { MoneyNet } from '../../../scripts/invite/money.ts';
import type { IntentsApiPort } from '../../../src/rails/intents-native.ts';
import type { RelayClient, RelayPublishRequest } from '../../../src/relay/client.ts';
import { buildNonce } from '../../../src/relay/payload.ts';
import type { SignedIntent, VerifierPort } from '../../../src/relay/verifier.ts';
import { signQuote } from './signed-quote.ts';

export const START = Date.parse('2026-10-01T20:00:00.000Z');
export const CHAIN_SALT = Uint8Array.from(Buffer.from('252812b3', 'hex'));

export type Chain = {
  mac: number;
  chain: number;
  balances: Map<string, bigint>;
  spent: Set<string>;
  locked: Set<string>;
  offline: boolean;
  // ok: take and run it; noreply: run it but lose the answer; down: never reach the relay;
  // refuse: answer that it is turned away.
  relayMode: 'ok' | 'noreply' | 'down' | 'refuse';
  executeAfterMs: number;
  queue: Array<{ at: number; payload: string; signature: string }>;
  published: RelayPublishRequest[];
  simulated: SignedIntent[][];
  executed: string[]; // intent hashes, in order
  oneclick: { quotes: number; submitted: Array<{ payload: string; signature: string }>; orders: Map<string, { recipient: string; amount: bigint; delivered: boolean }> };
  reads: number;
};

export function freshChain(): Chain {
  return {
    mac: START,
    chain: START - 2_500,
    balances: new Map(),
    spent: new Set(),
    locked: new Set(),
    offline: false,
    relayMode: 'ok',
    executeAfterMs: 1_000,
    queue: [],
    published: [],
    simulated: [],
    executed: [],
    oneclick: { quotes: 0, submitted: [], orders: new Map() },
    reads: 0,
  };
}

type Body = { signer_id: string; verifying_contract: string; deadline: string; nonce: string; intents: Array<{ intent: string; receiver_id: string; tokens: Record<string, string> }> };

async function signerOf(payload: string, signature: string): Promise<string | null> {
  try {
    if (!signature.startsWith('secp256k1:')) return null;
    const raw = base58Decode(signature.slice('secp256k1:'.length));
    if (raw.length !== 65) return null;
    const withV = Uint8Array.from(raw);
    withV[64] = raw[64]! + 27;
    return (await recoverMessageAddress({ message: payload, signature: bytesToHex(withV) })).toLowerCase();
  } catch {
    return null;
  }
}

/* The contract's verdict on one signed payload at the chain's time, or at `at`: null when it would
   run, else the words intents.near uses. `apply` runs it. */
export async function verdict(chain: Chain, payload: string, signature: string, apply: boolean, at: number = chain.chain): Promise<string | null> {
  let body: Body;
  try {
    body = JSON.parse(payload) as Body;
  } catch {
    return 'failed to parse the payload';
  }
  if (body.verifying_contract !== 'intents.near') return 'wrong verifying contract';
  const signer = await signerOf(payload, signature);
  if (signer !== body.signer_id) return `public key 'secp256k1:x' doesn't exist for account '${body.signer_id}'`;
  if (Date.parse(body.deadline) <= at) return 'deadline has expired';
  if (chain.locked.has(body.signer_id)) return `account '${body.signer_id}' is locked`;
  if (chain.spent.has(`${body.signer_id}|${body.nonce}`)) return 'nonce was already used';
  let total = 0n;
  for (const intent of body.intents) total += BigInt(intent.tokens[INVITE_ASSET_ID] ?? '0');
  if ((chain.balances.get(body.signer_id) ?? 0n) < total) return 'insufficient balance or overflow';
  if (apply) {
    chain.spent.add(`${body.signer_id}|${body.nonce}`);
    chain.balances.set(body.signer_id, (chain.balances.get(body.signer_id) ?? 0n) - total);
    for (const intent of body.intents) {
      const amount = BigInt(intent.tokens[INVITE_ASSET_ID] ?? '0');
      chain.balances.set(intent.receiver_id, (chain.balances.get(intent.receiver_id) ?? 0n) + amount);
    }
    chain.executed.push(intentHashOf(payload));
  }
  return null;
}

export async function settle(chain: Chain): Promise<void> {
  for (const item of [...chain.queue]) {
    if (item.at > chain.mac) continue;
    chain.queue.splice(chain.queue.indexOf(item), 1);
    await verdict(chain, item.payload, item.signature, true);
  }
}

export function verifierOn(chain: Chain): VerifierPort {
  const read = async <T>(value: () => T): Promise<T | null> => {
    chain.reads += 1;
    await settle(chain);
    return chain.offline ? null : value();
  };
  return {
    balance: (account) => read(() => chain.balances.get(account.toLowerCase()) ?? 0n),
    currentSalt: () => read(() => CHAIN_SALT),
    nonceUsed: (account, nonce) => read(() => chain.spent.has(`${account.toLowerCase()}|${nonce}`)),
    isValidSalt: () => read(() => true),
    finalBlock: () => read(() => ({ hash: `block${chain.chain}`, atMs: chain.chain })),
    accountLocked: (account) => read(() => chain.locked.has(account.toLowerCase())),
    simulate: async (signed) => {
      chain.simulated.push(signed);
      if (chain.offline) return null;
      for (const s of signed) {
        const refusal = await verdict(chain, s.payload, s.signature, false);
        if (refusal !== null) return { ok: false, refusal };
      }
      return { ok: true, intentHashes: signed.map((s) => intentHashOf(s.payload)) };
    },
  };
}

function lostAnswer(): Error {
  return Object.assign(new Error('fetch failed'), { cause: { code: 'ETIMEDOUT' } });
}

export function relayOn(chain: Chain): RelayClient {
  return {
    quote: async () => [],
    async publishIntent(req) {
      if (chain.relayMode === 'down') throw lostAnswer();
      chain.published.push(req);
      if (chain.relayMode === 'refuse') return { status: 'FAILED', reason: 'unauthorized: a JWT is required' };
      chain.queue.push({ at: chain.mac + chain.executeAfterMs, payload: req.payload, signature: req.signature });
      if (chain.relayMode === 'noreply') throw lostAnswer();
      return { status: 'OK', intentHash: intentHashOf(req.payload) };
    },
    async status(intentHash) {
      await settle(chain);
      const ran = chain.executed.includes(intentHash);
      return { intentHash, status: ran ? 'SETTLED' : 'PENDING', statusDetails: null, nearTxHash: ran ? '9fRHzGWLtKvuGEtGAxkUgFAqZeVmbrPDPSvQETDjZhyZ' : null, filledAmounts: [] };
    },
  };
}

/* 1Click as an in-Intents send sees it: a signed quote echoing the request, a handle per quote, an
   erc191 payload paying the quoted amount to the handle, and a status that, once the handle holds
   it, delivers 0.25 percent less to the recipient and says SUCCESS. */
export function oneclickOn(chain: Chain): IntentsApiPort {
  return {
    tokens: async () => [{ assetId: INVITE_ASSET_ID, decimals: 6, blockchain: 'near', symbol: 'USDC' }],
    async quote(params) {
      chain.oneclick.quotes += 1;
      const handle = crypto.createHash('sha256').update(`handle ${chain.oneclick.quotes}`).digest('hex');
      const amount = BigInt(params.amount);
      const out = (amount * 9_975n) / 10_000n;
      chain.oneclick.orders.set(handle, { recipient: String(params.recipient), amount, delivered: false });
      const quote = {
        depositAddress: handle,
        amountIn: params.amount,
        amountInFormatted: '0',
        amountInUsd: '0',
        minAmountIn: params.amount,
        amountOut: out.toString(),
        amountOutFormatted: '0',
        amountOutUsd: '0',
        minAmountOut: ((out * 9_990n) / 10_000n).toString(),
        timeEstimate: 12,
        refundFee: '0',
        withdrawFee: '0',
      } as OneClickQuote;
      const signed = signQuote({
        quote,
        quoteRequest: {
          dry: params.dry,
          swapType: 'EXACT_INPUT',
          slippageTolerance: params.slippageToleranceBps,
          originAsset: params.originAsset,
          destinationAsset: params.destinationAsset,
          amount: params.amount,
          depositType: 'INTENTS',
          refundTo: params.account,
          refundType: 'INTENTS',
          recipient: params.recipient,
          recipientType: params.recipientType,
        },
      });
      return { quote: signed['quote'] as OneClickQuote, raw: signed };
    },
    async generateIntent(params) {
      const order = chain.oneclick.orders.get(params.depositAddress);
      const nonce = buildNonce({ salt: CHAIN_SALT, deadlineMs: chain.mac + 8 * 86_400_000, random: new Uint8Array(15).fill(chain.oneclick.quotes) });
      return {
        standard: 'erc191',
        payload: JSON.stringify({
          signer_id: params.signerId,
          verifying_contract: 'intents.near',
          deadline: new Date(chain.mac + 72 * 3_600_000).toISOString(),
          nonce,
          intents: [{ intent: 'transfer', receiver_id: params.depositAddress, tokens: { [INVITE_ASSET_ID]: (order?.amount ?? 0n).toString() } }],
        }),
      };
    },
    async submitIntent(signed) {
      chain.oneclick.submitted.push(signed);
      chain.queue.push({ at: chain.mac, payload: signed.payload, signature: signed.signature });
      return { intentHash: intentHashOf(signed.payload) };
    },
    async status(depositAddress) {
      await settle(chain);
      const order = chain.oneclick.orders.get(depositAddress);
      const arrived = order !== undefined && (order.delivered || (chain.balances.get(depositAddress) ?? 0n) >= order.amount);
      if (order !== undefined && arrived && !order.delivered) {
        const net = (order.amount * 9_975n) / 10_000n;
        chain.balances.set(depositAddress, (chain.balances.get(depositAddress) ?? 0n) - net);
        chain.balances.set(order.recipient, (chain.balances.get(order.recipient) ?? 0n) + net);
        order.delivered = true;
      }
      const net = order === undefined ? 0n : (order.amount * 9_975n) / 10_000n;
      return {
        found: order !== undefined,
        status: arrived ? 'SUCCESS' : 'PENDING_DEPOSIT',
        reported: arrived ? 'SUCCESS' : 'PENDING_DEPOSIT',
        originTxHashes: [],
        destinationTxHashes: [],
        nearTxHashes: arrived ? ['NearTx1'] : [],
        ...(arrived ? { settledAmountOut: `${net / 1_000_000n}.${(net % 1_000_000n).toString().padStart(6, '0')}` } : {}),
      };
    },
  };
}

// Random bytes that are not random: a counter, so codes and keys differ and a run repeats.
export function countingRandom(seed = 1): (n: number) => Uint8Array {
  let next = seed;
  return (n) => {
    const out = crypto.createHash('sha512').update(`random ${next}`).digest().subarray(0, n);
    next += 1;
    return Uint8Array.from(out);
  };
}

// simulate_intents at a block this fake named in finalBlock(): `block<its time>`.
export function simulateAtOn(chain: Chain): NonNullable<MoneyNet['simulateAt']> {
  return async (signed, blockHash) => {
    chain.simulated.push(signed);
    const at = /^block(\d+)$/.exec(blockHash);
    if (chain.offline || at === null) return null;
    for (const s of signed) {
      const refusal = await verdict(chain, s.payload, s.signature, false, Number(at[1]));
      if (refusal !== null) return { ok: false, refusal };
    }
    return { ok: true, intentHashes: signed.map((s) => intentHashOf(s.payload)) };
  };
}

export function netOn(chain: Chain, over: Partial<MoneyNet> = {}): MoneyNet {
  return {
    verifier: verifierOn(chain),
    relay: relayOn(chain),
    simulateAt: simulateAtOn(chain),
    now: () => chain.mac,
    sleep: async (ms) => {
      chain.mac += ms;
      chain.chain += ms;
    },
    random: countingRandom(),
    firstPollMs: 250,
    pollMs: 3_000,
    ...over,
  };
}
