// The Uniswap v3 rail: same-chain swaps, liquidity in, liquidity out, and reading back
// whatever pool positions a wallet already holds.
//
// Three rules this module keeps to:
//   1. It never signs. Calldata is built here and handed to chain/evm.ts, which is the
//      only module in the app holding a private key.
//   2. simulate() touches nothing but eth_call. The quoter is a real on-chain quote, not
//      a guess derived from the pool price, so the number in the approval gate is the
//      number the swap would actually get.
//   3. Amounts cross into base units through string decimals, never through
//      Math.round(amount * 10 ** decimals). At 18 decimals that product is a thousand
//      times past Number.MAX_SAFE_INTEGER and the low digits are rounding noise.
//
// The pool maths (TickMath, LiquidityAmounts) is ported from the v3 libraries in BigInt.
// It is checked in tests/unit/uniswap.test.ts three ways: against sqrt(1.0001^t)*2^96 as
// a float oracle across the whole tick range, against the MIN/MAX boundary constants, and
// against live pools, where slot0's own tick must bracket its own sqrtPriceX96.

import { encodeFunctionData, formatUnits, getAddress, parseUnits } from 'viem';
import type { Address, Hex } from 'viem';
import type {
  AppConfig,
  ChainId,
  LpAddDraft,
  LpPosition,
  LpRemoveDraft,
  Network,
  Rail,
  RailResult,
  SimulationResult,
  SwapDraft,
} from '../types.ts';
import { ERC20, ensureAllowance, erc20Allowance, erc20Balance, evmAddress, reader, sendTx } from '../chain/evm.ts';
import {
  FACTORY_ABI,
  FEED_ABI,
  FEE_TIERS,
  NPM_ABI,
  POOL_ABI,
  QUOTER_ABI,
  ROUTER_ABI,
  chainsWithDeployment,
  deploymentFor,
  tickSpacingFor,
  tokenFor,
} from './uniswap-abi.ts';
import type { TokenInfo } from './uniswap-abi.ts';

export const VENUE = 'uniswap-v3';

const MIN_TICK = -887272;
const MAX_TICK = 887272;
const Q96 = 1n << 96n;
const MAX_UINT128 = (1n << 128n) - 1n;
const MAX_UINT256 = (1n << 256n) - 1n;

// Slippage floor on the LP side only. A swap carries its own floor in the draft
// (minAmountOut), which is the caller's number and is never widened here.
const LP_SLIPPAGE_BPS = 100n; // 1%
const DEADLINE_SEC = 20 * 60;

// ---------- units ----------

// A number as plain decimal digits. String(x) already gives the shortest decimal that
// reads back as this exact double, which is precisely the digits that carry information;
// the only thing it does that parseUnits cannot read is exponential notation, below 1e-6
// and at 1e21 and above. This expands those.
export function decimalString(amount: number): string {
  const s = String(amount);
  if (!/e/i.test(s)) return s;
  const parts = s.split(/e/i);
  const exp = Number(parts[1]);
  const negative = parts[0].startsWith('-');
  const bare = negative ? parts[0].slice(1) : parts[0];
  const split = bare.split('.');
  const digits = split[0] + (split[1] ?? '');
  const point = split[0].length + exp;
  let out: string;
  if (point <= 0) out = `0.${'0'.repeat(-point)}${digits}`;
  else if (point >= digits.length) out = digits + '0'.repeat(point - digits.length);
  else out = `${digits.slice(0, point)}.${digits.slice(point)}`;
  return negative ? `-${out}` : out;
}

// Base units from a UI-unit number, through decimal digits rather than arithmetic.
// Math.round(amount * 10 ** decimals) is the trap: at 18 decimals that product is far past
// Number.MAX_SAFE_INTEGER, so 12345.678 comes out as 12345678000000000327680 base units,
// 327680 of which the user never typed.
export function toBaseUnits(amount: number, decimals: number): bigint {
  if (!Number.isFinite(amount)) throw new Error(`amount is not a finite number: ${amount}`);
  if (amount < 0) throw new Error(`amount is negative: ${amount}`);
  const units = parseUnits(decimalString(amount), decimals);
  // Below the token's own resolution. Sending this would be a zero-value transaction
  // dressed up as a real one, which is worse than refusing it.
  if (units === 0n && amount > 0) throw new Error(`${amount} is smaller than one base unit at ${decimals} decimals`);
  return units;
}

export function fromBaseUnits(amount: bigint, decimals: number): number {
  return Number(formatUnits(amount, decimals));
}

function addr(value: string, label: string): Address {
  try {
    return getAddress(value);
  } catch {
    throw new Error(`${label} is not a valid address: ${value}`);
  }
}

function deadline(): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SEC);
}

function fmt(amount: bigint, decimals: number, symbol: string): string {
  const units = fromBaseUnits(amount, decimals);
  return `${units.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${symbol}`;
}

// ---------- TickMath ----------

// 1.0001^(2^i) in Q128.128, one constant per bit of |tick|. Verified: see the header.
const TICK_RATIOS: bigint[] = [
  0xfffcb933bd6fad37aa2d162d1a594001n,
  0xfff97272373d413259a46990580e213an,
  0xfff2e50f5f656932ef12357cf3c7fdccn,
  0xffe5caca7e10e4e61c3624eaa0941cd0n,
  0xffcb9843d60f6159c9db58835c926644n,
  0xff973b41fa98c081472e6896dfb254c0n,
  0xff2ea16466c96a3843ec78b326b52861n,
  0xfe5dee046a99a2a811c461f1969c3053n,
  0xfcbe86c7900a88aedcffc83b479aa3a4n,
  0xf987a7253ac413176f2b074cf7815e54n,
  0xf3392b0822b70005940c7a398e4b70f3n,
  0xe7159475a2c29b7443b29c7fa6e889d9n,
  0xd097f3bdfd2022b8845ad8f792aa5825n,
  0xa9f746462d870fdf8a65dc1f90e061e5n,
  0x70d869a156d2a1b890bb3df62baf32f7n,
  0x31be135f97d08fd981231505542fcfa6n,
  0x9aa508b5b7a84e1c677de54f3e99bc9n,
  0x5d6af8dedb81196699c329225ee604n,
  0x2216e584f5fa1ea926041bedfe98n,
  0x48a170391f7dc42444e8fa2n,
];

