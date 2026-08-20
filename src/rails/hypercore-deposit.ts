// The Hyperliquid funding rail: put collateral into a perps account from any chain NEAR
// Intents can reach.
//
// This replaces a bespoke bridge. The old rail held USDC on Arbitrum and made a plain ERC-20
// transfer to Hyperliquid's Bridge2 contract, which credits whoever sent the tokens. That
// worked and it cost the user a precondition: the money had to already be USDC, already on
// Arbitrum. Everything else was their problem.
//
// 1Click now lists `hypercore` as a destination, so the precondition is gone. One quote, one
// signature on whatever chain the money already sits on, and the collateral lands. Checked
// live on 2026-08-20: arb USDC in, 50.0 -> 49.6347 out, about 35 seconds. NEAR USDC the same.
//
// Three things about this rail are different from every other one here, and each is a refusal
// rather than a feature:
//
//   1. THE RAIL IS ONE WAY. 1Click refuses `hypercore` as an ORIGIN: a quote out of it returns
//      400 "Hypercore deposits not supported yet". Money leaves a Hyperliquid account through
//      the venue's own signed withdraw3 and nothing else. That is a property worth stating
//      plainly rather than hiding, because it is also a SAFETY property: this rail can fund
//      the trading account and structurally cannot drain it, which is the same argument the
//      API wallet's signing split makes, arriving from the other side.
//
//   2. THE FEE IS ALMOST FLAT, so the percentage depends entirely on size. Measured across
//      five live dry quotes on 2026-08-20:
//
//        in     out        fee
//        2      1.6827     0.3173
//        5      4.6797     0.3203
//        10     9.6747     0.3253
//        50     49.6347    0.3653
//        100    99.5847    0.4153
//
//      That fits fee = about $0.315 flat plus 10 bp. On $1000 it is 13 bp, which is good. On
//      $2 it is 16 percent, which is a trap that no percentage-shaped slippage check would
//      ever catch, because the venue is not slipping: it is charging a fixed cost against a
//      tiny amount. So this rail states the EFFECTIVE rate in the approval summary and refuses
//      below a floor, and both exist because of that table.
//
//   3. THE COLLATERAL MAY LAND ON THE WRONG SIDE OF THE ACCOUNT. Hyperliquid keeps spot and
//      perp as separate books, and a deposit is not useful as margin until it is on the perp
//      side. Rather than assume which one 1Click credits, this rail finishes by LOOKING, and
//      moves the balance itself if it has to. See settleToPerp() at the bottom: the rail is
//      not done when the money arrives, it is done when the money is spendable as margin.
//
// One consequence of point 3 worth stating plainly, because it is easy to miss: this rail
// signs under TWO different schemes. The deposit is an ordinary ERC-20 transfer or NEP-141
// ft_transfer, and the settle step is an EIP-712 usdClassTransfer, which is the same
// user-signed family as withdraw3. Both use the key at keysPath, so this is not new authority,
// but a reader should know that a module called "deposit" produces a user-signed action. The
// parameters are the narrow part: toPerp is always true and the amount comes from a balance
// this rail just observed, so the worst it can do is move our own money between our own books.

import { getAddress, isAddress } from 'viem';
import type { Address } from 'viem';
import { erc20Balance, erc20TransferData, evmAddress, reader, sendTx } from '../chain/evm.ts';
import type { SendOutcome, SendParams } from '../chain/evm.ts';
import {
  TGAS,
  functionCall,
  ftStorageRegistered,
  isNearAccountId,
  looksLikeEvmAddress,
  nearAccountId,
  sendTx as nearSendTx,
} from '../chain/near.ts';
import type { NearSendOutcome, NearSendParams } from '../chain/near.ts';
import type { ChainId, HlDepositDraft, Network, Rail, RailResult, SimulationResult } from '../types.ts';
import { ONECLICK_TERMINAL, assetIdFor, oneClickClient, oneLine, toBaseUnits } from '../intents.ts';
import type { OneClickClient, OneClickQuote, OneClickStatus, TokensFile } from '../intents.ts';
import { ONECLICK_COUNTERPARTY } from './oneclick.ts';
import { usdClassTransfer } from './hyperliquid-withdraw.ts';

