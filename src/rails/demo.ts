// The demo money rail: one rail per money kind that moves nothing and reports everything.
//
// Demo mode owned no rails at all, so every money proposal refused at draft time and the only
// thing a person could watch from end to end was a policy change. That left the live pending
// state (the card's stage clock, what the agent narrates while it waits, a row going late) with
// no way to be seen or judged without real money on a real chain.
//
// So this walks the stages a real rail reports, on a timer, through the same seams: the
// evidence hook writes the vendor's word onto the row, the result lands the row settling, and
// the balance the fixture serves is what settles it. Every write is the executor's own
// (src/proposals/execute.ts), so the per-proposal SSE frame, the view builder and the card see
// nothing they would not see on mainnet.
//
// NOTHING HERE IS REACHABLE OUTSIDE DEMO MODE. It signs nothing, quotes nothing, opens no
// socket and reads no key, and the registry builds it only under cfg.mode 'demo'
// (src/rails/index.ts). demoRails() throws on any other mode rather than trusting its caller,
// and every knob below reads its environment only in demo mode, so a mainnet config cannot
// carry one.

import { randomBytes } from 'node:crypto';

import { base58Encode } from '../chain/near.ts';

import type {
  AppConfig,
  HlDepositDraft,
  HlWithdrawDraft,
  IntentsPayDraft,
  IntentsSendDraft,
  Rail,
  RailEvidence,
  RailHooks,
  RailResult,
  SimulationResult,
  SwapDraft,
  WriteDraft,
} from '../types.ts';
import type { PocketRead } from '../ledger/settle.ts';
import type { RailRegistry } from './index.ts';
import { HYPERCORE_USDC_ASSET_ID, HYPERCORE_USDC_DECIMALS, HYPERCORE_VENUE_MIN_CREDIT_USDC, MAX_FEE_PCT, MIN_DEPOSIT_USDC } from './hypercore-deposit.ts';
import { HL_ACTIVATION_USDC, INTENTS_USDC_ASSET_ID, MIN_HL_WITHDRAW_USDC } from './hypercore-withdraw.ts';
import { maxSendableUsdc } from './hl-user-signed.ts';
import { demoAssetOf, demoAvailableUsdc, demoHolding, loadDemoLedger, moveDemoBalance } from '../ledger/demo.ts';
import type { RailKind } from './kinds.ts';
import { pricedAs } from '../proposals/draft.ts';
import { TYPICAL_SEC } from '../proposals/view.ts';

// ---------- the knobs ----------

export const DEMO_STAGE_SCALE_ENV = 'PHOSPHOR_DEMO_STAGE_SCALE';
export const DEMO_STALL_ENV = 'PHOSPHOR_DEMO_STALL';
export const DEMO_DEADLINE_ENV = 'PHOSPHOR_DEMO_DEADLINE_SEC';
// The vendor's terminal word a Hyperliquid move ends on instead of SUCCESS: FAILED or REFUNDED.
export const DEMO_PROVIDER_END_ENV = 'PHOSPHOR_DEMO_PROVIDER_END';
// A Hyperliquid deposit whose preflight holds (the Arbitrum gas check fails), so the row goes
// back to approved with the checks on it and the executor retries it; nothing walks.
export const DEMO_HOLD_ENV = 'PHOSPHOR_DEMO_HOLD';
// How often a held row is retried and how long it may hold, in seconds, in place of the
// shipped half minute and quarter hour (src/proposals/execute.ts). Read by demoHeldTiming.
export const DEMO_HELD_RETRY_ENV = 'PHOSPHOR_DEMO_HELD_RETRY_SEC';
export const DEMO_HELD_MAX_ENV = 'PHOSPHOR_DEMO_HELD_MAX_SEC';

export type DemoProviderEnd = 'FAILED' | 'REFUNDED';

export type DemoKnobs = {
  // How long each stage lasts, as a multiple of the defaults below. 1 walks in about 25
  // seconds; 0.1 walks in about two and a half.
  stageScale: number;
  // Stop at PROCESSING and credit nothing, so the deadline is what decides the row.
  stall: boolean;
  // What counts as late in demo mode, in seconds since the decision, in place of the shipped
  // floor of ten minutes (DEADLINE_SEC, src/proposals/view.ts). Null leaves the shipped one.
  deadlineSec: number | null;
  // The Hyperliquid seams: the router's terminal word instead of SUCCESS, and the preflight hold.
  providerEnd: DemoProviderEnd | null;
  hold: boolean;
};

// What every knob reads outside demo mode, whatever the environment says.
const KNOBS_OFF: DemoKnobs = { stageScale: 1, stall: false, deadlineSec: null, providerEnd: null, hold: false };

function flag(value: string | undefined): boolean {
  const word = String(value ?? '').toLowerCase();
  return word === '1' || word === 'true' || word === 'yes';
}

export function demoKnobs(cfg: AppConfig, env: Record<string, string | undefined> = process.env): DemoKnobs {
  if (cfg.mode !== 'demo') return KNOBS_OFF;
  const scale = Number(env[DEMO_STAGE_SCALE_ENV]);
  const deadline = Number(env[DEMO_DEADLINE_ENV]);
  const end = String(env[DEMO_PROVIDER_END_ENV] ?? '').toUpperCase();
  return {
    stageScale: Number.isFinite(scale) && scale > 0 ? scale : 1,
    stall: flag(env[DEMO_STALL_ENV]),
    deadlineSec: Number.isFinite(deadline) && deadline > 0 ? deadline : null,
    providerEnd: end === 'FAILED' || end === 'REFUNDED' ? end : null,
    hold: flag(env[DEMO_HOLD_ENV]),
  };
}

