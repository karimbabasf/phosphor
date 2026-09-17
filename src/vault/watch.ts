// The deposit watcher: one network and one asset at a time, from "the card is up" to "the money
// is credited", so the person who just sent a test amount from an exchange is told what happened
// to it while it is happening.
//
// THREE PHASES, and they come from two different sources on purpose. `watching` is this process
// asking. `seen` is the NEAR Intents bridge saying a transfer to the deposit address has arrived
// on the origin chain and is not yet credited (poaRecentDeposits, which was written for exactly
// this ten-minute gap and had no caller). `landed` is the verifier's own balance
// (mt_batch_balance_of, through the ledger) having gone UP by something for that asset since the
// watch began. Only the last one is money the agent can move, and only the last one ends the
// watch. Nothing here is a control: the rails read balances from the ledger, never from this.
//
// THE WATCH OUTLIVES THE CARD. A person closes the card and goes back to their agent in ten
// seconds; the deposit takes two minutes. So the watch runs until landed or a day has passed,
// whichever first, and the window is told on every change over SSE. The frame the window keys
// off is `{type:'deposit', ...}`; the backup nudge keys off the first `landed`.

import type { Ledger } from '../ledger/index.ts';
import { poaRecentDeposits } from '../rails/intents-address.ts';
import type { PoaDeposit } from '../rails/intents-address.ts';

export type DepositPhase = 'show' | 'watching' | 'seen' | 'landed' | 'stopped';

export type DepositState = {
  phase: DepositPhase;
  /** A receive network id from the registry in src/rails/intents-address.ts: 'btc', 'eth', 'sol'. */
  chain: string;
  symbol: string;
  /** The bridge address the card shows. Carried so a card opened from the agent's tool call can
   *  draw without a second fetch, and so the window can compare it to /api/intents-receive. */
  address: string | null;
  startedAt: string;
  baseline: number;
  /** The amount seen or credited, in the asset's units, once known. */
  amount: number | null;
  txHash: string | null;
  /** Milliseconds from the watch starting to the phase being reached. */
  ms: number | null;
};

export type DepositWatch = {
  /** The agent or the window asked for the card. Starts the watch and tells the window. */
  show(chain: string, symbol: string, address: string | null): DepositState;
  current(): DepositState | null;
  stop(): void;
};

const POLL_MS = 3_000;
const MAX_WATCH_MS = 24 * 60 * 60 * 1000;

type Deps = {
  ledger: Ledger;
  sse: { broadcast: (payload: unknown) => void };
  /** The intents account the bridge credits: the wallet's EVM address, lowercased. */
  account: () => string | null;
  /** The one refresh seam (refreshNow in src/main.ts). Never ledger.refresh() from here: two
   *  loops refreshing the same ledger raced each other into a flashing warning. */
  refresh: () => Promise<void>;
  recent?: (account: string, chain: string) => Promise<PoaDeposit[]>;
  now?: () => number;
  pollMs?: number;
};

function credited(ledger: Ledger, symbol: string): number {
  const read = ledger.intents();
  if (read === undefined) return 0;
  return read.holdings
    .filter((h) => h.symbol.toUpperCase() === symbol.toUpperCase())
    .reduce((sum, h) => sum + h.amount, 0);
}

export function createDepositWatch(deps: Deps): DepositWatch {
  const now = deps.now ?? Date.now;
  const pollMs = deps.pollMs ?? POLL_MS;
  const recent = deps.recent ?? poaRecentDeposits;
  let state: DepositState | null = null;
  let timer: NodeJS.Timeout | null = null;
  let started = 0;

  function announce(): void {
    if (state !== null) deps.sse.broadcast({ type: 'deposit', ...state });
  }

  function stopTimer(): void {
    if (timer !== null) clearInterval(timer);
    timer = null;
  }

  async function tick(): Promise<void> {
    if (state === null) return;
    if (now() - started > MAX_WATCH_MS) {
      state = { ...state, phase: 'stopped' };
      stopTimer();
      announce();
      return;
    }
    const account = deps.account();
    // Landed wins over seen: the verifier's balance is the settled truth.
    let landedAmount: number | null = null;
    try {
      await deps.refresh();
    } catch {
      // A failed refresh is a stale read, not a lost deposit; the next tick asks again.
    }
    const total = credited(deps.ledger, state.symbol);
    if (total > state.baseline + 1e-12) landedAmount = total - state.baseline;
    if (landedAmount !== null) {
      state = { ...state, phase: 'landed', amount: landedAmount, ms: now() - started };
      stopTimer();
      announce();
      return;
    }
    if (state.phase === 'watching' && account !== null) {
      const rows = await recent(account, state.chain);
      const seen = rows.find((r) => r.status !== 'COMPLETED' && r.asset.toUpperCase().includes(state!.symbol.toUpperCase()));
      if (seen !== undefined) {
        state = { ...state, phase: 'seen', amount: Number(seen.amount) || null, txHash: seen.txHash || null, ms: now() - started };
        announce();
      }
    }
  }

  return {
    show(chain, symbol, address) {
      stopTimer();
      started = now();
      state = {
        phase: 'watching',
        chain,
        symbol: symbol.toUpperCase(),
        address,
        startedAt: new Date(started).toISOString(),
        baseline: credited(deps.ledger, symbol),
        amount: null,
        txHash: null,
        ms: null,
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
      if (state !== null && state.phase !== 'landed') {
        state = { ...state, phase: 'stopped' };
        announce();
      }
    },
  };
}
