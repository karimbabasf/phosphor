// The NEAR Intents deposit rail: move money from this wallet INTO the intents.near verifier,
// where it becomes a balance the intents-native rail can swap without transferring anything.
//
// WHY THIS IS A RAIL OF ITS OWN AND NOT A SWAP. The asset does not change. ETH on Ethereum
// goes in, the same ETH comes out, and the only thing that moves is custody: from an address
// this app holds a key for, to a balance the verifier holds under our account id. Modelling
// that as a swap would mean a SwapDraft whose fromSymbol and toSymbol are equal and whose
// `to` is not an address at all, and it would put recipientType on the agent-facing tool
// surface. An agent that can choose recipientType can choose who gets credited. The kind is
// separate so that field never has to exist on the wire: this rail credits our own account
// id, resolved from our own key, and there is no argument that can say otherwise.
//
// THE SEQUENCE, four steps, one signature:
//   1. POST /v0/quote, dry:false, recipientType INTENTS -> a live EVM depositAddress
//   2. one transfer of the input to that address (the only signature involved)
//   3. POST /v0/deposit/submit, optional, so the solver stops waiting
//   4. GET /v0/status until SUCCESS, REFUNDED or FAILED
// No API key and no NEAR account: depositType stays ORIGIN_CHAIN, so the funds arrive by
// ordinary transfer and the solver needs no authorisation from us beyond seeing the money.
// Verified unauthenticated against the live API on 2026-08-13.
//
// NATIVE VALUE, WHICH THE SWAP RAIL NEVER SENDS. src/rails/oneclick.ts moves ERC-20 tokens,
// so the gas asset and the moved asset are different things and the wallet cannot be drained
// into a state where it can no longer pay for a transaction. This rail sends the gas asset
// itself. That is one new failure mode and it is unrecoverable: a deposit of the entire
// balance leaves nothing to pay gas with, and every later transaction, including the one
// that would rescue the funds, fails. checkNativeReserve() below is the answer and it runs
// before anything is signed.
//
// THIS RAIL IS MAINNET ONLY, for the reason in src/rails/oneclick.ts: NEAR Intents has no
// testnet, there is no 1Click host to call, and intents.near has never been deployed on NEAR
// testnet. execute() refuses on any other network before it does anything else.

import { formatUnits, getAddress, isAddress } from 'viem';
import type { Address } from 'viem';
import { erc20TransferData, evmAddress, reader, sendTx } from '../chain/evm.ts';
import type { SendOutcome, SendParams } from '../chain/evm.ts';
import type { ChainId, IntentsDepositDraft, Network, Rail, RailResult, SimulationResult } from '../types.ts';
import {
  NATIVE_ASSET,
  NATIVE_TOKEN_ID,
  ONECLICK_TERMINAL,
  assetIdFor,
  nativeAssetIdFor,
  oneClickClient,
  oneLine,
  toBaseUnits,
} from '../intents.ts';
import type { OneClickClient, OneClickQuote, OneClickStatus, TokensFile } from '../intents.ts';
import { NO_TESTNET_REASON, ONECLICK_COUNTERPARTY } from './oneclick.ts';

// The chains src/chain/evm.ts can sign for. 1Click accepts Solana and NEAR origins too;
// Phosphor has no signer for them, so a draft naming one is refused rather than attempted.
const EVM_ORIGINS: ChainId[] = ['eth', 'base', 'arb'];

// The deposit hands funds to a per-quote address minted by 1Click, exactly as the oneclick
// swap rail does, so it is governed by the same allowlist entry rather than a second string
// meaning the same thing. A separate constant would read as a separate trust decision while
// being the same operator, the same address-minting model and the same boundary; worse, it
// would leave an already-approved policy silently one entry short and the rail dead. The
// audit log still tells the two apart: the proposal kind is 'intents_deposit', not 'swap'.
export const INTENTS_DEPOSIT_COUNTERPARTY = ONECLICK_COUNTERPARTY;

