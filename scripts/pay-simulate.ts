// Every chain a payout can land on since 2026-09-26, run through the real pay rail's simulate path
// against live 1Click and the live chain readers. Read only: dry quotes, never a signature.
//
// What runs is src/rails/intents-pay.ts simulate(), the path a proposal takes before any key is
// touched, wired the way src/rails/index.ts wires it (one shared 1Click client, the live route
// checker, the live chain reads and the bridge's deposit address), with the draft built the way
// src/proposals/rails.ts proposeSend builds one (the address through pay-rules payAddress, the
// receiver read from the chain first). The one thing swapped out is the signer: its address()
// answers the account without opening any keystore, and signErc191 throws, and the run counts
// both. simulate() never calls signErc191 (execute does, through spendFromIntents), and the count
// printed at the end is the proof for this run.
//
// Rows: every token 1Click lists on each of the fourteen chains, paid to the account's own bridge
// deposit address there (a personal account on Stellar, where the bridge's address is shared and
// refused; on the XRP Ledger, where ours does not exist on the ledger yet; and on TON, whose
// deposit route may be paused, which a payout to our own address there now obeys), then one case
// per chain rule, each expected to refuse. A token whose flat bridge fee
// breaches the 3% floor at the default size is run again at the size that clears it, and both
// rows are printed: the refusal is the rule working, the second row is the smallest payout that
// goes through.
//
// Run: node scripts/pay-simulate.ts [--account 0x...] [--network xrp] [--usd 15]

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { IntentsPayDraft, SimulationResult } from '../src/types.ts';
import { oneClickClient } from '../src/intents.ts';
import type { OneClickToken, TokensFile } from '../src/intents.ts';
import { intentsApi } from '../src/rails/intents-native.ts';
import type { IntentsApiPort, IntentsSignerPort } from '../src/rails/intents-native.ts';
import { INTENTS_PAY_COUNTERPARTY, intentsPayRail, minReceivedForPay } from '../src/rails/intents-pay.ts';
import { intentsDepositAddress, spendNetworkOf } from '../src/rails/intents-address.ts';
import { payAddress } from '../src/rails/pay-rules.ts';
import { addressActivity, chainHead, scanNetworkOf } from '../src/chainscan/index.ts';
import type { AddressActivity } from '../src/chainscan/index.ts';
import { createRouteHealth } from '../src/preflight/route-health.ts';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] !== undefined ? String(process.argv[i + 1]) : fallback;
}

const ACCOUNT = arg('account', '0xd7b2de5862008d949dd6e5d70d4c68ad1d4d5050').toLowerCase();
const ONLY = arg('network', '');
const USD = Number(arg('usd', '15'));

const NETWORKS = ['tron', 'ton', 'xrp', 'stellar', 'sui', 'aptos', 'movement', 'cardano', 'starknet', 'btc', 'ltc', 'doge', 'bch', 'dash'].filter((n) => ONLY === '' || n === ONLY);

// Live accounts read on 2026-09-26, for the rule cases and Stellar's plain receiver.
const XLM_PERSONAL = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7'; // exists, XLM only
const XLM_PERSONAL_USDC = 'GDZZZXIMQ3JN3T7KN7I2G5DKOEFPHXKAHVC66GKUV2HZO6D4YC3QRAGJ'; // exists, trusts USDC
const XLM_EXCHANGE = 'GAHK7EEG2WWHVKDNT4CEQFZGKF2LGDSW2IVM4S5DP42RBW3K6BTODB4A'; // 1Click calls it an exchange
const XLM_NO_TRUSTLINE = XLM_PERSONAL;
const XLM_ABSENT = 'GCKFBEIYV2U22IO2BJ4KVJOIP7XPWQGQFKKWXR6DOSJBV7STMAQSMTGG'; // horizon 404
const XLM_MEMO_REQUIRED = 'GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37'; // config.memo_required = 1
const XLM_MUXED = 'MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVAAAAAAAAAAAAGZFQ';
const XRP_TAGGED = 'rEb8TK3gBgk5auZkwc6sHnwrGVJH8DuaLh'; // Binance, RequireDestTag
const XRP_ABSENT = 'rrrrrrrrrrrrrrrrrrrrrhoLvTp'; // actNotFound
const XRP_X = 'X7AcgcsBL6XDcUb289X4mJ8djcdyKaB5hJDWMArnXr61cqZ';
// Read on 2026-09-27: a plain XRP account (exists, no flags), the XRP/USD (Bitstamp) AMM account
// (DepositAuth, DefaultRipple and DisableMaster set), and a TON v5 wallet that is active.
const XRP_PLAIN = 'r3ASEe1LLnhfCwrHKr4Cg6YS15t52S1MK5';
const XRP_AMM = 'rHUpaqUPbwzKZdzQ8ZQCme18FrgW9pB4am';
const TON_PERSONAL = 'UQBFsZgysKtEdfVAccRkcARCaBPPaAURMcz171nLZlnyNtR_';
// A CashAddr of type 0 (key hash) carrying a 32-byte hash, checksum valid: money sent to it could
// never be spent. Built for this row; no wallet writes one.
const TRON_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'; // Tether's USDT contract
const DOGE_P2SH_9 = '9tqKQiiGuXEe6bVDPsdtwMhZgW9JMxw8ni';
const BCH_LEGACY = '1LS5MKKH37KBpJRCMQQuuGM7DEDA22qpXZ';
const BCH_P2PKH_32 = 'bitcoincash:qvrswpc8qurswpc8qurswpc8qurswpc8qurswpc8qurswpc8qurswmdqrg3rk';

