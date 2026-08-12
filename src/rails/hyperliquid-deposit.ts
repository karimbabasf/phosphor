// The Hyperliquid deposit rail: move USDC from Arbitrum into a Hyperliquid account.
//
// The deposit is a plain ERC-20 transfer to the Bridge2 contract. Bridge2 has no deposit()
// function and takes no signed payload: it credits whoever sent the tokens, in under a
// minute. Verified against a real testnet deposit, tx
// 0xd5a06833f3e299cce32a957e4078d473d14954b3aa9ec55cd966abc527015c03, whose input decodes
// to transfer(0x08cfc1B6...56f89, 10000000).
//
// Almost everything in this module is refusal, because this rail's failure mode is not an
// error. It is silent permanent loss:
//   - the MAINNET bridge address holds NO CONTRACT on Arbitrum Sepolia. Live eth_getCode on
//     2026-08-11 returned 0x. A transfer there lands in an EOA nobody has the key to.
//   - below 5 USDC the deposit is not credited at all. The docs say the funds are "lost
//     forever". The minimum lives on the validator side, so no contract will reject it.
//   - Bridge2 accepts exactly one token. Sending any other ERC-20 leaves it stuck in the
//     bridge: ~1,946 canonical USDC is sitting there right now from people who got this wrong.
// None of those three revert. None are recoverable. So simulate() reads the chain before it
// agrees to anything, and execute() re-runs simulate() instead of trusting an approval that
// may be minutes old.
//
// The bridge is officially the legacy path (Hyperliquid now points at CCTP) but it is the
// only documented testnet route, and it still carries live testnet deposits.

import { formatUnits, isAddress, parseUnits } from 'viem';
import type { Address, Hex } from 'viem';
import { erc20Balance, erc20TransferData, evmAddress, reader, sendTx } from '../chain/evm.ts';
import type { SendOutcome, SendParams } from '../chain/evm.ts';
import type { ChainId, HlDepositDraft, Network, Rail, RailResult, SimulationResult } from '../types.ts';

// ---------- the per-network table ----------

// Every address the rail can reach is in here, keyed by network. Nothing has a default:
// a default is how a testnet build ends up holding a mainnet address.
export type HlNetworkSpec = {
  chain: ChainId; // the EVM chain the deposit rides
  bridge: Address; // Bridge2
  usdc: Address; // the ONLY token Bridge2 credits
  symbol: string; // testnet's is a mock called USDC2, not canonical USDC
  decimals: number;
  infoUrl: string;
  label: string; // for humans reading a refusal
};

const HL_NETWORKS: Record<Network, HlNetworkSpec> = {
  testnet: {
    chain: 'arb',
    bridge: '0x08cfc1B6b2dCF36A1480b99353A354AA8AC56f89',
    usdc: '0x1baAbB04529D43a73232B713C0FE471f7c7334d5',
    symbol: 'USDC2',
    decimals: 6,
    infoUrl: 'https://api.hyperliquid-testnet.xyz/info',
    label: 'Arbitrum Sepolia',
  },
  mainnet: {
    chain: 'arb',
    bridge: '0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7',
    usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    symbol: 'USDC',
    decimals: 6,
    infoUrl: 'https://api.hyperliquid.xyz/info',
    label: 'Arbitrum One',
  },
};

export function hlSpec(network: Network): HlNetworkSpec {
  const spec = HL_NETWORKS[network];
  if (spec === undefined) throw new Error(`no Hyperliquid spec for network ${JSON.stringify(network)}`);
  return spec;
}

// Documented once for the bridge in general, with no separate testnet number. On-chain
// evidence agrees: of the last 12 testnet deposits, five were exactly 5.000000 and none
// were smaller.
export const MIN_DEPOSIT_USDC = 5;

// ---------- amounts ----------

