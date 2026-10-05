// One Mac whose vault moved to the chip, for the allowance tests (PHASE2-PLAN.md U9).
//
// The app's own parts wherever money or a key is involved: the keystore (the published test owner
// key in an enclave-wrapped file, a software P-256 key playing the enclave), its owner key gate, the
// relay with a chip service behind it (src/vault/chip.ts asks it), the accounts, the vault
// submitter, the allowance service, the relay swap rail, the top-up rail and the proposal service.
// The chain is the intents double (tests/unit/helpers/intents-double.ts): every top-up and sweep is
// simulated, executed and read back there, to the base unit. The swap relay is faked, and applies
// the signed diff on the double only when the diff is signed by the account it spends. Nothing here
// asks for a real Touch ID or touches real money.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { createAudit } from '../../../src/audit.ts';
import type { Audit } from '../../../src/audit.ts';
import { base58Encode } from '../../../src/chain/near.ts';
import type { OneClickClient, OneClickQuote, OneClickQuoteParams, OneClickToken, TokensFile } from '../../../src/intents.ts';
import { liveIntentsSigner, useRailAccounts } from '../../../src/intents-sign.ts';
import { createKeystore, useKeystore } from '../../../src/keystore/index.ts';
import { seUnwrapWithSoftwareKey } from '../../../src/keystore/sewrap.ts';
import type { Keystore } from '../../../src/keystore/store.ts';
import { loadDemoLedger } from '../../../src/ledger/demo.ts';
import type { Ledger } from '../../../src/ledger/index.ts';
import type { IntentsHolding, IntentsRead } from '../../../src/ledger/intents.ts';
import { savePolicy } from '../../../src/policy/file.ts';
import { createProposalService } from '../../../src/proposals.ts';
import { isRailKind } from '../../../src/rails/index.ts';
import { intentsRelayRail } from '../../../src/rails/intents-relay.ts';
import { ReasonError } from '../../../src/rails/reasons.ts';
import { vaultTopUpRail } from '../../../src/rails/vault-topup.ts';
import type { RelayClient, RelayPublishResult, RelayStatus } from '../../../src/relay/client.ts';
import { createStore } from '../../../src/store.ts';
import type { Store } from '../../../src/store.ts';
import type { AppConfig, LedgerSnapshot, Policy, Proposal, Rail, RailHooks, RiskRow, WriteDraft } from '../../../src/types.ts';
import { createAccounts } from '../../../src/vault/accounts.ts';
import type { AccountsPort } from '../../../src/vault/accounts.ts';
import { createAllowance, moveSpend } from '../../../src/vault/allowance.ts';
import type { AllowanceService } from '../../../src/vault/allowance.ts';
import { chipStatusReader, commitChip, createChip, ownerKeyGate } from '../../../src/vault/chip.ts';
import { createVaultPrefs } from '../../../src/vault/prefs.ts';
import type { VaultPrefs } from '../../../src/vault/prefs.ts';
import { createVaultRelay } from '../../../src/vault/relay.ts';
import type { VaultRelay, VaultRequest } from '../../../src/vault/relay.ts';
import { createVaultSubmitter, memoryJournal } from '../../../src/vault/submit.ts';
import type { VaultSubmitter } from '../../../src/vault/submit.ts';
import { DERIVED_VECTORS } from '../../fixtures/derived-keys.ts';
import { SoftwareChipService, serve } from './chip-fake.ts';
import type { Answer } from './chip-fake.ts';
import { createIntentsDouble } from './intents-double.ts';
import type { IntentsDouble } from './intents-double.ts';
import { seededPolicy } from './proposals.ts';
import { signerOf } from './rail-kinds.ts';
import { TEST_QUOTE_KEY, signQuote } from './signed-quote.ts';
import { tempDir } from './tmp.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const riskRows = (JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'risk-table.json'), 'utf8')) as { rows: RiskRow[] }).rows;