export function sqrtRatioAtTick(tick: number): bigint {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) {
    throw new Error(`tick ${tick} is outside [${MIN_TICK}, ${MAX_TICK}]`);
  }
  const abs = BigInt(Math.abs(tick));
  let ratio = 1n << 128n;
  for (let i = 0; i < TICK_RATIOS.length; i++) {
    if (((abs >> BigInt(i)) & 1n) === 1n) ratio = (ratio * TICK_RATIOS[i]) >> 128n;
  }
  if (tick > 0) ratio = MAX_UINT256 / ratio;
  // Q128.128 down to Q128.96, rounding up, exactly as the library does.
  const shifted = ratio >> 32n;
  return ratio % (1n << 32n) === 0n ? shifted : shifted + 1n;
}

// ---------- LiquidityAmounts ----------

function amount0ForLiquidity(sqrtA: bigint, sqrtB: bigint, liquidity: bigint): bigint {
  const [lo, hi] = sqrtA > sqrtB ? [sqrtB, sqrtA] : [sqrtA, sqrtB];
  if (lo === 0n) return 0n;
  return ((liquidity << 96n) * (hi - lo)) / hi / lo;
}

function amount1ForLiquidity(sqrtA: bigint, sqrtB: bigint, liquidity: bigint): bigint {
  const [lo, hi] = sqrtA > sqrtB ? [sqrtB, sqrtA] : [sqrtA, sqrtB];
  return (liquidity * (hi - lo)) / Q96;
}

// What a position of size `liquidity` over [sqrtA, sqrtB] is worth right now. Below the
// range it is all token0, above it all token1, inside it a mix: that is the whole of
// concentrated liquidity in three branches.
export function amountsForLiquidity(sqrtP: bigint, sqrtA: bigint, sqrtB: bigint, liquidity: bigint): { amount0: bigint; amount1: bigint } {
  const [lo, hi] = sqrtA > sqrtB ? [sqrtB, sqrtA] : [sqrtA, sqrtB];
  if (sqrtP <= lo) return { amount0: amount0ForLiquidity(lo, hi, liquidity), amount1: 0n };
  if (sqrtP < hi) return { amount0: amount0ForLiquidity(sqrtP, hi, liquidity), amount1: amount1ForLiquidity(lo, sqrtP, liquidity) };
  return { amount0: 0n, amount1: amount1ForLiquidity(lo, hi, liquidity) };
}

function liquidityForAmount0(sqrtA: bigint, sqrtB: bigint, amount0: bigint): bigint {
  const [lo, hi] = sqrtA > sqrtB ? [sqrtB, sqrtA] : [sqrtA, sqrtB];
  if (hi === lo) return 0n;
  const intermediate = (lo * hi) / Q96;
  return (amount0 * intermediate) / (hi - lo);
}

function liquidityForAmount1(sqrtA: bigint, sqrtB: bigint, amount1: bigint): bigint {
  const [lo, hi] = sqrtA > sqrtB ? [sqrtB, sqrtA] : [sqrtA, sqrtB];
  if (hi === lo) return 0n;
  return (amount1 * Q96) / (hi - lo);
}

// The largest position both amounts can fund. Inside the range the smaller side binds,
// which is why one of the two desired amounts is normally left partly unused.
export function liquidityForAmounts(sqrtP: bigint, sqrtA: bigint, sqrtB: bigint, amount0: bigint, amount1: bigint): bigint {
  const [lo, hi] = sqrtA > sqrtB ? [sqrtB, sqrtA] : [sqrtA, sqrtB];
  if (sqrtP <= lo) return liquidityForAmount0(lo, hi, amount0);
  if (sqrtP < hi) {
    const l0 = liquidityForAmount0(sqrtP, hi, amount0);
    const l1 = liquidityForAmount1(lo, sqrtP, amount1);
    return l0 < l1 ? l0 : l1;
  }
  return liquidityForAmount1(lo, hi, amount1);
}

function withSlippage(amount: bigint): bigint {
  return (amount * (10_000n - LP_SLIPPAGE_BPS)) / 10_000n;
}

// ---------- calldata ----------
// Exported so the encoders can be pinned to known-good bytes in tests without a network.

export function swapCalldata(params: {
  tokenIn: Address;
  tokenOut: Address;
  fee: number;
  recipient: Address;
  amountIn: bigint;
  amountOutMinimum: bigint;
}): Hex {
  return encodeFunctionData({
    abi: ROUTER_ABI,
    functionName: 'exactInputSingle',
    // sqrtPriceLimitX96 = 0 means "no price limit": amountOutMinimum is the only floor,
    // and it is the one the caller set. Two floors would let the weaker one hide the other.
    args: [{ ...params, sqrtPriceLimitX96: 0n } as never],
  });
}

export function mintCalldata(params: {
  token0: Address;
  token1: Address;
  fee: number;
  tickLower: number;
  tickUpper: number;
  amount0Desired: bigint;
  amount1Desired: bigint;
  amount0Min: bigint;
  amount1Min: bigint;
  recipient: Address;
  deadline: bigint;
}): Hex {
  return encodeFunctionData({ abi: NPM_ABI, functionName: 'mint', args: [params as never] });
}

export function increaseLiquidityCalldata(params: {
  tokenId: bigint;
  amount0Desired: bigint;
  amount1Desired: bigint;
  amount0Min: bigint;
  amount1Min: bigint;
  deadline: bigint;
}): Hex {
  return encodeFunctionData({ abi: NPM_ABI, functionName: 'increaseLiquidity', args: [params as never] });
}

export function decreaseLiquidityCalldata(params: {
  tokenId: bigint;
  liquidity: bigint;
  amount0Min: bigint;
  amount1Min: bigint;
  deadline: bigint;
}): Hex {
  return encodeFunctionData({ abi: NPM_ABI, functionName: 'decreaseLiquidity', args: [params as never] });
}