// HlDepositDraft.amount is a UI-unit number because every draft in the app is, but the
// transfer moves base units and a float that cannot be represented exactly must never be
// silently rounded into a balance. Convert through a fixed decimal string and refuse
// anything that does not survive the round trip.
export function toUnits(amount: number, decimals: number): bigint {
  if (!Number.isFinite(amount)) throw new Error(`amount ${amount} is not a finite number`);
  if (amount <= 0) throw new Error(`amount must be positive (got ${amount})`);
  const fixed = amount.toFixed(decimals);
  // toFixed goes exponential past 1e21, which parseUnits cannot read.
  if (!/^\d+(\.\d+)?$/.test(fixed)) throw new Error(`amount ${amount} is out of range`);
  if (Number(fixed) !== amount) {
    throw new Error(`amount ${amount} needs more than ${decimals} decimals; rounding it to ${fixed} would move a different amount`);
  }
  return parseUnits(fixed, decimals);
}

// ---------- the chain seam ----------

// A thin port over chain/evm.ts, which stays the only module that signs. It exists so the
// refusal tests can present a bridge with no code, or a wallet that is short, without an RPC.
export type HlEvmPort = {
  code(network: Network, chain: ChainId, address: Address): Promise<Hex | undefined>;
  erc20Balance(network: Network, chain: ChainId, token: Address, owner: Address): Promise<bigint>;
  nativeBalance(network: Network, chain: ChainId, owner: Address): Promise<bigint>;
  signerAddress(keysPath: string): Address;
  send(params: SendParams): Promise<SendOutcome>;
};

// viem 2.55 calls this getCode; getBytecode is the older alias for the same eth_getCode.
export const liveEvmPort: HlEvmPort = {
  code: (network, chain, address) => reader(network, chain).getCode({ address }),
  erc20Balance,
  nativeBalance: (network, chain, owner) => reader(network, chain).getBalance({ address: owner }),
  signerAddress: evmAddress,
  send: sendTx,
};

