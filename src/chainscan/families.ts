// The readers for every network past the first six, one per protocol family, and the chain
// head for all of them.
//
// Each family is three questions put to the chain's own public endpoint: what an address
// holds, what one transaction did, and where the chain is now. The rule is the one a contract
// follows about gas: one request per question wherever the source can answer in one, a batch
// where it takes several calls, a second request only when the first one's answer is the
// second one's input. Nothing here polls or keeps a timer; the only memory is chainFetch's
// bounded cache. Every function may throw, and src/chainscan/index.ts turns a throw into an
// answer that names the failure.

import { formatUnits } from 'viem';

import { chainFetch, DEFAULT_CAP, ratePerSecond } from './fetch.ts';
import { NETWORKS } from './networks.ts';
import type { ChainNetwork, ReadFamily } from './networks.ts';
import { api, big, dataText, decimalText, decimalUnits, idText, isoFromMillis, isoFromSeconds, isoFromText, list, num, rec, rpc, rpcBatch, units } from './common.ts';
import type { AddressActivity, ChainDeps, Found, TokenBalance } from './common.ts';

// A chain head moves every few seconds, so it is cached for fifteen, not the minute every
// other answer gets, unless the host's budget asks for longer (headTtl).
export const HEAD_TTL_MS = 15_000;
const BIG_CAP = 512 * 1024; // a transaction with its receipt, metadata or proof
const ALEO_TX_CAP = 1024 * 1024; // a deployment carries its program

export type Read = { activity: AddressActivity; tokens?: TokenBalance[]; tokensSource?: string };
export type Head = { height: number; time: string | null };

type Family = {
  activity: (network: ChainNetwork, address: string, deps: ChainDeps) => Promise<Read>;
  transaction: (network: ChainNetwork, hash: string, deps: ChainDeps) => Promise<Found>;
};

function blank(network: ChainNetwork, address: string, source: string): AddressActivity {
  return { network, address, ok: false, txCount: null, balance: null, isContract: null, lastSeen: null, source };
}

// An answered read. `txCount` 0 with a zero balance is what an address that has never been
// used on the chain reads as, which is the sentence a payout card needs most.
function answered(network: ChainNetwork, address: string, source: string, amount: string | null, extra: Partial<AddressActivity> = {}): Read {
  const spec = NETWORKS[network];
  return { activity: { ...blank(network, address, source), ok: true, balance: { amount: amount ?? '0', symbol: spec.symbol }, ...extra } };
}

function never(network: ChainNetwork, address: string, source: string): Read {
  return answered(network, address, source, '0', { txCount: 0 });
}

function height(v: unknown): number {
  const n = num(v) ?? (big(v) === null ? null : Number(big(v)));
  if (n === null || n < 0) throw new Error('the head answer carried no height');
  return n;
}

function detail(network: ChainNetwork, hash: string, source: string, fields: Partial<Found['tx']>): Found {
  const tx = { hash, time: null, from: null, to: null, value: null, symbol: NETWORKS[network].symbol, status: 'unknown' as const, method: null, fee: null, block: null, confirmations: null, ...fields };
  return { tx, source };
}

function isHttp404(err: unknown): boolean {
  return err instanceof Error && err.message === 'http 404';
}

// ---------- EVM over its own JSON-RPC ----------