// How much of the gas asset must survive a native deposit, as a multiple of the gas this
// very transaction is estimated to burn. A plain 1x would leave a wallet that can pay for
// the transfer it just made and nothing after it, which on a chain whose base fee moved
// between estimate and inclusion is the same as leaving nothing. 5x is small in absolute
// terms (a 21000-gas send at 0.09 gwei reserves fractions of a cent) and is the difference
// between a wallet that can still act and one that is bricked with funds inside it.
export const NATIVE_GAS_RESERVE_MULTIPLE = 5n;

// A floor under that multiple, in wei, because the multiple alone is only as meaningful as
// the gas price at the moment it is read.
//
// Measured 2026-08-13: Ethereum mainnet base fee was 0.09 gwei, so a 21000-gas send cost
// 0.0000019 ETH and a 5x reserve came to 0.0000095 ETH, about a third of a cent. That guard
// would let a deposit take all but $0.02 of the wallet and still call it safe, and the wallet
// would then be unable to move when gas returned to a normal level. Sizing a reserve off a
// once-in-a-cycle low is how a check passes every test and protects nothing.
//
// This is "three ordinary sends at 20 gwei", which is a plausible normal rather than a
// plausible spike: 21000 * 20e9 * 3. It is not an attempt to survive a gas crisis, it is an
// attempt to leave a wallet that can still act, including the transaction that would move
// the rest of the funds somewhere else.
//
// Only the EVM chains this rail can sign for appear. Base and Arbitrum are L2s where the same
// arithmetic gives a far smaller number, and they carry their own entries rather than
// inheriting Ethereum's, which would strand a wallet's whole balance behind a mainnet-sized
// reserve on a chain where a send costs a fraction of a cent.
export const NATIVE_GAS_RESERVE_FLOOR_WEI: Partial<Record<ChainId, bigint>> = {
  eth: 21_000n * 20_000_000_000n * 3n, // 0.00126 ETH
  base: 21_000n * 50_000_000n * 3n, // 0.00000315 ETH
  arb: 21_000n * 50_000_000n * 3n, // 0.00000315 ETH
};

// The most a deposit may lose between leaving the wallet and being credited, as basis points
// of the amount sent. It is a constant here and NOT an argument on the agent-facing tool,
// because a tolerance an agent can widen is a tolerance an agent can set to 100%.
//
// 200bps is chosen against the live numbers rather than picked for roundness: 1Click's own
// floor on a $10 ETH deposit came back 1.096% under the input (fee plus the 100bps slippage
// tolerance, which it applies to the quoted output and not to the input). A 100bps draft
// floor would therefore refuse every honest quote. 200bps clears the real floor with room
// and still caps the loss on a $10 deposit at 20 cents.
export const DEPOSIT_MAX_LOSS_BPS = 200;

// The least that may be credited for a given amount sent. Exported so the proposal builder
// and the tests derive it the same way.
export function minCreditedFor(amount: number): number {
  return amount * (1 - DEPOSIT_MAX_LOSS_BPS / 10_000);
}

export type DepositEvmPort = {
  signerAddress(keysPath: string): Address;
  send(params: SendParams): Promise<SendOutcome>;
  nativeBalance(network: Network, chain: ChainId, address: Address): Promise<bigint>;
  estimateNativeSendGas(network: Network, chain: ChainId, from: Address, to: Address, value: bigint): Promise<bigint>;
};

export const liveDepositEvmPort: DepositEvmPort = {
  signerAddress: evmAddress,
  send: sendTx,
  async nativeBalance(network, chain, address) {
    return reader(network, chain).getBalance({ address });
  },
  async estimateNativeSendGas(network, chain, from, to, value) {
    const pub = reader(network, chain);
    const [gas, fees] = await Promise.all([
      pub.estimateGas({ account: from, to, value, data: '0x' }),
      pub.estimateFeesPerGas(),
    ]);
    const perGas = fees.maxFeePerGas ?? fees.gasPrice ?? 0n;
    return gas * perGas;
  },
};