function hasCode(code: Hex | undefined): boolean {
  return code !== undefined && code !== '0x' && code.length > 2;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sameAddress(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

// ---------- account state ----------

export type HlSpotBalance = { coin: string; token: number; total: number; hold: number };

export type HlAccountState = {
  address: string;
  network: Network;
  accountValueUsd: number; // perp side; a bridge deposit lands here
  withdrawableUsd: number;
  marginUsedUsd: number;
  openPositions: number;
  spot: HlSpotBalance[]; // spot USDC is a SEPARATE balance from the perp one
  funded: boolean;
  fetchedAt: string;
};

type ClearinghouseState = {
  marginSummary?: { accountValue?: string; totalMarginUsed?: string };
  withdrawable?: string;
  assetPositions?: unknown[];
};

type SpotClearinghouseState = {
  balances?: Array<{ coin?: string; token?: number; total?: string; hold?: string }>;
};

// Every number in these responses is a string, and a malformed one must read as zero
// rather than NaN: NaN silently poisons every comparison downstream.
function num(value: string | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// ---------- the rail ----------

export type HlDepositDeps = {
  network: Network;
  keysPath: string;
  evm?: HlEvmPort;
  fetchImpl?: typeof fetch;
};

export type HlDepositRail = Rail<HlDepositDraft> & {
  spec: HlNetworkSpec;
  accountState(address: string): Promise<HlAccountState>;
};

export function hlDepositRail(deps: HlDepositDeps): HlDepositRail {
  const { network, keysPath } = deps;
  const evm = deps.evm ?? liveEvmPort;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const spec = hlSpec(network);
  const minUnits = parseUnits(String(MIN_DEPOSIT_USDC), spec.decimals);

  function show(units: bigint): string {
    return formatUnits(units, spec.decimals);
  }

  function refusal(draft: HlDepositDraft, reasons: string[]): SimulationResult {
    const joined = reasons.join('; ');
    return {
      ok: false,
      summary: `REFUSED: deposit ${draft.amount} ${spec.symbol} to Hyperliquid ${network} - ${joined}`,
      error: joined,
    };
  }

  // Everything decidable without touching the network. It runs first because a wrong
  // address here would make the chain reads below answer questions about the wrong contract.
  function checkShape(draft: HlDepositDraft): { reasons: string[]; units: bigint } {
    const reasons: string[] = [];

    if (draft.chain !== spec.chain) {
      reasons.push(`draft rides chain ${draft.chain}, but the Hyperliquid ${network} bridge is on ${spec.chain} (${spec.label})`);
    }

    if (!isAddress(draft.bridge.trim())) {
      reasons.push(`bridge ${draft.bridge} is not an address`);
    } else if (!sameAddress(draft.bridge, spec.bridge)) {
      const other = network === 'testnet' ? HL_NETWORKS.mainnet : HL_NETWORKS.testnet;
      if (sameAddress(draft.bridge, other.bridge)) {
        // The single most expensive mistake this rail can make.
        reasons.push(
          `bridge ${draft.bridge} is the ${network === 'testnet' ? 'MAINNET' : 'TESTNET'} bridge and this app runs on ${network}. ` +
            `That address holds no contract on ${spec.label}, so the transfer would land in a dead EOA and the funds would be unrecoverable. ` +
            `The ${network} bridge is ${spec.bridge}`,
        );
      } else {
        reasons.push(`bridge ${draft.bridge} is not the Hyperliquid ${network} bridge (expected ${spec.bridge})`);
      }
    }

    // Testnet's token is a mock named USDC2, so a draft written as plain 'USDC' is correct
    // on both networks. Anything else is a token the bridge will not credit.
    const symbol = draft.symbol.trim().toUpperCase();
    if (symbol !== 'USDC' && symbol !== spec.symbol.toUpperCase()) {
      reasons.push(`symbol ${draft.symbol} is not the token Bridge2 accepts (${spec.symbol} at ${spec.usdc}); any other token stays stuck in the bridge`);
    }

    // Bridge2 credits the account that SENT the tokens, which is the key at keysPath and
    // not whatever the draft says. A mismatch funds a Hyperliquid account we cannot trade.
    if (!isAddress(draft.from.trim())) {
      reasons.push(`from ${draft.from} is not an address`);
    } else {
      let signer: Address | null = null;
      try {
        signer = evm.signerAddress(keysPath);
      } catch (err) {
        reasons.push(`cannot resolve the signing wallet: ${errText(err)}`);
      }
      if (signer !== null && !sameAddress(draft.from, signer)) {
        reasons.push(
          `draft deposits from ${draft.from} but this app signs with ${signer}. ` +
            `Bridge2 credits the sending address, so the deposit would fund a Hyperliquid account we hold no key for`,
        );
      }
    }

    let units = 0n;
    try {
      units = toUnits(draft.amount, spec.decimals);
    } catch (err) {
      reasons.push(errText(err));
    }

    if (units > 0n && units < minUnits) {
      reasons.push(
        `amount ${draft.amount} is below the ${MIN_DEPOSIT_USDC} USDC minimum. ` +
          `Hyperliquid does not credit a smaller deposit and the docs say it is lost forever`,
      );
    }

    return { reasons, units };
  }

  async function simulate(draft: HlDepositDraft): Promise<SimulationResult> {
    const shape = checkShape(draft);
    if (shape.reasons.length > 0) return refusal(draft, shape.reasons);
    const units = shape.units;
    const from = draft.from.trim() as Address;

    let bridgeCode: Hex | undefined;
    let tokenCode: Hex | undefined;
    let balance = 0n;
    let gas = 0n;
    try {
      [bridgeCode, tokenCode, balance, gas] = await Promise.all([
        evm.code(network, spec.chain, spec.bridge),
        evm.code(network, spec.chain, spec.usdc),
        evm.erc20Balance(network, spec.chain, spec.usdc, from),
        evm.nativeBalance(network, spec.chain, from),
      ]);
    } catch (err) {
      // A chain we cannot read is not a chain we may send to.
      return refusal(draft, [`could not read ${spec.label}: ${errText(err)}`]);
    }

    const reasons: string[] = [];

    // The check that catches the network mixup even when the address table is wrong.
    if (!hasCode(bridgeCode)) {
      reasons.push(
        `the bridge ${spec.bridge} has NO CONTRACT on ${spec.label}: eth_getCode returns 0x. ` +
          `A transfer to a bare address is unrecoverable, so this rail will not send one`,
      );
    }
    if (!hasCode(tokenCode)) {
      reasons.push(`the token ${spec.usdc} has NO CONTRACT on ${spec.label}: eth_getCode returns 0x, so a transfer call would do nothing while reporting success`);
    }
    if (balance < units) {
      reasons.push(`wallet holds ${show(balance)} ${spec.symbol} on ${spec.label} and the deposit needs ${show(units)}`);
    }
    if (gas === 0n) {
      reasons.push(`wallet holds no ETH on ${spec.label} and cannot pay gas for the transfer`);
    }

    if (reasons.length > 0) return refusal(draft, reasons);

    return {
      ok: true,
      summary:
        `Deposit ${show(units)} ${spec.symbol} to Hyperliquid ${network}. ` +
        `Plain ERC-20 transfer on ${spec.label}: ${spec.usdc}.transfer(${spec.bridge}, ${units.toString()}), from ${from}. ` +
        `Wallet holds ${show(balance)} ${spec.symbol} and ${formatUnits(gas, 18)} ETH. ` +
        `Bridge2 credits the sending address in under a minute; getting it back out needs a signed withdraw3.`,
    };
  }

  async function execute(draft: HlDepositDraft): Promise<RailResult> {
    // Re-simulate rather than trust the approval. An approval can be minutes old, and the
    // refusals above describe permanent loss, not a revert we could read afterwards.
    const check = await simulate(draft);
    if (!check.ok) return { ok: false, detail: check.error ?? check.summary };

    const units = toUnits(draft.amount, spec.decimals);
    const outcome = await evm.send({
      network,
      chain: spec.chain,
      keysPath,
      to: spec.usdc,
      data: erc20TransferData(spec.bridge, units),
    });

    if (!outcome.ok) {
      return { ok: false, detail: `deposit failed: ${outcome.error ?? 'unknown error'}${outcome.hash ? ` (${outcome.hash})` : ''}` };
    }
    return {
      ok: true,
      detail:
        `deposited ${show(units)} ${spec.symbol} to the Hyperliquid ${network} bridge. ` +
        `${outcome.explorer ?? outcome.hash}. Credit lands on the account in under a minute.`,
      txids: outcome.hash !== undefined ? [outcome.hash] : [],
    };
  }

  async function info<T>(body: Record<string, unknown>): Promise<T> {
    const res = await fetchImpl(spec.infoUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`hyperliquid ${String(body.type)} failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }

  // Perp and spot are two separate balances on the same account, so both are read. An
  // unknown address answers 200 with zeros rather than 404, which is why `funded` is a
  // question about the values and never about the status code.
  async function accountState(address: string): Promise<HlAccountState> {
    if (!isAddress(address.trim())) throw new Error(`hyperliquid accountState: ${address} is not an address`);
    const user = address.trim();

    const [perp, spotState] = await Promise.all([
      info<ClearinghouseState>({ type: 'clearinghouseState', user, dex: '' }),
      info<SpotClearinghouseState>({ type: 'spotClearinghouseState', user }),
    ]);

    const spot: HlSpotBalance[] = (spotState.balances ?? []).map((b) => ({
      coin: b.coin ?? '',
      token: b.token ?? -1,
      total: num(b.total),
      hold: num(b.hold),
    }));

    const accountValueUsd = num(perp.marginSummary?.accountValue);
    return {
      address: user,
      network,
      accountValueUsd,
      withdrawableUsd: num(perp.withdrawable),
      marginUsedUsd: num(perp.marginSummary?.totalMarginUsed),
      openPositions: Array.isArray(perp.assetPositions) ? perp.assetPositions.length : 0,
      spot,
      funded: accountValueUsd > 0 || spot.some((b) => b.total > 0),
      fetchedAt: new Date().toISOString(),
    };
  }

  return {
    kind: 'hl_deposit',
    spec,
    // USDC is a dollar stable, so the two agree in practice. Taking the larger is the
    // pessimistic read: a draft that under-reports its USD value must not slip under a budget.
    valueUsd: (draft) => Math.max(draft.amountUsd, draft.amount),
    simulate,
    execute,
    accountState,
  };
}