const evmRpc: Family = {
  async activity(network, address, deps) {
    const [balance, nonce, code] = await rpcBatch(api(network, '/'), [
      { method: 'eth_getBalance', params: [address, 'latest'] },
      { method: 'eth_getTransactionCount', params: [address, 'latest'] },
      { method: 'eth_getCode', params: [address, 'latest'] },
    ], deps);
    if (balance.error !== undefined) throw new Error(`rpc ${balance.error}`);
    const count = big(nonce.result);
    const bytecode = typeof code.result === 'string' ? code.result.toLowerCase() : null;
    return answered(network, address, 'rpc', units(balance.result, NETWORKS[network].decimals), {
      txCount: count === null ? null : Number(count),
      // An EIP-7702 delegation (0xef0100...) is an account that signs, not a contract.
      isContract: bytecode === null ? null : bytecode !== '0x' && !bytecode.startsWith('0xef0100'),
    });
  },
  async transaction(network, hash, deps) {
    const spec = NETWORKS[network];
    const [txAnswer, receiptAnswer, tipAnswer] = await rpcBatch(api(network, '/'), [
      { method: 'eth_getTransactionByHash', params: [hash] },
      { method: 'eth_getTransactionReceipt', params: [hash] },
      { method: 'eth_blockNumber', params: [] },
    ], deps);
    if (txAnswer.error !== undefined) throw new Error(`rpc ${txAnswer.error}`);
    const tx = rec(txAnswer.result);
    if (Object.keys(tx).length === 0) throw new Error('no such transaction');
    const receipt = rec(receiptAnswer.result);
    const mined = big(receipt.blockNumber ?? tx.blockNumber);
    const tip = big(tipAnswer.result);
    const gas = big(receipt.gasUsed);
    const price = big(receipt.effectiveGasPrice);
    // No receipt is a transaction still waiting; a receipt the node refused to give (a public
    // node that keeps only recent ones) is a question it did not answer, and says so.
    const refused = receiptAnswer.error !== undefined;
    const found = detail(network, hash, 'rpc', {
      from: idText(tx.from),
      to: idText(tx.to),
      value: units(tx.value, spec.decimals),
      status: refused ? 'unknown' : Object.keys(receipt).length === 0 ? 'pending' : receipt.status === '0x1' ? 'success' : 'failed',
      // An OP-stack rollup also charges for posting the transaction to Ethereum, and says how much.
      fee: gas === null || price === null ? null : formatUnits(gas * price + (big(receipt.l1Fee) ?? 0n), spec.decimals),
      block: mined === null ? null : Number(mined),
      confirmations: mined === null || tip === null ? null : Number(tip - mined) + 1,
    });
    return refused ? { ...found, error: `receipt: ${receiptAnswer.error}` } : found;
  },
};

async function evmHead(network: ChainNetwork, deps: ChainDeps, host = headHost(network), path = '/'): Promise<Head> {
  const block = rec(await rpc(`https://${host}${path}`, 'eth_getBlockByNumber', ['latest', false], deps, DEFAULT_CAP, HEAD_TTL_MS));
  return { height: height(block.number), time: isoFromSeconds(big(block.timestamp)?.toString()) };
}

// ---------- UTXO chains past Bitcoin ----------

const HASKOIN = '/haskoin-store/bch';

const haskoin: Family = {
  async activity(network, address, deps) {
    const info = rec(await chainFetch(api(network, `${HASKOIN}/address/${encodeURIComponent(address)}/balance`), {}, deps));
    const sats = (big(info.confirmed) ?? 0n) + (big(info.unconfirmed) ?? 0n);
    return answered(network, address, 'haskoin', formatUnits(sats, NETWORKS[network].decimals), { txCount: num(info.txs), isContract: false });
  },
  async transaction(network, hash, deps) {
    const row = rec(await chainFetch(api(network, `${HASKOIN}/transaction/${encodeURIComponent(hash)}`), { cap: BIG_CAP }, deps));
    const decimals = NETWORKS[network].decimals;
    const mined = num(rec(row.block).height);
    let out = 0n;
    for (const o of list(row.outputs).map(rec)) out += big(o.value) ?? 0n;
    return detail(network, hash, 'haskoin', {
      time: isoFromSeconds(row.time),
      value: formatUnits(out, decimals),
      // A transaction dropped from the mempool (double-spent or replaced) is marked deleted.
      status: row.deleted === true ? 'failed' : mined !== null ? 'success' : 'pending',
      fee: units(row.fee, decimals),
      block: mined,
    });
  },
};

const BLOCKCYPHER = '/v1/doge/main';

const blockcypher: Family = {
  async activity(network, address, deps) {
    const info = rec(await chainFetch(api(network, `${BLOCKCYPHER}/addrs/${encodeURIComponent(address)}/balance`), {}, deps));
    return answered(network, address, 'blockcypher', units(info.final_balance, NETWORKS[network].decimals), { txCount: num(info.final_n_tx), isContract: false });
  },
  async transaction(network, hash, deps) {
    const row = rec(await chainFetch(api(network, `${BLOCKCYPHER}/txs/${encodeURIComponent(hash)}?limit=1&includeHex=false`), { cap: BIG_CAP }, deps));
    const decimals = NETWORKS[network].decimals;
    const mined = num(row.block_height);
    return detail(network, hash, 'blockcypher', {
      time: isoFromText(row.confirmed),
      value: units(row.total, decimals),
      status: row.double_spend === true ? 'failed' : mined !== null && mined >= 0 ? 'success' : 'pending',
      fee: units(row.fees, decimals),
      block: mined !== null && mined >= 0 ? mined : null,
      confirmations: num(row.confirmations),
    });
  },
};

