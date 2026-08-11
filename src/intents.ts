// NEAR Intents 1Click quote client, synthetic quoter, and stub signer.
// Endpoint shapes verified against the live API 2026-08-11; see
// docs/superpowers/plans/2026-08-11-acc-v1-plan.md, Global Constraints and Task C.

import type { ChainId, TransferLeg, LegQuote, Quoter, Signer } from './types.ts';

const ONECLICK_TOKENS_URL = 'https://1click.chaindefuser.com/v0/tokens';
const ONECLICK_QUOTE_URL = 'https://1click.chaindefuser.com/v0/quote';

// Token registry shape loaded from data/tokens.json: chain -> symbol -> contract/mint id + decimals.
export type TokensFile = Record<ChainId, Record<string, { tokenId: string; decimals: number }>>;

// One entry from 1Click's GET /v0/tokens list.
export type OneClickToken = {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  contractAddress?: string;
};

const CHAIN_TO_BLOCKCHAIN: Record<ChainId, string> = {
  eth: 'eth',
  base: 'base',
  arb: 'arb',
  sol: 'sol',
  near: 'near',
};

// Matches a chain + our token registry id against 1Click's token list. For near-chain
// tokens contractAddress carries the NEAR account id, so one field covers both cases.
export function assetIdFor(chain: ChainId, tokenId: string, list: OneClickToken[]): string | null {
  const blockchain = CHAIN_TO_BLOCKCHAIN[chain];
  const wantId = tokenId.toLowerCase();
  const match = list.find(
    (t) => t.blockchain.toLowerCase() === blockchain && (t.contractAddress ?? '').toLowerCase() === wantId,
  );
  return match ? match.assetId : null;
}

function toBaseUnits(amount: number, decimals: number): string {
  return Math.round(amount * 10 ** decimals).toString();
}

export function oneClickQuoter(tokens: TokensFile, deps?: { fetchImpl?: typeof fetch }): Quoter {
  const fetchImpl = deps?.fetchImpl ?? fetch;
  let tokenListCache: OneClickToken[] | null = null;

  async function getTokenList(): Promise<OneClickToken[]> {
    if (tokenListCache) return tokenListCache;
    const res = await fetchImpl(ONECLICK_TOKENS_URL);
    if (!res.ok) {
      throw new Error(`1click token list fetch failed: ${res.status} ${await res.text()}`);
    }
    const list = (await res.json()) as OneClickToken[];
    tokenListCache = list;
    return list;
  }

  async function quoteLeg(leg: TransferLeg): Promise<LegQuote> {
    const originInfo = tokens[leg.fromChain]?.[leg.symbol];
    const destInfo = tokens[leg.toChain]?.[leg.symbol];
    if (!originInfo) throw new Error(`no token registry entry for ${leg.symbol} on ${leg.fromChain}`);
    if (!destInfo) throw new Error(`no token registry entry for ${leg.symbol} on ${leg.toChain}`);

    const list = await getTokenList();
    const originAsset = assetIdFor(leg.fromChain, originInfo.tokenId, list);
    const destinationAsset = assetIdFor(leg.toChain, destInfo.tokenId, list);
    if (!originAsset) throw new Error(`no 1click asset id for ${leg.symbol} on ${leg.fromChain}`);
    if (!destinationAsset) throw new Error(`no 1click asset id for ${leg.symbol} on ${leg.toChain}`);

    const deadline = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const body = {
      dry: true,
      swapType: 'EXACT_INPUT',
      slippageTolerance: 100,
      originAsset,
      destinationAsset,
      amount: toBaseUnits(leg.amount, originInfo.decimals),
      refundTo: leg.from,
      refundType: 'ORIGIN_CHAIN',
      recipient: leg.to,
      recipientType: 'DESTINATION_CHAIN',
      depositType: 'ORIGIN_CHAIN',
      deadline,
    };

    const res = await fetchImpl(ONECLICK_QUOTE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;

    if (!res.ok) {
      const msg = payload?.['message'] ?? payload?.['error'];
      throw new Error(msg !== undefined ? String(msg) : `1click quote failed: ${res.status}`);
    }
    const quote = payload?.['quote'] as Record<string, unknown> | undefined;
    if (!quote) {
      const msg = payload?.['message'];
      throw new Error(msg !== undefined ? String(msg) : 'no quote in 1click response');
    }

    const amountInUsd = Number(quote['amountInUsd']);
    const amountOutUsd = Number(quote['amountOutUsd']);
    const amountOutFormatted = Number(quote['amountOutFormatted']);

    return {
      amountOut: amountOutFormatted,
      feeUsd: amountInUsd - amountOutUsd,
      timeEstimateSec: Number(quote['timeEstimate']),
      raw: payload,
    };
  }

  return { name: 'oneclick', quoteLeg };
}

export function syntheticQuoter(): Quoter {
  return {
    name: 'synthetic',
    async quoteLeg(leg: TransferLeg): Promise<LegQuote> {
      return {
        amountOut: leg.amount * 0.9999 - 0.02,
        feeUsd: leg.amount * 0.0001 + 0.02,
        timeEstimateSec: 8,
      };
    },
  };
}

export function stubSigner(): Signer {
  const describe = () => 'No signer configured. Add keys via config to enable live execution (auth step).';
  return {
    ready: false,
    describe,
    async send() {
      return { ok: false, error: describe() };
    },
  };
}
