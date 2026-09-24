// The propose door: what an agent gets back, the four boundary checks every kind shares, and
// the kinds themselves.
//
// The checks here are boundaries only. A wrong type or an unknown chain is answered here, and
// every question about the VALUE of a number (too big, zero, negative) is left to the policy
// engine and the rails, so money rules stay in one place.

import type http from 'node:http';

import type { ChainId, ClientKey, Proposal } from '../types.ts';
import { CLIENT_KEY_PATTERN, CLIENT_KEY_WINDOW_MS } from '../types.ts';
import { fingerprint } from '../duplicates.ts';
import { amountAsk } from '../intents.ts';
import { spendNetworkOf } from '../rails/intents-address.ts';
import { asRecord, errText, fail, sendJson } from './respond.ts';
import type { JsonBody } from './respond.ts';
import { CHAINS, PROPOSE_KINDS } from './context.ts';
import type { Ctx } from './context.ts';

/* THE REPLY IS THE DECISION, NEVER THE SETTLEMENT.
   This used to wait up to twenty seconds for the rail before answering, so the card in the
   conversation appeared that long after the agent's call: Karim clicked, then watched nothing
   happen. The decision is made the moment the policy allows or the person clicks, and the
   executor has the `executing` row on disk before the rail's first network call. That row, with
   its view, is the answer. The card draws on it and moves from there on the per-proposal SSE
   frame, so the window shows the stage while the venue is still working.
   The 2026-09-15 incident this replaces is still covered, and harder than before: no propose
   reply ever outlives the proxy's thirty second budget, because none of them waits at all. */

// What the agent gets back from any propose: the id to poll, what the policy decided, what
// the simulation said, the view the card draws, and what the rail said if it has answered.
// Never the draft itself, so the app's resolved addresses are not echoed to the caller that was
// deliberately not allowed to name them. The one exception is a send (sendFacts below): the
// receiver is the address the caller itself named, so echoing it as the chain spells it gives
// nothing away, and the card in the conversation needs that spelling rather than the argument.
// The rail's sentence rides along because it is the one that says "do not send this again", and
// a reply that carried only the status word left the agent reading `failed` as a cue to retry.
function sendProposal(ctx: Ctx, res: http.ServerResponse, proposal: Proposal): void {
  ctx.sse.broadcastState();
  // The simulation without its engineer's lines: the agent reads this reply and says the summary.
  const { developer: _developer, ...simulation } = proposal.simulation ?? { developer: undefined };
  sendJson(res, 200, {
    id: proposal.id,
    status: proposal.status,
    verdict: proposal.verdict,
    simulation: proposal.simulation === null ? null : simulation,
    view: ctx.proposals.view(proposal),
    ...(proposal.result === undefined ? {} : { result: proposal.result }),
    ...sendFacts(proposal),
  });
}

/* The reply carries no draft, and a send card in the conversation has to draw the address the
   app decoded and the receiver's history rather than the agent's own argument. So a send answers
   with the few normalised facts the card needs (ui/screens/sendcard.js viewOfToolData): what
   kind of send, where, to whom as the chain spells it, and what the recipients book knows. */
function sendFacts(proposal: Proposal): { send?: Record<string, unknown> } {
  const draft = proposal.draft;
  if (draft.kind !== 'intents_send' && draft.kind !== 'intents_pay') return {};
  const r = draft.recipient;
  return {
    send: {
      kind: draft.kind,
      where: 'network' in draft ? draft.network : 'intents',
      to: draft.to,
      symbol: draft.symbol,
      amount: draft.amount,
      amountUsd: draft.amountUsd,
      recipient: r === undefined ? null : { known: r.known, count: r.count, lastAt: r.lastAt, ownAddress: r.ownAddress },
    },
  };
}

// Boundary checks only: a wrong type or an unknown chain is answered here, and every
// question about the value of a number (too big, zero, negative) is left to the policy
// engine and the rails, so money rules stay in one place.
export function numField(params: JsonBody, name: string, problems: string[]): number {
  const raw = params[name];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    problems.push(`${name} must be a finite number`);
    return NaN;
  }
  return raw;
}

/* A number that must be above zero, at the edge.
   The header above says value questions belong to the policy engine, and mostly they do: too
   big, too much of the portfolio, over the day's cap. Zero and negative are different. They are
   not amounts at all, and the engine budgets on `amountUsd` derived from them, so a negative one
   arrives as a NEGATIVE spend that makes the cap look emptier than it is, and 1e308 arrives as
   Infinity. Neither is a policy question; both are a caller sending something that is not a
   quantity. `numField` already rejects NaN and Infinity, so this only has to rule out the sign
   and the zero. */