const INSIGHT = '/insight-api';

const insight: Family = {
  async activity(network, address, deps) {
    const info = rec(await chainFetch(api(network, `${INSIGHT}/addr/${encodeURIComponent(address)}?noTxList=1`), {}, deps));
    const sats = (big(info.balanceSat) ?? 0n) + (big(info.unconfirmedBalanceSat) ?? 0n);
    return answered(network, address, 'insight', formatUnits(sats, NETWORKS[network].decimals), {
      txCount: (num(info.txApperances) ?? 0) + (num(info.unconfirmedTxApperances) ?? 0),
      isContract: false,
    });
  },
  async transaction(network, hash, deps) {
    const row = rec(await chainFetch(api(network, `${INSIGHT}/tx/${encodeURIComponent(hash)}`), { cap: BIG_CAP }, deps));
    const decimals = NETWORKS[network].decimals;
    const confirmations = num(row.confirmations);
    const mined = num(row.blockheight);
    return detail(network, hash, 'insight', {
      time: isoFromSeconds(row.time),
      value: decimalUnits(row.valueOut, decimals),
      status: confirmations !== null && confirmations > 0 ? 'success' : 'pending',
      fee: decimalUnits(row.fees, decimals),
      block: mined !== null && mined >= 0 ? mined : null,
      confirmations,
    });
  },
};

// ---------- account chains ----------

// The XRP Ledger answers errors inside `result`, so its calls are read here rather than
// through rpc().
async function xrpl(network: ChainNetwork, method: string, params: Record<string, unknown>, deps: ChainDeps, cap = DEFAULT_CAP, ttl?: number): Promise<Record<string, unknown>> {
  return rec(rec(await chainFetch(api(network, '/'), { method: 'POST', body: JSON.stringify({ method, params: [params] }), cap, ttl }, deps)).result);
}

// Ledger times count seconds from 2000-01-01.
const RIPPLE_EPOCH = 946_684_800;

const xrplFamily: Family = {
  async activity(network, address, deps) {
    const result = await xrpl(network, 'account_info', { account: address, ledger_index: 'validated' }, deps);
    // An account that was never sent its reserve does not exist on the ledger yet.
    if (result.error === 'actNotFound') return never(network, address, 'xrpl');
    if (result.error !== undefined) throw new Error(`xrpl ${dataText(result.error, 40)}`);
    return answered(network, address, 'xrpl', units(rec(result.account_data).Balance, NETWORKS[network].decimals), { isContract: false });
  },
  async transaction(network, hash, deps) {
    const result = await xrpl(network, 'tx', { transaction: hash, binary: false }, deps, BIG_CAP);
    if (result.error === 'txnNotFound') throw new Error('no such transaction');
    if (result.error !== undefined) throw new Error(`xrpl ${dataText(result.error, 40)}`);
    const code = rec(result.meta).TransactionResult;
    const date = num(result.date);
    const decimals = NETWORKS[network].decimals;
    return detail(network, hash, 'xrpl', {
      time: date === null ? null : isoFromSeconds(date + RIPPLE_EPOCH),
      from: idText(result.Account),
      to: idText(result.Destination),
      value: units(result.Amount, decimals), // an issued currency is an object, and not the chain's coin
      // A tec code is a transaction the ledger included and charged for that did not do its job.
      status: result.validated !== true ? 'pending' : code === 'tesSUCCESS' ? 'success' : 'failed',
      method: dataText(result.TransactionType) || null,
      fee: units(result.Fee, decimals),
      block: num(result.ledger_index),
    });
  },
};

const toncenter: Family = {
  async activity(network, address, deps) {
    let info: Record<string, unknown>;
    try {
      info = rec(await chainFetch(api(network, `/api/v3/account?address=${encodeURIComponent(address)}`), {}, deps));
    } catch (err) {
      if (isHttp404(err)) return never(network, address, 'toncenter');
      throw err;
    }
    // Every TON wallet is itself a contract, so "is it a contract" says nothing here.
    return answered(network, address, 'toncenter', units(info.balance, NETWORKS[network].decimals), info.status === 'nonexist' ? { txCount: 0 } : {});
  },
  async transaction(network, hash, deps) {
    const answer = rec(await chainFetch(api(network, `/api/v3/transactions?hash=${encodeURIComponent(hash)}&limit=1`), {}, deps));
    const row = rec(list(answer.transactions)[0]);
    if (Object.keys(row).length === 0) throw new Error('no such transaction');
    const d = rec(row.description);
    const compute = rec(d.compute_ph);
    const action = rec(d.action);
    const failed = d.aborted === true || compute.success === false || action.success === false;
    return detail(network, hash, 'toncenter', {
      time: isoFromSeconds(row.now),
      status: failed ? 'failed' : 'success',
      fee: units(row.total_fees, NETWORKS[network].decimals),
      block: num(row.mc_block_seqno),
    });
  },
};

