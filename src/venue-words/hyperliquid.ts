// Hyperliquid's words this app knows, in one place: the order statuses its info endpoint answers
// with, and the refusals its exchange endpoint writes, each with the sentence an agent reads in its
// place (src/venue-words.ts). A refusal is matched whole; a part that changes is a number, so a
// word a venue or a stranger writes never rides inside one of these sentences.
//
// Sources, read 2026-10-02: the error table at hyperliquid.gitbook.io/hyperliquid-docs/
// for-developers/api/error-responses, the order status table on its info-endpoint page, and live
// answers quoted in public SDK issues (ccxt, hummingbot, freqtrade, the official Python and Rust
// SDKs). Live order errors end in " asset=N", which the table leaves out; the cancel error, the
// schedule-cancel error and the unified-account error are also on record in this code's tests.
// Left out on purpose: a refusal that names a token or an address (the spot minimum names its
// quote token, "Must deposit" and "User or API Wallet" name an address), so it stays quoted.

import type { VenueVocabulary } from '../venue-words.ts';

// Which market an order error was about, when the venue said: its asset index.
const ASSET = '[ asset={asset:int}]';
const on = (part: Readonly<Record<string, string>>): string => (part.asset === undefined ? '' : ` (asset ${part.asset})`);

export const HYPERLIQUID: VenueVocabulary = {
  names: ['Hyperliquid'],
  // orderStatus, historicalOrders and orderUpdates answer with one of these.
  words: [
    'open', 'filled', 'canceled', 'triggered', 'rejected', 'marginCanceled', 'vaultWithdrawalCanceled',
    'openInterestCapCanceled', 'selfTradeCanceled', 'reduceOnlyCanceled', 'siblingFilledCanceled', 'delistedCanceled',
    'liquidatedCanceled', 'scheduledCancel', 'tickRejected', 'minTradeNtlRejected', 'perpMarginRejected',
    'reduceOnlyRejected', 'badAloPxRejected', 'iocCancelRejected', 'badTriggerPxRejected', 'marketOrderNoLiquidityRejected',
    'positionIncreaseAtOpenInterestCapRejected', 'positionFlipAtOpenInterestCapRejected',
    'tooAggressiveAtOpenInterestCapRejected', 'openInterestIncreaseRejected', 'insufficientSpotBalanceRejected',
    'oracleRejected', 'perpMaxPositionRejected',
  ],
  refusals: [
    // An order or a cancel, one error per order in the batch.
    { said: `Price must be divisible by tick size.${ASSET}`, means: (p) => `Hyperliquid refused the order because its price is not a whole number of ticks${on(p)}` },
    { said: `Order must have minimum value of \${min:usd}.${ASSET}`, means: (p) => `Hyperliquid refused the order because it is worth less than the $${p.min} minimum${on(p)}` },
    { said: `Insufficient margin to place order.${ASSET}`, means: (p) => `Hyperliquid refused the order because the account does not have the margin for it${on(p)}` },
    { said: `Reduce only order would increase position.${ASSET}`, means: (p) => `Hyperliquid refused the reduce-only order because it would grow the position${on(p)}` },
    {
      said: `Post only order would have immediately matched, bbo was {bid:dec}@{ask:dec}.${ASSET}`,
      means: (p) => `Hyperliquid refused the post-only order because it would have filled at once (best bid ${p.bid}, best ask ${p.ask})${on(p)}`,
    },
    { said: `Order could not immediately match against any resting orders.${ASSET}`, means: (p) => `Hyperliquid canceled the order because nothing on the book could fill it at once at its price${on(p)}` },
    { said: `Invalid TP/SL price.${ASSET}`, means: (p) => `Hyperliquid refused the order because its take-profit or stop-loss price is not valid${on(p)}` },
    { said: `No liquidity available for market order.${ASSET}`, means: (p) => `Hyperliquid refused the market order because there is no liquidity to fill it${on(p)}` },
    { said: `Order would increase open interest while open interest is capped[.]${ASSET}`, means: (p) => `Hyperliquid refused the order because open interest on this market is at its cap${on(p)}` },
    {
      said: `Order rejected due to price more aggressive than oracle while at open interest cap[.]${ASSET}`,
      means: (p) => `Hyperliquid refused the order because its price is past the oracle price while this market is at its open interest cap${on(p)}`,
    },
    { said: `Order would increase open interest too quickly[.]${ASSET}`, means: (p) => `Hyperliquid refused the order because open interest on this market is growing too fast right now${on(p)}` },
    { said: `Insufficient spot balance${ASSET}`, means: (p) => `Hyperliquid refused the order because the spot balance does not cover it${on(p)}` },
    // The table says "Order price too far from oracle"; the venue answered "Price too far from oracle asset=4" on 2026-08-20.
    { said: `Order price too far from oracle[.]${ASSET}`, means: (p) => `Hyperliquid refused the order because its price is too far from the oracle price${on(p)}` },
    { said: `Price too far from oracle[.]${ASSET}`, means: (p) => `Hyperliquid refused the order because its price is too far from the oracle price${on(p)}` },
    {
      said: `Order price cannot be more than {pct:int}% away from the reference price[.]${ASSET}`,
      means: (p) => `Hyperliquid refused the order because its price is more than ${p.pct}% away from the reference price${on(p)}`,
    },
    { said: `Order has invalid price.${ASSET}`, means: (p) => `Hyperliquid refused the order because its price is not valid${on(p)}` },
    { said: `Order has invalid size.${ASSET}`, means: (p) => `Hyperliquid refused the order because its size is not valid${on(p)}` },
    { said: `Order has zero size.${ASSET}`, means: (p) => `Hyperliquid refused the order because its size is zero${on(p)}` },
    { said: `Order was never placed, already canceled, or filled.${ASSET}`, means: (p) => `Hyperliquid has no such open order: it was never placed, or it is already canceled or filled${on(p)}` },

    // A refused action, the whole request at once.
    {
      said: 'Too many cumulative requests sent ({sent:int} > {limit:int}) for cumulative volume traded ${volume:usd}. Place taker orders to free up 1 request per USDC traded.',
      means: (p) => `Hyperliquid refused the request because the account has used its requests (${p.sent} sent, ${p.limit} allowed for $${p.volume} traded); each 1 USDC traded frees one more`,
    },
    {
      said: 'Cannot set scheduled cancel time until enough volume traded. Required: ${required:usd}. Traded: ${traded:usd}.',
      means: (p) => `Hyperliquid will not set a scheduled cancel until the account has traded $${p.required}; it has traded $${p.traded}`,
    },
    { said: 'Action disabled when unified account is active[.]', means: () => 'Hyperliquid refused it because this account is a unified account, which turns this action off' },
    { said: 'Invalid nonce: duplicate nonce {nonce:int}', means: () => 'Hyperliquid refused it because its nonce was already used' },
    { said: 'Invalid nonce: nonce too low {nonce:int} < {least:int}', means: () => 'Hyperliquid refused it because its nonce is older than the venue still takes' },
    { said: 'Unable to recover signer[.]', means: () => 'Hyperliquid could not read the signature on the request' },

    // A transfer or a withdrawal the account signs itself.
    { said: 'Insufficient balance for withdrawal[.]', means: () => 'Hyperliquid refused it because the balance there does not cover this withdrawal' },
    { said: 'Insufficient balance for token transfer[.]', means: () => 'Hyperliquid refused the transfer because the balance there does not cover it' },
    {
      said: 'Insufficient balance for token transfer gas[.]',
      means: () => 'Hyperliquid refused the transfer because the balance does not cover the fee for sending to an address new to Hyperliquid',
    },

    // The info endpoint's 422 for a request body it could not read.
    { said: 'Failed to deserialize the JSON body into the target type', means: () => 'Hyperliquid could not read the request the app sent' },
  ],
};
