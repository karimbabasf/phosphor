# Phosphor v0.3 Basic View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `basic` view mode to Phosphor, a plain-English screen built to get one safe yes or no out of a non-technical person, switchable only by the connected agent.

**Architecture:** The server computes a `BasicView` model in TypeScript from the same state the pro view already renders, and ships it inside `/api/state`. The browser holds both templates in one page and swaps them with a `data-view` attribute. A new `set_view` MCP op writes the mode, refuses while any proposal is pending, and audits every switch.

**Tech Stack:** Node 24 native TypeScript type stripping (no build step), erasable TS only, `node --test`, zod for MCP schemas, vanilla ES5-flavoured browser JS, hand-written CSS.

**Spec:** `docs/superpowers/specs/2026-08-12-phosphor-basic-view.md`

## Global Constraints

- Erasable TypeScript only: no enums, no namespaces, no parameter properties. Relative imports carry explicit `.ts` extensions.
- No em dashes or en dashes anywhere, including copy strings and comments. Commas, colons and parentheses instead.
- Basic may remove detail. It may never remove a fact that would change the answer: amount in USD, what it becomes, and the balance afterwards always render.
- `BasicAsk.amountUsd` must equal `draft.amountUsd`, the number `evaluateRail` governed on.
- `totalUsd` is `null`, never `0`, when the balance is unknown or stale.
- Test the consequence, never the switch. No test may assert only that a pure function returns a value.
- Version `0.3.0` in `package.json`, `src/mcp.ts` and the `ui/index.html` status bar.
- Work happens in the `~/Developer/phosphor-basic` worktree on `feat/basic-view`. Never edit `~/Developer/phosphor`, a peer session owns that tree.

## File Structure

| File | Responsibility |
|---|---|
| `src/types.ts` (modify) | `ViewMode`, `BasicTone`, `BasicAsk`, `BasicView`; two new `LogEvent` types |
| `src/view/mode.ts` (create) | Read and write the persisted mode. Nothing else. |
| `src/view/basic.ts` (create) | Pure `buildBasic(input)`. All plain-English copy lives here and nowhere else. |
| `src/server.ts` (modify) | Two fields in `buildState()`, one `set_view` branch in `handleMcp()` |
| `src/main.ts` (modify) | Load the mode on boot, pass getter and setter into `createServer` |
| `src/mcp.ts` (modify) | Register `set_view`, bump version |
| `ui/index.html` (modify) | `data-view` on `#page`, a `#basic` section, version bump |
| `ui/style.css` (modify) | Basic scale and the mode swap |
| `ui/app.js` (modify) | `renderBasic(s)`, `applyViewMode(s)`, basic decide and stop wiring |
| `tests/unit/view-mode.test.ts` (create) | Persistence round trip and fallbacks |
| `tests/unit/basic-view.test.ts` (create) | All eleven states, the agreement test, the staleness rules |
| `tests/unit/state.test.ts` (modify) | `/api/state` carries `view` and `basic`; `set_view` refused while pending |
| `tests/injection.test.ts` (modify) | Sorted tool-name set gains `set_view` |
| `scripts/e2e.ts` (modify) | Drive `set_view` over a real MCP client, assert the consequence |

---

### Task 1: The mode, persisted

**Files:**
- Modify: `src/types.ts`
- Create: `src/view/mode.ts`
- Test: `tests/unit/view-mode.test.ts`

**Interfaces:**
- Produces: `type ViewMode = 'basic' | 'pro'`; `readViewMode(dataDir: string): ViewMode`; `writeViewMode(dataDir: string, mode: ViewMode): void`

- [ ] **Step 1: Add the type to `src/types.ts`**

Next to `Network`, since it is the same shape of idea (one field that moves the whole app):

```ts
// Which of the two screens the app window is showing. Persisted, because basic
// exists for a person who owns the money and is not technical: an app restart
// that dumped them back into pro would be an escape hatch Karim deliberately
// declined when he asked for agent-only switching.
export type ViewMode = 'basic' | 'pro';
```

And extend `LogEvent['type']` with `'view_changed'` and `'view_refused'`.

- [ ] **Step 2: Write the failing test**

