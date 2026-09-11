# Execution rebuild: implementation plan

> For agentic workers: one worktree per unit, tests before code, commit per task.
> Read the spec first: `docs/superpowers/specs/2026-09-11-execution-rebuild.md`.
> Subsystem maps (how HEAD works, with file:line refs) are at
> `/private/tmp/claude-501/-Users-karimbaba/59b666f6-816f-4fc0-b979-2a7fc8d539f3/scratchpad/map-*.md`.

**Goal:** replace mandates with plans the venue holds, cut the chart surface to one write, add custom indicators, a knowledge profile, a transcript that formats, and a trade page with one hierarchy.

**Architecture:** four build units in wave 1 on disjoint file sets (A execution, B chart server, B2 custom indicators, C profile and role), one UI unit in wave 2 that consumes their payload shapes, then verification (pen test, latency, live check).

**Stack:** Node 24, TypeScript run directly, zod, viem, node:test. UI is vanilla JS with vendored Geist and Geist Mono. No new dependencies.

## Global constraints

- No em or en dashes anywhere. Banned words: delve, leverage (as a verb), seamless, robust, comprehensive, journey.
- Comments only where the code cannot say it, in the repo's existing voice (short paragraphs that say why).
- Every venue write reads `orderErrors`; a 200 with a per-order error is a refusal.
- Numbers on the wire are strings via `src/hl/format.ts`; never `toString()` a float.
- No tool argument may be named `to, recipient, destination, address, toaddress, dest, payee` at any depth (tests/injection.test.ts:264-272).
- No tool name may start with `approve, refuse, kill, dismiss, execute`.
- Adding or removing a tool touches, together: `src/mcp.ts`, `src/greeting.ts` CAPABILITIES, `src/http/context.ts` (READ_TOOLS, VIEW_TOOLS, PROPOSE_KINDS), the dispatch table (`src/http/read/*`, `src/http/view.ts` HANDLERS, `src/http/propose.ts`), `tests/tool-surface.ts`, `ui/screens/agent.js` TOOL_PHRASES. `tests/unit/observability.test.ts`, `tests/injection.test.ts`, `tests/unit/role.test.ts` and `tests/unit/agent-panel-ui.test.ts` fail otherwise.
- Shared files (`src/mcp.ts`, `src/greeting.ts`, `src/http/context.ts`, `tests/tool-surface.ts`, `src/types.ts`, `ui/screens/agent.js` TOOL_PHRASES): a unit edits only the lines about its own tools. Never reorder or reformat the rest.
- Do not touch `src/rails/**` except the two one-line edits named for unit A. Do not touch `src/policy/engine.ts`, `src/proposals/rails.ts`, the identity text inside `buildRole`, or the `INSTRUCTIONS` block at the top of `src/mcp.ts`. Another session owns those.
- `npm run typecheck` and `npm test` green before every commit. `node --test tests/unit/<file>.test.ts` runs one file.
- Never `git add -A`. Stage the paths the commit is about.

## Final tool list (41)

Removed (14): `propose_mandate mandate_catalog chart_measure indicator_catalog chart_set_view chart_add_indicator chart_remove_indicator chart_level chart_mark chart_trendline chart_clear chart_preset candles trade_note`.
Added (7): `propose_trade propose_trade_change trade_plan chart_draw chart_snapshot chart_layout profile_learned`.
WORKER_WITHHELD adds: `trade_plan chart_draw chart_snapshot chart_layout profile_learned`.

---

## Unit A: execution

**Owns:** `src/trade/plan.ts` `src/trade/risk.ts` `src/trade/plans.ts` `src/trade/watch.ts` `src/trade/rail.ts` `src/runner/protocol.ts` `src/runner/host.ts` `src/runner/main.ts` `src/runner/keys.ts` `src/hl/exchange.ts` `src/trade/service.ts` `src/trade/state.ts` `src/trade/view.ts` `src/http/trade.ts` `src/http/propose.ts` (the trade branches) `src/proposals/execute.ts` (land override) `src/proposals/positions.ts` (delete) `src/types.ts` (TradeDraft) `src/main.ts` (runner wiring) `src/view/basic.ts` `src/transactions.ts` (trade headline) `ui/screens/decision.js` (the trade card region only) `src/rails/kinds.ts` (one line) `src/rails/index.ts` (two lines) and their tests.

