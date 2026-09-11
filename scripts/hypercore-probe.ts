// Drive the real funding rail against the live 1Click API, without moving anything.
//
// Every quote here is dry:true, so this mints no deposit handle and commits to nothing. What
// it proves is the part unit tests cannot: that the pinned asset id is still live, what the
// verifier holds for this app right now, and that the numbers the approval screen would show
// a human are the numbers the venue is really quoting today, in both directions.
//
// Run: node scripts/hypercore-probe.ts [--amount 10]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddress } from 'viem';
import type { Address } from 'viem';
import { loadConfig } from '../src/config.ts';
import {
  HYPERCORE_COUNTERPARTY,
  MIN_DEPOSIT_USDC,
  hypercoreDepositRail,
  minCreditedFor,
} from '../src/rails/hypercore-deposit.ts';
import { HL_WITHDRAW_COUNTERPARTY, hypercoreWithdrawRail, minReceivedForHlWithdraw } from '../src/rails/hypercore-withdraw.ts';
import { fetchIntentsHoldings } from '../src/ledger/intents.ts';
import { nearChainSpec } from '../src/chain/near.ts';
import { oneClickClient } from '../src/intents.ts';
import type { HlDepositDraft, HlWithdrawDraft } from '../src/types.ts';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cfg = loadConfig(root);

const amountArg = process.argv.indexOf('--amount');
const amount = amountArg > -1 ? Number(process.argv[amountArg + 1]) : 10;

const configured = cfg.addresses.evm[0];
if (configured === undefined) {
  console.error('no EVM address configured, so there is no trading account to quote against');
  process.exit(1);
}
const account = getAddress(configured);
const intentsAccount = account.toLowerCase();

// The rails derive the signer from the key, which this probe never opens: a signer port that
// answers with the configured address is enough for a dry quote and signs nothing.
const signer = { address: () => account as Address, signErc191: async () => { throw new Error('the probe never signs'); } };
const sign = { address: () => account as Address, signTypedData: async () => { throw new Error('the probe never signs'); } };
const client = oneClickClient();

const deposit = hypercoreDepositRail({ keysPath: cfg.keysPath, client, signer });
const withdraw = hypercoreWithdrawRail({ keysPath: cfg.keysPath, client, hl: { keysPath: cfg.keysPath, sign } });

console.log(`trading account : ${account}`);
console.log(`intents account : ${intentsAccount}`);
console.log(`amount          : ${amount} USDC\n`);

// 1. The pin still names something the API lists.
try {
  await deposit.assertAssetLive();
  console.log('PIN            ok, the HyperCore USDC asset id is live at the pinned decimals');
} catch (err) {
  console.log(`PIN            FAILED: ${err instanceof Error ? err.message : String(err)}`);
}

// 2. What the account holds right now, read off the venue.
try {
  const state = await deposit.accountState(account);
  console.log(
    `ACCOUNT        ${state.unified ? 'unified' : 'standard'}, available $${state.availableUsdc}, perp $${state.perpAccountValueUsd}, ` +
      `spot USDC ${state.spotUsdc}, ${state.openPositions} positions, margin used $${state.marginUsedUsd}`,
  );
} catch (err) {
  console.log(`ACCOUNT        FAILED: ${err instanceof Error ? err.message : String(err)}`);
}

// 3. What the verifier holds for us, which decides the flavor a deposit spends.
const read = await fetchIntentsHoldings({ rpcUrl: nearChainSpec().rpcUrl, accountId: intentsAccount, tokenList: () => client.tokens(), fetchImpl: fetch });
const usdc = read.holdings.filter((h) => h.symbol === 'USDC' && h.amount > 0).sort((a, b) => b.amount - a.amount);
console.log(
  `INTENTS        ${read.ok ? '' : 'read FAILED: ' + (read.error ?? '')}` +
    (usdc.length > 0 ? usdc.map((h) => `${h.amount} USDC from ${h.originChain} (${h.assetId})`).join('; ') : 'no USDC held'),
);
console.log('');

// 4. The deposit direction, priced for real.
const held = usdc[0];
if (held !== undefined) {
  const draft: HlDepositDraft = {
    kind: 'hl_deposit',
    symbol: 'USDC',
    originAsset: held.assetId,
    amount,
    amountUsd: amount,
    minCredited: minCreditedFor(amount),
    from: intentsAccount,
    hlAccount: account,
    counterparty: HYPERCORE_COUNTERPARTY,
  };
  const out = await deposit.simulate(draft);
  console.log(out.ok ? `DEPOSIT  OK\n${out.summary}` : `DEPOSIT  REFUSED ${(out.error ?? '').slice(0, 160)}`);
} else {
  console.log('DEPOSIT  skipped: nothing held inside the verifier to price a deposit from');
}
console.log('');

// 5. The withdraw direction, priced for real. Refused on an empty account, and the venue price
//    is still worth seeing beside the refusal.
const back: HlWithdrawDraft = {
  kind: 'hl_withdraw',
  symbol: 'USDC',
  amount,
  amountUsd: amount,
  minReceived: minReceivedForHlWithdraw(amount),
  from: account,
  to: intentsAccount,
  counterparty: HL_WITHDRAW_COUNTERPARTY,
};
const outBack = await withdraw.simulate(back);
console.log(outBack.ok ? `WITHDRAW OK\n${outBack.summary}` : `WITHDRAW REFUSED ${(outBack.error ?? '').slice(0, 200)}`);
console.log('');

// 6. The floor, which is the size-shaped refusal both rails share.
const small = await deposit.simulate({
  kind: 'hl_deposit',
  symbol: 'USDC',
  originAsset: held?.assetId ?? '',
  amount: MIN_DEPOSIT_USDC - 1,
  amountUsd: MIN_DEPOSIT_USDC - 1,
  minCredited: minCreditedFor(MIN_DEPOSIT_USDC - 1),
  from: intentsAccount,
  hlAccount: account,
  counterparty: HYPERCORE_COUNTERPARTY,
});
console.log(`floor  ${small.ok ? 'NOT ENFORCED (bug)' : 'enforced: ' + (small.error ?? '').slice(0, 110)}`);
