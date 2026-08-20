// Live proof for the yield rails. Nothing here is mocked.
//
// The claim being tested is not "the tests pass". It is that money left the wallet, sat in a
// lending pool, GREW, and came back. So this script drives the real proposal service against
// the real Arbitrum Sepolia chain, prints transaction hashes anyone can open on an explorer,
// and reads the position twice with real time in between.
//
// It goes through createProposalService rather than calling the rail directly, on purpose:
// the thing worth proving is the whole path, which includes the policy engine budgeting the
// draft and the audit log recording it. A script that called the rail would prove Aave works,
// which nobody doubted.
//
// Usage:
//   node scripts/yield-prove.ts deposit <amount>   supply that many USDC
//   node scripts/yield-prove.ts read               read the position and the realized figure
//   node scripts/yield-prove.ts withdraw           take the whole position back out
//   node scripts/yield-prove.ts fund <weth>        swap WETH into USDC through the swap rail
//
// It refuses to run on mainnet. The rail refuses too; this is the belt to that pair of braces.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.ts';
import { createAudit } from '../src/audit.ts';
import { createStore } from '../src/store.ts';
import { createLedger } from '../src/ledger/index.ts';
import { createRails } from '../src/rails/index.ts';
import { createProposalService } from '../src/proposals.ts';
import { oneClickQuoter, stubSigner } from '../src/intents.ts';
import { evmAddress, chainSpec } from '../src/chain/evm.ts';
import { aaveAsset, aavePosition, aaveRate } from '../src/yield/aave.ts';
import { fromBaseUnits } from '../src/yield/venue.ts';
import { creditsFor, openedAtFrom, principalFrom, realizedFrom } from '../src/yield/positions.ts';
import type { MandateRunner } from '../src/rails/mandate.ts';
import type { Proposal, RiskRow } from '../src/types.ts';
import type { TokensFile } from '../src/intents.ts';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHAIN = 'arb' as const;
const SYMBOL = 'USDC';

const cfg = loadConfig(ROOT);
if (cfg.network !== 'testnet') {
  console.error(`REFUSED: config says network=${cfg.network}. This script is testnet only.`);
  process.exit(1);
}

const riskRows = (JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'risk-table.json'), 'utf8')) as { rows: RiskRow[] }).rows;
const tokens = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'tokens.json'), 'utf8')) as TokensFile;

// The mandate rail wants a runner. Nothing in this script arms a bot, so a stub that refuses
// is both correct and safer than wiring the real child process in.
const stubRunner: MandateRunner = {
  arm: async () => ({ ok: false, detail: 'yield-prove does not arm mandates' }),
  disarm: async () => ({ ok: false, detail: 'yield-prove does not arm mandates' }),
  status: () => ({ armed: [], running: false }),
};

const audit = createAudit(cfg.dataDir);
const store = createStore(cfg.dataDir);
const ledger = createLedger(cfg);
const rails = createRails({ cfg, tokens, runner: stubRunner });
const proposals = createProposalService({
  cfg,
  audit,
  store,
  ledger,
  riskRows,
  quoter: oneClickQuoter(tokens),
  signer: stubSigner(),
  rails,
  dataDir: cfg.dataDir,
});

const owner = evmAddress(cfg.keysPath);
const explorer = chainSpec(cfg.network, CHAIN).explorerTx;

// The ledger starts empty and main.ts refreshes it on a timer. Without one refresh here the
// snapshot carries no prices, and a symbol the app cannot price becomes Infinity USD and is
// refused as invalid_amount. That is the engine behaving correctly against a ledger nobody
// filled in, and it is worth one round trip to avoid mistaking it for a rail fault.
console.log('Refreshing the ledger so the engine has prices to govern on...');
const snap = await ledger.refresh();
console.log(`  prices: ${Object.entries(snap.prices).map(([k, v]) => `${k}=${v}`).join(' ') || '(none)'}`);

function stamp(): string {
  return new Date().toISOString();
}

async function showProposal(p: Proposal): Promise<Proposal> {
  console.log(`\n  proposal ${p.id}  kind=${p.kind}  status=${p.status}  decidedBy=${p.decidedBy ?? '-'}`);
  console.log(`  verdict: ${p.verdict.outcome}  ${p.verdict.reasons.join('; ')}`);
  if (p.simulation) {
    console.log(`  simulation ok=${p.simulation.ok}`);
    if (p.simulation.summary) console.log(`    ${p.simulation.summary}`);
    if (p.simulation.error) console.log(`    ERROR: ${p.simulation.error}`);
  }

  // The gate is on in this worktree, so a proposal above the click threshold waits. This
  // script is allowed to play the human because it is being run BY the human; it says so
  // rather than approving quietly, because an approval nobody saw is the exact thing the
  // gate exists to prevent.
  let out = p;
  if (p.status === 'pending') {
    console.log('  status is pending: the policy asked for a human. Approving as the human running this script.');
    out = await proposals.approve(p.id);
    console.log(`  after approve: status=${out.status} decidedBy=${out.decidedBy ?? '-'}`);
  }

  if (out.result) {
    console.log(`  result ok=${out.result.ok}: ${out.result.detail}`);
    for (const tx of out.result.txids ?? []) console.log(`    ${explorer}${tx}`);
  }
  return out;
}

