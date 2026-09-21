// The solver relay (NEAR Intents' Message Bus), as this app calls it: three JSON-RPC methods
// over one POST endpoint. `quote` asks every connected solver for a price, `publish_intent`
// hands the relay one signed intent with the quote it answers, `get_status` says where that
// intent is. Checked live 2026-09-20 without a key: the docs say the endpoint wants a JWT and
// it does not enforce one today, so the partner key is sent when present and never required.
//
// Pure transport. Nothing here signs, builds a payload, chooses a quote or judges a status:
// every field the relay returns is typed and bounded before a caller sees it, and a shape this
// module does not recognise is an error with the relay's words in it, never a guess. The rail
// (src/rails/intents-relay.ts) decides what the numbers mean.
//
// Timeouts follow src/net.ts: a quote and a status read are reads, ten seconds; a publish is
// a venue write, thirty, because the relay simulates the intent against the verifier before it
// answers and a deadline that fires while it does leaves an intent that may be live.

import { readTimeout, venueWriteTimeout } from '../net.ts';
import { oneLine } from '../intents.ts';

export const RELAY_URL = 'https://solver-relay-v2.chaindefuser.com/rpc';

// The same partner key the 1Click client reads (INTENTS_API_KEY_ENV in the 1Click rail names
// the same variable; a test asserts the two strings agree). One key, one header, both venues.
export const RELAY_API_KEY_ENV = 'PHOSPHOR_1CLICK_API_KEY';

// A quote as one solver answered it. Amounts stay decimal strings: 24-decimal assets do not
// survive a double, and the rail compares them as bigint.
export type RelayQuote = {
  quoteHash: string;
  assetIn: string;
  assetOut: string;
  amountIn: string;
  amountOut: string;
  expirationTime: string; // ISO, as the solver wrote it
};

export type RelayQuoteRequest = {
  assetIn: string;
  assetOut: string;
  exactAmountIn: string; // base units, decimal integer string
  minDeadlineMs?: number; // how long the offers must stay valid; the relay defaults to 60 s
};

export type RelayPublishRequest = {
  quoteHashes: string[];
  standard: string;
  payload: string; // the exact string that was signed
  signature: string; // the verifier's encoding: secp256k1:<base58 of 65 bytes>
};

export type RelayPublishResult = { status: 'OK'; intentHash: string } | { status: 'FAILED'; reason: string };

/* The relay's status word, byte for byte, plus what rode beside it. `status` is deliberately a
   string and not the four words the docs list: a word this app does not know is passed up as
   itself, and the rail treats it as "not terminal" rather than as one of the four. */
export type RelayStatus = {
  intentHash: string;
  status: string;
  statusDetails: string | null;
  nearTxHash: string | null; // data.hash, once the transaction is on NEAR
  filledAmounts: string[]; // per leg, in the order the diff was written; empty until filled
};

export type RelayClient = {
  quote(req: RelayQuoteRequest): Promise<RelayQuote[]>;
  publishIntent(req: RelayPublishRequest): Promise<RelayPublishResult>;
  status(intentHash: string): Promise<RelayStatus>;
};

export type RelayClientDeps = {
  fetchImpl?: typeof fetch;
  apiKey?: string; // defaults to process.env[RELAY_API_KEY_ENV]
  url?: string;
};

// A bounded string off the wire, or null when the field is not a non-empty string.
function text(value: unknown, max = 200): string | null {
  return typeof value === 'string' && value !== '' ? oneLine(value, max) : null;
}

// A base-unit amount off the wire: digits only. A number, an empty string or an exponent is
// refused here so no caller ever runs BigInt() on something the relay did not write as an
// integer.
function digits(value: unknown): string | null {
  return typeof value === 'string' && /^\d+$/.test(value) ? value : null;
}

// A hash off the wire: base58 and hash-sized, or no hash. An intent hash goes on the row as
// the handle and a NEAR hash goes into an explorer link, so neither may carry anything but the
// characters a hash is made of.
function hash(value: unknown, min: number, max: number): string | null {
  return typeof value === 'string' && value.length >= min && value.length <= max && /^[1-9A-HJ-NP-Za-km-z]+$/.test(value) ? value : null;
}

function readQuote(raw: unknown): RelayQuote | null {
  if (raw === null || typeof raw !== 'object') return null;
  const q = raw as Record<string, unknown>;
  const quoteHash = text(q['quote_hash'], 120);
  const assetIn = text(q['defuse_asset_identifier_in'], 200);
  const assetOut = text(q['defuse_asset_identifier_out'], 200);
  const amountIn = digits(q['amount_in']);
  const amountOut = digits(q['amount_out']);
  const expirationTime = text(q['expiration_time'], 40);
  if (quoteHash === null || assetIn === null || assetOut === null || amountIn === null || amountOut === null || expirationTime === null) return null;
  if (!Number.isFinite(Date.parse(expirationTime))) return null;
  return { quoteHash, assetIn, assetOut, amountIn, amountOut, expirationTime };
}

