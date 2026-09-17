// Arbitrum gas as the chain itself prices it, and what 1Click's sweep would cost at that price.
//
// THE LOSS THIS MODELS. On 2026-09-15 1Click's HyperCore leg paid USDC to a forwarding wallet
// on Arbitrum and its relayer swept that wallet into Circle CCTP (`depositForBurn`) with a
// hard-coded 300,000 gas limit. Arbitrum charges every transaction for the L1 calldata it will
// post, in L2 gas units, and for a few minutes that evening the L1 charge was about 200x
// normal: the sweep carried 155,024 gas of L1 data on top of its own execution, ran out of
// gas at 300,000, was retried once, reverted, and nothing retried it again. The money sat on
// Arbitrum where an INTENTS refund cannot reach it. The vendor's other sweeps that day used
// about 204,000; the execution part is close to constant and the L1 part is what moves.
//
// THE MODEL. The precompile at 0x6C (ArbGasInfo) answers `getPricesInWei()` with six prices,
// two of which matter here: perL1CalldataByte, what a byte of L1 calldata costs right now in
// wei, and perArbGasTotal, what one unit of L2 gas costs. Their ratio times the sweep's bytes
// is the L1 charge in L2 gas units, which is exactly the number Arbiscan prints as
// gasUsedForL1. Added to the execution the sweep needs, that is what the relayer's limit has
// to cover. Nothing here signs or sends: it is arithmetic over three reads.

// ArbGasInfo. A precompile, so the address is the same on every Arbitrum chain.
export const ARB_GAS_INFO = '0x000000000000000000000000000000000000006C' as const;

export const ARB_GAS_INFO_ABI = [
  {
    type: 'function',
    name: 'getPricesInWei',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { type: 'uint256', name: 'perL2Tx' },
      { type: 'uint256', name: 'perL1CalldataByte' },
      { type: 'uint256', name: 'perStorageAllocation' },
      { type: 'uint256', name: 'perArbGasBase' },
      { type: 'uint256', name: 'perArbGasCongestion' },
      { type: 'uint256', name: 'perArbGasTotal' },
    ],
  },
  {
    type: 'function',
    name: 'getL1BaseFeeEstimate',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256', name: 'estimate' }],
  },
] as const;

// The gas limit 1Click's relayer sends its sweep with. Hard-coded on their side, read off the
// two failed sweeps on 2026-09-15 and the 23 that went through on 09-16.
export const VENDOR_SWEEP_GAS_LIMIT = 300_000;
// What the sweep's own execution takes, before the L1 charge: 300,000 minus the 155,024 of L1
// data on the sweep that ran out of gas, rounded to what the vendor's successful sweeps show.
export const SWEEP_L2_GAS_UNITS = 145_000;
// The calldata of a CCTP depositForBurn sweep as observed on the chain.
export const SWEEP_CALLDATA_BYTES = 420;
// Under this the sweep has room; between here and the limit it is elevated and the receipt
// says so; above the limit it fails the way it failed on 09-15.
export const SWEEP_OK_BELOW = 240_000;

export type ArbGasRead = {
  l2BaseFeeWei: bigint; // the L2 base fee off the latest block
  perL2Tx: bigint;
  perL1CalldataByte: bigint;
  perStorageAllocation: bigint;
  perArbGasBase: bigint;
  perArbGasCongestion: bigint;
  perArbGasTotal: bigint;
  l1BaseFeeEstimateWei: bigint;
};

export type SweepVerdict = 'ok' | 'elevated' | 'blocked';

export type SweepEstimate = {
  l1DataUnits: number; // the L1 charge in L2 gas units, what Arbiscan shows as gasUsedForL1
  gasUnits: number; // what the sweep needs in total
  limit: number; // what the vendor sends it with
  verdict: SweepVerdict;
};

// The L1 charge in L2 gas units, rounded up the way the chain rounds. Null when the L2 price
// is zero, which is a read this app cannot divide by rather than a free chain.
export function l1DataUnits(read: ArbGasRead): number | null {
  if (read.perArbGasTotal <= 0n) return null;
  const bytes = BigInt(SWEEP_CALLDATA_BYTES);
  const units = (read.perL1CalldataByte * bytes + read.perArbGasTotal - 1n) / read.perArbGasTotal;
  return Number(units);
}

export function sweepVerdict(gasUnits: number): SweepVerdict {
  if (gasUnits < SWEEP_OK_BELOW) return 'ok';
  if (gasUnits <= VENDOR_SWEEP_GAS_LIMIT) return 'elevated';
  return 'blocked';
}

export function sweepEstimate(read: ArbGasRead): SweepEstimate | null {
  const l1 = l1DataUnits(read);
  if (l1 === null) return null;
  const gasUnits = SWEEP_L2_GAS_UNITS + l1;
  return { l1DataUnits: l1, gasUnits, limit: VENDOR_SWEEP_GAS_LIMIT, verdict: sweepVerdict(gasUnits) };
}

// The three reads, through whatever viem client the caller hands in (src/chain/evm.ts
// reader('arb') in the app, a fake in the tests). Null when any of them fails: a preflight
// that cannot read the chain says so rather than guessing a price.
export type ArbGasClient = {
  readContract(args: { address: `0x${string}`; abi: typeof ARB_GAS_INFO_ABI; functionName: 'getPricesInWei' | 'getL1BaseFeeEstimate' }): Promise<unknown>;
  getBlock(): Promise<{ baseFeePerGas?: bigint | null }>;
};

function isBigintTuple(value: unknown, length: number): value is bigint[] {
  return Array.isArray(value) && value.length === length && value.every((v) => typeof v === 'bigint');
}

export async function readArbGas(client: ArbGasClient): Promise<ArbGasRead | null> {
  try {
    const [prices, l1, block] = await Promise.all([
      client.readContract({ address: ARB_GAS_INFO, abi: ARB_GAS_INFO_ABI, functionName: 'getPricesInWei' }),
      client.readContract({ address: ARB_GAS_INFO, abi: ARB_GAS_INFO_ABI, functionName: 'getL1BaseFeeEstimate' }),
      client.getBlock(),
    ]);
    if (!isBigintTuple(prices, 6) || typeof l1 !== 'bigint') return null;
    const baseFee = block.baseFeePerGas;
    if (typeof baseFee !== 'bigint') return null;
    return {
      l2BaseFeeWei: baseFee,
      perL2Tx: prices[0],
      perL1CalldataByte: prices[1],
      perStorageAllocation: prices[2],
      perArbGasBase: prices[3],
      perArbGasCongestion: prices[4],
      perArbGasTotal: prices[5],
      l1BaseFeeEstimateWei: l1,
    };
  } catch {
    return null;
  }
}
