# Phosphor v2: wallet view and three live testnet rails

Status: DRAFT. Rail sections (7, 8) fill from research in flight.
Author: agent team, 2026-08-11. Supersedes nothing; extends
`2026-08-11-phosphor-design.md`, which stays the law for the visual register.

## 0. The ask, compressed

Karim, 2026-08-11, verbatim intent in one sentence each:

1. Composition becomes a normal crypto wallet view: token, chain, quantity, price, plus an
   interactive donut. It owns the whole bottom left.
2. Cost is not a vital feature. Remove it.
3. The approval gate keeps its position, but testnet runs with no gate at all.
4. Policy and log must be clearly collapsible.
5. The wallet must show liquidity pool positions on any chain.
6. Three features must work end to end, all on testnet: swap, deposit to Hyperliquid, and
   provide/withdraw liquidity. Swaps route through NEAR. Staking and LP go direct to the chain if
   NEAR cannot carry them.
7. Demo mode off.
8. The git remote carries config and installable code only. No keys, no addresses, no state.

Out of scope by his explicit instruction: Hyperliquid trading mechanics beyond the deposit. The
requirement is that the three things are *doable*, not that the trading engine exists.

## 1. Standing constraints this build must not break

Carried from v1, all still load-bearing:

- Node 24 native type stripping, no build step. Erasable TypeScript only: no enums, no namespaces,
  no parameter properties, explicit `.ts` on relative imports.
- `src/types.ts` is the shared contract. Every module signature derives from it.
- The app process owns all state. `src/mcp.ts` stays a thin stdio proxy with no approve path.
- Policy sentences render machine-generated. Agent prose is quarantined inside the proposal record
  and never read as a rule.
- Approval re-runs the policy engine at click time. A stored verdict is a record, never an authority.
- The page never scrolls. Panels scroll inside themselves. `min-width: 0` on `.col` is load-bearing.
- Red in UI chrome belongs to the approval gate, refusals and breached cells. Chart candle red stays
  the darker `#cc3a30` so the gate is the only alarm.
- Peer Claude sessions share this repo. Re-read before broad edits.

## 2. Network model

`Mode` today is `demo | live` and `demo` is the default. Karim wants demo off and everything on
testnet. Two candidate shapes were weighed:

- **Add testnet chain ids** (`arb-sepolia`, `base-sepolia`, ...). Rejected: it doubles every
  `ChainId` switch in the engine, the ledger, the policy file and the UI, and the chain column then
  reads `arb-sepolia` where a wallet would read `ARB`.
- **Add a `network` axis, chosen.** `ChainId` keeps meaning the chain family. A new
  `Network = 'testnet' | 'mainnet'` selects the RPC endpoint, the token registry and the contract
  addresses per chain. One config field moves the whole app between worlds.

```ts
export type Network = 'testnet' | 'mainnet';
export type Mode = 'demo' | 'live';   // unchanged; demo survives for the offline test suite
```

`AppConfig` gains `network: Network`. Shipped `config.json` is `mode: "live"`, `network: "testnet"`.
Demo mode stays in the codebase because 129 tests and the e2e script run offline against it, but it
is no longer any default anywhere.

Token registry `data/tokens.json` grows a network layer: `network -> chain -> symbol -> {tokenId,
decimals}`. Same for RPC urls, which move out of `src/ledger/index.ts` into a per-network table.

**The rule that keeps testnet from leaking into mainnet:** every rail module takes `network` as an
argument and has no default. A missing network is a throw at boot, not a silent fall back to
mainnet.

## 3. Composition becomes the wallet view

Karim: "the composition thing should just show what a normal crypto wallet would show."

Today `classify()` filters to `!h.native`, so the panel shows stablecoins only and prices them at
their USD value. A wallet shows everything it holds.

### 3.1 What stays

`classify()` and `CompositionView` do not go away. The policy engine consumes `byIssuer` and
`freezableShare` to enforce the composition rules, and deleting it would rip out half the product.
It stops being what the UI renders and becomes what the engine reads.

### 3.2 What is new