/* The held row's clock, as the executor reads it (PCtx.held). Null in every mode but demo,
   and in demo unless a knob names a number, so the shipped timing is what a mainnet install
   runs on. The lead wires it into createProposalService in src/main.ts. */
export function demoHeldTiming(cfg: AppConfig, env: Record<string, string | undefined> = process.env): { retryMs: number; maxMs: number } | null {
  if (cfg.mode !== 'demo') return null;
  const retry = Number(env[DEMO_HELD_RETRY_ENV]);
  const max = Number(env[DEMO_HELD_MAX_ENV]);
  if (!Number.isFinite(retry) && !Number.isFinite(max)) return null;
  return {
    retryMs: Number.isFinite(retry) && retry > 0 ? retry * 1000 : 30_000,
    maxMs: Number.isFinite(max) && max > 0 ? max * 1000 : 15 * 60_000,
  };
}

/* THE DEMO DEADLINE, as the stall sweep reads it. markStalled takes the clock rather than the
   table, so a demo row is made late by handing the sweep a clock that is already past its
   deadline instead of by editing the shipped one: DEADLINE_SEC stays exactly what a mainnet
   install runs on and nothing demo-only is readable from it.
   The shift is measured off the longest deadline in that table, so a kind with a shorter one
   goes late sooner than the knob says. That is the direction a demo wants to be wrong in.
   Null in every mode but demo, and in demo unless the knob names a number. */
export const LONGEST_DEADLINE_SEC = 1440; // hl_deposit: eight times its typical three minutes

export function demoStallSweep(cfg: AppConfig, env: Record<string, string | undefined> = process.env): { everyMs: number; now: () => number } | null {
  const { deadlineSec } = demoKnobs(cfg, env);
  if (deadlineSec === null) return null;
  const shiftMs = Math.max(0, LONGEST_DEADLINE_SEC - deadlineSec) * 1000;
  // Often enough that a deadline measured in seconds shows up as one: the shipped sweep runs
  // every thirty, which would hide a thirty second demo deadline behind its own period.
  return { everyMs: Math.max(1000, Math.min(30_000, (deadlineSec * 1000) / 4)), now: () => Date.now() + shiftMs };
}

// ---------- the walk ----------

/* Four seconds in each of the five stages this app reports and five more while the venue
   credits it: about twenty five seconds end to end, which is the shape of a real HyperCore
   deposit (typically three minutes) compressed to something a person will sit through. */
const STAGE_MS = 4_000;
const CREDIT_MS = 5_000;

// 1Click's own words, in the order an order that works passes through them. Held as the vendor
// spells them because that is what the row carries and what the card prints.
const WALK = ['KNOWN_DEPOSIT_TX', 'PENDING_DEPOSIT', 'PROCESSING', 'SUCCESS'] as const;

// Where the stall knob stops. The row lands settling on this word, nothing credits it, and the
// deadline is the only thing left that can move it.
const STALL_AT = 'PROCESSING';

// The solver relay's words for a swap, as the relay spells them (src/rails/intents-relay.ts):
// matched, on NEAR, settled. A demo swap walks these so the card shows the stages a real relay
// swap shows; the stall stops it at the match, which is where a real one waits on a solver.
const RELAY_WALK = ['PENDING', 'TX_BROADCASTED', 'SETTLED'] as const;
const RELAY_STALL_AT = 'PENDING';

type Walk = { stages: readonly string[]; stallAt: string; relay: boolean };

// Which words a draft walks: a relay swap walks the relay's, everything else 1Click's.
function walkOf(draft: WriteDraft): Walk {
  if (draft.kind === 'swap' && draft.venue === 'intents-relay') return { stages: RELAY_WALK, stallAt: RELAY_STALL_AT, relay: true };
  return { stages: WALK, stallAt: STALL_AT, relay: false };
}
/* The Hyperliquid kinds walk their own path (KIND_STAGES.hl_deposit and hl_withdraw in
   src/proposals/view.ts): the money starts inside the verifier or on the venue, so there is no
   PENDING_DEPOSIT to wait through, and the router's three words come in the order the card
   prints them. Then `crediting` until the pocket shows the money, then Confirmed. */
const HL_WALK = ['KNOWN_DEPOSIT_TX', 'PROCESSING', 'SUCCESS'] as const;

export type DemoRailDeps = {
  cfg: AppConfig;
  // The ledger read the fixture serves, re-run once a move has changed it, so the settling row
  // is judged against the same balance the wallet panel is about to show. Without it a demo
  // deposit would sit in `crediting` until the app's own fifteen second poll came round.
  refresh: () => Promise<unknown>;
  knobs?: DemoKnobs;
};

export function demoRails(deps: DemoRailDeps): RailRegistry {
  if (deps.cfg.mode !== 'demo') {
    throw new Error(`the demo rail is demo mode only, and this app is in ${deps.cfg.mode} mode`);
  }
  const knobs = deps.knobs ?? demoKnobs(deps.cfg);
  const table = new Map<RailKind, Rail>();
  for (const kind of DEMO_KINDS) table.set(kind, demoRail(kind, deps, knobs));
  // A registry that answers for exactly the kinds it walks, so a draft of any other kind
  // refuses by name rather than reaching a rail that would invent a result for it.
  return {
    for: (draft: WriteDraft) => table.get(draft.kind as RailKind) ?? null,
    kinds: () => [...table.keys()],
  };
}

