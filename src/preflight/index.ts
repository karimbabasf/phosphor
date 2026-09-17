// The preflight: five checks the app runs for itself a moment before a 1Click intent is signed.
//
// Karim, 2026-09-16: "implement a tracker that tracks the current gas on chain on arbitrum
// before sending out a 1click api call so that we dont result in a loss like we did due to a
// gas error. simulation should be a huge part but not in front of the user, in the backend."
//
// The checks, in the order the receipt draws them:
//   gas       the chain the payout lands on. Arbitrum (a HyperCore deposit, a payout to
//             Arbitrum) is modelled as the vendor's sweep against its 300,000 gas limit
//             (src/preflight/arbitrum.ts); Ethereum and Base are the base fee against the
//             hour's average. Solana and NEAR are not read, and the check says so.
//   coverage  the fee inside the quote against this app's own estimate of what the payout
//             costs at today's gas price. A fee that does not cover the cost is the 09-15
//             shape: the vendor is paying for the payout out of a number it set earlier.
//   venue     1Click answers a dry quote inside the read budget and its status endpoint, the
//             one the watch loop will poll, answers at all.
//   balance   the verifier holds what the intent will hand over.
//   deadline  the quote is good for at least three more minutes.
//
// PURE. Every read comes in through `deps`: the app wires viem and the 1Click client in
// src/preflight/live.ts, the tests hand in fakes. Nothing here signs, sends or sleeps beyond
// the one deadline on the venue probe.
//
// THREE VERDICTS. `ok` signs. `hold` signs nothing and the executor tries again in a while,
// because every hold is a condition that clears on its own (gas settles, a fresh quote prices
// the fee again, the venue comes back). `fail` signs nothing and stops: a balance that is not
// there does not become there by waiting. The hold is a status, never a question: the card
// says what it is waiting for and the retry is the app's.

import { formatUnits } from 'viem';
import type { OneClickQuote } from '../intents.ts';
import type { Preflight, PreflightCheck, WriteDraft } from '../types.ts';
import { sweepEstimate } from './arbitrum.ts';
import type { ArbGasRead } from './arbitrum.ts';
import type { GasHistory } from './history.ts';

export type { Preflight, PreflightCheck } from '../types.ts';

export type GasChain = 'arb' | 'eth' | 'base';

// The two venue reads the check makes, built by the caller from the same client and the same
// request the live quote used (src/rails/intents-spend.ts).
export type VenueProbe = { dryQuote(): Promise<unknown>; status(): Promise<unknown> };

export type PreflightDeps = {
  now: () => number;
  arbitrum: () => Promise<ArbGasRead | null>;
  baseFee: (chain: 'eth' | 'base') => Promise<bigint | null>;
  history: Record<GasChain, GasHistory>;
  venue: VenueProbe;
  // The verifier's balance of the asset being spent, in base units. null when unread.
  balance: () => Promise<bigint | null>;
  priceUsd: (symbol: string) => number | null;
  venueTimeoutMs?: number;
};

export const VENUE_TIMEOUT_MS = 10_000;
export const DEADLINE_MIN_MS = 3 * 60_000;
// The units a payout burns on an EVM chain: a plain transfer of the coin, or an ERC-20 transfer.
export const NATIVE_PAYOUT_UNITS = 21_000;
export const TOKEN_PAYOUT_UNITS = 65_000;
// Base fee against the hour's average: above twice it the check warns, above four times it
// holds, the shape the plan set for the chains without a vendor limit to hold against.
export const BASE_FEE_WARN_RATIO = 2;
export const BASE_FEE_FAIL_RATIO = 4;
export const COVER_WARN_BELOW = 1.5;
export const COVER_FAIL_BELOW = 1;

// Where the payout lands, and how its gas is read.
type Landing =
  | { model: 'sweep'; chain: 'arb'; label: 'Arbitrum' }
  | { model: 'evm'; chain: GasChain; label: string; native: boolean }
  | { model: 'unread'; label: string }
  | { model: 'none' };

const LABELS: Record<string, string> = { ethereum: 'Ethereum', base: 'Base', arbitrum: 'Arbitrum', solana: 'Solana', near: 'NEAR', bitcoin: 'Bitcoin' };