function positiveField(params: JsonBody, name: string, problems: string[]): number {
  const value = numField(params, name, problems);
  if (!Number.isFinite(value)) return value; // numField has already said so
  if (value <= 0) {
    problems.push(`${name} must be greater than 0`);
    return value;
  }
  /* And an upper bound, which is not the same kind of rule as the policy engine's.
     MAX_SAFE_INTEGER is where a double stops being able to represent whole numbers exactly, so
     above it every figure derived from this one is already wrong before any limit is consulted:
     multiply 1e308 by a price and the answer is Infinity, and "Infinity cannot be checked
     against a limit" is a refusal that arrives by accident of the arithmetic rather than by a
     rule. A number this large is not an amount somebody meant. How much is TOO MUCH remains the
     policy engine's question, and this does not answer it. */
  if (value > Number.MAX_SAFE_INTEGER) {
    problems.push(`${name} is larger than this app can represent exactly (${Number.MAX_SAFE_INTEGER} is the ceiling)`);
  }
  return value;
}

/* What each free-text field on this door may hold. A symbol is a ticker, an address is at most a
   64-character NEAR id, a note is one line, a policy sentence is a short paragraph. Before these,
   the only bound was the 1 MiB body cap: a 900 KiB symbol went through into the refusal reason,
   proposals.json and every state frame after it. Over the cap is a 400 that names the field,
   like every other shape problem here. */
export const SYMBOL_MAX = 16;
// A swap names its coins by ticker or by the venue's asset id, and an id runs past 50 characters.
export const SWAP_SYMBOL_MAX = 128;
export const ADDRESS_MAX = 128;
export const WHERE_MAX = 32;
export const ID_MAX = 64;
export const NOTE_MAX = 280;
export const SENTENCE_MAX = 1000;

function strField(params: JsonBody, name: string, problems: string[], max: number): string {
  const raw = params[name];
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    problems.push(`${name} is required`);
    return '';
  }
  const value = raw.trim();
  if (value.length > max) {
    problems.push(`${name} is ${value.length} characters, over the ${max} this field takes`);
    return '';
  }
  return value;
}

/* null on an unknown chain, never a sentinel.
   This used to return 'eth'. Every caller checks `problems.length` before using the value, so it
   was latent rather than live, but the next branch that forgets silently drafts a transaction
   against Ethereum: the wrong chain, the wrong token contracts, and a caller who named something
   else entirely. A null cannot be spent by accident, and the type says so. */
export function chainField(params: JsonBody, name: string, problems: string[]): ChainId | null {
  const raw = String(params[name] ?? '');
  if (!CHAINS.includes(raw)) {
    problems.push(`${name} must be one of: ${CHAINS.join(', ')}`);
    return null;
  }
  return raw as ChainId;
}

/* A swap's chains name where each COIN is from, so any chain the venue lists a coin on is a
   chain a swap may name: the registry the MCP enum is built from (spendNetworkOf), not the five
   pinned ones. The door answered "toChain must be one of: eth, base, arb, sol, near" to a swap
   into BTC while the tool's own schema offered 36 (R1, 2026-09-23). */
function swapChainField(params: JsonBody, name: string, problems: string[]): string | null {
  const raw = String(params[name] ?? '').trim().toLowerCase();
  const net = spendNetworkOf(raw);
  if (net === undefined || net.venue === null) {
    problems.push(`${name} must be a chain id the deposit card offers, such as eth, base, arb, sol, near or btc`);
    return null;
  }
  return net.id;
}

/* "all", an exact decimal string, or a positive number; anything else is named here. The value
   question (more than is held) is the builder's, which reads the balance. */
function swapAmountField(params: JsonBody, name: string, problems: string[]): number | string {
  const raw = params[name];
  if (typeof raw === 'number') return positiveField(params, name, problems);
  if (amountAsk(raw) === null) {
    problems.push(`${name} must be "all" or an exact amount above zero written as a decimal, such as "0.5"`);
    return '';
  }
  return raw as string;
}

