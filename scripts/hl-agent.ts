// Approve an API wallet so the runner can trade, and write its key to the keys file.
//
// This is the one step that has to be taken by a human at a terminal, and it is deliberately
// not reachable from the app, not a rail, and not an MCP tool. Same precedent as
// scripts/hl-withdraw.ts: some things are exported as plain functions driven from scripts/
// rather than given a surface an agent can call.
//
// The reason is the venue's own signing split. ApproveAgent is a USER-SIGNED action, so it
// needs the master key, which is what makes the following true: an agent, or a compromised
// runner holding an API wallet, can never mint itself more authority. It can trade with the
// key it was given and it cannot create another one.
//
// What the resulting key can and cannot do, enforced by Hyperliquid and not by our code:
//   CAN     place, cancel and modify orders, and set leverage
//   CANNOT  withdraw, transfer USDC or spot assets, move between perp and spot, or approve
//           another agent, because those resolve the account from the signature itself
//
// Run: node scripts/hl-agent.ts [--name phosphor-runner]
//
// Never reuses an address. The venue prunes a deregistered agent's nonce state, and a reused
// address can then have previously signed actions replayed against it, so every run generates
// a fresh key and the old one is simply abandoned.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { loadConfig } from '../src/config.ts';
import { liveSignPort, SIGNATURE_CHAIN_ID, SIGNATURE_CHAIN_ID_HEX } from '../src/rails/hyperliquid-withdraw.ts';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cfg = loadConfig(root);

// Follows cfg.tradingNetwork like every other trading consumer, so an approved agent wallet
// always belongs to the account the runner is about to trade. Approving on the wrong network
// is a silent failure: the arm succeeds, the first order is rejected as unauthorised, and the
// reason is two layers away from where a human is looking.
const HL_MAINNET = cfg.tradingNetwork === 'mainnet';
const API = HL_MAINNET ? 'https://api.hyperliquid.xyz' : 'https://api.hyperliquid-testnet.xyz';
console.error(`approving an agent wallet on Hyperliquid ${cfg.tradingNetwork} (${API})`);

const nameArg = process.argv.indexOf('--name');
const agentName = nameArg > -1 ? String(process.argv[nameArg + 1]) : 'phosphor-runner';

const agentKey = generatePrivateKey();
const agentAddress = privateKeyToAccount(agentKey).address;
const nonce = Date.now();

// The user-signed scheme: real EIP-712 over the action's own fields, domain
// HyperliquidSignTransaction, with the REAL chain id. Not the msgpack phantom-agent scheme the
// runner uses for orders. Getting these two the wrong way round is the documented failure.
const action = {
  type: 'approveAgent',
  hyperliquidChain: HL_MAINNET ? 'Mainnet' : 'Testnet',
  signatureChainId: SIGNATURE_CHAIN_ID_HEX,
  agentAddress: agentAddress.toLowerCase(),
  agentName,
  nonce,
};

const typed = {
  domain: {
    name: 'HyperliquidSignTransaction',
    version: '1',
    chainId: SIGNATURE_CHAIN_ID,
    verifyingContract: '0x0000000000000000000000000000000000000000',
  },
  types: {
    'HyperliquidTransaction:ApproveAgent': [
      { name: 'hyperliquidChain', type: 'string' },
      { name: 'agentAddress', type: 'address' },
      { name: 'agentName', type: 'string' },
      { name: 'nonce', type: 'uint64' },
    ],
  },
  primaryType: 'HyperliquidTransaction:ApproveAgent',
  message: {
    hyperliquidChain: HL_MAINNET ? 'Mainnet' : 'Testnet',
    agentAddress: agentAddress.toLowerCase(),
    agentName,
    nonce: BigInt(nonce),
  },
};

const master = liveSignPort.address(cfg.keysPath);
console.log(`master account : ${master}`);
console.log(`new agent      : ${agentAddress}  (name: ${agentName})`);
console.log(`approving on ${HL_MAINNET ? 'MAINNET' : 'testnet'}...`);

const signature = await liveSignPort.signTypedData(cfg.keysPath, typed as never);

const res = await fetch(`${API}/exchange`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ action, nonce, signature }),
});
const body = (await res.json()) as { status?: string; response?: unknown };

if (body.status !== 'ok') {
  console.error('approval refused by the venue:', JSON.stringify(body));
  console.error('the key was NOT written. Common cause: the master account has never deposited,');
  console.error('and an account with no funds cannot register an agent.');
  process.exit(1);
}

// Written only after the venue accepted, so the file never claims an agent that does not exist.
//
// Atomically, because this file also holds the MASTER key. A plain write truncates before it
// fills, so a crash or a full disk part way through would leave keys.json empty and the master
// key gone with it: losing the funds without anyone attacking anything. Same tmp-then-rename
// shape src/policy/file.ts already uses, and rename is atomic within a filesystem.
//
// The mode is set on the temp file and then asserted on the target. Passing `mode` to a write
// of an EXISTING file is a no-op, so the 0600 this file already carries would have been
// inherited rather than enforced, and inherited is not a guarantee.
const keys = JSON.parse(fs.readFileSync(cfg.keysPath, 'utf8')) as Record<string, unknown>;

// Written under the NETWORK it was approved on, never over the other one.
//
// An agent wallet is approved by a signed action sent to one exchange, and the other network
// has never heard of the address. A single slot meant approving on mainnet destroyed the
// testnet agent, and pointing the app back at testnet then signed every order with a wallet
// that venue does not recognise: rejected, with nothing saying why, because the key is present
// and well formed and simply belongs somewhere else. That happened here on 2026-08-20.
const agents = (keys.hyperliquidAgents ?? {}) as Record<string, unknown>;
agents[cfg.tradingNetwork] = {
  address: agentAddress,
  privateKey: agentKey,
  name: agentName,
  approvedAt: new Date().toISOString(),
};
keys.hyperliquidAgents = agents;
// The pre-2026-08-20 flat field is left exactly as it was. src/runner/keys.ts still reads it as
// a fallback, so an install that has not re-approved keeps working, and removing it here would
// take away a key this script did not create.

const tmpPath = `${cfg.keysPath}.${process.pid}.tmp`;
fs.writeFileSync(tmpPath, JSON.stringify(keys, null, 2) + '\n', { mode: 0o600 });
fs.renameSync(tmpPath, cfg.keysPath);
fs.chmodSync(cfg.keysPath, 0o600);

console.log(`approved. key written to ${cfg.keysPath} under hyperliquidAgents.${cfg.tradingNetwork}.`);
console.log('this key can trade and cannot withdraw. the runner will pick it up on the next arm.');