const tokens = JSON.parse(readFileSync(path.join(ROOT, 'data', 'tokens.json'), 'utf8')) as TokensFile;
const client = oneClickClient();

// The echo each quote came back with, keyed by the recipient asked for.
const echoes: Array<{ asked: string; echoed: unknown }> = [];
const base = intentsApi({ apiKey: '', client });
const api: IntentsApiPort = {
  ...base,
  async quote(params) {
    const answer = await base.quote(params);
    const req = (answer.raw as { quoteRequest?: { recipient?: unknown } } | null)?.quoteRequest;
    echoes.push({ asked: String(params.recipient), echoed: req?.recipient });
    return answer;
  },
};

let addressReads = 0;
let signs = 0;
const signer: IntentsSignerPort = {
  address: () => {
    addressReads += 1;
    return ACCOUNT as `0x${string}`;
  },
  signErc191: async () => {
    signs += 1;
    throw new Error('the simulation never signs');
  },
};

const routes = createRouteHealth({
  tokens: () => client.tokens(),
  chainHead: (id) => {
    const network = scanNetworkOf(id);
    return network === null ? Promise.resolve(null) : chainHead(network);
  },
  log: () => undefined,
});

const rail = intentsPayRail({ keysPath: '/nonexistent/phosphor-pay-simulate/keys.json', tokens, api, signer, client, routes });

type Row = { network: string; token: string; to: string; verdict: string; sentence: string; fee: string; minimum: string; eta: string; echo: string; expect: 'ok' | 'refused' };
const rows: Row[] = [];

function sig(n: number): number {
  return Number(n.toPrecision(6));
}

// The balance flavor a payout of `t` spends: the asset itself when the balance can hold it, else
// the one intents asset of the same symbol and decimals (the rail refuses a decimals mismatch).
function heldFor(t: OneClickToken, list: OneClickToken[]): OneClickToken | null {
  if (/^nep(141|245):/.test(t.assetId)) return t;
  const same = list.filter((o) => /^nep(141|245):/.test(o.assetId) && o.symbol === t.symbol && o.decimals === t.decimals);
  return same.find((o) => o.assetId === `nep141:${o.symbol.toLowerCase()}.omft.near`) ?? same[0] ?? null;
}

async function draftFor(network: string, symbol: string, held: string, amount: number, given: string, priceUsd: number): Promise<{ draft: IntentsPayDraft | null; refused: string | null }> {
  const checked = payAddress(network, given);
  if (!checked.ok) return { draft: null, refused: `The receiving address is unusable: ${checked.reason}.` };
  const scan = scanNetworkOf(network);
  let activity: AddressActivity | null = null;
  if (scan !== null) activity = await addressActivity(scan, checked.to, { deadline: Date.now() + 8_000 }).catch(() => null);
  return {
    draft: {
      kind: 'intents_pay',
      symbol,
      originAsset: held,
      network,
      amount,
      amountUsd: amount * priceUsd,
      minReceived: minReceivedForPay(amount),
      from: ACCOUNT,
      to: checked.to,
      toChecksum: checked.checksum,
      ...(checked.given === null ? {} : { toGiven: checked.given }),
      counterparty: INTENTS_PAY_COUNTERPARTY,
      recipient: { known: false, count: 0, lastAt: null, activity, ownAddress: false },
    },
    refused: null,
  };
}