/* The five kinds that move money between the two pockets or out of them. `trade` is not one:
   a position needs the venue's own book, a mark and a runner, and a fixture has none of those,
   so the trade rail stays absent in demo mode as it always has. */
const DEMO_KINDS: readonly RailKind[] = ['hl_deposit', 'hl_withdraw', 'swap', 'intents_send', 'intents_pay'];

// The rails this module built, so a test can tell a demo registry from a live one without the
// rail having to carry a flag a live rail could also carry.
const built = new WeakSet<Rail>();

export function isDemoRail(rail: Rail | null): boolean {
  return rail !== null && built.has(rail);
}

function demoRail(kind: RailKind, deps: DemoRailDeps, knobs: DemoKnobs): Rail {
  const rail: Rail = {
    kind,
    valueUsd: (draft) => (draft as { amountUsd?: number }).amountUsd ?? 0,
    simulate: async (draft) => simulate(draft),
    execute: (draft, _id, hooks) => walk(draft, hooks, deps, knobs),
  };
  // The floor-free price for a swap, the same fixture arithmetic simulate prices with.
  if (kind === 'swap') rail.quote = async (draft) => swapQuote(draft as SwapDraft)?.out ?? null;
  built.add(rail);
  return rail;
}

// ---------- what a move is worth in demo ----------

/* The fee the walk charges: flat plus proportional for the two bridge crossings, proportional
   alone for a move that stays inside the verifier. Under each rail's own loss floor by enough
   that a demo move settles rather than reading as a short fill, and close enough to the
   measured live numbers (about 0.32 USDC plus 26 bps on a HyperCore deposit) that the card
   shows a figure a person would recognise. */
const FEES: Record<string, { flat: number; bps: number }> = {
  hl_deposit: { flat: 0.3, bps: 25 },
  hl_withdraw: { flat: 0.2, bps: 25 },
  swap: { flat: 0, bps: 10 },
  intents_send: { flat: 0, bps: 10 },
  intents_pay: { flat: 0.1, bps: 10 },
};

function feeFor(kind: string, amount: number): number {
  const rate = FEES[kind] ?? { flat: 0, bps: 0 };
  return Math.min(amount, rate.flat + (amount * rate.bps) / 10_000);
}

// A dollar price for a symbol, from the fixture's own table. Null for anything it cannot price,
// which is what makes a swap refuse at simulation rather than invent a rate.
const DOLLARS = new Set(['USDC', 'USDT', 'DAI', 'USD']);

function demoPrice(symbol: string): number | null {
  const upper = symbol.trim().toUpperCase();
  if (DOLLARS.has(upper)) return 1;
  const price = loadDemoLedger().prices[pricedAs(upper)];
  return typeof price === 'number' && price > 0 ? price : null;
}

// Base units as a decimal string, the way a pocket read carries them. An amount this cannot
// express is zero rather than a throw: a floor of zero settles, and a demo rail is not where a
// bad number should take the app down.
function base(amount: number, decimals: number): string {
  const scaled = Math.round(amount * 10 ** decimals);
  return Number.isFinite(scaled) ? BigInt(Math.max(0, scaled)).toString() : '0';
}

// Trimmed to the asset's own precision, so the card never prints a float's tail.
function units(amount: number, decimals: number): string {
  return String(Number(amount.toFixed(Math.min(decimals, 8))));
}

/* What a swap would get: the two fixture prices with the demo fee taken out of the output.
   Null where the fixture cannot price one of the legs, which a demo should say rather than
   guess: the whole point of the fixture is that every number on the card came from somewhere. */
function swapQuote(draft: SwapDraft): { out: number; feeUsd: number } | null {
  const inPrice = demoPrice(draft.fromSymbol);
  const outPrice = demoPrice(draft.toSymbol);
  if (inPrice === null || outPrice === null) return null;
  const usdIn = draft.amountIn * inPrice;
  const feeUsd = feeFor('swap', usdIn);
  return { out: (usdIn - feeUsd) / outPrice, feeUsd };
}

// ---------- simulation ----------

async function simulate(draft: WriteDraft): Promise<SimulationResult> {
  switch (draft.kind) {
    case 'hl_deposit':
      return simulateHlDeposit(draft);
    case 'hl_withdraw':
      return simulateHlWithdraw(draft);
    case 'swap': {
      const quote = swapQuote(draft);
      if (quote === null) {
        const missing = demoPrice(draft.fromSymbol) === null ? draft.fromSymbol : draft.toSymbol;
        return {
          ok: false,
          summary: `the demo fixture has no price for ${missing}, so this swap cannot be quoted`,
          error: `demo_unpriced_asset:${missing}`,
        };
      }
      if (quote.out < draft.minAmountOut) {
        return {
          ok: false,
          summary: `the demo quote gives ${units(quote.out, 8)} ${draft.toSymbol}, under the ${draft.minAmountOut} floor this asked for`,
          error: 'demo_quote_under_floor',
        };
      }
      const walk = walkOf(draft);
      return {
        ok: true,
        summary: `demo: ${units(draft.amountIn, 8)} ${draft.fromSymbol} becomes about ${units(quote.out, 8)} ${draft.toSymbol} inside NEAR Intents. Nothing is signed and no money moves.`,
        swap: {
          receives: units(quote.out, 8),
          receivesAtLeast: String(draft.minAmountOut),
          feeUsd: quote.feeUsd,
          etaSeconds: Math.round((STAGE_MS * walk.stages.length + CREDIT_MS) / 1000),
          // A relay price lives about a minute and is asked for again at the click; the 1Click
          // demo quote is held to the click the way the live one is.
          priceGoodForSec: walk.relay ? 60 : null,
        },
      };
    }
    case 'intents_send':
    case 'intents_pay': {
      const fee = feeFor(draft.kind, draft.amount);
      const arrives = draft.amount - fee;
      const price = demoPrice(draft.symbol);
      return {
        ok: true,
        summary: `demo: about ${units(arrives, 8)} ${draft.symbol} reaches ${draft.to}. Nothing is signed and no money moves.`,
        send: {
          destinationAsset: draft.originAsset,
          arrives: units(arrives, 8),
          arrivesAtLeast: String(draft.minReceived),
          feeUsd: price === null ? null : fee * price,
          bridgeFee: draft.kind === 'intents_pay' ? units(FEES.intents_pay.flat, 8) : null,
          etaSeconds: Math.round((STAGE_MS * WALK.length) / 1000),
          activity: 'demo mode asks no chain about a receiver, so nothing is known about this one.',
          explorer: null,
        },
      };
    }
    default:
      return { ok: false, summary: `demo mode has no rail for ${draft.kind}`, error: 'demo_no_rail' };
  }
}

