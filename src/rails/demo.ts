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
import { HYPERCORE_USDC_ASSET_ID, HYPERCORE_USDC_DECIMALS } from './hypercore-deposit.ts';
import { demoAssetOf, demoAvailableUsdc, demoHolding, loadDemoLedger, moveDemoBalance } from '../ledger/demo.ts';
import type { RailKind } from './kinds.ts';

// ---------- the knobs ----------

export const DEMO_STAGE_SCALE_ENV = 'PHOSPHOR_DEMO_STAGE_SCALE';
export const DEMO_STALL_ENV = 'PHOSPHOR_DEMO_STALL';
export const DEMO_DEADLINE_ENV = 'PHOSPHOR_DEMO_DEADLINE_SEC';

export type DemoKnobs = {
  // How long each stage lasts, as a multiple of the defaults below. 1 walks in about 25
  // seconds; 0.1 walks in about two and a half.
  stageScale: number;
  // Stop at PROCESSING and credit nothing, so the deadline is what decides the row.
  stall: boolean;
  // What counts as late in demo mode, in seconds since the decision, in place of the shipped
  // floor of ten minutes (DEADLINE_SEC, src/proposals/view.ts). Null leaves the shipped one.
  deadlineSec: number | null;
};

// What every knob reads outside demo mode, whatever the environment says.
const KNOBS_OFF: DemoKnobs = { stageScale: 1, stall: false, deadlineSec: null };

export function demoKnobs(cfg: AppConfig, env: Record<string, string | undefined> = process.env): DemoKnobs {
  if (cfg.mode !== 'demo') return KNOBS_OFF;
  const scale = Number(env[DEMO_STAGE_SCALE_ENV]);
  const deadline = Number(env[DEMO_DEADLINE_ENV]);
  const stall = String(env[DEMO_STALL_ENV] ?? '').toLowerCase();
  return {
    stageScale: Number.isFinite(scale) && scale > 0 ? scale : 1,
    stall: stall === '1' || stall === 'true' || stall === 'yes',
    deadlineSec: Number.isFinite(deadline) && deadline > 0 ? deadline : null,
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
  const price = loadDemoLedger().prices[upper === 'WETH' ? 'ETH' : upper];
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
    case 'hl_deposit': {
      const credited = draft.amount - feeFor('hl_deposit', draft.amount);
      return {
        ok: true,
        summary:
          `demo: ${units(draft.amount, 6)} ${draft.symbol} leaves NEAR Intents and about ` +
          `${units(credited, 6)} ${draft.symbol} reaches the trading account. Nothing is signed and no money moves.`,
      };
    }
    case 'hl_withdraw': {
      const received = draft.amount - feeFor('hl_withdraw', draft.amount);
      return {
        ok: true,
        summary:
          `demo: ${units(draft.amount, 6)} USDC leaves the trading account and about ` +
          `${units(received, 6)} USDC reaches NEAR Intents. Nothing is signed and no money moves.`,
      };
    }
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
      return {
        ok: true,
        summary: `demo: ${units(draft.amountIn, 8)} ${draft.fromSymbol} becomes about ${units(quote.out, 8)} ${draft.toSymbol} inside NEAR Intents. Nothing is signed and no money moves.`,
        swap: {
          receives: units(quote.out, 8),
          receivesAtLeast: String(draft.minAmountOut),
          feeUsd: quote.feeUsd,
          etaSeconds: Math.round((STAGE_MS * WALK.length + CREDIT_MS) / 1000),
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

function hlWithdrawMove(draft: HlWithdrawDraft): DemoMove {
  const received = draft.amount - feeFor('hl_withdraw', draft.amount);
  const landing = demoAssetOf(draft.symbol);
  return {
    arrives: received,
    decimals: landing?.decimals ?? 6,
    symbol: draft.symbol,
    // The live withdraw rail carries no pocket read, so neither does this: the row confirms on
    // the rail's own word and never sits in `crediting`.
    pocket: null,
    credit: () => {
      moveDemoBalance({
        intents: landing === null ? [] : [{ ...landing, amount: received }],
        hyperliquidUsdc: -draft.amount,
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

// A host that cannot resolve, so a demo link is visibly a demo link and a click reaches nobody.
export const DEMO_EXPLORER = 'https://explorer.demo.invalid/tx/';

async function walk(draft: WriteDraft, hooks: RailHooks | undefined, deps: DemoRailDeps, knobs: DemoKnobs): Promise<RailResult> {
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

async function creditLater(move: DemoMove, deps: DemoRailDeps, afterMs: number): Promise<void> {
  await sleep(afterMs);
  move.credit();
  await deps.refresh().catch(() => undefined);
}
