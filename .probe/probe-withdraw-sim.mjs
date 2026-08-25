// Simulate the withdraw rail without executing it. eth_call and reads only: nothing is signed.
import { loadConfig } from '../src/config.ts';
import { yieldRails } from '../src/rails/yield.ts';
import { aavePosition, aaveAsset } from '../src/yield/aave.ts';
import { evmAddress } from '../src/chain/evm.ts';

const cfg = loadConfig(process.cwd());
const rails = yieldRails(cfg);
const owner = evmAddress(cfg.keysPath);
const asset = aaveAsset(cfg.network, 'arb', 'USDC');
const pos = await aavePosition(cfg.network, 'arb', 'USDC', owner);

console.log('position now:', pos.balanceBase.toString(), 'base units');

// whole position
const whole = await rails.withdraw.simulate({
  kind: 'yield_withdraw', venue: 'aave-v3', chain: 'arb', symbol: 'USDC',
  amount: Number(pos.balanceBase) / 1e6, amountBase: null, decimals: 6,
  amountUsd: Number(pos.balanceBase) / 1e6, from: owner, counterparty: '',
});
console.log('\nWHOLE POSITION  ok=' + whole.ok);
console.log(' ', whole.summary || whole.error);

// partial
const part = await rails.withdraw.simulate({
  kind: 'yield_withdraw', venue: 'aave-v3', chain: 'arb', symbol: 'USDC',
  amount: 10, amountBase: '10000000', decimals: 6,
  amountUsd: 10, from: owner, counterparty: '',
});
console.log('\nPARTIAL 10 USDC  ok=' + part.ok);
console.log(' ', part.summary || part.error);

// more than we hold: must refuse
const over = await rails.withdraw.simulate({
  kind: 'yield_withdraw', venue: 'aave-v3', chain: 'arb', symbol: 'USDC',
  amount: 999999, amountBase: '999999000000', decimals: 6,
  amountUsd: 999999, from: owner, counterparty: '',
});
console.log('\nOVER-WITHDRAW 999999  ok=' + over.ok, '(must be false)');
console.log(' ', over.summary || over.error);

// wrong venue: must refuse
const wrongVenue = await rails.withdraw.simulate({
  kind: 'yield_withdraw', venue: 'compound-v3', chain: 'arb', symbol: 'USDC',
  amount: 1, amountBase: '1000000', decimals: 6, amountUsd: 1, from: owner, counterparty: '',
});
console.log('\nWRONG VENUE  ok=' + wrongVenue.ok, '(must be false)');
console.log(' ', wrongVenue.error);

// deposit bigger than the wallet holds: must refuse
const tooBig = await rails.deposit.simulate({
  kind: 'yield_deposit', venue: 'aave-v3', chain: 'arb', symbol: 'USDC',
  amount: 100000, amountBase: '100000000000', decimals: 6, amountUsd: 100000, from: owner, counterparty: '',
});
console.log('\nDEPOSIT BEYOND BALANCE  ok=' + tooBig.ok, '(must be false)');
console.log(' ', tooBig.error);