```ts
// tests/unit/view-mode.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readViewMode, writeViewMode } from '../../src/view/mode.ts';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-view-'));
}

test('a dataDir with no view file reads as pro', () => {
  assert.equal(readViewMode(tmpDir()), 'pro');
});

test('a written mode round trips', () => {
  const dir = tmpDir();
  writeViewMode(dir, 'basic');
  assert.equal(readViewMode(dir), 'basic');
  writeViewMode(dir, 'pro');
  assert.equal(readViewMode(dir), 'pro');
});

test('an unparseable view file falls back to pro rather than throwing', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'view.json'), '{not json');
  assert.equal(readViewMode(dir), 'pro');
});

test('a parseable file holding an unknown mode falls back to pro', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'view.json'), JSON.stringify({ view: 'expert' }));
  assert.equal(readViewMode(dir), 'pro');
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `cd ~/Developer/phosphor-basic && node --test tests/unit/view-mode.test.ts`
Expected: FAIL, cannot find module `src/view/mode.ts`.

- [ ] **Step 4: Implement `src/view/mode.ts`**

Atomic write via tmp file plus rename, matching `store.ts`. Fails toward `pro` on every unreadable case, because pro shows more and a corrupt file must never silently simplify what a human sees.

- [ ] **Step 5: Run the tests and the typecheck**

Run: `node --test tests/unit/view-mode.test.ts && npx tsc --noEmit`
Expected: 4 pass, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/view/mode.ts tests/unit/view-mode.test.ts
git commit -m "The view mode, persisted, failing toward pro"
```

---

### Task 2: buildBasic, where all the copy lives

**Files:**
- Modify: `src/types.ts`
- Create: `src/view/basic.ts`
- Test: `tests/unit/basic-view.test.ts`

**Interfaces:**
- Consumes: `ViewMode` from Task 1
- Produces:

```ts
export type BasicInput = {
  wallet: WalletView;
  proposals: Proposal[];
  policyReadable: boolean;
  killSwitch: boolean;
  gateRequired: boolean;
  agentsConnected: number;
  chainStatus: Record<ChainId, ChainStatus>;
};
export function buildBasic(input: BasicInput): BasicView;
```

- [ ] **Step 1: Add `BasicTone`, `BasicAsk` and `BasicView` to `src/types.ts`**

Exactly as written in the spec's Types section. Copy them verbatim.

- [ ] **Step 2: Write the failing tests, all eleven states plus the four rules**

The copy table in the spec is the assertion set. Every state asserts a non-empty `headline`. Four rules get their own tests:

```ts
test('the ask carries the same USD the policy engine governed on', () => {
  const draft = swapDraft({ amountUsd: 105 });
  const view = buildBasic(withPending(draft));
  assert.equal(view.ask?.amountUsd, draft.amountUsd);
  assert.ok(view.ask?.headline.includes('105'));
  assert.ok(view.ask?.headline.includes(draft.toSymbol));
});

// The control that actually matters. Amount alone would not have caught F2, where the
// amount was right and the destination was a solver-chosen address behind the words
// "your wallet". Basic may render fewer words, never fewer facts about where money goes.
test('basic renders every destination the approval rests on', () => {
  const draft = swapDraft({ amountUsd: 105, counterparty: ROUTER });
  const simulation = { depositAddresses: [{ leg: 'leg0', address: SOLVER_ADDR }] };
  const view = buildBasic(withPending(draft, simulation));
  const shown = (view.ask?.destinations ?? []).map((d) => d.address.toLowerCase());
  assert.ok(shown.includes(ROUTER.toLowerCase()), 'counterparty must be rendered');
  assert.ok(shown.includes(SOLVER_ADDR.toLowerCase()), 'quoter-chosen deposit address must be rendered');
  const solver = view.ask?.destinations.find((d) => d.address.toLowerCase() === SOLVER_ADDR.toLowerCase());
  assert.equal(solver?.chosenBy, 'quoter');
  assert.doesNotMatch(solver?.label ?? '', /your (own )?wallet/i, 'must not call a quoter address the user wallet');
});

test('basic never truncates an address it shows', () => {
  const ELLIPSIS = String.fromCharCode(0x2026);
  const view = buildBasic(withPending(swapDraft({ counterparty: ROUTER })));
  for (const d of view.ask?.destinations ?? []) {
    assert.ok(!d.address.includes('...') && !d.address.includes(ELLIPSIS), 'addresses render in full');
  }
});

test('every symbol and chain the draft names survives into basic', () => {
  const draft = swapDraft({ fromSymbol: 'USDC', toSymbol: 'WETH', chain: 'arb', toChain: 'arb' });
  const view = buildBasic(withPending(draft));
  assert.deepEqual([...(view.ask?.symbols ?? [])].sort(), ['USDC', 'WETH']);
  assert.ok(view.ask?.chains.includes('arb'));
});

test('a stale chain shows no number at all, never a zero', () => {
  const view = buildBasic(withStaleChain('near'));
  assert.equal(view.totalUsd, null);
  assert.match(view.totalLine, /still checking/);
  assert.ok(!view.totalLine.includes('0.00'));
});

test('a balance read before the last execution is not stated as fact', () => {
  // The cache serves pre-trade balances and stamps them stale: [].
  const view = buildBasic(fetchedBeforeExecution());
  assert.equal(view.totalUsd, null);
  assert.match(view.totalLine, /checking your new balance/);
});

test('every one of the eleven states produces copy', () => {
  for (const [name, input] of ELEVEN_STATES) {
    const view = buildBasic(input);
    assert.ok(view.headline.trim().length > 0, `${name} rendered an empty headline`);
    assert.ok(view.footer.trim().length > 0, `${name} rendered an empty footer`);
  }
});
```

