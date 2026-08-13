// The NEAR Intents 1Click swap rail: quote, send the deposit, watch it land.
//
// The whole execution sequence is four steps and only one of them signs anything:
//   1. POST /v0/quote with dry:false, which returns a live depositAddress
//   2. ERC-20 transfer of the input amount to that address (the only signature involved)
//   3. POST /v0/deposit/submit, optional, so the solver stops waiting
//   4. GET /v0/status until SUCCESS, REFUNDED or FAILED
// No API key, no NEAR account, no NEP-413 message signing. That is a property of
// depositType ORIGIN_CHAIN: the funds arrive by ordinary transfer, so the solver needs no
// authorisation from us beyond seeing the money. Verified unauthenticated against the live
// API on 2026-08-12; notes in scratchpad/research-near.md.
//
// THIS RAIL IS MAINNET ONLY, and the guard is not a preference. There is no testnet:
// every candidate host is NXDOMAIN, intents.testnet has never had code deployed, and the
// whole 62-page doc set contains zero occurrences of "testnet". A testnet mode here could
// only be a fake host and a pretend swap, so execute() refuses on any other network before
// it does anything else.
//
// Failure modes this rail has to survive, in the order they bite:
//   - The deposit address is chosen by the remote API and we cannot prove who owns it.
//     That trust is inherent to the protocol. What we can do is check the address is well
//     formed, check the amounts the server echoes back against the draft a human approved,
//     and refuse a quote that cannot meet the draft's slippage floor.
//   - Once the transfer confirms, the money is gone from our side. A poll timeout is
//     therefore NOT a failed transfer, and the detail string has to say so, otherwise a
//     human reads "failed" and sends the same amount again.
//   - A memo chain (XRP, TON, Stellar) returns depositMemo, which an ERC-20 transfer cannot
//     carry. Sending anyway loses the funds, so a memo quote is refused.

import { formatUnits, getAddress, isAddress } from 'viem';
import type { Address } from 'viem';
import { erc20TransferData, evmAddress, sendTx } from '../chain/evm.ts';
import type { SendOutcome, SendParams } from '../chain/evm.ts';
import {
  TGAS,
  ftStorageRegistered,
  functionCall,
  isNearAccountId,
  looksLikeEvmAddress,
  nearAccountId,
  sendTx as nearSendTx,
} from '../chain/near.ts';
import type { NearSendOutcome, NearSendParams } from '../chain/near.ts';
import type { ChainId, Network, Rail, RailResult, SimulationResult, SwapDraft } from '../types.ts';
import { ONECLICK_TERMINAL, assetIdFor, oneClickClient, oneLine, toBaseUnits } from '../intents.ts';
import type { OneClickClient, OneClickQuote, OneClickStatus, TokensFile } from '../intents.ts';

// The message a human sees if the app is pointed anywhere but mainnet. It names the
// alternative, because "not supported" without a next step just gets worked around.
export const NO_TESTNET_REASON =
  'NEAR Intents has no testnet: there is no 1Click host to call, and the verifier contract ' +
  'has never been deployed on NEAR testnet, so this rail runs on mainnet only. To exercise a ' +
  'swap without mainnet money, use the Uniswap v3 rail against an anvil mainnet fork.';

// The chains this rail can deposit from, by signer family.
//
// Every origin needs two things: a signer that can author its transactions, and a transfer
// shape that moves a token to an address the solver picked. EVM origins get that from
// src/chain/evm.ts and an ERC-20 transfer; NEAR gets it from src/chain/near.ts and a
// NEP-141 ft_transfer. Solana is still absent because the signer is, which is the honest
// reason and the one the refusal below gives.
const EVM_ORIGINS: ChainId[] = ['eth', 'base', 'arb'];
const NEAR_ORIGINS: ChainId[] = ['near'];

function originFamily(chain: ChainId): 'evm' | 'near' | null {
  if (EVM_ORIGINS.includes(chain)) return 'evm';
  if (NEAR_ORIGINS.includes(chain)) return 'near';
  return null;
}

// ft_transfer is one cross-contract hop and finishes well inside 30 TGas. The unburnt
// remainder is refunded, so this is a ceiling and not a cost.
const FT_TRANSFER_GAS = 30n * TGAS;

