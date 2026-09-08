// What the composition panel renders: everything held, the way a normal wallet shows it.
// Karim, 2026-08-11: "the composition thing should just show what a normal crypto wallet
// would show". So natives are in (classify() filters them out for the policy engine's
// purposes, which is a different question) and pool positions sit in the same table as
// one line each, because a wallet that hides your LP is lying about what you hold.
//
// Pure function, no IO. LP positions are passed in rather than fetched here: the chain
// readers own fetching, this owns presentation.

import type { ChainId, LedgerSnapshot, LpPosition, WalletPlace, WalletRow, WalletView } from './types.ts';
import type { IntentsRead } from './ledger/intents.ts';

// Price per unit, derived from what the ledger already priced rather than re-fetched.
// Stables land on ~1.0, natives on spot, and a zero balance cannot divide.
function unitPrice(amount: number, usd: number): number {
  return amount > 0 ? usd / amount : 0;
}

function lpLabel(pos: LpPosition): string {
  const pair = `${pos.token0.symbol}/${pos.token1.symbol}`;
  if (pos.feeTier === null) return pair;
  return `${pair} ${(pos.feeTier / 10_000).toFixed(2)}%`;
}

// An LP position's value is the two sides plus whatever fees it has accrued. Prices come
// from the same snapshot the tokens are priced from, so a pool position and a loose token
// of the same symbol never disagree about what that symbol is worth.
function lpValueUsd(pos: LpPosition, priceOf: (symbol: string) => number): number {
  const sides = pos.token0.amount * priceOf(pos.token0.symbol) + pos.token1.amount * priceOf(pos.token1.symbol);
  return sides + (pos.uncollectedFeesUsd ?? 0);
}

// Just enough of a yield position for the wallet to price it. Deliberately not the whole
// YieldHolding: this module has no business with a credit ledger or an annualised window,
// and a narrower input is one fewer thing that can change under it.
export type YieldWalletHolding = {
  chain: ChainId;
  venue: string;
  symbol: string;
  receipt: string;
  receiptSymbol: string;
  valueUsd: number;
  // Null when this app holds no executed deposit behind the balance, so it cannot say what
  // the position cost. See YieldHolding.basisKnown: zero is not a synonym for unknown, and
  // treating it as one prints the whole position as profit.
  principalUsd: number | null;
  earnedUsd: number | null;
};

