// What this app holds INSIDE the intents.near verifier: money that left the wallet on a
// deposit and that no block explorer will show you against your address.
//
// The wallet panel shows this now, as rows placed at `intents`. This script stays because
// it answers a narrower question without a browser: if a deposit reported SUCCESS and the
// panel shows nothing, run this and compare. It reads through src/ledger/intents.ts rather
// than reimplementing the view calls, because two copies of this read is exactly how the
// app came to disagree with the script in the first place: the script knew the endpoint had
// moved and the ledger did not, so the panel quietly showed an empty NEAR and no verifier
// balance at all.
//
// Read only. Two view methods, no signing.
//
// Run: npm run intents-balance

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.ts';
import { fetchIntentsHoldings } from '../src/ledger/intents.ts';
import { oneClickClient } from '../src/intents.ts';
import { evmAddress } from '../src/chain/evm.ts';

// rpc.mainnet.near.org answers every request with -429 and a notice telling you to stop
// using it, so it is deliberately not the default here.
const NEAR_RPC = process.env.PHOSPHOR_NEAR_RPC ?? 'https://free.rpc.fastnear.com';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cfg = loadConfig(root);

// Derived from the key, exactly as the rails derive it. Reading it from config instead
// would let a stale config point this at an account the app cannot spend, and report
// someone else's balance as ours.
const accountId = evmAddress(cfg.keysPath).toLowerCase();

const read = await fetchIntentsHoldings({
  rpcUrl: NEAR_RPC,
  accountId,
  tokenList: () => oneClickClient().tokens(),
  fetchImpl: fetch,
});

console.log(`intents.near balance for ${accountId}`);
console.log(`(held by the verifier contract, not on any chain)\n`);

if (!read.ok) {
  console.log(`  READ FAILED: ${read.error ?? 'unknown error'}`);
  console.log('  This is not the same as holding nothing. Try again before concluding anything.');
} else if (read.holdings.length === 0) {
  console.log('  nothing held.');
  console.log('  If a deposit just reported SUCCESS, give it a few seconds and run this again.');
} else {
  for (const row of read.holdings) {
    console.log(`  ${row.amount} ${row.symbol}`);
    console.log(`      ${row.assetId}  (${row.decimals} decimals)`);
  }
}
