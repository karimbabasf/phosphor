// What the wallet panel renders: everything held, the way a normal wallet shows it. Karim,
// 2026-08-11: "the composition thing should just show what a normal crypto wallet would show".
// So ETH and SOL are in; classify() leaves them out for the policy engine's purposes, which is
// a different question.
//
// Pure function, no IO. Everything it renders is passed in: the verifier reader and the venue
// reader own fetching, this owns presentation.

import type { LedgerSnapshot, WalletPlace, WalletRow, WalletView } from './types.ts';
import type { IntentsRead } from './ledger/intents.ts';
import type { HlRead } from './ledger/hyperliquid.ts';

// Below this a balance renders as $0.00, which is where a row stops carrying information.
const DUST_USD = 0.005;

export function buildWallet(snapshot: LedgerSnapshot, intents?: IntentsRead, hyperliquid?: HlRead): WalletView {
  // Symbol -> unit price, from the snapshot's spot table.
  //
  // KEYED UPPERCASE, AND WETH IS ETH. src/ledger/index.ts prices through exactly this
  // normalisation and this map once did not, so a lookup only landed when the two sides
  // happened to agree on case. The mapping is not a nicety either: WETH and ETH are the same
  // dollar behind two contracts.
  const priceBySymbol = new Map<string, number>();
  const key = (symbol: string): string => {
    const upper = String(symbol ?? '').toUpperCase();
    return upper === 'WETH' ? 'ETH' : upper;
  };
  for (const [symbol, price] of Object.entries(snapshot.prices)) {
    if (!priceBySymbol.has(key(symbol))) priceBySymbol.set(key(symbol), price);
  }

  /* WHY A STABLECOIN FLOOR EXISTS HERE, AND WHY IT IS NOT AN INVENTED PRICE.
     The spot table carries the natives. A stablecoin held inside the intents verifier appears
     in it nowhere, so without this it is priced off nothing. Karim, 2026-09-08, looking at his
     own window: 3.694727 USDC in NEAR Intents, priced at 0, valued at 0, and a total that was
     $25.90 when it was $29.60. Money he owns, on screen as nothing.
     It is deliberately a NAMED LIST and not a guess at what looks like a stablecoin: a token
     called USDCoin is not a dollar because its name starts the same way, and this figure is
     added to a total somebody makes decisions against. */
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

  // A balance inside the intents.near verifier, priced off the spot table. An asset we have
  // no price for keeps its quantity and values at zero rather than borrowing a number from
  // somewhere it does not belong.
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

  // The trading account. USDC is the only collateral HyperCore holds, and it is a dollar, so
  // the row prices itself: a venue read never has to wait for the price table.
  const hlRows: WalletRow[] =
    hyperliquid !== undefined && hyperliquid.ok
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
  const emptyCount = intentsRows.length + hlRows.length - held.length;

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
  // A verifier read that failed is stale: showing no intents row would claim the deposit is
  // gone. Only ever added when a read was actually attempted, so a ledger that never asked
  // does not sprout a permanent STALE badge.
  if (intents !== undefined && !intents.ok) stale.push('intents');
  if (hyperliquid !== undefined && !hyperliquid.ok) stale.push('hyperliquid');

  return { rows, totalUsd, byChain, stale, emptyCount, dustCount, dustUsd };
}