**Deletes:** `src/strategy/*`, `src/runner/feed.ts`, `src/runner/realised.ts`, `src/rails/mandate.ts`, `src/proposals/positions.ts`, `tests/unit/strategy-*.test.ts`, `tests/unit/mandate-catalog.test.ts`, `tests/unit/runner-limits.test.ts`, and every test that only exists for the grammar.

### Interfaces (produces)

```ts
// src/trade/plan.ts
export type Timeframe = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';
export type Ref = { px: number } | { line: string };            // line: /^tl_\d+$/
export type Condition =
  | { type: 'close'; tf: Timeframe; is: 'above' | 'below'; at: Ref; wick?: 'through' }
  | { type: 'volume'; tf: Timeframe; atLeast: number }
  | { type: 'time'; after?: string; before?: string };
export type Entry =
  | { type: 'market'; maxSlippageBps: number }
  | { type: 'limit'; px: number }
  | { type: 'stop'; px: number; maxSlippageBps: number };
export type PlanInput = {                     // what the agent may send
  symbol: string; side: 'long' | 'short'; sizeUsd: number; leverage: number;
  entry: Entry; stop: number; target?: number; when?: Condition[];
  expiresAt?: string; note?: string;
};
export type Plan = PlanInput & { id: string };                  // id minted by the app
export const planInputSchema: z.ZodType<PlanInput>;              // closed, defaults applied
export function mintPlanId(now: number): string;                 // 'pl_' + base36
export function planHash(plan: Plan): string;                    // sha256 of canonical JSON
export function renderPlan(plan: Plan, risk?: PlanRisk): string[];   // English lines for the card and rail
export function renderCondition(c: Condition): string;

// src/trade/risk.ts
export type PlanRisk = {
  marginUsd: number; maxLossUsd: number; stopSlipUsd: number;
  entryRef: number; liquidationPx: number; notionalUsd: number;   // after lot rounding
  amountUsd: number;                                              // max(marginUsd, maxLossUsd): what the policy sees
};
export type RiskInputs = {
  mark: number; szDecimals: number; maxLeverage: number; freeCollateralUsd: number | null;
  takerFeeBps: number;                                             // 4.5 default
  sameCoinLeverage: number | null;                                 // leverage of any placed/open plan on the coin
};
export function planRisk(plan: Plan, i: RiskInputs): { ok: true; risk: PlanRisk } | { ok: false; refusal: string };
export function changeRisk(plan: Plan, approved: PlanRisk, change: { stop?: number; target?: number }, i: RiskInputs):
  { ok: true; risk: PlanRisk; widens: boolean } | { ok: false; refusal: string };

// src/trade/plans.ts  (registry + state/plans.json)
export type PlanStatus = 'idea' | 'waiting' | 'placed' | 'open' | 'done';
export type EndReason = 'stopped' | 'targeted' | 'closed' | 'cancelled' | 'expired' | `failed:${string}`;
export type PlanRow = Plan & {
  status: PlanStatus; endReason?: EndReason; blind?: boolean; locked?: boolean;
  proposalId?: string; hash: string; risk?: PlanRisk;
  cloids: { entry?: string; stop?: string; target?: string }; gen: number;
  holds?: { condition: string; holds: boolean }[];                // waiting only
  createdAt: string; updatedAt: string;
};
export function createPlanStore(dir: string): {
  list(): PlanRow[]; get(id: string): PlanRow | null;
  put(row: PlanRow): void; remove(id: string): void;              // remove is for ideas only
};

// src/trade/watch.ts (pure)
export type Bar = { t: number; o: number; h: number; l: number; c: number; v: number };
export type MarketView = {
  nowMs: number; mark: number | null; freshMs: number;             // age of the newest frame
  bars: Partial<Record<Timeframe, Bar[]>>;                         // closed bars, oldest first, >= 21
  lineAt?: (id: string, t: number) => number | null;
};
export function evaluate(plan: Plan, view: MarketView): { holds: boolean; per: { condition: string; holds: boolean }[]; blind: boolean };

// src/runner/protocol.ts (host <-> child, JSON over IPC)
export type ToChild =
  | { cmd: 'arm'; plan: Plan; cloids: PlanRow['cloids']; meta: AssetMeta }
  | { cmd: 'fire'; id: string; mark: number }
  | { cmd: 'protect'; id: string }
  | { cmd: 'modify'; id: string; stop?: number; target?: number; cloids: PlanRow['cloids']; mark: number }
  | { cmd: 'cancel'; id: string }
  | { cmd: 'close'; id: string; maxSlippageBps: number }
  | { cmd: 'flatten'; coins: string[]; cloids: string[] }
  | { cmd: 'disarm'; id: string }
  | { cmd: 'kill' };
export type FromChild =
  | { ev: 'placed'; id: string; oids: { entry?: number; stop?: number; target?: number }; filledSz: number }
  | { ev: 'protected'; id: string; oids: { stop?: number; target?: number } }
  | { ev: 'modified'; id: string }
  | { ev: 'cancelled'; id: string; filledSz: number }
  | { ev: 'closed'; id: string; stillOpenSz: number }
  | { ev: 'flat'; stillOpen: string[] }
  | { ev: 'refused'; id: string; reason: string }
  | { ev: 'error'; id: string | null; message: string };

// src/runner/host.ts
export type PlanRunner = {
  arm(row: PlanRow): Promise<{ ok: true } | { ok: false; reason: string }>;
  change(id: string, c: { stop?: number; target?: number }): Promise<{ ok: boolean; detail: string }>;
  cancel(id: string): Promise<{ ok: boolean; detail: string }>;
  close(id: string, maxSlippageBps: number): Promise<{ ok: boolean; detail: string }>;
  flatten(): Promise<{ ok: boolean; detail: string }>;
  status(): { plans: PlanRow[]; child: 'off' | 'on'; watching: string[] };
  onMarket(coin: string, frame: { t: number; o: number; h: number; l: number; c: number; v: number; closed: boolean; baseSec: 60 }): void;
  onAccount(snapshot: AccountSnapshot): void;   // positions and fills from the trade feed
  onLines(lineAt: (id: string, t: number) => number | null): void;
  reconcile(): Promise<void>;                   // boot: re-arm waiting rows that match their approval; reconcile placed/open by cloid
  setKilled(on: boolean): void;
  stopAll(reason: string): Promise<void>;
  events(): RunnerEvent[];
};

// src/trade/rail.ts   kind 'trade' (rename of mandate_arm in src/rails/kinds.ts, one line)
export function tradeRail(deps: { runner: PlanRunner; meta: (coin: string) => AssetMeta | null; mark: (coin: string) => number | null; free: () => number | null }): Rail;

// src/types.ts
export type TradeDraft =
  | { kind: 'trade'; op: 'open'; plan: Plan; hash: string; risk: PlanRisk; amountUsd: number; counterparty: 'hyperliquid-perps' }
  | { kind: 'trade'; op: 'change'; id: string; stop?: number; target?: number; cancel?: true; close?: true;
      before: PlanRisk; after: PlanRisk; amountUsd: number; counterparty: 'hyperliquid-perps' };
```

