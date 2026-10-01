// A fake intents.near, solver relay and 1Click for the invite tests: they execute what was
// signed the way the verifier would, the nonce spent and the transfer applied in one step, at the
// world's own time. A sleep in the code under test moves this Mac's clock and the chain's.

import { getAddress } from 'viem';

import type { OneClickQuote } from '../../../src/intents.ts';
import type { IntentsApiPort } from '../../../src/rails/intents-native.ts';
import type { RelayClient, RelayPublishRequest } from '../../../src/relay/client.ts';
import { buildNonce } from '../../../src/relay/payload.ts';
import type { SignedIntent, VerifierPort } from '../../../src/relay/verifier.ts';
import { codeAddress, formatCode } from '../../../src/invite/code.ts';
import { INVITE_ASSET_ID, intentHashOf } from '../../../src/invite/payload.ts';
import { signQuote } from './signed-quote.ts';

export const SECRET = new Uint8Array(16).fill(0x42);
export const CODE = formatCode(SECRET);
export const CODE_ADDRESS = codeAddress(new Uint8Array(16).fill(0x42))!;
export const WALLET = getAddress('0x9858effd232b4033e47d90003d41ec34ecaeda94');
export const WALLET_ID = WALLET.toLowerCase();
export const SALT = Uint8Array.from(Buffer.from('252812b3', 'hex'));
export const HANDLE = 'a7d101a893efccc5e560badd89b55325c99a4da76f2ec584d6a355415e388058';
export const START = Date.parse('2026-10-01T20:00:00.000Z');

// `deadline` is the signed intent's own, in ms: the verifier runs nothing in a block stamped past it.
export type Transfer = { from: string; to: string; amount: bigint; nonce: string; deadline?: number };

export type World = {
  mac: number;
  chain: number;
  balances: Map<string, bigint>;
  spent: Set<string>;
  locked: Set<string>;
  simRefusal: string | null;
  offline: boolean;
  // 'noreply-then-auth': the first send gets no answer, the resend is refused for auth.
  relayMode: 'ok' | 'noreply' | 'auth' | 'quote' | 'failed' | 'noreply-then-auth';
  // Whether a payload the relay or 1Click took runs on the chain, and after how long.
  executes: boolean;
  executeAfterMs: number;
  queued: Array<{ at: number; t: Transfer }>;
  published: RelayPublishRequest[];
  simulated: SignedIntent[][];
  oneclick: {
    quotes: number;
    generated: number;
    submitted: Array<{ payload: string; signature: string }>;
    // What 1Click says once the code's transfer to its handle ran: SUCCESS delivers the net to
    // the wallet, REFUNDED puts the refund back on the code, FAILED is a refund still on its way.
    status: 'SUCCESS' | 'REFUNDED' | 'FAILED' | 'PENDING_DEPOSIT';
    quoteFails: boolean;
    settled: boolean;
    // What 1Click's status says was delivered, formatted, on SUCCESS.
    settledOut: string;
  };
  reads: number;
};

export function freshWorld(): World {
  return {
    mac: START,
    chain: START - 2_500,
    balances: new Map([[CODE_ADDRESS, 5_000_000n]]),
    spent: new Set(),
    locked: new Set(),
    simRefusal: null,
    offline: false,
    relayMode: 'ok',
    executes: true,
    executeAfterMs: 1_000,
    queued: [],
    published: [],
    simulated: [],
    oneclick: { quotes: 0, generated: 0, submitted: [], status: 'SUCCESS', quoteFails: false, settled: false, settledOut: '4.9875' },
    reads: 0,
  };
}

export function settleQueue(world: World): void {
  for (const item of [...world.queued]) {
    if (item.at > world.mac) continue;
    world.queued.splice(world.queued.indexOf(item), 1);
    const key = `${item.t.from}|${item.t.nonce}`;
    const held = world.balances.get(item.t.from) ?? 0n;
    // The chain's time when the item came due: the two clocks move together in this world.
    const chainAt = item.at - (world.mac - world.chain);
    // The verifier runs a transfer and spends its nonce in one call, or does neither, and never in
    // a block stamped past the intent's deadline.
    if (world.spent.has(key) || held < item.t.amount || (item.t.deadline !== undefined && chainAt > item.t.deadline)) continue;
    world.spent.add(key);
    world.balances.set(item.t.from, held - item.t.amount);
    world.balances.set(item.t.to, (world.balances.get(item.t.to) ?? 0n) + item.t.amount);
  }
}

export function transferOf(payload: string): Transfer {
  const body = JSON.parse(payload) as { signer_id: string; nonce: string; deadline: string; intents: Array<{ receiver_id: string; tokens: Record<string, string> }> };
  const intent = body.intents[0]!;
  return { from: body.signer_id, to: intent.receiver_id, amount: BigInt(intent.tokens[INVITE_ASSET_ID]!), nonce: body.nonce, deadline: Date.parse(body.deadline) };
}

// The time of a block this world named (`block<ms>`), or the chain's own time now.
function blockTime(world: World, at: string | undefined): number {
  const named = at === undefined ? null : /^block(\d+)$/.exec(at);
  return named === null ? world.chain : Number(named[1]);
}