export function collectCalldata(params: { tokenId: bigint; recipient: Address; amount0Max: bigint; amount1Max: bigint }): Hex {
  return encodeFunctionData({ abi: NPM_ABI, functionName: 'collect', args: [params as never] });
}

// decrease then collect, in one transaction. The NPM's multicall delegatecalls itself, so
// msg.sender survives. Bundling matters here: a decrease that lands without its collect
// leaves the principal sitting as a credit inside the NFT, which looks exactly like lost
// funds to anyone reading the wallet.
export function removeAndCollectCalldata(params: {
  tokenId: bigint;
  liquidity: bigint;
  amount0Min: bigint;
  amount1Min: bigint;
  recipient: Address;
  deadline: bigint;
}): Hex {
  const calls: Hex[] = [
    decreaseLiquidityCalldata({
      tokenId: params.tokenId,
      liquidity: params.liquidity,
      amount0Min: params.amount0Min,
      amount1Min: params.amount1Min,
      deadline: params.deadline,
    }),
    collectCalldata({ tokenId: params.tokenId, recipient: params.recipient, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }),
  ];
  return encodeFunctionData({ abi: NPM_ABI, functionName: 'multicall', args: [calls] });
}

// ---------- chain reads ----------

export type PoolState = { address: Address; sqrtPriceX96: bigint; tick: number };

async function poolAddress(network: Network, chain: ChainId, token0: Address, token1: Address, fee: number): Promise<Address | null> {
  const dep = deploymentFor(network, chain);
  const found = (await reader(network, chain).readContract({
    address: dep.factory,
    abi: FACTORY_ABI,
    functionName: 'getPool',
    args: [token0, token1, fee],
  })) as Address;
  return /^0x0{40}$/i.test(found) ? null : found;
}

// slot0 alone. The pool's total liquidity() is a separate call and nothing here reads it:
// a position's amounts come from its own liquidity, not the pool's. On sepolia.base.org,
// which rate-limits hard, one skipped call per position is the difference between a wallet
// that renders and a wallet full of "over rate limit".
async function poolState(network: Network, chain: ChainId, pool: Address): Promise<PoolState> {
  const slot0 = (await reader(network, chain).readContract({ address: pool, abi: POOL_ABI, functionName: 'slot0' })) as readonly [
    bigint,
    number,
    number,
    number,
    number,
    number,
    boolean,
  ];
  return { address: pool, sqrtPriceX96: slot0[0], tick: Number(slot0[1]) };
}

export type RawPosition = {
  tokenId: bigint;
  token0: Address;
  token1: Address;
  fee: number;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  tokensOwed0: bigint;
  tokensOwed1: bigint;
};

async function readPosition(network: Network, chain: ChainId, tokenId: bigint): Promise<RawPosition> {
  const dep = deploymentFor(network, chain);
  const raw = (await reader(network, chain).readContract({
    address: dep.positionManager,
    abi: NPM_ABI,
    functionName: 'positions',
    args: [tokenId],
  })) as readonly [bigint, Address, Address, Address, number, number, number, bigint, bigint, bigint, bigint, bigint];
  return {
    tokenId,
    token0: raw[2],
    token1: raw[3],
    fee: Number(raw[4]),
    tickLower: Number(raw[5]),
    tickUpper: Number(raw[6]),
    liquidity: raw[7],
    tokensOwed0: raw[10],
    tokensOwed1: raw[11],
  };
}

// symbol()/decimals() for a token this rail has no registry entry for: positions can hold
// any pair, and the wallet still has to label them.
type MetaCache = Map<string, TokenInfo>;

async function tokenMeta(network: Network, chain: ChainId, token: Address, cache: MetaCache): Promise<TokenInfo> {
  const key = token.toLowerCase();
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const client = reader(network, chain);
  const [symbol, decimals] = await Promise.all([
    client.readContract({ address: token, abi: ERC20, functionName: 'symbol' }).catch(() => token.slice(0, 8)),
    client.readContract({ address: token, abi: ERC20, functionName: 'decimals' }).catch(() => 18),
  ]);
  const info: TokenInfo = { symbol: String(symbol), address: token, decimals: Number(decimals) };
  cache.set(key, info);
  return info;
}

// ---------- prices, for the USD column only ----------

const STABLES = new Set(['USDC', 'USDT', 'DAI', 'USDBC', 'USDS', 'PYUSD', 'USDE']);

// Chainlink on the chain itself. Testnet feeds carry real mainnet-equivalent prices, so
// the USD column looks right on testnet. The pool's own sqrtPriceX96 is NOT a price
// source: the Base Sepolia WETH/USDC pool implies about 167 USD/ETH against a real 1,884.
async function ethUsd(network: Network, chain: ChainId): Promise<number | null> {
  try {
    const dep = deploymentFor(network, chain);
    const client = reader(network, chain);
    const [decimals, round] = await Promise.all([
      client.readContract({ address: dep.ethUsdFeed, abi: FEED_ABI, functionName: 'decimals' }),
      client.readContract({ address: dep.ethUsdFeed, abi: FEED_ABI, functionName: 'latestRoundData' }),
    ]);
    const answer = (round as readonly [bigint, bigint, bigint, bigint, bigint])[1];
    if (answer <= 0n) return null;
    return Number(formatUnits(answer, Number(decimals)));
  } catch {
    return null;
  }
}

type PriceLookup = (symbol: string) => number | null;

async function priceLookup(network: Network, chain: ChainId): Promise<PriceLookup> {
  const eth = await ethUsd(network, chain);
  return (symbol: string): number | null => {
    const upper = symbol.toUpperCase();
    if (STABLES.has(upper)) return 1;
    if (upper === 'WETH' || upper === 'ETH') return eth;
    return null; // a testnet token with no mainnet twin has no honest price
  };
}

// ---------- quoting ----------

export type SwapQuote = { fee: number; amountOut: bigint; gasEstimate: bigint };

