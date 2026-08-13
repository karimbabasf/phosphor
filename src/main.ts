// Phosphor app entrypoint: wires config, audit, store, policy, ledger, composition,
// cost, candles, quoter, signer, proposals and the HTTP server into one process.
// This is the authoritative state owner. The MCP process (src/mcp.ts) is a thin
// client of the HTTP surface this file boots.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Policy, RiskRow } from './types.ts';
import { loadConfig } from './config.ts';
import { createAudit } from './audit.ts';
import { createStore } from './store.ts';
import { loadPolicy, savePolicy, defaultPolicy } from './policy/file.ts';
import { renderSentences } from './policy/render.ts';
import { createRails, venueAllowlist } from './rails/index.ts';
import { createLedger } from './ledger/index.ts';
import { oneClickQuoter, syntheticQuoter, stubSigner, type TokensFile } from './intents.ts';
import { coinbaseSource, krakenSource, cachedCandles } from './candles.ts';
import { hyperliquidSource, hyperliquidLive } from './hyperliquid.ts';
import { createProposalService } from './proposals.ts';
import { createRunnerHost } from './runner/host.ts';
import { readApiWalletKey } from './runner/keys.ts';
import { createTradeService } from './trade/service.ts';
import { createInfoClient } from './hl/info.ts';
import { atr } from './analysis/regime.ts';
import { createServer } from './server.ts';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cfg = loadConfig(root);

const audit = createAudit(cfg.dataDir);
const store = createStore(cfg.dataDir);

// Seed a default policy only when the file is absent. A present-but-corrupt file
// is left in place: loadPolicy returns null and every write refuses (fail closed)
// until a human repairs or deletes it.
//
// The seeded allowlist carries the rail venues. evaluateRail refuses an unlisted
// counterparty outright, never as needs_approval, so without them the rails are not
// gated, they are dead. What the allowlist still governs is size: humanClickAboveUsd
// decides which of these venue calls a human has to click.
//
// An EXISTING policy.json is never rewritten, not even to add a venue. A human may
// have curated it, and an app whose whole claim is that software does not change the
// rules behind your back cannot change the rules behind your back. A missing venue is
// named once in the audit log and left alone.
const venues = venueAllowlist(cfg.network);
if (!fs.existsSync(path.join(cfg.dataDir, 'policy.json'))) {
  const seeded = defaultPolicy();
  seeded.outbound.destinationAllowlist = venues;
  seeded.sentences = renderSentences(seeded); // the human reads the policy actually in force
  savePolicy(cfg.dataDir, seeded);
  audit.append(
    'policy_changed',
    `seeded default policy on first boot, allowing ${venues.length} rail venue(s) on ${cfg.network}`,
    { destinationAllowlist: venues },
  );
} else {
  const existing = loadPolicy(cfg.dataDir);
  const listed = new Set((existing?.outbound.destinationAllowlist ?? []).map(a => a.toLowerCase()));
  const missing = venues.filter(v => !listed.has(v));
  if (existing !== null && missing.length > 0) {
    audit.append(
      'error',
      `policy.json does not allow ${missing.length} rail venue(s), so those rails refuse every proposal until a human adds them: ${missing.join(', ')}`,
      { missing },
    );
  }
}

const riskRows = (JSON.parse(fs.readFileSync(path.join(root, 'data', 'risk-table.json'), 'utf8')) as { rows: RiskRow[] }).rows;
const tokens = JSON.parse(fs.readFileSync(path.join(root, 'data', 'tokens.json'), 'utf8')) as TokensFile;

const ledger = createLedger(cfg);
// Hyperliquid is primary because that is the venue the high-frequency execution
// targets, and a chart that disagrees with the venue is worse than no chart.
// Coinbase stays as the fallback for the minute-and-above rail; Kraken behind it
// is dropped here because cachedCandles takes one fallback and two is enough.
const candles = cachedCandles(hyperliquidSource(), coinbaseSource());
// Sub-minute candles have no REST source anywhere: they are bucketed from the
// Hyperliquid trade stream in-process. See src/hyperliquid.ts.
const live = hyperliquidLive();
const quoter = cfg.mode === 'demo' ? syntheticQuoter() : oneClickQuoter(tokens);
const signer = stubSigner();

// Owns the armed bots and the child process that runs them. Constructed before the rails
// because the mandate rail only starts and stops it and holds no state of its own.
//
// The key it hands the child is the API wallet, never the master. Reading it lazily, at arm
// time rather than at boot, means an install with no agent approved yet starts fine and fails
// with a sentence that says what to do instead of failing at startup.
const runner = createRunnerHost({
  apiWalletKey: async () => await readApiWalletKey(cfg.keysPath),
  isMainnet: cfg.network === 'mainnet',
  baseUrl:
    cfg.network === 'mainnet' ? 'https://api.hyperliquid.xyz' : 'https://api.hyperliquid-testnet.xyz',
  // Fail closed: a policy file that will not load reads as the kill switch being ON, so an
  // unreadable policy can never be the reason a bot was allowed to arm.
  user: cfg.addresses.evm[0] ?? '',
  killSwitch: () => loadPolicy(cfg.dataDir)?.killSwitch ?? true,
  onEvent: (e) => {
    audit.append(
      e.type === 'halted' || e.type === 'error' ? 'error' : 'executed',
      `runner: ${e.type}${'id' in e && e.id !== null ? ` ${e.id}` : ''}` +
        ('reason' in e ? `: ${e.reason}` : 'message' in e ? `: ${e.message}` : ''),
      e,
    );
  },
});

