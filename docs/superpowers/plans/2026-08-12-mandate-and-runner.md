# Mandate and Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A human clicks once to arm a bounded mandate, and a deterministic runner executes an agent-authored strategy inside that envelope on Hyperliquid perpetuals, with no model in the execution path.

**Architecture:** A declarative grammar the agent emits and a human reads in English; a mandate that rides phosphor's existing proposal and gate machinery; and a child process that evaluates the program against a websocket feed and signs orders with an API wallet that cannot withdraw. The envelope is checked in the same function that signs.

**Tech Stack:** Node 24 type stripping, no build step, erasable TypeScript only. `viem` for keccak256 and EIP-712 signing. Hand-rolled msgpack (no new dependency). Tests are `node --test`.

**Spec:** `docs/superpowers/specs/2026-08-12-phosphor-trading-design.md`
**Depends on:** `docs/superpowers/plans/2026-08-12-instrument-surface.md` (complete). Drawing ids from `src/drawings.ts` are what a `Ref` points at.

## Global Constraints

- **Erasable TypeScript only.** No enums, no namespaces, no parameter properties. Explicit `.ts` extensions on relative imports.
- **The grammar has no verb for moving value off the venue.** No withdraw, no transfer, no approve, and no schema field anywhere accepts an address. `tests/injection.test.ts` gains the mandate schemas.
- **Arming never auto-approves.** It joins `policy_change` in the carve-out at `src/proposals.ts:333`: pending on every network with the gate on or off.
- **Every number on the Hyperliquid wire is a string** with at most 8 decimals, trailing zeros stripped, `-0` normalised to `0`. `"1.50"` and `"1.5"` hash differently.
- **Lowercase every address before signing.**
- **`f` on an order and `a` on a modify must be OMITTED when false.** Actions hashed with `f: false` are rejected.
- **L1 action chainId is literally 1337** on mainnet and testnet both. Mainnet versus testnet is carried only by the phantom agent's `source`, `"a"` or `"b"`.
- **Testnet only.** `MAINNET_REFUSED` guard in the runner, matching `src/rails/hyperliquid-withdraw.ts:427`.
- **No em dashes or en dashes** in any file, including comments and commit messages.

---

## Locked interfaces

Every task implements against these exactly. They are the contract between tasks.

```ts
// src/strategy/grammar.ts
export type Ref =
  | { kind: 'price'; value: number }
  | { kind: 'drawing'; id: string }              // 'tl_1' | 'zn_1', from src/drawings.ts
  | { kind: 'indicator'; id: string; plot?: string };

export type Condition =
  | { op: 'price_above' | 'price_below' | 'price_cross_up' | 'price_cross_down'; ref: Ref }
  | { op: 'bar_close'; timeframeSec: number; side: 'above' | 'below'; ref: Ref }
  | { op: 'position'; state: 'flat' | 'long' | 'short' }
  | { op: 'pnl_pct'; cmp: 'gt' | 'lt'; value: number }
  | { op: 'elapsed'; since: 'arm' | 'entry'; cmp: 'gt' | 'lt'; seconds: number }
  | { op: 'and' | 'or'; of: Condition[] }
  | { op: 'not'; of: Condition };

export type Entry =
  | { type: 'market'; maxSlippageBps: number }
  | { type: 'limit'; ref: Ref; postOnly?: boolean };

export type Action =
  | { do: 'open'; side: 'long' | 'short'; sizeUsd: number; leverage: number; entry: Entry }
  | { do: 'add'; sizeUsd: number; entry: Entry }
  | { do: 'reduce'; fraction: number; exit: Entry }
  | { do: 'close'; exit: Entry }
  | { do: 'set_stop'; ref: Ref; trailPct?: number }
  | { do: 'set_target'; ref: Ref; fraction: number }
  | { do: 'cancel'; which: 'all' | 'entries' | 'exits' }
  | { do: 'stand_down'; reason: string }
  | { do: 'notify'; text: string };

export type Rule = { id: string; when: Condition; then: Action[]; once?: boolean; cooldownSec?: number };
export type Program = { symbol: string; rules: Rule[]; invalidate?: Condition };

export const PROGRAM_SCHEMA: z.ZodType<Program>;           // zod, rejects unknown keys
export function validateProgram(raw: unknown): { ok: true; program: Program } | { ok: false; errors: string[] };
export function programHash(p: Program): string;            // sha256 of canonical JSON, stable key order
export function actionVerbs(p: Program): Action['do'][];    // sorted, deduped

// src/strategy/render.ts
export function renderProgram(p: Program): string[];        // one plain-English line per rule
export function worstCaseUsd(p: Program, m: Mandate): number;

// src/strategy/envelope.ts
export type Mandate = {
  id: string; programHash: string; symbol: string;
  maxNotionalUsd: number; maxLeverage: number; maxOrdersPerMin: number;
  maxLossUsd: number; expiresAt: string; allowedActions: Action['do'][];
};
export type RunState = {
  nowMs: number; armedAtMs: number; symbol: string;
  positionUsd: number; positionSide: 'flat' | 'long' | 'short';
  realisedUsd: number; unrealisedUsd: number;
  ordersInLastMin: number; programHash: string;
};
export type Ruling = { allow: true } | { allow: false; halt: boolean; reason: string };
export function checkEnvelope(action: Action, m: Mandate, s: RunState): Ruling;

// src/hl/format.ts
export function wireNumber(x: number): string;                        // 8dp, trailing zeros stripped, -0 -> 0
export function formatPrice(px: number, szDecimals: number, isPerp: boolean): string;
export function formatSize(sz: number, szDecimals: number): string;

// src/hl/msgpack.ts
export function packb(value: unknown): Uint8Array;                    // maps in insertion order

// src/hl/liquidation.ts
export function liquidationPrice(a: { entryPx: number; side: 'long'|'short'; positionSize: number;
  marginAvailable: number; maintenanceLeverage: number }): number;
export function distanceToLiquidationPct(markPx: number, liqPx: number, side: 'long'|'short'): number;

// src/hl/sign.ts
export function actionHash(action: unknown, nonce: number, vaultAddress: string | null, expiresAfter: number | null): `0x${string}`;
export function signL1Action(privKey: `0x${string}`, action: unknown, nonce: number, isMainnet: boolean,
  vaultAddress?: string | null, expiresAfter?: number | null): Promise<{ r: string; s: string; v: number }>;
```

