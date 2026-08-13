// What the agent is doing RIGHT NOW, as opposed to what it has already done.
//
// The audit log answers "what happened". It cannot answer "something is happening", because
// a line is appended once and never changes, and the interesting part of an agent action is
// the gap between it arriving and it finishing. That gap is where the model's own latency
// lives: a call from a client thinking at max effort lands whole, but the work behind it
// (a quote, a simulation, a chain read) still takes hundreds of milliseconds to seconds.
//
// So this store holds a small set of IN-FLIGHT actions and emits on every transition. The
// window animates from these. Two rules the UI depends on and this file guarantees:
//
//   1. `start` is emitted BEFORE the work is dispatched, never after. The animation has to
//      begin at the moment the intent is known, not at the moment the result exists.
//   2. Every `start` is followed by exactly one `settle`, including when the handler throws.
//      An animation that winds up and never releases is worse than no animation, so the
//      settle is a finally, not a happy path.
//
// Duration is deliberately NOT predicted. The window's wind-up loops for as long as this
// says the action is open, which is what makes a 200ms read and an 8s swap use the same
// choreography without either looking wrong.

/** Which instrument the action acts on. The window picks its animation from this. */
export type ActionTarget = 'chart' | 'order' | 'policy' | 'account' | 'view' | 'read';

export type ActionOutcome = 'ok' | 'refused' | 'error';

export interface AgentActionStart {
  readonly id: number;
  readonly op: string;
  readonly tool: string;
  /** Already capped and safe to render. */
  readonly label: string;
  readonly target: ActionTarget;
  /** One short line of what changes, when it can be said before the work runs. */
  readonly detail: string;
  readonly at: number;
}

export interface AgentActionSettle extends AgentActionStart {
  readonly outcome: ActionOutcome;
  /** Wall time the action was open, ms. */
  readonly ms: number;
}

export type AgentActionEvent =
  | { readonly phase: 'start'; readonly action: AgentActionStart }
  | { readonly phase: 'settle'; readonly action: AgentActionSettle };

export interface AgentActionStore {
  /** Opens an action and emits `start`. Returns the handle to settle it with. */
  begin(input: Omit<AgentActionStart, 'id' | 'at'>): AgentActionStart;
  /** Closes an action and emits `settle`. Settling twice is a no-op, not an error. */
  end(action: AgentActionStart, outcome: ActionOutcome): void;
  /** Everything open, oldest first. A reconnecting window reads this to catch up. */
  open(): readonly AgentActionStart[];
  subscribe(fn: (event: AgentActionEvent) => void): () => void;
}

// An action that never settles would pin the window's animation on forever. Nothing in the
// server can hang indefinitely (every rail has its own timeout), but a bug that skipped the
// finally would, so open actions are swept. The sweep emits a real settle so the window
// releases through its normal path rather than being reset behind its back.
const STALE_MS = 120_000;

/**
 * An explicit table against the real propose kinds in src/server.ts, not a prefix guess. A
 * prefix rule looked tidier and was wrong in a way that only showed on screen: it read
 * `hl_deposit` as an order and drew a bow for what is a transfer. A moving of funds and a
 * placing of a trade are different acts and the panel should not blur them.
 *
 * `order` is deliberately narrow. Arming a mandate is the only propose kind that actually
 * puts size in the market, so it is the only one that gets the drawn bow. Everything else
 * that moves money is a transfer and weighs on the scale.
 *
 * Keep this in step with PROPOSE_KINDS in src/server.ts. It is not a gate and a missing kind
 * costs nothing but a duller animation, which is why the fallback is the quietest stage
 * rather than a guess: an unknown op animates as a read.
 */
const PROPOSE_TARGET: Record<string, ActionTarget> = {
  mandate_arm: 'order',
  policy_change: 'policy',
  consolidate: 'account',
  swap: 'account',
  hl_deposit: 'account',
  intents_deposit: 'account',
  intents_withdraw: 'account',
  lp_add: 'account',
  lp_remove: 'account',
};

export function targetFor(op: string, tool: string, kind: string): ActionTarget {
  /* The `view` op is two different things wearing one name. Seven of its twelve tools are
     `chart_*` and drive the price pane; the other five are `trade_*` and change what the
     trading window is showing (focus, highlight, overlay, note, clear). Animating all twelve
     as chart work drew the lathe for an action that never touched the chart.
     The `trade_*` five are a change of what is on screen, which is what the iris is for. */
  if (op === 'view') return tool.startsWith('trade_') ? 'view' : 'chart';
  if (op === 'set_view_mode') return 'view';
  // An unrecognised propose kind is still money moving, so it weighs rather than falling all
  // the way to the read stage: the server refuses it a moment later and the settle says so.
  if (op === 'propose') return PROPOSE_TARGET[kind] ?? 'account';
  if (op === 'read') return tool.startsWith('chart_') ? 'chart' : 'read';
  return 'read';
}

export function createAgentActionStore(now: () => number = Date.now): AgentActionStore {
  const live = new Map<number, AgentActionStart>();
  const subscribers = new Set<(event: AgentActionEvent) => void>();
  let nextId = 1;

  function emit(event: AgentActionEvent): void {
    // A throwing subscriber must not take the others down with it, and must not abort the
    // dispatch that is mid-flight behind this call.
    for (const fn of subscribers) {
      try {
        fn(event);
      } catch {
        /* a window that cannot receive is not a reason to stop the trade */
      }
    }
  }

  function sweep(at: number): void {
    for (const [id, action] of live) {
      if (at - action.at < STALE_MS) continue;
      live.delete(id);
      emit({ phase: 'settle', action: { ...action, outcome: 'error', ms: at - action.at } });
    }
  }

  return {
    begin(input) {
      const at = now();
      sweep(at);
      const action: AgentActionStart = { ...input, id: nextId++, at };
      live.set(action.id, action);
      emit({ phase: 'start', action });
      return action;
    },

    end(action, outcome) {
      if (!live.delete(action.id)) return;
      const at = now();
      emit({ phase: 'settle', action: { ...action, outcome, ms: at - action.at } });
    },

    open() {
      return [...live.values()];
    },

    subscribe(fn) {
      subscribers.add(fn);
      return () => {
        subscribers.delete(fn);
      };
    },
  };
}