// TRC-20 contracts whose decimals this module knows. The account call returns every token's
// raw balance for free, but a raw integer shown as an amount is a wrong number, so a token
// whose decimals are not known here is left out rather than guessed.
const TRC20: Readonly<Record<string, { symbol: string; name: string; decimals: number }>> = {
  TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t: { symbol: 'USDT', name: 'Tether USD', decimals: 6 },
};

const trongrid: Family = {
  async activity(network, address, deps) {
    const answer = rec(await chainFetch(api(network, `/v1/accounts/${encodeURIComponent(address)}`), {}, deps));
    const account = rec(list(answer.data)[0]);
    // Tron creates an account on its first incoming transfer; before that the list is empty.
    if (Object.keys(account).length === 0) return { ...never(network, address, 'trongrid'), tokens: [], tokensSource: 'trongrid' };
    const tokens: TokenBalance[] = [];
    for (const entry of list(account.trc20).map(rec)) {
      for (const [contract, raw] of Object.entries(entry)) {
        const known = TRC20[contract];
        const amount = known === undefined ? null : units(raw, known.decimals);
        if (known !== undefined && amount !== null) tokens.push({ symbol: known.symbol, name: known.name, amount, contract, usd: null });
      }
    }
    const read = answered(network, address, 'trongrid', units(account.balance, NETWORKS[network].decimals), { lastSeen: isoFromMillis(account.latest_opration_time) });
    return { ...read, tokens, tokensSource: 'trongrid' };
  },
  async transaction(network, hash, deps) {
    const info = rec(await chainFetch(api(network, '/wallet/gettransactioninfobyid'), { method: 'POST', body: JSON.stringify({ value: hash }) }, deps));
    // An empty object is a transaction no block holds: unknown to the chain, or still waiting.
    if (info.blockNumber === undefined) throw new Error('no such transaction in any block yet');
    const receipt = rec(info.receipt).result;
    return detail(network, hash, 'trongrid', {
      time: isoFromMillis(info.blockTimeStamp),
      status: info.result === 'FAILED' || (typeof receipt === 'string' && receipt !== 'SUCCESS') ? 'failed' : 'success',
      fee: units(info.fee ?? 0, NETWORKS[network].decimals),
      block: num(info.blockNumber),
    });
  },
};

// Sui retired JSON-RPC on its public fullnodes; GraphQL is the foundation's read endpoint now.
async function sui(network: ChainNetwork, query: string, variables: Record<string, unknown>, deps: ChainDeps, ttl?: number): Promise<Record<string, unknown>> {
  const answer = rec(await chainFetch(api(network, '/graphql'), { method: 'POST', body: JSON.stringify({ query, variables }), ttl }, deps));
  const errors = list(answer.errors);
  if (errors.length > 0) throw new Error(`graphql ${dataText(rec(errors[0]).message, 80) || 'error'}`);
  return rec(answer.data);
}

const suiFamily: Family = {
  async activity(network, address, deps) {
    const data = await sui(network, 'query ($a: SuiAddress!) { address(address: $a) { balance(coinType: "0x2::sui::SUI") { totalBalance } } }', { a: address }, deps);
    return answered(network, address, 'sui-graphql', units(rec(rec(data.address).balance).totalBalance, NETWORKS[network].decimals));
  },
  async transaction(network, hash, deps) {
    const data = await sui(network, 'query ($d: String!) { transaction(digest: $d) { sender { address } effects { status timestamp checkpoint { sequenceNumber } } } }', { d: hash }, deps);
    const tx = rec(data.transaction);
    if (Object.keys(tx).length === 0) throw new Error('no such transaction');
    const effects = rec(tx.effects);
    return detail(network, hash, 'sui-graphql', {
      time: isoFromText(effects.timestamp),
      from: idText(rec(tx.sender).address),
      status: effects.status === 'SUCCESS' ? 'success' : effects.status === 'FAILURE' ? 'failed' : 'unknown',
      block: num(rec(effects.checkpoint).sequenceNumber),
    });
  },
};

