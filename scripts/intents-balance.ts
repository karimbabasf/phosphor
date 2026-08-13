// What this app holds INSIDE the intents.near verifier, which is money the wallet panel
// cannot see and no block explorer will show you against your address.
//
// A deposit through the intents-deposit rail leaves the wallet and becomes a balance the
// verifier tracks on its own ledger, keyed by an account id. For an erc191 signer that
// account id is the EVM address lowercased, so this reads the same id the rail credits and
// the intents-native rail spends. If a deposit says SUCCESS and this shows nothing, those
// are the two numbers to compare.
//
// Read only. It calls one view method and signs nothing.
//
// Run: npm run intents-balance

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.ts';

const INTENTS_VERIFIER = 'intents.near';

// rpc.mainnet.near.org now answers every request with -429 and a notice telling you to stop
// using it, so it is deliberately not the default here.
const NEAR_RPC = process.env.PHOSPHOR_NEAR_RPC ?? 'https://free.rpc.fastnear.com';

type TokenEntry = { assetId: string; symbol: string; decimals: number; blockchain: string };

async function tokenList(): Promise<TokenEntry[]> {
  const res = await fetch('https://1click.chaindefuser.com/v0/tokens');
  if (!res.ok) throw new Error(`1click token list failed: ${res.status}`);
  return (await res.json()) as TokenEntry[];
}

async function balances(accountId: string, tokenIds: string[]): Promise<string[]> {
  const args = Buffer.from(JSON.stringify({ account_id: accountId, token_ids: tokenIds })).toString('base64');
  const res = await fetch(NEAR_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'query',
      params: {
        request_type: 'call_function',
        finality: 'final',
        account_id: INTENTS_VERIFIER,
        method_name: 'mt_batch_balance_of',
        args_base64: args,
      },
    }),
  });
  const body = (await res.json()) as { result?: { result: number[] }; error?: unknown };
  if (body.error !== undefined || body.result === undefined) {
    throw new Error(`near view call failed: ${JSON.stringify(body.error ?? 'no result').slice(0, 200)}`);
  }
  return JSON.parse(Buffer.from(Uint8Array.from(body.result.result)).toString('utf8')) as string[];
}

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cfg = loadConfig(root);

// The account id is derived from the key, exactly as the rails derive it. Reading it from
// config instead would let a stale config point this at an account the app cannot spend, and
// report someone else's balance as ours.
const keys = JSON.parse(fs.readFileSync(cfg.keysPath, 'utf8')) as { evm?: { address?: string } };
const address = keys.evm?.address;
if (typeof address !== 'string' || address === '') {
  throw new Error(`no evm.address in ${cfg.keysPath}. Run: npm run keygen`);
}
const accountId = address.toLowerCase();

const list = await tokenList();
// One view call for every asset the verifier could hold for us, then print only what is
// actually there. 186 ids in one call is cheaper and less racy than 186 calls.
const ids = [...new Set(list.map((t) => t.assetId))];
const amounts = await balances(accountId, ids);

const held = ids
  .map((assetId, i) => ({ assetId, raw: BigInt(amounts[i] ?? '0') }))
  .filter((row) => row.raw > 0n)
  .map((row) => {
    const meta = list.find((t) => t.assetId === row.assetId);
    const decimals = meta?.decimals ?? 0;
    const amount = Number(row.raw) / 10 ** decimals;
    return { symbol: meta?.symbol ?? row.assetId, assetId: row.assetId, amount, raw: row.raw.toString() };
  });

console.log(`intents.near balance for ${accountId}`);
console.log(`(this is NOT in the wallet: it is held by the verifier contract)\n`);

if (held.length === 0) {
  console.log('  nothing held.');
  console.log('  If a deposit just reported SUCCESS, give it a few seconds and run this again.');
} else {
  for (const row of held) {
    console.log(`  ${row.amount} ${row.symbol}`);
    console.log(`      ${row.assetId}  (${row.raw} base units)`);
  }
}
