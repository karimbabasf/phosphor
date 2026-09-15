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
import { asRecord, errText, fail, sendJson } from './respond.ts';
import type { JsonBody } from './respond.ts';
import { CHAINS, PROPOSE_KINDS } from './context.ts';
import type { Ctx } from './context.ts';

/* How long a propose holds its reply open for the rail. Under the proxy's thirty second budget
   with room for the reply to travel, and the whole of the fix for 2026-09-15: a rail that ran
   43 s answered nothing, the proxy said the app was not running, the agent proposed again, and
   "deposit $10" moved $20. Past this the reply carries the `executing` row and says where the
   answer will appear. */
export const PROPOSE_REPLY_CAP_MS = 20_000;

// What the agent gets back from any propose: the id to poll, what the policy decided, what
// the simulation said, and what the rail said if it has answered. Never the draft itself, so
// the app's resolved addresses are not echoed to the caller that was deliberately not allowed
// to name them. The rail's sentence rides along because it is the one that says "do not send
// this again", and a reply that carried only the status word left the agent reading `failed`
// as a cue to retry.
function sendProposal(ctx: Ctx, res: http.ServerResponse, proposal: Proposal): void {
  ctx.sse.broadcastState();
  sendJson(res, 200, {
    id: proposal.id,
    status: proposal.status,
    verdict: proposal.verdict,
    simulation: proposal.simulation,
    ...(proposal.result === undefined ? {} : { result: proposal.result }),
    ...(proposal.status === 'executing' ? { next: 'executing: read proposal_status until it settles' } : {}),
  });
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

function strField(params: JsonBody, name: string, problems: string[]): string {
  const raw = params[name];
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    problems.push(`${name} is required`);
    return '';
  }
  return raw.trim();
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

export async function handlePropose(ctx: Ctx, body: JsonBody, res: http.ServerResponse): Promise<void> {
  const kind = String(body.kind ?? '');
  const params = asRecord(body.params);
  const session = String(body.session ?? 'unnamed-session');
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
      sendProposal(ctx, res, await ctx.proposals.settled(existing.id, PROPOSE_REPLY_CAP_MS));
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
      ? `this ${kind} was sent by this session moments ago${names} and the first one is unconfirmed, do not send it again; read proposal_status ${clash.id}.`
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

  // The id is remembered before the wait, so a repeat arriving during it is told which row it
  // is repeating; the reply is the row as it stands when the rail answers or the cap runs out.
  const respond = async (proposal: Proposal): Promise<void> => {
    landed = true;
    ctx.duplicates.remember(kind, params, session, proposal.id);
    sendProposal(ctx, res, await ctx.proposals.settled(proposal.id, PROPOSE_REPLY_CAP_MS));
  };

  try {
    if (kind === 'swap') {
      // Two venues, and the default crosses chains, which is what a bare "swap" means here now.
      // The old default was an on-chain DEX that could only work same-chain, so a cross-chain
      // swap naming no venue was refused at this door and had to be retried. There is nothing
      // left to refuse: both venues reach every pair the token list carries.
      const venueRaw = params.venue === undefined ? 'oneclick' : String(params.venue);
      if (venueRaw !== 'oneclick' && venueRaw !== 'intents-native') {
        problems.push('venue must be oneclick or intents-native');
      }
      const chain = chainField(params, 'chain', problems);
      const toChain = params.toChain === undefined ? chain : chainField(params, 'toChain', problems);
      const fromSymbol = strField(params, 'fromSymbol', problems);
      const toSymbol = strField(params, 'toSymbol', problems);
      // A negative or zero input has no honest swap, and neither does one too large to be
      // represented exactly. Rejected at the edge so it never reaches usdOf, where a negative
      // amount became "$Infinity ... cannot be checked against a limit" and only failed closed
      // by accident of the arithmetic. Through positiveField now, so one rule covers every kind.
      const amountIn = positiveField(params, 'amountIn', problems);
      // Through positiveField for the same reason amountIn is, and one the rails cannot make up
      // for on their own: minAmountOut is the only slippage protection a swap carries, and a
      // floor of zero is not a floor. It is the one field on this whole surface whose value a
      // caller chooses and money depends on, so zero and negative are stopped at the door as
      // well as inside every venue.
      const minAmountOut = positiveField(params, 'minAmountOut', problems);
      // `chain === null` is already in `problems`; naming it here is what convinces the type
      // system, and what stops the next edit reaching for a chain that was never resolved.
      if (problems.length > 0 || chain === null || toChain === null) {
        fail(res, 400, problems.join('; '));
        return;
      }
      await respond(
        await ctx.proposals.proposeSwap({
          venue: venueRaw as 'oneclick' | 'intents-native',
          chain,
          toChain,
          fromSymbol,
          toSymbol,
          amountIn,
          minAmountOut,
          clientKey,
        }),
      );
      return;
    }
    if (kind === 'trade') {
      /* A plan, or the id of one already drawn. The shape is checked by the plan schema inside
         the proposal service; what is checked HERE is the edge every kind shares, so a zero or
         a 1e308 on the plan's numbers is answered with the field's name like everywhere else. */
      const planId = params.planId === undefined ? undefined : strField(params, 'planId', problems);
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
      await respond(await ctx.proposals.proposeTrade({ plan, planId, by: session, clientKey }));
      return;
    }
    if (kind === 'trade_change') {
      const id = strField(params, 'id', problems);
      const stop = params.stop === undefined ? undefined : positiveField(params, 'stop', problems);
      const target = params.target === undefined ? undefined : positiveField(params, 'target', problems);
      const cancel = params.cancel === true;
      const close = params.close === true;
      if (problems.length > 0) {
        fail(res, 400, problems.join('; '));
        return;
      }
      await respond(await ctx.proposals.proposeTradeChange({ id, stop, target, cancel, close, clientKey }));
      return;
    }
    if (kind === 'hl_deposit') {
      // No chain: the money leaves the intents balance and nowhere else. symbol is optional
      // and defaults to USDC inside proposeHlDeposit, which also picks the flavor held.
      const symbol = params.symbol === undefined ? undefined : strField(params, 'symbol', problems);
      const amount = positiveField(params, 'amount', problems);
      if (problems.length > 0) {
        fail(res, 400, problems.join('; '));
        return;
      }
      await respond(await ctx.proposals.proposeHlDeposit({ symbol, amount, clientKey }));
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
      await respond(await ctx.proposals.proposeHlWithdraw({ amount, clientKey }));
      return;
    }
    if (kind === 'intents_deposit') {
      const chain = chainField(params, 'chain', problems);
      // symbol is optional: absent means the chain's gas asset, which is the common case
      // and the one the ERC-20 path could not serve.
      const symbol = params.symbol === undefined ? undefined : strField(params, 'symbol', problems);
      const amount = positiveField(params, 'amount', problems);
      if (problems.length > 0 || chain === null) {
        fail(res, 400, problems.join('; '));
        return;
      }
      await respond(await ctx.proposals.proposeIntentsDeposit({ chain, symbol, amount, clientKey }));
      return;
    }
    if (kind === 'intents_withdraw') {
      const chain = chainField(params, 'chain', problems);
      // Same optional symbol as the deposit: absent means the destination chain's gas asset.
      // There is no field here for the address, and there must never be one: the wallet the
      // payout lands in is resolved from config by the proposal service and re-derived by the
      // rail. tests/injection.test.ts holds this schema to that.
      const symbol = params.symbol === undefined ? undefined : strField(params, 'symbol', problems);
      const amount = positiveField(params, 'amount', problems);
      if (problems.length > 0 || chain === null) {
        fail(res, 400, problems.join('; '));
        return;
      }
      await respond(await ctx.proposals.proposeIntentsWithdraw({ chain, symbol, amount, clientKey }));
      return;
    }
    if (kind === 'consolidate') {
      const toChain = String(params.toChain ?? '');
      const symbol = typeof params.symbol === 'string' ? params.symbol.trim() : '';
      if (!CHAINS.includes(toChain)) {
        fail(res, 400, `toChain must be one of: ${CHAINS.join(', ')}`);
        return;
      }
      if (symbol.length === 0) {
        fail(res, 400, 'symbol is required');
        return;
      }
      const fromChains = Array.isArray(params.fromChains)
        ? (params.fromChains.filter((c) => typeof c === 'string' && CHAINS.includes(c)) as ChainId[])
        : undefined;
      const maxTotalUsd = typeof params.maxTotalUsd === 'number' && Number.isFinite(params.maxTotalUsd)
        ? params.maxTotalUsd
        : undefined;
      await respond(
        await ctx.proposals.proposeConsolidate({
          toChain: toChain as ChainId,
          symbol,
          ...(fromChains !== undefined && fromChains.length > 0 ? { fromChains } : {}),
          ...(maxTotalUsd !== undefined ? { maxTotalUsd } : {}),
          clientKey,
        }),
      );
      return;
    }
    if (kind === 'policy_change') {
      // patch and sentence are passed through as authored: the engine validates
      // the patch, and the sentence is stored as data, never read as instruction.
      const sentence = typeof params.sentence === 'string' ? params.sentence : '';
      await respond(await ctx.proposals.proposePolicyChange({ patch: asRecord(params.patch), sentence, clientKey }));
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