// Aptos and Movement run the same node API; the coin is 0x1::aptos_coin::AptosCoin on both.
const aptos: Family = {
  async activity(network, address, deps) {
    const a = encodeURIComponent(address);
    const [account, balance] = await Promise.all([
      chainFetch(api(network, `/v1/accounts/${a}`), {}, deps).catch((err) => {
        if (isHttp404(err)) return { sequence_number: '0' };
        throw err;
      }),
      chainFetch(api(network, `/v1/accounts/${a}/balance/0x1::aptos_coin::AptosCoin`), {}, deps),
    ]);
    // The sequence number counts the transactions the account has sent.
    return answered(network, address, 'aptos-node', units(balance, NETWORKS[network].decimals), { txCount: num(rec(account).sequence_number) });
  },
  async transaction(network, hash, deps) {
    const row = rec(await chainFetch(api(network, `/v1/transactions/by_hash/${encodeURIComponent(hash)}`), { cap: BIG_CAP }, deps).catch((err) => {
      throw isHttp404(err) ? new Error('no such transaction') : err;
    }));
    const gas = big(row.gas_used);
    const price = big(row.gas_unit_price);
    const micros = big(row.timestamp);
    return detail(network, hash, 'aptos-node', {
      time: micros === null ? null : isoFromMillis(Number(micros / 1000n)),
      from: idText(row.sender),
      status: row.type === 'pending_transaction' ? 'pending' : row.success === true ? 'success' : row.success === false ? 'failed' : 'unknown',
      fee: gas === null || price === null ? null : formatUnits(gas * price, NETWORKS[network].decimals),
    });
  },
};

// PostgREST under Koios: `select` trims the answer to the columns read, which keeps a busy
// address's thousand UTXOs out of the body.
const koios: Family = {
  async activity(network, address, deps) {
    const rows = list(await chainFetch(api(network, '/api/v1/address_info?select=address,balance'), { method: 'POST', body: JSON.stringify({ _addresses: [address] }) }, deps));
    // Koios returns nothing for an address the chain has never seen.
    if (rows.length === 0) return never(network, address, 'koios');
    return answered(network, address, 'koios', units(rec(rows[0]).balance, NETWORKS[network].decimals));
  },
  async transaction(network, hash, deps) {
    const rows = list(await chainFetch(api(network, '/api/v1/tx_info?select=tx_hash,block_height,tx_timestamp,fee,total_output'), {
      method: 'POST',
      body: JSON.stringify({ _tx_hashes: [hash], _inputs: false, _metadata: false, _assets: false, _withdrawals: false, _certs: false, _scripts: false, _bytecode: false }),
    }, deps));
    if (rows.length === 0) throw new Error('no such transaction in any block yet');
    const row = rec(rows[0]);
    const decimals = NETWORKS[network].decimals;
    return detail(network, hash, 'koios', {
      time: isoFromSeconds(row.tx_timestamp),
      value: units(row.total_output, decimals),
      status: num(row.block_height) === null ? 'pending' : 'success',
      fee: units(row.fee, decimals),
      block: num(row.block_height),
    });
  },
};

const horizon: Family = {
  async activity(network, address, deps) {
    let account: Record<string, unknown>;
    try {
      account = rec(await chainFetch(api(network, `/accounts/${encodeURIComponent(address)}`), {}, deps));
    } catch (err) {
      // An account that was never sent its base reserve does not exist yet.
      if (isHttp404(err)) return { ...never(network, address, 'horizon'), tokens: [], tokensSource: 'horizon' };
      throw err;
    }
    const decimals = NETWORKS[network].decimals;
    let native: string | null = null;
    const tokens: TokenBalance[] = [];
    // Horizon lists the account's trustline balances in the same answer, so they come free.
    for (const b of list(account.balances).map(rec)) {
      const amount = decimalUnits(b.balance, decimals);
      if (b.asset_type === 'native') native = amount;
      else if (amount !== null && tokens.length < 10) tokens.push({ symbol: dataText(b.asset_code), name: '', amount, contract: idText(b.asset_issuer), usd: null });
    }
    const read = answered(network, address, 'horizon', native, { lastSeen: isoFromText(account.last_modified_time), isContract: false });
    return { ...read, tokens, tokensSource: 'horizon' };
  },
  async transaction(network, hash, deps) {
    const row = rec(await chainFetch(api(network, `/transactions/${encodeURIComponent(hash)}`), { cap: BIG_CAP }, deps).catch((err) => {
      throw isHttp404(err) ? new Error('no such transaction') : err;
    }));
    return detail(network, hash, 'horizon', {
      time: isoFromText(row.created_at),
      from: idText(row.source_account),
      status: row.successful === true ? 'success' : row.successful === false ? 'failed' : 'unknown',
      fee: units(row.fee_charged, NETWORKS[network].decimals),
      block: num(row.ledger),
    });
  },
};

