// Phosphor app entrypoint: wires config, audit, store, policy, ledger, composition,
// cost, candles, quoter, signer, proposals and the HTTP server into one process.
// This is the authoritative state owner. The MCP process (src/mcp.ts) is a thin
// client of the HTTP surface this file boots.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Policy, RiskRow, ViewMode } from './types.ts';
import { readViewMode, writeViewMode } from './view/mode.ts';
import { loadConfig } from './config.ts';
import { createAudit } from './audit.ts';
import { createStore } from './store.ts';
import { loadPolicy, savePolicy, defaultPolicy } from './policy/file.ts';
import { renderSentences } from './policy/render.ts';
import { createRails, venueAllowlist } from './rails/index.ts';
import { createLedger } from './ledger/index.ts';
import { oneClickQuoter, syntheticQuoter, stubSigner, type TokensFile } from './intents.ts';
import { coinbaseSource, cachedCandles } from './candles.ts';
import { hyperliquidSource } from './hyperliquid.ts';
import { createMarketData } from './market/index.ts';
import { createProposalService } from './proposals.ts';
import { createAgents } from './agents.ts';
import { MAINNET_TRADING_LIMITS, TESTNET_TRADING_LIMITS, createRunnerHost } from './runner/host.ts';
import { readApiWalletKey } from './runner/keys.ts';
import { createTradeService } from './trade/service.ts';
import { createInfoClient } from './hl/info.ts';
import { atr } from './analysis/regime.ts';
import { createServer } from './server.ts';
import { sweepOrphans } from './driver.ts';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cfg = loadConfig(root);

const audit = createAudit(cfg.dataDir);
const store = createStore(cfg.dataDir);

/* Anything the last run left behind, before this one can add to it. See the note above
   sweepOrphans in src/driver.ts for why this is safe here and nowhere else: it runs from the
   entrypoint rather than from createServer because every test in this repo builds a server,
   and a sweep that matched this installation's own settings path from inside a test would kill
   a Phosphor agent the developer is actually using. */
const collected = sweepOrphans(root);
if (collected.length > 0) {
  audit.append(
    'app_start',
    `collected ${collected.length} agent process(es) left running by a previous session`,
    { pids: collected },
  );
}

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

// The market data layer: the venue catalogue, the candle cache, and the folding that lets
// any timeframe be asked for. It owns the render path now, which is what took the exchange
// round trip out from in front of the first pixel. See src/market/index.ts.
// Assigned once the server exists, because the server is what has the SSE clients to tell.
// Until then a fill that lands simply has nobody to announce it to, which is correct.
let marketUpdated: () => void = () => {};

const market = createMarketData({
  cachePath: path.join(cfg.dataDir, 'market-catalog.json'),
  onUpdate: () => marketUpdated(),
});

// The catalogue is what makes a symbol beyond the config list reachable. A cold start with
// no network still runs: resolution falls back to the product id as typed.
void market.refreshCatalog().catch((err: unknown) => {
  console.error(`market catalogue unavailable, falling back to literal product ids: ${String(err)}`);
});
const quoter = cfg.mode === 'demo' ? syntheticQuoter() : oneClickQuoter(tokens);
const signer = stubSigner();

// Owns the armed bots and the child process that runs them. Constructed before the rails
// because the mandate rail only starts and stops it and holds no state of its own.
//
// The key it hands the child is the API wallet, never the master. Reading it lazily, at arm
// time rather than at boot, means an install with no agent approved yet starts fine and fails
// with a sentence that says what to do instead of failing at startup.
// Which Hyperliquid the trading half talks to. This used to be two constants pinned to
// testnet, because the version before THAT derived the URLs from cfg.network while the runner
// refused mainnet outright, and that split the app in half: the window read a mainnet account
// holding $0.000002 while the 888 the account actually holds sat on testnet, and the runner
// was handed MAINNET=1 and refused to arm, so a mandate could be written and never fire.
//
// The lesson was never "pin it to testnet". It was that the panel a human reads and the runner
// that trades must not be able to disagree. So there is now ONE value, cfg.tradingNetwork, and
// every consumer takes it from here: these URLs, the runner's isMainnet, the greeting, the
// withdraw rail and the strategy catalog. Disagreement is no longer expressible.
const HL_MAINNET = cfg.tradingNetwork === 'mainnet';
const HL_BASE_URL = HL_MAINNET ? 'https://api.hyperliquid.xyz' : 'https://api.hyperliquid-testnet.xyz';
const HL_WS_URL = HL_MAINNET ? 'wss://api.hyperliquid.xyz/ws' : 'wss://api.hyperliquid-testnet.xyz/ws';