---

### Task 1: The grammar, its schema, and its hash
Files: create `src/strategy/grammar.ts`, `tests/unit/strategy-grammar.test.ts`.
Tests must cover: a valid program round-trips; an unknown key is rejected (zod `.strict()`); a negative `sizeUsd` is rejected; `leverage` outside 1..40 is rejected; **no schema field is named or shaped like an address**; `programHash` is stable across key reordering and changes when any value changes; `actionVerbs` is sorted and deduped.

### Task 2: Rendering a program to English, and its worst case
Files: create `src/strategy/render.ts`, `tests/unit/strategy-render.test.ts`.
`renderProgram` produces one line per rule that a human can check against intent, for example
`when price crosses up tl_1: open long $500 at 3x, limit at tl_1`. A `Ref` renders as its drawing id, not as a raw number, because the id is what the human sees on the chart.
`worstCaseUsd` returns the mandate's `maxNotionalUsd` when no rule sets a stop, and the summed stop distance times size when every open is paired with one. It must never return a number smaller than the true exposure: a worst case that flatters the program is the one defect this function can have.

### Task 3: msgpack, wire numbers, tick and lot
Files: create `src/hl/msgpack.ts`, `src/hl/format.ts`, tests for both.
msgpack must emit the compact forms Python's `msgpack.packb` emits: fixint, uint8/16/32/64, int8/16/32/64, float64 `0xcb`, fixstr/str8/16/32, fixarray/array16/32, fixmap/map16/32, `0xc2`/`0xc3` for booleans, `0xc0` for nil. **Map keys keep insertion order.**
`formatPrice`: at most 5 significant figures AND at most `6 - szDecimals` decimals for a perp; integer prices always valid. Test against every documented example: `1234.5` valid, `1234.56` not; `0.001234` valid, `0.0012345` not; with `szDecimals = 1`, `0.01234` valid and `0.012345` not.
`wireNumber`: `1.5` and `1.50` both give `"1.5"`; `-0` gives `"0"`; more than 8 decimals throws rather than silently rounding.

### Task 4: Liquidation price and distance
Files: create `src/hl/liquidation.ts`, test.
`liq_price = price - side * margin_available / position_size / (1 - l * side)` with `l = 1 / maintenanceLeverage`, `side = 1` long and `-1` short. Test long and short by hand, and assert a long's liquidation sits below entry and a short's above.