function sentenceOf(sim: SimulationResult): string {
  if (!sim.ok) return String(sim.error ?? sim.summary).replace(/\s+/g, ' ').trim();
  const notes = (sim.send?.notes ?? []).map((n) => n.text);
  return [sim.send?.activity ?? '', ...notes].filter((t) => t !== '').join(' ');
}

async function run(network: string, token: OneClickToken, held: OneClickToken | null, given: string, amount: number, expect: 'ok' | 'refused', tag = ''): Promise<SimulationResult | null> {
  const label = `${token.symbol}${token.assetId.startsWith('1cs_v1') ? ' (1cs)' : ''}${tag}`;
  if (held === null) {
    rows.push({ network, token: label, to: given, verdict: 'skipped', sentence: `no balance flavor holds ${token.symbol} at ${token.decimals} decimals, so no payout can spend into it`, fee: '', minimum: '', eta: '', echo: 'no quote', expect });
    return null;
  }
  const before = echoes.length;
  const { draft, refused } = await draftFor(network, token.symbol, held.assetId, amount, given, token.price ?? 0);
  if (draft === null) {
    rows.push({ network, token: label, to: given, verdict: 'refused', sentence: refused ?? '', fee: '', minimum: '', eta: '', echo: 'no quote (refused at propose)', expect });
    return null;
  }
  const sim = await rail.simulate(draft);
  const echo = echoes.length === before ? 'no quote' : echoes.slice(before).every((e) => e.echoed === e.asked) ? `byte-for-byte (${draft.to === given ? 'as given' : `sent ${draft.to}`})` : `DIFFERS: ${String(echoes[echoes.length - 1].echoed)}`;
  rows.push({
    network,
    token: label,
    to: given,
    verdict: sim.ok ? 'ok' : 'refused',
    sentence: sentenceOf(sim),
    fee: sim.send?.feeUsd === null || sim.send?.feeUsd === undefined ? '' : `$${sim.send.feeUsd.toFixed(4)}`,
    minimum: sim.send ? `${sim.send.arrivesAtLeast} ${token.symbol}` : '',
    eta: sim.send?.etaSeconds === null || sim.send?.etaSeconds === undefined ? '' : `${sim.send.etaSeconds}s`,
    echo,
    expect,
  });
  return sim;
}

const list = await client.tokens();
const own: Record<string, string> = {};
for (const network of NETWORKS) {
  own[network] = (await intentsDepositAddress(ACCOUNT, network)).address;
}

const coinOf = (network: string, symbol: string): OneClickToken => {
  const venue = spendNetworkOf(network)?.venue ?? network;
  const t = list.find((o) => o.blockchain === venue && o.symbol === symbol);
  if (t === undefined) throw new Error(`1click lists no ${symbol} on ${network}`);
  return t;
};
const amountOf = (t: OneClickToken, usd = USD): number => sig(usd / (t.price ?? 1));

// ---------- every token on every chain ----------

for (const network of NETWORKS) {
  const venue = spendNetworkOf(network)?.venue ?? network;
  for (const t of list.filter((o) => o.blockchain === venue)) {
    const to = network === 'stellar' ? (t.symbol === 'XLM' ? XLM_PERSONAL : XLM_PERSONAL_USDC) : network === 'xrp' ? XRP_PLAIN : network === 'ton' ? TON_PERSONAL : own[network];
    const held = heldFor(t, list);
    const sim = await run(network, t, held, to, amountOf(t), 'ok');
    // The flat bridge fee breached the floor: the size where it is 2% of the payout goes through.
    const fee = Number(sim?.send?.bridgeFee ?? NaN);
    if (sim !== null && !sim.ok && /floor the draft names/.test(sim.summary) && Number.isFinite(fee) && fee > 0) {
      rows[rows.length - 1].expect = 'refused';
      await run(network, t, held, to, sig(fee / 0.02), 'ok', ' (sized to its fee)');
    }
  }
}

// ---------- one case per rule ----------