// NEP-141 requires exactly one yoctoNEAR on any method that moves tokens. It is a
// full-access-key assertion: a function-call key cannot attach a deposit, so this single
// yocto is what stops a restricted key from moving somebody's balance.
const ONE_YOCTO = 1n;

// SwapDraft.counterparty is checked against the policy allowlist, and for a DEX that is the
// router address. This rail has no fixed address to name: 1Click mints a fresh deposit
// address per quote and expires it within days, so no address here can ever be on a static
// allowlist. The allowlist entry is therefore the venue, and a draft must name exactly this.
//
// The alternative, putting the deposit address in the field so an unvetted destination
// always needs a human click, does not do that. evaluateRail treats an unlisted counterparty
// as a TERMINAL refusal (rule 'destination_not_allowed'), never as needs_approval, so every
// swap would be refused and the rail would be dead. Proven against the real engine in
// tests/unit/oneclick.test.ts, 'a deposit address as counterparty is refused outright'.
// It could not work anyway: dry:true returns no deposit address (verified live), so minting
// one at proposal time would mean a dry:false call before any human has approved anything.
//
// The click is still available, and through the lever built for it: with the venue
// allowlisted, humanClickAboveUsd governs, so $50 auto-allows and $500 needs a click. Set
// that threshold to 0 to make every swap need one. What bounds the rest is everything
// execute() checks before it signs: the amount, the slippage floor, the memo, the address
// checksum, and the per-transaction and session budgets on top.
export const ONECLICK_COUNTERPARTY = 'oneclick:1click.chaindefuser.com';

// The chain seam, same shape as the Hyperliquid rail: one object the tests replace, so no
// test can reach a real key or a real RPC by forgetting to stub something.
export type SwapEvmPort = {
  signerAddress(keysPath: string): Address;
  send(params: SendParams): Promise<SendOutcome>;
};

export const liveEvmPort: SwapEvmPort = {
  signerAddress: evmAddress,
  send: sendTx,
};

// The NEAR half of the same seam. storageRegistered is here rather than inside send because
// it is a refusal the rail makes BEFORE signing: a NEP-141 transfer to an account with no
// storage deposit on that token panics inside a receipt, and the tokens bounce back after a
// transaction has already been paid for. Checking first turns that into a sentence.
export type SwapNearPort = {
  accountId(keysPath: string): string;
  send(params: NearSendParams): Promise<NearSendOutcome>;
  storageRegistered(network: Network, tokenId: string, accountId: string): Promise<boolean>;
};

export const liveNearPort: SwapNearPort = {
  accountId: nearAccountId,
  send: nearSendTx,
  storageRegistered: (network, tokenId, accountId) => ftStorageRegistered(network, tokenId, accountId),
};

export type OneClickRailDeps = {
  network: Network;
  keysPath: string;
  tokens: TokensFile; // data/tokens.json: chain -> symbol -> { tokenId, decimals }
  evm?: SwapEvmPort;
  near?: SwapNearPort;
  fetchImpl?: typeof fetch;
  client?: OneClickClient;
  sleepImpl?: (ms: number) => Promise<void>;
  now?: () => number;
  pollIntervalMs?: number; // default 5s; the API's own time estimate is ~42s
  pollTimeoutMs?: number; // default 5 min
};

export type OneClickRail = Rail<SwapDraft>;

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

