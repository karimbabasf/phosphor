// The app opens with an agent already attached, which means a Claude Code process is spawned by
// the act of the window opening rather than by anybody deciding to. Three things have to hold
// for that to be safe, and all three are here:
//
//   - it happens on 'listening' and never earlier. The child's MCP proxy POSTs straight back to
//     this port, so a driver started ahead of the socket hands the model an empty tool surface;
//   - it is OPT IN at the dep, not read from config inside the server. Every test in this repo
//     builds a server and listens on it, and a flag that defaulted to on would have each of them
//     spawn a real agent;
//   - it starts exactly one, and the seat is cleared before it rather than after.
//
// The driver itself is injected, so nothing here launches a real process.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { createServer } from '../../src/server.ts';
import { createTradeView } from '../../src/trade/view.ts';
import { createAgents } from '../../src/agents.ts';
import { createAudit } from '../../src/audit.ts';
import { createStore } from '../../src/store.ts';
import { defaultPolicy } from '../../src/policy/file.ts';
import { createMarketData } from '../../src/market/index.ts';
import type { AppConfig, ChainId, ChainStatus, LedgerSnapshot, LpPosition } from '../../src/types.ts';

const CHAINS: ChainId[] = ['eth', 'base', 'arb', 'sol', 'near'];
const FETCHED_AT = '2026-08-20T00:00:00.000Z';

function snapshot(): LedgerSnapshot {
  const status: ChainStatus = { ok: true, fetchedAt: FETCHED_AT };
  return {
    holdings: [],
    chainStatus: Object.fromEntries(CHAINS.map((c) => [c, status])) as Record<ChainId, ChainStatus>,
    mode: 'demo',
    prices: {},
    gas: Object.fromEntries(CHAINS.map((c) => [c, { transferCostUsd: 0.1 }])) as LedgerSnapshot['gas'],
  };
}

interface Booted {
  url: string;
  close: () => Promise<void>;
  starts: number;
  agents: ReturnType<typeof createAgents>;
  auditLines: () => string[];
}

async function boot(opts: { autostart?: boolean } = {}): Promise<Booted> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-autostart-'));
  const cfg: AppConfig = {
    mode: 'demo',
    network: 'testnet',
    approvalGate: true,
    port: 0,
    addresses: { evm: ['0xself'], solana: [], near: [] },
    economicTransferUsd: 10,
    candleProducts: ['BTC-USD'],
    dataDir,
    keysPath: path.join(dataDir, 'keys.json'),
  };
  const booted: Booted = {
    url: '',
    close: async () => {},
    starts: 0,
    agents: createAgents(),
    auditLines: () =>
      fs
        .readFileSync(path.join(dataDir, 'audit.jsonl'), 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== ''),
  };
  const server = createServer({
    cfg,
    audit: createAudit(dataDir),
    store: createStore(dataDir),
    riskRows: [],
    ledger: {
      snapshot,
      positions: (): LpPosition[] => [],
      intents: () => undefined,
      refresh: async () => snapshot(),
      applyDemoTransfer: () => {},
    },
    candles: {
      get: async () => ({ candles: [], stale: false, source: 'test', fetchedAt: FETCHED_AT }),
      spot: async () => 1,
    },
    market: createMarketData({
      fetchImpl: (async () => ({ ok: true, json: async () => [], text: async () => '', headers: new Headers() })) as unknown as typeof fetch,
    }),
    proposals: {
      proposeConsolidate: async () => { throw new Error('unused'); },
      proposePolicyChange: async () => { throw new Error('unused'); },
      proposeSwap: async () => { throw new Error('unused'); },
      proposeHlDeposit: async () => { throw new Error('unused'); },
      proposeIntentsDeposit: async () => { throw new Error('unused'); },
      proposeIntentsWithdraw: async () => { throw new Error('unused'); },
      proposeMandate: async () => { throw new Error('unused'); },
      proposeLpAdd: async () => { throw new Error('unused'); },
      proposeLpRemove: async () => { throw new Error('unused'); },
      approve: async () => { throw new Error('unused'); },
      refuse: async () => { throw new Error('unused'); },
      get: () => undefined,
      list: () => [],
      sessionSpentUsd: () => 0,
    },
    getPolicy: () => defaultPolicy(),
    setKill: () => {},
    agents: booted.agents,
    getView: () => 'pro',
    setView: () => {},
    trade: {
      view: createTradeView('BTC'),
      payload: () => ({}) as never,
      read: () => ({}),
      batch: () => [],
      action: async () => ({ ok: false, detail: 'no venue in this test' }),
      onUpdate: () => {},
      stop: () => {},
    },
    autostart: opts.autostart,
    makeDriver: () => ({
      start: () => { booted.starts += 1; },
      send: () => {},
      stop: () => {},
      status: () => ({ state: 'ready' as const, sessionId: 'fake', running: true }),
    }),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  booted.url = `http://127.0.0.1:${port}`;
  booted.close = () => new Promise<void>((r) => server.close(() => r()));
  return booted;
}

test('the port opening starts the agent, once, when the app asked for it', async () => {
  const b = await boot({ autostart: true });
  try {
    assert.equal(b.starts, 1);
    const app = b.auditLines().filter((l) => l.includes('in-app driver starting at boot'));
    assert.equal(app.length, 1, 'and it says so in the record, in its own words');
  } finally {
    await b.close();
  }
});

test('a server nobody asked to autostart never spawns anything', async () => {
  const b = await boot();
  try {
    assert.equal(b.starts, 0, 'which is what keeps every other test in this repo from launching an agent');
    assert.equal(
      b.auditLines().some((l) => l.includes('in-app driver starting')),
      false,
    );
  } finally {
    await b.close();
  }
});

test('the boot start clears the seat first, and leaves it free for its own child', async () => {
  const b = await boot({ autostart: true });
  try {
    const lines = b.auditLines();
    const start = lines.findIndex((l) => l.includes('in-app driver starting at boot'));
    assert.ok(start >= 0);
    // Nothing held the seat here, so there is no eviction line, and that is the point: the
    // eviction is attempted first and is a no-op when the seat is empty.
    assert.equal(lines.some((l) => l.includes('replaced')), false);
    assert.equal(b.agents.holder(), null, 'the seat is still free for the child to take');
  } finally {
    await b.close();
  }
});