```ts
export type WalletRow = {
  kind: 'token' | 'lp';
  chain: ChainId;
  symbol: string;        // 'USDC', 'ETH', or 'USDC/WETH 0.05%' for an LP position
  tokenId: string;
  quantity: number;
  priceUsd: number;      // 1.0 for stables, spot for natives, see 8.3 for testnet pricing
  valueUsd: number;      // quantity * priceUsd
  share: number;         // 0..1 of wallet total
  native: boolean;
  lp?: LpPosition;       // present when kind === 'lp'
};

export type WalletView = {
  rows: WalletRow[];     // value descending
  totalUsd: number;      // everything, natives and LP included
  byChain: Record<ChainId, number>;
  stale: ChainId[];      // chains whose last read failed
};
```

Columns, exactly what he listed plus the value the donut needs:

    TOKEN   CHAIN   QTY   PRICE   VALUE   SHARE

LP rows render in the same table with the pair as the symbol and the position's total value, so a
pool position reads as one line of the wallet rather than a separate region.

### 3.3 The donut

Canvas, drawn with the chart's existing renderer conventions: no library, no SVG, one hue with
brightness tiers per slice, box-drawing legend. Interactive means: hover a slice highlights it and
writes the row into a readout line under the donut; hover a table row highlights its slice. Click
does nothing, because there is nowhere to navigate to on a one-page app.

It sits left of the table inside the composition panel, sized so the panel keeps one screen. If it
cannot fit at 1440x900 without pushing the table under the fold, the donut is cut, not the table.
Karim said "if you can fit it in" and the table is what he actually asked for.

### 3.4 Where the risk classification goes

The freeze and issuer columns leave the wallet table. They stay visible where they matter: the
policy panel already renders the composition sentences, and a breach still marks the offending
wallet row's SHARE cell red exactly as it does today. Nothing about the policy engine changes.

## 4. Cost is removed

Delete `src/cost.ts`, the `CostLine` and `CostReport` types, the `cost` key from `buildState()`,
the `cost` MCP read tool, the COST panel from `ui/index.html`, `renderCost()` from `ui/app.js`,
the `.panel-cost` rules from `ui/style.css`, and `tests/unit/*` cost cases.

Verified before writing this: nothing in `src/policy/engine.ts` or `src/proposals.ts` reads
`CostReport`. It is a leaf. Removal is clean.

The freed space in the left column goes to composition, per his instruction that the whole bottom
left becomes composition.

## 5. Policy and log collapse

Both panels get a collapse control in the frame title, rendered in the existing box-drawing
register rather than as a widget:

    ├─ POLICY ──────────────────────────────────── [-] ─┤     expanded
    ├─ POLICY ──────────────────────────────────── [+] ─┤     collapsed, body hidden

Clicking anywhere on the frame title toggles. Collapsed state persists in `localStorage` per panel,
so the layout Karim leaves is the layout he returns to. A collapsed panel releases its flex space
to its siblings, which is the point: collapsing the log gives the gate room.

The gate never collapses. A safety surface that can be hidden is a safety bug, and this is the same
reasoning that made the gate red in v1.

## 6. The approval gate on testnet

Karim: "approval gate is fine where it is. but we wont need it for testing, right now since we are
on test net no safeguards."

This is the one instruction that can quietly destroy the product's central claim, so the bypass is
built to be impossible to carry into mainnet:

```ts
// AppConfig
approvalGate: boolean;   // config-settable
```

Resolved once at boot, in one function, with no other caller:

```ts
function gateRequired(cfg: AppConfig): boolean {
  if (cfg.network === 'mainnet') return true;   // not configurable, ever
  return cfg.approvalGate;
}
```

- `network: 'mainnet'` forces the gate on and ignores `approvalGate` entirely.
- `network: 'testnet'` with `approvalGate: false` auto-approves any proposal that the policy engine
  returns `needs_approval` for. A `refuse` verdict still refuses: the policy engine keeps running,
  the kill switch keeps working, and the audit log records every auto-approval with
  `decidedBy: 'gate_disabled'` so the transcript never claims a human clicked.
- The status bar shows a permanent unmissable line while the gate is off:
  `GATE DISABLED - TESTNET - EVERY PROPOSAL AUTO-APPROVES`, in the gate's own red.