// The STRK token contract and the selector of balanceOf: an account's STRK is a token balance
// like any other, read with one call.
const STRK_TOKEN = '0x4718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const BALANCE_OF = '0x2e4263afad30923c891518314c3c95dbe830a16874e8abc5777a9a20b54c76e';

// The RPC spells a felt without leading zeros.
function felt(value: string): string {
  return `0x${BigInt(value).toString(16)}`;
}

const starknet: Family = {
  async activity(network, address, deps) {
    const [nonce, balance] = await rpcBatch(api(network, '/'), [
      { method: 'starknet_getNonce', params: ['latest', felt(address)] },
      { method: 'starknet_call', params: [{ contract_address: STRK_TOKEN, entry_point_selector: BALANCE_OF, calldata: [felt(address)] }, 'latest'] },
    ], deps);
    if (balance.error !== undefined) throw new Error(`rpc ${balance.error}`);
    const [low, high] = list(balance.result).map((v) => big(v) ?? 0n);
    // An account holds funds before its contract is deployed; until then the nonce read says
    // "Contract not found", which is an account that has never sent anything.
    const count = nonce.error !== undefined ? (/not found/i.test(nonce.error) ? 0 : null) : big(nonce.result);
    return answered(network, address, 'starknet-rpc', formatUnits((low ?? 0n) + ((high ?? 0n) << 128n), NETWORKS[network].decimals), { txCount: count === null ? null : Number(count) });
  },
  async transaction(network, hash, deps) {
    const receipt = rec(await rpc(api(network, '/'), 'starknet_getTransactionReceipt', [felt(hash)], deps));
    const fee = rec(receipt.actual_fee);
    return detail(network, hash, 'starknet-rpc', {
      status: receipt.execution_status === 'SUCCEEDED' ? 'success' : receipt.execution_status === 'REVERTED' ? 'failed' : 'pending',
      // Old transactions paid in ETH (unit WEI); only a fee in STRK is in this chain's coin.
      fee: fee.unit === 'FRI' ? units(fee.amount, NETWORKS[network].decimals) : null,
      block: num(receipt.block_number),
    });
  },
};

const ALEO = '/v1/mainnet';

const aleo: Family = {
  async activity(network, address, deps) {
    // The public balance only: private records are encrypted to their owner and no API sees them.
    const raw = await chainFetch(api(network, `${ALEO}/program/credits.aleo/mapping/account/${encodeURIComponent(address)}`), {}, deps);
    // No entry in the mapping (null) is no public credit, which says nothing about private use.
    if (raw === null) return answered(network, address, 'provable', '0');
    const micro = typeof raw === 'string' ? /^(\d+)u64$/.exec(raw)?.[1] : undefined;
    if (micro === undefined) throw new Error('the answer was not a balance');
    return answered(network, address, 'provable', units(micro, NETWORKS[network].decimals));
  },
  async transaction(network, hash, deps) {
    const row = rec(await chainFetch(api(network, `${ALEO}/transaction/confirmed/${encodeURIComponent(hash)}`), { cap: ALEO_TX_CAP }, deps).catch((err) => {
      throw isHttp404(err) ? new Error('no such confirmed transaction') : err;
    }));
    return detail(network, hash, 'provable', {
      status: row.status === 'accepted' ? 'success' : row.status === 'rejected' ? 'failed' : 'unknown',
      method: dataText(row.type) || null,
    });
  },
};

