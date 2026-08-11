// Fixture loader for demo mode. Reads data/demo-state.json (+ data/tokens.json for tokenId
// lookups) and produces a full LedgerSnapshot. Pure and synchronous: no network, no mutation.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { ChainId, ChainStatus, Holding, LedgerSnapshot } from '../types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEMO_STATE_PATH = path.join(__dirname, '..', '..', 'data', 'demo-state.json');
const TOKENS_PATH = path.join(__dirname, '..', '..', 'data', 'tokens.json');

type DemoStateFile = {
  prices: Record<string, number>;
  gasGwei: Record<string, number>;
  accounts: { evm: string; solana: string; near: string };
  holdings: Array<{ chain: ChainId; symbol: string; amount: number; native?: boolean }>;
};

type TokenTable = Record<string, Record<string, { tokenId: string; decimals: number }>>;

const ALL_CHAINS: ChainId[] = ['eth', 'base', 'arb', 'sol', 'near'];

// Est. cost of one stable transfer out of a chain, in usd. Constants per the plan's Task B spec.
const EVM_TRANSFER_GAS_UNITS = 65000; // typical gas for an ERC-20 transfer with headroom
const SOL_TRANSFER_LAMPORTS = 0.000005; // one signature fee
const SOL_TRANSFER_SIGNATURES = 2; // ata-create + transfer, worst case
const NEAR_TRANSFER_NATIVE = 0.005; // ft_transfer call + storage headroom

function accountFor(accounts: DemoStateFile['accounts'], chain: ChainId): string {
  if (chain === 'sol') return accounts.solana;
  if (chain === 'near') return accounts.near;
  return accounts.evm; // eth, base, arb share one evm address
}

function tokenIdFor(tokens: TokenTable, chain: ChainId, symbol: string): string {
  return tokens[chain]?.[symbol]?.tokenId ?? symbol;
}

export function loadDemoLedger(): LedgerSnapshot {
  const raw = JSON.parse(readFileSync(DEMO_STATE_PATH, 'utf8')) as DemoStateFile;
  const tokens = JSON.parse(readFileSync(TOKENS_PATH, 'utf8')) as TokenTable;
  const fetchedAt = new Date().toISOString();

  const ethUsd = raw.prices.ETH ?? 0;
  const solUsd = raw.prices.SOL ?? 0;
  const nearUsd = raw.prices.NEAR ?? 0;
  const prices: Record<string, number> = { ETH: ethUsd, SOL: solUsd, NEAR: nearUsd };

  const holdings: Holding[] = raw.holdings.map(h => {
    const native = !!h.native;
    const usd = native ? h.amount * (prices[h.symbol] ?? 0) : h.amount;
    return {
      chain: h.chain,
      address: accountFor(raw.accounts, h.chain),
      symbol: h.symbol,
      tokenId: native ? 'native' : tokenIdFor(tokens, h.chain, h.symbol),
      amount: h.amount,
      usd,
      native,
    };
  });

  const chainStatus = Object.fromEntries(
    ALL_CHAINS.map(c => [c, { ok: true, fetchedAt } satisfies ChainStatus]),
  ) as Record<ChainId, ChainStatus>;

  const evmTransferCostUsd = (gwei: number) => gwei * 1e-9 * EVM_TRANSFER_GAS_UNITS * ethUsd;
  const gas: Record<ChainId, { transferCostUsd: number }> = {
    eth: { transferCostUsd: evmTransferCostUsd(raw.gasGwei.eth ?? 0) },
    base: { transferCostUsd: evmTransferCostUsd(raw.gasGwei.base ?? 0) },
    arb: { transferCostUsd: evmTransferCostUsd(raw.gasGwei.arb ?? 0) },
    sol: { transferCostUsd: SOL_TRANSFER_LAMPORTS * solUsd * SOL_TRANSFER_SIGNATURES },
    near: { transferCostUsd: NEAR_TRANSFER_NATIVE * nearUsd },
  };

  return { holdings, chainStatus, mode: 'demo', prices, gas };
}