export function buildWallet(
  snapshot: LedgerSnapshot,
  positions: LpPosition[] = [],
  intents?: IntentsRead,
  yieldHoldings: YieldWalletHolding[] = [],
): WalletView {
  // Symbol -> unit price, learned from the holdings themselves and topped up from the
  // snapshot's native price table for symbols held only inside a pool.
  //
  // KEYED UPPERCASE, AND WETH IS ETH. src/ledger/index.ts prices the wallet's own holdings
  // through exactly this normalisation and this map did not, so a lookup only landed when the
  // two sides happened to agree on case. The mapping is not a nicety either: WETH and ETH are
  // the same dollar behind two contracts, which is the argument priceHoldings already makes.
  const priceBySymbol = new Map<string, number>();
  const key = (symbol: string): string => {
    const upper = String(symbol ?? '').toUpperCase();
    return upper === 'WETH' ? 'ETH' : upper;
  };
  for (const h of snapshot.holdings) {
    const price = unitPrice(h.amount, h.usd);
    if (price > 0) priceBySymbol.set(key(h.symbol), price);
  }
  for (const [symbol, price] of Object.entries(snapshot.prices)) {
    if (!priceBySymbol.has(key(symbol))) priceBySymbol.set(key(symbol), price);
  }

  /* WHY A STABLECOIN FLOOR EXISTS HERE, AND WHY IT IS NOT AN INVENTED PRICE.
     This map learns prices from what the wallet holds. A balance held ONLY inside the intents
     verifier is therefore priced off nothing: the snapshot's own price table carries the gas
     assets, and a stablecoin the wallet does not also hold on some chain appears in neither.
     Karim, 2026-09-08, looking at his own window: 3.694727 USDC in NEAR Intents, priced at 0,
     valued at 0, and a total that was $25.90 when it was $29.60. Money he owns, on screen as
     nothing.
     The dollar is the assumption src/ledger/index.ts already makes for every non-native
     holding it has no spot price for, so applying it here is agreeing with the rest of the app
     rather than making something up. It is deliberately a NAMED LIST and not a guess at what
     looks like a stablecoin: a token called USDCoin is not a dollar because its name starts
     the same way, and this figure is added to a total somebody makes decisions against. */
  const DOLLARS = new Set(['USDC', 'USDT', 'DAI', 'USDC.E', 'FRAX', 'PYUSD', 'USDE', 'LUSD', 'TUSD', 'USDP']);
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

  const tokenRows: WalletRow[] = snapshot.holdings.map(h => ({
    kind: 'token',
    chain: h.chain,
    symbol: h.symbol,
    tokenId: h.tokenId,
    quantity: h.amount,
    priceUsd: unitPrice(h.amount, h.usd),
    valueUsd: h.usd,
    share: 0, // filled below, once the total is known
    native: h.native,
  }));

  const lpRows: WalletRow[] = positions.map(pos => {
    const valueUsd = lpValueUsd(pos, priceOf);
    return {
      kind: 'lp',
      chain: pos.chain,
      symbol: lpLabel(pos),
      tokenId: pos.poolId,
      // A pool position has no meaningful unit count, so quantity carries the position
      // count (always 1) and price carries its value. Showing a fabricated "LP token
      // amount" for a v3 NFT would be inventing a number the chain does not have.
      quantity: 1,
      priceUsd: valueUsd,
      valueUsd,
      share: 0,
      native: false,
      lp: pos,
    };
  });

  // A balance inside the intents.near verifier. It is priced off the same symbol map as
  // everything else, so ETH held in the verifier and ETH held in the wallet agree about
  // what an ETH is worth. An asset we have no price for keeps its quantity and values at
  // zero rather than borrowing a number from somewhere it does not belong.
  const intentsRows: WalletRow[] = (intents?.holdings ?? []).map(h => {
    const priceUsd = priceOf(h.symbol);
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
      priced: pricedOf(h.symbol),
      intents: { accountId: h.accountId, assetId: h.assetId },
    };
  });

  // A wallet lists what you hold. The configured token list is long and most of it is
  // empty on any given day (19 rows, 14 of them zero, on 2026-08-13), and a list where
  // three quarters of the lines are 0.0000 buries the five that are real.
  //
  // The test is quantity, not value: a token we hold but have no price for is still held,
  // and dropping it would be the app deciding you own less than you do. A pool position is
  // kept whatever it is worth, because the position exists on chain either way.
  // Money supplied to a lending venue.
  //
  // This row exists because the wallet total was WRONG without it. A deposit leaves the
  // token balance the chain reader sees, so $56 in an Aave position simply vanished from a
  // $294 total, and the one number a person checks first quietly said they owned less than
  // they did. The receipt token is not in data/tokens.json and adding it there would fix the
  // arithmetic while calling the row aArbUSDCn, which tells a reader nothing.
  //
  // The value is the aToken balance, so it already includes the interest. Nothing is double
  // counted: the underlying left the wallet when it was supplied, and this is the same money
  // in the only place it now exists.
  const yieldRows: WalletRow[] = yieldHoldings.map(h => {
    // quantity is a TOKEN COUNT, and price is what one of them is worth, the same contract
    // every other row on this table keeps. Putting the dollar figure in the quantity column
    // reads correctly only while USDC prices at exactly 1.0; off peg the row contradicts
    // itself, because quantity times price no longer equals the value beside them.
    const unit = priceOf(h.symbol) || 1;
    return {
    kind: 'yield',
    chain: h.chain,
    symbol: `${h.symbol} earning`,
    tokenId: h.receipt,
    quantity: h.valueUsd / unit,
    priceUsd: unit,
    valueUsd: h.valueUsd,
    share: 0,
    native: false,
    yield: {
      venue: h.venue,
      receiptSymbol: h.receiptSymbol,
      receipt: h.receipt,
      principalUsd: h.principalUsd,
      earnedUsd: h.earnedUsd,
    },
    };
  });

  const held = [...tokenRows, ...lpRows, ...intentsRows, ...yieldRows].filter(
    r => r.kind === 'lp' || r.quantity > 0 || r.valueUsd > 0,
  );
  const emptyCount = tokenRows.length + intentsRows.length - held.filter(r => r.kind !== 'lp' && r.kind !== 'yield').length;

  const rows = held.sort((a, b) => b.valueUsd - a.valueUsd);
  const totalUsd = rows.reduce((sum, r) => sum + r.valueUsd, 0);
  for (const row of rows) row.share = totalUsd > 0 ? row.valueUsd / totalUsd : 0;

  const byChain: Record<string, number> = {};
  for (const row of rows) byChain[row.chain] = (byChain[row.chain] ?? 0) + row.valueUsd;

  const stale: WalletPlace[] = (Object.entries(snapshot.chainStatus) as Array<[ChainId, { ok: boolean }]>)
    .filter(([, status]) => !status.ok)
    .map(([chain]) => chain);
  // A verifier read that failed is stale for the same reason a chain read that failed is:
  // showing no intents row would claim the deposit is gone. Only ever added when a read was
  // actually attempted, so demo mode does not sprout a permanent STALE badge.
  if (intents !== undefined && !intents.ok) stale.push('intents');

  return { rows, totalUsd, byChain, stale, emptyCount };
}