export type IntentsDepositRailDeps = {
  network: Network;
  keysPath: string;
  tokens: TokensFile;
  evm?: DepositEvmPort;
  fetchImpl?: typeof fetch;
  client?: OneClickClient;
  sleepImpl?: (ms: number) => Promise<void>;
  now?: () => number;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
};

export type IntentsDepositRail = Rail<IntentsDepositDraft>;

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// A base-unit field from the API. Never Number(): 18-decimal amounts do not survive a
// double, and a garbage string must fail loudly rather than become NaN.
function baseUnits(value: unknown, field: string): bigint {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error(`1click quote is missing ${field}`);
  }
  try {
    return BigInt(value);
  } catch {
    throw new Error(`1click quote returned a non-integer ${field}: ${oneLine(value, 40)}`);
  }
}

export function intentsDepositRail(deps: IntentsDepositRailDeps): IntentsDepositRail {
  const { network, keysPath, tokens } = deps;
  const evm = deps.evm ?? liveDepositEvmPort;
  const client = deps.client ?? oneClickClient({ fetchImpl: deps.fetchImpl });
  const sleep = deps.sleepImpl ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const pollIntervalMs = deps.pollIntervalMs ?? 5_000;
  const pollTimeoutMs = deps.pollTimeoutMs ?? 5 * 60_000;

  type Plan = {
    asset: string; // the 1Click asset id, the same one on both sides
    decimals: number;
    isNative: boolean;
    token: Address | null; // the ERC-20 contract, or null for the gas asset
    amountBase: bigint;
    minCreditedBase: bigint;
  };

  function requireVenue(draft: IntentsDepositDraft): void {
    if (draft.counterparty !== INTENTS_DEPOSIT_COUNTERPARTY) {
      throw new Error(
        `intents deposit drafts must name ${INTENTS_DEPOSIT_COUNTERPARTY} as the counterparty ` +
          `(got ${oneLine(draft.counterparty, 60)}); the deposit address is minted per quote and cannot be allowlisted in advance`,
      );
    }
  }

  async function plan(draft: IntentsDepositDraft): Promise<Plan> {
    requireVenue(draft);

    if (!EVM_ORIGINS.includes(draft.chain)) {
      throw new Error(
        `the intents deposit rail signs EVM transfers only, so it cannot deposit from ${draft.chain}. ` +
          '1Click itself supports it; Phosphor has no signer for that chain.',
      );
    }

    const list = await client.tokens();
    const isNative = draft.tokenId === NATIVE_TOKEN_ID;

    let asset: string | null;
    let decimals: number;
    let token: Address | null;

    if (isNative) {
      const spec = NATIVE_ASSET[draft.chain];
      if (spec === undefined) throw new Error(`no native asset table entry for ${draft.chain}`);
      // The draft's symbol has to agree with our own table, so a draft cannot claim the gas
      // asset of a chain is something it is not.
      if (draft.symbol !== spec.symbol) {
        throw new Error(`the gas asset of ${draft.chain} is ${spec.symbol}, not ${oneLine(draft.symbol, 20)}`);
      }
      asset = nativeAssetIdFor(draft.chain, list);
      decimals = spec.decimals;
      token = null;
      if (asset === null) throw new Error(`1click does not list native ${spec.symbol} on ${draft.chain} unambiguously`);
    } else {
      const info = tokens[draft.chain]?.[draft.symbol];
      if (!info) throw new Error(`no token registry entry for ${draft.symbol} on ${draft.chain}`);
      if (!isAddress(info.tokenId, { strict: false })) {
        throw new Error(`token registry entry for ${draft.symbol} on ${draft.chain} is not an EVM address`);
      }
      asset = assetIdFor(draft.chain, info.tokenId, list);
      decimals = info.decimals;
      token = getAddress(info.tokenId);
      if (asset === null) throw new Error(`1click does not list ${draft.symbol} on ${draft.chain}`);
    }

    return {
      asset,
      decimals,
      isNative,
      token,
      amountBase: toBaseUnits(draft.amount, decimals),
      minCreditedBase: toBaseUnits(draft.minCredited, decimals),
    };
  }

  // Everything about a quote that has to be true before we would send money to it. Run on the
  // dry quote at simulate time and again on the live quote at execute time, because the live
  // quote is a different quote with a different fee.
  function checkQuote(draft: IntentsDepositDraft, p: Plan, quote: OneClickQuote): string[] {
    const problems: string[] = [];

    const amountIn = baseUnits(quote.amountIn, 'amountIn');
    if (amountIn !== p.amountBase) {
      problems.push(
        `the quote is for ${formatUnits(amountIn, p.decimals)} ${draft.symbol}, not the ${draft.amount} the draft names`,
      );
    }

    // A deposit is not a swap, so what lands has to be the same asset, and enough of it. A
    // solver that credited one wei would otherwise satisfy a rail that only checked the
    // amount going out.
    const minOut = baseUnits(quote.minAmountOut, 'minAmountOut');
    if (minOut < p.minCreditedBase) {
      problems.push(
        `the solver would credit as little as ${formatUnits(minOut, p.decimals)} ${draft.symbol}, ` +
          `below the ${draft.minCredited} floor the draft names`,
      );
    }

    return problems;
  }

  // The check that makes a native deposit survivable. An ERC-20 deposit never needed it: the
  // token and the gas are different balances. Here they are the same one.
  async function checkNativeReserve(draft: IntentsDepositDraft, p: Plan, to: Address): Promise<string | null> {
    if (!p.isNative) return null;

    const owner = evm.signerAddress(keysPath);
    const balance = await evm.nativeBalance(network, draft.chain, owner);
    const gasCost = await evm.estimateNativeSendGas(network, draft.chain, owner, to, p.amountBase);

    // Whichever is larger: a multiple of what this send costs now, or the absolute floor.
    // The multiple tracks a genuinely expensive moment; the floor covers the opposite case,
    // where gas is momentarily so cheap that a multiple of it reserves nothing at all.
    const scaled = gasCost * NATIVE_GAS_RESERVE_MULTIPLE;
    const floor = NATIVE_GAS_RESERVE_FLOOR_WEI[draft.chain] ?? 0n;
    const reserve = scaled > floor ? scaled : floor;

    if (balance < p.amountBase + reserve) {
      const short = p.amountBase + reserve - balance;
      return (
        `depositing ${draft.amount} ${draft.symbol} would leave ${draft.chain} without enough of its own gas asset ` +
        `to pay for another transaction: balance ${formatUnits(balance, p.decimals)}, deposit ${draft.amount}, ` +
        `gas reserve ${formatUnits(reserve, p.decimals)}, short by ${formatUnits(short, p.decimals)} ${draft.symbol}. ` +
        `Deposit at most ${formatUnits(balance - reserve, p.decimals)} ${draft.symbol}.`
      );
    }
    return null;
  }

  function priceLines(draft: IntentsDepositDraft, quote: OneClickQuote): string[] {
    const inUsd = Number(quote.amountInUsd);
    const outUsd = Number(quote.amountOutUsd);
    const feeUsd = Number.isFinite(inUsd) && Number.isFinite(outUsd) ? inUsd - outUsd : NaN;
    return [
      `intents deposit: ${draft.amount} ${draft.symbol} on ${draft.chain} -> ` +
        `${oneLine(quote.amountOutFormatted, 40)} ${draft.symbol} credited to ${draft.intentsAccount} inside intents.near`,
      `fee ${Number.isFinite(feeUsd) ? '$' + feeUsd.toFixed(4) : 'unknown'}, eta ~${Number(quote.timeEstimate)}s, ` +
        `solver floor ${oneLine(quote.minAmountOut, 40)} base units, draft floor ${draft.minCredited} ${draft.symbol}`,
    ];
  }

  function valueUsd(draft: IntentsDepositDraft): number {
    return Number.isFinite(draft.amountUsd) ? draft.amountUsd : Infinity;
  }

  async function simulate(draft: IntentsDepositDraft): Promise<SimulationResult> {
    try {
      const p = await plan(draft);

      // dry:true. A proposal gets priced and shown in the approval gate without minting a
      // deposit address or committing to anything.
      const response = await client.quote({
        dry: true,
        originAsset: p.asset,
        destinationAsset: p.asset, // a deposit does not change the asset
        amount: p.amountBase.toString(),
        refundTo: draft.from,
        refundType: 'ORIGIN_CHAIN',
        recipient: draft.intentsAccount,
        recipientType: 'INTENTS',
        depositType: 'ORIGIN_CHAIN',
      });

      const lines = priceLines(draft, response.quote);
      const problems = checkQuote(draft, p, response.quote);

      if (problems.length > 0) {
        const joined = problems.join('; ');
        return { ok: false, summary: [`REFUSED: ${joined}`, ...lines].join('\n'), error: joined };
      }

      if (network !== 'mainnet') {
        return {
          ok: false,
          summary: [`CANNOT EXECUTE on ${network}: ${NO_TESTNET_REASON}`, ...lines].join('\n'),
          error: NO_TESTNET_REASON,
        };
      }

      // The reserve is checked here as well as in execute() so a human sees the refusal
      // before they click, not after. The address is not known yet at simulate time, so the
      // estimate is taken against our own address, which is the same 21000-gas shape.
      const reserve = await checkNativeReserve(draft, p, evm.signerAddress(keysPath));
      if (reserve !== null) {
        return { ok: false, summary: [`REFUSED: ${reserve}`, ...lines].join('\n'), error: reserve };
      }

      lines.push(
        'execution sends the input to a deposit address the solver picks; only the amounts above are guaranteed',
      );
      lines.push(
        `credited funds are spendable by the intents-native swap rail and are NOT in this wallet: ` +
          `withdrawing them back on chain is a separate action`,
      );
      return { ok: true, summary: lines.join('\n') };
    } catch (err) {
      const message = errText(err);
      return { ok: false, summary: `intents deposit simulation failed: ${message}`, error: message };
    }
  }

  async function execute(draft: IntentsDepositDraft): Promise<RailResult> {
    if (network !== 'mainnet') throw new Error(NO_TESTNET_REASON);

    const p = await plan(draft);

    // The draft names the wallet a human approved. If the configured key is a different
    // wallet, the refund address in the quote belongs to someone else.
    const owner = evm.signerAddress(keysPath);
    if (draft.from.toLowerCase() !== owner.toLowerCase()) {
      throw new Error(`draft is authored for ${draft.from} but the configured key is ${owner}`);
    }

    // The credited account is our own EVM address, lowercased, because that is the account id
    // the verifier derives for an erc191 signer and it is what the intents-native rail signs
    // as. A draft naming anything else would credit a balance we cannot spend, which is a
    // total loss that no later step can recover.
    if (draft.intentsAccount !== owner.toLowerCase()) {
      throw new Error(
        `draft credits ${oneLine(draft.intentsAccount, 60)} inside intents.near, but this app can only spend the ` +
          `balance of ${owner.toLowerCase()}; depositing to any other account id is unrecoverable`,
      );
    }

    const response = await client.quote({
      dry: false,
      originAsset: p.asset,
      destinationAsset: p.asset,
      amount: p.amountBase.toString(),
      refundTo: draft.from,
      refundType: 'ORIGIN_CHAIN',
      recipient: draft.intentsAccount,
      recipientType: 'INTENTS',
      depositType: 'ORIGIN_CHAIN',
    });
    const quote = response.quote;

    const problems = checkQuote(draft, p, quote);
    if (problems.length > 0) throw new Error(`live quote does not match the approved draft: ${problems.join('; ')}`);

    if (typeof quote.depositMemo === 'string' && quote.depositMemo !== '') {
      throw new Error(
        'the quote requires a deposit memo, which an EVM transfer cannot carry; funds sent without it are lost',
      );
    }
    if (typeof quote.depositAddress !== 'string' || !isAddress(quote.depositAddress, { strict: false })) {
      throw new Error(`1click returned no usable deposit address (got ${oneLine(quote.depositAddress, 60)})`);
    }
    // Throws on a mixed-case address with a bad checksum, which is exactly when we want to stop.
    const depositAddress = getAddress(quote.depositAddress);

    // Last gate before the key is touched, re-estimated against the real destination.
    const reserve = await checkNativeReserve(draft, p, depositAddress);
    if (reserve !== null) throw new Error(reserve);

    const sent = await evm.send(
      p.isNative
        ? { network, chain: draft.chain, keysPath, to: depositAddress, data: '0x', value: p.amountBase }
        : { network, chain: draft.chain, keysPath, to: p.token as Address, data: erc20TransferData(depositAddress, p.amountBase) },
    );

    if (!sent.ok) {
      const where = sent.hash !== undefined ? ` (tx ${sent.hash})` : '';
      return {
        ok: false,
        detail: `deposit transfer failed${where}: ${oneLine(sent.error ?? 'unknown error')}. No funds left the wallet.`,
        txids: sent.hash !== undefined ? [sent.hash] : [],
      };
    }

    const txHash = sent.hash ?? '(no hash)';
    const evidence = `deposit ${depositAddress}, origin tx ${txHash}`;

    // Best effort. The solver finds the deposit on its own; this only saves a few seconds.
    await client.submitDeposit(depositAddress, txHash);

    const watch = await watchStatus(depositAddress);

    if (watch.status === 'SUCCESS') {
      return {
        ok: true,
        detail:
          `deposited ${draft.amount} ${draft.symbol} from ${draft.chain} into intents.near; ` +
          `${oneLine(quote.amountOutFormatted, 40)} ${draft.symbol} now credited to ${draft.intentsAccount} ` +
          `and spendable by the intents-native swap rail; ${evidence}`,
        txids: [txHash, ...watch.destinationTxHashes],
      };
    }

    if (watch.status === 'REFUNDED' || watch.status === 'FAILED') {
      return {
        ok: false,
        detail: `1click reported ${watch.reported} after the deposit landed; ${evidence}. Check the refund address ${draft.from}.`,
        txids: [txHash, ...watch.originTxHashes, ...watch.destinationTxHashes],
      };
    }

    // Timed out. The transfer confirmed, so the money is already gone from the wallet and the
    // deposit is very likely still settling. Saying "failed" without that sentence is how
    // someone sends the same amount twice.
    return {
      ok: false,
      detail:
        `deposit confirmed on chain but 1click did not reach a terminal status within ${Math.round(pollTimeoutMs / 1000)}s ` +
        `(last status ${watch.reported}); ${evidence}. THE FUNDS WERE SENT and the credit may still land: ` +
        'check the balance inside intents.near before retrying.',
      txids: [txHash, ...watch.originTxHashes],
    };
  }

  // Polls until terminal, out of attempts, or out of time. Never throws: a status endpoint
  // that goes down after the money has moved must not turn into an unhandled rejection.
  async function watchStatus(depositAddress: string): Promise<OneClickStatus> {
    const deadline = now() + pollTimeoutMs;
    const maxPolls = Math.max(1, Math.ceil(pollTimeoutMs / pollIntervalMs));
    let last: OneClickStatus = {
      found: false,
      status: 'PENDING_DEPOSIT',
      reported: 'not polled',
      originTxHashes: [],
      destinationTxHashes: [],
    };

    for (let attempt = 0; attempt < maxPolls; attempt += 1) {
      try {
        last = await client.status(depositAddress);
        if ((ONECLICK_TERMINAL as readonly string[]).includes(last.status)) return last;
      } catch (err) {
        last = { ...last, reported: `status check failed: ${oneLine(errText(err), 80)}` };
      }
      if (now() >= deadline) break;
      await sleep(pollIntervalMs);
    }

    return last;
  }

  return { kind: 'intents_deposit', valueUsd, simulate, execute };
}