`TradePayload` (src/trade/state.ts) replaces `mandates: MandateRow[]` with `plans: PlanRow[]` (ideas, waiting, placed, open, and the last 20 done), and `account` gains `atRiskUsd` (sum of margin of placed and open plans) and `maxLossUsd` (sum of max loss). `TradeRead.plans` mirrors it with `holds` on waiting plans.

### Tasks

A1. `plan.ts` schema, id, hash, render. Tests: every field bound, refusals by name, hash stable across key order, render lines for each entry type and condition.
A2. `risk.ts`. Tests: isolated liquidation math against `src/hl/liquidation.ts`, lot rounding floor ($10 after rounding; a $10.5 BTC plan at $64k is refused), wrong-side stop and target against entry and against mark, free collateral, same-coin leverage refusal, `amountUsd = max(margin, maxLoss)`, change tightens vs widens.
A3. `plans.ts` store: atomic write (tmp + rename), 0600, boot load, ideas removable, non-ideas not.
A4. `watch.ts`: close above/below, wick through, volume x average, time window, line ref via `lineAt`, blind when `freshMs > 15000`, bars fewer than 21 means not holds and not blind.
A5. `src/hl/exchange.ts`: `TriggerRequest` gains `limitPx` and `reduceOnly` (default true); stop leg limit at 10% past trigger (`roundToValidPrice`), target leg `isMarket: false`; `buildModifyAction` accepts a trigger with `a: true`; `cloidFor(planId, leg, gen)` deterministic without a window; keep `buildBracketAction` (normalTpsl) and add `buildExitsAction` (positionTpsl). Update `tests/unit/hl-exchange.test.ts` key order pins.
A6. `protocol.ts` and `main.ts` (child): stdin key as today; commands as specified; fake exchange in tests (loopback http server answering /exchange with the shapes in the HL docs: `statuses[0].filled.totalSz`, `resting.oid`, `error`). Tests: fire market full fill places bracket only; partial fill places positionTpsl; limit fire places entry alone; protect sizes exits to the position; modify re-checks sides against mark; cancel on open refused; "already canceled" is success; refuses unknown plan id; refuses expired.
A7. `host.ts`: registry, watcher wiring, coin set = view symbol plus plan coins, fills watch -> protect, fork and kill as today (keep `tests/unit/runner-fork-race.test.ts` green), reconcile on boot (hash and proposal id check), extraAgents check once per session, signing session clamp, `locked` on session end, no TRADING_LIMITS.
A8. `rail.ts` + `types.ts` + `kinds.ts` + `rails/index.ts` + `propose.ts` + `execute.ts`: kind `trade`, ops open and change, `amountUsd` rules, land() override removed, simulate renders the card lines, execute calls the runner. `src/duplicates.ts` key unchanged. Tests: `tests/unit/engine-rails.test.ts` style flow: $60 margin plan lands executed with decidedBy policy; $150 lands pending; change that tightens is amountUsd 0; cancel on open refused at simulate.
A9. `service.ts`, `state.ts`, `view.ts`, `http/trade.ts`, `main.ts`: payload with plans, `atRiskUsd`, `maxLossUsd`; `trade_plan` handler (ideas) in `src/http/view.ts` region; human door cancel/close(100 bps)/flatten; highlight kinds `plan level line indicator`; `trade_note` removed; realised PnL from fills stays on the payload (the loss ceiling is gone: the stop is the ceiling). Fix `tests/unit/trade-state.test.ts` and `trade-view.test.ts`.
A10. Surface: `src/mcp.ts` (register `propose_trade`, `propose_trade_change`, `trade_plan`; remove `propose_mandate`, `mandate_catalog`, `trade_note`), `greeting.ts` rows, `context.ts`, `tests/tool-surface.ts`, `ui/screens/agent.js` TOOL_PHRASES for the three, `ui/screens/decision.js` trade card (headline "Open a long on BTC" / "Change the stop on pl_x" / "Close pl_x", the risk facts, old and new on a change), `src/view/basic.ts` and `src/transactions.ts` headlines for kind `trade`.
A11. Docs: `docs/reference.md` trade section rewritten (short), README "Trade" paragraph. Delete the mandate prose.