/* The Hyperliquid deposit, priced the way the live rail prices it: the same floors (7 USDC in,
   where the nearly flat fee is under the 5 percent ceiling and 5 still lands), the fee split into
   its two parts, and the facts the card draws. A refusal names the floor, so a
   demo of "put 2 dollars on Hyperliquid" reads exactly as it would on mainnet. */
function simulateHlDeposit(draft: HlDepositDraft): SimulationResult {
  const rate = FEES.hl_deposit;
  if (draft.amountUsd < MIN_DEPOSIT_USDC || draft.minCredited < HYPERCORE_VENUE_MIN_CREDIT_USDC) {
    const reason =
      `${units(draft.amount, 6)} ${draft.symbol} is below the ${MIN_DEPOSIT_USDC} USDC floor. Deposits start at ${MIN_DEPOSIT_USDC} USDC because the ` +
      `routing fee is nearly flat (about ${units(rate.flat, 2)} USDC) and would be over ${MAX_FEE_PCT} percent of anything smaller; deposit more at once`;
    return { ok: false, summary: `REFUSED: fund Hyperliquid with ${units(draft.amount, 6)} ${draft.symbol} - ${reason}`, error: reason };
  }
  const fee = feeFor('hl_deposit', draft.amount);
  const appFee = (draft.amount * rate.bps) / 10_000;
  const routing = fee - appFee;
  const credited = draft.amount - fee;
  return {
    ok: true,
    summary: [
      `demo: ${units(draft.amount, 6)} ${draft.symbol} leaves NEAR Intents and about ${units(credited, 6)} ${draft.symbol} reaches the trading account.`,
      `  at least  ${units(draft.minCredited, 6)} USDC, the floor the move is held to`,
      `  cost      ${fee.toFixed(4)} USDC, ${((fee / draft.amount) * 100).toFixed(2)} percent of the deposit`,
      `  routing   ${routing.toFixed(4)} USDC inside the quote`,
      `  app fee   ${appFee.toFixed(4)} USDC, ${rate.bps} bp, inside the quote`,
      'Nothing is signed and no money moves.',
    ].join('\n'),
    send: {
      destinationAsset: HYPERCORE_USDC_ASSET_ID,
      // The floor in both slots, as the live rails do: the chat card draws `arrives` as the
      // landing leg and has no "at least" line for this kind yet.
      arrives: units(draft.minCredited, 6),
      arrivesAtLeast: units(draft.minCredited, 6),
      feeUsd: Number(fee.toFixed(6)),
      bridgeFee: null,
      // The typical the card counts against, off its own table, rather than the demo's own
      // compressed clock: the card and the facts must name one figure (criterion 3.3).
      etaSeconds: TYPICAL_SEC.hl_deposit,
      activity:
        `Two fees, both inside the quote: routing ${units(routing, 6)} USDC and a ${rate.bps} bp app fee (${units(appFee, 6)} USDC); ` +
        `at least ${units(draft.minCredited, 6)} USDC has to land, or nothing is signed.`,
      explorer: null,
    },
  };
}

/* The Hyperliquid withdrawal, priced the way the live rail prices it: the 5 USDC floor, the
   routing leg and app fee inside the quote, the venue's 1 USDC activation fee on top (every
   address 1Click mints is new to the venue), and a short balance refused BEFORE any quote with
   the most that could come back in the sentence (criterion 8.6). */
