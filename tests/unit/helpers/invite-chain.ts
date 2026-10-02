// A fake intents.near, solver relay and 1Click for the operator script and the proof script, for
// any number of accounts and assets. Like the contract, it recovers the signer from the erc191
// signature and refuses a payload the signer_id did not sign, a spent nonce, a passed deadline, a
// locked account or a balance short of what the transfers pay; it runs every transfer of a payload
// and spends the nonce in one step, or does nothing. A sleep moves this Mac's clock and the chain's
// together. NEAR USDC sits in `balances`, every other asset in `held`.

import crypto from 'node:crypto';

import { bytesToHex, recoverMessageAddress } from 'viem';

import { base58Decode } from '../../../src/chain/near.ts';
import type { OneClickQuote, OneClickStatus } from '../../../src/intents.ts';
import { INVITE_ASSET_ID, intentHashOf } from '../../../src/invite/payload.ts';
import { asInviteBase, variantOf } from '../../../scripts/invite/convert.ts';
import type { MoneyNet } from '../../../scripts/invite/money.ts';
import type { IntentsApiPort } from '../../../src/rails/intents-native.ts';
import type { RelayClient, RelayPublishRequest } from '../../../src/relay/client.ts';
import { buildNonce } from '../../../src/relay/payload.ts';
import type { SignedIntent, VerifierPort } from '../../../src/relay/verifier.ts';
import { signQuote } from './signed-quote.ts';

export const START = Date.parse('2026-10-01T20:00:00.000Z');
export const CHAIN_SALT = Uint8Array.from(Buffer.from('252812b3', 'hex'));

// A 1Click order by its handle: what it takes, where its output and a refund go, and its output.
export type Order = { recipient: string; refundTo: string; amount: bigint; origin: string; destination: string; out: bigint; delivered: boolean };

export type Chain = {
  mac: number;
  chain: number;
  balances: Map<string, bigint>; // NEAR USDC, by account
  held: Map<string, bigint>; // every other asset, by `${assetId}|${account}`
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
  oneclick: {
    quotes: number;
    submitted: Array<{ payload: string; signature: string }>;
    orders: Map<string, Order>;
    // A convert (another asset in): the value it gives up in basis points, how a paid order ends,
    // and edits a test makes to a quote before it is signed or to a payload before it is answered.
    lossBps: number;
    outcome: 'SUCCESS' | 'REFUNDED' | 'PENDING';
    tamper: ((quote: Record<string, unknown>) => void) | null;
    payloadAs: ((payload: Record<string, any>) => void) | null;
    submitAnswer: 'ok' | 'error' | 'lost';
  };
  reads: number;
};

export function freshChain(): Chain {
  return {
    mac: START,
    chain: START - 2_500,
    balances: new Map(),
    held: new Map(),
    spent: new Set(),
    locked: new Set(),
    offline: false,
    relayMode: 'ok',
    executeAfterMs: 1_000,
    queue: [],
    published: [],
    simulated: [],
    executed: [],
    oneclick: { quotes: 0, submitted: [], orders: new Map(), lossBps: 2, outcome: 'SUCCESS', tamper: null, payloadAs: null, submitAnswer: 'ok' },
    reads: 0,
  };
}

export function balanceOf(chain: Chain, account: string, asset: string): bigint {
  const who = account.toLowerCase();
  return (asset === INVITE_ASSET_ID ? chain.balances.get(who) : chain.held.get(`${asset}|${who}`)) ?? 0n;
}

export function setBalance(chain: Chain, account: string, asset: string, amount: bigint): void {
  const who = account.toLowerCase();
  if (asset === INVITE_ASSET_ID) chain.balances.set(who, amount);
  else chain.held.set(`${asset}|${who}`, amount);
}

