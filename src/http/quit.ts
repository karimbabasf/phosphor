// What quitting would interrupt, read off state the app already keeps, for the window's quit sheet.
//
// Nothing here tracks anything new and nothing here stops anything: the quit itself is the shell's
// SIGTERM and src/shutdown.ts, whatever this said. This only names, in the sheet's own words, what
// is running and what happens to it, so a person can quit knowing where their money stands.
//
// Three facts decide every line, each checked in the code it names:
//   A signed move finishes at the venue without this process. The boot sweep turns whatever was
//   mid-flight into a row the venue is asked about, at boot and every ten minutes after
//   (reconcileOnBoot and reconcileOpen in src/proposals/reconcile.ts, wired in src/main.ts).
//   A move held by its checks has signed nothing, and the boot sweep closes it (expireHold).
//   A plan's watcher and its stop-on-fill run in THIS process (src/runner/host.ts, tick and
//   onAccount). A waiting plan cannot fire while the app is closed, and a resting entry that
//   fills while it is closed has no stop until the app is open and unlocked again.

import type http from 'node:http';

import type { Proposal, WriteDraft } from '../types.ts';
import type { PlanRow } from '../trade/plans.ts';
import type { DepositState } from '../vault/watch.ts';
import { moveStateOf, stageOf } from '../proposals/view.ts';
import { sendJson } from './respond.ts';
import type { Ctx } from './context.ts';

export type QuitLine = {
  // Which line this is, for the window's icon. Never shown.
  kind: 'entry' | 'moving' | 'held' | 'plan' | 'agent' | 'yours' | 'venue' | 'incoming';
  // warn: money can be exposed. note: something stops or waits. safe: it carries on by itself.
  tone: 'warn' | 'note' | 'safe';
  lead: string;
  rest: string;
};

export type QuitReport = {
  // Ids of moves already signed or on their way. "Quit when it lands" waits for this to empty.
  moving: string[];
  // Ids of moves waiting for the person's click.
  waiting: string[];
  agent: boolean;
  // Plan ids whose watcher runs only while the app is open.
  watching: string[];
  // Plan ids with an entry resting at the venue and no stop yet.
  unprotected: string[];
  lines: QuitLine[];
};

export type QuitInputs = {
  proposals: Proposal[];
  plans: PlanRow[];
  agentAnswering: boolean;
  venueHeld: number;
  deposit: DepositState | null;
};

const NOUN: Record<WriteDraft['kind'], string> = {
  swap: 'swap',
  intents_send: 'send',
  intents_pay: 'payment',
  hl_deposit: 'transfer to your trading account',
  hl_withdraw: 'transfer from your trading account',
  trade: 'trade',
  policy_change: 'change',
};

function one(rows: Proposal[], single: (noun: string) => string, many: (n: number) => string): string {
  return rows.length === 1 ? single(NOUN[rows[0].kind]) : many(rows.length);
}

export function quitReport(input: QuitInputs): QuitReport {
  const moving: Proposal[] = [];
  const held: Proposal[] = [];
  const waiting: Proposal[] = [];
  for (const p of input.proposals) {
    const stage = stageOf(p);
    // A stalled row is late and already on the venue's clock; an acknowledged one the person has
    // filed. Neither is something quitting interrupts, and a wait on them would never end.
    if (stage === 'stalled' || p.acknowledgedAt !== undefined) continue;
    const state = moveStateOf(stage);
    if (state === 'needs_you') waiting.push(p);
    else if (stage === 'held') held.push(p);
    else if (state === 'working') moving.push(p);
  }
  const watching = input.plans.filter((r) => r.status === 'waiting' && r.locked !== true);
  const unprotected = input.plans.filter((r) => r.status === 'placed');
  const incoming = input.deposit !== null && (input.deposit.phase === 'watching' || input.deposit.phase === 'seen' || input.deposit.phase === 'bridged');

  const lines: QuitLine[] = [];
  for (const row of unprotected) {
    lines.push({
      kind: 'entry',
      tone: 'warn',
      lead: `Your ${row.symbol} entry is waiting at Hyperliquid with no stop yet.`,
      rest: 'Phosphor adds the stop when it fills. If it fills while Phosphor is closed, it has no stop until you open Phosphor and unlock.',
    });
  }
  if (moving.length > 0) {
    lines.push({
      kind: 'moving',
      tone: 'safe',
      lead: one(moving, (noun) => `Your ${noun} is on its way.`, (n) => `${n} moves are on their way.`),
      rest:
        moving.length === 1
          ? 'It finishes without Phosphor, and you see how it ended when you open Phosphor again.'
          : 'They finish without Phosphor, and you see how they ended when you open Phosphor again.',
    });
  }
  if (held.length > 0) {
    lines.push({
      kind: 'held',
      tone: 'note',
      lead: one(held, (noun) => `Your ${noun} is waiting for its checks.`, (n) => `${n} moves are waiting for their checks.`),
      rest: held.length === 1 ? 'Quitting cancels it. Nothing is signed, so nothing moves.' : 'Quitting cancels them. Nothing is signed, so nothing moves.',
    });
  }
  if (watching.length > 0) {
    lines.push({
      kind: 'plan',
      tone: 'note',
      lead: watching.length === 1 ? `Your ${watching[0].symbol} ${watching[0].side} is watching the chart.` : `${watching.length} plans are watching the chart.`,
      rest: watching.length === 1 ? 'It can only fire while Phosphor is open.' : 'They can only fire while Phosphor is open.',
    });
  }
  if (input.agentAnswering) {
    lines.push({ kind: 'agent', tone: 'note', lead: 'Your agent is still answering.', rest: 'Quitting stops it mid-reply.' });
  }
  if (waiting.length > 0) {
    lines.push({
      kind: 'yours',
      tone: 'safe',
      lead: waiting.length === 1 ? 'A move is waiting for your OK.' : `${waiting.length} moves are waiting for your OK.`,
      rest: 'Nothing moves without you.',
    });
  }
  if (input.venueHeld > 0) {
    lines.push({ kind: 'venue', tone: 'safe', lead: 'Your positions and orders stay at Hyperliquid.', rest: 'They keep working while Phosphor is closed.' });
  }
  if (incoming) {
    lines.push({ kind: 'incoming', tone: 'safe', lead: 'Money you are adding still arrives.', rest: 'You see it in your balance when you open Phosphor again.' });
  }

  return {
    moving: moving.map((p) => p.id),
    waiting: waiting.map((p) => p.id),
    agent: input.agentAnswering,
    watching: watching.map((r) => r.id),
    unprotected: unprotected.map((r) => r.id),
    lines,
  };
}

export function quitInputs(ctx: Ctx): QuitInputs {
  const trade = ctx.trade.payload();
  return {
    proposals: ctx.proposals.list(),
    plans: trade.plans,
    agentAnswering: ctx.chats.all().some((chat) => chat.driver.status().state === 'thinking'),
    venueHeld: trade.positions.length + trade.orders.length,
    deposit: ctx.deposits.current(),
  };
}

export function sendQuitStatus(ctx: Ctx, res: http.ServerResponse): void {
  sendJson(res, 200, quitReport(quitInputs(ctx)));
}