- [ ] **Step 3: Run and watch it fail**

Run: `node --test tests/unit/basic-view.test.ts`
Expected: FAIL, cannot find module `src/view/basic.ts`.

- [ ] **Step 4: Implement `src/view/basic.ts`**

One pure function, no I/O, no clock reads except the timestamps handed in. Precedence for `tone`, most dangerous first: `broken` (policy unreadable, or gate off) beats `frozen` (kill switch) beats `asking` beats `working` beats `stopped` beats `calm`. Copy strings come from the spec's eleven-state table verbatim.

- [ ] **Step 5: Run tests and typecheck**

Run: `node --test tests/unit/basic-view.test.ts && npx tsc --noEmit`
Expected: all pass, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/view/basic.ts tests/unit/basic-view.test.ts
git commit -m "buildBasic: the whole basic screen as one pure function"
```

---

### Task 3: Server wiring and the set_view op

**Files:**
- Modify: `src/server.ts`, `src/main.ts`
- Test: `tests/unit/state.test.ts`

**Interfaces:**
- Consumes: `readViewMode`/`writeViewMode` (Task 1), `buildBasic` (Task 2)
- Produces: `ServerDeps` gains `getView(): ViewMode` and `setView(mode: ViewMode): void`; `/api/state` gains `view` and `basic`; `handleMcp` accepts `{ op: 'set_view', mode }`

- [ ] **Step 1: Write the failing tests**

```ts
test('/api/state carries the view mode and a basic model in both modes', async () => {
  const s = await bootTestServer({ view: 'pro' });
  const state = await getJson(s, '/api/state');
  assert.equal(state.view, 'pro');
  assert.ok(state.basic, 'basic must be computed even when pro is rendering');
});

test('set_view flips the mode and the next state read shows it', async () => {
  const s = await bootTestServer({ view: 'pro' });
  const res = await postMcp(s, { op: 'set_view', mode: 'basic' });
  assert.equal(res.status, 200);
  assert.equal((await getJson(s, '/api/state')).view, 'basic');
});

test('set_view is refused while a proposal is pending, and changes nothing', async () => {
  const s = await bootTestServer({ view: 'pro', pending: swapProposal() });
  const res = await postMcp(s, { op: 'set_view', mode: 'basic' });
  assert.equal(res.status, 409);
  assert.equal((await getJson(s, '/api/state')).view, 'pro');
  assert.ok(auditTypes(s).includes('view_refused'));
});