Done when: typecheck clean, `npm test` green, and `node --test tests/unit/runner-*.test.ts tests/unit/trade-*.test.ts tests/unit/plan*.test.ts` covers every command path named in A6 and A7.

---

## Unit B: chart server

**Owns:** `src/chart.ts` `src/charts.ts` (new) `src/drawings.ts` `src/http/chart.ts` `src/http/read/chart.ts` `src/http/view.ts` (chart handlers region) `src/http/sse.ts` (snapshot frame) `src/snapshot.ts` (new) `src/analysis/index.ts` (tail, indicator_list rescan hook) `src/batch.ts` `src/presets.ts` `src/market/index.ts` (atrForCoin) `src/server.ts` (slots) `src/main.ts` (chart wiring only) and tests. Deletes `src/candles.ts`, `src/hyperliquid.ts`, `src/history.ts`.

### Interfaces (produces)

```ts
// src/charts.ts
export type ChartSlot = { store: ChartStore; drawings: DrawingStore; index: number };
export function createChartSlots(defaultProduct: string): {
  primary: ChartSlot;                                   // slot 0, also ctx.chart / ctx.drawings for old call sites
  slot(n: number): ChartSlot | null;                    // 0..3
  layout(charts: { product: string; timeframe: string }[]): { ok: true } | { ok: false; reason: string };  // 1..4
  list(): { index: number; product: string; timeframe: string }[];
};

// src/http/view.ts additions (HANDLERS)
// chart_draw args (zod in mcp.ts, mirrored here):
type ChartDraw = {
  chart?: number;                                       // 0..3, default 0
  clear?: 'mine' | 'agent' | 'all';
  view?: { product?: string; timeframe?: string; bars?: number; provider?: 'auto' | 'hyperliquid' | 'coinbase' };
  indicators?: { preset?: string; set?: IndicatorReq[]; add?: IndicatorReq[]; remove?: string[] };
  levels?: { px: number; label?: string }[];
  marks?: { t: number; label?: string }[];
  lines?: { t1: number; p1: number; t2: number; p2: number; label?: string }[];
  zones?: { p1: number; p2: number; t1?: number; t2?: number; label?: string }[];
};
type IndicatorReq = { type: string; params?: Record<string, number> };   // type may be 'custom:<slug>'
// answer: ChartDigest
export type ChartDigest = {
  chart: number; product: string; timeframe: string; bars: number; last: number | null;
  indicators: { id: string; type: string; last: Record<string, number | null>; state: string }[];
  counts: { levels: number; marks: number; lines: number; zones: number; plans: number };
  refused: string[];
};
export function chartDigest(slot: ChartSlot): Promise<ChartDigest>;

// src/snapshot.ts
export function createSnapshotBroker(deps: { broadcast: (frame: { type: 'snapshot'; slot: number; reqId: string }) => void }): {
  request(slot: number, timeoutMs: number): Promise<{ jpegBase64: string } | null>;   // one outstanding per slot
  deliver(reqId: string, jpegBase64: string): boolean;
};
// window POST /api/chart/snapshot { token, reqId, jpeg } under the same guard as /api/trade (loopback host, same origin, token), body <= 512 KB.
// GET /api/chart?slot=n serves any slot with the same payload shape as today.
```