function credit(chain: Chain, account: string, asset: string, delta: bigint): void {
  setBalance(chain, account, asset, balanceOf(chain, account, asset) + delta);
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
  const totals = new Map<string, bigint>();
  for (const intent of body.intents) {
    for (const [asset, amount] of Object.entries(intent.tokens)) totals.set(asset, (totals.get(asset) ?? 0n) + BigInt(amount));
  }
  for (const [asset, total] of totals) {
    if (balanceOf(chain, body.signer_id, asset) < total) return 'insufficient balance or overflow';
  }
  if (apply) {
    chain.spent.add(`${body.signer_id}|${body.nonce}`);
    for (const intent of body.intents) {
      for (const [asset, amount] of Object.entries(intent.tokens)) {
        credit(chain, body.signer_id, asset, -BigInt(amount));
        credit(chain, intent.receiver_id, asset, BigInt(amount));
      }
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
    balance: (account, asset) => read(() => balanceOf(chain, account, asset)),
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

// 1Click's own fee account, as the live API echoes it (src/intents.ts ONECLICK_FEE_ACCOUNTS).
export const ONECLICK_FEE_ACCOUNT = '5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd';

function usd(base6: bigint): string {
  return `${base6 / 1_000_000n}.${(base6 % 1_000_000n).toString().padStart(6, '0')}`;
}

type Ask = { dry: boolean; origin: string; destination: string; amount: string; recipient: string; refundTo: string; slippageBps: number; feeBps: number };

/* A quote and, for a live one, its order under a fresh handle. The same asset in and out is an
   in-Intents send: 0.25 percent less arrives, priced at nothing. Another asset in is a convert: the
   input at its own decimals, CHAIN.oneclick.lossBps and any fee lines off it, priced in dollars. */
function priceAsk(chain: Chain, ask: Ask): { handle: string; quote: Record<string, unknown> } {
  chain.oneclick.quotes += 1;
  const handle = crypto.createHash('sha256').update(`handle ${chain.oneclick.quotes}`).digest('hex');
  const amount = BigInt(ask.amount);
  const same = ask.origin === ask.destination;
  const value = same ? amount : asInviteBase(amount, variantOf(ask.origin)?.decimals ?? 6);
  const out = same ? (amount * 9_975n) / 10_000n : (value * BigInt(10_000 - chain.oneclick.lossBps - ask.feeBps)) / 10_000n;
  const least = same ? (out * 9_990n) / 10_000n : (out * BigInt(10_000 - ask.slippageBps)) / 10_000n;
  chain.oneclick.orders.set(handle, { recipient: ask.recipient.toLowerCase(), refundTo: ask.refundTo.toLowerCase(), amount, origin: ask.origin, destination: ask.destination, out, delivered: false });
  const quote: Record<string, unknown> = {
    depositAddress: handle,
    amountIn: ask.amount,
    amountInFormatted: '0',
    amountInUsd: same ? '0' : usd(value),
    minAmountIn: ask.amount,
    amountOut: out.toString(),
    amountOutFormatted: '0',
    amountOutUsd: same ? '0' : usd(out),
    minAmountOut: least.toString(),
    timeEstimate: 12,
    refundFee: '0',
    withdrawFee: '0',
  };
  chain.oneclick.tamper?.(quote);
  return { handle, quote };
}

function generated(chain: Chain, signerId: string, depositAddress: string): string {
  const order = chain.oneclick.orders.get(depositAddress);
  const nonce = buildNonce({ salt: CHAIN_SALT, deadlineMs: chain.mac + 8 * 86_400_000, random: new Uint8Array(15).fill(chain.oneclick.quotes) });
  const body: Record<string, any> = {
    signer_id: signerId,
    verifying_contract: 'intents.near',
    deadline: new Date(chain.mac + 72 * 3_600_000).toISOString(),
    nonce,
    intents: [{ intent: 'transfer', receiver_id: depositAddress, tokens: { [order?.origin ?? INVITE_ASSET_ID]: (order?.amount ?? 0n).toString() } }],
  };
  chain.oneclick.payloadAs?.(body);
  return JSON.stringify(body);
}

function lostAnswerFrom1Click(): Error {
  return Object.assign(new Error('fetch failed'), { cause: { code: 'ETIMEDOUT' } });
}

function submitted(chain: Chain, signed: { payload: string; signature: string }): string {
  chain.oneclick.submitted.push(signed);
  if (chain.oneclick.submitAnswer === 'error') throw new Error('submit-intent failed: 1Click\'s own words: "quote expired"');
  chain.queue.push({ at: chain.mac, payload: signed.payload, signature: signed.signature });
  if (chain.oneclick.submitAnswer === 'lost') throw lostAnswerFrom1Click();
  return intentHashOf(signed.payload);
}

/* Once the handle holds the order, a send delivers its 0.25 percent less and says SUCCESS; a
   convert ends the way CHAIN.oneclick.outcome says: the output to the recipient, the input back to
   the refund account, or still PROCESSING. */
async function statusOf(chain: Chain, depositAddress: string): Promise<OneClickStatus> {
  await settle(chain);
  const order = chain.oneclick.orders.get(depositAddress);
  const arrived = order !== undefined && (order.delivered || balanceOf(chain, depositAddress, order.origin) >= order.amount);
  const same = order !== undefined && order.origin === order.destination;
  const outcome = same ? 'SUCCESS' : chain.oneclick.outcome;
  if (order !== undefined && arrived && !order.delivered && outcome !== 'PENDING') {
    credit(chain, depositAddress, order.origin, same ? -order.out : -order.amount);
    if (outcome === 'SUCCESS') credit(chain, order.recipient, order.destination, order.out);
    else credit(chain, order.refundTo, order.origin, order.amount);
    order.delivered = true;
  }
  const status = !arrived ? 'PENDING_DEPOSIT' : outcome === 'PENDING' ? 'PROCESSING' : outcome;
  return {
    found: order !== undefined,
    status,
    reported: status,
    originTxHashes: [],
    destinationTxHashes: [],
    nearTxHashes: arrived ? ['NearTx1'] : [],
    ...(status === 'SUCCESS' && order !== undefined ? { settledAmountOut: usd(order.out) } : {}),
    ...(status === 'REFUNDED' && order !== undefined ? { refundedAmount: usd(asInviteBase(order.amount, variantOf(order.origin)?.decimals ?? 6)) } : {}),
  };
}

/* 1Click as an in-Intents send or a convert sees it, behind the port: a signed quote echoing the
   request, a handle per quote, an erc191 payload paying the quoted amount to the handle, and a
   status by handle. */
export function oneclickOn(chain: Chain): IntentsApiPort {
  return {
    tokens: async () => [{ assetId: INVITE_ASSET_ID, decimals: 6, blockchain: 'near', symbol: 'USDC' }],
    async quote(params) {
      const { quote } = priceAsk(chain, {
        dry: params.dry,
        origin: params.originAsset,
        destination: params.destinationAsset,
        amount: params.amount,
        recipient: String(params.recipient),
        refundTo: params.account,
        slippageBps: params.slippageToleranceBps ?? 100,
        feeBps: 0,
      });
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
      return { standard: 'erc191', payload: generated(chain, params.signerId, params.depositAddress) };
    },
    async submitIntent(signed) {
      return { intentHash: submitted(chain, signed) };
    },
    status: (depositAddress) => statusOf(chain, depositAddress),
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/* The same 1Click on the wire, for the real clients (src/rails/intents-native.ts intentsApi): it
   prices what arrives, fee lines included, echoes the request with the defaults the live API adds
   and its own fee line, and signs. `rewrite` edits a request after the app sent it, `hide` an echo
   after 1Click signed it, the way a position on the wire would. A dry quote carries no handle. */
export function oneclickFetchOn(chain: Chain, wire: { rewrite?: (body: Record<string, any>) => void; hide?: (echo: Record<string, any>) => void } = {}): typeof fetch {
  return async (url, init) => {
    const u = new URL(String(url));
    if (u.pathname === '/v0/tokens') return json([{ assetId: INVITE_ASSET_ID, decimals: 6, blockchain: 'near', symbol: 'USDC' }]);
    if (u.pathname === '/v0/status') return json(statusBody(await statusOf(chain, u.searchParams.get('depositAddress') ?? '')));
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, any>;
    if (u.pathname === '/v0/quote') {
      wire.rewrite?.(body);
      const fees = (Array.isArray(body['appFees']) ? body['appFees'] : []) as Array<{ recipient: string; fee: number }>;
      const { quote } = priceAsk(chain, {
        dry: body['dry'] === true,
        origin: body['originAsset'],
        destination: body['destinationAsset'],
        amount: body['amount'],
        recipient: body['recipient'],
        refundTo: body['refundTo'],
        slippageBps: body['slippageTolerance'],
        feeBps: 1 + fees.reduce((sum, f) => sum + f.fee, 0),
      });
      if (body['dry'] === true) delete quote['depositAddress'];
      else Object.assign(quote, { deadline: body['deadline'], timeWhenInactive: body['deadline'] });
      const echo = { depositMode: 'SIMPLE', ...body, confidentiality: 'public', quoteWaitingTimeMs: 0, insured: false, appFees: [{ recipient: ONECLICK_FEE_ACCOUNT, fee: 1 }, ...fees] };
      const answer = signQuote({ quoteRequest: echo, quote });
      wire.hide?.(answer['quoteRequest'] as Record<string, any>);
      return json(answer);
    }
    if (u.pathname === '/v0/generate-intent') return json({ intent: { standard: 'erc191', payload: generated(chain, body['signerId'], body['depositAddress']) } }, 201);
    if (u.pathname === '/v0/submit-intent') {
      const signedData = body['signedData'] as { payload: string; signature: string };
      try {
        return json({ intentHash: submitted(chain, { payload: signedData.payload, signature: signedData.signature }) });
      } catch (err) {
        if ((err as { cause?: unknown }).cause !== undefined) throw err;
        return json({ message: 'quote expired' }, 400);
      }
    }
    throw new Error(`unexpected ${u.pathname}`);
  };
}

function statusBody(status: OneClickStatus): Record<string, unknown> {
  return {
    status: status.status,
    swapDetails: {
      nearTxHashes: status.nearTxHashes,
      ...(status.settledAmountOut === undefined ? {} : { amountOutFormatted: status.settledAmountOut }),
      ...(status.refundedAmount === undefined ? {} : { refundedAmountFormatted: status.refundedAmount }),
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