const rule = async (network: string, symbol: string, to: string, amount?: number): Promise<void> => {
  if (!NETWORKS.includes(network)) return;
  const t = coinOf(network, symbol);
  await run(network, t, heldFor(t, list), to, amount ?? amountOf(t), 'refused');
};

await rule('xrp', 'XRP', XRP_X);
await rule('xrp', 'XRP', XRP_TAGGED);
await rule('xrp', 'XRP', XRP_ABSENT, 0.5);
// Our own XRP deposit address does not exist on the ledger: refused whatever the size.
await rule('xrp', 'XRP', own.xrp ?? XRP_ABSENT, 5);
await rule('xrp', 'XRP', XRP_AMM);
await rule('stellar', 'XLM', XLM_MUXED);
await rule('stellar', 'XLM', XLM_MEMO_REQUIRED);
await rule('stellar', 'USDC', XLM_ABSENT);
await rule('stellar', 'XLM', XLM_ABSENT, 20);
await rule('stellar', 'USDC', XLM_NO_TRUSTLINE);
await rule('stellar', 'XLM', own.stellar ?? XLM_PERSONAL);
await rule('stellar', 'XLM', XLM_EXCHANGE);
if (NETWORKS.includes('ton')) {
  // A wallet's UQ address respelt bounceable: goes ahead, sent as the same account non-bounceable.
  const uq = Buffer.from(TON_PERSONAL.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const eq = Buffer.from(uq);
  eq[0] = 0x11;
  const { crc16 } = await import('../src/chainscan/codec.ts');
  const c = crc16(eq.subarray(0, 34));
  eq[34] = c >> 8;
  eq[35] = c & 0xff;
  const t = coinOf('ton', 'GRAM');
  await run('ton', t, heldFor(t, list), eq.toString('base64url'), amountOf(t), 'ok');
  const testnet = Buffer.from(uq);
  testnet[0] = 0xd1;
  const d = crc16(testnet.subarray(0, 34));
  testnet[34] = d >> 8;
  testnet[35] = d & 0xff;
  await run('ton', t, heldFor(t, list), testnet.toString('base64url'), amountOf(t), 'refused');
  // Our own TON deposit address is a deposit into TON: refused while NEAR Intents has paused TON
  // deposits, which it had on 2026-09-27.
  await run('ton', t, heldFor(t, list), own.ton, amountOf(t), 'refused', ' (own deposit address)');
}
await rule('tron', 'TRX', TRON_CONTRACT);
await rule('doge', 'DOGE', DOGE_P2SH_9);
await rule('bch', 'BCH', BCH_LEGACY);
await rule('bch', 'BCH', BCH_P2PKH_32);
await rule('btc', 'BTC', own.btc ? own.btc.slice(0, -1) + (own.btc.endsWith('q') ? 'p' : 'q') : 'bc1q');
await rule('btc', 'BTC', own.btc ?? '', 0.000005);
await rule('starknet', 'STRK', own.starknet ? `0x${own.starknet.slice(2).replace(/^0+/, '')}` : '0x1');

// ---------- the table ----------

const cell = (s: string): string => s.replace(/\|/g, '/');
console.log('| network | token | verdict | sentence | fee | minimum received | time | echo |');
console.log('|---|---|---|---|---|---|---|---|');
for (const r of rows) {
  const verdict = r.verdict === r.expect || r.verdict === 'skipped' ? r.verdict : `${r.verdict} (EXPECTED ${r.expect})`;
  console.log(`| ${r.network} | ${cell(r.token)} | ${verdict} | ${cell(r.sentence)} | ${r.fee} | ${cell(r.minimum)} | ${r.eta} | ${cell(r.echo)} |`);
}
const okNetworks = new Set(rows.filter((r) => r.verdict === 'ok').map((r) => r.network));
const missing = NETWORKS.filter((n) => !okNetworks.has(n));
const unexpected = rows.filter((r) => r.verdict !== 'skipped' && r.verdict !== r.expect);
console.log(`\n${rows.length} rows; ok on ${okNetworks.size}/${NETWORKS.length} networks${missing.length ? ` (none on ${missing.join(', ')})` : ''}; ${unexpected.length} unexpected verdicts; signer: address() ${addressReads} times from no file, signErc191 ${signs} times.`);
if (signs !== 0) process.exitCode = 1;
