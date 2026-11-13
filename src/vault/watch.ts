// The deposit watcher: one network and one asset at a time, from "the card is up" to "the money
// is credited", so the person who just sent a test amount from an exchange is told what happened
// to it while it is happening.
//
// FOUR PHASES, from two sources, and the settled one wins. `watching` is this process asking.
// `seen` is 1Click saying a transfer to the one-time address has arrived on the origin chain
// (GET /v0/status: KNOWN_DEPOSIT_TX, PROCESSING, INCOMPLETE_DEPOSIT, REFUNDED), and `bridged` is
// SUCCESS, 1Click's side done. `credited` is the verifier's own balance for that one asset (one
// mt_batch_balance_of per tick) having gone UP since the watch began: the only phase that is
// money the agent can move, and the only one that ends the watch. `expired` is the address's own
// deadline passing with nothing seen: the address comes off the screen, because money sent to it
// after that may be lost (src/rails/deposit-quote.ts). Karim, 2026-09-16: "if the
// only user feedback is a timer, it is freaky", so each phase carries what it knows: the hash,
// the explorer link, the confirmations on an EVM chain, the amount, and the last read failure.
//
// WHAT A TICK COSTS. One 1Click status call and one verifier call, every 3 s, plus two chain reads
// while a transfer is confirming. It used to be a full ledger refresh (three prices, the trading
// account, two verifier calls) racing the 15 s loop for the same ledger, which is where the
// flashing "Could not check NEAR Intents" came from. The ledger is touched once, through the one
// seam, when the money is credited, so the wallet card updates then rather than at the next poll.
//
// THE WATCH OUTLIVES THE CARD. A person closes the card and goes back to their agent in ten
// seconds; the deposit takes two minutes. So the watch runs until a minute after credited, or
// Stop, or two hours, whichever first, and the window is told on every change over SSE as
// `{type:'deposit', ...}`; the backup nudge keys off the first `credited`.
// Nothing here is a control: the rails read balances from the ledger, never from this.

import type { Ledger } from '../ledger/index.ts';
import { fetchIntentsAssetBalance } from '../ledger/intents.ts';
import { chainSpec } from '../chain/evm.ts';
import { nearChainSpec } from '../chain/near.ts';
import type { OneClickStatus } from '../intents.ts';
import type { OneTimeDeposit } from '../rails/deposit-quote.ts';
import { readTimeout } from '../net.ts';

export type DepositPhase = 'watching' | 'seen' | 'bridged' | 'credited' | 'stopped' | 'expired';

/** The asset being watched, as the card resolved it from 1Click's token list. */
export type DepositToken = {
  /** The verifier's id for it ('nep141:eth-0xa0b8....omft.near'), which is also 1Click's. */
  assetId: string;
  decimals: number;
  /** The contract on the origin chain, null for the chain's own coin. */
  contract: string | null;
};

export type DepositState = {
  phase: DepositPhase;
  /** A receive network id from the registry in src/rails/intents-address.ts: 'btc', 'eth', 'sol'. */
  chain: string;
  symbol: string;
  /** The one-time address the card shows, minted for this watch (src/http/deposit-open.ts). The
   *  window draws it from here and nowhere else; null once the address has expired. */
  address: string | null;
  /** True when the address is a one-time 1Click quote: good for one deposit until `deadline`. */
  oneTime: boolean;
  /** Half of the destination on a memo chain, null elsewhere and once expired. */
  memo: string | null;
  /** ISO: after this the address takes nothing and money sent to it may be lost. */
  deadline: string | null;
  /** The least to send, in the coin's own unit, as the quote that minted the address said. */
  minimum: string | null;
  /** One sentence about the deposit beside the phase (a refund, a short deposit), or null. */
  note: string | null;
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
  /** NEAR Intents stopped taking this asset on this network while the card was up, in the
   *  sentence the window prints where the address was, and the status page; null while it takes it. */
  paused: string | null;
  statusLink: string | null;
};

export type DepositWatch = {
  /** The agent or the window asked for the card. Starts the watch and tells the window. */
  show(chain: string, symbol: string, address: string | null, token?: DepositToken, oneTime?: OneTimeDeposit): DepositState;
  current(): DepositState | null;
  /** The one-time address the current watch carries, whole, for the card's reuse check; null when none. */
  held(): OneTimeDeposit | null;
  stop(): void;
  /** An invite claim is about to move money into this wallet on `assetId` (src/invite/claim.ts),
   *  and `walletBefore` is the wallet's balance of it read a moment before, when the claim could
   *  read it. Until the returned release is called the watch never calls that asset credited; the
   *  release says what the claim proved landed (base units), or null when it proved nothing. */
  holdForClaim(assetId: string, walletBefore?: bigint | null): (proven: bigint | null) => void;
};