const hyperliquid: Family = {
  async activity(network, address, deps) {
    const answer = rec(await chainFetch(api(network, '/info'), { method: 'POST', body: JSON.stringify({ type: 'spotClearinghouseState', user: address.toLowerCase() }) }, deps));
    let native: string | null = null;
    const tokens: TokenBalance[] = [];
    // The spot balances, the chain's coin among them, all in the one answer, each already in
    // whole coins at its own precision.
    for (const b of list(answer.balances).map(rec)) {
      const symbol = dataText(b.coin);
      const amount = decimalText(b.total);
      if (symbol === NETWORKS[network].symbol) native = amount;
      else if (amount !== null && tokens.length < 10) tokens.push({ symbol, name: '', amount, contract: null, usd: null });
    }
    return { ...answered(network, address, 'hyperliquid', native), tokens, tokensSource: 'hyperliquid' };
  },
  async transaction(network, hash, deps) {
    const answer = rec(await chainFetch(`https://${NETWORKS[network].rpc}/explorer`, { method: 'POST', body: JSON.stringify({ type: 'txDetails', hash }) }, deps));
    if (answer.type !== 'txDetails') throw new Error('no such transaction');
    const tx = rec(answer.tx);
    return detail(network, hash, 'hyperliquid', {
      time: isoFromMillis(tx.time),
      from: idText(tx.user),
      status: tx.error === null || tx.error === undefined ? 'success' : 'failed',
      method: dataText(rec(tx.action).type) || null,
      block: num(tx.block),
    });
  },
};

export const FAMILIES: Readonly<Record<Exclude<ReadFamily, 'blockscout' | 'solana' | 'near' | 'esplora'>, Family>> = {
  'evm-rpc': evmRpc,
  haskoin,
  blockcypher,
  insight,
  xrpl: xrplFamily,
  toncenter,
  trongrid,
  sui: suiFamily,
  aptos,
  koios,
  horizon,
  starknet,
  aleo,
  hyperliquid,
};

// ---------- the chain head ----------

// The share of a host's budget chain heads may spend, so the agent's own lookups keep the rest.
export const HEAD_SHARE = 0.2;

// Requests one head read makes where it is more than one: Solana's slot and then its time,
// BlockCypher's chain and then its tip.
const HEAD_CALLS: Partial<Record<ReadFamily, number>> = { solana: 2, blockcypher: 2 };

// The one host a network's head is read from: the RPC beside an indexer where there is one.
export function headHost(network: ChainNetwork): string {
  return NETWORKS[network].rpc ?? NETWORKS[network].api;
}

export function headCalls(network: ChainNetwork): number {
  const family = NETWORKS[network].read;
  return family === null ? 0 : (HEAD_CALLS[family] ?? 1);
}

/* How long a head is kept before it is read again: fifteen seconds, or long enough that head
   reads spend at most HEAD_SHARE of the host's budget, whichever is longer. BlockCypher's 100 an
   hour at two requests a head is one read every six minutes, Blockchain.com's one call per 10 s
   one every 50 s, and every other host's budget clears fifteen seconds. */
export function headTtl(network: ChainNetwork): number {
  return Math.max(HEAD_TTL_MS, Math.round((headCalls(network) / (HEAD_SHARE * ratePerSecond(headHost(network)))) * 1000));
}