export async function handlePropose(ctx: Ctx, body: JsonBody, res: http.ServerResponse): Promise<void> {
  const kind = String(body.kind ?? '');
  const params = asRecord(body.params);
  const session = String(body.session ?? 'unnamed-session');
  // The seat a row records as its proposer: only a seat that was actually named. The
  // placeholder above keeps the duplicate guard working for a caller with no session and is
  // not a seat anything could be told on.
  const by = typeof body.session === 'string' && body.session !== '' ? body.session : undefined;
  /* A worker's MCP process never registers a propose tool, and this is the wall behind that one:
     the app minted the worker's session id and seated it as an analyst, so a raw post from that
     seat is refused by its role before the duplicate guard remembers it or a draft is priced.
     Nothing in the chain that spawned a worker is a human, so nothing in it may reach the money. */
  if (ctx.agents.member(body.session)?.role === 'analyst') {
    fail(res, 403, `propose_${kind} is not on a worker's surface`);
    return;
  }

  /* THE IDEMPOTENCY KEY, read and taken off the params before anything else looks at them.
     A proposer that sends the same key twice is answered with the row that key already made,
     for a day: an agent whose reply was lost (the incident: a propose that outlived the proxy)
     repeats with the key and gets the same proposal back, never a second spend. It is kept out
     of the fingerprint below, so a key does not turn one agent's two different-keyed calls into
     two proposals the duplicate guard would have caught, nor make a repeat look new.
     SCOPED TO THIS SESSION AND THIS KIND. The namespace was global once: agent B filing a
     withdraw under a key agent A had used for a deposit was answered 200 with A's row, read
     "executed", and its withdraw never ran. Another session's key never matches, another kind
     under the same key is a new move, and the same key sent with other params is refused with
     the row's id rather than answered with a row that moved something else. */
  let clientKey: ClientKey | undefined;
  if (params.clientKey !== undefined) {
    if (typeof params.clientKey !== 'string' || !CLIENT_KEY_PATTERN.test(params.clientKey)) {
      fail(res, 400, 'clientKey must be 1 to 64 characters of letters, digits, and _ . : -');
      return;
    }
    const key = params.clientKey;
    delete params.clientKey;
    clientKey = { key, session, kind, fingerprint: fingerprint(kind, params) };
    const existing = ctx.proposals
      .list()
      .find(
        (p) =>
          p.clientKey?.key === key &&
          p.clientKey.session === session &&
          p.clientKey.kind === kind &&
          Date.now() - Date.parse(p.createdAt) < CLIENT_KEY_WINDOW_MS,
      );
    if (existing !== undefined && existing.clientKey?.fingerprint !== clientKey.fingerprint) {
      ctx.audit.append('agent_rejected', 'a propose reused a client key with different params and was refused', {
        kind,
        existing: existing.id,
        clientKey: key,
      });
      fail(
        res,
        409,
        `clientKey ${key} already names a ${kind} this session proposed with different params (proposal ${existing.id}). ` +
          `A key is one move: read proposal_status ${existing.id}, and choose a new key for a new move.`,
        { existing: existing.id, status: existing.status },
      );
      return;
    }
    if (existing !== undefined) {
      ctx.audit.append('agent_rejected', 'a propose carrying a known client key was answered with the row it already made', {
        kind,
        existing: existing.id,
        clientKey: key,
      });
      sendProposal(ctx, res, existing);
      return;
    }
  }

  const clash = ctx.duplicates.find(kind, params, session);
  if (clash !== null) {
    const own = clash.session === session;
    ctx.audit.append('agent_rejected', own ? 'a caller repeating a proposal still in flight was refused' : 'a duplicate proposal from a second agent was refused', {
      kind,
      existing: clash.id,
      by: clash.session,
    });
    // An empty id means the proposal is still being drafted, which is exactly the race this
    // guard exists for. There is nothing to read yet, so the sentence does not offer. When the
    // row exists, its status and result ride on the refusal so the caller sees what its repeat
    // would have doubled without a second call.
    const existing = clash.id === '' ? undefined : ctx.proposals.get(clash.id);
    const names = clash.id === '' ? '' : ` (proposal ${clash.id})`;
    // An unconfirmed first move is the incident's exact shape: the money may be live at the
    // venue, and "in flight" would under-describe it to an agent deciding whether to send again.
    const unconfirmed = own && existing?.status === 'needs_reconciliation';
    const lead = unconfirmed
      ? `this ${kind} was sent by this session moments ago${names} and the first one is still unconfirmed, so this repeat was not filed; read proposal_status ${clash.id}.`
      : own
        ? `this ${kind} is still in flight${names}, so a repeat of it is refused rather than sending it twice.`
        : `another agent proposed exactly this ${kind} moments ago${names}. It has not been superseded, so this one is refused rather than doubling it.`;
    fail(
      res,
      409,
      unconfirmed ? lead : `${lead} Read it with proposal_status before repeating anything.`,
      {
        duplicate: clash.id,
        ...(existing === undefined ? {} : { status: existing.status, ...(existing.result === undefined ? {} : { result: existing.result }) }),
      },
    );
    return;
  }

  /* THE CLAIM, made in the same tick as the check above, and that pair is the whole fix.
     This used to be recorded only once the proposal had landed, with the entire draft, quote and
     policy pipeline awaited in between, so two identical requests arriving together both found an
     empty memory and both went through. Nothing downstream catches that: each proposal is
     individually correct, and only the pair is wrong.
     There is no id yet, so the entry carries an empty one and is rewritten with the real id when
     the proposal exists. Anything that does not land gives the claim back below. */
  ctx.duplicates.remember(kind, params, session, '');
  let landed = false;
  const problems: string[] = [];

  // The id is remembered before the reply goes out, so a repeat arriving while the rail runs is
  // told which row it is repeating rather than doubling it.
  const respond = (proposal: Proposal): void => {
    landed = true;
    ctx.duplicates.remember(kind, params, session, proposal.id);
    sendProposal(ctx, res, proposal);
  };

  try {
    if (kind === 'swap') {
      // One venue: the balance inside NEAR Intents. chain and toChain name the home chains of
      // the two assets, never a place money lands, so there is no venue field to check.
      // Either may be left out: the swap picks the coin by one rule (resolveSwapSides).
      const chain = params.chain === undefined ? undefined : swapChainField(params, 'chain', problems);
      const toChain = params.toChain === undefined ? undefined : swapChainField(params, 'toChain', problems);
      const fromSymbol = strField(params, 'fromSymbol', problems, SWAP_SYMBOL_MAX);
      const toSymbol = strField(params, 'toSymbol', problems, SWAP_SYMBOL_MAX);
      // A negative or zero input has no honest swap, and neither does one too large to be
      // represented exactly. Rejected at the edge so it never reaches usdOf, where a negative
      // amount became "$Infinity ... cannot be checked against a limit" and only failed closed
      // by accident of the arithmetic. "all" and an exact decimal string are the exact forms: a
      // number is read through its shortest decimal, never through float math on base units.
      const amountIn = swapAmountField(params, 'amountIn', problems);
      // Through positiveField for the same reason amountIn is, and one the rails cannot make up
      // for on their own: minAmountOut is the only slippage protection a swap carries, and a
      // floor of zero is not a floor. It is the one field on this whole surface whose value a
      // caller chooses and money depends on, so zero and negative are stopped at the door as
      // well as inside every venue.
      // Absent is not zero: it passes, and proposeSwap sets the floor one percent under its own
      // live quote or refuses the swap. Demanding it here refused every swap proposed without
      // a floor before any quote was asked for.
      const minAmountOut = params.minAmountOut === undefined ? undefined : positiveField(params, 'minAmountOut', problems);
      // `chain === null` is already in `problems`; naming it here is what convinces the type
      // system, and what stops the next edit reaching for a chain that was never resolved.
      if (problems.length > 0 || chain === null || toChain === null) {
        fail(res, 400, problems.join('; '));
        return;
      }
      respond(
        await ctx.proposals.proposeSwap({
          chain,
          toChain,
          fromSymbol,
          toSymbol,
          amountIn,
          minAmountOut,
          clientKey,
          by,
        }),
      );
      return;
    }
    if (kind === 'trade') {
      /* A plan, or the id of one already drawn. The shape is checked by the plan schema inside
         the proposal service; what is checked HERE is the edge every kind shares, so a zero or
         a 1e308 on the plan's numbers is answered with the field's name like everywhere else. */
      const planId = params.planId === undefined ? undefined : strField(params, 'planId', problems, ID_MAX);
      const plan = params.plan;
      if (planId === undefined) {
        if (plan === null || typeof plan !== 'object') problems.push('plan is required, or planId of a drawn plan');
        else {
          const fields = plan as JsonBody;
          positiveField(fields, 'sizeUsd', problems);
          positiveField(fields, 'leverage', problems);
          positiveField(fields, 'stop', problems);
          if (fields.target !== undefined) positiveField(fields, 'target', problems);
        }
      }
      if (problems.length > 0) {
        fail(res, 400, problems.join('; '));
        return;
      }
      respond(await ctx.proposals.proposeTrade({ plan, planId, by, clientKey }));
      return;
    }
    if (kind === 'trade_change') {
      const id = strField(params, 'id', problems, ID_MAX);
      const stop = params.stop === undefined ? undefined : positiveField(params, 'stop', problems);
      const target = params.target === undefined ? undefined : positiveField(params, 'target', problems);
      const cancel = params.cancel === true;
      const close = params.close === true;
      if (problems.length > 0) {
        fail(res, 400, problems.join('; '));
        return;
      }
      respond(await ctx.proposals.proposeTradeChange({ id, stop, target, cancel, close, clientKey, by }));
      return;
    }
    if (kind === 'hl_deposit') {
      // No chain: the money leaves the intents balance and nowhere else. symbol is optional
      // and defaults to USDC inside proposeHlDeposit, which also picks the flavor held.
      const symbol = params.symbol === undefined ? undefined : strField(params, 'symbol', problems, SYMBOL_MAX);
      const amount = positiveField(params, 'amount', problems);
      if (problems.length > 0) {
        fail(res, 400, problems.join('; '));
        return;
      }
      respond(await ctx.proposals.proposeHlDeposit({ symbol, amount, clientKey, by }));
      return;
    }
    if (kind === 'hl_withdraw') {
      // One number. No destination, no chain, no symbol: the venue account, the intents account
      // credited and the floor are all the app's. tests/injection.test.ts holds this schema to that.
      const amount = positiveField(params, 'amount', problems);
      if (problems.length > 0) {
        fail(res, 400, problems.join('; '));
        return;
      }
      respond(await ctx.proposals.proposeHlWithdraw({ amount, clientKey, by }));
      return;
    }
    if (kind === 'send') {
      // The one propose kind with a destination field, and the one with a confirmation field.
      // `where` has no default: a send with no place named is a send the agent has not
      // understood, and the wrong guess is a total loss on a chain. `confirmed` is the agent's
      // statement that the human read the exact address and the landing place back and said
      // yes; the schema at src/mcp.ts holds it to the literal true and so does this door, so a
      // raw post cannot skip the read-back either. The builder decodes `to` for the place it is
      // going, and the card and the Touch ID sentence are the gate.
      const to = strField(params, 'to', problems, ADDRESS_MAX);
      const symbol = strField(params, 'symbol', problems, SYMBOL_MAX);
      const amount = positiveField(params, 'amount', problems);
      const where = strField(params, 'where', problems, WHERE_MAX);
      if (params.confirmed !== true) {
        problems.push('confirmed must be true, and only after the human confirmed the exact address and where it lands in this conversation');
      }
      if (params.note !== undefined && typeof params.note !== 'string') problems.push('note must be a string');
      const note = typeof params.note === 'string' && params.note.trim() !== '' ? params.note.trim() : undefined;
      if (note !== undefined && note.length > NOTE_MAX) problems.push(`note is ${note.length} characters, over the ${NOTE_MAX} this field takes`);
      if (problems.length > 0) {
        fail(res, 400, problems.join('; '));
        return;
      }
      respond(await ctx.proposals.proposeSend({ to, symbol, amount, where, note, clientKey, by }));
      return;
    }
    if (kind === 'policy_change') {
      // patch and sentence are passed through as authored: the engine validates
      // the patch, and the sentence is stored as data, never read as instruction.
      const sentence = typeof params.sentence === 'string' ? params.sentence : '';
      if (sentence.length > SENTENCE_MAX) {
        fail(res, 400, `sentence is ${sentence.length} characters, over the ${SENTENCE_MAX} this field takes`);
        return;
      }
      respond(await ctx.proposals.proposePolicyChange({ patch: asRecord(params.patch), sentence, clientKey, by }));
      return;
    }
    fail(res, 400, `unknown propose kind: ${kind}. known kinds: ${PROPOSE_KINDS.join(', ')}`);
  } catch (err) {
    fail(res, 400, errText(err));
  } finally {
    /* Nothing landed, so the claim goes back. A fingerprint left behind by a draft that was
       refused for a bad amount would block a second agent's correct proposal for ninety seconds
       and name an id that does not exist. */
    if (!landed) ctx.duplicates.forget(kind, params);
  }
}