function simulateHlWithdraw(draft: HlWithdrawDraft): SimulationResult {
  const refuse = (reason: string): SimulationResult => ({
    ok: false,
    summary: `REFUSED: withdraw ${units(draft.amount, 6)} USDC from Hyperliquid - ${reason}`,
    error: reason,
  });
  if (draft.amount < MIN_HL_WITHDRAW_USDC) {
    return refuse(
      `${units(draft.amount, 6)} USDC is below the ${MIN_HL_WITHDRAW_USDC} USDC floor. The cost is nearly flat, about ${units(FEES.hl_withdraw.flat, 2)} USDC of ` +
        `routing plus the ${HL_ACTIVATION_USDC} USDC activation fee the venue charges for the fresh deposit address, so at this size it would be ` +
        'most of the withdrawal; withdraw more at once',
    );
  }
  const available = demoAvailableUsdc();
  const needed = draft.amount + HL_ACTIVATION_USDC;
  if (available < needed) {
    const most = maxSendableUsdc(available, HL_ACTIVATION_USDC);
    const offer =
      most >= MIN_HL_WITHDRAW_USDC
        ? `The most that can come back now is ${units(most, 6)} USDC`
        : `After the fee at most ${units(most, 6)} USDC could come back, under the ${MIN_HL_WITHDRAW_USDC} USDC floor, so nothing can leave until more is on the account`;
    return refuse(
      `the account has ${units(available, 6)} USDC and the withdrawal needs ${units(needed, 6)} USDC: ${units(draft.amount, 6)} plus the ` +
        `${HL_ACTIVATION_USDC} USDC activation fee the venue charges the sender for a destination it has never seen. ${offer}`,
    );
  }
  const rate = FEES.hl_withdraw;
  const inside = feeFor('hl_withdraw', draft.amount);
  const appFee = (draft.amount * rate.bps) / 10_000;
  const routing = inside - appFee;
  const total = inside + HL_ACTIVATION_USDC;
  const received = draft.amount - inside;
  return {
    ok: true,
    summary: [
      `demo: ${units(draft.amount, 6)} USDC leaves the trading account and about ${units(received, 6)} USDC reaches this app's own NEAR Intents balance; no other destination can be named.`,
      `  at least  ${units(draft.minReceived, 6)} USDC, the floor the move is held to`,
      `  cost      ${total.toFixed(4)} USDC, ${((total / draft.amount) * 100).toFixed(2)} percent`,
      `  routing   ${routing.toFixed(4)} USDC inside the quote`,
      `  app fee   ${appFee.toFixed(4)} USDC, ${rate.bps} bp, inside the quote`,
      `  activation ${HL_ACTIVATION_USDC} USDC on top, the venue's charge for a destination it has never seen`,
      '  by hand   always a click, whatever the size',
      'Nothing is signed and no money moves.',
    ].join('\n'),
    send: {
      destinationAsset: INTENTS_USDC_ASSET_ID,
      arrives: units(draft.minReceived, 6),
      arrivesAtLeast: units(draft.minReceived, 6),
      feeUsd: Number(total.toFixed(6)),
      bridgeFee: null,
      etaSeconds: TYPICAL_SEC.hl_withdraw,
      activity:
        `Three fees. Routing ${units(routing, 6)} USDC and a ${rate.bps} bp app fee (${units(appFee, 6)} USDC) come out of the quote. ` +
        `Hyperliquid charges ${HL_ACTIVATION_USDC} USDC on top to open the fresh address 1Click mints, paid by the venue account.`,
      explorer: null,
    },
  };
}

// ---------- the move itself ----------

/* What a kind does to the fixture and what it reports while it does it. `pocket` is set for
   exactly the two kinds whose live rails carry one (a HyperCore deposit and a swap), because
   the pocket is what makes a row settle off a later balance read rather than off the rail's own
   word, and a demo that carried one where mainnet does not would be showing a stage mainnet
   never shows. */
type DemoMove = {
  arrives: number; // what lands, in the destination asset's own units
  decimals: number;
  symbol: string;
  pocket: PocketRead | null;
  credit: () => void;
  detail: string;
};

function moveFor(draft: WriteDraft): DemoMove | null {
  switch (draft.kind) {
    case 'hl_deposit':
      return hlDepositMove(draft);
    case 'hl_withdraw':
      return hlWithdrawMove(draft);
    case 'swap':
      return swapMove(draft);
    case 'intents_send':
    case 'intents_pay':
      return sendMove(draft);
    default:
      return null;
  }
}

function hlDepositMove(draft: HlDepositDraft): DemoMove {
  const credited = draft.amount - feeFor('hl_deposit', draft.amount);
  const spent = demoHolding(draft.originAsset);
  return {
    arrives: credited,
    decimals: HYPERCORE_USDC_DECIMALS,
    symbol: 'USDC',
    pocket: {
      venue: 'hyperliquid',
      account: draft.hlAccount.toLowerCase(),
      assetId: HYPERCORE_USDC_ASSET_ID,
      symbol: 'USDC',
      decimals: HYPERCORE_USDC_DECIMALS,
      before: base(demoAvailableUsdc(), HYPERCORE_USDC_DECIMALS),
      after: null,
      floor: base(draft.minCredited, HYPERCORE_USDC_DECIMALS),
    },
    credit: () => {
      moveDemoBalance({
        intents: spent === null ? [] : [{ ...spent, amount: -draft.amount }],
        hyperliquidUsdc: credited,
      });
    },
    detail: `demo: ${units(credited, 6)} ${draft.symbol} reached the trading account. Nothing was signed and no money moved.`,
  };
}

function hlWithdrawMove(draft: HlWithdrawDraft): DemoMove | null {
  const received = draft.amount - feeFor('hl_withdraw', draft.amount);
  const landing = demoAssetOf(draft.symbol);
  if (landing === null) return null;
  return {
    arrives: received,
    decimals: landing.decimals,
    symbol: draft.symbol,
    // The live withdraw rail reads the verifier either side and confirms only once the credit
    // shows (criterion 8.3), so the demo carries the same pocket: the row sits in `crediting`
    // until the balance the fixture serves rises by the floor.
    pocket: {
      venue: 'intents',
      account: draft.to.toLowerCase(),
      assetId: landing.assetId,
      symbol: landing.symbol,
      decimals: landing.decimals,
      before: base(demoHolding(landing.assetId)?.amount ?? 0, landing.decimals),
      after: null,
      floor: base(draft.minReceived, landing.decimals),
    },
    credit: () => {
      moveDemoBalance({
        intents: [{ ...landing, amount: received }],
        // The venue takes the activation fee beside the amount, so the account falls by both.
        hyperliquidUsdc: -(draft.amount + HL_ACTIVATION_USDC),
      });
    },
    detail: `demo: ${units(received, 6)} ${draft.symbol} reached NEAR Intents. Nothing was signed and no money moved.`,
  };
}