export function verifierOf(world: World): VerifierPort {
  const read = <T>(value: T): Promise<T | null> => {
    world.reads += 1;
    settleQueue(world);
    return Promise.resolve(world.offline ? null : value);
  };
  return {
    balance: (account) => read(world.balances.get(account) ?? 0n),
    currentSalt: () => read(SALT),
    nonceUsed: (account, nonce) => read(world.spent.has(`${account}|${nonce}`)),
    isValidSalt: () => read(true),
    finalBlock: () => read({ hash: `block${world.chain}`, atMs: world.chain }),
    accountLocked: (account) => read(world.locked.has(account)),
    simulate: async (signed, at) => {
      world.simulated.push(signed);
      if (world.offline) return null;
      if (world.simRefusal !== null) return { ok: false, refusal: world.simRefusal };
      // Run at the block asked for, as the verifier does: a deadline at or before its stamp is refused.
      const stamp = blockTime(world, at);
      if (signed.some((s) => (transferOf(s.payload).deadline ?? Infinity) <= stamp)) return { ok: false, refusal: 'deadline has expired' };
      return { ok: true, intentHashes: signed.map((s) => intentHashOf(s.payload)) };
    },
  };
}

export function relayOf(world: World): RelayClient {
  return {
    quote: async () => [],
    async publishIntent(req) {
      world.published.push(req);
      if (world.relayMode === 'noreply-then-auth' && world.published.length > 1) {
        throw new Error('relay publish_intent failed: 401');
      }
      if (world.relayMode === 'noreply' || world.relayMode === 'noreply-then-auth') {
        // The answer is lost on the way back; the bytes may still have reached the chain.
        if (world.executes) world.queued.push({ at: world.mac + world.executeAfterMs, t: transferOf(req.payload) });
        throw Object.assign(new Error('fetch failed'), { cause: { code: 'ETIMEDOUT' } });
      }
      if (world.relayMode === 'auth') throw new Error('relay publish_intent failed: The solver relay said: Unauthorized, a JWT is required');
      if (world.relayMode === 'quote') return { status: 'FAILED', reason: 'quote_hashes: no quote found for this intent' };
      if (world.relayMode === 'failed') return { status: 'FAILED', reason: 'intent simulation failed' };
      if (world.executes) world.queued.push({ at: world.mac + world.executeAfterMs, t: transferOf(req.payload) });
      return { status: 'OK', intentHash: intentHashOf(req.payload) };
    },
    async status(intentHash) {
      return { intentHash, status: 'SETTLED', statusDetails: null, nearTxHash: '9fRHzGWLtKvuGEtGAxkUgFAqZeVmbrPDPSvQETDjZhyZ', filledAmounts: [] };
    },
  };
}

// 1Click as an in-Intents send sees it: a signed quote with its request echoed, an erc191 payload
// that hands the code's balance to a handle with a 72 hour deadline, and a status by handle.
export function oneclickOf(world: World): IntentsApiPort {
  return {
    tokens: async () => [{ assetId: INVITE_ASSET_ID, decimals: 6, blockchain: 'near', symbol: 'USDC' }],
    async quote(params) {
      world.oneclick.quotes += 1;
      if (world.oneclick.quoteFails) throw new Error('1click quote http 503');
      const quote: OneClickQuote = {
        depositAddress: HANDLE,
        amountIn: params.amount,
        amountInFormatted: '5.0',
        amountInUsd: '5.0',
        minAmountIn: params.amount,
        amountOut: '4987500',
        amountOutFormatted: '4.9875',
        amountOutUsd: '4.9875',
        minAmountOut: '4982512',
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
      world.oneclick.generated += 1;
      const deadline = new Date(world.mac + 72 * 3_600_000).toISOString();
      const nonce = buildNonce({ salt: SALT, deadlineMs: world.mac + 8 * 86_400_000, random: new Uint8Array(15).fill(3) });
      return {
        standard: 'erc191',
        payload: JSON.stringify({
          signer_id: params.signerId,
          verifying_contract: 'intents.near',
          deadline,
          nonce,
          intents: [{ intent: 'transfer', receiver_id: params.depositAddress, tokens: { [INVITE_ASSET_ID]: world.balances.get(CODE_ADDRESS)!.toString() } }],
        }),
      };
    },
    async submitIntent(signed) {
      world.oneclick.submitted.push(signed);
      if (world.executes) world.queued.push({ at: world.mac, t: transferOf(signed.payload) });
      return { intentHash: 'OneClickIntentHash11111111111111111111111' };
    },
    async status() {
      settleQueue(world);
      const s = world.oneclick.status;
      const ran = (world.balances.get(HANDLE) ?? 0n) >= 5_000_000n || world.oneclick.settled;
      if (ran && !world.oneclick.settled && (s === 'SUCCESS' || s === 'REFUNDED')) {
        world.oneclick.settled = true;
        const to = s === 'SUCCESS' ? WALLET_ID : CODE_ADDRESS;
        const amount = s === 'SUCCESS' ? 4_987_500n : 4_990_000n;
        world.queued.push({ at: world.mac, t: { from: HANDLE, to, amount, nonce: `handle-${s}` } });
        settleQueue(world);
      }
      return {
        found: true,
        status: ran ? s : 'PENDING_DEPOSIT',
        reported: ran ? s : 'PENDING_DEPOSIT',
        originTxHashes: [],
        destinationTxHashes: [],
        nearTxHashes: ['NearTx1'],
        ...(ran && s === 'SUCCESS' ? { settledAmountOut: world.oneclick.settledOut } : {}),
        ...(ran && s === 'REFUNDED' ? { refundedAmount: '4.99' } : {}),
        ...(ran && s === 'FAILED' ? { refundedAmount: '0' } : {}),
      };
    },
  };
}