// NEP-141 transfer costs, same numbers the swap rail uses: 30 TGas is the documented ceiling
// for ft_transfer, and the one yoctoNEAR is the full-access-key assertion the standard requires.
const FT_TRANSFER_GAS = 30n * TGAS;
const ONE_YOCTO = 1n;

// ---------- the destination ----------

// PINNED, not looked up. Every other asset in this app resolves through data/tokens.json and
// the 1Click list, and this one cannot: its id is `1cs_v1:...` rather than the `nep141:...`
// shape the omni-bridge registry holds, so assetIdFor() will never find it.
//
// Same rule the Polygon decision settled on 2026-08-20: a table in this repo decides where
// money goes and remote text never does. plan() verifies this id is still in the live list on
// every quote, off the fetch it already makes, and assertAssetLive() below is the same check
// on its own for scripts/hypercore-probe.ts. Neither one ever takes a replacement from the API:
// a hostile token list can stop this rail, and it cannot redirect it.
export const HYPERCORE_USDC_ASSET_ID = '1cs_v1:hypercore:erc20:0xb88339CB7199b77E23DB6E890353E22632Ba630f';
export const HYPERCORE_USDC_DECIMALS = 6;

// The remote service is the same one the swap rail uses, so it is the same allowlist entry.
// A second string for the same host would mean a human could allow one and refuse the other
// while believing they had made one decision.
export const HYPERCORE_COUNTERPARTY = ONECLICK_COUNTERPARTY;

// Below this the flat fee stops being a fee and starts being most of the deposit. 1Click's own
// floor is lower (1 USDC is refused, 2 quotes), and the old Bridge2 rail used 5 for a different
// reason: below 5 the venue did not credit at all and the docs said the funds were lost. The
// number is kept at 5 so the two eras agree, but the reason has changed and the refusal says
// the new one, because a user reading "the venue will eat it" and a user reading "you will pay
// 6 percent" make different decisions.
export const MIN_DEPOSIT_USDC = 5;

// What a deposit is allowed to cost before this rail stops calling it a deposit. 5 percent on
// the floor amount is about right: it lets a $10 test through with a loud number attached and
// refuses the sizes where the user would be paying mostly for the privilege.
export const MAX_FEE_PCT = 5;

// The loss floor a draft carries, and it has to be shaped like the fee or it refuses honest
// quotes.
//
// The Intents deposit rail uses a flat 200 bps of the amount, which is right for a fee that is
// proportional. This one is not: it is about $0.315 plus 10 bp, so the percentage runs away as
// the amount shrinks. Reusing the 200 bps rule here quietly refused every deposit between about
// $6.50 and $17, because on $10 it demanded 9.80 credited and the venue delivers 9.67, and the
// refusal blamed the floor instead of naming the flat fee. That is the same bug this repo keeps
// paying for: the value checked was not the value used.
//
// So the floor is the measured fee with headroom on both terms, roughly doubled on the bp side
// and rounded up on the flat side. It still caps the loss, and it caps it against the shape the
// fee actually has.
export const HYPERCORE_FLAT_FEE_USDC = 0.35; // measured 0.315
export const HYPERCORE_FEE_BPS = 20; // measured about 10

export function minCreditedFor(amount: number): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return amount - (HYPERCORE_FLAT_FEE_USDC + (amount * HYPERCORE_FEE_BPS) / 10_000);
}

// ---------- the seams ----------

// Same shape as the swap rail's ports, and for the same reason: the refusal tests present a
// short wallet or an unregistered deposit address without an RPC anywhere near them.
export type HypercoreEvmPort = {
  signerAddress(keysPath: string): Address;
  send(params: SendParams): Promise<SendOutcome>;
  // Read before we quote. The rail this replaced checked both and refused up front, and
  // dropping that check was a regression: without it a short wallet gets a live quote, a minted
  // deposit address and a reverted transfer, and the reason arrives from the chain instead of
  // from a sentence. No money is lost either way; what is lost is the explanation.
  erc20Balance(network: Network, chain: ChainId, token: Address, owner: Address): Promise<bigint>;
  nativeBalance(network: Network, chain: ChainId, owner: Address): Promise<bigint>;
};

export type HypercoreNearPort = {
  accountId(keysPath: string): string;
  storageRegistered(network: Network, token: string, account: string): Promise<boolean>;
  send(params: NearSendParams): Promise<NearSendOutcome>;
};