export function relayClient(deps: RelayClientDeps = {}): RelayClient {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const url = deps.url ?? RELAY_URL;
  const apiKey = deps.apiKey ?? process.env[RELAY_API_KEY_ENV] ?? '';
  let nextId = 1;

  // The key goes in a header and nowhere else: never into a message, a thrown error or a
  // returned detail. An empty key means no header rather than an empty one.
  function headers(): Record<string, string> {
    const out: Record<string, string> = { 'content-type': 'application/json' };
    if (apiKey.trim() !== '') out['X-API-Key'] = apiKey;
    return out;
  }

  async function call(method: string, params: Record<string, unknown>, deadline: AbortSignal): Promise<unknown> {
    const id = nextId;
    nextId += 1;
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params: [params] }),
      signal: deadline,
    });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      const said = body?.['error'] !== undefined ? oneLine(body['error'], 160) : String(res.status);
      throw new Error(`relay ${method} failed: ${said}`);
    }
    if (body === null || typeof body !== 'object') throw new Error(`relay ${method} returned no JSON body`);
    const error = body['error'];
    if (error !== undefined && error !== null) {
      const message = (error as Record<string, unknown>)['message'];
      throw new Error(`relay ${method} failed: ${oneLine(message ?? error, 160)}`);
    }
    return body['result'];
  }

  async function quote(req: RelayQuoteRequest): Promise<RelayQuote[]> {
    const result = await call(
      'quote',
      {
        defuse_asset_identifier_in: req.assetIn,
        defuse_asset_identifier_out: req.assetOut,
        exact_amount_in: req.exactAmountIn,
        min_deadline_ms: req.minDeadlineMs ?? 60_000,
      },
      readTimeout(),
    );
    // `null` is the relay's word for "no solver answered", and it is an empty list here rather
    // than an error: nothing is wrong with the request, there is no price for it right now.
    if (result === null || result === undefined) return [];
    if (!Array.isArray(result)) throw new Error(`relay quote returned ${oneLine(result, 80)} instead of a list`);
    const quotes: RelayQuote[] = [];
    for (const raw of result) {
      const q = readQuote(raw);
      // A malformed entry is dropped, not repaired: the rail picks among what is well formed.
      if (q !== null) quotes.push(q);
    }
    return quotes;
  }

  async function publishIntent(req: RelayPublishRequest): Promise<RelayPublishResult> {
    const result = await call(
      'publish_intent',
      {
        quote_hashes: req.quoteHashes,
        signed_data: { standard: req.standard, payload: req.payload, signature: req.signature },
      },
      venueWriteTimeout(),
    );
    if (result === null || typeof result !== 'object') throw new Error(`relay publish_intent returned ${oneLine(result, 80)}`);
    const r = result as Record<string, unknown>;
    const status = r['status'];
    if (status === 'OK') {
      const intentHash = hash(r['intent_hash'], 8, 120);
      if (intentHash === null) throw new Error('relay publish_intent said OK and gave no intent hash');
      return { status: 'OK', intentHash };
    }
    if (status === 'FAILED') {
      return { status: 'FAILED', reason: text(r['reason'], 300) ?? 'no reason given' };
    }
    throw new Error(`relay publish_intent answered with status ${oneLine(status, 40)}, which this app does not know`);
  }

  async function status(intentHash: string): Promise<RelayStatus> {
    const result = await call('get_status', { intent_hash: intentHash }, readTimeout());
    if (result === null || typeof result !== 'object') throw new Error(`relay get_status returned ${oneLine(result, 80)}`);
    const r = result as Record<string, unknown>;
    const word = text(r['status'], 60);
    if (word === null) throw new Error('relay get_status answered with no status word');
    const data = r['data'];
    const nearTxHash = data !== null && typeof data === 'object' ? hash((data as Record<string, unknown>)['hash'], 32, 64) : null;
    const filled = r['filled_amounts'];
    const filledAmounts = Array.isArray(filled) ? filled.map((v) => digits(v)).filter((v): v is string => v !== null) : [];
    return {
      intentHash: hash(r['intent_hash'], 8, 120) ?? intentHash,
      status: word,
      statusDetails: text(r['status_details'], 300),
      nearTxHash,
      filledAmounts,
    };
  }

  return { quote, publishIntent, status };
}