async function readPosition(): Promise<void> {
  const asset = aaveAsset(cfg.network, CHAIN, SYMBOL);
  if (asset === null) throw new Error('no verified Aave asset');

  const [pos, rate] = await Promise.all([
    aavePosition(cfg.network, CHAIN, SYMBOL, owner),
    aaveRate(cfg.network, CHAIN, SYMBOL),
  ]);

  const credits = creditsFor(proposals.list(), 'aave-v3', CHAIN, SYMBOL);
  const principal = principalFrom(credits);
  const openedAt = openedAtFrom(credits);
  const earned = pos.balanceBase - principal;
  const realized = realizedFrom({
    credits,
    openedAt,
    earnedBase: earned,
    decimals: asset.decimals,
    priceUsd: 1,
    nowMs: Date.now(),
  });

  console.log(`\n  read at ${stamp()}`);
  console.log(`  owner            ${owner}`);
  console.log(`  aToken           ${asset.receiptSymbol} ${asset.receipt}`);
  console.log(`  balance (base)   ${pos.balanceBase}`);
  console.log(`  balance          ${fromBaseUnits(pos.balanceBase, asset.decimals).toFixed(6)} ${SYMBOL}`);
  console.log(`  principal (base) ${principal}`);
  console.log(`  principal        ${fromBaseUnits(principal, asset.decimals).toFixed(6)} ${SYMBOL}`);
  console.log(`  EARNED (base)    ${earned}`);
  console.log(`  EARNED           ${fromBaseUnits(earned, asset.decimals).toFixed(6)} ${SYMBOL}`);
  console.log(`  venue rate now   ${(rate.apy * 100).toFixed(4)}% APY  (${(rate.apr * 100).toFixed(4)}% APR)`);
  console.log(`  scaled balance   ${pos.scaledBase}   index ${pos.indexRay}`);
  if (realized) {
    console.log(`  window           ${realized.windowLabel}`);
    console.log(`  avg principal    $${realized.avgPrincipalUsd.toFixed(6)}`);
    console.log(
      `  REALIZED         ${realized.annualisedPct === null ? '(window under one hour, no rate shown)' : realized.annualisedPct.toFixed(4) + '% annualised'}`,
    );
    console.log(`  ${realized.caveat}`);
  } else {
    console.log('  no open position, so no realized figure');
  }
  console.log(`  credits (${credits.length}):`);
  for (const c of credits) {
    console.log(`    ${c.at}  ${c.kind.padEnd(8)} ${c.amountBase.padStart(12)}  ${c.txids.join(' ')}`);
  }
}

const [op, arg] = process.argv.slice(2);

if (op === 'fund') {
  const weth = Number(arg ?? '0.02');
  console.log(`Swapping ${weth} WETH into ${SYMBOL} on ${CHAIN} through the app's own swap rail.`);
  // minAmountOut is the only slippage protection a swap has, so it is never left near zero:
  // a floor near zero is the documented way a sandwich takes the whole trade (see the header
  // of src/rails/uniswap.ts).
  //
  // It is sized off the TESTNET POOL and not off mainnet spot, which is the part worth
  // writing down. Arbitrum Sepolia's USDC/WETH 0.30% pool holds about 8,800 USDC against
  // 0.76 WETH, and it prices ETH roughly 20 percent under the mainnet quote because nobody
  // arbitrages it. A floor computed from spot at a mainnet-grade tolerance refuses every
  // swap here, which reads as a broken rail and is really a correct floor pointed at the
  // wrong market. 0.7 covers that gap and still refuses a trade that has gone badly wrong.
  const spotEthUsd = snap.prices.ETH ?? 0;
  if (spotEthUsd <= 0) {
    console.error('No ETH price in the ledger, so no honest floor can be set. Refusing to swap.');
    process.exit(1);
  }
  const floor = weth * spotEthUsd * 0.7;
  console.log(`  ETH spot $${spotEthUsd}, floor ${floor.toFixed(6)} USDC for ${weth} WETH`);
  const p = await proposals.proposeSwap({
    venue: 'uniswap-v3',
    chain: CHAIN,
    fromSymbol: 'WETH',
    toSymbol: SYMBOL,
    amountIn: weth,
    minAmountOut: floor,
  });
  await showProposal(p);
} else if (op === 'deposit') {
  const amount = Number(arg ?? '0');
  if (!Number.isFinite(amount) || amount <= 0) {
    console.error('usage: node scripts/yield-prove.ts deposit <amount>');
    process.exit(1);
  }
  console.log(`BEFORE, ${stamp()}`);
  await readPosition();
  console.log(`\nProposing yield_deposit of ${amount} ${SYMBOL} on ${CHAIN}.`);
  const p = await proposals.proposeYieldDeposit({ chain: CHAIN, symbol: SYMBOL, amount });
  await showProposal(p);
  console.log(`\nAFTER, ${stamp()}`);
  await readPosition();
} else if (op === 'read') {
  await readPosition();
} else if (op === 'withdraw') {
  console.log(`BEFORE, ${stamp()}`);
  await readPosition();
  console.log('\nProposing yield_withdraw of the whole position.');
  const p = await proposals.proposeYieldWithdraw({ chain: CHAIN, symbol: SYMBOL });
  await showProposal(p);
  console.log(`\nAFTER, ${stamp()}`);
  await readPosition();
} else {
  console.error('usage: node scripts/yield-prove.ts <fund|deposit|read|withdraw> [amount]');
  process.exit(1);
}