const POLL_MS = 3_000;
// Eager for the ten minutes a person stands at the card, then one poll in five (15 s at the
// default tick) until the watch gives up: a card left open must not ask 1Click and the
// verifier 57,000 times a day. Showing the card again starts a fresh eager window.
const EAGER_MS = 10 * 60 * 1000;
const SLOW_EVERY = 5;
const MAX_WATCH_MS = 2 * 60 * 60 * 1000;
// A minute more of balance reads after credited, so a second tranche is caught, then quiet.
const AFTER_CREDITED_MS = 60_000;

const NEAR_RPC_URL = nearChainSpec().rpcUrl;

// Explorer link prefixes for the chains 1Click names an origin hash on beyond the EVM three
// (src/chain/evm.ts carries those). Anything else gets no link rather than a wrong one.
const EXPLORER_TX: Record<string, string> = {
  sol: 'https://solscan.io/tx/',
  near: 'https://nearblocks.io/txns/',
};

type EvmChain = 'eth' | 'base' | 'arb';

function evmChainOf(chain: string): EvmChain | null {
  return chain === 'eth' || chain === 'base' || chain === 'arb' ? chain : null;
}

// A hash 1Click reports is data from the wire: it becomes a link only when it has the shape
// of a hash on that chain, so a malformed answer can never put an arbitrary string in a URL.
const HASH_SHAPE: Record<string, RegExp> = {
  eth: /^0x[0-9a-f]{64}$/i,
  base: /^0x[0-9a-f]{64}$/i,
  arb: /^0x[0-9a-f]{64}$/i,
  sol: /^[1-9A-HJ-NP-Za-km-z]{43,88}$/,
  near: /^[1-9A-HJ-NP-Za-km-z]{32,64}$/,
  btc: /^[0-9a-f]{64}$/i,
};

