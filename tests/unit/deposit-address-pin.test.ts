// The pins file, <dataDir>/deposit-addresses.json, is what the app up to 0.11.5 wrote when it drew
// the POA bridge's standing deposit address for an (account, network). No address is drawn from it
// any more and nothing writes it: every deposit address is a one-time 1Click quote now
// (src/rails/deposit-quote.ts). It is read for one thing only, so a payout to one of those old
// addresses is refused by name (ownDepositsOn), because a person may have saved one on an exchange.
// A file that cannot be read is no rows, and a payout is never made to wait on it.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { depositAddressProblem, intentsReceiveReport } from '../../src/http/wallet.ts';
import { openDeposit } from '../../src/http/deposit-open.ts';
import type { ResolvedDeposit } from '../../src/http/deposit-open.ts';
import { DEPOSIT_PINS_FILE, createDepositBook, depositBookPath, depositPinsPath, ownDepositsOn, standingAddresses } from '../../src/rails/deposit-quote.ts';
import type { OneTimeDeposit } from '../../src/rails/deposit-quote.ts';
import { receiveNetworkOf } from '../../src/rails/intents-address.ts';
import type { Ctx } from '../../src/http/context.ts';
import { tempDir } from './helpers/tmp.ts';

type Any = Record<string, any>;

const ACCOUNT = '0x00000000000000000000000000000000000020aa';
const EVM = '0xb583f41992cd21b2f2345e194a36d33684bb5db0';
const OTHER_EVM = '0x9999999999999999999999999999999999999999';
const XRP = 'rp6s4fyjoCzjZ7Pukt46UVek9LQq1X2xHe';
const STELLAR = 'GDJ4JZXZELZD737NVFORH4PSSQDWFDZTKW3AIDKHYQG23ZXBPDGGQBJK';

function pinsIn(dir: string, body: unknown): string {
  const file = depositPinsPath(dir);
  fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
  return file;
}

test('the pins file lives at deposit-addresses.json in the data folder', () => {
  const dir = tempDir('phosphor-pin-');
  assert.equal(DEPOSIT_PINS_FILE, 'deposit-addresses.json');
  assert.equal(depositPinsPath(dir), path.join(dir, 'deposit-addresses.json'));
});

test('standingAddresses reads each `${account}|${bridgeKey}` row as its account, network, address and memo', () => {
  const dir = tempDir('phosphor-pin-');
  pinsIn(dir, {
    [`${ACCOUNT}|eth:1`]: { address: EVM, memo: null, shownAt: '2026-09-17T00:00:00Z' },
    [`${ACCOUNT}|stellar:mainnet`]: { address: STELLAR, memo: '177690326', shownAt: '2026-09-17T00:00:00Z' },
    // An older row with no memo field and no shownAt is still an address.
    [`${OTHER_EVM}|xrp:mainnet`]: { address: XRP },
  });
  assert.deepEqual(standingAddresses(dir), [
    { account: ACCOUNT, network: 'eth:1', address: EVM, memo: null },
    { account: ACCOUNT, network: 'stellar:mainnet', address: STELLAR, memo: '177690326' },
    { account: OTHER_EVM, network: 'xrp:mainnet', address: XRP, memo: null },
  ]);
});

test('bad rows are skipped and the good ones kept, and a memo that is not a string is no memo', () => {
  const dir = tempDir('phosphor-pin-');
  pinsIn(dir, {
    'no-separator': { address: EVM, memo: null },
    '|eth:1': { address: EVM, memo: null },
    [`${ACCOUNT}|eth:8453`]: null,
    [`${ACCOUNT}|eth:42161`]: 'just a string',
    [`${ACCOUNT}|sol:mainnet`]: { memo: null },
    [`${ACCOUNT}|near:mainnet`]: { address: '' },
    [`${ACCOUNT}|btc:mainnet`]: { address: 12345 },
    // The bridge once sent an XRP memo as a number: the row is kept, the memo is not.
    [`${ACCOUNT}|xrp:mainnet`]: { address: XRP, memo: 177690326 },
    [`${ACCOUNT}|eth:1`]: { address: EVM, memo: null },
  });
  assert.deepEqual(standingAddresses(dir), [
    { account: ACCOUNT, network: 'xrp:mainnet', address: XRP, memo: null },
    { account: ACCOUNT, network: 'eth:1', address: EVM, memo: null },
  ]);
});

test('a missing, unreadable or wrongly shaped pins file is no rows', () => {
  const missing = tempDir('phosphor-pin-');
  assert.deepEqual(standingAddresses(missing), []);
  for (const body of ['not json', '', '[]', 'null', '"a string"', '42', JSON.stringify([{ address: EVM }])]) {
    const dir = tempDir('phosphor-pin-');
    pinsIn(dir, body);
    assert.deepEqual(standingAddresses(dir), [], `file ${JSON.stringify(body)}`);
  }
  // A folder where the file should be cannot be read either.
  const folder = tempDir('phosphor-pin-');
  fs.mkdirSync(depositPinsPath(folder));
  assert.deepEqual(standingAddresses(folder), []);
  // The payout check refuses on a pins file that is there and cannot be read, rather than reading it as empty.
  assert.equal(ownDepositsOn(folder, 'eth'), null);
  assert.deepEqual(ownDepositsOn(missing, 'eth'), [], 'no file at all is nothing pinned');
});

