// The intents-native swap rail: the funds already sit inside the verifier contract, and a
// swap is authorised by a signed message rather than by moving money.
//
// WHICH RAIL DO I WANT? Read this paragraph and you will know.
//
// src/rails/oneclick.ts swaps money that lives in your wallet. It asks 1Click for a quote,
// 1Click mints a brand new deposit address for that one quote, and the app sends an ERC-20
// transfer to it. That address is chosen by a remote server, exists only for a few days, and
// is different every time, so it can never appear on a policy allowlist written in advance.
// The app therefore hands real money to a destination the policy engine cannot check. The
// allowlist entry for that rail is the venue string, not an address, because no address of
// its own could ever be listed.
//
// This rail swaps money that already lives inside `intents.near`, the NEAR Intents verifier
// contract. Nothing is transferred to start a swap. The app asks for a quote with
// depositType INTENTS, asks the API to generate the intent that expresses the swap, checks
// that intent against the draft a human approved, signs it with the EVM key the app already
// holds, and submits the signature. The verifier moves balances on its own internal ledger.
//
// The security consequence is the reason this rail exists. Because there is no outbound
// transfer, there is no per-quote destination to govern, and the counterparty is the single
// fixed account `intents.near` for every swap forever. That is a value a human can put on
// the policy allowlist once and leave there, and it is the value evaluateRail actually
// checks. The unverifiable destination is not verified better here; it stops existing.
//
// What replaces it as the thing to be careful about: the API hands back an intent payload
// and we sign it. A signature over a payload we did not read is exactly as dangerous as a
// transfer to an address we did not check, so the payload is treated as hostile data. It is
// parsed with JSON.parse and never evaluated, it never chooses an address, it must name the
// hardcoded verifier account, and its amounts and asset ids are compared against the draft
// before the key is touched. A server that returns a payload swapping a different asset, or
// a payload carrying a withdrawal to somebody else's account, is refused unsigned.
//
// THIS RAIL IS MAINNET ONLY, for the same reason oneclick.ts is, and the evidence is the
// contract itself. On mainnet `intents.near` holds ~10.6 GB of state under code hash
// HUJ89jxFhsXF17XS8L5kmxz7te8AKfdWw2xzrVYo7aoj. On testnet `intents.testnet` reports
// code_hash 11111111111111111111111111111111, which is NEAR's all-ones sentinel for an
// account that has never had code deployed. There is no verifier to sign an intent for on
// testnet, so execute() refuses on any other network before it does anything else.
//
// IT ALSO NEEDS A PARTNER API KEY, which oneclick.ts does not. Quoting is unauthenticated,
// but POST /v0/generate-intent and POST /v0/submit-intent both require an X-API-Key, and
// those two calls are the entire rail. A missing key is therefore refused at simulate()
// time, naming what to obtain, rather than surfacing as a confusing 401 at the moment of
// signing.

import fs from 'node:fs';
import { formatUnits, hexToBytes } from 'viem';
import type { Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Network, Rail, RailResult, SimulationResult, SwapDraft } from '../types.ts';
import {
  ONECLICK_BASE,
  ONECLICK_TERMINAL,
  assetIdFor,
  oneClickClient,
  oneLine,
  toBaseUnits,
} from '../intents.ts';
import type { OneClickQuote, OneClickStatus, OneClickToken, TokensFile } from '../intents.ts';
import {
  TGAS,
  ftStorageRegistered,
  functionCall,
  nearAccountId,
  sendTx as nearSendTx,
} from '../chain/near.ts';
import type { NearSendOutcome, NearSendParams } from '../chain/near.ts';

// The verifier contract. This is the whole point of the rail: one fixed account that goes on
// the policy allowlist once and stays there, unlike a deposit address minted per quote.
// Nothing in this module may derive a destination from an API response; every place that
// needs the verifier reads this constant.
export const INTENTS_VERIFIER = 'intents.near';

// SwapDraft.venue for this rail. The 'swap' kind is shared with two other venues, so the
// venue is what routes a draft here and what a draft must name to be accepted.
export const INTENTS_NATIVE_VENUE = 'intents-native';

// What the policy allowlist has to contain. Unlike ONECLICK_COUNTERPARTY, this is not a
// venue string standing in for an address that cannot be listed: it is the real account the
// funds are held by and swapped inside.
export const INTENTS_NATIVE_COUNTERPARTY = INTENTS_VERIFIER;

// The signing standard. erc191 is plain personal_sign over the EVM key the app already
// holds, which is why this rail needs no NEAR key and no NEP-413 support.
export const INTENTS_SIGNING_STANDARD = 'erc191';

// Environment variable carrying the partner API key. Read here rather than in the registry
// so the name lives next to the message that tells a human to set it.
export const INTENTS_API_KEY_ENV = 'PHOSPHOR_1CLICK_API_KEY';

export const INTENTS_NO_TESTNET_REASON =
  'NEAR Intents has no testnet: intents.testnet reports code_hash 11111111111111111111111111111111, ' +
  'which is the all-ones sentinel for an account that has never had code deployed, so there is no ' +
  'verifier contract to hold a balance or execute a signed intent. This rail runs on mainnet only.';

