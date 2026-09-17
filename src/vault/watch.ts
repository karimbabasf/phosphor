// The deposit watcher: one network and one asset at a time, from "the card is up" to "the money
// is credited", so the person who just sent a test amount from an exchange is told what happened
// to it while it is happening.
//
// FOUR PHASES, from two sources, and the settled one wins. `watching` is this process asking.
// `seen` is the NEAR Intents bridge saying a transfer to the deposit address has arrived on the
// origin chain (recent_deposits, status PENDING), and `bridged` is the same row at COMPLETED,
// the bridge's side done. `credited` is the verifier's own balance for that one asset (one
// mt_batch_balance_of per tick) having gone UP since the watch began: the only phase that is
// money the agent can move, and the only one that ends the watch. Karim, 2026-09-16: "if the
// only user feedback is a timer, it is freaky", so each phase carries what it knows: the hash,
// the explorer link, the confirmations on an EVM chain, the amount, and the last read failure.
//
// WHAT A TICK COSTS. One bridge call and one verifier call, every 3 s, plus two chain reads
// while a transfer is confirming. It used to be a full ledger refresh (three prices, the trading
// account, two verifier calls) racing the 15 s loop for the same ledger, which is where the
// flashing "Could not check NEAR Intents" came from. The ledger is touched once, through the one
// seam, when the money is credited, so the wallet card updates then rather than at the next poll.
//
// THE WATCH OUTLIVES THE CARD. A person closes the card and goes back to their agent in ten
// seconds; the deposit takes two minutes. So the watch runs until a minute after credited, or
// Stop, or a day, whichever first, and the window is told on every change over SSE as
// `{type:'deposit', ...}`; the backup nudge keys off the first `credited`.
// Nothing here is a control: the rails read balances from the ledger, never from this.

import type { Ledger } from '../ledger/index.ts';
import { fetchIntentsAssetBalance } from '../ledger/intents.ts';
import { chainSpec } from '../chain/evm.ts';
import { nearChainSpec } from '../chain/near.ts';
import { bridgeKeyOf, poaRecentDepositsOrThrow } from '../rails/intents-address.ts';
import type { PoaDeposit } from '../rails/intents-address.ts';
import { readTimeout } from '../net.ts';

export type DepositPhase = 'watching' | 'seen' | 'bridged' | 'credited' | 'stopped';

/** The asset being watched, as the show route resolved it from the bridge's own token list. */
export type DepositToken = {
  /** The verifier's id for it ('nep141:eth-0xa0b8....omft.near'), the bridge's intents_token_id. */
  assetId: string;
  decimals: number;
  /** The contract on the origin chain, null for the chain's own coin. Names the bridge's rows. */
  contract: string | null;
};

export type DepositState = {
  phase: DepositPhase;
  /** A receive network id from the registry in src/rails/intents-address.ts: 'btc', 'eth', 'sol'. */
  chain: string;
  symbol: string;
  /** The bridge address the card shows. Carried so a card opened from the agent's tool call can
   *  draw without a second fetch, and so the window can compare it to /api/intents-receive. */
  address: string | null;
  startedAt: string;
  /** What the asset already held when the watch began, in its own units. Credited is the rise. */
  baseline: number;
  /** The amount seen, bridged or credited, in the asset's units, once known. */
  amount: number | null;
  txHash: string | null;
  explorerUrl: string | null;
  /** Blocks on top of the one the transfer is in, on an EVM chain this app reads. null on any
   *  other chain, before the transfer is mined, and when the count could not be read. */
  confirmations: number | null;
  /** Milliseconds from the watch starting to the phase being reached. */
  ms: number | null;
  /** The last read that failed, in words, while it keeps failing; null once a read works. */
  error: string | null;
};

export type DepositWatch = {
  /** The agent or the window asked for the card. Starts the watch and tells the window. */
  show(chain: string, symbol: string, address: string | null, token?: DepositToken): DepositState;
  current(): DepositState | null;
  stop(): void;
};

const POLL_MS = 3_000;
const MAX_WATCH_MS = 24 * 60 * 60 * 1000;
// A minute more of balance reads after credited, so a second tranche is caught, then quiet.
const AFTER_CREDITED_MS = 60_000;