async function quoteTier(network: Network, chain: ChainId, tokenIn: Address, tokenOut: Address, amountIn: bigint, fee: number): Promise<SwapQuote> {
  const dep = deploymentFor(network, chain);
  const { result } = await reader(network, chain).simulateContract({
    address: dep.quoter,
    abi: QUOTER_ABI,
    functionName: 'quoteExactInputSingle',
    args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n } as never],
  });
  const out = result as readonly [bigint, bigint, number, bigint];
  return { fee, amountOut: out[0], gasEstimate: out[3] };
}

// Quote every tier and take the best fill. The draft names no fee tier, and picking one by
// convention would silently route through a pool 20x thinner than the one next to it.
export async function bestQuote(network: Network, chain: ChainId, tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<SwapQuote> {
  const settled = await Promise.allSettled(FEE_TIERS.map(fee => quoteTier(network, chain, tokenIn, tokenOut, amountIn, fee)));
  let best: SwapQuote | null = null;
  for (const outcome of settled) {
    if (outcome.status !== 'fulfilled') continue;
    if (outcome.value.amountOut > 0n && (best === null || outcome.value.amountOut > best.amountOut)) best = outcome.value;
  }
  if (best === null) {
    const why = settled
      .map((o, i) => (o.status === 'rejected' ? `${FEE_TIERS[i]}: ${String((o.reason as Error).message).split('\n')[0]}` : `${FEE_TIERS[i]}: zero out`))
      .join('; ');
    throw new Error(`no uniswap-v3 pool quoted this swap (${why})`);
  }
  return best;
}

// ---------- shared validation ----------

function requireVenue(venue: string): void {
  if (venue !== VENUE) throw new Error(`this rail is ${VENUE}, draft says ${venue}`);
}

// The policy engine allowlists draft.counterparty. If the rail then hands the funds to a
// different contract, the allowlist checked an address that never received anything, and
// the approval a human clicked described a transaction that was never sent.
function requireCounterparty(declared: string, actual: Address, what: string): void {
  if (declared.toLowerCase() !== actual.toLowerCase()) {
    throw new Error(`draft.counterparty is ${declared} but this rail hands funds to the ${what} at ${actual}`);
  }
}

// Sign from the account the draft names, or not at all. A mismatch means the app would
// spend one wallet's funds while the proposal, the policy budget and the audit line all
// describe another.
function requireSigner(cfg: AppConfig, from: string): Address {
  const signer = evmAddress(cfg.keysPath);
  if (signer.toLowerCase() !== from.toLowerCase()) {
    throw new Error(`draft is from ${from} but the configured signer is ${signer}`);
  }
  return signer;
}

function failed(err: unknown): SimulationResult {
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, summary: `uniswap-v3: ${message.split('\n')[0]}`, error: message };
}

function railFailed(err: unknown): RailResult {
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, detail: `uniswap-v3: ${message.split('\n')[0]}` };
}

function valueUsdOf(draft: { amountUsd: number }): number {
  return Number.isFinite(draft.amountUsd) ? draft.amountUsd : 0;
}

// ---------- rail: swap ----------

type SwapPlan = {
  tokenIn: TokenInfo;
  tokenOut: TokenInfo;
  amountIn: bigint;
  minOut: bigint;
  quote: SwapQuote;
  recipient: Address;
};

async function planSwap(cfg: AppConfig, draft: SwapDraft): Promise<SwapPlan> {
  requireVenue(draft.venue);
  if (draft.chain !== draft.toChain) throw new Error(`uniswap-v3 is a same-chain venue; draft goes ${draft.chain} to ${draft.toChain}`);
  // A floor of zero is not a floor. The type calls minAmountOut a slippage floor and the
  // policy gate approves against it, so a swap that could fill at any price is refused
  // here rather than sent and explained afterwards.
  if (!(draft.minAmountOut > 0)) throw new Error('minAmountOut is 0: refusing to swap with no slippage floor');
  if (!(draft.amountIn > 0)) throw new Error('amountIn is 0');

  requireCounterparty(draft.counterparty, deploymentFor(cfg.network, draft.chain).router, 'SwapRouter02');

  const tokenIn = tokenFor(cfg.network, draft.chain, draft.fromSymbol);
  const tokenOut = tokenFor(cfg.network, draft.chain, draft.toSymbol);
  if (tokenIn.address.toLowerCase() === tokenOut.address.toLowerCase()) throw new Error(`cannot swap ${draft.fromSymbol} for itself`);

  const amountIn = toBaseUnits(draft.amountIn, tokenIn.decimals);
  const minOut = toBaseUnits(draft.minAmountOut, tokenOut.decimals);
  const quote = await bestQuote(cfg.network, draft.chain, tokenIn.address, tokenOut.address, amountIn);
  return { tokenIn, tokenOut, amountIn, minOut, quote, recipient: addr(draft.to, 'draft.to') };
}

