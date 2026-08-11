# phosphor

A local app that holds stablecoin state, chain connections and policy, and contains no AI. It
exposes an MCP server. An agent you already pay for (Claude Code, Codex, anything speaking MCP)
connects and drives it. The app is the car, the agent is the person with the key.

The agent can read everything and propose actions. It can never approve, never execute, and never
touch policy without a human click in the app window. The policy engine enforces authored rules at
machine speed with no model in the execution path.

## Run it

Requires Node 24+. No build step.

    npm install
    npm run app

Open http://127.0.0.1:4177. Demo mode is the default: a fixture portfolio across eth, base, arb,
sol and near, a synthetic quoter, and the full propose/approve/execute loop working offline.

Connect an agent (Claude Code):

    claude mcp add phosphor -- node ~/Developer/phosphor/src/mcp.ts

The agent gets 7 read tools (balances, composition, cost, policy_show, log_tail, candles,
proposal_status) and 2 write tools (propose_consolidate, propose_policy_change). Write tools only
ever create proposals. Approve or refuse them in the browser window.

## Test it

    npm test          # unit suites: policy engine, proposals, ledger, composition, cost, rails, injection
    npm run e2e       # boots the app + a real MCP client, drives the full loop, exits 0/1
    npx tsc --noEmit  # typecheck

## Live mode

Set `"mode": "live"` in config.json and add your addresses under `addresses` (evm, solana, near).
Balance reads use public RPCs and need no keys. Quotes come from NEAR Intents 1Click (no key for
dry quotes).

## Auth steps (deliberately last)

Live execution is stubbed behind a Signer interface and fails with a clear message until keys are
configured. To go live, in this order:

1. Review data/risk-table.json rows and sources (curated, human-owned).
2. Decide key custody for the sending side (env var, keychain, or hardware) and implement a Signer
   for it in src/intents.ts (interface in src/types.ts; the stub shows the contract).
3. Real 1Click execution: request a non-dry quote (returns a depositAddress), send funds to it
   with the Signer, poll /v0/status. The quote client already exists; only the signing send is
   missing. Note toBaseUnits must move to BigInt before signing 18-decimal amounts.
4. Optional: JWT for 1Click (lower fee tier) via the NEAR Intents site.
5. Optional indexer keys (Etherscan or similar) if you want historical gas/spread lines in the
   cost region; the four live-computed lines work without them.

## Layout

    src/main.ts        app process: state owner, HTTP + UI on 127.0.0.1:4177
    src/mcp.ts         stdio MCP server, thin proxy to the app, no approval path
    src/policy/        engine (pure) + policy file + sentence renderer
    src/proposals.ts   simulate, evaluate, persist, execute after approval
    src/ledger/        evm, solana, near readers + demo fixtures
    src/composition.ts risk classification against data/risk-table.json
    src/cost.ts        fragmentation cost, four lines
    src/intents.ts     1Click quotes, synthetic quoter, stub signer
    src/candles.ts     Coinbase/Kraken candle sources behind one interface
    ui/                one page, seven regions, no framework, no build
    state/             policy.json, proposals.json, audit.jsonl (append-only)