const NEAR_RPC_URL = nearChainSpec().rpcUrl;

// Explorer link prefixes for the chains the bridge fills tx_hash for beyond the EVM three
// (src/chain/evm.ts carries those). Anything else gets no link rather than a wrong one.
const EXPLORER_TX: Record<string, string> = {
  sol: 'https://solscan.io/tx/',
  near: 'https://nearblocks.io/txns/',
};

type EvmChain = 'eth' | 'base' | 'arb';

function evmChainOf(chain: string): EvmChain | null {
  return chain === 'eth' || chain === 'base' || chain === 'arb' ? chain : null;
}

function explorerTxUrl(chain: string, txHash: string): string | null {
  const evm = evmChainOf(chain);
  if (evm !== null) return chainSpec(evm).explorerTx + txHash;
  const prefix = EXPLORER_TX[chain];
  return prefix === undefined ? null : prefix + txHash;
}

/* Blocks on top of the block the transfer is in: the receipt's block against the head. Two plain
   JSON-RPC reads on the app's own deadline rather than viem's reader, because a tick is three
   seconds long and the reader retries for twenty. null while the transfer is not mined and on
   any failure: a count the app could not get is not zero. */
async function evmConfirmations(chain: EvmChain, txHash: string, fetchImpl: typeof fetch): Promise<number | null> {
  const spec = chainSpec(chain);
  const call = async (method: string, params: unknown[]): Promise<unknown> => {
    const res = await fetchImpl(spec.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: readTimeout(),
    });
    if (!res.ok) throw new Error(`${chain} ${method} http ${res.status}`);
    return ((await res.json()) as { result?: unknown }).result;
  };
  try {
    const [receipt, head] = await Promise.all([call('eth_getTransactionReceipt', [txHash]), call('eth_blockNumber', [])]);
    const mined = (receipt as { blockNumber?: unknown } | null)?.blockNumber;
    if (typeof mined !== 'string' || typeof head !== 'string') return null;
    const depth = Number(BigInt(head) - BigInt(mined)) + 1;
    return Number.isFinite(depth) && depth >= 0 ? depth : null;
  } catch {
    return null;
  }
}

/* Is this bridge row the asset being watched. The bridge names the asset its own way, 'eth:1:0xa0b8...'
   or 'eth:1:native', in whatever case it likes; a row that names only the network (or nothing) is
   taken as ours, because it is on our address and our chain and a person at this card has sent one
   thing. Without a token to compare against, the symbol in the identifier is all there is. */
function sameAsset(row: PoaDeposit, bridgeKey: string | undefined, token: DepositToken | null, symbol: string): boolean {
  const asset = row.asset.toLowerCase();
  if (asset === '' || (bridgeKey !== undefined && asset === bridgeKey)) return true;
  if (token === null) return asset.includes(symbol.toLowerCase());
  const rest = asset.split(':').slice(2).join(':');
  return rest === (token.contract === null ? 'native' : token.contract.toLowerCase());
}

// The row's amount in the asset's units, by the row's own scale when the bridge sent one.
function rowAmount(row: PoaDeposit, token: DepositToken | null): number | null {
  const decimals = row.decimals ?? token?.decimals;
  if (decimals === undefined || !/^\d+$/.test(row.amount)) return null;
  return Number(BigInt(row.amount)) / 10 ** decimals;
}

// A row's identity across polls: the hash where the bridge fills one (EVM), the asset and the
// amount where it does not.
function keyOf(row: PoaDeposit): string {
  return row.txHash !== '' ? row.txHash : `${row.asset}|${row.amount}`;
}

function units(base: bigint, decimals: number): number {
  return Number(base) / 10 ** decimals;
}

const RANK: Record<DepositPhase, number> = { watching: 0, seen: 1, bridged: 2, credited: 3, stopped: 4 };