// The dispatch table for swap, hyperliquid deposit and LP add/remove. Empty in demo
// mode, where there is a fixture and no chain, so a rail proposal refuses rather than
// reaching for an RPC and a private key.
const rails = createRails({ cfg, tokens, runner });

const proposals = createProposalService({
  cfg,
  audit,
  store,
  ledger,
  riskRows,
  quoter,
  signer,
  rails,
  dataDir: cfg.dataDir,
});

// Agent connection tracking: mcp.ts sends op:hello every 15s; connected means
// a heartbeat within the last 45s.
let lastHello = 0;
function agentSeen(): void {
  lastHello = Date.now();
}
function agentsConnected(): number {
  return Date.now() - lastHello < 45_000 ? 1 : 0;
}

function getPolicy(): Policy | null {
  return loadPolicy(cfg.dataDir);
}

function setKill(on: boolean): void {
  const p = getPolicy();
  if (p === null) {
    audit.append('error', 'kill toggle ignored: policy file unreadable (writes already refused)');
    return;
  }
  p.killSwitch = on;
  savePolicy(cfg.dataDir, p);
  audit.append('kill_switch', on ? 'kill switch ON: all writes refused' : 'kill switch off');

  // Stop what is already running, not just what tries to start next.
  //
  // The switch used to be consulted only when a mandate armed, so flipping it while a bot held
  // a position refused future proposals and left the bot trading: the one situation a kill
  // switch exists for. Both paths run, because they fail differently. setKilled asks the child
  // to flatten and stop, which is the clean exit and needs the child to be healthy. stopAll
  // does not care whether it is healthy and takes the process out regardless.
  runner.setKilled(on);
  if (on) void runner.stopAll('kill switch');
}

// ATR per coin, refreshed on a slow timer and served from a cache.
//
// The risk panel asks for this while it renders, and rendering must not wait on a network read.
// Volatility on an hourly bar is also not a number that changes meaningfully inside a minute,
// so a cache costs nothing real and a synchronous read is what the caller actually needs.
// Fourteen periods of hourly bars is the standard Wilder window, which is what the chart draws.
const atrCache = new Map<string, number>();

async function refreshAtr(): Promise<void> {
  for (const product of cfg.candleProducts) {
    try {
      const load = await candles.get(product, 3600, 120);
      const series = atr(load.candles, 14);
      const last = series[series.length - 1];
      if (last !== null && last !== undefined && Number.isFinite(last)) {
        atrCache.set(product.split('-')[0].toUpperCase(), last);
      }
    } catch {
      // A market whose candles will not load keeps whatever it had, and the surface reports
      // the distance in the two units that do not need it. Missing is better than stale-wrong.
    }
  }
}

function atrForCoin(coin: string): number | null {
  return atrCache.get(coin.toUpperCase()) ?? null;
}

void refreshAtr();
setInterval(() => void refreshAtr(), 300_000).unref?.();

// The trading surface. Reads over a websocket rather than a poll, because Hyperliquid's own
// rate-limit guidance is that a chatty /info loop blows the weight budget long before orders do,
// and a trading screen refreshing positions, orders, fills, mark and funding is that loop.
//
// The ATR it uses for the liquidation-distance figure comes from the same indicator engine the
// chart draws with, on purpose. Two implementations of volatility would mean the risk panel and
// the candles could disagree about how much a market moves, and the person would have no way to
// tell which one was lying.
const tradeInfo = createInfoClient({
  baseUrl:
    cfg.network === 'mainnet' ? 'https://api.hyperliquid.xyz' : 'https://api.hyperliquid-testnet.xyz',
});

const trade = createTradeService({
  wsUrl: cfg.network === 'mainnet' ? 'wss://api.hyperliquid.xyz/ws' : 'wss://api.hyperliquid-testnet.xyz/ws',
  user: cfg.addresses.evm[0] ?? '',
  info: tradeInfo,
  runner,
  products: cfg.candleProducts,
  atrFor: (coin) => atrForCoin(coin),
  initialSymbol: (cfg.candleProducts[0] ?? 'BTC-USD').split('-')[0],
});

const server = createServer({
  cfg,
  audit,
  store,
  ledger,
  riskRows,
  candles,
  live,
  proposals,
  getPolicy,
  setKill,
  agentSeen,
  agentsConnected,
  trade,
});

// The feed moving is the only thing that makes the trading surface change without anyone
// touching it, so it is what drives the push. Coalesced by the feed already.
trade.onUpdate(() => server.broadcastState());

server.listen(cfg.port, '127.0.0.1', () => {
  audit.append('app_start', `phosphor up on http://127.0.0.1:${cfg.port} (${cfg.mode} mode)`);
  console.log(`phosphor: http://127.0.0.1:${cfg.port} (${cfg.mode} mode)`);
});

// Ledger refresh loop. Demo mode is static between writes but the refresh also
// re-marks chain staleness in live mode; 30s matches the plan.
void ledger.refresh().catch(() => undefined);
setInterval(() => {
  void ledger.refresh().catch(() => undefined);
}, 30_000);
