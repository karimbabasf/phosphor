// What the wallet panel renders: everything held, the way a normal wallet shows it. Karim,
// 2026-08-11: "the composition thing should just show what a normal crypto wallet would show".
// So ETH and SOL are in; classify() leaves them out for the policy engine's purposes, which is
// a different question.
//
// Pure function, no IO. Everything it renders is passed in: the verifier reader and the venue
// reader own fetching, this owns presentation.

import type { LedgerSnapshot, WalletPlace, WalletRow, WalletView } from './types.ts';
import { intentsUnreadWhy, type IntentsRead } from './ledger/intents.ts';
import type { HlRead } from './ledger/hyperliquid.ts';
import { pricedAs } from './proposals/draft.ts';
// Below this a balance renders as $0.00, which is where a row stops carrying information: one
// threshold for a dust row and for a trading account that was never funded.
import { DUST_USD } from './trade/funding.ts';

/* WHY A STABLECOIN FLOOR EXISTS HERE, AND WHY IT IS NOT AN INVENTED PRICE.
   The spot table carries the natives. A stablecoin held inside the intents verifier appears
   in it nowhere, so without this it is priced off nothing. Karim, 2026-09-08, looking at his
   own window: 3.694727 USDC in NEAR Intents, priced at 0, valued at 0, and a total that was
   $25.90 when it was $29.60. Money he owns, on screen as nothing.
   It is deliberately a NAMED LIST and not a guess at what looks like a stablecoin: a token
   called USDCoin is not a dollar because its name starts the same way, and this figure is
   added to a total somebody makes decisions against. */
const DOLLARS = new Set(['USDC', 'USDT', 'DAI', 'USDC.E', 'FRAX', 'PYUSD', 'USDE', 'LUSD', 'TUSD', 'USDP']);

/* A live mid (src/ledger/live-prices.ts) is taken for the window only within this share of the
   coin's own price. 1Click's list trails its market by a minute at most and Coinbase's by fifteen
   seconds, so a real coin sits well inside it (GRAM: 1.46 listed, 1.456 live); a different token
   under the same ticker, or a perp that broke from its spot, does not, and keeps its own price. */
export const LIVE_BAND = 0.1;

// A coin's live mid by the key this file prices through (pricedAs), or null for none.
export type LivePrice = (coin: string) => number | null;

// At most this many coins get a live price: one subscribe each, on a socket the trade feed's shares limits with.
export const LIVE_COINS_MAX = 20;

/* The coins a live price is worth keeping for, keyed as the wallet keys them, largest first: a held,
   priced, non-dollar coin with a ticker for a name. Anyone can send tokens to the account, and a
   coin 1Click does not list is named by its raw id and has no price to hold a mid against, so it
   could never take one (review 2026-10-09: 1500 junk deposits were 1500 subscriptions). */
export function liveCoins(intents: IntentsRead | undefined): string[] {
  const value = new Map<string, number>();
  for (const h of intents?.holdings ?? []) {
    const coin = pricedAs(String(h.symbol ?? ''));
    const price = typeof h.priceUsd === 'number' && Number.isFinite(h.priceUsd) ? h.priceUsd : 0;
    if (!(h.amount > 0) || !(price > 0) || !/^[A-Z0-9]{2,10}$/.test(coin) || DOLLARS.has(coin)) continue;
    value.set(coin, (value.get(coin) ?? 0) + h.amount * price);
  }
  return [...value.entries()].sort((a, b) => b[1] - a[1]).slice(0, LIVE_COINS_MAX).map(([coin]) => coin);
}