export const INTENTS_NO_API_KEY_REASON =
  'This rail needs a 1Click partner API key: POST /v0/generate-intent and POST /v0/submit-intent both ' +
  `require an X-API-Key header and they are the entire swap path. Obtain a key from the NEAR Intents ` +
  `Partners Portal (registration required, see https://docs.near-intents.org/integration/distribution-channels/` +
  `1click-api/authentication) and put it in the ${INTENTS_API_KEY_ENV} environment variable. ` +
  'Until then use the oneclick venue, which quotes and swaps unauthenticated.';

// A signed intent stays spendable until its deadline, so a server-chosen deadline far in the
// future is a long window in which a signature we have already released can be replayed
// against our balance. One hour is generous for a swap the API itself estimates at ~42s.
const MAX_DEADLINE_MS = 60 * 60 * 1000;

// ---------- base58, for the signature field ----------

// The verifier wants the secp256k1 signature as 'secp256k1:' + base58(65 bytes). base58 is a
// radix conversion, not a cryptographic primitive, so it is written out here rather than
// pulling in a dependency for it. @scure/base is present in node_modules as a transitive
// dependency of viem, but importing a package that package.json does not declare breaks the
// day a hoisting change moves it. Cross-checked against @scure/base on the leading-zero,
// empty and multi-byte vectors, and the test file repeats those vectors.
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);

  let out = '';
  while (n > 0n) {
    out = BASE58_ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  // Leading zero bytes carry no value in the number above, so they have to be restored by
  // hand. Dropping them would silently change the signature.
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

// viem returns a 65-byte signature with v in {27, 28}, the value Ethereum clients emit. The
// verifier contract expects the recovery byte in {0, 1} and the docs call this out as a
// client responsibility, so a signature normalised wrong is rejected on chain after the
// intent has already been submitted.
export function erc191SignatureField(signatureHex: Hex): string {
  const raw = hexToBytes(signatureHex);
  if (raw.length !== 65) {
    throw new Error(`erc191 signature must be 65 bytes, got ${raw.length}`);
  }
  const v = raw[64];
  const recovery = v === 27 || v === 28 ? v - 27 : v;
  if (recovery !== 0 && recovery !== 1) {
    throw new Error(`erc191 recovery byte must normalise to 0 or 1, got ${v}`);
  }
  const normalised = Uint8Array.from(raw);
  normalised[64] = recovery;
  return `secp256k1:${base58Encode(normalised)}`;
}

// ---------- the signer seam ----------

export type IntentsSignerPort = {
  address(keysPath: string): Address;
  // erc191 personal_sign over the exact payload string, returned in the verifier's encoding.
  signErc191(keysPath: string, payload: string): Promise<string>;
};

type KeysFile = { evm?: { privateKey?: string }; [k: string]: unknown };

// A copy of the discipline in src/chain/evm.ts: read the key at the moment it is needed,
// never keep it in module state, never let it reach a log or a return value.
//
// It is a copy because evm.ts exports evmAddress() but not a signing function and not the
// key itself, and this rail signs a message rather than a transaction. The right home for
// this is evm.ts, next to sendTx, so that "the one place Phosphor signs" stays true; moving
// it is a change to a file this module is not allowed to touch.
function readEvmKey(keysPath: string): Hex {
  if (!fs.existsSync(keysPath)) {
    throw new Error(`no keys file at ${keysPath}. Run: npm run keygen`);
  }
  const parsed = JSON.parse(fs.readFileSync(keysPath, 'utf8')) as KeysFile;
  const key = parsed.evm?.privateKey;
  if (typeof key !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error(`keys file at ${keysPath} has no valid evm.privateKey`);
  }
  return key as Hex;
}

export const liveIntentsSigner: IntentsSignerPort = {
  address(keysPath: string): Address {
    return privateKeyToAccount(readEvmKey(keysPath)).address;
  },
  async signErc191(keysPath: string, payload: string): Promise<string> {
    const account = privateKeyToAccount(readEvmKey(keysPath));
    // viem's signMessage is EIP-191 personal_sign: it prefixes the payload and hashes it the
    // way the verifier expects for the erc191 standard.
    const signature = await account.signMessage({ message: payload });
    return erc191SignatureField(signature);
  },
};

// ---------- the API seam ----------

export type IntentsQuoteParams = {
  dry: boolean;
  originAsset: string;
  destinationAsset: string;
  amount: string; // base units, decimal integer string
  account: string; // our Intents account id; refundTo and recipient are both this
  slippageToleranceBps?: number;
  deadlineMs?: number;
};

export type GeneratedIntent = { standard: string; payload: unknown; correlationId?: string };
export type SubmittedIntent = { intentHash: string; correlationId?: string };

export type IntentsApiPort = {
  tokens(): Promise<OneClickToken[]>;
  quote(params: IntentsQuoteParams): Promise<{ quote: OneClickQuote; raw: unknown }>;
  generateIntent(params: { signerId: string; depositAddress: string }): Promise<GeneratedIntent>;
  submitIntent(signed: { payload: string; signature: string }): Promise<SubmittedIntent>;
  status(depositAddress: string): Promise<OneClickStatus>;
};

// The two endpoints that need the key are the two written here. Quoting, the token list and
// the status poll are unauthenticated and reuse the client in src/intents.ts rather than
// growing a second copy of them.
export function intentsApi(deps: { apiKey: string; fetchImpl?: typeof fetch }): IntentsApiPort {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const shared = oneClickClient({ fetchImpl: deps.fetchImpl });

  // The key goes in a header and nowhere else. It is never interpolated into a message, a
  // thrown error or a returned detail string.
  function authHeaders(): Record<string, string> {
    return { 'content-type': 'application/json', 'X-API-Key': deps.apiKey };
  }

  async function readJson(res: Response, what: string): Promise<Record<string, unknown>> {
    const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      const msg = payload?.['message'] ?? payload?.['error'];
      if (res.status === 401 || res.status === 403) {
        throw new Error(`${what} was rejected as unauthorised (${res.status}). ${INTENTS_NO_API_KEY_REASON}`);
      }
      throw new Error(msg !== undefined ? `${what} failed: ${oneLine(msg)}` : `${what} failed: ${res.status}`);
    }
    if (payload === null || typeof payload !== 'object') throw new Error(`${what} returned no JSON body`);
    return payload;
  }

  async function quote(params: IntentsQuoteParams): Promise<{ quote: OneClickQuote; raw: unknown }> {
    const deadline = new Date(Date.now() + (params.deadlineMs ?? 10 * 60 * 1000)).toISOString();
    // All three of depositType, refundType and recipientType are INTENTS. That is what keeps
    // the whole swap inside the verifier: the input is already there, the output is credited
    // there, and a refund is credited there too. No leg of this touches a chain, which is
    // why there is no destination for the policy engine to be unable to check.
    const body = {
      dry: params.dry,
      swapType: 'EXACT_INPUT',
      slippageTolerance: params.slippageToleranceBps ?? 100,
      originAsset: params.originAsset,
      destinationAsset: params.destinationAsset,
      amount: params.amount,
      depositType: 'INTENTS',
      refundTo: params.account,
      refundType: 'INTENTS',
      recipient: params.account,
      recipientType: 'INTENTS',
      deadline,
    };

    const res = await fetchImpl(`${ONECLICK_BASE}/v0/quote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await readJson(res, '1click quote');
    const quoteField = payload['quote'] as OneClickQuote | undefined;
    if (!quoteField || typeof quoteField !== 'object') throw new Error('no quote in 1click response');
    return { quote: quoteField, raw: payload };
  }

  async function generateIntent(params: { signerId: string; depositAddress: string }): Promise<GeneratedIntent> {
    const res = await fetchImpl(`${ONECLICK_BASE}/v0/generate-intent`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        type: 'swap_transfer',
        standard: INTENTS_SIGNING_STANDARD,
        signerId: params.signerId,
        depositAddress: params.depositAddress,
      }),
    });
    const payload = await readJson(res, 'generate-intent');
    const intent = payload['intent'] as Record<string, unknown> | undefined;
    if (!intent || typeof intent !== 'object') throw new Error('generate-intent returned no intent');
    return {
      standard: typeof intent['standard'] === 'string' ? (intent['standard'] as string) : '',
      payload: intent['payload'],
      correlationId: typeof payload['correlationId'] === 'string' ? (payload['correlationId'] as string) : undefined,
    };
  }

  async function submitIntent(signed: { payload: string; signature: string }): Promise<SubmittedIntent> {
    const res = await fetchImpl(`${ONECLICK_BASE}/v0/submit-intent`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        type: 'swap_transfer',
        signedData: {
          standard: INTENTS_SIGNING_STANDARD,
          payload: signed.payload,
          signature: signed.signature,
        },
      }),
    });
    const payload = await readJson(res, 'submit-intent');
    const hash = payload['intentHash'];
    if (typeof hash !== 'string' || hash === '') throw new Error('submit-intent returned no intentHash');
    return {
      intentHash: oneLine(hash, 120),
      correlationId: typeof payload['correlationId'] === 'string' ? (payload['correlationId'] as string) : undefined,
    };
  }

  return { tokens: shared.tokens, quote, generateIntent, submitIntent, status: shared.status };
}

// ---------- the intent payload, read as data ----------

export type IntentPayloadExpectation = {
  signerId: string; // our own account id inside the verifier
  originAsset: string;
  destinationAsset: string;
  amountBase: bigint; // exactly what leaves our balance
  minOutBase: bigint; // the least that may arrive
  now: number;
  maxDeadlineMs: number;
};

// Everything that has to be true about the payload before the key is touched.
//
// The threat is a remote server returning a well-formed payload that does something other
// than the swap a human approved: a different asset, a larger amount, an extra withdrawal to
// an account that is not ours. A signature over that payload spends our balance exactly as
// effectively as a transfer would, so this is the checkpoint that replaces "is the deposit
// address one we trust", and unlike that question this one is answerable.
//
// Returns the problems it found. An empty array means the payload says what the draft says.
export function checkIntentPayload(raw: unknown, expect: IntentPayloadExpectation): string[] {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return [`the erc191 intent payload must be a JSON string, got ${oneLine(raw, 60)}`];
  }

  let body: Record<string, unknown>;
  try {
    // JSON.parse, never eval and never a Function constructor. The payload is a value.
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return [`the intent payload is not a JSON object: ${oneLine(raw, 80)}`];
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return [`the intent payload is not valid JSON: ${oneLine(raw, 80)}`];
  }

  // The verifier the signature is scoped to. A payload naming any other contract would be a
  // signature we release for a system we did not choose, so this is compared against the
  // hardcoded constant and never against anything the API told us.
  const verifying = body['verifying_contract'];
  if (verifying !== INTENTS_VERIFIER) {
    return [
      `the intent names ${oneLine(verifying, 60)} as the verifying contract, not ${INTENTS_VERIFIER}; ` +
        'this signature would authorise a swap in a contract we did not choose',
    ];
  }

  const signer = body['signer_id'];
  if (typeof signer !== 'string' || signer.toLowerCase() !== expect.signerId.toLowerCase()) {
    return [`the intent is authored for ${oneLine(signer, 60)} but our account is ${expect.signerId}`];
  }

  if (typeof body['nonce'] !== 'string' || body['nonce'] === '') {
    return ['the intent carries no nonce, so it cannot be protected against replay'];
  }

  // A signed intent stays spendable until its deadline. A deadline in the past is dead on
  // arrival; a deadline far ahead is a long replay window on a signature we have released.
  const deadlineRaw = body['deadline'];
  const deadline = typeof deadlineRaw === 'string' ? Date.parse(deadlineRaw) : Number.NaN;
  if (!Number.isFinite(deadline)) {
    return [`the intent deadline ${oneLine(deadlineRaw, 60)} is not a timestamp`];
  }
  if (deadline <= expect.now) {
    return [`the intent deadline ${oneLine(deadlineRaw, 60)} has already passed`];
  }
  if (deadline - expect.now > expect.maxDeadlineMs) {
    return [
      `the intent stays valid until ${oneLine(deadlineRaw, 60)}, more than ` +
        `${Math.round(expect.maxDeadlineMs / 60000)} minutes out; a signature released for that long can be replayed`,
    ];
  }

  const intents = body['intents'];
  if (!Array.isArray(intents) || intents.length !== 1) {
    // Deliberately strict. With every leg staying inside the verifier there is no legitimate
    // second intent: a withdrawal, a transfer or a key change riding along with the swap is
    // the exact shape of the attack this check exists for. Refusing names what was found, so
    // a legitimate change in the API's output is a readable refusal and not a mystery.
    const kinds = Array.isArray(intents)
      ? intents.map((i) => oneLine((i as Record<string, unknown>)?.['intent'] ?? '?', 30)).join(', ')
      : oneLine(intents, 60);
    return [`the intent bundles ${Array.isArray(intents) ? intents.length : 'a non-list'} actions (${kinds}); this rail signs exactly one token_diff`];
  }

  const action = intents[0] as Record<string, unknown>;
  if (action?.['intent'] !== 'token_diff') {
    return [`the intent is a ${oneLine(action?.['intent'], 40)}, not the token_diff a swap is made of`];
  }

  const diff = action['diff'];
  if (diff === null || typeof diff !== 'object' || Array.isArray(diff)) {
    return [`the token_diff carries no diff object (got ${oneLine(diff, 60)})`];
  }
  const entries = diff as Record<string, unknown>;
  const keys = Object.keys(entries);

  const problems: string[] = [];

  // Exactly the two assets the draft names, and nothing else. An extra asset in the diff is
  // an extra balance being moved.
  const unexpected = keys.filter((k) => k !== expect.originAsset && k !== expect.destinationAsset);
  if (unexpected.length > 0) {
    problems.push(`the swap also moves ${unexpected.map((k) => oneLine(k, 60)).join(', ')}, which the draft does not name`);
  }
  if (!keys.includes(expect.originAsset)) {
    problems.push(`the swap does not spend ${oneLine(expect.originAsset, 60)}, which the draft names as the input`);
  }
  if (!keys.includes(expect.destinationAsset)) {
    problems.push(`the swap does not deliver ${oneLine(expect.destinationAsset, 60)}, which the draft names as the output`);
  }
  if (problems.length > 0) return problems;

  const spend = amountOf(entries[expect.originAsset], 'the input leg');
  const receive = amountOf(entries[expect.destinationAsset], 'the output leg');
  if (typeof spend === 'string') return [spend];
  if (typeof receive === 'string') return [receive];

  // A token_diff spends as a negative number and credits as a positive one.
  if (spend !== -expect.amountBase) {
    problems.push(`the swap spends ${(-spend).toString()} base units, not the ${expect.amountBase.toString()} the draft approved`);
  }
  if (receive < expect.minOutBase) {
    problems.push(`the swap delivers ${receive.toString()} base units, below the ${expect.minOutBase.toString()} floor the draft approved`);
  }

  return problems;
}

// A diff amount. Never Number(): these are base units at up to 24 decimals and a double
// would round them silently, and a garbage value must be a refusal rather than a NaN that
// compares false against every limit.
function amountOf(value: unknown, what: string): bigint | string {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return `${what} of the swap has no amount (got ${oneLine(value, 40)})`;
  }
  try {
    return BigInt(value);
  } catch {
    return `${what} of the swap has a non-integer amount: ${oneLine(value, 40)}`;
  }
}

// ---------- moving funds INTO the verifier ----------

// The funding step, kept separate from the rail on purpose. A swap on this rail moves
// nothing; getting a balance in there in the first place does, so it is its own reviewable
// object with its own destination check rather than a hidden first step of execute().
export type IntentsDepositPlan = {
  verifier: string; // always INTENTS_VERIFIER, checked below before this object is built
  intentsAccountId: string; // who the deposit is credited to inside the verifier
  token: string; // the NEP-141 contract holding the asset on NEAR
  amountBase: string;
  // The exact call a human runs. receiver_id is the fixed verifier account, which is what
  // makes this destination checkable in a way a per-quote deposit address never is.
  call: {
    contractId: string;
    method: 'ft_transfer_call';
    args: { receiver_id: string; amount: string; msg: string };
    attachedDepositYocto: '1';
  };
};

// Builds the funding call and refuses to build one pointed anywhere but the verifier.
//
// An ECDSA key gets an Implicit Eth account inside the verifier whose account id is the
// Ethereum address itself, so the address the app already signs with is also the account the
// deposit must be credited to. That is why msg carries it: an empty msg would credit the
// NEAR account that sent the tokens, which is not us.
export function intentsDepositPlan(args: {
  intentsAccountId: string;
  token: string;
  amountBase: bigint;
  verifier?: string;
}): IntentsDepositPlan {
  const verifier = args.verifier ?? INTENTS_VERIFIER;
  if (verifier !== INTENTS_VERIFIER) {
    throw new Error(
      `a deposit may only be sent to ${INTENTS_VERIFIER}, not ${oneLine(verifier, 60)}; ` +
        'the verifier account is fixed and is never taken from a quote or an API response',
    );
  }
  if (args.intentsAccountId.trim() === '') throw new Error('a deposit needs the account id it is credited to');
  if (args.token.trim() === '') throw new Error('a deposit needs the NEP-141 token contract it moves');
  if (args.amountBase <= 0n) throw new Error(`a deposit must move a positive amount (got ${args.amountBase})`);

  return {
    verifier,
    intentsAccountId: args.intentsAccountId,
    token: args.token,
    amountBase: args.amountBase.toString(),
    call: {
      contractId: args.token,
      method: 'ft_transfer_call',
      args: { receiver_id: verifier, amount: args.amountBase.toString(), msg: args.intentsAccountId },
      attachedDepositYocto: '1',
    },
  };
}

// ft_transfer_call is one hop further than ft_transfer: the token contract calls
// ft_on_transfer on the verifier and waits for the callback that says how much was accepted.
// 100 TGas covers the round trip with room to spare, and the unburnt remainder is refunded.
const FT_TRANSFER_CALL_GAS = 100n * TGAS;

// The seam, same shape as the one in oneclick.ts so both rails stub NEAR the same way.
export type IntentsNearPort = {
  accountId(keysPath: string): string;
  send(params: NearSendParams): Promise<NearSendOutcome>;
  storageRegistered(network: Network, tokenId: string, accountId: string): Promise<boolean>;
};

export const liveIntentsNearPort: IntentsNearPort = {
  accountId: nearAccountId,
  send: nearSendTx,
  storageRegistered: (network, tokenId, accountId) => ftStorageRegistered(network, tokenId, accountId),
};

// Funds the rail by signing the deposit, which is the step that used to be impossible.
//
// This function used to refuse on principle and the principle was sound at the time: the
// verifier's deposit interface is ft_transfer_call on a NEP-141 contract, that is a NEAR
// transaction, and the app held an EVM key and no NEAR signer. So it built the exact call,
// checked its destination, and handed it to a human to run from a NEAR wallet.
//
// src/chain/near.ts removes the reason. What does NOT change is the property the refusal was
// protecting: the destination is still the fixed verifier account from a constant in this
// module, checked by intentsDepositPlan before anything is signed, and never read out of an
// API response. The alternative that was rejected then is still rejected now, and for the
// same reason: funding this rail through a 1Click ORIGIN_CHAIN quote would route the money
// via a freshly minted per-quote deposit address, which is the exact unverifiable
// destination this rail exists to remove.
//
// The account being credited is msg, and it is the EVM address rather than the NEAR account
// that signs. That is deliberate: an ECDSA key gets an Implicit Eth account inside the
// verifier whose id is the address itself, and that is the identity the erc191 intents in
// this rail are signed for. An empty msg would credit the NEAR account that sent the tokens,
// and the rail would then sign intents against a balance it does not have.
export async function intentsDeposit(args: {
  intentsAccountId: string;
  token: string;
  amountBase: bigint;
  network: Network;
  keysPath: string;
  near?: IntentsNearPort;
  signer?: IntentsSignerPort;
}): Promise<RailResult> {
  if (args.network !== 'mainnet') {
    return { ok: false, detail: INTENTS_NO_TESTNET_REASON, txids: [] };
  }

  // Builds the call and throws if it is pointed anywhere but the verifier. Runs first, so a
  // bad destination never reaches a key.
  const plan = intentsDepositPlan(args);
  const near = args.near ?? liveIntentsNearPort;
  const signer = args.signer ?? liveIntentsSigner;

  // Pinning the verifier is only half the destination. The other half is msg, which decides
  // WHICH account inside the verifier gets the credit, and a deposit credited to somebody
  // else is a total loss of the amount with a perfectly successful transaction to show for
  // it. The contract address was already checked against a constant; this checks the
  // credited account against the key that is about to sign, so neither half of "where the
  // money goes" is taken from a caller unchallenged.
  const ours = signer.address(args.keysPath);
  if (plan.intentsAccountId.toLowerCase() !== ours.toLowerCase()) {
    return {
      ok: false,
      detail:
        `refusing to credit ${oneLine(plan.intentsAccountId, 60)}: this key's Implicit Eth account inside ` +
        `${plan.verifier} is ${ours}, so a deposit crediting anything else funds an account we cannot spend from.`,
      txids: [],
    };
  }

  const registered = await near.storageRegistered(args.network, plan.token, plan.verifier);
  if (!registered) {
    return {
      ok: false,
      detail:
        `${plan.verifier} has no storage deposit registered on ${plan.token}, so ft_transfer_call would ` +
        'panic and the tokens would bounce. Nothing was signed.',
      txids: [],
    };
  }

  const sent = await near.send({
    network: args.network,
    keysPath: args.keysPath,
    receiverId: plan.call.contractId,
    actions: [
      functionCall(plan.call.method, plan.call.args, FT_TRANSFER_CALL_GAS, BigInt(plan.call.attachedDepositYocto)),
    ],
  });

  if (!sent.ok) {
    return {
      ok: false,
      detail: `deposit failed: ${oneLine(sent.error ?? 'unknown error')}. The balance inside ${plan.verifier} is unchanged.`,
      txids: sent.hash !== undefined ? [sent.hash] : [],
    };
  }

  return {
    ok: true,
    detail:
      `deposited ${plan.amountBase} base units of ${plan.token} into ${plan.verifier}, credited to ` +
      `${plan.intentsAccountId}; tx ${sent.hash}. Swaps on this rail now need no transfer at all.`,
    txids: sent.hash !== undefined ? [sent.hash] : [],
  };
}