export const V = DERIVED_VECTORS[0]!;
export const USDC = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
export const USDT = 'nep141:usdt.tether-token.near';
// A coin nothing prices: not a stable, no spot price, and 1Click lists no price for it.
export const ODD = 'nep141:odd.coin.near';
export const SINK = '0x5151515151515151515151515151515151515151';
// One NEAR, in yocto: more than any test's sends burn.

export const TOKENS: TokensFile = {
  eth: {},
  base: {},
  arb: {},
  sol: {},
  near: {
    USDC: { tokenId: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', decimals: 6 },
    USDT: { tokenId: 'usdt.tether-token.near', decimals: 6 },
  },
};
const LIST = [
  { assetId: USDC, decimals: 6, blockchain: 'near', symbol: 'USDC', contractAddress: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', price: 1 },
  { assetId: USDT, decimals: 6, blockchain: 'near', symbol: 'USDT', contractAddress: 'usdt.tether-token.near', price: 1 },
] as OneClickToken[];
const COINS: { assetId: string; symbol: string; decimals: number }[] = [
  { assetId: USDC, symbol: 'USDC', decimals: 6 },
  { assetId: USDT, symbol: 'USDT', decimals: 6 },
  { assetId: ODD, symbol: 'ODD', decimals: 6 },
];

// 1Click's signed dry price, a dollar a coin and one out for one in: what the relay rail checks the relay's quote by.
export function signedPrice(): OneClickClient {
  const units = (base: string): string => (Number(base) / 1e6).toFixed(6);
  return {
    tokens: async () => LIST,
    async quote(params: OneClickQuoteParams) {
      const quoteRequest = {
        dry: params.dry,
        swapType: 'EXACT_INPUT',
        slippageTolerance: params.slippageToleranceBps,
        originAsset: params.originAsset,
        depositType: params.depositType,
        destinationAsset: params.destinationAsset,
        amount: params.amount,
        refundTo: params.refundTo,
        refundType: params.refundType,
        recipient: params.recipient,
        recipientType: params.recipientType,
        deadline: new Date(Date.now() + 600_000).toISOString(),
        referral: 'phosphor',
      };
      const quote = { amountIn: params.amount, amountInFormatted: units(params.amount), amountInUsd: units(params.amount), minAmountIn: params.amount, amountOut: params.amount, amountOutFormatted: units(params.amount), amountOutUsd: units(params.amount), minAmountOut: params.amount, timeEstimate: 10 };
      const raw = signQuote({ quoteRequest, quote });
      return { quote: raw['quote'] as OneClickQuote, quoteRequest: raw['quoteRequest'], raw };
    },
  } as unknown as OneClickClient;
}

/* The solver relay, faked: a quote of 0.980998 out for one in, and a publish that runs the signed
   token_diff on the chain double, both sides, but only when the erc191 signature recovers to the
   account the diff spends: a signature by anyone else moves nothing, as the verifier would refuse it. */
export function fakeRelay(chain: IntentsDouble, publishes: { payload: string; signer: string }[]): RelayClient {
  return {
    async quote(req) {
      const amountOut = (BigInt(req.exactAmountIn) * 980_998n) / 1_000_000n;
      return [{ quoteHash: base58Encode(crypto.randomBytes(32)), assetIn: req.assetIn, assetOut: req.assetOut, amountIn: req.exactAmountIn, amountOut: amountOut.toString(), expirationTime: new Date(Date.now() + 60_000).toISOString() }];
    },
    async publishIntent(req): Promise<RelayPublishResult> {
      const body = JSON.parse(req.payload) as { signer_id: string; intents: { diff: Record<string, string> }[] };
      const signer = (await signerOf(req.payload, req.signature)).toLowerCase();
      publishes.push({ payload: req.payload, signer });
      if (signer !== body.signer_id.toLowerCase()) throw new Error('the diff is not signed by the account it spends');
      const diff = Object.entries(body.intents[0]!.diff);
      for (const [asset, amount] of diff) if (amount.startsWith('-') && chain.balanceOf(signer, asset) < -BigInt(amount)) throw new Error('insufficient balance');
      for (const [asset, amount] of diff) chain.fund(signer, asset, BigInt(amount));
      return { status: 'OK', intentHash: base58Encode(crypto.randomBytes(32)) };
    },
    async status(intentHash): Promise<RelayStatus> {
      return { intentHash, status: 'SETTLED', statusDetails: null, nearTxHash: base58Encode(crypto.randomBytes(32)), filledAmounts: [] };
    },
  };
}

/* A spend rail for the drafts whose real rails reach 1Click (a send, a payout, a Hyperliquid
   deposit): it signs through the app's own intents signer for the account the draft names, and the
   double moves the coins only when the signature recovers to that account. */
function spendRail(kind: 'intents_send' | 'intents_pay' | 'hl_deposit', chain: IntentsDouble, keysPath: string, signed: string[]): Rail {
  return {
    kind,
    valueUsd: (d) => (d as { amountUsd: number }).amountUsd,
    async simulate() {
      const coin = { assetId: USDC, decimals: 6 };
      return { ok: true, summary: 'a test spend rail', assets: { origin: coin, destination: coin } };
    },
    async execute(draft: WriteDraft, _id?: string, hooks?: RailHooks) {
      const spend = moveSpend(draft);
      const from = (draft as { from: string }).from.toLowerCase();
      if (spend === null) throw new ReasonError('invalid_request', 'no coin pinned');
      const held = chain.balanceOf(from, spend.asset);
      if (held < spend.base) throw new ReasonError('insufficient_balance', `holds ${held}, less than ${spend.base}; nothing was signed`);
      hooks?.lastCheck?.();
      const payload = JSON.stringify({ signer_id: from, intents: [{ intent: 'transfer', receiver_id: SINK, tokens: { [spend.asset]: spend.base.toString() } }], nonce: crypto.randomBytes(8).toString('hex') });
      const signature = await liveIntentsSigner.signErc191(keysPath, payload);
      const signer = (await signerOf(payload, signature)).toLowerCase();
      signed.push(signer);
      if (signer !== from) throw new Error('signed by another account; the verifier would refuse it');
      chain.fund(from, spend.asset, -spend.base);
      chain.fund(SINK, spend.asset, spend.base);
      return { ok: true, detail: `${kind} of ${spend.base} sent`, txids: [base58Encode(crypto.randomBytes(32))] };
    },
  } as Rail;
}

/* The ledger the app reads, off the double: both accounts' coins with their exact base units, each
   read stamped later than the last, and its listeners told after every refresh. */
export function doubleLedger(chain: IntentsDouble, accounts: () => string[]): Ledger & { reread(): void } {
  const snapshot: LedgerSnapshot = { ...loadDemoLedger(), mode: 'live' };
  const listeners = new Set<() => void>();
  let last = 0;
  let read: IntentsRead = { ok: true, holdings: [], fetchedAt: new Date().toISOString(), failures: 0 };
  const reread = (): void => {
    const holdings: IntentsHolding[] = [];
    for (const account of accounts()) {
      for (const coin of COINS) {
        const base = chain.balanceOf(account, coin.assetId);
        if (base > 0n) holdings.push({ accountId: account.toLowerCase(), assetId: coin.assetId, symbol: coin.symbol, originChain: 'near', amount: Number(base) / 10 ** coin.decimals, amountBase: base.toString(), decimals: coin.decimals, priceUsd: null });
      }
    }
    last = Math.max(Date.now(), last + 1);
    read = { ok: true, holdings, fetchedAt: new Date(last).toISOString(), failures: 0 };
  };
  reread();
  return {
    snapshot: () => snapshot,
    intents: () => read,
    hyperliquid: () => undefined,
    async refresh() {
      reread();
      for (const fn of [...listeners]) fn();
      return snapshot;
    },
    onRefresh(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    reread,
  };
}

type ChipService = { run(request: VaultRequest): Answer | Promise<Answer>; signatures?: number };

/* The proposal store kept in memory: what a thousand-row test runs on, where the file store's
   whole-file rewrite on every write is the time. Same contract: copies in and out, every write
   counted and told. */
function memoryRows(): Store {
  const rows = new Map<string, Proposal>();
  const listeners = new Set<(p: Proposal) => void>();
  let revision = 0;
  return {
    // Shallow copies: every caller spreads a row into a new one rather than editing it.
    list: () => [...rows.values()].map((p) => ({ ...p })),
    get: (id) => {
      const p = rows.get(id);
      return p === undefined ? undefined : structuredClone(p);
    },
    put(p) {
      rows.set(p.id, structuredClone(p));
      revision += 1;
      for (const fn of [...listeners]) fn(structuredClone(p));
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    revision: () => revision,
    intact: (id) => rows.has(id),
  };
}

export type AllowanceWorld = {
  chain: IntentsDouble;
  keys: Keystore;
  keysPath: string;
  prefs: VaultPrefs;
  relay: VaultRelay;
  accounts: AccountsPort;
  submitter: VaultSubmitter;
  allowance: AllowanceService;
  svc: ReturnType<typeof createProposalService>;
  rows: Store;
  audit: Audit;
  ledger: Ledger & { reread(): void };
  dataDir: string;
  vault: string; // lowercased
  account: string; // the allowance, lowercased
  chip: { keyRef: string; publicKey: string };
  publishes: { payload: string; signer: string }[];
  spends: string[];
  policy(edit: (p: Policy) => void): void;
  stop(): Promise<void>;
};

/* `service`: the chip service behind the relay, SoftwareChipService unless a test hands U5's stand-in.
   `now`: the clock the vault payloads are dated by, the double's unless given. */
export async function allowanceWorld(opts: { service?: ChipService; start?: number; sizeUsd?: number; vaultUsdc?: bigint; allowanceUsdc?: bigint; policy?: (p: Policy) => void; memory?: boolean } = {}): Promise<AllowanceWorld> {
  const dir = tempDir('phosphor-allowance-');
  fs.mkdirSync(path.join(dir, 'state'));
  const dataDir = path.join(dir, 'state');
  const keysPath = path.join(dir, 'keys.json');
  const prefs = createVaultPrefs(dataDir);
  const relay = createVaultRelay({ transportKey: crypto.randomBytes(32), makesKeys: true });
  const service = opts.service ?? new SoftwareChipService();
  const shell = serve(relay, service);
  const chain = createIntentsDouble(opts.start === undefined ? {} : { start: opts.start });

  // The wallet: the vector's owner key, enclave-wrapped, a software P-256 key playing the enclave.
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = pair.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const x963 = Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  const keys = createKeystore({ keysPath, kdf: () => ({ name: 'scrypt', N: 2 ** 14, r: 8, p: 1, salt: crypto.randomBytes(16).toString('hex') }) });
  keys.keepOwnerKeyOutWhen(ownerKeyGate(() => prefs.get(), relay, chain.verifier));
  keys.importWithEnclave({ keyBlob: crypto.randomBytes(427).toString('base64'), publicKey: x963.toString('base64'), createdAt: new Date().toISOString() }, { keys: { evm: `0x${V.old}` } });
  keys.lock();
  const accounts = createAccounts({ keystore: keys, prefs, chipStatus: chipStatusReader(relay) });
  useKeystore(keys);
  useRailAccounts(accounts.accounts);

  // The rekey's end state (U10 makes it): the chip and the paper key on the vault, vault.json naming the chip.
  const vault = V.vault.toLowerCase();
  const account = V.allowance.toLowerCase();
  const recovery = `secp256k1:${base58Encode(Buffer.from(privateKeyToAccount(generatePrivateKey()).publicKey.slice(4), 'hex'))}`;
  const made = await createChip(relay);
  assert.ok(made.ok, JSON.stringify(made));
  const committed = await commitChip(relay, { keyRef: made.keyRef, account: vault, allowance: account, recovery });
  assert.ok(committed.ok, JSON.stringify(committed));
  const chip = { keyRef: made.keyRef, publicKey: made.publicKey };
  chain.addKey(vault, made.publicKey);
  chain.addKey(vault, recovery);
  prefs.setChip({ ...chip, account: vault });
  if (opts.sizeUsd !== undefined) prefs.setAllowanceSize(opts.sizeUsd);

  // Open, through the enclave stand-in, and let the service say the vault moved.
  const request = keys.enclaveRequest();
  assert.ok(request !== null);
  assert.deepEqual(keys.unlockWithDataKey(seUnwrapWithSoftwareKey({ ephemeralPublicKey: request.ephemeralPublicKey, ciphertext: request.ciphertext }, pair.privateKey, Buffer.from(request.aad, 'base64'))), { ok: true });
  const now = await accounts.refresh();
  assert.equal(now.kind, 'chip', JSON.stringify(now));
  assert.equal(now.spend, V.allowance);

  chain.fund(vault, USDC, opts.vaultUsdc ?? 1_850_000_000n);
  if ((opts.allowanceUsdc ?? 0n) > 0n) chain.fund(account, USDC, opts.allowanceUsdc!);

  const submitter = createVaultSubmitter({
    verifier: chain.verifier,
    relay: chain.relay,
    journal: memoryJournal(),
    now: chain.now,
    sleep: chain.near.sleep,
  });
  const allowance = createAllowance({ accounts, prefs, relay, verifier: chain.verifier, submitter, now: chain.now, sleep: chain.near.sleep });

  const publishes: { payload: string; signer: string }[] = [];
  const spends: string[] = [];
  const swap = intentsRelayRail({
    keysPath,
    tokens: TOKENS,
    relay: fakeRelay(chain, publishes),
    client: signedPrice(),
    quoteKey: TEST_QUOTE_KEY,
    verifier: chain.verifier,
    sleepImpl: async () => {},
    settleSchedule: { firstMs: 1, maxMs: 1, timeoutMs: 50 },
  }) as Rail;
  const table = new Map<WriteDraft['kind'], Rail>([
    ['swap', swap],
    ['vault_top_up', vaultTopUpRail({ allowance }) as Rail],
    ['intents_send', spendRail('intents_send', chain, keysPath, spends)],
    ['intents_pay', spendRail('intents_pay', chain, keysPath, spends)],
    ['hl_deposit', spendRail('hl_deposit', chain, keysPath, spends)],
  ]);

  const ledger = doubleLedger(chain, () => [vault, account]);
  const policy = seededPolicy();
  opts.policy?.(policy);
  savePolicy(dataDir, policy);
  const cfg: AppConfig = { mode: 'live', port: 4177, addresses: {}, candleProducts: [], dataDir, keysPath };
  const audit = createAudit(dataDir);
  // As src/main.ts does: every executed line re-reads the ledger.
  audit.subscribe((event) => {
    if (event.type === 'executed') void ledger.refresh();
  });
  const rows = opts.memory === true ? memoryRows() : createStore(dataDir);
  const svc = createProposalService({
    cfg,
    audit,
    store: rows,
    ledger,
    riskRows,
    rails: { for: (draft) => table.get(draft.kind) ?? null, kinds: () => [...table.keys()].filter(isRailKind) },
    dataDir,
    keystore: keys,
    allowance,
  });

  return {
    chain,
    keys,
    keysPath,
    prefs,
    relay,
    accounts,
    submitter,
    allowance,
    svc,
    rows,
    audit,
    ledger,
    dataDir,
    vault,
    account,
    chip,
    publishes,
    spends,
    policy(edit) {
      const next = seededPolicy();
      edit(next);
      savePolicy(dataDir, next);
    },
    async stop() {
      await shell.stop();
      relay.stop();
      useRailAccounts(null);
      useKeystore(null);
    },
  };
}