// `now` is only for the age of the verifier read (see intentsUnreadWhy); a test pins it.
// `live` is for the window and the agent's wallet read only, never a path that governs a move.
export function buildWallet(snapshot: LedgerSnapshot, intents?: IntentsRead, hyperliquid?: HlRead, now: number = Date.now(), live?: LivePrice): WalletView {
  // Symbol -> unit price, from the snapshot's spot table.
  //
  // KEYED UPPERCASE, AND A WRAPPER IS ITS COIN. src/ledger/index.ts prices through exactly
  // this normalisation and this map once did not, so a lookup only landed when the two sides
  // happened to agree on case. The wrapper table is the engine's (pricedAs), so what the window
  // values and what the policy governs can never disagree about wNEAR or WETH.
  const priceBySymbol = new Map<string, number>();
  const key = (symbol: string): string => pricedAs(String(symbol ?? ''));
  for (const [symbol, price] of Object.entries(snapshot.prices)) {
    if (!priceBySymbol.has(key(symbol))) priceBySymbol.set(key(symbol), price);
  }

  const priceOf = (symbol: string): number => {
    const found = priceBySymbol.get(key(symbol));
    if (found !== undefined && found > 0) return found;
    return DOLLARS.has(key(symbol)) ? 1 : 0;
  };

  /* Is this a price or is it a hole. Zero is a real answer for a worthless token and it is also
     what "we could not price this" looks like, and the two must not print the same, because
     "$0.00" beside a balance a person owns reads as "you have nothing". Every row carries the
     answer so the window can say "not priced" instead.
     No guard for a zero balance: an empty holding never becomes a row, so a row with nothing in
     it does not exist to be asked about. */
  const pricedOf = (symbol: string): boolean => priceOf(symbol) > 0;

  // A balance inside the intents.near verifier, priced off the spot table. An asset we have
  // no price for keeps its quantity and values at zero rather than borrowing a number from
  // somewhere it does not belong.
  // Where neither prices it, 1Click's own price for the asset, off the token list, marked as such:
  // WBTC, cbBTC, nBTC and the rest read "not priced" beside a real balance until 2026-09-23.
  // The live mid, where one is given and sits within LIVE_BAND of the coin's own price.
  const liveOf = (symbol: string, own: number): number | null => {
    if (live === undefined || !(own > 0) || DOLLARS.has(key(symbol))) return null;
    const mid = live(key(symbol));
    if (mid === null || !Number.isFinite(mid) || mid <= 0) return null;
    return Math.abs(mid - own) / own <= LIVE_BAND ? mid : null;
  };
  const intentsRows: WalletRow[] = (intents?.holdings ?? []).map(h => {
    const listed = !pricedOf(h.symbol) && typeof h.priceUsd === 'number' && h.priceUsd > 0 ? h.priceUsd : null;
    const own = listed ?? priceOf(h.symbol);
    const mid = liveOf(h.symbol, own);
    const priceUsd = mid ?? own;
    return {
      kind: 'intents',
      chain: 'intents',
      symbol: h.symbol,
      tokenId: h.assetId,
      quantity: h.amount,
      priceUsd,
      valueUsd: h.amount * priceUsd,
      share: 0,
      native: false,
      priced: listed !== null || pricedOf(h.symbol),
      ...(mid !== null ? { priceSource: 'hyperliquid' as const } : listed === null ? {} : { priceSource: '1click' as const }),
      intents: { accountId: h.accountId, assetId: h.assetId },
    };
  });

  // The trading account. USDC is the only collateral HyperCore holds, and it is a dollar, so
  // the row prices itself: a venue read never has to wait for the price table. A read that missed
  // carries the last good figures (src/ledger/index.ts), and they stay as the row, marked stale
  // below: one miss used to drop the row and empty the whole list.
  const hlKnown = hyperliquid !== undefined && hyperliquid.unknown !== true;
  const hlRows: WalletRow[] =
    hlKnown
      ? [
          {
            kind: 'hyperliquid',
            chain: 'hyperliquid',
            symbol: 'USDC',
            tokenId: 'hyperliquid:perps',
            quantity: hyperliquid.collateralUsdc,
            priceUsd: 1,
            valueUsd: hyperliquid.collateralUsdc,
            share: 0,
            native: false,
            hyperliquid: {
              account: hyperliquid.account,
              availableUsdc: hyperliquid.availableUsdc,
              marginUsedUsd: hyperliquid.marginUsedUsd,
              openPositions: hyperliquid.openPositions,
              unified: hyperliquid.unified,
            },
          },
        ]
      : [];

  // A wallet lists what you hold. The test is quantity, not value: a token we hold but have no
  // price for is still held, and dropping it would be the app deciding you own less than you do.
  const held = [...intentsRows, ...hlRows].filter(r => r.quantity > 0 || r.valueUsd > 0);
  // The trading account at $0 is where a new account starts, not an empty holding to count:
  // "1 empty, not listed" on a fresh wallet was this row. The report says unfunded instead.
  const emptyCount = intentsRows.length - held.filter(r => r.kind !== 'hyperliquid').length;

  // Dust. A priced balance that rounds to $0.00 (0.001 USDC left on a venue after a withdrawal)
  // is money, so the total and the place keep it, but a row reading "$0.00" beside a real one
  // is noise the eye has to step over every time. Only a PRICED balance can be dust: a holding
  // the app cannot value (priced false, or a token row whose price came back 0) is a hole, not a
  // small number, and hiding it would be the 2026-09-08 bug again (money shown as nothing). The
  // count and the sum go out so the card can say so.
  const isDust = (r: WalletRow): boolean => r.priced !== false && r.priceUsd > 0 && r.valueUsd < DUST_USD;
  const dust = held.filter(isDust);
  const dustCount = dust.length;
  const dustUsd = dust.reduce((sum, r) => sum + r.valueUsd, 0);

  const rows = held.filter(r => !isDust(r)).sort((a, b) => b.valueUsd - a.valueUsd);
  const totalUsd = held.reduce((sum, r) => sum + r.valueUsd, 0);
  for (const row of rows) row.share = totalUsd > 0 ? row.valueUsd / totalUsd : 0;

  const byChain: Record<string, number> = {};
  for (const row of held) byChain[row.chain] = (byChain[row.chain] ?? 0) + row.valueUsd;

  const stale: WalletPlace[] = [];
  // A verifier read that failed twice in a row, or holdings nobody has re-read for two idle
  // periods, are stale: showing no intents row would claim the deposit is gone. One miss is
  // not (intentsUnreadWhy says why). Only ever added when a read was actually attempted, so a
  // ledger that never asked does not sprout a permanent STALE badge. The reason goes out
  // beside the place, so the card can say more than "unknown".
  const staleWhy: Partial<Record<WalletPlace, string>> = {};
  const intentsWhy = intents === undefined ? null : intentsUnreadWhy(intents, now);
  if (intentsWhy !== null) {
    stale.push('intents');
    staleWhy.intents = intentsWhy;
  }
  if (hyperliquid !== undefined && !hyperliquid.ok) {
    stale.push('hyperliquid');
    if (hyperliquid.error !== undefined) staleWhy.hyperliquid = hyperliquid.error;
  }
  /* NOTHING READ YET IS NOT NOTHING HELD. Before the first pass lands neither place has answered,
     and the window drew "$0.00" over "Nothing here yet" until it did (2026-10-05: 0.72 s on a good
     day, 10 s while 1Click hung). Both places go out unread, so every surface that refuses to print
     an unread place as zero refuses this one too. */
  const pending = snapshot.pending === true;
  if (pending) {
    for (const place of ['intents', 'hyperliquid'] as const) {
      if (stale.includes(place)) continue;
      stale.push(place);
      staleWhy[place] = 'not read yet';
    }
  }
  // Funded is more than dust: the venue left 0.000002 USDC on a trading account that was never
  // funded, and "funded" over it hid the one line an empty account needs (src/trade/funding.ts).
  const hl = hlKnown ? { funded: hyperliquid.collateralUsdc >= DUST_USD } : undefined;

  const unpriced = rows.filter(r => r.priced === false).map(r => r.symbol);
  const unread: WalletPlace[] = pending
    ? ['intents', 'hyperliquid']
    : [...(intents?.unknown === true ? ['intents' as const] : []), ...(hyperliquid?.unknown === true ? ['hyperliquid' as const] : [])];

  return {
    rows, totalUsd, byChain, stale, staleWhy, emptyCount, dustCount, dustUsd, unpriced, hyperliquid: hl,
    ...(pending ? { pending: true as const } : {}),
    ...(unread.length > 0 ? { unread } : {}),
  };
}
