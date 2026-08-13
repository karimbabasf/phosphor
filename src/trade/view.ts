// What the agent and the human are both looking at on the trading surface.
//
// The chart already established the idea this module generalises. A trend line the agent draws
// is the shared coordinate system for PRICE: the agent measures against it, the human sees the
// same line, and a bot triggers off it by id. Three parties, one object, no translation.
//
// This is that for ROWS. A trading screen is dense with things that look alike: five positions,
// nine resting orders, a page of fills. When the agent says "the ETH one is the problem", a
// human has to find it, and finding it is where the agreement quietly breaks. A highlight makes
// attention addressable: the agent points, the row lights up, and both of them are demonstrably
// looking at the same object.
//
// Three properties fall out of that being the purpose:
//
//   Highlights EXPIRE. A pointer that outlives its reason is worse than no pointer, because it
//   still looks current. They are dropped from the state on read, not merely dimmed in the UI,
//   so an agent reading the state back sees exactly what the human sees.
//
//   Everything is a CLOSED SET. Overlay names and highlight kinds are enumerated, and an
//   unknown one is refused with the list. Same reason the strategy grammar is closed: a
//   surface an agent can extend at runtime is a surface nobody can audit.
//
//   The state carries NO AUTHORITY. Nothing here places, cancels or sizes anything. The agent
//   can change what is drawn and what is pointed at, and cannot change what is true. That is
//   the same split as the rest of the app, held at the one place where it would be most
//   tempting to blur it.

export type Source = 'agent' | 'human';

export type Outcome = { ok: boolean; notes: string[]; error?: string };

// The row kinds that can be pointed at. Each one is something the trading page renders as a
// list with stable ids, which is the whole requirement for being addressable.
export const HIGHLIGHT_KINDS = ['position', 'order', 'fill', 'mandate', 'rule'] as const;
export type HighlightKind = (typeof HIGHLIGHT_KINDS)[number];

// What the chart may draw on top of price. Every one of these is a fact about the account
// rather than a study, which is why they live here and not with the indicators.
export const OVERLAYS = [
  'position', // entry line and the position's own band
  'liquidation', // the price at which the venue takes it
  'stops', // working stop-loss triggers
  'targets', // working take-profit triggers
  'orders', // resting limit orders
  'fills', // where this account actually traded
  'mandateWall', // the price at which the approved max loss is reached
] as const;
export type OverlayName = (typeof OVERLAYS)[number];

export type Overlays = Record<OverlayName, boolean>;

export type Highlight = {
  kind: HighlightKind;
  id: string;
  note: string;
  source: Source;
  at: string;
  atMs: number;
  ttlSec: number;
};

export type TradeViewState = {
  symbol: string;
  overlays: Overlays;
  highlights: Highlight[];
  note: string | null;
  noteSource: Source | null;
  noteAt: string | null;
  rev: number;
  lastDriver: Source;
  lastChangeAt: string;
};

export const HIGHLIGHT_TTL_DEFAULT_SEC = 300;
// Five minutes is already generous for "look at this". An hour-long pointer is a decoration.
export const HIGHLIGHT_TTL_MAX_SEC = 3600;
export const HIGHLIGHT_MAX = 24;
export const NOTE_MAX_CHARS = 240;

