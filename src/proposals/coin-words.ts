// What a person calls the coins a move names, read off the tables the rails resolve against.
//
// An agent may name a coin by 1Click's asset id (propose_swap takes "a symbol, or the assetId
// swap_assets gave"), and a swap draft keeps the id where one ticker is two coins on one network
// (swap-reads.ts draftSymbolOf) or where the agent named the network itself. The window printed
// whatever it was handed: on 0.10.13 a swap's first frame read "Swap 1.7147 nep141:17208628...a1
// to SOL" over two gray monograms until the row landed (Karim, 2026-10-02). The window draws these
// words instead, on the propose's first frame (src/http/chats.ts), on every row (view.ts money) and
// on every receipt. The id stays on the draft and in its pins (src/rails/asset-pin.ts), and only
// the id decides what is signed.

import { heldSymbol, looksLikeAssetId } from '../intents.ts';
import type { PCtx } from './lifecycle.ts';

type Named = { assetId: string; symbol: string };

// The moves whose symbols are coins of the balance. A trade's are Hyperliquid's own names.
export const COIN_KINDS: ReadonlySet<string> = new Set(['swap', 'intents_send', 'intents_pay', 'hl_deposit', 'hl_withdraw']);

// The agent's handle for a token nobody lists (src/http/read/wallet.ts): a name for the agent only.
const UNLISTED = /^unlisted-[0-9a-f]{8}$/i;

/* The word for one coin as a draft or an agent names it. An id is the ticker the venue's list
   files it under, else the ticker the balance holds it as, else nothing: an id no table knows has
   no word, and the window then names no coin rather than print the id. A ticker is answered in the
   list's own case ("wbtc" is wBTC, NEAR is the wNEAR the balance holds), so the first frame and the
   row say the same word; a ticker no table knows is left as it was asked. */
export function coinWord(ref: string, list: readonly Named[] | null, held: readonly Named[] = []): string | null {
  const text = ref.trim();
  if (text === '' || UNLISTED.test(text)) return null;
  const named = (t: Named): boolean => t.symbol !== '' && !looksLikeAssetId(t.symbol);
  if (looksLikeAssetId(text)) {
    const row = list?.find((t) => t.assetId === text && named(t)) ?? held.find((t) => t.assetId === text && named(t));
    return row === undefined ? null : row.symbol;
  }
  const asked = heldSymbol(text);
  const upper = asked.toUpperCase();
  const row = list?.find((t) => t.symbol.toUpperCase() === upper && named(t)) ?? held.find((t) => t.symbol.toUpperCase() === upper && named(t));
  return row === undefined ? asked : row.symbol;
}

/* The same word off this app's own tables, without a read: the list the swap reads and the rails
   last fetched, else the one the ledger's balance read last fetched (however old: a name does not
   age the way a price does), and the balance as the ledger last read it, which holds every coin a
   move can spend. */
export function coinWordOf(ctx: PCtx, ref: string): string | null {
  const read = ctx.ledger.intents();
  const list = ctx.rails.swap?.listed?.() ?? ctx.ledger.listed?.() ?? null;
  return coinWord(ref, list, read?.ok === true ? read.holdings : []);
}