type Deps = {
  /** The last known holdings, for the baseline the rise is measured from. Never refreshed from here. */
  ledger: Ledger;
  sse: { broadcast: (payload: unknown) => void; broadcastState?: () => void };
  /** The intents account the bridge credits: the wallet's EVM address, lowercased. */
  account: () => string | null;
  /** The one refresh seam (refreshNow in src/main.ts): called once when money is credited, and
   *  once at show() when the ledger has never read this wallet. Never ledger.refresh() from here:
   *  two loops refreshing the same ledger raced each other into a flashing warning. */
  refresh: () => Promise<void>;
  /** Every read goes through this, so a test stands in for the bridge, the verifier and the
   *  chain with one function. */
  fetchImpl?: typeof fetch;
  recent?: (account: string, chain: string) => Promise<PoaDeposit[]>;
  balance?: (account: string, assetId: string) => Promise<bigint | null>;
  confirmations?: (chain: string, txHash: string) => Promise<number | null>;
  now?: () => number;
  pollMs?: number;
};

export function createDepositWatch(deps: Deps): DepositWatch {
  const now = deps.now ?? Date.now;
  const pollMs = deps.pollMs ?? POLL_MS;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const recent = deps.recent ?? ((account: string, chain: string) => poaRecentDepositsOrThrow(account, chain, fetchImpl));
  const balance =
    deps.balance ??
    ((account: string, assetId: string) => fetchIntentsAssetBalance({ rpcUrl: NEAR_RPC_URL, accountId: account, assetId, fetchImpl }));
  const confirmations =
    deps.confirmations ??
    ((chain: string, txHash: string) => {
      const evm = evmChainOf(chain);
      return evm === null ? Promise.resolve(null) : evmConfirmations(evm, txHash, fetchImpl);
    });

  let state: DepositState | null = null;
  let timer: NodeJS.Timeout | null = null;
  let started = 0;
  // Beside the frame, per watch: what the frame does not carry.
  let generation = 0;
  let token: DepositToken | null = null;
  let baseline: bigint | null = null;
  // The refresh fired at show() when the ledger has never read this wallet, awaited by the
  // first tick so the baseline can come from the ledger rather than from the first live read.
  let priming: Promise<void> | null = null;
  // Rows already COMPLETED when the watch began: yesterday's deposit, not the one being watched.
  let history = new Set<string>();
  let firstPoll = true;
  let creditedAt = 0;
  let inFlight = false;

  function announce(): void {
    if (state !== null) deps.sse.broadcast({ type: 'deposit', ...state });
  }

  // The window hears about changes, not ticks: the same facts twice are said once.
  function commit(next: DepositState): void {
    if (state !== null && JSON.stringify(next) === JSON.stringify(state)) return;
    state = next;
    announce();
  }

  function stopTimer(): void {
    if (timer !== null) clearInterval(timer);
    timer = null;
  }

  // What the ledger last saw the asset hold, in base units; null when it has not read this
  // wallet (or its last read failed), so the first live read stands in instead. An account
  // with a good read and no row for the asset holds none of it.
  function baselineFromLedger(): bigint | null {
    if (token === null) return null;
    const read = deps.ledger.intents();
    if (read === undefined || !read.ok) return null;
    const row = read.holdings.find((h) => h.assetId === token!.assetId);
    if (row === undefined) return 0n;
    if (row.amountBase !== undefined && /^\d+$/.test(row.amountBase)) return BigInt(row.amountBase);
    return BigInt(Math.round(row.amount * 10 ** row.decimals));
  }

  /* Which of the bridge's rows is this deposit. The first poll that answers takes a snapshot of
     the rows already complete, and those are never it. After that, the newest row for the asset
     that is not history; once a hash is known, that row is followed for its status change. */
  function pickRow(rows: PoaDeposit[], current: DepositState): PoaDeposit | undefined {
    const bridgeKey = bridgeKeyOf(current.chain);
    const mine = rows.filter((r) => r.status !== 'FAILED' && sameAsset(r, bridgeKey, token, current.symbol));
    if (firstPoll) {
      firstPoll = false;
      for (const r of mine) if (r.status === 'COMPLETED') history.add(keyOf(r));
    }
    const live = mine.filter((r) => !history.has(keyOf(r)));
    if (current.txHash !== null) {
      const followed = live.find((r) => r.txHash === current.txHash);
      if (followed !== undefined) return followed;
    }
    return live[0];
  }

  async function poll(gen: number): Promise<void> {
    const current = state;
    if (current === null) return;
    if (current.phase === 'credited') {
      if (now() - creditedAt > AFTER_CREDITED_MS) stopTimer();
      if (timer === null) return;
    } else if (now() - started > MAX_WATCH_MS) {
      stopTimer();
      commit({ ...current, phase: 'stopped' });
      return;
    }
    // No wallet yet is not an error: the card can go up before the wallet is made, and the
    // next tick asks again. The account is resolved per tick for exactly that reason.
    const account = deps.account();
    if (account === null) return;
    if (baseline === null && priming !== null) {
      await priming;
      priming = null;
      if (gen !== generation) return;
      baseline = baselineFromLedger();
    }

    const askBridge = current.phase !== 'credited';
    const [bridge, held] = await Promise.all([
      askBridge
        ? recent(account, current.chain).then(
            (rows) => ({ rows, failed: false }),
            () => ({ rows: [] as PoaDeposit[], failed: true }),
          )
        : Promise.resolve({ rows: [] as PoaDeposit[], failed: false }),
      token !== null ? balance(account, token.assetId) : Promise.resolve(null),
    ]);
    if (gen !== generation || state === null) return;

    const next: DepositState = { ...current };
    // The verifier first: credited is the settled truth and wins over anything the bridge says.
    if (token === null) {
      next.error = `Cannot check the ${current.symbol} balance: the bridge gave this token no intents id`;
    } else if (held === null) {
      next.error = 'The verifier is not answering, retrying';
    } else {
      next.error = bridge.failed ? 'The bridge is not answering, retrying' : null;
      if (baseline === null) {
        baseline = held;
        next.baseline = units(held, token.decimals);
      } else if (held > baseline) {
        if (next.phase !== 'credited') {
          next.phase = 'credited';
          next.ms = now() - started;
          creditedAt = now();
        }
        next.amount = units(held - baseline, token.decimals);
      }
    }

    if (next.phase !== 'credited' && askBridge && !bridge.failed) {
      const row = pickRow(bridge.rows, next);
      if (row !== undefined) {
        const phase: DepositPhase = row.status === 'COMPLETED' ? 'bridged' : 'seen';
        if (RANK[phase] > RANK[next.phase]) {
          next.phase = phase;
          next.ms = now() - started;
        }
        if (row.txHash !== '') next.txHash = row.txHash;
        next.explorerUrl = next.txHash === null ? null : explorerTxUrl(current.chain, next.txHash);
        const amount = rowAmount(row, token);
        if (amount !== null) next.amount = amount;
        if (next.phase === 'seen' && next.txHash !== null) {
          next.confirmations = await confirmations(current.chain, next.txHash);
          if (gen !== generation || state === null) return;
        }
      }
    }

    const credited = current.phase !== 'credited' && next.phase === 'credited';
    commit(next);
    if (credited) {
      // The wallet card should show the money now, not at the next poll: one refresh through
      // the seam, then the state frame that makes the window fetch it.
      try {
        await deps.refresh();
      } catch {
        // The 15 s loop reads it next; the credited frame has already gone out.
      }
      deps.sse.broadcastState?.();
    }
  }

  // One poll at a time: a slow bridge answer must not stack ticks behind it.
  async function tick(): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    const gen = generation;
    try {
      await poll(gen);
    } catch (err) {
      if (gen === generation && state !== null) {
        commit({ ...state, error: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      inFlight = false;
    }
  }

  return {
    show(chain, symbol, address, tok) {
      stopTimer();
      generation += 1;
      started = now();
      token = tok !== undefined && tok.assetId !== '' ? tok : null;
      history = new Set();
      firstPoll = true;
      creditedAt = 0;
      inFlight = false;
      baseline = baselineFromLedger();
      priming = baseline === null && token !== null ? deps.refresh().catch(() => undefined) : null;
      state = {
        phase: 'watching',
        chain,
        symbol: symbol.toUpperCase(),
        address,
        startedAt: new Date(started).toISOString(),
        baseline: baseline === null || token === null ? 0 : units(baseline, token.decimals),
        amount: null,
        txHash: null,
        explorerUrl: null,
        confirmations: null,
        ms: null,
        error: null,
      };
      announce();
      timer = setInterval(() => {
        void tick();
      }, pollMs);
      timer.unref?.();
      return state;
    },
    current: () => state,
    stop() {
      stopTimer();
      if (state !== null && state.phase !== 'credited') commit({ ...state, phase: 'stopped' });
    },
  };
}