`chart_read { chart?, full? }` compact: view, last price, indicators with last values and state line, counts, geometry; `full: true` returns today's shape. `chart_scan`: `Promise.all` over the timeframes. `chart_batch` ops that return series (`atr, indicator_series, candles, trendline_touches, pivots`) take `tail` (default 20) and `full: true`. `indicator_list` calls `ctx.customIndicators?.refresh()` (unit B2 provides it; guard for absence) and lists custom specs. `chart_snapshot { chart? }` returns MCP content `[image, text]`; mcp.ts passes image blocks through (`proxy()` currently returns text only: add a branch for `{ image: base64, digest }`).

### Tasks

B1. Unify drawings: delete `ctx.chart.trendlines` and everything that reads it; `chart_read` reports `drawings` from `src/drawings.ts` only. Fix `tests/unit/chart.test.ts`, `chart-tidy.test.ts`.
B2. `charts.ts` slots + server wiring; `/api/chart?slot=n`; SSE `chart` frame carries `slot`. Existing single-chart tests keep passing through `primary`.
B3. `chart_draw` handler, `chartDigest`, `chart_layout`, removal of the ten old handlers and their mcp.ts registrations, `indicators.preset` uses `src/presets.ts`. Tests: one call sets view, adds a preset, two levels, a line, a zone; `refused` names an unknown indicator and a plan that is not an idea; `clear: 'mine'` counts by caller.
B4. Compact `chart_read`, parallel `chart_scan`, `tail` on batch ops. Tests: response size bound (a compact read with 4 indicators under 1.5 KB), scan of 5 timeframes issues fetches concurrently (fake source records overlap).
B5. Snapshot broker + route + SSE frame + mcp.ts image pass-through. Tests: window answers within TTL -> image; no window -> digest with the sentence; second request while one is outstanding -> refused; body over 512 KB -> 413; wrong origin -> 403.
B6. Delete `src/candles.ts`, `src/hyperliquid.ts`, `src/history.ts`, the `candles` tool, `history_page`, `chart_measure`, `indicator_catalog`; move `atrForCoin` in `src/main.ts` onto `market.warm` + `src/analysis/regime.ts` Wilder ATR (one ATR in the app).
B7. Surface files: mcp.ts, greeting.ts, context.ts, tool-surface.ts, agent.js TOOL_PHRASES for `chart_draw chart_snapshot chart_layout` (phrases: "drawing on the chart", "taking a picture of the chart", "arranging the charts").
B8. `docs/reference.md` chart section rewritten (short).

---

## Unit B2: custom indicators