function explorerTxUrl(chain: string, txHash: string): string | null {
  const shape = HASH_SHAPE[chain];
  if (shape === undefined || !shape.test(txHash)) return null;
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

/* The hash 1Click names for the deposit, held to the chain's shape where this file knows one and
   to plain letters and digits elsewhere: it is printed on the card, so a malformed answer prints
   nothing rather than arbitrary text. */
const PLAIN_HASH = /^[0-9A-Za-z]{16,128}$/;

function hashOf(chain: string, status: OneClickStatus): string | null {
  const first = status.originTxHashes[0];
  if (first === undefined) return null;
  const shape = HASH_SHAPE[chain];
  return (shape ?? PLAIN_HASH).test(first) ? first : null;
}

// 1Click's formatted amount ("1.5"), as a number, or null.
function amountOf(formatted: string | undefined): number | null {
  if (formatted === undefined) return null;
  const n = Number(formatted);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// What 1Click's word means for the card: the phase it reaches, and a sentence where one is owed.
function phaseOf(status: OneClickStatus): { phase: DepositPhase | null; note: string | null; error: string | null } {
  switch (status.status) {
    case 'KNOWN_DEPOSIT_TX':
    case 'PROCESSING':
      return { phase: 'seen', note: null, error: null };
    case 'INCOMPLETE_DEPOSIT':
      return { phase: 'seen', note: 'This deposit is under the minimum for this address, so NEAR Intents returns it to your balance instead.', error: null };
    case 'REFUNDED':
      return { phase: 'seen', note: 'NEAR Intents did not convert this deposit and put it back in your balance instead.', error: null };
    case 'SUCCESS':
      return { phase: 'bridged', note: null, error: null };
    case 'FAILED':
      return { phase: null, note: null, error: `NEAR Intents says this deposit failed (${status.reported}). It is checking your balance anyway.` };
    default:
      // PENDING_DEPOSIT, not found yet, or a word the spec does not have: nothing seen.
      return { phase: null, note: null, error: null };
  }
}

function units(base: bigint, decimals: number): number {
  return Number(base) / 10 ** decimals;
}

const RANK: Record<DepositPhase, number> = { watching: 0, seen: 1, bridged: 2, credited: 3, stopped: 4, expired: 4 };

type Deps = {
  /** The last known holdings, for the baseline the rise is measured from. Never refreshed from here. */
  ledger: Ledger;
  sse: { broadcast: (payload: unknown) => void; broadcastState?: () => void };
  /** The intents account a deposit credits: the wallet's EVM address, lowercased. */
  account: () => string | null;
  /** The one refresh seam (refreshNow in src/main.ts): called once when money is credited, and
   *  once at show() when the ledger has never read this wallet. Never ledger.refresh() from here:
   *  two loops refreshing the same ledger raced each other into a flashing warning. */
  refresh: () => Promise<void>;
  /** Every read goes through this, so a test stands in for the verifier and the chain with one
   *  function. */
  fetchImpl?: typeof fetch;
  /** 1Click's word on a one-time address (src/intents.ts status). Absent (demo mode, a test
   *  server), only the verifier's balance moves the card. */
  status?: (address: string, memo?: string) => Promise<OneClickStatus>;
  balance?: (account: string, assetId: string) => Promise<bigint | null>;
  confirmations?: (chain: string, txHash: string) => Promise<number | null>;
  /** Whether NEAR Intents is taking this exact asset on this network right now (the route check
   *  in src/preflight/route-health.ts), asked on the tick beside 1Click and the verifier, so an
   *  address that stops being safe comes off the screen with no timer or loop of its own. The
   *  checker keeps its answers a minute (twenty seconds when shaky), so most ticks ask nothing
   *  of the network. Absent (a test, demo mode), no route is ever called closed. */
  route?: (account: string, chain: string, assetId: string) => Promise<{ closed: string | null; link: string | null }>;
  now?: () => number;
  pollMs?: number;
};

export function createDepositWatch(deps: Deps): DepositWatch {
  const now = deps.now ?? Date.now;
  const pollMs = deps.pollMs ?? POLL_MS;
  const fetchImpl = deps.fetchImpl ?? fetch;
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
  // The one-time address this watch is for, whole: what 1Click is asked about, and its deadline.
  let held: OneTimeDeposit | null = null;
  let creditedAt = 0;
  let inFlight = false;
  let ticks = 0;
  /* THE INVITE HOLD. A claim lands on NEAR USDC with no bridge row, and the rise it makes is the
     same signal as a deposit, so while one runs the watch holds "credited" on that asset. When
     the claim is proven, its amount joins the baseline, and only when the baseline is known to
     predate the claim: one the watch already had when the hold opened (the hold opens before the
     claim is sent), or the wallet's balance the claim read just before sending, which a card
     opened mid-claim takes as its baseline. The baseline is never read again, because a read
     would swallow a real deposit landing in the same window. A card opened mid-claim with no such
     read (a boot reconcile has none) takes no baseline until the claim ends. */
  type Hold = { assetId: string; walletBefore: bigint | null; addOnProof: boolean; generation: number };
  const holds = new Set<Hold>();

  function claimRunning(assetId: string | undefined): boolean {
    for (const h of holds) if (h.assetId === assetId) return true;
    return false;
  }

  // A baseline for a card opened while a claim runs on its asset: the one hold's read from just
  // before its send, which then adds its proof on release. Null when that cannot be known.
  function baselineDuringHold(assetId: string): bigint | null {
    const active = [...holds].filter((h) => h.assetId === assetId);
    if (active.length !== 1 || active[0]!.walletBefore === null) return null;
    active[0]!.addOnProof = true;
    active[0]!.generation = generation;
    return active[0]!.walletBefore;
  }

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
    // This account's row: once the vault has moved, the read also carries the allowance's.
    const account = deps.account()?.toLowerCase() ?? null;
    const row = read.holdings.find((h) => h.assetId === token!.assetId && (account === null || h.accountId.toLowerCase() === account));
    if (row === undefined) return 0n;
    if (row.amountBase !== undefined && /^\d+$/.test(row.amountBase)) return BigInt(row.amountBase);
    return BigInt(Math.round(row.amount * 10 ** row.decimals));
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
    } else if (current.phase === 'watching' && now() - started > EAGER_MS) {
      ticks += 1;
      if (ticks % SLOW_EVERY !== 0) return;
    }
    // No wallet yet is not an error: the card can go up before the wallet is made, and the
    // next tick asks again. The account is resolved per tick for exactly that reason.
    const account = deps.account();
    if (account === null) return;
    if (baseline === null && priming !== null) {
      await priming;
      priming = null;
      if (gen !== generation) return;
      if (!claimRunning(token?.assetId)) baseline = baselineFromLedger();
    }

    /* The deadline first: an address past it takes nothing and money sent to it may be lost, so
       with nothing seen yet it comes off the screen and is never drawn again. The balance is still
       read, so a deposit that was on its way and lands anyway still reads as credited. */
    const deadline = held === null ? null : Date.parse(held.deadline);
    const pastDeadline = deadline !== null && Number.isFinite(deadline) && now() >= deadline;
    const expiring = pastDeadline && current.phase === 'watching';

    const askVenue = current.phase !== 'credited' && current.phase !== 'expired' && !expiring && held !== null && deps.status !== undefined;
    const askRoute = current.phase !== 'credited' && current.phase !== 'expired' && token !== null && deps.route !== undefined;
    const spot = held;
    const [venue, heldNow, route] = await Promise.all([
      askVenue && spot !== null && deps.status !== undefined
        ? deps.status(spot.address, spot.memo ?? undefined).then(
            (said) => ({ said, failed: false }),
            () => ({ said: null, failed: true }),
          )
        : Promise.resolve({ said: null as OneClickStatus | null, failed: false }),
      token !== null ? balance(account, token.assetId) : Promise.resolve(null),
      askRoute && token !== null && deps.route !== undefined ? deps.route(account, current.chain, token.assetId).catch(() => null) : Promise.resolve(null),
    ]);
    if (gen !== generation || state === null) return;

    const next: DepositState = { ...current };
    if (expiring) {
      next.phase = 'expired';
      next.address = null;
      next.memo = null;
      next.ms = now() - started;
    }
    // A route read that failed keeps what the last one said.
    if (route !== null) {
      next.paused = route.closed;
      next.statusLink = route.closed === null ? null : route.link;
    }
    // The verifier first: credited is the settled truth and wins over anything 1Click says.
    const verdict = venue.said === null ? null : phaseOf(venue.said);
    if (token === null) {
      next.error = `Cannot check the ${current.symbol} balance: 1Click gave this token no intents id`;
    } else if (heldNow === null) {
      next.error = 'The verifier is not answering, retrying';
    } else {
      next.error = venue.failed ? 'NEAR Intents is not answering about this address, retrying' : (verdict?.error ?? null);
      if (claimRunning(token.assetId)) {
        // An invite claim is landing on this asset: no baseline and no credit until it ends.
      } else if (baseline === null) {
        baseline = heldNow;
        next.baseline = units(heldNow, token.decimals);
      } else if (heldNow > baseline) {
        if (next.phase !== 'credited') {
          next.phase = 'credited';
          next.ms = now() - started;
          creditedAt = now();
        }
        next.amount = units(heldNow - baseline, token.decimals);
      }
    }

    if (next.phase !== 'credited' && next.phase !== 'expired' && venue.said !== null && verdict !== null) {
      const said = venue.said;
      if (verdict.phase !== null && RANK[verdict.phase] > RANK[next.phase]) {
        next.phase = verdict.phase;
        next.ms = now() - started;
      }
      if (verdict.note !== null) next.note = verdict.note;
      if (verdict.phase !== null) {
        const hash = hashOf(current.chain, said);
        if (hash !== null) next.txHash = hash;
        next.explorerUrl = next.txHash === null ? null : explorerTxUrl(current.chain, next.txHash);
        const amount = amountOf(said.depositedAmount);
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

  // One poll at a time: a slow 1Click answer must not stack ticks behind it.
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
    show(chain, symbol, address, tok, oneTime) {
      stopTimer();
      generation += 1;
      started = now();
      ticks = 0;
      token = tok !== undefined && tok.assetId !== '' ? tok : null;
      held = oneTime ?? null;
      creditedAt = 0;
      inFlight = false;
      // A ledger read taken while a claim lands on this asset may or may not hold it, so it is
      // not used; the claim's own read from before its send is.
      baseline = token !== null && claimRunning(token.assetId) ? baselineDuringHold(token.assetId) : baselineFromLedger();
      priming = baseline === null && token !== null && !claimRunning(token.assetId) ? deps.refresh().catch(() => undefined) : null;
      state = {
        phase: 'watching',
        chain,
        symbol: symbol.toUpperCase(),
        address,
        oneTime: held !== null,
        memo: held?.memo ?? null,
        deadline: held?.deadline ?? null,
        minimum: held?.minimum ?? null,
        note: null,
        startedAt: new Date(started).toISOString(),
        baseline: baseline === null || token === null ? 0 : units(baseline, token.decimals),
        amount: null,
        txHash: null,
        explorerUrl: null,
        confirmations: null,
        ms: null,
        error: null,
        paused: null,
        statusLink: null,
      };
      announce();
      timer = setInterval(() => {
        void tick();
      }, pollMs);
      timer.unref?.();
      return state;
    },
    current: () => state,
    held: () => held,
    stop() {
      stopTimer();
      if (state !== null && state.phase !== 'credited') commit({ ...state, phase: 'stopped' });
    },
    holdForClaim(assetId, walletBefore = null) {
      const h: Hold = { assetId, walletBefore, addOnProof: baseline !== null && token !== null && token.assetId === assetId, generation };
      holds.add(h);
      return (proven) => {
        if (!holds.delete(h)) return;
        if (proven !== null && proven > 0n && h.addOnProof && h.generation === generation && baseline !== null) baseline += proven;
      };
    },
  };
}
