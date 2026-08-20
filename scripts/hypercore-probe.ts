// Drive the real funding rail against the live 1Click API, without moving anything.
//
// Every quote here is dry:true, so this mints no deposit address and commits to nothing. What
// it proves is the part unit tests cannot: that the pinned asset id is still live, that the
// origin chains this rail claims actually route to HyperCore today, and that the numbers the
// approval screen would show a human are the numbers the venue is really quoting.
//
// Run: node scripts/hypercore-probe.ts [--amount 50]

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.ts';
import { hypercoreDepositRail, MIN_DEPOSIT_USDC } from '../src/rails/hypercore-deposit.ts';
import type { HlDepositDraft } from '../src/types.ts';
import type { TokensFile } from '../src/intents.ts';
import { HYPERCORE_COUNTERPARTY } from '../src/rails/hypercore-deposit.ts';
import type { ChainId } from '../src/types.ts';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cfg = loadConfig(root);
const tokens = JSON.parse(fs.readFileSync(path.join(root, 'data', 'tokens.json'), 'utf8')) as TokensFile;

const amountArg = process.argv.indexOf('--amount');
const amount = amountArg > -1 ? Number(process.argv[amountArg + 1]) : 50;

const account = cfg.addresses.evm[0];
if (account === undefined) {
  console.error('no EVM address configured, so there is no trading account to quote against');
  process.exit(1);
}

const rail = hypercoreDepositRail({
  network: cfg.tradingNetwork,
  keysPath: cfg.keysPath,
  tokens,
});

console.log(`trading network : ${cfg.tradingNetwork}`);
console.log(`trading account : ${account}`);
console.log(`amount          : ${amount} USDC\n`);

// 1. The pin still names something the API lists.
try {
  await rail.assertAssetLive();
  console.log('PIN            ok, the HyperCore USDC asset id is live and still 6 decimals');
} catch (err) {
  console.log(`PIN            FAILED: ${err instanceof Error ? err.message : String(err)}`);
}

// 2. What the account holds right now, read off the venue.
try {
  const state = await rail.accountState(account);
  const spot = state.spot.filter((b) => b.total > 0).map((b) => `${b.coin} ${b.total}`);
  console.log(
    `ACCOUNT        perp $${state.accountValueUsd}, withdrawable $${state.withdrawableUsd}, ` +
      `${state.openPositions} positions, spot [${spot.join(', ') || 'empty'}]`,
  );
} catch (err) {
  console.log(`ACCOUNT        FAILED: ${err instanceof Error ? err.message : String(err)}`);
}

console.log('');

// 3. Every origin chain the rail claims, priced for real. `sol` is in the list on purpose: the
//    rail must refuse it with a sentence about signing rather than time out against the API.
const ORIGINS: ChainId[] = ['arb', 'eth', 'base', 'near', 'sol'];

function draftFor(chain: ChainId, value: number): HlDepositDraft {
  return {
    kind: 'hl_deposit',
    chain,
    symbol: 'USDC',
    tokenId: tokens[chain]?.USDC?.tokenId ?? '',
    amount: value,
    amountUsd: value,
    // Deliberately loose here: this probe is measuring what the venue offers, and a floor set
    // for a real proposal would refuse the quote before it printed the number being measured.
    minCredited: 0,
    // The wallet the money LEAVES, which is chain-shaped: a NEAR origin sends from a NEAR
    // account id, not from the EVM address. proposeHlDeposit() resolves this per chain and an
    // earlier version of this probe did not, which produced a refusal that looked like a rail
    // bug and was really the probe naming the wrong wallet.
    from: chain === 'near' ? (cfg.addresses.near[0] ?? '') : account,
    // The account CREDITED is always the EVM one: Hyperliquid has no other kind.
    hlAccount: account,
    counterparty: HYPERCORE_COUNTERPARTY,
  };
}

for (const chain of ORIGINS) {
  const out = await rail.simulate(draftFor(chain, amount));
  if (out.ok) {
    const credited = out.summary.match(/credited\s+(\S+)/)?.[1] ?? '?';
    const cost = out.summary.match(/cost\s+(.+)/)?.[1] ?? '?';
    const eta = out.summary.match(/arrives\s+(.+)/)?.[1] ?? '?';
    console.log(`${chain.padEnd(6)} OK      ${credited} USDC credited, cost ${cost}, ${eta}`);
  } else {
    console.log(`${chain.padEnd(6)} REFUSED ${(out.error ?? '').slice(0, 150)}`);
  }
}

// 4. The floor and the ceiling, which are this rail's two size-shaped refusals.
console.log('');
const small = await rail.simulate(draftFor('arb', MIN_DEPOSIT_USDC - 1));
console.log(`floor  ${small.ok ? 'NOT ENFORCED (bug)' : 'enforced: ' + (small.error ?? '').slice(0, 110)}`);

const feeTrap = await rail.simulate(draftFor('arb', 6));
console.log(`6 USDC ${feeTrap.ok ? 'allowed: ' + (feeTrap.summary.match(/cost\s+(.+)/)?.[1] ?? '') : 'refused: ' + (feeTrap.error ?? '').slice(0, 110)}`);
