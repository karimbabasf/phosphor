// Read the solver relay and the verifier as the relay swap rail reads them, without moving
// anything: a quote for a pair, the salt a nonce would carry, what the account holds of the
// input asset, and the relay's status for an intent hash. Nothing here signs or publishes, no
// key is opened, and no argument can make it do either.
//
// Run: node scripts/relay-probe.ts [--from USDC] [--to USDT] [--amount 2] [--chain near]
//      node scripts/relay-probe.ts --status <intent hash>
//      node scripts/relay-probe.ts --nonce <base64 nonce>     (is it spent, for the configured account)
//
// The live proof (docs/superpowers/specs/2026-09-20-swap-relay-design.md, "Proof") starts here:
// a pair the public relay does not quote comes back "no solver offered a price", and is not a
// pair to prove on.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatUnits } from 'viem';
import { loadConfig } from '../src/config.ts';
import { oneClickClient, resolveAsset, toBaseUnits } from '../src/intents.ts';
import type { TokensFile } from '../src/intents.ts';
import type { ChainId } from '../src/types.ts';
import { relayClient } from '../src/relay/client.ts';
import { pickQuote } from '../src/relay/payload.ts';
import { liveVerifier } from '../src/relay/verifier.ts';
import { RELAY_MIN_QUOTE_AHEAD_MS } from '../src/rails/intents-relay.ts';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cfg = loadConfig(root);

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(name);
  return at > -1 && process.argv[at + 1] !== undefined ? process.argv[at + 1] : fallback;
}

const relay = relayClient();
const verifier = liveVerifier();
const account = (cfg.addresses.evm ?? '').toLowerCase();

const statusHash = arg('--status', '');
if (statusHash !== '') {
  const status = await relay.status(statusHash);
  console.log(`intent  : ${status.intentHash}`);
  console.log(`status  : ${status.status}${status.statusDetails === null ? '' : ` (${status.statusDetails})`}`);
  console.log(`near tx : ${status.nearTxHash ?? 'none yet'}`);
  console.log(`filled  : ${status.filledAmounts.length === 0 ? 'none yet' : status.filledAmounts.join(', ')}`);
  process.exit(0);
}

const nonce = arg('--nonce', '');
if (nonce !== '') {
  if (account === '') {
    console.error('no EVM address configured, so there is no account to ask about');
    process.exit(1);
  }
  const used = await verifier.nonceUsed(account, nonce);
  console.log(`account : ${account}`);
  console.log(`nonce   : ${nonce}`);
  console.log(`spent   : ${used === null ? 'the verifier did not answer' : used ? 'yes, the intent executed' : 'no'}`);
  process.exit(0);
}

const chain = arg('--chain', 'near') as ChainId;
const fromSymbol = arg('--from', 'USDC');
const toSymbol = arg('--to', 'USDT');
const amount = Number(arg('--amount', '2'));

const tokens = JSON.parse(fs.readFileSync(path.join(root, 'data', 'tokens.json'), 'utf8')) as TokensFile;
const list = await oneClickClient().tokens();
const origin = resolveAsset(chain, fromSymbol, tokens, list);
const dest = resolveAsset(chain, toSymbol, tokens, list);
const amountBase = toBaseUnits(amount, origin.decimals);

console.log(`pair    : ${amount} ${fromSymbol} (${origin.assetId}) -> ${toSymbol} (${dest.assetId})`);
console.log(`account : ${account === '' ? 'none configured' : account}\n`);

const salt = await verifier.currentSalt();
console.log(`SALT     ${salt === null ? 'FAILED: the verifier did not answer' : `ok, ${Buffer.from(salt).toString('hex')}`}`);

if (account !== '') {
  const held = await verifier.balance(account, origin.assetId);
  console.log(`BALANCE  ${held === null ? 'not read' : `${formatUnits(held, origin.decimals)} ${fromSymbol} held inside intents.near`}${held !== null && held < amountBase ? ' (SHORT for this amount)' : ''}`);
}

const started = Date.now();
const quotes = await relay.quote({ assetIn: origin.assetId, assetOut: dest.assetId, exactAmountIn: amountBase.toString() });
const took = Date.now() - started;
const pick = pickQuote(quotes, { assetIn: origin.assetId, assetOut: dest.assetId, amountIn: amountBase, now: Date.now(), minAheadMs: RELAY_MIN_QUOTE_AHEAD_MS });
if (pick.chosen === null) {
  console.log(`QUOTE    no solver offered a price for ${amount} ${fromSymbol} to ${toSymbol} (${quotes.length} answers in ${took} ms). Not a pair to prove on right now.`);
  for (const line of pick.passed) console.log(`         ${line}`);
  process.exit(2);
}
console.log(`QUOTE    ${quotes.length} answer(s) in ${took} ms; best ${formatUnits(BigInt(pick.chosen.amountOut), dest.decimals)} ${toSymbol}`);
console.log(`         quote hash ${pick.chosen.quoteHash}, good until ${pick.chosen.expirationTime}`);
for (const line of pick.passed) console.log(`         passed over: ${line}`);
console.log('\nNothing was signed and nothing was published.');