A test asserts `gateRequired({network: 'mainnet', approvalGate: false})` is `true`. That test is the
thing standing between a convenience flag and a product that lies about what it is.

## 7. The finding that reshaped this section

**NEAR Intents has no testnet.** Not "an awkward one", none. Four independent lines of
evidence, collected 2026-08-12: every candidate host is NXDOMAIN, the verifier contract account on
NEAR testnet has never had code deployed, the official SDK ships exactly one base URL and it is
mainnet, and the complete 62-page documentation set contains zero occurrences of "testnet",
"sandbox" or "staging".

So "swaps route through NEAR, tested on testnet" cannot both be true. Nobody can do it. The
options were: build a fake testnet host (dishonest), run small real-money mainnet swaps (spends
Karim's money without asking), or test the swap capability on a real testnet DEX while keeping the
NEAR rail complete and mainnet-ready. **Chosen: the third.**

Two findings soften it considerably:
- `dry:false` on 1Click needs **no API key and no NEAR signing**. An unauthenticated request
  returns HTTP 201 with a live deposit address, and the only signing is a plain ERC-20 transfer to
  that address. The rail is far simpler than the v1 AUTH-LAST list assumed: no NEP-413, no NEAR
  account with a registered key.
- The `1Click` rail is therefore complete and correct in this build. It is gated so `execute()`
  throws unless the network is `mainnet`, which is the honest form of "we did not test this".

### Rail: swap
Two venues behind one `swap` draft kind.
- `venue: 'oneclick'`: quote `dry:false` -> `depositAddress` -> ERC-20 transfer -> poll `/v0/status`.
  Mainnet only, hard-guarded. Its counterparty is a freshly minted deposit address that no allowlist
  can ever contain, so it always requires a human click. That is the correct outcome, not a
  limitation: an unvetted destination is exactly what the click threshold exists for.
- `venue: 'uniswap-v3'`: same-chain exact-input swap on Arbitrum Sepolia. This is the one that
  actually executes on testnet.

## 8. Rails: Hyperliquid deposit, LP, and one chain for all three

### The chain decision
Everything runs on **Arbitrum Sepolia (421614)**, not Base Sepolia as first planned.

The reason is funding, not technology. No scriptable faucet exists for either chain: every one is a
browser with a captcha, and most gate on a mainnet ETH balance. Base Sepolia would mean Karim funds
two wallets on two chains. Arbitrum Sepolia means one, and the swap rail can then produce the USDC
the LP rail needs, so a single ETH transfer bootstraps all three features.

Verified live by the lead before committing to the move, not taken on report:

    factory 0x248AB79Bbb9bC29bB72f7Cd42F17e054Fc40188e
    getPool(USDC, WETH, 3000) -> 0x66eeab70ac52459dd74c6ad50d578ef76a441bbf
      liquidity 8449934188401 | USDC 8808.22 | WETH 0.7595 | token0 = USDC

Base Sepolia stays in the address table as a supported option (its pool is deeper) but is not the
default. Addresses live in a per-network, per-chain table; neither chain is hardcoded.

**Trap recorded:** the same address hosts different contracts on different chains, because an
address is deployer plus nonce. A Base address must never be carried to Arbitrum on the assumption
the name matches. Verify by behaviour, with `eth_getCode`.

### Rail: LP provide and withdraw
Uniswap v3, `NonfungiblePositionManager`. Chosen over v4 and over Ref Finance on NEAR because every
argument of `mint`, `increaseLiquidity`, `decreaseLiquidity` and `collect` is a **static** ABI type,
so encoding is fixed 32-byte words with no dynamic offsets. v4 routes everything through
`modifyLiquidities(bytes unlockData, ...)`, a nested dynamic blob. Ref Finance is genuinely live
(2,647 pools) but uses JSON args, storage deposits and `ft_transfer_call`, reusing none of the
existing EVM path.

Positions read back through `balanceOf` + `tokenOfOwnerByIndex` + `positions(tokenId)` and fill
`ledger.positions()`, which is what puts pool positions in the wallet view as ordinary rows.

### Rail: Hyperliquid deposit
A plain ERC-20 transfer of USDC2 to Bridge2 on Arbitrum Sepolia. No permit, no signed payload.

**This rail's failure mode is silent, total loss, so its refusals are the deliverable.** Verified:
the mainnet bridge address has NO CONTRACT on Arbitrum Sepolia, so sending there burns the tokens
to a dead EOA with no recovery, and the documented minimum is 5 USDC below which funds are "lost
forever". `simulate()` must refuse when the bridge does not match the network, when the amount is
under the minimum, when the destination has no bytecode on the target chain, or when the balance is
short. Each has a test.

**Funding is the one thing code cannot solve.** The testnet drip requires a prior *mainnet* deposit
from the same address, and there is no USDC2 faucet at all: `mint` is owner-gated, proven by
`eth_call` reverting with "Ownable: caller is not the owner" from a random EOA. Karim's route,
chosen 2026-08-11: claim the drip with an address he has already deposited from, withdraw USDC2 to
Arbitrum Sepolia, then send it to the app's own fresh address. His mainnet key never enters the app.

### Signing
`src/chain/evm.ts` is the only module that signs or broadcasts. It simulates before sending so a
revert costs nothing and yields the real reason string, and approves only when the allowance is short.

**viem 2.55.13 added**, reversing the near-zero-dependency stance deliberately. keccak256 is not
Node's `sha3-256`: different padding, different digest, wrong addresses and wrong selectors. Two
researchers hit this independently in one session and one wrote a keccak by hand that failed its own
test vector. Hand-rolling the one thing that must never be wrong is a bad trade for a dependency
count. Verified against the canonical vector.

### Pricing on testnet
Testnet tokens have no market price, and the Arbitrum Sepolia pool implies ~167 USDC per WETH, which
is fiction. **Pool price is never a USD source.** Testnet symbols map to their mainnet twin and take
that price, so the wallet's USD column reads in real money while the balances are testnet.

## 9. Remote hygiene

Karim: "the remote has to be free of any private keys, info, or anything, only config and
installable code should be on there."

Current state is already close: 54 tracked files, `state/` and `.env*` gitignored, verified clean
twice on 2026-08-11. What changes:

- `config.json` becomes the committed template. It carries structure and safe defaults only:
  network, port, mode, empty address arrays, candle products. No addresses.
- `config.local.json` (new, gitignored) carries Karim's actual addresses and overrides
  `config.json` key by key. `loadConfig` merges it when present.
- Private keys never touch the repo tree at all. They live in `~/.phosphor/keys.json`, mode 0600,
  outside the working copy, path configurable by `PHOSPHOR_KEYS`. A file inside a git working copy
  is one `git add -f` from being published; a file outside it cannot be.
- New `npm run sweep`: greps every tracked file for key-shaped material (hex runs of 64, base58 runs
  of 87-88, `-----BEGIN`, seed-phrase-shaped word runs, and any address from the local config) and
  exits non-zero on a hit. It runs in CI position: before any push.
- README gains a Testnet setup section explaining how a fresh clone gets running, since "installable
  code" means someone else can install it.

Push happens after `npm run sweep` passes and the tracked-file list is reviewed by eye. Karim
authorised the push on that condition this session.

## 10. Verification

The build is done when all of these hold, each with pasted evidence:

1. `npx tsc --noEmit` clean.
2. `npm test` green, with new cases for: the network resolver, `gateRequired` mainnet forcing, the
   wallet view including natives and LP rows, and each new proposal kind's policy verdict.
3. `npm run e2e` green over a real MCP client.
4. `npm run sweep` exits 0 and the tracked-file list contains no state, keys or addresses.
5. `node ~/.claude/tools/ui-gate.mjs http://127.0.0.1:4177 --src ui` reaches `UI-GATE: PASS`, judged
   against a `.design/brief.md` revised to describe the wallet view, the donut, the collapsible
   panels and the gate-disabled banner.
6. **The three features executed for real on testnet, each with a block explorer link or an exchange
   API response proving it landed.** A passing unit test is not evidence that a swap happened. This
   is the acceptance criterion that matters and the one the whole spec exists to reach.