export function uniswapSwapRail(cfg: AppConfig): Rail<SwapDraft> {
  return {
    kind: 'swap',
    valueUsd: valueUsdOf,

    async simulate(draft: SwapDraft): Promise<SimulationResult> {
      try {
        const plan = await planSwap(cfg, draft);
        const owner = addr(draft.from, 'draft.from');
        const balance = await erc20Balance(cfg.network, draft.chain, plan.tokenIn.address, owner);

        const out = fmt(plan.quote.amountOut, plan.tokenOut.decimals, plan.tokenOut.symbol);
        const floor = fmt(plan.minOut, plan.tokenOut.decimals, plan.tokenOut.symbol);
        const head = `swap ${fmt(plan.amountIn, plan.tokenIn.decimals, plan.tokenIn.symbol)} for ${out} through the ${(plan.quote.fee / 10_000).toFixed(2)}% pool on ${draft.chain}, floor ${floor}`;

        if (balance < plan.amountIn) {
          return {
            ok: false,
            summary: `${head}. Balance is ${fmt(balance, plan.tokenIn.decimals, plan.tokenIn.symbol)}, short by ${fmt(plan.amountIn - balance, plan.tokenIn.decimals, plan.tokenIn.symbol)}.`,
            error: 'insufficient balance',
          };
        }
        if (plan.quote.amountOut < plan.minOut) {
          return { ok: false, summary: `${head}. The quote is below the floor, so this would revert.`, error: 'quote below minAmountOut' };
        }
        const dep = deploymentFor(cfg.network, draft.chain);
        const allowance = await erc20Allowance(cfg.network, draft.chain, plan.tokenIn.address, owner, dep.router);
        const approvals = allowance < plan.amountIn ? ' One approval transaction runs first.' : '';
        return { ok: true, summary: `${head}.${approvals}` };
      } catch (err) {
        return failed(err);
      }
    },

    async execute(draft: SwapDraft): Promise<RailResult> {
      try {
        const plan = await planSwap(cfg, draft);
        requireSigner(cfg, draft.from);
        const dep = deploymentFor(cfg.network, draft.chain);
        const txids: string[] = [];

        const approval = await ensureAllowance({
          network: cfg.network,
          chain: draft.chain,
          keysPath: cfg.keysPath,
          token: plan.tokenIn.address,
          spender: dep.router,
          needed: plan.amountIn,
        });
        if (approval !== null) {
          if (!approval.ok) return { ok: false, detail: `approve ${plan.tokenIn.symbol} failed: ${approval.error ?? 'unknown'}`, txids };
          if (approval.hash !== undefined) txids.push(approval.hash);
        }

        const sent = await sendTx({
          network: cfg.network,
          chain: draft.chain,
          keysPath: cfg.keysPath,
          to: dep.router,
          data: swapCalldata({
            tokenIn: plan.tokenIn.address,
            tokenOut: plan.tokenOut.address,
            fee: plan.quote.fee,
            recipient: plan.recipient,
            amountIn: plan.amountIn,
            amountOutMinimum: plan.minOut,
          }),
        });
        if (sent.hash !== undefined) txids.push(sent.hash);
        if (!sent.ok) return { ok: false, detail: `swap failed: ${sent.error ?? 'unknown'}`, txids };

        return {
          ok: true,
          detail: `swapped ${fmt(plan.amountIn, plan.tokenIn.decimals, plan.tokenIn.symbol)} for at least ${fmt(plan.minOut, plan.tokenOut.decimals, plan.tokenOut.symbol)} through the ${(plan.quote.fee / 10_000).toFixed(2)}% pool. ${sent.explorer ?? ''}`.trim(),
          txids,
        };
      } catch (err) {
        return railFailed(err);
      }
    },
  };
}

// ---------- rail: lp_add ----------

type AddPlan = {
  token0: TokenInfo;
  token1: TokenInfo;
  pool: PoolState;
  fee: number;
  tickLower: number;
  tickUpper: number;
  used0: bigint;
  used1: bigint;
  min0: bigint;
  min1: bigint;
  liquidity: bigint;
  existing: RawPosition | null;
};

// The position an increaseLiquidity would land on: same pair, same fee, same exact range,
// already owned by this wallet. Anything else has to be a fresh mint.
async function findExistingPosition(
  network: Network,
  chain: ChainId,
  owner: Address,
  want: { token0: Address; token1: Address; fee: number; tickLower: number; tickUpper: number },
): Promise<RawPosition | null> {
  const ids = await ownedTokenIds(network, chain, owner);
  for (const tokenId of ids) {
    const p = await readPosition(network, chain, tokenId);
    if (
      p.token0.toLowerCase() === want.token0.toLowerCase() &&
      p.token1.toLowerCase() === want.token1.toLowerCase() &&
      p.fee === want.fee &&
      p.tickLower === want.tickLower &&
      p.tickUpper === want.tickUpper
    ) {
      return p;
    }
  }
  return null;
}

async function planAdd(cfg: AppConfig, draft: LpAddDraft): Promise<AddPlan> {
  requireVenue(draft.venue);
  requireCounterparty(draft.counterparty, deploymentFor(cfg.network, draft.chain).positionManager, 'position manager');
  const token0: TokenInfo = { symbol: draft.token0.symbol, address: addr(draft.token0.tokenId, 'token0'), decimals: draft.token0.decimals };
  const token1: TokenInfo = { symbol: draft.token1.symbol, address: addr(draft.token1.tokenId, 'token1'), decimals: draft.token1.decimals };

  // token0 must be the numerically lower address or mint reverts. Reordering here is not
  // safe to do quietly: ticks are quoted as token1 per token0, so flipping the pair also
  // has to flip and negate the range. The draft is wrong; say so rather than guess.
  if (BigInt(token0.address) >= BigInt(token1.address)) {
    throw new Error(`token0 ${token0.symbol} must sort below token1 ${token1.symbol}; swap the pair and use ticks [${-draft.tickUpper}, ${-draft.tickLower}]`);
  }

  const spacing = tickSpacingFor(draft.feeTier);
  if (draft.tickLower % spacing !== 0 || draft.tickUpper % spacing !== 0) {
    throw new Error(`ticks must be multiples of ${spacing} for the ${(draft.feeTier / 10_000).toFixed(2)}% tier (got ${draft.tickLower}, ${draft.tickUpper})`);
  }
  if (draft.tickLower >= draft.tickUpper) throw new Error(`tickLower ${draft.tickLower} must be below tickUpper ${draft.tickUpper}`);

  const found = await poolAddress(cfg.network, draft.chain, token0.address, token1.address, draft.feeTier);
  if (found === null) throw new Error(`no ${(draft.feeTier / 10_000).toFixed(2)}% pool exists for ${token0.symbol}/${token1.symbol} on ${draft.chain}`);
  if (draft.poolId !== '' && found.toLowerCase() !== draft.poolId.toLowerCase()) {
    throw new Error(`draft names pool ${draft.poolId} but the factory returns ${found} for this pair and fee`);
  }

  const pool = await poolState(cfg.network, draft.chain, found);
  const desired0 = toBaseUnits(draft.token0.amount, token0.decimals);
  const desired1 = toBaseUnits(draft.token1.amount, token1.decimals);
  if (desired0 === 0n && desired1 === 0n) throw new Error('both amounts are 0');

  const sqrtA = sqrtRatioAtTick(draft.tickLower);
  const sqrtB = sqrtRatioAtTick(draft.tickUpper);
  const liquidity = liquidityForAmounts(pool.sqrtPriceX96, sqrtA, sqrtB, desired0, desired1);
  if (liquidity === 0n) throw new Error('these amounts fund no liquidity in this range at the current price');

  // The pool takes whatever ratio the current price implies, so the mins are 1% under the
  // amounts this liquidity actually needs, not 1% under what the draft offered. Setting
  // them off the offered amounts makes every one-sided range revert on its own slippage check.
  const used = amountsForLiquidity(pool.sqrtPriceX96, sqrtA, sqrtB, liquidity);
  const existing = await findExistingPosition(cfg.network, draft.chain, addr(draft.from, 'draft.from'), {
    token0: token0.address,
    token1: token1.address,
    fee: draft.feeTier,
    tickLower: draft.tickLower,
    tickUpper: draft.tickUpper,
  });

  return {
    token0,
    token1,
    pool,
    fee: draft.feeTier,
    tickLower: draft.tickLower,
    tickUpper: draft.tickUpper,
    used0: used.amount0,
    used1: used.amount1,
    min0: withSlippage(used.amount0),
    min1: withSlippage(used.amount1),
    liquidity,
    existing,
  };
}