function swapMove(draft: SwapDraft): DemoMove | null {
  const quote = swapQuote(draft);
  const sold = demoAssetOf(draft.fromSymbol);
  const bought = demoAssetOf(draft.toSymbol);
  if (quote === null || sold === null || bought === null) return null;
  return {
    arrives: quote.out,
    decimals: bought.decimals,
    symbol: draft.toSymbol,
    pocket: {
      venue: 'intents',
      account: draft.to.toLowerCase(),
      assetId: bought.assetId,
      symbol: bought.symbol,
      decimals: bought.decimals,
      before: base(demoHolding(bought.assetId)?.amount ?? 0, bought.decimals),
      after: null,
      floor: base(draft.minAmountOut, bought.decimals),
    },
    credit: () => {
      moveDemoBalance({
        intents: [
          { ...sold, amount: -draft.amountIn },
          { ...bought, amount: quote.out },
        ],
      });
    },
    detail: `demo: ${units(quote.out, bought.decimals)} ${draft.toSymbol} is what the balance holds now. Nothing was signed and no money moved.`,
  };
}

function sendMove(draft: IntentsSendDraft | IntentsPayDraft): DemoMove {
  const arrives = draft.amount - feeFor(draft.kind, draft.amount);
  const spent = demoHolding(draft.originAsset) ?? demoAssetOf(draft.symbol);
  return {
    arrives,
    decimals: spent?.decimals ?? 6,
    symbol: draft.symbol,
    // Like the live send rails: the receiver's balance is not this app's to read, so the row
    // confirms on the rail's word rather than on a pocket that would never rise here.
    pocket: null,
    credit: () => {
      moveDemoBalance({ intents: spent === null ? [] : [{ ...spent, amount: -draft.amount }] });
    },
    detail: `demo: ${units(arrives, 8)} ${draft.symbol} reached ${draft.to}. Nothing was signed and no money moved.`,
  };
}

// ---------- the timer ----------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    // A demo walk must never be the reason a process stays up.
    timer.unref?.();
  });
}

function tell(hooks: RailHooks | undefined, evidence: { txids?: string[] } & RailEvidence): void {
  try {
    hooks?.onEvidence?.(evidence);
  } catch {
    // reported by the executor's own persistence, not by this rail
  }
}

// A hash nobody can mistake for a real one: the right shape for the card and the explorer link,
// minted here and known to no chain.
function demoHash(): string {
  return `0x${randomBytes(32).toString('hex')}`;
}

// A NEAR-shaped hash (base58, no 0x) for the relay walk, so the history reads it as the NEAR
// leg the way it reads a real relay swap's. Known to no chain either.
function demoNearHash(): string {
  return base58Encode(Uint8Array.from(randomBytes(32)));
}

// A host that cannot resolve, so a demo link is visibly a demo link and a click reaches nobody.
export const DEMO_EXPLORER = 'https://explorer.demo.invalid/tx/';

async function walk(draft: WriteDraft, hooks: RailHooks | undefined, deps: DemoRailDeps, knobs: DemoKnobs): Promise<RailResult> {
  if (draft.kind === 'hl_deposit' || draft.kind === 'hl_withdraw') return hlWalk(draft, hooks, deps, knobs);
  const move = moveFor(draft);
  if (move === null) return { ok: false, detail: `demo mode has no rail for ${draft.kind}` };

  const stageMs = STAGE_MS * knobs.stageScale;
  const intentHash = demoHash();
  const quote = {
    correlationId: `demo-${randomBytes(6).toString('hex')}`,
    timestamp: new Date().toISOString(),
    signature: 'demo, nothing was signed',
    depositAddress: 'demo, no deposit address was minted',
  };

  const walk = walkOf(draft);
  if (walk.relay) return walkRelaySwap(move, hooks, deps, knobs);

  for (const stage of WALK) {
    await sleep(stageMs);
    if (stage === WALK[0]) {
      // The first report carries what a rail learns when it takes a quote and submits: the
      // handle it would ask the vendor about, and the hash of the intent it signed.
      tell(hooks, { providerStage: stage, txids: [intentHash], handle: quote.correlationId, quote });
    } else if (stage === 'SUCCESS') {
      tell(hooks, {
        providerStage: stage,
        txids: [intentHash, demoHash()],
        settledAmountOut: units(move.arrives, move.decimals),
        explorerUrl: `${DEMO_EXPLORER}${intentHash}`,
      });
    } else {
      tell(hooks, { providerStage: stage });
    }
    /* THE STALL. The vendor is still working, this app has stopped hearing from it, and nothing
       will credit the row: it lands settling on the vendor's own last word, and the deadline is
       the only thing left that can move it (markStalled, src/proposals/execute.ts). The same
       shape a real router that stops answering leaves behind. */
    if (knobs.stall && stage === STALL_AT) {
      return {
        ok: false,
        settling: true,
        detail: 'demo: the router reported PROCESSING and has not answered since. Nothing was signed and no money moved.',
        txids: [intentHash],
        evidence: { providerStage: STALL_AT, handle: quote.correlationId, quote },
        ...(move.pocket === null ? {} : { pocket: move.pocket }),
      };
    }
  }

  // The last reported stage gets its own beat too: a word the card shows for no time at all is
  // a stage nobody watching this could have read.
  await sleep(stageMs);

  const evidence: RailEvidence = {
    providerStage: 'SUCCESS',
    handle: quote.correlationId,
    quote,
    settledAmountOut: units(move.arrives, move.decimals),
    explorerUrl: `${DEMO_EXPLORER}${intentHash}`,
  };

  /* A kind with a pocket settles the way its live rail does: the router is done, the venue has
     not shown the money, and the row waits in `crediting` until a balance read proves it. The
     credit lands after the executor has written that row, and the ledger is re-read on the spot
     so the same read the wallet panel is about to show is what judges it. */
  if (move.pocket !== null) {
    void creditLater(move, deps, CREDIT_MS * knobs.stageScale);
    return {
      ok: false,
      settling: true,
      detail: `demo: the router is done and the venue has not shown it yet. ${move.detail}`,
      txids: [intentHash],
      evidence,
      pocket: move.pocket,
    };
  }

  move.credit();
  await deps.refresh().catch(() => undefined);
  return { ok: true, detail: move.detail, txids: [intentHash], evidence };
}