// ---------- the rail ----------

export type IntentsNativeRailDeps = {
  network: Network;
  keysPath: string;
  tokens: TokensFile;
  apiKey?: string; // defaults to process.env[INTENTS_API_KEY_ENV]
  signer?: IntentsSignerPort;
  api?: IntentsApiPort;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  now?: () => number;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  maxDeadlineMs?: number;
};

export type IntentsNativeRail = Rail<SwapDraft>;

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function baseUnits(value: unknown, field: string): bigint {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error(`1click quote is missing ${field}`);
  }
  try {
    return BigInt(value);
  } catch {
    throw new Error(`1click quote returned a non-integer ${field}: ${oneLine(value, 40)}`);
  }
}

export function intentsNativeRail(deps: IntentsNativeRailDeps): IntentsNativeRail {
  const { network, keysPath, tokens } = deps;
  const apiKey = deps.apiKey ?? process.env[INTENTS_API_KEY_ENV];
  const signer = deps.signer ?? liveIntentsSigner;
  const sleep = deps.sleepImpl ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const pollIntervalMs = deps.pollIntervalMs ?? 5_000;
  const pollTimeoutMs = deps.pollTimeoutMs ?? 5 * 60_000;
  const maxDeadlineMs = deps.maxDeadlineMs ?? MAX_DEADLINE_MS;

  const hasKey = deps.api !== undefined || (typeof apiKey === 'string' && apiKey.trim() !== '');
  // The client is only built when there is a key to build it with, so a missing key can
  // never reach the network as a 401.
  const api =
    deps.api ??
    (hasKey ? intentsApi({ apiKey: apiKey as string, fetchImpl: deps.fetchImpl }) : null);

  type Plan = {
    originAsset: string;
    destinationAsset: string;
    originDecimals: number;
    destDecimals: number;
    amountBase: bigint;
    minOutBase: bigint;
  };

  function requireVenue(draft: SwapDraft): void {
    if (draft.venue !== INTENTS_NATIVE_VENUE) {
      throw new Error(
        `intents-native rail received a ${draft.venue} draft; kind 'swap' is shared, venue is not`,
      );
    }
    // The counterparty is fixed and hardcoded. A draft naming anything else is either built
    // against the wrong rail or built by something choosing where the money goes.
    if (draft.counterparty !== INTENTS_NATIVE_COUNTERPARTY) {
      throw new Error(
        `intents-native drafts must name ${INTENTS_NATIVE_COUNTERPARTY} as the counterparty ` +
          `(got ${oneLine(draft.counterparty, 60)}); the verifier account is fixed and never comes from a quote`,
      );
    }
    // Both legs stay inside the verifier and are credited to our own account, so a draft
    // whose output goes somewhere else is describing a swap this rail cannot perform. Checked
    // without reading the key so simulate stays key-free; execute checks both against the
    // real signer address.
    if (draft.from.toLowerCase() !== draft.to.toLowerCase()) {
      throw new Error(
        `intents-native credits the proceeds to our own account inside the verifier, so a draft cannot ` +
          `send them from ${oneLine(draft.from, 50)} to ${oneLine(draft.to, 50)}`,
      );
    }
  }

  function requireUsable(): void {
    if (!hasKey || api === null) throw new Error(INTENTS_NO_API_KEY_REASON);
  }

  async function plan(draft: SwapDraft): Promise<Plan> {
    requireVenue(draft);
    requireUsable();

    const originInfo = tokens[draft.chain]?.[draft.fromSymbol];
    const destInfo = tokens[draft.toChain]?.[draft.toSymbol];
    if (!originInfo) throw new Error(`no token registry entry for ${draft.fromSymbol} on ${draft.chain}`);
    if (!destInfo) throw new Error(`no token registry entry for ${draft.toSymbol} on ${draft.toChain}`);

    // No EVM-origin restriction, unlike the oneclick rail. Nothing is signed on the origin
    // chain here, so the asset's home chain only has to be one the verifier holds a bridged
    // balance for; a base USDC to NEAR USDT swap needs no NEAR key and no Solana key.
    const list = await (api as IntentsApiPort).tokens();
    const originAsset = assetIdFor(draft.chain, originInfo.tokenId, list);
    const destinationAsset = assetIdFor(draft.toChain, destInfo.tokenId, list);
    if (!originAsset) throw new Error(`1click does not list ${draft.fromSymbol} on ${draft.chain}`);
    if (!destinationAsset) throw new Error(`1click does not list ${draft.toSymbol} on ${draft.toChain}`);
    if (originAsset === destinationAsset) {
      throw new Error(`${draft.fromSymbol} on ${draft.chain} and ${draft.toSymbol} on ${draft.toChain} are the same asset inside the verifier`);
    }

    return {
      originAsset,
      destinationAsset,
      originDecimals: originInfo.decimals,
      destDecimals: destInfo.decimals,
      amountBase: toBaseUnits(draft.amountIn, originInfo.decimals),
      minOutBase: toBaseUnits(draft.minAmountOut, destInfo.decimals),
    };
  }

  function checkQuote(draft: SwapDraft, p: Plan, quote: OneClickQuote): string[] {
    const problems: string[] = [];

    const amountIn = baseUnits(quote.amountIn, 'amountIn');
    if (amountIn !== p.amountBase) {
      problems.push(
        `the quote is for ${formatUnits(amountIn, p.originDecimals)} ${draft.fromSymbol}, ` +
          `not the ${draft.amountIn} the draft names`,
      );
    }

    const minOut = baseUnits(quote.minAmountOut, 'minAmountOut');
    if (minOut < p.minOutBase) {
      problems.push(
        `the solver floor of ${formatUnits(minOut, p.destDecimals)} ${draft.toSymbol} is below the ` +
          `draft floor of ${draft.minAmountOut}`,
      );
    }

    return problems;
  }

  function priceLines(draft: SwapDraft, quote: OneClickQuote): string[] {
    const inUsd = Number(quote.amountInUsd);
    const outUsd = Number(quote.amountOutUsd);
    const feeUsd = Number.isFinite(inUsd) && Number.isFinite(outUsd) ? inUsd - outUsd : NaN;
    return [
      `intents-native: ${draft.amountIn} ${draft.fromSymbol} -> ` +
        `${oneLine(quote.amountOutFormatted, 40)} ${draft.toSymbol}, entirely inside ${INTENTS_VERIFIER}`,
      `fee ${Number.isFinite(feeUsd) ? '$' + feeUsd.toFixed(4) : 'unknown'}, eta ~${Number(quote.timeEstimate)}s, ` +
        `solver floor ${oneLine(quote.minAmountOut, 40)} base units, draft floor ${draft.minAmountOut} ${draft.toSymbol}`,
    ];
  }

  function valueUsd(draft: SwapDraft): number {
    return Number.isFinite(draft.amountUsd) ? draft.amountUsd : Infinity;
  }

  async function simulate(draft: SwapDraft): Promise<SimulationResult> {
    try {
      // Order matters, and all three of these refuse before any network call. A draft for
      // another venue is not this rail's business; a missing key means the swap cannot be
      // submitted however good the price is, so pricing it would be a proposal a human can
      // approve and nothing can run.
      requireVenue(draft);
      requireUsable();
      if (network !== 'mainnet') throw new Error(INTENTS_NO_TESTNET_REASON);

      const p = await plan(draft);

      const response = await (api as IntentsApiPort).quote({
        dry: true,
        originAsset: p.originAsset,
        destinationAsset: p.destinationAsset,
        amount: p.amountBase.toString(),
        account: draft.from,
      });

      const lines = priceLines(draft, response.quote);
      const problems = checkQuote(draft, p, response.quote);
      if (problems.length > 0) {
        const joined = problems.join('; ');
        return { ok: false, summary: [`REFUSED: ${joined}`, ...lines].join('\n'), error: joined };
      }

      lines.push(
        `execution signs one intent with the EVM key and transfers nothing; the balance must already be ` +
          `inside ${INTENTS_VERIFIER}`,
      );
      return { ok: true, summary: lines.join('\n') };
    } catch (err) {
      const message = errText(err);
      return { ok: false, summary: `intents-native simulation failed: ${message}`, error: message };
    }
  }

  async function execute(draft: SwapDraft): Promise<RailResult> {
    // First line, before any network call, any key read and any quote. There is no verifier
    // deployed on testnet, so there is nothing to sign an intent against.
    if (network !== 'mainnet') throw new Error(INTENTS_NO_TESTNET_REASON);
    requireVenue(draft);
    requireUsable();
    const client = api as IntentsApiPort;

    const p = await plan(draft);

    // The draft names the wallet a human approved. Since the account id inside the verifier
    // IS this address, a different key would be swapping somebody else's balance, or more
    // likely swapping nothing and failing after the signature is already released.
    const owner = signer.address(keysPath);
    if (draft.from.toLowerCase() !== owner.toLowerCase()) {
      throw new Error(`draft is authored for ${draft.from} but the configured key is ${owner}`);
    }

    const response = await client.quote({
      dry: false,
      originAsset: p.originAsset,
      destinationAsset: p.destinationAsset,
      amount: p.amountBase.toString(),
      account: owner,
    });
    const quote = response.quote;

    const problems = checkQuote(draft, p, quote);
    if (problems.length > 0) throw new Error(`live quote does not match the approved draft: ${problems.join('; ')}`);

    // For an INTENTS quote this is an account id inside the verifier, not a chain address,
    // and nothing is ever sent to it. It is the handle that ties the signed intent back to
    // this quote, so it is bounded and required but deliberately not address-validated.
    const depositAddress = quote.depositAddress;
    if (typeof depositAddress !== 'string' || depositAddress.trim() === '') {
      throw new Error(`the quote carries no deposit handle to attach an intent to (got ${oneLine(depositAddress, 60)})`);
    }

    const generated = await client.generateIntent({ signerId: owner, depositAddress });

    // We asked for erc191 and we can only sign erc191. A different standard coming back is
    // never something to attempt: signing the wrong scheme releases a signature over bytes we
    // did not mean to authorise.
    if (generated.standard !== INTENTS_SIGNING_STANDARD) {
      throw new Error(
        `generate-intent returned a ${oneLine(generated.standard, 40)} payload, but this rail signs ` +
          `${INTENTS_SIGNING_STANDARD} only`,
      );
    }

    const payloadProblems = checkIntentPayload(generated.payload, {
      signerId: owner,
      originAsset: p.originAsset,
      destinationAsset: p.destinationAsset,
      amountBase: p.amountBase,
      minOutBase: p.minOutBase,
      now: now(),
      maxDeadlineMs,
    });
    if (payloadProblems.length > 0) {
      throw new Error(`refusing to sign the intent 1click generated: ${payloadProblems.join('; ')}`);
    }

    // Signed exactly as returned. The payload string is not re-serialised, re-ordered or
    // normalised anywhere above: the signature has to cover the same bytes the verifier will
    // parse, and a round trip through JSON.parse and JSON.stringify would not guarantee that.
    const payload = generated.payload as string;
    const signature = await signer.signErc191(keysPath, payload);

    const submitted = await client.submitIntent({ payload, signature });
    const evidence = `intent ${submitted.intentHash}, quote handle ${oneLine(depositAddress, 80)}`;

    const watch = await watchStatus(depositAddress);

    if (watch.status === 'SUCCESS') {
      return {
        ok: true,
        detail:
          `swapped ${draft.amountIn} ${draft.fromSymbol} for ${oneLine(quote.amountOutFormatted, 40)} ` +
          `${draft.toSymbol} inside ${INTENTS_VERIFIER}; ${evidence}. Nothing was transferred on any chain ` +
          `and the proceeds are credited to ${owner} inside the verifier.`,
        txids: [submitted.intentHash, ...watch.destinationTxHashes],
      };
    }

    if (watch.status === 'REFUNDED' || watch.status === 'FAILED') {
      return {
        ok: false,
        detail:
          `1click reported ${watch.reported} after the intent was submitted; ${evidence}. ` +
          `A refund is credited back to ${owner} inside ${INTENTS_VERIFIER}, not to any chain address.`,
        txids: [submitted.intentHash, ...watch.originTxHashes, ...watch.destinationTxHashes],
      };
    }

    // Timed out. The signature is already released and the intent already submitted, so the
    // balance may well move after this returns. Same rule as the oneclick rail: a poll
    // timeout is not a failed swap, and saying so is what stops someone signing a second one.
    return {
      ok: false,
      detail:
        `the intent was submitted but 1click did not reach a terminal status within ` +
        `${Math.round(pollTimeoutMs / 1000)}s (last status ${watch.reported}); ${evidence}. ` +
        `THE INTENT IS SIGNED AND SUBMITTED and the swap may still complete: check the balance inside ` +
        `${INTENTS_VERIFIER} before signing another.`,
      txids: [submitted.intentHash],
    };
  }

  // Same contract as the oneclick rail's watcher: polls until terminal, out of attempts or
  // out of time, and never throws once the intent has been submitted.
  async function watchStatus(depositAddress: string): Promise<OneClickStatus> {
    const client = api as IntentsApiPort;
    const deadline = now() + pollTimeoutMs;
    const maxPolls = Math.max(1, Math.ceil(pollTimeoutMs / pollIntervalMs));
    let last: OneClickStatus = {
      found: false,
      status: 'PENDING_DEPOSIT',
      reported: 'not polled',
      originTxHashes: [],
      destinationTxHashes: [],
    };

    for (let attempt = 0; attempt < maxPolls; attempt += 1) {
      try {
        last = await client.status(depositAddress);
        if ((ONECLICK_TERMINAL as readonly string[]).includes(last.status)) return last;
      } catch (err) {
        last = { ...last, reported: `status check failed: ${oneLine(errText(err), 80)}` };
      }
      if (now() >= deadline) break;
      await sleep(pollIntervalMs);
    }

    return last;
  }

  return { kind: 'swap', valueUsd, simulate, execute };
}