### Task 5: The envelope check
Files: create `src/strategy/envelope.ts`, test.
Refuses and halts on: a verb outside `allowedActions`; a symbol mismatch; notional over `maxNotionalUsd` counting the existing position; leverage over `maxLeverage`; more than `maxOrdersPerMin` orders in the trailing minute; realised plus unrealised loss at or beyond `maxLossUsd`; past `expiresAt`; a `programHash` that does not match.
**Halting rather than clamping is the property under test.** An order that would breach is refused whole; it is never shrunk to fit. Safety verbs (`close`, `reduce`, `cancel`, `stand_down`, `notify`) are allowed even past expiry or a loss breach, because getting flat must never be blocked by the rule that noticed the problem.
Property test: no sequence of actions accepted by `checkEnvelope` can leave notional above `maxNotionalUsd` or leverage above `maxLeverage`.

### Task 6: Signing
Files: create `src/hl/sign.ts`, test.
`actionHash` = `keccak(msgpack(action) || nonce as 8 bytes BE || 0x00 for a null vault (else 0x01 || 20 address bytes) || 0x00 || expiresAfter as 8 bytes BE when present)`.
Then EIP-712 over domain `{ name: 'Exchange', version: '1', chainId: 1337, verifyingContract: zero }`, primary type `Agent`, types `[source string, connectionId bytes32]`, message `{ source: isMainnet ? 'a' : 'b', connectionId: actionHash }`.
Test: a known action produces a stable hash (pin it, so a msgpack regression is caught); testnet and mainnet produce different signatures for the same action; the recovered address equals the signer.

### Task 7: The exchange client
Files: create `src/hl/exchange.ts`, test.
Builds `order`, `cancel`, `cancelByCloid`, `updateLeverage` actions in the documented field order, posts the envelope, and generates a cloid per order for idempotent retry. Nonce is one atomic counter fast-forwarded to unix milliseconds. Orders and cancels batch on a short timer, with add-liquidity-only batches kept separate from immediate-or-cancel and good-til-cancelled.
**Test with a stub transport, never against the live venue.**

### Task 8: The evaluator
Files: create `src/strategy/evaluate.ts`, test.
Pure: `(program, marketState, runState) => Action[]`. Same inputs, same output. Resolves a `Ref` through the drawing store so `line:tl_1` becomes a price at the current time. Honours `once` and `cooldownSec`. Cross conditions need the previous tick's price, so the evaluator takes it rather than holding state.

### Task 9: The mandate rail and the arm path
Files: create `src/rails/mandate.ts`; modify `src/types.ts` (add `MandateDraft`, extend `WriteDraft` and `ProposalStatus` use), `src/rails/index.ts`, `src/proposals.ts` (the never-auto-approve carve-out), `src/policy/engine.ts` if the venue allowlist needs the `hyperliquid-perps` entry.
`simulate()` renders the program to English and computes the worst case. It signs nothing.
`execute()` spawns or signals the runner. Disarm is a plain function, never a draft, never gated.

### Task 10: The runner process
Files: create `src/runner/main.ts`, `src/runner/feed.ts`, `src/runner/supervisor.ts`.
Child process, one per app, hosting every armed mandate over one multiplexed websocket. Subscribes `activeAssetData`, `orderUpdates`, `userFills`, `bbo`. Folds `isSnapshot: true` messages once. The supervisor runs every tick regardless of program logic and watches drawdown, expiry, distance to liquidation and the kill switch; on breach it flattens and disarms without consulting the program. Reports over IPC on a channel separate from execution, so a slow consumer cannot back-pressure an order.

### Task 11: MCP and server surface
Files: modify `src/mcp.ts` (register `propose_mandate` with enumerated args and no address field), `src/server.ts` (routes for arm, disarm, runner status; a `trading` SSE payload type), `tests/injection.test.ts` (add the tool to the exact set; assert the new schemas carry no address).

### Task 12: The trading surface in the window
Files: modify `ui/index.html`, `ui/app.js`, `ui/chart.js`, `ui/style.css`, `.design/brief.md`.
Position as a line on the chart with size and side, liquidation price as a line the eye finds first, stops and targets as lines, working orders at their price, fills as marks. The mandate's maximum loss draws as a real price, so the wall is visible. A kill switch that is always live. Then `node ~/.claude/tools/ui-gate.mjs` to PASS.

### Task 13: Security audit
Invoke the `security-audit` skill over the signer, the envelope and the arm path before calling this done. This is a wallet and a signer, which is the documented trigger.

## Verification
`npm test` green, `npm run typecheck` clean, `tests/injection.test.ts` extended and passing, UI gate PASS, and on testnet: arm a mandate, watch a fill, watch a stop fire, hit the kill switch mid-position and confirm flat. Plus the empirical check that an API-wallet-signed withdrawal cannot move master funds.