export function uniswapLpAddRail(cfg: AppConfig): Rail<LpAddDraft> {
  return {
    kind: 'lp_add',
    valueUsd: valueUsdOf,

    async simulate(draft: LpAddDraft): Promise<SimulationResult> {
      try {
        const plan = await planAdd(cfg, draft);
        const owner = addr(draft.from, 'draft.from');
        const [bal0, bal1] = await Promise.all([
          erc20Balance(cfg.network, draft.chain, plan.token0.address, owner),
          erc20Balance(cfg.network, draft.chain, plan.token1.address, owner),
        ]);

        const inRange = plan.pool.tick >= plan.tickLower && plan.pool.tick < plan.tickUpper;
        const action = plan.existing === null ? 'mint a new position' : `add to position #${plan.existing.tokenId}`;
        const head =
          `${action} in the ${plan.token0.symbol}/${plan.token1.symbol} ${(plan.fee / 10_000).toFixed(2)}% pool, ticks ${plan.tickLower} to ${plan.tickUpper} ` +
          `(${inRange ? 'in range' : 'out of range'} at tick ${plan.pool.tick}), supplying ${fmt(plan.used0, plan.token0.decimals, plan.token0.symbol)} and ${fmt(plan.used1, plan.token1.decimals, plan.token1.symbol)}`;

        const short: string[] = [];
        if (bal0 < plan.used0) short.push(`${plan.token0.symbol} short by ${fmt(plan.used0 - bal0, plan.token0.decimals, plan.token0.symbol)}`);
        if (bal1 < plan.used1) short.push(`${plan.token1.symbol} short by ${fmt(plan.used1 - bal1, plan.token1.decimals, plan.token1.symbol)}`);
        if (short.length > 0) return { ok: false, summary: `${head}. Balance is short: ${short.join(', ')}.`, error: 'insufficient balance' };

        const dep = deploymentFor(cfg.network, draft.chain);
        const [allow0, allow1] = await Promise.all([
          erc20Allowance(cfg.network, draft.chain, plan.token0.address, owner, dep.positionManager),
          erc20Allowance(cfg.network, draft.chain, plan.token1.address, owner, dep.positionManager),
        ]);
        const approvals = [allow0 < plan.used0 ? plan.token0.symbol : null, allow1 < plan.used1 ? plan.token1.symbol : null].filter(s => s !== null);
        const tail = approvals.length > 0 ? ` Approvals run first for ${approvals.join(' and ')}.` : '';
        return { ok: true, summary: `${head}.${tail}` };
      } catch (err) {
        return failed(err);
      }
    },

    async execute(draft: LpAddDraft): Promise<RailResult> {
      try {
        const plan = await planAdd(cfg, draft);
        const signer = requireSigner(cfg, draft.from);
        const dep = deploymentFor(cfg.network, draft.chain);
        const txids: string[] = [];

        // Approve the amounts the pool will actually pull, not the amounts offered: a
        // wider allowance than the transaction needs outlives the transaction.
        const approvals: Array<[TokenInfo, bigint]> = [
          [plan.token0, plan.used0],
          [plan.token1, plan.used1],
        ];
        for (const [token, needed] of approvals) {
          if (needed === 0n) continue;
          const approval = await ensureAllowance({
            network: cfg.network,
            chain: draft.chain,
            keysPath: cfg.keysPath,
            token: token.address,
            spender: dep.positionManager,
            needed,
          });
          if (approval !== null) {
            if (!approval.ok) return { ok: false, detail: `approve ${token.symbol} failed: ${approval.error ?? 'unknown'}`, txids };
            if (approval.hash !== undefined) txids.push(approval.hash);
          }
        }

        const data =
          plan.existing === null
            ? mintCalldata({
                token0: plan.token0.address,
                token1: plan.token1.address,
                fee: plan.fee,
                tickLower: plan.tickLower,
                tickUpper: plan.tickUpper,
                amount0Desired: plan.used0,
                amount1Desired: plan.used1,
                amount0Min: plan.min0,
                amount1Min: plan.min1,
                recipient: signer,
                deadline: deadline(),
              })
            : increaseLiquidityCalldata({
                tokenId: plan.existing.tokenId,
                amount0Desired: plan.used0,
                amount1Desired: plan.used1,
                amount0Min: plan.min0,
                amount1Min: plan.min1,
                deadline: deadline(),
              });

        const sent = await sendTx({ network: cfg.network, chain: draft.chain, keysPath: cfg.keysPath, to: dep.positionManager, data });
        if (sent.hash !== undefined) txids.push(sent.hash);
        if (!sent.ok) return { ok: false, detail: `add liquidity failed: ${sent.error ?? 'unknown'}`, txids };

        const what = plan.existing === null ? 'minted a new position' : `added to position #${plan.existing.tokenId}`;
        return {
          ok: true,
          detail: `${what} in ${plan.token0.symbol}/${plan.token1.symbol} ${(plan.fee / 10_000).toFixed(2)}%: ${fmt(plan.used0, plan.token0.decimals, plan.token0.symbol)} and ${fmt(plan.used1, plan.token1.decimals, plan.token1.symbol)}. ${sent.explorer ?? ''}`.trim(),
          txids,
        };
      } catch (err) {
        return railFailed(err);
      }
    },
  };
}