/* The relay swap's walk: the same seams as the 1Click walk above, with the relay's words and
   the relay's evidence. The first report carries what the live rail hands over the moment the
   signature exists and the publish answers (the nonce, the deadline, the intent hash), the
   second the NEAR hash the relay reports once the transaction is broadcast, the third the
   settled word; the row then lands settling on its pocket and the credit lands after, exactly
   as a live relay swap does. The stall stops at the match with nothing credited. */
async function walkRelaySwap(move: DemoMove, hooks: RailHooks | undefined, deps: DemoRailDeps, knobs: DemoKnobs): Promise<RailResult> {
  const stageMs = STAGE_MS * knobs.stageScale;
  const intentHash = demoNearHash();
  const nearHash = demoNearHash();
  const nonce = Buffer.from(randomBytes(32)).toString('base64');
  const deadline = new Date(Date.now() + 120_000).toISOString();
  const explorerUrl = `${DEMO_EXPLORER}${nearHash}`;
  const signed = { handle: intentHash, nonce, deadline };

  for (const stage of RELAY_WALK) {
    await sleep(stageMs);
    if (stage === 'PENDING') {
      tell(hooks, { providerStage: stage, txids: [intentHash], ...signed });
    } else if (stage === 'TX_BROADCASTED') {
      tell(hooks, { providerStage: stage, txids: [intentHash, nearHash], explorerUrl });
    } else {
      tell(hooks, { providerStage: stage, settledAmountOut: units(move.arrives, move.decimals) });
    }
    if (knobs.stall && stage === RELAY_STALL_AT) {
      return {
        ok: false,
        settling: true,
        detail: `demo: the swap is sent and no solver has matched it since. Nothing was signed and no money moved.`,
        txids: [intentHash],
        evidence: { providerStage: RELAY_STALL_AT, ...signed },
        ...(move.pocket === null ? {} : { pocket: move.pocket }),
      };
    }
  }
  await sleep(stageMs);

  const evidence: RailEvidence = {
    providerStage: 'SETTLED',
    ...signed,
    settledAmountOut: units(move.arrives, move.decimals),
    explorerUrl,
  };
  if (move.pocket !== null) {
    void creditLater(move, deps, CREDIT_MS * knobs.stageScale);
    return {
      ok: false,
      settling: true,
      detail: `demo: the swap settled and the balance has not shown it yet. ${move.detail}`,
      txids: [intentHash, nearHash],
      evidence,
      pocket: move.pocket,
    };
  }
  move.credit();
  await deps.refresh().catch(() => undefined);
  return { ok: true, detail: move.detail, txids: [intentHash, nearHash], evidence };
}

async function creditLater(move: DemoMove, deps: DemoRailDeps, afterMs: number): Promise<void> {
  await sleep(afterMs);
  move.credit();
  await deps.refresh().catch(() => undefined);
}

// ---------- the Hyperliquid walk ----------

/* The five checks a live deposit runs before the intent is signed (src/preflight/index.ts), as
   the hold seam reports them: the Arbitrum sweep blocked by gas, everything else fine. The same
   shape the card's checks fold draws, and a hold reason in the preflight's own words. */
function heldPreflight(at: string): NonNullable<RailResult['preflight']> {
  return {
    at,
    verdict: 'hold',
    holdReason: 'Waiting for Arbitrum gas to settle',
    checks: [
      { id: 'gas', label: 'Arbitrum gas', state: 'fail', value: '300,024 / 300,000', detail: 'The sweep that lands this on Hyperliquid needs more gas than Arbitrum allows a transaction right now.', limit: 300_000 },
      { id: 'coverage', label: 'Fee covers the payout', state: 'ok', value: '2.3x', detail: 'The fee inside the quote covers the payout with room to spare.' },
      { id: 'venue', label: 'NEAR Intents answers', state: 'ok', value: 'Answering', detail: 'A dry quote and a status read both came back.' },
      { id: 'balance', label: 'Balance', state: 'ok', value: 'Covered', detail: 'The balance inside NEAR Intents covers this move.' },
      { id: 'deadline', label: 'Quote deadline', state: 'ok', value: '9 min', detail: 'The quote holds long enough to sign against.' },
    ],
  };
}