export const liveEvmPort: HypercoreEvmPort = {
  signerAddress: evmAddress,
  send: sendTx,
  erc20Balance,
  nativeBalance: (network, chain, owner) => reader(network, chain).getBalance({ address: owner }),
};
export const liveNearPort: HypercoreNearPort = {
  accountId: nearAccountId,
  storageRegistered: ftStorageRegistered,
  send: nearSendTx,
};

// Which signer authors the origin transfer. Solana is absent because the signer is, which is
// the same honest gap the swap rail carries.
function originFamily(chain: ChainId): 'evm' | 'near' | null {
  if (chain === 'eth' || chain === 'base' || chain === 'arb') return 'evm';
  if (chain === 'near') return 'near';
  return null;
}

// ---------- account state ----------

export type HlSpotBalance = { coin: string; token: number; total: number; hold: number };

export type HlAccountState = {
  address: string;
  network: Network;
  accountValueUsd: number; // the perp side: this is what margin is drawn from
  withdrawableUsd: number;
  marginUsedUsd: number;
  openPositions: number;
  spot: HlSpotBalance[]; // a SEPARATE book from the perp balance above
  funded: boolean;
  fetchedAt: string;
};

type ClearinghouseState = {
  marginSummary?: { accountValue?: string; totalMarginUsed?: string };
  withdrawable?: string;
  assetPositions?: unknown[];
};

type SpotClearinghouseState = {
  balances?: Array<{ coin?: string; token?: number; total?: string; hold?: string }>;
};

