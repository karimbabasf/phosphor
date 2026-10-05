// When the allowance goes home (PHASE2-PLAN.md C8, call 15): after every move that touched it has
// settled, every ten minutes while the wallet is open, and when the size changes. What goes is
// src/vault/allowance.ts sweepPlan's: everything over the size once the allowance is worth more
// than the size plus 10 %, USDC first, then the rest by dollar value. The allowance key signs it,
// with no click and no touch, and the gas account sends it.
//
// A no-click move, so it is held to the rules every no-click move is held to, and to two of its own:
//   - a coin with no price is never moved, and with no price at all nothing is (the prices are the
//     engine's own, src/proposals/draft.ts priceOf, the ones every no-click move is governed by);
//   - Freeze stops it, read again as the last thing before the key signs;
//   - nothing goes while a move is approved, waiting on a Touch ID or executing: such a move may
//     need what the allowance holds (a shortfall top-up lands there a moment before its move);
//   - every amount is the verifier's own figure, read live a moment before, never a guess.
// One sweep at a time. A sweep whose send came back without a final answer holds the next one back
// through the vault journal (src/vault/submit.ts) until NEAR has settled it.

import type { Audit } from '../audit.ts';
import type { IntentsRead } from '../ledger/intents.ts';
import { amountWords, heldCoins, sweepId, sweepPlan } from '../vault/allowance.ts';
import type { AllowanceService, CoinAmount, HeldCoin } from '../vault/allowance.ts';
import type { VaultResult } from '../vault/submit.ts';
import { ReasonError } from './reasons.ts';

export type SweepWhy = 'after_move' | 'timer' | 'size' | 'unlock';

// `tried`: the plan had something to send and the allowance key was asked; `result` says what came of it.
export type SweepOutcome = { tried: false; why: string } | { tried: true; moves: CoinAmount[]; result: VaultResult };

export type SweepDeps = {
  service: AllowanceService;
  sizeUsd(): number;
  // The ledger's last verifier read: which coins the allowance holds, and 1Click's prices.
  read(): IntentsRead | undefined;
  price(symbol: string, asset: string): number | null;
  busy(): boolean;
  // Freeze, or rules that will not load: either stops every no-click move.
  frozen(): boolean;
  // Whether the session holds the allowance key and the gas seed.
  isOpen(): boolean;
  audit: Pick<Audit, 'append'>;
  // A ledger read: after a sweep went through, so the window shows it, and after a settled move.
  refresh?(): void;
  /* Told after every ledger refresh. A sweep asked for after a move waits for the first read that
     started after it, so the coin the move bought is in the read. Absent, a timer stands in. */
  onRefresh?(fn: () => void): () => void;
  now?: () => number;
};

// Without a ledger to wait on, how long after a move the sweep looks.
const AFTER_MOVE_FALLBACK_MS = 20_000;

export type AllowanceSweep = {
  // Sweep now if anything is over, and say what happened. One at a time: a second ask joins the first.
  now(why: SweepWhy): Promise<SweepOutcome>;
  // A move that touched the allowance settled: sweep on the next ledger read that shows it, asked for now.
  after(): void;
  stop(): void;
};