/* KNOWN_DEPOSIT_TX, PROCESSING, SUCCESS, then `crediting` until the pocket shows the money, then
   Confirmed: the walk a real HyperCore move reports, on a timer, through the executor's own
   seams. Four seams beside it, each the shape its live counterpart leaves behind:
     hold        (PHOSPHOR_DEMO_HOLD, deposits) the preflight says wait, nothing walks, the row
                 goes back to approved with the checks on it and the executor retries it;
     stall       (PHOSPHOR_DEMO_STALL) the router says PROCESSING and never answers again;
     FAILED      (PHOSPHOR_DEMO_PROVIDER_END) the router could not finish and refunded nothing yet;
     REFUNDED    (PHOSPHOR_DEMO_PROVIDER_END) the router sent the money back.
   The walk debits nothing before the router's terminal word, so a refund seam leaves the
   fixture exactly as it found it, which is what a refund means. */
async function hlWalk(draft: HlDepositDraft | HlWithdrawDraft, hooks: RailHooks | undefined, deps: DemoRailDeps, knobs: DemoKnobs): Promise<RailResult> {
  const move = moveFor(draft);
  if (move === null) return { ok: false, detail: `demo mode has no rail for ${draft.kind}` };
  const stageMs = STAGE_MS * knobs.stageScale;

  if (knobs.hold && draft.kind === 'hl_deposit') {
    const preflight = heldPreflight(new Date().toISOString());
    try {
      hooks?.onPreflight?.(preflight);
    } catch {
      // the row is the executor's to write
    }
    return { ok: false, held: true, detail: `${preflight.holdReason}. Nothing was signed.`, preflight };
  }

  const intentHash = demoHash();
  const quote = {
    correlationId: `demo-${randomBytes(6).toString('hex')}`,
    timestamp: new Date().toISOString(),
    signature: 'demo, nothing was signed',
    depositAddress: 'demo, no deposit address was minted',
  };
  // A withdrawal's first evidence is the venue nonce of the send it signed; a deposit's is the
  // hash of the intent. Both are what the sweep asks the venue by, and both reach the row
  // before the wait (criterion 8.5).
  const nonce = String(Date.now());
  const firstWord = (stage: string): RailEvidence & { txids?: string[] } =>
    draft.kind === 'hl_withdraw'
      ? { providerStage: stage, txids: [intentHash], handle: quote.correlationId, nonce, quote }
      : { providerStage: stage, txids: [intentHash], handle: quote.correlationId, quote };
  const kept = draft.kind === 'hl_withdraw' ? { handle: quote.correlationId, nonce, quote } : { handle: quote.correlationId, quote };

  for (const stage of HL_WALK) {
    await sleep(stageMs);
    if (stage === HL_WALK[0]) {
      tell(hooks, firstWord(stage));
    } else if (stage === 'PROCESSING' && knobs.providerEnd !== null) {
      tell(hooks, { providerStage: stage });
      await sleep(stageMs);
      tell(hooks, { providerStage: knobs.providerEnd });
      const refundTo = draft.kind === 'hl_deposit' ? 'the balance inside NEAR Intents' : 'the venue account';
      if (knobs.providerEnd === 'REFUNDED') {
        return {
          ok: false,
          detail: `REFUNDED: ${units(draft.amount, 6)} USDC went back to ${refundTo}. The router could not finish the move. Nothing was signed and no money moved.`,
          txids: [intentHash],
          evidence: { ...kept, providerStage: 'REFUNDED', refundedAmount: units(draft.amount, 6) },
        };
      }
      return {
        ok: false,
        detail: `the router reported FAILED and refunded 0 USDC so far, reason not given. The input is held by the router under handle ${quote.correlationId} until a refund shows in your balance. Nothing was signed and no money moved.`,
        txids: [intentHash],
        evidence: { ...kept, providerStage: 'FAILED', refundedAmount: '0', refundReason: 'not given' },
      };
    } else if (stage === 'SUCCESS') {
      tell(hooks, {
        providerStage: stage,
        txids: [intentHash, demoHash()],
        settledAmountOut: units(move.arrives, move.decimals),
        explorerUrl: `${DEMO_EXPLORER}${intentHash}`,
      });
    } else {
      tell(hooks, { providerStage: stage });
    }
    if (knobs.stall && stage === STALL_AT) {
      return {
        ok: false,
        settling: true,
        detail: 'demo: the router reported PROCESSING and has not answered since. Nothing was signed and no money moved.',
        txids: [intentHash],
        evidence: { ...kept, providerStage: STALL_AT },
        ...(move.pocket === null ? {} : { pocket: move.pocket }),
      };
    }
  }

  // The last reported stage gets its own beat too: a word the card shows for no time at all is
  // a stage nobody watching this could have read.
  await sleep(stageMs);

  const evidence: RailEvidence = {
    ...kept,
    providerStage: 'SUCCESS',
    settledAmountOut: units(move.arrives, move.decimals),
    explorerUrl: `${DEMO_EXPLORER}${intentHash}`,
  };

  // Both Hyperliquid kinds carry a pocket, so both settle the way their live rails do: the router
  // is done, the venue has not shown the money, and the row waits in `crediting` until a balance
  // read proves it. The credit lands after the executor has written that row.
  if (move.pocket !== null) {
    void creditLater(move, deps, CREDIT_MS * knobs.stageScale);
    return {
      ok: false,
      settling: true,
      detail: `demo: the router is done and the venue has not shown it yet. ${move.detail}`,
      txids: [intentHash],
      evidence,
      pocket: move.pocket,
    };
  }

  move.credit();
  await deps.refresh().catch(() => undefined);
  return { ok: true, detail: move.detail, txids: [intentHash], evidence };
}