// ---------- rail: lp_remove ----------

type RemovePlan = {
  position: RawPosition;
  token0: TokenInfo;
  token1: TokenInfo;
  pool: PoolState;
  burn: bigint;
  out0: bigint;
  out1: bigint;
  min0: bigint;
  min1: bigint;
  fees0: bigint;
  fees1: bigint;
  recipient: Address;
};

async function planRemove(cfg: AppConfig, draft: LpRemoveDraft): Promise<RemovePlan> {
  requireVenue(draft.venue);
  if (!(draft.liquidityPct > 0) || draft.liquidityPct > 1) throw new Error(`liquidityPct must be in (0, 1], got ${draft.liquidityPct}`);

  const owner = addr(draft.from, 'draft.from');
  const dep = deploymentFor(cfg.network, draft.chain);
  requireCounterparty(draft.counterparty, dep.positionManager, 'position manager');
  const client = reader(cfg.network, draft.chain);

  if (!/^\d+$/.test(draft.positionId)) throw new Error(`positionId ${draft.positionId} is not a token id`);
  const tokenId = BigInt(draft.positionId);

  const onChainOwner = (await client.readContract({ address: dep.positionManager, abi: NPM_ABI, functionName: 'ownerOf', args: [tokenId] })) as Address;
  if (onChainOwner.toLowerCase() !== owner.toLowerCase()) throw new Error(`position #${tokenId} is owned by ${onChainOwner}, not ${owner}`);

  const position = await readPosition(cfg.network, draft.chain, tokenId);
  if (position.liquidity === 0n) throw new Error(`position #${tokenId} holds no liquidity`);

  // Percent to liquidity in integer maths. 1e6 is finer than any percentage a UI produces
  // and keeps a full withdrawal exact: pct 1 burns every last unit, never all-but-one.
  const scaled = BigInt(Math.round(draft.liquidityPct * 1_000_000));
  const burn = draft.liquidityPct >= 1 ? position.liquidity : (position.liquidity * scaled) / 1_000_000n;
  if (burn === 0n) throw new Error(`${(draft.liquidityPct * 100).toFixed(4)}% of position #${tokenId} rounds to zero liquidity`);

  const found = await poolAddress(cfg.network, draft.chain, position.token0, position.token1, position.fee);
  if (found === null) throw new Error(`the pool behind position #${tokenId} no longer resolves`);
  const pool = await poolState(cfg.network, draft.chain, found);

  const out = amountsForLiquidity(pool.sqrtPriceX96, sqrtRatioAtTick(position.tickLower), sqrtRatioAtTick(position.tickUpper), burn);
  const cache: MetaCache = new Map();
  const [token0, token1] = await Promise.all([
    tokenMeta(cfg.network, draft.chain, position.token0, cache),
    tokenMeta(cfg.network, draft.chain, position.token1, cache),
  ]);
  const fees = await collectableFees(cfg.network, draft.chain, tokenId, owner, position);

  return {
    position,
    token0,
    token1,
    pool,
    burn,
    out0: out.amount0,
    out1: out.amount1,
    min0: withSlippage(out.amount0),
    min1: withSlippage(out.amount1),
    fees0: fees.amount0,
    fees1: fees.amount1,
    recipient: owner,
  };
}

export function uniswapLpRemoveRail(cfg: AppConfig): Rail<LpRemoveDraft> {
  return {
    kind: 'lp_remove',
    valueUsd: valueUsdOf,

    async simulate(draft: LpRemoveDraft): Promise<SimulationResult> {
      try {
        const plan = await planRemove(cfg, draft);
        const pct = (draft.liquidityPct * 100).toFixed(2);
        const summary =
          `pull ${pct}% of position #${plan.position.tokenId} (${plan.token0.symbol}/${plan.token1.symbol} ${(plan.position.fee / 10_000).toFixed(2)}%): ` +
          `about ${fmt(plan.out0, plan.token0.decimals, plan.token0.symbol)} and ${fmt(plan.out1, plan.token1.decimals, plan.token1.symbol)} back, ` +
          `plus ${fmt(plan.fees0, plan.token0.decimals, plan.token0.symbol)} and ${fmt(plan.fees1, plan.token1.decimals, plan.token1.symbol)} of uncollected fees. ` +
          'One transaction: decrease then collect.';
        return { ok: true, summary };
      } catch (err) {
        return failed(err);
      }
    },

    async execute(draft: LpRemoveDraft): Promise<RailResult> {
      try {
        const plan = await planRemove(cfg, draft);
        requireSigner(cfg, draft.from);
        const dep = deploymentFor(cfg.network, draft.chain);

        const sent = await sendTx({
          network: cfg.network,
          chain: draft.chain,
          keysPath: cfg.keysPath,
          to: dep.positionManager,
          data: removeAndCollectCalldata({
            tokenId: plan.position.tokenId,
            liquidity: plan.burn,
            amount0Min: plan.min0,
            amount1Min: plan.min1,
            recipient: plan.recipient,
            deadline: deadline(),
          }),
        });
        const txids = sent.hash !== undefined ? [sent.hash] : [];
        if (!sent.ok) return { ok: false, detail: `remove liquidity failed: ${sent.error ?? 'unknown'}`, txids };

        return {
          ok: true,
          detail: `pulled ${(draft.liquidityPct * 100).toFixed(2)}% of position #${plan.position.tokenId} and collected fees: at least ${fmt(plan.min0, plan.token0.decimals, plan.token0.symbol)} and ${fmt(plan.min1, plan.token1.decimals, plan.token1.symbol)}. ${sent.explorer ?? ''}`.trim(),
          txids,
        };
      } catch (err) {
        return railFailed(err);
      }
    },
  };
}

// ---------- reading positions ----------