const runner = createRunnerHost({
  apiWalletKey: async () => await readApiWalletKey(cfg.keysPath, cfg.tradingNetwork),
  isMainnet: HL_MAINNET,
  baseUrl: HL_BASE_URL,
  // The ceiling on everything armed at once. Tighter on mainnet, and it is what replaced the
  // runner's blanket mainnet refusal rather than that refusal simply being deleted.
  limits: HL_MAINNET ? MAINNET_TRADING_LIMITS : TESTNET_TRADING_LIMITS,
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

// Who is driving, and the rule that only one thing may. The state, the TTL and the
// one-at-a-time seat live in src/agents.ts; what lives here is the sweep that turns a
// silent expiry into a line in the log and a push to the window.
//
// The heartbeat itself is deliberately absent from the audit log, and the edges stand in
// for it: one agent_connected when an agent attaches, one agent_disconnected when it goes.
// Two lines per session instead of 240 an hour, and the transcript still answers "was an
// agent attached at 19:52".
const agents = createAgents();

// The drop is swept for because a killed MCP process has no request to ride on. mcp.ts does
// send a bye on a clean shutdown, so this is the backstop for a SIGKILL rather than the
// normal path, and it runs often enough that the backstop is still fast: the status bar
// used to hold "connected" for up to a minute after an agent was terminated (45s TTL swept
// every 15s, then up to another 15s waiting for an SSE state frame). Every part of that is
// now shorter, and the push below is what closes the last of it.
const AGENT_SWEEP_MS = 2_000;

function getPolicy(): Policy | null {
  return loadPolicy(cfg.dataDir);
}

// Held in memory and mirrored to disk, so a restart does not silently change what the
// human is looking at. Read once on boot rather than per request: the file is the
// durable copy, this is the live one.
let viewMode: ViewMode = readViewMode(cfg.dataDir);
function getView(): ViewMode {
  return viewMode;
}
function setView(mode: ViewMode): void {
  viewMode = mode;
  writeViewMode(cfg.dataDir, mode);
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
const tradeInfo = createInfoClient({ baseUrl: HL_BASE_URL });

const trade = createTradeService({
  wsUrl: HL_WS_URL,
  user: cfg.addresses.evm[0] ?? '',
  network: cfg.tradingNetwork,
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
  market,
  proposals,
  getPolicy,
  setKill,
  agents,
  getView,
  setView,
  trade,
  /* Default OFF, and the window opens on the turning globe. Karim, 2026-08-20: with no agent
     attached yet, the globe is what the app opens on, always.
     Spawning a Claude Code process because a window opened was the app making a decision on
     the user's behalf, and paying for it: a session nobody had a question for still holds the
     seat and still spends the subscription. The press is cheap and it is the user's. Anyone
     who wants the old behaviour sets `driver.autostart: true` in config.json. */
  autostart: cfg.driver?.autostart === true,
});

setInterval(() => {
  const gone = agents.sweep();
  if (gone === null) return;
  audit.append('agent_disconnected', 'the agent stopped sending heartbeats', {
    client: gone.client,
    lastSeen: gone.lastSeen,
    ttlMs: gone.ttlMs,
  });
  // Without this the light stayed on until the next state frame, whatever the TTL said.
  server.broadcastState();
}, AGENT_SWEEP_MS);

// A background fill that lands is worth exactly one SSE frame: the browser is holding the
// previous candles and needs to be told there are better ones, not polled at.
marketUpdated = () => server.broadcastCandles();

// The feed moving is the only thing that makes the trading surface change without anyone
// touching it, so it is what drives the push. Coalesced by the feed already.
//
// BOTH channels, and the second one is the bug fix. This called broadcastState alone, and the
// trading window does not listen to state: ui/trade.js refetches the position book on
// {type:'trade'} and nothing else. So a fill arriving on the websocket repainted no position,
// no PnL and no health bar. It corrected on the next unrelated 'trade' frame, which in
// practice was the agent's next tool call, which is why the staleness read as "a couple of
// seconds" and was really unbounded: on a quiet agent the book could sit wrong indefinitely.
trade.onUpdate(() => {
  server.broadcastState();
  server.broadcastTrade();
});

server.listen(cfg.port, '127.0.0.1', () => {
  audit.append('app_start', `phosphor up on http://127.0.0.1:${cfg.port} (${cfg.mode} mode)`);
  console.log(`phosphor: http://127.0.0.1:${cfg.port} (${cfg.mode} mode)`);
  // Say where the signing key is read from, every boot. The path only, never a byte of the key.
  // "I don't know where my private key is" should not survive a single startup. `npm run
  // keys:where` prints the same, with permissions, on demand.
  console.log(`phosphor: signing key at ${cfg.keysPath}`);
});

// Ledger refresh loop. Demo mode is static between writes but the refresh also
// re-marks chain staleness in live mode.
//
// The old shape was a bare 30s interval that did not tell anyone it had finished, so a
// balance that changed waited up to 30s to be read and then up to another 15s for the SSE
// heartbeat to mention it: 45s worst case to see money that had already arrived. The read
// now pushes as soon as it lands, and the poll is the floor rather than the mechanism.
const REFRESH_IDLE_MS = 15_000;

// Two refreshes at once would be two sets of RPC calls racing to write the same snapshot,
// and the loser's answer is the older one. A caller arriving mid-flight joins the read
// already running instead of starting a second.
let refreshing: Promise<void> | null = null;

function refreshNow(): Promise<void> {
  if (refreshing !== null) return refreshing;
  refreshing = ledger
    .refresh()
    .then(() => {
      server.broadcastState();
    })
    .catch(() => undefined)
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

void refreshNow();
setInterval(() => {
  void refreshNow();
}, REFRESH_IDLE_MS);

// The moment money actually moves, read it back rather than waiting out the poll. This is
// what makes a deposit or a swap show up as soon as it settles: the rails already announce
// themselves on the audit log, so this needs no new seam and no rail has to remember to
// call it. An intents deposit is exactly the case that used to look broken, because the
// funds leave the wallet immediately and the balance that replaces them is one the app
// only learns about on a refresh.
audit.subscribe(event => {
  if (event.type === 'executed') void refreshNow();
});