test('an unknown mode is refused and changes nothing', async () => {
  const s = await bootTestServer({ view: 'pro' });
  assert.equal((await postMcp(s, { op: 'set_view', mode: 'expert' })).status, 400);
  assert.equal((await getJson(s, '/api/state')).view, 'pro');
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `node --test tests/unit/state.test.ts`
Expected: FAIL on the new tests, existing ones still pass.

- [ ] **Step 3: Implement**

In `buildState()`, add `view: getView()` and `basic: buildBasic({...})`. In `handleMcp`, add the `set_view` branch after `propose`, keeping the existing contract that every op is audit-logged before dispatch. Add `set_view` to the op list in the unknown-op error string. Wire `getView`/`setView` through `main.ts` from `readViewMode(cfg.dataDir)`.

- [ ] **Step 4: Run the full unit suite**

Run: `npm test && npx tsc --noEmit`
Expected: all pass. The pre-existing count was 327; expect it higher, and no failures.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts src/main.ts tests/unit/state.test.ts
git commit -m "set_view, refused while a human is mid-decision"
```

---

### Task 4: The MCP tool

**Files:**
- Modify: `src/mcp.ts`
- Test: `tests/injection.test.ts`

**Interfaces:**
- Consumes: the `set_view` op from Task 3
- Produces: a fourteenth tool named `set_view`

- [ ] **Step 1: Update the tool-name-set assertion**

`injection.test.ts` asserts a sorted name set, never a count. Add `set_view` to the expected array.

- [ ] **Step 2: Run and watch it fail**

Run: `node --test tests/injection.test.ts`
Expected: FAIL, the actual set lacks `set_view`.

- [ ] **Step 3: Register the tool**

```ts
server.registerTool(
  'set_view',
  {
    description:
      "Switches the app window between the detailed operator view and a simplified view written for someone non-technical. This changes what the human sees before they approve anything, so it is refused while any proposal is waiting for a decision, and every switch is written to the audit log. It cannot approve, refuse or execute anything.",
    inputSchema: { mode: z.enum(['basic', 'pro']) },
  },
  async (args) => proxy({ op: 'set_view', mode: args.mode }),
);
```

Bump `McpServer` version to `0.3.0`.

- [ ] **Step 4: Fix the false claim on the six propose tools**

`CANNOT_APPROVE` is one shared constant interpolated into all six propose descriptions, so all
six currently tell the agent "Execution only ever happens after a human approves in the app
window". That is false below `humanClickAboveUsd`: a $60.64 `lp_add` executed immediately with
`decidedBy: 'policy'` on 2026-08-12. Replace the constant:

```ts
const CANNOT_APPROVE =
  'Returns a proposal id and simulation result. This tool cannot approve, refuse or execute anything. Whether a human is asked depends on the policy: proposals above the click threshold wait for a human click in the app window, and proposals below it are decided by the policy engine and may execute immediately.';
```

Scope call, flagged in the final report. Shipping an honest `set_view` description directly above
six dishonest siblings in the same file and the same commit is not a defensible place to stop.

- [ ] **Step 5: Run the injection suite**

Run: `node --test tests/injection.test.ts`
Expected: PASS, and the existing assertion that no tool schema carries a destination field still holds.

- [ ] **Step 5: Commit**

```bash
git add src/mcp.ts tests/injection.test.ts
git commit -m "set_view on the tool surface, described honestly"
```

---

### Task 5: The basic screen

**Files:**
- Modify: `ui/index.html`, `ui/style.css`, `ui/app.js`

**Interfaces:**
- Consumes: `state.view` and `state.basic` from Task 3
- Produces: nothing other tasks read

- [ ] **Step 1: Add the markup**

`data-view="pro"` on `<main id="page">`, then a `<section id="basic">` sibling to `.deck` holding: total, places line, headline, ask block, YES and NO buttons, warning line, agent line, footer, and a separated STOP EVERYTHING control. Status bar reads `PHOSPHOR v0.3`.

- [ ] **Step 2: Add the CSS**

`[data-view="basic"] .deck { display: none }` and `[data-view="pro"] #basic { display: none }`. Basic scale: base 20px, balance 64px, buttons at least 56px tall, full width to a 420px cap, same phosphor green on near-black, no box-drawing frames. Tones map through a class, never a raw server string.

- [ ] **Step 3: Add the JS**

`applyViewMode(s)` sets `page.dataset.view = s.view === 'basic' ? 'basic' : 'pro'`. `renderBasic(s)` renders `s.basic` and nothing else, calling the existing `decide()` for YES and NO so approval goes through one code path in both modes. **Do not reuse the names `applyView` or `setViewCount`: both already exist and mean the chart's candle window.** STOP EVERYTHING takes two presses and posts to `/api/kill`.

- [ ] **Step 4: Look at it**

Run: `npm run app` on a spare port, then flip to basic via the op surface, then:
`node ~/.claude/tools/ui-gate.mjs http://127.0.0.1:<port> --src ui`
Expected: iterate to `UI-GATE: PASS`. Read the PNG each round; the audit is blind to whether the page is legible to the person it is for.

- [ ] **Step 5: Commit**

```bash
git add ui/index.html ui/style.css ui/app.js
git commit -m "The basic screen: one balance, one question, two buttons"
```

---

### Task 6: End to end, through a real MCP client

**Files:**
- Modify: `scripts/e2e.ts`

- [ ] **Step 1: Add the checks**

Drive `set_view` over stdio through the real MCP client the script already builds, not over HTTP. Then:

1. `GET /api/state` shows `view === 'basic'`.
2. `state.basic.ask.headline` contains the live proposal's real amount.
3. With a proposal pending, `set_view` returns 409 and the mode is unchanged.
4. The audit log holds a `view_changed` line.

Check 2 is the one that matters. A flag that changes only what the app says about itself is the exact defect this repo already shipped once.

- [ ] **Step 2: Run it**

Run: `npm run app` then `npm run e2e`
Expected: the pre-existing 19 checks still pass, plus the new ones.

- [ ] **Step 3: Commit**

```bash
git add scripts/e2e.ts
git commit -m "e2e: prove the view flip carries the real amount, not just the label"
```

---

### Task 7: Docs and version

**Files:**
- Modify: `README.md`, `docs/architecture.md`, `docs/security-model.md`, `package.json`

- [ ] **Step 1: Write the security model section**

The agent can now change what the human sees. State it plainly, then state what stops it mattering: identical facts in both modes with a test asserting it, refused while any proposal is pending, every switch audited. v0.2 shipped a security model describing a mechanism that did not exist; a new agent capability left out of that file is the same mistake facing the other way.

- [ ] **Step 2: README and architecture**

README gains basic view and the fourteenth tool. `docs/architecture.md` gains `src/view/`.

- [ ] **Step 3: Bump to 0.3.0**

`package.json`. (`src/mcp.ts` was done in Task 4, `ui/index.html` in Task 5.)

- [ ] **Step 4: Full verification**

Run: `npm test && npx tsc --noEmit && npm run sweep && npm run e2e`
Expected: all green, sweep 6/6.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/ package.json
git commit -m "v0.3: docs, and the security model says what the agent can now do"
```

---

## Self-Review

**Spec coverage:** Types → Task 1, 2. Mode persistence → Task 1. `buildBasic` and the eleven states → Task 2. Both staleness rules → Task 2. State payload → Task 3. `set_view` including refuse-while-pending → Task 3, 4. Honest description → Task 4. Frontend → Task 5. Tests 1 through 6 of the spec → Tasks 1, 2, 3, 4, 6. Test 7 (ui-gate) → Task 5. Docs → Task 7. Version → Tasks 4, 5, 7. No gaps.

**Placeholders:** None. Every step names its file, its command and its expected result.

**Type consistency:** `ViewMode`, `BasicTone`, `BasicAsk`, `BasicView`, `BasicInput`, `buildBasic`, `readViewMode`, `writeViewMode`, `getView`, `setView` are spelled the same in every task.

**One correction to the spec, made here:** the agreement test compares `basic.ask` against the **draft**, not against what pro renders. `headlineFor()` in `app.js` has no branch for swap, hl_deposit, lp_add or lp_remove and falls through to `String(proposal.kind)`, so pro's string is a weaker authority than the draft. The draft is what the policy engine read, so the draft is what basic must agree with. (Pro's missing branches are a real gap, filed, not fixed here.)