**Owns:** `src/indicators-custom/{schema.ts,evaluate.ts,pine.ts,loader.ts,index.ts}`, `src/indicators.ts` (catalogue accepts extra specs; `pane` and `params` from the custom spec), `tests/unit/indicators-custom-*.test.ts`, `tests/fixtures/indicators/*.{json,pine}`, `docs/reference.md` one paragraph.

### Interfaces (produces)

```ts
// src/indicators-custom/schema.ts
export type Expr = number | string | [op: string, ...args: Expr[]];   // string = series name or input name
export type CustomIndicator = {
  title: string; overlay: boolean;
  inputs: Record<string, { default: number; min?: number; max?: number; int?: boolean }>;
  plots: { title: string; color?: 'up' | 'down' | 'warn' | 'agent' | 'text'; expr: Expr; style?: 'line' | 'histogram' }[];
  hlines?: { value: number; title?: string }[];
};
export const customIndicatorSchema: z.ZodType<CustomIndicator>;    // 400 nodes, depth 16, 6 plots, history 500
// src/indicators-custom/evaluate.ts
export function compile(ind: CustomIndicator, slug: string): IndicatorSpec;   // type 'custom:<slug>'
// src/indicators-custom/pine.ts
export function translatePine(source: string): { ok: true; indicator: CustomIndicator; ignored: string[] } | { ok: false; line: number; message: string };
// src/indicators-custom/loader.ts
export function createCustomIndicators(dir: string): {
  refresh(): { specs: IndicatorSpec[]; problems: { file: string; line?: number; message: string }[] };   // mtime-gated
  specs(): IndicatorSpec[];
  get(slug: string): IndicatorSpec | null;                            // map lookup only, slug /^[a-z0-9-]{1,32}$/
};
```

Ops for `Expr`: `sma ema rma wma rsi atr stdev highest lowest change tr crossover crossunder abs max min sqrt log nz na + - * / % < <= > >= == != and or not ? hist` where `hist` is `[hist, expr, n]`. Series: `open high low close volume hl2 hlc3 ohlc4 bar_index`. Every intermediate is a `Float64Array` over the candle window; `NaN` is `na`. Node budget: throw past 2,000,000 evaluations per compute.

Pine subset: `//@version=5`, `indicator(title, overlay=)`, `input.int/float/bool(default, title=, minval=, maxval=)` and bare `input(...)`, `name = expr`, `var name = expr`, `name := expr`, `if cond` / `else` blocks that assign, ternary, `[n]`, `ta.*` and `math.*` from the op list, `nz`, `na`, `plot(expr, title=, color=, style=)`, `hline`. `plotshape plotchar fill bgcolor alertcondition alert barcolor` are ignored and listed. Everything else refuses with line and reason.

### Tasks

B2.1 schema + evaluate with golden tests: `custom` sma/ema/rsi/atr equal the built-ins on the same candles to 1e-9.
B2.2 loader with fixtures, mtime refresh, slug rule, problems list.
B2.3 pine translator: fixtures for a 2-MA cross, RSI with bands, a `var`/`:=` running max, a script using `for` (refused with line), a script with `request.security` (refused).
B2.4 pen tests: 10 MB file, 100k-node expression, `__proto__` and `constructor` as input names, unicode confusables, history 10^9, division by zero, a plot count of 50; each refused or bounded, none throws past the loader.
B2.5 hook into `src/indicators.ts` catalogue: `catalogue(extra?: IndicatorSpec[])`; the chart store resolves `custom:<slug>` through `ctx.customIndicators.get`.

---

## Unit C: profile and role

**Owns:** `src/profile/index.ts`, `src/role.ts` (a new appended section and the "no headings" line only), `src/greeting.ts` (profile block in the start answer plus one CAPABILITIES row), `src/http/chats.ts` (pass the profile), `src/http/mutation.ts` (per-message tag gains focused symbol and waiting count), `src/http/view.ts` (`profile_learned` handler region), `src/http/context.ts` (VIEW_TOOLS row), `src/mcp.ts` (one registration, withheld from analysts), `tests/tool-surface.ts` (row), `skills/phosphor-analysis.md`, `skills/phosphor-hunt.md`, tests.

### Interfaces (produces)

