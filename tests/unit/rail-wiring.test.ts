// The rails wired into the proposal service: propose -> engine verdict -> approve -> execute.
//
// Two properties carry the weight here, and both are failure modes that would be invisible
// in production:
//
//   1. The loop actually closes. A rail can be perfect and still never run, because the
//      proposal service is the only thing that calls it. Every test that reaches execution
//      asserts on a spy rail, so no test needs a key, an RPC or a testnet coin.
//
//   2. The venue allowlist is seeded. evaluateRail refuses an unlisted counterparty
//      OUTRIGHT (rule 'destination_not_allowed'), never as needs_approval, so a policy that
//      does not name the venue does not make the rails cautious, it makes them dead. That
//      is the silent-failure test at the bottom of this file.
//
// Run: node --test tests/unit/rail-wiring.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  AppConfig,
  HlDepositDraft,
  LedgerSnapshot,
  LpPosition,
  LpRemoveDraft,
  Policy,
  Rail,
  RailResult,
  RiskRow,
  SimulationResult,
  SwapDraft,
  WriteDraft,
} from '../../src/types.ts';
import type { Ledger } from '../../src/ledger/index.ts';
import type { RailRegistry } from '../../src/rails/index.ts';
import { createAudit } from '../../src/audit.ts';
import { createStore } from '../../src/store.ts';
import { loadDemoLedger } from '../../src/ledger/demo.ts';
import { defaultPolicy, savePolicy } from '../../src/policy/file.ts';
import { renderSentences } from '../../src/policy/render.ts';
import { syntheticQuoter, stubSigner } from '../../src/intents.ts';
import { createProposalService } from '../../src/proposals.ts';
import { createRails, venueAllowlist } from '../../src/rails/index.ts';
import { chainsWithDeployment, deploymentFor } from '../../src/rails/uniswap-abi.ts';
import { hlSpec } from '../../src/rails/hyperliquid-deposit.ts';
import { ONECLICK_COUNTERPARTY } from '../../src/rails/oneclick.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(path.dirname(__dirname));
const riskRows = (JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'risk-table.json'), 'utf8')) as { rows: RiskRow[] }).rows;

const SELF_EVM = '0x1111111111111111111111111111111111111111';
const ARB = deploymentFor('testnet', 'arb');

