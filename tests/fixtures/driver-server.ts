// A real Phosphor server with a fake agent in the driver's seat.
//
// Every test about the in-app driver needs the same thing: an app listening on a loopback port,
// with a working audit log and approval token, whose `Driver` is a spy rather than a Claude Code
// process. Building that inline is 120 lines of config nobody reads, and two copies of it drift.
//
// The driver is INJECTED, which is the property that matters. Nothing here launches a process,
// spends a subscription, or writes to a real state directory. And autostart is opt-in at the dep
// rather than read from config, so a test that forgets to ask for it gets a server that spawns
// nothing, which is what keeps the rest of the suite from launching agents.

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
import type { DriverState } from '../../src/driver.ts';

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

// What the fake agent was asked to do, in order. Assertions read this instead of guessing from
// the audit log, so a test can tell "the route answered 200" apart from "the driver was called".
export type DriverCalls = {
  starts: number;
  sends: string[];
  interrupts: number;
  stops: number;
};

export interface Booted {
  url: string;
  close: () => Promise<void>;
  calls: DriverCalls;
  agents: ReturnType<typeof createAgents>;
  auditLines: () => string[];
  // The per-boot approval token, already fetched. Every POST needs it.
  token: () => Promise<string>;
  // POST /api/driver with the token filled in. Returns status and parsed body together, because
  // a 409 with a message is as much of a result here as a 200.
  driver: (body: Record<string, unknown>) => Promise<{ status: number; body: Record<string, unknown> }>;
}

export type BootOptions = {
  autostart?: boolean;
  // What the fake driver reports. `thinking` is the state an interrupt is meaningful in, so a
  // test that wants one sets it here rather than trying to get the fake into it by other means.
  state?: DriverState;
  // Whether the fake accepts an interrupt. False models a child that has already died.
  interruptible?: boolean;
};

export async function bootDriverServer(opts: BootOptions = {}): Promise<Booted> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-driver-'));
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

  const calls: DriverCalls = { starts: 0, sends: [], interrupts: 0, stops: 0 };
  const state: DriverState = opts.state ?? 'ready';
  const agents = createAgents();

  let cachedToken = '';
  const booted: Booted = {
    url: '',
    close: async () => {},
    calls,
    agents,
    auditLines: () =>
      fs
        .readFileSync(path.join(dataDir, 'audit.jsonl'), 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== ''),
    token: async () => {
      if (cachedToken === '') {
        const res = await fetch(`${booted.url}/api/session`);
        cachedToken = String(((await res.json()) as { token: string }).token);
      }
      return cachedToken;
    },
    driver: async (body) => {
      const res = await fetch(`${booted.url}/api/driver`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: await booted.token(), ...body }),
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    },
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
    agents,
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
      start: () => { calls.starts += 1; },
      send: (text: string) => { calls.sends.push(text); },
      interrupt: () => {
        calls.interrupts += 1;
        return opts.interruptible !== false && state === 'thinking';
      },
      stop: () => { calls.stops += 1; },
      status: () => ({ state, sessionId: 'fake', running: true }),
    }),
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  booted.url = `http://127.0.0.1:${port}`;
  booted.close = () => new Promise<void>((r) => server.close(() => r()));
  return booted;
}
