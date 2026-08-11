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
import { createLedger } from './ledger/index.ts';
import { oneClickQuoter, syntheticQuoter, stubSigner, type TokensFile } from './intents.ts';
import { coinbaseSource, krakenSource, cachedCandles } from './candles.ts';
import { createProposalService } from './proposals.ts';
import { createServer } from './server.ts';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cfg = loadConfig(root);

const audit = createAudit(cfg.dataDir);
const store = createStore(cfg.dataDir);

// Seed a default policy only when the file is absent. A present-but-corrupt file
// is left in place: loadPolicy returns null and every write refuses (fail closed)
// until a human repairs or deletes it.
if (!fs.existsSync(path.join(cfg.dataDir, 'policy.json'))) {
  savePolicy(cfg.dataDir, defaultPolicy());
  audit.append('policy_changed', 'seeded default policy on first boot');
}

const riskRows = (JSON.parse(fs.readFileSync(path.join(root, 'data', 'risk-table.json'), 'utf8')) as { rows: RiskRow[] }).rows;
const tokens = JSON.parse(fs.readFileSync(path.join(root, 'data', 'tokens.json'), 'utf8')) as TokensFile;

const ledger = createLedger(cfg);
const candles = cachedCandles(coinbaseSource(), krakenSource());
const quoter = cfg.mode === 'demo' ? syntheticQuoter() : oneClickQuoter(tokens);
const signer = stubSigner();

const proposals = createProposalService({
  cfg,
  audit,
  store,
  ledger,
  riskRows,
  quoter,
  signer,
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
}

const server = createServer({
  cfg,
  audit,
  store,
  ledger,
  riskRows,
  candles,
  proposals,
  getPolicy,
  setKill,
  agentSeen,
  agentsConnected,
});

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