export function createAllowanceSweep(deps: SweepDeps): AllowanceSweep {
  const clock = deps.now ?? Date.now;
  let running: Promise<SweepOutcome> | null = null;
  let waitingSince: number | null = null;
  let fallback: ReturnType<typeof setTimeout> | null = null;
  // The last refusal written, so a sweep the gas account cannot pay for says so once, not every pass.
  let lastRefusal: string | null = null;

  const stopListening =
    deps.onRefresh?.(() => {
      if (waitingSince === null) return;
      // A read stamped before the move settled can miss a coin it bought; the amounts are read live anyway.
      const stamp = Date.parse(deps.read()?.fetchedAt ?? '');
      if (!Number.isFinite(stamp) || stamp < waitingSince) return;
      waitingSince = null;
      void now('after_move');
    }) ?? (() => {});

  // Freeze, and a move that started since the plan was made, as the last thing before the key.
  function lastCheck(): void {
    if (deps.frozen()) throw new ReasonError('kill_switch', 'Everything is frozen, so nothing was signed.');
    if (deps.busy()) throw new ReasonError('not_sent', 'A move started that may need what the allowance holds, so nothing was signed.');
  }

  async function once(why: SweepWhy): Promise<SweepOutcome> {
    const no = (because: string): SweepOutcome => ({ tried: false, why: because });
    if (!deps.isOpen()) return no('the wallet is shut, so the allowance key is not here');
    const acc = deps.service.accounts();
    if (acc.kind === 'key') return no('the vault has not moved to the chip');
    if (acc.allowance === null || acc.vault === null) return no('the allowance is not known until the wallet has opened');
    if (deps.frozen()) return no('everything is frozen');
    if (deps.busy()) return no('a move is under way and may need what the allowance holds');
    const allowance = acc.allowance.toLowerCase();

    // The coins the last read names, each priced the engine's way and read again live, exactly.
    const listed = heldCoins(deps.read(), allowance, deps.price).filter((c) => c.base > 0n);
    if (listed.length === 0) return no('the last read shows nothing in the allowance');
    const live = await Promise.all(listed.map(async (c) => ({ ...c, base: await deps.service.balance(allowance, c.asset) })));
    if (live.some((c) => c.base === null)) return no('a balance could not be read, and nothing moves on a guess');
    const plan = sweepPlan(live as HeldCoin[], deps.sizeUsd());
    if (plan.moves.length === 0) return no(`the allowance is worth $${plan.totalUsd.toFixed(2)}, within its $${plan.sizeUsd.toFixed(2)} size and the 10 % over it`);

    const id = sweepId();
    const result = await deps.service.sweep({ id, moves: plan.moves, lastCheck });
    const moved = plan.moves.map(amountWords).join(', ');
    const left = plan.unpriced.length === 0 ? '' : `; left in place with no price: ${[...new Set(plan.unpriced)].join(', ')}`;
    const data = {
      id,
      why,
      state: result.state,
      ...('code' in result ? { code: result.code } : {}),
      ...('txHash' in result && result.txHash !== null ? { txHash: result.txHash } : {}),
      moves: plan.moves.map((m) => ({ asset: m.asset, base: m.base.toString() })),
      totalUsd: plan.totalUsd,
      sizeUsd: plan.sizeUsd,
    };
    if (result.state === 'done') {
      lastRefusal = null;
      deps.audit.append('allowance_swept', `${moved} went from your allowance to your vault: it was worth $${plan.totalUsd.toFixed(2)} over a $${plan.sizeUsd.toFixed(2)} size${left}`, data);
      deps.refresh?.();
      return { tried: true, moves: plan.moves, result };
    }
    const line = `the sweep of ${moved} from your allowance to your vault did not finish (${result.code}): ${result.detail}${left}`;
    const key = `${result.state}:${result.code}`;
    if (result.state !== 'refused' || key !== lastRefusal) deps.audit.append('allowance_swept', line, data);
    lastRefusal = result.state === 'refused' ? key : null;
    return { tried: true, moves: plan.moves, result };
  }

  function now(why: SweepWhy): Promise<SweepOutcome> {
    if (running !== null) return running;
    running = once(why)
      .catch((err: unknown): SweepOutcome => {
        try {
          deps.audit.append('error', `the allowance sweep stopped: ${err instanceof Error ? err.message : String(err)}`);
        } catch {
          // the log is what failed
        }
        return { tried: false, why: 'it stopped on an error' };
      })
      .finally(() => {
        running = null;
      });
    return running;
  }

  return {
    now,
    after() {
      if (deps.onRefresh !== undefined) {
        // Waits for a read that started after the move settled, and asks for one.
        waitingSince ??= clock();
        deps.refresh?.();
        return;
      }
      if (fallback !== null) return;
      fallback = setTimeout(() => {
        fallback = null;
        void now('after_move');
      }, AFTER_MOVE_FALLBACK_MS);
      fallback.unref?.();
    },
    stop() {
      stopListening();
      if (fallback !== null) clearTimeout(fallback);
      fallback = null;
      waitingSince = null;
    },
  };
}