// Risk overlays start ON. A liquidation line the human has to switch on is a liquidation line
// they learn about after it mattered. The two that start off are the noisy ones: a page of
// fills and a wall of resting orders bury the price action they are drawn over.
function defaultOverlays(): Overlays {
  return {
    position: true,
    liquidation: true,
    stops: true,
    targets: true,
    orders: true,
    fills: false,
    mandateWall: true,
  };
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function createTradeView(
  initialSymbol: string,
  now: () => number = Date.now,
): {
  state(): TradeViewState;
  rev(): number;
  setFocus(patch: Record<string, unknown>, source: Source): Outcome;
  highlight(args: Record<string, unknown>, source: Source): Outcome;
  setOverlay(args: Record<string, unknown>, source: Source): Outcome;
  setNote(args: Record<string, unknown>, source: Source): Outcome;
  clear(what: string): Outcome;
  agentObjects(): number;
} {
  const state: TradeViewState = {
    symbol: initialSymbol.toUpperCase(),
    overlays: defaultOverlays(),
    highlights: [],
    note: null,
    noteSource: null,
    noteAt: null,
    rev: 0,
    lastDriver: 'human',
    lastChangeAt: new Date(now()).toISOString(),
  };

  // Bumped only when something actually changed. The revision is what the browser redraws on
  // and what the agent uses to ignore its own echo, so a bump for a no-op call makes both of
  // them work for nothing.
  function touch(source: Source): void {
    state.rev += 1;
    state.lastDriver = source;
    state.lastChangeAt = new Date(now()).toISOString();
  }

  // Expiry happens on read rather than on a timer. A timer would have the state and the screen
  // disagree for up to one interval, and this way an agent reading the state back is looking at
  // exactly what the human is looking at.
  function live(): Highlight[] {
    const t = now();
    const kept = state.highlights.filter((h) => t - h.atMs < h.ttlSec * 1000);
    if (kept.length !== state.highlights.length) state.highlights = kept;
    return state.highlights;
  }

  return {
    state: () => ({ ...state, highlights: [...live()], overlays: { ...state.overlays } }),

    rev: () => state.rev,

    setFocus(patch, source) {
      const symbol = str(patch.symbol);
      if (symbol === null) return { ok: true, notes: [] };
      const next = symbol.trim().toUpperCase();
      if (next === '') return { ok: false, notes: [], error: 'symbol cannot be empty' };
      if (next === state.symbol) return { ok: true, notes: [] };
      state.symbol = next;
      touch(source);
      return { ok: true, notes: [] };
    },

    highlight(args, source) {
      const kind = str(args.kind);
      if (kind === null || !(HIGHLIGHT_KINDS as readonly string[]).includes(kind)) {
        return {
          ok: false,
          notes: [],
          error: `unknown highlight kind: ${String(args.kind)}. known kinds: ${HIGHLIGHT_KINDS.join(', ')}`,
        };
      }
      const id = str(args.id);
      if (id === null || id.trim() === '') {
        return { ok: false, notes: [], error: 'highlight needs the id of the row to point at' };
      }
      const note = str(args.note) ?? '';
      if (note.length > NOTE_MAX_CHARS) {
        return { ok: false, notes: [], error: `highlight note too long: ${note.length} chars, max ${NOTE_MAX_CHARS}` };
      }

      const notes: string[] = [];
      let ttlSec = num(args.ttlSec) ?? HIGHLIGHT_TTL_DEFAULT_SEC;
      if (ttlSec > HIGHLIGHT_TTL_MAX_SEC) {
        notes.push(`ttl clamped from ${ttlSec}s to the ${HIGHLIGHT_TTL_MAX_SEC}s maximum`);
        ttlSec = HIGHLIGHT_TTL_MAX_SEC;
      }
      if (ttlSec <= 0) return { ok: false, notes: [], error: 'ttlSec must be positive' };

      live();
      // One pointer per row. Stacking two notes on one object leaves the human to guess which
      // is current, and the answer is always the newer one, so say so by replacing.
      state.highlights = state.highlights.filter((h) => !(h.kind === kind && h.id === id));
      if (state.highlights.length >= HIGHLIGHT_MAX) {
        // Oldest out. A bounded surface cannot be flooded into uselessness by a loop.
        state.highlights.shift();
        notes.push(`dropped the oldest highlight: at most ${HIGHLIGHT_MAX} are kept`);
      }
      const t = now();
      state.highlights.push({
        kind: kind as HighlightKind,
        id: id.trim(),
        note,
        source,
        at: new Date(t).toISOString(),
        atMs: t,
        ttlSec,
      });
      touch(source);
      return { ok: true, notes };
    },

    setOverlay(args, source) {
      const name = str(args.name);
      if (name === null || !(OVERLAYS as readonly string[]).includes(name)) {
        return {
          ok: false,
          notes: [],
          error: `unknown overlay: ${String(args.name)}. known overlays: ${OVERLAYS.join(', ')}`,
        };
      }
      const on = args.on === true;
      const key = name as OverlayName;
      if (state.overlays[key] === on) return { ok: true, notes: [] };
      state.overlays[key] = on;
      touch(source);
      return { ok: true, notes: [] };
    },

    setNote(args, source) {
      const text = str(args.text);
      if (text === null) return { ok: false, notes: [], error: 'note needs text' };
      if (text.length > NOTE_MAX_CHARS) {
        // Refused rather than truncated. A sentence cut in half can mean the opposite of the
        // whole, and an agent that gets told to be brief writes a better line than one whose
        // reasoning was silently edited.
        return { ok: false, notes: [], error: `note too long: ${text.length} chars, max ${NOTE_MAX_CHARS}` };
      }
      const trimmed = text.trim();
      // Stored verbatim. Escaping belongs at the one place that renders it, and doing it here
      // as well is how one of the two ends up wrong.
      state.note = trimmed === '' ? null : trimmed;
      state.noteSource = state.note === null ? null : source;
      state.noteAt = state.note === null ? null : new Date(now()).toISOString();
      touch(source);
      return { ok: true, notes: [] };
    },

    clear(what) {
      const target = what === '' ? 'agent' : what;
      if (target !== 'agent' && target !== 'all' && target !== 'highlights' && target !== 'note') {
        return { ok: false, notes: [], error: `unknown clear target: ${what}. known: agent, all, highlights, note` };
      }
      const notes: string[] = [];
      if (target === 'agent' || target === 'all' || target === 'highlights') {
        notes.push(`cleared ${live().length} highlight(s)`);
        state.highlights = [];
      }
      if (target === 'agent' || target === 'all' || target === 'note') {
        state.note = null;
        state.noteSource = null;
        state.noteAt = null;
      }
      // 'agent' deliberately leaves the symbol and the overlays alone: those are the human's
      // view of their own account, not objects the agent put there to be tidied away.
      if (target === 'all') {
        state.overlays = defaultOverlays();
        notes.push('overlays reset to their defaults');
      }
      touch('human');
      return { ok: true, notes };
    },

    agentObjects: () => live().filter((h) => h.source === 'agent').length + (state.noteSource === 'agent' ? 1 : 0),
  };
}