// Every number in these responses is a string, and a malformed one must read as zero rather
// than NaN: NaN silently poisons every comparison downstream.
function num(value: string | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sameAddress(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

const INFO_URL: Record<Network, string> = {
  testnet: 'https://api.hyperliquid-testnet.xyz/info',
  mainnet: 'https://api.hyperliquid.xyz/info',
};

// ---------- the rail ----------

export type HypercoreDepositDeps = {
  network: Network; // the TRADING network: which Hyperliquid the collateral lands on
  keysPath: string;
  tokens: TokensFile;
  client?: OneClickClient;
  evm?: HypercoreEvmPort;
  near?: HypercoreNearPort;
  fetchImpl?: typeof fetch;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export type HypercoreDepositRail = Rail<HlDepositDraft> & {
  accountState(address: string): Promise<HlAccountState>;
  assertAssetLive(): Promise<void>;
};

type Plan = {
  family: 'evm' | 'near';
  originAsset: string;
  originToken: string;
  decimals: number;
  native: boolean;
  amountBase: bigint;
};

export function hypercoreDepositRail(deps: HypercoreDepositDeps): HypercoreDepositRail {
  const { network, keysPath, tokens } = deps;
  const client = deps.client ?? oneClickClient({ fetchImpl: deps.fetchImpl });
  const evm = deps.evm ?? liveEvmPort;
  const near = deps.near ?? liveNearPort;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const pollIntervalMs = deps.pollIntervalMs ?? 3000;
  const pollTimeoutMs = deps.pollTimeoutMs ?? 180_000;
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  // Confirms the pinned asset id is still in the live list. Called at boot. It reports and it
  // never repairs: taking a replacement id from the API is exactly the thing the pin exists to
  // prevent, because an attacker who can change that list could then choose where money goes.
  async function assertAssetLive(): Promise<void> {
    const list = await client.tokens();
    const hit = list.find((t) => t.assetId === HYPERCORE_USDC_ASSET_ID);
    if (hit === undefined) {
      const hypercore = list.filter((t) => t.blockchain.toLowerCase() === 'hypercore').map((t) => t.assetId);
      throw new Error(
        `the pinned HyperCore USDC asset id is no longer in the 1Click token list. ` +
          `Pinned: ${HYPERCORE_USDC_ASSET_ID}. Live hypercore assets: ${hypercore.length > 0 ? hypercore.join(', ') : 'none'}. ` +
          `This rail will not take a replacement id from the API; update the constant deliberately.`,
      );
    }
    if (hit.decimals !== HYPERCORE_USDC_DECIMALS) {
      throw new Error(
        `HyperCore USDC decimals changed: pinned ${HYPERCORE_USDC_DECIMALS}, live ${hit.decimals}. ` +
          `Every amount this rail sends would be wrong by a factor of ten.`,
      );
    }
  }

  function refusal(draft: HlDepositDraft, reasons: string[], lines: string[] = []): SimulationResult {
    const joined = reasons.join('; ');
    return {
      ok: false,
      summary: [`REFUSED: fund Hyperliquid ${network} with ${draft.amount} ${draft.symbol} - ${joined}`, ...lines].join('\n'),
      error: joined,
    };
  }

  // Everything decidable BEFORE a quote. The order matters: the checks that need no network at
  // all run first, so a bad account or an unsigned chain never becomes a question asked of a
  // remote API about the wrong asset.
  async function plan(draft: HlDepositDraft): Promise<{ plan?: Plan; reasons: string[] }> {
    const reasons: string[] = [];

    // THE FIRST CHECK, and the one that stops the worst outcome this rail can produce.
    //
    // 1Click has no testnet and the asset pinned above is MAINNET HyperCore USDC. The recipient
    // is an EVM address, and the same address names an account on BOTH Hyperliquid networks. So
    // a deposit raised while this app is trading testnet would take real money, deliver it
    // correctly to the MAINNET trading account, and report success, while the testnet account
    // the app is actually trading stayed empty. Nothing reverts. Nothing looks wrong.
    //
    // It is not recoverable by this rail either: getting it back is a signed withdraw3 against
    // mainnet, which is not the network the app is configured for.
    if (network !== 'mainnet') {
      return {
        reasons: [
          `funding routes through NEAR Intents, which has no testnet, and the asset it delivers is ` +
            `MAINNET HyperCore USDC. This app is trading ${network}, and one address names an account ` +
            `on both networks, so this deposit would put real money into the mainnet trading account ` +
            `while the ${network} one stayed empty. Use the venue faucet for ${network} ` +
            `(https://app.hyperliquid-testnet.xyz/drip), or set tradingNetwork to mainnet`,
        ],
      };
    }

    const family = originFamily(draft.chain);
    if (family === null) {
      return {
        reasons: [
          `this app cannot sign on ${draft.chain}. Funding can start from eth, base, arb or near; ` +
            `1Click reaches more chains than that, but a chain with no signer here is a chain we cannot send from`,
        ],
      };
    }

    if (draft.counterparty !== HYPERCORE_COUNTERPARTY) {
      reasons.push(`draft counterparty ${oneLine(draft.counterparty, 60)} is not ${HYPERCORE_COUNTERPARTY}`);
    }

    // The account being credited must be one we hold the key for, or the deposit funds a
    // stranger's trading account and nothing about it is recoverable.
    if (!isAddress(draft.hlAccount.trim())) {
      reasons.push(`hlAccount ${oneLine(draft.hlAccount, 60)} is not an EVM address, and HyperCore credits an EVM account`);
    }

    if (draft.amount < MIN_DEPOSIT_USDC) {
      reasons.push(
        `${draft.amount} is below the ${MIN_DEPOSIT_USDC} minimum. The routing fee is close to flat, about ` +
          `$0.32 plus 10 bp, so a deposit this small pays most of itself away rather than landing`,
      );
    }

    // 1Click has no testnet, so a NEAR origin is always a MAINNET NEAR account. A `.testnet`
    // account here is a config mistake, and without this check it leaves as a well-formed quote
    // request and comes back as a bare "Internal server error" from the API: a refusal whose
    // stated reason has nothing to do with the real cause, which is the shape of the bug this
    // repo has paid for more than once.
    if (family === 'near' && /\.testnet$/i.test(draft.from.trim())) {
      reasons.push(
        `${draft.from} is a NEAR testnet account and 1Click is mainnet only, so this quote would be refused ` +
          `by the API with an error that does not say so. Configure a mainnet NEAR account, or fund from an EVM chain`,
      );
    }

    const registry = tokens[draft.chain]?.[draft.symbol];
    if (registry === undefined) {
      reasons.push(`no token registry entry for ${draft.symbol} on ${draft.chain}`);
    } else {
      // Each family validates the token id its own way. Letting a NEAR account id through an
      // EVM address check, or the reverse, builds a transfer against a contract that does not
      // exist on the chain being signed for.
      if (family === 'evm' && !isAddress(registry.tokenId, { strict: false })) {
        reasons.push(`token registry entry for ${draft.symbol} on ${draft.chain} is not an EVM address`);
      }
      if (family === 'near' && !isNearAccountId(registry.tokenId)) {
        reasons.push(`token registry entry for ${draft.symbol} on ${draft.chain} is not a NEAR account id`);
      }
    }

    if (reasons.length > 0 || registry === undefined) return { reasons };

    let amountBase = 0n;
    try {
      amountBase = toBaseUnits(draft.amount, registry.decimals);
    } catch (err) {
      return { reasons: [errText(err)] };
    }

    // The ORIGIN asset id comes from the live list, exactly as the swap rail resolves it. Only
    // the DESTINATION is pinned, because only the destination is the thing an attacker who
    // could edit that list would want to move.
    let originAsset: string | null = null;
    try {
      const list = await client.tokens();

      // The pin is verified HERE, against the list this call already had to fetch, rather than
      // at boot. It was written as a boot check and nothing called it, which made the comment
      // above a claim about a check that never ran: the exact defect shape this repo keeps
      // paying for. Doing it on the path that fetches the list anyway costs no round trip and
      // cannot be forgotten, because a quote is impossible without it.
      const pinned = list.find((t) => t.assetId === HYPERCORE_USDC_ASSET_ID);
      if (pinned === undefined) {
        const hypercore = list.filter((t) => t.blockchain.toLowerCase() === 'hypercore').map((t) => t.assetId);
        return {
          reasons: [
            `the pinned HyperCore USDC asset id is no longer in the 1Click token list. Pinned: ` +
              `${HYPERCORE_USDC_ASSET_ID}. Live hypercore assets: ${hypercore.length > 0 ? hypercore.join(', ') : 'none'}. ` +
              `This rail will not take a replacement id from the API; update the constant deliberately`,
          ],
        };
      }
      if (pinned.decimals !== HYPERCORE_USDC_DECIMALS) {
        return {
          reasons: [
            `HyperCore USDC decimals changed: pinned ${HYPERCORE_USDC_DECIMALS}, live ${pinned.decimals}. ` +
              `Every amount this rail sends would be wrong by a factor of ten`,
          ],
        };
      }

      originAsset = assetIdFor(draft.chain, registry.tokenId, list);
    } catch (err) {
      return { reasons: [`could not read the 1Click token list: ${errText(err)}`] };
    }
    if (originAsset === null) {
      return { reasons: [`1click does not list ${draft.symbol} on ${draft.chain}`] };
    }

    return {
      plan: {
        family,
        originAsset,
        originToken: family === 'evm' ? getAddress(registry.tokenId) : registry.tokenId,
        decimals: registry.decimals,
        native: false,
        amountBase,
      },
      reasons: [],
    };
  }

  // What the human reads before clicking. The effective rate is computed rather than quoted,
  // because the number that matters is not the fee, it is the fee against THIS amount.
  function priceLines(draft: HlDepositDraft, quote: OneClickQuote): { lines: string[]; feePct: number } {
    const out = Number(quote.amountOutFormatted);
    const feeUsd = Number.isFinite(out) ? draft.amount - out : NaN;
    const feePct = Number.isFinite(feeUsd) ? (feeUsd / draft.amount) * 100 : NaN;
    return {
      feePct,
      lines: [
        `Fund Hyperliquid ${network} perps from ${draft.chain}.`,
        `  send      ${draft.amount} ${draft.symbol} on ${draft.chain}`,
        `  credited  ${oneLine(quote.amountOutFormatted, 40)} USDC to ${draft.hlAccount}`,
        `  cost      ${Number.isFinite(feeUsd) ? `${feeUsd.toFixed(4)} USDC, ${feePct.toFixed(2)} percent of the deposit` : 'unknown'}`,
        `  arrives   about ${quote.timeEstimate ?? '?'}s`,
        `  one way   money leaves a Hyperliquid account only through a signed withdraw3, never back down this rail`,
      ],
    };
  }

  function checkQuote(draft: HlDepositDraft, quote: OneClickQuote, feePct: number): string[] {
    const problems: string[] = [];

    const out = Number(quote.amountOutFormatted);
    if (!Number.isFinite(out) || out <= 0) {
      problems.push(`1click returned an unusable output amount (${oneLine(quote.amountOutFormatted, 40)})`);
      return problems;
    }

    if (out < draft.minCredited) {
      problems.push(`the quote credits ${out} USDC and the approved draft required at least ${draft.minCredited}`);
    }

    if (Number.isFinite(feePct) && feePct > MAX_FEE_PCT) {
      problems.push(
        `the routing cost is ${feePct.toFixed(2)} percent of the deposit, above the ${MAX_FEE_PCT} percent ceiling. ` +
          `The fee is close to flat, so depositing more at once costs the same in dollars and far less as a share`,
      );
    }

    // Echoed back by the server; a mismatch means the quote priced something other than the
    // draft a human read.
    if (quote.amountInFormatted !== undefined && Number(quote.amountInFormatted) !== draft.amount) {
      problems.push(`the quote prices ${oneLine(quote.amountInFormatted, 40)} in, but the draft says ${draft.amount}`);
    }

    return problems;
  }

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
    if (looksLikeEvmAddress(value)) {
      throw new Error(`1click returned an EVM address where a NEAR account id belongs: ${oneLine(value, 60)}`);
    }
    return value;
  }

  type Deposited = { ok: boolean; hash?: string; error?: string };

  async function depositTransfer(draft: HlDepositDraft, p: Plan, depositAddress: string): Promise<Deposited> {
    if (p.family === 'evm') {
      return evm.send({
        network,
        chain: draft.chain,
        keysPath,
        to: p.originToken as Address,
        data: erc20TransferData(depositAddress as Address, p.amountBase),
      });
    }

    // A NEP-141 transfer to an account with no storage deposit on that token contract panics,
    // the tokens bounce, and the transaction is still paid for. The deposit address is freshly
    // minted, so this is a live question rather than a formality.
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
        functionCall('ft_transfer', { receiver_id: depositAddress, amount: p.amountBase.toString() }, FT_TRANSFER_GAS, ONE_YOCTO),
      ],
    });
  }

  async function info<T>(body: Record<string, unknown>): Promise<T> {
    const res = await fetchImpl(INFO_URL[network], {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`hyperliquid ${String(body.type)} failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }

  async function accountState(address: string): Promise<HlAccountState> {
    if (!isAddress(address.trim())) throw new Error(`hyperliquid accountState: ${address} is not an address`);
    const user = address.trim();

    const [perp, spotState] = await Promise.all([
      info<ClearinghouseState>({ type: 'clearinghouseState', user, dex: '' }),
      info<SpotClearinghouseState>({ type: 'spotClearinghouseState', user }),
    ]);

    const spot: HlSpotBalance[] = (spotState.balances ?? []).map((b) => ({
      coin: b.coin ?? '',
      token: b.token ?? -1,
      total: num(b.total),
      hold: num(b.hold),
    }));

    const accountValueUsd = num(perp.marginSummary?.accountValue);
    return {
      address: user,
      network,
      accountValueUsd,
      withdrawableUsd: num(perp.withdrawable),
      marginUsedUsd: num(perp.marginSummary?.totalMarginUsed),
      openPositions: Array.isArray(perp.assetPositions) ? perp.assetPositions.length : 0,
      spot,
      funded: accountValueUsd > 0 || spot.some((b) => b.total > 0),
      fetchedAt: new Date().toISOString(),
    };
  }

  // The last step, and the one that makes this rail's promise true.
  //
  // "The money arrived" and "the money is usable as margin" are different claims on
  // Hyperliquid, because spot and perp are separate books. Rather than assume which side a
  // HyperCore delivery credits, this looks, and moves it if it has to. On an account where the
  // delivery already lands on the perp side this does nothing at all and says so.
  //
  // A failure here is NOT a failed deposit. The money is on the account either way, so the
  // sentence has to separate the two or someone reads "failed" and sends again.
  async function settleToPerp(draft: HlDepositDraft, before: HlAccountState): Promise<string> {
    let after: HlAccountState;
    try {
      after = await accountState(draft.hlAccount);
    } catch (err) {
      return ` Could not read the account afterwards (${oneLine(errText(err), 80)}); the deposit itself completed.`;
    }

    const perpGain = after.accountValueUsd - before.accountValueUsd;
    const spotOf = (s: HlAccountState): number => s.spot.find((b) => b.coin === 'USDC')?.total ?? 0;
    const spotGain = spotOf(after) - spotOf(before);

    if (perpGain > 0.01) {
      return ` Credited to the perp side directly; ${perpGain.toFixed(4)} USDC is margin now.`;
    }

    if (spotGain <= 0.01) {
      // Neither book moved. The 1Click status said SUCCESS, so this is a timing gap far more
      // often than a loss, and the sentence must not claim otherwise.
      return ' The venue has not shown the credit yet. 1Click reported SUCCESS, so check the account in a minute rather than sending again.';
    }

    try {
      const moved = await usdClassTransfer({ network, keysPath }, { amount: spotGain, toPerp: true });
      return moved.ok
        ? ` Landed on the spot side and was moved to perp: ${spotGain.toFixed(4)} USDC is margin now.`
        : ` Landed on the SPOT side and the move to perp failed: ${oneLine(moved.detail, 120)}. ` +
            `The money is on the account and is not margin yet; run npm run hl-withdraw -- --to-perp ${spotGain}.`;
    } catch (err) {
      return (
        ` Landed on the SPOT side and the move to perp threw: ${oneLine(errText(err), 120)}. ` +
        `The money is on the account and is not margin yet.`
      );
    }
  }

  function valueUsd(draft: HlDepositDraft): number {
    // USDC is a dollar stable so the two agree in practice. Taking the larger is the
    // pessimistic read: a draft that under-reports its value must not slip under a budget.
    const a = Number.isFinite(draft.amountUsd) ? draft.amountUsd : Infinity;
    const b = Number.isFinite(draft.amount) ? draft.amount : Infinity;
    return Math.max(a, b);
  }

  async function simulate(draft: HlDepositDraft): Promise<SimulationResult> {
    const planned = await plan(draft);
    if (planned.plan === undefined) return refusal(draft, planned.reasons);
    const p = planned.plan;

    // The wallet a human approved must be the wallet this app signs with, or the refund
    // address on the quote belongs to somebody else.
    try {
      const owner = p.family === 'evm' ? evm.signerAddress(keysPath) : near.accountId(keysPath);
      if (!sameAddress(draft.from, owner)) {
        return refusal(draft, [`draft funds from ${draft.from} but this app signs with ${owner}`]);
      }
    } catch (err) {
      return refusal(draft, [`cannot resolve the signing wallet: ${errText(err)}`]);
    }

    // Can this wallet actually send it. Checked BEFORE the quote, because a quote that prices a
    // transfer the wallet cannot make is a number that reads as a plan.
    if (p.family === 'evm') {
      try {
        const [held, gas] = await Promise.all([
          evm.erc20Balance(network, draft.chain, p.originToken as Address, draft.from as Address),
          evm.nativeBalance(network, draft.chain, draft.from as Address),
        ]);
        const shortfall: string[] = [];
        if (held < p.amountBase) {
          const have = Number(held) / 10 ** p.decimals;
          shortfall.push(`wallet holds ${have} ${draft.symbol} on ${draft.chain} and the deposit needs ${draft.amount}`);
        }
        if (gas === 0n) {
          shortfall.push(`wallet holds no native gas on ${draft.chain} and cannot pay for the transfer`);
        }
        if (shortfall.length > 0) return refusal(draft, shortfall);
      } catch (err) {
        // A chain we cannot read is a chain we may not send on.
        return refusal(draft, [`could not read the ${draft.chain} wallet: ${errText(err)}`]);
      }
    }

    try {
      // dry:true, always. A simulation must never mint a deposit address.
      const response = await client.quote({
        dry: true,
        originAsset: p.originAsset,
        destinationAsset: HYPERCORE_USDC_ASSET_ID,
        amount: p.amountBase.toString(),
        refundTo: draft.from,
        recipient: draft.hlAccount,
        recipientType: 'DESTINATION_CHAIN',
        refundType: 'ORIGIN_CHAIN',
        depositType: 'ORIGIN_CHAIN',
      });

      const priced = priceLines(draft, response.quote);
      const problems = checkQuote(draft, response.quote, priced.feePct);
      if (problems.length > 0) return refusal(draft, problems, priced.lines);

      priced.lines.push('execution sends the input to a deposit address the solver picks; only the amounts above are guaranteed');
      return { ok: true, summary: priced.lines.join('\n') };
    } catch (err) {
      const message = errText(err);
      return { ok: false, summary: `hypercore funding simulation failed: ${message}`, error: message };
    }
  }

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

  async function execute(draft: HlDepositDraft): Promise<RailResult> {
    // Re-plan and re-price rather than trust the approval. An approval can be minutes old and
    // a quote is a live price, so the checks that refused a bad draft have to run again here.
    const check = await simulate(draft);
    if (!check.ok) return { ok: false, detail: check.error ?? check.summary };

    const planned = await plan(draft);
    if (planned.plan === undefined) return { ok: false, detail: planned.reasons.join('; ') };
    const p = planned.plan;

    // Read the account BEFORE anything moves, so the settle step afterwards is a comparison
    // rather than a guess about which balance was already there.
    let before: HlAccountState;
    try {
      before = await accountState(draft.hlAccount);
    } catch (err) {
      return { ok: false, detail: `could not read the Hyperliquid account before funding it: ${errText(err)}. Nothing was sent.` };
    }

    const response = await client.quote({
      dry: false,
      originAsset: p.originAsset,
      destinationAsset: HYPERCORE_USDC_ASSET_ID,
      amount: p.amountBase.toString(),
      refundTo: draft.from,
      recipient: draft.hlAccount,
      recipientType: 'DESTINATION_CHAIN',
      refundType: 'ORIGIN_CHAIN',
      depositType: 'ORIGIN_CHAIN',
    });
    const quote = response.quote;

    const priced = priceLines(draft, quote);
    const problems = checkQuote(draft, quote, priced.feePct);
    if (problems.length > 0) {
      return { ok: false, detail: `live quote does not match the approved draft: ${problems.join('; ')}. Nothing was sent.` };
    }

    if (typeof quote.depositMemo === 'string' && quote.depositMemo !== '') {
      return {
        ok: false,
        detail:
          'the quote requires a deposit memo, which neither an ERC-20 transfer nor an ft_transfer can carry; ' +
          'funds sent without it are lost. Nothing was sent.',
      };
    }
    if (typeof quote.depositAddress !== 'string') {
      return { ok: false, detail: `1click returned no deposit address (got ${oneLine(quote.depositAddress, 60)}). Nothing was sent.` };
    }

    const depositAddress = checkDepositAddress(p.family, quote.depositAddress);
    const sent = await depositTransfer(draft, p, depositAddress);

    if (!sent.ok) {
      const where = sent.hash !== undefined ? ` (tx ${sent.hash})` : '';
      return {
        ok: false,
        detail: `funding transfer failed${where}: ${oneLine(sent.error ?? 'unknown error')}. No funds left the wallet.`,
        txids: sent.hash !== undefined ? [sent.hash] : [],
      };
    }

    const txHash = sent.hash ?? '(no hash)';
    const evidence = `deposit ${depositAddress}, origin tx ${txHash}`;

    // Best effort: the solver finds the deposit on its own, this only saves a few seconds.
    await client.submitDeposit(depositAddress, txHash);

    const watch = await watchStatus(depositAddress);

    if (watch.status === 'SUCCESS') {
      const settled = await settleToPerp(draft, before);
      return {
        ok: true,
        detail:
          `funded Hyperliquid ${network} with ${oneLine(quote.amountOutFormatted, 40)} USDC ` +
          `from ${draft.amount} ${draft.symbol} on ${draft.chain}; ${evidence}.${settled}`,
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

    // Timed out. The transfer confirmed, so the money has already left the wallet and the
    // routing is very likely still running. Saying "failed" without that sentence is how
    // someone sends the same amount twice.
    return {
      ok: false,
      detail:
        `transfer confirmed but 1click did not reach a terminal status within ${Math.round(pollTimeoutMs / 1000)}s ` +
        `(last status ${watch.reported}); ${evidence}. THE FUNDS WERE SENT and the routing may still complete: ` +
        'check the deposit address before retrying.',
      txids: [txHash, ...watch.originTxHashes],
    };
  }

  return { kind: 'hl_deposit', valueUsd, simulate, execute, accountState, assertAssetLive };
}