```ts
// src/profile/index.ts
export type Profile = {
  name: string; style: 'plain' | 'technical';
  levels: { markets: 0 | 1 | 2 | 3 | 4; charting: 0 | 1 | 2 | 3 | 4; perps: 0 | 1 | 2 | 3 | 4; blockchain: 0 | 1 | 2 | 3 | 4 };
  knows: { concept: string; date: string }[];                        // <= 60
};
export function loadProfile(dataDir: string): Profile;                 // defaults when missing; never throws
export function profileBlock(p: Profile): string;                      // <= 900 chars, the fence and the teaching rules
export function recordLearned(dataDir: string, concept: string, today: string): { ok: true } | { ok: false; reason: string };
// concept: /^[A-Za-z0-9 ,'-]{1,48}$/, deduped case-insensitively, session cap 10 enforced by the view handler
```

File format is in the spec (flat `key: value` header, one `## Knows` list).

### Tasks

C1. `profile/index.ts` with tests: missing file, every level clamped, hostile lines stripped, the eight hostile sentences from `tests/fixtures/hostile.json` never appear in `profileBlock` output verbatim, block under 900 chars.
C2. Role: append `profileBlock` after HOW TO ANSWER; change "No headings, no bulleted summaries" to "Headings render as labels; put numbers in a table"; chats.ts passes `loadProfile(cfg.dataDir)`; `tests/unit/role.test.ts` extended.
C3. `profile_learned` view handler + registration (withheld from analysts) + start answer block + tag in mutation.ts (`[phosphor: the window is on the trade screen, BTC focused, 1 plan waiting]`).
C4. Skills: rewrite `skills/phosphor-analysis.md` to under 9 KB: tiers stay, the procedure uses `chart_scan` once, `chart_batch` once, `chart_draw` once, `trade_plan` for the idea; the output contract becomes short prose plus one GFM table of levels; the appendix of chart_batch parameters shrinks to the three trap defaults. `skills/phosphor-hunt.md`: tool names updated, fan-out unchanged. Note in the commit that `~/.claude/skills/phosphor-analysis/` must be synced by hand.

---

## Unit D (wave 2): window

**Owns:** `ui/core/markdown.js` (new), `ui/screens/agent.js` (rendering), `ui/screens/trade.js`, `ui/chart/chart.js` (font, label manager, snapshot capture, slot 0), `ui/chart/mini.js` (new), `ui/chart/labels.js` (new), `ui/chart/trade-overlay.js`, `ui/design/*.css`, `ui/core/api.js`, `ui/index.html` (script tags), and the `*-ui.test.ts` files. Consumes `TradePayload.plans`, `ChartDigest`, `/api/chart?slot=n`, SSE `snapshot` frames, highlights with the new kinds.

Direction is set by the frontend-design and emil-design-eng skills at dispatch time. Fixed points: Geist for text, Geist Mono for numbers and the canvas; the rail stays right; floors unchanged; red only for liquidation; amber for waiting on a person; one radius; one hover grammar.

Tasks: D1 markdown renderer + merge of reply blocks (tests: no markup reaches the DOM, tables render as `<table>` built by createElement, links print as text). D2 highlights render + spotlight (halo, dim, callout). D3 chart bar and Layers popover. D4 rail: Status, Open (Close button), Waiting (Cancel button, condition ticks, locked and blind states), Done. D5 canvas font, `labels.js` shared column, token colours for overlays. D6 `mini.js` + grid for slots. D7 snapshot capture on SSE frame (`canvas.toBlob('image/jpeg', 0.7)`, max 1024 px). D8 scan band on writes only. D9 headless Chromium check with a demo backend (the vault gotcha names the exact recipe) and screenshots into `docs/screenshots/` using fixture data only.

---

## Verification (wave 3)

V1. Full suite, typecheck, e2e (`npm run e2e`).
V2. Pen test workflow: attackers per surface (Pine, profile, plan schema, snapshot route, child protocol, policy math), each returning reproduction commands; fixes land as tests.
V3. Latency: (a) `scripts/latency-venue.ts`: signed order round trip on mainnet at minimum size when collateral exists, else a signed order the venue rejects for margin (same path); (b) `tests/unit/runner-latency.test.ts`: frame in -> post out under 50 ms with a fake venue; (c) headless Chromium: SSE frame -> DOM update, `chart_draw` -> repaint.
V4. Live check in the app: `npm run bundle`, `npm run tauri dev`, one real plan at minimum size with the agent, cancel, close.