// A position the wallet already holds, so lp_remove has something to resolve against.
// Priced off the demo fixture: USDC at 1.00 and ETH at 4,520.
const POSITION: LpPosition = {
  chain: 'arb',
  venue: 'uniswap-v3',
  poolId: '0x66eeab70ac52459dd74c6ad50d578ef76a441bbf',
  positionId: '4242',
  token0: { symbol: 'USDC', tokenId: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d', amount: 100 },
  token1: { symbol: 'WETH', tokenId: '0x980B62Da83eFf3D4576C647993b0c1D7faf17c73', amount: 0.05 },
  feeTier: 3000,
  inRange: true,
  uncollectedFeesUsd: 1.5,
};
const POSITION_USD = 100 + 0.05 * 4520 + 1.5;

// ---------- harness ----------

// The spy every execution test asserts on. It records what it was handed and never touches
// a network or a key, which is the whole point: this suite proves the wiring, and the rails
// themselves are proven in their own files.
type Spy = {
  registry: RailRegistry;
  simulated: WriteDraft[];
  executed: WriteDraft[];
};

function spyRails(over: { simulation?: SimulationResult; result?: RailResult } = {}): Spy {
  const simulated: WriteDraft[] = [];
  const executed: WriteDraft[] = [];
  const simulation: SimulationResult = over.simulation ?? { ok: true, summary: 'spy rail: nothing was actually simulated' };
  const result: RailResult = over.result ?? { ok: true, detail: 'spy rail: nothing was actually sent', txids: ['0xspy'] };

  const rail = (kind: WriteDraft['kind']): Rail => ({
    kind,
    valueUsd: () => 0,
    async simulate(draft) {
      simulated.push(draft);
      return simulation;
    },
    async execute(draft) {
      executed.push(draft);
      return result;
    },
  });

  const table: Record<string, Rail> = {
    swap: rail('swap'),
    hl_deposit: rail('hl_deposit'),
    lp_add: rail('lp_add'),
    lp_remove: rail('lp_remove'),
  };

  return {
    simulated,
    executed,
    registry: {
      for: (draft) => table[draft.kind] ?? null,
      kinds: () => ['swap', 'hl_deposit', 'lp_add', 'lp_remove'],
    },
  };
}

// The default policy plus the venue addresses main.ts seeds on first boot. Without the
// second line every rail test below would refuse, which is exactly the bug this file exists
// to catch, so it is spelled out here rather than hidden in a fixture.
function seededPolicy(): Policy {
  const p = defaultPolicy();
  p.outbound.destinationAllowlist = venueAllowlist('testnet');
  p.sentences = renderSentences(p);
  return p;
}

type Harness = {
  dataDir: string;
  svc: ReturnType<typeof createProposalService>;
  rails: Spy;
  eventTypes(): string[];
};

function setup(over: { policy?: Policy; rails?: Spy; positions?: LpPosition[] } = {}): Harness {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-rail-wiring-'));
  const cfg: AppConfig = {
    mode: 'live', // demo mode owns no rails at all; that is its own test below
    network: 'testnet',
    approvalGate: true,
    port: 4177,
    addresses: { evm: [SELF_EVM], solana: [], near: [] },
    economicTransferUsd: 10,
    candleProducts: [],
    dataDir,
    keysPath: '/tmp/phosphor-rail-wiring-keys.json', // never read: the spy rail signs nothing
  };

  // A live-mode ledger over the demo fixture, so addresses and prices resolve without RPCs.
  const snapshot: LedgerSnapshot = { ...loadDemoLedger(), mode: 'live' };
  const positions = over.positions ?? [POSITION];
  const ledger: Ledger = {
    snapshot: () => snapshot,
    positions: () => positions,
    refresh: async () => snapshot,
    applyDemoTransfer: () => {
      throw new Error('applyDemoTransfer must never be called in live mode');
    },
  };

  savePolicy(dataDir, over.policy ?? seededPolicy());
  const audit = createAudit(dataDir);
  const rails = over.rails ?? spyRails();

  const svc = createProposalService({
    cfg,
    audit,
    store: createStore(dataDir),
    ledger,
    riskRows,
    quoter: syntheticQuoter(),
    signer: stubSigner(),
    rails: rails.registry,
    dataDir,
  });

  return {
    dataDir,
    svc,
    rails,
    eventTypes: () => audit.tail(200).map(e => e.type).reverse(), // oldest first
  };
}

function swapParams(amountIn: number) {
  return { venue: 'uniswap-v3' as const, chain: 'arb' as const, fromSymbol: 'USDT', toSymbol: 'USDC', amountIn, minAmountOut: amountIn * 0.99 };
}

// ---------- the allowlist ----------

test('venueAllowlist names every contract the rails can hand funds to, and only for this network', () => {
  const testnet = venueAllowlist('testnet');

  for (const chain of chainsWithDeployment('testnet')) {
    const dep = deploymentFor('testnet', chain);
    assert.ok(testnet.includes(dep.router.toLowerCase()), `${chain} router is missing`);
    assert.ok(testnet.includes(dep.positionManager.toLowerCase()), `${chain} position manager is missing`);
  }
  assert.ok(testnet.includes(hlSpec('testnet').bridge.toLowerCase()), 'the hyperliquid bridge is missing');
  assert.ok(testnet.includes(ONECLICK_COUNTERPARTY), 'the oneclick venue is missing');
  assert.ok(testnet.every(a => a === a.toLowerCase()), 'the engine lowercases the list it compares against');

  // The mainnet bridge on a testnet build is the one mistake in this app that is not
  // recoverable: that address holds no contract on Arbitrum Sepolia.
  assert.ok(!testnet.includes(hlSpec('mainnet').bridge.toLowerCase()), 'a testnet allowlist names the mainnet bridge');
  assert.ok(!venueAllowlist('mainnet').includes(hlSpec('testnet').bridge.toLowerCase()));
});

test('every rail draft the service builds names a counterparty the seeded allowlist covers', async () => {
  const allowed = new Set(venueAllowlist('testnet'));
  const h = setup();

  const swap = await h.svc.proposeSwap(swapParams(50));
  const deposit = await h.svc.proposeHlDeposit({ amount: 50 });
  const add = await h.svc.proposeLpAdd({
    chain: 'arb',
    token0Symbol: 'USDC',
    token1Symbol: 'WETH',
    amount0: 10,
    amount1: 0.001,
    feeTier: 3000,
    tickLower: -60,
    tickUpper: 60,
  });
  const remove = await h.svc.proposeLpRemove({ positionId: POSITION.positionId, liquidityPct: 0.5 });

  for (const p of [swap, deposit, add, remove]) {
    const draft = p.draft as { counterparty?: string; bridge?: string };
    const counterparty = (draft.counterparty ?? draft.bridge ?? '').toLowerCase();
    assert.ok(allowed.has(counterparty), `${p.kind} points at ${counterparty}, which the seeded policy does not allow`);
    assert.notEqual(p.status, 'policy_refused', `${p.kind} was refused: ${JSON.stringify(p.verdict)}`);
  }
});

// ---------- the loop ----------

test('a swap above the click threshold parks pending, then executes through the rail on a human approval', async () => {
  const h = setup();

  const p = await h.svc.proposeSwap(swapParams(500));
  assert.equal(p.verdict.outcome, 'needs_approval');
  assert.equal(p.status, 'pending');
  assert.equal(p.simulation?.ok, true, 'the rail was simulated before anyone was asked to approve');
  assert.equal(h.rails.simulated.length, 1);
  assert.equal(h.rails.executed.length, 0, 'nothing runs while a proposal is pending');

  const done = await h.svc.approve(p.id);
  assert.equal(done.status, 'executed');
  assert.equal(done.decidedBy, 'human');
  assert.equal(done.result?.ok, true);
  assert.match(done.result?.detail ?? '', /spy rail/);

  assert.equal(h.rails.executed.length, 1, 'approval reached the rail exactly once');
  assert.deepEqual(h.rails.executed[0], p.draft, 'the rail ran the draft the human approved, not another one');

  const types = h.eventTypes();
  assert.ok(types.indexOf('approved') < types.indexOf('executed'), 'the approval is logged before the execution');
});

test('a swap below the click threshold is the policy own decision and executes with no pending state', async () => {
  const h = setup();

  const p = await h.svc.proposeSwap(swapParams(50));
  assert.equal(p.verdict.outcome, 'allow');
  assert.equal(p.status, 'executed');
  assert.equal(p.decidedBy, 'policy');
  assert.equal(h.rails.executed.length, 1);

  // A rail that executed has to count against the session budget, or the session cap is
  // unenforceable for exactly the drafts that move funds fastest.
  assert.ok(Math.abs(h.svc.sessionSpentUsd() - 50) < 1e-9, `sessionSpentUsd is ${h.svc.sessionSpentUsd()}`);
});

test('each rail kind reaches its own rail with the draft the service built', async () => {
  const h = setup();

  await h.svc.proposeSwap(swapParams(50));
  await h.svc.proposeHlDeposit({ amount: 40 });
  await h.svc.proposeLpRemove({ positionId: POSITION.positionId, liquidityPct: 0.1 });

  assert.deepEqual(
    h.rails.executed.map(d => d.kind),
    ['swap', 'hl_deposit', 'lp_remove'],
  );
});

// ---------- what the agent may not name ----------

test('the app resolves every address in a rail draft, so the agent names none of them', async () => {
  const h = setup();

  const swap = (await h.svc.proposeSwap(swapParams(500))).draft as SwapDraft;
  assert.equal(swap.from, SELF_EVM);
  assert.equal(swap.to, SELF_EVM, 'a swap returns to our own wallet');
  assert.equal(swap.counterparty, ARB.router, 'the counterparty is the verified router, not a parameter');
  assert.equal(swap.amountUsd, 500, 'the app prices the draft; the agent cannot declare a smaller number');

  const deposit = (await h.svc.proposeHlDeposit({ amount: 40 })).draft as HlDepositDraft;
  assert.equal(deposit.bridge, hlSpec('testnet').bridge);
  assert.equal(deposit.chain, 'arb');
  assert.equal(deposit.from, SELF_EVM);

  const remove = (await h.svc.proposeLpRemove({ positionId: POSITION.positionId, liquidityPct: 0.5 })).draft as LpRemoveDraft;
  assert.equal(remove.counterparty, ARB.positionManager);
  assert.equal(remove.chain, POSITION.chain, 'the chain comes from the position in the wallet');
  assert.ok(Math.abs(remove.amountUsd - POSITION_USD * 0.5) < 1e-9);
});

test('a position id the wallet does not hold cannot be turned into a draft', async () => {
  const h = setup();
  const p = await h.svc.proposeLpRemove({ positionId: '999999', liquidityPct: 1 });

  assert.equal(p.status, 'policy_refused');
  assert.equal(p.verdict.outcome === 'refuse' ? p.verdict.rule : '', 'invalid_draft');
  assert.equal(h.rails.simulated.length, 0, 'a draft that could not be built never reached a rail');
  assert.equal(h.rails.executed.length, 0);
});

test('a symbol the app cannot price is refused rather than budgeted at NaN', async () => {
  const h = setup();
  // ZZZ is in no risk table, no holding and no price table, so there is no honest USD value
  // for it. A NaN amountUsd would pass every cap comparison in the engine.
  const p = await h.svc.proposeSwap({ ...swapParams(500), fromSymbol: 'ZZZ' });

  assert.equal(p.status, 'policy_refused');
  assert.equal(p.verdict.outcome === 'refuse' ? p.verdict.rule : '', 'invalid_amount');
  assert.equal(h.rails.executed.length, 0);
});

// ---------- fail closed ----------

test('a rail whose counterparty is not on the allowlist is refused outright, never queued for a click', async () => {
  // The shipped default policy has an EMPTY allowlist. This is the exact state of an app
  // whose policy.json predates the rails, and the failure it produces is silent: every rail
  // refuses, and nothing about the refusal looks like a configuration problem unless the
  // rule name is read.
  const h = setup({ policy: defaultPolicy() });

  const swap = await h.svc.proposeSwap(swapParams(500));
  const deposit = await h.svc.proposeHlDeposit({ amount: 50 });
  const add = await h.svc.proposeLpAdd({
    chain: 'arb',
    token0Symbol: 'USDC',
    token1Symbol: 'WETH',
    amount0: 10,
    amount1: 0.001,
    feeTier: 3000,
    tickLower: -60,
    tickUpper: 60,
  });
  const remove = await h.svc.proposeLpRemove({ positionId: POSITION.positionId, liquidityPct: 0.5 });

  for (const p of [swap, deposit, add, remove]) {
    assert.equal(p.status, 'policy_refused', `${p.kind} was not refused`);
    assert.equal(p.verdict.outcome === 'refuse' ? p.verdict.rule : '', 'destination_not_allowed', `${p.kind} refused for the wrong reason`);
  }

  assert.ok(swap.verdict.reasons.join(' ').includes(ARB.router), 'the refusal names the venue it refused');
  assert.equal(h.rails.simulated.length, 0, 'a refused draft costs no network round trips');
  assert.equal(h.rails.executed.length, 0, 'nothing executed');
});

test('a failed simulation refuses instead of asking a human to approve it', async () => {
  const h = setup({
    rails: spyRails({ simulation: { ok: false, summary: 'REFUSED: wallet is short', error: 'insufficient balance' } }),
  });

  const p = await h.svc.proposeSwap(swapParams(50)); // small enough that the engine would allow it
  assert.equal(p.status, 'policy_refused');
  assert.equal(p.verdict.outcome === 'refuse' ? p.verdict.rule : '', 'simulation_required');
  assert.ok(p.verdict.reasons.join(' ').includes('insufficient balance'), 'the rail own words survive into the refusal');
  assert.equal(h.rails.executed.length, 0, 'nothing is signed off a failed simulation');
});

test('a rail that fails at execution lands failed, not executed', async () => {
  const h = setup({ rails: spyRails({ result: { ok: false, detail: 'transaction reverted on chain' } }) });

  const p = await h.svc.proposeSwap(swapParams(50));
  assert.equal(p.status, 'failed');
  assert.equal(p.result?.ok, false);
  assert.match(p.result?.detail ?? '', /reverted/);
  assert.ok(h.eventTypes().includes('execution_failed'));
  assert.ok(!h.eventTypes().includes('executed'));
  assert.equal(h.svc.sessionSpentUsd(), 0, 'a failed rail spends nothing');
});

test('the kill switch stops a rail proposal that was already pending', async () => {
  const h = setup();
  const p = await h.svc.proposeSwap(swapParams(500));
  assert.equal(p.status, 'pending');

  const killed = seededPolicy();
  killed.killSwitch = true;
  savePolicy(h.dataDir, killed);

  const after = await h.svc.approve(p.id);
  assert.equal(after.status, 'policy_refused');
  assert.equal(after.verdict.outcome === 'refuse' ? after.verdict.rule : '', 'kill_switch');
  assert.equal(h.rails.executed.length, 0);
});

// ---------- the registry ----------

function cfgFor(mode: AppConfig['mode']): AppConfig {
  return {
    mode,
    network: 'testnet',
    approvalGate: true,
    port: 4177,
    addresses: { evm: [SELF_EVM], solana: [], near: [] },
    economicTransferUsd: 10,
    candleProducts: [],
    dataDir: '/tmp/phosphor-rail-wiring-cfg',
    keysPath: '/tmp/phosphor-rail-wiring-keys.json',
  };
}

// The mandate rail only starts and stops the runner, so a stub is enough here: this file is
// about which rails the registry holds and what they refuse, not about arming anything.
const stubRunner = {
  arm: async () => ({ ok: true, detail: 'stub' }),
  disarm: async () => ({ ok: true, detail: 'stub' }),
  status: () => ({ armed: [], running: false }),
};

test('the live registry holds every rail kind and nothing else', () => {
  const tokens = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'tokens.json'), 'utf8'));
  const registry = createRails({ cfg: cfgFor('live'), tokens, runner: stubRunner });

  assert.deepEqual(registry.kinds().sort(), ['hl_deposit', 'lp_add', 'lp_remove', 'mandate_arm', 'swap']);
  for (const kind of registry.kinds()) {
    const rail = registry.for({ kind } as WriteDraft);
    assert.ok(rail !== null, `no rail for ${kind}`);
    assert.equal(rail.kind, kind);
  }
  // The kinds that ride their own path must not be claimed by a rail.
  for (const kind of ['consolidate', 'transfer', 'policy_change'] as const) {
    assert.equal(registry.for({ kind } as WriteDraft), null, `${kind} was claimed by a rail`);
  }

  // One kind, two venues: 'swap' has to route on the draft, not on the kind alone.
  const swapRail = registry.for({ kind: 'swap' } as WriteDraft);
  assert.ok(swapRail !== null);
  assert.equal(swapRail.kind, 'swap');
});