test('the payout check reads the pins as standing addresses of every account, on the chains of the payout chain\'s family', () => {
  const dir = tempDir('phosphor-pin-');
  pinsIn(dir, {
    [`${ACCOUNT}|eth:8453`]: { address: EVM, memo: null },
    [`${OTHER_EVM}|eth:1`]: { address: OTHER_EVM, memo: null },
    [`${ACCOUNT}|xrp:mainnet`]: { address: XRP, memo: '7' },
    // A bridge key no network of the app's carries is nobody's.
    [`${ACCOUNT}|madeup:mainnet`]: { address: EVM, memo: null },
  });
  const onArb = ownDepositsOn(dir, 'arb');
  assert.deepEqual(onArb, [
    { address: EVM, memo: null, kind: 'standing', network: 'base', deadline: null },
    { address: OTHER_EVM, memo: null, kind: 'standing', network: 'eth', deadline: null },
  ]);
  assert.deepEqual(ownDepositsOn(dir, 'xrp'), [{ address: XRP, memo: '7', kind: 'standing', network: 'xrp', deadline: null }]);
  assert.deepEqual(ownDepositsOn(dir, 'sol'), []);
});

/* Nothing in the app writes the pins file any more: not the receive report, not a card that mints
   and books a one-time address, not the payout check that reads it. Byte for byte and to the
   millisecond, it is the file it was; and where there was none, none is made. */
test('the pins file is never written: the receive report, a card open and the payout check leave it byte-identical', async () => {
  const dir = tempDir('phosphor-pin-');
  const file = pinsIn(dir, { [`${ACCOUNT}|eth:1`]: { address: EVM, memo: null, shownAt: '2026-09-17T00:00:00Z' } });
  const past = new Date('2026-09-17T00:00:00Z');
  fs.utimesSync(file, past, past);
  const bytes = fs.readFileSync(file);
  const mtime = fs.statSync(file).mtimeMs;

  const shown: string[] = [];
  const ctxOf = (dataDir: string): Ctx =>
    ({
      cfg: { mode: 'live', dataDir },
      keystore: { addressReport: () => ({ addresses: { evm: ACCOUNT, solana: null, near: null }, verified: true, tampered: false }) },
      depositBook: createDepositBook(dataDir),
      depositQuotes: {
        tokens: async () => [],
        mint: async (): Promise<OneTimeDeposit> => ({
          account: ACCOUNT, chain: 'base', network: 'eth:8453', symbol: 'USDC', assetId: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
          decimals: 6, address: OTHER_EVM, memo: null, minimumBase: '160000', minimum: '0.16', deadline: new Date(Date.now() + 86_400_000).toISOString(),
          coldAt: null, mintedAt: new Date().toISOString(), correlationId: 'c-1', signature: null, timestamp: null,
        }),
        status: async () => ({ found: false }),
      },
      deposits: { held: () => null, current: () => null, show: (_chain: string, _symbol: string, address: string) => { shown.push(address); return {}; } },
      audit: { append: () => undefined },
    }) as unknown as Ctx;
  const got = {
    ok: true,
    chain: 'base',
    account: ACCOUNT,
    network: { id: 'base' },
    token: { symbol: 'USDC', assetId: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near', decimals: 6, contract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
    notice: null,
    statusLink: null,
  } as unknown as ResolvedDeposit;

  const ctx = ctxOf(dir);
  const report = (await intentsReceiveReport(ctx)) as Any;
  assert.ok(report.networks.length > 0);
  assert.ok(report.networks.every((n: Any) => n.address === null), 'a pinned address was drawn on the receive report');
  const opened = await openDeposit(ctx, got, 'window');
  assert.equal(opened.ok, true, JSON.stringify(opened));
  assert.deepEqual(shown, [OTHER_EVM], 'the card showed something other than the minted address');
  assert.ok(fs.existsSync(depositBookPath(dir)), 'the card did not book its address');
  assert.equal(ownDepositsOn(dir, 'eth')!.length, 2);

  assert.ok(fs.readFileSync(file).equals(bytes), 'the pins file changed');
  assert.equal(fs.statSync(file).mtimeMs, mtime, 'the pins file was rewritten');

  // A Mac that never had a pins file does not get one.
  const fresh = tempDir('phosphor-pin-');
  const ctx2 = ctxOf(fresh);
  await intentsReceiveReport(ctx2);
  assert.equal((await openDeposit(ctx2, got, 'agent')).ok, true);
  ownDepositsOn(fresh, 'base');
  assert.equal(fs.existsSync(depositPinsPath(fresh)), false, 'a pins file was made');
});

test('depositAddressProblem rules by the chain where it knows one and by plainness where it does not', () => {
  const eth = receiveNetworkOf('eth')!;
  const sol = receiveNetworkOf('sol')!;
  const near = receiveNetworkOf('near')!;
  const btc = receiveNetworkOf('btc')!;
  const xrp = receiveNetworkOf('xrp')!;
  assert.equal(depositAddressProblem(eth, EVM), null);
  assert.match(String(depositAddressProblem(eth, '0xB583f41992Cd21b2F2345e194a36D33684BB5DB0')), /checksum/);
  assert.match(String(depositAddressProblem(eth, 'deposit-for-you.near')), /expected 0x followed by 40 hex/);
  assert.equal(depositAddressProblem(sol, 'So11111111111111111111111111111111111111112'), null);
  assert.match(String(depositAddressProblem(sol, EVM)), /not a Solana address/);
  assert.equal(depositAddressProblem(near, 'deposit-for-you.near'), null);
  assert.match(String(depositAddressProblem(near, 'Deposit.near')), /not a NEAR account id/);
  assert.equal(depositAddressProblem(btc, 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'), null);
  assert.match(String(depositAddressProblem(btc, 'addr-for-btc:mainnet')), /not a Bitcoin address/);
  assert.equal(depositAddressProblem(xrp, 'rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH'), null);
  assert.match(String(depositAddressProblem(xrp, 'send it here please')), /no spaces/);
  assert.match(String(depositAddressProblem(xrp, 'short')), /10 to 128/);
});
