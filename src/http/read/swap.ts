// The swap reads: what can be swapped inside NEAR Intents, a dry quote, and one swap's truth
// re-read now. Reads like every other on this door: audited before dispatch, and none of them
// files a row, signs anything or waits in the spend queue (src/proposals/swap-reads.ts).

import { fail, intParam, sendJson } from '../respond.ts';
import type { ReadTable } from '../context.ts';
import { oneLine } from '../../intents.ts';

// The longest name a coin or a chain can be given here: an asset id, which runs past 50.
const NAME_MAX = 128;

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed.slice(0, max);
}

export const swapReads: ReadTable = {
  /* Every coin the swap service lists, or those matching a search (a ticker, a chain, an id).
     A search that narrows to ten or fewer is asked about each one, so "can I buy bitcoin" is
     answered by the venue and not by its list. */
  swap_assets: async (ctx, _body, args, res) => {
    if (ctx.proposals.swapAssets === undefined) return fail(res, 501, 'swap reads are not wired in this app');
    sendJson(res, 200, await ctx.proposals.swapAssets({ query: text(args.query, NAME_MAX), limit: intParam(args.limit, 40, 200) }));
  },
  /* A dry quote that files nothing and signs nothing, asked in propose_swap's own words:
     fromSymbol and toSymbol by ticker or assetId, chain and toChain where a ticker needs them,
     and amountIn as "all" or an exact decimal. */
  swap_quote: async (ctx, _body, args, res) => {
    if (ctx.proposals.swapQuote === undefined) return fail(res, 501, 'swap reads are not wired in this app');
    const fromSymbol = text(args.fromSymbol, NAME_MAX);
    const toSymbol = text(args.toSymbol, NAME_MAX);
    const amountIn = typeof args.amountIn === 'number' ? args.amountIn : text(args.amountIn, 80);
    const problems: string[] = [];
    if (fromSymbol === undefined) problems.push('fromSymbol is required: a ticker such as USDC, or an assetId');
    if (toSymbol === undefined) problems.push('toSymbol is required: a ticker such as ETH, or an assetId');
    if (amountIn === undefined) problems.push('amountIn is required: "all" or an exact decimal such as 1.25');
    if (problems.length > 0 || fromSymbol === undefined || toSymbol === undefined || amountIn === undefined) return fail(res, 400, problems.join('; '));
    sendJson(res, 200, await ctx.proposals.swapQuote({ fromSymbol, toSymbol, amountIn, chain: text(args.chain, 32), toChain: text(args.toChain, 32) }));
  },
  /* One swap's truth, read again now: the venue's word, the sold coin's ledger since the click,
     and the balance. For "did my money leave?", answered from the balance and never from a note. */
  swap_check: async (ctx, _body, args, res) => {
    if (ctx.proposals.swapCheck === undefined) return fail(res, 501, 'swap reads are not wired in this app');
    const id = typeof args.id === 'string' ? args.id : '';
    if (ctx.proposals.get(id) === undefined) return fail(res, 404, `unknown proposal id: ${oneLine(id, 120)}`);
    sendJson(res, 200, await ctx.proposals.swapCheck(id));
  },
};