test('demo mode owns no rails, and a rail proposal there refuses instead of reaching for a key', async () => {
  const tokens = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'tokens.json'), 'utf8'));
  const registry = createRails({ cfg: cfgFor('demo'), tokens, runner: stubRunner });
  assert.deepEqual(registry.kinds(), []);
  assert.equal(registry.for({ kind: 'swap' } as WriteDraft), null);

  // The proposal service default is the same shape: no registry means no rail can execute.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-rail-norails-'));
  savePolicy(dataDir, seededPolicy());
  const snapshot: LedgerSnapshot = { ...loadDemoLedger(), mode: 'live' };
  const svc = createProposalService({
    cfg: { ...cfgFor('live'), dataDir },
    audit: createAudit(dataDir),
    store: createStore(dataDir),
    ledger: {
      snapshot: () => snapshot,
      positions: () => [],
      refresh: async () => snapshot,
      applyDemoTransfer: () => {},
    },
    riskRows,
    quoter: syntheticQuoter(),
    signer: stubSigner(),
    dataDir, // no rails passed
  });

  const p = await svc.proposeSwap(swapParams(50));
  assert.equal(p.status, 'policy_refused');
  assert.equal(p.verdict.outcome === 'refuse' ? p.verdict.rule : '', 'no_rail');
  fs.rmSync(dataDir, { recursive: true, force: true });
});
