// Operator driver for the Hyperliquid TESTNET withdrawal path. Not reachable by an agent:
// there is no MCP tool behind any of this, and there is not meant to be. A human runs it.
//
//   node scripts/hl-withdraw.ts summary
//   node scripts/hl-withdraw.ts to-perp  <amount> --yes
//   node scripts/hl-withdraw.ts to-spot  <amount> --yes
//   node scripts/hl-withdraw.ts withdraw <amount> --yes [--to 0x...] [--allow-external]
//
// Both writes are signed API actions, not transactions: no gas, no Arbitrum tx from us. The
// withdrawal takes a 1 USDC fee OUT OF the amount and lands amount - 1 on Arbitrum Sepolia in
// three to five minutes.
//
// --yes is required for every write. Without it the command prints exactly what it would do and
// exits 0 without signing anything, so a half-typed command cannot move money.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.ts';
import { accountSummary, usdClassTransfer, withdraw3, MIN_WITHDRAW_USDC, WITHDRAW_FEE_USDC } from '../src/rails/hyperliquid-withdraw.ts';
import type { HlWithdrawDeps } from '../src/rails/hyperliquid-withdraw.ts';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const argv = process.argv.slice(2);
const command = argv[0] ?? 'summary';
const flag = (name: string): boolean => argv.includes(`--${name}`);
const value = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const cfg = loadConfig(ROOT);
const deps: HlWithdrawDeps = { network: cfg.network, keysPath: cfg.keysPath };

function usage(): never {
  console.error('usage: node scripts/hl-withdraw.ts summary | to-perp <amt> | to-spot <amt> | withdraw <amt> [--to 0x..] [--allow-external] --yes');
  process.exit(2);
}

function amountArg(): number {
  const raw = argv[1];
  const n = Number(raw);
  if (raw === undefined || !Number.isFinite(n)) {
    console.error(`amount ${JSON.stringify(raw ?? '')} is not a number`);
    process.exit(2);
  }
  return n;
}

async function printSummary(): Promise<void> {
  const s = await accountSummary(deps);
  console.log(`network            ${s.network}`);
  console.log(`address            ${s.address}`);
  console.log(`spot USDC          ${s.spotUsdc}`);
  console.log(`perp withdrawable  ${s.perpWithdrawableUsd}`);
  console.log(`perp accountValue  ${s.perpAccountValueUsd}`);
  console.log(`margin used        ${s.marginUsedUsd}`);
  console.log(`open positions     ${s.openPositions}`);
  console.log(`read at            ${s.fetchedAt}`);
}

// The network guard lives in the module and throws, so a mainnet config never reaches a signer.
// Repeating the check here only buys a friendlier message before the read.
if (cfg.network !== 'testnet' && command !== 'summary') {
  console.error(`REFUSED: config.network is ${cfg.network}. This script is testnet only.`);
  process.exit(1);
}

switch (command) {
  case 'summary': {
    await printSummary();
    break;
  }

  case 'to-perp':
  case 'to-spot': {
    const amount = amountArg();
    const toPerp = command === 'to-perp';
    console.log(`about to move ${amount} USDC ${toPerp ? 'spot -> perp' : 'perp -> spot'} on Hyperliquid ${cfg.network}`);
    if (!flag('yes')) {
      console.log('dry run: pass --yes to sign and send.');
      break;
    }
    const out = await usdClassTransfer(deps, { amount, toPerp });
    console.log(out.ok ? `OK  ${out.detail}` : `FAIL ${out.detail}`);
    if (out.ok) {
      console.log('\nbalances after:');
      await printSummary();
    }
    process.exit(out.ok ? 0 : 1);
  }

  case 'withdraw': {
    const amount = amountArg();
    const destination = value('to');
    const own = (await accountSummary(deps)).address;
    console.log(`about to withdraw ${amount} USDC from Hyperliquid ${cfg.network}`);
    console.log(`  destination      ${destination ?? own}${destination === undefined ? ' (this app own address)' : ''}`);
    console.log(`  fee              ${WITHDRAW_FEE_USDC} USDC, taken out of the amount (minimum ${MIN_WITHDRAW_USDC})`);
    console.log(`  lands            ${(amount - WITHDRAW_FEE_USDC).toFixed(6)} USDC2 on Arbitrum Sepolia in 3 to 5 minutes`);
    if (!flag('yes')) {
      console.log('dry run: pass --yes to sign and send.');
      break;
    }
    const out = await withdraw3(deps, { amount, destination, allowExternalDestination: flag('allow-external') });
    console.log(out.ok ? `OK  ${out.detail}` : `FAIL ${out.detail}`);
    if (out.ok) {
      console.log('\nbalances after (the payout is not instant, so perp drops now and Arbitrum lands later):');
      await printSummary();
    }
    process.exit(out.ok ? 0 : 1);
  }

  default:
    usage();
}