function landingOf(kind: WriteDraft['kind'], draft: WriteDraft): Landing {
  if (kind === 'hl_deposit') return { model: 'sweep', chain: 'arb', label: 'Arbitrum' };
  if (kind === 'intents_pay' && draft.kind === 'intents_pay') {
    const native = draft.symbol.toUpperCase() === 'ETH';
    switch (draft.network) {
      case 'ethereum':
        return { model: 'evm', chain: 'eth', label: 'Ethereum', native };
      case 'base':
        return { model: 'evm', chain: 'base', label: 'Base', native };
      case 'arbitrum':
        return { model: 'evm', chain: 'arb', label: 'Arbitrum', native };
      default:
        return { model: 'unread', label: LABELS[draft.network] ?? draft.network };
    }
  }
  return { model: 'none' };
}

function units(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

function usd(v: number): string {
  return v < 0.01 ? 'under $0.01' : `$${v.toFixed(2)}`;
}

function ratioWords(value: number, average: number | null): string {
  if (average === null || average <= 0) return '';
  return `, ${(value / average).toFixed(1)}x the hourly average`;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// The gas read, and what the coverage check needs from it: the price of a unit and how many
// units the payout takes. Both null when nothing was read.
type GasRead = { check: PreflightCheck; priceWei: bigint | null; extraUnits: number; sweepUnits: number | null };

async function gasCheck(landing: Landing, deps: PreflightDeps): Promise<GasRead> {
  const now = deps.now();
  if (landing.model === 'none') {
    return {
      check: { id: 'gas', label: 'Gas', state: 'ok', value: 'None', detail: 'This stays inside NEAR Intents: no chain transaction and no gas.' },
      priceWei: null,
      extraUnits: 0,
      sweepUnits: null,
    };
  }
  if (landing.model === 'unread') {
    return {
      check: {
        id: 'gas',
        label: `${landing.label} gas`,
        state: 'ok',
        value: 'Not read',
        detail: `${landing.label} gas is not read by this app. The bridge pays its own fee there, and the fee check below is what stands.`,
      },
      priceWei: null,
      extraUnits: 0,
      sweepUnits: null,
    };
  }
  const label = `${landing.label} gas`;
  if (landing.chain === 'arb') {
    const read = await deps.arbitrum();
    const estimate = read === null ? null : sweepEstimate(read);
    if (read === null || estimate === null) {
      return {
        check: { id: 'gas', label, state: 'warn', value: 'Not read', detail: 'Arbitrum did not answer, so the sweep cannot be modelled right now.' },
        priceWei: null,
        extraUnits: 0,
        sweepUnits: null,
      };
    }
    const history = deps.history.arb;
    const average = history.average(now);
    history.push(now, estimate.gasUnits);
    const state = estimate.verdict === 'ok' ? 'ok' : estimate.verdict === 'elevated' ? 'warn' : 'fail';
    return {
      check: {
        id: 'gas',
        label,
        state,
        value: `${units(estimate.gasUnits)} / ${units(estimate.limit)}`,
        detail:
          `1Click's relayer sweeps the payout with a ${units(estimate.limit)} gas limit. Right now the sweep needs about ` +
          `${units(estimate.gasUnits)}, ${units(estimate.l1DataUnits)} of it L1 data${ratioWords(estimate.gasUnits, average)}.`,
        series: history.series(now),
        limit: estimate.limit,
      },
      priceWei: read.perArbGasTotal,
      extraUnits: estimate.l1DataUnits,
      sweepUnits: estimate.gasUnits,
    };
  }
  const fee = await deps.baseFee(landing.chain);
  if (fee === null) {
    return {
      check: { id: 'gas', label, state: 'warn', value: 'Not read', detail: `${landing.label} did not answer, so its base fee is unknown right now.` },
      priceWei: null,
      extraUnits: 0,
      sweepUnits: null,
    };
  }
  const gwei = Number(fee) / 1e9;
  const history = deps.history[landing.chain];
  const average = history.average(now);
  history.push(now, gwei);
  const ratio = average === null || average <= 0 ? null : gwei / average;
  const state = ratio === null ? 'ok' : ratio > BASE_FEE_FAIL_RATIO ? 'fail' : ratio > BASE_FEE_WARN_RATIO ? 'warn' : 'ok';
  return {
    check: {
      id: 'gas',
      label,
      state,
      value: `${gwei.toFixed(1)} gwei`,
      detail: `The base fee on ${landing.label} is ${gwei.toFixed(2)} gwei${ratioWords(gwei, average)}. The bridge pays the payout's gas out of its fee.`,
      series: history.series(now),
    },
    priceWei: fee,
    extraUnits: 0,
    sweepUnits: null,
  };
}

function feeUsdOf(quote: OneClickQuote): number | null {
  const inUsd = Number(quote.amountInUsd);
  const outUsd = Number(quote.amountOutUsd);
  return Number.isFinite(inUsd) && Number.isFinite(outUsd) ? inUsd - outUsd : null;
}

function coverageCheck(kind: WriteDraft['kind'], landing: Landing, gas: GasRead, quote: OneClickQuote, deps: PreflightDeps): PreflightCheck {
  const label = 'Fee covers the payout';
  if (landing.model === 'none') return { id: 'coverage', label, state: 'ok', value: 'n/a', detail: 'No chain payout to cover.' };
  if (landing.model === 'unread') {
    return { id: 'coverage', label, state: 'ok', value: 'n/a', detail: `The payout's cost on ${landing.label} is not modelled; the bridge pays its own fee there.` };
  }
  const feeUsd = feeUsdOf(quote);
  if (feeUsd === null) return { id: 'coverage', label, state: 'warn', value: 'Unknown', detail: 'The quote did not price both sides, so the fee is unknown.' };
  if (gas.priceWei === null) return { id: 'coverage', label, state: 'warn', value: 'Unknown', detail: `${landing.label} gas was not read, so the payout's cost cannot be estimated.` };
  const price = deps.priceUsd('ETH');
  if (price === null || !(price > 0)) {
    return { id: 'coverage', label, state: 'warn', value: 'Unknown', detail: 'The ETH price was not read, so the gas cannot be priced in dollars.' };
  }
  const payoutUnits =
    kind === 'hl_deposit' && gas.sweepUnits !== null
      ? gas.sweepUnits
      : (landing.model === 'evm' && landing.native ? NATIVE_PAYOUT_UNITS : TOKEN_PAYOUT_UNITS) + gas.extraUnits;
  const costUsd = (Number(gas.priceWei * BigInt(payoutUnits)) / 1e18) * price;
  const cover = costUsd > 0 ? feeUsd / costUsd : Infinity;
  const state = cover < COVER_FAIL_BELOW ? 'fail' : cover < COVER_WARN_BELOW ? 'warn' : 'ok';
  return {
    id: 'coverage',
    label,
    state,
    value: `${Number.isFinite(cover) ? cover.toFixed(1) : '999'}x`,
    detail: `${usd(feeUsd)} fee against about ${usd(costUsd)} of gas on ${landing.label} (${units(payoutUnits)} units at today's price).`,
  };
}

// A promise raced against a deadline, the deadline's timer never holding the process open.
function within<T>(ms: number, work: Promise<T>): Promise<T | 'timeout'> {
  return new Promise<T | 'timeout'>((resolve, reject) => {
    const timer = setTimeout(() => resolve('timeout'), ms);
    timer.unref?.();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function venueCheck(deps: PreflightDeps): Promise<PreflightCheck> {
  const label = 'Venue answering';
  const budget = deps.venueTimeoutMs ?? VENUE_TIMEOUT_MS;
  const started = deps.now();
  try {
    const answer = await within(budget, deps.venue.dryQuote());
    if (answer === 'timeout') {
      return { id: 'venue', label, state: 'fail', value: `> ${units(budget)} ms`, detail: `NEAR Intents did not answer a dry quote within ${units(budget)} ms.` };
    }
  } catch (err) {
    return { id: 'venue', label, state: 'fail', value: 'No answer', detail: `NEAR Intents refused the dry quote: ${errText(err)}.` };
  }
  const ms = Math.max(0, deps.now() - started);
  try {
    await within(budget, deps.venue.status());
  } catch (err) {
    return { id: 'venue', label, state: 'fail', value: `${units(ms)} ms`, detail: `The quote answered but the status endpoint did not (${errText(err)}); the watch after signing would be blind.` };
  }
  return { id: 'venue', label, state: 'ok', value: `${units(ms)} ms`, detail: `A dry quote answered in ${units(ms)} ms and the status endpoint is reachable.` };
}

function amountOf(draft: WriteDraft): number | null {
  return 'amount' in draft && typeof draft.amount === 'number' && Number.isFinite(draft.amount) ? draft.amount : null;
}

function symbolOf(draft: WriteDraft): string {
  return 'symbol' in draft && typeof draft.symbol === 'string' ? draft.symbol.toUpperCase() : '';
}

// The asset's decimals, from the quote's base amount against the draft's: the quote is the
// one thing here that states the amount in base units.
function decimalsOf(amountBase: bigint, amount: number | null): number {
  if (amount === null || amount <= 0 || amountBase <= 0n) return 0;
  const d = Math.round(Math.log10(Number(amountBase) / amount));
  return Number.isFinite(d) && d >= 0 ? d : 0;
}

async function balanceCheck(draft: WriteDraft, quote: OneClickQuote, deps: PreflightDeps): Promise<PreflightCheck> {
  const label = 'Balance';
  const symbol = symbolOf(draft);
  const amountBase = /^\d+$/.test(quote.amountIn) ? BigInt(quote.amountIn) : null;
  if (amountBase === null) return { id: 'balance', label, state: 'warn', value: 'Unknown', detail: 'The quote states no base amount to hold the balance to.' };
  const decimals = decimalsOf(amountBase, amountOf(draft));
  const held = await deps.balance();
  if (held === null) return { id: 'balance', label, state: 'warn', value: 'Not read', detail: `The verifier did not answer for the ${symbol} balance.` };
  const have = `${formatUnits(held, decimals)} ${symbol}`;
  const need = `${formatUnits(amountBase, decimals)} ${symbol}`;
  if (held < amountBase) {
    return { id: 'balance', label, state: 'fail', value: have, detail: `${symbol} inside NEAR Intents reads ${have}; this move needs ${need}.` };
  }
  return { id: 'balance', label, state: 'ok', value: have, detail: `${symbol} inside NEAR Intents reads ${have}, and this move needs ${need}.` };
}

function deadlineCheck(quote: OneClickQuote, deps: PreflightDeps): PreflightCheck {
  const label = 'Quote still valid';
  const at = Date.parse(quote.deadline ?? '');
  if (!Number.isFinite(at)) return { id: 'deadline', label, state: 'warn', value: 'Unknown', detail: 'The quote carries no deadline.' };
  const left = at - deps.now();
  const minutes = Math.round(left / 60_000);
  const value = `${Math.max(0, minutes)} min`;
  const detail = `The quote is good until ${new Date(at).toISOString()}; the intent is signed and submitted within seconds of this check.`;
  if (left < DEADLINE_MIN_MS) {
    return { id: 'deadline', label, state: 'fail', value, detail: `The quote expires in ${value}, under the three minutes the app wants between this check and the submit.` };
  }
  return { id: 'deadline', label, state: 'ok', value, detail };
}

function holdReasonOf(check: PreflightCheck, landing: Landing): string {
  switch (check.id) {
    case 'gas':
      return `Waiting for ${landing.model === 'sweep' || landing.model === 'evm' ? landing.label : 'chain'} gas to settle`;
    case 'coverage':
      return 'Waiting for a fee that covers the payout';
    case 'venue':
      return 'Waiting for NEAR Intents to answer';
    case 'deadline':
      return 'Waiting for a fresh quote';
    case 'balance':
      return 'The balance inside NEAR Intents does not cover this move';
  }
}

export async function runPreflight(kind: WriteDraft['kind'], draft: WriteDraft, quote: OneClickQuote, deps: PreflightDeps): Promise<Preflight> {
  const landing = landingOf(kind, draft);
  const gas = await gasCheck(landing, deps);
  const coverage = coverageCheck(kind, landing, gas, quote, deps);
  const [venue, balance] = await Promise.all([venueCheck(deps), balanceCheck(draft, quote, deps)]);
  const deadline = deadlineCheck(quote, deps);
  const checks = [gas.check, coverage, venue, balance, deadline];

  const failing = checks.filter((c) => c.state === 'fail');
  if (failing.length === 0) return { at: new Date(deps.now()).toISOString(), checks, verdict: 'ok' };
  // A balance that is not there does not arrive by waiting, so it outranks every hold.
  const stop = failing.find((c) => c.id === 'balance');
  const first = stop ?? failing[0];
  return {
    at: new Date(deps.now()).toISOString(),
    checks,
    verdict: stop === undefined ? 'hold' : 'fail',
    holdReason: holdReasonOf(first, landing),
  };
}
