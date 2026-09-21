// Drive the real funding rail against the live 1Click API, without moving anything.
//
// Every quote here is dry:true, so this mints no deposit handle and commits to nothing. What
// it proves is the part unit tests cannot: that the pinned asset id is still live, what the
// verifier holds for this app right now, and that the numbers the approval screen would show
// a human are the numbers the venue is really quoting today, in both directions.
//
// Run: node scripts/hypercore-probe.ts [--amount 10] [--account 0x...]
// --account quotes against that address and reads no config at all, so the probe runs from a
// worktree that holds no wallet. Read only, in every mode: nothing here signs.
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
import { HL_ACTIVATION_USDC, HL_WITHDRAW_COUNTERPARTY, MIN_HL_WITHDRAW_USDC, hypercoreWithdrawRail, minReceivedForHlWithdraw } from '../src/rails/hypercore-withdraw.ts';
import { maxSendableUsdc } from '../src/rails/hl-user-signed.ts';
import { fetchIntentsHoldings } from '../src/ledger/intents.ts';
import { HYPERCORE_ORIGIN_ASSET_ID, INTENTS_USDC_ASSET_ID } from '../src/rails/hypercore-withdraw.ts';
import { HYPERCORE_USDC_ASSET_ID } from '../src/rails/hypercore-deposit.ts';
import { appFeeBpsOf } from '../src/rails/intents-spend.ts';
import { nearChainSpec } from '../src/chain/near.ts';
import { oneClickClient } from '../src/intents.ts';
import type { HlDepositDraft, HlWithdrawDraft } from '../src/types.ts';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const amountArg = process.argv.indexOf('--amount');
const amount = amountArg > -1 ? Number(process.argv[amountArg + 1]) : 10;
const accountArg = process.argv.indexOf('--account');
const cfg = accountArg > -1 ? { keysPath: '/nowhere/keys.json', addresses: { evm: process.argv[accountArg + 1] } } : loadConfig(root);

const configured = cfg.addresses.evm;
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

// 2. What the account holds right now, read off the venue, and what could leave it: the free
//    collateral less the 1 USDC the venue takes for the fresh address every exit pays into.
try {
  const state = await deposit.accountState(account);
  const most = maxSendableUsdc(state.unified ? state.availableUsdc : state.spotUsdc + state.perpWithdrawableUsd, HL_ACTIVATION_USDC);
  console.log(
    `ACCOUNT        ${state.unified ? 'unified' : 'standard'}, available $${state.availableUsdc}, perp $${state.perpAccountValueUsd}, ` +
      `spot USDC ${state.spotUsdc}, ${state.openPositions} positions, margin used $${state.marginUsedUsd}`,
  );
  console.log(
    `EXIT           ${state.unified ? 'unified account: the exit signs sendAsset (spotSend and usdSend are refused here)' : 'standard account: the exit signs sendAsset out of the spot book'}; ` +
      `the most that can come back now is ${most} USDC (${MIN_HL_WITHDRAW_USDC} USDC floor)`,
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
  if (out.send !== undefined) console.log(`DEPOSIT  card facts: arrives ${out.send.arrives}, at least ${out.send.arrivesAtLeast}, fee ${out.send.feeUsd} USDC, about ${out.send.etaSeconds}s`);
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
console.log(outBack.ok ? `WITHDRAW OK\n${outBack.summary}` : `WITHDRAW REFUSED ${(outBack.error ?? '').slice(0, 260)}`);
if (outBack.send !== undefined) console.log(`WITHDRAW card facts: arrives ${outBack.send.arrives}, at least ${outBack.send.arrivesAtLeast}, fee ${outBack.send.feeUsd} USDC, about ${outBack.send.etaSeconds}s`);
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

// 7. The venue's price today, whatever the balances: both directions quoted dry at the amount,
//    with the fee split the card prints (routing and the app fee inside the quote, the
//    activation fee on top of a withdrawal). This is what the two rails' summaries are built
//    from, read straight off 1Click so a drift in the fee shows here first.
async function price(label: string, originAsset: string, destinationAsset: string, base: string, inDecimals: number, outDecimals: number, activation: number, params: Record<string, unknown>): Promise<void> {
  try {
    const response = await client.quote({ dry: true, originAsset, destinationAsset, amount: base, slippageToleranceBps: 10, ...params } as never);
    const q = response.quote;
    const sent = Number(q.amountIn) / 10 ** inDecimals;
    const out = Number(q.amountOut) / 10 ** outDecimals;
    const floor = Number(q.minAmountOut) / 10 ** outDecimals;
    const bps = appFeeBpsOf(response.raw);
    const appFee = (sent * bps) / 10_000;
    const inside = sent - out;
    console.log(
      `${label} ${sent} in, ${out} expected, at least ${floor}, ${q.timeEstimate}s: inside the quote ${inside.toFixed(6)} USDC ` +
        `(routing ${(inside - appFee).toFixed(6)} plus ${bps} bp app fee ${appFee.toFixed(6)})` +
        (activation > 0 ? `, plus ${activation} USDC activation on top: total ${(inside + activation).toFixed(6)} USDC, ${(((inside + activation) / sent) * 100).toFixed(2)} percent` : `: ${((inside / sent) * 100).toFixed(2)} percent`),
    );
  } catch (err) {
    console.log(`${label} FAILED: ${err instanceof Error ? err.message : String(err)}`);
  }
}
console.log('');
const eightDec = BigInt(Math.round(amount * 1e8)).toString();
const sixDec = BigInt(Math.round(amount * 1e6)).toString();
await price('PRICE withdraw', HYPERCORE_ORIGIN_ASSET_ID, INTENTS_USDC_ASSET_ID, eightDec, 8, 6, HL_ACTIVATION_USDC, {
  refundTo: account,
  refundType: 'ORIGIN_CHAIN',
  recipient: intentsAccount,
  recipientType: 'INTENTS',
  depositType: 'ORIGIN_CHAIN',
});
await price('PRICE deposit ', 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near', HYPERCORE_USDC_ASSET_ID, sixDec, 6, 8, 0, {
  refundTo: intentsAccount,
  refundType: 'INTENTS',
  recipient: account,
  recipientType: 'DESTINATION_CHAIN',
  depositType: 'INTENTS',
});