export function oneClickRail(deps: OneClickRailDeps): OneClickRail {
  const { network, keysPath, tokens } = deps;
  const evm = deps.evm ?? liveEvmPort;
  const near = deps.near ?? liveNearPort;
  const client = deps.client ?? oneClickClient({ fetchImpl: deps.fetchImpl });
  const sleep = deps.sleepImpl ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const pollIntervalMs = deps.pollIntervalMs ?? 5_000;
  const pollTimeoutMs = deps.pollTimeoutMs ?? 5 * 60_000;

  // ---------- resolution, shared by simulate and execute ----------

  type Plan = {
    originAsset: string;
    destinationAsset: string;
    originDecimals: number;
    destDecimals: number;
    // The contract holding the input token on the origin chain: an EVM address, or a NEAR
    // account id. Kept as a string so one Plan covers both families; each branch of
    // execute() narrows it back before it signs anything.
    originToken: string;
    family: 'evm' | 'near';
    amountBase: bigint;
    minOutBase: bigint;
  };

  function requireVenue(draft: SwapDraft): void {
    // The dispatch table keys on kind, and 'swap' is shared with the Uniswap rail. A draft
    // for the other venue must bounce here rather than be quietly bridged through NEAR.
    if (draft.venue !== 'oneclick') {
      throw new Error(`oneclick rail received a ${draft.venue} draft; kind 'swap' is shared, venue is not`);
    }
    if (draft.counterparty !== ONECLICK_COUNTERPARTY) {
      throw new Error(
        `oneclick drafts must name ${ONECLICK_COUNTERPARTY} as the counterparty (got ${oneLine(draft.counterparty, 60)}); ` +
          'the deposit address is minted per swap and cannot be allowlisted in advance',
      );
    }
  }

  async function plan(draft: SwapDraft): Promise<Plan> {
    requireVenue(draft);

    const family = originFamily(draft.chain);
    if (family === null) {
      throw new Error(
        `oneclick rail cannot deposit from ${draft.chain}: Phosphor has no signer for that chain. ` +
          '1Click itself supports it.',
      );
    }

    const originInfo = tokens[draft.chain]?.[draft.fromSymbol];
    const destInfo = tokens[draft.toChain]?.[draft.toSymbol];
    if (!originInfo) throw new Error(`no token registry entry for ${draft.fromSymbol} on ${draft.chain}`);
    if (!destInfo) throw new Error(`no token registry entry for ${draft.toSymbol} on ${draft.toChain}`);

    // Each family validates the token id its own way. Letting a NEAR account id through an
    // EVM address check, or the reverse, is how a transfer gets built against a contract
    // that does not exist on the chain being signed for.
    if (family === 'evm' && !isAddress(originInfo.tokenId, { strict: false })) {
      throw new Error(`token registry entry for ${draft.fromSymbol} on ${draft.chain} is not an EVM address`);
    }
    if (family === 'near' && !isNearAccountId(originInfo.tokenId)) {
      throw new Error(`token registry entry for ${draft.fromSymbol} on ${draft.chain} is not a NEAR account id`);
    }

    const list = await client.tokens();
    const originAsset = assetIdFor(draft.chain, originInfo.tokenId, list);
    const destinationAsset = assetIdFor(draft.toChain, destInfo.tokenId, list);
    if (!originAsset) throw new Error(`1click does not list ${draft.fromSymbol} on ${draft.chain}`);
    if (!destinationAsset) throw new Error(`1click does not list ${draft.toSymbol} on ${draft.toChain}`);

    return {
      originAsset,
      destinationAsset,
      originDecimals: originInfo.decimals,
      destDecimals: destInfo.decimals,
      // getAddress throws on a bad EVM checksum, which is the moment to stop. A NEAR account
      // id is already lowercase and canonical, so it passes through as itself.
      originToken: family === 'evm' ? getAddress(originInfo.tokenId) : originInfo.tokenId,
      family,
      amountBase: toBaseUnits(draft.amountIn, originInfo.decimals),
      minOutBase: toBaseUnits(draft.minAmountOut, destInfo.decimals),
    };
  }

  // Everything about a quote that has to be true before we would send money to it. Run on
  // the dry quote at simulate time and again on the live quote at execute time, because
  // the live quote is a different quote with a different price.
  function checkQuote(draft: SwapDraft, p: Plan, quote: OneClickQuote): string[] {
    const problems: string[] = [];

    const amountIn = baseUnits(quote.amountIn, 'amountIn');
    if (amountIn !== p.amountBase) {
      problems.push(
        `the quote is for ${formatUnits(amountIn, p.originDecimals)} ${draft.fromSymbol}, ` +
          `not the ${draft.amountIn} the draft names`,
      );
    }

    const minOut = baseUnits(quote.minAmountOut, 'minAmountOut');
    if (minOut < p.minOutBase) {
      problems.push(
        `the solver floor of ${formatUnits(minOut, p.destDecimals)} ${draft.toSymbol} is below the ` +
          `draft floor of ${draft.minAmountOut}`,
      );
    }

    return problems;
  }

  function priceLines(draft: SwapDraft, quote: OneClickQuote): string[] {
    const inUsd = Number(quote.amountInUsd);
    const outUsd = Number(quote.amountOutUsd);
    const feeUsd = Number.isFinite(inUsd) && Number.isFinite(outUsd) ? inUsd - outUsd : NaN;
    return [
      `oneclick: ${draft.amountIn} ${draft.fromSymbol} on ${draft.chain} -> ` +
        `${oneLine(quote.amountOutFormatted, 40)} ${draft.toSymbol} on ${draft.toChain}`,
      `fee ${Number.isFinite(feeUsd) ? '$' + feeUsd.toFixed(4) : 'unknown'}, eta ~${Number(quote.timeEstimate)}s, ` +
        `solver floor ${oneLine(quote.minAmountOut, 40)} base units, draft floor ${draft.minAmountOut} ${draft.toSymbol}`,
    ];
  }

  // The deposit address is the one field in the whole flow we cannot verify the ownership
  // of: the API picks it and no signature proves who holds it. That trust is inherent to the
  // protocol. What is checkable is the SHAPE, and the shape has to be checked against the
  // chain being signed for, because the two families are not interchangeable:
  //
  //   - An EVM origin must get a checksummed 20-byte address. getAddress throws on a
  //     mixed-case address whose checksum is wrong, which is a corrupted address caught for
  //     free before any money moves.
  //   - A NEAR origin gets an account id, and in practice a 64-character hex implicit
  //     account. Running that through viem's isAddress rejects it, correctly, which is the
  //     precise reason this rail used to refuse every NEAR swap. The fix is a NEAR check,
  //     not a weaker one: an EVM address reaching the NEAR branch is still refused here.
  function checkDepositAddress(family: 'evm' | 'near', value: string): string {
    if (family === 'evm') {
      if (!isAddress(value, { strict: false })) {
        throw new Error(`1click returned a deposit address that is not an EVM address: ${oneLine(value, 60)}`);
      }
      return getAddress(value);
    }
    if (!isNearAccountId(value)) {
      throw new Error(`1click returned a deposit address that is not a NEAR account id: ${oneLine(value, 60)}`);
    }
    // A lowercased EVM address passes the account-id rule, because NEAR genuinely allows
    // that name. Refusing the shape here is what makes "an EVM address is still refused on
    // the NEAR branch" true for every casing rather than only for the checksummed one.
    if (looksLikeEvmAddress(value)) {
      throw new Error(`1click returned an EVM address where a NEAR account id belongs: ${oneLine(value, 60)}`);
    }
    return value;
  }

  // Normalised across both signers so execute() reads the same either way.
  type Deposited = { ok: boolean; hash?: string; error?: string };

  async function depositTransfer(draft: SwapDraft, p: Plan, depositAddress: string): Promise<Deposited> {
    if (p.family === 'evm') {
      return evm.send({
        network,
        chain: draft.chain,
        keysPath,
        to: p.originToken as Address,
        data: erc20TransferData(depositAddress as Address, p.amountBase),
      });
    }

    // A NEP-141 transfer to an account with no storage deposit on that token contract
    // panics, the tokens bounce, and the transaction is still paid for. The deposit address
    // is freshly minted by the solver, so this is a live question rather than a formality.
    // Asking before signing turns a confusing on-chain failure into a sentence.
    const registered = await near.storageRegistered(network, p.originToken, depositAddress);
    if (!registered) {
      return {
        ok: false,
        error:
          `the deposit address ${depositAddress} has no storage deposit registered on ${p.originToken}, ` +
          'so an ft_transfer to it would panic and bounce. Nothing was signed.',
      };
    }

    return near.send({
      network,
      keysPath,
      receiverId: p.originToken,
      actions: [
        functionCall(
          'ft_transfer',
          { receiver_id: depositAddress, amount: p.amountBase.toString() },
          FT_TRANSFER_GAS,
          ONE_YOCTO,
        ),
      ],
    });
  }

  // ---------- the Rail surface ----------

  // Read by the policy engine's per-transaction and session budgets. A draft that cannot
  // price itself must fail every budget rather than pass them all, so a broken number
  // becomes Infinity and not NaN.
  function valueUsd(draft: SwapDraft): number {
    return Number.isFinite(draft.amountUsd) ? draft.amountUsd : Infinity;
  }

  async function simulate(draft: SwapDraft): Promise<SimulationResult> {
    try {
      const p = await plan(draft);

      // dry:true. This is the whole point of the dry path: a proposal gets priced and shown
      // in the approval gate without minting a deposit address or committing to anything.
      const response = await client.quote({
        dry: true,
        originAsset: p.originAsset,
        destinationAsset: p.destinationAsset,
        amount: p.amountBase.toString(),
        refundTo: draft.from,
        recipient: draft.to,
      });

      const lines = priceLines(draft, response.quote);
      const problems = checkQuote(draft, p, response.quote);

      if (problems.length > 0) {
        const joined = problems.join('; ');
        return { ok: false, summary: [`REFUSED: ${joined}`, ...lines].join('\n'), error: joined };
      }

      if (network !== 'mainnet') {
        // The pricing above is real and worth showing, but approving this would hand the
        // human a proposal that cannot run. Say so before they click, not after.
        return {
          ok: false,
          summary: [`CANNOT EXECUTE on ${network}: ${NO_TESTNET_REASON}`, ...lines].join('\n'),
          error: NO_TESTNET_REASON,
        };
      }

      lines.push('execution sends the input to a deposit address the solver picks; only the amounts above are guaranteed');
      return { ok: true, summary: lines.join('\n') };
    } catch (err) {
      const message = errText(err);
      return { ok: false, summary: `oneclick simulation failed: ${message}`, error: message };
    }
  }

  async function execute(draft: SwapDraft): Promise<RailResult> {
    // First line, before any network call, any key read and any quote. There is no host to
    // point at on a testnet, so there is nothing to attempt.
    if (network !== 'mainnet') throw new Error(NO_TESTNET_REASON);

    const p = await plan(draft);

    // The draft names the wallet a human approved. If the configured key is a different
    // wallet, the refund address in the quote belongs to someone else.
    const owner = p.family === 'evm' ? evm.signerAddress(keysPath) : near.accountId(keysPath);
    if (draft.from.toLowerCase() !== owner.toLowerCase()) {
      throw new Error(`draft is authored for ${draft.from} but the configured key is ${owner}`);
    }

    const response = await client.quote({
      dry: false,
      originAsset: p.originAsset,
      destinationAsset: p.destinationAsset,
      amount: p.amountBase.toString(),
      refundTo: draft.from,
      recipient: draft.to,
    });
    const quote = response.quote;

    const problems = checkQuote(draft, p, quote);
    if (problems.length > 0) throw new Error(`live quote does not match the approved draft: ${problems.join('; ')}`);

    if (typeof quote.depositMemo === 'string' && quote.depositMemo !== '') {
      throw new Error(
        'the quote requires a deposit memo, which neither an ERC-20 transfer nor a NEP-141 ' +
          'ft_transfer can carry; funds sent without it are lost',
      );
    }
    if (typeof quote.depositAddress !== 'string') {
      throw new Error(`1click returned no deposit address (got ${oneLine(quote.depositAddress, 60)})`);
    }

    const depositAddress = checkDepositAddress(p.family, quote.depositAddress);
    const sent = await depositTransfer(draft, p, depositAddress);

    if (!sent.ok) {
      // Nothing moved: the transfer either never broadcast or reverted on chain.
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
      const destination = watch.destinationTxHashes;
      return {
        ok: true,
        detail:
          `swapped ${draft.amountIn} ${draft.fromSymbol} on ${draft.chain} for ` +
          `${oneLine(quote.amountOutFormatted, 40)} ${draft.toSymbol} on ${draft.toChain}; ${evidence}` +
          (destination.length > 0 ? `, destination tx ${destination.join(', ')}` : ''),
        txids: [txHash, ...destination],
      };
    }

    if (watch.status === 'REFUNDED' || watch.status === 'FAILED') {
      return {
        ok: false,
        detail: `1click reported ${watch.reported} after the deposit landed; ${evidence}. Check the refund address ${draft.from}.`,
        txids: [txHash, ...watch.originTxHashes, ...watch.destinationTxHashes],
      };
    }

    // Timed out. The transfer confirmed, so the money is already gone from our wallet and
    // the swap is very likely still running. Saying "failed" without that sentence is how
    // someone sends the same amount twice.
    return {
      ok: false,
      detail:
        `deposit confirmed but 1click did not reach a terminal status within ${Math.round(pollTimeoutMs / 1000)}s ` +
        `(last status ${watch.reported}); ${evidence}. THE FUNDS WERE SENT and the swap may still complete: ` +
        'check the deposit address before retrying.',
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

  return { kind: 'swap', valueUsd, simulate, execute };
}
