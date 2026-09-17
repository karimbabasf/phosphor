// The preflight wired to the world: viem for the chains, the verifier for the balance, the
// ledger for the price, and the venue probe the spend path hands over. One instance per app
// process, built by src/rails/index.ts and shared by the rails that run it, so the hour of gas
// readings is one hour and not one per rail.
//
// THE SAMPLER. The receipt draws an hour of readings, and a send happens rarely, so the
// history would be one dot without help. After any preflight this keeps reading the chains
// it touched once a minute for an hour, then stops until the next preflight. The timer never
// holds the process open.

import type { PublicClient } from 'viem';
import { reader } from '../chain/evm.ts';
import { nearChainSpec } from '../chain/near.ts';
import { fetchIntentsAssetBalance } from '../ledger/intents.ts';
import type { OneClickQuote } from '../intents.ts';
import type { Preflight, WriteDraft } from '../types.ts';
import { readArbGas, sweepEstimate } from './arbitrum.ts';
import type { ArbGasClient, ArbGasRead } from './arbitrum.ts';
import { createGasHistory } from './history.ts';
import type { GasHistory } from './history.ts';
import { runPreflight } from './index.ts';
import type { GasChain, VenueProbe } from './index.ts';

// What the spend path knows at the moment the checks run: whose balance, which asset, and the
// venue reads built from the same client and request as the live quote.
export type PreflightPort = { owner: string; originAsset: string; venue: VenueProbe };

export type PreflightRunner = {
  run(kind: WriteDraft['kind'], draft: WriteDraft, quote: OneClickQuote, port: PreflightPort): Promise<Preflight>;
  stop(): void;
};

export type LivePreflightDeps = {
  prices: () => Record<string, number>;
  fetchImpl?: typeof fetch;
  // The chain clients, by chain. Defaults to src/chain/evm.ts; a test hands in fakes.
  clients?: Partial<Record<GasChain, PublicClient>>;
  now?: () => number;
  sampleMs?: number;
};

export const SAMPLE_MS = 60_000;
const SAMPLE_FOR_MS = 60 * 60_000;

function asArbClient(client: PublicClient): ArbGasClient {
  return {
    readContract: (args) => client.readContract(args as never),
    getBlock: () => client.getBlock(),
  };
}

export function createLivePreflight(deps: LivePreflightDeps): PreflightRunner {
  const now = deps.now ?? Date.now;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const history: Record<GasChain, GasHistory> = { arb: createGasHistory(), eth: createGasHistory(), base: createGasHistory() };
  const touched = new Set<GasChain>();
  let lastRunAt = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  function client(chain: GasChain): PublicClient {
    return deps.clients?.[chain] ?? reader(chain);
  }

  async function arbitrum(): Promise<ArbGasRead | null> {
    touched.add('arb');
    return readArbGas(asArbClient(client('arb')));
  }

  async function baseFee(chain: 'eth' | 'base'): Promise<bigint | null> {
    touched.add(chain);
    try {
      const block = await client(chain).getBlock();
      return typeof block.baseFeePerGas === 'bigint' ? block.baseFeePerGas : null;
    } catch {
      return null;
    }
  }

  // One reading per touched chain, pushed straight into the hour.
  async function sample(): Promise<void> {
    const at = now();
    if (at - lastRunAt > SAMPLE_FOR_MS) {
      stop();
      return;
    }
    for (const chain of touched) {
      if (chain === 'arb') {
        const read = await readArbGas(asArbClient(client('arb')));
        const estimate = read === null ? null : sweepEstimate(read);
        if (estimate !== null) history.arb.push(at, estimate.gasUnits);
      } else {
        const fee = await baseFee(chain);
        if (fee !== null) history[chain].push(at, Number(fee) / 1e9);
      }
    }
  }

  function keepSampling(): void {
    if (timer !== null) return;
    timer = setInterval(() => {
      void sample().catch(() => {
        // a missed sample is a gap in the sparkline, nothing more
      });
    }, deps.sampleMs ?? SAMPLE_MS);
    timer.unref?.();
  }

  function stop(): void {
    if (timer !== null) clearInterval(timer);
    timer = null;
  }

  async function run(kind: WriteDraft['kind'], draft: WriteDraft, quote: OneClickQuote, port: PreflightPort): Promise<Preflight> {
    lastRunAt = now();
    const result = await runPreflight(kind, draft, quote, {
      now,
      arbitrum,
      baseFee,
      history,
      venue: port.venue,
      balance: () => fetchIntentsAssetBalance({ rpcUrl: nearChainSpec().rpcUrl, accountId: port.owner, assetId: port.originAsset, fetchImpl }),
      priceUsd: (symbol) => {
        const price = deps.prices()[symbol.toUpperCase()];
        return typeof price === 'number' && price > 0 ? price : null;
      },
    });
    keepSampling();
    return result;
  }

  return { run, stop };
}