async function ownedTokenIds(network: Network, chain: ChainId, owner: Address): Promise<bigint[]> {
  const dep = deploymentFor(network, chain);
  const client = reader(network, chain);
  const count = (await client.readContract({ address: dep.positionManager, abi: NPM_ABI, functionName: 'balanceOf', args: [owner] })) as bigint;
  const indexes = Array.from({ length: Number(count) }, (_, i) => BigInt(i));
  return mapLimit(
    indexes,
    4,
    async index => (await client.readContract({ address: dep.positionManager, abi: NPM_ABI, functionName: 'tokenOfOwnerByIndex', args: [owner, index] })) as bigint,
  );
}

// What collect() would actually pay out right now. Simulating it beats reading tokensOwed:
// with liquidity in the position, collect first pokes the pool to checkpoint fee growth,
// so the simulated return includes the fees earned since the last touch. tokensOwed alone
// reports only what was already checkpointed, which on a quiet position is often zero.
async function collectableFees(
  network: Network,
  chain: ChainId,
  tokenId: bigint,
  owner: Address,
  fallback: RawPosition,
): Promise<{ amount0: bigint; amount1: bigint }> {
  try {
    const dep = deploymentFor(network, chain);
    const { result } = await reader(network, chain).simulateContract({
      address: dep.positionManager,
      abi: NPM_ABI,
      functionName: 'collect',
      account: owner,
      args: [{ tokenId, recipient: owner, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 } as never],
    });
    const out = result as readonly [bigint, bigint];
    return { amount0: out[0], amount1: out[1] };
  } catch {
    return { amount0: fallback.tokensOwed0, amount1: fallback.tokensOwed1 };
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      out[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return out;
}

export type ReadPositionsOptions = {
  chains?: ChainId[]; // every chain with a verified deployment, by default
  onError?: (message: string) => void; // one position failing must not blank the wallet
};

// Every Uniswap v3 position this owner holds, priced where the app has an honest price.
// Chains are swept rather than fixed: a position minted on one chain must not vanish from
// the wallet because the default chain for new drafts moved to another.
export async function readPositions(network: Network, owner: string, opts?: ReadPositionsOptions): Promise<LpPosition[]> {
  const note = opts?.onError ?? ((): void => {});
  let ownerAddr: Address;
  try {
    ownerAddr = addr(owner, 'owner');
  } catch (err) {
    note(err instanceof Error ? err.message : String(err));
    return [];
  }

  const chains = opts?.chains ?? chainsWithDeployment(network);
  const perChain = await Promise.all(chains.map(chain => readPositionsOnChain(network, chain, ownerAddr, note)));
  return perChain.flat();
}

// The NPM is ERC-721 Enumerable, so the loop is balanceOf, tokenOfOwnerByIndex, positions.
async function readPositionsOnChain(network: Network, chain: ChainId, ownerAddr: Address, note: (message: string) => void): Promise<LpPosition[]> {
  let ids: bigint[];
  let price: PriceLookup;
  try {
    [ids, price] = await Promise.all([ownedTokenIds(network, chain, ownerAddr), priceLookup(network, chain)]);
  } catch (err) {
    note(`uniswap-v3 position list failed on ${chain}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }

  const cache: MetaCache = new Map();
  // One pool read per pool, not per position. Several positions on the same pair is the
  // normal case, and sepolia.base.org counts every call.
  const pools = new Map<string, PoolState | null>();

  // Two at a time. The public testnet RPC answers a burst with an HTML rate-limit page,
  // and a wallet that renders slowly beats a wallet that renders empty.
  const results = await mapLimit(ids, 2, async tokenId => {
    try {
      const position = await readPosition(network, chain, tokenId);
      // A burned-out NFT with nothing left in it is not a holding.
      if (position.liquidity === 0n && position.tokensOwed0 === 0n && position.tokensOwed1 === 0n) return null;

      const key = `${position.token0}-${position.token1}-${position.fee}`.toLowerCase();
      if (!pools.has(key)) {
        const found = await poolAddress(network, chain, position.token0, position.token1, position.fee);
        pools.set(key, found === null ? null : await poolState(network, chain, found));
      }
      const state = pools.get(key) ?? null;
      if (state === null) {
        note(`uniswap-v3 position #${tokenId}: no pool for ${position.token0}/${position.token1} fee ${position.fee}`);
        return null;
      }
      const pool = state.address;
      const [token0, token1] = await Promise.all([tokenMeta(network, chain, position.token0, cache), tokenMeta(network, chain, position.token1, cache)]);
      const amounts = amountsForLiquidity(state.sqrtPriceX96, sqrtRatioAtTick(position.tickLower), sqrtRatioAtTick(position.tickUpper), position.liquidity);
      const fees = await collectableFees(network, chain, tokenId, ownerAddr, position);

      const price0 = price(token0.symbol);
      const price1 = price(token1.symbol);
      // Half a fee figure is worse than none: a pair where only one side has a price
      // would render as if the other side's fees were zero.
      const uncollectedFeesUsd =
        price0 === null || price1 === null
          ? null
          : fromBaseUnits(fees.amount0, token0.decimals) * price0 + fromBaseUnits(fees.amount1, token1.decimals) * price1;

      const out: LpPosition = {
        chain,
        venue: VENUE,
        poolId: pool,
        positionId: tokenId.toString(),
        token0: { symbol: token0.symbol, tokenId: token0.address, amount: fromBaseUnits(amounts.amount0, token0.decimals) },
        token1: { symbol: token1.symbol, tokenId: token1.address, amount: fromBaseUnits(amounts.amount1, token1.decimals) },
        feeTier: position.fee,
        inRange: state.tick >= position.tickLower && state.tick < position.tickUpper,
        uncollectedFeesUsd,
      };
      return out;
    } catch (err) {
      note(`uniswap-v3 position #${tokenId} failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  });

  return results.filter((p): p is LpPosition => p !== null);
}

// ---------- the bundle the dispatch table wires in ----------

export function uniswapRails(cfg: AppConfig): { swap: Rail<SwapDraft>; lpAdd: Rail<LpAddDraft>; lpRemove: Rail<LpRemoveDraft> } {
  return { swap: uniswapSwapRail(cfg), lpAdd: uniswapLpAddRail(cfg), lpRemove: uniswapLpRemoveRail(cfg) };
}