// Where each family's chain says it is now: its latest block (or slot, ledger, checkpoint)
// and that block's time, one request wherever the source has one endpoint for both.
export const HEADS: Readonly<Record<ReadFamily, (network: ChainNetwork, deps: ChainDeps) => Promise<Head>>> = {
  blockscout: (network, deps) => evmHead(network, deps),
  'evm-rpc': (network, deps) => evmHead(network, deps),
  // A slot rather than a block height: slots advance while the chain runs and stop when it
  // halts, and the block time needs the slot first.
  solana: async (network, deps) => {
    const slot = height(await rpc(api(network, '/'), 'getSlot', [{ commitment: 'finalized' }], deps, DEFAULT_CAP, HEAD_TTL_MS));
    const time = await rpc(api(network, '/'), 'getBlockTime', [slot], deps).catch(() => null);
    return { height: slot, time: isoFromSeconds(time) };
  },
  near: async (network, deps) => {
    const header = rec(rec(await rpc(api(network, '/'), 'block', { finality: 'final' }, deps, DEFAULT_CAP, HEAD_TTL_MS)).header);
    const nanos = big(header.timestamp);
    return { height: height(header.height), time: nanos === null ? null : isoFromMillis(Number(nanos / 1_000_000n)) };
  },
  esplora: async (network, deps) => {
    const tip = rec(list(await chainFetch(api(network, '/api/blocks'), { ttl: HEAD_TTL_MS }, deps))[0]);
    return { height: height(tip.height), time: isoFromSeconds(tip.timestamp) };
  },
  haskoin: async (network, deps) => {
    const best = rec(await chainFetch(api(network, `${HASKOIN}/block/best?notx=true`), { ttl: HEAD_TTL_MS }, deps));
    return { height: height(best.height), time: isoFromSeconds(best.time) };
  },
  // BlockCypher's chain answer carries the tip's hash, and the tip's own answer its time.
  blockcypher: async (network, deps) => {
    const chain = rec(await chainFetch(api(network, BLOCKCYPHER), { ttl: HEAD_TTL_MS }, deps));
    const hash = typeof chain.hash === 'string' && /^[0-9a-f]{64}$/.test(chain.hash) ? chain.hash : null;
    const block = hash === null ? {} : rec(await chainFetch(api(network, `${BLOCKCYPHER}/blocks/${hash}?txstart=0&limit=1`), {}, deps).catch(() => null));
    return { height: height(chain.height), time: isoFromText(block.time) };
  },
  insight: async (network, deps) => {
    const tip = rec(list(rec(await chainFetch(api(network, `${INSIGHT}/blocks?limit=1`), { ttl: HEAD_TTL_MS }, deps)).blocks)[0]);
    return { height: height(tip.height), time: isoFromSeconds(tip.time) };
  },
  xrpl: async (network, deps) => {
    const ledger = rec((await xrpl(network, 'ledger', { ledger_index: 'validated' }, deps, DEFAULT_CAP, HEAD_TTL_MS)).ledger);
    const close = num(ledger.close_time);
    return { height: height(ledger.ledger_index), time: close === null ? null : isoFromSeconds(close + RIPPLE_EPOCH) };
  },
  toncenter: async (network, deps) => {
    const last = rec(rec(await chainFetch(api(network, '/api/v3/masterchainInfo'), { ttl: HEAD_TTL_MS }, deps)).last);
    return { height: height(last.seqno), time: isoFromSeconds(last.gen_utime) };
  },
  trongrid: async (network, deps) => {
    const raw = rec(rec(rec(await chainFetch(api(network, '/wallet/getblock'), { method: 'POST', body: JSON.stringify({ detail: false }), ttl: HEAD_TTL_MS }, deps)).block_header).raw_data);
    return { height: height(raw.number), time: isoFromMillis(raw.timestamp) };
  },
  sui: async (network, deps) => {
    const checkpoint = rec((await sui(network, '{ checkpoint { sequenceNumber timestamp } }', {}, deps, HEAD_TTL_MS)).checkpoint);
    return { height: height(checkpoint.sequenceNumber), time: isoFromText(checkpoint.timestamp) };
  },
  aptos: async (network, deps) => {
    const info = rec(await chainFetch(api(network, '/v1'), { ttl: HEAD_TTL_MS }, deps));
    const micros = big(info.ledger_timestamp);
    return { height: height(info.block_height), time: micros === null ? null : isoFromMillis(Number(micros / 1000n)) };
  },
  koios: async (network, deps) => {
    const tip = rec(list(await chainFetch(api(network, '/api/v1/tip'), { ttl: HEAD_TTL_MS }, deps))[0]);
    return { height: height(tip.block_no), time: isoFromSeconds(tip.block_time) };
  },
  horizon: async (network, deps) => {
    const root = rec(await chainFetch(api(network, '/'), { ttl: HEAD_TTL_MS }, deps));
    return { height: height(root.history_latest_ledger), time: isoFromText(root.history_latest_ledger_closed_at) };
  },
  starknet: async (network, deps) => {
    const block = rec(await rpc(api(network, '/'), 'starknet_getBlockWithTxHashes', ['latest'], deps, DEFAULT_CAP, HEAD_TTL_MS));
    return { height: height(block.block_number), time: isoFromSeconds(block.timestamp) };
  },
  // Aleo's API gives the height alone; the block that carries the time is hundreds of
  // kilobytes of proofs, too much to fetch for one timestamp.
  aleo: async (network, deps) => ({ height: height(await chainFetch(api(network, `${ALEO}/latest/height`), { ttl: HEAD_TTL_MS }, deps)), time: null }),
  // HyperCore's own explorer has no head call; HyperEVM's blocks come out of the same
  // consensus and stop when it stops.
  hyperliquid: (network, deps) => evmHead(network, deps, NETWORKS[network].rpc, '/evm'),
};
